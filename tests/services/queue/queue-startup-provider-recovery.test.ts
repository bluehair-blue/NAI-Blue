import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpoolReconcileResult } from '@/application/generation/provider-result-spool'

const mocks = vi.hoisted(() => ({
    initialize: vi.fn(),
    listJobs: vi.fn(),
    listAttempts: vi.fn(),
    reconcileAttempt: vi.fn(),
    recoverLinked: vi.fn(),
    recoverPending: vi.fn(),
    recoverLeases: vi.fn(),
    reconcileStyleLab: vi.fn(),
    reconcileSceneLinks: vi.fn(),
    recoverR2: vi.fn(),
}))

vi.mock('@/services/queue/indexeddb-queue-repository', () => ({
    getRuntimeQueueRepository: () => ({
        initialize: mocks.initialize,
        listJobs: mocks.listJobs,
        listAttempts: mocks.listAttempts,
        reconcileProviderAttemptAfterRestart: mocks.reconcileAttempt,
    }),
}))
vi.mock('@/services/output/output-writer', () => ({
    getRuntimeOutputWriter: () => ({ recoverPending: mocks.recoverPending }),
}))
vi.mock('@/services/queue/queue-output-recovery', () => ({
    recoverQueueLinkedOutputs: mocks.recoverLinked,
}))
vi.mock('@/services/queue/recovery', () => ({ recoverQueueAfterRestart: mocks.recoverLeases }))
vi.mock('@/services/style-lab/style-lab-queue-adapter', () => ({
    reconcileStyleLabRenderReservations: mocks.reconcileStyleLab,
}))
vi.mock('@/application/scene/link-scene-artifact', () => ({
    reconcileSceneArtifactLinks: mocks.reconcileSceneLinks,
}))
vi.mock('@/lib/scene-migration-startup', () => ({ getRuntimeSceneRepository: () => ({}) }))
vi.mock('@/services/organizer/runtime', () => ({ getRuntimeArtifactRepository: () => ({}) }))
vi.mock('@/services/diagnostics/error-registry', () => ({ reportDiagnostic: vi.fn() }))
vi.mock('@/services/queue/queue-r2-release-recovery', () => ({ recoverQueueR2Release: mocks.recoverR2 }))

import {
    initializeQueueAfterRestart,
    resetQueueStartupForTests,
} from '@/services/queue/queue-startup'

const complete = {
    dispatchState: 'response-complete' as const,
    providerOutcome: 'succeeded' as const,
    billingRisk: 'confirmed' as const,
    responseDigest: null,
    spoolReceipt: null,
}
const receipt = {
    schemaVersion: 1 as const,
    spoolId: 'provider-spool',
    attemptId: 'job:1:1',
    contentType: 'image/png',
    byteLength: 3,
    sha256: `sha256:${'a'.repeat(64)}` as const,
    committedAt: '2026-09-03T00:00:00.000Z',
}

function spool(receipts: readonly typeof receipt[]) {
    return {
        commit: vi.fn(), verify: vi.fn(), read: vi.fn(), discard: vi.fn(), removeIfEligible: vi.fn(), list: vi.fn(),
        reconcile: vi.fn(async (): Promise<SpoolReconcileResult> => ({
            receipts,
            promotedSpoolIds: [], removedTemporarySpoolIds: [],
            removedOrphanSpoolIds: [], corruptSpoolIds: [],
        })),
    }
}

describe('Queue startup Provider reconciliation', () => {
    beforeEach(() => {
        vi.resetAllMocks()
        resetQueueStartupForTests()
        mocks.listJobs.mockResolvedValue({
            items: [{ id: 'job:1', state: 'running', attemptCount: 1 }],
            nextCursor: null,
        })
        mocks.listAttempts.mockResolvedValue([{
            id: 'job:1:1', jobId: 'job:1', attemptNumber: 1, providerEvidence: complete,
        }])
        mocks.reconcileAttempt.mockResolvedValue({ state: 'queued', attemptCount: 1 })
        mocks.recoverLinked.mockResolvedValue([])
        mocks.recoverPending.mockResolvedValue([])
        mocks.recoverLeases.mockResolvedValue({ recovering: 0, queued: 0, blocked: 0, failed: 0 })
        mocks.reconcileStyleLab.mockResolvedValue({ spent: 0, released: 0 })
        mocks.reconcileSceneLinks.mockResolvedValue([])
        mocks.recoverR2.mockResolvedValue(null)
    })

    it('promotes response-complete plus a committed receipt to the same queued attempt', async () => {
        const result = await initializeQueueAfterRestart({ providerResultSpool: spool([receipt]) })

        expect(result.inboxReady).toBe(true)
        expect(result.recoveryIssues).toEqual([])

        expect(mocks.reconcileAttempt).toHaveBeenCalledWith(expect.objectContaining({
            jobId: 'job:1', attemptNumber: 1,
            expectedEvidence: complete,
            nextEvidence: {
                ...complete,
                dispatchState: 'result-spooled',
                responseDigest: receipt.sha256,
                spoolReceipt: receipt,
            },
            disposition: 'queued-spooled',
        }))
        expect(mocks.recoverLinked.mock.invocationCallOrder[0])
            .toBeGreaterThan(mocks.reconcileAttempt.mock.invocationCallOrder[0])
        expect(mocks.recoverLeases.mock.invocationCallOrder[0])
            .toBeGreaterThan(mocks.recoverLinked.mock.invocationCallOrder[0])
        expect(mocks.reconcileSceneLinks.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.recoverLeases.mock.invocationCallOrder[0])
    })

    it('blocks response-complete as result-lost when no committed receipt exists', async () => {
        mocks.reconcileAttempt.mockResolvedValue({ state: 'blocked', attemptCount: 1 })
        const result = await initializeQueueAfterRestart({ providerResultSpool: spool([]) })
        expect(result.inboxReady).toBe(true)

        expect(mocks.reconcileAttempt).toHaveBeenCalledWith(expect.objectContaining({
            jobId: 'job:1', attemptNumber: 1,
            nextEvidence: { ...complete, dispatchState: 'result-lost' },
            disposition: 'blocked',
            blockReason: 'provider-result-lost',
        }))
    })

    it('keeps safely blocked unknown Provider outcomes and terminal lease failures ready', async () => {
        mocks.listAttempts.mockResolvedValue([{
            id: 'job:1:1', jobId: 'job:1', attemptNumber: 1,
            providerEvidence: { ...complete, dispatchState: 'possibly-dispatched' },
        }])
        mocks.reconcileAttempt.mockResolvedValue({ state: 'blocked', attemptCount: 1 })
        mocks.recoverLeases.mockResolvedValue({ recovering: 2, queued: 0, blocked: 1, failed: 1 })
        const result = await initializeQueueAfterRestart({ providerResultSpool: spool([]) })
        expect(result.inboxReady).toBe(true)
        expect(mocks.reconcileAttempt).toHaveBeenCalledWith(expect.objectContaining({
            disposition: 'blocked', blockReason: 'provider-outcome-unknown',
        }))
    })

    it.each(['failed', 'ineligible', 'missing'] as const)(
        'marks resolved %s output recovery as unavailable without leaking the error', async action => {
            const incomplete = [{ transactionId: 'private-path', action, error: 'secret-error' }]
            mocks.recoverLinked.mockResolvedValue(incomplete)
            mocks.recoverPending.mockResolvedValue(incomplete)
            const result = await initializeQueueAfterRestart({ providerResultSpool: spool([]) })
            expect(result.inboxReady).toBe(false)
            expect(result.recoveryIssues).toEqual(['linked-output-recovery', 'orphan-output-recovery'])
            expect(result.linkedOutputs).toEqual(incomplete)
            expect(mocks.recoverPending).toHaveBeenCalledWith({ excludeTransactionIds: ['private-path'] })
            expect(mocks.reconcileStyleLab).toHaveBeenCalledOnce()
        },
    )

    it.each(['PENDING_CONFLICT', 'SCENE_MISSING'])(
        'marks resolved Scene %s as unavailable', async status => {
            mocks.reconcileSceneLinks.mockResolvedValue([{ status, artifactId: 'artifact-1' }])
            const result = await initializeQueueAfterRestart({ providerResultSpool: spool([]) })
            expect(result.inboxReady).toBe(false)
            expect(result.recoveryIssues).toEqual(['scene-artifact-reconcile'])
        },
    )

    it('reports every swallowed Scene and per-job R2 failure while completing remaining recovery', async () => {
        mocks.reconcileSceneLinks.mockRejectedValue(new Error('private Scene error'))
        mocks.recoverR2.mockRejectedValue(new Error('private R2 error'))
        const result = await initializeQueueAfterRestart({ providerResultSpool: spool([]) })
        expect(result.inboxReady).toBe(false)
        expect(result.recoveryIssues).toEqual(['scene-artifact-reconcile', 'r2-release-reconcile'])
        expect(result.sceneLinks).toEqual([])
        expect(result.r2ReleaseJobs).toBe(0)
        expect(mocks.reconcileStyleLab).toHaveBeenCalledOnce()
    })

    it.each([false, true])('reports unresolved spool corruption with explicit details=%s', async explicit => {
        const providerResultSpool = spool([])
        providerResultSpool.reconcile.mockResolvedValue({
            receipts: [], promotedSpoolIds: [], removedTemporarySpoolIds: [], removedOrphanSpoolIds: [],
            corruptSpoolIds: ['corrupt'],
            ...(explicit ? { unresolvedCorruptSpoolIds: ['corrupt'] } : {}),
        })
        const result = await initializeQueueAfterRestart({ providerResultSpool })
        expect(result.inboxReady).toBe(false)
        expect(result.recoveryIssues).toEqual(['provider-spool-reconcile'])
    })

    it('allows recovered temporary spool corruption once cleanup proves no retained corruption', async () => {
        const providerResultSpool = spool([])
        providerResultSpool.reconcile.mockResolvedValue({
            receipts: [], promotedSpoolIds: [], removedTemporarySpoolIds: ['temp'],
            removedOrphanSpoolIds: [], corruptSpoolIds: ['temp'],
            unresolvedCorruptSpoolIds: [],
        })
        expect((await initializeQueueAfterRestart({ providerResultSpool })).inboxReady).toBe(true)
    })

    it.each([
        'initialize', 'listJobs', 'listAttempts', 'reconcileAttempt', 'recoverLinked',
        'recoverPending', 'recoverLeases', 'reconcileStyleLab',
    ] as const)('retains rejected %s failure so the coordinator cannot start', async stage => {
        const failure = new Error(`injected ${stage}`)
        mocks[stage].mockRejectedValue(failure)
        const first = initializeQueueAfterRestart({ providerResultSpool: spool([]) })
        await expect(first).rejects.toBe(failure)
        expect(initializeQueueAfterRestart({ providerResultSpool: spool([]) })).toBe(first)
    })

    it('retains a rejected spool failure before Provider and lease reconciliation', async () => {
        const providerResultSpool = spool([])
        providerResultSpool.reconcile.mockRejectedValue(new Error('spool failure'))
        await expect(initializeQueueAfterRestart({ providerResultSpool })).rejects.toThrow('spool failure')
        expect(mocks.reconcileAttempt).not.toHaveBeenCalled()
        expect(mocks.recoverLeases).not.toHaveBeenCalled()
    })

    it('caches an unavailable report without silently retrying recovery', async () => {
        mocks.recoverPending.mockResolvedValue([{ transactionId: 'tx', action: 'failed' }])
        const first = initializeQueueAfterRestart({ providerResultSpool: spool([]) })
        expect((await first).inboxReady).toBe(false)
        expect(initializeQueueAfterRestart({ providerResultSpool: spool([]) })).toBe(first)
        expect(mocks.recoverPending).toHaveBeenCalledOnce()
    })
})
