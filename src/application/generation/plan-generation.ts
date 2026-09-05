import {
    canonicalProject,
    hashCanonicalValue,
    projectForCompositionPlanHash,
} from '@/domain/composition/canonical-serialize'
import {
    listBatchImageDraftIssues,
    listSingleImageDraftIssues,
    type WorkflowDraft,
} from '@/domain/workflow/single-image-draft'
import type { WorkflowDraftRepositoryPort } from '@/application/workflow/workflow-draft-repository'
import { parseAssessmentRequirement } from '@/domain/assessment/visual-rubric'
import type {
    ApprovalRequirement,
    CompatibilitySnapshot,
    DetachedGenerationCapture,
    GenerationConflictSource,
    GenerationExecutionPolicySnapshot,
    GenerationPlan,
    GenerationPlanView,
    PlanGenerationInput,
    PlanGenerationResult,
    PlanIssue,
    PreparedGenerationJob,
    PreparedGenerationJobDraft,
    PreparedJobPlannerPort,
    Sha256Digest,
} from './generation-plan-contract'

const UINT32_MAX = 0xffff_ffff
const MAX_WORKFLOW_GENERATION_COUNT = 9_999

export interface PlanGenerationDependencies<TPrepared = unknown> {
    readonly drafts: Pick<WorkflowDraftRepositoryPort, 'get'>
    readonly planner: PreparedJobPlannerPort<TPrepared>
    readonly executionPolicy: Omit<
        GenerationExecutionPolicySnapshot,
        'credentialDispatch' | 'metadataMode'
    >
    readonly estimateAnlas: (job: PreparedGenerationJobDraft<TPrepared>) => number
    readonly resolveCompatibility: (job: PreparedGenerationJobDraft<TPrepared>) => CompatibilitySnapshot
    readonly classifyPreparationError?: (error: unknown) => PlanIssue | null
    readonly randomSeed?: () => number
    readonly resolveReplayTrace?: (traceId: string) => Promise<readonly number[] | null>
}

function digest(value: unknown): Sha256Digest {
    return `sha256:${hashCanonicalValue(value)}`
}

/**
 * Hashes the JSON-safe detached payload without trusting its claimed hash.
 * Prepared Main values are included, so replay cannot swap executable state
 * while retaining only the same public semantic projection.
 */
export function hashDetachedGenerationCapture<TPrepared>(
    capture: DetachedGenerationCapture<TPrepared> | Omit<DetachedGenerationCapture<TPrepared>, 'contentHash'>,
): Sha256Digest {
    const { contentHash: _claimedHash, ...content } = capture as DetachedGenerationCapture<TPrepared>
    const serialized = JSON.stringify(content)
    if (serialized === undefined) throw new TypeError('Detached generation capture must be JSON-safe.')
    return digest(JSON.parse(serialized) as unknown)
}

/** Hashes one reviewed job's Provider meaning without output or execution policy. */
export function hashGenerationSemanticIntent(
    semantic: PreparedGenerationJobDraft['semantic'],
): Sha256Digest {
    return digest(projectForCompositionPlanHash(semantic))
}

function issue(code: string, fieldPath: string, message: string): PlanIssue {
    return Object.freeze({ code, severity: 'blocking', fieldPath, message })
}

function isSeed(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0 && value <= UINT32_MAX
}

function validIdentifier(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value
}

function isDigest(value: unknown): value is Sha256Digest {
    return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
}

function conflictSource<TPrepared>(source: PlanGenerationInput<TPrepared>['source']): GenerationConflictSource {
    if (source.kind === 'workflow-draft') return structuredClone(source)
    return Object.freeze({
        kind: 'detached-generation-capture',
        captureId: source.capture.captureId,
        contentHash: source.capture.contentHash,
    })
}

function validateInput<TPrepared>(input: PlanGenerationInput<TPrepared>): readonly PlanIssue[] {
    const issues: PlanIssue[] = []
    if (input.assessment !== undefined) {
        try {
            if (parseAssessmentRequirement(input.assessment).requiredAcceptedCount > input.count) {
                throw new TypeError('Required acceptance count exceeds planned images.')
            }
        } catch {
            issues.push(issue('invalid-human-assessment', 'assessment', 'A valid rubric and acceptance count within the planned images are required.'))
        }
    }
    if (input.source.kind === 'workflow-draft') {
        if (!input.source.draftId
            || !Number.isSafeInteger(input.source.expectedRevision)
            || input.source.expectedRevision < 0) {
            issues.push(issue('invalid-source', 'source', 'A revisioned workflow draft is required.'))
        }
    } else {
        const capture = input.source.capture
        if (capture.schemaVersion !== 1 || !validIdentifier(capture.captureId)) {
            issues.push(issue('invalid-detached-capture', 'source.capture', 'A versioned detached capture identity is required.'))
        }
        if (!isDigest(capture.contentHash) || !isDigest(capture.credentialReadinessFingerprint)) {
            issues.push(issue('invalid-detached-capture-digest', 'source.capture', 'Detached capture digests must be canonical SHA-256 values.'))
        }
        if (!Array.isArray(capture.sourceBindings)
            || capture.sourceBindings.some(binding => (
                binding.resourceType === 'main-generation-capture'
                || !validIdentifier(binding.resourceId)
                || !isDigest(binding.contentHash)
                || (binding.revision !== null
                    && (!Number.isSafeInteger(binding.revision) || binding.revision < 0))
            ))) {
            issues.push(issue('invalid-detached-source-bindings', 'source.capture.sourceBindings', 'Detached source bindings are invalid.'))
        }
        if (!Array.isArray(capture.materializedSeeds)
            || !capture.materializedSeeds.every(isSeed)
            || !Array.isArray(capture.jobs)) {
            issues.push(issue('invalid-detached-capture-jobs', 'source.capture.jobs', 'Detached jobs and seeds must be materialized arrays.'))
        }
        if (input.seedPolicy.kind !== 'replay'
            || input.seedPolicy.traceId !== capture.captureId) {
            issues.push(issue('invalid-detached-seed-policy', 'seedPolicy', 'Detached captures must replay their captured seed trace.'))
        }
        try {
            if (isDigest(capture.contentHash)
                && hashDetachedGenerationCapture(capture) !== capture.contentHash) {
                issues.push(issue('detached-capture-hash-mismatch', 'source.capture.contentHash', 'Detached capture content does not match its declared hash.'))
            }
        } catch {
            issues.push(issue('invalid-detached-capture-content', 'source.capture', 'Detached capture content must be JSON-safe.'))
        }
    }
    if (!Number.isSafeInteger(input.count)
        || input.count < 1
        || input.count > MAX_WORKFLOW_GENERATION_COUNT) {
        issues.push(issue('invalid-count', 'count', 'Count must be between 1 and 9,999.'))
    }
    if (!Number.isSafeInteger(input.budget.maxImages) || input.budget.maxImages < 0) {
        issues.push(issue('invalid-image-budget', 'budget.maxImages', 'Image budget must be a non-negative safe integer.'))
    }
    if (!Number.isSafeInteger(input.budget.maxAnlas) || input.budget.maxAnlas < 0) {
        issues.push(issue('invalid-anlas-budget', 'budget.maxAnlas', 'Anlas budget must be a non-negative safe integer.'))
    }
    if (input.seedPolicy.kind === 'fixed' && !isSeed(input.seedPolicy.seed)) {
        issues.push(issue('invalid-seed', 'seedPolicy.seed', 'Seed must be an unsigned 32-bit integer.'))
    }
    if (input.seedPolicy.kind === 'increment' && !isSeed(input.seedPolicy.firstSeed)) {
        issues.push(issue('invalid-seed', 'seedPolicy.firstSeed', 'Seed must be an unsigned 32-bit integer.'))
    }
    if (input.seedPolicy.kind === 'replay' && !input.seedPolicy.traceId) {
        issues.push(issue('invalid-trace-id', 'seedPolicy.traceId', 'Replay trace ID is required.'))
    }
    if (!['random', 'fixed', 'increment', 'replay'].includes(input.seedPolicy.kind)) {
        issues.push(issue('invalid-seed-policy', 'seedPolicy.kind', 'Seed policy is unsupported.'))
    }
    return Object.freeze(issues)
}

async function materializeSeeds(
    input: PlanGenerationInput,
    dependencies: Pick<PlanGenerationDependencies, 'randomSeed' | 'resolveReplayTrace'>,
): Promise<readonly number[] | null> {
    const { count, seedPolicy } = input
    if (seedPolicy.kind === 'fixed') return Object.freeze(Array(count).fill(seedPolicy.seed))
    if (seedPolicy.kind === 'increment') {
        return Object.freeze(Array.from({ length: count }, (_, ordinal) => (
            seedPolicy.firstSeed + ordinal
        ) >>> 0))
    }
    if (seedPolicy.kind === 'replay') {
        const trace = await dependencies.resolveReplayTrace?.(seedPolicy.traceId)
        return trace !== null && trace !== undefined
            && trace.length === count && trace.every(isSeed)
            ? Object.freeze([...trace])
            : null
    }
    if (dependencies.randomSeed === undefined) return null
    const seeds = Array.from({ length: count }, () => dependencies.randomSeed?.() as number)
    return seeds.every(isSeed) ? Object.freeze(seeds) : null
}

export interface GenerationPlanMismatch {
    readonly fieldPath: string
    readonly expectedDigest: Sha256Digest
    readonly actualDigest: Sha256Digest
}

/** Returns the first review-relevant mismatch in a stable diagnostic order. */
export function compareGenerationPlans(
    expected: GenerationPlan,
    actual: GenerationPlan,
): GenerationPlanMismatch | null {
    const comparisons: [string, unknown, unknown][] = []
    const jobCount = Math.max(expected.jobs.length, actual.jobs.length)
    for (let ordinal = 0; ordinal < jobCount; ordinal += 1) {
        comparisons.push(
            [`jobs[${ordinal}].semantic`, expected.jobs[ordinal]?.semantic ?? null, actual.jobs[ordinal]?.semantic ?? null],
            [`jobs[${ordinal}].preparationDigest`, expected.jobs[ordinal]?.preparationDigest ?? null, actual.jobs[ordinal]?.preparationDigest ?? null],
            [`jobs[${ordinal}].destination`, expected.jobs[ordinal]?.destination ?? null, actual.jobs[ordinal]?.destination ?? null],
            [`jobs[${ordinal}].compatibility`, expected.jobs[ordinal]?.compatibility ?? null, actual.jobs[ordinal]?.compatibility ?? null],
        )
    }
    comparisons.push(
        ['sourceBindings', expected.sourceBindings, actual.sourceBindings],
        ['semanticPlanHash', expected.semanticPlanHash, actual.semanticPlanHash],
        ['budget', expected.budget, actual.budget],
        ['executionPolicy', expected.executionPolicy, actual.executionPolicy],
        ['planHash', expected.planHash, actual.planHash],
    )
    for (const [fieldPath, expectedValue, actualValue] of comparisons) {
        const expectedDigest = digest(expectedValue)
        const actualDigest = digest(actualValue)
        if (expectedDigest !== actualDigest) return { fieldPath, expectedDigest, actualDigest }
    }
    return null
}

function unsupportedDraftIssue(draft: Awaited<ReturnType<WorkflowDraftRepositoryPort['get']>>): PlanIssue | null {
    if (draft === null) return null
    const output = draft.payload.output
    // Exact names are not reserved until Folder CAS exists. Today's unique/error
    // policies both collapse to the Phase 2 logical fail-only reservation.
    if (output.collisionPolicy === 'overwrite') {
        return issue('unsupported-collision-policy', 'draft.payload.output.collisionPolicy', 'Overwrite plans are not supported.')
    }
    if (output.autoR2UploadProfileId || output.r2Bucket || output.r2Prefix
        || output.deleteOriginalAfterRelease) {
        // The detached Main adapter captures an exact R2 destination. The Draft
        // adapter has no such planning port yet, so its fields cannot authorize delivery.
        return issue('unsupported-r2-delivery', 'draft.payload.output', 'This Workflow Draft adapter cannot plan an exact R2 delivery target or delete the original.')
    }
    return null
}

function invalidDraftIssues(draft: WorkflowDraft): readonly PlanIssue[] {
    const codes = draft.kind === 'single-image'
        ? listSingleImageDraftIssues(draft)
        : listBatchImageDraftIssues(draft)
    return Object.freeze(codes.map(code => issue(
        `draft-${code}`,
        'source.draft',
        `Workflow draft is not ready: ${code}.`,
    )))
}

/** Recursively freezes the detached plan so opaque prepared parameters cannot mutate after review. */
function immutable<T>(value: T): T {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
    for (const nested of Object.values(value as Record<string, unknown>)) immutable(nested)
    return Object.freeze(value)
}

function createView<TPrepared>(plan: GenerationPlan<TPrepared>): GenerationPlanView {
    return immutable({
        schemaVersion: plan.schemaVersion,
        planId: plan.planId,
        planHash: plan.planHash,
        semanticPlanHash: plan.semanticPlanHash,
        sourceBindings: structuredClone(plan.sourceBindings),
        materializedSeedTrace: structuredClone(plan.materializedSeedTrace),
        jobs: plan.jobs.map(job => ({
            ordinal: job.ordinal,
            promptDigest: digest({ prompt: job.semantic.prompt, negativePrompt: job.semantic.negativePrompt }),
            resourceDigest: job.semantic.resourceDigest,
            model: job.semantic.model,
            seed: job.semantic.seed,
            estimatedAnlas: job.estimatedAnlas,
            destination: structuredClone(job.destination),
            compatibilityProfileId: job.compatibility.compatibilityProfileId,
            compatibilityStatus: job.compatibility.status,
        })),
        estimatedAnlas: plan.estimatedAnlas,
        issues: structuredClone(plan.issues),
        requiredApprovals: structuredClone(plan.requiredApprovals),
        executionPolicy: structuredClone(plan.executionPolicy),
        budget: structuredClone(plan.budget),
        ...(plan.assessment === undefined ? {} : { assessment: structuredClone(plan.assessment) }),
    })
}

/**
 * Loads one CAS-bound draft, fixes every random choice, then hashes a detached
 * immutable plan. All cost and compatibility behavior is injected, keeping
 * this use case read-only and independent of UI, platform, and provider code.
 */
export async function planGeneration<TPrepared = unknown>(
    input: PlanGenerationInput<TPrepared>,
    dependencies: PlanGenerationDependencies<TPrepared>,
): Promise<PlanGenerationResult<TPrepared>> {
    const inputIssues = validateInput(input)
    if (inputIssues.length > 0) return immutable({ status: 'invalid', issues: inputIssues })

    let seeds: readonly number[]
    let prepared: readonly PreparedGenerationJobDraft<TPrepared>[]
    let sourceBindings: GenerationPlan<TPrepared>['sourceBindings']
    let executionPolicy: GenerationExecutionPolicySnapshot
    if (input.source.kind === 'workflow-draft') {
        const draft = await dependencies.drafts.get(input.source.draftId)
        if (draft === null || draft.revision !== input.source.expectedRevision) {
            return immutable({
                status: 'conflict',
                source: conflictSource(input.source),
                currentRevision: draft?.revision ?? null,
                action: 'reload-workflow-draft',
            })
        }
        const draftIssues = invalidDraftIssues(draft)
        if (draftIssues.length > 0) return immutable({ status: 'invalid', issues: draftIssues })
        const unsupported = unsupportedDraftIssue(draft)
        if (unsupported !== null) {
            return immutable({ status: 'unsupported', capability: unsupported.code, issues: [unsupported] })
        }

        const materialized = await materializeSeeds(input, dependencies)
        if (materialized === null) {
            return immutable({
                status: 'invalid',
                issues: [issue(
                    input.seedPolicy.kind === 'replay' ? 'replay-trace-unavailable' : 'random-source-unavailable',
                    'seedPolicy',
                    'The requested seed trace could not be materialized.',
                )],
            })
        }
        seeds = materialized
        try {
            prepared = await dependencies.planner.prepare({
                draft: structuredClone(draft),
                materializedSeeds: seeds,
            })
        } catch (error) {
            const classified = dependencies.classifyPreparationError?.(error) ?? null
            if (classified === null) throw error
            return immutable({ status: 'invalid', issues: [classified] })
        }
        sourceBindings = [{
            resourceType: 'workflow-draft',
            resourceId: draft.id,
            revision: draft.revision,
            contentHash: digest(draft),
        }]
        executionPolicy = {
            ...dependencies.executionPolicy,
            credentialDispatch: structuredClone(draft.payload.credentialPolicy),
            metadataMode: draft.payload.output.metadataMode,
        }
    } else {
        const capture = input.source.capture
        seeds = Object.freeze([...capture.materializedSeeds])
        prepared = structuredClone(capture.jobs)
        sourceBindings = [{
            resourceType: 'main-generation-capture',
            resourceId: capture.captureId,
            revision: null,
            contentHash: capture.contentHash,
        }, ...structuredClone(capture.sourceBindings)]
        executionPolicy = structuredClone(capture.executionPolicy)
    }
    if (prepared.length !== input.count) {
        return immutable({
            status: 'invalid',
            issues: [issue('prepared-count-mismatch', 'jobs', 'Planner output count does not match the requested count.')],
        })
    }

    const jobs: PreparedGenerationJob<TPrepared>[] = []
    const planIssues: PlanIssue[] = []
    for (let ordinal = 0; ordinal < prepared.length; ordinal += 1) {
        const job = structuredClone(prepared[ordinal])
        if (job.semantic.seed !== seeds[ordinal]) {
            return immutable({
                status: 'invalid',
                issues: [issue('prepared-seed-mismatch', `jobs[${ordinal}].semantic.seed`, 'Planner did not use the materialized seed.')],
            })
        }
        const estimatedAnlas = dependencies.estimateAnlas(job)
        if (!Number.isSafeInteger(estimatedAnlas) || estimatedAnlas < 0) {
            return immutable({
                status: 'invalid',
                issues: [issue('invalid-anlas-estimate', `jobs[${ordinal}].estimatedAnlas`, 'Anlas estimate must be a non-negative safe integer.')],
            })
        }
        const compatibility = dependencies.resolveCompatibility(job)
        if (compatibility.status === 'synthetic-only') {
            planIssues.push(Object.freeze({
                code: 'compatibility-synthetic-only',
                severity: 'warning',
                fieldPath: `jobs[${ordinal}].compatibility`,
                message: 'Compatibility is supported only by a synthetic fixture.',
            }))
        }
        if (compatibility.status === 'known-divergence' || compatibility.status === 'unsupported') {
            planIssues.push(issue(
                `compatibility-${compatibility.status}`,
                `jobs[${ordinal}].compatibility`,
                'The prepared job is not compatible with the current provider profile.',
            ))
        }
        jobs.push({ ...job, ordinal, estimatedAnlas, compatibility: structuredClone(compatibility) })
    }
    const blockingCompatibility = planIssues.find(value => value.severity === 'blocking')
    if (blockingCompatibility !== undefined) {
        return immutable({
            status: 'unsupported',
            capability: blockingCompatibility.code,
            issues: planIssues,
        })
    }

    const estimatedAnlas = jobs.reduce((sum, job) => sum + job.estimatedAnlas, 0)
    if (!Number.isSafeInteger(estimatedAnlas)) {
        return immutable({ status: 'invalid', issues: [issue('anlas-total-overflow', 'estimatedAnlas', 'Total Anlas exceeds the safe integer range.')] })
    }
    const approvals: ApprovalRequirement[] = []
    if (jobs.length > input.budget.maxImages) approvals.push({
        kind: 'budget', fieldPath: 'budget.maxImages', required: jobs.length, allowed: input.budget.maxImages,
    })
    if (estimatedAnlas > input.budget.maxAnlas) approvals.push({
        kind: 'budget', fieldPath: 'budget.maxAnlas', required: estimatedAnlas, allowed: input.budget.maxAnlas,
    })

    const semanticPlanHash = digest({
        schemaVersion: 1,
        jobs: jobs.map(job => ({
            ordinal: job.ordinal,
            semantic: projectForCompositionPlanHash(job.semantic),
        })),
    })
    const materializedSeedTrace = {
        source: input.seedPolicy.kind,
        traceId: input.seedPolicy.kind === 'replay'
            ? input.seedPolicy.traceId
            : input.seedPolicy.kind === 'random'
                ? digest({ seeds })
                : null,
        seeds,
    } as const
    const assessment = input.assessment === undefined ? undefined : parseAssessmentRequirement(input.assessment)
    if (assessment !== undefined) {
        sourceBindings = [...sourceBindings.filter(binding => binding.resourceType !== 'visual-rubric'), {
            resourceType: 'visual-rubric', resourceId: assessment.rubric.rubricId,
            revision: assessment.rubric.version, contentHash: assessment.rubricHash,
        }]
    }
    const planHash = digest({
        schemaVersion: 1,
        semanticPlanHash,
        sourceBindings,
        count: jobs.length,
        budget: input.budget,
        executionPolicy,
        destinations: jobs.map(job => job.destination),
        compatibility: jobs.map(job => job.compatibility),
        preparationDigests: jobs.map(job => job.preparationDigest),
        // Replay identity is the materialized values, never the RNG/trace route.
        materializedSeeds: seeds,
        estimatedAnlas,
        requiredApprovals: approvals,
        ...(assessment === undefined ? {} : { assessment }),
    })
    const plan = immutable({
        schemaVersion: 1 as const,
        planId: planHash,
        planHash,
        semanticPlanHash,
        sourceBindings: canonicalProject(sourceBindings) as unknown as GenerationPlan<TPrepared>['sourceBindings'],
        materializedSeedTrace,
        jobs,
        estimatedAnlas,
        issues: planIssues,
        requiredApprovals: approvals,
        executionPolicy: structuredClone(executionPolicy),
        budget: structuredClone(input.budget),
        ...(assessment === undefined ? {} : { assessment }),
    })
    const view = createView(plan)
    return approvals.length > 0
        ? immutable({ status: 'needs_input', plan, view, requirements: approvals })
        : immutable({ status: 'ready', plan, view })
}

/**
 * Re-reads the draft and rebuilds a reviewed plan using only its saved seeds.
 * A mismatch is a conflict; this helper never enqueues or obtains new entropy.
 */
export async function replayGenerationPlan<TPrepared = unknown>(
    reviewed: GenerationPlan,
    input: Omit<PlanGenerationInput<TPrepared>, 'seedPolicy'>,
    dependencies: PlanGenerationDependencies<TPrepared>,
): Promise<PlanGenerationResult<TPrepared>> {
    const traceId = input.source.kind === 'detached-generation-capture'
        ? input.source.capture.captureId
        : reviewed.materializedSeedTrace.traceId ?? `review:${digest(reviewed.materializedSeedTrace.seeds)}`
    const result = await planGeneration({
        ...input,
        seedPolicy: { kind: 'replay', traceId },
    }, {
        ...dependencies,
        randomSeed: undefined,
        resolveReplayTrace: async requestedTraceId => requestedTraceId === traceId
            ? reviewed.materializedSeedTrace.seeds
            : null,
    })
    if (result.status !== 'ready' && result.status !== 'needs_input') return result
    const mismatch = compareGenerationPlans(reviewed, result.plan)
    if (mismatch === null) return result
    return immutable({
        status: 'conflict',
        source: conflictSource(input.source),
        currentRevision: input.source.kind === 'workflow-draft'
            ? result.plan.sourceBindings[0]?.revision ?? null
            : null,
        action: input.source.kind === 'workflow-draft'
            ? 'reload-workflow-draft'
            : 'recapture-generation',
        mismatch,
    })
}
