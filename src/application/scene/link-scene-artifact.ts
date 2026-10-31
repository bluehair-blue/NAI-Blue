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
    const knownDocuments = new Map(documents.flatMap(document => document === null ? [] : [[document.presetId, document] as const]))
    const knownLinks = new Map(documents.flatMap(document => document?.scenes.map(scene => [
        JSON.stringify([document.presetId, scene.id]), new Set(scene.artifactRefs.map(reference => reference.artifactId)),
    ] as const) ?? []))
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
            // The bulk snapshot already proves existing links. Re-reading a
            // collection-backed repository for every historical image makes
            // startup quadratic. Missing links still use fresh reads and CAS.
            const key = JSON.stringify([presetId, record.sourceSceneId])
            const known = knownDocuments.get(presetId)
            if (known && knownLinks.get(key)?.has(record.artifactId)) {
                results.push({ status: 'ALREADY_LINKED', document: known })
                continue
            }
            const result = await linkSceneArtifact(scenes, input)
            results.push(result)
            if ('document' in result) {
                knownDocuments.set(presetId, result.document)
                for (const scene of result.document.scenes) knownLinks.set(
                    JSON.stringify([presetId, scene.id]), new Set(scene.artifactRefs.map(reference => reference.artifactId)),
                )
            }
        }
        cursor = page.nextCursor
    } while (cursor !== null)
    return results
}

/** Startup presentation applies each latest preset once, even when hundreds
 * of Artifact records report the same document or several CAS revisions.
 */
export function latestReconciledSceneDocuments(results: readonly LinkSceneArtifactResult[]): readonly SceneDocument[] {
    const documents = new Map<string, SceneDocument>()
    for (const result of results) {
        if (!('document' in result)) continue
        const current = documents.get(result.document.presetId)
        if (!current || current.revision < result.document.revision) documents.set(result.document.presetId, result.document)
    }
    return [...documents.values()]
}
