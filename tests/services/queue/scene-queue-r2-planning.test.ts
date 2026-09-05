import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { GenerationFolderDocument, GenerationFolderV2 } from '@/domain/generation-folders'
import { createR2ProfileV2, hashR2ProfileV2 } from '@/domain/r2/types'
import { createGenerationOutputCommitSet } from '@/services/output/generation-output-commit-set'
import type { OutputCommitSetPlanningRequest } from '@/services/queue/main-queue-runtime-dependencies'

const runtime = vi.hoisted(() => ({
    folder: vi.fn(), scene: vi.fn(), profile: vi.fn(), readiness: vi.fn(), allocation: vi.fn(), enqueue: vi.fn(),
    build: vi.fn(), dehydrate: vi.fn(),
}))
vi.mock('@/adapters/folder/indexeddb-generation-folder-repository', () => ({
    IndexedDbGenerationFolderRepository: class { getDocument = runtime.folder },
}))
vi.mock('@/lib/scene-migration-startup', () => ({ getRuntimeSceneRepository: () => ({ getDocument: runtime.scene }) }))
vi.mock('@/stores/auth-store', () => ({ selectActiveCredentialsAreOpus: () => true, useAuthStore: { getState: () => ({}) } }))
vi.mock('@/stores/character-store', () => ({ useCharacterStore: { getState: () => ({ releaseImageData: () => undefined }) } }))
vi.mock('@/stores/character-rotation-store', () => ({ useRotationStore: { getState: () => ({ active: false }) } }))
vi.mock('@/stores/queue-store', () => ({ useQueueStore: { getState: () => ({
    beginEnqueueOperation: () => 'operation', completeEnqueueOperation: () => undefined,
}) } }))
vi.mock('@/stores/settings-store', () => ({ useSettingsStore: { getState: () => ({
    generationFolders: [], sceneSavePath: 'output', useAbsoluteScenePath: false,
    sceneSubfoldersEnabled: false, metadataMode: 'embedded', useStreaming: false,
}) } }))
vi.mock('@/stores/scene-store', () => ({
    getScenePresetPathSegments: () => ['Preset'],
    resolveSceneGeneration: () => ({ seed: 7, seedLocked: true }),
    useSceneStore: { getState: () => ({ presets: [{ id: 'preset', name: 'Preset', scenes: [], createdAt: 0 }],
        recordSceneCompositionResult: () => undefined, consumeSceneGenerationSeed: () => undefined,
        consumeSceneQueueEntries: () => undefined,
    }) },
}))
vi.mock('@/lib/scene-generation/build-scene-params', () => ({ buildSceneGenerationParams: runtime.build }))
vi.mock('@/lib/scene-output-path', () => ({ getRotationCharacterFolderName: () => null }))
vi.mock('@/lib/workspace-mutation-gate', () => ({ runtimeWorkspaceMutationGate: {
    runExclusive: async (_key: string, work: () => Promise<unknown>) => work(),
} }))
vi.mock('@/platform/capabilities', () => ({ runtimeCapabilities: {
    generationPublication: { supported: true, outputReservationGuarantee: 'atomic-no-replace', generationLimits: {
        maxJobsPerAtomicBatch: 100, maxOutputClaimsPerAtomicBatch: 400,
    } },
} }))
vi.mock('@/services/queue/main-queue-runtime-dependencies', () => ({ getRuntimeMainQueueDependencies: () => ({
    r2Planning: { getProfile: runtime.profile, getReadiness: runtime.readiness },
    outputReservations: { planBatch: runtime.allocation },
}) }))
vi.mock('@/services/queue/indexeddb-queue-repository', () => ({
    assertGenerationAtomicBatchAvailable: () => undefined,
    getRuntimeQueueRepository: () => ({ createBatchAndEnqueue: runtime.enqueue }),
}))
vi.mock('@/services/queue/queue-resource-materializer', () => ({
    getRuntimeQueueResourceMaterializer: () => ({}), dehydrateGenerationParams: runtime.dehydrate,
}))

import { enqueueReviewedSceneQueue, prepareSceneQueueReview, type SceneQueueTarget } from '@/services/queue/scene-queue-adapter'
import { decodeSceneJobSnapshot } from '@/services/queue/scene-job-snapshot-codec'

const selected = createR2ProfileV2({
    id: 'profile-1', name: 'Profile', accountId: 'account', jurisdiction: null, endpoint: null,
    bucket: 'profile-bucket', prefix: 'base', credentialRef: 'credential-fixture', transport: 'native-s3',
    conflictPolicy: 'fail', publicMode: 'r2-dev', publicBaseUrl: null,
}, '2026-09-05T00:00:00.000Z')
const parent: GenerationFolderV2 = {
    id: 'parent', displayName: 'Parent', pathSegment: 'parent', parentId: null, rootDirectory: 'output',
    useAbsolutePath: false, commonPrompt: '', autoUpload: true,
    r2ProfilePolicy: { mode: 'set', value: selected.id },
    r2BucketPolicy: { mode: 'set', value: 'ancestor-bucket' },
    r2PrefixPolicy: { mode: 'set', value: 'ancestor' },
}
const child: GenerationFolderV2 = {
    ...parent, id: 'child', displayName: 'Child', pathSegment: 'child', parentId: 'parent', rootDirectory: null,
    r2ProfilePolicy: { mode: 'inherit' }, r2BucketPolicy: { mode: 'inherit' }, r2PrefixPolicy: { mode: 'inherit' },
}
function folder(patch: Partial<GenerationFolderV2> = {}): GenerationFolderDocument {
    return { schemaVersion: 2, workspaceId: 'local', revision: 3, folders: [parent, { ...child, ...patch }] }
}
const target: SceneQueueTarget = { presetId: 'preset', sceneId: 'scene', count: 1, fileNames: ['scene.png'] }
const params = {
    model: 'nai-diffusion-4-5-full', width: 832, height: 1216, steps: 28, seed: 7,
    prompt: 'A room', negative_prompt: '', cfg_scale: 5, cfg_rescale: 0, sampler: 'k_euler', scheduler: 'karras',
    smea: false, smea_dyn: false, variety: false, imageFormat: 'png', metadataMode: 'embedded',
}

beforeEach(() => {
    vi.clearAllMocks()
    runtime.folder.mockResolvedValue(folder())
    runtime.scene.mockResolvedValue({ schemaVersion: 1, presetId: 'preset', revision: 2, updatedAt: '2026-09-05T00:00:00.000Z',
        scenes: [{ id: 'scene', name: 'Scene', scenePrompt: 'A room', generationFolderId: 'child',
            generation: { seed: 7, seedLocked: true }, artifactRefs: [], createdAt: 1 }],
    })
    runtime.profile.mockResolvedValue(selected)
    runtime.readiness.mockResolvedValue({ status: 'ready', credentialRef: selected.credentialRef })
    runtime.build.mockResolvedValue({ success: true, params, finalPrompt: 'A room', mimeType: 'image/png',
        sequenceCommitProposal: null, planHash: null, mode: 'legacy', warnings: [], errors: [],
    })
    runtime.dehydrate.mockImplementation(async value => ({ parameters: {
        generationParams: value, resourceBindings: [], resourceArrayLengths: {},
    }, records: [], resources: [] }))
    runtime.enqueue.mockResolvedValue({ batch: {}, jobs: [] })
    runtime.allocation.mockImplementation(async (requests: readonly OutputCommitSetPlanningRequest[]) => requests.map(request => ({
        fileName: request.claimPlan.fileName, directoryIdentity: `sha256:${'b'.repeat(64)}`,
        ...createGenerationOutputCommitSet({ ...request.claimPlan, directoryAuthorityId: request.directoryAuthorityId,
            directoryAuthorityFingerprint: `sha256:${'b'.repeat(64)}` }),
    })))
})

describe('Scene Queue R2 reviewed planning', () => {
    it.each([
        { patch: {}, bucket: 'ancestor-bucket', prefix: 'ancestor/child', bucketSource: 'ancestor', prefixSource: 'ancestor', sourceId: 'parent' },
        { patch: { r2BucketPolicy: { mode: 'set', value: 'child-bucket' }, r2PrefixPolicy: { mode: 'set', value: 'chosen' } }, bucket: 'child-bucket', prefix: 'chosen', bucketSource: 'folder', prefixSource: 'folder', sourceId: 'child' },
        { patch: { r2PrefixPolicy: { mode: 'clear' } }, bucket: 'ancestor-bucket', prefix: '', bucketSource: 'ancestor', prefixSource: 'cleared', sourceId: 'child' },
    ] as const)('keeps $prefixSource destination from review through Queue snapshot', async expected => {
        runtime.folder.mockResolvedValue(folder(expected.patch))
        const unchanged = structuredClone(selected)
        const prepared = await prepareSceneQueueReview([{ ...target, r2Requirement: { mode: 'required', profileId: selected.id } }])
        expect(runtime.enqueue).not.toHaveBeenCalled()
        const destination = prepared!.review.r2Destinations[0]!
        expect(destination).toMatchObject({ requirement: 'required', bucket: expected.bucket,
            key: [expected.prefix, 'scene.png'].filter(Boolean).join('/'), provenance: {
                bucket: expected.bucketSource, prefix: expected.prefixSource,
                folder: { id: 'child', profileId: 'parent', prefix: expected.sourceId },
            },
        })
        expect(JSON.stringify(prepared!.review)).not.toContain('credential')
        await enqueueReviewedSceneQueue(prepared!.submission)
        const queued = runtime.enqueue.mock.calls[0][0].jobs[0]
        const workflow = decodeSceneJobSnapshot(queued.snapshot).sceneWorkflow
        expect(workflow.r2Delivery).toMatchObject({ requirement: 'required', planned: {
            destination, profile: { ...selected, bucket: expected.bucket, prefix: expected.prefix },
            sourceProfileHash: hashR2ProfileV2(selected),
        } })
        expect(workflow.batch!.planHash).toBe(queued.compositionPlanHash)
        expect(selected).toEqual(unchanged)
    })

    it('blocks required readiness before Queue writes and rechecks after review', async () => {
        const requested = [{ ...target, r2Requirement: { mode: 'required' as const, profileId: selected.id } }]
        runtime.readiness.mockResolvedValue({ status: 'not-ready', reason: 'credential' })
        await expect(prepareSceneQueueReview(requested)).rejects.toThrow('required R2 profile and credential are not ready')
        expect(runtime.enqueue).not.toHaveBeenCalled()
        runtime.readiness.mockResolvedValue({ status: 'ready', credentialRef: selected.credentialRef })
        const prepared = await prepareSceneQueueReview(requested)
        runtime.readiness.mockResolvedValue({ status: 'not-ready', reason: 'credential' })
        await expect(enqueueReviewedSceneQueue(prepared!.submission)).rejects.toThrow()
        expect(runtime.enqueue).not.toHaveBeenCalled()
    })

    it('rejects bucket clear and respects profile clear or explicit disabled', async () => {
        runtime.folder.mockResolvedValue(folder({ r2BucketPolicy: { mode: 'clear' } }))
        await expect(prepareSceneQueueReview([target])).rejects.toThrow('bucket is cleared or invalid')
        expect(runtime.enqueue).not.toHaveBeenCalled()
        for (const explicit of [false, true]) {
            runtime.folder.mockResolvedValue(folder(explicit ? {} : { r2ProfilePolicy: { mode: 'clear' } }))
            const prepared = await prepareSceneQueueReview([{ ...target, ...(explicit ? { r2Requirement: { mode: 'disabled' as const } } : {}) }])
            expect(prepared!.review.r2Destinations).toEqual([])
            await enqueueReviewedSceneQueue(prepared!.submission)
            const queued = runtime.enqueue.mock.lastCall![0].jobs[0]
            expect(decodeSceneJobSnapshot(queued.snapshot).sceneWorkflow.r2Delivery).toEqual({ requirement: 'disabled', planned: null })
        }
    })

    it('binds a changed requirement into batch and composition hashes with all other planning inputs fixed', async () => {
        vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000000')
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-09-05T00:00:00.000Z'))
        try {
            const hashes: string[] = []
            for (const mode of ['best-effort', 'required'] as const) {
                const prepared = await prepareSceneQueueReview([{ ...target, r2Requirement: { mode, profileId: selected.id } }])
                await enqueueReviewedSceneQueue(prepared!.submission)
                const queued = runtime.enqueue.mock.lastCall![0].jobs[0]
                const workflow = decodeSceneJobSnapshot(queued.snapshot).sceneWorkflow
                expect(workflow.r2Delivery.requirement).toBe(mode)
                expect(workflow.batch!.planHash).toBe(queued.compositionPlanHash)
                hashes.push(queued.compositionPlanHash)
            }
            expect(hashes[0]).not.toBe(hashes[1])
        } finally { vi.useRealTimers() }
    })
})
