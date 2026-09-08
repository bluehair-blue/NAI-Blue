import type { JsonObject } from '@/domain/composition/types'
import { canonicalSerialize, hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import type { GenerationFolderDocument, GenerationFolderV2, GenerationFolderV2Defaults } from '@/domain/generation-folders'
import type { SceneAuthoringRecord, SceneDocument, SceneRepositoryPort } from '@/application/scene/scene-repository'
import { planGenerationFolderChanges, type GenerationFolderChange } from '@/application/folder/plan-folder-changes'
import type { ApplyGenerationFolderChangesInput, ApplyGenerationFolderChangesResult } from '@/application/folder/apply-folder-changes'
import { AgentCommandError } from './agent-command-contract'
import type { AgentAuthoringPort, AgentAuthoringTarget } from './agent-authoring-contract'

type SceneChange = Partial<Omit<SceneAuthoringRecord, 'id' | 'artifactRefs' | 'createdAt' | 'compositionRef' | 'scenePrompt'>> & { sceneId: string }
interface SceneInput { presetId: string; expectedRevision: number; presetName?: string; changes: SceneChange[] }
type FolderChange = Partial<Pick<GenerationFolderV2, 'displayName' | 'pathSegment' | 'commonPrompt' | 'autoUpload' | 'r2ProfilePolicy' | 'r2BucketPolicy' | 'r2PrefixPolicy'>> & {
    op: 'create' | 'patch'; folderId: string; parentId?: string
}
interface FolderInput { expectedRevision: number; expectedPlanHash?: `sha256:${string}`; changes: FolderChange[] }

export interface AgentAuthoringDependencies {
    readonly scenes: SceneRepositoryPort
    readonly folderWorkspaceId: string
    readonly readFolders: () => Promise<GenerationFolderDocument | null>
    readonly folderDefaults: () => GenerationFolderV2Defaults
    readonly applyFolders: (input: Pick<ApplyGenerationFolderChangesInput, 'workspaceId' | 'expectedRevision' | 'expectedPlanHash' | 'changes' | 'defaults'>) => Promise<ApplyGenerationFolderChangesResult>
    /** Drain UI edits before comparing revisions, and persist navigation only after repository commit. */
    readonly flushScenes: () => Promise<void>
    readonly projectScene: (document: SceneDocument, newPresetName?: string) => Promise<void>
    readonly projectFolders: (document: GenerationFolderDocument) => void
    readonly hasPreset: (presetId: string) => boolean
}

function failed(code: string): JsonObject { return { status: 'rejected', code } }
function digest(value: unknown): `sha256:${string}` { return `sha256:${hashCanonicalValue(value)}` }
function sceneContent(document: SceneDocument) {
    // Timestamps are presentation facts; result links remain owned by generation, never by an authoring grant.
    return { presetId: document.presetId, scenes: document.scenes.map(({ createdAt: _time, artifactRefs: _refs, ...scene }) => scene) }
}
function committed(target: AgentAuthoringTarget): JsonObject {
    return { status: 'authoring-committed', command: target.command, resourceId: target.resourceId,
        revision: target.expectedRevision + 1, targetHash: target.targetHash }
}

/** Explicit upserts preserve unrelated authoring and all result history. IDs belong to the caller's saved batch. */
function nextScenes(current: SceneDocument | null, input: SceneInput, time: string): SceneDocument | null {
    if (current === null && (!input.presetName || input.expectedRevision !== 0)) return null
    const scenes = [...(current?.scenes ?? [])]
    for (const { sceneId, ...patch } of input.changes) {
        const index = scenes.findIndex(scene => scene.id === sceneId)
        const previous = scenes[index]
        if (!previous && !patch.name) return null
        let next: SceneAuthoringRecord = { ...(previous ?? { id: sceneId, name: patch.name!, scenePrompt: '',
            artifactRefs: [], createdAt: Date.parse(time) }), ...patch,
            ...(patch.prompts ? { prompts: { ...(previous?.prompts ?? { additional: previous?.scenePrompt ?? '' }), ...patch.prompts },
                scenePrompt: patch.prompts.additional ?? previous?.scenePrompt ?? '' } : {}),
            ...(patch.generation ? { generation: { ...previous?.generation, ...patch.generation, smea: false, smeaDyn: false } } : {}) }
        // The legacy scalar character inputs and explicit captions must agree, just as the UI editor ensures.
        if (patch.prompts && (patch.prompts.character !== undefined || patch.prompts.characterNegative !== undefined)
            && next.characterCaptions?.length) {
            next = { ...next, characterCaptions: next.characterCaptions.map((caption, ordinal) => ordinal ? caption : {
                ...caption, prompt: patch.prompts!.character ?? caption.prompt,
                negative: patch.prompts!.characterNegative ?? caption.negative,
            }) }
        }
        if (index === -1) scenes.push(next)
        else scenes[index] = next
    }
    return { schemaVersion: 1, presetId: input.presetId, revision: input.expectedRevision + 1, scenes, updatedAt: time }
}

/** Only children of configured roots cross the public API; local directory expansion stays in the Folder authority. */
function folderChanges(document: GenerationFolderDocument, input: FolderInput): GenerationFolderChange[] | null {
    const known = new Set(document.folders.map(folder => folder.id))
    const changes: GenerationFolderChange[] = []
    for (const { op, folderId, ...patch } of input.changes) {
        if (patch.parentId !== undefined && !known.has(patch.parentId)) return null
        if (op === 'create') {
            if (known.has(folderId) || !patch.parentId || !patch.displayName || !patch.pathSegment) return null
            changes.push({ op, folder: { id: folderId, displayName: patch.displayName, pathSegment: patch.pathSegment,
                parentId: patch.parentId, rootDirectory: null, useAbsolutePath: false, commonPrompt: '', autoUpload: false,
                r2ProfilePolicy: { mode: 'inherit' }, r2BucketPolicy: { mode: 'inherit' }, r2PrefixPolicy: { mode: 'inherit' }, ...patch } })
            known.add(folderId)
        } else {
            const previous = document.folders.find(folder => folder.id === folderId)
            if (!previous) return null
            // Reparenting a configured root would discard its local destination. Require the existing Folder UI for that change.
            if (previous.parentId === null && patch.parentId !== undefined) return null
            changes.push({ folderId, ...patch })
        }
    }
    return changes
}

export function createAgentAuthoringService(deps: AgentAuthoringDependencies): AgentAuthoringPort & {
    planFolders(input: JsonObject): Promise<JsonObject>
} {
    async function prepareScene(raw: JsonObject) {
        const input = raw as unknown as SceneInput
        await deps.flushScenes()
        const current = await deps.scenes.getDocument(input.presetId)
        if ((current?.revision ?? 0) !== input.expectedRevision || (current !== null && !deps.hasPreset(input.presetId))) return null
        // Preset renaming is a separate navigation action, not an unversioned side effect of Scene edits.
        if (current !== null && input.presetName !== undefined) return null
        const folders = await deps.readFolders()
        if (!folders || input.changes.some(change => change.generationFolderId !== undefined
            && !folders.folders.some(folder => folder.id === change.generationFolderId))) return null
        const document = nextScenes(current, input, '1970-01-01T00:00:00.000Z')
        if (!document) return null
        const target: AgentAuthoringTarget = { command: 'scene.patch_many', resourceId: input.presetId,
            expectedRevision: input.expectedRevision, targetHash: digest({ input, content: sceneContent(document) }),
            changeCount: input.changes.length, createsFolders: false, renamesPathSegments: false }
        return { input, current, document, target }
    }
    async function prepareFolders(raw: JsonObject) {
        const input = raw as unknown as FolderInput
        const current = await deps.readFolders()
        if (!current || current.revision !== input.expectedRevision) return null
        const changes = folderChanges(current, input)
        if (!changes) return null
        const defaults = deps.folderDefaults()
        const plan = planGenerationFolderChanges(current, changes, defaults)
        if (plan.status !== 'PLANNED' || plan.collisions.length) return null
        if (input.expectedPlanHash !== undefined && input.expectedPlanHash !== plan.planHash) return null
        const target: AgentAuthoringTarget = { command: 'folder.apply_changes', resourceId: deps.folderWorkspaceId,
            expectedRevision: input.expectedRevision, targetHash: digest({ input: { ...input, expectedPlanHash: plan.planHash }, document: plan.document }),
            changeCount: changes.length, createsFolders: changes.some(change => 'op' in change),
            renamesPathSegments: plan.pathMoves.length > 0 }
        return { input, changes, defaults, plan, target }
    }
    return {
        async planFolders(input) {
            const prepared = await prepareFolders(input)
            if (!prepared) return failed('AGENT_FOLDER_PLAN_CONFLICT')
            return { status: 'planned', expectedRevision: prepared.input.expectedRevision, planHash: prepared.plan.planHash,
                changeCount: prepared.target.changeCount, createsFolders: prepared.target.createsFolders,
                renamesPathSegments: prepared.target.renamesPathSegments,
                folders: prepared.changes.map((change): JsonObject => {
                    if ('op' in change && change.op === 'create') return {
                        folderId: change.folder.id, name: change.folder.displayName, parentId: change.folder.parentId,
                    }
                    return { folderId: (change as { folderId: string }).folderId }
                }) }
        },
        async inspect(command, input) {
            return command === 'scene.patch_many' ? (await prepareScene(input))?.target ?? null : (await prepareFolders(input))?.target ?? null
        },
        async apply(command, raw, target, grant) {
            if (canonicalSerialize(target) !== canonicalSerialize(grant.target) || command !== target.command) throw new AgentCommandError('INVALID_AUTHORING_TARGET')
            if (command === 'scene.patch_many') {
                const prepared = await prepareScene(raw)
                if (!prepared || canonicalSerialize(prepared.target) !== canonicalSerialize(target)) return failed('AGENT_AUTHORING_TARGET_CHANGED')
                const document = nextScenes(prepared.current, prepared.input, grant.consentedAt)!
                const result = await deps.scenes.commit(document, target.expectedRevision)
                if (result.status !== 'COMMITTED') return failed(result.status)
                await deps.projectScene(result.document, prepared.input.presetName)
            } else {
                const prepared = await prepareFolders(raw)
                if (!prepared || canonicalSerialize(prepared.target) !== canonicalSerialize(target)) return failed('AGENT_AUTHORING_TARGET_CHANGED')
                const result = await deps.applyFolders({ workspaceId: deps.folderWorkspaceId, expectedRevision: target.expectedRevision,
                    expectedPlanHash: prepared.plan.planHash, changes: prepared.changes, defaults: prepared.defaults })
                if (result.status !== 'COMMITTED') return failed(result.status)
                deps.projectFolders(result.plan.document)
            }
            return committed(target)
        },
        async reconcile(grant, raw) {
            const { target } = grant
            if (target.command === 'scene.patch_many') {
                const input = raw as unknown as SceneInput
                const current = await deps.scenes.getDocument(target.resourceId)
                if (!current || current.revision !== target.expectedRevision + 1
                    || digest({ input, content: sceneContent(current) }) !== target.targetHash) return null
                // A crash after CAS may leave only the navigation projection unfinished. No authoring is re-applied.
                await deps.projectScene(current, input.expectedRevision === 0 ? input.presetName : undefined)
            } else {
                const current = await deps.readFolders()
                if (!current || current.revision !== target.expectedRevision + 1
                    || digest({ input: raw, document: current }) !== target.targetHash) return null
                deps.projectFolders(current)
            }
            return committed(target)
        },
    }
}
