import { describe, expect, it, vi } from 'vitest'

const persistedSceneStorage = vi.hoisted(() => ({ value: '' }))

vi.mock('@/lib/indexed-db', () => ({
    SCENE_DOCUMENT_STORE_KEY: 'nai-blue-scene-documents',
    FOLDER_DOCUMENT_STORE_KEY: 'nai-blue-generation-folder-documents',
    FOLDER_V1_PREIMAGE_STORE_KEY: 'nai-blue-generation-folder-v1-preimage',
    FOLDER_AUTHORITY_MARKER_STORE_KEY: 'nai-blue-generation-folder-authority',
    compareAndSetIndexedDBItem: async () => false,
    getIndexedDBItemStrict: async (key: string) => (
        key === 'nai-blue-scenes' ? persistedSceneStorage.value : null
    ),
    indexedDBStorage: {
        getItem: async (key: string) => (
            key === 'nai-blue-scenes' ? persistedSceneStorage.value : null
        ),
        setItem: async () => undefined,
        removeItem: async () => undefined,
    },
    setIndexedDBItemStrict: async () => undefined,
}))

import { IndexedDbSceneRepository } from '@/adapters/scene/indexeddb-scene-repository'
import type {
    SceneAuthoringRecord,
    SceneDocument,
} from '@/application/scene/scene-repository'
import {
    getScenePresetPathSegments,
    resolveSceneCharacterCaptions,
    resolveSceneGeneration,
    resolveScenePrompts,
    useSceneStore,
    type SceneCard,
    type ScenePreset,
} from '@/stores/scene-store'
import { applyLegacySceneProjection } from '@/lib/scene-authority-runtime'
import { generationFolderDocumentMutationKey } from '@/application/workspace/workspace-mutation-gate'
import { runtimeWorkspaceMutationGate } from '@/lib/workspace-mutation-gate'

const legacyScene = {
    id: 'scene:legacy',
    name: 'Legacy',
    scenePrompt: 'legacy scalar prompt',
    queueCount: 4,
    queuedFileNames: ['runtime.png'],
    images: [{ id: 'image:legacy', url: 'Scene/legacy.png', timestamp: 10, isFavorite: true }],
    width: 768,
    height: 1024,
    excludePinned: false,
    createdAt: 1_700_000_000_000,
    isGenerating: true,
    compositionDiagnostics: { warnings: ['runtime only'] },
}

const modularScene = {
    id: 'scene:modular',
    name: 'Modular',
    scenePrompt: 'compatibility alias',
    prompts: {
        base: 'base',
        additional: 'modular additional',
        character: 'character',
        negative: 'negative',
        characterNegative: 'character negative',
    },
    characterCaptions: [{
        id: 'caption:1',
        name: 'Hero',
        prompt: 'hero prompt',
        negative: 'hero negative',
        enabled: true,
        position: { x: 0.25, y: 0.75 },
    }],
    characterPositionEnabled: true,
    generation: { steps: 31, cfgScale: 6, seed: 42, seedLocked: true, smea: true },
    queueCount: 2,
    images: [{ id: 'image:modular', url: 'data:image/png;base64,legacy', timestamp: 20, isFavorite: false }],
    metadataMode: 'strip-and-sidecar',
    generationFolderId: 'folder:1',
    filenameTemplate: '{scene}_{index}',
    compositionRef: { recipeId: 'recipe:1', recipeRevision: 7 },
    createdAt: 1_700_000_000_001,
}

const persistedState = {
    presets: [{
        id: 'preset:parent',
        name: 'Parent',
        scenes: [legacyScene],
        parentId: null,
        defaultTemplate: {
            sourceSceneId: legacyScene.id,
            sourceSceneName: legacyScene.name,
            scenePrompt: legacyScene.scenePrompt,
            prompts: { base: '', additional: legacyScene.scenePrompt, character: '', negative: '', characterNegative: '' },
            generation: { model: 'nai-diffusion-4-5-full', steps: 28 },
        },
        createdAt: 1_699_000_000_000,
    }, {
        id: 'preset:child',
        name: 'Child',
        scenes: [modularScene],
        parentId: 'preset:parent',
        createdAt: 1_699_000_000_001,
    }],
    activePresetId: 'preset:child',
    gridColumns: 6,
    thumbnailLayout: 'horizontal',
    scrollPosition: 240,
    isGenerating: true,
    isCancelling: true,
    streamingSession: { id: 'runtime' },
    historyTrigger: 9,
    sceneCompositionResults: { [modularScene.id]: { warnings: ['runtime'] } },
}

const V2_KEY = 'nai-blue-scene-documents'

function authoringScene(id: string): SceneAuthoringRecord {
    return {
        id,
        name: `Scene ${id}`,
        scenePrompt: `prompt ${id}`,
        prompts: { additional: `modular ${id}` },
        generation: { steps: 28, seed: 10 },
        artifactRefs: [{
            artifactId: `artifact:${id}`,
            createdAt: '2026-09-04T00:00:00.000Z',
            favorite: false,
        }],
        createdAt: 1_700_000_000_000,
    }
}

function document(
    presetId: string,
    revision: number,
    scenes: readonly SceneAuthoringRecord[] = [authoringScene(`scene:${presetId}`)],
): SceneDocument {
    return {
        schemaVersion: 1,
        presetId,
        revision,
        scenes,
        updatedAt: `2026-09-04T00:00:0${revision}.000Z`,
    }
}

function collection(...documents: readonly SceneDocument[]): string {
    return JSON.stringify({ schemaVersion: 1, documents })
}

function memoryPersistence(initial: Readonly<Record<string, string>> = {}) {
    const values = new Map(Object.entries(initial))
    const writes: string[] = []
    return {
        values,
        writes,
        port: {
            getItem: async (key: string) => values.get(key) ?? null,
            compareAndSet: async (key: string, expected: string | null, next: string) => {
                if ((values.get(key) ?? null) !== expected) return false
                writes.push(key)
                values.set(key, next)
                return true
            },
        },
    }
}

describe('IndexedDbSceneRepository', () => {
    it('makes a later Queue final check observe a Scene commit that won the shared gate', async () => {
        const current = document('preset:race', 1)
        let serialized = collection(current)
        let releaseCommit!: () => void
        let commitStarted!: () => void
        const started = new Promise<void>(resolve => { commitStarted = resolve })
        const hold = new Promise<void>(resolve => { releaseCommit = resolve })
        const repository = new IndexedDbSceneRepository({
            getItem: async () => serialized,
            compareAndSet: async (_key, expected, next) => {
                if (serialized !== expected) return false
                serialized = next
                commitStarted()
                await hold
                return true
            },
        })
        const committing = repository.commit(document('preset:race', 2), 1)
        await started
        let queueWrites = 0
        const enqueue = runtimeWorkspaceMutationGate.runExclusive(
            generationFolderDocumentMutationKey('local'),
            async () => {
                if ((await repository.getDocument('preset:race'))?.revision === 1) queueWrites += 1
            },
        )
        releaseCommit()

        await expect(committing).resolves.toMatchObject({ status: 'COMMITTED' })
        await enqueue
        expect(queueWrites).toBe(0)
    })

    it('waits to start Scene CAS until a winning Queue reservation releases the shared gate', async () => {
        const current = document('preset:wait', 1)
        const memory = memoryPersistence({ [V2_KEY]: collection(current) })
        const compareAndSet = vi.spyOn(memory.port, 'compareAndSet')
        const repository = new IndexedDbSceneRepository(memory.port)
        let releaseQueue!: () => void
        let queueStarted!: () => void
        const started = new Promise<void>(resolve => { queueStarted = resolve })
        const hold = new Promise<void>(resolve => { releaseQueue = resolve })
        const enqueue = runtimeWorkspaceMutationGate.runExclusive(
            generationFolderDocumentMutationKey('local'),
            async () => { queueStarted(); await hold },
        )
        await started
        const committing = repository.commit(document('preset:wait', 2), 1)
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(compareAndSet).not.toHaveBeenCalled()
        releaseQueue()

        await enqueue
        await expect(committing).resolves.toMatchObject({ status: 'COMMITTED' })
        expect(compareAndSet).toHaveBeenCalledOnce()
    })

    it('reads version 0 without changing the preimage and projects authoring fields only', async () => {
        const preimage = JSON.stringify({ state: persistedState, version: 0 })
        const reads: string[] = []
        const repository = new IndexedDbSceneRepository({
            getItem: async key => {
                reads.push(key)
                return preimage
            },
        })

        const projection = await repository.readLegacyProjection()

        expect(reads).toEqual(['nai-blue-scenes'])
        expect(JSON.stringify({ state: persistedState, version: 0 })).toBe(preimage)
        expect(projection?.presets[0]).toMatchObject({
            id: 'preset:parent',
            name: 'Parent',
            parentId: null,
            defaultTemplate: persistedState.presets[0].defaultTemplate,
            createdAt: 1_699_000_000_000,
        })
        expect(projection?.presets[0].scenes[0].images).toEqual(legacyScene.images)
        expect(projection?.presets[1].scenes[0]).toMatchObject({
            prompts: modularScene.prompts,
            characterCaptions: modularScene.characterCaptions,
            generation: modularScene.generation,
            metadataMode: modularScene.metadataMode,
            generationFolderId: modularScene.generationFolderId,
            filenameTemplate: modularScene.filenameTemplate,
            compositionRef: modularScene.compositionRef,
        })
        expect(projection).not.toHaveProperty('activePresetId')
        expect(projection?.presets[0].scenes[0]).not.toHaveProperty('queueCount')
        expect(projection?.presets[0].scenes[0]).not.toHaveProperty('queuedFileNames')
        expect(projection?.presets[0].scenes[0]).not.toHaveProperty('isGenerating')
        expect(projection?.presets[0].scenes[0]).not.toHaveProperty('compositionDiagnostics')
    })

    it('matches the V1 fallback projection and existing prompt, caption, generation, and path resolvers', async () => {
        persistedSceneStorage.value = JSON.stringify({ state: persistedState, version: 0 })
        const projection = await new IndexedDbSceneRepository({
            getItem: async () => persistedSceneStorage.value,
        }).readLegacyProjection()
        applyLegacySceneProjection(projection!)
        const projectedPresets = projection?.presets as unknown as ScenePreset[]
        const hydrated = useSceneStore.getState()

        for (const sceneId of [legacyScene.id, modularScene.id]) {
            const projected = projectedPresets.flatMap(preset => preset.scenes).find(scene => scene.id === sceneId) as SceneCard
            const hydratedScene = hydrated.presets.flatMap(preset => preset.scenes).find(scene => scene.id === sceneId) as SceneCard
            expect(resolveScenePrompts(projected)).toEqual(resolveScenePrompts(hydratedScene))
            expect(resolveSceneCharacterCaptions(projected)).toEqual(resolveSceneCharacterCaptions(hydratedScene))
            expect(resolveSceneGeneration(projected)).toEqual(resolveSceneGeneration(hydratedScene))
        }
        expect(getScenePresetPathSegments(projectedPresets, 'preset:child')).toEqual(
            getScenePresetPathSegments(hydrated.presets, 'preset:child'),
        )
    })

    it('returns null when the Scene key is missing', async () => {
        await expect(new IndexedDbSceneRepository({ getItem: async () => null }).readLegacyProjection())
            .resolves.toBeNull()
    })

    it.each([
        '{',
        'null',
        JSON.stringify({ state: persistedState }),
        JSON.stringify({ state: persistedState, version: 1 }),
        JSON.stringify({ state: [], version: 0 }),
        JSON.stringify({ state: { presets: 'invalid' }, version: 0 }),
        JSON.stringify({ state: { presets: [{ id: 'broken' }] }, version: 0 }),
    ])('rejects a malformed or unsupported envelope without repairing it: %s', async serialized => {
        const repository = new IndexedDbSceneRepository({ getItem: async () => serialized })
        await expect(repository.readLegacyProjection()).rejects.toBeInstanceOf(TypeError)
    })

    it('returns empty V2 reads and creates revision 1 with expected revision 0', async () => {
        const memory = memoryPersistence()
        const repository = new IndexedDbSceneRepository(memory.port)

        await expect(repository.getDocument('preset:new')).resolves.toBeNull()
        await expect(repository.listDocuments()).resolves.toEqual([])
        await expect(repository.commit(document('preset:new', 1), 0)).resolves.toMatchObject({
            status: 'COMMITTED',
            document: { presetId: 'preset:new', revision: 1 },
        })
        expect(memory.writes).toEqual([V2_KEY])
        await expect(repository.getDocument('preset:new')).resolves.toEqual(document('preset:new', 1))
    })

    it('updates by exactly one revision and commits two Scene changes atomically', async () => {
        const first = document('preset:atomic', 1, [authoringScene('scene:a'), authoringScene('scene:b')])
        const memory = memoryPersistence({ [V2_KEY]: collection(first) })
        const repository = new IndexedDbSceneRepository(memory.port)
        const next = document('preset:atomic', 2, [
            { ...authoringScene('scene:a'), name: 'A updated' },
            { ...authoringScene('scene:b'), name: 'B updated' },
        ])

        await expect(repository.commit(next, 1)).resolves.toEqual({ status: 'COMMITTED', document: next })
        await expect(repository.getDocument('preset:atomic')).resolves.toEqual(next)
    })

    it('rejects stale and jumping revisions without changing storage', async () => {
        const current = document('preset:stale', 2)
        const serialized = collection(current)
        const memory = memoryPersistence({ [V2_KEY]: serialized })
        const repository = new IndexedDbSceneRepository(memory.port)

        await expect(repository.commit(document('preset:stale', 2), 1)).resolves.toEqual({
            status: 'REVISION_CONFLICT',
            current,
        })
        await expect(repository.commit(document('preset:stale', 4), 2)).rejects.toBeInstanceOf(TypeError)
        expect(memory.values.get(V2_KEY)).toBe(serialized)
        expect(memory.writes).toEqual([])
    })

    it('rejects runtime fields and legacy raw image URLs in a V2 commit candidate', async () => {
        const memory = memoryPersistence()
        const repository = new IndexedDbSceneRepository(memory.port)
        const invalid = {
            ...document('preset:invalid', 1),
            scenes: [{ ...authoringScene('scene:invalid'), queueCount: 2, images: legacyScene.images }],
        } as unknown as SceneDocument

        await expect(repository.commit(invalid, 0)).rejects.toBeInstanceOf(TypeError)
        expect(memory.values.has(V2_KEY)).toBe(false)
    })

    it('re-reads after a storage race and preserves another preset document', async () => {
        const target = document('preset:target', 1)
        const other = document('preset:other', 1)
        let serialized = collection(target)
        let attempts = 0
        const repository = new IndexedDbSceneRepository({
            getItem: async key => key === V2_KEY ? serialized : null,
            compareAndSet: async (_key, _expected, next) => {
                attempts += 1
                if (attempts === 1) {
                    serialized = collection(target, other)
                    return false
                }
                serialized = next
                return true
            },
        })

        await expect(repository.commit(document('preset:target', 2), 1)).resolves.toMatchObject({ status: 'COMMITTED' })
        expect(attempts).toBe(2)
        const documents = JSON.parse(serialized) as { documents: SceneDocument[] }
        expect(documents.documents).toEqual(expect.arrayContaining([other, document('preset:target', 2)]))
    })

    it('returns a semantic conflict when the raced write advanced the same preset', async () => {
        const target = document('preset:target', 1)
        const concurrent = document('preset:target', 2)
        let serialized = collection(target)
        const repository = new IndexedDbSceneRepository({
            getItem: async () => serialized,
            compareAndSet: async () => {
                serialized = collection(concurrent)
                return false
            },
        })

        await expect(repository.commit(document('preset:target', 2), 1)).resolves.toEqual({
            status: 'REVISION_CONFLICT',
            current: concurrent,
        })
    })

    it('returns STORAGE_CONFLICT after three storage CAS failures', async () => {
        let attempts = 0
        const repository = new IndexedDbSceneRepository({
            getItem: async () => null,
            compareAndSet: async () => {
                attempts += 1
                return false
            },
        })

        await expect(repository.commit(document('preset:contended', 1), 0)).resolves.toEqual({
            status: 'STORAGE_CONFLICT',
        })
        expect(attempts).toBe(3)
    })

    it.each([
        '{',
        JSON.stringify({ schemaVersion: 2, documents: [] }),
        JSON.stringify({ schemaVersion: 1, documents: 'invalid' }),
        JSON.stringify({ schemaVersion: 1, documents: [document('duplicate', 1), document('duplicate', 1)] }),
        JSON.stringify({
            schemaVersion: 1,
            documents: [{
                ...document('raw-url', 1),
                scenes: [{ ...authoringScene('scene:raw'), images: legacyScene.images }],
            }],
        }),
    ])('fails closed on malformed or future V2 collections: %s', async serialized => {
        const repository = new IndexedDbSceneRepository({ getItem: async () => serialized })
        await expect(repository.getDocument('preset:any')).rejects.toBeInstanceOf(TypeError)
        await expect(repository.listDocuments()).rejects.toBeInstanceOf(TypeError)
    })

    it('returns detached document and summary clones in deterministic preset order', async () => {
        const first = document('preset:b', 1)
        const second = document('preset:a', 1)
        const memory = memoryPersistence({ [V2_KEY]: collection(first, second) })
        const repository = new IndexedDbSceneRepository(memory.port)

        const found = await repository.getDocument('preset:b')
        ;(found as { scenes: Array<{ name: string }> }).scenes[0].name = 'mutated outside'
        expect((await repository.getDocument('preset:b'))?.scenes[0].name).toBe(first.scenes[0].name)

        const summaries = await repository.listDocuments()
        expect(summaries.map(summary => summary.presetId)).toEqual(['preset:a', 'preset:b'])
        ;(summaries as Array<{ presetId: string }>)[0].presetId = 'mutated outside'
        expect((await repository.listDocuments()).map(summary => summary.presetId)).toEqual(['preset:a', 'preset:b'])
    })

    it('writes only the V2 key and leaves the legacy reader preimage unchanged', async () => {
        const legacy = JSON.stringify({ state: persistedState, version: 0 })
        const memory = memoryPersistence({ 'nai-blue-scenes': legacy })
        const repository = new IndexedDbSceneRepository(memory.port)

        await expect(repository.commit(document('preset:v2', 1), 0)).resolves.toMatchObject({ status: 'COMMITTED' })
        expect(memory.values.get('nai-blue-scenes')).toBe(legacy)
        expect(memory.writes).toEqual([V2_KEY])
        expect((await repository.readLegacyProjection())?.presets).toHaveLength(2)
    })
})
