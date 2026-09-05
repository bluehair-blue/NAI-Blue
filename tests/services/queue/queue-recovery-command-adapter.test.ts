import { describe, expect, it, vi } from 'vitest'

import type { ArtifactRecord } from '@/domain/organizer/types'
import type { GenerationAttempt, GenerationJob, OutputReservation } from '@/domain/queue/types'
import type { SpoolReceipt } from '@/domain/queue/provider-result'
import type { OutputWriter } from '@/services/output/output-writer'
import { createQueueRecoveryCommandAdapter } from '@/services/queue/queue-recovery-command-adapter'
import type { QueueArtifactRepository } from '@/services/queue/queue-artifact-lineage'
import type { SceneDocument, SceneRepositoryPort } from '@/application/scene/scene-repository'

const NOW = '2026-09-04T00:00:00.000Z'
const HASH = `sha256:${'a'.repeat(64)}` as const
const receipt: SpoolReceipt = {
    schemaVersion: 1,
    spoolId: 'spool:1',
    attemptId: 'job:1:1',
    contentType: 'image/png',
    byteLength: 4,
    sha256: HASH,
    committedAt: NOW,
}

function job(overrides: Partial<GenerationJob> = {}): GenerationJob {
    return {
        id: 'job:1', batchId: 'batch:1', workflow: 'main', sceneId: null,
        state: 'failed', createdAt: NOW, updatedAt: NOW, priority: 0, ordinal: 0,
        snapshotSchemaVersion: 1,
        snapshot: {
            schemaVersion: 1, prompt: { positive: '', negative: '' }, parameters: {}, outputPolicy: {},
            resources: [], resumability: 'resumable',
        },
        snapshotHash: HASH, compositionPlanHash: null, attemptCount: 1, maxAttempts: 3,
        idempotencyKey: 'job:1', leaseOwner: null, leaseToken: null, leaseExpiresAt: null,
        heartbeatAt: null, progress: { stage: 'done', current: 1, total: 1 },
        lastDiagnosticEventId: null, outputTransactionId: null, artifactReference: null,
        blockReason: null, readyAt: NOW, cancelRequestedAt: null, cancelReason: null,
        retryOfJobId: null, rootJobId: 'job:1', version: 1,
        ...overrides,
    }
}

function reservation(overrides: Partial<OutputReservation> = {}): OutputReservation {
    return {
        reservationSchemaVersion: 0,
        reservationId: 'reservation:1', batchId: 'batch:1', jobId: 'job:1',
        folderBinding: { resourceType: 'generation-folder-document', resourceId: 'folder:1', revision: 1, contentHash: HASH },
        directoryIdentity: HASH, relativePath: 'image.png', collisionPolicy: 'fail', expectedExistingDigest: null,
        state: 'conflict',
        ...overrides,
    } as OutputReservation
}

function attempt(evidence: GenerationAttempt['providerEvidence']): GenerationAttempt {
    return {
        recordSchemaVersion: 2, id: 'job:1:1', jobId: 'job:1', attemptNumber: 1,
        startedAt: NOW, finishedAt: NOW, outcome: 'failed', diagnosticEventId: null,
        providerEvidence: evidence, providerTransitions: [], executionEnvelopeHash: null,
    }
}

function dependencies(options: {
    currentJob?: GenerationJob | null
    currentReservation?: OutputReservation | null
    attempts?: GenerationAttempt[]
    artifact?: ArtifactRecord | null
    writer?: OutputWriter
    scenes?: SceneRepositoryPort
    verifiedReceipt?: SpoolReceipt
    projectSceneDocument?: (document: SceneDocument) => void
    resumeR2Release?: (job: GenerationJob) => Promise<import('@/application/r2/enqueue-r2-release').DurableR2ReleaseHandle | null>
} = {}) {
    const currentJob = options.currentJob === undefined ? job() : options.currentJob
    const currentReservation = options.currentReservation === undefined ? null : options.currentReservation
    const abandonOutputReservation = vi.fn(async () => reservation({ state: 'abandoned' }))
    const repository = {
        initialize: vi.fn(async () => undefined),
        getJob: vi.fn(async () => currentJob),
        getOutputReservation: vi.fn(async () => currentReservation),
        listAttempts: vi.fn(async () => options.attempts ?? []),
        abandonOutputReservation,
        recoverFilesCommittedSuccess: vi.fn(async () => currentJob as GenerationJob),
    }
    const discard = vi.fn(async () => undefined)
    const writer = options.writer ?? ({} as OutputWriter)
    const adapter = createQueueRecoveryCommandAdapter({
        repository,
        storage: {
            retryStorage: vi.fn(async input => {
                await writer.retryFilesCommittedWorkflow?.('txn:1', input.jobId, vi.fn())
                return { status: 'ready' as const, targetId: input.jobId }
            }),
        },
        artifacts: ({
            get: vi.fn(async () => options.artifact ?? null),
            putOriginal: vi.fn(),
            removeOriginalIfUnmodified: vi.fn(),
        } as unknown as QueueArtifactRepository),
        scenes: options.scenes ?? ({} as SceneRepositoryPort),
        projectSceneDocument: options.projectSceneDocument,
        resumeR2Release: options.resumeR2Release,
        spool: {
            initialize: vi.fn(), spool: vi.fn(), listReceipts: vi.fn(), cleanup: vi.fn(),
            verify: vi.fn(async () => options.verifiedReceipt ?? receipt),
            read: vi.fn(), discard,
        },
        now: () => NOW,
    })
    return { adapter, repository, abandonOutputReservation, discard }
}

describe('Queue recovery command adapter', () => {
    it('routes delivery recovery through the committed-job seam without touching storage or spool', async () => {
        const resumeR2Release = vi.fn(async () => ({ artifactId: 'artifact:1', status: 'queued' as const, jobIds: ['upload:1'] }))
        const { adapter, repository, discard } = dependencies({ resumeR2Release })
        await expect(adapter.execute({ jobId: 'job:1', action: { kind: 'retry-r2-release', requiresHuman: false } }))
            .resolves.toEqual({ status: 'recovered', action: 'retry-r2-release' })
        expect(resumeR2Release).toHaveBeenCalledWith(await repository.getJob('job:1'))
        expect(repository.getOutputReservation).not.toHaveBeenCalled()
        expect(discard).not.toHaveBeenCalled()
    })

    it('retries only the pre-bound files-committed workflow without Provider dispatch', async () => {
        const current = job({
            state: 'running', outputTransactionId: 'txn:1',
            artifactReference: { kind: 'output-writer', artifactId: 'artifact:1', digest: HASH },
        })
        const writer = {
            retryFilesCommittedWorkflow: vi.fn(async () => ({ transactionId: 'txn:1', action: 'retried' as const })),
        } as unknown as OutputWriter
        const { adapter, repository } = dependencies({ currentJob: current, writer })

        await expect(adapter.execute({ jobId: current.id, action: { kind: 'retry-storage', requiresHuman: false } }))
            .resolves.toEqual({ status: 'recovered', action: 'retry-storage' })
        expect(writer.retryFilesCommittedWorkflow).toHaveBeenCalledOnce()
    })

    it('re-reads Artifact lineage and idempotently links the authoritative Scene', async () => {
        const current = job({
            workflow: 'scene', sceneId: 'scene:1',
            snapshot: { ...job().snapshot, parameters: { sceneWorkflow: { saveContext: { activePresetId: 'preset:1' } } } },
            artifactReference: { kind: 'output-writer', artifactId: 'artifact:1', digest: HASH },
        })
        const document = { presetId: 'preset:1', revision: 1, updatedAt: NOW, scenes: [{ id: 'scene:1', artifactRefs: [] }] }
        const commit = vi.fn(async next => ({ status: 'COMMITTED' as const, document: next }))
        const projectSceneDocument = vi.fn()
        const { adapter } = dependencies({
            currentJob: current,
            artifact: { artifactId: 'artifact:1', sourceJobId: current.id, sourceSceneId: current.sceneId, createdAt: NOW } as ArtifactRecord,
            scenes: { getDocument: vi.fn(async () => document), commit } as unknown as SceneRepositoryPort,
            projectSceneDocument,
        })

        await expect(adapter.execute({ jobId: current.id, action: { kind: 'retry-scene-link', requiresHuman: false } }))
            .resolves.toMatchObject({ status: 'scene-linked', result: { status: 'LINKED' } })
        expect(commit).toHaveBeenCalledOnce()
        expect(projectSceneDocument).toHaveBeenCalledOnce()
    })

    it('rejects a Scene artifact whose current commit-set lineage differs from the snapshot', async () => {
        const snapshot = {
            reservationSchemaVersion: 1 as const,
            reservationId: 'reservation:1',
            folderBinding: { resourceType: 'generation-folder-document' as const, resourceId: 'folder:1', revision: 1, contentHash: HASH },
            directoryIdentity: HASH, relativePath: 'image.png', collisionPolicy: 'fail' as const, expectedExistingDigest: null,
            commitSet: {
                schemaVersion: 1 as const, directoryAuthorityId: 'directory:1', directoryAuthorityFingerprint: HASH,
                filesystemSemantics: 'windows' as const, filenamePolicyRevision: 'v1', pathNormalizationRevision: 'v1', claims: [],
            },
            commitSetHash: HASH,
        }
        const current = job({
            workflow: 'scene', sceneId: 'scene:1',
            snapshot: {
                ...job().snapshot,
                outputReservation: snapshot,
                parameters: { sceneWorkflow: { saveContext: { activePresetId: 'preset:1' } } },
            },
            artifactReference: { kind: 'output-writer', artifactId: 'artifact:1', digest: HASH },
        })
        const commit = vi.fn()
        const projectSceneDocument = vi.fn()
        const { adapter } = dependencies({
            currentJob: current,
            artifact: {
                artifactId: 'artifact:1', sourceJobId: current.id, sourceSceneId: current.sceneId,
                outputCommitSetHash: `sha256:${'b'.repeat(64)}`, createdAt: NOW,
            } as ArtifactRecord,
            scenes: { getDocument: vi.fn(), commit } as unknown as SceneRepositoryPort,
            projectSceneDocument,
        })

        await expect(adapter.execute({ jobId: current.id, action: { kind: 'retry-scene-link', requiresHuman: false } }))
            .rejects.toMatchObject({ code: 'E_QUEUE_IDEMPOTENCY_CONFLICT' })
        expect(commit).not.toHaveBeenCalled()
        expect(projectSceneDocument).not.toHaveBeenCalled()
    })

    it('abandons only an exact inactive reservation and refuses stale or active authority', async () => {
        const held = reservation()
        const current = job({ snapshot: { ...job().snapshot, outputReservation: held } })
        const ok = dependencies({ currentJob: current, currentReservation: held })
        await expect(ok.adapter.execute({ jobId: current.id, action: { kind: 'abandon-reservation', requiresHuman: true } }))
            .resolves.toEqual({ status: 'recovered', action: 'abandon-reservation' })
        expect(ok.abandonOutputReservation).toHaveBeenCalledOnce()

        const stale = dependencies({ currentJob: current, currentReservation: reservation({ jobId: 'job:other' }) })
        await expect(stale.adapter.execute({ jobId: current.id, action: { kind: 'abandon-reservation', requiresHuman: true } }))
            .rejects.toMatchObject({ code: 'E_QUEUE_IDEMPOTENCY_CONFLICT' })
        const active = dependencies({ currentJob: { ...current, state: 'running' }, currentReservation: held })
        await expect(active.adapter.execute({ jobId: current.id, action: { kind: 'abandon-reservation', requiresHuman: true } }))
            .rejects.toMatchObject({ code: 'E_QUEUE_INVALID_TRANSITION' })
        expect(active.abandonOutputReservation).not.toHaveBeenCalled()
        for (const staleJob of [
            { ...current, state: 'recovering' as const },
            { ...current, outputTransactionId: 'txn:bound' },
            { ...current, artifactReference: { kind: 'output-writer' as const, artifactId: 'artifact:1', digest: HASH } },
        ]) {
            const stale = dependencies({ currentJob: staleJob, currentReservation: held })
            await expect(stale.adapter.execute({ jobId: current.id, action: { kind: 'abandon-reservation', requiresHuman: true } }))
                .rejects.toMatchObject({ code: 'E_QUEUE_INVALID_TRANSITION' })
            expect(stale.abandonOutputReservation).not.toHaveBeenCalled()
        }
        const committed = dependencies({ currentJob: current, currentReservation: reservation({ state: 'committed' }) })
        await expect(committed.adapter.execute({ jobId: current.id, action: { kind: 'abandon-reservation', requiresHuman: true } }))
            .rejects.toMatchObject({ code: 'E_QUEUE_INVALID_TRANSITION' })
        const abandoned = dependencies({ currentJob: current, currentReservation: reservation({ state: 'abandoned' }) })
        await expect(abandoned.adapter.execute({ jobId: current.id, action: { kind: 'abandon-reservation', requiresHuman: true } }))
            .rejects.toMatchObject({ code: 'E_QUEUE_INVALID_TRANSITION' })
        expect(abandoned.abandonOutputReservation).not.toHaveBeenCalled()
        const missing = dependencies({ currentJob: null })
        await expect(missing.adapter.execute({ jobId: current.id, action: { kind: 'abandon-reservation', requiresHuman: true } }))
            .rejects.toMatchObject({ code: 'E_QUEUE_NOT_FOUND' })
    })

    it('discards only the exact current spooled receipt before abandoning the reservation', async () => {
        const held = reservation()
        const current = job({ snapshot: { ...job().snapshot, outputReservation: held } })
        const spooled = attempt({ dispatchState: 'result-spooled', providerOutcome: 'succeeded', billingRisk: 'confirmed', responseDigest: HASH, spoolReceipt: receipt })
        const ok = dependencies({ currentJob: current, currentReservation: held, attempts: [spooled] })
        await expect(ok.adapter.execute({ jobId: current.id, action: { kind: 'discard-result-and-abandon-reservation', requiresHuman: true } }))
            .resolves.toEqual({ status: 'recovered', action: 'discard-result-and-abandon-reservation' })
        expect(ok.discard).toHaveBeenCalledWith(receipt)
        expect(ok.abandonOutputReservation).toHaveBeenCalledWith(expect.objectContaining({ discardedSpoolReceipt: receipt }))

        const mismatch = dependencies({
            currentJob: current, currentReservation: held, attempts: [spooled],
            verifiedReceipt: { ...receipt, byteLength: receipt.byteLength + 1 },
        })
        await expect(mismatch.adapter.execute({ jobId: current.id, action: { kind: 'discard-result-and-abandon-reservation', requiresHuman: true } }))
            .rejects.toMatchObject({ code: 'E_QUEUE_WRITE_VERIFY' })
        expect(mismatch.discard).not.toHaveBeenCalled()

        for (const staleJob of [
            { ...current, state: 'running' as const },
            { ...current, outputTransactionId: 'txn:bound' },
            { ...current, artifactReference: { kind: 'output-writer' as const, artifactId: 'artifact:1', digest: HASH } },
        ]) {
            const stale = dependencies({ currentJob: staleJob, currentReservation: held, attempts: [spooled] })
            await expect(stale.adapter.execute({
                jobId: current.id,
                action: { kind: 'discard-result-and-abandon-reservation', requiresHuman: true },
            })).rejects.toMatchObject({ code: 'E_QUEUE_INVALID_TRANSITION' })
            expect(stale.discard).not.toHaveBeenCalled()
        }
        const committed = dependencies({
            currentJob: current,
            currentReservation: reservation({ state: 'committed' }),
            attempts: [spooled],
        })
        await expect(committed.adapter.execute({
            jobId: current.id,
            action: { kind: 'discard-result-and-abandon-reservation', requiresHuman: true },
        })).rejects.toMatchObject({ code: 'E_QUEUE_INVALID_TRANSITION' })
        expect(committed.discard).not.toHaveBeenCalled()

        const changed = dependencies({ currentJob: current, currentReservation: held, attempts: [spooled] })
        changed.repository.getJob
            .mockResolvedValueOnce(current)
            .mockResolvedValueOnce(current)
            .mockResolvedValueOnce({ ...current, state: 'running', version: current.version + 1 })
        await expect(changed.adapter.execute({
            jobId: current.id,
            action: { kind: 'discard-result-and-abandon-reservation', requiresHuman: true },
        })).rejects.toMatchObject({ code: 'E_QUEUE_INVALID_TRANSITION' })
        expect(changed.discard).not.toHaveBeenCalled()
    })
})
