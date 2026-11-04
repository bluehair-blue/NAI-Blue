import { assertAgentPublicValue } from '@/application/agent/agent-command-contract'
import { ProviderResultSpoolError, type ProviderResultSpool } from '@/application/generation/provider-result-spool'
import { journalMatchesJob, reservationMatchesJob, scenePresetId } from '@/adapters/generation/indexeddb-generation-run-reader'
import type { JsonObject } from '@/domain/composition/types'
import { providerResultSpoolId, type SpoolReceipt } from '@/domain/queue/provider-result'
import { hashGenerationJobSnapshot } from '@/services/queue/job-snapshot'
import { getRuntimeQueueRepository, type IndexedDBQueueRepository } from '@/services/queue/indexeddb-queue-repository'
import { getRuntimeMainQueueDependencies } from '@/services/queue/main-queue-runtime-dependencies'
import { getRuntimeOutputWriter, type OutputWriter } from '@/services/output/output-writer'
import { getRuntimeArtifactRepository } from '@/services/organizer/runtime'
import type { ArtifactRecord } from '@/domain/organizer/types'
import { readSavedArtifactImage, SavedArtifactImageError } from '@/services/agent/saved-artifact-image'

export interface GenerationRecoveryInspectionPorts {
    queue: Pick<IndexedDBQueueRepository, 'getBatch' | 'getJob' | 'listAttempts' | 'getOutputReservation'>
    spool: Pick<ProviderResultSpool, 'verify'>
    output: Pick<OutputWriter, 'inspectQueueTransaction' | 'inspectPendingQueueTransactions'>
    artifacts: { get(id: string): Promise<ArtifactRecord | null> }
    verifyArtifact(id: string, checksum: string): Promise<{ checksum: string }>
}

async function read<T>(work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
    try { return { ok: true, value: await work() } } catch (error) { return { ok: false, error } }
}

function publicFileName(value: string | undefined): string | null {
    if (value === undefined || /[/\\]/.test(value)) return null
    try { assertAgentPublicValue({ fileName: value }); return value } catch { return null }
}

function runtimePorts(): GenerationRecoveryInspectionPorts {
    return { queue: getRuntimeQueueRepository(), spool: getRuntimeMainQueueDependencies().providerResultSpool,
        output: getRuntimeOutputWriter(), artifacts: getRuntimeArtifactRepository(),
        verifyArtifact: (id, checksum) => readSavedArtifactImage(id, checksum) }
}

/** Exact-job reads only: never invoke Provider, spool reconciliation, cleanup, or a Queue transition. */
export async function inspectGenerationRecovery(
    runId: string, jobId: string, ports: GenerationRecoveryInspectionPorts = runtimePorts(),
): Promise<JsonObject> {
    const [batchRead, jobRead] = await Promise.all([
        read(() => ports.queue.getBatch(runId)), read(() => ports.queue.getJob(jobId)),
    ])
    if (!batchRead.ok || !jobRead.ok) return { found: false, code: 'RECOVERY_READ_UNAVAILABLE' }
    const job = jobRead.value
    if (batchRead.value === null || job === null || job.batchId !== runId) return { found: false }
    if (job.snapshotHash !== hashGenerationJobSnapshot(job.snapshot)) {
        return { found: true, jobId, status: 'mismatch', code: 'RECOVERY_SNAPSHOT_MISMATCH' }
    }
    const attemptsRead = await read(() => ports.queue.listAttempts(job.id))
    const attempt = attemptsRead.ok ? attemptsRead.value.find(item => item.jobId === job.id && item.attemptNumber === job.attemptCount) : undefined
    const evidence = attempt?.providerEvidence
    let spool: JsonObject = { status: attemptsRead.ok ? 'unrecorded' : 'unavailable' }
    if (attempt !== undefined) {
        const candidates = [...new Set([providerResultSpoolId(attempt.id), evidence?.spoolReceipt?.spoolId]
            .filter((id): id is string => id !== undefined))]
        const receipts: SpoolReceipt[] = []
        const failures: string[] = []
        for (const id of candidates) {
            try {
                const receipt = await ports.spool.verify(id)
                if (receipt.spoolId !== id || receipt.attemptId !== attempt.id
                    || (evidence?.spoolReceipt !== null && evidence?.spoolReceipt !== undefined
                        && (evidence.spoolReceipt.attemptId !== attempt.id
                            || receipt.sha256 !== evidence.spoolReceipt.sha256
                            || receipt.byteLength !== evidence.spoolReceipt.byteLength))) failures.push('mismatch')
                else receipts.push(receipt)
            } catch (error) {
                if (error instanceof ProviderResultSpoolError) {
                    if (error.code !== 'missing') failures.push(error.code === 'conflict' ? 'mismatch' : 'corrupt')
                } else failures.push('unavailable')
            }
        }
        if (receipts.some(item => item.sha256 !== receipts[0].sha256)) failures.push('mismatch')
        const failure = ['mismatch', 'corrupt', 'unavailable'].find(status => failures.includes(status))
        const receipt = receipts[0]
        spool = failure !== undefined ? { status: failure }
            : receipt !== undefined ? { status: 'verified', attemptId: receipt.attemptId,
                contentChecksum: receipt.sha256, byteLength: receipt.byteLength }
                : { status: evidence?.spoolReceipt ? 'missing' : 'absent' }
    }
    const reservationRead = job.snapshot.outputReservation === undefined ? null
        : await read(() => ports.queue.getOutputReservation(job.snapshot.outputReservation!.reservationId))
    const reservation: JsonObject = reservationRead === null ? { status: 'unrecorded' }
        : !reservationRead.ok ? { status: 'unavailable' }
            : reservationRead.value === null ? { status: 'absent' }
                : { status: reservationMatchesJob(reservationRead.value, job) ? 'verified' : 'mismatch',
                    state: reservationRead.value.state }
    const journalsRead = await read(async () => job.outputTransactionId === null
        ? (await ports.output.inspectPendingQueueTransactions()).filter(item => item.sourceJobId === job.id)
        : [await ports.output.inspectQueueTransaction(job.outputTransactionId)]
            .filter((item): item is NonNullable<typeof item> => item !== null))
    const journals = journalsRead.ok ? journalsRead.value : []
    const journal: JsonObject = !journalsRead.ok ? { status: 'unavailable' }
        : journals.length === 0 ? { status: 'absent' }
            : { status: journals.every(item => item.sourceJobId === job.id) ? 'present' : 'mismatch',
                count: journals.length, phases: [...new Set(journals.map(item => item.phase))].slice(0, 8),
                filesCommittedVerified: journals.length === 1 && reservation.status === 'verified'
                    && journals[0].sourceJobId === job.id && journalMatchesJob(journals[0], job) }
    const artifactId = job.artifactReference?.artifactId
        ?? (job.workflow === 'scene' || job.workflow === 'main' ? `artifact:${job.id}` : null)
    let artifact: JsonObject = { status: 'unrecorded' }
    if (artifactId !== null) {
        const artifactRead = await read(() => ports.artifacts.get(artifactId))
        if (!artifactRead.ok) artifact = { status: 'unavailable' }
        else if (artifactRead.value === null) artifact = { status: 'absent' }
        else {
            const record = artifactRead.value, snapshot = job.snapshot.outputReservation
            if (record.artifactId !== artifactId || record.sourceJobId !== job.id || record.sourceSceneId !== job.sceneId
                || (snapshot?.reservationSchemaVersion === 1 && record.outputCommitSetHash !== snapshot.commitSetHash)) {
                artifact = { status: 'mismatch' }
            } else {
                const verified = await read(() => ports.verifyArtifact(artifactId, record.original.contentChecksum))
                artifact = verified.ok
                    ? verified.value.checksum === record.original.contentChecksum
                        ? { status: 'verified', artifactId, contentChecksum: record.original.contentChecksum }
                        : { status: 'mismatch' }
                    : { status: verified.error instanceof SavedArtifactImageError
                        ? verified.error.code === 'content-mismatch' ? 'corrupt' : 'mismatch' : 'unavailable' }
            }
        }
    }
    const afterRead = await read(() => ports.queue.getJob(job.id))
    const afterAttempts = await read(() => ports.queue.listAttempts(job.id))
    const afterAttempt = afterAttempts.ok ? afterAttempts.value.find(item => item.jobId === job.id && item.attemptNumber === job.attemptCount) : undefined
    const recheckUnavailable = !afterRead.ok || !afterAttempts.ok
    const changed = afterRead.ok && afterAttempts.ok && (afterRead.value === null
        || afterRead.value.updatedAt !== job.updatedAt || afterRead.value.attemptCount !== job.attemptCount
        || afterRead.value.state !== job.state || afterRead.value.snapshotHash !== job.snapshotHash
        || afterRead.value.outputTransactionId !== job.outputTransactionId
        || afterAttempt?.id !== attempt?.id
        || JSON.stringify(afterAttempt?.providerEvidence ?? null) !== JSON.stringify(evidence ?? null))
    const localOutputVerified = !recheckUnavailable && !changed && (spool.status === 'verified' || artifact.status === 'verified')
    const result: JsonObject = { found: true, runId, jobId, status: recheckUnavailable ? 'unavailable' : changed ? 'changed' : 'observed',
        source: { ordinal: job.ordinal, workflow: job.workflow, presetId: scenePresetId(job), sceneId: job.sceneId,
            snapshotHash: job.snapshotHash, fileName: publicFileName(job.snapshot.outputReservation?.relativePath) },
        attempt: { attemptCount: job.attemptCount, attemptId: attempt?.id ?? null,
            dispatchState: evidence?.dispatchState ?? null, providerOutcome: evidence?.providerOutcome ?? null,
            billingRisk: evidence?.billingRisk ?? null },
        spool, reservation, outputCommit: journal, artifact,
        recovery: { localOutputVerified, code: recheckUnavailable ? 'RECOVERY_RECHECK_UNAVAILABLE' : changed ? 'RECOVERY_EVIDENCE_CHANGED'
            : localOutputVerified ? 'VERIFIED_LOCAL_OUTPUT' : 'NO_VERIFIED_LOCAL_OUTPUT',
        nextAction: recheckUnavailable || changed ? 'refresh-run-evidence' : localOutputVerified ? 'review-retained-output'
            : evidence?.providerOutcome === 'unknown' ? 'review-uncertain-result' : 'review-recovery' } }
    assertAgentPublicValue(result)
    return result
}
