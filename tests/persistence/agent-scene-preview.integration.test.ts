import 'fake-indexeddb/auto'
import { afterEach, expect, it } from 'vitest'

import { IndexedDbSceneRepository } from '@/adapters/scene/indexeddb-scene-repository'
import { createAgentAuthoringService } from '@/application/agent/agent-authoring-service'
import type { AgentAuthoringGrant, AgentAuthoringTarget } from '@/application/agent/agent-authoring-contract'
import { linkSceneArtifact } from '@/application/scene/link-scene-artifact'
import type { JsonObject } from '@/domain/composition/types'
import type { GenerationFolderDocument, GenerationFolder } from '@/domain/generation-folders'
import { createArtifactRecord } from '@/domain/organizer/types'
import {
    activateSceneAuthorityRuntime, applySceneDocumentProjection, flushSceneAuthorityRuntime,
    publishAgentSceneDocument, stopSceneAuthorityRuntimeForTests,
} from '@/lib/scene-authority-runtime'
import {
    flushIndexedDBKey, getIndexedDBItemStrict, setIndexedDBItemStrict,
    SCENE_DOCUMENT_STORE_KEY, SCENE_PRESENTATION_STORE_KEY,
} from '@/lib/indexed-db'
import { createZustandSceneResultPresentation } from '@/presentation/scene/zustand-scene-result-presentation'
import { collectFolderAssets, folderAssetLatestImage } from '@/presentation/folders/folder-workbench'
import { useSceneStore } from '@/stores/scene-store'
import { useGenerationStore } from '@/stores/generation-store'
import { useArtifactLifecycleStore } from '@/stores/artifact-lifecycle-store'

const presetId = 'agent-preview-preset'
const sceneId = 'agent-preview-scene'
const folderId = 'agent-preview-folder'
const folders: GenerationFolderDocument = { schemaVersion: 2, workspaceId: 'local', revision: 1, folders: [{
    id: folderId, displayName: 'Agent previews', pathSegment: 'Agent previews', parentId: null,
    rootDirectory: 'output', useAbsolutePath: false, commonPrompt: '', autoUpload: false,
    r2ProfilePolicy: { mode: 'clear' }, r2BucketPolicy: { mode: 'inherit' }, r2PrefixPolicy: { mode: 'inherit' },
}] }
const folderProjection: GenerationFolder[] = [{
    schemaVersion: 1, id: folderId, name: 'Agent previews', parentId: null, rootDirectory: 'output',
    useAbsolutePath: false, commonPrompt: '', r2: { autoUpload: false, bucket: null, prefix: null },
    createdAt: '', updatedAt: '',
}]
const grant = (target: AgentAuthoringTarget): AgentAuthoringGrant => ({
    requestId: 'request-preview', requestHash: `sha256:${'a'.repeat(64)}`, workspaceId: 'local',
    clientId: 'agent-test', actorKind: 'agent', policyRevision: 1,
    expiresAt: '2026-09-09T00:00:00.000Z', consentedAt: '2026-09-08T00:00:00.000Z',
    authorization: 'human', target,
})

afterEach(stopSceneAuthorityRuntimeForTests)

it('restores an agent-created preset and its real linked previews, preserving history through revision-checked edits', async () => {
    await Promise.all([useSceneStore.persist.rehydrate(), useGenerationStore.persist.rehydrate()])
    useSceneStore.setState({ presets: [], activePresetId: null, sceneAuthorityInitialized: false, legacyImagePresentation: {} })
    useGenerationStore.setState({ history: [] })
    await flushIndexedDBKey(SCENE_PRESENTATION_STORE_KEY)
    await setIndexedDBItemStrict(SCENE_DOCUMENT_STORE_KEY, JSON.stringify({ schemaVersion: 1, documents: [] }))
    const scenes = new IndexedDbSceneRepository()
    await activateSceneAuthorityRuntime(scenes, { documents: [], legacyProjection: null })
    const authoring = createAgentAuthoringService({
        scenes, folderWorkspaceId: 'local', readFolders: async () => folders,
        folderDefaults: () => ({ directory: 'output', useAbsolutePath: false, r2ProfileId: null }),
        applyFolders: async () => { throw new Error('This Scene proof never mutates folders') },
        flushScenes: flushSceneAuthorityRuntime, projectScene: publishAgentSceneDocument,
        projectFolders: () => { throw new Error('This Scene proof never projects folders') },
        hasPreset: id => useSceneStore.getState().presets.some(preset => preset.id === id),
    })
    const input: JsonObject = { presetId, presetName: 'Agent-created previews', expectedRevision: 0,
        changes: [{ sceneId, name: 'A new scene', generationFolderId: folderId,
            prompts: { additional: 'A synthetic scene' }, generation: { steps: 28, cfgScale: 5.5 }, productionCount: 2 }] }
    const target = await authoring.inspect('scene.patch_many', input)
    expect(target).not.toBeNull()
    expect(await authoring.apply('scene.patch_many', input, target!, grant(target!)))
        .toMatchObject({ status: 'authoring-committed', revision: 1 })
    expect(await scenes.getDocument(presetId)).toMatchObject({ revision: 1, scenes: [{ id: sceneId, artifactRefs: [] }] })

    const artifacts = [1, 2].map(index => createArtifactRecord({
        artifactId: `agent-artifact-${index}`, sourceJobId: `agent-job-${index}`, sourceSceneId: sceneId,
        file: { directory: { kind: 'standard', root: 'pictures', segments: ['Synthetic'] }, fileName: `preview-${index}.png` },
        format: 'png', contentChecksum: `sha256:${String(index).repeat(64)}`, size: 1,
        createdAt: `2026-09-08T00:00:0${index}.000Z`,
    }))
    const imagePath = (fileName: string) => `E:/Synthetic/${fileName}`
    const presentation = createZustandSceneResultPresentation()
    for (const artifact of artifacts) {
        const linked = await linkSceneArtifact(scenes, { presetId, sceneId, artifactId: artifact.artifactId,
            createdAt: artifact.createdAt, favorite: false })
        expect(linked.status).toBe('LINKED')
        if (!('document' in linked)) throw new Error('Expected a committed Scene result link')
        expect(applySceneDocumentProjection(linked.document)).toBe(true)
        presentation.commitResult({ presetId, sceneId, artifactId: artifact.artifactId,
            sourceJobId: artifact.sourceJobId!, sourceSceneId: sceneId, historyId: `history-${artifact.artifactId}`,
            path: imagePath(artifact.original.file.fileName), prompt: 'A synthetic scene', seed: 1,
            thumbnail: 'data:image/png;base64,AA==',
        })
    }
    await flushSceneAuthorityRuntime()
    const rows = () => collectFolderAssets(useSceneStore.getState().presets, folderProjection, folderId, false)
    expect(rows()).toHaveLength(1)
    expect(folderAssetLatestImage(rows()[0].scene)).toMatchObject({ id: 'agent-artifact-2', url: 'E:/Synthetic/preview-2.png' })
    expect(rows()[0].scene.images).toHaveLength(2)
    expect(useGenerationStore.getState().history.map(image => image.artifactId)).toEqual(['agent-artifact-2', 'agent-artifact-1'])
    expect(useArtifactLifecycleStore.getState().latestGeneratedArtifact).toMatchObject({ artifactId: 'agent-artifact-2', sourceSceneId: sceneId })
    expect((await scenes.getDocument(presetId))?.revision).toBe(3)

    const patch: JsonObject = { presetId, expectedRevision: 3, changes: [{ sceneId, productionCount: 4 }] }
    const staleTarget = (await authoring.inspect('scene.patch_many', patch))!
    useSceneStore.getState().updateScenePrompt(presetId, sceneId, 'User revised the scene')
    await flushSceneAuthorityRuntime()
    expect((await scenes.getDocument(presetId))?.revision).toBe(4)
    expect(await authoring.apply('scene.patch_many', patch, staleTarget, grant(staleTarget)))
        .toEqual({ status: 'rejected', code: 'AGENT_AUTHORING_TARGET_CHANGED' })
    const currentPatch = { ...patch, expectedRevision: 4 }
    const freshTarget = (await authoring.inspect('scene.patch_many', currentPatch))!
    expect(await authoring.apply('scene.patch_many', currentPatch, freshTarget, grant(freshTarget)))
        .toMatchObject({ status: 'authoring-committed', revision: 5 })
    const saved = (await scenes.getDocument(presetId))!
    expect(saved.scenes[0]).toMatchObject({ scenePrompt: 'User revised the scene', productionCount: 4 })
    expect(saved.scenes[0].artifactRefs.map(ref => ref.artifactId).sort()).toEqual(['agent-artifact-1', 'agent-artifact-2'])
    expect(rows()[0].scene.images).toHaveLength(2)

    await flushIndexedDBKey(SCENE_PRESENTATION_STORE_KEY)
    const navigation = (await getIndexedDBItemStrict(SCENE_PRESENTATION_STORE_KEY))!
    expect(JSON.parse(navigation).state.presets).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: presetId, name: 'Agent-created previews', scenes: [] }),
    ]))
    expect(navigation).not.toContain('preview-2.png')
    // Simulate losing all in-memory scenes, then rehydrate the exact bytes saved by the publisher.
    stopSceneAuthorityRuntimeForTests()
    useSceneStore.setState({ presets: [], activePresetId: null, sceneAuthorityInitialized: false })
    await flushIndexedDBKey(SCENE_PRESENTATION_STORE_KEY)
    await setIndexedDBItemStrict(SCENE_PRESENTATION_STORE_KEY, navigation)
    await useSceneStore.persist.rehydrate()
    const reopened = new IndexedDbSceneRepository()
    await activateSceneAuthorityRuntime(reopened, { legacyProjection: null, artifactPresentation: {
        get: async id => artifacts.find(artifact => artifact.artifactId === id) ?? null,
        resolveOriginalPath: async artifact => imagePath(artifact.original.file.fileName),
    } })
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({ presetId, presetName: 'Agent-created previews',
        scene: { id: sceneId, scenePrompt: 'User revised the scene', productionCount: 4 } })
    expect(rows()[0].scene.images.map(image => image.id)).toEqual(['agent-artifact-2', 'agent-artifact-1'])
    expect(folderAssetLatestImage(rows()[0].scene)).toMatchObject({ id: 'agent-artifact-2', url: 'E:/Synthetic/preview-2.png' })
    expect((await reopened.getDocument(presetId))?.revision).toBe(5)
})
