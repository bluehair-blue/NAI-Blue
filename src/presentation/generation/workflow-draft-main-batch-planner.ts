import type { MainBatchPlannerPort } from '@/application/generation/plan-main-batch'
import {
    planGeneration,
    type PlanGenerationDependencies,
} from '@/application/generation/plan-generation'
import type {
    CompatibilitySnapshot,
    PlanGenerationInput,
    PlanGenerationResult,
    PlanIssue,
    PreparedJobPlannerPort,
} from '@/application/generation/generation-plan-contract'
import type { WorkflowDraftRepositoryPort } from '@/application/workflow/workflow-draft-repository'
import { buildLegacyMainGenerationParameters } from '@/domain/generation/legacy-main-parameters'
import { CURRENT_MAIN_QUEUE_POLICY } from '@/domain/queue/types'
import {
    isBatchImageDraftReady,
    isSingleImageDraftReady,
    type BatchImageDraft,
    type SingleImageDraft,
    type SingleImageMetadataMode,
} from '@/domain/workflow/single-image-draft'
import type {
    FragmentSequenceCommitProposal,
    FragmentSequenceSnapshot,
} from '@/domain/composition/fragment-resolver'
import type { DeepReadonly } from '@/domain/composition/provenance'
import { createWildcardResolutionSession } from '@/lib/fragment-processor'
import { calculateAnlasCost } from '@/lib/anlas-calculator'
import {
    prepareMainGeneration,
    type PreparedMainGeneration,
} from '@/services/generation/main-generation-plan'
import { removeComments } from '@/services/nai/presets'
import {
    CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
    queryNaiGenerationCompatibility,
} from '@/services/nai/compatibility'
import type { GenerationParams } from '@/services/novelai-types'
import type { FragmentLookupRepository } from '@/stores/fragment-store'
import { useFragmentStore } from '@/stores/fragment-store'
import { projectPreparedMainGenerationJob } from '@/services/generation/main-prepared-job-projection'

interface WorkflowDraftMainBatchPlannerOptions {
    readonly fragmentRepository?: FragmentLookupRepository
    readonly materializedSeeds?: readonly number[]
    readonly allowPinnedCredential?: boolean
}

type MainWorkflowDraft = SingleImageDraft | BatchImageDraft

interface BatchPromptInput {
    readonly positive: string
    readonly negative: string
    readonly seed: number
    readonly ordinal: number
}

export class WorkflowDraftPromptModuleResolutionError extends Error {
    constructor() {
        super('A saved Guided prompt module could not be resolved')
        this.name = 'WorkflowDraftPromptModuleResolutionError'
    }
}

export class WorkflowDraftCharacterPromptValidationError extends Error {
    constructor() {
        super('An enabled Guided character prompt resolved to empty text')
        this.name = 'WorkflowDraftCharacterPromptValidationError'
    }
}

/**
 * The MCP count is an assertion about the saved draft, not a repeat/override
 * instruction. The existing Guided planner owns expansion, so this error lets
 * the application return a safe draft issue before it creates any jobs.
 */
export class WorkflowDraftCountMismatchError extends Error {
    constructor(readonly expected: number, readonly requested: number) {
        super('The requested image count does not match the saved Guided draft')
        this.name = 'WorkflowDraftCountMismatchError'
    }
}

function requestedCount(draft: MainWorkflowDraft): number {
    if (draft.kind === 'single-image') return 1
    if (draft.payload.batchMode !== 'scenes') return draft.payload.count
    return draft.payload.scenes.reduce((sum, scene) => sum + scene.count, 0)
}

/** Captures the persisted draft identity, count, and deterministic seed route for review. */
export function createWorkflowDraftGenerationInput(
    draft: MainWorkflowDraft,
    budget: PlanGenerationInput['budget'],
): PlanGenerationInput<PreparedMainGeneration> {
    return {
        source: {
            kind: 'workflow-draft',
            draftId: draft.id,
            expectedRevision: draft.revision,
        },
        count: requestedCount(draft),
        seedPolicy: draft.kind === 'single-image'
            ? { kind: 'fixed', seed: draft.payload.generation.seed }
            : { kind: 'increment', firstSeed: draft.payload.generation.seed },
        budget,
    }
}

function batchPromptInputs(
    draft: MainWorkflowDraft,
    materializedSeeds?: readonly number[],
): readonly BatchPromptInput[] {
    const commonPrompt = draft.payload.output.folderCommonPrompt?.trim() ?? ''
    const withCommonPrompt = (prompt: string) => [commonPrompt, prompt].filter(Boolean).join(', ')
    if (draft.kind === 'single-image') {
        const inputs = [{
            positive: withCommonPrompt(draft.payload.prompt.positive),
            negative: draft.payload.prompt.negative,
            seed: draft.payload.generation.seed,
            ordinal: 0,
        }]
        if (materializedSeeds === undefined) return inputs
        return materializedSeeds.length === 1
            ? [{ ...inputs[0], seed: materializedSeeds[0] }]
            : []
    }
    const inputs: BatchPromptInput[] = []
    const append = (positive: string, negative: string, count: number) => {
        for (let index = 0; index < count; index += 1) {
            const ordinal = inputs.length
            inputs.push({
                positive,
                negative,
                seed: (draft.payload.generation.seed + ordinal) >>> 0,
                ordinal,
            })
        }
    }
    if (draft.payload.batchMode !== 'scenes') {
        append(withCommonPrompt(draft.payload.prompt.positive), draft.payload.prompt.negative, draft.payload.count)
    } else {
        for (const scene of draft.payload.scenes) {
            append(
                withCommonPrompt([draft.payload.prompt.positive, scene.positive].filter(Boolean).join(', ')),
                [draft.payload.prompt.negative, scene.negative].filter(Boolean).join(', '),
                scene.count,
            )
        }
    }
    if (materializedSeeds === undefined) return inputs
    if (materializedSeeds.length !== inputs.length) return []
    return inputs.map((input, ordinal) => ({ ...input, seed: materializedSeeds[ordinal] }))
}

export class WorkflowDraftFragmentRevisionConflictError extends Error {
    constructor() {
        super('Prompt module sequence state changed during Guided batch planning')
        this.name = 'WorkflowDraftFragmentRevisionConflictError'
    }
}

/**
 * Projects successful sequential proposals into memory while planning. The
 * live fragment counters stay untouched until each durable job succeeds.
 */
function createStagedFragmentRepository(live: FragmentLookupRepository): {
    readonly repository: FragmentLookupRepository
    stage(proposal: DeepReadonly<FragmentSequenceCommitProposal> | null): boolean
} {
    const baseLiveRevision = live.getSequenceSnapshot().revision
    let snapshot: FragmentSequenceSnapshot = structuredClone(live.getSequenceSnapshot())
    const assertSourceUnchanged = () => {
        if (live.getSequenceSnapshot().revision !== baseLiveRevision) {
            throw new WorkflowDraftFragmentRevisionConflictError()
        }
    }
    return {
        repository: {
            findMetadataByPath: path => live.findMetadataByPath(path),
            loadDefinitionByPath: async path => {
                assertSourceUnchanged()
                return live.loadDefinitionByPath(path)
            },
            getSequenceSnapshot: () => structuredClone(snapshot),
            commitSequenceProposal: () => false,
        },
        stage: proposal => {
            if (proposal === null || proposal.changes.length === 0) return true
            if (proposal.expectedRevision !== snapshot.revision) return false
            const counters = { ...snapshot.counters }
            for (const change of proposal.changes) {
                if ((counters[change.fragmentId] ?? 0) !== change.expectedCounter) return false
                counters[change.fragmentId] = change.nextCounter
            }
            snapshot = { revision: snapshot.revision + 1, counters }
            return true
        },
    }
}

/**
 * Converts one detached Guided draft into the existing credential-free Main
 * plan. It deliberately disables preview streaming because Guided submissions
 * are background jobs and must not compete for the expert canvas stream.
 */
export function createWorkflowDraftMainBatchPlanner(
    draft: MainWorkflowDraft,
    options: WorkflowDraftMainBatchPlannerOptions = {},
): MainBatchPlannerPort<PreparedMainGeneration> {
    const captured = structuredClone(draft)
    return Object.freeze({
        getRequestedCount: () => requestedCount(captured),
        prepareBatch: async () => {
            if ((captured.kind === 'single-image'
                    ? !isSingleImageDraftReady(captured)
                    : !isBatchImageDraftReady(captured))
                || captured.payload.model === null
                || captured.payload.resolution === null
                // Queue credential affinity is a separate scheduling contract;
                // never silently run a pinned draft through today's auto slot.
                || (!options.allowPinnedCredential
                    && captured.payload.credentialPolicy.kind !== 'auto')) {
                return []
            }
            const expectedCount = requestedCount(captured)
            if (options.materializedSeeds !== undefined
                && options.materializedSeeds.length !== expectedCount) {
                throw new WorkflowDraftCountMismatchError(expectedCount, options.materializedSeeds.length)
            }
            const { generation, output, resolution } = captured.payload
            const liveRepository = options.fragmentRepository
                ?? useFragmentStore.getState().getLookupRepository()
            const stagedFragments = createStagedFragmentRepository(liveRepository)
            const prepared: PreparedMainGeneration[] = []
            for (const input of batchPromptInputs(captured, options.materializedSeeds)) {
                const fragments = createWildcardResolutionSession({
                    seed: input.seed,
                    scope: `guided:${captured.id}:revision:${captured.revision}:item:${input.ordinal}`,
                    strictness: 'strict',
                    repository: stagedFragments.repository,
                })
                let positive: string
                let negative: string
                const characterPrompts: NonNullable<GenerationParams['characterPrompts']> = []
                try {
                    positive = (await fragments.process(removeComments(input.positive))).trim()
                    negative = (await fragments.process(removeComments(input.negative))).trim()
                    for (const character of captured.payload.characterPrompts.items) {
                        if (!character.enabled) continue
                        const prompt = (await fragments.process(removeComments(character.prompt))).trim()
                        const characterNegative = (
                            await fragments.process(removeComments(character.negative))
                        ).trim()
                        if (!prompt) throw new WorkflowDraftCharacterPromptValidationError()
                        characterPrompts.push({
                            stableId: character.id,
                            ...(character.name === undefined ? {} : { name: character.name }),
                            prompt,
                            negative: characterNegative,
                            enabled: true,
                            position: { ...character.position },
                        })
                    }
                } catch (error) {
                    fragments.discard()
                    throw error
                }
                if (!fragments.success) {
                    fragments.discard()
                    throw new WorkflowDraftPromptModuleResolutionError()
                }
                const sequenceCommitProposal = fragments.sequenceCommitProposal
                if (!stagedFragments.stage(sequenceCommitProposal)) {
                    fragments.discard()
                    throw new WorkflowDraftFragmentRevisionConflictError()
                }
                const params: GenerationParams = buildLegacyMainGenerationParameters<never, SingleImageMetadataMode>({
                prompt: positive,
                negativePrompt: negative,
                originalPrompts: {
                    base: input.positive,
                    additional: '',
                    detail: '',
                    negative: input.negative,
                    inpainting: '',
                },
                model: captured.payload.model,
                width: resolution.width,
                height: resolution.height,
                steps: generation.steps,
                cfgScale: generation.cfgScale,
                cfgRescale: generation.cfgRescale,
                sampler: generation.sampler,
                scheduler: generation.scheduler,
                smea: generation.smea,
                smeaDyn: generation.smeaDyn,
                variety: generation.variety,
                seed: input.seed,
                sourceImage: null,
                strength: 0.7,
                noise: 0,
                mask: null,
                characterImages: [],
                vibeImages: [],
                characterPrompts,
                characterPositionEnabled: captured.payload.characterPrompts.positionEnabled,
                modulePromptsActive: false,
                moduleCharacterPromptsPresent: false,
                imageFormat: output.imageFormat,
                metadataMode: output.metadataMode,
                assetModulePlan: null,
                qualityToggle: generation.qualityToggle,
                ucPreset: generation.ucPreset,
                transparentBackground: generation.transparentBackground ?? false,
                })
                prepared.push(prepareMainGeneration({
                    params,
                    fallbackImageFormat: output.imageFormat,
                    fallbackMetadataMode: output.metadataMode,
                    streamingRequested: false,
                    sequenceCommitProposal,
                    output: {
                        autoSave: output.autoSave,
                        directory: output.directory,
                        useAbsolutePath: output.useAbsolutePath,
                        capabilityFallbackDirectory: output.capabilityFallbackDirectory,
                        collisionPolicy: output.collisionPolicy,
                        generationFolderId: output.generationFolderId ?? null,
                        generationFolderPath: output.generationFolderPath ?? null,
                        autoR2UploadProfileId: output.autoR2UploadProfileId ?? null,
                        r2Bucket: output.r2Bucket ?? null,
                        r2Prefix: output.r2Prefix ?? null,
                        deleteOriginalAfterRelease: output.deleteOriginalAfterRelease ?? false,
                        rightsXmpEnabled: output.rightsXmpEnabled ?? false,
                        rightsOwner: output.rightsOwner,
                        rightsEffectiveDate: output.rightsEffectiveDate ?? null,
                    },
                }))
            }
            return Object.freeze(prepared)
        },
    })
}

/** Canonical Workflow Draft planning always receives its fragment authority explicitly. */
export function createWorkflowDraftPreparedJobPlanner(
    fragmentRepository: FragmentLookupRepository,
): PreparedJobPlannerPort<PreparedMainGeneration> {
    const planner: PreparedJobPlannerPort<PreparedMainGeneration> = {
        prepare: async ({ draft, materializedSeeds }) => {
            const batchPlanner = createWorkflowDraftMainBatchPlanner(draft, {
                fragmentRepository,
                materializedSeeds,
                allowPinnedCredential: true,
            })
            return (await batchPlanner.prepareBatch()).map(projectPreparedMainGenerationJob)
        },
    }
    return Object.freeze(planner)
}

export const WORKFLOW_DRAFT_RETRY_POLICY_ID = CURRENT_MAIN_QUEUE_POLICY.retryPolicyId

function createRandomSeed(): number {
    const values = new Uint32Array(1)
    globalThis.crypto.getRandomValues(values)
    return values[0]
}

export interface WorkflowDraftGenerationPlanOptions {
    readonly drafts: Pick<WorkflowDraftRepositoryPort, 'get'>
    readonly fragmentRepository: FragmentLookupRepository
    readonly pricingBasis: 'paid' | 'all-active-opus'
    readonly randomSeed?: () => number
    readonly resolveReplayTrace?: (traceId: string) => Promise<readonly number[] | null>
}

/** Shared dependency builder used by Guided and protocol-neutral callers. */
export function createWorkflowDraftGenerationPlanDependencies(
    options: WorkflowDraftGenerationPlanOptions,
): PlanGenerationDependencies<PreparedMainGeneration> {
    const dependencies: PlanGenerationDependencies<PreparedMainGeneration> = {
        drafts: options.drafts,
        planner: createWorkflowDraftPreparedJobPlanner(options.fragmentRepository),
        executionPolicy: {
            failurePolicy: 'continue',
            retryPolicyId: WORKFLOW_DRAFT_RETRY_POLICY_ID,
            maxAttempts: 3,
            maxConcurrency: CURRENT_MAIN_QUEUE_POLICY.maxConcurrency,
            pricingBasis: options.pricingBasis,
        },
        estimateAnlas: job => calculateAnlasCost({
            model: job.semantic.model,
            width: job.semantic.width,
            height: job.semantic.height,
            steps: job.semantic.steps,
            imageCount: 1,
            pricingBasis: options.pricingBasis,
        }),
        resolveCompatibility: job => {
            const profile = queryNaiGenerationCompatibility(
                job.prepared.params,
                CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
                job.prepared.streaming,
            )
            return {
                compatibilityProfileId: profile.compatibilityProfileId,
                status: profile.status,
            } satisfies CompatibilitySnapshot
        },
        classifyPreparationError: error => {
            let classified: PlanIssue | null = null
            if (error instanceof WorkflowDraftPromptModuleResolutionError) {
                classified = {
                    code: 'prompt-module-unavailable',
                    severity: 'blocking',
                    fieldPath: 'source.draft.payload.prompt',
                    message: error.message,
                }
            } else if (error instanceof WorkflowDraftCharacterPromptValidationError) {
                classified = {
                    code: 'character-prompt-invalid',
                    severity: 'blocking',
                    fieldPath: 'source.draft.payload.characterPrompts',
                    message: error.message,
                }
            } else if (error instanceof WorkflowDraftFragmentRevisionConflictError) {
                classified = {
                    code: 'fragment-sequence-conflict',
                    severity: 'blocking',
                    fieldPath: 'source.fragmentSequence',
                    message: error.message,
                }
            } else if (error instanceof WorkflowDraftCountMismatchError) {
                classified = {
                    code: 'draft-count-mismatch',
                    severity: 'blocking',
                    fieldPath: 'count',
                    message: error.message,
                }
            }
            return classified === null ? null : Object.freeze(classified)
        },
        randomSeed: options.randomSeed ?? createRandomSeed,
        ...(options.resolveReplayTrace === undefined
            ? {}
            : { resolveReplayTrace: options.resolveReplayTrace }),
    }
    return Object.freeze(dependencies)
}

/** Thin Guided wrapper; direct callers can invoke planGeneration with the same dependencies. */
export function planWorkflowDraftGeneration(
    input: PlanGenerationInput<PreparedMainGeneration>,
    options: WorkflowDraftGenerationPlanOptions,
): Promise<PlanGenerationResult<PreparedMainGeneration>> {
    return planGeneration(input, createWorkflowDraftGenerationPlanDependencies(options))
}
