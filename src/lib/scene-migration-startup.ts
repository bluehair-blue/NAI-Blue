import { migrateSceneDocuments } from '@/application/scene/migrate-scene-documents'
import type { SceneDocument, SceneRepositoryPort } from '@/application/scene/scene-repository'
import { isSceneCompositionRef } from '@/application/scene/patch-scenes'

export interface SceneAuthorityMarker {
    readonly reader: 'v1' | 'v2'
    /** Exact serialized V1 bytes captured at startup; never rewritten by migration. */
    readonly v1Preimage: string
    readonly verifiedAt?: string
}

export interface SceneAuthorityMarkerPersistence {
    read(): Promise<SceneAuthorityMarker | null>
    write(marker: SceneAuthorityMarker): Promise<void>
}

export interface SceneLegacyPreimagePersistence {
    readSerialized(): Promise<string | null>
}

export type SceneMigrationStartupResult =
    | { readonly status: 'V1_FALLBACK'; readonly reason: 'NO_LEGACY' | 'ROLLED_BACK' | 'INVALID_V2' | 'COMMIT_FAILED' }
    | { readonly status: 'V2_ACTIVE'; readonly documents: readonly SceneDocument[] }

function sameDocument(left: SceneDocument | null, right: SceneDocument): boolean {
    return left !== null && JSON.stringify(left) === JSON.stringify(right)
}

function sameMigratedContent(left: SceneDocument, right: SceneDocument): boolean {
    return JSON.stringify({ ...left, updatedAt: '' }) === JSON.stringify({ ...right, updatedAt: '' })
}

/** Composition adds migration references after Scene captures V1. Only that additive
 * change may cross the authority boundary; every other original field must match. */
function hasOnlyAddedCompositionReferences(original: string, current: string): boolean {
    try {
        const before = JSON.parse(original)
        const after = JSON.parse(current)
        const presets = after.state.presets
        if (!Array.isArray(presets) || presets.length !== before.state.presets.length) return false
        for (const [index, preset] of presets.entries()) {
            const previous = before.state.presets[index]
            if (!Array.isArray(preset.scenes) || preset.scenes.length !== previous.scenes.length) return false
            for (const [sceneIndex, scene] of preset.scenes.entries()) {
                if (previous.scenes[sceneIndex].compositionRef !== undefined || scene.compositionRef === undefined) continue
                const ref = scene.compositionRef
                if (!isSceneCompositionRef(ref) || ref === undefined || ref.selectionKind !== 'asset'
                    || !ref.recipeId.startsWith('scene-recipe:migrated:')
                    || ref.migrationMarker?.kind !== 'legacy-scene-prompt'
                    || ref.migrationMarker.schemaVersion !== 2
                    || Object.keys(ref).some(key => !['recipeId', 'selectionKind', 'recipeRevision', 'migrationMarker'].includes(key))) return false
                delete scene.compositionRef
            }
        }
        return JSON.stringify(before) === JSON.stringify(after)
    } catch {
        return false
    }
}

async function readDocumentRecords(repository: SceneRepositoryPort): Promise<readonly SceneDocument[]> {
    if (repository.listDocumentRecords !== undefined) return repository.listDocumentRecords()
    const summaries = await repository.listDocuments()
    const documents: SceneDocument[] = []
    for (const summary of summaries) {
        const document = await repository.getDocument(summary.presetId)
        if (document !== null) documents.push(document)
    }
    return documents
}

/** Materializes V2 first, verifies readback, and only then switches the reader marker. */
export async function runSceneMigrationStartup(dependencies: {
    readonly repository: SceneRepositoryPort
    readonly legacyPreimage: SceneLegacyPreimagePersistence
    readonly marker: SceneAuthorityMarkerPersistence
    readonly now?: () => string
}): Promise<SceneMigrationStartupResult> {
    const currentMarker = await dependencies.marker.read()
    const preimage = await dependencies.legacyPreimage.readSerialized()
    const legacy = await dependencies.repository.readLegacyProjection()
    if (currentMarker?.reader === 'v1') return { status: 'V1_FALLBACK', reason: 'ROLLED_BACK' }
    if (preimage === null || legacy === null) {
        if (preimage !== null || legacy !== null) return { status: 'V1_FALLBACK', reason: 'INVALID_V2' }
        if (currentMarker !== null && currentMarker.v1Preimage !== '') {
            return { status: 'V1_FALLBACK', reason: 'INVALID_V2' }
        }
        try {
            const documents = await readDocumentRecords(dependencies.repository)
            if (currentMarker === null) {
                await dependencies.marker.write({
                    reader: 'v2',
                    v1Preimage: '',
                    verifiedAt: dependencies.now?.() ?? new Date().toISOString(),
                })
            }
            return { status: 'V2_ACTIVE', documents }
        } catch {
            return { status: 'V1_FALLBACK', reason: 'COMMIT_FAILED' }
        }
    }
    const addedCompositionReferences = currentMarker?.reader === 'v2'
        && currentMarker.v1Preimage !== preimage
        && hasOnlyAddedCompositionReferences(currentMarker.v1Preimage, preimage)
    if (currentMarker !== null && currentMarker.v1Preimage !== preimage && !addedCompositionReferences) {
        return { status: 'V1_FALLBACK', reason: 'INVALID_V2' }
    }
    if (currentMarker?.reader === 'v2') {
        try {
            const documents = await readDocumentRecords(dependencies.repository)
            const summaries = documents.map(document => ({ presetId: document.presetId }))
            const expectedPresetIds = new Set(legacy.presets.map(preset => preset.id))
            const complete = [...expectedPresetIds].every(presetId => summaries.some(summary => summary.presetId === presetId))
            if (complete) {
                if (!addedCompositionReferences) return { status: 'V2_ACTIVE', documents }
                const materialized: SceneDocument[] = []
                for (const document of documents) {
                    const source = legacy.presets.find(preset => preset.id === document.presetId)
                    const refs = new Map(source?.scenes.map(scene => [scene.id,
                        isSceneCompositionRef(scene.compositionRef) ? scene.compositionRef : undefined,
                    ] as const))
                    const scenes = document.scenes.map(scene => scene.compositionRef !== undefined || refs.get(scene.id) === undefined
                        ? scene : { ...scene, compositionRef: refs.get(scene.id)! })
                    if (scenes.every((scene, index) => scene === document.scenes[index])) {
                        materialized.push(document)
                        continue
                    }
                    // CAS retains V2 edits/artifact links and never rewrites the V1 backup.
                    const result = await dependencies.repository.commit({
                        ...document, scenes, revision: document.revision + 1,
                        updatedAt: dependencies.now?.() ?? new Date().toISOString(),
                    }, document.revision)
                    if (result.status !== 'COMMITTED') return { status: 'V1_FALLBACK', reason: 'COMMIT_FAILED' }
                    materialized.push(result.document)
                }
                const readback = await readDocumentRecords(dependencies.repository)
                if (!materialized.every(document => sameDocument(
                    readback.find(candidate => candidate.presetId === document.presetId) ?? null, document,
                ))) return { status: 'V1_FALLBACK', reason: 'INVALID_V2' }
                return { status: 'V2_ACTIVE', documents: readback }
            }
            await dependencies.marker.write({ reader: 'v1', v1Preimage: currentMarker.v1Preimage })
            return { status: 'V1_FALLBACK', reason: 'INVALID_V2' }
        } catch {
            if (addedCompositionReferences) return { status: 'V1_FALLBACK', reason: 'COMMIT_FAILED' }
            await dependencies.marker.write({ reader: 'v1', v1Preimage: currentMarker.v1Preimage })
            return { status: 'V1_FALLBACK', reason: 'INVALID_V2' }
        }
    }
    const now = currentMarker?.verifiedAt ?? dependencies.now?.() ?? new Date().toISOString()
    const projected = migrateSceneDocuments(legacy, now)
    try {
        const materialized: SceneDocument[] = []
        for (const document of projected) {
            const existing = await dependencies.repository.getDocument(document.presetId)
            if (existing === null) {
                const result = await dependencies.repository.commit(document, 0)
                if (result.status !== 'COMMITTED') return { status: 'V1_FALLBACK', reason: 'COMMIT_FAILED' }
                materialized.push(result.document)
            } else if (sameMigratedContent(existing, document)) {
                materialized.push(existing)
            } else {
                if (currentMarker?.reader === 'v2') {
                    await dependencies.marker.write({ reader: 'v1', v1Preimage: preimage })
                }
                return { status: 'V1_FALLBACK', reason: 'INVALID_V2' }
            }
        }
        const readback = await readDocumentRecords(dependencies.repository)
        if (!materialized.every(document => sameDocument(
            readback.find(candidate => candidate.presetId === document.presetId) ?? null,
            document,
        ))) {
            return { status: 'V1_FALLBACK', reason: 'INVALID_V2' }
        }
        await dependencies.marker.write({ reader: 'v2', v1Preimage: preimage, verifiedAt: now })
        return { status: 'V2_ACTIVE', documents: materialized }
    } catch {
        return { status: 'V1_FALLBACK', reason: 'COMMIT_FAILED' }
    }
}

/** Rollback changes only reader authority; V2 documents and artifacts remain recoverable. */
export async function rollbackSceneAuthority(marker: SceneAuthorityMarkerPersistence): Promise<void> {
    const current = await marker.read()
    if (current === null) return
    await marker.write({ reader: 'v1', v1Preimage: current.v1Preimage })
}

let runtimeSceneRepository: SceneRepositoryPort | null = null
let runtimeSceneRepositoryLoad: Promise<SceneRepositoryPort> | null = null

async function loadRuntimeSceneRepository(): Promise<SceneRepositoryPort> {
    if (runtimeSceneRepository !== null) return runtimeSceneRepository
    runtimeSceneRepositoryLoad ??= import('@/adapters/scene/indexeddb-scene-repository')
        .then(({ IndexedDbSceneRepository }) => {
            runtimeSceneRepository ??= new IndexedDbSceneRepository()
            return runtimeSceneRepository
        })
    return runtimeSceneRepositoryLoad
}

const lazyRuntimeSceneRepository: SceneRepositoryPort = {
    readLegacyProjection: async () => (await loadRuntimeSceneRepository()).readLegacyProjection(),
    getDocument: async presetId => (await loadRuntimeSceneRepository()).getDocument(presetId),
    listDocuments: async () => (await loadRuntimeSceneRepository()).listDocuments(),
    listDocumentRecords: async () => (await loadRuntimeSceneRepository()).listDocumentRecords?.() ?? [],
    commit: async (next, expectedRevision) => (
        await loadRuntimeSceneRepository()
    ).commit(next, expectedRevision),
}

export function getRuntimeSceneRepository(): SceneRepositoryPort {
    return runtimeSceneRepository ?? lazyRuntimeSceneRepository
}

export function resetRuntimeSceneRepositoryForTests(): void {
    runtimeSceneRepository = null
    runtimeSceneRepositoryLoad = null
}
