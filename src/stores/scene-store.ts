import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { indexedDBStorage } from '@/lib/indexed-db'
import {
    nativePathExists as exists,
    renameNativePath as rename,
} from '@/platform/native-file-system'
import { joinNativePath } from '@/platform/native-path'
import { getMediaStorageRoot, shouldUseAbsoluteMediaPath } from '@/platform/storage'
import type { CompositionPlanHash } from '@/domain/composition/canonical-serialize'
import type { CompositionEngineIssue } from '@/domain/composition/engine'
import type { DeepReadonly } from '@/domain/composition/provenance'
import type {
    SceneCompositionMode,
    SceneCompositionRef,
} from '@/lib/composition/scene-adapter'
import { abortSceneSessionRequests } from '@/lib/scene-generation/request-cancellation'
import type { MetadataMode } from '@/lib/generation-metadata'
import { generateRandomSeed } from '@/lib/utils'
import { DEFAULT_NAI_IMAGE_MODEL } from '@/services/nai/model-catalog'
import type { SceneArtifactRef } from '@/application/scene/scene-repository'

export type { SceneCompositionMode, SceneCompositionRef } from '@/lib/composition/scene-adapter'

export interface SceneImage {
    id: string
    url: string  // data:image/png;base64,... format
    timestamp: number
    isFavorite: boolean
}

export interface ScenePromptConfig {
    base: string
    additional: string
    character: string
    negative: string
    characterNegative: string
}

export interface SceneCharacterCaption {
    id: string
    name?: string
    prompt: string
    negative: string
    enabled: boolean
    /** NovelAI character-caption coordinates use normalized 0..1 image space. */
    position: { x: number; y: number }
}

export interface SceneGenerationConfig {
    model: string
    steps: number
    cfgScale: number
    cfgRescale: number
    sampler: string
    scheduler: string
    /** Provider compatibility fields are always normalized to false for Scene requests. */
    smea: false
    smeaDyn: false
    variety: boolean
    qualityToggle: boolean
    ucPreset: number
    seed: number
    seedLocked: boolean
}

export const DEFAULT_SCENE_PROMPTS: ScenePromptConfig = {
    base: '',
    additional: '',
    character: '',
    negative: '',
    characterNegative: '',
}

export const DEFAULT_SCENE_GENERATION: SceneGenerationConfig = {
    model: DEFAULT_NAI_IMAGE_MODEL,
    steps: 28,
    cfgScale: 5,
    cfgRescale: 0,
    sampler: 'k_euler_ancestral',
    scheduler: 'karras',
    smea: false,
    smeaDyn: false,
    variety: false,
    qualityToggle: true,
    ucPreset: 0,
    seed: 0,
    seedLocked: false,
}

export interface SceneCard {
    id: string
    name: string
    scenePrompt: string
    /** Scene-owned prompt module. `scenePrompt` remains as an import/sync compatibility alias. */
    prompts?: Partial<ScenePromptConfig>
    /** Scene-owned character captions. Undefined promotes the legacy scalar character slots. */
    characterCaptions?: SceneCharacterCaption[]
    /** Enables per-caption coordinates for this Scene only. */
    characterPositionEnabled?: boolean
    /** Scene-owned generation parameters; Main prompt-panel changes never mutate this snapshot. */
    generation?: Partial<SceneGenerationConfig>
    queueCount: number  // Number of images to generate
    /** Saved authoring quantity for repeatable production; never a pending Queue entry or replay instruction. */
    productionCount?: number
    images: SceneImage[]  // Generated images for this scene
    width?: number
    height?: number
    /** Scene-level output policy; undefined keeps the global Settings policy for legacy cards. */
    metadataMode?: MetadataMode
    /** Optional shared generation-folder plan selected specifically for this scene. */
    generationFolderId?: string
    /** Scene-wide filename template. Empty/undefined keeps the resolved output policy. */
    filenameTemplate?: string
    /** FIFO overrides aligned with pending queue entries; blanks inherit filenameTemplate. */
    queuedFileNames?: string[]
    excludePinned?: boolean // Rotation-only: skip pinned characters for this scene.
    compositionRef?: SceneCompositionRef
    /** Durable result links projected from SceneRepository; raw images stay presentation-only. */
    artifactRefs?: SceneArtifactRef[]
    createdAt: number
}

export interface SceneFolderTemplate {
    sourceSceneId: string
    sourceSceneName: string
    scenePrompt: string
    prompts: ScenePromptConfig
    characterCaptions?: SceneCharacterCaption[]
    characterPositionEnabled?: boolean
    generation: SceneGenerationConfig
    width?: number
    height?: number
    excludePinned?: boolean
    metadataMode?: MetadataMode
    filenameTemplate?: string
    compositionRef?: SceneCompositionRef
}

export interface SceneQueueClaim {
    scene: SceneCard
    filenameTemplate?: string
}

export interface SceneRenameStorageContext {
    sceneSavePath: string
    useAbsoluteScenePath: boolean
}

/** Old Scene cards remain readable while all new edits use the modular prompt shape. */
export function resolveScenePrompts(scene: Pick<SceneCard, 'scenePrompt' | 'prompts'>): ScenePromptConfig {
    return {
        ...DEFAULT_SCENE_PROMPTS,
        additional: scene.scenePrompt || '',
        ...scene.prompts,
    }
}

/**
 * New Scene cards own a caption array. Legacy cards are promoted lazily so old
 * persisted presets keep generating the same single character without a data migration.
 */
export function resolveSceneCharacterCaptions(
    scene: Pick<SceneCard, 'id' | 'name' | 'scenePrompt' | 'prompts' | 'characterCaptions'>,
): SceneCharacterCaption[] {
    if (scene.characterCaptions !== undefined) {
        return scene.characterCaptions.map(caption => ({
            ...caption,
            position: { ...caption.position },
        }))
    }

    const prompts = resolveScenePrompts(scene)
    if (!prompts.character.trim() && !prompts.characterNegative.trim()) return []
    return [{
        id: `scene:${scene.id}:character`,
        name: scene.name,
        prompt: prompts.character,
        negative: prompts.characterNegative,
        enabled: true,
        position: { x: 0.5, y: 0.5 },
    }]
}

export function resolveSceneGeneration(scene: Pick<SceneCard, 'generation'>): SceneGenerationConfig {
    return {
        ...DEFAULT_SCENE_GENERATION,
        ...scene.generation,
        // NAI 4.5 no longer accepts SMEA controls. Ignore stale persisted flags.
        smea: false,
        smeaDyn: false,
    }
}

export interface SceneCompositionRuntimeRecord {
    mode: SceneCompositionMode
    planHash?: DeepReadonly<CompositionPlanHash>
    warnings: readonly DeepReadonly<CompositionEngineIssue>[]
    errors: readonly DeepReadonly<CompositionEngineIssue>[]
}

export function hasSceneCompositionOverrides(scene: Pick<SceneCard, 'id' | 'name' | 'scenePrompt' | 'prompts' | 'characterCaptions' | 'generation' | 'width' | 'height' | 'compositionRef'>): boolean {
    const ref = scene.compositionRef
    return Object.values(resolveScenePrompts(scene)).some(value => value.trim().length > 0)
        || resolveSceneCharacterCaptions(scene).some(caption => (
            caption.prompt.trim().length > 0 || caption.negative.trim().length > 0
        ))
        || scene.generation !== undefined
        || scene.width !== undefined
        || scene.height !== undefined
        || (ref?.sceneContributions?.length ?? 0) > 0
        || ref?.paramsOverride !== undefined
        || (ref?.characterOverrides?.length ?? 0) > 0
        || ref?.outputOverride !== undefined
}

export interface ScenePreset {
    id: string
    name: string
    scenes: SceneCard[]
    /** Presets remain the persistence contract while parentId turns them into Scene folders. */
    parentId?: string | null
    defaultTemplate?: SceneFolderTemplate
    createdAt: number
}

/** Resolves the logical folder tree into the same path segments used by Scene output persistence. */
export function getScenePresetPathSegments(presets: readonly ScenePreset[], presetId: string): string[] {
    const byId = new Map(presets.map(preset => [preset.id, preset]))
    const visited = new Set<string>()
    const segments: string[] = []
    let current = byId.get(presetId)
    while (current && !visited.has(current.id)) {
        visited.add(current.id)
        segments.unshift(current.name || 'Default')
        current = current.parentId ? byId.get(current.parentId) : undefined
    }
    return segments
}

interface SceneState {
    presets: ScenePreset[]
    activePresetId: string | null
    /** Distinguishes first V1 bootstrap from an intentionally deleted presentation shell. */
    sceneAuthorityInitialized: boolean
    /** ID-only visibility overlay; legacy URLs/base64 remain solely in the preimage. */
    legacyImagePresentation: Record<string, { deleted?: true; favorite?: boolean }>

    // Actions - Presets
    addPreset: (name: string, parentId?: string | null) => string
    deletePreset: (id: string) => void
    renamePreset: (id: string, name: string) => void
    movePresets: (ids: string[], parentId: string | null) => void
    duplicatePresets: (ids: string[]) => void
    setPresetDefaultFromScene: (targetPresetIds: string[], sourcePresetId: string, sceneId: string) => void
    clearPresetDefault: (presetIds: string[]) => void
    reorderPresets: (oldIndex: number, newIndex: number) => void
    setActivePreset: (id: string) => void
    getActivePreset: () => ScenePreset | undefined

    // Actions - Scenes
    addScene: (presetId: string, name?: string) => string
    deleteScene: (presetId: string, sceneId: string) => void
    duplicateScene: (presetId: string, sceneId: string) => void
    renameScene: (
        presetId: string,
        sceneId: string,
        name: string,
        storage: SceneRenameStorageContext,
    ) => Promise<void>
    updateScenePrompt: (presetId: string, sceneId: string, prompt: string) => void
    updateScenePrompts: (presetId: string, sceneId: string, prompts: Partial<ScenePromptConfig>) => void
    updateSceneCharacterCaptions: (presetId: string, sceneId: string, captions: readonly SceneCharacterCaption[], positionEnabled?: boolean) => void
    updateSceneSettings: (presetId: string, sceneId: string, settings: { width?: number, height?: number, excludePinned?: boolean, metadataMode?: MetadataMode, generationFolderId?: string | undefined }) => void
    updateSceneGeneration: (presetId: string, sceneId: string, generation: Partial<SceneGenerationConfig>) => void
    consumeSceneGenerationSeed: (presetId: string, sceneId: string) => number
    setSceneFilenameTemplate: (presetId: string, sceneId: string, filenameTemplate: string) => void
    setQueuedImageFileNames: (presetId: string, sceneId: string, fileNames: readonly string[]) => void
    setSceneCompositionRef: (presetId: string, sceneId: string, ref: SceneCompositionRef | undefined) => void
    resetSceneToRecipe: (presetId: string, sceneId: string) => void
    updateAllScenesResolution: (presetId: string, width: number, height: number) => void
    reorderScenes: (presetId: string, scenes: SceneCard[]) => void
    getScene: (presetId: string, sceneId: string) => SceneCard | undefined

    // Actions - Queue
    setQueueCount: (presetId: string, sceneId: string, count: number) => void
    setSceneProductionCounts: (targets: readonly { presetId: string; sceneId: string }[], count: number) => void
    incrementQueue: (presetId: string, sceneId: string, count?: number) => void
    decrementQueue: (presetId: string, sceneId: string) => void
    addAllToQueue: (presetId: string, count?: number) => void
    clearAllQueue: (presetId: string) => void
    getTotalQueueCount: (presetId: string) => number
    getQueuedScenes: (presetId: string) => SceneCard[]

    // Actions - Images
    addImageToScene: (
        presetId: string,
        sceneId: string,
        imageUrl: string,
        imageId?: string,
        isFavorite?: boolean,
    ) => void
    toggleFavorite: (presetId: string, sceneId: string, imageId: string) => void
    deleteImage: (presetId: string, sceneId: string, imageId: string) => void
    deleteNonFavoriteImages: (presetId: string, sceneId: string) => { count: number; paths: string[] }
    clearAllFavorites: (presetId: string, sceneId: string) => number
    deleteAllImages: (presetId: string, sceneId: string) => { count: number; paths: string[] }
    getSceneThumbnail: (scene: SceneCard) => string | undefined

    // Actions - Generation
    decrementFirstQueuedScene: (presetId: string) => SceneQueueClaim | null
    requeueSceneGeneration: (presetId: string, sceneId: string, filenameTemplate?: string) => void
    consumeSceneQueueEntries: (presetId: string, sceneId: string, count: number) => void

    // Generation Status
    isGenerating: boolean
    isCancelling: boolean  // True while active worker requests are aborting
    setIsGenerating: (isGenerating: boolean) => void
    cancelSceneGeneration: () => void  // Invalidates the session and aborts its active HTTP requests
    generationSessionId: number  // Incremented on each new generation session to invalidate old ones
    startNewGenerationSession: () => number  // Returns new session ID

    // Streaming State
    streamingSceneId: string | null
    streamingImage: string | null
    streamingProgress: number
    setStreamingData: (sceneId: string | null, image: string | null, progress: number) => void
    
    // Memory cleanup - call when leaving scene mode to release streaming data
    clearRuntimeData: () => void

    // History Refresh Trigger
    historyRefreshTrigger: number
    triggerHistoryRefresh: () => void

    // File Management
    importPreset: (preset: ScenePreset) => void
    validateSceneImages: (presetId: string, sceneId: string, validImageIds: string[]) => void

    // Multi-Select / Edit Mode
    isEditMode: boolean
    selectedSceneIds: string[]
    setEditMode: (isEdit: boolean) => void
    toggleSceneSelection: (sceneId: string, clearOthers?: boolean) => void
    selectSceneRange: (fromId: string, toId: string) => void
    selectAllScenes: () => void
    clearSelection: () => void
    deleteSelectedScenes: () => void
    moveSelectedScenesToPreset: (targetPresetId: string) => void
    updateSelectedScenesResolution: (width: number, height: number) => void
    applyRecipeToSelectedScenes: (
        recipeId: string,
        recipeRevision?: number,
        selectionKind?: SceneCompositionRef['selectionKind'],
    ) => void
    lastSelectedSceneId: string | null
    setLastSelectedSceneId: (id: string | null) => void

    // Composition v2 rollout and transient worker diagnostics
    sceneCompositionMode: SceneCompositionMode
    sceneCompositionResults: Record<string, SceneCompositionRuntimeRecord>
    setSceneCompositionMode: (mode: SceneCompositionMode) => void
    recordSceneCompositionResult: (sceneId: string, record: SceneCompositionRuntimeRecord) => void
    clearSceneCompositionResult: (sceneId: string) => void

    // Generation Progress
    completedCount: number
    totalQueuedCount: number
    setGenerationProgress: (completed: number, total: number) => void
    initGenerationProgress: () => void

    // Grid Layout
    gridColumns: number
    setGridColumns: (columns: number) => void
    thumbnailLayout: 'vertical' | 'horizontal'
    setThumbnailLayout: (layout: 'vertical' | 'horizontal') => void

    // Scroll Position (for returning from detail page)
    scrollPosition: number
    setScrollPosition: (position: number) => void
}

const DEFAULT_PRESET_ID = 'scene-default'

const createDefaultPreset = (): ScenePreset => ({
    id: DEFAULT_PRESET_ID,
    name: '기본',
    scenes: [],
    parentId: null,
    createdAt: Date.now(),
})

const createSceneEntityId = (): string => `${Date.now()}-${crypto.randomUUID()}`
export const sceneImagePresentationKey = (presetId: string, sceneId: string, imageId: string): string => (
    JSON.stringify([presetId, sceneId, imageId])
)
function withoutImagePresentation(
    presentation: SceneState['legacyImagePresentation'],
    key: string,
): SceneState['legacyImagePresentation'] {
    if (!(key in presentation)) return presentation
    const next = { ...presentation }
    delete next[key]
    return next
}
const nextSceneGenerationSessionId = (current: number): number => Math.max(Date.now(), current + 1)
const MAX_FILENAME_TEMPLATE_LENGTH = 180

function normalizeFilenameTemplate(value: string | undefined): string | undefined {
    const normalized = sanitizeFilenameTemplateInput(value)?.trim()
    return normalized || undefined
}

function sanitizeFilenameTemplateInput(value: string | undefined): string | undefined {
    const sanitized = value?.replace(/[\r\n]+/g, ' ').slice(0, MAX_FILENAME_TEMPLATE_LENGTH)
    return sanitized || undefined
}

function normalizeQueuedFileNames(values: readonly string[], count: number): string[] | undefined {
    const normalized = Array.from({ length: Math.max(0, count) }, (_, index) => (
        normalizeFilenameTemplate(values[index]) ?? ''
    ))
    return normalized.some(Boolean) ? normalized : undefined
}

/** Clones nested coordinates so duplicated Scenes and folder defaults never share mutable caption state. */
function cloneSceneCharacterCaptions(
    captions: readonly SceneCharacterCaption[] | undefined,
): SceneCharacterCaption[] | undefined {
    return captions?.map(caption => ({
        ...caption,
        position: { ...caption.position },
    }))
}

/** Template cloning isolates folder defaults from later edits to either the source or created Scene. */
function cloneSceneFolderTemplate(template: SceneFolderTemplate): SceneFolderTemplate {
    return {
        ...template,
        prompts: { ...template.prompts },
        characterCaptions: cloneSceneCharacterCaptions(template.characterCaptions),
        generation: { ...template.generation },
        ...(template.compositionRef === undefined
            ? {}
            : { compositionRef: structuredClone(template.compositionRef) }),
    }
}

function sceneFolderTemplateFromScene(scene: SceneCard): SceneFolderTemplate {
    return {
        sourceSceneId: scene.id,
        sourceSceneName: scene.name,
        scenePrompt: scene.scenePrompt,
        prompts: resolveScenePrompts(scene),
        characterCaptions: resolveSceneCharacterCaptions(scene),
        characterPositionEnabled: scene.characterPositionEnabled === true,
        generation: resolveSceneGeneration(scene),
        ...(scene.width === undefined ? {} : { width: scene.width }),
        ...(scene.height === undefined ? {} : { height: scene.height }),
        ...(scene.excludePinned === undefined ? {} : { excludePinned: scene.excludePinned }),
        ...(scene.metadataMode === undefined ? {} : { metadataMode: scene.metadataMode }),
        ...(scene.filenameTemplate === undefined ? {} : { filenameTemplate: scene.filenameTemplate }),
        ...(scene.compositionRef === undefined ? {} : { compositionRef: structuredClone(scene.compositionRef) }),
    }
}

function withoutSceneCompositionResult(
    records: Record<string, SceneCompositionRuntimeRecord>,
    sceneId: string,
): Record<string, SceneCompositionRuntimeRecord> {
    if (!(sceneId in records)) return records
    const next = { ...records }
    delete next[sceneId]
    return next
}

function withoutSceneCompositionResults(
    records: Record<string, SceneCompositionRuntimeRecord>,
    sceneIds: readonly string[],
): Record<string, SceneCompositionRuntimeRecord> {
    if (!sceneIds.some(id => id in records)) return records
    const next = { ...records }
    sceneIds.forEach(id => delete next[id])
    return next
}

/**
 * Persists only the Scene navigation shell. Scene authoring and result links are
 * re-projected from SceneRepository, while queue/images/session data stay in memory.
 */
export function projectScenePresentationState(state: SceneState) {
    return {
        presets: state.presets.map(preset => ({
            id: preset.id,
            name: preset.name,
            scenes: [],
            parentId: preset.parentId,
            defaultTemplate: preset.defaultTemplate
                ? cloneSceneFolderTemplate(preset.defaultTemplate)
                : undefined,
            createdAt: preset.createdAt,
        })),
        activePresetId: state.activePresetId,
        sceneAuthorityInitialized: state.sceneAuthorityInitialized,
        legacyImagePresentation: { ...state.legacyImagePresentation },
        isEditMode: state.isEditMode,
        selectedSceneIds: [...state.selectedSceneIds],
        lastSelectedSceneId: state.lastSelectedSceneId,
        gridColumns: state.gridColumns,
        thumbnailLayout: state.thumbnailLayout,
        scrollPosition: state.scrollPosition,
        sceneCompositionMode: state.sceneCompositionMode,
    }
}

export const useSceneStore = create<SceneState>()(
    persist(
        (set, get) => ({
            presets: [createDefaultPreset()],
            activePresetId: DEFAULT_PRESET_ID,
            sceneAuthorityInitialized: false,
            legacyImagePresentation: {},
            sceneCompositionMode: 'v2',
            sceneCompositionResults: {},
            setSceneCompositionMode: (sceneCompositionMode) => set({
                sceneCompositionMode,
                sceneCompositionResults: {},
            }),
            recordSceneCompositionResult: (sceneId, record) => set(state => ({
                sceneCompositionResults: {
                    ...state.sceneCompositionResults,
                    [sceneId]: {
                        ...record,
                        ...(record.planHash === undefined
                            ? {}
                            : { planHash: { ...record.planHash } }),
                        warnings: record.warnings.map(issue => ({
                            ...issue,
                            fieldPath: [...issue.fieldPath],
                        })),
                        errors: record.errors.map(issue => ({
                            ...issue,
                            fieldPath: [...issue.fieldPath],
                        })),
                    },
                },
            })),
            clearSceneCompositionResult: (sceneId) => set(state => ({
                sceneCompositionResults: withoutSceneCompositionResult(state.sceneCompositionResults, sceneId),
            })),

            // Preset Actions
            addPreset: (name, parentId = null) => {
                const newPreset: ScenePreset = {
                    id: createSceneEntityId(),
                    name,
                    scenes: [],
                    parentId,
                    createdAt: Date.now(),
                }
                set(state => ({
                    presets: [...state.presets, newPreset],
                    activePresetId: newPreset.id,
                }))
                return newPreset.id
            },

            deletePreset: (id) => {
                if (id === DEFAULT_PRESET_ID) return
                set(state => {
                    // Removing a folder owns its descendants so the persisted tree can never retain orphans.
                    const deleted = new Set([id])
                    let changed = true
                    while (changed) {
                        changed = false
                        state.presets.forEach(preset => {
                            if (preset.parentId && deleted.has(preset.parentId) && !deleted.has(preset.id)) {
                                deleted.add(preset.id)
                                changed = true
                            }
                        })
                    }
                    const deletedSceneIds = state.presets
                        .filter(preset => deleted.has(preset.id))
                        .flatMap(preset => preset.scenes.map(scene => scene.id))
                    return {
                        presets: state.presets.filter(preset => !deleted.has(preset.id)),
                        activePresetId: state.activePresetId && deleted.has(state.activePresetId)
                            ? DEFAULT_PRESET_ID
                            : state.activePresetId,
                        sceneCompositionResults: withoutSceneCompositionResults(
                            state.sceneCompositionResults,
                            deletedSceneIds,
                        ),
                    }
                })
            },

            renamePreset: (id, name) => {
                set(state => ({
                    presets: state.presets.map(p =>
                        p.id === id ? { ...p, name } : p
                    ),
                }))
            },

            movePresets: (ids, parentId) => set(state => {
                const selected = new Set(ids.filter(id => id !== DEFAULT_PRESET_ID))
                if (selected.size === 0 || (parentId !== null && !state.presets.some(preset => preset.id === parentId))) {
                    return state
                }
                // Reject moves into any selected folder's descendant to keep path resolution acyclic.
                const descendants = new Set(selected)
                let changed = true
                while (changed) {
                    changed = false
                    state.presets.forEach(preset => {
                        if (preset.parentId && descendants.has(preset.parentId) && !descendants.has(preset.id)) {
                            descendants.add(preset.id)
                            changed = true
                        }
                    })
                }
                if (parentId !== null && descendants.has(parentId)) return state
                return {
                    presets: state.presets.map(preset => selected.has(preset.id)
                        ? { ...preset, parentId }
                        : preset),
                }
            }),

            duplicatePresets: (ids) => set(state => {
                const selected = new Set(ids)
                // If parent and child are both selected, cloning the parent already includes that child.
                const roots = state.presets.filter(preset => selected.has(preset.id)
                    && !(preset.parentId && selected.has(preset.parentId)))
                if (roots.length === 0) return state
                const additions: ScenePreset[] = []
                const cloneBranch = (source: ScenePreset, parentId: string | null, root: boolean): void => {
                    const cloneId = createSceneEntityId()
                    additions.push({
                        ...source,
                        id: cloneId,
                        name: root ? `${source.name} (복사본)` : source.name,
                        parentId,
                        scenes: source.scenes.map(scene => ({
                            ...scene,
                            id: createSceneEntityId(),
                            queueCount: 0,
                            images: [],
                            prompts: scene.prompts ? { ...scene.prompts } : undefined,
                            characterCaptions: cloneSceneCharacterCaptions(scene.characterCaptions),
                            generation: scene.generation ? { ...scene.generation } : undefined,
                            compositionRef: scene.compositionRef ? structuredClone(scene.compositionRef) : undefined,
                            createdAt: Date.now(),
                        })),
                        defaultTemplate: source.defaultTemplate
                            ? cloneSceneFolderTemplate(source.defaultTemplate)
                            : undefined,
                        createdAt: Date.now(),
                    })
                    state.presets
                        .filter(candidate => candidate.parentId === source.id)
                        .forEach(child => cloneBranch(child, cloneId, false))
                }
                roots.forEach(root => cloneBranch(root, root.parentId ?? null, true))
                return { presets: [...state.presets, ...additions] }
            }),

            setPresetDefaultFromScene: (targetPresetIds, sourcePresetId, sceneId) => set(state => {
                const source = state.presets.find(preset => preset.id === sourcePresetId)
                    ?.scenes.find(scene => scene.id === sceneId)
                if (!source) return state
                const targets = new Set(targetPresetIds)
                const template = sceneFolderTemplateFromScene(source)
                return {
                    presets: state.presets.map(preset => targets.has(preset.id)
                        ? { ...preset, defaultTemplate: cloneSceneFolderTemplate(template) }
                        : preset),
                }
            }),

            clearPresetDefault: (presetIds) => set(state => {
                const targets = new Set(presetIds)
                return {
                    presets: state.presets.map(preset => targets.has(preset.id)
                        ? { ...preset, defaultTemplate: undefined }
                        : preset),
                }
            }),

            reorderPresets: (oldIndex, newIndex) => {
                set(state => {
                    const newPresets = [...state.presets]
                    const [removed] = newPresets.splice(oldIndex, 1)
                    newPresets.splice(newIndex, 0, removed)
                    return { presets: newPresets }
                })
            },

            setActivePreset: (id) => set({ activePresetId: id }),

            getActivePreset: () => {
                return get().presets.find(p => p.id === get().activePresetId)
            },

            // Scene Actions
            addScene: (presetId, name) => {
                const sceneId = createSceneEntityId()
                set(state => ({
                    presets: state.presets.map(p => {
                        if (p.id !== presetId) return p
                        const template = p.defaultTemplate
                        const newScene: SceneCard = {
                            id: sceneId,
                            name: name || `씬 ${p.scenes.length + 1}`,
                            scenePrompt: template?.scenePrompt ?? '',
                            prompts: template ? { ...template.prompts } : { ...DEFAULT_SCENE_PROMPTS },
                            characterCaptions: template
                                ? cloneSceneCharacterCaptions(template.characterCaptions) ?? []
                                : [],
                            characterPositionEnabled: template?.characterPositionEnabled === true,
                            generation: template ? { ...template.generation } : { ...DEFAULT_SCENE_GENERATION },
                            queueCount: 0,
                            images: [],
                            ...(template?.width === undefined ? {} : { width: template.width }),
                            ...(template?.height === undefined ? {} : { height: template.height }),
                            excludePinned: template?.excludePinned ?? false,
                            ...(template?.metadataMode === undefined ? {} : { metadataMode: template.metadataMode }),
                            ...(template?.filenameTemplate === undefined ? {} : { filenameTemplate: template.filenameTemplate }),
                            ...(template?.compositionRef === undefined
                                ? {}
                                : { compositionRef: structuredClone(template.compositionRef) }),
                            createdAt: Date.now(),
                        }
                        return { ...p, scenes: [...p.scenes, newScene] }
                    }),
                }))
                return sceneId
            },

            deleteScene: (presetId, sceneId) => {
                set(state => ({
                    presets: state.presets.map(p =>
                        p.id === presetId
                            ? { ...p, scenes: p.scenes.filter(s => s.id !== sceneId) }
                            : p
                    ),
                    sceneCompositionResults: withoutSceneCompositionResult(state.sceneCompositionResults, sceneId),
                }))
            },

            duplicateScene: (presetId, sceneId) => {
                set(state => ({
                    presets: state.presets.map(p => {
                        if (p.id !== presetId) return p
                        const scene = p.scenes.find(s => s.id === sceneId)
                        if (!scene) return p
                        const duplicated: SceneCard = {
                            ...scene,
                            id: createSceneEntityId(),
                            name: `${scene.name} (복사본)`,
                            queueCount: 0,
                            queuedFileNames: undefined,
                            images: [],
                            prompts: scene.prompts ? { ...scene.prompts } : undefined,
                            characterCaptions: cloneSceneCharacterCaptions(scene.characterCaptions),
                            generation: scene.generation ? { ...scene.generation } : undefined,
                            compositionRef: scene.compositionRef ? structuredClone(scene.compositionRef) : undefined,
                            createdAt: Date.now(),
                        }
                        const index = p.scenes.findIndex(s => s.id === sceneId)
                        const newScenes = [...p.scenes]
                        newScenes.splice(index + 1, 0, duplicated)
                        return { ...p, scenes: newScenes }
                    }),
                }))
            },

            renameScene: async (presetId, sceneId, name, storage) => {
                const state = get()
                const preset = state.presets.find(p => p.id === presetId)
                const scene = preset?.scenes.find(s => s.id === sceneId)
                
                if (!scene || scene.name === name) return
                
                const oldName = scene.name
                const safeOldName = oldName.replace(/[<>:"/\\|?*]/g, '_').trim() || 'Untitled_Scene'
                const safeNewName = name.replace(/[<>:"/\\|?*]/g, '_').trim() || 'Untitled_Scene'
                const safePresetSegments = getScenePresetPathSegments(state.presets, presetId)
                    .map(segment => segment.replace(/[<>:"/\\|?*]/g, '_').trim() || 'Default')
                
                // B's rename behavior intentionally covers only the direct
                // preset/scene folder in this phase. Rotation character
                // subfolders are left untouched to avoid cross-character
                // collisions until a dedicated migration pass owns that scan.
                try {
                    const { sceneSavePath, useAbsoluteScenePath } = storage
                    let oldFolderPath: string
                    let newFolderPath: string
                    
                    if (shouldUseAbsoluteMediaPath(useAbsoluteScenePath) && sceneSavePath) {
                        oldFolderPath = await joinNativePath(sceneSavePath, ...safePresetSegments, safeOldName)
                        newFolderPath = await joinNativePath(sceneSavePath, ...safePresetSegments, safeNewName)
                    } else {
                        const baseDir = await getMediaStorageRoot()
                        const sceneRoot = (sceneSavePath || 'NAI_Blue_Scene').replace(/[<>:"/\\|?*]/g, '_').trim() || 'NAI_Blue_Scene'
                        oldFolderPath = await joinNativePath(baseDir, sceneRoot, ...safePresetSegments, safeOldName)
                        newFolderPath = await joinNativePath(baseDir, sceneRoot, ...safePresetSegments, safeNewName)
                    }
                    
                    if (await exists(oldFolderPath) && !(await exists(newFolderPath))) {
                        await rename(oldFolderPath, newFolderPath)
                        set(state => ({
                            presets: state.presets.map(p =>
                                p.id === presetId
                                    ? {
                                        ...p,
                                        scenes: p.scenes.map(s =>
                                            s.id === sceneId 
                                                ? { 
                                                    ...s, 
                                                    name,
                                                    images: s.images.map(img => ({
                                                        ...img,
                                                        url: img.url.replace(oldFolderPath, newFolderPath)
                                                    }))
                                                } 
                                                : s
                                        ),
                                    }
                                    : p
                            ),
                        }))
                        return
                    }
                } catch (e) {
                    console.warn('Failed to rename scene folder:', e)
                }
                
                // Fallback: just update the name without folder rename
                set(state => ({
                    presets: state.presets.map(p =>
                        p.id === presetId
                            ? {
                                ...p,
                                scenes: p.scenes.map(s =>
                                    s.id === sceneId ? { ...s, name } : s
                                ),
                            }
                            : p
                    ),
                }))
            },

            updateScenePrompt: (presetId, sceneId, prompt) => set((state) => ({
                presets: state.presets.map((preset) =>
                    preset.id === presetId
                        ? {
                            ...preset,
                            scenes: preset.scenes.map((scene) =>
                                scene.id === sceneId
                                    ? {
                                        ...scene,
                                        scenePrompt: prompt,
                                        prompts: { ...resolveScenePrompts(scene), additional: prompt },
                                    }
                                    : scene
                            ),
                        }
                        : preset
                ),
                sceneCompositionResults: withoutSceneCompositionResult(state.sceneCompositionResults, sceneId),
            })),
            updateScenePrompts: (presetId, sceneId, promptPatch) => set(state => ({
                presets: state.presets.map(preset => preset.id === presetId
                    ? {
                        ...preset,
                        scenes: preset.scenes.map(scene => {
                            if (scene.id !== sceneId) return scene
                            const prompts = { ...resolveScenePrompts(scene), ...promptPatch }
                            return {
                                ...scene,
                                prompts,
                                // Sync and older exports understand this field; generation no longer reads it directly.
                                scenePrompt: prompts.additional,
                            }
                        }),
                    }
                    : preset),
                sceneCompositionResults: withoutSceneCompositionResult(state.sceneCompositionResults, sceneId),
            })),
            updateSceneCharacterCaptions: (presetId, sceneId, nextCaptions, positionEnabled) => set(state => ({
                presets: state.presets.map(preset => preset.id === presetId
                    ? {
                        ...preset,
                        scenes: preset.scenes.map(scene => {
                            if (scene.id !== sceneId) return scene
                            const characterCaptions = cloneSceneCharacterCaptions(nextCaptions) ?? []
                            const legacyCaption = characterCaptions.find(caption => caption.enabled)
                            return {
                                ...scene,
                                characterCaptions,
                                ...(positionEnabled === undefined
                                    ? {}
                                    : { characterPositionEnabled: positionEnabled }),
                                // Scalar aliases keep old exports readable; generation uses the array above.
                                prompts: {
                                    ...resolveScenePrompts(scene),
                                    character: legacyCaption?.prompt ?? '',
                                    characterNegative: legacyCaption?.negative ?? '',
                                },
                            }
                        }),
                    }
                    : preset),
                sceneCompositionResults: withoutSceneCompositionResult(state.sceneCompositionResults, sceneId),
            })),
            updateSceneSettings: (presetId, sceneId, settings) => set((state) => ({
                presets: state.presets.map((preset) =>
                    preset.id === presetId
                        ? {
                            ...preset,
                            scenes: preset.scenes.map((scene) =>
                                scene.id === sceneId ? { ...scene, ...settings } : scene
                            ),
                        }
                        : preset
                ),
                sceneCompositionResults: withoutSceneCompositionResult(state.sceneCompositionResults, sceneId),
            })),
            updateSceneGeneration: (presetId, sceneId, generationPatch) => set(state => ({
                presets: state.presets.map(preset => preset.id === presetId
                    ? {
                        ...preset,
                        scenes: preset.scenes.map(scene => scene.id === sceneId
                            ? { ...scene, generation: { ...resolveSceneGeneration(scene), ...generationPatch } }
                            : scene),
                    }
                    : preset),
                sceneCompositionResults: withoutSceneCompositionResult(state.sceneCompositionResults, sceneId),
            })),
            consumeSceneGenerationSeed: (presetId, sceneId) => {
                let consumedSeed: number | null = null
                set(state => {
                    const preset = state.presets.find(candidate => candidate.id === presetId)
                    const scene = preset?.scenes.find(candidate => candidate.id === sceneId)
                    if (scene === undefined) return state

                    const generation = resolveSceneGeneration(scene)
                    consumedSeed = generation.seed || generateRandomSeed()
                    const nextSeed = generation.seedLocked ? consumedSeed : generateRandomSeed()
                    if (generation.seed === nextSeed) return state

                    return {
                        presets: state.presets.map(candidate => candidate.id === presetId
                            ? {
                                ...candidate,
                                scenes: candidate.scenes.map(item => item.id === sceneId
                                    ? {
                                        ...item,
                                        generation: { ...generation, seed: nextSeed },
                                    }
                                    : item),
                            }
                            : candidate),
                        sceneCompositionResults: withoutSceneCompositionResult(state.sceneCompositionResults, sceneId),
                    }
                })
                return consumedSeed ?? generateRandomSeed()
            },
            setSceneFilenameTemplate: (presetId, sceneId, filenameTemplate) => set(state => ({
                presets: state.presets.map(preset => preset.id === presetId
                    ? {
                        ...preset,
                        scenes: preset.scenes.map(scene => scene.id === sceneId
                            ? { ...scene, filenameTemplate: sanitizeFilenameTemplateInput(filenameTemplate) }
                            : scene),
                    }
                    : preset),
            })),
            setQueuedImageFileNames: (presetId, sceneId, fileNames) => set(state => ({
                presets: state.presets.map(preset => preset.id === presetId
                    ? {
                        ...preset,
                        scenes: preset.scenes.map(scene => scene.id === sceneId
                            ? {
                                ...scene,
                                queuedFileNames: normalizeQueuedFileNames(fileNames, scene.queueCount),
                            }
                            : scene),
                    }
                    : preset),
            })),
            setSceneCompositionRef: (presetId, sceneId, compositionRef) => set(state => ({
                presets: state.presets.map(preset => preset.id === presetId
                    ? {
                        ...preset,
                        scenes: preset.scenes.map(scene => scene.id === sceneId
                            ? {
                                ...scene,
                                ...(compositionRef === undefined ? { compositionRef: undefined } : { compositionRef }),
                            }
                            : scene),
                    }
                    : preset),
                sceneCompositionResults: withoutSceneCompositionResult(state.sceneCompositionResults, sceneId),
            })),
            resetSceneToRecipe: (presetId, sceneId) => set(state => ({
                presets: state.presets.map(preset => preset.id === presetId
                    ? {
                        ...preset,
                        scenes: preset.scenes.map(scene => {
                            if (scene.id !== sceneId) return scene
                            const { width: _width, height: _height, ...rest } = scene
                            const ref = scene.compositionRef
                            return {
                                ...rest,
                                scenePrompt: '',
                                ...(ref === undefined
                                    ? {}
                                    : {
                                        compositionRef: {
                                            recipeId: ref.recipeId,
                                            ...(ref.selectionKind === undefined ? {} : { selectionKind: ref.selectionKind }),
                                            ...(ref.recipeRevision === undefined ? {} : { recipeRevision: ref.recipeRevision }),
                                            ...(ref.migrationMarker === undefined ? {} : { migrationMarker: ref.migrationMarker }),
                                            ...(ref.extensions === undefined ? {} : { extensions: ref.extensions }),
                                        },
                                    }),
                            }
                        }),
                    }
                    : preset),
                sceneCompositionResults: withoutSceneCompositionResult(state.sceneCompositionResults, sceneId),
            })),
            updateAllScenesResolution: (presetId, width, height) => set((state) => ({
                presets: state.presets.map((preset) =>
                    preset.id === presetId
                        ? {
                            ...preset,
                            scenes: preset.scenes.map((scene) => ({
                                ...scene,
                                width,
                                height
                            })),
                        }
                        : preset
                ),
                sceneCompositionResults: withoutSceneCompositionResults(
                    state.sceneCompositionResults,
                    state.presets.find(preset => preset.id === presetId)?.scenes.map(scene => scene.id) ?? [],
                ),
            })),
            reorderScenes: (presetId, scenes) => {
                set(state => ({
                    presets: state.presets.map(p =>
                        p.id === presetId ? { ...p, scenes } : p
                    ),
                }))
            },

            getScene: (presetId, sceneId) => {
                const preset = get().presets.find(p => p.id === presetId)
                return preset?.scenes.find(s => s.id === sceneId)
            },

            // Queue Actions
            setQueueCount: (presetId, sceneId, count) => {
                const nextCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
                set(state => ({
                    presets: state.presets.map(p => p.id === presetId ? {
                        ...p,
                        scenes: p.scenes.map(scene => scene.id === sceneId ? {
                            ...scene, queueCount: nextCount,
                            queuedFileNames: normalizeQueuedFileNames(scene.queuedFileNames ?? [], nextCount),
                        } : scene),
                    } : p),
                }))
            },

            // Bulk editing visits each preset once and emits one persisted update, even for thousands of items.
            setSceneProductionCounts: (targets, count) => {
                if (!Number.isInteger(count) || count < 1 || count > 999) throw new RangeError('Production quantity must be 1–999')
                const byPreset = new Map<string, Set<string>>()
                for (const target of targets) {
                    const ids = byPreset.get(target.presetId) ?? new Set<string>()
                    ids.add(target.sceneId)
                    byPreset.set(target.presetId, ids)
                }
                if (byPreset.size === 0) return
                set(state => ({
                    presets: state.presets.map(p =>
                        byPreset.has(p.id)
                            ? {
                                ...p,
                                scenes: p.scenes.map(s =>
                                    byPreset.get(p.id)!.has(s.id)
                                        ? {
                                            ...s,
                                            productionCount: count,
                                        }
                                        : s
                                ),
                            }
                            : p
                    ),
                }))
            },

            incrementQueue: (presetId, sceneId, count = 1) => {
                const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
                if (safeCount === 0) return

                set(state => ({
                    presets: state.presets.map(p =>
                        p.id === presetId
                            ? {
                                ...p,
                                scenes: p.scenes.map(s =>
                                    s.id === sceneId ? { ...s, queueCount: s.queueCount + safeCount } : s
                                ),
                            }
                            : p
                    ),
                }))
            },

            decrementQueue: (presetId, sceneId) => {
                const preset = get().presets.find(p => p.id === presetId)
                const scene = preset?.scenes.find(s => s.id === sceneId)
                if (scene && scene.queueCount > 0) {
                    get().setQueueCount(presetId, sceneId, scene.queueCount - 1)
                }
            },

            addAllToQueue: (presetId, count = 1) => {
                const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
                if (safeCount === 0) return
                set(state => ({
                    presets: state.presets.map(p =>
                        p.id === presetId
                            ? {
                                ...p,
                                scenes: p.scenes.map(s => ({ ...s, queueCount: s.queueCount + safeCount })),
                            }
                            : p
                    ),
                }))
            },

            clearAllQueue: (presetId) => {
                set(state => ({
                    presets: state.presets.map(p =>
                        p.id === presetId
                            ? {
                                ...p,
                                scenes: p.scenes.map(s => ({ ...s, queueCount: 0, queuedFileNames: undefined })),
                            }
                            : p
                    ),
                }))
            },

            consumeSceneQueueEntries: (presetId, sceneId, count) => {
                const consumedCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
                if (consumedCount === 0) return
                set(state => ({
                    presets: state.presets.map(preset => preset.id === presetId
                        ? {
                            ...preset,
                            scenes: preset.scenes.map(scene => {
                                if (scene.id !== sceneId) return scene
                                const nextCount = Math.max(0, scene.queueCount - consumedCount)
                                return {
                                    ...scene,
                                    queueCount: nextCount,
                                    queuedFileNames: normalizeQueuedFileNames(
                                        (scene.queuedFileNames ?? []).slice(consumedCount),
                                        nextCount,
                                    ),
                                }
                            }),
                        }
                        : preset),
                }))
            },

            getTotalQueueCount: (presetId) => {
                const preset = get().presets.find(p => p.id === presetId)
                return preset?.scenes.reduce((sum, s) => sum + s.queueCount, 0) || 0
            },

            getQueuedScenes: (presetId) => {
                const preset = get().presets.find(p => p.id === presetId)
                return preset?.scenes.filter(s => s.queueCount > 0) || []
            },

            // Image Actions
            addImageToScene: (presetId, sceneId, imageUrl, imageId, isFavorite = false) => {
                const timestamp = Date.now()
                const newImage: SceneImage = {
                    id: imageId ?? createSceneEntityId(),
                    url: imageUrl,
                    timestamp,
                    isFavorite,
                }
                
                // MEMORY OPTIMIZATION: Increased limit for heavy users (was 100)
                const MAX_IMAGES_PER_SCENE = 2000
                const presentationKey = sceneImagePresentationKey(presetId, sceneId, newImage.id)
                
                set(state => ({
                    presets: state.presets.map(p =>
                        p.id === presetId
                            ? {
                                ...p,
                                scenes: p.scenes.map(s => {
                                    if (s.id !== sceneId) return s
                                    
                                    // Add new image at the beginning (newest first)
                                    let updatedImages = [newImage, ...s.images.filter(image => image.id !== newImage.id)]
                                    
                                    // If over limit, remove oldest non-favorites
                                    if (updatedImages.length > MAX_IMAGES_PER_SCENE) {
                                        // Sort by timestamp descending to keep newest
                                        // Favorites are preserved separately
                                        const favorites = updatedImages.filter(img => img.isFavorite)
                                        const nonFavorites = updatedImages
                                            .filter(img => !img.isFavorite)
                                            .sort((a, b) => b.timestamp - a.timestamp)
                                        
                                        // Keep all favorites + newest non-favorites up to limit
                                        const keepCount = Math.max(0, MAX_IMAGES_PER_SCENE - favorites.length)
                                        // Merge back and sort by timestamp to maintain display order
                                        updatedImages = [...favorites, ...nonFavorites.slice(0, keepCount)]
                                            .sort((a, b) => b.timestamp - a.timestamp)
                                        
                                        console.warn(`[SceneStore] Scene ${s.name}: Trimmed to ${updatedImages.length} images (limit: ${MAX_IMAGES_PER_SCENE})`)
                                    }
                                    
                                    return { ...s, images: updatedImages }
                                }),
                            }
                            : p
                    ),
                    legacyImagePresentation: withoutImagePresentation(
                        state.legacyImagePresentation,
                        presentationKey,
                    ),
                }))
                // NOTE: Removed triggerHistoryRefresh() here.
                // HistoryPanel now uses the transient artifact lifecycle store,
                // so triggering a full directory rescan per image is no longer needed.
            },

            toggleFavorite: (presetId, sceneId, imageId) => {
                set(state => {
                    const scene = state.presets.find(preset => preset.id === presetId)
                        ?.scenes.find(candidate => candidate.id === sceneId)
                    const image = scene?.images.find(candidate => candidate.id === imageId)
                    const isArtifact = scene?.artifactRefs?.some(reference => reference.artifactId === imageId) === true
                    const key = sceneImagePresentationKey(presetId, sceneId, imageId)
                    return {
                    presets: state.presets.map(p =>
                        p.id === presetId
                            ? {
                                ...p,
                                scenes: p.scenes.map(s =>
                                    s.id === sceneId
                                        ? {
                                            ...s,
                                            images: s.images.map(img =>
                                                img.id === imageId
                                                    ? { ...img, isFavorite: !img.isFavorite }
                                                    : img
                                            ),
                                        }
                                        : s
                                ),
                            }
                            : p
                    ),
                    ...(!isArtifact && image !== undefined
                        ? {
                            legacyImagePresentation: {
                                ...state.legacyImagePresentation,
                                [key]: {
                                    ...state.legacyImagePresentation[key],
                                    favorite: !image.isFavorite,
                                },
                            },
                        }
                        : {}),
                }})
            },

            deleteImage: (presetId, sceneId, imageId) => {
                set(state => {
                    const scene = state.presets.find(preset => preset.id === presetId)
                        ?.scenes.find(candidate => candidate.id === sceneId)
                    const key = sceneImagePresentationKey(presetId, sceneId, imageId)
                    return {
                    presets: state.presets.map(p =>
                        p.id === presetId
                            ? {
                                ...p,
                                scenes: p.scenes.map(s =>
                                    s.id === sceneId
                                        ? { ...s, images: s.images.filter(img => img.id !== imageId) }
                                        : s
                                ),
                            }
                            : p
                    ),
                    ...(scene?.images.some(image => image.id === imageId)
                        ? {
                            legacyImagePresentation: {
                                ...state.legacyImagePresentation,
                                [key]: { deleted: true },
                            },
                        }
                        : {}),
                }})
            },

            deleteNonFavoriteImages: (presetId, sceneId) => {
                const preset = get().presets.find(p => p.id === presetId)
                const scene = preset?.scenes.find(s => s.id === sceneId)
                if (!scene) return { count: 0, paths: [] }
                
                const nonFavorites = scene.images.filter(img => !img.isFavorite)
                const nonFavoriteCount = nonFavorites.length
                // Collect file paths (non-base64 URLs) for deletion
                const filePaths = nonFavorites
                    .map(img => img.url)
                    .filter(url => !url.startsWith('data:'))
                const legacyTombstones = Object.fromEntries(nonFavorites
                    .map(image => [sceneImagePresentationKey(presetId, sceneId, image.id), { deleted: true as const }]))
                
                set(state => ({
                    presets: state.presets.map(p =>
                        p.id === presetId
                            ? {
                                ...p,
                                scenes: p.scenes.map(s =>
                                    s.id === sceneId
                                        ? { ...s, images: s.images.filter(img => img.isFavorite) }
                                        : s
                                ),
                            }
                            : p
                    ),
                    legacyImagePresentation: {
                        ...state.legacyImagePresentation,
                        ...legacyTombstones,
                    },
                }))
                
                return { count: nonFavoriteCount, paths: filePaths }
            },

            clearAllFavorites: (presetId, sceneId) => {
                const preset = get().presets.find(p => p.id === presetId)
                const scene = preset?.scenes.find(s => s.id === sceneId)
                if (!scene) return 0
                
                const favoriteCount = scene.images.filter(img => img.isFavorite).length
                const artifactIds = new Set(scene.artifactRefs?.map(reference => reference.artifactId) ?? [])
                const legacyFavorites = Object.fromEntries(scene.images
                    .filter(image => image.isFavorite && !artifactIds.has(image.id))
                    .map(image => [sceneImagePresentationKey(presetId, sceneId, image.id), { favorite: false }]))
                
                set(state => ({
                    presets: state.presets.map(p =>
                        p.id === presetId
                            ? {
                                ...p,
                                scenes: p.scenes.map(s =>
                                    s.id === sceneId
                                        ? {
                                            ...s,
                                            images: s.images.map(img => ({ ...img, isFavorite: false })),
                                        }
                                        : s
                                ),
                            }
                            : p
                    ),
                    legacyImagePresentation: {
                        ...state.legacyImagePresentation,
                        ...legacyFavorites,
                    },
                }))
                
                return favoriteCount
            },

            deleteAllImages: (presetId, sceneId) => {
                const preset = get().presets.find(p => p.id === presetId)
                const scene = preset?.scenes.find(s => s.id === sceneId)
                if (!scene) return { count: 0, paths: [] }
                
                const totalCount = scene.images.length
                const filePaths = scene.images
                    .map(img => img.url)
                    .filter(url => !url.startsWith('data:'))
                const legacyTombstones = Object.fromEntries(scene.images
                    .map(image => [sceneImagePresentationKey(presetId, sceneId, image.id), { deleted: true as const }]))
                
                set(state => ({
                    presets: state.presets.map(p =>
                        p.id === presetId
                            ? {
                                ...p,
                                scenes: p.scenes.map(s =>
                                    s.id === sceneId
                                        ? { ...s, images: [] }
                                        : s
                                ),
                            }
                            : p
                    ),
                    legacyImagePresentation: {
                        ...state.legacyImagePresentation,
                        ...legacyTombstones,
                    },
                }))
                
                return { count: totalCount, paths: filePaths }
            },

            getSceneThumbnail: (scene) => {
                // Priority: favorite > newest
                const favorite = scene.images.find(img => img.isFavorite)
                if (favorite) return favorite.url
                if (scene.images.length > 0) return scene.images[0].url
                return undefined
            },

            // Generation Actions
            decrementFirstQueuedScene: (presetId) => {
                let claim: SceneQueueClaim | null = null
                set(state => {
                    const preset = state.presets.find(candidate => candidate.id === presetId)
                    const queuedScene = preset?.scenes.find(scene => scene.queueCount > 0)
                    if (queuedScene === undefined) return state

                    const filenameTemplate = normalizeFilenameTemplate(queuedScene.queuedFileNames?.[0])
                        ?? normalizeFilenameTemplate(queuedScene.filenameTemplate)
                    claim = {
                        scene: queuedScene,
                        ...(filenameTemplate === undefined ? {} : { filenameTemplate }),
                    }
                    const nextCount = queuedScene.queueCount - 1
                    return {
                        presets: state.presets.map(candidate => candidate.id === presetId
                            ? {
                                ...candidate,
                                scenes: candidate.scenes.map(scene => scene.id === queuedScene.id
                                    ? {
                                        ...scene,
                                        queueCount: nextCount,
                                        queuedFileNames: normalizeQueuedFileNames(
                                            (scene.queuedFileNames ?? []).slice(1),
                                            nextCount,
                                        ),
                                    }
                                    : scene),
                            }
                            : candidate),
                    }
                })
                return claim
            },
            requeueSceneGeneration: (presetId, sceneId, filenameTemplate) => set(state => ({
                presets: state.presets.map(preset => preset.id === presetId
                    ? {
                        ...preset,
                        scenes: preset.scenes.map(scene => {
                            if (scene.id !== sceneId) return scene
                            const existing = Array.from({ length: scene.queueCount }, (_, index) => (
                                scene.queuedFileNames?.[index] ?? ''
                            ))
                            return {
                                ...scene,
                                queueCount: scene.queueCount + 1,
                                queuedFileNames: normalizeQueuedFileNames([
                                    normalizeFilenameTemplate(filenameTemplate) ?? '',
                                    ...existing,
                                ], scene.queueCount + 1),
                            }
                        }),
                    }
                    : preset),
            })),

            isGenerating: false,
            isCancelling: false,
            setIsGenerating: (isGenerating) => {
                // When stopping generation, increment session ID to invalidate any in-progress operations
                if (!isGenerating) {
                    set(state => ({
                        isGenerating: false,
                        isCancelling: false,
                        generationSessionId: nextSceneGenerationSessionId(state.generationSessionId),
                    }))
                } else {
                    set({ isGenerating: true, isCancelling: false })
                }
            },
            cancelSceneGeneration: () => {
                const cancelledSessionId = get().generationSessionId
                set(state => ({
                    isCancelling: true,
                    generationSessionId: nextSceneGenerationSessionId(state.generationSessionId),
                }))
                abortSceneSessionRequests(cancelledSessionId)
            },
            generationSessionId: 0,
            startNewGenerationSession: () => {
                const newSessionId = nextSceneGenerationSessionId(get().generationSessionId)
                set({
                    generationSessionId: newSessionId,
                    isGenerating: true,
                    isCancelling: false,
                    sceneCompositionResults: {},
                })
                return newSessionId
            },

            streamingSceneId: null,
            streamingImage: null,
            streamingProgress: 0,
            setStreamingData: (sceneId, image, progress) => {
                const currentSceneId = get().streamingSceneId
                // If sceneId changed, reset image to prevent showing previous scene's image
                if (sceneId !== currentSceneId) {
                    set({
                        streamingSceneId: sceneId,
                        streamingImage: image,
                        streamingProgress: progress
                    })
                } else {
                    // Same scene - if image is null, keep existing (progress-only update)
                    set({
                        streamingSceneId: sceneId,
                        streamingImage: image ?? get().streamingImage,
                        streamingProgress: progress
                    })
                }
            },

            // Memory cleanup - release streaming data when leaving scene mode
            // This prevents OOM when switching between modes (Issue #6)
            clearRuntimeData: () => {
                console.log('[SceneStore] Clearing runtime data to free memory')
                set({
                    streamingSceneId: null,
                    streamingImage: null,
                    streamingProgress: 0
                })
            },

            // History Refresh Trigger
            historyRefreshTrigger: 0,
            triggerHistoryRefresh: () => set(state => ({ historyRefreshTrigger: state.historyRefreshTrigger + 1 })),

            // File Management Actions
            importPreset: (jsonContent: any) => {
                set(state => {
                    let newName = "Imported Preset"
                    let newScenes: SceneCard[] = []

                    // 1. Detect Format

                    // Case A: Legacy Array Format (scene_preset_export.json)
                    if (Array.isArray(jsonContent)) {
                        newName = `Legacy Import ${new Date().toLocaleDateString()}`
                        newScenes = jsonContent.map((item: any) => ({
                            id: crypto.randomUUID(),
                            name: item.scene_name || "Untitled Scene",
                            scenePrompt: item.scene_prompt || "",
                            queueCount: 0,
                            images: [], // Legacy images not imported automatically
                            excludePinned: Boolean(item.excludePinned),
                            createdAt: Date.now()
                        }))
                    }
                    // Case B: Interaction Share Format (상호작용공유용.json) - New Logic
                    else if (jsonContent.scenes && !Array.isArray(jsonContent.scenes) && typeof jsonContent.scenes === 'object') {
                        newName = jsonContent.name || "Interaction Share"
                        const sceneMap = jsonContent.scenes

                        // Helper to generate prompt combinations
                        const generatePrompts = (slots: any[][]): string[] => {
                            if (slots.length === 0) return [""]

                            const firstSlot = slots[0] || []
                            // enabled 필드가 없으면 기본적으로 활성화된 것으로 간주
                            const enabledItems = firstSlot.filter((item: any) => item.enabled !== false)
                            const remainingPrompts = generatePrompts(slots.slice(1))

                            if (enabledItems.length === 0) return remainingPrompts

                            const results: string[] = []
                            for (const item of enabledItems) {
                                for (const nextPrompt of remainingPrompts) {
                                    const current = item.prompt || ""
                                    // simple join
                                    const combined = nextPrompt ? `${current}, ${nextPrompt}` : current
                                    results.push(combined)
                                }
                            }
                            return results
                        }

                        Object.values(sceneMap).forEach((sceneData: any) => {
                            if (sceneData.slots && Array.isArray(sceneData.slots)) {
                                const combinations = generatePrompts(sceneData.slots)
                                combinations.forEach((fullPrompt, index) => {
                                    // If there are multiple variations, append index to name
                                    const suffix = combinations.length > 1 ? `_${index + 1}` : ""

                                    newScenes.push({
                                        id: crypto.randomUUID(),
                                        name: (sceneData.name || "Untitled") + suffix,
                                        scenePrompt: fullPrompt,
                                        queueCount: 0,
                                        images: [],
                                        excludePinned: Boolean(sceneData.excludePinned),
                                        createdAt: Date.now()
                                    })
                                })
                            }
                        })
                    }
                    // Case C: SDImageGenEasy Presets (Fallback if 'scenes' object missing but has presets)
                    else if (jsonContent.presets && jsonContent.presets.SDImageGenEasy) {
                        // ... (Existing logic for SDImageGenEasy if needed, or remove if B covers it)
                        // Keeping it as fallback for files that might only have presets
                        newName = jsonContent.name || "Interaction Share (Presets)"
                        const presets = jsonContent.presets.SDImageGenEasy
                        if (Array.isArray(presets)) {
                            newScenes = presets.map((item: any) => {
                                const promptParts = []
                                if (item.frontPrompt) promptParts.push(item.frontPrompt)
                                if (item.backPrompt) promptParts.push(item.backPrompt)
                                return {
                                    id: crypto.randomUUID(),
                                    name: item.name || "Untitled",
                                    scenePrompt: promptParts.join(", "),
                                    queueCount: 0,
                                    images: [],
                                    excludePinned: Boolean(item.excludePinned),
                                    createdAt: Date.now()
                                }
                            })
                        }
                    }
                    // Case D: Standard ScenePreset Format (NAI Blue)
                    else if (jsonContent.scenes && Array.isArray(jsonContent.scenes)) {
                        newName = jsonContent.name || "Use Preset"
                        newScenes = jsonContent.scenes.map((s: any) => ({
                            ...s,
                            id: s.id || crypto.randomUUID(), // Ensure ID exists
                            images: s.images || [],
                            prompts: s.prompts ? { ...s.prompts } : undefined,
                            characterCaptions: Array.isArray(s.characterCaptions)
                                ? cloneSceneCharacterCaptions(s.characterCaptions)
                                : undefined,
                            generation: s.generation ? { ...s.generation } : undefined,
                            compositionRef: s.compositionRef ? structuredClone(s.compositionRef) : undefined,
                            excludePinned: Boolean(s.excludePinned)
                        }))
                        // If importing a full preset object, try to preserve its ID if unique, otherwise gen new
                        if (jsonContent.id && !state.presets.some(p => p.id === jsonContent.id)) {
                            // ID is unique, use it? No, safer to always generate new ID for imported stuff to avoid conflicts later
                        }
                    } else {
                        console.error("Unknown preset format", jsonContent)
                        return state // No change
                    }

                    if (newScenes.length === 0) {
                        console.warn("No scenes found in import")
                        return state
                    }

                    // Create the new preset
                    const newPreset: ScenePreset = {
                        id: createSceneEntityId(),
                        name: newName,
                        scenes: newScenes,
                        createdAt: Date.now()
                    }

                    // Check for name collision
                    let nameSuffix = 1
                    while (state.presets.some(p => p.name === newPreset.name)) {
                        newPreset.name = `${newName} (${nameSuffix++})`
                    }

                    return {
                        presets: [...state.presets, newPreset],
                        activePresetId: newPreset.id // Switch to imported preset
                    }
                })
            },

            exportPreset: () => {
                // Implementation moved to UI component (SceneMode.tsx) for file saving
            },

            validateSceneImages: (presetId, sceneId, validImageIds) => {
                set(state => ({
                    presets: state.presets.map(p =>
                        p.id === presetId
                            ? {
                                ...p,
                                scenes: p.scenes.map(s =>
                                    s.id === sceneId
                                        ? { ...s, images: s.images.filter(img => validImageIds.includes(img.id)) }
                                        : s
                                )
                            }
                            : p
                    )
                }))
            },

            // Multi-Select / Edit Mode Implementation
            isEditMode: false,
            selectedSceneIds: [],
            lastSelectedSceneId: null,

            setEditMode: (isEdit) => set({
                isEditMode: isEdit,
                selectedSceneIds: isEdit ? [] : [],
                lastSelectedSceneId: null
            }),

            toggleSceneSelection: (sceneId, clearOthers = true) => set(state => {
                const isSelected = state.selectedSceneIds.includes(sceneId)
                let newSelection: string[]

                if (clearOthers) {
                    // Single click - toggle single selection
                    newSelection = isSelected ? [] : [sceneId]
                } else {
                    // Ctrl+click - toggle in multi-select
                    newSelection = isSelected
                        ? state.selectedSceneIds.filter(id => id !== sceneId)
                        : [...state.selectedSceneIds, sceneId]
                }

                return {
                    selectedSceneIds: newSelection,
                    lastSelectedSceneId: sceneId
                }
            }),

            selectSceneRange: (fromId, toId) => set(state => {
                const preset = state.presets.find(p => p.id === state.activePresetId)
                if (!preset) return state

                const fromIndex = preset.scenes.findIndex(s => s.id === fromId)
                const toIndex = preset.scenes.findIndex(s => s.id === toId)

                if (fromIndex === -1 || toIndex === -1) return state

                const start = Math.min(fromIndex, toIndex)
                const end = Math.max(fromIndex, toIndex)

                const rangeIds = preset.scenes.slice(start, end + 1).map(s => s.id)

                // Merge with existing selection
                const newSelection = [...new Set([...state.selectedSceneIds, ...rangeIds])]

                return {
                    selectedSceneIds: newSelection,
                    lastSelectedSceneId: toId
                }
            }),

            selectAllScenes: () => set(state => {
                const preset = state.presets.find(p => p.id === state.activePresetId)
                if (!preset) return state
                return { selectedSceneIds: preset.scenes.map(s => s.id) }
            }),

            clearSelection: () => set({ selectedSceneIds: [], lastSelectedSceneId: null }),

            setLastSelectedSceneId: (id) => set({ lastSelectedSceneId: id }),

            deleteSelectedScenes: () => set(state => {
                const preset = state.presets.find(p => p.id === state.activePresetId)
                if (!preset) return state

                return {
                    presets: state.presets.map(p =>
                        p.id === state.activePresetId
                            ? { ...p, scenes: p.scenes.filter(s => !state.selectedSceneIds.includes(s.id)) }
                            : p
                    ),
                    selectedSceneIds: [],
                    lastSelectedSceneId: null,
                    sceneCompositionResults: withoutSceneCompositionResults(
                        state.sceneCompositionResults,
                        state.selectedSceneIds,
                    ),
                }
            }),

            moveSelectedScenesToPreset: (targetPresetId) => set(state => {
                const sourcePreset = state.presets.find(p => p.id === state.activePresetId)
                if (!sourcePreset || targetPresetId === state.activePresetId) return state

                const scenesToMove = sourcePreset.scenes.filter(s => state.selectedSceneIds.includes(s.id))
                if (scenesToMove.length === 0) return state

                return {
                    presets: state.presets.map(p => {
                        if (p.id === state.activePresetId) {
                            // Remove from source
                            return { ...p, scenes: p.scenes.filter(s => !state.selectedSceneIds.includes(s.id)) }
                        }
                        if (p.id === targetPresetId) {
                            // Add to target
                            return { ...p, scenes: [...p.scenes, ...scenesToMove] }
                        }
                        return p
                    }),
                    selectedSceneIds: [],
                    lastSelectedSceneId: null
                }
            }),

            updateSelectedScenesResolution: (width, height) => set(state => ({
                presets: state.presets.map(p =>
                    p.id === state.activePresetId
                        ? {
                            ...p,
                            scenes: p.scenes.map(s =>
                                state.selectedSceneIds.includes(s.id)
                                    ? { ...s, width, height }
                                    : s
                            )
                        }
                        : p
                ),
                sceneCompositionResults: withoutSceneCompositionResults(
                    state.sceneCompositionResults,
                    state.selectedSceneIds,
                ),
            })),

            applyRecipeToSelectedScenes: (recipeId, recipeRevision, selectionKind = 'asset') => set(state => {
                if (!state.activePresetId || state.selectedSceneIds.length === 0) return state
                const selected = new Set(state.selectedSceneIds)
                return {
                    presets: state.presets.map(preset => preset.id === state.activePresetId
                        ? {
                            ...preset,
                            scenes: preset.scenes.map(scene => selected.has(scene.id)
                                ? {
                                    ...scene,
                                    compositionRef: {
                                        ...scene.compositionRef,
                                        recipeId,
                                        recipeRevision,
                                        selectionKind,
                                        migrationMarker: scene.compositionRef?.migrationMarker ?? {
                                            kind: 'legacy-scene-prompt' as const,
                                            schemaVersion: 2 as const,
                                        },
                                    },
                                }
                                : scene),
                        }
                        : preset),
                    sceneCompositionResults: withoutSceneCompositionResults(
                        state.sceneCompositionResults,
                        state.selectedSceneIds,
                    ),
                }
            }),

            // Generation Progress Implementation
            completedCount: 0,
            totalQueuedCount: 0,

            setGenerationProgress: (completed, total) => set({
                completedCount: completed,
                totalQueuedCount: total
            }),

            initGenerationProgress: () => set(state => {
                const total = state.activePresetId ? state.presets.find(p => p.id === state.activePresetId)?.scenes.reduce((sum, s) => sum + s.queueCount, 0) || 0 : 0
                return {
                    completedCount: 0,
                    totalQueuedCount: total
                }
            }),

            // Grid Layout
            gridColumns: 4,
            setGridColumns: (columns) => set({ gridColumns: columns }),
            thumbnailLayout: 'vertical' as const,
            setThumbnailLayout: (layout) => set({ thumbnailLayout: layout }),

            // Scroll Position
            scrollPosition: 0,
            setScrollPosition: (position) => set({ scrollPosition: position }),
        }),
        {
            name: 'nai-blue-scene-presentation',
            storage: createJSONStorage(() => indexedDBStorage),
            partialize: projectScenePresentationState,
            onRehydrateStorage: () => (state, error) => {
                if (error) {
                    console.error('[SceneStore] Hydration failed:', error)
                    return
                }
                
                if (state) {
                    if (!['legacy', 'shadow', 'v2'].includes(state.sceneCompositionMode)) {
                        state.sceneCompositionMode = 'v2'
                    }
                    state.sceneCompositionResults = {}
                    // 복원 로그
                    const presetCount = state.presets?.length || 0
                    const totalScenes = state.presets?.reduce((sum, p) => sum + (p.scenes?.length || 0), 0) || 0
                    const totalImages = state.presets?.reduce((sum, p) => 
                        sum + p.scenes?.reduce((sSum, s) => sSum + (s.images?.length || 0), 0) || 0, 0) || 0
                    console.log(`[SceneStore] Hydrated: ${presetCount} presets, ${totalScenes} scenes, ${totalImages} images`)
                    
                    // MEMORY WARNING: Log if too many images
                    if (totalImages > 500) {
                        console.warn(`[SceneStore] Warning: ${totalImages} images loaded - consider clearing old images`)
                    }
                    
                    // 기본 프리셋 보장
                    if (!state.presets.find(p => p.id === DEFAULT_PRESET_ID)) {
                        console.log('[SceneStore] Adding default preset')
                        state.presets = [createDefaultPreset(), ...state.presets]
                    }
                    if (!state.activePresetId) {
                        state.activePresetId = DEFAULT_PRESET_ID
                    }

                    // Migration for pre-rotation scene records.
                    for (const preset of state.presets) {
                        for (const scene of preset.scenes || []) {
                            if (typeof scene.excludePinned !== 'boolean') {
                                scene.excludePinned = false
                            }
                        }
                    }
                    
                    // One default preset with no scenes is the valid first-run state;
                    // only an actual hydration error should be reported as data loss.
                }
            },
        }
    )
)
