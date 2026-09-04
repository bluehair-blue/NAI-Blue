import { canonicalSerialize } from '@/domain/composition/canonical-serialize'
import { safeParseCompositionDocument } from '@/domain/composition/schema'
import type { JsonObject, JsonValue } from '@/domain/composition/types'
import type { ArtifactRecord } from '@/domain/organizer/types'
import {
    SyncSanitizationError,
    assertSyncPayloadSafe,
    isForbiddenSyncFieldKey,
    normalizeSyncFieldKey,
    type ActiveSyncEntityType,
    type SyncEntityType,
} from '@/domain/sync'
import { validateArtifactRecord } from '@/services/organizer/artifact-repository'

export { SyncSanitizationError, assertSyncPayloadSafe } from '@/domain/sync'

const COMPOSITION_TOP_LEVEL_KEYS: Readonly<Record<Extract<ActiveSyncEntityType,
    'composition.document' | 'composition.profile' | 'composition.recipe' | 'composition.module'>, readonly string[]>> = {
    'composition.document': [
        'schemaVersion', 'id', 'revision', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'deletedAt',
        'profiles', 'modules', 'recipes', 'characters', 'paramsPresets', 'resources', 'randomRules', 'activeProfileId',
    ],
    'composition.profile': [
        'id', 'orderKey', 'revision', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'deletedAt', 'name', 'enabled',
        'moduleIds', 'recipeIds', 'characterIds', 'paramsPresetIds', 'resourceBindings', 'randomRuleIds',
        'defaultRecipeId', 'defaultParamsPresetId', 'contributions', 'characterPatches', 'paramsOverride', 'outputPolicy',
    ],
    'composition.recipe': [
        'id', 'orderKey', 'revision', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'deletedAt', 'name', 'enabled',
        'steps', 'paramsOverride', 'outputPolicy',
    ],
    'composition.module': [
        'id', 'orderKey', 'revision', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'deletedAt', 'name', 'enabled',
        'kind', 'contributions', 'characterPatches', 'paramsOverride', 'outputPolicy', 'resourceBindings', 'randomRuleIds',
    ],
}

const PROMPT_PRESET_KEYS = [
    'id', 'name', 'createdAt', 'isDefault', 'basePrompt', 'additionalPrompt', 'detailPrompt', 'negativePrompt',
    'model', 'steps', 'cfgScale', 'cfgRescale', 'sampler', 'scheduler', 'smea', 'smeaDyn', 'variety',
    'qualityToggle', 'ucPreset', 'selectedResolution', 'orderKey',
] as const

const UI_BOOLEAN_KEYS = [
    'leftSidebarVisible', 'rightSidebarVisible', 'basePromptCollapsed', 'additionalPromptCollapsed',
    'detailPromptCollapsed', 'negativePromptCollapsed',
] as const
const UI_NUMBER_KEYS = [
    'promptFontSize', 'mosaicPixelSize', 'mosaicBrushSize', 'inpaintingBrushSize',
] as const

const OMITTED_TREE_KEYS = new Set([
    'extensions',
])

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalid(field: string): never {
    throw new SyncSanitizationError('E_SYNC_PAYLOAD_INVALID', `Sync payload field ${field} is invalid.`)
}

function requiredRecord(value: unknown, field = '$'): Record<string, unknown> {
    if (!isRecord(value)) return invalid(field)
    return value
}

function requiredString(record: Record<string, unknown>, key: string): string {
    const value = record[key]
    if (typeof value !== 'string' || value.trim().length === 0) return invalid(key)
    return value
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key]
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'string') return invalid(key)
    return value
}

function requiredNumber(record: Record<string, unknown>, key: string): number {
    const value = record[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) return invalid(key)
    return value
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
    const value = record[key]
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'number' || !Number.isFinite(value)) return invalid(key)
    return value
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
    const value = record[key]
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'boolean') return invalid(key)
    return value
}

interface ProjectionBudget {
    nodes: number
}

function projectTree(
    value: unknown,
    ancestors = new Set<object>(),
    budget: ProjectionBudget = { nodes: 0 },
    depth = 0,
): JsonValue {
    budget.nodes += 1
    if (budget.nodes > 100_000 || depth > 64) return invalid('payload-size')
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return invalid('number')
        return Object.is(value, -0) ? 0 : value
    }
    if (typeof value !== 'object') return invalid('value')
    if (ancestors.has(value)) return invalid('cycle')
    ancestors.add(value)
    try {
        if (Array.isArray(value)) return value.map(entry => projectTree(entry, ancestors, budget, depth + 1))
        const record = requiredRecord(value)
        const result: JsonObject = {}
        for (const key of Object.keys(record).sort()) {
            if (OMITTED_TREE_KEYS.has(normalizeSyncFieldKey(key)) || isForbiddenSyncFieldKey(key)) continue
            result[key] = projectTree(record[key], ancestors, budget, depth + 1)
        }
        return result
    } finally {
        ancestors.delete(value)
    }
}

function projectKeys(record: Record<string, unknown>, keys: readonly string[]): JsonObject {
    const result: JsonObject = {}
    const budget: ProjectionBudget = { nodes: 0 }
    for (const key of keys) {
        if (record[key] !== undefined) result[key] = projectTree(record[key], new Set<object>(), budget)
    }
    return result
}

const COMPOSITION_VALIDATION_TIME = '2000-01-01T00:00:00.000Z'
const COMPOSITION_VALIDATION_ACTOR = { kind: 'system', id: 'sync:sanitizer' }

function compositionEntityIds(value: unknown): Set<string> {
    const occupiedIds = new Set<string>()
    const visited = new Set<object>()
    let nodes = 0
    const inspect = (current: unknown, ancestors: Set<object>, depth: number): void => {
        nodes += 1
        if (nodes > 100_000 || depth > 64) invalid('composition-size')
        if (current === null || typeof current !== 'object') return
        if (ancestors.has(current)) invalid('composition-cycle')
        if (visited.has(current)) return
        visited.add(current)
        ancestors.add(current)
        try {
            if (Array.isArray(current)) {
                current.forEach(entry => inspect(entry, ancestors, depth + 1))
                return
            }
            const record = current as Record<string, unknown>
            if (typeof record.id === 'string') occupiedIds.add(record.id)
            Object.values(record).forEach(entry => inspect(entry, ancestors, depth + 1))
        } finally {
            ancestors.delete(current)
        }
    }
    inspect(value, new Set<object>(), 0)
    return occupiedIds
}

function unoccupiedCompositionId(value: unknown, base: string): string {
    const occupiedIds = compositionEntityIds(value)
    let candidate = base
    while (occupiedIds.has(candidate)) candidate += ':scope'
    return candidate
}

function validateCompositionEntity(
    entityType: keyof typeof COMPOSITION_TOP_LEVEL_KEYS,
    value: unknown,
): void {
    const validationDocumentId = unoccupiedCompositionId(value, 'composition-document:sync-validation')
    const candidate = entityType === 'composition.document'
        ? value
        : {
            schemaVersion: 2,
            id: validationDocumentId,
            revision: 0,
            createdAt: COMPOSITION_VALIDATION_TIME,
            createdBy: COMPOSITION_VALIDATION_ACTOR,
            updatedAt: COMPOSITION_VALIDATION_TIME,
            updatedBy: COMPOSITION_VALIDATION_ACTOR,
            profiles: entityType === 'composition.profile' ? [value] : [],
            modules: entityType === 'composition.module' ? [value] : [],
            recipes: entityType === 'composition.recipe' ? [value] : [],
            characters: [],
            paramsPresets: [],
            resources: [],
            randomRules: [],
        }
    if (!safeParseCompositionDocument(candidate).success) invalid('composition-schema')
}

function projectComposition(entityType: keyof typeof COMPOSITION_TOP_LEVEL_KEYS, value: unknown): JsonObject {
    validateCompositionEntity(entityType, value)
    return projectKeys(requiredRecord(value), COMPOSITION_TOP_LEVEL_KEYS[entityType])
}

function projectScenePreset(value: unknown): JsonObject {
    const record = requiredRecord(value)
    return {
        id: requiredString(record, 'id'),
        name: requiredString(record, 'name'),
        createdAt: requiredNumber(record, 'createdAt'),
        orderKey: requiredString(record, 'orderKey'),
    }
}

function projectSceneCompositionRef(value: unknown): JsonObject {
    const record = requiredRecord(value, 'compositionRef')
    const recipeId = requiredString(record, 'recipeId')
    const result: JsonObject = { recipeId }
    if (record.selectionKind !== undefined) {
        if (record.selectionKind !== 'asset' && record.selectionKind !== 'direct') return invalid('selectionKind')
        result.selectionKind = record.selectionKind
    }
    if (record.recipeRevision !== undefined) {
        const revision = requiredNumber(record, 'recipeRevision')
        if (!Number.isSafeInteger(revision) || revision < 0) return invalid('recipeRevision')
        result.recipeRevision = revision
    }
    const contributions = record.sceneContributions ?? []
    const characterPatches = record.characterOverrides ?? []
    const syntheticModule = {
        id: unoccupiedCompositionId(record, 'module:scene-sync-validation'),
        orderKey: 'sync-validation',
        revision: 0,
        createdAt: COMPOSITION_VALIDATION_TIME,
        createdBy: COMPOSITION_VALIDATION_ACTOR,
        updatedAt: COMPOSITION_VALIDATION_TIME,
        updatedBy: COMPOSITION_VALIDATION_ACTOR,
        name: 'Scene sync validation',
        enabled: true,
        kind: 'composite',
        contributions,
        characterPatches,
        ...(record.paramsOverride === undefined ? {} : { paramsOverride: record.paramsOverride }),
        ...(record.outputOverride === undefined ? {} : { outputPolicy: record.outputOverride }),
        resourceBindings: [],
        randomRuleIds: [],
    }
    validateCompositionEntity('composition.module', syntheticModule)
    if (record.sceneContributions !== undefined) result.sceneContributions = projectTree(record.sceneContributions)
    if (record.paramsOverride !== undefined) result.paramsOverride = projectTree(record.paramsOverride)
    if (record.characterOverrides !== undefined) result.characterOverrides = projectTree(record.characterOverrides)
    if (record.outputOverride !== undefined) result.outputOverride = projectTree(record.outputOverride)
    if (record.migrationMarker !== undefined) {
        const marker = requiredRecord(record.migrationMarker, 'migrationMarker')
        if (marker.kind !== 'legacy-scene-prompt' || marker.schemaVersion !== 2) return invalid('migrationMarker')
        result.migrationMarker = { kind: 'legacy-scene-prompt', schemaVersion: 2 }
    }
    return result
}

function projectSceneCard(value: unknown): JsonObject {
    const record = requiredRecord(value)
    const result: JsonObject = {
        id: requiredString(record, 'id'),
        name: requiredString(record, 'name'),
        scenePrompt: typeof record.scenePrompt === 'string' ? record.scenePrompt : invalid('scenePrompt'),
        createdAt: requiredNumber(record, 'createdAt'),
        orderKey: requiredString(record, 'orderKey'),
    }
    const presetId = optionalString(record, 'presetId')
    const width = optionalNumber(record, 'width')
    const height = optionalNumber(record, 'height')
    const excludePinned = optionalBoolean(record, 'excludePinned')
    if (presetId !== undefined) result.presetId = presetId
    if (width !== undefined) result.width = width
    if (height !== undefined) result.height = height
    if (excludePinned !== undefined) result.excludePinned = excludePinned
    // Scene prompt modules and generation settings are portable, JSON-only
    // state. The bounded tree projector strips forbidden keys before sync.
    if (record.prompts !== undefined) result.prompts = projectTree(record.prompts)
    if (record.characterCaptions !== undefined) result.characterCaptions = projectTree(record.characterCaptions)
    if (record.characterPositionEnabled !== undefined) {
        result.characterPositionEnabled = typeof record.characterPositionEnabled === 'boolean'
            ? record.characterPositionEnabled
            : invalid('characterPositionEnabled')
    }
    if (record.generation !== undefined) result.generation = projectTree(record.generation)
    if (record.compositionRef !== undefined) result.compositionRef = projectSceneCompositionRef(record.compositionRef)
    return result
}

function projectPromptPreset(value: unknown): JsonObject {
    const record = requiredRecord(value)
    const result = projectKeys(record, PROMPT_PRESET_KEYS)
    for (const key of ['id', 'name', 'model', 'sampler', 'scheduler', 'orderKey']) {
        requiredString(record, key)
    }
    for (const key of ['basePrompt', 'additionalPrompt', 'detailPrompt', 'negativePrompt']) {
        if (typeof record[key] !== 'string') return invalid(key)
    }
    requiredNumber(record, 'createdAt')
    const resolution = requiredRecord(record.selectedResolution, 'selectedResolution')
    const label = requiredString(resolution, 'label')
    const width = requiredNumber(resolution, 'width')
    const height = requiredNumber(resolution, 'height')
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
        || width <= 0 || height <= 0 || width > 16_384 || height > 16_384) return invalid('selectedResolution')
    result.selectedResolution = { label, width, height }
    return result
}

function projectFragment(value: unknown): JsonObject {
    const record = requiredRecord(value)
    if (!Array.isArray(record.content) || record.content.some(line => typeof line !== 'string')) return invalid('content')
    const schemaVersion = requiredNumber(record, 'schemaVersion')
    return {
        schemaVersion,
        id: requiredString(record, 'id'),
        name: requiredString(record, 'name'),
        folder: typeof record.folder === 'string' ? record.folder : invalid('folder'),
        content: [...record.content] as string[],
        createdAt: requiredNumber(record, 'createdAt'),
        updatedAt: requiredNumber(record, 'updatedAt'),
        orderKey: requiredString(record, 'orderKey'),
    }
}

function projectUiPreference(value: unknown): JsonObject {
    const record = requiredRecord(value)
    const result: JsonObject = {}
    if (record.theme !== undefined) {
        if (record.theme !== 'light' && record.theme !== 'dark' && record.theme !== 'system') return invalid('theme')
        result.theme = record.theme
    }
    for (const key of UI_BOOLEAN_KEYS) {
        const projected = optionalBoolean(record, key)
        if (projected !== undefined) result[key] = projected
    }
    for (const key of UI_NUMBER_KEYS) {
        const projected = optionalNumber(record, key)
        if (projected !== undefined) {
            if (projected < 0 || projected > 4_096) return invalid(key)
            result[key] = projected
        }
    }
    if (Object.keys(result).length === 0) return invalid('preferences')
    return result
}

function optionalNullableString(record: Record<string, unknown>, key: string): string | null {
    if (record[key] === null || record[key] === undefined) return null
    return requiredString(record, key)
}

function assertExactProjectedKeys(record: Record<string, unknown>, allowed: readonly string[], field: string): void {
    if (Object.keys(record).some(key => !allowed.includes(key))) invalid(field)
}

function assertProjectedChecksum(value: unknown, field: string, nullable = false): void {
    if (nullable && value === null) return
    if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(value)) invalid(field)
}

function assertProjectedTimestamp(value: unknown, field: string): void {
    if (typeof value !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
        || !Number.isFinite(Date.parse(value))
        || new Date(value).toISOString() !== value) invalid(field)
}

function validateProjectedArtifactRecord(record: Record<string, unknown>): void {
    assertExactProjectedKeys(record, [
        'schemaVersion', 'artifactId', 'sourceJobId', 'sourceSceneId', 'outputCommitSetHash', 'original', 'distributionVariants',
        'contentChecksum', 'sanitizationPolicyVersion', 'createdAt', 'updatedAt', 'version',
    ], 'artifact-record')
    if (record.schemaVersion !== 1) invalid('schemaVersion')
    requiredString(record, 'artifactId')
    optionalNullableString(record, 'sourceJobId')
    optionalNullableString(record, 'sourceSceneId')
    assertProjectedChecksum(record.outputCommitSetHash ?? null, 'outputCommitSetHash', true)
    assertProjectedChecksum(record.contentChecksum, 'contentChecksum')
    requiredNumber(record, 'sanitizationPolicyVersion')
    assertProjectedTimestamp(record.createdAt, 'createdAt')
    assertProjectedTimestamp(record.updatedAt, 'updatedAt')
    const version = requiredNumber(record, 'version')
    if (!Number.isSafeInteger(version) || version < 1) invalid('version')

    const original = requiredRecord(record.original, 'original')
    assertExactProjectedKeys(original, ['variantId', 'format', 'contentChecksum', 'size', 'createdAt'], 'original')
    if (original.variantId !== 'original'
        || !['png', 'webp', 'jpeg'].includes(String(original.format))) invalid('original')
    assertProjectedChecksum(original.contentChecksum, 'original.contentChecksum')
    if (original.contentChecksum !== record.contentChecksum) invalid('original.contentChecksum')
    const originalSize = requiredNumber(original, 'size')
    if (!Number.isSafeInteger(originalSize) || originalSize < 0) invalid('original.size')
    assertProjectedTimestamp(original.createdAt, 'original.createdAt')

    if (!Array.isArray(record.distributionVariants)) invalid('distributionVariants')
    const variantIds = new Set<string>()
    for (const value of record.distributionVariants) {
        const variant = requiredRecord(value, 'distributionVariant')
        assertExactProjectedKeys(variant, [
            'variantId', 'status', 'requestedFileName', 'format', 'contentChecksum', 'size', 'sanitizationPolicyVersion',
            'createdAt', 'updatedAt', 'sidecarDigest',
        ], 'distributionVariant')
        const variantId = requiredString(variant, 'variantId')
        if (variantIds.has(variantId)) invalid('variantId')
        variantIds.add(variantId)
        if (!['pending', 'running', 'succeeded', 'failed', 'cancelled'].includes(String(variant.status))) invalid('status')
        const fileName = requiredString(variant, 'requestedFileName')
        if (/[\\/\0]/.test(fileName)) invalid('requestedFileName')
        if (!['png', 'webp'].includes(String(variant.format))) invalid('format')
        assertProjectedChecksum(variant.contentChecksum, 'variant.contentChecksum', true)
        if (variant.size !== null) {
            const size = requiredNumber(variant, 'size')
            if (!Number.isSafeInteger(size) || size < 0) invalid('variant.size')
        }
        requiredNumber(variant, 'sanitizationPolicyVersion')
        assertProjectedTimestamp(variant.createdAt, 'variant.createdAt')
        assertProjectedTimestamp(variant.updatedAt, 'variant.updatedAt')
        if (variant.sidecarDigest !== undefined) assertProjectedChecksum(variant.sidecarDigest, 'sidecarDigest')
    }
}

function projectArtifact(value: unknown): JsonObject {
    const record = requiredRecord(value)
    const originalCandidate = requiredRecord(record.original, 'original')
    if (originalCandidate.file === undefined && record.thumbnail === undefined) {
        validateProjectedArtifactRecord(record)
    } else {
        try {
            validateArtifactRecord(record as unknown as ArtifactRecord)
        } catch {
            return invalid('artifact-record')
        }
    }
    const original = originalCandidate
    const variants = Array.isArray(record.distributionVariants) ? record.distributionVariants : invalid('distributionVariants')
    return {
        schemaVersion: requiredNumber(record, 'schemaVersion'),
        artifactId: requiredString(record, 'artifactId'),
        sourceJobId: optionalNullableString(record, 'sourceJobId'),
        sourceSceneId: optionalNullableString(record, 'sourceSceneId'),
        outputCommitSetHash: optionalNullableString(record, 'outputCommitSetHash'),
        original: {
            variantId: requiredString(original, 'variantId'),
            format: requiredString(original, 'format'),
            contentChecksum: requiredString(original, 'contentChecksum'),
            size: requiredNumber(original, 'size'),
            createdAt: requiredString(original, 'createdAt'),
        },
        distributionVariants: variants.map((entry, index) => {
            const variant = requiredRecord(entry, `distributionVariants.${index}`)
            const sidecar = isRecord(variant.sidecar) ? variant.sidecar : null
            return {
                variantId: requiredString(variant, 'variantId'),
                status: requiredString(variant, 'status'),
                requestedFileName: requiredString(variant, 'requestedFileName'),
                format: requiredString(variant, 'format'),
                contentChecksum: optionalNullableString(variant, 'contentChecksum'),
                size: variant.size === null || variant.size === undefined ? null : requiredNumber(variant, 'size'),
                sanitizationPolicyVersion: requiredNumber(variant, 'sanitizationPolicyVersion'),
                createdAt: requiredString(variant, 'createdAt'),
                updatedAt: requiredString(variant, 'updatedAt'),
                ...(sidecar === null ? {} : { sidecarDigest: requiredString(sidecar, 'digest') }),
            } satisfies JsonObject
        }),
        contentChecksum: requiredString(record, 'contentChecksum'),
        sanitizationPolicyVersion: requiredNumber(record, 'sanitizationPolicyVersion'),
        createdAt: requiredString(record, 'createdAt'),
        updatedAt: requiredString(record, 'updatedAt'),
        version: requiredNumber(record, 'version'),
    }
}

function projectR2Object(value: unknown): JsonObject {
    const record = requiredRecord(value)
    if (record.state !== 'succeeded') return invalid('state')
    for (const key of ['profileId', 'artifactId', 'variantId']) {
        const identifier = requiredString(record, key)
        if (!/^[A-Za-z0-9:_-]{1,256}$/.test(identifier)) return invalid(key)
    }
    const remoteKey = requiredString(record, 'remoteKey')
    if (remoteKey.length > 1_024
        || remoteKey.startsWith('/')
        || remoteKey.split('/').some(segment => !segment || segment === '.' || segment === '..' || /[\\\0]/.test(segment))) {
        return invalid('remoteKey')
    }
    const updatedAt = requiredString(record, 'updatedAt')
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(updatedAt)
        || !Number.isFinite(Date.parse(updatedAt))
        || new Date(updatedAt).toISOString() !== updatedAt) return invalid('updatedAt')
    return {
        profileId: requiredString(record, 'profileId'),
        artifactId: requiredString(record, 'artifactId'),
        variantId: requiredString(record, 'variantId'),
        remoteKey,
        state: 'succeeded',
        updatedAt,
    }
}

function canonicalObject(value: JsonObject): JsonObject {
    return JSON.parse(canonicalSerialize(value)) as JsonObject
}

/** Entity allowlist projection followed by an invariant scan and canonical detach. */
export function sanitizeSyncPayload(entityType: SyncEntityType, value: unknown): JsonObject {
    let projected: JsonObject
    switch (entityType) {
        case 'composition.document':
        case 'composition.profile':
        case 'composition.recipe':
        case 'composition.module':
            projected = projectComposition(entityType, value)
            break
        case 'scene.preset': projected = projectScenePreset(value); break
        case 'scene.card': projected = projectSceneCard(value); break
        case 'prompt.preset': projected = projectPromptPreset(value); break
        case 'prompt.fragment': projected = projectFragment(value); break
        case 'ui.preference': projected = projectUiPreference(value); break
        case 'artifact.metadata': projected = projectArtifact(value); break
        case 'artifact.r2-object': projected = projectR2Object(value); break
        case 'generation.job-snapshot':
            throw new SyncSanitizationError(
                'E_SYNC_ENTITY_UNSUPPORTED',
                'Immutable generation snapshots have a conflict policy but are not an active Phase 11 sync target.',
            )
    }
    assertSyncPayloadSafe(projected)
    const canonical = canonicalObject(projected)
    assertSyncPayloadSafe(canonical)
    return canonical
}
