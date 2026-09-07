import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
    CommitResult,
    SceneDocument,
    SceneRepositoryPort,
    SceneV1CompatibilityProjection,
} from '@/application/scene/scene-repository'
import { createArtifactRecord } from '@/domain/organizer/types'
import {
    bindDurableSceneOutputDirectory,
    hydrateDurableSceneOutputDirectories,
} from '@/lib/scene-output-portable-locator'
import { runtimeCapabilities } from '@/platform/capabilities'
import { assessPortablePath, runtimePortablePathTokenRegistry } from '@/platform/portable-resources'
import {
    activateSceneAuthorityRuntime,
    applyLegacySceneProjection,
    applySceneDocumentProjection,
    flushSceneAuthorityRuntime,
    stopSceneAuthorityRuntimeForTests,
} from '@/lib/scene-authority-runtime'
import { projectScenePresentationState, sceneImagePresentationKey, useSceneStore } from '@/stores/scene-store'
import { useSettingsStore } from '@/stores/settings-store'

const LEGACY: SceneV1CompatibilityProjection = {
    presets: [{
        id: 'preset-a',
        name: 'Preset A',
        parentId: null,
        createdAt: 1,
        scenes: [{
            id: 'scene-a',
            name: 'Scene A',
            scenePrompt: 'legacy prompt',
            images: [{
                id: 'legacy-image',
                url: 'data:image/png;base64,legacy-only',
                timestamp: 2,
                isFavorite: false,
            }],
            createdAt: 1,
        }],
    }],
}

function document(revision = 1, prompt = 'v2 prompt'): SceneDocument {
    return {
        schemaVersion: 1,
        presetId: 'preset-a',
        revision,
        updatedAt: `2026-09-04T00:00:0${revision}.000Z`,
        scenes: [{
            id: 'scene-a',
            name: 'Scene A',
            scenePrompt: prompt,
            artifactRefs: [{
                artifactId: 'artifact-a',
                createdAt: '2026-09-04T00:00:00.000Z',
                favorite: false,
            }],
            createdAt: 1,
        }],
    }
}

class MemoryRepository implements SceneRepositoryPort {
    readonly commits: { next: SceneDocument; expected: number }[] = []

    constructor(
        private current: SceneDocument | null,
        private readonly legacy: SceneV1CompatibilityProjection | null = LEGACY,
        private readonly onCommit: () => void = () => undefined,
    ) {}

    async readLegacyProjection() { return this.legacy }
    async getDocument(presetId: string) { return this.current?.presetId === presetId ? structuredClone(this.current) : null }
    async listDocuments() {
        return this.current === null ? [] : [{
            presetId: this.current.presetId,
            revision: this.current.revision,
            sceneCount: this.current.scenes.length,
            updatedAt: this.current.updatedAt,
        }]
    }
    async commit(next: SceneDocument, expected: number): Promise<CommitResult> {
        this.onCommit()
        this.commits.push({ next: structuredClone(next), expected })
        if ((this.current?.revision ?? 0) !== expected) {
            return { status: 'REVISION_CONFLICT', current: structuredClone(this.current) }
        }
        this.current = structuredClone(next)
        return { status: 'COMMITTED', document: structuredClone(next) }
    }
}

function resetStore(): void {
    useSceneStore.setState({
        presets: [{ id: 'scene-default', name: '기본', scenes: [], parentId: null, createdAt: 0 }],
        activePresetId: 'scene-default',
        sceneAuthorityInitialized: false,
        legacyImagePresentation: {},
        selectedSceneIds: [],
        lastSelectedSceneId: null,
        isEditMode: false,
    })
}

describe('Scene Zustand authority runtime', () => {
    beforeEach(resetStore)
    afterEach(stopSceneAuthorityRuntimeForTests)

    it('persists only presentation shells and never raw Scene authoring or images', () => {
        expect(useSceneStore.persist.getOptions().name).toBe('nai-blue-scene-presentation')
        useSceneStore.setState({
            presets: [{
                id: 'preset-a',
                name: 'Preset A',
                parentId: null,
                createdAt: 1,
                scenes: [{
                    id: 'scene-a',
                    name: 'Scene A',
                    scenePrompt: 'must-not-persist',
                    queueCount: 7,
                    images: [{ id: 'image-a', url: 'data:image/png;base64,secret', timestamp: 1, isFavorite: false }],
                    artifactRefs: document().scenes[0].artifactRefs.map(reference => ({ ...reference })),
                    createdAt: 1,
                }],
            }],
        })

        const projected = projectScenePresentationState(useSceneStore.getState())

        expect(projected.presets[0]).toMatchObject({ id: 'preset-a', name: 'Preset A', scenes: [] })
        expect(JSON.stringify(projected)).not.toMatch(/must-not-persist|base64|artifact-a|queueCount/)
    })

    it('bootstraps once from V1 shells, reopens V2 authoring, and keeps orphan documents hidden', async () => {
        const orphan = { ...document(), presetId: 'deleted-preset' }
        const repository = new MemoryRepository(document())
        const runtime = await activateSceneAuthorityRuntime(repository, {
            documents: [document(), orphan],
            legacyProjection: LEGACY,
        })
        expect(useSceneStore.getState().presets.map(preset => preset.id)).toEqual(['preset-a'])
        expect(useSceneStore.getState().presets[0].scenes[0]).toMatchObject({
            scenePrompt: 'v2 prompt',
            queueCount: 0,
            images: [{ id: 'legacy-image' }],
            artifactRefs: [{ artifactId: 'artifact-a' }],
        })

        const persisted = projectScenePresentationState(useSceneStore.getState())
        runtime.stop()
        useSceneStore.setState(persisted)
        const reopened = await activateSceneAuthorityRuntime(repository, {
            documents: [document(), orphan],
            legacyProjection: LEGACY,
        })

        expect(useSceneStore.getState().presets.map(preset => preset.id)).toEqual(['preset-a'])
        expect(useSceneStore.getState().presets[0].scenes[0].scenePrompt).toBe('v2 prompt')
        reopened.stop()
    })

    it('restores the preserved V1 projection without starting a repository writer', async () => {
        const repository = new MemoryRepository(document())
        const runtime = await activateSceneAuthorityRuntime(repository, {
            documents: [document()],
            legacyProjection: LEGACY,
        })

        applyLegacySceneProjection(LEGACY)
        useSceneStore.getState().updateScenePrompt('preset-a', 'scene-a', 'legacy-only edit')
        await runtime.flush()

        expect(useSceneStore.getState().presets[0].scenes[0]).toMatchObject({
            scenePrompt: 'legacy-only edit',
            queueCount: 0,
            images: [{ id: 'legacy-image', url: 'data:image/png;base64,legacy-only' }],
            artifactRefs: [],
        })
        expect(useSceneStore.getState().sceneAuthorityInitialized).toBe(false)
        expect(repository.commits).toHaveLength(0)
    })

    it('reapplies ID-only favorite and delete overlays without persisting legacy image bytes', () => {
        applyLegacySceneProjection(LEGACY)
        useSceneStore.getState().toggleFavorite('preset-a', 'scene-a', 'legacy-image')
        applyLegacySceneProjection(LEGACY)
        expect(useSceneStore.getState().presets[0].scenes[0].images[0].isFavorite).toBe(true)

        useSceneStore.getState().deleteImage('preset-a', 'scene-a', 'legacy-image')
        const projected = projectScenePresentationState(useSceneStore.getState())
        applyLegacySceneProjection(LEGACY)

        expect(useSceneStore.getState().presets[0].scenes[0].images).toEqual([])
        expect(JSON.stringify(projected)).not.toMatch(/base64|legacy-only/)
        expect(projected.legacyImagePresentation).toEqual({
            '["preset-a","scene-a","legacy-image"]': { deleted: true },
        })
    })

    it('reopens Organizer originals and persists artifact favorite/delete through Scene CAS', async () => {
        const order: string[] = []
        const linked = document()
        const withMissing: SceneDocument = {
            ...linked,
            scenes: [{
                ...linked.scenes[0],
                artifactRefs: [...linked.scenes[0].artifactRefs, {
                    artifactId: 'artifact-missing',
                    createdAt: '2026-09-04T00:00:02.000Z',
                    favorite: true,
                }],
            }],
        }
        const artifact = createArtifactRecord({
            artifactId: 'artifact-a',
            sourceSceneId: 'scene-a',
            file: {
                directory: { kind: 'standard', root: 'pictures', segments: ['NAI Blue'] },
                fileName: 'scene-a.png',
            },
            format: 'png',
            contentChecksum: `sha256:${'a'.repeat(64)}`,
            size: 12,
            createdAt: '2026-09-04T00:00:00.000Z',
        })
        const artifactPresentation = {
            get: async (artifactId: string) => artifactId === artifact.artifactId ? artifact : null,
            resolveOriginalPath: async () => 'E:\\Pictures\\NAI Blue\\scene-a.png',
        }
        const repository = new MemoryRepository(withMissing, LEGACY, () => order.push('scene-cas'))
        const runtime = await activateSceneAuthorityRuntime(repository, {
            documents: [withMissing],
            legacyProjection: LEGACY,
            artifactPresentation,
            flushArtifactTombstones: async () => { order.push('tombstone-flush') },
        })

        expect(useSceneStore.getState().presets[0].scenes[0].images).toEqual([
            {
                id: 'artifact-a',
                url: 'E:\\Pictures\\NAI Blue\\scene-a.png',
                timestamp: Date.parse('2026-09-04T00:00:00.000Z'),
                isFavorite: false,
            },
            LEGACY.presets[0].scenes[0].images[0],
        ])
        expect(JSON.stringify(projectScenePresentationState(useSceneStore.getState())))
            .not.toContain('scene-a.png')

        useSceneStore.getState().toggleFavorite('preset-a', 'scene-a', 'artifact-a')
        await runtime.flush()
        expect(order).toEqual(['scene-cas'])
        expect(repository.commits.at(-1)?.next.scenes[0].artifactRefs).toEqual([
            { ...withMissing.scenes[0].artifactRefs[0], favorite: true },
            withMissing.scenes[0].artifactRefs[1],
        ])

        order.length = 0
        useSceneStore.getState().deleteImage('preset-a', 'scene-a', 'artifact-a')
        await runtime.flush()
        expect(order).toEqual(['tombstone-flush', 'scene-cas'])
        expect(repository.commits.at(-1)?.next.scenes[0].artifactRefs)
            .toEqual([withMissing.scenes[0].artifactRefs[1]])

        const persisted = projectScenePresentationState(useSceneStore.getState())
        runtime.stop()
        useSceneStore.setState(persisted)
        await activateSceneAuthorityRuntime(repository, {
            documents: [repository.commits.at(-1)!.next],
            legacyProjection: LEGACY,
            artifactPresentation,
            flushArtifactTombstones: async () => undefined,
        })
        expect(useSceneStore.getState().presets[0].scenes[0].images)
            .toEqual([LEGACY.presets[0].scenes[0].images[0]])
    })

    it('uses a durable tombstone to finish artifact unlink after a crash before Scene CAS', async () => {
        const artifact = createArtifactRecord({
            artifactId: 'artifact-a',
            sourceSceneId: 'scene-a',
            file: {
                directory: { kind: 'standard', root: 'pictures', segments: ['NAI Blue'] },
                fileName: 'scene-a.png',
            },
            format: 'png',
            contentChecksum: `sha256:${'a'.repeat(64)}`,
            size: 12,
            createdAt: '2026-09-04T00:00:00.000Z',
        })
        const persisted = projectScenePresentationState({
            ...useSceneStore.getState(),
            presets: [{ id: 'preset-a', name: 'Preset A', parentId: null, createdAt: 1, scenes: [] }],
            activePresetId: 'preset-a',
            sceneAuthorityInitialized: true,
            legacyImagePresentation: {
                [sceneImagePresentationKey('preset-a', 'scene-a', 'artifact-a')]: { deleted: true },
            },
        })
        useSceneStore.setState(persisted)
        const order: string[] = []
        const repository = new MemoryRepository(document(), LEGACY, () => order.push('scene-cas'))

        const runtime = await activateSceneAuthorityRuntime(repository, {
            documents: [document()],
            legacyProjection: LEGACY,
            artifactPresentation: {
                get: async () => artifact,
                resolveOriginalPath: async () => 'E:\\Pictures\\NAI Blue\\scene-a.png',
            },
            flushArtifactTombstones: async () => { order.push('tombstone-flush') },
        })
        await runtime.flush()

        expect(order).toEqual(['tombstone-flush', 'scene-cas'])
        expect(repository.commits.at(-1)?.next.scenes[0].artifactRefs).toEqual([])
        expect(useSceneStore.getState().presets[0].scenes[0].images).not.toContainEqual(
            expect.objectContaining({ id: 'artifact-a' }),
        )
    })

    it.each([
        'settings path changed',
        'absolute output disabled',
        'generation folder deleted',
    ])('reopens an immutable absolute Artifact after cold restart when %s', async scenario => {
        useSettingsStore.setState({
            sceneSavePath: 'D:\\Pictures\\A',
            useAbsoluteScenePath: true,
        })
        const bookmarkId = await bindDurableSceneOutputDirectory('D:\\Pictures\\A')
        const directory = {
            kind: 'bookmark' as const,
            bookmarkId,
            segments: ['Preset A', 'Scene A'],
        }
        const artifact = createArtifactRecord({
            artifactId: 'artifact-a',
            sourceSceneId: 'scene-a',
            file: { directory, fileName: 'scene-a.png' },
            format: 'png',
            contentChecksum: `sha256:${'a'.repeat(64)}`,
            size: 12,
            createdAt: '2026-09-04T00:00:00.000Z',
        })
        if (scenario === 'settings path changed') {
            useSettingsStore.setState({ sceneSavePath: 'D:\\Pictures\\B' })
            await bindDurableSceneOutputDirectory('D:\\Pictures\\B')
        } else if (scenario === 'absolute output disabled') {
            useSettingsStore.setState({ useAbsoluteScenePath: false })
        } else {
            useSettingsStore.setState({ generationFolders: [] })
        }
        // A cold process has no registry. Main restores creation-time bindings
        // without consulting current Settings or a possibly deleted Folder.
        runtimePortablePathTokenRegistry.remove(directory.bookmarkId)
        expect(assessPortablePath(directory, runtimeCapabilities).status).toBe('unresolved')
        await hydrateDurableSceneOutputDirectories()

        await activateSceneAuthorityRuntime(new MemoryRepository(document()), {
            documents: [document()],
            legacyProjection: LEGACY,
            artifactPresentation: {
                get: async () => artifact,
                resolveOriginalPath: async record => {
                    const resolved = assessPortablePath(record.original.file.directory, runtimeCapabilities)
                    return resolved.status === 'resolved'
                        ? `${resolved.materialized.displayPath}/${record.original.file.fileName}`
                        : null
                },
            },
        })

        expect(useSceneStore.getState().presets[0].scenes[0].images).toContainEqual(
            expect.objectContaining({
                id: 'artifact-a',
                url: 'D:\\Pictures\\A/Preset A/Scene A/scene-a.png',
            }),
        )
    })

    it('commits one whole-document revision for a UI authoring edit and preserves artifact refs', async () => {
        const repository = new MemoryRepository(document())
        const runtime = await activateSceneAuthorityRuntime(repository, {
            documents: [document()],
            legacyProjection: LEGACY,
        })

        useSceneStore.getState().updateScenePrompt('preset-a', 'scene-a', 'edited once')
        await runtime.flush()

        expect(repository.commits).toHaveLength(1)
        expect(repository.commits[0]).toMatchObject({ expected: 1, next: { revision: 2 } })
        expect(repository.commits[0].next.scenes[0]).toMatchObject({
            scenePrompt: 'edited once',
            artifactRefs: [{ artifactId: 'artifact-a' }],
        })
    })

    it('does not commit queue or transient legacy image changes', async () => {
        const repository = new MemoryRepository(document())
        const runtime = await activateSceneAuthorityRuntime(repository, {
            documents: [document()],
            legacyProjection: LEGACY,
        })

        useSceneStore.getState().incrementQueue('preset-a', 'scene-a')
        useSceneStore.getState().addImageToScene('preset-a', 'scene-a', 'data:image/png;base64,runtime')
        await runtime.flush()

        expect(repository.commits).toHaveLength(0)
        expect(useSceneStore.getState().presets[0].scenes[0]).toMatchObject({ queueCount: 1 })
    })

    it('refreshes from current authority on stale UI conflict and accepts verified external documents', async () => {
        const repository = new MemoryRepository(document(2, 'server wins'))
        await activateSceneAuthorityRuntime(repository, {
            documents: [document(1, 'stale snapshot')],
            legacyProjection: LEGACY,
        })

        useSceneStore.getState().updateScenePrompt('preset-a', 'scene-a', 'stale edit')
        await flushSceneAuthorityRuntime()

        expect(repository.commits[0].expected).toBe(1)
        expect(useSceneStore.getState().presets[0].scenes[0].scenePrompt).toBe('server wins')
        expect(applySceneDocumentProjection(document(3, 'agent result'))).toBe(true)
        expect(useSceneStore.getState().presets[0].scenes[0].scenePrompt).toBe('agent result')
    })

    it('persists configured production quantity while clearing transient pending entries on reopen', async () => {
        const repository = new MemoryRepository(document())
        await activateSceneAuthorityRuntime(repository, { documents: [document()], legacyProjection: LEGACY })
        useSceneStore.getState().setSceneProductionCounts([{ presetId: 'preset-a', sceneId: 'scene-a' }], 20)
        useSceneStore.getState().setQueueCount('preset-a', 'scene-a', 3)
        await flushSceneAuthorityRuntime()
        const saved = repository.commits.at(-1)!.next
        expect(saved.scenes[0].productionCount).toBe(20)
        expect(saved.scenes[0]).not.toHaveProperty('queueCount')
        await activateSceneAuthorityRuntime(repository, { documents: [saved], legacyProjection: LEGACY })
        expect(useSceneStore.getState().presets[0].scenes[0]).toMatchObject({ productionCount: 20, queueCount: 0 })
    })
})
