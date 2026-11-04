import { createCompositionPlanHash, type CompositionPlanHash } from './canonical-serialize'
import {
    DEFAULT_FRAGMENT_MAX_RECURSION,
    resolveFragments,
    type FragmentLookup,
    type FragmentResolutionIssue,
    type FragmentResolutionIssueCode,
    type FragmentResolutionMode,
    type FragmentSequenceCommitProposal,
    type FragmentSequenceSnapshot,
    type FragmentStrictnessPolicy,
} from './fragment-resolver'
import {
    CORE_PARAMS_FIELDS,
    PARAMS_PRECEDENCE_ORDER,
    mergeParamsByPrecedence,
    type CoreParams,
    type CoreParamsField,
    type ParamsPrecedenceLayer,
    type ParamsPrecedenceSource,
    type ResourceBindingOperation,
} from './precedence'
import {
    composePromptContributions,
    finalizePromptComposition,
    removePromptCommentLines,
    type PromptDedupePolicy,
} from './prompt-normalizer'
import {
    CompositionProvenanceCollector,
    createEntityProvenanceRef,
    createExternalProvenanceRef,
    createImmutableSerializableSnapshot,
    createRequestProvenanceRef,
    dedupeProvenanceChain,
    flattenProvenanceRefs,
    type CompositionProvenance,
    type DeepReadonly,
    type ParamsLayerProvenance,
} from './provenance'
import { createDeterministicRandom, normalizeGenerationSeed } from './random'
import { safeParseCompositionDocument } from './schema'
import type {
    CharacterDefinition,
    CharacterPosition,
    CharacterResourceBinding,
    CharacterSlotPatch,
    CompositionDocument,
    CompositionModule,
    CompositionProfile,
    CompositionRecipe,
    EntityId,
    Extensions,
    IsoTimestamp,
    OutputPolicy,
    ParamsOverride,
    ParamsPreset,
    PromptContribution,
    PromptTarget,
    ProvenanceRef,
    RandomRule,
    RandomScalar,
    RandomTraceEntry,
    RecipeStep,
    ResolveRequest,
    ResolvedCharacterPrompt,
    ResolvedGenerationParams,
    ResolvedGenerationPlan,
    ResolutionIssue,
    ResolutionIssueCode,
    ResolutionIssueEntityRef,
    ResourceBinding,
    ResourceRef,
} from './types'
import {
    createResolutionIssue,
    validateCharacterPositionModes,
    validateParamsRanges,
    validateUnknownExtensions,
} from './validation'

export const COMPOSITION_ENGINE_VERSION = 'composition-engine-v1' as const

export type CompositionReferencePolicy = 'strict' | 'compatible'

export interface CompositionConditionSnapshot {
    recipeSteps?: Readonly<Record<EntityId, boolean>>
    modules?: Readonly<Record<EntityId, boolean>>
}

export interface CompositionEngineOverrideLayer extends ParamsPrecedenceLayer {
    outputPolicy?: Readonly<OutputPolicy>
    sourceRef?: Readonly<ProvenanceRef>
}

export interface CompositionEngineFragmentInput {
    lookup: FragmentLookup
    sequenceSnapshot: FragmentSequenceSnapshot
    mode: FragmentResolutionMode
    strictness: FragmentStrictnessPolicy
    maxRecursion?: number
}

export interface CompositionEngineResolveInput {
    request: Readonly<ResolveRequest>
    /** Deterministic replacement for ambient time in filename policy inputs. */
    now: IsoTimestamp
    /** Complete lowest-precedence values; the engine invents no generation defaults. */
    engineDefaults: Readonly<ResolvedGenerationParams>
    fragment: CompositionEngineFragmentInput
    referencePolicy?: CompositionReferencePolicy
    conditionSnapshot?: CompositionConditionSnapshot
    randomScope?: string
    dedupePolicy?: PromptDedupePolicy
    promptTextMode?: 'verbatim'
    sceneOverride?: CompositionEngineOverrideLayer
    workflowRuntimeOverride?: CompositionEngineOverrideLayer
    transportDerivedOverride?: CompositionEngineOverrideLayer
    capabilitySafetyClamp?: CompositionEngineOverrideLayer
}

export interface FilenamePolicyInput {
    template: string
    format: OutputPolicy['format']
    collisionPolicy: OutputPolicy['collisionPolicy']
    now: IsoTimestamp
    seed: number
    documentId: EntityId
    profileId: EntityId
    profileName: string
    recipeId: EntityId
    recipeName: string
    requestId: EntityId
}

export type CompositionEngineIssueCode =
    | ResolutionIssueCode
    | FragmentResolutionIssueCode
    | 'E_DOCUMENT_SCHEMA_INVALID'
    | 'E_PROFILE_MISSING'
    | 'E_PARAMS_PRESET_MISSING'
    | 'E_CHARACTER_REF_MISSING'
    | 'E_CHAR_POSITION_OUT_OF_RANGE'
    | 'E_RANDOM_RULE_REF_MISSING'
    | 'E_RANDOM_RULE_INVALID'
    | 'E_RESOURCE_REF_MISSING'
    | 'E_RESOLVED_PARAMS_INCOMPLETE'
    | 'W_MODULE_REF_MISSING_COMPATIBILITY'
    | 'W_PARAMS_PRESET_MISSING_COMPATIBILITY'
    | 'W_CHARACTER_REF_MISSING_COMPATIBILITY'
    | 'W_RANDOM_RULE_REF_MISSING_COMPATIBILITY'
    | 'W_RESOURCE_REF_MISSING_COMPATIBILITY'

export interface CompositionEngineIssue {
    code: CompositionEngineIssueCode
    severity: 'warning' | 'error'
    messageKey: string
    sourceRef: ProvenanceRef
    entityRef?: ResolutionIssueEntityRef
    fieldPath: Array<string | number>
    repairHintKey?: string
    actionId?: string
    blocking: boolean
    fragmentId?: EntityId
    fragmentPath?: string
    fragmentStack?: EntityId[]
    extensions?: Extensions
}

export type CompositionEnginePlan = Omit<ResolvedGenerationPlan, 'issues'> & {
    promptTextMode?: 'verbatim'
    engineVersion: typeof COMPOSITION_ENGINE_VERSION
    issues: CompositionEngineIssue[]
    filenamePolicyInput: FilenamePolicyInput
    provenanceDetails: CompositionProvenance
    planHash: CompositionPlanHash
}

export interface CompositionEngineResolveSuccess {
    success: true
    plan: CompositionEnginePlan
    warnings: CompositionEngineIssue[]
    errors: []
    sequenceCommitProposal: FragmentSequenceCommitProposal | null
    usedFragmentIds: EntityId[]
}

export interface CompositionEngineResolveFailure {
    success: false
    plan: null
    warnings: CompositionEngineIssue[]
    errors: CompositionEngineIssue[]
    sequenceCommitProposal: null
    randomTrace: RandomTraceEntry[]
    usedFragmentIds: EntityId[]
}

export type CompositionEngineResolveResult = DeepReadonly<
    CompositionEngineResolveSuccess | CompositionEngineResolveFailure
>

interface ActiveStepContext {
    step: RecipeStep
    module: CompositionModule
    stepRef: ProvenanceRef
    moduleRef: ProvenanceRef
}

interface CollectedContribution {
    contribution: PromptContribution
    sourceChain: ProvenanceRef[]
    collectionIndex: number
}

interface PromptContributionOutcome {
    retainedAfterReplace: boolean
    supersededByContributionId?: EntityId
}

interface ParamsCandidate {
    layer: ParamsPrecedenceSource
    sourceRef: ProvenanceRef
    params?: Readonly<ParamsOverride>
    resourceBindingOperations?: readonly ResourceBindingOperation[]
}

interface OutputCandidate {
    policy: Readonly<OutputPolicy>
    sourceRef: ProvenanceRef
}

interface MutableCharacterState {
    definition: CharacterDefinition
    enabled: boolean
    positive: string
    negative: string
    position: CharacterPosition
    resourceBindings: CharacterResourceBinding[]
    positiveSources: ProvenanceRef[]
    negativeSources: ProvenanceRef[]
    positionSources: ProvenanceRef[]
}

interface RandomProvenanceInput {
    trace: RandomTraceEntry
    sourceChain: ProvenanceRef[]
}

interface FragmentSessionResult {
    text: string
}

function compareStableText(left: string, right: string): number {
    if (left < right) return -1
    if (left > right) return 1
    return 0
}

function compareOrdered(
    left: Readonly<{ orderKey: string; id: EntityId }>,
    right: Readonly<{ orderKey: string; id: EntityId }>,
): number {
    return compareStableText(left.orderKey, right.orderKey)
        || compareStableText(left.id, right.id)
}

function requestSource(input: CompositionEngineResolveInput, path?: readonly (string | number)[]): ProvenanceRef {
    return createRequestProvenanceRef(input.request.requestId, path)
}

function issue(
    code: CompositionEngineIssueCode,
    severity: 'warning' | 'error',
    sourceRef: ProvenanceRef,
    fieldPath: readonly (string | number)[],
    options: {
        messageKey?: string
        entityRef?: ResolutionIssueEntityRef
        repairHintKey?: string
        actionId?: string
        extensions?: Extensions
    } = {},
): CompositionEngineIssue {
    return {
        code,
        severity,
        messageKey: options.messageKey ?? `composition.issue.${code.toLowerCase()}`,
        sourceRef,
        ...(options.entityRef === undefined ? {} : { entityRef: options.entityRef }),
        fieldPath: [...fieldPath],
        ...(options.repairHintKey === undefined ? {} : { repairHintKey: options.repairHintKey }),
        ...(options.actionId === undefined ? {} : { actionId: options.actionId }),
        blocking: severity === 'error',
        ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
    }
}

function addIssue(
    value: CompositionEngineIssue | ResolutionIssue | FragmentResolutionIssue,
    warnings: CompositionEngineIssue[],
    errors: CompositionEngineIssue[],
): void {
    const cloned = { ...value, fieldPath: [...value.fieldPath] } as CompositionEngineIssue
    if (cloned.severity === 'warning' && !cloned.blocking) warnings.push(cloned)
    else errors.push({ ...cloned, severity: 'error', blocking: true })
}

function issueSortKey(value: CompositionEngineIssue): string {
    const source = value.sourceRef.kind === 'entity'
        ? `entity:${value.sourceRef.entityKind}:${value.sourceRef.entityId}:${value.sourceRef.revision}`
        : value.sourceRef.kind === 'request'
            ? `request:${value.sourceRef.requestId}`
            : `external:${value.sourceRef.source}:${value.sourceRef.digest ?? ''}`
    return JSON.stringify([value.code, source, value.entityRef ?? null, value.fieldPath])
}

function sortIssues(values: readonly CompositionEngineIssue[]): CompositionEngineIssue[] {
    return [...values].sort((left, right) => compareStableText(issueSortKey(left), issueSortKey(right)))
}

function freezeResult(
    result: CompositionEngineResolveSuccess | CompositionEngineResolveFailure,
): CompositionEngineResolveResult {
    return createImmutableSerializableSnapshot(result)
}

function failureResult(
    warnings: readonly CompositionEngineIssue[],
    errors: readonly CompositionEngineIssue[],
    randomTrace: readonly RandomTraceEntry[] = [],
    usedFragmentIds: readonly EntityId[] = [],
): CompositionEngineResolveResult {
    return freezeResult({
        success: false,
        plan: null,
        warnings: sortIssues(warnings),
        errors: sortIssues(errors),
        sequenceCommitProposal: null,
        randomTrace: [...randomTrace],
        usedFragmentIds: [...usedFragmentIds].sort(compareStableText),
    })
}

function recordUnknownExtensions(
    extensions: Readonly<Extensions> | undefined,
    sourceRef: ProvenanceRef,
    fieldPath: readonly (string | number)[],
    warnings: CompositionEngineIssue[],
    entityRef?: ResolutionIssueEntityRef,
    knownKeys: readonly string[] = [],
): void {
    for (const warning of validateUnknownExtensions({
        extensions,
        sourceRef,
        fieldPath,
        entityRef,
        knownKeys,
    })) {
        warnings.push(warning)
    }
}

function brokenReferenceIssue(
    policy: CompositionReferencePolicy,
    strictCode: CompositionEngineIssueCode,
    compatibilityCode: CompositionEngineIssueCode,
    sourceRef: ProvenanceRef,
    fieldPath: readonly (string | number)[],
    entityRef?: ResolutionIssueEntityRef,
): CompositionEngineIssue {
    if (policy === 'compatible') {
        return issue(compatibilityCode, 'warning', sourceRef, fieldPath, {
            entityRef,
            messageKey: 'composition.issue.compatibilityReferenceSkipped',
            repairHintKey: 'composition.repair.repairReference',
            actionId: 'repair-reference',
        })
    }

    if (strictCode === 'E_MODULE_REF_MISSING') {
        return createResolutionIssue('E_MODULE_REF_MISSING', {
            sourceRef,
            entityRef,
            fieldPath,
        })
    }

    return issue(strictCode, 'error', sourceRef, fieldPath, {
        entityRef,
        repairHintKey: 'composition.repair.repairReference',
        actionId: 'repair-reference',
    })
}

const POSITIVE_SLOT_INDEX: Readonly<Record<string, number>> = {
    base: 0,
    inpainting: 1,
    additional: 2,
    workflow: 3,
    scene: 3,
    style: 3,
    quality: 3,
    detail: 4,
}

function promptTargetKey(target: Readonly<PromptTarget>): string {
    switch (target.kind) {
        case 'positive':
            return `0:${POSITIVE_SLOT_INDEX[target.slot] ?? Number.MAX_SAFE_INTEGER}`
        case 'negative':
            return '1'
        case 'character':
            return `2:${target.characterId}:${target.polarity === 'positive' ? 0 : 1}`
    }
}

function compareCollectedContributions(
    left: CollectedContribution,
    right: CollectedContribution,
): number {
    return compareStableText(promptTargetKey(left.contribution.target), promptTargetKey(right.contribution.target))
        || compareOrdered(left.contribution, right.contribution)
        || left.collectionIndex - right.collectionIndex
}

function cloneContribution(
    contribution: Readonly<PromptContribution>,
    sourceChain: readonly ProvenanceRef[],
): PromptContribution {
    return {
        ...contribution,
        target: { ...contribution.target },
        provenance: dedupeProvenanceChain([
            ...(contribution.provenance ?? []),
            ...sourceChain,
        ]),
    }
}

function collectContributions(
    profile: CompositionProfile,
    activeSteps: readonly ActiveStepContext[],
    recipeRef: ProvenanceRef,
    input: CompositionEngineResolveInput,
): CollectedContribution[] {
    const result: CollectedContribution[] = []
    let collectionIndex = 0

    const append = (
        contributions: readonly PromptContribution[],
        sourceChain: readonly ProvenanceRef[],
    ): void => {
        for (const contribution of contributions) {
            if (!contribution.enabled || contribution.deletedAt !== undefined) continue
            result.push({
                contribution: cloneContribution(contribution, sourceChain),
                sourceChain: [...sourceChain],
                collectionIndex,
            })
            collectionIndex += 1
        }
    }

    append(profile.contributions, [createEntityProvenanceRef('profile', profile)])
    for (const context of activeSteps) {
        append(context.module.contributions, [context.moduleRef, context.stepRef, recipeRef])
        append(context.step.contributions, [context.moduleRef, context.stepRef, recipeRef])
    }
    append(input.request.contributions, [requestSource(input, ['contributions'])])

    return result.sort(compareCollectedContributions)
}

/**
 * Prompt operations are target-local. Only contributions before the last
 * replace are superseded; the replacing contribution and all later operations
 * remain part of the final winner chain.
 */
function promptContributionOutcomes(
    contributions: readonly CollectedContribution[],
): ReadonlyMap<EntityId, PromptContributionOutcome> {
    const byTarget = new Map<string, CollectedContribution[]>()
    for (const contribution of contributions) {
        const key = promptTargetKey(contribution.contribution.target)
        const group = byTarget.get(key) ?? []
        group.push(contribution)
        byTarget.set(key, group)
    }

    const outcomes = new Map<EntityId, PromptContributionOutcome>()
    for (const group of byTarget.values()) {
        let finalReplaceIndex = -1
        for (let index = 0; index < group.length; index += 1) {
            if (group[index].contribution.merge === 'replace') finalReplaceIndex = index
        }
        const supersedingId = finalReplaceIndex < 0
            ? undefined
            : group[finalReplaceIndex].contribution.id

        group.forEach((entry, index) => {
            outcomes.set(entry.contribution.id, index < finalReplaceIndex
                ? { retainedAfterReplace: false, supersededByContributionId: supersedingId }
                : { retainedAfterReplace: true })
        })
    }
    return outcomes
}

function randomRuleSourceSeed(rule: RandomRule, generationSeed: number): number {
    switch (rule.source.mode) {
        case 'runtime':
        case 'replay':
            return generationSeed
        case 'fixed':
        case 'seeded':
            return normalizeGenerationSeed(rule.source.seed)
    }
}

function traceWithResult(
    trace: RandomTraceEntry,
    result: RandomScalar,
    selectedOptionId?: EntityId,
): RandomTraceEntry {
    return {
        ...trace,
        result,
        ...(selectedOptionId === undefined ? {} : { selectedOptionIds: [selectedOptionId] }),
    }
}

function evaluateRandomRule(
    rule: RandomRule,
    generationSeed: number,
    scope: string,
    sourceChain: readonly ProvenanceRef[],
    warnings: CompositionEngineIssue[],
    errors: CompositionEngineIssue[],
): RandomProvenanceInput[] {
    const ruleRef = createEntityProvenanceRef('random-rule', rule)
    const chain = dedupeProvenanceChain([ruleRef, ...sourceChain])

    if (rule.source.mode === 'replay') {
        return rule.source.entries.map(entry => ({
            trace: {
                ...entry,
                ...(entry.selectedOptionIds === undefined
                    ? {}
                    : { selectedOptionIds: [...entry.selectedOptionIds] }),
                provenance: entry.provenance ?? ruleRef,
            },
            sourceChain: chain,
        }))
    }

    const streamKey = `${scope}/random-rule:${rule.id}/${rule.streamKey || rule.id}`
    const stream = createDeterministicRandom(randomRuleSourceSeed(rule, generationSeed), streamKey)
    const result: RandomProvenanceInput[] = []

    const invalid = (reason: string): RandomProvenanceInput[] => {
        addIssue(issue('E_RANDOM_RULE_INVALID', 'error', ruleRef, ['randomRules', rule.id], {
            entityRef: { kind: 'random-rule', id: rule.id },
            extensions: { reason },
        }), warnings, errors)
        return result
    }

    switch (rule.kind) {
        case 'choice': {
            let candidates = [...rule.options]
                .sort(compareOrdered)
                .filter(option => Number.isFinite(option.weight) && option.weight > 0)
            if (rule.pickCount > 0 && candidates.length === 0) return invalid('no-positive-weight-options')
            if (rule.withoutReplacement && rule.pickCount > candidates.length) {
                return invalid('pick-count-exceeds-options')
            }

            for (let pickIndex = 0; pickIndex < rule.pickCount; pickIndex += 1) {
                const totalWeight = candidates.reduce((sum, option) => sum + option.weight, 0)
                const draw = stream.nextFloat({ ruleId: rule.id, provenance: ruleRef })
                let threshold = draw.value * totalWeight
                let selectedIndex = candidates.length - 1
                for (let index = 0; index < candidates.length; index += 1) {
                    threshold -= candidates[index].weight
                    if (threshold < 0) {
                        selectedIndex = index
                        break
                    }
                }
                const selected = candidates[selectedIndex]
                result.push({
                    trace: traceWithResult(draw.trace, selected.value, selected.id),
                    sourceChain: chain,
                })
                if (rule.withoutReplacement) {
                    candidates = candidates.filter((_, index) => index !== selectedIndex)
                }
            }
            break
        }
        case 'integer-range': {
            const count = Math.floor((rule.max - rule.min) / rule.step) + 1
            if (!Number.isSafeInteger(count) || count <= 0) return invalid('invalid-integer-range')
            const draw = stream.nextInt(count, { ruleId: rule.id, provenance: ruleRef })
            result.push({
                trace: traceWithResult(draw.trace, rule.min + draw.value * rule.step),
                sourceChain: chain,
            })
            break
        }
        case 'decimal-range': {
            const draw = stream.nextFloat({ ruleId: rule.id, provenance: ruleRef })
            result.push({
                trace: traceWithResult(draw.trace, rule.min + draw.value * (rule.max - rule.min)),
                sourceChain: chain,
            })
            break
        }
        case 'boolean': {
            const draw = stream.nextFloat({ ruleId: rule.id, provenance: ruleRef })
            result.push({
                trace: traceWithResult(draw.trace, draw.value < rule.probability),
                sourceChain: chain,
            })
            break
        }
    }

    return result
}

function collectAndEvaluateRandomRules(
    document: CompositionDocument,
    profile: CompositionProfile,
    activeSteps: readonly ActiveStepContext[],
    contributions: readonly CollectedContribution[],
    recipeRef: ProvenanceRef,
    generationSeed: number,
    scope: string,
    referencePolicy: CompositionReferencePolicy,
    warnings: CompositionEngineIssue[],
    errors: CompositionEngineIssue[],
): RandomProvenanceInput[] {
    // v2 rules identify deterministic sources but do not yet type an application
    // target. Evaluate and trace them here without inventing extension-driven
    // prompt/parameter/output effects.
    const rulesById = new Map(
        document.randomRules
            .filter(rule => rule.deletedAt === undefined)
            .map(rule => [rule.id, rule]),
    )
    const references = new Map<EntityId, ProvenanceRef[]>()

    const addReferences = (ids: readonly EntityId[], sourceChain: readonly ProvenanceRef[]): void => {
        for (const id of ids) {
            references.set(id, dedupeProvenanceChain([...(references.get(id) ?? []), ...sourceChain]))
        }
    }

    addReferences(profile.randomRuleIds, [createEntityProvenanceRef('profile', profile)])
    for (const context of activeSteps) {
        addReferences(context.module.randomRuleIds, [context.moduleRef, context.stepRef, recipeRef])
        addReferences(context.step.randomRuleIds, [context.stepRef, recipeRef])
    }
    for (const collected of contributions) {
        if (collected.contribution.randomRuleId !== undefined) {
            addReferences([collected.contribution.randomRuleId], collected.sourceChain)
        }
    }

    const resolvedRules: Array<{ rule: RandomRule; sourceChain: ProvenanceRef[] }> = []
    for (const [ruleId, sourceChain] of references) {
        const rule = rulesById.get(ruleId)
        if (rule === undefined) {
            addIssue(brokenReferenceIssue(
                referencePolicy,
                'E_RANDOM_RULE_REF_MISSING',
                'W_RANDOM_RULE_REF_MISSING_COMPATIBILITY',
                sourceChain[0] ?? createExternalProvenanceRef('composition-engine:random-rule'),
                ['randomRuleIds', ruleId],
            ), warnings, errors)
            continue
        }
        if (!rule.enabled) continue
        resolvedRules.push({ rule, sourceChain })
    }

    return resolvedRules
        .sort((left, right) => compareOrdered(left.rule, right.rule))
        .flatMap(({ rule, sourceChain }) => evaluateRandomRule(
            rule,
            generationSeed,
            scope,
            sourceChain,
            warnings,
            errors,
        ))
}

class FragmentResolutionSession {
    private readonly workingCounters: Record<EntityId, number>
    private readonly stagedChanges = new Map<EntityId, FragmentSequenceCommitProposal['changes'][number]>()
    private readonly usedIds = new Set<EntityId>()
    private failed = false
    readonly randomTrace: RandomTraceEntry[] = []
    readonly randomProvenance: RandomProvenanceInput[] = []

    constructor(
        private readonly input: CompositionEngineResolveInput,
        private readonly generationSeed: number,
        private readonly warnings: CompositionEngineIssue[],
        private readonly errors: CompositionEngineIssue[],
    ) {
        this.workingCounters = { ...input.fragment.sequenceSnapshot.counters }
    }

    resolve(
        text: string,
        scope: string,
        sourceChain: readonly ProvenanceRef[],
        winnerSource: ProvenanceRef | undefined = sourceChain[0],
    ): FragmentSessionResult {
        const sourceRef = winnerSource ?? requestSource(this.input)
        const result = resolveFragments({
            text,
            seed: this.generationSeed,
            scope,
            lookup: this.input.fragment.lookup,
            sequenceSnapshot: {
                revision: this.input.fragment.sequenceSnapshot.revision,
                counters: this.workingCounters,
            },
            mode: this.input.fragment.mode,
            strictness: this.input.fragment.strictness,
            maxRecursion: this.input.fragment.maxRecursion ?? DEFAULT_FRAGMENT_MAX_RECURSION,
            sourceRef,
        })

        result.warnings.forEach(value => addIssue(value, this.warnings, this.errors))
        result.errors.forEach(value => addIssue(value, this.warnings, this.errors))
        if (result.errors.length > 0) this.failed = true

        for (const trace of result.randomTrace) {
            this.randomTrace.push(trace)
            this.randomProvenance.push({ trace, sourceChain: [...sourceChain] })
        }
        result.usedFragmentIds.forEach(id => this.usedIds.add(id))

        for (const change of result.sequenceCommitProposal?.changes ?? []) {
            this.workingCounters[change.fragmentId] = change.nextCounter
            const existing = this.stagedChanges.get(change.fragmentId)
            this.stagedChanges.set(change.fragmentId, {
                fragmentId: change.fragmentId,
                fragmentPath: existing?.fragmentPath ?? change.fragmentPath,
                expectedCounter: existing?.expectedCounter ?? change.expectedCounter,
                nextCounter: change.nextCounter,
            })
        }

        return { text: result.resolvedText }
    }

    proposal(hasEngineErrors: boolean): FragmentSequenceCommitProposal | null {
        if (
            this.input.fragment.mode !== 'generate'
            || this.failed
            || hasEngineErrors
            || this.stagedChanges.size === 0
        ) {
            return null
        }
        return {
            expectedRevision: this.input.fragment.sequenceSnapshot.revision,
            changes: [...this.stagedChanges.values()]
                .sort((left, right) => compareStableText(left.fragmentId, right.fragmentId)),
        }
    }

    usedFragmentIds(): EntityId[] {
        return [...this.usedIds].sort(compareStableText)
    }
}

function paramsOverrideFromResolved(params: Readonly<ResolvedGenerationParams>): ParamsOverride {
    return { ...params }
}

function appendResourceBindings(bindings: readonly ResourceBinding[]): ResourceBindingOperation[] {
    return bindings.length === 0 ? [] : [{ operation: 'append', bindings }]
}

function aggregateParamsLayer(candidates: readonly ParamsCandidate[]): ParamsPrecedenceLayer | undefined {
    if (candidates.length === 0) return undefined
    const params: ParamsOverride = {}
    const operations: ResourceBindingOperation[] = []
    let hasParams = false

    for (const candidate of candidates) {
        if (candidate.params !== undefined) {
            for (const field of CORE_PARAMS_FIELDS) {
                const value = candidate.params[field]
                if (value === undefined) continue
                Object.assign(params, { [field]: value })
                hasParams = true
            }
        }
        operations.push(...(candidate.resourceBindingOperations ?? []))
    }

    return {
        ...(hasParams ? { params } : {}),
        ...(operations.length === 0 ? {} : { resourceBindingOperations: operations }),
    }
}

/** Resolve only the RNG input; the full typed params merge remains stage 11. */
function resolveGenerationSeed(
    candidates: readonly ParamsCandidate[],
    fallbackSeed: number,
): number {
    let seed = fallbackSeed
    for (const layer of PARAMS_PRECEDENCE_ORDER) {
        for (const candidate of candidates) {
            if (candidate.layer === layer && candidate.params?.seed !== undefined) {
                seed = candidate.params.seed
            }
        }
    }
    return normalizeGenerationSeed(seed)
}

function paramsWinnerSource(
    candidates: readonly ParamsCandidate[],
    field: CoreParamsField,
): ProvenanceRef | undefined {
    let winner: ProvenanceRef | undefined
    for (const layer of PARAMS_PRECEDENCE_ORDER) {
        for (const candidate of candidates) {
            if (candidate.layer === layer && candidate.params?.[field] !== undefined) {
                winner = candidate.sourceRef
            }
        }
    }
    return winner
}

function overrideSource(
    layer: CompositionEngineOverrideLayer | undefined,
    fallback: string,
): ProvenanceRef {
    return layer?.sourceRef === undefined
        ? createExternalProvenanceRef(fallback)
        : { ...layer.sourceRef }
}

function buildParamsCandidates(
    input: CompositionEngineResolveInput,
    profile: CompositionProfile,
    preset: ParamsPreset | undefined,
    activeSteps: readonly ActiveStepContext[],
    recipe: CompositionRecipe,
): ParamsCandidate[] {
    const candidates: ParamsCandidate[] = [{
        layer: 'engine-defaults',
        sourceRef: createExternalProvenanceRef('composition-engine:defaults'),
        params: paramsOverrideFromResolved(input.engineDefaults),
    }]

    if (preset !== undefined) {
        candidates.push({
            layer: 'profile-defaults',
            sourceRef: createEntityProvenanceRef('params-preset', preset),
            params: preset.params,
        })
    }
    candidates.push({
        layer: 'profile-defaults',
        sourceRef: createEntityProvenanceRef('profile', profile),
        params: profile.paramsOverride,
        resourceBindingOperations: appendResourceBindings(profile.resourceBindings),
    })

    for (const context of activeSteps) {
        candidates.push({
            layer: 'module-defaults',
            sourceRef: context.moduleRef,
            params: context.module.paramsOverride,
            resourceBindingOperations: appendResourceBindings(context.module.resourceBindings),
        })
        candidates.push({
            layer: 'recipe-step-override',
            sourceRef: context.stepRef,
            params: context.step.paramsOverride,
            resourceBindingOperations: appendResourceBindings(context.step.resourceBindings),
        })
    }

    candidates.push({
        layer: 'recipe-override',
        sourceRef: createEntityProvenanceRef('recipe', recipe),
        params: recipe.paramsOverride,
    })

    const addOverride = (
        layer: ParamsPrecedenceSource,
        override: CompositionEngineOverrideLayer | undefined,
        source: string,
    ): void => {
        if (override === undefined) return
        candidates.push({
            layer,
            sourceRef: overrideSource(override, source),
            params: override.params,
            resourceBindingOperations: override.resourceBindingOperations,
        })
    }

    addOverride('scene-override', input.sceneOverride, 'composition-engine:scene-override')
    candidates.push({
        layer: 'workflow-runtime-override',
        sourceRef: requestSource(input, ['paramsOverride']),
        params: input.request.paramsOverride,
        resourceBindingOperations: appendResourceBindings(input.request.resourceBindings),
    })
    if (input.request.randomSeed !== undefined) {
        candidates.push({
            layer: 'workflow-runtime-override',
            sourceRef: requestSource(input, ['randomSeed']),
            params: { seed: normalizeGenerationSeed(input.request.randomSeed) },
        })
    }
    addOverride(
        'workflow-runtime-override',
        input.workflowRuntimeOverride,
        'composition-engine:workflow-runtime-override',
    )
    addOverride(
        'transport-derived-override',
        input.transportDerivedOverride,
        'composition-engine:transport-derived-override',
    )
    addOverride(
        'capability-safety-clamp',
        input.capabilitySafetyClamp,
        'composition-engine:capability-safety-clamp',
    )

    return candidates
}

function buildResolvedParams(core: CoreParams): ResolvedGenerationParams | null {
    const required: Array<keyof ResolvedGenerationParams> = [
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
        'qualityToggle',
        'ucPreset',
        'sourceMode',
        'strength',
        'noise',
        'characterPositionEnabled',
    ]
    if (required.some(field => core[field] === undefined)) return null

    return {
        model: core.model as string,
        width: core.width as number,
        height: core.height as number,
        steps: core.steps as number,
        cfgScale: core.cfgScale as number,
        cfgRescale: core.cfgRescale as number,
        sampler: core.sampler as string,
        scheduler: core.scheduler as string,
        smea: core.smea as boolean,
        smeaDyn: core.smeaDyn as boolean,
        variety: core.variety as boolean,
        seed: core.seed as number,
        qualityToggle: core.qualityToggle as boolean,
        ucPreset: core.ucPreset as number,
        // Older documents predate V5 transparency, so absence remains the
        // stable opaque-background behavior instead of invalidating the plan.
        transparentBackground: core.transparentBackground ?? false,
        sourceMode: core.sourceMode as ResolvedGenerationParams['sourceMode'],
        ...(core.sourceImageResourceId === undefined
            ? {}
            : { sourceImageResourceId: core.sourceImageResourceId }),
        ...(core.maskResourceId === undefined ? {} : { maskResourceId: core.maskResourceId }),
        strength: core.strength as number,
        noise: core.noise as number,
        characterPositionEnabled: core.characterPositionEnabled as boolean,
    }
}

function applyCharacterPatch(
    state: MutableCharacterState,
    patch: Readonly<CharacterSlotPatch>,
    sourceRef: ProvenanceRef,
): void {
    if (patch.enabled !== undefined) state.enabled = patch.enabled
    if (patch.positivePrompt !== undefined) {
        state.positive = patch.positivePrompt
        state.positiveSources.push(sourceRef)
    }
    if (patch.negativePrompt !== undefined) {
        state.negative = patch.negativePrompt
        state.negativeSources.push(sourceRef)
    }
    if (patch.position !== undefined) {
        state.position = { ...patch.position }
        state.positionSources.push(sourceRef)
    }
    if (patch.resourceBindings !== undefined) {
        state.resourceBindings = patch.resourceBindings.map(binding => ({ ...binding }))
    }
}

function resolveSelectedCharacters(
    document: CompositionDocument,
    profile: CompositionProfile,
    activeSteps: readonly ActiveStepContext[],
    input: CompositionEngineResolveInput,
    referencePolicy: CompositionReferencePolicy,
    warnings: CompositionEngineIssue[],
    errors: CompositionEngineIssue[],
): Map<EntityId, MutableCharacterState> {
    const charactersById = new Map(
        document.characters
            .filter(character => character.deletedAt === undefined)
            .map(character => [character.id, character]),
    )
    const selected = new Map<EntityId, MutableCharacterState>()
    const profileRef = createEntityProvenanceRef('profile', profile)

    for (const [index, characterId] of profile.characterIds.entries()) {
        const character = charactersById.get(characterId)
        if (character === undefined) {
            addIssue(brokenReferenceIssue(
                referencePolicy,
                'E_CHARACTER_REF_MISSING',
                'W_CHARACTER_REF_MISSING_COMPATIBILITY',
                profileRef,
                ['profiles', profile.id, 'characterIds', index],
            ), warnings, errors)
            continue
        }
        const characterRef = createEntityProvenanceRef('character', character)
        selected.set(character.id, {
            definition: character,
            enabled: character.enabled,
            positive: character.positivePrompt,
            negative: character.negativePrompt,
            position: { ...character.position },
            resourceBindings: character.resourceBindings.map(binding => ({ ...binding })),
            positiveSources: [characterRef],
            negativeSources: [characterRef],
            positionSources: [characterRef],
        })
    }

    const applyPatches = (
        patches: readonly CharacterSlotPatch[],
        sourceRef: ProvenanceRef,
        fieldPath: readonly (string | number)[],
    ): void => {
        patches.forEach((patch, index) => {
            const character = selected.get(patch.characterId)
            if (character === undefined) {
                addIssue(brokenReferenceIssue(
                    referencePolicy,
                    'E_CHARACTER_REF_MISSING',
                    'W_CHARACTER_REF_MISSING_COMPATIBILITY',
                    sourceRef,
                    [...fieldPath, index, 'characterId'],
                ), warnings, errors)
                return
            }
            applyCharacterPatch(character, patch, sourceRef)
        })
    }

    applyPatches(profile.characterPatches, profileRef, ['profiles', profile.id, 'characterPatches'])
    for (const context of activeSteps) {
        applyPatches(
            context.module.characterPatches,
            context.moduleRef,
            ['modules', context.module.id, 'characterPatches'],
        )
        applyPatches(
            context.step.characterPatches,
            context.stepRef,
            ['recipes', context.step.id, 'characterPatches'],
        )
    }
    applyPatches(
        input.request.characterPatches,
        requestSource(input, ['characterPatches']),
        ['request', 'characterPatches'],
    )

    return selected
}

function validateResolvedCharacterCoordinates(
    characters: readonly MutableCharacterState[],
    warnings: CompositionEngineIssue[],
    errors: CompositionEngineIssue[],
): void {
    for (const character of characters) {
        if (!character.enabled || character.position.mode !== 'manual') continue
        for (const coordinate of ['x', 'y'] as const) {
            const value = character.position[coordinate]
            if (Number.isFinite(value) && value >= 0 && value <= 1) continue
            addIssue(issue(
                'E_CHAR_POSITION_OUT_OF_RANGE',
                'error',
                character.positionSources[character.positionSources.length - 1]
                    ?? createEntityProvenanceRef('character', character.definition),
                ['characters', character.definition.id, 'position', coordinate],
                {
                    messageKey: 'composition.issue.characterPositionOutOfRange',
                    entityRef: { kind: 'character', id: character.definition.id },
                    repairHintKey: 'composition.repair.clampCharacterPosition',
                    actionId: 'clamp-character-position',
                },
            ), warnings, errors)
        }
    }
}

function buildOutputCandidates(
    input: CompositionEngineResolveInput,
    profile: CompositionProfile,
    activeSteps: readonly ActiveStepContext[],
    recipe: CompositionRecipe,
): OutputCandidate[] {
    const candidates: OutputCandidate[] = [{
        policy: profile.outputPolicy,
        sourceRef: createEntityProvenanceRef('profile', profile),
    }]
    for (const context of activeSteps) {
        if (context.module.outputPolicy !== undefined) {
            candidates.push({ policy: context.module.outputPolicy, sourceRef: context.moduleRef })
        }
        if (context.step.outputPolicy !== undefined) {
            candidates.push({ policy: context.step.outputPolicy, sourceRef: context.stepRef })
        }
    }
    if (recipe.outputPolicy !== undefined) {
        candidates.push({ policy: recipe.outputPolicy, sourceRef: createEntityProvenanceRef('recipe', recipe) })
    }
    if (input.sceneOverride?.outputPolicy !== undefined) {
        candidates.push({
            policy: input.sceneOverride.outputPolicy,
            sourceRef: overrideSource(input.sceneOverride, 'composition-engine:scene-output'),
        })
    }
    if (input.request.outputPolicy !== undefined) {
        candidates.push({
            policy: input.request.outputPolicy,
            sourceRef: requestSource(input, ['outputPolicy']),
        })
    }
    for (const [override, source] of [
        [input.workflowRuntimeOverride, 'composition-engine:workflow-output'],
        [input.transportDerivedOverride, 'composition-engine:transport-output'],
        [input.capabilitySafetyClamp, 'composition-engine:capability-output'],
    ] as const) {
        if (override?.outputPolicy !== undefined) {
            candidates.push({ policy: override.outputPolicy, sourceRef: overrideSource(override, source) })
        }
    }
    return candidates
}

function semanticOutputPolicy(policy: OutputPolicy): unknown {
    return {
        destination: policy.destination.kind === 'memory'
            ? { kind: 'memory' }
            : {
                kind: 'filesystem',
                directory: policy.destination.directory.kind === 'standard'
                    ? {
                        kind: 'standard',
                        root: policy.destination.directory.root,
                        segments: [...policy.destination.directory.segments],
                    }
                    : {
                        kind: 'bookmark',
                        bookmarkId: policy.destination.directory.bookmarkId,
                        segments: [...policy.destination.directory.segments],
                    },
            },
        format: policy.format,
        filenameTemplate: policy.filenameTemplate,
        metadataMode: policy.metadataMode,
        collisionPolicy: policy.collisionPolicy,
    }
}

/**
 * Keeps stable URI location semantics without hashing userinfo, query values,
 * or fragments that commonly carry credentials and signed-URL material.
 * Callers should provide ResourceRef.contentHash (or the legacy digest) when
 * query values identify content.
 */
function credentialRedactedUri(uri: string): string {
    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(uri)?.[1].toLowerCase()
    if (scheme === 'data') {
        const commaIndex = uri.indexOf(',')
        const mediaType = commaIndex < 0 ? '' : uri.slice('data:'.length, commaIndex)
        return `data:${mediaType},[redacted]`
    }
    if (scheme === 'blob') return 'blob:[redacted]'

    const fragmentIndex = uri.indexOf('#')
    const withoutFragment = fragmentIndex < 0 ? uri : uri.slice(0, fragmentIndex)
    const queryIndex = withoutFragment.indexOf('?')
    const base = queryIndex < 0 ? withoutFragment : withoutFragment.slice(0, queryIndex)
    const query = queryIndex < 0 ? '' : withoutFragment.slice(queryIndex + 1)

    const authorityMatch = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/]*)(.*)$/.exec(base)
    const redactedBase = authorityMatch === null
        ? base
        : `${authorityMatch[1]}${authorityMatch[2].replace(/^.*@/, '')}${authorityMatch[3]}`
    if (query.length === 0) return redactedBase

    const queryKeys = query
        .split('&')
        .filter(part => part.length > 0)
        .map(part => part.split('=', 1)[0])
    return queryKeys.length === 0 ? redactedBase : `${redactedBase}?${queryKeys.join('&')}`
}

function semanticResource(resource: ResourceRef): unknown {
    const common = {
        id: resource.id,
        kind: resource.kind,
        enabled: resource.enabled,
        role: resource.role,
        ...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
        ...(resource.contentHash === undefined
            ? {}
            : { contentHash: { ...resource.contentHash } }),
        ...(resource.digest === undefined ? {} : { digest: resource.digest }),
    }
    switch (resource.kind) {
        case 'managed':
            return { ...common, resourceId: resource.resourceId }
        case 'library-image':
            return { ...common, libraryImageId: resource.libraryImageId }
        case 'path':
            return {
                ...common,
                path: resource.path.kind === 'standard'
                    ? { kind: 'standard', root: resource.path.root, segments: [...resource.path.segments] }
                    : {
                        kind: 'bookmark',
                        bookmarkId: resource.path.bookmarkId,
                        segments: [...resource.path.segments],
                    },
            }
        case 'uri':
            return { ...common, uri: credentialRedactedUri(resource.uri) }
    }
}

function semanticBinding(binding: ResourceBinding): unknown {
    return {
        resourceId: binding.resourceId,
        enabled: binding.enabled,
        referenceType: binding.referenceType,
        strength: binding.strength,
        ...(binding.fidelity === undefined ? {} : { fidelity: binding.fidelity }),
        ...(binding.informationExtracted === undefined
            ? {}
            : { informationExtracted: binding.informationExtracted }),
    }
}

function semanticFilenamePolicyInput(input: FilenamePolicyInput): unknown {
    const tokens = new Set<string>()
    const tokenPattern = /\{([A-Za-z][A-Za-z0-9_.-]*)(?::[^{}]+)?\}/g
    let match: RegExpExecArray | null
    while ((match = tokenPattern.exec(input.template)) !== null) tokens.add(match[1])

    const usesAny = (...names: readonly string[]): boolean => names.some(name => tokens.has(name))
    return {
        template: input.template,
        format: input.format,
        collisionPolicy: input.collisionPolicy,
        values: {
            ...(usesAny('seed') ? { seed: input.seed } : {}),
            ...(usesAny('now', 'date', 'time', 'datetime', 'timestamp') ? { now: input.now } : {}),
            ...(usesAny('document', 'documentId') ? { documentId: input.documentId } : {}),
            ...(usesAny('profile') ? { profile: input.profileName } : {}),
            ...(usesAny('profileId') ? { profileId: input.profileId } : {}),
            ...(usesAny('recipeId', 'recipe.id') ? { recipeId: input.recipeId } : {}),
            ...(usesAny('recipe.label') ? { recipeLabel: input.recipeName } : {}),
            ...(usesAny('request', 'requestId') ? { requestId: input.requestId } : {}),
        },
    }
}

function semanticPlanProjection(plan: Omit<CompositionEnginePlan, 'planHash' | 'planId'>): unknown {
    return {
        ...(plan.promptTextMode === undefined ? {} : { promptTextMode: plan.promptTextMode }),
        schemaVersion: plan.schemaVersion,
        positivePrompt: plan.positivePrompt,
        negativePrompt: plan.negativePrompt,
        promptParts: {
            base: plan.promptParts.base,
            inpainting: plan.promptParts.inpainting,
            additional: plan.promptParts.additional,
            workflow: plan.promptParts.workflow,
            detail: plan.promptParts.detail,
            negative: plan.promptParts.negative,
        },
        characters: plan.characters.filter(character => character.enabled).map(character => ({
            characterId: character.characterId,
            positive: character.positive,
            negative: character.negative,
            enabled: character.enabled,
            position: character.position.mode === 'ai-choice'
                ? { mode: 'ai-choice' }
                : { mode: 'manual', x: character.position.x, y: character.position.y },
            resourceBindings: character.resourceBindings
                .filter(binding => binding.enabled)
                .map(semanticBinding),
        })),
        params: plan.params,
        outputPolicy: semanticOutputPolicy(plan.outputPolicy),
        resources: plan.resources.map(semanticResource),
        resourceBindings: plan.resourceBindings.filter(binding => binding.enabled).map(semanticBinding),
        filenamePolicyInput: semanticFilenamePolicyInput(plan.filenamePolicyInput),
    }
}

function referencedResources(
    document: CompositionDocument,
    params: ResolvedGenerationParams,
    resourceBindings: readonly ResourceBinding[],
    characters: readonly ResolvedCharacterPrompt[],
    referencePolicy: CompositionReferencePolicy,
    input: CompositionEngineResolveInput,
    warnings: CompositionEngineIssue[],
    errors: CompositionEngineIssue[],
): ResourceRef[] {
    const ids = new Set<EntityId>()
    resourceBindings.filter(binding => binding.enabled).forEach(binding => ids.add(binding.resourceId))
    characters.filter(character => character.enabled).forEach(character => (
        character.resourceBindings.filter(binding => binding.enabled).forEach(binding => ids.add(binding.resourceId))
    ))
    if (params.sourceImageResourceId !== undefined) ids.add(params.sourceImageResourceId)
    if (params.maskResourceId !== undefined) ids.add(params.maskResourceId)

    const resourcesById = new Map(
        document.resources
            .filter(resource => resource.deletedAt === undefined)
            .map(resource => [resource.id, resource]),
    )
    const resources: ResourceRef[] = []
    for (const resourceId of [...ids].sort(compareStableText)) {
        const resource = resourcesById.get(resourceId)
        if (resource === undefined) {
            addIssue(brokenReferenceIssue(
                referencePolicy,
                'E_RESOURCE_REF_MISSING',
                'W_RESOURCE_REF_MISSING_COMPATIBILITY',
                requestSource(input),
                ['resources', resourceId],
            ), warnings, errors)
            continue
        }
        resources.push(resource)
    }
    return resources.sort(compareOrdered)
}

/** Pure Composition Domain v2 resolver. No store, transport, filesystem, or persistence calls. */
export function resolveComposition(
    input: CompositionEngineResolveInput,
): CompositionEngineResolveResult {
    const warnings: CompositionEngineIssue[] = []
    const errors: CompositionEngineIssue[] = []
    const parsed = safeParseCompositionDocument(input.request.document)

    if (!parsed.success) {
        for (const schemaIssue of parsed.issues) {
            errors.push(issue(
                'E_DOCUMENT_SCHEMA_INVALID',
                'error',
                requestSource(input, ['document']),
                ['document', ...schemaIssue.path],
                {
                    messageKey: 'composition.issue.documentSchemaInvalid',
                    repairHintKey: 'composition.repair.repairDocument',
                    actionId: 'repair-document',
                    extensions: {
                        schemaIssueCode: schemaIssue.code,
                        ...(schemaIssue.expected === undefined ? {} : { expected: schemaIssue.expected }),
                    },
                },
            ))
        }
        return failureResult(warnings, errors)
    }

    const document = parsed.data
    const referencePolicy = input.referencePolicy ?? 'strict'
    const requestRef = requestSource(input)
    recordUnknownExtensions(document.extensions, requestRef, ['document', 'extensions'], warnings)
    recordUnknownExtensions(input.request.extensions, requestRef, ['request', 'extensions'], warnings)

    const profile = document.profiles.find(candidate => (
        candidate.id === input.request.profileId
        && candidate.deletedAt === undefined
        && candidate.enabled
    ))
    if (profile === undefined) {
        errors.push(issue('E_PROFILE_MISSING', 'error', requestRef, ['profileId'], {
            messageKey: 'composition.issue.profileMissing',
            repairHintKey: 'composition.repair.selectProfile',
            actionId: 'select-profile',
        }))
        return failureResult(warnings, errors)
    }
    const profileRef = createEntityProvenanceRef('profile', profile)
    recordUnknownExtensions(
        profile.extensions,
        profileRef,
        ['profiles', profile.id, 'extensions'],
        warnings,
        { kind: 'profile', id: profile.id },
        ['legacyCharacterTemplates'],
    )

    // Recipe selection is request-explicit. No first-enabled or implicit default fallback exists.
    const recipeId = input.request.recipeId
    const recipe = recipeId === undefined
        ? undefined
        : document.recipes.find(candidate => (
            candidate.id === recipeId
            && candidate.deletedAt === undefined
            && candidate.enabled
            && profile.recipeIds.includes(candidate.id)
        ))
    if (recipe === undefined) {
        errors.push(createResolutionIssue('E_RECIPE_MISSING', {
            sourceRef: requestRef,
            entityRef: { kind: 'profile', id: profile.id },
            fieldPath: ['recipeId'],
        }))
        return failureResult(warnings, errors)
    }
    const recipeRef = createEntityProvenanceRef('recipe', recipe)
    recordUnknownExtensions(
        recipe.extensions,
        recipeRef,
        ['recipes', recipe.id, 'extensions'],
        warnings,
        { kind: 'recipe', id: recipe.id },
    )

    const modulesById = new Map(
        document.modules
            .filter(module => module.deletedAt === undefined)
            .map(module => [module.id, module]),
    )
    const activeSteps: ActiveStepContext[] = []
    const sortedSteps = [...recipe.steps].sort(compareOrdered)

    for (const step of sortedSteps) {
        if (
            step.deletedAt !== undefined
            || !step.enabled
            || input.conditionSnapshot?.recipeSteps?.[step.id] === false
        ) {
            continue
        }
        const stepRef = createEntityProvenanceRef('recipe-step', step)
        recordUnknownExtensions(
            step.extensions,
            stepRef,
            ['recipes', recipe.id, 'steps', step.id, 'extensions'],
            warnings,
            { kind: 'recipe-step', id: step.id },
        )

        // A false condition disables the reference itself, so do not require
        // the target module to exist merely to skip this branch.
        if (input.conditionSnapshot?.modules?.[step.moduleId] === false) continue

        const module = modulesById.get(step.moduleId)
        if (module === undefined) {
            addIssue(brokenReferenceIssue(
                referencePolicy,
                'E_MODULE_REF_MISSING',
                'W_MODULE_REF_MISSING_COMPATIBILITY',
                stepRef,
                ['recipes', recipe.id, 'steps', step.id, 'moduleId'],
                { kind: 'recipe-step', id: step.id },
            ), warnings, errors)
            continue
        }
        if (!module.enabled) {
            warnings.push(createResolutionIssue('W_MODULE_DISABLED', {
                sourceRef: stepRef,
                entityRef: { kind: 'module', id: module.id },
                fieldPath: ['recipes', recipe.id, 'steps', step.id, 'moduleId'],
            }))
            continue
        }
        const moduleRef = createEntityProvenanceRef('module', module)
        recordUnknownExtensions(
            module.extensions,
            moduleRef,
            ['modules', module.id, 'extensions'],
            warnings,
            { kind: 'module', id: module.id },
        )
        activeSteps.push({ step, module, stepRef, moduleRef })
    }

    const collectedContributions = collectContributions(profile, activeSteps, recipeRef, input)
    const validContributions: CollectedContribution[] = []
    const activeCharacterIds = new Set(
        document.characters
            .filter(character => character.deletedAt === undefined)
            .map(character => character.id),
    )
    const selectedCharacterIds = new Set(
        profile.characterIds.filter(characterId => activeCharacterIds.has(characterId)),
    )
    for (const collected of collectedContributions) {
        const contributionRef = createEntityProvenanceRef('prompt-contribution', collected.contribution)
        recordUnknownExtensions(
            collected.contribution.extensions,
            contributionRef,
            ['contributions', collected.contribution.id, 'extensions'],
            warnings,
            { kind: 'prompt-contribution', id: collected.contribution.id },
        )
        recordUnknownExtensions(
            collected.contribution.target.extensions,
            contributionRef,
            ['contributions', collected.contribution.id, 'target', 'extensions'],
            warnings,
            { kind: 'prompt-contribution', id: collected.contribution.id },
        )
        if (
            collected.contribution.target.kind === 'character'
            && !selectedCharacterIds.has(collected.contribution.target.characterId)
        ) {
            addIssue(brokenReferenceIssue(
                referencePolicy,
                'E_CHARACTER_REF_MISSING',
                'W_CHARACTER_REF_MISSING_COMPATIBILITY',
                contributionRef,
                ['contributions', collected.contribution.id, 'target', 'characterId'],
            ), warnings, errors)
            continue
        }
        validContributions.push(collected)
    }

    const characters = resolveSelectedCharacters(
        document,
        profile,
        activeSteps,
        input,
        referencePolicy,
        warnings,
        errors,
    )
    const activeContributions = validContributions.filter(collected => (
        collected.contribution.target.kind !== 'character'
        || characters.get(collected.contribution.target.characterId)?.enabled === true
    ))

    const presetId = input.request.paramsPresetId ?? profile.defaultParamsPresetId
    let preset: ParamsPreset | undefined
    if (presetId !== undefined) {
        preset = document.paramsPresets.find(candidate => (
            candidate.id === presetId
            && candidate.deletedAt === undefined
            && candidate.enabled
            && profile.paramsPresetIds.includes(candidate.id)
        ))
        if (preset === undefined) {
            addIssue(brokenReferenceIssue(
                referencePolicy,
                'E_PARAMS_PRESET_MISSING',
                'W_PARAMS_PRESET_MISSING_COMPATIBILITY',
                profileRef,
                ['paramsPresetId'],
            ), warnings, errors)
        } else {
            recordUnknownExtensions(
                preset.extensions,
                createEntityProvenanceRef('params-preset', preset),
                ['paramsPresets', preset.id, 'extensions'],
                warnings,
                { kind: 'params-preset', id: preset.id },
                ['legacyPresetMetadata'],
            )
        }
    }

    // The random stage consumes the seed winner from the same nine layers.
    // No other params or resource operations are merged before stage 11.
    const effectiveParamsCandidates = buildParamsCandidates(input, profile, preset, activeSteps, recipe)
    const generationSeed = resolveGenerationSeed(effectiveParamsCandidates, input.engineDefaults.seed)
    const randomScope = input.randomScope ?? `recipe:${recipe.id}`
    const randomRecords = collectAndEvaluateRandomRules(
        document,
        profile,
        activeSteps,
        activeContributions,
        recipeRef,
        generationSeed,
        randomScope,
        referencePolicy,
        warnings,
        errors,
    )

    const fragmentSession = new FragmentResolutionSession(input, generationSeed, warnings, errors)
    const verbatim = input.promptTextMode === 'verbatim'

    const sortedCharacterStates = [...characters.values()]
        .sort((left, right) => compareOrdered(left.definition, right.definition))
    const resolvedContributionText = new Map<EntityId, string>()
    const resolveContribution = (collected: CollectedContribution): void => {
        // Final source text is literal: no comment removal, expansion, or trimming.
        if (verbatim) {
            resolvedContributionText.set(collected.contribution.id, collected.contribution.text)
            return
        }
        const contributionRef = createEntityProvenanceRef('prompt-contribution', collected.contribution)
        const sourceChain = dedupeProvenanceChain([contributionRef, ...collected.sourceChain])
        const cleanedText = removePromptCommentLines(collected.contribution.text).trim()
        resolvedContributionText.set(collected.contribution.id, fragmentSession.resolve(
            cleanedText,
            `${randomScope}/contribution:${collected.contribution.id}`,
            sourceChain,
            contributionRef,
        ).text)
    }

    // Fragment/sequence consumption follows canonical target order: main,
    // negative, then stable character ID with base-before-contribution polarity.
    activeContributions
        .filter(collected => collected.contribution.target.kind !== 'character')
        .forEach(resolveContribution)
    const fragmentCharacterStates = [...sortedCharacterStates]
        .sort((left, right) => compareStableText(left.definition.id, right.definition.id))
    for (const character of fragmentCharacterStates) {
        if (verbatim) {
            activeContributions.filter(collected => collected.contribution.target.kind === 'character'
                && collected.contribution.target.characterId === character.definition.id).forEach(resolveContribution)
            continue
        }
        if (!character.enabled) {
            character.positive = removePromptCommentLines(character.positive).trim()
            character.negative = removePromptCommentLines(character.negative).trim()
            continue
        }
        character.positive = fragmentSession.resolve(
            removePromptCommentLines(character.positive).trim(),
            `${randomScope}/character:${character.definition.id}:positive`,
            character.positiveSources,
            character.positiveSources[character.positiveSources.length - 1],
        ).text
        activeContributions.filter(collected => (
            collected.contribution.target.kind === 'character'
            && collected.contribution.target.characterId === character.definition.id
            && collected.contribution.target.polarity === 'positive'
        )).forEach(resolveContribution)
        character.negative = fragmentSession.resolve(
            removePromptCommentLines(character.negative).trim(),
            `${randomScope}/character:${character.definition.id}:negative`,
            character.negativeSources,
            character.negativeSources[character.negativeSources.length - 1],
        ).text
        activeContributions.filter(collected => (
            collected.contribution.target.kind === 'character'
            && collected.contribution.target.characterId === character.definition.id
            && collected.contribution.target.polarity === 'negative'
        )).forEach(resolveContribution)
    }

    const resolvedCollected: CollectedContribution[] = activeContributions.map(collected => ({
        ...collected,
        contribution: {
            ...collected.contribution,
            text: resolvedContributionText.get(collected.contribution.id) ?? '',
        },
    }))

    const initialCharacterText = sortedCharacterStates.map(character => ({
        characterId: character.definition.id,
        positive: character.positive,
        negative: character.negative,
    }))
    const draft = composePromptContributions(
        resolvedCollected.map(collected => collected.contribution),
        { characters: initialCharacterText },
        { comments: 'preserve', ...(verbatim ? { whitespace: 'preserve' as const } : {}) },
    )
    const finalized = finalizePromptComposition(draft, {
        dedupe: verbatim ? 'verbatim' : input.dedupePolicy ?? 'exact-token',
    })
    const finalizedCharactersById = new Map(
        finalized.characters.map(character => [character.characterId, character]),
    )

    for (const candidate of effectiveParamsCandidates) {
        recordUnknownExtensions(
            candidate.params?.extensions,
            candidate.sourceRef,
            ['params', candidate.layer, 'extensions'],
            warnings,
        )
    }
    const candidatesByLayer = new Map<ParamsPrecedenceSource, ParamsCandidate[]>()
    for (const candidate of effectiveParamsCandidates) {
        const group = candidatesByLayer.get(candidate.layer) ?? []
        group.push(candidate)
        candidatesByLayer.set(candidate.layer, group)
    }
    const precedenceLayers: Partial<Record<ParamsPrecedenceSource, ParamsPrecedenceLayer>> = {}
    for (const layer of PARAMS_PRECEDENCE_ORDER) {
        const aggregate = aggregateParamsLayer(candidatesByLayer.get(layer) ?? [])
        if (aggregate !== undefined) precedenceLayers[layer] = aggregate
    }
    const paramsMerge = mergeParamsByPrecedence(precedenceLayers)
    const normalizedCoreParams: CoreParams = {
        ...paramsMerge.params,
        ...(paramsMerge.params.seed === undefined
            ? {}
            : { seed: normalizeGenerationSeed(paramsMerge.params.seed) }),
    }
    const resolvedParams = buildResolvedParams(normalizedCoreParams)
    if (resolvedParams === null) {
        errors.push(issue(
            'E_RESOLVED_PARAMS_INCOMPLETE',
            'error',
            createExternalProvenanceRef('composition-engine:defaults'),
            ['params'],
            {
                messageKey: 'composition.issue.resolvedParamsIncomplete',
                repairHintKey: 'composition.repair.completeEngineDefaults',
                actionId: 'complete-engine-defaults',
            },
        ))
    } else {
        for (const rangeIssue of validateParamsRanges(resolvedParams, {
            sourceRef: requestRef,
            fieldPath: ['params'],
        })) {
            const field = rangeIssue.fieldPath[rangeIssue.fieldPath.length - 1]
            const winnerSource = typeof field === 'string'
                && (CORE_PARAMS_FIELDS as readonly string[]).includes(field)
                ? paramsWinnerSource(effectiveParamsCandidates, field as CoreParamsField)
                : undefined
            addIssue({
                ...rangeIssue,
                sourceRef: winnerSource ?? rangeIssue.sourceRef,
            }, warnings, errors)
        }
    }

    const resolvedCharacters: ResolvedCharacterPrompt[] = sortedCharacterStates.map(character => {
        const text = finalizedCharactersById.get(character.definition.id)
        return {
            characterId: character.definition.id,
            positive: text?.positive ?? '',
            negative: text?.negative ?? '',
            enabled: character.enabled,
            position: { ...character.position },
            resourceBindings: character.resourceBindings.map(binding => ({ ...binding })),
        }
    })

    validateResolvedCharacterCoordinates(sortedCharacterStates, warnings, errors)

    if (resolvedParams !== null) {
        for (const positionIssue of validateCharacterPositionModes({
            characters: resolvedCharacters.map(character => ({
                characterId: character.characterId,
                enabled: character.enabled,
                position: character.position,
            })),
            characterPositionEnabled: resolvedParams.characterPositionEnabled,
            sourceRef: requestRef,
            fieldPath: ['characters'],
        })) {
            addIssue(positionIssue, warnings, errors)
        }
    }

    const outputCandidates = buildOutputCandidates(input, profile, activeSteps, recipe)
    const outputWinner = outputCandidates[outputCandidates.length - 1] as OutputCandidate
    outputCandidates.forEach(candidate => recordUnknownExtensions(
        candidate.policy.extensions,
        candidate.sourceRef,
        ['outputPolicy', 'extensions'],
        warnings,
    ))

    const randomTrace = [
        ...randomRecords.map(record => record.trace),
        ...fragmentSession.randomTrace,
    ]
    const usedFragmentIds = fragmentSession.usedFragmentIds()

    if (resolvedParams === null || errors.length > 0) {
        return failureResult(warnings, errors, randomTrace, usedFragmentIds)
    }

    const provenance = new CompositionProvenanceCollector()
    const contributionOutcomes = promptContributionOutcomes(resolvedCollected)
    resolvedCollected.forEach((collected, applicationIndex) => {
        const outcome = contributionOutcomes.get(collected.contribution.id)
        provenance.recordPrompt({
            contribution: collected.contribution,
            applicationIndex,
            retainedAfterReplace: outcome?.retainedAfterReplace ?? true,
            ...(outcome?.supersededByContributionId === undefined
                ? {}
                : { supersededByContributionId: outcome.supersededByContributionId }),
            sourceChain: collected.sourceChain,
        })
    })

    for (const field of CORE_PARAMS_FIELDS) {
        if (field === 'seedLocked' || paramsMerge.params[field] === undefined) continue
        const sourceChain: ParamsLayerProvenance[] = []
        for (const layer of PARAMS_PRECEDENCE_ORDER) {
            for (const candidate of candidatesByLayer.get(layer) ?? []) {
                if (candidate.params?.[field] !== undefined) {
                    sourceChain.push({ layer, sourceRef: candidate.sourceRef })
                }
            }
        }
        const winner = sourceChain[sourceChain.length - 1]
        if (winner !== undefined) {
            provenance.recordParam({ field, winner, sourceChain })
        }
    }

    for (const character of sortedCharacterStates) {
        const contributionRefs = resolvedCollected
            .filter(collected => (
                collected.contribution.target.kind === 'character'
                && collected.contribution.target.characterId === character.definition.id
            ))
        for (const field of ['positive', 'negative'] as const) {
            const polarityContributions = contributionRefs.filter(collected => (
                collected.contribution.target.kind === 'character'
                && collected.contribution.target.polarity === field
                && (contributionOutcomes.get(collected.contribution.id)?.retainedAfterReplace ?? true)
            ))
            const originalBaseSources = field === 'positive'
                ? character.positiveSources
                : character.negativeSources
            const baseSources = polarityContributions.some(
                collected => collected.contribution.merge === 'replace',
            ) ? [] : originalBaseSources
            const contributionSources = polarityContributions.flatMap(collected => [
                createEntityProvenanceRef('prompt-contribution', collected.contribution),
                ...collected.sourceChain,
            ])
            const sourceChain = dedupeProvenanceChain([...baseSources, ...contributionSources])
            const winningContribution = polarityContributions[polarityContributions.length - 1]
            const winnerSource = winningContribution === undefined
                ? originalBaseSources[originalBaseSources.length - 1]
                : createEntityProvenanceRef('prompt-contribution', winningContribution.contribution)
            provenance.recordCharacter({
                characterId: character.definition.id,
                field,
                winnerSource: winnerSource as ProvenanceRef,
                sourceChain,
            })
        }
        provenance.recordCharacter({
            characterId: character.definition.id,
            field: 'position',
            winnerSource: character.positionSources[character.positionSources.length - 1] as ProvenanceRef,
            sourceChain: character.positionSources,
        })
    }

    for (const fieldPath of [
        ['destination'],
        ['format'],
        ['filenameTemplate'],
        ['metadataMode'],
        ['collisionPolicy'],
    ] as const) {
        provenance.recordOutputPolicy({
            fieldPath,
            winnerSource: outputWinner.sourceRef,
            sourceChain: outputCandidates.map(candidate => candidate.sourceRef),
        })
    }
    for (const record of [...randomRecords, ...fragmentSession.randomProvenance]) {
        provenance.recordRandomSelection(record)
    }
    const provenanceDetails = provenance.snapshot() as unknown as CompositionProvenance
    const flatProvenance = flattenProvenanceRefs(provenance.snapshot())

    const resources = referencedResources(
        document,
        resolvedParams,
        paramsMerge.resourceBindings,
        resolvedCharacters,
        referencePolicy,
        input,
        warnings,
        errors,
    )
    if (errors.length > 0) {
        return failureResult(warnings, errors, randomTrace, usedFragmentIds)
    }

    const filenamePolicyInput: FilenamePolicyInput = {
        template: outputWinner.policy.filenameTemplate,
        format: outputWinner.policy.format,
        collisionPolicy: outputWinner.policy.collisionPolicy,
        now: input.now,
        seed: resolvedParams.seed,
        documentId: document.id,
        profileId: profile.id,
        profileName: profile.name,
        recipeId: recipe.id,
        recipeName: recipe.name,
        requestId: input.request.requestId,
    }
    const sortedWarnings = sortIssues(warnings)
    const basePlan: Omit<CompositionEnginePlan, 'planHash' | 'planId'> = {
        ...(verbatim ? { promptTextMode: 'verbatim' as const } : {}),
        engineVersion: COMPOSITION_ENGINE_VERSION,
        schemaVersion: document.schemaVersion,
        requestId: input.request.requestId,
        documentId: document.id,
        documentRevision: document.revision,
        profileId: profile.id,
        recipeId: recipe.id,
        positivePrompt: finalized.positive,
        negativePrompt: finalized.negative,
        promptParts: {
            ...finalized.main,
            negative: finalized.negative,
        },
        contributions: resolvedCollected.map(collected => collected.contribution),
        characters: resolvedCharacters,
        params: resolvedParams,
        outputPolicy: { ...outputWinner.policy },
        resources,
        resourceBindings: paramsMerge.resourceBindings.map(binding => ({ ...binding })),
        issues: sortedWarnings,
        provenance: flatProvenance,
        provenanceDetails,
        randomTrace,
        filenamePolicyInput,
    }
    const planHash = createCompositionPlanHash(semanticPlanProjection(basePlan))
    const plan: CompositionEnginePlan = {
        ...basePlan,
        planId: `resolved-plan:${planHash.version}:${planHash.digest}`,
        planHash,
    }

    return freezeResult({
        success: true,
        plan,
        warnings: sortedWarnings,
        errors: [],
        sequenceCommitProposal: fragmentSession.proposal(false),
        usedFragmentIds,
    })
}

export const CompositionEngine = Object.freeze({
    resolve: resolveComposition,
})
