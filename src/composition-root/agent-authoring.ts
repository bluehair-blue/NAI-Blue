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
import { useSceneStore } from '@/stores/scene-store'
import { getRuntimeR2UploadRepository } from '@/services/r2/runtime'
import { getR2ProfileReadiness } from '@/services/r2/readiness'

/** Runtime wiring retains the existing Scene/Folder CAS, directory grants and UI projection authorities. */
export function createRuntimeAgentAuthoring() {
    return createAgentAuthoringService({ scenes: getRuntimeSceneRepository(),
        folderWorkspaceId: DEFAULT_GENERATION_FOLDER_WORKSPACE_ID,
        readFolders: () => getRuntimeGenerationFolderDocument(DEFAULT_GENERATION_FOLDER_WORKSPACE_ID),
        folderDefaults: () => ({ directory: useSettingsStore.getState().savePath, useAbsolutePath: useSettingsStore.getState().useAbsolutePath }),
        applyFolders: applyRuntimeGenerationFolderChanges, flushScenes: flushSceneAuthorityRuntime,
        projectScene: publishAgentSceneDocument, projectFolders: applyGenerationFolderDocumentProjection,
        hasPreset: presetId => useSceneStore.getState().presets.some(preset => preset.id === presetId),
    })
}

function publicScene(scene: SceneAuthoringRecord): JsonObject {
    // Expose editable generation data and durable result IDs; native paths and resource payloads stay inside the app.
    return JSON.parse(JSON.stringify({ sceneId: scene.id, name: scene.name, prompts: scene.prompts ?? { additional: scene.scenePrompt },
        generation: scene.generation ?? {}, width: scene.width, height: scene.height, generationFolderId: scene.generationFolderId,
        productionCount: scene.productionCount ?? 1, filenameTemplate: scene.filenameTemplate,
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
            for (const target of targets) {
                const document = await getRuntimeSceneRepository().getDocument(target.presetId)
                const scene = document?.scenes.find(candidate => candidate.id === target.sceneId)
                let item: JsonObject = scene ? { found: true, presetId: target.presetId, revision: document!.revision, ...publicScene(scene) }
                    : { found: false, ...target }
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

/** A bounded, paged directory lets an agent discover the same saved rows the Folder workbench renders. */
export async function getAgentAuthoringSnapshot(offset = 0, limit = 20): Promise<JsonObject> {
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
    const presets = useSceneStore.getState().presets
    const rows = []
    for (const summary of summaries) {
        if (!presets.some(preset => preset.id === summary.presetId)) continue
        const document = documents?.find(candidate => candidate.presetId === summary.presetId)
            ?? await repository.getDocument(summary.presetId)
        for (const scene of document?.scenes ?? []) rows.push({ presetId: summary.presetId, sceneId: scene.id,
            revision: document!.revision, name: scene.name.slice(0, 200), generationFolderId: scene.generationFolderId ?? null,
            productionCount: scene.productionCount ?? 1, resultCount: scene.artifactRefs.length })
    }
    const folders = await getRuntimeGenerationFolderDocument(DEFAULT_GENERATION_FOLDER_WORKSPACE_ID)
    const sortedFolders = [...(folders?.folders ?? [])].sort((a, b) => a.id.localeCompare(b.id))
    const pageSize = Math.min(limit, 50)
    return { scenePresets: summaries.slice(offset, offset + pageSize).map(summary => ({ ...summary,
        name: presets.find(preset => preset.id === summary.presetId)?.name.slice(0, 200) ?? summary.presetId })),
        scenes: rows.slice(offset, offset + pageSize), totalScenes: rows.length, totalPresets: summaries.length,
        folderRevision: folders?.revision ?? null,
        folders: sortedFolders.slice(offset, offset + pageSize).map(folder => ({ folderId: folder.id, name: folder.displayName,
            pathSegment: folder.pathSegment, parentId: folder.parentId, autoUpload: folder.autoUpload,
            directoryReference: folder.parentId === null ? folder.id : null })),
        totalFolders: sortedFolders.length, offset, pageSize,
        nextOffset: offset + pageSize < Math.max(rows.length, summaries.length, sortedFolders.length) ? offset + pageSize : null }
}
