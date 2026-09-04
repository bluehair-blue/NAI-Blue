import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
    platform: 'windows' as 'windows' | 'linux',
    planningSnapshot: vi.fn(),
    listPending: vi.fn(async () => []),
    resolveDirectory: vi.fn(async (destination: { directory?: string | null }) => ({
        path: destination.directory ?? 'output',
        displayPath: destination.directory ?? 'output',
        baseDir: 1,
        capabilityFallbackUsed: false,
    })),
    entries: new Map<string, readonly string[]>(),
    reservations: new Map<string, unknown>(),
    pending: [] as Array<{ path: string; displayPath: string; baseDir: number }>,
    readDirectoryEntries: vi.fn(async (directory: { path: string }) => runtime.entries.get(directory.path) ?? []),
}))

vi.mock('@/services/queue/indexeddb-queue-repository', () => ({
    getRuntimeQueueRepository: () => ({
        getOutputReservationPlanningSnapshot: runtime.planningSnapshot,
    }),
}))
vi.mock('@/services/output/tauri-output-adapter', () => ({
    createRuntimeOutputPlatformAdapter: () => ({
        resolveDirectory: runtime.resolveDirectory,
        readDirectoryEntries: runtime.readDirectoryEntries,
    }),
}))
vi.mock('@/services/output/output-writer', () => ({
    getRuntimeOutputWriter: () => ({ listPendingFinalOutputRefs: runtime.listPending }),
}))
vi.mock('@/platform/capabilities', () => ({
    runtimeCapabilities: { get platform() { return runtime.platform } },
}))
vi.mock('@/stores/auth-store', () => ({
    selectActiveCredentialsAreOpus: () => false,
    useAuthStore: { getState: () => ({ getActiveTokens: () => [] }) },
}))
vi.mock('@/stores/settings-store', () => ({ useSettingsStore: { getState: () => ({}) } }))
vi.mock('@/services/queue/runtime', () => ({ configureRuntimeQueueDependencies: vi.fn() }))
vi.mock('@/presentation/generation/zustand-main-batch-planner', () => ({ createZustandMainBatchPlanner: vi.fn() }))
vi.mock('@/presentation/queue/zustand-main-queue-presentation', () => ({ createZustandMainQueuePresentation: vi.fn() }))
vi.mock('@/presentation/queue/zustand-style-lab-queue-presentation', () => ({ createZustandStyleLabQueuePresentation: vi.fn() }))
vi.mock('@/presentation/scene/zustand-scene-result-presentation', () => ({ createZustandSceneResultPresentation: vi.fn() }))
vi.mock('@/adapters/generation/desktop-provider-result-spool', () => ({ DesktopProviderResultSpool: class {} }))
vi.mock('@/application/folder/generation-folder-binding', () => ({ createGenerationFolderDocumentBinding: vi.fn() }))

import { planOutputCommitSetBatch } from '@/composition-root/core-runtime'
import { createGenerationOutputCommitSet } from '@/services/output/generation-output-commit-set'
import { directoryIdentityForResolvedOutputDirectory } from '@/services/output/platform-adapter'

const folderBinding = {
    resourceType: 'generation-folder-document' as const,
    resourceId: 'folder:output',
    revision: 1,
    contentHash: `sha256:${'d'.repeat(64)}` as const,
}

function existingReservation(input: {
    readonly reservationId: string
    readonly jobId: string
    readonly fileName: string
    readonly collisionPolicy: 'fail' | 'suffix'
    readonly state: 'reserved' | 'committed' | 'abandoned'
}) {
    const directoryIdentity = directoryIdentityForResolvedOutputDirectory({
        path: 'output', displayPath: 'output', baseDir: 1, capabilityFallbackUsed: false,
    }, 'windows')
    const selected = createGenerationOutputCommitSet({
        fileName: input.fileName,
        imageFormat: 'png',
        metadataMode: 'sidecar-only',
        preserveProviderOriginal: false,
        directoryAuthorityId: folderBinding.resourceId,
        directoryAuthorityFingerprint: directoryIdentity,
        filesystemSemantics: 'windows',
    })
    return {
        reservationSchemaVersion: 1 as const,
        reservationId: input.reservationId,
        batchId: 'batch:1',
        jobId: input.jobId,
        folderBinding,
        directoryIdentity,
        relativePath: input.fileName,
        collisionPolicy: input.collisionPolicy,
        expectedExistingDigest: null,
        ...selected,
        state: input.state,
        version: 1,
        updatedAt: '2026-09-04T00:00:00.000Z',
    }
}

describe('runtime output batch planning', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        runtime.platform = 'windows'
        runtime.entries.clear()
        runtime.entries.set('output', ['portrait.png'])
        runtime.reservations.clear()
        runtime.pending.length = 0
        runtime.planningSnapshot.mockImplementation(async (ids: readonly string[]) => ({
            reservations: ids.map(id => runtime.reservations.get(id) ?? null),
            activeCollisionKeys: [],
        }))
        runtime.listPending.mockImplementation(async () => runtime.pending)
    })

    it('reads active claims once and each resolved claim parent once for the whole batch', async () => {
        const destination = {
            directory: 'output', useAbsolutePath: false, workflowDefaultDirectory: 'output',
            extension: 'png' as const, collisionPolicy: 'error' as const,
        }
        const requests = [0, 1].map(ordinal => ({
            destination,
            claimPlan: {
                fileName: 'portrait.png', imageFormat: 'png' as const,
                metadataMode: 'sidecar-only' as const, preserveProviderOriginal: true,
            },
            collisionPolicy: 'suffix' as const,
            directoryAuthorityId: 'folder:output',
            folderBinding,
            reservationIdentity: {
                reservationId: `reservation:${ordinal}`,
                batchId: 'batch:1',
                jobId: `job:${ordinal}`,
            },
        }))

        const result = await planOutputCommitSetBatch(requests)

        expect(runtime.planningSnapshot).toHaveBeenCalledOnce()
        expect(runtime.listPending).toHaveBeenCalledOnce()
        expect(runtime.readDirectoryEntries.mock.calls.map(([directory]) => directory.path).sort()).toEqual([
            'output', 'output/._nai-blue-private',
        ])
        expect(result.map(allocation => allocation.fileName)).toEqual(['portrait-2.png', 'portrait-3.png'])
    })

    it.each([
        ['reserved', 'suffix', 'portrait-2.png'],
        ['committed', 'fail', 'portrait.png'],
    ] as const)('reuses a matching %s %s reservation despite its own final files', async (state, policy, fileName) => {
        runtime.entries.set('output', ['portrait.png', 'portrait-2.png', 'portrait.nai-blue.json', 'portrait-2.nai-blue.json'])
        runtime.reservations.set('reservation:0', existingReservation({
            reservationId: 'reservation:0', jobId: 'job:0', fileName, collisionPolicy: policy, state,
        }))

        const replayRequest = [{
            destination: {
                directory: 'output', useAbsolutePath: false, workflowDefaultDirectory: 'output',
                extension: 'png', collisionPolicy: 'error',
            },
            claimPlan: {
                fileName: 'portrait.png', imageFormat: 'png',
                metadataMode: 'sidecar-only', preserveProviderOriginal: false,
            },
            collisionPolicy: policy,
            directoryAuthorityId: folderBinding.resourceId,
            folderBinding,
            reservationIdentity: { reservationId: 'reservation:0', batchId: 'batch:1', jobId: 'job:0' },
        }] as const
        const [[first], [second]] = await Promise.all([
            planOutputCommitSetBatch(replayRequest),
            planOutputCommitSetBatch(replayRequest),
        ])

        expect(first.fileName).toBe(fileName)
        expect(second.fileName).toBe(fileName)
    })

    it('keeps replay claims occupied for fresh jobs in the same batch', async () => {
        runtime.reservations.set('reservation:0', existingReservation({
            reservationId: 'reservation:0', jobId: 'job:0', fileName: 'portrait-2.png',
            collisionPolicy: 'suffix', state: 'reserved',
        }))
        const requests = [0, 1].map(ordinal => ({
            destination: {
                directory: 'output', useAbsolutePath: false, workflowDefaultDirectory: 'output',
                extension: 'png' as const, collisionPolicy: 'error' as const,
            },
            claimPlan: {
                fileName: 'portrait.png', imageFormat: 'png' as const,
                metadataMode: 'sidecar-only' as const, preserveProviderOriginal: false,
            },
            collisionPolicy: 'suffix' as const,
            directoryAuthorityId: folderBinding.resourceId,
            folderBinding,
            reservationIdentity: {
                reservationId: `reservation:${ordinal}`, batchId: 'batch:1', jobId: `job:${ordinal}`,
            },
        }))

        await expect(planOutputCommitSetBatch(requests)).resolves.toEqual([
            expect.objectContaining({ fileName: 'portrait-2.png' }),
            expect.objectContaining({ fileName: 'portrait-3.png' }),
        ])
    })

    it('fails closed for an abandoned deterministic reservation', async () => {
        runtime.reservations.set('reservation:0', existingReservation({
            reservationId: 'reservation:0', jobId: 'job:0', fileName: 'portrait.png',
            collisionPolicy: 'fail', state: 'abandoned',
        }))
        await expect(planOutputCommitSetBatch([{
            destination: { directory: 'output', workflowDefaultDirectory: 'output', extension: 'png' },
            claimPlan: {
                fileName: 'portrait.png', imageFormat: 'png', metadataMode: 'sidecar-only',
                preserveProviderOriginal: false,
            },
            collisionPolicy: 'fail',
            directoryAuthorityId: folderBinding.resourceId,
            folderBinding,
            reservationIdentity: { reservationId: 'reservation:0', batchId: 'batch:1', jobId: 'job:0' },
        }])).rejects.toThrow('does not match')
    })

    it('fails closed when a suffix replay filename is unrelated to the deterministic request', async () => {
        runtime.reservations.set('reservation:0', existingReservation({
            reservationId: 'reservation:0', jobId: 'job:0', fileName: 'unrelated.png',
            collisionPolicy: 'suffix', state: 'reserved',
        }))
        await expect(planOutputCommitSetBatch([{
            destination: { directory: 'output', workflowDefaultDirectory: 'output', extension: 'png' },
            claimPlan: {
                fileName: 'portrait.png', imageFormat: 'png', metadataMode: 'sidecar-only',
                preserveProviderOriginal: false,
            },
            collisionPolicy: 'suffix', directoryAuthorityId: folderBinding.resourceId, folderBinding,
            reservationIdentity: { reservationId: 'reservation:0', batchId: 'batch:1', jobId: 'job:0' },
        }])).rejects.toThrow('commit set does not match')
    })

    it('preserves Linux case-distinct parents and journal containment', async () => {
        runtime.platform = 'linux'
        runtime.entries.clear()
        runtime.pending.push({ path: 'Output/pending.png', displayPath: 'pending', baseDir: 1 })
        const request = (directory: string, ordinal: number) => ({
            destination: { directory, workflowDefaultDirectory: directory, extension: 'png' as const },
            claimPlan: {
                fileName: 'pending.png', imageFormat: 'png' as const,
                metadataMode: 'embedded' as const, preserveProviderOriginal: false,
            },
            collisionPolicy: 'fail' as const,
            directoryAuthorityId: folderBinding.resourceId,
            folderBinding,
            reservationIdentity: {
                reservationId: `reservation:${ordinal}`, batchId: 'batch:1', jobId: `job:${ordinal}`,
            },
        })

        await expect(planOutputCommitSetBatch([request('output', 0)]))
            .resolves.toEqual([expect.objectContaining({ fileName: 'pending.png' })])
        await planOutputCommitSetBatch([request('Output', 1), request('output', 2)]).catch(() => undefined)
        expect(runtime.readDirectoryEntries.mock.calls.map(([directory]) => directory.path))
            .toEqual(expect.arrayContaining(['Output', 'output']))
    })
})
