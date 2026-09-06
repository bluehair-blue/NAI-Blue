import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderResultSpool } from '@/application/generation/provider-result-spool'
import { createOutputCommitSet } from '@/domain/output-commit-set'
import type { ProviderAttemptEvidence, SpoolReceipt } from '@/domain/queue/provider-result'
import type { GenerationJob, OutputCommitSetReservation } from '@/domain/queue/types'

const mocks = vi.hoisted(() => ({ getRepository: vi.fn() }))
vi.mock('@/services/queue/indexeddb-queue-repository', async importOriginal => ({
    ...await importOriginal<typeof import('@/services/queue/indexeddb-queue-repository')>(),
    getRuntimeQueueRepository: mocks.getRepository,
}))
vi.mock('@/services/output/output-writer', () => ({
    getRuntimeOutputWriter: () => ({ recoverPending: async () => [] }),
}))
vi.mock('@/services/queue/queue-output-recovery', () => ({ recoverQueueLinkedOutputs: async () => [] }))
vi.mock('@/services/style-lab/style-lab-queue-adapter', () => ({
    reconcileStyleLabRenderReservations: async () => ({ spent: 0, released: 0 }),
}))
vi.mock('@/application/scene/link-scene-artifact', () => ({ reconcileSceneArtifactLinks: async () => [] }))
vi.mock('@/lib/scene-migration-startup', () => ({ getRuntimeSceneRepository: () => ({}) }))
vi.mock('@/services/organizer/runtime', () => ({ getRuntimeArtifactRepository: () => ({}) }))
vi.mock('@/services/queue/queue-r2-release-recovery', () => ({ recoverQueueR2Release: async () => null }))

import { IndexedDBQueueRepository } from '@/services/queue/indexeddb-queue-repository'
import { bindOutputReservationSnapshot, createGenerationJobSnapshot } from '@/services/queue/job-snapshot'
import { DurableQueueCoordinator, type QueueExecutorContext } from '@/services/queue/durable-queue-coordinator'
import { initializeQueueAfterRestart, resetQueueStartupForTests } from '@/services/queue/queue-startup'

const NOW = '2026-09-04T00:00:00.000Z'
const CANCELLED_AT = '2026-09-04T00:00:01.000Z'
const LATER = '2026-09-04T00:00:02.000Z'
const AGENT_REASON = `agent-cancel:${'a'.repeat(64)}` as const
const receipt: SpoolReceipt = {
    schemaVersion: 1, spoolId: 'provider-cancel-result', attemptId: 'job:1:1', contentType: 'image/webp',
    byteLength: 4, sha256: `sha256:${'f'.repeat(64)}`, committedAt: NOW,
}
const prepared: ProviderAttemptEvidence = {
    dispatchState: 'prepared', providerOutcome: 'running', billingRisk: 'none', responseDigest: null, spoolReceipt: null,
}
const possibly: ProviderAttemptEvidence = { ...prepared, dispatchState: 'possibly-dispatched', billingRisk: 'possible' }
const unknown: ProviderAttemptEvidence = { ...possibly, providerOutcome: 'unknown' }
const complete: ProviderAttemptEvidence = {
    ...possibly, dispatchState: 'response-complete', providerOutcome: 'succeeded', billingRisk: 'confirmed',
    responseDigest: receipt.sha256,
}
const spooled: ProviderAttemptEvidence = { ...complete, dispatchState: 'result-spooled', spoolReceipt: receipt }
const spoolTransitions: ProviderAttemptEvidence[] = [
    possibly, { ...possibly, dispatchState: 'response-started' }, complete, spooled,
]

function providerSpool(): ProviderResultSpool {
    return {
        commit: vi.fn(), verify: vi.fn(), read: vi.fn(), discard: vi.fn(), removeIfEligible: vi.fn(), list: vi.fn(),
        reconcile: vi.fn(async () => ({
            receipts: [receipt], promotedSpoolIds: [], removedTemporarySpoolIds: [],
            removedOrphanSpoolIds: [], corruptSpoolIds: [],
        })),
    }
}

// Real IndexedDB transactions exercise marker, attempt and whole-output claim ownership together.
async function fixture(maxAttempts = 3, legacy = false) {
    const queue = new IndexedDBQueueRepository({
        factory: new IDBFactory() as unknown as globalThis.IDBFactory,
        keyRange: IDBKeyRange as unknown as typeof globalThis.IDBKeyRange,
        databaseName: `cancel-recovery-${crypto.randomUUID()}`,
        generationLimits: {
            maxJobsPerAtomicBatch: 100, maxOutputClaimsPerAtomicBatch: 400,
            measuredAt: '2026-09-04T07:06:52.993Z',
            evidenceId: 'benchmark:queue:edge:webview2-152.0.4191.62@d1118542+b44519c5#docs/releases/evidence/queue-edge-benchmark.json',
        },
    })
    const directoryIdentity = `sha256:${'d'.repeat(64)}` as const
    const commitSet = createOutputCommitSet({
        directoryAuthorityId: 'folder:1', directoryAuthorityFingerprint: directoryIdentity,
        filesystemSemantics: 'windows', filenamePolicyRevision: 'filename-v1', pathNormalizationRevision: 'path-v1',
        claims: [
            { claimId: 'image', kind: 'image', relativePath: 'Image.webp' },
            { claimId: 'metadata', kind: 'metadata-sidecar', relativePath: 'Image.webp.json' },
        ],
    })
    const reservation: OutputCommitSetReservation = {
        reservationId: 'reservation:1', batchId: 'batch:1', jobId: 'job:1',
        folderBinding: {
            resourceType: 'generation-folder-document', resourceId: 'folder:1', revision: 1,
            contentHash: `sha256:${'b'.repeat(64)}`,
        },
        directoryIdentity, relativePath: 'Image.webp', collisionPolicy: 'fail', expectedExistingDigest: null,
        reservationSchemaVersion: 1, ...commitSet, state: 'reserved', version: 1, updatedAt: NOW,
    }
    const { batchId: _batch, jobId: _job, state: _state, version: _version, updatedAt: _updated, ...snapshotReservation } = reservation
    const snapshot = bindOutputReservationSnapshot({
        ...createGenerationJobSnapshot({
            prompt: { positive: 'cancel test', negative: '' }, parameters: {},
            outputPolicy: { format: 'webp' }, resources: [], resumability: 'resumable',
        }),
        providerExecutionEnvelope: {
            schemaVersion: 1, provider: 'novelai', compatibilityProfileId: 'profile', payloadBuilderRevision: 'payload-v1',
            modelCatalogRevision: 'catalog-v1', action: 'generate', responseMode: 'standard',
            semanticIntentHash: `sha256:${'a'.repeat(64)}`, queueResourceBindings: [],
        },
    }, snapshotReservation)
    const { providerExecutionEnvelope: _envelope, ...legacySnapshot } = snapshot
    await queue.createBatchAndEnqueue({
        batch: { id: 'batch:1', workflow: 'main', createdAt: NOW, failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch:1' },
        jobs: [{
            id: 'job:1', batchId: 'batch:1', workflow: 'main', sceneId: null, createdAt: NOW, priority: 0, ordinal: 0,
            snapshot: legacy ? legacySnapshot : snapshot, compositionPlanHash: null, maxAttempts, idempotencyKey: 'job:1',
        }],
        reservations: [reservation],
    })
    mocks.getRepository.mockReturnValue(queue)
    return { queue, reservation }
}

async function start(queue: IndexedDBQueueRepository, stage: 'prepared' | 'unknown' | 'spooled') {
    const lease = await queue.acquireLease({ jobId: 'job:1', owner: 'worker:1', now: NOW, ttlMs: 60_000 })
    const owner = { jobId: 'job:1', attemptNumber: 1, leaseOwner: 'worker:1', leaseToken: lease!.leaseToken! }
    await queue.transitionJob({ ...owner, to: 'running', now: NOW })
    let evidence = prepared
    for (const next of stage === 'prepared' ? [] : stage === 'unknown' ? [possibly] : spoolTransitions) {
        await queue.recordProviderAttemptTransition({ ...owner, now: NOW, expectedEvidence: evidence, nextEvidence: next })
        evidence = next
    }
    return { owner, evidence }
}

describe('durable cancellation recovery', () => {
    beforeEach(() => { resetQueueStartupForTests(); mocks.getRepository.mockReset() })

    it.each(['unknown', 'spooled'] as const)('finishes an existing marker after %s reconciliation without changing Provider facts', async stage => {
        const { queue, reservation } = await fixture()
        const { evidence } = await start(queue, stage)
        await queue.requestCancel({ jobId: 'job:1', now: CANCELLED_AT, reason: 'batch' })
        await queue.reconcileProviderAttemptAfterRestart({
            jobId: 'job:1', attemptNumber: 1, now: LATER, expectedEvidence: evidence,
            nextEvidence: stage === 'unknown' ? unknown : spooled,
            disposition: stage === 'unknown' ? 'blocked' : 'queued-spooled',
            ...(stage === 'unknown' ? { blockReason: 'provider-outcome-unknown' as const } : {}),
        })
        const attempts = await queue.listAttempts('job:1')
        const claims = await queue.listOutputReservationClaims(reservation.reservationId)
        await expect(queue.requestCancel({ jobId: 'job:1', now: LATER, reason: 'user' })).resolves.toMatchObject({
            state: 'cancelled', cancelRequestedAt: CANCELLED_AT, cancelReason: 'batch',
        })
        expect(await queue.listAttempts('job:1')).toEqual(attempts)
        expect(await queue.getOutputReservation(reservation.reservationId)).toEqual(reservation)
        expect(await queue.listOutputReservationClaims(reservation.reservationId)).toEqual(claims)
    })

    it.each(['prepared', 'unknown', 'spooled'] as const)('completes a persisted %s cancellation during startup', async stage => {
        const { queue, reservation } = await fixture()
        await start(queue, stage)
        await queue.requestCancel({ jobId: 'job:1', now: CANCELLED_AT, reason: 'batch' })
        const result = await initializeQueueAfterRestart({ providerResultSpool: providerSpool() })
        expect(result.inboxReady).toBe(true)
        const cancelled = await queue.getJob('job:1')
        expect(cancelled).toMatchObject({ state: 'cancelled', cancelRequestedAt: CANCELLED_AT, cancelReason: 'batch', leaseOwner: null })
        const attempts = await queue.listAttempts('job:1')
        expect(attempts).toHaveLength(1)
        expect(attempts[0].providerEvidence).toEqual(stage === 'unknown' ? unknown : stage === 'spooled' ? spooled : prepared)
        expect(await queue.getOutputReservation(reservation.reservationId)).toMatchObject({ state: stage === 'prepared' ? 'abandoned' : 'reserved' })
        const claims = await queue.listOutputReservationClaims(reservation.reservationId)
        expect(claims.every(claim => stage === 'prepared' ? claim.activeCollisionKey === null : claim.activeCollisionKey !== null)).toBe(true)
        await queue.requestCancel({ jobId: 'job:1', now: LATER, reason: 'user' })
        expect(await queue.getJob('job:1')).toEqual(cancelled)
    })

    it.each(['prepared', 'legacy'] as const)('finishes a persisted %s cancellation before exhausted-attempt recovery can fail it', async stage => {
        const { queue, reservation } = await fixture(1, stage === 'legacy')
        await start(queue, 'prepared')
        await queue.requestCancel({ jobId: 'job:1', now: CANCELLED_AT, reason: AGENT_REASON })
        const result = await initializeQueueAfterRestart({ providerResultSpool: providerSpool() })
        expect(result.inboxReady).toBe(true)
        expect(await queue.getJob('job:1')).toMatchObject({ state: 'cancelled', attemptCount: 1,
            cancelRequestedAt: CANCELLED_AT, cancelReason: AGENT_REASON, leaseOwner: null })
        const [attempt] = await queue.listAttempts('job:1')
        expect(attempt).toMatchObject({ outcome: 'interrupted', providerEvidence: stage === 'legacy' ? null : prepared })
        expect(await queue.getOutputReservation(reservation.reservationId)).toMatchObject({ state: 'abandoned' })
        expect((await queue.listOutputReservationClaims(reservation.reservationId))
            .every(claim => claim.activeCollisionKey === null)).toBe(true)
    })

    it.each(['unknown', 'spooled'] as const)('finishes live %s cancellation while preserving the Provider journal and claims', async stage => {
        const { queue, reservation } = await fixture()
        let context!: QueueExecutorContext
        let startExecution!: () => void
        let releaseExecution!: () => void
        const started = new Promise<void>(resolve => { startExecution = resolve })
        const released = new Promise<void>(resolve => { releaseExecution = resolve })
        const execute = vi.fn(async (_job: GenerationJob, active: QueueExecutorContext) => {
            context = active
            for (const next of stage === 'unknown' ? [possibly] : spoolTransitions) await active.recordProviderTransition(next)
            startExecution()
            await released
            if (stage === 'unknown') {
                await active.recordProviderTransition(unknown, { blockReason: 'provider-outcome-unknown' })
                throw new Error('cancelled transport after dispatch')
            }
        })
        const runtime = new DurableQueueCoordinator({
            repository: queue, tokenProvider: () => [{ slotId: 'slot:1', token: 'token' }],
            executor: { execute }, now: () => CANCELLED_AT,
        })
        const draining = runtime.drain()
        await started
        const persistCancellation = queue.requestCancelBatch.bind(queue)
        let abortedBeforePersistence = false
        vi.spyOn(queue, 'requestCancelBatch').mockImplementation(async input => {
            abortedBeforePersistence = context.signal.aborted
            return persistCancellation(input)
        })
        await runtime.cancelBatch('batch:1', AGENT_REASON)
        releaseExecution()
        await draining
        expect(abortedBeforePersistence).toBe(false)
        expect(context.signal.reason).toBe(AGENT_REASON)
        expect(execute).toHaveBeenCalledOnce()
        expect(await queue.getJob('job:1')).toMatchObject({ state: 'cancelled', cancelReason: AGENT_REASON })
        const [attempt] = await queue.listAttempts('job:1')
        expect(attempt.providerEvidence).toEqual(stage === 'unknown' ? unknown : spooled)
        expect(attempt.outcome).toBe(stage === 'unknown' ? 'interrupted' : 'running')
        expect(await queue.getOutputReservation(reservation.reservationId)).toEqual(reservation)
        expect((await queue.listOutputReservationClaims(reservation.reservationId)).every(claim => claim.activeCollisionKey !== null)).toBe(true)
    })

    it('persists only a canonical Agent operation digest and keeps the first cancellation reason', async () => {
        const { queue } = await fixture()
        for (const reason of ['agent-cancel:short', `agent-cancel:${'A'.repeat(64)}`, `${AGENT_REASON}\n`, 'private arbitrary reason']) {
            await expect(queue.requestCancel({ jobId: 'job:1', now: CANCELLED_AT, reason: reason as typeof AGENT_REASON }))
                .rejects.toMatchObject({ code: 'E_QUEUE_RECORD_INVALID' })
        }
        await expect(queue.requestCancel({ jobId: 'job:1', now: CANCELLED_AT, reason: AGENT_REASON }))
            .resolves.toMatchObject({ state: 'cancelled', cancelReason: AGENT_REASON })
        await expect(queue.requestCancel({ jobId: 'job:1', now: LATER, reason: 'user' }))
            .resolves.toMatchObject({ cancelRequestedAt: CANCELLED_AT, cancelReason: AGENT_REASON })
    })
})
