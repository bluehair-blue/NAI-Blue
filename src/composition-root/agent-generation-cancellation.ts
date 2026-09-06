import {
    agentCancellationMarker,
    assertAgentCancellationTarget,
    sameAgentCancellationTarget,
    type AgentCancellationGrant,
    type AgentCancellationPorts,
    type AgentCancellationResult,
    type AgentCancellationTarget,
} from '@/application/agent/agent-cancellation-contract'
import { AgentCommandError, assertAgentTimestamp } from '@/application/agent/agent-command-contract'
import { cancelGeneration } from '@/application/generation/enqueue-generation-plan'
import type { CancelGenerationPort } from '@/application/generation/generation-command-contract'
import { hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import { isTerminalJobState } from '@/domain/queue/state-machine'
import type { GenerationJob } from '@/domain/queue/types'
import { getRuntimeGenerationCommandAdapter } from '@/services/queue/generation-command-adapter'
import { getRuntimeQueueRepository, type IndexedDBQueueRepository } from '@/services/queue/indexeddb-queue-repository'
import { hashGenerationJobSnapshot } from '@/services/queue/job-snapshot'

interface CancellationDependencies {
    readonly repository: Pick<IndexedDBQueueRepository, 'initialize' | 'getBatch' | 'listJobs'>
    readonly commands: CancelGenerationPort
}

const stopped = (job: GenerationJob): boolean => isTerminalJobState(job.state) || job.cancelRequestedAt !== null
/** Terminal Queue rows are immutable; their updatedAt records the settled completion time. */
function stoppedBeforeConsent(job: GenerationJob, consentedAt: string): boolean {
    const stoppedAt = job.cancelRequestedAt ?? (isTerminalJobState(job.state) ? job.updatedAt : null)
    try {
        assertAgentTimestamp(stoppedAt)
        assertAgentTimestamp(consentedAt)
        return Date.parse(stoppedAt) <= Date.parse(consentedAt)
    } catch { return false }
}
const resultFor = (target: AgentCancellationTarget): AgentCancellationResult => ({
    status: 'cancel-requested', runId: target.runId, batchId: target.batchId, jobIds: [...target.jobIds],
})

/** Binds human cancellation to immutable Queue facts; runtime cancellation alone owns aborts and reservation handling. */
export function createAgentGenerationCancellationPort(
    overrides: Partial<CancellationDependencies> = {},
): AgentCancellationPorts {
    const repository = overrides.repository ?? getRuntimeQueueRepository()
    const inspect = async (runId: string): Promise<{ target: AgentCancellationTarget; jobs: readonly GenerationJob[] } | null> => {
        if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(runId)) return null
        try {
            await repository.initialize()
            const batch = await repository.getBatch(runId)
            if (batch === null || batch.id !== runId) return null
            // One bounded page keeps approval/receipt payloads within the public value guard.
            const page = await repository.listJobs({ batchId: batch.id, limit: 100 })
            const jobs = [...page.items].sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
            if (page.nextCursor !== null || jobs.length === 0 || jobs.length > 100
                || new Set(jobs.map(job => job.ordinal)).size !== jobs.length
                || jobs.some(job => job.batchId !== batch.id || job.workflow !== batch.workflow
                    || job.snapshotHash !== hashGenerationJobSnapshot(job.snapshot))) return null
            const target: AgentCancellationTarget = {
                runId, batchId: batch.id, jobIds: jobs.map(job => job.id),
                targetHash: `sha256:${hashCanonicalValue({
                    batch: { id: batch.id, workflow: batch.workflow, queueSequence: batch.queueSequence,
                        createdAt: batch.createdAt, failurePolicy: batch.failurePolicy,
                        origin: batch.origin, idempotencyKey: batch.idempotencyKey },
                    jobs: jobs.map(job => ({ id: job.id, batchId: job.batchId, workflow: job.workflow,
                        sceneId: job.sceneId, createdAt: job.createdAt, ordinal: job.ordinal,
                        snapshotSchemaVersion: job.snapshotSchemaVersion, snapshotHash: job.snapshotHash,
                        compositionPlanHash: job.compositionPlanHash, maxAttempts: job.maxAttempts, idempotencyKey: job.idempotencyKey,
                        retryOfJobId: job.retryOfJobId, rootJobId: job.rootJobId })),
                })}`,
                previouslyStoppedJobIds: jobs.filter(stopped).map(job => job.id),
            }
            assertAgentCancellationTarget(target)
            return { target, jobs }
        } catch { return null }
    }
    const checked = async (grant: AgentCancellationGrant) => {
        try { assertAgentCancellationTarget(grant.target) } catch { return null }
        const current = await inspect(grant.target.runId)
        return current !== null && sameAgentCancellationTarget(current.target, grant.target) ? current : null
    }
    const hasGrantEvidence = (job: GenerationJob, grant: AgentCancellationGrant): boolean => (
        (job.cancelRequestedAt !== null && job.cancelReason === agentCancellationMarker(grant))
        || (grant.target.previouslyStoppedJobIds.includes(job.id) && stoppedBeforeConsent(job, grant.consentedAt))
    )
    return {
        async inspect(runId) { return (await inspect(runId))?.target ?? null },
        async cancel(target, grant) {
            assertAgentCancellationTarget(target)
            const before = await checked(grant)
            if (before === null || !sameAgentCancellationTarget(target, grant.target)) {
                throw new AgentCommandError('CANCELLATION_TARGET_CHANGED')
            }
            const result = await cancelGeneration({ batchId: target.batchId,
                actor: { kind: grant.actorKind, id: `client:${grant.clientId}` },
                operationId: agentCancellationMarker(grant).slice('agent-cancel:'.length),
            }, overrides.commands ?? getRuntimeGenerationCommandAdapter())
            if (result.status !== 'ready') throw new AgentCommandError('CANCELLATION_NOT_ACKNOWLEDGED')
            const after = await checked(grant)
            // A returned successful call can acknowledge jobs which naturally finished meanwhile.
            // Restart reconciliation cannot use that fact to invent proof of this operation.
            if (after === null || !after.jobs.every(job => hasGrantEvidence(job, grant) || isTerminalJobState(job.state))) {
                throw new AgentCommandError('CANCELLATION_NOT_ACKNOWLEDGED')
            }
            return resultFor(grant.target)
        },
        async reconcile(grant) {
            const current = await checked(grant)
            return current !== null && current.jobs.every(job => hasGrantEvidence(job, grant))
                ? resultFor(grant.target) : null
        },
    }
}
