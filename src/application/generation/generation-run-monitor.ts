import { hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import type { JsonObject } from '@/domain/composition/types'
import type { GenerationFulfillmentProjection, RecoveryAction } from './generation-fulfillment'

export interface GenerationRunMonitor {
    readonly stateHash: string
    readonly complete: boolean
    readonly attention: 'error' | 'needs-input' | null
    readonly nextAction: 'wait' | 'resume-in-app' | 'review-results' | 'review-recovery' | 'review-uncertain-result' | 'inspect-status'
    readonly counts: {
        readonly total: number
        readonly generated: number
        readonly stored: number
        readonly uploadRequested: number
        readonly uploaded: number
        readonly fulfilled: number
        readonly failed: number
        readonly uncertain: number
        readonly cancelled: number
        readonly skipped: number
    }
    readonly recoveryActions: readonly (RecoveryAction & { readonly jobCount: number })[]
}

/** UI and agent reads share these counts. Queue success alone never proves storage or delivery. */
export function summarizeGenerationRun(run: GenerationFulfillmentProjection): GenerationRunMonitor {
    const stages = (job: GenerationFulfillmentProjection['jobs'][number]) => [job.interpretation, job.provider, job.storage, job.release]
    const fulfilled = run.jobs.filter(job => job.queue.state === 'succeeded'
        && [job.interpretation, job.provider, job.storage].every(stage => stage.state === 'succeeded')
        && ['succeeded', 'not-required'].includes(job.release.state) && job.issues.length === 0).length
    const counts = {
        total: run.jobs.length,
        generated: run.jobs.filter(job => job.provider.state === 'succeeded').length,
        stored: run.jobs.filter(job => job.storage.state === 'succeeded').length,
        uploadRequested: run.jobs.filter(job => job.release.state !== 'not-required').length,
        uploaded: run.jobs.filter(job => job.release.state === 'succeeded').length,
        fulfilled,
        failed: run.jobs.filter(job => job.queue.state === 'failed' || stages(job).some(stage => stage.state === 'failed')).length,
        uncertain: run.jobs.filter(job => stages(job).some(stage => stage.state === 'uncertain')).length,
        cancelled: run.jobs.filter(job => job.queue.state === 'cancelled').length,
        skipped: run.jobs.filter(job => job.queue.state === 'skipped').length,
    }
    const complete = counts.total > 0 && fulfilled === counts.total && ['delivered', 'accepted'].includes(run.overall)
    const recovery = new Map<string, { action: RecoveryAction; jobs: Set<string> }>()
    for (const issue of run.issues) {
        const key = `${issue.action.kind}:${issue.action.requiresHuman}`
        const entry = recovery.get(key) ?? { action: issue.action, jobs: new Set<string>() }
        entry.jobs.add(issue.jobId)
        recovery.set(key, entry)
    }
    const recoveryActions = [...recovery].sort(([a], [b]) => a.localeCompare(b))
        .map(([, entry]) => ({ ...entry.action, jobCount: entry.jobs.size }))
    const uncertain = counts.uncertain > 0 || recoveryActions.some(action => action.kind === 'review-provider-unknown')
    const requiresInput = uncertain || run.acceptance.state === 'needs-review' || run.acceptance.state === 'rejected'
        || (run.acceptance.state === 'not-evaluated' && fulfilled === counts.total && counts.total > 0)
        || recoveryActions.some(action => action.requiresHuman)
    const attention = requiresInput ? 'needs-input' : counts.failed > 0 ? 'error'
        : run.overall === 'needs-attention' || run.overall === 'partial' ? 'needs-input' : null
    const nextAction: GenerationRunMonitor['nextAction'] = complete ? 'review-results'
        : uncertain ? 'review-uncertain-result'
            : recoveryActions.length > 0 ? 'review-recovery'
                : attention !== null || counts.cancelled > 0 || counts.skipped > 0 ? 'inspect-status'
                    : run.queue.state === 'paused' ? 'resume-in-app' : 'wait'

    // This is a content version, not an event ID or heartbeat. Sibling identity is
    // included so equal totals cannot hide a different failing image from a reader.
    const stateHash = `sha256:${hashCanonicalValue({ runId: run.runId, queue: run.queue, overall: run.overall,
        acceptance: run.acceptance, jobs: run.jobs.map(job => ({ jobId: job.jobId, queue: job.queue,
            interpretation: job.interpretation.state, provider: job.provider.state, storage: job.storage.state,
            release: job.release.state, acceptance: job.acceptance, issues: job.issues,
        })).sort((a, b) => a.jobId.localeCompare(b.jobId)) })}`
    return { stateHash, complete, attention, nextAction, counts, recoveryActions }
}

/** Keep the established get_run result while adding bounded monitoring and recovery hints. */
export function projectGenerationRunStatus(run: GenerationFulfillmentProjection): JsonObject {
    return { found: true, runId: run.runId, state: run.overall, queueState: run.queue.state,
        jobCount: run.jobs.length, truncated: run.jobs.length > 100,
        monitor: summarizeGenerationRun(run) as unknown as JsonObject,
        jobs: run.jobs.slice(0, 100).map(job => ({ jobId: job.jobId, queueState: job.queue.state,
            providerState: job.provider.state, storageState: job.storage.state, releaseState: job.release.state,
            acceptanceState: job.acceptance.state })) }
}
