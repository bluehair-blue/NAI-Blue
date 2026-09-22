import type {
    CharacterSlotPatch,
    Extensions,
    OutputPolicy,
    ParamsOverride,
    PromptContribution,
} from '@/domain/composition/types'

/** Persisted Scene prompt fields retained by the V1 compatibility reader. */
export interface SceneV1PromptConfig {
    readonly base?: string
    readonly additional?: string
    readonly character?: string
    readonly negative?: string
    readonly characterNegative?: string
}

export interface SceneV1CharacterCaption {
    readonly id: string
    readonly name?: string
    readonly prompt: string
    readonly negative: string
    readonly enabled: boolean
    readonly position: { readonly x: number; readonly y: number }
}

export interface SceneV1GenerationConfig {
    readonly model?: string
    readonly steps?: number
    readonly cfgScale?: number
    readonly cfgRescale?: number
    readonly sampler?: string
    readonly scheduler?: string
    readonly smea?: boolean
    readonly smeaDyn?: boolean
    readonly variety?: boolean
    readonly qualityToggle?: boolean
    readonly ucPreset?: number
    readonly seed?: number
    readonly seedLocked?: boolean
}

export interface SceneV1LegacyImage {
    readonly id: string
    readonly url: string
    readonly timestamp: number
    readonly isFavorite: boolean
}

export interface SceneV1FolderTemplate {
    readonly sourceSceneId: string
    readonly sourceSceneName: string
    readonly scenePrompt: string
    readonly prompts: SceneV1PromptConfig
    readonly characterCaptions?: readonly SceneV1CharacterCaption[]
    readonly characterPositionEnabled?: boolean
    readonly generation: SceneV1GenerationConfig
    readonly width?: number
    readonly height?: number
    readonly excludePinned?: boolean
    readonly metadataMode?: 'embedded' | 'sidecar-only' | 'strip-and-sidecar' | 'strip-only'
    readonly filenameTemplate?: string
    readonly compositionRef?: unknown
}

/** Authoring-only projection; queue and presentation/session fields intentionally have no slot. */
export interface SceneV1AuthoringRecord {
    readonly id: string
    readonly name: string
    readonly scenePrompt: string
    readonly prompts?: SceneV1PromptConfig
    readonly characterCaptions?: readonly SceneV1CharacterCaption[]
    readonly characterPositionEnabled?: boolean
    readonly generation?: SceneV1GenerationConfig
    readonly images: readonly SceneV1LegacyImage[]
    readonly width?: number
    readonly height?: number
    readonly metadataMode?: 'embedded' | 'sidecar-only' | 'strip-and-sidecar' | 'strip-only'
    readonly generationFolderId?: string
    readonly productionCount?: number
    readonly filenameTemplate?: string
    readonly excludePinned?: boolean
    readonly compositionRef?: unknown
    readonly createdAt: number
}

export interface SceneV1PresetProjection {
    readonly id: string
    readonly name: string
    readonly scenes: readonly SceneV1AuthoringRecord[]
    readonly parentId?: string | null
    readonly defaultTemplate?: SceneV1FolderTemplate
    readonly createdAt: number
}

export interface SceneV1CompatibilityProjection {
    readonly presets: readonly SceneV1PresetProjection[]
}

export interface SceneArtifactRef {
    readonly artifactId: string
    readonly createdAt: string
    readonly favorite: boolean
}

/** Serializable Scene-owned composition state shared by UI and Agent writes. */
export interface SceneCompositionRef {
    readonly recipeId: string
    readonly selectionKind?: 'asset' | 'direct'
    readonly recipeRevision?: number
    readonly sceneContributions?: readonly PromptContribution[]
    readonly paramsOverride?: Readonly<ParamsOverride>
    readonly characterOverrides?: readonly CharacterSlotPatch[]
    readonly outputOverride?: Readonly<OutputPolicy>
    readonly migrationMarker?: {
        readonly kind: 'legacy-scene-prompt'
        readonly schemaVersion: 2
        readonly extensions?: Readonly<Extensions>
    }
    readonly extensions?: Readonly<Extensions>
}

/** V2 authoring state excludes legacy URLs and every queue/presentation field. */
export interface SceneAuthoringRecord {
    readonly id: string
    readonly name: string
    readonly scenePrompt: string
    readonly prompts?: SceneV1PromptConfig
    readonly characterCaptions?: readonly SceneV1CharacterCaption[]
    readonly characterPositionEnabled?: boolean
    readonly generation?: SceneV1GenerationConfig
    readonly width?: number
    readonly height?: number
    readonly metadataMode?: 'embedded' | 'sidecar-only' | 'strip-and-sidecar' | 'strip-only'
    readonly generationFolderId?: string
    /** Optional saved quantity; old documents remain valid and transient queue counts stay excluded. */
    readonly productionCount?: number
    readonly filenameTemplate?: string
    readonly excludePinned?: boolean
    readonly compositionRef?: SceneCompositionRef
    readonly artifactRefs: readonly SceneArtifactRef[]
    readonly createdAt: number
}

export interface SceneDocument {
    readonly schemaVersion: 1
    readonly presetId: string
    readonly revision: number
    readonly scenes: readonly SceneAuthoringRecord[]
    readonly updatedAt: string
}

export interface SceneDocumentSummary {
    readonly presetId: string
    readonly revision: number
    readonly sceneCount: number
    readonly updatedAt: string
}

export type CommitResult =
    | { readonly status: 'COMMITTED'; readonly document: SceneDocument }
    | { readonly status: 'REVISION_CONFLICT'; readonly current: SceneDocument | null }
    | { readonly status: 'STORAGE_CONFLICT' }

/** V1 remains read-only while V2 documents use whole-document CAS. */
export interface SceneRepositoryPort {
    readLegacyProjection(): Promise<SceneV1CompatibilityProjection | null>
    getDocument(presetId: string): Promise<SceneDocument | null>
    listDocuments(): Promise<readonly SceneDocumentSummary[]>
    /** Optional bulk read for collection-backed adapters; avoids rereading the full store per preset. */
    listDocumentRecords?(): Promise<readonly SceneDocument[]>
    commit(next: SceneDocument, expectedRevision: number): Promise<CommitResult>
}
