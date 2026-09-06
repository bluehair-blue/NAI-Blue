import { getRuntimeOutputWriter, type OutputRecoveryResult } from '@/services/output/output-writer'
import { assertFilesCommittedRecoveryEligibility, getRuntimeQueueRepository } from './indexeddb-queue-repository'
import { recoverQueueLinkedOutputs, verifyRecoveryReservation } from './queue-output-recovery'
import { hashGenerationJobSnapshot } from './job-snapshot'
import { recoverQueueAfterRestart, type QueueRecoveryResult } from './recovery'
import { reconcileStyleLabRenderReservations } from '@/services/style-lab/style-lab-queue-adapter'
import type { ProviderResultSpool, SpoolReconcileResult } from '@/application/generation/provider-result-spool'
import type { GenerationAttempt } from '@/domain/queue/types'
import type { ProviderAttemptEvidence, SpoolReceipt } from '@/domain/queue/provider-result'
import { getRuntimeMainQueueDependencies } from './main-queue-runtime-dependencies'
import {
    reconcileSceneArtifactLinks,
    type LinkSceneArtifactResult,
} from '@/application/scene/link-scene-artifact'
import { getRuntimeSceneRepository } from '@/lib/scene-migration-startup'
import { getRuntimeArtifactRepository } from '@/services/organizer/runtime'
import { reportDiagnostic } from '@/services/diagnostics/error-registry'
import { recoverQueueR2Release } from './queue-r2-release-recovery'

/** Safe readiness codes; exception text, paths, and Provider payloads stay out of the inbox gate. */
export type QueueStartupRecoveryIssue =
    | 'provider-spool-reconcile'
    | 'linked-output-recovery'
    | 'orphan-output-recovery'
    | 'scene-artifact-reconcile'
    | 'r2-release-reconcile'

export interface QueueStartupRecoveryResult {
    readonly inboxReady: boolean
    readonly recoveryIssues: readonly QueueStartupRecoveryIssue[]
    linkedOutputs: OutputRecoveryResult[]
    orphanOutputs: OutputRecoveryResult[]
    leases: QueueRecoveryResult
    providerSpool: SpoolReconcileResult
    styleLabReservations: { spent: number; released: number }
    sceneLinks: readonly LinkSceneArtifactResult[]
    r2ReleaseJobs: number
}

let startupPromise: Promise<QueueStartupRecoveryResult> | null = null

/** Queue-linked journals must reconcile before generic rollback and lease expiry. */
async function reconcileProviderAttempts(
    repository: ReturnType<typeof getRuntimeQueueRepository>,
    writer: ReturnType<typeof getRuntimeOutputWriter>,
    receipts: readonly SpoolReceipt[],
    now: string,
): Promise<void> {
    const receiptsByAttempt = new Map(receipts.map(receipt => [receipt.attemptId, receipt]))
    let cursor: string | null = null
    do {
        const page = await repository.listJobs({ states: ['running'], cursor, limit: 250 })
        for (const job of page.items) {
            const attempts = await repository.listAttempts(job.id)
            const attempt: GenerationAttempt | undefined = attempts.find(item => item.attemptNumber === job.attemptCount)
            const evidence = attempt?.providerEvidence
            if (attempt === undefined || evidence === null || evidence === undefined) continue
            const receipt = receiptsByAttempt.get(attempt.id)
            let next: ProviderAttemptEvidence | null = null
            let disposition: 'blocked' | 'queued-spooled' | 'failed-known' | null = null
            let blockReason: 'provider-outcome-unknown' | 'provider-result-lost' | undefined
            if (evidence.dispatchState === 'possibly-dispatched' || evidence.dispatchState === 'response-started') {
                next = { ...evidence, providerOutcome: 'unknown' }
                disposition = 'blocked'
                blockReason = 'provider-outcome-unknown'
            } else if (evidence.dispatchState === 'response-complete'
                && evidence.providerOutcome === 'known-failure') {
                next = evidence
                disposition = 'failed-known'
            } else if (evidence.dispatchState === 'response-complete') {
                if (receipt !== undefined
                    && (evidence.responseDigest === null || receipt.sha256 === evidence.responseDigest)) {
                    next = {
                        ...evidence,
                        dispatchState: 'result-spooled',
                        responseDigest: receipt.sha256,
                        spoolReceipt: receipt,
                    }
                    disposition = 'queued-spooled'
                } else {
                    next = { ...evidence, dispatchState: 'result-lost', spoolReceipt: null }
                    disposition = 'blocked'
                    blockReason = 'provider-result-lost'
                }
            } else if (evidence.dispatchState === 'result-spooled') {
                const expected = evidence.spoolReceipt
                if (receipt !== undefined
                    && expected !== null
                    && receipt.spoolId === expected.spoolId
                    && receipt.sha256 === expected.sha256) {
                    next = evidence
                    disposition = 'queued-spooled'
                } else {
                    next = { ...evidence, dispatchState: 'result-lost', spoolReceipt: null }
                    disposition = 'blocked'
                    blockReason = 'provider-result-lost'
                }
            }
            if (next !== null && disposition !== null) {
                // A verified Provider spool can already own committed files. Keep that exact journal
                // with output recovery instead of requeueing it into the spool executor's path.
                if (disposition === 'queued-spooled' && next.providerOutcome === 'succeeded'
                    && attempt.outcome === 'running' && job.snapshot?.outputReservation?.reservationSchemaVersion === 1
                    && job.snapshotHash === hashGenerationJobSnapshot(job.snapshot)
                    && job.outputTransactionId !== null && job.artifactReference !== null) {
                    try {
                        assertFilesCommittedRecoveryEligibility(job, attempt, now)
                        const journal = await writer.inspectQueueTransaction(job.outputTransactionId)
                        if (!writer.isTransactionActive(job.outputTransactionId)
                            && journal?.phase === 'files-committed' && journal.sourceJobId === job.id
                            && journal.transactionId === job.outputTransactionId) {
                            await verifyRecoveryReservation(repository, job, { inspected: true, reservation: journal.outputReservation })
                            continue
                        }
                    } catch { /* Existing Provider reconciliation and the output readiness gate own changed evidence. */ }
                }
                await repository.reconcileProviderAttemptAfterRestart({
                    jobId: job.id,
                    attemptNumber: attempt.attemptNumber,
                    now,
                    expectedEvidence: evidence,
                    nextEvidence: next,
                    disposition,
                    blockReason,
                })
            }
        }
        cursor = page.nextCursor
    } while (cursor !== null)
}

/** Recreates only missing durable delivery jobs from committed local authority; Provider is never consulted. */
export async function reconcileR2ReleaseJobs(
    repository: ReturnType<typeof getRuntimeQueueRepository>,
    onRecoveryFailure?: () => void,
): Promise<number> {
    let enqueued = 0
    let cursor: string | null = null
    do {
        const page = await repository.listJobs({ cursor, limit: 250 })
        for (const job of page.items) {
            if (job.artifactReference === null) continue
            try {
                const handle = await recoverQueueR2Release(job)
                enqueued += handle?.jobIds.length ?? 0
            } catch (error) {
                onRecoveryFailure?.()
                reportDiagnostic(error, { operation: 'queue.startup', stage: 'r2-release-reconcile', jobId: job.id })
            }
        }
        cursor = page.nextCursor
    } while (cursor !== null)
    return enqueued
}

export function initializeQueueAfterRestart(options: {
    providerResultSpool: ProviderResultSpool
} = { providerResultSpool: getRuntimeMainQueueDependencies().providerResultSpool }): Promise<QueueStartupRecoveryResult> {
    startupPromise ??= (async () => {
        const recoveryIssues = new Set<QueueStartupRecoveryIssue>()
        const repository = getRuntimeQueueRepository()
        const writer = getRuntimeOutputWriter()
        await repository.initialize()
        const providerSpool = await options.providerResultSpool.reconcile()
        if ((providerSpool.unresolvedCorruptSpoolIds ?? providerSpool.corruptSpoolIds).length > 0) {
            recoveryIssues.add('provider-spool-reconcile')
        }
        await reconcileProviderAttempts(repository, writer, providerSpool.receipts, new Date().toISOString())
        const linkedOutputs = await recoverQueueLinkedOutputs(repository, writer, {
            now: new Date().toISOString(),
        })
        // Queue-owned journals that failed eligibility remain evidence; only the remaining orphans roll back.
        const orphanOutputs = await writer.recoverPending({
            excludeTransactionIds: linkedOutputs.map(output => output.transactionId),
        })
        // These resolved outcomes leave recovery unproven. A blocked Provider
        // attempt or terminal lease disposition, by contrast, is reconciled truth.
        const incompleteOutput = (output: OutputRecoveryResult) =>
            output.action === 'failed' || output.action === 'ineligible' || output.action === 'missing'
        if (linkedOutputs.some(incompleteOutput)) recoveryIssues.add('linked-output-recovery')
        if (orphanOutputs.some(incompleteOutput)) recoveryIssues.add('orphan-output-recovery')
        const sceneLinks = await reconcileSceneArtifactLinks(
            getRuntimeSceneRepository(),
            getRuntimeArtifactRepository(),
        ).catch(error => {
            recoveryIssues.add('scene-artifact-reconcile')
            reportDiagnostic(error, { operation: 'queue.startup', stage: 'scene-artifact-reconcile' })
            return []
        })
        if (sceneLinks.some(link => link.status === 'PENDING_CONFLICT' || link.status === 'SCENE_MISSING')) {
            recoveryIssues.add('scene-artifact-reconcile')
        }
        const r2ReleaseJobs = await reconcileR2ReleaseJobs(repository, () => recoveryIssues.add('r2-release-reconcile'))
        const leases = await recoverQueueAfterRestart(repository, {
            now: new Date().toISOString(),
            // This gate runs once before the process-local coordinator starts.
            // A desktop restart invalidates every lease from the previous process,
            // even when its wall-clock expiry is still in the future.
            includeUnexpiredLeases: true,
        })
        // Resolve prior-process cancel markers only after Provider, output and lease journals settle.
        // requestCancel preserves the first marker and retains any unknown/spooled output claims.
        let cancellationCursor: string | null = null
        do {
            const page = await repository.listJobs({
                states: ['queued', 'blocked', 'recovering'], cursor: cancellationCursor, limit: 250,
            })
            for (const job of page.items) {
                if (job.cancelRequestedAt != null) await repository.requestCancel({ jobId: job.id, now: new Date().toISOString() })
            }
            cancellationCursor = page.nextCursor
        } while (cancellationCursor !== null)
        // Lease recovery determines terminal Queue truth before render costs are
        // reconciled; this releases failed/cancelled work after desktop restarts.
        const styleLabReservations = await reconcileStyleLabRenderReservations({ queueRepository: repository })
        // Preserve rejected infrastructure failures for the Queue coordinator;
        // only previously resolved partial failures become an explicit inbox gate.
        return {
            linkedOutputs, orphanOutputs, leases, providerSpool, styleLabReservations, sceneLinks, r2ReleaseJobs,
            inboxReady: recoveryIssues.size === 0,
            recoveryIssues: [...recoveryIssues],
        }
    })()
    return startupPromise
}

export function resetQueueStartupForTests(): void {
    startupPromise = null
}
