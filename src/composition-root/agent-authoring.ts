import { createAgentAuthoringService } from '@/application/agent/agent-authoring-service'
import { getAgentCommandInputContract } from '@/application/agent/agent-command-input'
import type { AgentCommandHandler } from '@/application/agent/runtime-capability-registry'
import type { JsonObject } from '@/domain/composition/types'
import type { SceneAuthoringRecord, SceneDocumentSummary } from '@/application/scene/scene-repository'
import { getRuntimeSceneRepository } from '@/lib/scene-migration-startup'
import { flushSceneAuthorityRuntime, publishAgentSceneDocument } from '@/lib/scene-authority-runtime'
import { DEFAULT_GENERATION_FOLDER_WORKSPACE_ID } from '@/lib/generation-folder-authority-runtime'
import { getRuntimeGenerationFolderDocument, applyRuntimeGenerationFolderChanges } from '@/services/folder/apply-runtime-folder-changes'
import { applyGenerationFolderDocumentProjection, useSettingsStore } from '@/stores/settings-store'
import { DEFAULT_SCENE_PRESET_ID, useSceneStore } from '@/stores/scene-store'
import { flushIndexedDBKey, SCENE_PRESENTATION_STORE_KEY } from '@/lib/indexed-db'
import { getRuntimeR2UploadRepository } from '@/services/r2/runtime'
import { getR2ProfileReadiness } from '@/services/r2/readiness'
import { getRuntimeArtifactRepository } from '@/services/organizer/runtime'

/** Runtime wiring retains the existing Scene/Folder CAS, directory grants and UI projection authorities. */
export function createRuntimeAgentAuthoring() {
    return createAgentAuthoringService({ scenes: getRuntimeSceneRepository(),
        folderWorkspaceId: DEFAULT_GENERATION_FOLDER_WORKSPACE_ID,
        readFolders: () => getRuntimeGenerationFolderDocument(DEFAULT_GENERATION_FOLDER_WORKSPACE_ID),
        folderDefaults: () => ({ directory: useSettingsStore.getState().savePath, useAbsolutePath: useSettingsStore.getState().useAbsolutePath }),
        applyFolders: applyRuntimeGenerationFolderChanges, flushScenes: flushSceneAuthorityRuntime,
        projectScene: publishAgentSceneDocument, projectFolders: applyGenerationFolderDocumentProjection,
        hasPreset: presetId => useSceneStore.getState().presets.some(preset => preset.id === presetId),
        presetArchive: {
            isArchived: presetId => useSceneStore.getState().presets.find(preset => preset.id === presetId)?.archivedAt !== undefined,
            canArchive: presetId => presetId !== DEFAULT_SCENE_PRESET_ID,
            set: async (presetId, archived) => {
                const store = useSceneStore.getState()
                if (archived) store.archivePresets([presetId])
                else store.restoreArchivedPresets([presetId])
                await flushIndexedDBKey(SCENE_PRESENTATION_STORE_KEY)
            },
        },
        validateImageSource: async source => {
            const artifact = await getRuntimeArtifactRepository().get(source.artifactId)
            return artifact !== null && artifact.original.contentChecksum === source.contentChecksum
                && artifact.original.size !== null && artifact.original.size <= 25 * 1024 * 1024
                && ['png', 'webp'].includes(artifact.original.format)
        },
    })
}

function publicScene(scene: SceneAuthoringRecord): JsonObject {
    // Expose editable generation data and durable result IDs; native paths and resource payloads stay inside the app.
    return JSON.parse(JSON.stringify({ sceneId: scene.id, name: scene.name, prompts: scene.prompts ?? { additional: scene.scenePrompt },
        generation: scene.generation ?? {}, width: scene.width, height: scene.height, generationFolderId: scene.generationFolderId,
        productionCount: scene.productionCount ?? 1, filenameTemplate: scene.filenameTemplate,
        imageSource: scene.imageSource, preciseReferences: scene.preciseReferences,
        promptTextMode: scene.promptTextMode,
        artifactIds: [...scene.artifactRefs].reverse().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
            .slice(0, 100).map(ref => ref.artifactId), totalArtifactCount: scene.artifactRefs.length })) as JsonObject
}

export function createAgentAuthoringReadHandlers(): AgentCommandHandler[] {
    const authoring = createRuntimeAgentAuthoring()
    return [{ command: 'scene.resolve_many', effect: 'read',
        validate: getAgentCommandInputContract('scene.resolve_many')!.validate,
        execute: async input => {
            await flushSceneAuthorityRuntime()
            const targets = input.targets as { presetId: string; sceneId: string }[]
            const results: JsonObject[] = []
            const archived = archivedPresetIds()
            for (const target of targets) {
                // An archived preset's Scenes are hidden until it is restored; the marker says why and how to get them back.
                const document = archived.has(target.presetId) ? null : await getRuntimeSceneRepository().getDocument(target.presetId)
                const scene = document?.scenes.find(candidate => candidate.id === target.sceneId)
                let item: JsonObject = scene ? { found: true, presetId: target.presetId, revision: document!.revision, ...publicScene(scene) }
                    : { found: false, ...target, ...(archived.has(target.presetId) ? { archived: true } : {}) }
                // An oversized target is an explicit result; retrying a zero-progress page can never recover it.
                if (new TextEncoder().encode(JSON.stringify(item)).length > 52_000) {
                    item = { found: true, ...target, revision: document!.revision, code: 'RESULT_TOO_LARGE' }
                }
                if (results.length > 0 && new TextEncoder().encode(JSON.stringify([...results, item])).length > 52_000) break
                results.push(item)
            }
            return { results, truncated: results.length < targets.length, nextIndex: results.length < targets.length ? results.length : null }
        },
    }, { command: 'folder.plan_changes', effect: 'plan', validate: getAgentCommandInputContract('folder.plan_changes')!.validate,
        execute: input => authoring.planFolders(input),
    }, { command: 'r2.get_readiness', effect: 'read', validate: getAgentCommandInputContract('r2.get_readiness')!.validate,
        execute: async () => {
            const profiles = await getRuntimeR2UploadRepository().listProfiles()
            return { profiles: await Promise.all(profiles.slice(0, 100).map(async profile => {
                const ready = await getR2ProfileReadiness(profile)
                return { profileId: profile.id, name: profile.name, status: ready.status,
                    ...(ready.status === 'unavailable' ? { reason: ready.reason } : {}) }
            })), truncated: profiles.length > 100 }
        },
    }]
}

function archivedPresetIds(): Set<string> {
    return new Set(useSceneStore.getState().presets.flatMap(preset => preset.archivedAt === undefined ? [] : [preset.id]))
}

/**
 * A bounded, paged directory lets an agent discover the same saved rows the Folder workbench renders.
 * Archived presets count only in totalArchivedPresets; their list is returned when includeArchived asks for it.
 */
export async function getAgentAuthoringSnapshot(offset = 0, limit = 20, includeArchived = false): Promise<JsonObject> {
    await flushSceneAuthorityRuntime()
    const repository = getRuntimeSceneRepository()
    const documents = repository.listDocumentRecords !== undefined
        ? await repository.listDocumentRecords()
        : null
    const summaries: SceneDocumentSummary[] = documents === null
        ? [...await repository.listDocuments()]
        : documents.map(document => ({
            presetId: document.presetId,
            revision: document.revision,
            sceneCount: document.scenes.length,
            updatedAt: document.updatedAt,
        }))
    summaries.sort((a, b) => a.presetId.localeCompare(b.presetId))
    const presets = new Map(useSceneStore.getState().presets.map(preset => [preset.id, preset]))
    const visible = summaries.filter(summary => presets.get(summary.presetId)?.archivedAt === undefined)
    const rows = []
    for (const summary of visible) {
        if (!presets.has(summary.presetId)) continue
        const document = documents?.find(candidate => candidate.presetId === summary.presetId)
            ?? await repository.getDocument(summary.presetId)
        for (const scene of document?.scenes ?? []) rows.push({ presetId: summary.presetId, sceneId: scene.id,
            revision: document!.revision, name: scene.name.slice(0, 200), generationFolderId: scene.generationFolderId ?? null,
            productionCount: scene.productionCount ?? 1, resultCount: scene.artifactRefs.length })
    }
    const summaryById = new Map(summaries.map(summary => [summary.presetId, summary]))
    // A shell that never had Scenes has no document: revision 0 and no Scenes, as scene.patch_many expects.
    const archived = [...presets.values()].filter(preset => preset.archivedAt !== undefined)
        .sort((a, b) => a.id.localeCompare(b.id))
    const folders = await getRuntimeGenerationFolderDocument(DEFAULT_GENERATION_FOLDER_WORKSPACE_ID)
    const sortedFolders = [...(folders?.folders ?? [])].sort((a, b) => a.id.localeCompare(b.id))
    const pageSize = Math.min(limit, 50)
    return { scenePresets: visible.slice(offset, offset + pageSize).map(summary => ({ ...summary,
        name: presets.get(summary.presetId)?.name.slice(0, 200) ?? summary.presetId })),
        scenes: rows.slice(offset, offset + pageSize), totalScenes: rows.length, totalPresets: visible.length,
        totalArchivedPresets: archived.length,
        ...(includeArchived ? { archivedPresets: archived.slice(offset, offset + pageSize).map(preset => ({
            presetId: preset.id, name: preset.name.slice(0, 200), revision: summaryById.get(preset.id)?.revision ?? 0,
            sceneCount: summaryById.get(preset.id)?.sceneCount ?? 0, archivedAt: new Date(preset.archivedAt!).toISOString() })) } : {}),
        folderRevision: folders?.revision ?? null,
        folders: sortedFolders.slice(offset, offset + pageSize).map(folder => ({ folderId: folder.id, name: folder.displayName,
            pathSegment: folder.pathSegment, parentId: folder.parentId, autoUpload: folder.autoUpload,
            directoryReference: folder.parentId === null ? folder.id : null })),
        totalFolders: sortedFolders.length, offset, pageSize,
        nextOffset: offset + pageSize < Math.max(rows.length, visible.length, sortedFolders.length, includeArchived ? archived.length : 0)
            ? offset + pageSize : null }
}
