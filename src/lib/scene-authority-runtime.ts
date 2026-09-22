import type {
    SceneAuthoringRecord,
    SceneDocument,
    SceneRepositoryPort,
    SceneV1AuthoringRecord,
    SceneV1CompatibilityProjection,
    SceneV1PresetProjection,
} from '@/application/scene/scene-repository'
import type { ArtifactRecord } from '@/domain/organizer/types'
import { canonicalSerialize } from '@/domain/composition/canonical-serialize'
import { flushIndexedDBKey, SCENE_PRESENTATION_STORE_KEY } from '@/lib/indexed-db'
import {
    sceneImagePresentationKey,
    useSceneStore,
    type SceneCard,
    type SceneGenerationConfig,
    type SceneImage,
    type ScenePreset,
} from '@/stores/scene-store'

export interface SceneAuthorityRuntime {
    flush(): Promise<void>
    stop(): void
}

export interface ActivateSceneAuthorityOptions {
    /** Migration may pass its verified readback and avoid a second repository scan. */
    readonly documents?: readonly SceneDocument[]
    readonly legacyProjection?: SceneV1CompatibilityProjection | null
    /** Resolves durable Organizer originals into the native path consumed by existing Scene UI/export. */
    readonly artifactPresentation?: {
        get(artifactId: string): Promise<ArtifactRecord | null>
        resolveOriginalPath(record: ArtifactRecord): Promise<string | null>
    }
    /** Test seam; production flushes the ID-only presentation tombstone before Scene CAS. */
    readonly flushArtifactTombstones?: () => Promise<void>
}

interface ActiveRuntime extends SceneAuthorityRuntime {
    apply(document: SceneDocument, legacyPreset?: SceneV1PresetProjection): boolean
    createShell(document: SceneDocument, name: string): void
}

let activeRuntime: ActiveRuntime | null = null

function cloneLegacyImages(scene: SceneV1AuthoringRecord | undefined) {
    return scene?.images.map(image => ({ ...image })) ?? []
}

type SceneImagePresentation = Readonly<Record<string, { deleted?: true; favorite?: boolean }>>

function visibleLegacyImages(
    presetId: string,
    scene: SceneV1AuthoringRecord | undefined,
    overlay: SceneImagePresentation,
): SceneImage[] {
    return cloneLegacyImages(scene).flatMap(image => {
        const presentation = overlay[sceneImagePresentationKey(presetId, scene?.id ?? '', image.id)]
        if (presentation?.deleted) return []
        return [{
            ...image,
            ...(presentation?.favorite === undefined ? {} : { isFavorite: presentation.favorite }),
        }]
    })
}

function mergeSceneImages(
    record: SceneAuthoringRecord,
    current: SceneCard | undefined,
    legacyImages: readonly SceneImage[],
    resetRuntime: boolean,
    resolvedArtifacts: readonly SceneImage[] | undefined,
): SceneImage[] {
    const references = new Map(record.artifactRefs.map(reference => [reference.artifactId, reference]))
    const previousArtifactIds = new Set(current?.artifactRefs?.map(reference => reference.artifactId) ?? [])
    const candidates = resetRuntime
        ? [...(resolvedArtifacts ?? []), ...legacyImages]
        : [
            ...(current?.images.flatMap(image => {
                if (!previousArtifactIds.has(image.id)) return [{ ...image }]
                const reference = references.get(image.id)
                return reference === undefined ? [] : [{ ...image, isFavorite: reference.favorite }]
            }) ?? []),
            ...(resolvedArtifacts ?? []).filter(image => references.has(image.id)),
        ]
    const unique = new Map<string, SceneImage>()
    candidates.forEach(image => {
        if (!unique.has(image.id)) unique.set(image.id, { ...image })
    })
    return [...unique.values()].sort((left, right) => right.timestamp - left.timestamp)
}

function toSceneCard(
    record: SceneAuthoringRecord,
    current: SceneCard | undefined,
    legacy: SceneV1AuthoringRecord | undefined,
    resetRuntime: boolean,
    artifactImages: readonly SceneImage[] | undefined,
    presetId: string,
    overlay: SceneImagePresentation,
): SceneCard {
    const generation = record.generation === undefined
        ? undefined
        : {
            ...record.generation,
            // Stale V1 flags remain readable, but new Scene requests never regain SMEA.
            smea: false,
            smeaDyn: false,
        } as Partial<SceneGenerationConfig>
    return {
        ...structuredClone(record) as unknown as SceneCard,
        ...(generation === undefined ? {} : { generation }),
        queueCount: resetRuntime ? 0 : current?.queueCount ?? 0,
        images: mergeSceneImages(
            record,
            current,
            visibleLegacyImages(presetId, legacy, overlay),
            resetRuntime,
            artifactImages,
        ),
        ...(resetRuntime || current?.queuedFileNames === undefined
            ? {}
            : { queuedFileNames: [...current.queuedFileNames] }),
        artifactRefs: record.artifactRefs.map(reference => ({ ...reference })),
    }
}

function legacyShell(preset: SceneV1PresetProjection): ScenePreset {
    return {
        id: preset.id,
        name: preset.name,
        scenes: [],
        parentId: preset.parentId,
        defaultTemplate: preset.defaultTemplate === undefined
            ? undefined
            : structuredClone(preset.defaultTemplate) as ScenePreset['defaultTemplate'],
        createdAt: preset.createdAt,
    }
}

function legacyPresetProjection(
    preset: SceneV1PresetProjection,
    overlay: Readonly<Record<string, { deleted?: true; favorite?: boolean }>>,
): ScenePreset {
    return {
        ...legacyShell(preset),
        scenes: preset.scenes.map(scene => ({
            ...structuredClone(scene) as unknown as SceneCard,
            queueCount: 0,
            images: cloneLegacyImages(scene).flatMap(image => {
                const presentation = overlay[sceneImagePresentationKey(preset.id, scene.id, image.id)]
                if (presentation?.deleted) return []
                return [{
                    ...image,
                    ...(presentation?.favorite === undefined
                        ? {}
                        : { isFavorite: presentation.favorite }),
                }]
            }),
            artifactRefs: [],
        })),
    }
}

function mergeDocumentIntoShell(
    shell: ScenePreset,
    document: SceneDocument,
    legacy: SceneV1PresetProjection | undefined,
    resetRuntime: boolean,
    artifactImages: ReadonlyMap<string, readonly SceneImage[]> | undefined,
    overlay: SceneImagePresentation,
): ScenePreset {
    const currentById = new Map(shell.scenes.map(scene => [scene.id, scene]))
    const legacyById = new Map(legacy?.scenes.map(scene => [scene.id, scene]) ?? [])
    return {
        ...shell,
        scenes: document.scenes.map(scene => toSceneCard(
            scene,
            currentById.get(scene.id),
            legacyById.get(scene.id),
            resetRuntime,
            artifactImages?.get(scene.id),
            document.presetId,
            overlay,
        )),
    }
}

function optional<T extends object, K extends keyof T>(
    source: T,
    key: K,
): Pick<T, K> | Record<never, never> {
    return source[key] === undefined ? {} : { [key]: structuredClone(source[key]) } as Pick<T, K>
}

/** Projects exactly the V2 authoring fields; queue, images, filenames and UI state have no slot. */
function projectAuthoringScene(
    scene: SceneCard,
    authority: SceneAuthoringRecord | undefined,
    managedArtifactIds: Set<string> | undefined,
): SceneAuthoringRecord {
    const imagesById = new Map(scene.images.map(image => [image.id, image]))
    const artifactRefs = authority === undefined
        ? scene.artifactRefs ?? []
        : authority.artifactRefs.flatMap(reference => {
            const image = imagesById.get(reference.artifactId)
            if (image !== undefined) {
                managedArtifactIds?.add(reference.artifactId)
                return [{ ...reference, favorite: image.isFavorite }]
            }
            if (!managedArtifactIds?.has(reference.artifactId)) return [{ ...reference }]
            return []
        })
    return {
        id: scene.id,
        name: scene.name,
        scenePrompt: scene.scenePrompt,
        ...optional(scene, 'prompts'),
        ...optional(scene, 'characterCaptions'),
        ...optional(scene, 'characterPositionEnabled'),
        ...optional(scene, 'generation'),
        ...optional(scene, 'width'),
        ...optional(scene, 'height'),
        ...optional(scene, 'metadataMode'),
        ...optional(scene, 'generationFolderId'),
        ...optional(scene, 'productionCount'),
        ...optional(scene, 'filenameTemplate'),
        ...optional(scene, 'excludePinned'),
        ...optional(scene, 'compositionRef'),
        // Only Organizer-backed image IDs can mutate durable result links.
        artifactRefs: artifactRefs.map(reference => ({ ...reference })),
        createdAt: scene.createdAt,
    }
}

function projectPreset(
    preset: ScenePreset,
    authority: SceneDocument | undefined,
    managedArtifactIds: ReadonlyMap<string, Set<string>> | undefined,
): readonly SceneAuthoringRecord[] {
    const authorityById = new Map(authority?.scenes.map(scene => [scene.id, scene]) ?? [])
    return preset.scenes.map(scene => projectAuthoringScene(
        scene,
        authorityById.get(scene.id),
        managedArtifactIds?.get(scene.id),
    ))
}

function authoringHash(scenes: readonly SceneAuthoringRecord[]): string {
    // UI projection and repository writers insert properties in different orders. A result preview must not become an authoring edit.
    return canonicalSerialize(JSON.parse(JSON.stringify(scenes)))
}

function removesArtifactReference(
    current: SceneDocument | undefined,
    next: readonly SceneAuthoringRecord[],
): boolean {
    if (current === undefined) return false
    const nextByScene = new Map(next.map(scene => [scene.id, scene]))
    return current.scenes.some(scene => {
        const nextIds = new Set(nextByScene.get(scene.id)?.artifactRefs
            .map(reference => reference.artifactId) ?? [])
        return scene.artifactRefs.some(reference => !nextIds.has(reference.artifactId))
    })
}

async function readDocuments(repository: SceneRepositoryPort): Promise<readonly SceneDocument[]> {
    if (repository.listDocumentRecords !== undefined) return repository.listDocumentRecords()
    const summaries = await repository.listDocuments()
    const documents: Array<SceneDocument | null> = []
    for (const summary of summaries) documents.push(await repository.getDocument(summary.presetId))
    return documents.filter((document): document is SceneDocument => document !== null)
}

async function resolveArtifactImages(
    documents: readonly SceneDocument[],
    presentation: NonNullable<ActivateSceneAuthorityOptions['artifactPresentation']>,
    overlay: SceneImagePresentation,
): Promise<{
    readonly images: ReadonlyMap<string, ReadonlyMap<string, readonly SceneImage[]>>
    readonly managedIds: Map<string, Map<string, Set<string>>>
}> {
    const byPreset = new Map<string, ReadonlyMap<string, readonly SceneImage[]>>()
    const managedByPreset = new Map<string, Map<string, Set<string>>>()
    await Promise.all(documents.map(async document => {
        const byScene = new Map<string, readonly SceneImage[]>()
        const managedByScene = new Map<string, Set<string>>()
        await Promise.all(document.scenes.map(async scene => {
            const images = (await Promise.all(scene.artifactRefs.map(async reference => {
                if (overlay[sceneImagePresentationKey(document.presetId, scene.id, reference.artifactId)]?.deleted) {
                    return null
                }
                try {
                    const record = await presentation.get(reference.artifactId)
                    if (record === null) return null
                    const url = (await presentation.resolveOriginalPath(record))?.trim()
                    if (!url) return null
                    return {
                        id: reference.artifactId,
                        url,
                        timestamp: Date.parse(reference.createdAt),
                        isFavorite: reference.favorite,
                    } satisfies SceneImage
                } catch {
                    // A missing/unresolvable Organizer original must not block Scene startup.
                    return null
                }
            }))).filter((image): image is SceneImage => image !== null)
            byScene.set(scene.id, images)
            managedByScene.set(scene.id, new Set([
                ...images.map(image => image.id),
                ...scene.artifactRefs
                    .filter(reference => overlay[sceneImagePresentationKey(
                        document.presetId,
                        scene.id,
                        reference.artifactId,
                    )]?.deleted)
                    .map(reference => reference.artifactId),
            ]))
        }))
        byPreset.set(document.presetId, byScene)
        managedByPreset.set(document.presetId, managedByScene)
    }))
    return { images: byPreset, managedIds: managedByPreset }
}

/**
 * Starts the single UI-to-repository write bridge. Per-preset queues coalesce edits,
 * require the last observed revision, and refresh (never overwrite) on CAS conflict.
 */
export async function activateSceneAuthorityRuntime(
    repository: SceneRepositoryPort,
    options: ActivateSceneAuthorityOptions = {},
): Promise<SceneAuthorityRuntime> {
    activeRuntime?.stop()
    const [documents, legacyProjection] = await Promise.all([
        options.documents === undefined ? readDocuments(repository) : options.documents,
        options.legacyProjection === undefined
            ? repository.readLegacyProjection()
            : options.legacyProjection,
    ])
    const presentationState = useSceneStore.getState()
    const artifactPresentation = options.artifactPresentation === undefined
        ? undefined
        : await resolveArtifactImages(
            documents,
            options.artifactPresentation,
            presentationState.legacyImagePresentation,
        )
    const authority = new Map(documents.map(document => [document.presetId, structuredClone(document)]))
    const legacy = new Map(legacyProjection?.presets.map(preset => [preset.id, preset]) ?? [])
    const hashes = new Map<string, string>()
    const latest = new Map<string, readonly SceneAuthoringRecord[]>()
    const inFlightHashes = new Map<string, string>()
    const running = new Map<string, Promise<void>>()
    let applying = true
    let stopped = false
    let failure: unknown = null
    const flushArtifactTombstones = options.flushArtifactTombstones
        ?? (() => flushIndexedDBKey(SCENE_PRESENTATION_STORE_KEY))

    const apply = (
        document: SceneDocument,
        legacyPreset: SceneV1PresetProjection | undefined = legacy.get(document.presetId),
        resetRuntime = false,
    ): boolean => {
        authority.set(document.presetId, structuredClone(document))
        hashes.set(document.presetId, authoringHash(document.scenes))
        const state = useSceneStore.getState()
        const shell = state.presets.find(preset => preset.id === document.presetId)
        // Repository orphans remain recoverable but cannot recreate a deleted UI shell.
        if (shell === undefined) return false
        applying = true
        useSceneStore.setState(current => ({
            presets: current.presets.map(preset => preset.id === document.presetId
                ? mergeDocumentIntoShell(
                    preset,
                    document,
                    legacyPreset,
                    resetRuntime,
                    artifactPresentation?.images.get(document.presetId),
                    current.legacyImagePresentation,
                )
                : preset),
        }))
        applying = false
        return true
    }

    const run = (presetId: string): void => {
        if (running.has(presetId) || stopped) return
        const task = (async () => {
            while (!stopped) {
                const scenes = latest.get(presetId)
                if (scenes === undefined) break
                latest.delete(presetId)
                inFlightHashes.set(presetId, authoringHash(scenes))
                const current = authority.get(presetId)
                const expectedRevision = current?.revision ?? 0
                try {
                    if (removesArtifactReference(current, scenes)) {
                        // The tombstone is the crash-recovery guard. It must reach disk before
                        // a successful Scene CAS can make the link removal externally visible.
                        await flushArtifactTombstones()
                        if (stopped) break
                    }
                    const result = await repository.commit({
                        schemaVersion: 1,
                        presetId,
                        revision: expectedRevision + 1,
                        scenes,
                        updatedAt: new Date().toISOString(),
                    }, expectedRevision)
                    if (stopped) break
                    if (result.status === 'COMMITTED') {
                        const livePreset = useSceneStore.getState().presets
                            .find(preset => preset.id === presetId)
                        const liveHash = livePreset === undefined
                            ? null
                            : authoringHash(projectPreset(
                                livePreset,
                                current,
                                artifactPresentation?.managedIds.get(presetId),
                            ))
                        if (liveHash === authoringHash(scenes)) {
                            apply(result.document)
                        } else {
                            // A newer synchronous UI edit arrived while CAS was in flight.
                            authority.set(presetId, structuredClone(result.document))
                            hashes.set(presetId, authoringHash(result.document.scenes))
                        }
                    } else if (result.status === 'REVISION_CONFLICT') {
                        latest.delete(presetId)
                        if (result.current !== null) apply(result.current)
                    } else {
                        throw new Error(`Scene repository storage conflict for ${presetId}`)
                    }
                } finally {
                    inFlightHashes.delete(presetId)
                }
            }
        })().catch(error => {
            failure = error
            console.error('[SceneAuthority] UI projection commit failed:', error)
        }).finally(() => {
            running.delete(presetId)
            if (latest.has(presetId) && !stopped) run(presetId)
        })
        running.set(presetId, task)
    }

    const scan = (): void => {
        if (applying || stopped) return
        for (const preset of useSceneStore.getState().presets) {
            const scenes = projectPreset(
                preset,
                authority.get(preset.id),
                artifactPresentation?.managedIds.get(preset.id),
            )
            const hash = authoringHash(scenes)
            if (hashes.get(preset.id) === hash || inFlightHashes.get(preset.id) === hash) continue
            latest.set(preset.id, scenes)
            run(preset.id)
        }
    }

    const state = useSceneStore.getState()
    const initialBootstrap = !state.sceneAuthorityInitialized && legacy.size > 0
    const shells = initialBootstrap
        ? [...legacy.values()].map(legacyShell)
        : state.presets
    useSceneStore.setState({
        presets: shells.map(shell => {
            const document = authority.get(shell.id)
            return document === undefined
                ? shell
                : mergeDocumentIntoShell(
                    shell,
                    document,
                    legacy.get(shell.id),
                    true,
                    artifactPresentation?.images.get(document.presetId),
                    state.legacyImagePresentation,
                )
        }),
        activePresetId: shells.some(shell => shell.id === state.activePresetId)
            ? state.activePresetId
            : shells[0]?.id ?? null,
        sceneAuthorityInitialized: true,
    })
    for (const shell of shells) {
        const document = authority.get(shell.id)
        if (document !== undefined) hashes.set(shell.id, authoringHash(document.scenes))
    }
    applying = false

    const unsubscribe = useSceneStore.subscribe(scan)
    const runtime: ActiveRuntime = {
        apply: (document, legacyPreset) => apply(document, legacyPreset),
        createShell(document, name) {
            if (useSceneStore.getState().presets.some(preset => preset.id === document.presetId)) return
            // Only an explicitly committed authoring request can create a shell. Ordinary result replay keeps orphan protection.
            applying = true
            useSceneStore.setState(current => ({ presets: [...current.presets, {
                id: document.presetId, name, scenes: [], parentId: null, createdAt: Date.parse(document.updatedAt),
            }] }))
            applying = false
        },
        async flush() {
            scan()
            while (running.size > 0 || latest.size > 0) {
                for (const presetId of latest.keys()) run(presetId)
                await Promise.all([...running.values()])
            }
            if (failure !== null) throw failure
        },
        stop() {
            stopped = true
            latest.clear()
            unsubscribe()
            if (activeRuntime === runtime) activeRuntime = null
        },
    }
    activeRuntime = runtime
    scan()
    return runtime
}

/** Applies a verified Agent/result-link document without bypassing runtime revision tracking. */
export function applySceneDocumentProjection(
    document: SceneDocument,
    legacyPreset?: SceneV1PresetProjection,
): boolean {
    return activeRuntime?.apply(document, legacyPreset) ?? false
}

/** Agent authoring publishes the committed Scene through the same revision tracker and durable navigation shell as the UI. */
export async function publishAgentSceneDocument(document: SceneDocument, newPresetName?: string): Promise<void> {
    if (activeRuntime === null) throw new Error('Scene authority is not ready')
    if (newPresetName !== undefined) activeRuntime.createShell(document, newPresetName)
    if (!activeRuntime.apply(document)) throw new Error('Scene navigation shell is missing')
    await flushIndexedDBKey(SCENE_PRESENTATION_STORE_KEY)
}

/** Restores the preserved read-only V1 projection without starting a V2 writer. */
export function applyLegacySceneProjection(projection: SceneV1CompatibilityProjection): void {
    activeRuntime?.stop()
    const state = useSceneStore.getState()
    const presets = projection.presets.map(preset => legacyPresetProjection(
        preset,
        state.legacyImagePresentation,
    ))
    useSceneStore.setState({
        presets,
        activePresetId: presets.some(preset => preset.id === state.activePresetId)
            ? state.activePresetId
            : presets[0]?.id ?? null,
        sceneAuthorityInitialized: false,
    })
}

/** Lets authoring UIs await the existing repository bridge before presenting a saved result. */
export async function flushSceneAuthorityRuntime(): Promise<void> {
    if (activeRuntime === null) throw new Error('Scene authority is not ready')
    await activeRuntime.flush()
}

export function stopSceneAuthorityRuntimeForTests(): void {
    activeRuntime?.stop()
}
