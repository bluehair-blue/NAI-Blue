import {
    assertAgentStorageRetryTarget,
    sameAgentStorageRetryTarget,
    type AgentStorageRetryInput,
    type AgentStorageRetryPorts,
    type AgentStorageRetryResult,
    type AgentStorageRetryTarget,
} from '@/application/agent/agent-storage-retry-contract'
import { AgentCommandError } from '@/application/agent/agent-command-contract'
import { retryGenerationStorage } from '@/application/generation/enqueue-generation-plan'
import type { RetryGenerationStoragePort } from '@/application/generation/generation-command-contract'
import { canonicalSerialize, hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import { hashOutputCommitSet } from '@/domain/output-commit-set'
import { getRuntimeArtifactRepository } from '@/services/organizer/runtime'
import { getRuntimeOutputWriter, type OutputWriter } from '@/services/output/output-writer'
import { getRuntimeGenerationCommandAdapter } from '@/services/queue/generation-command-adapter'
import {
    assertFilesCommittedRecoveryEligibility,
    getRuntimeQueueRepository,
    type IndexedDBQueueRepository,
} from '@/services/queue/indexeddb-queue-repository'
import { hashGenerationJobSnapshot } from '@/services/queue/job-snapshot'
import type { QueueArtifactRepository } from '@/services/queue/queue-artifact-lineage'
import { verifyRecoveryReservation } from '@/services/queue/queue-output-recovery'

interface StorageRetryDependencies {
    readonly repository: Pick<IndexedDBQueueRepository, 'initialize' | 'getBatch' | 'getJob' | 'listAttempts' | 'getOutputReservation'>
    readonly writer: Pick<OutputWriter, 'inspectQueueTransaction' | 'isTransactionActive'>
    readonly artifacts: Pick<QueueArtifactRepository, 'get'>
    readonly commands: RetryGenerationStoragePort
    readonly now: () => string
}

const resultFor = (target: AgentStorageRetryTarget): AgentStorageRetryResult => ({
    status: 'storage-registered', runId: target.runId, batchId: target.batchId,
    jobId: target.jobId, artifactId: target.artifactId,
})

/** Approves one current commit set and delegates registration to the existing storage-only command. */
export function createAgentGenerationStorageRetryPort(
    overrides: Partial<StorageRetryDependencies> = {},
): AgentStorageRetryPorts {
    // Runtime authorities stay lazy: capability registration must not initialize storage or Queue execution.
    const repository = () => overrides.repository ?? getRuntimeQueueRepository()
    const writer = () => overrides.writer ?? getRuntimeOutputWriter()
    const inspect = async (input: AgentStorageRetryInput, completed = false) => {
        const id = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value)
        if (!input || !id(input.runId) || !id(input.jobId)) return null
        try {
            const queue = repository()
            await queue.initialize()
            const [batch, job] = await Promise.all([queue.getBatch(input.runId), queue.getJob(input.jobId)])
            if (batch === null || job === null || batch.id !== input.runId || job.id !== input.jobId
                || job.batchId !== batch.id || job.workflow !== batch.workflow
                || job.snapshotHash !== hashGenerationJobSnapshot(job.snapshot)
                || job.outputTransactionId === null || job.artifactReference === null) return null
            const reservation = job.snapshot.outputReservation
            // Legacy output has no complete destination lineage; manual recovery retains its compatibility path.
            if (reservation?.reservationSchemaVersion !== 1
                || hashOutputCommitSet(reservation.commitSet) !== reservation.commitSetHash) return null
            const attempts = await queue.listAttempts(job.id)
            const attempt = attempts.find(item => item.attemptNumber === job.attemptCount) ?? null
            if (attempt === null || attempt.jobId !== job.id
                || !['running', 'succeeded'].includes(attempt.outcome)
                || (attempt.providerEvidence !== null && (attempt.providerEvidence.providerOutcome !== 'succeeded'
                    || !['response-complete', 'result-spooled'].includes(attempt.providerEvidence.dispatchState)))) return null
            assertFilesCommittedRecoveryEligibility(job, attempt, overrides.now?.() ?? new Date().toISOString(), true)
            if (writer().isTransactionActive(job.outputTransactionId)) return null
            const journal = await writer().inspectQueueTransaction(job.outputTransactionId)
            if (completed ? job.state !== 'succeeded' : job.state === 'succeeded') return null
            // Startup may already have cleaned a completed journal. Pending entry always needs exact journal ownership.
            if ((!completed && journal === null) || (journal !== null && (journal.transactionId !== job.outputTransactionId
                || journal.sourceJobId !== job.id
                || (!completed && journal.phase !== 'files-committed')
                || (completed && !['files-committed', 'workflow-committed'].includes(journal.phase))))) return null
            await verifyRecoveryReservation(queue, job, journal === null ? undefined : {
                inspected: true, reservation: journal.outputReservation,
            })
            if (journal !== null && canonicalSerialize(journal.outputReservation?.commitSet ?? null)
                !== canonicalSerialize(reservation.commitSet)) return null
            const target: AgentStorageRetryTarget = {
                runId: batch.id, batchId: batch.id, jobId: job.id,
                outputTransactionId: job.outputTransactionId, artifactId: job.artifactReference.artifactId,
                targetHash: `sha256:${hashCanonicalValue({
                    batch: { id: batch.id, workflow: batch.workflow, queueSequence: batch.queueSequence,
                        createdAt: batch.createdAt, failurePolicy: batch.failurePolicy,
                        origin: batch.origin, idempotencyKey: batch.idempotencyKey },
                    job: { id: job.id, batchId: job.batchId, workflow: job.workflow, sceneId: job.sceneId,
                        createdAt: job.createdAt, ordinal: job.ordinal, snapshotSchemaVersion: job.snapshotSchemaVersion,
                        snapshotHash: job.snapshotHash, compositionPlanHash: job.compositionPlanHash,
                        maxAttempts: job.maxAttempts, idempotencyKey: job.idempotencyKey,
                        retryOfJobId: job.retryOfJobId, rootJobId: job.rootJobId,
                        outputTransactionId: job.outputTransactionId, artifactReference: job.artifactReference },
                    reservation: { ...reservation, batchId: job.batchId, jobId: job.id },
                })}`,
            }
            assertAgentStorageRetryTarget(target)
            return { target, job, reservation }
        } catch { return null }
    }
    const reconcile = async (target: AgentStorageRetryTarget): Promise<AgentStorageRetryResult | null> => {
        try {
            assertAgentStorageRetryTarget(target)
            const current = await inspect(target, true)
            if (current === null || !sameAgentStorageRetryTarget(current.target, target)) return null
            const artifact = await (overrides.artifacts ?? getRuntimeArtifactRepository()).get(target.artifactId)
            return artifact !== null && artifact.artifactId === target.artifactId
                && artifact.sourceJobId === current.job.id && artifact.sourceSceneId === current.job.sceneId
                && artifact.outputCommitSetHash === current.reservation.commitSetHash
                && artifact.original.file.fileName === current.reservation.relativePath
                ? resultFor(target) : null
        } catch { return null }
    }
    return {
        async inspect(input) { return (await inspect(input))?.target ?? null },
        async retry(target, grant) {
            assertAgentStorageRetryTarget(target)
            assertAgentStorageRetryTarget(grant.target)
            const before = await inspect(target)
            if (before === null || !sameAgentStorageRetryTarget(target, grant.target)
                || !sameAgentStorageRetryTarget(before.target, target)) {
                throw new AgentCommandError('STORAGE_RETRY_TARGET_CHANGED')
            }
            const result = await retryGenerationStorage({ jobId: target.jobId,
                actor: { kind: grant.actorKind, id: `client:${grant.clientId}` },
            }, overrides.commands ?? getRuntimeGenerationCommandAdapter()).catch(() => {
                // Platform errors can contain paths; only the stable command code crosses this boundary.
                throw new AgentCommandError('STORAGE_RETRY_NOT_ACKNOWLEDGED')
            })
            if (result.status !== 'ready') throw new AgentCommandError('STORAGE_RETRY_NOT_ACKNOWLEDGED')
            const completed = await reconcile(target)
            if (completed === null) throw new AgentCommandError('STORAGE_RETRY_NOT_ACKNOWLEDGED')
            return completed
        },
        // This is a goal-state proof, not a claim that this grant caused the registration; it never retries.
        async reconcile(grant) { return reconcile(grant.target) },
    }
}
