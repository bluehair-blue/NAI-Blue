import type {
    ActorRef,
    CharacterSlotPatch,
    JsonValue,
    ParamsOverride,
    PromptContribution,
    ProvenanceRef,
} from '@/domain/composition/types'
import type {
    CommitResult,
    SceneAuthoringRecord,
    SceneCompositionRef,
    SceneDocument,
    SceneRepositoryPort,
} from './scene-repository'
import { PRECISE_REFERENCE_CAPTIONS } from '@/domain/generation/precise-reference'
import { resolveScenes, type ResolvedSceneAuthoring } from './resolve-scenes'

export type SceneParameter =
    | 'model'
    | 'width'
    | 'height'
    | 'steps'
    | 'cfgScale'
    | 'cfgRescale'
    | 'sampler'
    | 'scheduler'
    | 'ucPreset'
    | 'seed'

/** Deliberately narrow Agent/UI mutation vocabulary; arbitrary partial config is not accepted. */
export type ScenePatch =
    | { readonly op: 'set-prompt-contribution'; readonly contribution: PromptContribution }
    | { readonly op: 'remove-prompt-contribution'; readonly contributionId: string }
    | { readonly op: 'set-parameter'; readonly field: SceneParameter; readonly value: number | string }
    | { readonly op: 'inherit-parameter'; readonly field: SceneParameter }
    | {
        readonly op: 'set-character-caption'
        readonly characterId: string
        readonly prompt: string
        readonly negative: string
        readonly position?: { readonly x: number; readonly y: number }
    }
    | { readonly op: 'assign-recipe'; readonly recipeId: string; readonly recipeRevision: number }

export interface ScenePatchSet {
    readonly sceneId: string
    readonly patches: readonly ScenePatch[]
}

export interface PatchScenesInput {
    readonly repository: SceneRepositoryPort
    readonly presetId: string
    readonly expectedRevision: number
    readonly scenePatches: readonly ScenePatchSet[]
    readonly now?: string | (() => string)
}

export type PatchScenesResult =
    | {
        readonly status: 'COMMITTED'
        readonly document: SceneDocument
        readonly scenes: readonly ResolvedSceneAuthoring[]
    }
    | {
        readonly status: 'REVISION_CONFLICT'
        readonly current: SceneDocument | null
        readonly scenes: readonly ResolvedSceneAuthoring[]
    }
    | { readonly status: 'NOT_FOUND'; readonly presetId: string }
    | {
        readonly status: 'INVALID'
        readonly current: SceneDocument
        readonly code: 'INVALID_INPUT' | 'SCENE_NOT_FOUND' | 'INVALID_PATCH'
        readonly sceneId?: string
        readonly patchIndex?: number
        readonly message: string
    }
    | { readonly status: 'STORAGE_CONFLICT'; readonly current: SceneDocument }

const DIRECT_RECIPE_ID = 'scene:direct'
const STRING_PARAMETERS = new Set<SceneParameter>(['model', 'sampler', 'scheduler'])
const NUMBER_PARAMETERS = new Set<SceneParameter>([
    'width', 'height', 'steps', 'cfgScale', 'cfgRescale', 'ucPreset', 'seed',
])
const PARAM_RANGES: Partial<Record<SceneParameter, { min: number; max?: number; integer?: boolean }>> = {
    width: { min: 1, integer: true },
    height: { min: 1, integer: true },
    steps: { min: 1, integer: true },
    cfgScale: { min: 0 },
    cfgRescale: { min: 0, max: 1 },
    ucPreset: { min: 0, integer: true },
    seed: { min: 0, max: 0xffff_ffff, integer: true },
}

class InvalidScenePatch extends TypeError {
    constructor(
        message: string,
        readonly code: 'INVALID_INPUT' | 'SCENE_NOT_FOUND' | 'INVALID_PATCH' = 'INVALID_PATCH',
        readonly sceneId?: string,
        readonly patchIndex?: number,
    ) {
        super(message)
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
    const keys = new Set(allowed)
    return Object.keys(value).every(key => keys.has(key))
}

function isId(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0
}

function isIsoTimestamp(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value))
}

function isJsonValue(value: unknown): value is JsonValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
    if (typeof value === 'number') return Number.isFinite(value)
    if (Array.isArray(value)) return value.every(isJsonValue)
    return isRecord(value) && Object.values(value).every(isJsonValue)
}

function isActor(value: unknown): value is ActorRef {
    return isRecord(value)
        && hasOnlyKeys(value, ['kind', 'id', 'displayName', 'extensions'])
        && ['user', 'agent', 'system', 'service'].includes(value.kind as string)
        && isId(value.id)
        && (value.displayName === undefined || typeof value.displayName === 'string')
        && (value.extensions === undefined || (isRecord(value.extensions) && isJsonValue(value.extensions)))
}

function isProvenance(value: unknown): value is ProvenanceRef {
    if (!isRecord(value)) return false
    switch (value.kind) {
        case 'entity':
            return hasOnlyKeys(value, ['kind', 'entityKind', 'entityId', 'revision', 'extensions'])
                && typeof value.entityKind === 'string' && isId(value.entityId)
                && Number.isSafeInteger(value.revision) && Number(value.revision) >= 0
                && (value.extensions === undefined || isJsonValue(value.extensions))
        case 'request':
            return hasOnlyKeys(value, ['kind', 'requestId', 'extensions'])
                && isId(value.requestId)
                && (value.extensions === undefined || isJsonValue(value.extensions))
        case 'external':
            return hasOnlyKeys(value, ['kind', 'source', 'digest', 'extensions'])
                && isId(value.source)
                && (value.digest === undefined || typeof value.digest === 'string')
                && (value.extensions === undefined || isJsonValue(value.extensions))
        default:
            return false
    }
}

function isPromptContribution(value: unknown): value is PromptContribution {
    if (!isRecord(value) || !isJsonValue(value) || !hasOnlyKeys(value, [
        'id', 'orderKey', 'revision', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'deletedAt',
        'extensions', 'enabled', 'target', 'text', 'merge', 'separator', 'weight', 'randomRuleId', 'provenance',
    ])) return false
    const target = value.target
    const targetValid = isRecord(target) && (
        (target.kind === 'positive'
            && hasOnlyKeys(target, ['kind', 'slot', 'extensions'])
            && ['base', 'inpainting', 'additional', 'workflow', 'scene', 'style', 'detail', 'quality']
                .includes(target.slot as string))
        || (target.kind === 'negative' && hasOnlyKeys(target, ['kind', 'extensions']))
        || (target.kind === 'character'
            && hasOnlyKeys(target, ['kind', 'characterId', 'polarity', 'extensions'])
            && isId(target.characterId) && ['positive', 'negative'].includes(target.polarity as string))
    ) && (target.extensions === undefined || isJsonValue(target.extensions))
    return isId(value.id) && isId(value.orderKey)
        && Number.isSafeInteger(value.revision) && Number(value.revision) >= 0
        && isIsoTimestamp(value.createdAt) && isActor(value.createdBy)
        && isIsoTimestamp(value.updatedAt) && isActor(value.updatedBy)
        && (value.deletedAt === undefined || isIsoTimestamp(value.deletedAt))
        && (value.extensions === undefined || isJsonValue(value.extensions))
        && typeof value.enabled === 'boolean' && targetValid && typeof value.text === 'string'
        && ['append', 'prepend', 'replace'].includes(value.merge as string)
        && (value.separator === undefined
            || ['comma-space', 'space', 'newline', 'none'].includes(value.separator as string))
        && (value.weight === undefined || (typeof value.weight === 'number' && Number.isFinite(value.weight)))
        && (value.randomRuleId === undefined || isId(value.randomRuleId))
        && (value.provenance === undefined
            || (Array.isArray(value.provenance) && value.provenance.every(isProvenance)))
}

function isPosition(value: unknown): value is { x: number; y: number } {
    return isRecord(value) && hasOnlyKeys(value, ['x', 'y'])
        && typeof value.x === 'number' && Number.isFinite(value.x) && value.x >= 0 && value.x <= 1
        && typeof value.y === 'number' && Number.isFinite(value.y) && value.y >= 0 && value.y <= 1
}

function isCharacterOverride(value: unknown): value is CharacterSlotPatch {
    if (!isRecord(value) || !hasOnlyKeys(value, [
        'characterId', 'enabled', 'positivePrompt', 'negativePrompt', 'position', 'resourceBindings', 'extensions',
    ]) || !isId(value.characterId)) return false
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean') return false
    if (value.positivePrompt !== undefined && typeof value.positivePrompt !== 'string') return false
    if (value.negativePrompt !== undefined && typeof value.negativePrompt !== 'string') return false
    if (value.position !== undefined) {
        if (!isRecord(value.position)) return false
        if (value.position.mode === 'ai-choice') {
            if (!hasOnlyKeys(value.position, ['mode', 'extensions'])) return false
        } else if (value.position.mode === 'manual') {
            if (!hasOnlyKeys(value.position, ['mode', 'x', 'y', 'extensions'])
                || !isPosition({ x: value.position.x, y: value.position.y })) return false
        } else return false
        if (value.position.extensions !== undefined && !isJsonValue(value.position.extensions)) return false
    }
    return (value.resourceBindings === undefined
            || (Array.isArray(value.resourceBindings) && value.resourceBindings.every(binding => (
                isRecord(binding) && hasOnlyKeys(binding, [
                    'resourceId', 'enabled', 'referenceType', 'strength', 'fidelity',
                    'informationExtracted', 'extensions',
                ]) && isId(binding.resourceId) && typeof binding.enabled === 'boolean'
                && [...PRECISE_REFERENCE_CAPTIONS, 'delta', 'vibe'].includes(binding.referenceType as string)
                && typeof binding.strength === 'number' && Number.isFinite(binding.strength)
                && (binding.fidelity === undefined
                    || (typeof binding.fidelity === 'number' && Number.isFinite(binding.fidelity)))
                && (binding.informationExtracted === undefined
                    || (typeof binding.informationExtracted === 'number' && Number.isFinite(binding.informationExtracted)))
                && (binding.extensions === undefined || isJsonValue(binding.extensions))
            ))))
        && (value.extensions === undefined || isJsonValue(value.extensions))
}

function isParamsOverride(value: unknown): value is ParamsOverride {
    if (!isRecord(value) || !hasOnlyKeys(value, [
        'model', 'width', 'height', 'steps', 'cfgScale', 'cfgRescale', 'sampler', 'scheduler', 'smea', 'smeaDyn',
        'variety', 'seed', 'seedLocked', 'qualityToggle', 'ucPreset', 'transparentBackground', 'sourceMode',
        'sourceImageResourceId', 'maskResourceId', 'strength', 'noise', 'characterPositionEnabled', 'extensions',
    ])) return false
    for (const key of ['model', 'sampler', 'scheduler', 'sourceImageResourceId', 'maskResourceId'] as const) {
        if (value[key] !== undefined && !isId(value[key])) return false
    }
    for (const key of [
        'smea', 'smeaDyn', 'variety', 'seedLocked', 'qualityToggle', 'transparentBackground', 'characterPositionEnabled',
    ] as const) {
        if (value[key] !== undefined && typeof value[key] !== 'boolean') return false
    }
    if (value.sourceMode !== undefined && !['text-to-image', 'image-to-image', 'inpaint'].includes(value.sourceMode as string)) {
        return false
    }
    for (const key of ['width', 'height', 'steps', 'cfgScale', 'cfgRescale', 'seed', 'ucPreset', 'strength', 'noise'] as const) {
        const item = value[key]
        if (item !== undefined && (typeof item !== 'number' || !Number.isFinite(item))) return false
    }
    for (const key of Object.keys(PARAM_RANGES) as SceneParameter[]) {
        const item = value[key as keyof ParamsOverride]
        const range = PARAM_RANGES[key]
        if (typeof item === 'number' && range !== undefined
            && (item < range.min || (range.max !== undefined && item > range.max)
                || (range.integer === true && !Number.isSafeInteger(item)))) return false
    }
    const strength = value.strength
    const noise = value.noise
    if ((typeof strength === 'number' && (strength < 0 || strength > 1))
        || (typeof noise === 'number' && (noise < 0 || noise > 1))) return false
    return value.extensions === undefined || isJsonValue(value.extensions)
}

function isOutputPolicy(value: unknown): boolean {
    if (!isRecord(value) || !hasOnlyKeys(value, [
        'destination', 'format', 'filenameTemplate', 'metadataMode', 'collisionPolicy', 'extensions',
    ]) || !isRecord(value.destination) || typeof value.filenameTemplate !== 'string'
        || !['png', 'webp'].includes(value.format as string)
        || !['embedded', 'sidecar-only', 'strip-and-sidecar', 'strip-only'].includes(value.metadataMode as string)
        || !['unique', 'overwrite', 'error'].includes(value.collisionPolicy as string)
        || (value.extensions !== undefined && !isJsonValue(value.extensions))) return false
    if (value.destination.kind === 'memory') {
        return hasOnlyKeys(value.destination, ['kind', 'extensions'])
            && (value.destination.extensions === undefined || isJsonValue(value.destination.extensions))
    }
    return value.destination.kind === 'filesystem'
        && hasOnlyKeys(value.destination, ['kind', 'directory', 'extensions'])
        && isRecord(value.destination.directory) && isJsonValue(value.destination.directory)
        && (value.destination.extensions === undefined || isJsonValue(value.destination.extensions))
}

function assertCompositionRef(value: unknown): asserts value is SceneCompositionRef | undefined {
    if (value === undefined) return
    if (!isRecord(value) || !isJsonValue(value) || !hasOnlyKeys(value, [
        'recipeId', 'selectionKind', 'recipeRevision', 'sceneContributions', 'paramsOverride',
        'characterOverrides', 'outputOverride', 'migrationMarker', 'extensions',
    ]) || !isId(value.recipeId)
        || (value.selectionKind !== undefined && !['asset', 'direct'].includes(value.selectionKind as string))
        || (value.selectionKind === 'direct' && value.recipeId !== DIRECT_RECIPE_ID)
        || (value.recipeRevision !== undefined
            && (!Number.isSafeInteger(value.recipeRevision) || Number(value.recipeRevision) < 0))
        || (value.sceneContributions !== undefined
            && (!Array.isArray(value.sceneContributions) || !value.sceneContributions.every(isPromptContribution)
                || new Set(value.sceneContributions.map(item => (item as unknown as PromptContribution).id)).size
                    !== value.sceneContributions.length))
        || (value.paramsOverride !== undefined && !isParamsOverride(value.paramsOverride))
        || (value.characterOverrides !== undefined
            && (!Array.isArray(value.characterOverrides) || !value.characterOverrides.every(isCharacterOverride)
                || new Set(value.characterOverrides
                    .map(item => (item as unknown as CharacterSlotPatch).characterId)).size
                    !== value.characterOverrides.length))
        || (value.outputOverride !== undefined && !isOutputPolicy(value.outputOverride))
        || (value.extensions !== undefined && !isJsonValue(value.extensions))) {
        throw new InvalidScenePatch('Existing Scene composition reference is invalid')
    }
    if (value.migrationMarker !== undefined && (!isRecord(value.migrationMarker)
        || !hasOnlyKeys(value.migrationMarker, ['kind', 'schemaVersion', 'extensions'])
        || value.migrationMarker.kind !== 'legacy-scene-prompt' || value.migrationMarker.schemaVersion !== 2
        || (value.migrationMarker.extensions !== undefined && !isJsonValue(value.migrationMarker.extensions)))) {
        throw new InvalidScenePatch('Existing Scene migration marker is invalid')
    }
}

/** Shared persistence guard so CAS cannot store an arbitrary JSON composition object. */
export function isSceneCompositionRef(value: unknown): value is SceneCompositionRef | undefined {
    try {
        assertCompositionRef(value)
        return true
    } catch {
        return false
    }
}

function assertParameter(field: unknown, value?: unknown): asserts field is SceneParameter {
    if (typeof field !== 'string' || (!STRING_PARAMETERS.has(field as SceneParameter)
        && !NUMBER_PARAMETERS.has(field as SceneParameter))) {
        throw new InvalidScenePatch('Unsupported Scene parameter field')
    }
    if (value === undefined) return
    if (STRING_PARAMETERS.has(field as SceneParameter)) {
        if (typeof value !== 'string' || value.trim().length === 0) {
            throw new InvalidScenePatch(`${field} must be a non-empty string`)
        }
        return
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new InvalidScenePatch(`${field} must be a finite number`)
    }
    const range = PARAM_RANGES[field as SceneParameter]
    if (range !== undefined && (value < range.min || (range.max !== undefined && value > range.max)
        || (range.integer === true && !Number.isSafeInteger(value)))) {
        throw new InvalidScenePatch(`${field} is out of range`)
    }
}

function assertPatch(value: unknown): asserts value is ScenePatch {
    if (!isRecord(value) || typeof value.op !== 'string') throw new InvalidScenePatch('Patch must be an object')
    switch (value.op) {
        case 'set-prompt-contribution':
            if (!hasOnlyKeys(value, ['op', 'contribution']) || !isPromptContribution(value.contribution)) {
                throw new InvalidScenePatch('Prompt contribution is invalid')
            }
            return
        case 'remove-prompt-contribution':
            if (!hasOnlyKeys(value, ['op', 'contributionId']) || !isId(value.contributionId)) {
                throw new InvalidScenePatch('Contribution ID is invalid')
            }
            return
        case 'set-parameter':
            if (!hasOnlyKeys(value, ['op', 'field', 'value'])) throw new InvalidScenePatch('Parameter patch is invalid')
            assertParameter(value.field, value.value)
            return
        case 'inherit-parameter':
            if (!hasOnlyKeys(value, ['op', 'field'])) throw new InvalidScenePatch('Parameter inherit patch is invalid')
            assertParameter(value.field)
            return
        case 'set-character-caption':
            if (!hasOnlyKeys(value, ['op', 'characterId', 'prompt', 'negative', 'position'])
                || !isId(value.characterId) || typeof value.prompt !== 'string'
                || typeof value.negative !== 'string'
                || (value.position !== undefined && !isPosition(value.position))) {
                throw new InvalidScenePatch('Character caption patch is invalid')
            }
            return
        case 'assign-recipe':
            if (!hasOnlyKeys(value, ['op', 'recipeId', 'recipeRevision']) || !isId(value.recipeId)
                || !Number.isSafeInteger(value.recipeRevision) || Number(value.recipeRevision) < 0) {
                throw new InvalidScenePatch('Recipe assignment is invalid')
            }
            return
        default:
            throw new InvalidScenePatch('Unsupported Scene patch operation')
    }
}

function baseCompositionRef(scene: SceneAuthoringRecord): SceneCompositionRef {
    return scene.compositionRef ?? {
        recipeId: DIRECT_RECIPE_ID,
        selectionKind: 'direct',
    }
}

function applyPatch(scene: SceneAuthoringRecord, patch: ScenePatch): SceneAuthoringRecord {
    const ref = baseCompositionRef(scene)
    switch (patch.op) {
        case 'set-prompt-contribution': {
            const contributions = [...(ref.sceneContributions ?? [])]
            const index = contributions.findIndex(item => item.id === patch.contribution.id)
            if (index < 0) contributions.push(patch.contribution)
            else contributions[index] = patch.contribution
            return { ...scene, compositionRef: { ...ref, sceneContributions: contributions } }
        }
        case 'remove-prompt-contribution': {
            const contributions = (ref.sceneContributions ?? []).filter(item => item.id !== patch.contributionId)
            const { sceneContributions: _removed, ...withoutContributions } = ref
            return {
                ...scene,
                compositionRef: contributions.length === 0
                    ? withoutContributions
                    : { ...ref, sceneContributions: contributions },
            }
        }
        case 'set-parameter':
            return {
                ...scene,
                compositionRef: {
                    ...ref,
                    paramsOverride: { ...(ref.paramsOverride ?? {}), [patch.field]: patch.value } as ParamsOverride,
                },
            }
        case 'inherit-parameter': {
            const params = { ...(ref.paramsOverride ?? {}) } as Record<string, unknown>
            delete params[patch.field]
            const { paramsOverride: _removed, ...withoutParams } = ref
            return {
                ...scene,
                compositionRef: Object.keys(params).length === 0
                    ? withoutParams
                    : { ...ref, paramsOverride: params as ParamsOverride },
            }
        }
        case 'set-character-caption': {
            const overrides = [...(ref.characterOverrides ?? [])]
            const index = overrides.findIndex(item => item.characterId === patch.characterId)
            const previous = index < 0 ? undefined : overrides[index]
            const next: CharacterSlotPatch = {
                ...(previous ?? {}),
                characterId: patch.characterId,
                positivePrompt: patch.prompt,
                negativePrompt: patch.negative,
                ...(patch.position === undefined
                    ? {}
                    : { position: { mode: 'manual', ...patch.position } }),
            }
            if (index < 0) overrides.push(next)
            else overrides[index] = next
            return { ...scene, compositionRef: { ...ref, characterOverrides: overrides } }
        }
        case 'assign-recipe':
            return {
                ...scene,
                compositionRef: {
                    ...ref,
                    recipeId: patch.recipeId,
                    recipeRevision: patch.recipeRevision,
                    selectionKind: patch.recipeId === DIRECT_RECIPE_ID ? 'direct' : 'asset',
                },
            }
    }
}

function timestamp(now: PatchScenesInput['now']): string {
    const value = typeof now === 'function' ? now() : now ?? new Date().toISOString()
    if (!isIsoTimestamp(value)) throw new InvalidScenePatch('updatedAt must be an ISO timestamp', 'INVALID_INPUT')
    return value
}

function conflict(current: SceneDocument | null): PatchScenesResult {
    return {
        status: 'REVISION_CONFLICT',
        current,
        scenes: current === null ? [] : resolveScenes(current.scenes),
    }
}

/** Applies every Scene patch to a detached document and performs exactly one whole-document CAS commit. */
export async function patchScenes(input: PatchScenesInput): Promise<PatchScenesResult> {
    if (!isId(input.presetId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
        || !Array.isArray(input.scenePatches)) {
        return { status: 'NOT_FOUND', presetId: input.presetId }
    }
    const current = await input.repository.getDocument(input.presetId)
    if (current === null) return { status: 'NOT_FOUND', presetId: input.presetId }
    if (input.scenePatches.length === 0) {
        return {
            status: 'INVALID',
            current,
            code: 'INVALID_INPUT',
            message: 'At least one Scene patch set is required',
        }
    }
    if (current.revision !== input.expectedRevision) return conflict(current)

    try {
        const mutable = structuredClone(current) as unknown as { scenes: SceneAuthoringRecord[] }
        const seen = new Set<string>()
        for (const set of input.scenePatches) {
            if (!isRecord(set) || !hasOnlyKeys(set, ['sceneId', 'patches'])
                || !isId(set.sceneId) || !Array.isArray(set.patches) || seen.has(set.sceneId)) {
                throw new InvalidScenePatch('Scene patch set is invalid', 'INVALID_INPUT')
            }
            if (set.patches.length === 0) {
                throw new InvalidScenePatch(
                    'At least one patch is required for each Scene', 'INVALID_INPUT', set.sceneId,
                )
            }
            seen.add(set.sceneId)
            const sceneIndex = mutable.scenes.findIndex(scene => scene.id === set.sceneId)
            if (sceneIndex < 0) throw new InvalidScenePatch(
                `Scene ${set.sceneId} was not found`, 'SCENE_NOT_FOUND', set.sceneId,
            )
            let scene = mutable.scenes[sceneIndex]
            assertCompositionRef(scene.compositionRef)
            for (let patchIndex = 0; patchIndex < set.patches.length; patchIndex += 1) {
                try {
                    assertPatch(set.patches[patchIndex])
                    scene = applyPatch(scene, set.patches[patchIndex])
                } catch (error) {
                    if (error instanceof InvalidScenePatch) {
                        throw new InvalidScenePatch(error.message, error.code, set.sceneId, patchIndex)
                    }
                    throw error
                }
            }
            mutable.scenes[sceneIndex] = scene
        }
        const next: SceneDocument = {
            ...current,
            scenes: mutable.scenes,
            revision: current.revision + 1,
            updatedAt: timestamp(input.now),
        }
        const committed: CommitResult = await input.repository.commit(next, input.expectedRevision)
        switch (committed.status) {
            case 'COMMITTED':
                return { status: 'COMMITTED', document: committed.document, scenes: resolveScenes(committed.document.scenes) }
            case 'REVISION_CONFLICT':
                return conflict(committed.current)
            case 'STORAGE_CONFLICT':
                return { status: 'STORAGE_CONFLICT', current }
        }
    } catch (error) {
        if (error instanceof InvalidScenePatch) {
            return {
                status: 'INVALID',
                current,
                code: error.code,
                ...(error.sceneId === undefined ? {} : { sceneId: error.sceneId }),
                ...(error.patchIndex === undefined ? {} : { patchIndex: error.patchIndex }),
                message: error.message,
            }
        }
        throw error
    }
}
