import type {
    CancelGenerationPort,
    GenerationCommandResult,
    RetryGenerationStoragePort,
} from '@/application/generation/generation-command-contract'
import type { PlanIssue } from '@/application/generation/generation-plan-contract'
import type { QueueCancelReason } from '@/domain/queue/types'
import { getRuntimeOutputWriter, type OutputWriter } from '@/services/output/output-writer'
import { getRuntimeQueueRepository, type IndexedDBQueueRepository } from './indexeddb-queue-repository'
import { retryQueueLinkedOutput } from './queue-output-recovery'
import { getRuntimeDurableQueueCoordinator } from './runtime'

type GenerationCommandAdapter = CancelGenerationPort & RetryGenerationStoragePort

interface GenerationCommandAdapterDependencies {
    readonly repository: Pick<
        IndexedDBQueueRepository,
        'initialize' | 'getBatch' | 'getJob' | 'getOutputReservation' | 'recoverFilesCommittedSuccess' | 'listAttempts'
    >
    readonly writer: OutputWriter
    readonly coordinator: { cancelBatch(batchId: string, reason?: QueueCancelReason): Promise<void> }
    readonly now?: () => string
}

function issue(code: string, fieldPath: string, message: string): PlanIssue {
    return Object.freeze({ code, severity: 'blocking', fieldPath, message })
}

function failure(
    status: 'invalid' | 'conflict',
    item: PlanIssue,
): GenerationCommandResult {
    return Object.freeze({ status, issues: Object.freeze([item]) })
}

/** Bridges protocol-neutral commands to the existing durable Queue runtime. */
export function createGenerationCommandAdapter(
    dependencies: GenerationCommandAdapterDependencies,
): GenerationCommandAdapter {
    const now = dependencies.now ?? (() => new Date().toISOString())
    return {
        async cancelBatch(input) {
            // Actor validation belongs to the application use case; Queue has no
            // durable actor audit field yet, so this adapter does not claim one.
            void input.actor
            await dependencies.repository.initialize()
            if (await dependencies.repository.getBatch(input.batchId) === null) {
                return failure('invalid', issue(
                    'generation-batch-not-found',
                    'batchId',
                    'The generation batch does not exist.',
                ))
            }
            if (input.operationId === undefined) await dependencies.coordinator.cancelBatch(input.batchId)
            else await dependencies.coordinator.cancelBatch(input.batchId, `agent-cancel:${input.operationId}`)
            return Object.freeze({ status: 'ready', targetId: input.batchId })
        },

        async retryStorage(input) {
            void input.actor
            const result = await retryQueueLinkedOutput(dependencies.repository, dependencies.writer, {
                jobId: input.jobId,
                now: now(),
            })
            if (result.status === 'ready') {
                return Object.freeze({ status: 'ready', targetId: input.jobId })
            }
            if (result.status === 'missing-job') {
                return failure('invalid', issue(
                    'generation-job-not-found',
                    'jobId',
                    'The generation job does not exist.',
                ))
            }
            if (result.status === 'unbound-job') {
                return Object.freeze({
                    status: 'unsupported',
                    capability: 'files-committed-storage-retry',
                    issues: Object.freeze([issue(
                        'generation-storage-retry-unsupported',
                        'jobId',
                        'Only a pre-bound files-committed output can be retried without Provider dispatch.',
                    )]),
                })
            }
            if (result.status === 'ineligible' && result.reason === 'phase-not-files-committed') {
                return Object.freeze({
                    status: 'unsupported',
                    capability: 'files-committed-storage-retry',
                    issues: Object.freeze([issue(
                        'generation-storage-retry-unsupported',
                        'jobId',
                        'The bound output is not awaiting a files-committed workflow retry.',
                    )]),
                })
            }
            return failure('conflict', issue(
                'generation-storage-retry-conflict',
                'jobId',
                result.status === 'failed'
                    ? result.message
                    : 'The bound output journal is missing or no longer belongs to this job.',
            ))
        },
    }
}

/** Resolves runtime singletons lazily so importing the adapter has no startup side effects. */
export function getRuntimeGenerationCommandAdapter(): GenerationCommandAdapter {
    return createGenerationCommandAdapter({
        repository: getRuntimeQueueRepository(),
        writer: getRuntimeOutputWriter(),
        coordinator: getRuntimeDurableQueueCoordinator(),
    })
}
