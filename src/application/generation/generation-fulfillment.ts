import type { RunAcceptanceProjection } from '@/domain/assessment/intent-assessment'

export type TechnicalStageState =
    | 'not-required'
    | 'pending'
    | 'succeeded'
    | 'failed'
    | 'uncertain'
    | 'unavailable'

export type AcceptanceState =
    | 'not-required'
    | 'not-evaluated'
    | 'needs-review'
    | 'accepted'
    | 'rejected'

export interface StageEvidence {
    readonly source: string
    readonly referenceId: string
    readonly observedAt: string
    readonly kind: 'direct' | 'derived'
}

export interface StageProjection {
    readonly state: TechnicalStageState
    readonly evidence: readonly StageEvidence[]
    readonly jobIds?: readonly string[]
}

export interface AcceptanceProjection {
    readonly state: AcceptanceState
    readonly assessmentIds: readonly string[]
    readonly acceptedArtifactIds: readonly string[]
    readonly requiredAcceptedCount: number | null
}

export interface RecoveryAction {
    readonly kind:
        | 'replan'
        | 'grant-directory-access'
        | 'retry-storage'
        | 'retry-scene-link'
        | 'retry-r2-release'
        | 'abandon-reservation'
        | 'discard-result-and-abandon-reservation'
        | 'review-provider-unknown'
    readonly requiresHuman: boolean
}

export interface FulfillmentIssue {
    readonly code:
        | 'SCENE_LINK_PENDING'
        | 'R2_DELIVERY_MISSING'
        | 'R2_DELIVERY_FAILED'
        | 'OUTPUT_RESERVATION_CONFLICT'
        | 'DIRECTORY_AUTHORIZATION_REQUIRED'
    readonly jobId: string
    readonly severity: 'warning' | 'blocking'
    readonly action: RecoveryAction
}

export interface GenerationJobFulfillmentProjection {
    readonly jobId: string
    readonly queue: { readonly state: string }
    readonly interpretation: StageProjection
    readonly provider: StageProjection
    readonly storage: StageProjection
    readonly release: StageProjection
    readonly acceptance: AcceptanceProjection
    readonly issues: readonly FulfillmentIssue[]
}

export interface GenerationFulfillmentProjection {
    readonly runId: string
    readonly queue: { readonly batchId: string; readonly state: string }
    readonly interpretation: StageProjection
    readonly provider: StageProjection
    readonly storage: StageProjection
    readonly release: StageProjection
    readonly acceptance: AcceptanceProjection
    readonly jobs: readonly GenerationJobFulfillmentProjection[]
    readonly issues: readonly FulfillmentIssue[]
    readonly overall:
        | 'planned'
        | 'running'
        | 'partial'
        | 'needs-attention'
        | 'delivered'
        | 'accepted'
        | 'rejected'
}

/** A sanitized observation supplied by read adapters; payloads and locations never cross this port. */
export interface ObservedTechnicalFact extends StageEvidence {
    readonly state: TechnicalStageState
}

export interface GenerationAcceptanceFact {
    readonly state: AcceptanceState
    readonly assessmentId: string
    readonly acceptedArtifactIds?: readonly string[]
}

export interface GenerationFulfillmentJobFacts {
    readonly jobId: string
    readonly queueState: string
    readonly interpretation?: ObservedTechnicalFact
    /** Phase 3 receipts can be supplied here without changing the public projection. */
    readonly provider?: ObservedTechnicalFact
    readonly storage?: ObservedTechnicalFact
    readonly release: {
        readonly policy: 'not-required' | 'best-effort' | 'required'
        readonly fact?: ObservedTechnicalFact
        readonly jobIds?: readonly string[]
    }
    readonly acceptance: {
        readonly required: boolean
        /** Phase 8 assessments can be supplied here without adding another repository. */
        readonly assessment?: GenerationAcceptanceFact
    }
    readonly issues?: readonly FulfillmentIssue[]
}

export interface GenerationFulfillmentFacts {
    readonly batchId: string
    readonly queueState: string
    readonly requiredAcceptedCount?: number | null
    /** Run acceptance is authoritative across artifacts and retry batches; job rejection alone cannot close a run. */
    readonly runAcceptance?: RunAcceptanceProjection
    readonly jobs: readonly GenerationFulfillmentJobFacts[]
}

const RUNNING_QUEUE_STATES = new Set(['leased', 'running', 'recovering'])
const IN_FLIGHT_QUEUE_STATES = new Set(['queued', ...RUNNING_QUEUE_STATES])
const FAILED_QUEUE_STATES = new Set(['failed', 'blocked'])

function evidenceOf(fact: ObservedTechnicalFact): StageEvidence {
    return {
        source: fact.source,
        referenceId: fact.referenceId,
        observedAt: fact.observedAt,
        kind: fact.kind,
    }
}

function projectFact(fact: ObservedTechnicalFact | undefined): StageProjection {
    return fact
        ? { state: fact.state, evidence: [evidenceOf(fact)] }
        : { state: 'unavailable', evidence: [] }
}

function projectProvider(job: GenerationFulfillmentJobFacts): StageProjection {
    if (job.provider) return projectFact(job.provider)
    if (job.storage?.state !== 'succeeded') return projectFact(undefined)

    // A committed local result proves provider completion, but is not a provider receipt.
    return {
        state: 'succeeded',
        evidence: [{ ...evidenceOf(job.storage), kind: 'derived' }],
    }
}

function projectRelease(job: GenerationFulfillmentJobFacts): StageProjection {
    if (job.release.fact) return { ...projectFact(job.release.fact), ...(job.release.jobIds ? { jobIds: job.release.jobIds } : {}) }
    return job.release.policy === 'not-required'
        ? { state: 'not-required', evidence: [] }
        : projectFact(undefined)
}

function projectAcceptance(
    required: boolean,
    assessment: GenerationAcceptanceFact | undefined,
    requiredAcceptedCount: number | null,
): AcceptanceProjection {
    return {
        state: assessment?.state ?? (required ? 'not-evaluated' : 'not-required'),
        assessmentIds: assessment ? [assessment.assessmentId] : [],
        acceptedArtifactIds: assessment?.acceptedArtifactIds ? [...assessment.acceptedArtifactIds] : [],
        requiredAcceptedCount,
    }
}

function aggregateStage(stages: readonly StageProjection[]): StageProjection {
    if (stages.length === 0) return { state: 'unavailable', evidence: [] }
    const evidence = stages.flatMap(stage => stage.evidence)
    const relevant = stages.filter(stage => stage.state !== 'not-required')
    if (relevant.length === 0) return { state: 'not-required', evidence }
    const precedence: readonly TechnicalStageState[] = ['failed', 'uncertain', 'unavailable', 'pending', 'succeeded']
    const state = precedence.find(candidate => relevant.some(stage => stage.state === candidate)) ?? 'unavailable'
    return { state, evidence }
}

function aggregateAcceptance(
    jobs: readonly GenerationJobFulfillmentProjection[],
    requiredAcceptedCount: number | null,
): AcceptanceProjection {
    const states = jobs.map(job => job.acceptance.state)
    const acceptedArtifactIds = [...new Set(jobs.flatMap(job => job.acceptance.acceptedArtifactIds))]
    let state: AcceptanceState = states.includes('rejected') || states.includes('needs-review')
            ? 'needs-review'
            : states.includes('not-evaluated')
                ? 'not-evaluated'
                : states.includes('accepted')
                    ? 'accepted'
                    : 'not-required'
    if (state === 'accepted' && requiredAcceptedCount !== null && acceptedArtifactIds.length < requiredAcceptedCount) {
        state = 'needs-review'
    }
    return {
        state,
        assessmentIds: [...new Set(jobs.flatMap(job => job.acceptance.assessmentIds))],
        acceptedArtifactIds,
        requiredAcceptedCount,
    }
}

function deriveOverall(
    facts: GenerationFulfillmentFacts,
    jobs: readonly GenerationJobFulfillmentProjection[],
    acceptance: AcceptanceProjection,
): GenerationFulfillmentProjection['overall'] {
    if (acceptance.state === 'rejected') return 'rejected'
    if (jobs.length === 0) return 'planned'
    const explicitAttention = jobs.some((job, index) => (
        FAILED_QUEUE_STATES.has(job.queue.state)
        || job.issues.some(issue => issue.severity === 'blocking')
        || [job.interpretation, job.provider, job.storage].some(stage => (
            stage.state === 'failed' || stage.state === 'uncertain'
        ))
        || (facts.jobs[index]?.release.policy === 'required'
            && (job.release.state === 'failed'
                || job.release.state === 'uncertain'
                || (job.release.state === 'unavailable' && !IN_FLIGHT_QUEUE_STATES.has(job.queue.state))))
        || (facts.jobs[index]?.acceptance.required === true
            && acceptance.state !== 'accepted'
            && job.acceptance.state === 'not-evaluated'
            && !IN_FLIGHT_QUEUE_STATES.has(job.queue.state))
    ))
    if (explicitAttention || acceptance.state === 'needs-review') return 'needs-attention'
    if (jobs.length > 0 && jobs.every(job => job.queue.state === 'queued')) return 'planned'

    const pending = jobs.some(job => (
        RUNNING_QUEUE_STATES.has(job.queue.state)
        || [job.interpretation, job.provider, job.storage, job.release].some(stage => stage.state === 'pending')
    ))
    if (pending) return 'running'

    if (jobs.some(job => job.issues.some(issue => issue.severity === 'warning'))) return 'partial'

    const missingCoreEvidence = jobs.some(job => (
        [job.interpretation, job.provider, job.storage].some(stage => stage.state === 'unavailable')
    ))
    if (missingCoreEvidence) return 'needs-attention'
    if (jobs.some((job, index) => (
        facts.jobs[index]?.release.policy === 'best-effort' && job.release.state !== 'succeeded'
    ))) return 'partial'
    if (acceptance.state === 'accepted') return 'accepted'
    return 'delivered'
}

/** Builds the read model only from supplied authority facts; no result is persisted or inferred from Queue success. */
export function deriveGenerationFulfillment(facts: GenerationFulfillmentFacts): GenerationFulfillmentProjection {
    const requiredAcceptedCount = facts.runAcceptance?.requiredAcceptedCount ?? facts.requiredAcceptedCount ?? null
    const jobs = facts.jobs.map((job): GenerationJobFulfillmentProjection => ({
        jobId: job.jobId,
        queue: { state: job.queueState },
        interpretation: projectFact(job.interpretation),
        provider: projectProvider(job),
        storage: projectFact(job.storage),
        release: projectRelease(job),
        acceptance: projectAcceptance(job.acceptance.required, job.acceptance.assessment, requiredAcceptedCount),
        issues: [...(job.issues ?? [])],
    }))
    const runAcceptance = facts.runAcceptance
    const acceptance: AcceptanceProjection = runAcceptance === undefined
        ? aggregateAcceptance(jobs, requiredAcceptedCount)
        : {
            state: runAcceptance.state,
            assessmentIds: [...runAcceptance.latestAssessmentIds],
            acceptedArtifactIds: [...runAcceptance.acceptedArtifactIds],
            requiredAcceptedCount,
        }
    const issues = jobs.flatMap(job => job.issues)

    return {
        runId: facts.batchId,
        queue: { batchId: facts.batchId, state: facts.queueState },
        interpretation: aggregateStage(jobs.map(job => job.interpretation)),
        provider: aggregateStage(jobs.map(job => job.provider)),
        storage: aggregateStage(jobs.map(job => job.storage)),
        release: aggregateStage(jobs.map(job => job.release)),
        acceptance,
        jobs,
        issues,
        overall: deriveOverall(facts, jobs, acceptance),
    }
}
