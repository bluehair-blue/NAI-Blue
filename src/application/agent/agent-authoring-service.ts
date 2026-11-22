import type { JsonObject } from '@/domain/composition/types'
import { canonicalSerialize, hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import type { GenerationFolderDocument, GenerationFolderV2, GenerationFolderV2Defaults } from '@/domain/generation-folders'
import type { SceneAuthoringRecord, SceneDocument, SceneRepositoryPort } from '@/application/scene/scene-repository'
import { planGenerationFolderChanges, type GenerationFolderChange } from '@/application/folder/plan-folder-changes'
import type { ApplyGenerationFolderChangesInput, ApplyGenerationFolderChangesResult } from '@/application/folder/apply-folder-changes'
import { AgentCommandError } from './agent-command-contract'
import type { AgentAuthoringPort, AgentAuthoringRefusal, AgentAuthoringTarget } from './agent-authoring-contract'
import type { SavedArtifactBinding } from '@/application/scene/scene-image-source'
import { agentSpans } from './agent-command-dispatcher'

type SceneChange = Partial<Omit<SceneAuthoringRecord, 'id' | 'artifactRefs' | 'createdAt' | 'compositionRef' | 'scenePrompt'>> & { sceneId: string }
interface SceneInput { presetId: string; expectedRevision: number; presetName?: string; presetArchived?: boolean; changes: SceneChange[] }
type FolderChange = Partial<Pick<GenerationFolderV2, 'displayName' | 'pathSegment' | 'commonPrompt' | 'autoUpload' | 'r2ProfilePolicy' | 'r2BucketPolicy' | 'r2PrefixPolicy'>> & {
    op: 'create' | 'patch'; folderId: string; parentId?: string
}
/** document is null for a preset-only archive or restore, which commits no Scene document. */
interface PreparedScene { input: SceneInput; current: SceneDocument | null; document: SceneDocument | null; target: AgentAuthoringTarget }
interface FolderInput { expectedRevision: number; expectedPlanHash?: `sha256:${string}`; changes: FolderChange[] }

export interface AgentAuthoringDependencies {
    /** Checks any saved-original binding (Image2Image source or Precise Reference) before commit, not at generation. */
    readonly validateImageSource?: (source: SavedArtifactBinding) => Promise<boolean>
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
    /** The navigation shell's archive flag. Without it archive requests are unavailable and nothing reads as archived. */
    readonly presetArchive?: {
        readonly isArchived: (presetId: string) => boolean
        readonly canArchive: (presetId: string) => boolean
        /** Persists the flag; the Scene document, its revision and result links are untouched. */
        readonly set: (presetId: string, archived: boolean) => Promise<void>
    }
}

function failed(code: string): JsonObject { return { status: 'rejected', code } }
function digest(value: unknown): `sha256:${string}` { return `sha256:${hashCanonicalValue(value)}` }
function sceneContent(document: SceneDocument | null, presetId: string) {
    // Timestamps are presentation facts; result links remain owned by generation, never by an authoring grant.
    return { presetId, scenes: document?.scenes.map(({ createdAt: _time, artifactRefs: _refs, ...scene }) => scene) ?? [] }
}
/** Without Scene changes no document is committed, so the revision a preset-only request reports is the one it named. */
function nextRevision(target: AgentAuthoringTarget): number {
    return target.expectedRevision + (target.changeCount === 0 ? 0 : 1)
}
function committed(target: AgentAuthoringTarget): JsonObject {
    return { status: 'authoring-committed', command: target.command, resourceId: target.resourceId,
        revision: nextRevision(target), targetHash: target.targetHash }
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
    function prepareScene(raw: JsonObject) {
        return agentSpans.span('agent-authoring:prepare-scene', detail => prepareSceneOnce(raw, detail))
    }
    async function prepareSceneOnce(raw: JsonObject, detail: Record<string, number>): Promise<PreparedScene | AgentAuthoringRefusal | null> {
        const input = raw as unknown as SceneInput
        detail.changes = input.changes.length
        await agentSpans.span('agent-authoring:flush-scenes', () => deps.flushScenes())
        // An archived preset is hidden from agents; only a request that restores it may also edit its Scenes.
        if (input.changes.length > 0 && input.presetArchived !== false && deps.presetArchive?.isArchived(input.presetId)) {
            return { refused: 'AGENT_PRESET_ARCHIVED' } satisfies AgentAuthoringRefusal
        }
        const current = await agentSpans.span('agent-authoring:scene-read', () => deps.scenes.getDocument(input.presetId))
        detail.scenes = current?.scenes.length ?? 0
        if ((current?.revision ?? 0) !== input.expectedRevision || (current !== null && !deps.hasPreset(input.presetId))) return null
        // Preset renaming is a separate navigation action, not an unversioned side effect of Scene edits.
        if (current !== null && input.presetName !== undefined) return null
        if (input.presetArchived !== undefined) {
            // Archiving names an existing navigation shell; it never creates one.
            if (!deps.presetArchive || !deps.hasPreset(input.presetId) || input.presetName !== undefined) return null
            if (input.presetArchived && !deps.presetArchive.canArchive(input.presetId)) {
                return { refused: 'AGENT_PRESET_NOT_ARCHIVABLE' } satisfies AgentAuthoringRefusal
            }
        }
        if (input.changes.length === 0) {
            const target: AgentAuthoringTarget = { command: 'scene.patch_many', resourceId: input.presetId,
                expectedRevision: input.expectedRevision,
                targetHash: digest({ input, content: sceneContent(current, input.presetId) }),
                changeCount: 0, createsFolders: false, renamesPathSegments: false }
            return { input, current, document: null, target }
        }
        const folders = await agentSpans.span('agent-authoring:folders-read', () => deps.readFolders())
        if (!folders || input.changes.some(change => change.generationFolderId !== undefined
            && !folders.folders.some(folder => folder.id === change.generationFolderId))) return null
        for (const binding of input.changes.flatMap(change => [...(change.imageSource ? [change.imageSource] : []), ...change.preciseReferences ?? []])) {
            if (!deps.validateImageSource || !await agentSpans.span('agent-authoring:image-source',
                () => deps.validateImageSource!(binding))) return null
        }
        const document = nextScenes(current, input, '1970-01-01T00:00:00.000Z')
        if (!document) return null
        const target: AgentAuthoringTarget = { command: 'scene.patch_many', resourceId: input.presetId,
            expectedRevision: input.expectedRevision,
            targetHash: agentSpans.spanSync('agent-authoring:target-hash', () => digest({ input, content: sceneContent(document, input.presetId) })),
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
            if (command !== 'scene.patch_many') return (await prepareFolders(input))?.target ?? null
            const prepared = await prepareScene(input)
            return prepared === null || 'refused' in prepared ? prepared : prepared.target
        },
        async apply(command, raw, target, grant) {
            if (canonicalSerialize(target) !== canonicalSerialize(grant.target) || command !== target.command) throw new AgentCommandError('INVALID_AUTHORING_TARGET')
            if (command === 'scene.patch_many') {
                const prepared = await prepareScene(raw)
                if (!prepared || 'refused' in prepared || canonicalSerialize(prepared.target) !== canonicalSerialize(target)) return failed('AGENT_AUTHORING_TARGET_CHANGED')
                // Scene changes commit first: a crash before the flag lands is completed by reconcile from the committed document.
                if (prepared.document !== null) {
                    const document = nextScenes(prepared.current, prepared.input, grant.consentedAt)!
                    const result = await agentSpans.span('agent-authoring:scene-commit', () => deps.scenes.commit(document, target.expectedRevision))
                    if (result.status !== 'COMMITTED') return failed(result.status)
                    await agentSpans.span('agent-authoring:project-scene', () => deps.projectScene(result.document, prepared.input.presetName))
                }
                if (prepared.input.presetArchived !== undefined) {
                    await agentSpans.span('agent-authoring:preset-archive', () => deps.presetArchive!.set(prepared.input.presetId, prepared.input.presetArchived!))
                }
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
                if ((current?.revision ?? 0) !== nextRevision(target)
                    || digest({ input, content: sceneContent(current, target.resourceId) }) !== target.targetHash) return null
                if (target.changeCount === 0) {
                    // Nothing to finish: the flag either reached the shell before the crash or the outcome stays unknown.
                    // A preset deleted since then reads as "not archived" and must not pass for a completed restore.
                    return deps.hasPreset(target.resourceId) && deps.presetArchive?.isArchived(target.resourceId) === input.presetArchived
                        ? committed(target) : null
                }
                // A crash after CAS may leave only the navigation projection (shell and archive flag) unfinished. No authoring is re-applied.
                await deps.projectScene(current!, input.expectedRevision === 0 ? input.presetName : undefined)
                if (input.presetArchived !== undefined && deps.presetArchive) await deps.presetArchive.set(target.resourceId, input.presetArchived)
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
