import {
    CompositionEngine,
    type CompositionEngineFragmentInput,
    type CompositionEngineIssue,
    type CompositionEngineOverrideLayer,
    type CompositionEnginePlan,
    type CompositionEngineResolveResult,
} from '@/domain/composition/engine'
import {
    createImmutableSerializableSnapshot,
    type DeepReadonly,
} from '@/domain/composition/provenance'
import { safeParseCompositionDocument } from '@/domain/composition/schema'
import type {
    CharacterSlotPatch,
    ChoiceRandomRule,
    EntityId,
    Extensions,
    IsoTimestamp,
    OutputPolicy,
    ParamsOverride,
    PromptContribution,
    RandomTraceEntry,
    ResolveRequest,
    ResolvedGenerationParams,
} from '@/domain/composition/types'
import type { AssetProfile } from '@/types/asset-profile'
import {
    buildMainResolveRequest,
    MAIN_DIRECT_SELECTION_ID,
    mainAssetRecipeSelectionId,
    type MainCharacterPromptSnapshot,
    type MainCompositionSnapshot,
    type MainOutputSnapshot,
    type MainPromptSnapshot,
    type MainReferenceSnapshot,
    type MainSourceSnapshot,
} from './main-adapter'

export const SCENE_DIRECT_RECIPE_ID = 'scene:direct' as const
export const SCENE_DIRECT_SELECTION_ID = 'scene-selection:direct' as const
export const SCENE_ASSET_SELECTION_PREFIX = 'scene-selection:asset:' as const

export type SceneCompositionMode = 'legacy' | 'shadow' | 'v2'

export function sceneAssetRecipeSelectionId(recipeId: string): string {
    return `${SCENE_ASSET_SELECTION_PREFIX}${encodeURIComponent(recipeId)}`
}

export function decodeSceneRecipeSelection(value: string): {
    recipeId: string
    selectionKind: NonNullable<SceneCompositionRef['selectionKind']>
} {
    if (value === SCENE_DIRECT_SELECTION_ID) {
        return { recipeId: SCENE_DIRECT_RECIPE_ID, selectionKind: 'direct' }
    }
    if (value.startsWith(SCENE_ASSET_SELECTION_PREFIX)) {
        const encoded = value.slice(SCENE_ASSET_SELECTION_PREFIX.length)
        try {
            return { recipeId: decodeURIComponent(encoded), selectionKind: 'asset' }
        } catch {
            return { recipeId: encoded, selectionKind: 'asset' }
        }
    }
    return { recipeId: value, selectionKind: 'asset' }
}

export interface SceneCompositionMigrationMarker {
    kind: 'legacy-scene-prompt'
    schemaVersion: 2
    extensions?: Extensions
}

/**
 * Optional, serializable v2 ownership attached to a SceneCard. Recipe IDs stay
 * in their stored Asset Profile form; UI selection tokens never cross this
 * persistence boundary.
 */
export interface SceneCompositionRef {
    recipeId: EntityId
    /** Disambiguates the synthetic direct option from an Asset recipe with the same ID. */
    selectionKind?: 'asset' | 'direct'
    /** Source Asset Profile revision observed when the recipe was selected. */
    recipeRevision?: number
    sceneContributions?: PromptContribution[]
    paramsOverride?: ParamsOverride
    characterOverrides?: CharacterSlotPatch[]
    outputOverride?: OutputPolicy
    migrationMarker?: SceneCompositionMigrationMarker
    extensions?: Extensions
}

export interface SceneCompositionCardSnapshot {
    promptTextMode?: 'standard' | 'verbatim'
    id: EntityId
    name: string
    scenePrompt: string
    width?: number
    height?: number
    createdAt: number
    compositionRef?: SceneCompositionRef
}

export interface SceneCompositionSnapshot {
    profile: AssetProfile
    scene: SceneCompositionCardSnapshot
    preset?: {
        id: EntityId
        name: string
        sceneNumber?: number
    }
    prompt: MainPromptSnapshot
    characters: readonly MainCharacterPromptSnapshot[]
    characterPresets?: MainCompositionSnapshot['characterPresets']
    characterGroups?: MainCompositionSnapshot['characterGroups']
    positionEnabled: boolean
    references: readonly MainReferenceSnapshot[]
    paramsPresets?: MainCompositionSnapshot['paramsPresets']
    activeParamsPresetId?: MainCompositionSnapshot['activeParamsPresetId']
    params: ResolvedGenerationParams
    output: MainOutputSnapshot
    source: MainSourceSnapshot
}

export interface BuildSceneCompositionInput {
    snapshot: SceneCompositionSnapshot
    requestId: EntityId
    now: IsoTimestamp
    seed: number
    fragment: CompositionEngineFragmentInput
    fragmentMode?: CompositionEngineFragmentInput['mode']
    runtimeCharacterOverride?: SceneRuntimeCharacterOverride
}

/** Transient Scene runtime input. It is never persisted into SceneCard. */
export interface SceneRuntimeCharacterOverride {
    characterPatches: readonly CharacterSlotPatch[]
    randomTrace: RandomTraceEntry
}

export interface SceneCompositionResolution {
    result: CompositionEngineResolveResult
    selectedRecipeId: EntityId
    directRecipeId: EntityId
}

export interface SceneCompositionDiagnostics {
    plan: DeepReadonly<CompositionEnginePlan> | null
    warnings: readonly DeepReadonly<CompositionEngineIssue>[]
    errors: readonly DeepReadonly<CompositionEngineIssue>[]
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sceneReferenceIssue(
    sceneId: EntityId,
    path: readonly (string | number)[],
    detail: string,
): CompositionEngineIssue {
    return {
        code: 'E_DOCUMENT_SCHEMA_INVALID',
        severity: 'error',
        messageKey: 'composition.error.sceneReferenceInvalid',
        sourceRef: { kind: 'external', source: `scene:${sceneId}:compositionRef` },
        fieldPath: ['scene', 'compositionRef', ...path],
        repairHintKey: 'composition.repair.resetSceneToRecipe',
        actionId: 'scene.reset-to-recipe',
        blocking: true,
        extensions: { detail },
    }
}

function validateSceneReference(
    document: ResolveRequest['document'],
    scene: SceneCompositionCardSnapshot,
    requestContributions: readonly PromptContribution[],
): CompositionEngineIssue[] {
    const value = scene.compositionRef as unknown
    if (value === undefined) return []
    if (!isPlainRecord(value)) {
        return [sceneReferenceIssue(scene.id, [], 'must be an object')]
    }

    const issues: CompositionEngineIssue[] = []
    const allowed = new Set([
        'recipeId',
        'selectionKind',
        'recipeRevision',
        'sceneContributions',
        'paramsOverride',
        'characterOverrides',
        'outputOverride',
        'migrationMarker',
        'extensions',
    ])
    for (const key of Object.keys(value).filter(key => !allowed.has(key)).sort()) {
        issues.push(sceneReferenceIssue(scene.id, [key], 'unknown fields must be stored in extensions'))
    }
    if (typeof value.recipeId !== 'string' || value.recipeId.trim().length === 0) {
        issues.push(sceneReferenceIssue(scene.id, ['recipeId'], 'must be a non-empty string'))
    }
    if (value.selectionKind !== undefined && value.selectionKind !== 'asset' && value.selectionKind !== 'direct') {
        issues.push(sceneReferenceIssue(scene.id, ['selectionKind'], "must be 'asset' or 'direct'"))
    }
    if (value.selectionKind === 'direct' && value.recipeId !== SCENE_DIRECT_RECIPE_ID) {
        issues.push(sceneReferenceIssue(
            scene.id,
            ['recipeId'],
            `direct selection must use ${SCENE_DIRECT_RECIPE_ID}`,
        ))
    }
    if (value.recipeRevision !== undefined
        && (!Number.isSafeInteger(value.recipeRevision) || Number(value.recipeRevision) < 0)) {
        issues.push(sceneReferenceIssue(scene.id, ['recipeRevision'], 'must be a non-negative safe integer'))
    }
    if (value.migrationMarker !== undefined) {
        if (!isPlainRecord(value.migrationMarker)) {
            issues.push(sceneReferenceIssue(scene.id, ['migrationMarker'], 'must be an object'))
        } else {
            if (value.migrationMarker.kind !== 'legacy-scene-prompt') {
                issues.push(sceneReferenceIssue(
                    scene.id,
                    ['migrationMarker', 'kind'],
                    "must be 'legacy-scene-prompt'",
                ))
            }
            if (value.migrationMarker.schemaVersion !== 2) {
                issues.push(sceneReferenceIssue(scene.id, ['migrationMarker', 'schemaVersion'], 'must equal 2'))
            }
        }
    }

    const profile = document.profiles[0]
    if (profile !== undefined) {
        const candidateProfile = {
            ...profile,
            contributions: value.sceneContributions === undefined
                ? requestContributions
                : Array.isArray(value.sceneContributions)
                    ? [...requestContributions, ...value.sceneContributions]
                    : value.sceneContributions,
            characterPatches: value.characterOverrides === undefined
                ? profile.characterPatches
                : value.characterOverrides,
            ...(value.paramsOverride === undefined ? {} : { paramsOverride: value.paramsOverride }),
            ...(value.outputOverride === undefined ? {} : { outputPolicy: value.outputOverride }),
            ...((value.extensions === undefined && !isPlainRecord(value.migrationMarker))
                ? {}
                : {
                    extensions: {
                        ...(profile.extensions ?? {}),
                        ...(value.extensions === undefined ? {} : { sceneRef: value.extensions }),
                        ...(!isPlainRecord(value.migrationMarker) || value.migrationMarker.extensions === undefined
                            ? {}
                            : { migrationMarker: value.migrationMarker.extensions }),
                    },
                }),
        }
        const candidate = {
            ...document,
            profiles: [candidateProfile, ...document.profiles.slice(1)],
        }
        const parsed = safeParseCompositionDocument(candidate)
        if (!parsed.success) {
            for (const schemaIssue of parsed.issues) {
                const path = schemaIssue.path[0] === 'profiles' && schemaIssue.path[1] === 0
                    ? schemaIssue.path.slice(2)
                    : schemaIssue.path
                issues.push(sceneReferenceIssue(scene.id, path, schemaIssue.message))
            }
        }
    }

    return issues.sort((left, right) => (
        JSON.stringify(left.fieldPath).localeCompare(JSON.stringify(right.fieldPath))
    ))
}

function stableTimestamp(value: number): IsoTimestamp {
    const date = new Date(Number.isFinite(value) ? value : 0)
    return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString()
}

function sceneWorkflowContribution(scene: SceneCompositionCardSnapshot): PromptContribution | null {
    if (!scene.scenePrompt.trim()) return null
    const timestamp = stableTimestamp(scene.createdAt)
    const actor = { kind: 'user' as const, id: 'scene-runtime:user' }
    return {
        id: `scene:${scene.id}:workflow`,
        orderKey: 'scene:workflow',
        revision: 0,
        createdAt: timestamp,
        createdBy: actor,
        updatedAt: timestamp,
        updatedBy: actor,
        enabled: true,
        target: { kind: 'positive', slot: 'workflow' },
        text: scene.scenePrompt,
        merge: 'append',
        separator: 'comma-space',
        provenance: [{ kind: 'external', source: `scene:${scene.id}:scenePrompt` }],
    }
}

function sceneRecipeSelection(ref: unknown): string | null {
    if (!isPlainRecord(ref) || typeof ref.recipeId !== 'string') return null
    return ref.selectionKind === 'direct'
        ? MAIN_DIRECT_SELECTION_ID
        : mainAssetRecipeSelectionId(ref.recipeId)
}

function sceneParamsOverride(scene: SceneCompositionCardSnapshot): ParamsOverride | undefined {
    const rawRef = scene.compositionRef as unknown
    const refParams = isPlainRecord(rawRef) && isPlainRecord(rawRef.paramsOverride)
        ? rawRef.paramsOverride as ParamsOverride
        : undefined
    const legacyDimensions: ParamsOverride = {
        ...(scene.width === undefined ? {} : { width: scene.width }),
        ...(scene.height === undefined ? {} : { height: scene.height }),
    }
    const result: ParamsOverride = {
        ...legacyDimensions,
        ...refParams,
    }
    return Object.keys(result).length === 0 ? undefined : result
}

function sourceOverride(source: MainSourceSnapshot): ParamsOverride {
    const sourceMode: ParamsOverride['sourceMode'] = source.hasMask
        ? 'inpaint'
        : source.hasSourceImage
            ? 'image-to-image'
            : 'text-to-image'
    return {
        ...(source.hasSourceImage || source.hasMask
            ? { width: source.width, height: source.height }
            : {}),
        sourceMode,
        ...(source.hasSourceImage ? { sourceImageResourceId: 'main-resource:source-image' } : {}),
        ...(source.hasMask ? { maskResourceId: 'main-resource:mask' } : {}),
        strength: source.strength,
        noise: source.noise,
    }
}

function attachRuntimeCharacterOverride(
    request: ResolveRequest,
    runtime: SceneRuntimeCharacterOverride | undefined,
    now: IsoTimestamp,
): ResolveRequest {
    if (runtime === undefined) return request

    const baseRuleId = runtime.randomTrace.ruleId || `scene:${request.requestId}:character-rotation`
    let ruleId = baseRuleId
    let suffix = 1
    while (request.document.randomRules.some(rule => rule.id === ruleId)) {
        ruleId = `${baseRuleId}:runtime-${suffix}`
        suffix += 1
    }
    // Choice option IDs share the document-wide entity namespace, so never
    // reuse a character ID supplied by the legacy rotation store here.
    const selectedOptionId = `${ruleId}:selected`
    const trace: RandomTraceEntry = {
        ...runtime.randomTrace,
        ruleId,
        selectedOptionIds: [selectedOptionId],
    }
    const rule: ChoiceRandomRule = {
        id: ruleId,
        orderKey: 'runtime:character-rotation',
        revision: request.document.revision,
        createdAt: now,
        createdBy: request.requestedBy,
        updatedAt: now,
        updatedBy: request.requestedBy,
        kind: 'choice',
        enabled: true,
        streamKey: trace.streamKey,
        scope: 'character-rotation',
        source: { mode: 'replay', entries: [trace] },
        options: [{
            id: selectedOptionId,
            orderKey: 'selected',
            value: trace.result,
            weight: 1,
        }],
        pickCount: 1,
        withoutReplacement: true,
    }
    return {
        ...request,
        document: {
            ...request.document,
            profiles: request.document.profiles.map(profile => (
                profile.id === request.profileId
                    ? { ...profile, randomRuleIds: [...profile.randomRuleIds, ruleId] }
                    : profile
            )),
            randomRules: [...request.document.randomRules, rule],
        },
        characterPatches: [
            ...request.characterPatches,
            ...runtime.characterPatches,
        ],
    }
}

export function buildSceneResolveRequest(input: BuildSceneCompositionInput): {
    request: ResolveRequest
    engineDefaults: ResolvedGenerationParams
    selectedRecipeId: EntityId
    directRecipeId: EntityId
    preflightErrors: CompositionEngineIssue[]
    sceneOverride?: CompositionEngineOverrideLayer
    transportDerivedOverride: CompositionEngineOverrideLayer
} {
    const rawRef = input.snapshot.scene.compositionRef as unknown
    const ref = isPlainRecord(rawRef) ? rawRef : null
    const selectedRecipeId = sceneRecipeSelection(rawRef)
    const main = buildMainResolveRequest({
        snapshot: {
            profile: input.snapshot.profile,
            selectedRecipeId,
            prompt: input.snapshot.prompt,
            characters: input.snapshot.characters,
            characterPresets: input.snapshot.characterPresets,
            characterGroups: input.snapshot.characterGroups,
            positionEnabled: input.snapshot.positionEnabled,
            references: input.snapshot.references,
            paramsPresets: input.snapshot.paramsPresets,
            activeParamsPresetId: input.snapshot.activeParamsPresetId,
            params: input.snapshot.params,
            output: input.snapshot.output,
            source: input.snapshot.source,
        },
        requestId: input.requestId,
        now: input.now,
        seed: input.seed,
        fragment: input.fragment,
        fragmentMode: input.fragmentMode,
    })
    const workflow = sceneWorkflowContribution(input.snapshot.scene)
    const params = sceneParamsOverride(input.snapshot.scene)
    const outputPolicy = ref !== null && isPlainRecord(ref.outputOverride)
        ? ref.outputOverride as unknown as OutputPolicy
        : undefined
    const baseRequestContributions = [
        ...main.request.contributions,
        ...(workflow === null ? [] : [workflow]),
    ]
    const preflightErrors = validateSceneReference(
        main.request.document,
        input.snapshot.scene,
        baseRequestContributions,
    )
    const sceneContributions = ref !== null && Array.isArray(ref.sceneContributions)
        ? ref.sceneContributions as PromptContribution[]
        : []
    const characterOverrides = ref !== null && Array.isArray(ref.characterOverrides)
        ? ref.characterOverrides as CharacterSlotPatch[]
        : []
    const sceneOverride = params === undefined && outputPolicy === undefined
        ? undefined
        : {
            ...(params === undefined ? {} : { params }),
            ...(outputPolicy === undefined ? {} : { outputPolicy }),
            sourceRef: { kind: 'external' as const, source: `scene:${input.snapshot.scene.id}:override` },
        }

    const request = attachRuntimeCharacterOverride({
        ...main.request,
        contributions: [
            ...baseRequestContributions,
            ...sceneContributions,
        ],
        characterPatches: [
            ...main.request.characterPatches,
            ...characterOverrides,
        ],
    }, input.runtimeCharacterOverride, input.now)

    return {
        request,
        engineDefaults: main.engineDefaults,
        selectedRecipeId: main.selectedRecipeId,
        directRecipeId: main.directRecipeId,
        preflightErrors,
        ...(sceneOverride === undefined ? {} : { sceneOverride }),
        transportDerivedOverride: {
            params: sourceOverride(input.snapshot.source),
            sourceRef: { kind: 'external', source: 'scene-runtime:transport-derived' },
        },
    }
}

export function resolveSceneComposition(input: BuildSceneCompositionInput): SceneCompositionResolution {
    const built = buildSceneResolveRequest(input)
    if (built.preflightErrors.length > 0) {
        return {
            result: createImmutableSerializableSnapshot({
                success: false as const,
                plan: null,
                warnings: [],
                errors: built.preflightErrors,
                sequenceCommitProposal: null,
                randomTrace: [],
                usedFragmentIds: [],
            }),
            selectedRecipeId: built.selectedRecipeId,
            directRecipeId: built.directRecipeId,
        }
    }
    const result = CompositionEngine.resolve({
        request: built.request,
        now: input.now,
        engineDefaults: built.engineDefaults,
        fragment: {
            ...input.fragment,
            mode: input.fragmentMode ?? input.fragment.mode,
        },
        referencePolicy: 'strict',
        randomScope: `scene:${input.snapshot.scene.id}`,
        dedupePolicy: 'exact-token',
        ...(input.snapshot.scene.promptTextMode === 'verbatim' ? { promptTextMode: 'verbatim' as const } : {}),
        sceneOverride: built.sceneOverride,
        transportDerivedOverride: built.transportDerivedOverride,
    })
    return {
        result,
        selectedRecipeId: built.selectedRecipeId,
        directRecipeId: built.directRecipeId,
    }
}

export function diagnosticsFromSceneResolution(
    resolution: SceneCompositionResolution,
): SceneCompositionDiagnostics {
    return resolution.result.success
        ? {
            plan: resolution.result.plan,
            warnings: resolution.result.warnings,
            errors: [],
        }
        : {
            plan: null,
            warnings: resolution.result.warnings,
            errors: resolution.result.errors,
        }
}
