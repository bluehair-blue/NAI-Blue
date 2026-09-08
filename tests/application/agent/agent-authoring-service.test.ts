import { describe, expect, it, vi } from 'vitest'
import { IndexedDbSceneRepository } from '@/adapters/scene/indexeddb-scene-repository'
import { createAgentAuthoringService } from '@/application/agent/agent-authoring-service'
import type { AgentAuthoringGrant, AgentAuthoringTarget } from '@/application/agent/agent-authoring-contract'
import type { SceneDocument } from '@/application/scene/scene-repository'
import type { GenerationFolderDocument } from '@/domain/generation-folders'
import { applyGenerationFolderChanges } from '@/application/folder/apply-folder-changes'
import type { JsonObject } from '@/domain/composition/types'
import { assertAgentPublicValue } from '@/application/agent/agent-command-contract'

const time = '2026-09-08T00:00:00.000Z'
const digest = `sha256:${'a'.repeat(64)}` as const
const root: GenerationFolderDocument = { schemaVersion: 2, workspaceId: 'local', revision: 1, folders: [{
    id: 'root', displayName: '작업 폴더', pathSegment: 'assets', parentId: null,
    rootDirectory: 'E:/assets', useAbsolutePath: true, commonPrompt: '', autoUpload: false,
    r2ProfilePolicy: { mode: 'inherit' }, r2BucketPolicy: { mode: 'inherit' }, r2PrefixPolicy: { mode: 'inherit' },
}] }
function grant(target: AgentAuthoringTarget): AgentAuthoringGrant {
    return { requestId: 'edit-1', requestHash: digest, workspaceId: 'native-workspace', clientId: 'codex', actorKind: 'agent',
        policyRevision: 1, expiresAt: '2026-09-08T01:00:00.000Z', consentedAt: time, authorization: 'human', target }
}
function fixture() {
    const values = new Map<string, string>()
    const scenes = new IndexedDbSceneRepository({ getItem: async key => values.get(key) ?? null,
        compareAndSet: async (key, previous, next) => {
            if ((values.get(key) ?? null) !== previous) return false
            values.set(key, next); return true
        } })
    let folders = structuredClone(root)
    const shells = new Set<string>()
    const projectScene = vi.fn(async (document: SceneDocument) => { shells.add(document.presetId) })
    const authorize = vi.fn(async () => undefined)
    const applyFolders = vi.fn(async (input: Parameters<typeof applyGenerationFolderChanges>[0]) => applyGenerationFolderChanges(input))
    const dependencies = { scenes, folderWorkspaceId: 'local', readFolders: async () => structuredClone(folders),
        folderDefaults: () => ({ directory: 'output', useAbsolutePath: false }), flushScenes: async () => undefined,
        projectScene, projectFolders: vi.fn(), hasPreset: (id: string) => shells.has(id),
        applyFolders: async (input: Pick<Parameters<typeof applyGenerationFolderChanges>[0], 'workspaceId' | 'expectedRevision' | 'expectedPlanHash' | 'changes' | 'defaults'>) => applyFolders({ ...input,
            repository: { getDocument: async () => structuredClone(folders), listDocuments: async () => [], readLegacyProjection: async () => null,
                commit: async (next, revision) => {
                    if (folders.revision !== revision) return { status: 'REVISION_CONFLICT' as const, current: folders }
                    folders = structuredClone(next)
                    return { status: 'COMMITTED' as const, document: structuredClone(next) }
                } }, occupancyGuard: async () => ({ status: 'empty' as const }),
            mutationGate: { runExclusive: async (_key, work) => work() }, authorizeDirectories: authorize,
        }),
    }
    return { service: createAgentAuthoringService(dependencies), reopen: () => createAgentAuthoringService(dependencies), scenes,
        folders: () => folders, projectScene, authorize, applyFolders, shells }
}
const createInput: JsonObject = { presetId: 'codex-assets', presetName: '교복 표정', expectedRevision: 0, changes: [
    { sceneId: 'happy', name: '웃는 표정', prompts: { additional: 'smile, classroom' }, generation: { steps: 28, cfgScale: 5.5, seed: 10, seedLocked: true },
        width: 832, height: 1216, generationFolderId: 'root', productionCount: 3, filenameTemplate: 'happy_{index}' },
    { sceneId: 'calm', name: '차분한 표정', prompts: { additional: 'calm, classroom' }, generationFolderId: 'root', productionCount: 2 },
] }

describe('agent authoring through existing Scene and Folder authorities', () => {
    it('saves distinct prompts, parameters, count and folder in the real Scene CAS repository', async () => {
        const f = fixture()
        const target = (await f.service.inspect('scene.patch_many', createInput))!
        const result = await f.service.apply('scene.patch_many', createInput, target, grant(target))
        expect(result).toMatchObject({ status: 'authoring-committed', revision: 1 })
        assertAgentPublicValue(result)
        const document = (await f.scenes.getDocument('codex-assets'))!
        expect(document.scenes.map(scene => [scene.scenePrompt, scene.productionCount])).toEqual([['smile, classroom', 3], ['calm, classroom', 2]])
        expect(document.scenes[0]).toMatchObject({ createdAt: Date.parse(time), generation: { cfgScale: 5.5 }, generationFolderId: 'root', artifactRefs: [] })
        expect(f.projectScene).toHaveBeenCalledTimes(1)
        expect(await f.service.inspect('scene.patch_many', createInput)).toBeNull()
    })
    it('preserves existing result history and unrelated fields while merging an edit', async () => {
        const f = fixture()
        const target = (await f.service.inspect('scene.patch_many', createInput))!
        await f.service.apply('scene.patch_many', createInput, target, grant(target))
        const current = (await f.scenes.getDocument('codex-assets'))!
        const refs = [{ artifactId: 'artifact-1', createdAt: time, favorite: true }]
        await f.scenes.commit({ ...current, revision: 2, scenes: current.scenes.map(scene => ({ ...scene, artifactRefs: refs })) }, 1)
        const input: JsonObject = { presetId: 'codex-assets', expectedRevision: 2, changes: [{ sceneId: 'happy', prompts: { additional: 'laugh' }, generation: { steps: 30 } }] }
        const update = (await f.service.inspect('scene.patch_many', input))!
        await f.service.apply('scene.patch_many', input, update, grant(update))
        const scene = (await f.scenes.getDocument('codex-assets'))!.scenes[0]
        expect(scene).toMatchObject({ scenePrompt: 'laugh', productionCount: 3, generation: { steps: 30, cfgScale: 5.5 }, artifactRefs: refs })
    })
    it('reconciles a committed request after reopening without another CAS and rejects a changed document', async () => {
        const f = fixture()
        const target = (await f.service.inspect('scene.patch_many', createInput))!
        const authority = grant(target)
        await f.service.apply('scene.patch_many', createInput, target, authority)
        const commit = vi.spyOn(f.scenes, 'commit')
        expect(await f.reopen().reconcile(authority, createInput)).toMatchObject({ revision: 1 })
        expect(commit).not.toHaveBeenCalled()
        const current = (await f.scenes.getDocument('codex-assets'))!
        await f.scenes.commit({ ...current, revision: 2 }, 1)
        expect(await f.reopen().reconcile(authority, createInput)).toBeNull()
    })
    it('does not overwrite a concurrent UI edit or silently create a missing destination', async () => {
        const f = fixture()
        expect(await f.service.inspect('scene.patch_many', { ...createInput, changes: [{ sceneId: 'a', name: 'A', generationFolderId: 'missing' }] })).toBeNull()
        const target = (await f.service.inspect('scene.patch_many', createInput))!
        await f.scenes.commit({ schemaVersion: 1, presetId: 'codex-assets', revision: 1, updatedAt: time, scenes: [] }, 0)
        expect(await f.service.apply('scene.patch_many', createInput, target, grant(target))).toMatchObject({ code: 'AGENT_AUTHORING_TARGET_CHANGED' })
    })
    it('plans and commits a referenced child destination and explicit R2 preference through Folder authorization', async () => {
        const f = fixture()
        const input: JsonObject = { expectedRevision: 1, changes: [{ op: 'create', folderId: 'uniform', parentId: 'root', displayName: '교복',
            pathSegment: 'uniform', autoUpload: true, r2ProfilePolicy: { mode: 'set', value: 'production-r2' } }] }
        const plan = await f.service.planFolders(input)
        expect(plan.status).toBe('planned')
        assertAgentPublicValue(plan)
        const apply = { ...input, expectedPlanHash: plan.planHash }
        const target = (await f.service.inspect('folder.apply_changes', apply))!
        expect(target.createsFolders).toBe(true)
        expect(await f.service.apply('folder.apply_changes', apply, target, grant(target))).toMatchObject({ status: 'authoring-committed', revision: 2 })
        expect(f.folders().folders[1]).toMatchObject({ parentId: 'root', rootDirectory: null, autoUpload: true, r2ProfilePolicy: { mode: 'set', value: 'production-r2' } })
        expect(f.authorize).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ directory: 'E:/assets/uniform' })]))
        expect(await f.reopen().reconcile(grant(target), apply)).toMatchObject({ revision: 2 })
        expect(f.applyFolders).toHaveBeenCalledTimes(1)
    })
    it('rejects an unknown parent or changed reviewed Folder plan before directory authorization', async () => {
        const f = fixture()
        const input: JsonObject = { expectedRevision: 1, changes: [{ op: 'create', folderId: 'uniform', parentId: 'missing', displayName: '교복', pathSegment: 'uniform' }] }
        expect(await f.service.planFolders(input)).toMatchObject({ status: 'rejected' })
        expect(await f.service.inspect('folder.apply_changes', { expectedRevision: 1, expectedPlanHash: digest,
            changes: [{ op: 'patch', folderId: 'root', commonPrompt: 'soft coloring' }] })).toBeNull()
        expect(f.authorize).not.toHaveBeenCalled()
    })
})
