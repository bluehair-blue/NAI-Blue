import {
    CompositionEngine,
    type CompositionEngineFragmentInput,
    type CompositionEngineIssue,
    type CompositionEnginePlan,
    type CompositionEngineResolveResult,
} from '@/domain/composition/engine'
import type { DeepReadonly } from '@/domain/composition/provenance'
import type {
    ActorRef,
    CharacterDefinition,
    CompositionDocument,
    CompositionModule,
    CompositionProfile,
    CompositionRecipe,
    IsoTimestamp,
    OutputFormat,
    OutputPolicy,
    PortablePathRef,
    PortablePathRoot,
    ParamsOverride,
    PromptContribution,
    PromptTarget,
    RecipeStep,
    ResolveRequest,
    ResolvedGenerationParams,
    ResourceRef,
} from '@/domain/composition/types'
import { COMPOSITION_SCHEMA_VERSION } from '@/domain/composition/types'
import type { PreciseReferenceCaption } from '@/domain/generation/precise-reference'
import { createFallbackFilename, renderFilenameTemplate } from '@/lib/asset-modules/filename-template'
import {
    projectCharacterPromptsToV2,
    type CharacterPromptProjectionResult,
} from '@/lib/composition/character-prompt-adapter'
import {
    characterResourceRefId,
    projectCharacterResourcesToV2,
} from '@/lib/composition/character-resource-adapter'
import {
    legacyPresetParams,
    projectLegacyParamsPresets,
} from '@/lib/composition/params-preset-adapter'
import type {
    CharacterGroup,
    CharacterPreset,
} from '@/stores/character-prompt-store'
import type {
    AssetModuleProfile,
    AssetProfile,
    AssetProfileJsonRecord,
    AssetProfileOutput,
    AssetRecipe,
    AssetRecipeStep,
} from '@/types/asset-profile'
import { getRuntimeCompositionDocument } from '@/lib/composition-authority'

export const MAIN_DIRECT_RECIPE_ID = 'main:direct' as const
export const MAIN_DIRECT_SELECTION_ID = 'main-selection:direct' as const
export const MAIN_ASSET_SELECTION_PREFIX = 'main-selection:asset:' as const
export const MAIN_COMPOSITION_PROFILE_ID = 'main:profile' as const
export const MAIN_COMPOSITION_DOCUMENT_ID = 'main:composition-document' as const

export type MainCompositionMode = 'legacy' | 'shadow' | 'v2'

export interface MainPromptSnapshot {
    base: string
    inpainting: string
    additional: string
    detail: string
    negative: string
}

export interface MainCharacterPromptSnapshot {
    id: string
    name?: string
    prompt: string
    negative: string
    enabled: boolean
    position: CharacterDefinition['position'] | { x: number; y: number }
    presetId?: string
    groupId?: string
}

export interface MainReferenceSnapshot {
    id: string
    enabled: boolean
    kind: 'character' | 'vibe'
    referenceType: PreciseReferenceCaption
    strength: number
    fidelity?: number
    informationExtracted?: number
    digest?: string
}

export interface MainOutputSnapshot {
    autoSave: boolean
    savePath: string
    useAbsolutePath: boolean
    imageFormat: 'png' | 'webp'
    metadataMode: 'embedded' | 'sidecar-only' | 'strip-and-sidecar' | 'strip-only'
    /** Platform adapter choice for newly projected relative destinations. */
    portableRoot?: PortablePathRoot
}

export interface MainSourceSnapshot {
    hasSourceImage: boolean
    hasMask: boolean
    sourceImageDigest?: string
    maskDigest?: string
    width: number
    height: number
    strength: number
    noise: number
}

export interface MainCompositionSnapshot {
    profile: AssetProfile
    selectedRecipeId: string | null
    prompt: MainPromptSnapshot
    characters: readonly MainCharacterPromptSnapshot[]
    characterPresets?: readonly CharacterPreset[]
    characterGroups?: readonly CharacterGroup[]
    positionEnabled: boolean
    references: readonly MainReferenceSnapshot[]
    paramsPresets?: readonly unknown[]
    activeParamsPresetId?: string
    params: ResolvedGenerationParams
    output: MainOutputSnapshot
    source: MainSourceSnapshot
}

export interface BuildMainCompositionInput {
    snapshot: MainCompositionSnapshot
    requestId: string
    now: IsoTimestamp
    seed: number
    fragment: CompositionEngineFragmentInput
    fragmentMode?: CompositionEngineFragmentInput['mode']
}

export interface MainOutputMaterialization {
    directory: string
    portableDirectory?: PortablePathRef
    fileName: string
    format: OutputFormat
    metadataMode: MainOutputSnapshot['metadataMode']
    autoSave: boolean
    useAbsolutePath: boolean
    capabilityFallbackDirectory: string
}

export interface MainCompositionResolution {
    result: CompositionEngineResolveResult
    selectedRecipeId: string
    directRecipeId: string
    output: MainOutputMaterialization | null
}

export interface MainCompositionDiagnostics {
    plan: DeepReadonly<CompositionEnginePlan> | null
    warnings: readonly DeepReadonly<CompositionEngineIssue>[]
    errors: readonly DeepReadonly<CompositionEngineIssue>[]
}

interface EntityContext {
    revision: number
    timestamp: IsoTimestamp
    actor: ActorRef
}

interface LegacyPromptDraft {
    target: string
    order: number
    text: string
    sourceIndex: number
}

interface RecipeBuildResult {
    recipe: CompositionRecipe
    hasPromptContributions: boolean
    assetCharacterIds: string[]
    output: AssetProfileOutput
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function actorForProfile(profile: AssetProfile): ActorRef {
    const raw = String(profile.updatedBy || 'system')
    const kind: ActorRef['kind'] = raw === 'agent'
        ? 'agent'
        : raw === 'system'
            ? 'system'
            : raw === 'gui'
                ? 'user'
                : 'service'
    return { kind, id: `asset-profile-actor:${raw}` }
}

function entityContext(profile: AssetProfile): EntityContext {
    return {
        revision: Math.max(0, Math.trunc(profile.revision)),
        timestamp: profile.updatedAt,
        actor: actorForProfile(profile),
    }
}

function revisionFields(context: EntityContext) {
    return {
        revision: context.revision,
        createdAt: context.timestamp,
        createdBy: context.actor,
        updatedAt: context.timestamp,
        updatedBy: context.actor,
    }
}

function readString(source: Record<string, unknown>, ...keys: readonly string[]): string | undefined {
    for (const key of keys) {
        const value = source[key]
        if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    }
    return undefined
}

function readNumber(source: Record<string, unknown>, ...keys: readonly string[]): number | undefined {
    for (const key of keys) {
        const value = source[key]
        if (typeof value === 'number' && Number.isFinite(value)) return value
        if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
            return Number(value)
        }
    }
    return undefined
}

function readBoolean(source: Record<string, unknown>, ...keys: readonly string[]): boolean | undefined {
    for (const key of keys) {
        const value = source[key]
        if (typeof value === 'boolean') return value
    }
    return undefined
}

/** Only typed, generation-relevant keys cross from legacy settings into core params. */
export function legacySettingsToParamsOverride(
    ...sources: Array<Record<string, unknown> | AssetProfileJsonRecord | undefined>
): ParamsOverride | undefined {
    const source = Object.assign({}, ...sources.filter(isRecord))
    const result: ParamsOverride = {}
    const assign = <Key extends keyof ParamsOverride>(key: Key, value: ParamsOverride[Key]): void => {
        if (value !== undefined) Object.assign(result, { [key]: value })
    }

    assign('model', readString(source, 'model'))
    assign('width', readNumber(source, 'width'))
    assign('height', readNumber(source, 'height'))
    assign('steps', readNumber(source, 'steps'))
    assign('cfgScale', readNumber(source, 'cfgScale', 'cfg_scale', 'cfg'))
    assign('cfgRescale', readNumber(source, 'cfgRescale', 'cfg_rescale'))
    assign('sampler', readString(source, 'sampler'))
    assign('scheduler', readString(source, 'scheduler'))
    assign('smea', readBoolean(source, 'smea'))
    assign('smeaDyn', readBoolean(source, 'smeaDyn', 'smea_dyn'))
    assign('variety', readBoolean(source, 'variety'))
    assign('seed', readNumber(source, 'seed'))
    assign('seedLocked', readBoolean(source, 'seedLocked', 'seed_locked'))
    assign('qualityToggle', readBoolean(source, 'qualityToggle', 'quality_toggle'))
    assign('ucPreset', readNumber(source, 'ucPreset', 'uc_preset'))
    assign(
        'transparentBackground',
        readBoolean(source, 'transparentBackground', 'transparent_background'),
    )
    assign('strength', readNumber(source, 'strength'))
    assign('noise', readNumber(source, 'noise'))
    assign(
        'characterPositionEnabled',
        readBoolean(source, 'characterPositionEnabled', 'character_position_enabled'),
    )

    return Object.keys(result).length === 0 ? undefined : result
}

function normalizeTarget(target: string | undefined): string {
    return target?.trim() || 'main.base'
}

function collectPromptValue(
    value: unknown,
    target: string,
    order: number,
    drafts: LegacyPromptDraft[],
): void {
    if (typeof value === 'string') {
        if (value.trim()) drafts.push({ target, order, text: value.trim(), sourceIndex: drafts.length })
        return
    }
    if (Array.isArray(value)) {
        value.forEach(item => collectPromptValue(item, target, order, drafts))
        return
    }
    if (!isRecord(value)) return

    const nested = readString(value, 'prompt', 'text')
    if (nested !== undefined) {
        drafts.push({
            target: normalizeTarget(readString(value, 'target') ?? target),
            order: readNumber(value, 'order') ?? order,
            text: nested,
            sourceIndex: drafts.length,
        })
        return
    }
    for (const [nestedTarget, nestedValue] of Object.entries(value)) {
        collectPromptValue(nestedValue, normalizeTarget(nestedTarget), order, drafts)
    }
}

function extractLegacyPromptDrafts(
    module: AssetModuleProfile,
    step: AssetRecipeStep,
): LegacyPromptDraft[] {
    const source = {
        ...(module as unknown as Record<string, unknown>),
        ...module.settings,
        ...step.settings,
        ...(step as unknown as Record<string, unknown>),
    }
    const target = normalizeTarget(readString(source, 'target'))
    const order = readNumber(source, 'order') ?? 0
    const drafts: LegacyPromptDraft[] = []
    collectPromptValue(source.prompt, target, order, drafts)
    collectPromptValue(source.prompts, target, order, drafts)
    collectPromptValue(source.targets, target, order, drafts)

    const negative = readString(source, 'negative', 'negativePrompt')
    if (negative !== undefined) {
        drafts.push({
            target: 'main.negative',
            order,
            text: negative,
            sourceIndex: drafts.length,
        })
    }
    return drafts
}

function directTarget(slot: 'base' | 'inpainting' | 'additional' | 'detail'): PromptTarget {
    return { kind: 'positive', slot }
}

function assetCharacterId(recipeId: string, index: number): string {
    return `asset-character:${recipeId}:${index}`
}

function mapLegacyPromptTarget(
    target: string,
    recipeId: string,
    stableCharacterIds: readonly string[] = [],
): PromptTarget {
    const normalized = target.trim().toLowerCase()
    if (normalized === 'main.negative' || normalized === 'negative') return { kind: 'negative' }
    if (normalized === 'main.inpainting') return { kind: 'positive', slot: 'inpainting' }
    if (normalized === 'main.additional') return { kind: 'positive', slot: 'additional' }
    if (normalized === 'main.detail') return { kind: 'positive', slot: 'detail' }
    if (normalized === 'main.workflow' || normalized === 'main.style' || normalized === 'main.quality') {
        return { kind: 'positive', slot: 'workflow' }
    }
    const character = /^v4\.char\.(\d+)\.(positive|negative)$/.exec(normalized)
    if (character !== null) {
        const characterIndex = Number(character[1])
        return {
            kind: 'character',
            characterId: stableCharacterIds[characterIndex] ?? assetCharacterId(recipeId, characterIndex),
            polarity: character[2] as 'positive' | 'negative',
        }
    }
    return { kind: 'positive', slot: 'base' }
}

function contribution(
    context: EntityContext,
    id: string,
    orderKey: string,
    target: PromptTarget,
    text: string,
    merge: PromptContribution['merge'],
): PromptContribution {
    return {
        ...revisionFields(context),
        id,
        orderKey,
        enabled: true,
        target,
        text,
        merge,
        separator: 'comma-space',
    }
}

function directContributions(
    context: EntityContext,
    prompt: MainPromptSnapshot,
): PromptContribution[] {
    return [
        contribution(context, 'main:prompt:base', '00:00', directTarget('base'), prompt.base, 'append'),
        contribution(
            context,
            'main:prompt:inpainting',
            '00:01',
            directTarget('inpainting'),
            prompt.inpainting,
            'append',
        ),
        contribution(
            context,
            'main:prompt:additional',
            '00:02',
            directTarget('additional'),
            prompt.additional,
            'append',
        ),
        contribution(context, 'main:prompt:detail', '00:04', directTarget('detail'), prompt.detail, 'append'),
        contribution(context, 'main:prompt:negative', '00:05', { kind: 'negative' }, prompt.negative, 'append'),
    ]
}

function referenceResourceId(reference: MainReferenceSnapshot): string {
    return characterResourceRefId(reference.kind, reference.id)
}

export function mainReferenceResourceId(kind: MainReferenceSnapshot['kind'], id: string): string {
    return referenceResourceId({
        id,
        kind,
        enabled: true,
        referenceType: kind === 'vibe' ? 'character&style' : 'character&style',
        strength: 0,
    })
}

function sourceResources(context: EntityContext, source: MainSourceSnapshot): ResourceRef[] {
    const resources: ResourceRef[] = []
    if (source.hasSourceImage) {
        resources.push({
            ...revisionFields(context),
            id: 'main-resource:source-image',
            orderKey: 'source:00',
            kind: 'managed',
            enabled: true,
            role: 'source-image',
            resourceId: 'main-runtime:source-image',
            ...(source.sourceImageDigest === undefined ? {} : { digest: source.sourceImageDigest }),
        })
    }
    if (source.hasMask) {
        resources.push({
            ...revisionFields(context),
            id: 'main-resource:mask',
            orderKey: 'source:01',
            kind: 'managed',
            enabled: true,
            role: 'mask',
            resourceId: 'main-runtime:mask',
            ...(source.maskDigest === undefined ? {} : { digest: source.maskDigest }),
        })
    }
    return resources
}

function normalizeFormat(value: string | undefined, fallback: OutputFormat): OutputFormat {
    const normalized = value?.replace(/^\./, '').toLowerCase()
    return normalized === 'webp' || normalized === 'png' ? normalized : fallback
}

function portableSegments(path: string): string[] {
    return path
        .split(/[\\/]+/)
        .map(segment => segment.trim())
        .filter(segment => segment.length > 0 && segment !== '.' && segment !== '..' && !segment.endsWith(':'))
}

function isAbsolutePath(path: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\')
}

function outputPolicy(
    runtime: MainOutputSnapshot,
    legacy: AssetProfileOutput | undefined,
    fallbackFilenameTemplate = 'NAI_Blue_{timestamp}',
): OutputPolicy {
    const directory = legacy?.directory?.trim() || runtime.savePath.trim() || 'NAI_Blue_Output'
    const format = normalizeFormat(legacy?.format, runtime.imageFormat)
    const metadataMode = legacy?.metadataMode ?? runtime.metadataMode
    const filenameTemplate = legacy?.filenameTemplate?.trim()
        || legacy?.fileName?.trim()
        || fallbackFilenameTemplate

    return {
        destination: runtime.autoSave
            ? {
                kind: 'filesystem',
                directory: runtime.useAbsolutePath || isAbsolutePath(directory)
                    ? { kind: 'bookmark', bookmarkId: 'main-output:absolute-runtime', segments: [] }
                    : {
                        kind: 'standard',
                        root: runtime.portableRoot ?? 'pictures',
                        segments: portableSegments(directory),
                    },
            }
            : { kind: 'memory' },
        format,
        filenameTemplate,
        metadataMode,
        collisionPolicy: 'overwrite',
    }
}

function moduleKind(value: string | undefined): CompositionModule['kind'] {
    return value === 'prompt'
        || value === 'character'
        || value === 'params'
        || value === 'output'
        || value === 'composite'
        ? value
        : 'composite'
}

function mergeLegacyOutput(...values: Array<AssetProfileOutput | undefined>): AssetProfileOutput {
    return Object.assign({}, ...values.filter(value => value !== undefined))
}

function buildModule(
    context: EntityContext,
    module: AssetModuleProfile,
    index: number,
    runtimeOutput: MainOutputSnapshot,
): CompositionModule {
    return {
        ...revisionFields(context),
        id: module.id,
        orderKey: `module:${String(index).padStart(6, '0')}`,
        name: module.label?.trim() || module.id,
        enabled: module.enabled,
        kind: moduleKind(module.kind),
        contributions: [],
        characterPatches: [],
        ...(legacySettingsToParamsOverride(
            module as unknown as Record<string, unknown>,
            module.settings,
        ) === undefined
            ? {}
            : {
                paramsOverride: legacySettingsToParamsOverride(
                    module as unknown as Record<string, unknown>,
                    module.settings,
                ),
            }),
        ...(module.output === undefined ? {} : { outputPolicy: outputPolicy(runtimeOutput, module.output) }),
        resourceBindings: [],
        randomRuleIds: [],
    }
}

function clearAssetPromptContributions(
    context: EntityContext,
    recipeId: string,
): PromptContribution[] {
    return [
        contribution(context, `asset-clear:${recipeId}:base`, '10:00', directTarget('base'), '', 'replace'),
        contribution(
            context,
            `asset-clear:${recipeId}:inpainting`,
            '10:01',
            directTarget('inpainting'),
            '',
            'replace',
        ),
        contribution(
            context,
            `asset-clear:${recipeId}:additional`,
            '10:02',
            directTarget('additional'),
            '',
            'replace',
        ),
        contribution(context, `asset-clear:${recipeId}:workflow`, '10:03', { kind: 'positive', slot: 'workflow' }, '', 'replace'),
        contribution(context, `asset-clear:${recipeId}:detail`, '10:04', directTarget('detail'), '', 'replace'),
        contribution(context, `asset-clear:${recipeId}:negative`, '10:05', { kind: 'negative' }, '', 'replace'),
    ]
}

function buildRecipe(
    context: EntityContext,
    profile: AssetProfile,
    recipe: AssetRecipe,
    recipeIndex: number,
    runtimeOutput: MainOutputSnapshot,
    stableCharacterIds: readonly string[] = [],
): RecipeBuildResult {
    const collectedDrafts: Array<{
        stepIndex: number
        draft: LegacyPromptDraft
    }> = []
    let output = mergeLegacyOutput(profile.output)

    for (const [stepIndex, step] of recipe.steps.entries()) {
        if (step.enabled === false) continue
        const module = profile.modules[step.moduleId]
        if (module === undefined || !module.enabled) continue
        output = mergeLegacyOutput(output, module.output)
        extractLegacyPromptDrafts(module, step).forEach(draft => collectedDrafts.push({ stepIndex, draft }))
    }
    output = mergeLegacyOutput(output, recipe.output)
    if (!output.filenameTemplate?.trim() && !output.fileName?.trim()) {
        output = {
            ...output,
            filenameTemplate: '{profile}_{seed}_{datetime:YYYYMMDD-HHmmss}',
        }
    }

    const sortedDrafts = [...collectedDrafts].sort((left, right) => (
        left.draft.order - right.draft.order
        || left.stepIndex - right.stepIndex
        || left.draft.sourceIndex - right.draft.sourceIndex
    ))
    const contributionRanks = new Map<string, number>()
    sortedDrafts.forEach((entry, rank) => {
        contributionRanks.set(`${entry.stepIndex}:${entry.draft.sourceIndex}`, rank)
    })
    const hasPromptContributions = sortedDrafts.length > 0
    const clearStepIndex = sortedDrafts[0]?.stepIndex ?? -1
    const assetCharacterIds = [...new Set(sortedDrafts.flatMap(({ draft }) => {
        const match = /^v4\.char\.(\d+)\./i.exec(draft.target)
        return match === null ? [] : [Number(match[1])]
    }))]
        .sort((left, right) => left - right)
        .map(index => stableCharacterIds[index] ?? assetCharacterId(recipe.id, index))

    const steps: RecipeStep[] = recipe.steps.map((step, stepIndex) => {
        const module = profile.modules[step.moduleId]
        const drafts = module === undefined ? [] : extractLegacyPromptDrafts(module, step)
        const promptContributions = drafts.map(draft => {
            const rank = contributionRanks.get(`${stepIndex}:${draft.sourceIndex}`) ?? draft.sourceIndex
            return contribution(
                context,
                `asset-contribution:${recipe.id}:${stepIndex}:${draft.sourceIndex}`,
                `20:${String(rank).padStart(8, '0')}`,
                mapLegacyPromptTarget(draft.target, recipe.id, stableCharacterIds),
                draft.text,
                'append',
            )
        })
        if (hasPromptContributions && stepIndex === clearStepIndex) {
            promptContributions.push(...clearAssetPromptContributions(context, recipe.id))
        }

        const stepParams = legacySettingsToParamsOverride(
            step as unknown as Record<string, unknown>,
            step.settings,
        )
        const hasAssetCharacters = promptContributions.some(item => item.target.kind === 'character')
        const paramsOverride = hasAssetCharacters
            ? { ...(stepParams ?? {}), characterPositionEnabled: true }
            : stepParams

        return {
            ...revisionFields(context),
            id: `recipe-step:${recipe.id}:${stepIndex}:${step.moduleId}`,
            orderKey: `step:${String(stepIndex).padStart(8, '0')}`,
            moduleId: step.moduleId,
            enabled: step.enabled !== false,
            contributions: promptContributions,
            characterPatches: [],
            ...(paramsOverride === undefined ? {} : { paramsOverride }),
            resourceBindings: [],
            randomRuleIds: [],
        }
    })

    const paramsOverride = legacySettingsToParamsOverride(recipe.settings)
    return {
        recipe: {
            ...revisionFields(context),
            id: recipe.id,
            orderKey: `recipe:${String(recipeIndex).padStart(6, '0')}`,
            // Legacy filename `{recipe.label}` resolves to empty when no label exists.
            name: recipe.label?.trim() || '',
            enabled: recipe.enabled,
            steps,
            ...(paramsOverride === undefined ? {} : { paramsOverride }),
            outputPolicy: outputPolicy(runtimeOutput, output),
        },
        hasPromptContributions,
        assetCharacterIds,
        output,
    }
}

function directCharacters(
    context: EntityContext,
    characters: readonly MainCharacterPromptSnapshot[],
    positionEnabled: boolean,
    presets: readonly CharacterPreset[] = [],
    groups: readonly CharacterGroup[] = [],
): CharacterPromptProjectionResult {
    return projectCharacterPromptsToV2({
        characters,
        positionEnabled,
        presets,
        groups,
        context,
    })
}

function assetCharacters(
    context: EntityContext,
    recipes: readonly RecipeBuildResult[],
    existingCharacterIds: ReadonlySet<string>,
): CharacterDefinition[] {
    return [...new Set(recipes.flatMap(item => item.assetCharacterIds))]
        .filter(id => id.startsWith('asset-character:') && !existingCharacterIds.has(id))
        .sort((left, right) => {
            const leftIndex = Number(/:(\d+)$/.exec(left)?.[1] ?? Number.MAX_SAFE_INTEGER)
            const rightIndex = Number(/:(\d+)$/.exec(right)?.[1] ?? Number.MAX_SAFE_INTEGER)
            return leftIndex - rightIndex || left.localeCompare(right)
        })
        .map((id, index) => ({
            ...revisionFields(context),
            id,
            orderKey: `asset-character:${String(index).padStart(6, '0')}`,
            name: id,
            enabled: true,
            positivePrompt: '',
            negativePrompt: '',
            position: { mode: 'manual', x: 0.5, y: 0.5 },
            resourceBindings: [],
        }))
}

export function getMainDirectRecipeId(
    recipes: readonly Pick<AssetRecipe, 'id'>[],
): string {
    const storedIds = new Set(recipes.map(recipe => recipe.id))
    let candidate: string = MAIN_DIRECT_RECIPE_ID
    while (storedIds.has(candidate)) candidate = `${candidate}:synthetic`
    return candidate
}

export function mainAssetRecipeSelectionId(recipeId: string): string {
    return `${MAIN_ASSET_SELECTION_PREFIX}${encodeURIComponent(recipeId)}`
}

export function resolveMainRecipeSelection(
    profile: AssetProfile,
    requested: string | null,
): { recipeId: string; directRecipeId: string; isDirect: boolean } {
    const directRecipeId = getMainDirectRecipeId(profile.recipes)
    if (requested === null) {
        const firstEnabled = profile.recipes.find(recipe => recipe.enabled)
        return firstEnabled === undefined
            ? { recipeId: directRecipeId, directRecipeId, isDirect: true }
            : { recipeId: firstEnabled.id, directRecipeId, isDirect: false }
    }
    if (requested === MAIN_DIRECT_SELECTION_ID
        || requested === MAIN_DIRECT_RECIPE_ID
        || requested === directRecipeId) {
        return { recipeId: directRecipeId, directRecipeId, isDirect: true }
    }
    if (requested.startsWith(MAIN_ASSET_SELECTION_PREFIX)) {
        const encoded = requested.slice(MAIN_ASSET_SELECTION_PREFIX.length)
        try {
            return { recipeId: decodeURIComponent(encoded), directRecipeId, isDirect: false }
        } catch {
            return { recipeId: encoded, directRecipeId, isDirect: false }
        }
    }
    return { recipeId: requested, directRecipeId, isDirect: false }
}

export function getEffectiveMainRecipeId(profile: AssetProfile, requested: string | null): string {
    return resolveMainRecipeSelection(profile, requested).recipeId
}

function buildDocument(
    snapshot: MainCompositionSnapshot,
    now: IsoTimestamp,
    stableTargetCharacterIds?: readonly string[],
): {
    document: CompositionDocument
    selectedRecipeId: string
    directRecipeId: string
    selectedOutput: AssetProfileOutput
} {
    const context = entityContext(snapshot.profile)
    const selection = resolveMainRecipeSelection(snapshot.profile, snapshot.selectedRecipeId)
    const { directRecipeId, recipeId: selectedRecipeId } = selection
    const modules = Object.values(snapshot.profile.modules).map((module, index) => (
        buildModule(context, module, index, snapshot.output)
    ))
    const characterProjection = directCharacters(
        context,
        snapshot.characters,
        snapshot.positionEnabled,
        snapshot.characterPresets,
        snapshot.characterGroups,
    )
    const runtimeCharacters = characterProjection.characters
    const runtimeCharacterIds = runtimeCharacters.map(character => character.id)
    const stableCharacterIds = stableTargetCharacterIds === undefined
        ? runtimeCharacterIds
        : [
            ...stableTargetCharacterIds,
            ...runtimeCharacterIds.filter(id => !stableTargetCharacterIds.includes(id)),
        ]
    const recipeBuilds = snapshot.profile.recipes.map((recipe, index) => (
        buildRecipe(
            context,
            snapshot.profile,
            recipe,
            index,
            snapshot.output,
            stableCharacterIds,
        )
    ))
    const selectedBuild = recipeBuilds.find(item => item.recipe.id === selectedRecipeId)
    const syntheticCharacters = assetCharacters(
        context,
        recipeBuilds,
        new Set(stableCharacterIds),
    )
    const selectedCharacterIds = selectedBuild?.hasPromptContributions
        ? selectedBuild.assetCharacterIds
        : runtimeCharacters.map(character => character.id)
    const referenceProjection = projectCharacterResourcesToV2({
        characterImages: snapshot.references.filter(reference => reference.kind === 'character'),
        vibeImages: snapshot.references.filter(reference => reference.kind === 'vibe'),
        context,
    })
    const projectedParamsPresets = projectLegacyParamsPresets(snapshot.paramsPresets ?? [], context)
    const activeParamsPresetId = snapshot.activeParamsPresetId !== undefined
        && projectedParamsPresets.some(preset => preset.id === snapshot.activeParamsPresetId)
        ? snapshot.activeParamsPresetId
        : undefined
    const paramsPresets = projectedParamsPresets.map(preset => (
        preset.id === activeParamsPresetId
            ? { ...preset, params: legacyPresetParams(snapshot.params) }
            : preset
    ))
    const hasCharacterTemplateMetadata = (snapshot.characterPresets?.length ?? 0) > 0
        || (snapshot.characterGroups?.length ?? 0) > 0

    const directRecipe: CompositionRecipe = {
        ...revisionFields(context),
        id: directRecipeId,
        orderKey: 'recipe:direct',
        name: 'Direct prompts',
        enabled: true,
        steps: [],
        outputPolicy: outputPolicy(
            snapshot.output,
            undefined,
            snapshot.source.hasMask
                ? 'NAI_Blue_INPAINT_{timestamp}'
                : snapshot.source.hasSourceImage
                    ? 'NAI_Blue_I2I_{timestamp}'
                    : 'NAI_Blue_{timestamp}',
        ),
    }
    const profile: CompositionProfile = {
        ...revisionFields(context),
        id: MAIN_COMPOSITION_PROFILE_ID,
        orderKey: 'profile:main',
        name: readString(snapshot.profile.settings, 'name') ?? snapshot.profile.updatedBy,
        enabled: true,
        moduleIds: modules.map(module => module.id),
        recipeIds: [directRecipeId, ...recipeBuilds.map(item => item.recipe.id)],
        characterIds: selectedCharacterIds,
        paramsPresetIds: paramsPresets.map(preset => preset.id),
        resourceBindings: referenceProjection.bindings,
        randomRuleIds: [],
        defaultRecipeId: selectedRecipeId,
        contributions: [],
        characterPatches: [],
        ...(activeParamsPresetId === undefined ? {} : { defaultParamsPresetId: activeParamsPresetId }),
        ...(hasCharacterTemplateMetadata ? { extensions: characterProjection.templateExtensions } : {}),
        ...(selectedBuild === undefined
            || legacySettingsToParamsOverride(snapshot.profile.settings) === undefined
            ? {}
            : { paramsOverride: legacySettingsToParamsOverride(snapshot.profile.settings) }),
        outputPolicy: outputPolicy(
            snapshot.output,
            selectedBuild === undefined ? undefined : snapshot.profile.output,
        ),
    }

    const document: CompositionDocument = {
        ...revisionFields({ ...context, timestamp: now }),
        schemaVersion: COMPOSITION_SCHEMA_VERSION,
        id: MAIN_COMPOSITION_DOCUMENT_ID,
        profiles: [profile],
        modules,
        recipes: [directRecipe, ...recipeBuilds.map(item => item.recipe)],
        characters: [...runtimeCharacters, ...syntheticCharacters],
        paramsPresets,
        resources: [...referenceProjection.resources, ...sourceResources(context, snapshot.source)],
        randomRules: [],
        activeProfileId: MAIN_COMPOSITION_PROFILE_ID,
    }
    return {
        document,
        selectedRecipeId,
        directRecipeId,
        selectedOutput: selectedBuild?.output ?? {},
    }
}

function sourceOverride(source: MainSourceSnapshot): ParamsOverride {
    const sourceMode: ParamsOverride['sourceMode'] = source.hasMask
        ? 'inpaint'
        : source.hasSourceImage
            ? 'image-to-image'
            : 'text-to-image'
    return {
        width: source.width,
        height: source.height,
        sourceMode,
        ...(source.hasSourceImage ? { sourceImageResourceId: 'main-resource:source-image' } : {}),
        ...(source.hasMask ? { maskResourceId: 'main-resource:mask' } : {}),
        strength: source.strength,
        noise: source.noise,
    }
}

function mergeEntitiesByKey<T>(
    authoritative: readonly T[],
    runtime: readonly T[],
    keyOf: (value: T) => string,
): T[] {
    const merged = new Map(authoritative.map(entity => [keyOf(entity), entity]))
    for (const entity of runtime) merged.set(keyOf(entity), entity)
    return [...merged.values()]
}

function hasLegacySidecarExtension(
    entity: { extensions?: Record<string, unknown> },
    key: 'legacyScene' | 'legacyPromptPreset',
): boolean {
    return isRecord(entity.extensions)
        && Object.prototype.hasOwnProperty.call(entity.extensions, key)
}

function isRepositorySidecarModule(module: CompositionModule): boolean {
    return hasLegacySidecarExtension(module, 'legacyScene')
        || hasLegacySidecarExtension(module, 'legacyPromptPreset')
}

function isRepositorySidecarRecipe(recipe: CompositionRecipe): boolean {
    return hasLegacySidecarExtension(recipe, 'legacyScene')
}

function isMainRuntimeResourceId(id: string): boolean {
    return id.startsWith('main-resource:')
}

function repositoryBackedMainDocument(
    transient: ReturnType<typeof buildDocument>,
    authoritative: CompositionDocument | null,
): ReturnType<typeof buildDocument> & { profileId: string } {
    if (authoritative === null) {
        return { ...transient, profileId: MAIN_COMPOSITION_PROFILE_ID }
    }

    const profile = authoritative.profiles.find(candidate => (
        candidate.id === authoritative.activeProfileId && candidate.enabled
    )) ?? authoritative.profiles.find(candidate => candidate.enabled)
    if (profile === undefined) {
        // Preserve the repository document and let the engine return a strict
        // missing-profile error. Falling back to a legacy-derived document here
        // would silently bypass v2 authority.
        return {
            ...transient,
            document: authoritative,
            profileId: authoritative.activeProfileId ?? 'composition:profile-missing',
        }
    }

    const transientProfile = transient.document.profiles[0]
    if (transientProfile === undefined) {
        throw new Error('Main transient profile projection is missing')
    }

    // The repository remains the verified document/revision authority. These
    // compatibility entities are deliberately overlaid from live stores so a
    // character/profile/preset edit takes effect without a restart. Migrated
    // Scene and prompt-preset modules remain repository-owned sidecars.
    const sidecarModules = authoritative.modules.filter(isRepositorySidecarModule)
    const sidecarRecipes = authoritative.recipes.filter(isRepositorySidecarRecipe)
    const liveModules = transient.document.modules
    const liveRecipes = transient.document.recipes.filter(recipe => recipe.id !== transient.directRecipeId)
    const modules = mergeEntitiesByKey(liveModules, sidecarModules, module => module.id)

    let selectedRecipeId = transient.selectedRecipeId
    let directRecipeId = transient.directRecipeId
    const recipes = mergeEntitiesByKey(liveRecipes, sidecarRecipes, recipe => recipe.id)
    const profileRecipeIds = recipes.map(recipe => recipe.id)
    const directRequested = transient.selectedRecipeId === transient.directRecipeId
    if (directRequested) {
        while (recipes.some(recipe => recipe.id === directRecipeId)) {
            directRecipeId = `${directRecipeId}:synthetic`
        }
        const transientDirect = transient.document.recipes.find(recipe => recipe.id === transient.directRecipeId)
        if (transientDirect === undefined) {
            throw new Error('Main direct recipe projection is missing')
        }
        recipes.push({ ...transientDirect, id: directRecipeId })
        profileRecipeIds.push(directRecipeId)
        selectedRecipeId = directRecipeId
    }

    const repositoryBindings = profile.resourceBindings.filter(binding => (
        !isMainRuntimeResourceId(binding.resourceId)
    ))
    const runtimeBindings = transientProfile.resourceBindings
    const resourceBindings = mergeEntitiesByKey(
        repositoryBindings,
        runtimeBindings,
        binding => binding.resourceId,
    )
    const {
        defaultParamsPresetId: _staleDefaultParamsPresetId,
        paramsOverride: _staleParamsOverride,
        ...profileWithoutOptionalLiveFields
    } = profile
    const profiles = authoritative.profiles.map(candidate => candidate.id === profile.id
        ? {
            ...profileWithoutOptionalLiveFields,
            ...transientProfile,
            id: candidate.id,
            orderKey: candidate.orderKey,
            extensions: {
                ...(candidate.extensions ?? {}),
                ...(transientProfile.extensions ?? {}),
            },
            moduleIds: modules.map(module => module.id),
            recipeIds: profileRecipeIds,
            characterIds: transientProfile.characterIds,
            paramsPresetIds: transientProfile.paramsPresetIds,
            resourceBindings,
            defaultRecipeId: selectedRecipeId,
        }
        : candidate)
    const repositoryResources = authoritative.resources.filter(resource => (
        !isMainRuntimeResourceId(resource.id)
    ))
    const resources = mergeEntitiesByKey(
        repositoryResources,
        transient.document.resources,
        resource => resource.id,
    )

    return {
        ...transient,
        document: {
            ...authoritative,
            profiles,
            modules,
            recipes,
            characters: transient.document.characters,
            paramsPresets: transient.document.paramsPresets,
            resources,
        },
        profileId: profile.id,
        selectedRecipeId,
        directRecipeId,
    }
}

export function buildMainResolveRequest(input: BuildMainCompositionInput): {
    request: ResolveRequest
    engineDefaults: ResolvedGenerationParams
    selectedRecipeId: string
    directRecipeId: string
    selectedOutput: AssetProfileOutput
} {
    const authoritative = getRuntimeCompositionDocument()
    const authoritativeProfile = authoritative?.profiles.find(candidate => (
        candidate.id === authoritative.activeProfileId && candidate.enabled
    )) ?? authoritative?.profiles.find(candidate => candidate.enabled)
    const built = repositoryBackedMainDocument(
        buildDocument(input.snapshot, input.now, authoritativeProfile?.characterIds),
        authoritative,
    )
    const actor: ActorRef = { kind: 'user', id: 'main-runtime:user' }
    return {
        request: {
            schemaVersion: COMPOSITION_SCHEMA_VERSION,
            requestId: input.requestId,
            requestedAt: input.now,
            requestedBy: actor,
            document: built.document,
            profileId: built.profileId,
            recipeId: built.selectedRecipeId,
            contributions: directContributions(entityContext(input.snapshot.profile), input.snapshot.prompt),
            characterPatches: [],
            resourceBindings: [],
            randomSeed: input.seed,
        },
        engineDefaults: { ...input.snapshot.params, seed: input.seed },
        selectedRecipeId: built.selectedRecipeId,
        directRecipeId: built.directRecipeId,
        selectedOutput: built.selectedOutput,
    }
}

function materializeOutput(
    plan: DeepReadonly<CompositionEnginePlan>,
    snapshot: MainCompositionSnapshot,
    selectedOutput: AssetProfileOutput,
    selectedRecipeId: string,
    now: IsoTimestamp,
): MainOutputMaterialization {
    const format = plan.outputPolicy.format
    const date = new Date(now)
    const rawDirectory = selectedOutput.directory?.trim()
        || snapshot.output.savePath.trim()
        || 'NAI_Blue_Output'
    const materializedDirectory = plan.outputPolicy.destination.kind === 'filesystem'
        && plan.outputPolicy.destination.directory.kind === 'standard'
        ? plan.outputPolicy.destination.directory.segments.join('/') || 'NAI_Blue_Output'
        : rawDirectory
    const runtimeFallbackDirectory = isAbsolutePath(snapshot.output.savePath)
        ? 'NAI_Blue_Output'
        : portableSegments(snapshot.output.savePath).join('/') || 'NAI_Blue_Output'
    const fileName = renderFilenameTemplate({
        template: plan.filenamePolicyInput.template,
        context: {
            profile: plan.filenamePolicyInput.profileName,
            recipe: {
                id: selectedRecipeId,
                label: plan.filenamePolicyInput.recipeName,
            },
            now: date,
            date,
            time: date,
            seed: plan.params.seed,
            document: plan.documentId,
            documentId: plan.documentId,
            profileId: plan.profileId,
            recipeId: plan.recipeId,
            requestId: plan.requestId,
            request: plan.requestId,
            timestamp: date.getTime(),
        },
        now: date,
        fallback: createFallbackFilename(date),
    })
    return {
        directory: materializedDirectory,
        ...(plan.outputPolicy.destination.kind === 'filesystem'
            ? {
                portableDirectory: plan.outputPolicy.destination.directory.kind === 'standard'
                    ? {
                        kind: 'standard' as const,
                        root: plan.outputPolicy.destination.directory.root,
                        segments: [...plan.outputPolicy.destination.directory.segments],
                    }
                    : {
                        kind: 'bookmark' as const,
                        bookmarkId: plan.outputPolicy.destination.directory.bookmarkId,
                        segments: [...plan.outputPolicy.destination.directory.segments],
                    },
            }
            : {}),
        fileName,
        format,
        metadataMode: plan.outputPolicy.metadataMode,
        autoSave: plan.outputPolicy.destination.kind === 'filesystem',
        useAbsolutePath: plan.outputPolicy.destination.kind === 'filesystem'
            && plan.outputPolicy.destination.directory.kind === 'bookmark',
        capabilityFallbackDirectory: runtimeFallbackDirectory,
    }
}

export function resolveMainComposition(input: BuildMainCompositionInput): MainCompositionResolution {
    const built = buildMainResolveRequest(input)
    const result = CompositionEngine.resolve({
        request: built.request,
        now: input.now,
        engineDefaults: built.engineDefaults,
        fragment: {
            ...input.fragment,
            mode: input.fragmentMode ?? input.fragment.mode,
        },
        referencePolicy: 'strict',
        dedupePolicy: 'exact-token',
        transportDerivedOverride: {
            params: sourceOverride(input.snapshot.source),
            sourceRef: { kind: 'external', source: 'main-runtime:transport-derived' },
        },
    })
    return {
        result,
        selectedRecipeId: built.selectedRecipeId,
        directRecipeId: built.directRecipeId,
        output: result.success
            ? materializeOutput(
                result.plan,
                input.snapshot,
                built.selectedOutput,
                built.selectedRecipeId,
                input.now,
            )
            : null,
    }
}

export function diagnosticsFromMainResolution(
    resolution: MainCompositionResolution,
): MainCompositionDiagnostics {
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
