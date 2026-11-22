import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as serialization from '@/domain/composition/canonical-serialize'
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
import { projectScenePresentationState, sceneImagePresentationKey, useSceneStore, type ScenePreset } from '@/stores/scene-store'
import { markSpans, spansSince } from '@/lib/user-timing'
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

    it('does not serialize scene authoring for scrolling, selection or generation progress', async () => {
        const repository = new MemoryRepository(document())
        await activateSceneAuthorityRuntime(repository)
        const serialize = vi.spyOn(serialization, 'canonicalSerialize')
        try {
            useSceneStore.getState().setScrollPosition(240)
            useSceneStore.getState().setGenerationProgress(1, 10)
            useSceneStore.setState({ selectedSceneIds: ['scene-a'], isEditMode: true })
            expect(serialize).not.toHaveBeenCalled()
            expect(repository.commits).toHaveLength(0)
        } finally { serialize.mockRestore() }
    })

    it('does not reproject unchanged presets when another preset changes', async () => {
        const repository = new MemoryRepository(document())
        await activateSceneAuthorityRuntime(repository)
        useSceneStore.setState(state => ({ presets: [...state.presets, {
            id: 'unrelated', name: 'Unrelated', parentId: null, createdAt: 1,
            scenes: [{ ...state.presets[0].scenes[0], id: 'unrelated-scene', scenePrompt: 'untouched-marker' }],
        }] }))
        await flushSceneAuthorityRuntime()
        const serialize = vi.spyOn(serialization, 'canonicalSerialize')
        try {
            useSceneStore.setState(state => ({ presets: state.presets.map(preset => preset.id === 'preset-a'
                ? { ...preset, scenes: preset.scenes.map(scene => ({ ...scene, scenePrompt: 'changed' })) }
                : preset) }))
            expect(serialize.mock.calls.every(([value]) => !JSON.stringify(value).includes('untouched-marker'))).toBe(true)
        } finally { serialize.mockRestore() }
    })
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

describe('explicit flush reuses the projection of unchanged presets', () => {
    beforeEach(resetStore)
    afterEach(stopSceneAuthorityRuntimeForTests)

    const scanDetail = async (runtime: { flush(): Promise<void> }) => {
        const mark = markSpans()
        await runtime.flush()
        return spansSince(mark).find(span => span.name === 'scene-authority:scan')!.detail
    }
    const presetDocument = (presetId: string, prompt = `${presetId} prompt`): SceneDocument => ({ schemaVersion: 1, presetId, revision: 1,
        updatedAt: '2026-11-22T00:00:00.000Z', scenes: [{ id: `${presetId}-scene`, name: 'Scene', scenePrompt: prompt, artifactRefs: [], createdAt: 1 }] })
    const shells = (ids: string[]): ScenePreset[] => ids.map(id => ({ id, name: id, scenes: [], parentId: null, createdAt: 1 }))

    it('projects nothing for unchanged or archived presets and exactly the edited one after a store edit', async () => {
        const ids = Array.from({ length: 12 }, (_, index) => `preset-${index}`)
        useSceneStore.setState({ presets: [...useSceneStore.getState().presets, ...shells(ids)], sceneAuthorityInitialized: true })
        const repository = new MemoryRepository(null, null)
        const runtime = await activateSceneAuthorityRuntime(repository, { documents: ids.map(id => presetDocument(id)), legacyProjection: null })
        // The default preset has no document yet; its first commit replaces its Scene array, projected once by the next flush.
        await runtime.flush()
        await runtime.flush()
        expect(await scanDetail(runtime)).toMatchObject({ presetsProjected: 0, presetsReused: 13, presetsChanged: 0 })
        useSceneStore.getState().archivePresets(ids.slice(0, 6))
        expect(await scanDetail(runtime)).toMatchObject({ presetsProjected: 0, presetsReused: 13, presetsChanged: 0 })
        useSceneStore.getState().updateScenePrompt('preset-8', 'preset-8-scene', 'edited by a human')
        await runtime.flush()
        const commits = repository.commits.filter(commit => commit.next.presetId !== 'scene-default')
        expect(commits).toHaveLength(1)
        expect(commits[0]).toMatchObject({ expected: 1, next: { presetId: 'preset-8', revision: 2,
            scenes: [{ scenePrompt: 'edited by a human' }] } })
        // The commit republished preset-8 with a new Scene array: projected once, found unchanged, then reused.
        expect(await scanDetail(runtime)).toMatchObject({ presetsProjected: 1, presetsReused: 12, presetsChanged: 0 })
        expect(await scanDetail(runtime)).toMatchObject({ presetsProjected: 0, presetsReused: 13, presetsChanged: 0 })
    })

    it('still commits a human edit the store subscription missed while a document was being applied', async () => {
        const repository = new MemoryRepository(document())
        const runtime = await activateSceneAuthorityRuntime(repository, { documents: [document()], legacyProjection: LEGACY })
        await runtime.flush()
        // A store listener that edits synchronously during apply runs while the runtime ignores its own projection.
        let edited = false
        const unsubscribe = useSceneStore.subscribe(state => {
            if (edited || state.presets[0]?.scenes[0]?.scenePrompt !== 'agent result') return
            edited = true
            state.updateScenePrompt('preset-a', 'scene-a', 'human edit during apply')
        })
        try { expect(applySceneDocumentProjection(document(2, 'agent result'))).toBe(true) } finally { unsubscribe() }
        expect(repository.commits).toHaveLength(0)
        await runtime.flush()
        expect(repository.commits.at(-1)).toMatchObject({ expected: 2, next: { revision: 3, scenes: [{ scenePrompt: 'human edit during apply' }] } })
    })

    it('keeps a newly linked result when a later edit commits, and commits an edit made while a commit was in flight', async () => {
        // The UI edit lands while the first CAS is awaiting, so the runtime records the newer authority without a store change.
        let editDuringCommit = false
        class SlowRepository extends MemoryRepository {
            async commit(next: SceneDocument, expected: number): Promise<CommitResult> {
                await Promise.resolve()
                if (editDuringCommit) {
                    editDuringCommit = false
                    useSceneStore.getState().updateScenePrompt('preset-a', 'scene-a', 'second edit')
                }
                return super.commit(next, expected)
            }
        }
        const repository = new SlowRepository(document())
        const runtime = await activateSceneAuthorityRuntime(repository, { documents: [document()], legacyProjection: LEGACY })
        await runtime.flush()
        const linked: SceneDocument = { ...document(2), scenes: [{ ...document(2).scenes[0], artifactRefs: [...document(2).scenes[0].artifactRefs,
            { artifactId: 'artifact-new', createdAt: '2026-11-22T00:00:00.000Z', favorite: false }] }] }
        // A finished job's result writer commits the link first, then publishes it through the runtime.
        expect(await repository.commit(linked, 1)).toMatchObject({ status: 'COMMITTED' })
        expect(applySceneDocumentProjection(linked)).toBe(true)
        expect(await scanDetail(runtime)).toMatchObject({ presetsChanged: 0 })
        editDuringCommit = true
        useSceneStore.getState().updateScenePrompt('preset-a', 'scene-a', 'first edit')
        await runtime.flush()
        expect(repository.commits.slice(1).map(commit => [commit.expected, commit.next.scenes[0].scenePrompt]))
            .toEqual([[2, 'first edit'], [3, 'second edit']])
        expect(repository.commits.at(-1)!.next.scenes[0].artifactRefs.map(reference => reference.artifactId)).toEqual(['artifact-a', 'artifact-new'])
        expect(await scanDetail(runtime)).toMatchObject({ presetsChanged: 0 })
    })
})

