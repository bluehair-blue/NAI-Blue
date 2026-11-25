import type { PreciseReferenceCaption } from '@/domain/generation/precise-reference'

export const COMPOSITION_SCHEMA_VERSION = 2 as const

export type CompositionSchemaVersion = typeof COMPOSITION_SCHEMA_VERSION

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject
export type JsonObject = { [key: string]: JsonValue }
export type Extensions = JsonObject

export type EntityId = string
export type OrderKey = string
export type IsoTimestamp = string

export type ActorKind = 'user' | 'agent' | 'system' | 'service'

export interface ActorRef {
    kind: ActorKind
    id: EntityId
    displayName?: string
    extensions?: Extensions
}

export interface RevisionMeta {
    revision: number
    createdAt: IsoTimestamp
    createdBy: ActorRef
    updatedAt: IsoTimestamp
    updatedBy: ActorRef
    deletedAt?: IsoTimestamp
}

export interface RevisionedEntity extends RevisionMeta {
    id: EntityId
    extensions?: Extensions
}

export interface OrderedEntity extends RevisionedEntity {
    orderKey: OrderKey
}

export type PositivePromptSlot =
    | 'base'
    | 'inpainting'
    | 'additional'
    | 'workflow'
    | 'scene'
    | 'style'
    | 'detail'
    | 'quality'

export type PromptTarget =
    | {
        kind: 'positive'
        slot: PositivePromptSlot
        extensions?: Extensions
    }
    | {
        kind: 'negative'
        extensions?: Extensions
    }
    | {
        kind: 'character'
        characterId: EntityId
        polarity: 'positive' | 'negative'
        extensions?: Extensions
    }

export interface PromptContribution extends OrderedEntity {
    enabled: boolean
    target: PromptTarget
    text: string
    merge: 'append' | 'prepend' | 'replace'
    separator?: 'comma-space' | 'space' | 'newline' | 'none'
    weight?: number
    randomRuleId?: EntityId
    provenance?: ProvenanceRef[]
}

export type CharacterPosition =
    | { mode: 'ai-choice'; extensions?: Extensions }
    | { mode: 'manual'; x: number; y: number; extensions?: Extensions }

export type CharacterReferenceType = PreciseReferenceCaption | 'delta' | 'vibe'

export interface ResourceBinding {
    resourceId: EntityId
    enabled: boolean
    referenceType: CharacterReferenceType
    strength: number
    fidelity?: number
    informationExtracted?: number
    extensions?: Extensions
}

export type CharacterResourceBinding = ResourceBinding

export interface CharacterDefinition extends OrderedEntity {
    name: string
    enabled: boolean
    positivePrompt: string
    negativePrompt: string
    position: CharacterPosition
    resourceBindings: CharacterResourceBinding[]
}

export interface CharacterSlotPatch {
    characterId: EntityId
    enabled?: boolean
    positivePrompt?: string
    negativePrompt?: string
    position?: CharacterPosition
    resourceBindings?: CharacterResourceBinding[]
    extensions?: Extensions
}

export type SourceMode = 'text-to-image' | 'image-to-image' | 'inpaint'

export interface ParamsOverride {
    model?: string
    width?: number
    height?: number
    steps?: number
    cfgScale?: number
    cfgRescale?: number
    sampler?: string
    scheduler?: string
    smea?: boolean
    smeaDyn?: boolean
    variety?: boolean
    seed?: number
    seedLocked?: boolean
    qualityToggle?: boolean
    ucPreset?: number
    transparentBackground?: boolean
    sourceMode?: SourceMode
    sourceImageResourceId?: EntityId
    maskResourceId?: EntityId
    strength?: number
    noise?: number
    characterPositionEnabled?: boolean
    extensions?: Extensions
}

export interface ParamsPreset extends OrderedEntity {
    name: string
    enabled: boolean
    params: ParamsOverride
}

export interface ResolvedGenerationParams {
    model: string
    width: number
    height: number
    steps: number
    cfgScale: number
    cfgRescale: number
    sampler: string
    scheduler: string
    smea: boolean
    smeaDyn: boolean
    variety: boolean
    seed: number
    qualityToggle: boolean
    ucPreset: number
    transparentBackground: boolean
    sourceMode: SourceMode
    sourceImageResourceId?: EntityId
    maskResourceId?: EntityId
    strength: number
    noise: number
    characterPositionEnabled: boolean
}

/** Platform-owned roots which can be resolved without persisting an OS path. */
export type PortablePathRoot =
    | 'app-data'
    | 'documents'
    | 'pictures'
    | 'downloads'
    | 'media'
    | 'cache'

export interface StandardPortablePathRef {
    kind: 'standard'
    root: PortablePathRoot
    /** Relative path components only. Separators, traversal, and absolute paths are invalid. */
    segments: string[]
    /** Presentation hint only. It is never used to resolve or export this reference. */
    displayPath?: string
    extensions?: Extensions
}

/** Portable lookup id for a user grant; it never contains the grant/token material itself. */
export type UserSelectedTokenId = EntityId

/**
 * A user-selected directory/file grant. `bookmarkId` is a portable logical id,
 * not a desktop bookmark, Android content URI, or other opaque platform token.
 * Adapters keep token material in platform storage keyed by this id.
 */
export interface UserSelectedPortablePathRef {
    kind: 'bookmark'
    bookmarkId: UserSelectedTokenId
    /** Relative path components beneath the selected grant. */
    segments: string[]
    /** Presentation hint only. It is never used to resolve or export this reference. */
    displayPath?: string
    extensions?: Extensions
}

/** No raw absolute-path-only variant is part of the composition document contract. */
export type PortablePathRef = StandardPortablePathRef | UserSelectedPortablePathRef

/** Portable sync/export projection. Volatile display paths are deliberately absent. */
export type ExportedPortablePathRef =
    | Omit<StandardPortablePathRef, 'displayPath'>
    | Omit<UserSelectedPortablePathRef, 'displayPath'>

export type OutputDestination =
    | { kind: 'memory'; extensions?: Extensions }
    | { kind: 'filesystem'; directory: PortablePathRef; extensions?: Extensions }

export type OutputFormat = 'png' | 'webp'
export type MetadataMode = 'embedded' | 'sidecar-only' | 'strip-and-sidecar' | 'strip-only'

export interface OutputPolicy {
    destination: OutputDestination
    format: OutputFormat
    filenameTemplate: string
    metadataMode: MetadataMode
    collisionPolicy: 'unique' | 'overwrite' | 'error'
    extensions?: Extensions
}

export type ResourceRole =
    | 'source-image'
    | 'mask'
    | 'character-reference'
    | 'vibe-reference'
    | 'style-reference'

export type LibraryImageId = EntityId

export interface ResourceContentHash {
    algorithm: 'sha256'
    /** Lower-case, unprefixed SHA-256 digest. */
    value: string
}

export interface ResourceRefBase extends OrderedEntity {
    enabled: boolean
    role: ResourceRole
    mimeType?: string
    /** Structured content identity for portable verification and de-duplication. */
    contentHash?: ResourceContentHash
    /** @deprecated Legacy unstructured digest retained for v2 compatibility. */
    digest?: string
}

export interface ManagedResourceRef extends ResourceRefBase {
    kind: 'managed'
    /** Legacy stable handle owned by an external resource registry. */
    resourceId: EntityId
}

export interface LibraryImageResourceRef extends ResourceRefBase {
    kind: 'library-image'
    /** Stable image identity in the composition library; bytes live outside the document. */
    libraryImageId: LibraryImageId
}

export interface PathResourceRef extends ResourceRefBase {
    kind: 'path'
    path: PortablePathRef
}

export interface UriResourceRef extends ResourceRefBase {
    kind: 'uri'
    uri: string
}

/**
 * Identity/location only. Resource bytes and materialized native paths are
 * resolved by a platform adapter and must never be stored in this union.
 */
export type ResourceRef =
    | ManagedResourceRef
    | LibraryImageResourceRef
    | PathResourceRef
    | UriResourceRef

export type RandomScalar = string | number | boolean

export interface RandomChoiceOption {
    id: EntityId
    orderKey: OrderKey
    value: RandomScalar
    weight: number
    extensions?: Extensions
}

export interface RandomRuleBase extends OrderedEntity {
    enabled: boolean
    streamKey: string
    scope: 'generation-seed' | 'prompt-wildcard' | 'character-rotation' | 'filename' | 'parameter'
    source: RandomSourcePolicy
}

export type RandomSourcePolicy =
    | { mode: 'runtime'; extensions?: Extensions }
    | { mode: 'fixed'; seed: number; extensions?: Extensions }
    | { mode: 'seeded'; seed: number; algorithm: 'xorshift32-v1'; extensions?: Extensions }
    | { mode: 'replay'; entries: RandomTraceEntry[]; extensions?: Extensions }

export interface ChoiceRandomRule extends RandomRuleBase {
    kind: 'choice'
    options: RandomChoiceOption[]
    pickCount: number
    withoutReplacement: boolean
}

export interface IntegerRangeRandomRule extends RandomRuleBase {
    kind: 'integer-range'
    min: number
    max: number
    step: number
}

export interface DecimalRangeRandomRule extends RandomRuleBase {
    kind: 'decimal-range'
    min: number
    max: number
}

export interface BooleanRandomRule extends RandomRuleBase {
    kind: 'boolean'
    probability: number
}

export type RandomRule =
    | ChoiceRandomRule
    | IntegerRangeRandomRule
    | DecimalRangeRandomRule
    | BooleanRandomRule

export type CompositionModuleKind = 'prompt' | 'character' | 'params' | 'output' | 'composite'

export interface CompositionModule extends OrderedEntity {
    name: string
    enabled: boolean
    kind: CompositionModuleKind
    contributions: PromptContribution[]
    characterPatches: CharacterSlotPatch[]
    paramsOverride?: ParamsOverride
    outputPolicy?: OutputPolicy
    resourceBindings: ResourceBinding[]
    randomRuleIds: EntityId[]
}

export interface RecipeStep extends OrderedEntity {
    moduleId: EntityId
    enabled: boolean
    contributions: PromptContribution[]
    characterPatches: CharacterSlotPatch[]
    paramsOverride?: ParamsOverride
    outputPolicy?: OutputPolicy
    resourceBindings: ResourceBinding[]
    randomRuleIds: EntityId[]
}

export interface CompositionRecipe extends OrderedEntity {
    name: string
    enabled: boolean
    steps: RecipeStep[]
    paramsOverride?: ParamsOverride
    outputPolicy?: OutputPolicy
}

export interface CompositionProfile extends OrderedEntity {
    name: string
    enabled: boolean
    moduleIds: EntityId[]
    recipeIds: EntityId[]
    characterIds: EntityId[]
    paramsPresetIds: EntityId[]
    resourceBindings: ResourceBinding[]
    randomRuleIds: EntityId[]
    defaultRecipeId?: EntityId
    defaultParamsPresetId?: EntityId
    contributions: PromptContribution[]
    characterPatches: CharacterSlotPatch[]
    paramsOverride?: ParamsOverride
    outputPolicy: OutputPolicy
}

export interface CompositionDocument extends RevisionedEntity {
    schemaVersion: CompositionSchemaVersion
    profiles: CompositionProfile[]
    modules: CompositionModule[]
    recipes: CompositionRecipe[]
    characters: CharacterDefinition[]
    paramsPresets: ParamsPreset[]
    resources: ResourceRef[]
    randomRules: RandomRule[]
    activeProfileId?: EntityId
}

export interface ResolveRequest {
    schemaVersion: CompositionSchemaVersion
    requestId: EntityId
    requestedAt: IsoTimestamp
    requestedBy: ActorRef
    document: CompositionDocument
    profileId: EntityId
    recipeId?: EntityId
    paramsPresetId?: EntityId
    contributions: PromptContribution[]
    characterPatches: CharacterSlotPatch[]
    paramsOverride?: ParamsOverride
    outputPolicy?: OutputPolicy
    resourceBindings: ResourceBinding[]
    randomSeed?: number
    extensions?: Extensions
}

export interface ResolvedCharacterPrompt {
    characterId: EntityId
    positive: string
    negative: string
    enabled: boolean
    position: CharacterPosition
    resourceBindings: CharacterResourceBinding[]
    extensions?: Extensions
}

export interface ResolvedPromptParts {
    base: string
    inpainting: string
    additional: string
    workflow: string
    detail: string
    negative: string
    extensions?: Extensions
}

export interface ResolvedGenerationPlan {
    schemaVersion: CompositionSchemaVersion
    planId: EntityId
    requestId: EntityId
    documentId: EntityId
    documentRevision: number
    profileId: EntityId
    recipeId?: EntityId
    positivePrompt: string
    negativePrompt: string
    promptParts: ResolvedPromptParts
    contributions: PromptContribution[]
    characters: ResolvedCharacterPrompt[]
    params: ResolvedGenerationParams
    outputPolicy: OutputPolicy
    resources: ResourceRef[]
    resourceBindings: ResourceBinding[]
    issues: ResolutionIssue[]
    provenance: ProvenanceRef[]
    randomTrace: RandomTraceEntry[]
    extensions?: Extensions
}

export type CompositionEntityKind =
    | 'profile'
    | 'module'
    | 'recipe'
    | 'recipe-step'
    | 'prompt-contribution'
    | 'character'
    | 'params-preset'
    | 'resource'
    | 'random-rule'

export type CompositionChange =
    // Steps and contributions are replaced through their owning recipe/module upsert.
    | { kind: 'upsert-profile'; value: CompositionProfile; extensions?: Extensions }
    | { kind: 'upsert-module'; value: CompositionModule; extensions?: Extensions }
    | { kind: 'upsert-recipe'; value: CompositionRecipe; extensions?: Extensions }
    | { kind: 'upsert-character'; value: CharacterDefinition; extensions?: Extensions }
    | { kind: 'upsert-params-preset'; value: ParamsPreset; extensions?: Extensions }
    | { kind: 'upsert-resource'; value: ResourceRef; extensions?: Extensions }
    | { kind: 'upsert-random-rule'; value: RandomRule; extensions?: Extensions }
    | {
        kind: 'tombstone'
        entityKind: CompositionEntityKind
        entityId: EntityId
        parentId?: EntityId
        deletedAt: IsoTimestamp
        extensions?: Extensions
    }

export interface CompositionChangeSet {
    schemaVersion: CompositionSchemaVersion
    id: EntityId
    documentId: EntityId
    baseRevision: number
    revision: number
    updatedAt: IsoTimestamp
    updatedBy: ActorRef
    changes: CompositionChange[]
    extensions?: Extensions
}

export type ResolutionIssueCode =
    | 'E_PROFILE_MISSING'
    | 'E_RECIPE_MISSING'
    | 'E_MODULE_REF_MISSING'
    | 'E_PARAMS_PRESET_MISSING'
    | 'E_CHARACTER_REF_MISSING'
    | 'E_RANDOM_RULE_REF_MISSING'
    | 'E_RESOURCE_REF_MISSING'
    | 'E_PARAM_OUT_OF_RANGE'
    | 'E_CHAR_POSITION_MODE_MIXED'
    | 'W_FRAGMENT_MISSING'
    | 'W_MODULE_DISABLED'
    | 'W_UNKNOWN_EXTENSION'
    | 'W_PAYLOAD_PARITY_UNVERIFIED_MODEL'
    | 'W_PATH_CAPABILITY_FALLBACK'

export interface ResolutionIssueEntityRef {
    kind: CompositionEntityKind
    id: EntityId
}

export interface ResolutionIssue {
    code: ResolutionIssueCode
    severity: 'warning' | 'error'
    messageKey: string
    sourceRef: ProvenanceRef
    entityRef?: ResolutionIssueEntityRef
    fieldPath: Array<string | number>
    repairHintKey?: string
    actionId?: string
    blocking: boolean
    extensions?: Extensions
}

export type ProvenanceRef =
    | {
        kind: 'entity'
        entityKind: CompositionEntityKind
        entityId: EntityId
        revision: number
        path?: Array<string | number>
        extensions?: Extensions
    }
    | {
        kind: 'request'
        requestId: EntityId
        path?: Array<string | number>
        extensions?: Extensions
    }
    | {
        kind: 'external'
        source: string
        digest?: string
        path?: Array<string | number>
        extensions?: Extensions
    }

export interface RandomTraceEntry {
    ruleId: EntityId
    streamKey: string
    drawIndex: number
    seed: number
    result: RandomScalar
    selectedOptionIds?: EntityId[]
    provenance?: ProvenanceRef
    extensions?: Extensions
}
