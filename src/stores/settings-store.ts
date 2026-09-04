import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { indexedDBStorage } from '@/lib/indexed-db'
import { DEFAULT_METADATA_MODE, type MetadataMode } from '@/lib/generation-metadata'
import {
    DEFAULT_GENERATION_FOLDER_ID,
    createDefaultGenerationFolder,
    generationFolderDescendantIds,
    isGenerationFolderName,
    normalizeGenerationFolderV1Projection,
    type GenerationFolder,
    type GenerationFolderDocument,
    type GenerationFolderV2,
    type GenerationFolderV1Projection,
} from '@/domain/generation-folders'
import {
    planGenerationFolderChanges,
    type GenerationFolderChange,
    type GenerationFolderPatch as GenerationFolderV2Patch,
} from '@/application/folder/plan-folder-changes'
import {
    GenerationFolderAuthorityRuntime,
    generationFolderRootProjection,
    projectGenerationFolderDocument,
    type ProjectedGenerationFolder,
} from '@/lib/generation-folder-authority-runtime'
import { normalizeR2Prefix } from '@/domain/r2/types'

export interface CustomResolution {
    id: string
    label: string
    width: number
    height: number
}

export interface GenerationFolderPatch {
    readonly name?: string
    readonly rootDirectory?: string | null
    readonly useAbsolutePath?: boolean
    readonly commonPrompt?: string
    readonly r2?: Partial<GenerationFolder['r2']>
}

interface AddGenerationFolderInput {
    readonly name: string
    readonly parentId?: string | null
    readonly rootDirectory?: string | null
    readonly useAbsolutePath?: boolean
}

export interface SettingsState {
    // Save settings
    savePath: string
    useAbsolutePath: boolean  // If true, savePath is absolute path; if false, relative to Pictures folder
    sceneSavePath: string
    useAbsoluteScenePath: boolean
    sceneSubfoldersEnabled: boolean
    styleLabSavePath: string
    useAbsoluteStyleLabPath: boolean
    toolsSavePath: string
    useAbsoluteToolsPath: boolean
    autoSave: boolean

    // Custom resolution presets
    customResolutions: CustomResolution[]

    // UI settings
    promptFontSize: number
    basePromptCollapsed: boolean  // 기본 프롬프트 접기 상태
    additionalPromptCollapsed: boolean  // 추가 프롬프트 접기 상태
    detailPromptCollapsed: boolean  // 세부 프롬프트 접기 상태
    negativePromptCollapsed: boolean  // 네거티브 프롬프트 접기 상태

    // Generation settings
    useStreaming: boolean  // Use streaming API for image generation
    generationDelay: number  // Delay between batch generations in ms (0-5000)

    // Gemini API settings
    geminiApiKey: string

    // Library settings
    libraryPath: string
    useAbsoluteLibraryPath: boolean

    // Image format setting
    imageFormat: 'png' | 'webp'
    metadataMode: MetadataMode
    productGuidanceVersion: number
    remoteImageProcessingConsentVersion: number

    // Output folders shared by Guided, Main, and Scene workflows.
    /** Compatibility projection only; GenerationFolderDocument is durable authority. */
    generationFolders: ProjectedGenerationFolder[]
    generationFolderDocument: GenerationFolderDocument | null
    activeGenerationFolderId: string

    // Actions
    setSavePath: (path: string, useAbsolute?: boolean) => Promise<void>
    setSceneSavePath: (path: string, useAbsolute?: boolean) => void
    setSceneSubfoldersEnabled: (enabled: boolean) => void
    setStyleLabSavePath: (path: string, useAbsolute?: boolean) => void
    setToolsSavePath: (path: string, useAbsolute?: boolean) => void
    setAutoSave: (autoSave: boolean) => void
    addCustomResolution: (resolution: Omit<CustomResolution, 'id'>) => void
    removeCustomResolution: (id: string) => void
    setPromptFontSize: (size: number) => void
    setBasePromptCollapsed: (collapsed: boolean) => void
    setAdditionalPromptCollapsed: (collapsed: boolean) => void
    setDetailPromptCollapsed: (collapsed: boolean) => void
    setNegativePromptCollapsed: (collapsed: boolean) => void
    setUseStreaming: (useStreaming: boolean) => void
    setGenerationDelay: (delay: number) => void
    setGeminiApiKey: (key: string) => void
    setLibraryPath: (path: string, useAbsolute?: boolean) => void
    setImageFormat: (format: 'png' | 'webp') => void
    setMetadataMode: (mode: MetadataMode) => void
    setProductGuidanceVersion: (version: number) => void
    setRemoteImageProcessingConsentVersion: (version: number) => void
    addGenerationFolder: (input: AddGenerationFolderInput) => Promise<string>
    updateGenerationFolder: (id: string, patch: GenerationFolderPatch) => Promise<void>
    saveGenerationFolder: (id: string, parentId: string | null, patch: GenerationFolderPatch) => Promise<void>
    moveGenerationFolders: (ids: string[], parentId: string | null) => Promise<void>
    deleteGenerationFolders: (ids: string[]) => Promise<void>
    copyGenerationFolderPrompt: (sourceId: string, targetIds: string[], prompt?: string) => Promise<void>
    setActiveGenerationFolder: (id: string) => void
}

function createGenerationFolderId(): string {
    return `generation-folder-${crypto.randomUUID()}`
}

let folderAuthority: GenerationFolderAuthorityRuntime | null = null

function folderDefaults(state: SettingsState) {
    return { directory: state.savePath, useAbsolutePath: state.useAbsolutePath }
}

function projectAuthorityDocument(document: GenerationFolderDocument): void {
    useSettingsStore.setState(state => {
        const root = generationFolderRootProjection(document)
        return {
            generationFolderDocument: document,
            generationFolders: projectGenerationFolderDocument(document, state.generationFolders),
            ...root,
            activeGenerationFolderId: document.folders.some(folder => folder.id === state.activeGenerationFolderId)
                ? state.activeGenerationFolderId
                : DEFAULT_GENERATION_FOLDER_ID,
        }
    })
}

/** Applies a repository-committed document to the UI compatibility projection. */
export function applyGenerationFolderDocumentProjection(document: GenerationFolderDocument): void {
    projectAuthorityDocument(document)
}

function projectLegacyFolderAuthority(projection: GenerationFolderV1Projection): void {
    useSettingsStore.setState({
        generationFolderDocument: null,
        generationFolders: projection.generationFolders.map(folder => structuredClone(folder)),
        savePath: projection.savePath,
        useAbsolutePath: projection.useAbsolutePath,
        activeGenerationFolderId: projection.activeGenerationFolderId,
    })
}

async function applyAuthorityChanges(
    state: SettingsState,
    changes: readonly GenerationFolderChange[],
): Promise<GenerationFolderDocument> {
    if (state.generationFolderDocument === null) throw new Error('Generation folder authority is not ready')
    const planned = planGenerationFolderChanges(state.generationFolderDocument, changes, folderDefaults(state))
    if (planned.status !== 'PLANNED') throw new TypeError(planned.reason)
    const {
        applyRuntimeGenerationFolderChanges,
        getRuntimeGenerationFolderDocument,
    } = await import('@/services/folder/apply-runtime-folder-changes')
    const result = await applyRuntimeGenerationFolderChanges({
        workspaceId: state.generationFolderDocument.workspaceId,
        expectedRevision: state.generationFolderDocument.revision,
        expectedPlanHash: planned.planHash,
        changes,
        defaults: folderDefaults(state),
    })
    if (result.status === 'COMMITTED') {
        projectAuthorityDocument(result.plan.document)
        return result.plan.document
    }
    const current = await getRuntimeGenerationFolderDocument(state.generationFolderDocument.workspaceId)
    if (current !== null) projectAuthorityDocument(current)
    const folderIds = result.status === 'AUTHORIZATION_FAILED'
        ? result.folderIds
        : result.status === 'UNSUPPORTED'
            ? result.occupancy.folderIds
            : []
    throw new Error(`Generation folder mutation failed: ${result.status}${folderIds.length ? ` (${folderIds.join(', ')})` : ''}`)
}

function v2Patch(
    state: SettingsState,
    id: string,
    parentId: string | null,
    patch: GenerationFolderPatch,
): GenerationFolderV2Patch {
    const current = state.generationFolderDocument?.folders.find(folder => folder.id === id)
    if (current === undefined) throw new TypeError('Generation folder does not exist')
    const displayName = patch.name?.trim() ?? current.displayName
    if (!isGenerationFolderName(displayName)) throw new TypeError('Generation folder name is invalid')
    const commonPrompt = patch.commonPrompt ?? current.commonPrompt
    if (commonPrompt.length > 20_000) throw new TypeError('Generation folder prompt is too long')
    const bucketInput = patch.r2?.bucket === undefined ? undefined : patch.r2.bucket?.trim() ?? ''
    const bucket = bucketInput === (current.r2BucketPolicy.mode === 'set' ? current.r2BucketPolicy.value : '')
        ? undefined
        : bucketInput
    const prefixInput = patch.r2?.prefix === undefined ? undefined : normalizeR2Prefix(patch.r2.prefix)
    const prefix = prefixInput === (current.r2PrefixPolicy.mode === 'set' ? current.r2PrefixPolicy.value : null)
        ? undefined
        : prefixInput
    return {
        folderId: id,
        displayName,
        parentId,
        rootDirectory: parentId === null
            ? patch.rootDirectory === undefined
                ? current.rootDirectory ?? current.pathSegment
                : patch.rootDirectory?.trim() || current.pathSegment
            : null,
        useAbsolutePath: parentId === null && (patch.useAbsolutePath ?? current.useAbsolutePath),
        commonPrompt,
        ...(patch.r2?.autoUpload === undefined ? {} : { autoUpload: patch.r2.autoUpload }),
        ...(bucket === undefined ? {} : {
            r2BucketPolicy: bucket === '' ? { mode: 'inherit' as const } : { mode: 'set' as const, value: bucket },
        }),
        ...(prefix === undefined ? {} : {
            r2PrefixPolicy: prefix === null ? { mode: 'inherit' as const } : { mode: 'set' as const, value: prefix },
        }),
    }
}

const SETTINGS_PERSIST_VERSION = 1

/**
 * Reconciles the legacy savePath authority with the shared folder model before
 * Zustand exposes hydrated settings. This preserves custom drives across app
 * updates and supplies new settings without overwriting explicit old values.
 */
export function normalizePersistedSettingsState(persistedState: unknown): Partial<SettingsState> {
    const persisted = typeof persistedState === 'object' && persistedState !== null && !Array.isArray(persistedState)
        ? persistedState as Partial<SettingsState>
        : {}
    const folderProjection = normalizeGenerationFolderV1Projection(persistedState)
    const activeGenerationFolderId = !Array.isArray((persisted as Record<string, unknown>).generationFolders)
        && typeof persisted.activeGenerationFolderId === 'string'
        ? persisted.activeGenerationFolderId
        : folderProjection.activeGenerationFolderId

    return {
        ...persisted,
        ...folderProjection,
        activeGenerationFolderId,
        sceneSubfoldersEnabled: typeof persisted.sceneSubfoldersEnabled === 'boolean'
            ? persisted.sceneSubfoldersEnabled
            : true,
    }
}

/** Keeps legacy presentation settings without writing Folder authority back to V1. */
export function partializePersistedSettingsState(state: SettingsState): Partial<SettingsState> {
    const {
        generationFolders: _generationFolders,
        generationFolderDocument: _generationFolderDocument,
        savePath: _savePath,
        useAbsolutePath: _useAbsolutePath,
        ...persisted
    } = state
    return persisted
}

export const useSettingsStore = create<SettingsState>()(
    persist(
        (set) => ({
            savePath: 'NAI_Blue_Output',
            useAbsolutePath: false,  // Default: relative to Pictures folder
            sceneSavePath: 'NAI_Blue_Scene',
            useAbsoluteScenePath: false,
            sceneSubfoldersEnabled: true,
            styleLabSavePath: 'nai-blue-style',
            useAbsoluteStyleLabPath: false,
            toolsSavePath: 'nai-blue-tools',
            useAbsoluteToolsPath: false,
            autoSave: true,
            customResolutions: [],
            promptFontSize: 16, // Default text-base equivalent approximately
            basePromptCollapsed: false, // Default: expanded
            additionalPromptCollapsed: false, // Default: expanded
            detailPromptCollapsed: false, // Default: expanded
            negativePromptCollapsed: false, // Default: expanded
            useStreaming: true, // Default: enabled
            generationDelay: 500, // Default: 500ms delay between batch generations
            geminiApiKey: '', // Default: empty
            libraryPath: 'NAI_Blue_Library', // Default: relative to Pictures folder
            useAbsoluteLibraryPath: false, // Default: relative to Pictures folder
            imageFormat: 'png', // Default: PNG format
            metadataMode: DEFAULT_METADATA_MODE,
            productGuidanceVersion: 0,
            remoteImageProcessingConsentVersion: 0,
            generationFolders: [createDefaultGenerationFolder()],
            generationFolderDocument: null,
            activeGenerationFolderId: DEFAULT_GENERATION_FOLDER_ID,

            setSavePath: async (savePath, useAbsolute) => {
                const state = useSettingsStore.getState()
                await applyAuthorityChanges(state, [{
                    folderId: DEFAULT_GENERATION_FOLDER_ID,
                    rootDirectory: savePath,
                    useAbsolutePath: useAbsolute ?? false,
                }])
            },
            setSceneSavePath: (sceneSavePath, useAbsolute) => set({
                sceneSavePath,
                useAbsoluteScenePath: useAbsolute ?? false
            }),
            setSceneSubfoldersEnabled: (sceneSubfoldersEnabled) => set({ sceneSubfoldersEnabled }),
            setStyleLabSavePath: (styleLabSavePath, useAbsolute) => set({
                styleLabSavePath,
                useAbsoluteStyleLabPath: useAbsolute ?? false
            }),
            setToolsSavePath: (toolsSavePath, useAbsolute) => set({
                toolsSavePath,
                useAbsoluteToolsPath: useAbsolute ?? false
            }),
            setAutoSave: (autoSave) => set({ autoSave }),

            addCustomResolution: (resolution) => set((state) => ({
                customResolutions: [
                    ...state.customResolutions,
                    { ...resolution, id: Date.now().toString() }
                ]
            })),

            removeCustomResolution: (id) => set((state) => ({
                customResolutions: state.customResolutions.filter(r => r.id !== id)
            })),
            setPromptFontSize: (size) => set({ promptFontSize: size }),
            setBasePromptCollapsed: (collapsed) => set({ basePromptCollapsed: collapsed }),
            setAdditionalPromptCollapsed: (collapsed) => set({ additionalPromptCollapsed: collapsed }),
            setDetailPromptCollapsed: (collapsed) => set({ detailPromptCollapsed: collapsed }),
            setNegativePromptCollapsed: (collapsed) => set({ negativePromptCollapsed: collapsed }),
            setUseStreaming: (useStreaming) => set({ useStreaming }),
            setGenerationDelay: (delay) => set({ generationDelay: Math.max(0, Math.min(5000, delay)) }),
            setGeminiApiKey: (key) => set({ geminiApiKey: key }),
            setLibraryPath: (libraryPath, useAbsolute) => set({
                libraryPath,
                useAbsoluteLibraryPath: useAbsolute ?? false
            }),
            setImageFormat: (format) => set({ imageFormat: format }),
            setMetadataMode: (metadataMode) => set({ metadataMode }),
            setProductGuidanceVersion: (productGuidanceVersion) => set({ productGuidanceVersion }),
            setRemoteImageProcessingConsentVersion: (remoteImageProcessingConsentVersion) => set({
                remoteImageProcessingConsentVersion: Math.max(0, Math.trunc(remoteImageProcessingConsentVersion)),
            }),
            addGenerationFolder: async input => {
                const name = input.name.trim()
                if (!isGenerationFolderName(name)) throw new TypeError('Generation folder name is invalid')
                const state = useSettingsStore.getState()
                const document = state.generationFolderDocument
                if (document === null) throw new Error('Generation folder authority is not ready')
                const parentId = input.parentId ?? null
                if (parentId !== null && !document.folders.some(folder => folder.id === parentId)) {
                    throw new TypeError('Generation folder parent does not exist')
                }
                const id = createGenerationFolderId()
                const folder: GenerationFolderV2 = {
                    id,
                    displayName: name,
                    pathSegment: name,
                    parentId,
                    rootDirectory: parentId === null
                        ? input.rootDirectory?.trim() || name
                        : null,
                    useAbsolutePath: parentId === null && input.useAbsolutePath === true,
                    commonPrompt: '',
                    autoUpload: false,
                    r2ProfilePolicy: { mode: 'inherit' },
                    r2BucketPolicy: { mode: 'inherit' },
                    r2PrefixPolicy: { mode: 'inherit' },
                }
                await applyAuthorityChanges(state, [{ op: 'create', folder }])
                set({ activeGenerationFolderId: id })
                return id
            },
            updateGenerationFolder: async (id, patch) => {
                const state = useSettingsStore.getState()
                const current = state.generationFolderDocument?.folders.find(folder => folder.id === id)
                if (current === undefined) throw new TypeError('Generation folder does not exist')
                await applyAuthorityChanges(state, [v2Patch(state, id, current.parentId, patch)])
            },
            saveGenerationFolder: async (id, parentId, patch) => {
                const state = useSettingsStore.getState()
                await applyAuthorityChanges(state, [v2Patch(state, id, parentId, patch)])
            },
            moveGenerationFolders: async (ids, parentId) => {
                const state = useSettingsStore.getState()
                const selected = new Set(ids.filter(id => id !== DEFAULT_GENERATION_FOLDER_ID))
                if (selected.size === 0) return
                if (parentId !== null && !state.generationFolders.some(folder => folder.id === parentId)) return
                const blockedTargets = new Set(selected)
                for (const id of selected) {
                    generationFolderDescendantIds(state.generationFolders, id).forEach(child => blockedTargets.add(child))
                }
                if (parentId !== null && blockedTargets.has(parentId)) return
                await applyAuthorityChanges(state, [...selected].map(id => {
                    const current = state.generationFolderDocument?.folders.find(folder => folder.id === id)
                    if (current === undefined) throw new TypeError('Generation folder does not exist')
                    return {
                        folderId: id,
                        parentId,
                        rootDirectory: parentId === null ? current.rootDirectory ?? current.pathSegment : null,
                        useAbsolutePath: parentId === null && current.useAbsolutePath,
                    }
                }))
            },
            deleteGenerationFolders: async ids => {
                const state = useSettingsStore.getState()
                const document = state.generationFolderDocument
                if (document === null) throw new Error('Generation folder authority is not ready')
                const deleted = new Set(ids.filter(id => id !== DEFAULT_GENERATION_FOLDER_ID))
                for (const id of [...deleted]) {
                    generationFolderDescendantIds(state.generationFolders, id).forEach(child => deleted.add(child))
                }
                if (deleted.size === 0) return
                const ordered = [...deleted].sort((left, right) => (
                    generationFolderDescendantIds(state.generationFolders, left).length
                    - generationFolderDescendantIds(state.generationFolders, right).length
                ))
                await applyAuthorityChanges(state, ordered.map(folderId => ({ op: 'delete', folderId })))
                if (deleted.has(state.activeGenerationFolderId)) set({ activeGenerationFolderId: DEFAULT_GENERATION_FOLDER_ID })
            },
            copyGenerationFolderPrompt: async (sourceId, targetIds, replacementPrompt) => {
                const state = useSettingsStore.getState()
                const prompt = replacementPrompt
                    ?? state.generationFolderDocument?.folders.find(folder => folder.id === sourceId)?.commonPrompt
                if (prompt === undefined) return
                if (prompt.length > 20_000) throw new TypeError('Generation folder prompt is too long')
                const targets = new Set(targetIds.filter(id => id !== sourceId))
                if (targets.size === 0) return
                await applyAuthorityChanges(state, [
                    { folderId: sourceId, commonPrompt: prompt },
                    ...[...targets].map(folderId => ({ folderId, commonPrompt: prompt })),
                ])
            },
            setActiveGenerationFolder: id => set(state => state.generationFolders.some(folder => folder.id === id)
                ? { activeGenerationFolderId: id }
                : state),
        }),
        {
            name: 'nai-blue-settings',
            storage: createJSONStorage(() => indexedDBStorage),
            version: SETTINGS_PERSIST_VERSION,
            partialize: partializePersistedSettingsState,
            migrate: persistedState => normalizePersistedSettingsState(persistedState) as SettingsState,
            merge: (persistedState, currentState) => ({
                ...currentState,
                ...normalizePersistedSettingsState(persistedState),
            }),
            onRehydrateStorage: () => (state, error) => {
                if (error) {
                    console.error('[SettingsStore] Hydration failed:', error)
                    return
                }
                if (state) {
                    console.log('[SettingsStore] Hydrated successfully')
                }
            },
        }
    )
)

export async function initializeGenerationFolderAuthority(): Promise<GenerationFolderDocument | null> {
    if (folderAuthority === null) {
        const { IndexedDbGenerationFolderRepository } = await import('@/adapters/folder/indexeddb-generation-folder-repository')
        folderAuthority = new GenerationFolderAuthorityRuntime(
            new IndexedDbGenerationFolderRepository(),
            projectAuthorityDocument,
            projectLegacyFolderAuthority,
        )
    }
    return folderAuthority.initialize()
}
