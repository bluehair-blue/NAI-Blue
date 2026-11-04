import { describe, expect, it, vi } from 'vitest'
import { inspectGenerationRecovery } from '@/composition-root/agent-generation-recovery-inspection'
import { ProviderResultSpoolError } from '@/application/generation/provider-result-spool'
import { assertAgentPublicValue } from '@/application/agent/agent-command-contract'
import { providerResultSpoolId, type SpoolReceipt } from '@/domain/queue/provider-result'
import type { GenerationBatch, GenerationJob, GenerationAttempt, OutputReservation } from '@/domain/queue/types'
import { createEmptyGenerationBatchSummary } from '@/domain/queue/summary'
import { createArtifactRecord, type ArtifactRecord } from '@/domain/organizer/types'
import { hashGenerationJobSnapshot } from '@/services/queue/job-snapshot'
import type { PendingQueueOutputTransaction } from '@/services/output/output-writer'
import { readSavedArtifactImage } from '@/services/agent/saved-artifact-image'
import { sha256Bytes } from '@/lib/binary-digest'

const now = '2026-10-19T03:09:11.605Z'
const digest = `sha256:${'a'.repeat(64)}` as const

function fixture() {
    const batch: GenerationBatch = { id: 'run-1', workflow: 'scene', queueSequence: 1, createdAt: now, updatedAt: now,
        state: 'active', failurePolicy: 'continue', pauseReason: null, origin: 'fresh', idempotencyKey: 'run-1',
        version: 1, projectionRevision: 1, projectionSummary: createEmptyGenerationBatchSummary('run-1') }
    const job: GenerationJob = { id: 'job-23', batchId: batch.id, workflow: 'scene', sceneId: 'scene-3',
        state: 'blocked', createdAt: now, updatedAt: now, priority: 0, ordinal: 23, snapshotSchemaVersion: 1,
        snapshot: { schemaVersion: 1, prompt: { positive: 'private scene prose', negative: '' },
            parameters: { sceneWorkflow: { saveContext: { activePresetId: 'preset-sia' } } }, outputPolicy: {},
            resources: [], resumability: 'resumable', outputReservation: { reservationId: 'reservation-23',
                folderBinding: { resourceType: 'generation-folder-document', resourceId: 'folder-1', revision: 1, contentHash: digest },
                directoryIdentity: digest, relativePath: 'SIA3.png', collisionPolicy: 'fail', expectedExistingDigest: null } },
        snapshotHash: '', compositionPlanHash: null, attemptCount: 1, maxAttempts: 3, idempotencyKey: 'job-23',
        leaseOwner: null, leaseToken: null, leaseExpiresAt: null, heartbeatAt: null, progress: { stage: 'blocked', current: 0, total: 1 },
        lastDiagnosticEventId: null, outputTransactionId: null, artifactReference: null, blockReason: 'provider-outcome-unknown',
        readyAt: now, cancelRequestedAt: null, cancelReason: null, retryOfJobId: null, rootJobId: 'job-23', version: 1 }
    const current = { ...job, snapshotHash: hashGenerationJobSnapshot(job.snapshot) }
    const attempt: GenerationAttempt = { recordSchemaVersion: 2, id: 'job-23:1', jobId: current.id, attemptNumber: 1,
        startedAt: now, finishedAt: now, outcome: 'interrupted', diagnosticEventId: null, executionEnvelopeHash: null,
        providerEvidence: { dispatchState: 'response-started', providerOutcome: 'unknown', billingRisk: 'possible',
            responseDigest: null, spoolReceipt: null }, providerTransitions: [] }
    const reservation: OutputReservation = { ...current.snapshot.outputReservation!, batchId: batch.id, jobId: current.id, state: 'reserved' }
    const receipt: SpoolReceipt = { schemaVersion: 1, spoolId: providerResultSpoolId(attempt.id), attemptId: attempt.id,
        contentType: 'image/png', byteLength: 8, sha256: digest, committedAt: now }
    const forbiddenWrite = vi.fn(() => { throw new Error('read inspection attempted a mutation') })
    const ports = {
        queue: { getBatch: vi.fn(async () => batch), getJob: vi.fn(async () => current), listAttempts: vi.fn(async () => [attempt]),
            getOutputReservation: vi.fn(async () => reservation), transitionJob: forbiddenWrite },
        spool: { verify: vi.fn(async (_id: string): Promise<SpoolReceipt> => { throw new ProviderResultSpoolError('missing', 'private path') }),
            reconcile: forbiddenWrite, commit: forbiddenWrite, discard: forbiddenWrite },
        output: { inspectQueueTransaction: vi.fn(async (_id: string): Promise<PendingQueueOutputTransaction | null> => null),
            inspectPendingQueueTransactions: vi.fn(async (): Promise<PendingQueueOutputTransaction[]> => []), recoverPending: forbiddenWrite },
        artifacts: { get: vi.fn(async (_id: string): Promise<ArtifactRecord | null> => null) },
        verifyArtifact: vi.fn(async (_id: string, checksum: string) => ({ checksum })),
    }
    return { batch, job: current, attempt, receipt, reservation, ports, forbiddenWrite }
}

describe('read-only exact-job recovery evidence', () => {
    it('keeps unknown outcome, original attempt and reservation intact when no retained output exists', async () => {
        const f = fixture(), before = JSON.stringify([f.job, f.attempt, f.reservation])
        const result = await inspectGenerationRecovery('run-1', 'job-23', f.ports)
        expect(result).toMatchObject({ found: true, status: 'observed',
            source: { ordinal: 23, presetId: 'preset-sia', sceneId: 'scene-3', fileName: 'SIA3.png' },
            attempt: { attemptCount: 1, providerOutcome: 'unknown', billingRisk: 'possible' },
            spool: { status: 'absent' }, outputCommit: { status: 'absent' }, artifact: { status: 'absent' },
            reservation: { status: 'verified', state: 'reserved' },
            recovery: { localOutputVerified: false, code: 'NO_VERIFIED_LOCAL_OUTPUT', nextAction: 'review-uncertain-result' } })
        expect(JSON.stringify([f.job, f.attempt, f.reservation])).toBe(before)
        expect(f.forbiddenWrite).not.toHaveBeenCalled()
        expect(() => assertAgentPublicValue(result)).not.toThrow()
        expect(JSON.stringify(result)).not.toMatch(/private scene prose|private path|directoryIdentity|spoolId/)
    })

    it('rejects a cross-run job or corrupt snapshot before probing private retained bytes', async () => {
        const f = fixture()
        expect(await inspectGenerationRecovery('other-run', 'job-23', f.ports)).toEqual({ found: false })
        f.ports.queue.getJob.mockResolvedValue({ ...f.job, snapshotHash: digest })
        expect(await inspectGenerationRecovery('run-1', 'job-23', f.ports)).toMatchObject({ code: 'RECOVERY_SNAPSHOT_MISMATCH' })
        expect(f.ports.spool.verify).not.toHaveBeenCalled()
        expect(f.ports.artifacts.get).not.toHaveBeenCalled()
    })

    it('verifies the existing deterministic spool identity without changing Provider uncertainty', async () => {
        const f = fixture()
        f.ports.spool.verify.mockResolvedValue(f.receipt)
        expect(await inspectGenerationRecovery('run-1', 'job-23', f.ports)).toMatchObject({
            spool: { status: 'verified', attemptId: f.attempt.id, contentChecksum: digest },
            attempt: { providerOutcome: 'unknown' }, recovery: { localOutputVerified: true } })
        expect(f.ports.spool.verify).toHaveBeenCalledExactlyOnceWith(providerResultSpoolId(f.attempt.id))
        expect(f.forbiddenWrite).not.toHaveBeenCalled()
    })

    it.each([
        [new ProviderResultSpoolError('checksum-mismatch', 'private path'), 'corrupt'],
        [new ProviderResultSpoolError('conflict', 'private path'), 'mismatch'],
        [new Error('private filesystem unavailable'), 'unavailable'],
    ])('separates retained corruption and unreadable storage from absence', async (error, status) => {
        const f = fixture()
        f.ports.spool.verify.mockRejectedValue(error)
        const result = await inspectGenerationRecovery('run-1', 'job-23', f.ports)
        expect(result).toMatchObject({ spool: { status }, recovery: { localOutputVerified: false } })
        expect(JSON.stringify(result)).not.toContain('private')
    })

    it('rejects a different attempt or contradicting recorded digest', async () => {
        for (const invalid of [{ ...fixture().receipt, attemptId: 'job-23:2' }, { ...fixture().receipt, sha256: `sha256:${'b'.repeat(64)}` as const }]) {
            const f = fixture()
            f.ports.queue.listAttempts.mockResolvedValue([{ ...f.attempt,
                providerEvidence: { ...f.attempt.providerEvidence!, spoolReceipt: f.receipt } }])
            f.ports.spool.verify.mockResolvedValue(invalid)
            expect(await inspectGenerationRecovery('run-1', 'job-23', f.ports)).toMatchObject({ spool: { status: 'mismatch' },
                recovery: { localOutputVerified: false } })
        }
    })

    it('selects only the current attempt and suppresses a recovery claim if its evidence changes', async () => {
        const f = fixture()
        f.ports.queue.listAttempts.mockResolvedValue([{ ...f.attempt, attemptNumber: 0, id: 'old-attempt' }, f.attempt])
        f.ports.spool.verify.mockResolvedValue(f.receipt)
        f.ports.queue.getJob.mockResolvedValueOnce(f.job).mockResolvedValue({ ...f.job, attemptCount: 2 })
        expect(await inspectGenerationRecovery('run-1', 'job-23', f.ports)).toMatchObject({ status: 'changed',
            recovery: { localOutputVerified: false, code: 'RECOVERY_EVIDENCE_CHANGED' } })
        expect(f.ports.spool.verify).toHaveBeenCalledExactlyOnceWith(providerResultSpoolId(f.attempt.id))
    })

    it('does not treat an unrelated journal or a mismatched reservation as a verified commit', async () => {
        const f = fixture()
        f.job.outputTransactionId = 'transaction-23'
        f.ports.output.inspectQueueTransaction.mockResolvedValue({ transactionId: 'transaction-23', sourceJobId: 'job-other', phase: 'files-committed' })
        f.ports.queue.getOutputReservation.mockResolvedValue({ ...f.reservation, jobId: 'job-other' })
        expect(await inspectGenerationRecovery('run-1', 'job-23', f.ports)).toMatchObject({
            reservation: { status: 'mismatch' }, outputCommit: { status: 'mismatch', filesCommittedVerified: false },
            recovery: { localOutputVerified: false } })
    })

    it('verifies a matching committed original using actual bytes, rejecting changed bytes and lineage', async () => {
        const f = fixture(), bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), checksum = await sha256Bytes(bytes)
        const artifact = createArtifactRecord({ artifactId: 'artifact:job-23', sourceJobId: f.job.id, sourceSceneId: f.job.sceneId,
            file: { directory: { kind: 'standard', root: 'pictures', segments: ['output'] }, fileName: 'SIA3.png' },
            format: 'png', contentChecksum: checksum, size: bytes.length, createdAt: now })
        f.ports.artifacts.get.mockResolvedValue(artifact)
        const platform = { resolveDirectory: vi.fn(async () => ({ path: 'output', displayPath: 'output', capabilityFallbackUsed: false })),
            readFile: vi.fn(async () => bytes) }
        f.ports.verifyArtifact.mockImplementation((id, expected) => readSavedArtifactImage(id, expected, { artifacts: f.ports.artifacts, platform }))
        expect(await inspectGenerationRecovery('run-1', 'job-23', f.ports)).toMatchObject({ artifact: { status: 'verified', contentChecksum: checksum },
            recovery: { localOutputVerified: true } })
        platform.readFile.mockResolvedValue(new Uint8Array([1, 2]))
        expect(await inspectGenerationRecovery('run-1', 'job-23', f.ports)).toMatchObject({ artifact: { status: 'corrupt' },
            recovery: { localOutputVerified: false } })
        platform.readFile.mockRejectedValue(new Error('private directory unavailable'))
        expect(await inspectGenerationRecovery('run-1', 'job-23', f.ports)).toMatchObject({ artifact: { status: 'unavailable' },
            recovery: { localOutputVerified: false } })
        f.ports.artifacts.get.mockResolvedValue({ ...artifact, sourceJobId: 'other-job' })
        const previousReads = platform.readFile.mock.calls.length
        expect(await inspectGenerationRecovery('run-1', 'job-23', f.ports)).toMatchObject({ artifact: { status: 'mismatch' } })
        expect(platform.readFile.mock.calls.length).toBe(previousReads)
        expect(f.forbiddenWrite).not.toHaveBeenCalled()
    })

    it('keeps failed rereads separate from proven changes and suppresses a verified-output claim', async () => {
        const f = fixture()
        f.ports.spool.verify.mockResolvedValue(f.receipt)
        f.ports.queue.getJob.mockResolvedValueOnce(f.job).mockRejectedValue(new Error('private I/O failure'))
        expect(await inspectGenerationRecovery('run-1', 'job-23', f.ports)).toMatchObject({ status: 'unavailable',
            recovery: { localOutputVerified: false, code: 'RECOVERY_RECHECK_UNAVAILABLE' } })
    })

    it('retains a stronger spool mismatch when another candidate is unreadable and distinguishes recorded missing output', async () => {
        const f = fixture()
        const recorded = { ...f.receipt, spoolId: 'legacy-spool' }
        f.ports.queue.listAttempts.mockResolvedValue([{ ...f.attempt,
            providerEvidence: { ...f.attempt.providerEvidence!, spoolReceipt: recorded } }])
        expect(await inspectGenerationRecovery('run-1', 'job-23', f.ports)).toMatchObject({ spool: { status: 'missing' } })
        f.ports.spool.verify.mockResolvedValueOnce({ ...f.receipt, attemptId: 'other-attempt' })
            .mockRejectedValue(new Error('private I/O failure'))
        expect(await inspectGenerationRecovery('run-1', 'job-23', f.ports)).toMatchObject({ spool: { status: 'mismatch' },
            recovery: { localOutputVerified: false } })
    })
})
