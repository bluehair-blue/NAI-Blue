import type { ArtifactRecord } from '@/domain/organizer/types'
import type { SceneArtifactRef, SceneDocument, SceneRepositoryPort } from './scene-repository'

export type LinkSceneArtifactResult =
    | { readonly status: 'LINKED' | 'ALREADY_LINKED'; readonly document: SceneDocument }
    | { readonly status: 'SCENE_MISSING' }
    | { readonly status: 'PENDING_CONFLICT'; readonly artifactId: string }

export interface LinkSceneArtifactInput extends SceneArtifactRef {
    readonly presetId: string
    readonly sceneId: string
}

/** Adds one immutable artifact reference through the existing whole-document CAS. */
export async function linkSceneArtifact(
    repository: SceneRepositoryPort,
    input: LinkSceneArtifactInput,
): Promise<LinkSceneArtifactResult> {
    if (!input.presetId.trim() || !input.sceneId.trim() || !input.artifactId.trim()
        || !Number.isFinite(Date.parse(input.createdAt))) {
        throw new TypeError('Scene artifact link input is invalid')
    }

    let current = await repository.getDocument(input.presetId)
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const scene = current?.scenes.find(candidate => candidate.id === input.sceneId)
        if (current === null || scene === undefined) return { status: 'SCENE_MISSING' }
        if (scene.artifactRefs.some(reference => reference.artifactId === input.artifactId)) {
            return { status: 'ALREADY_LINKED', document: current }
        }
        const next: SceneDocument = {
            ...current,
            revision: current.revision + 1,
            updatedAt: input.createdAt,
            scenes: current.scenes.map(candidate => candidate.id === input.sceneId
                ? { ...candidate, artifactRefs: [...candidate.artifactRefs, {
                    artifactId: input.artifactId,
                    createdAt: input.createdAt,
                    favorite: input.favorite,
                }] }
                : candidate),
        }
        const committed = await repository.commit(next, current.revision)
        if (committed.status === 'COMMITTED') return { status: 'LINKED', document: committed.document }
        if (committed.status === 'STORAGE_CONFLICT') break
        current = committed.current
    }
    // The immutable ArtifactRecord remains the recovery authority for a later relink.
    return { status: 'PENDING_CONFLICT', artifactId: input.artifactId }
}

export interface SceneArtifactListPort {
    list(options?: { cursor?: string | null; limit?: number }): Promise<{
        readonly items: readonly ArtifactRecord[]
        readonly nextCursor: string | null
    }>
}

/** Replays Organizer lineage after startup/reopen without inventing pending state. */
export async function reconcileSceneArtifactLinks(
    scenes: SceneRepositoryPort,
    artifacts: SceneArtifactListPort,
    options: {
        readonly shouldLink?: (input: LinkSceneArtifactInput) => boolean
    } = {},
): Promise<readonly LinkSceneArtifactResult[]> {
    // Collection-backed adapters can return all documents from one bounded
    // read. Keep the sequential fallback for small in-memory/test adapters so
    // the same reconciliation contract remains usable without a bulk method.
    const documents: Array<SceneDocument | null> = scenes.listDocumentRecords !== undefined
        ? [...await scenes.listDocumentRecords()]
        : []
    if (scenes.listDocumentRecords === undefined) {
        for (const summary of await scenes.listDocuments()) {
            documents.push(await scenes.getDocument(summary.presetId))
        }
    }
    const sceneOwners = new Map<string, string | null>()
    for (const document of documents) {
        for (const scene of document?.scenes ?? []) {
            const owner = sceneOwners.get(scene.id)
            sceneOwners.set(scene.id, owner === undefined || owner === document!.presetId ? document!.presetId : null)
        }
    }

    const results: LinkSceneArtifactResult[] = []
    let cursor: string | null = null
    do {
        const page = await artifacts.list({ cursor, limit: 100 })
        for (const record of page.items) {
            if (record.sourceSceneId === null) continue
            const presetId = sceneOwners.get(record.sourceSceneId)
            if (presetId == null) continue
            const input: LinkSceneArtifactInput = {
                presetId,
                sceneId: record.sourceSceneId,
                artifactId: record.artifactId,
                createdAt: record.createdAt,
                favorite: false,
            }
            if (options.shouldLink?.(input) === false) continue
            results.push(await linkSceneArtifact(scenes, input))
        }
        cursor = page.nextCursor
    } while (cursor !== null)
    return results
}
