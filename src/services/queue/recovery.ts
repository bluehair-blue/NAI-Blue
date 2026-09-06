import { evaluateQueueRetry } from '@/domain/queue/retry-policy'
import type { GenerationJob } from '@/domain/queue/types'
import type { IndexedDBQueueRepository } from './indexeddb-queue-repository'

export interface QueueRecoveryResult {
    recovering: number
    queued: number
    blocked: number
    failed: number
}

async function recoverJob(
    repository: IndexedDBQueueRepository,
    job: GenerationJob,
    now: string,
): Promise<'queued' | 'blocked' | 'failed'> {
    if (job.snapshot.resumability === 'non-resumable') {
        await repository.transitionJob({
            jobId: job.id,
            to: 'blocked',
            now,
            blockReason: 'non-resumable-resource',
        })
        return 'blocked'
    }
    for (const requirement of job.snapshot.resources) {
        const resource = await repository.getResource(requirement.resourceId)
        if (resource === null || resource.availability !== 'available') {
            await repository.transitionJob({
                jobId: job.id,
                to: 'blocked',
                now,
                blockReason: 'missing-resource',
            })
            return 'blocked'
        }
        if (resource.digest !== requirement.digest) {
            await repository.transitionJob({
                jobId: job.id,
                to: 'blocked',
                now,
                blockReason: 'digest-mismatch',
            })
            return 'blocked'
        }
    }
    const retry = evaluateQueueRetry({
        attemptCount: job.attemptCount,
        maxAttempts: job.maxAttempts,
        failureKind: 'lease-expired',
        now,
    })
    if (retry.decision === 'fail') {
        await repository.transitionJob({ jobId: job.id, to: 'failed', now })
        return 'failed'
    }
    await repository.transitionJob({ jobId: job.id, to: 'queued', now })
    return 'queued'
}

export async function recoverQueueAfterRestart(
    repository: IndexedDBQueueRepository,
    options: { now: string; includeUnexpiredLeases?: boolean },
): Promise<QueueRecoveryResult> {
    await repository.initialize()
    const expired = await repository.recoverExpiredLeases(options.now, {
        includeUnexpired: options.includeUnexpiredLeases,
    })
    const result: QueueRecoveryResult = {
        recovering: expired.length,
        queued: 0,
        blocked: 0,
        failed: 0,
    }
    for (const id of expired) {
        const job = await repository.getJob(id)
        if (job === null || job.state !== 'recovering') continue
        // Lease recovery has settled this attempt; its persisted cancellation must
        // precede retry exhaustion, which would otherwise make the reservation immutable.
        if (job.cancelRequestedAt !== null) {
            await repository.requestCancel({ jobId: job.id, now: options.now })
            continue
        }
        result[await recoverJob(repository, job, options.now)] += 1
    }
    return result
}
