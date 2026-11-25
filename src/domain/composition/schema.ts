import { PRECISE_REFERENCE_CAPTIONS } from '@/domain/generation/precise-reference'
import { COMPOSITION_SCHEMA_VERSION, type CompositionDocument } from './types'

const SUPPORTED_SCHEMA_VERSION = COMPOSITION_SCHEMA_VERSION

type SchemaPathSegment = string | number

export type CompositionSchemaIssueCode =
    | 'duplicate_id'
    | 'invalid_discriminator'
    | 'invalid_json'
    | 'invalid_json_value'
    | 'invalid_schema_version'
    | 'invalid_type'
    | 'invalid_value'
    | 'missing_required'
    | 'unknown_key'
    | 'unsupported_schema_version'

export interface CompositionSchemaIssue {
    code: CompositionSchemaIssueCode
    path: readonly SchemaPathSegment[]
    message: string
    expected?: string
}

export type CompositionSchemaResult<T> =
    | { success: true; data: T }
    | {
        success: false
        error: CompositionSchemaError
        issues: readonly CompositionSchemaIssue[]
    }

function formatPath(path: readonly SchemaPathSegment[]): string {
    if (path.length === 0) return '$'

    return path.reduce<string>((formatted, segment) => {
        if (typeof segment === 'number') return `${formatted}[${segment}]`
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) return `${formatted}.${segment}`
        return `${formatted}[${JSON.stringify(segment)}]`
    }, '$')
}

export class CompositionSchemaError extends Error {
    readonly issues: readonly CompositionSchemaIssue[]

    constructor(issues: readonly CompositionSchemaIssue[], message = 'Composition document validation failed') {
        const detail = issues.length === 0
            ? ''
            : `: ${issues.map(issue => `${formatPath(issue.path)} ${issue.message}`).join('; ')}`
        super(`${message}${detail}`)
        this.name = 'CompositionSchemaError'
        this.issues = issues.map(issue => ({ ...issue, path: [...issue.path] }))
    }
}

interface ValidationContext {
    issues: CompositionSchemaIssue[]
    entityIds: Map<string, readonly SchemaPathSegment[]>
}

// Cross-references are validated as stable EntityId values, not resolved here.
// Missing/disabled/tombstoned targets are semantic ResolutionIssue cases for the future engine.

type UnknownRecord = Record<string, unknown>
type Validator = (value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext) => void

const ACTOR_KINDS = ['user', 'agent', 'system', 'service'] as const
const POSITIVE_PROMPT_SLOTS = [
    'base',
    'inpainting',
    'additional',
    'workflow',
    'scene',
    'style',
    'detail',
    'quality',
] as const
const CHARACTER_REFERENCE_TYPES = [...PRECISE_REFERENCE_CAPTIONS, 'delta', 'vibe'] as const
const SOURCE_MODES = ['text-to-image', 'image-to-image', 'inpaint'] as const
const RESOURCE_ROLES = [
    'source-image',
    'mask',
    'character-reference',
    'vibe-reference',
    'style-reference',
] as const
const COMPOSITION_ENTITY_KINDS = [
    'profile',
    'module',
    'recipe',
    'recipe-step',
    'prompt-contribution',
    'character',
    'params-preset',
    'resource',
    'random-rule',
] as const

const REVISION_KEYS = [
    'revision',
    'createdAt',
    'createdBy',
    'updatedAt',
    'updatedBy',
    'deletedAt',
] as const
const REVISIONED_ENTITY_KEYS = ['id', ...REVISION_KEYS, 'extensions'] as const
const ORDERED_ENTITY_KEYS = [...REVISIONED_ENTITY_KEYS, 'orderKey'] as const

function issue(
    context: ValidationContext,
    code: CompositionSchemaIssueCode,
    path: readonly SchemaPathSegment[],
    message: string,
    expected?: string,
): void {
    context.issues.push({ code, path: [...path], message, ...(expected === undefined ? {} : { expected }) })
}

function hasOwn(record: UnknownRecord, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(record, key)
}

function isPlainRecord(value: unknown): value is UnknownRecord {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function recordAt(
    value: unknown,
    path: readonly SchemaPathSegment[],
    context: ValidationContext,
): UnknownRecord | null {
    if (isPlainRecord(value)) return value
    issue(context, 'invalid_type', path, 'must be an object', 'object')
    return null
}

function rejectUnknownKeys(
    record: UnknownRecord,
    keys: readonly string[],
    path: readonly SchemaPathSegment[],
    context: ValidationContext,
): void {
    const allowed = new Set(keys)
    for (const key of Object.keys(record)) {
        if (!allowed.has(key)) {
            issue(context, 'unknown_key', [...path, key], 'is not a recognized field; preserve extension data under extensions')
        }
    }
}

function required(
    record: UnknownRecord,
    key: string,
    path: readonly SchemaPathSegment[],
    context: ValidationContext,
    validator: Validator,
): void {
    if (!hasOwn(record, key)) {
        issue(context, 'missing_required', [...path, key], 'is required')
        return
    }
    validator(record[key], [...path, key], context)
}

function optional(
    record: UnknownRecord,
    key: string,
    path: readonly SchemaPathSegment[],
    context: ValidationContext,
    validator: Validator,
): void {
    if (hasOwn(record, key)) validator(record[key], [...path, key], context)
}

function validateString(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    if (typeof value !== 'string') issue(context, 'invalid_type', path, 'must be a string', 'string')
}

function validateNonEmptyString(
    value: unknown,
    path: readonly SchemaPathSegment[],
    context: ValidationContext,
): value is string {
    if (typeof value !== 'string') {
        issue(context, 'invalid_type', path, 'must be a string', 'string')
        return false
    }
    if (value.trim().length === 0) {
        issue(context, 'invalid_value', path, 'must not be empty')
        return false
    }
    return true
}

function validateEntityId(
    value: unknown,
    path: readonly SchemaPathSegment[],
    context: ValidationContext,
): value is string {
    return validateNonEmptyString(value, path, context)
}

function validateBoolean(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    if (typeof value !== 'boolean') issue(context, 'invalid_type', path, 'must be a boolean', 'boolean')
}

function validateFiniteNumber(
    value: unknown,
    path: readonly SchemaPathSegment[],
    context: ValidationContext,
): value is number {
    if (typeof value !== 'number') {
        issue(context, 'invalid_type', path, 'must be a number', 'number')
        return false
    }
    if (!Number.isFinite(value)) {
        issue(context, 'invalid_value', path, 'must be finite')
        return false
    }
    return true
}

function validateInteger(
    value: unknown,
    path: readonly SchemaPathSegment[],
    context: ValidationContext,
): value is number {
    if (!validateFiniteNumber(value, path, context)) return false
    if (!Number.isSafeInteger(value)) {
        issue(context, 'invalid_value', path, 'must be a safe integer')
        return false
    }
    return true
}

function validateNonNegativeInteger(
    value: unknown,
    path: readonly SchemaPathSegment[],
    context: ValidationContext,
): boolean {
    if (!validateInteger(value, path, context)) return false
    if (value < 0) {
        issue(context, 'invalid_value', path, 'must be greater than or equal to 0')
        return false
    }
    return true
}

function validatePositiveInteger(
    value: unknown,
    path: readonly SchemaPathSegment[],
    context: ValidationContext,
): boolean {
    if (!validateInteger(value, path, context)) return false
    if (value <= 0) {
        issue(context, 'invalid_value', path, 'must be greater than 0')
        return false
    }
    return true
}

function validateEnum(
    value: unknown,
    allowed: readonly string[],
    path: readonly SchemaPathSegment[],
    context: ValidationContext,
): value is string {
    if (typeof value !== 'string') {
        issue(context, 'invalid_type', path, 'must be a string', allowed.join(' | '))
        return false
    }
    if (!allowed.includes(value)) {
        issue(context, 'invalid_value', path, `must be one of ${allowed.join(', ')}`, allowed.join(' | '))
        return false
    }
    return true
}

function validateIsoTimestamp(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    if (typeof value !== 'string') {
        issue(context, 'invalid_type', path, 'must be an ISO timestamp string', 'string')
        return
    }
    const looksLikeIsoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    if (!looksLikeIsoTimestamp || Number.isNaN(Date.parse(value))) {
        issue(context, 'invalid_value', path, 'must be a valid ISO 8601 timestamp')
    }
}

function validateExtensions(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    if (!isPlainRecord(value)) {
        issue(context, 'invalid_type', path, 'must be a JSON object', 'object')
    }
}

function validateArray(
    value: unknown,
    path: readonly SchemaPathSegment[],
    context: ValidationContext,
    validator: Validator,
): void {
    if (!Array.isArray(value)) {
        issue(context, 'invalid_type', path, 'must be an array', 'array')
        return
    }
    value.forEach((item, index) => validator(item, [...path, index], context))
}

function validateEntityIdArray(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    validateArray(value, path, context, validateEntityId)
}

function validatePathArray(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    validateArray(value, path, context, (segment, segmentPath, segmentContext) => {
        if (typeof segment === 'string') return
        if (validateNonNegativeInteger(segment, segmentPath, segmentContext)) return
        if (typeof segment !== 'number') {
            issue(segmentContext, 'invalid_type', segmentPath, 'must be a string or non-negative integer', 'string | number')
        }
    })
}

function validateJsonSafety(
    value: unknown,
    path: readonly SchemaPathSegment[],
    context: ValidationContext,
    ancestors: WeakSet<object>,
): void {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) issue(context, 'invalid_json_value', path, 'must be a finite JSON number')
        return
    }
    if (typeof value !== 'object') {
        issue(context, 'invalid_json_value', path, 'is not JSON-serializable')
        return
    }
    if (!Array.isArray(value) && !isPlainRecord(value)) {
        issue(context, 'invalid_json_value', path, 'must be a plain JSON object or array')
        return
    }
    if (ancestors.has(value)) {
        issue(context, 'invalid_json_value', path, 'must not contain a cyclic reference')
        return
    }

    ancestors.add(value)
    if (Array.isArray(value)) {
        value.forEach((item, index) => validateJsonSafety(item, [...path, index], context, ancestors))
    } else {
        for (const [key, item] of Object.entries(value)) {
            validateJsonSafety(item, [...path, key], context, ancestors)
        }
    }
    ancestors.delete(value)
}

function registerEntityId(
    id: string,
    path: readonly SchemaPathSegment[],
    context: ValidationContext,
): void {
    const previousPath = context.entityIds.get(id)
    if (previousPath) {
        issue(
            context,
            'duplicate_id',
            path,
            `duplicates entity ID first defined at ${formatPath(previousPath)}`,
        )
        return
    }
    context.entityIds.set(id, [...path])
}

function validateActorRef(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    const record = recordAt(value, path, context)
    if (!record) return
    rejectUnknownKeys(record, ['kind', 'id', 'displayName', 'extensions'], path, context)
    required(record, 'kind', path, context, (item, itemPath, itemContext) => {
        validateEnum(item, ACTOR_KINDS, itemPath, itemContext)
    })
    required(record, 'id', path, context, validateEntityId)
    optional(record, 'displayName', path, context, validateString)
    optional(record, 'extensions', path, context, validateExtensions)
}

function validateRevisionedEntityBase(
    record: UnknownRecord,
    path: readonly SchemaPathSegment[],
    context: ValidationContext,
    extraKeys: readonly string[],
    ordered: boolean,
): void {
    rejectUnknownKeys(
        record,
        [...(ordered ? ORDERED_ENTITY_KEYS : REVISIONED_ENTITY_KEYS), ...extraKeys],
        path,
        context,
    )

    if (!hasOwn(record, 'id')) {
        issue(context, 'missing_required', [...path, 'id'], 'is required')
    } else if (validateEntityId(record.id, [...path, 'id'], context)) {
        registerEntityId(record.id, [...path, 'id'], context)
    }
    required(record, 'revision', path, context, validateNonNegativeInteger)
    required(record, 'createdAt', path, context, validateIsoTimestamp)
    required(record, 'createdBy', path, context, validateActorRef)
    required(record, 'updatedAt', path, context, validateIsoTimestamp)
    required(record, 'updatedBy', path, context, validateActorRef)
    optional(record, 'deletedAt', path, context, validateIsoTimestamp)
    optional(record, 'extensions', path, context, validateExtensions)
    if (ordered) required(record, 'orderKey', path, context, validateNonEmptyString)
}

function validateProvenanceRef(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    const record = recordAt(value, path, context)
    if (!record) return
    if (!hasOwn(record, 'kind')) {
        issue(context, 'missing_required', [...path, 'kind'], 'is required')
        return
    }
    if (typeof record.kind !== 'string') {
        issue(context, 'invalid_type', [...path, 'kind'], 'must be a string discriminator', 'string')
        return
    }

    switch (record.kind) {
        case 'entity':
            rejectUnknownKeys(record, ['kind', 'entityKind', 'entityId', 'revision', 'path', 'extensions'], path, context)
            required(record, 'entityKind', path, context, (item, itemPath, itemContext) => {
                validateEnum(item, COMPOSITION_ENTITY_KINDS, itemPath, itemContext)
            })
            required(record, 'entityId', path, context, validateEntityId)
            required(record, 'revision', path, context, validateNonNegativeInteger)
            optional(record, 'path', path, context, validatePathArray)
            optional(record, 'extensions', path, context, validateExtensions)
            return
        case 'request':
            rejectUnknownKeys(record, ['kind', 'requestId', 'path', 'extensions'], path, context)
            required(record, 'requestId', path, context, validateEntityId)
            optional(record, 'path', path, context, validatePathArray)
            optional(record, 'extensions', path, context, validateExtensions)
            return
        case 'external':
            rejectUnknownKeys(record, ['kind', 'source', 'digest', 'path', 'extensions'], path, context)
            required(record, 'source', path, context, validateNonEmptyString)
            optional(record, 'digest', path, context, validateNonEmptyString)
            optional(record, 'path', path, context, validatePathArray)
            optional(record, 'extensions', path, context, validateExtensions)
            return
        default:
            issue(context, 'invalid_discriminator', [...path, 'kind'], 'must identify a supported provenance reference')
    }
}

function validateProvenanceArray(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    validateArray(value, path, context, validateProvenanceRef)
}

function validatePromptTarget(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    const record = recordAt(value, path, context)
    if (!record) return
    if (!hasOwn(record, 'kind')) {
        issue(context, 'missing_required', [...path, 'kind'], 'is required')
        return
    }

    switch (record.kind) {
        case 'positive':
            rejectUnknownKeys(record, ['kind', 'slot', 'extensions'], path, context)
            required(record, 'slot', path, context, (item, itemPath, itemContext) => {
                validateEnum(item, POSITIVE_PROMPT_SLOTS, itemPath, itemContext)
            })
            optional(record, 'extensions', path, context, validateExtensions)
            return
        case 'negative':
            rejectUnknownKeys(record, ['kind', 'extensions'], path, context)
            optional(record, 'extensions', path, context, validateExtensions)
            return
        case 'character':
            rejectUnknownKeys(record, ['kind', 'characterId', 'polarity', 'extensions'], path, context)
            required(record, 'characterId', path, context, validateEntityId)
            required(record, 'polarity', path, context, (item, itemPath, itemContext) => {
                validateEnum(item, ['positive', 'negative'], itemPath, itemContext)
            })
            optional(record, 'extensions', path, context, validateExtensions)
            return
        default:
            issue(context, 'invalid_discriminator', [...path, 'kind'], 'must identify a supported prompt target')
    }
}

function validatePromptContribution(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    const record = recordAt(value, path, context)
    if (!record) return
    validateRevisionedEntityBase(
        record,
        path,
        context,
        ['enabled', 'target', 'text', 'merge', 'separator', 'weight', 'randomRuleId', 'provenance'],
        true,
    )
    required(record, 'enabled', path, context, validateBoolean)
    required(record, 'target', path, context, validatePromptTarget)
    required(record, 'text', path, context, validateString)
    required(record, 'merge', path, context, (item, itemPath, itemContext) => {
        validateEnum(item, ['append', 'prepend', 'replace'], itemPath, itemContext)
    })
    optional(record, 'separator', path, context, (item, itemPath, itemContext) => {
        validateEnum(item, ['comma-space', 'space', 'newline', 'none'], itemPath, itemContext)
    })
    optional(record, 'weight', path, context, validateFiniteNumber)
    optional(record, 'randomRuleId', path, context, validateEntityId)
    optional(record, 'provenance', path, context, validateProvenanceArray)
}

function validatePromptContributionArray(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    validateArray(value, path, context, validatePromptContribution)
}

function validateCharacterPosition(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    const record = recordAt(value, path, context)
    if (!record) return

    switch (record.mode) {
        case 'ai-choice':
            rejectUnknownKeys(record, ['mode', 'extensions'], path, context)
            optional(record, 'extensions', path, context, validateExtensions)
            return
        case 'manual':
            rejectUnknownKeys(record, ['mode', 'x', 'y', 'extensions'], path, context)
            for (const key of ['x', 'y'] as const) {
                required(record, key, path, context, (item, itemPath, itemContext) => {
                    if (!validateFiniteNumber(item, itemPath, itemContext)) return
                    if (item < 0 || item > 1) {
                        issue(itemContext, 'invalid_value', itemPath, 'must be between 0 and 1 inclusive')
                    }
                })
            }
            optional(record, 'extensions', path, context, validateExtensions)
            return
        default:
            if (!hasOwn(record, 'mode')) {
                issue(context, 'missing_required', [...path, 'mode'], 'is required')
            } else {
                issue(context, 'invalid_discriminator', [...path, 'mode'], 'must be ai-choice or manual')
            }
    }
}

function validateResourceBinding(
    value: unknown,
    path: readonly SchemaPathSegment[],
    context: ValidationContext,
): void {
    const record = recordAt(value, path, context)
    if (!record) return
    rejectUnknownKeys(
        record,
        ['resourceId', 'enabled', 'referenceType', 'strength', 'fidelity', 'informationExtracted', 'extensions'],
        path,
        context,
    )
    required(record, 'resourceId', path, context, validateEntityId)
    required(record, 'enabled', path, context, validateBoolean)
    required(record, 'referenceType', path, context, (item, itemPath, itemContext) => {
        validateEnum(item, CHARACTER_REFERENCE_TYPES, itemPath, itemContext)
    })
    required(record, 'strength', path, context, validateFiniteNumber)
    optional(record, 'fidelity', path, context, validateFiniteNumber)
    optional(record, 'informationExtracted', path, context, validateFiniteNumber)
    optional(record, 'extensions', path, context, validateExtensions)
}

function validateResourceBindingArray(
    value: unknown,
    path: readonly SchemaPathSegment[],
    context: ValidationContext,
): void {
    validateArray(value, path, context, validateResourceBinding)
}

function validateCharacterDefinition(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    const record = recordAt(value, path, context)
    if (!record) return
    validateRevisionedEntityBase(
        record,
        path,
        context,
        ['name', 'enabled', 'positivePrompt', 'negativePrompt', 'position', 'resourceBindings'],
        true,
    )
    required(record, 'name', path, context, validateString)
    required(record, 'enabled', path, context, validateBoolean)
    required(record, 'positivePrompt', path, context, validateString)
    required(record, 'negativePrompt', path, context, validateString)
    required(record, 'position', path, context, validateCharacterPosition)
    required(record, 'resourceBindings', path, context, validateResourceBindingArray)
}

function validateCharacterSlotPatch(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    const record = recordAt(value, path, context)
    if (!record) return
    rejectUnknownKeys(
        record,
        [
            'characterId',
            'enabled',
            'positivePrompt',
            'negativePrompt',
            'position',
            'resourceBindings',
            'extensions',
        ],
        path,
        context,
    )
    required(record, 'characterId', path, context, validateEntityId)
    optional(record, 'enabled', path, context, validateBoolean)
    optional(record, 'positivePrompt', path, context, validateString)
    optional(record, 'negativePrompt', path, context, validateString)
    optional(record, 'position', path, context, validateCharacterPosition)
    optional(record, 'resourceBindings', path, context, validateResourceBindingArray)
    optional(record, 'extensions', path, context, validateExtensions)
}

function validateCharacterSlotPatchArray(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    validateArray(value, path, context, validateCharacterSlotPatch)
}

const PARAM_OVERRIDE_KEYS = [
    'model',
    'width',
    'height',
    'steps',
    'cfgScale',
    'cfgRescale',
    'sampler',
    'scheduler',
    'smea',
    'smeaDyn',
    'variety',
    'seed',
    'seedLocked',
    'qualityToggle',
    'ucPreset',
    'transparentBackground',
    'sourceMode',
    'sourceImageResourceId',
    'maskResourceId',
    'strength',
    'noise',
    'characterPositionEnabled',
    'extensions',
] as const

function validateParamsOverride(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    const record = recordAt(value, path, context)
    if (!record) return
    rejectUnknownKeys(record, PARAM_OVERRIDE_KEYS, path, context)
    optional(record, 'model', path, context, validateString)
    optional(record, 'width', path, context, validatePositiveInteger)
    optional(record, 'height', path, context, validatePositiveInteger)
    optional(record, 'steps', path, context, validatePositiveInteger)
    optional(record, 'cfgScale', path, context, validateFiniteNumber)
    optional(record, 'cfgRescale', path, context, validateFiniteNumber)
    optional(record, 'sampler', path, context, validateString)
    optional(record, 'scheduler', path, context, validateString)
    optional(record, 'smea', path, context, validateBoolean)
    optional(record, 'smeaDyn', path, context, validateBoolean)
    optional(record, 'variety', path, context, validateBoolean)
    optional(record, 'seed', path, context, validateNonNegativeInteger)
    optional(record, 'seedLocked', path, context, validateBoolean)
    optional(record, 'qualityToggle', path, context, validateBoolean)
    optional(record, 'ucPreset', path, context, validateNonNegativeInteger)
    optional(record, 'transparentBackground', path, context, validateBoolean)
    optional(record, 'sourceMode', path, context, (item, itemPath, itemContext) => {
        validateEnum(item, SOURCE_MODES, itemPath, itemContext)
    })
    optional(record, 'sourceImageResourceId', path, context, validateEntityId)
    optional(record, 'maskResourceId', path, context, validateEntityId)
    optional(record, 'strength', path, context, validateFiniteNumber)
    optional(record, 'noise', path, context, validateFiniteNumber)
    optional(record, 'characterPositionEnabled', path, context, validateBoolean)
    optional(record, 'extensions', path, context, validateExtensions)
}

function validateParamsPreset(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    const record = recordAt(value, path, context)
    if (!record) return
    validateRevisionedEntityBase(record, path, context, ['name', 'enabled', 'params'], true)
    required(record, 'name', path, context, validateString)
    required(record, 'enabled', path, context, validateBoolean)
    required(record, 'params', path, context, validateParamsOverride)
}

function validatePortablePathSegments(
    value: unknown,
    path: readonly SchemaPathSegment[],
    context: ValidationContext,
): void {
    validateArray(value, path, context, (segment, segmentPath, segmentContext) => {
        if (!validateNonEmptyString(segment, segmentPath, segmentContext)) return
        if (segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\') || segment.includes('\0')) {
            issue(segmentContext, 'invalid_value', segmentPath, 'must be a portable path segment without separators or traversal')
        }
    })
}

function validatePortablePathRef(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    const record = recordAt(value, path, context)
    if (!record) return

    switch (record.kind) {
        case 'standard':
            rejectUnknownKeys(record, ['kind', 'root', 'segments', 'displayPath', 'extensions'], path, context)
            required(record, 'root', path, context, (item, itemPath, itemContext) => {
                validateEnum(
                    item,
                    ['app-data', 'documents', 'pictures', 'downloads', 'media', 'cache'],
                    itemPath,
                    itemContext,
                )
            })
            required(record, 'segments', path, context, validatePortablePathSegments)
            optional(record, 'displayPath', path, context, validateString)
            optional(record, 'extensions', path, context, validateExtensions)
            return
        case 'bookmark':
            rejectUnknownKeys(record, ['kind', 'bookmarkId', 'segments', 'displayPath', 'extensions'], path, context)
            required(record, 'bookmarkId', path, context, validateEntityId)
            required(record, 'segments', path, context, validatePortablePathSegments)
            optional(record, 'displayPath', path, context, validateString)
            optional(record, 'extensions', path, context, validateExtensions)
            return
        default:
            if (!hasOwn(record, 'kind')) {
                issue(context, 'missing_required', [...path, 'kind'], 'is required')
            } else {
                issue(context, 'invalid_discriminator', [...path, 'kind'], 'must be standard or bookmark')
            }
    }
}

function validateResourceContentHash(
    value: unknown,
    path: readonly SchemaPathSegment[],
    context: ValidationContext,
): void {
    const record = recordAt(value, path, context)
    if (!record) return
    rejectUnknownKeys(record, ['algorithm', 'value'], path, context)
    required(record, 'algorithm', path, context, (item, itemPath, itemContext) => {
        validateEnum(item, ['sha256'], itemPath, itemContext)
    })
    required(record, 'value', path, context, (item, itemPath, itemContext) => {
        if (!validateNonEmptyString(item, itemPath, itemContext)) return
        if (!/^[0-9a-f]{64}$/.test(item)) {
            issue(itemContext, 'invalid_value', itemPath, 'must be a lower-case, unprefixed SHA-256 digest')
        }
    })
}

function validateOutputDestination(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    const record = recordAt(value, path, context)
    if (!record) return
    switch (record.kind) {
        case 'memory':
            rejectUnknownKeys(record, ['kind', 'extensions'], path, context)
            optional(record, 'extensions', path, context, validateExtensions)
            return
        case 'filesystem':
            rejectUnknownKeys(record, ['kind', 'directory', 'extensions'], path, context)
            required(record, 'directory', path, context, validatePortablePathRef)
            optional(record, 'extensions', path, context, validateExtensions)
            return
        default:
            if (!hasOwn(record, 'kind')) {
                issue(context, 'missing_required', [...path, 'kind'], 'is required')
            } else {
                issue(context, 'invalid_discriminator', [...path, 'kind'], 'must be memory or filesystem')
            }
    }
}

function validateFilenameTemplate(
    value: unknown,
    path: readonly SchemaPathSegment[],
    context: ValidationContext,
): void {
    if (!validateNonEmptyString(value, path, context)) return
    if (value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) {
        issue(context, 'invalid_value', path, 'must be a portable basename template without path traversal')
    }
}

function validateOutputPolicy(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    const record = recordAt(value, path, context)
    if (!record) return
    rejectUnknownKeys(
        record,
        ['destination', 'format', 'filenameTemplate', 'metadataMode', 'collisionPolicy', 'extensions'],
        path,
        context,
    )
    required(record, 'destination', path, context, validateOutputDestination)
    required(record, 'format', path, context, (item, itemPath, itemContext) => {
        validateEnum(item, ['png', 'webp'], itemPath, itemContext)
    })
    required(record, 'filenameTemplate', path, context, validateFilenameTemplate)
    required(record, 'metadataMode', path, context, (item, itemPath, itemContext) => {
        validateEnum(item, ['embedded', 'sidecar-only', 'strip-and-sidecar', 'strip-only'], itemPath, itemContext)
    })
    required(record, 'collisionPolicy', path, context, (item, itemPath, itemContext) => {
        validateEnum(item, ['unique', 'overwrite', 'error'], itemPath, itemContext)
    })
    optional(record, 'extensions', path, context, validateExtensions)
}

function validateResourceRef(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    const record = recordAt(value, path, context)
    if (!record) return
    const commonKeys = ['kind', 'enabled', 'role', 'mimeType', 'contentHash', 'digest'] as const

    switch (record.kind) {
        case 'managed':
            validateRevisionedEntityBase(record, path, context, [...commonKeys, 'resourceId'], true)
            required(record, 'resourceId', path, context, validateEntityId)
            break
        case 'library-image':
            validateRevisionedEntityBase(record, path, context, [...commonKeys, 'libraryImageId'], true)
            required(record, 'libraryImageId', path, context, validateEntityId)
            break
        case 'path':
            validateRevisionedEntityBase(record, path, context, [...commonKeys, 'path'], true)
            required(record, 'path', path, context, validatePortablePathRef)
            break
        case 'uri':
            validateRevisionedEntityBase(record, path, context, [...commonKeys, 'uri'], true)
            required(record, 'uri', path, context, validateNonEmptyString)
            break
        default:
            if (!hasOwn(record, 'kind')) {
                issue(context, 'missing_required', [...path, 'kind'], 'is required')
            } else {
                issue(context, 'invalid_discriminator', [...path, 'kind'], 'must be managed, library-image, path, or uri')
            }
            return
    }

    required(record, 'enabled', path, context, validateBoolean)
    required(record, 'role', path, context, (item, itemPath, itemContext) => {
        validateEnum(item, RESOURCE_ROLES, itemPath, itemContext)
    })
    optional(record, 'mimeType', path, context, validateNonEmptyString)
    optional(record, 'contentHash', path, context, validateResourceContentHash)
    optional(record, 'digest', path, context, validateNonEmptyString)
}

function validateRandomScalar(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    if (typeof value === 'string' || typeof value === 'boolean') return
    if (typeof value === 'number') {
        validateFiniteNumber(value, path, context)
        return
    }
    issue(context, 'invalid_type', path, 'must be a string, number, or boolean', 'string | number | boolean')
}

function validateRandomChoiceOption(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    const record = recordAt(value, path, context)
    if (!record) return
    rejectUnknownKeys(record, ['id', 'orderKey', 'value', 'weight', 'extensions'], path, context)
    if (!hasOwn(record, 'id')) {
        issue(context, 'missing_required', [...path, 'id'], 'is required')
    } else if (validateEntityId(record.id, [...path, 'id'], context)) {
        registerEntityId(record.id, [...path, 'id'], context)
    }
    required(record, 'orderKey', path, context, validateNonEmptyString)
    required(record, 'value', path, context, validateRandomScalar)
    required(record, 'weight', path, context, (item, itemPath, itemContext) => {
        if (validateFiniteNumber(item, itemPath, itemContext) && item < 0) {
            issue(itemContext, 'invalid_value', itemPath, 'must be greater than or equal to 0')
        }
    })
    optional(record, 'extensions', path, context, validateExtensions)
}

function validateRandomTraceEntry(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    const record = recordAt(value, path, context)
    if (!record) return
    rejectUnknownKeys(
        record,
        ['ruleId', 'streamKey', 'drawIndex', 'seed', 'result', 'selectedOptionIds', 'provenance', 'extensions'],
        path,
        context,
    )
    required(record, 'ruleId', path, context, validateEntityId)
    required(record, 'streamKey', path, context, validateString)
    required(record, 'drawIndex', path, context, validateNonNegativeInteger)
    required(record, 'seed', path, context, validateInteger)
    required(record, 'result', path, context, validateRandomScalar)
    optional(record, 'selectedOptionIds', path, context, validateEntityIdArray)
    optional(record, 'provenance', path, context, validateProvenanceRef)
    optional(record, 'extensions', path, context, validateExtensions)
}

function validateRandomSourcePolicy(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    const record = recordAt(value, path, context)
    if (!record) return

    switch (record.mode) {
        case 'runtime':
            rejectUnknownKeys(record, ['mode', 'extensions'], path, context)
            optional(record, 'extensions', path, context, validateExtensions)
            return
        case 'fixed':
            rejectUnknownKeys(record, ['mode', 'seed', 'extensions'], path, context)
            required(record, 'seed', path, context, validateInteger)
            optional(record, 'extensions', path, context, validateExtensions)
            return
        case 'seeded':
            rejectUnknownKeys(record, ['mode', 'seed', 'algorithm', 'extensions'], path, context)
            required(record, 'seed', path, context, validateInteger)
            required(record, 'algorithm', path, context, (item, itemPath, itemContext) => {
                validateEnum(item, ['xorshift32-v1'], itemPath, itemContext)
            })
            optional(record, 'extensions', path, context, validateExtensions)
            return
        case 'replay':
            rejectUnknownKeys(record, ['mode', 'entries', 'extensions'], path, context)
            required(record, 'entries', path, context, (item, itemPath, itemContext) => {
                validateArray(item, itemPath, itemContext, validateRandomTraceEntry)
            })
            optional(record, 'extensions', path, context, validateExtensions)
            return
        default:
            if (!hasOwn(record, 'mode')) {
                issue(context, 'missing_required', [...path, 'mode'], 'is required')
            } else {
                issue(context, 'invalid_discriminator', [...path, 'mode'], 'must identify a supported random source')
            }
    }
}

function validateRandomRule(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    const record = recordAt(value, path, context)
    if (!record) return
    const commonKeys = ['kind', 'enabled', 'streamKey', 'scope', 'source'] as const

    switch (record.kind) {
        case 'choice':
            validateRevisionedEntityBase(
                record,
                path,
                context,
                [...commonKeys, 'options', 'pickCount', 'withoutReplacement'],
                true,
            )
            required(record, 'options', path, context, (item, itemPath, itemContext) => {
                validateArray(item, itemPath, itemContext, validateRandomChoiceOption)
            })
            required(record, 'pickCount', path, context, validateNonNegativeInteger)
            required(record, 'withoutReplacement', path, context, validateBoolean)
            break
        case 'integer-range':
            validateRevisionedEntityBase(record, path, context, [...commonKeys, 'min', 'max', 'step'], true)
            required(record, 'min', path, context, validateInteger)
            required(record, 'max', path, context, validateInteger)
            required(record, 'step', path, context, (item, itemPath, itemContext) => {
                if (validateInteger(item, itemPath, itemContext) && item <= 0) {
                    issue(itemContext, 'invalid_value', itemPath, 'must be greater than 0')
                }
            })
            if (typeof record.min === 'number' && typeof record.max === 'number' && record.min > record.max) {
                issue(context, 'invalid_value', [...path, 'max'], 'must be greater than or equal to min')
            }
            break
        case 'decimal-range':
            validateRevisionedEntityBase(record, path, context, [...commonKeys, 'min', 'max'], true)
            required(record, 'min', path, context, validateFiniteNumber)
            required(record, 'max', path, context, validateFiniteNumber)
            if (typeof record.min === 'number' && typeof record.max === 'number' && record.min > record.max) {
                issue(context, 'invalid_value', [...path, 'max'], 'must be greater than or equal to min')
            }
            break
        case 'boolean':
            validateRevisionedEntityBase(record, path, context, [...commonKeys, 'probability'], true)
            required(record, 'probability', path, context, (item, itemPath, itemContext) => {
                if (!validateFiniteNumber(item, itemPath, itemContext)) return
                if (item < 0 || item > 1) {
                    issue(itemContext, 'invalid_value', itemPath, 'must be between 0 and 1 inclusive')
                }
            })
            break
        default:
            if (!hasOwn(record, 'kind')) {
                issue(context, 'missing_required', [...path, 'kind'], 'is required')
            } else {
                issue(context, 'invalid_discriminator', [...path, 'kind'], 'must identify a supported random rule')
            }
            return
    }

    required(record, 'enabled', path, context, validateBoolean)
    required(record, 'streamKey', path, context, validateString)
    required(record, 'scope', path, context, (item, itemPath, itemContext) => {
        validateEnum(
            item,
            ['generation-seed', 'prompt-wildcard', 'character-rotation', 'filename', 'parameter'],
            itemPath,
            itemContext,
        )
    })
    required(record, 'source', path, context, validateRandomSourcePolicy)
}

function validateCompositionModule(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    const record = recordAt(value, path, context)
    if (!record) return
    validateRevisionedEntityBase(
        record,
        path,
        context,
        [
            'name',
            'enabled',
            'kind',
            'contributions',
            'characterPatches',
            'paramsOverride',
            'outputPolicy',
            'resourceBindings',
            'randomRuleIds',
        ],
        true,
    )
    required(record, 'name', path, context, validateString)
    required(record, 'enabled', path, context, validateBoolean)
    required(record, 'kind', path, context, (item, itemPath, itemContext) => {
        validateEnum(item, ['prompt', 'character', 'params', 'output', 'composite'], itemPath, itemContext)
    })
    required(record, 'contributions', path, context, validatePromptContributionArray)
    required(record, 'characterPatches', path, context, validateCharacterSlotPatchArray)
    optional(record, 'paramsOverride', path, context, validateParamsOverride)
    optional(record, 'outputPolicy', path, context, validateOutputPolicy)
    required(record, 'resourceBindings', path, context, validateResourceBindingArray)
    required(record, 'randomRuleIds', path, context, validateEntityIdArray)
}

function validateRecipeStep(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    const record = recordAt(value, path, context)
    if (!record) return
    validateRevisionedEntityBase(
        record,
        path,
        context,
        [
            'moduleId',
            'enabled',
            'contributions',
            'characterPatches',
            'paramsOverride',
            'outputPolicy',
            'resourceBindings',
            'randomRuleIds',
        ],
        true,
    )
    required(record, 'moduleId', path, context, validateEntityId)
    required(record, 'enabled', path, context, validateBoolean)
    required(record, 'contributions', path, context, validatePromptContributionArray)
    required(record, 'characterPatches', path, context, validateCharacterSlotPatchArray)
    optional(record, 'paramsOverride', path, context, validateParamsOverride)
    optional(record, 'outputPolicy', path, context, validateOutputPolicy)
    required(record, 'resourceBindings', path, context, validateResourceBindingArray)
    required(record, 'randomRuleIds', path, context, validateEntityIdArray)
}

function validateCompositionRecipe(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    const record = recordAt(value, path, context)
    if (!record) return
    validateRevisionedEntityBase(
        record,
        path,
        context,
        ['name', 'enabled', 'steps', 'paramsOverride', 'outputPolicy'],
        true,
    )
    required(record, 'name', path, context, validateString)
    required(record, 'enabled', path, context, validateBoolean)
    required(record, 'steps', path, context, (item, itemPath, itemContext) => {
        validateArray(item, itemPath, itemContext, validateRecipeStep)
    })
    optional(record, 'paramsOverride', path, context, validateParamsOverride)
    optional(record, 'outputPolicy', path, context, validateOutputPolicy)
}

function validateCompositionProfile(value: unknown, path: readonly SchemaPathSegment[], context: ValidationContext): void {
    const record = recordAt(value, path, context)
    if (!record) return
    validateRevisionedEntityBase(
        record,
        path,
        context,
        [
            'name',
            'enabled',
            'moduleIds',
            'recipeIds',
            'characterIds',
            'paramsPresetIds',
            'resourceBindings',
            'randomRuleIds',
            'defaultRecipeId',
            'defaultParamsPresetId',
            'contributions',
            'characterPatches',
            'paramsOverride',
            'outputPolicy',
        ],
        true,
    )
    required(record, 'name', path, context, validateString)
    required(record, 'enabled', path, context, validateBoolean)
    required(record, 'moduleIds', path, context, validateEntityIdArray)
    required(record, 'recipeIds', path, context, validateEntityIdArray)
    required(record, 'characterIds', path, context, validateEntityIdArray)
    required(record, 'paramsPresetIds', path, context, validateEntityIdArray)
    required(record, 'resourceBindings', path, context, validateResourceBindingArray)
    required(record, 'randomRuleIds', path, context, validateEntityIdArray)
    optional(record, 'defaultRecipeId', path, context, validateEntityId)
    optional(record, 'defaultParamsPresetId', path, context, validateEntityId)
    required(record, 'contributions', path, context, validatePromptContributionArray)
    required(record, 'characterPatches', path, context, validateCharacterSlotPatchArray)
    optional(record, 'paramsOverride', path, context, validateParamsOverride)
    required(record, 'outputPolicy', path, context, validateOutputPolicy)
}

function validateCompositionDocumentStructure(
    value: unknown,
    path: readonly SchemaPathSegment[],
    context: ValidationContext,
): void {
    const record = recordAt(value, path, context)
    if (!record) return
    validateRevisionedEntityBase(
        record,
        path,
        context,
        [
            'schemaVersion',
            'profiles',
            'modules',
            'recipes',
            'characters',
            'paramsPresets',
            'resources',
            'randomRules',
            'activeProfileId',
        ],
        false,
    )
    required(record, 'schemaVersion', path, context, (item, itemPath, itemContext) => {
        if (item !== SUPPORTED_SCHEMA_VERSION) {
            issue(itemContext, 'invalid_schema_version', itemPath, `must equal ${SUPPORTED_SCHEMA_VERSION}`)
        }
    })
    required(record, 'profiles', path, context, (item, itemPath, itemContext) => {
        validateArray(item, itemPath, itemContext, validateCompositionProfile)
    })
    required(record, 'modules', path, context, (item, itemPath, itemContext) => {
        validateArray(item, itemPath, itemContext, validateCompositionModule)
    })
    required(record, 'recipes', path, context, (item, itemPath, itemContext) => {
        validateArray(item, itemPath, itemContext, validateCompositionRecipe)
    })
    required(record, 'characters', path, context, (item, itemPath, itemContext) => {
        validateArray(item, itemPath, itemContext, validateCharacterDefinition)
    })
    required(record, 'paramsPresets', path, context, (item, itemPath, itemContext) => {
        validateArray(item, itemPath, itemContext, validateParamsPreset)
    })
    required(record, 'resources', path, context, (item, itemPath, itemContext) => {
        validateArray(item, itemPath, itemContext, validateResourceRef)
    })
    required(record, 'randomRules', path, context, (item, itemPath, itemContext) => {
        validateArray(item, itemPath, itemContext, validateRandomRule)
    })
    optional(record, 'activeProfileId', path, context, validateEntityId)
}

function schemaVersionIssues(value: unknown): CompositionSchemaIssue[] {
    const context: ValidationContext = { issues: [], entityIds: new Map() }
    if (!isPlainRecord(value)) {
        issue(context, 'invalid_type', [], 'must be an object', 'object')
        return context.issues
    }
    if (!hasOwn(value, 'schemaVersion')) {
        issue(context, 'missing_required', ['schemaVersion'], 'is required')
        return context.issues
    }
    const version = value.schemaVersion
    if (typeof version !== 'number' || !Number.isSafeInteger(version)) {
        issue(context, 'invalid_schema_version', ['schemaVersion'], 'must be the integer 2', '2')
    } else if (version > SUPPORTED_SCHEMA_VERSION) {
        issue(
            context,
            'unsupported_schema_version',
            ['schemaVersion'],
            `schema version ${version} is newer than supported version ${SUPPORTED_SCHEMA_VERSION}`,
            String(SUPPORTED_SCHEMA_VERSION),
        )
    } else if (version !== SUPPORTED_SCHEMA_VERSION) {
        issue(
            context,
            'invalid_schema_version',
            ['schemaVersion'],
            `must equal ${SUPPORTED_SCHEMA_VERSION}`,
            String(SUPPORTED_SCHEMA_VERSION),
        )
    }
    return context.issues
}

export function parseCompositionDocument(value: unknown): CompositionDocument {
    const versionIssues = schemaVersionIssues(value)
    if (versionIssues.length > 0) throw new CompositionSchemaError(versionIssues)

    const context: ValidationContext = { issues: [], entityIds: new Map() }
    validateJsonSafety(value, [], context, new WeakSet())
    if (context.issues.length === 0) {
        validateCompositionDocumentStructure(value, [], context)
    }
    if (context.issues.length > 0) throw new CompositionSchemaError(context.issues)

    return value as CompositionDocument
}

export function safeParseCompositionDocument(value: unknown): CompositionSchemaResult<CompositionDocument> {
    try {
        return { success: true, data: parseCompositionDocument(value) }
    } catch (error) {
        if (!(error instanceof CompositionSchemaError)) throw error
        return { success: false, error, issues: error.issues }
    }
}

export function isCompositionDocument(value: unknown): value is CompositionDocument {
    return safeParseCompositionDocument(value).success
}

export function serializeCompositionDocument(document: CompositionDocument): string {
    return JSON.stringify(parseCompositionDocument(document))
}

export function deserializeCompositionDocument(source: string): CompositionDocument {
    if (typeof source !== 'string') {
        throw new CompositionSchemaError([
            {
                code: 'invalid_type',
                path: [],
                message: 'serialized composition document must be a string',
                expected: 'string',
            },
        ])
    }

    let value: unknown
    try {
        value = JSON.parse(source)
    } catch {
        throw new CompositionSchemaError([
            {
                code: 'invalid_json',
                path: [],
                message: 'must contain valid JSON',
            },
        ], 'Composition document deserialization failed')
    }
    return parseCompositionDocument(value)
}

export const compositionDocumentSchema = Object.freeze({
    parse: parseCompositionDocument,
    safeParse: safeParseCompositionDocument,
    is: isCompositionDocument,
})
