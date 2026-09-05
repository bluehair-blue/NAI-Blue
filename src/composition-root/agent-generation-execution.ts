import type { AgentExecutionGrant } from '@/application/agent/agent-execution-repository'
import type { AgentExecutionCoordinatorOptions } from '@/application/agent/agent-execution-coordinator'
import { enqueueGeneration } from '@/application/generation/enqueue-generation-plan'
import type { GenerationPlan, PlanGenerationInput } from '@/application/generation/generation-plan-contract'
import { replayGenerationPlan, type PlanGenerationDependencies } from '@/application/generation/plan-generation'
import { canonicalSerialize, hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import type { JsonObject } from '@/domain/composition/types'
import { createAnlasCostConsentSnapshot } from '@/domain/queue/anlas-cost-consent'
import { CURRENT_MAIN_QUEUE_POLICY, TERMINAL_JOB_STATES, type GenerationJob } from '@/domain/queue/types'
import { getWorkflowDraftRepository } from '@/adapters/workflow/indexeddb-workflow-draft-repository'
import { createWorkflowDraftGenerationPlanDependencies } from '@/presentation/generation/workflow-draft-main-batch-planner'
import { resolveAnlasPricingBasis } from '@/lib/anlas-calculator'
import { selectActiveCredentialsAreOpus, useAuthStore } from '@/stores/auth-store'
import { useFragmentStore } from '@/stores/fragment-store'
import type { PreparedMainGeneration } from '@/services/generation/main-generation-plan'
import { enqueueReviewedMainPlan, hasStrictReviewedMainDestination } from '@/services/queue/main-queue-adapter'
import { getRuntimeQueueRepository, type IndexedDBQueueRepository } from '@/services/queue/indexeddb-queue-repository'
import { hashGenerationJobSnapshot } from '@/services/queue/job-snapshot'

interface ExecutionDependencies {
    readonly repository: Pick<IndexedDBQueueRepository, 'initialize' | 'getBatch' | 'listJobs' | 'listAttempts'>
    readonly replan: (plan: GenerationPlan) => Promise<PlanGenerationDependencies<PreparedMainGeneration>>
    readonly enqueueReviewed: typeof enqueueReviewedMainPlan
}

/** Reconstruct only source identity and unchanged review limits; replay owns the saved seed trace. */
function replanInput(plan: GenerationPlan): Omit<PlanGenerationInput<PreparedMainGeneration>, 'seedPolicy'> | null {
    const sources = plan.sourceBindings.filter(binding => binding.resourceType === 'workflow-draft')
    if (sources.length !== 1 || sources[0].revision === null
        || plan.sourceBindings.some(binding => binding.resourceType === 'main-generation-capture')) return null
    return {
        source: { kind: 'workflow-draft', draftId: sources[0].resourceId, expectedRevision: sources[0].revision },
        count: plan.jobs.length, budget: plan.budget,
        ...(plan.assessment === undefined ? {} : { assessment: plan.assessment }),
    }
}

function binding(grant: AgentExecutionGrant): NonNullable<GenerationJob['snapshot']['agentExecutionBinding']> {
    return { scopeId: grant.scopeId, planId: grant.planId, planHash: grant.planHash,
        grantHash: `sha256:${hashCanonicalValue(grant)}` }
}

function runResult(grant: AgentExecutionGrant): JsonObject {
    const batchId = `main-batch-${grant.scopeId}`
    return { status: 'ready', batchId, runId: batchId,
        jobIds: Array.from({ length: grant.imageCount }, (_, ordinal) => `main-job-${grant.scopeId}-${ordinal}`) }
}

async function runtimeReplan(plan: GenerationPlan): Promise<PlanGenerationDependencies<PreparedMainGeneration>> {
    const drafts = getWorkflowDraftRepository()
    const source = replanInput(plan)?.source
    const draft = source?.kind === 'workflow-draft' ? await drafts.get(source.draftId) : null
    return createWorkflowDraftGenerationPlanDependencies({ drafts,
        fragmentRepository: useFragmentStore.getState().getLookupRepository(),
        pricingBasis: resolveAnlasPricingBasis({ model: draft?.payload.model ?? '',
            activeCredentialsAreOpus: selectActiveCredentialsAreOpus(useAuthStore.getState()) }),
    })
}

/** Shares the real Main Queue. Approval ownership stays in the coordinator, never in caller JSON. */
export function createAgentGenerationExecutionPort(
    overrides: Partial<ExecutionDependencies> = {},
): Required<AgentExecutionCoordinatorOptions['ports']> {
    const dependencies: ExecutionDependencies = {
        repository: overrides.repository ?? getRuntimeQueueRepository(),
        replan: overrides.replan ?? runtimeReplan,
        enqueueReviewed: overrides.enqueueReviewed ?? enqueueReviewedMainPlan,
    }
    const checkedJobs = async (grant: AgentExecutionGrant): Promise<GenerationJob[] | null> => {
        if (!Number.isSafeInteger(grant.imageCount) || grant.imageCount < 1 || grant.imageCount > 100) return null
        await dependencies.repository.initialize()
        const batchId = `main-batch-${grant.scopeId}`
        const batch = await dependencies.repository.getBatch(batchId)
        if (batch === null || batch.workflow !== 'main' || batch.idempotencyKey !== `main-enqueue-${grant.scopeId}`) return null
        const page = await dependencies.repository.listJobs({ batchId, limit: 100 })
        const jobs = [...page.items].sort((left, right) => left.ordinal - right.ordinal)
        if (page.nextCursor !== null || jobs.length !== grant.imageCount || jobs.some((job, ordinal) => (
            job.id !== `main-job-${grant.scopeId}-${ordinal}` || job.batchId !== batchId || job.ordinal !== ordinal
            || job.workflow !== 'main' || job.idempotencyKey !== `main-enqueue-${grant.scopeId}-${ordinal}`
            || job.snapshotHash !== hashGenerationJobSnapshot(job.snapshot)
            || canonicalSerialize(job.snapshot.agentExecutionBinding ?? null) !== canonicalSerialize(binding(grant))
        ))) return null
        return jobs
    }
    return {
        async validate(plan) {
            try {
                const input = replanInput(plan)
                if (input === null || plan.requiredApprovals.length !== 0 || plan.jobs.length > 100
                    || plan.executionPolicy.credentialDispatch.kind !== 'auto'
                    || plan.executionPolicy.retryPolicyId !== CURRENT_MAIN_QUEUE_POLICY.retryPolicyId
                    || plan.executionPolicy.maxConcurrency !== CURRENT_MAIN_QUEUE_POLICY.maxConcurrency
                    || !hasStrictReviewedMainDestination(plan as GenerationPlan<PreparedMainGeneration>)) return false
                const replayed = await replayGenerationPlan(plan, input, await dependencies.replan(plan))
                return replayed.status === 'ready' && hasStrictReviewedMainDestination(replayed.plan)
            } catch { return false }
        },
        async enqueue(plan, grant) {
            // Check original facts first: a receipt crash must not mint another batch or timestamp.
            if (await checkedJobs(grant) !== null) return runResult(grant)
            if (await dependencies.repository.getBatch(`main-batch-${grant.scopeId}`) !== null) {
                return { status: 'conflict', issueCodes: ['agent-queue-binding-conflict'] }
            }
            const input = replanInput(plan)
            if (input === null || plan.planId !== grant.planId || plan.planHash !== grant.planHash
                || plan.estimatedAnlas !== grant.estimatedAnlas || plan.jobs.length !== grant.imageCount) {
                return { status: 'invalid', issueCodes: ['agent-plan-grant-mismatch'] }
            }
            if (plan.requiredApprovals.length !== 0 || plan.estimatedAnlas > plan.budget.maxAnlas
                || plan.jobs.length > plan.budget.maxImages) {
                return { status: 'invalid', issueCodes: ['reviewed-budget-needs-input'] }
            }
            const replan = await dependencies.replan(plan)
            const costConsent = createAnlasCostConsentSnapshot({
                pricingBasis: plan.executionPolicy.pricingBasis, estimatedAnlas: grant.estimatedAnlas,
                maxAnlas: Math.min(plan.budget.maxAnlas, grant.estimatedAnlas),
                estimatedAt: grant.consentedAt, approvedAt: grant.consentedAt,
            })
            const result = await enqueueGeneration({ reviewedPlan: plan as GenerationPlan<PreparedMainGeneration>,
                costConsent, idempotencyKey: grant.scopeId,
                actor: { kind: grant.actorKind, id: `client:${grant.clientId}` }, replanInput: input,
            }, { replan, enqueue: { enqueue: async request => {
                const queued = await dependencies.enqueueReviewed({ reviewed: request.plan, input, dependencies: replan,
                    submissionPolicy: { kind: 'reviewed', costConsent: request.costConsent },
                    idempotencyScope: grant.scopeId, strictReviewedDestination: true, agentExecutionBinding: binding(grant),
                })
                if (queued.status === 'enqueued') return { status: 'ready', batchId: queued.queue.batch.id,
                    jobs: queued.queue.jobs.map(job => ({ id: job.id, ordinal: job.ordinal })) }
                if (queued.status !== 'needs_input') return queued
                return { status: 'invalid', issues: [{ code: 'reviewed-budget-needs-input', severity: 'blocking',
                    fieldPath: 'budget', message: 'Create a new plan with sufficient review limits.' }] }
            } } })
            if (result.status === 'ready') return { ...result, jobIds: [...result.jobIds] }
            return { status: result.status, issueCodes: 'issues' in result
                ? result.issues.map(issue => issue.code) : ['reviewed-source-conflict'] }
        },
        async reconcile(grant) {
            return await checkedJobs(grant) === null ? null : runResult(grant)
        },
        async isOutstanding(grant) {
            const jobs = await checkedJobs(grant)
            if (jobs === null) return true
            for (const job of jobs) {
                if (!(TERMINAL_JOB_STATES as readonly string[]).includes(job.state)) return true
                if (job.state === 'succeeded' && job.attemptCount === 0) return true
                const attempts = await dependencies.repository.listAttempts(job.id)
                if (attempts.length !== job.attemptCount || attempts.some(attempt => (
                    attempt.providerEvidence === null || attempt.providerEvidence.providerOutcome === 'unknown'
                    || attempt.providerEvidence.providerOutcome === 'running' || attempt.providerEvidence.billingRisk === 'possible'
                ))) return true
            }
            return false
        },
    }
}
