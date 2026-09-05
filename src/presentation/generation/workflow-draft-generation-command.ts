import { enqueueGeneration } from '@/application/generation/enqueue-generation-plan'
import type {
    EnqueueGenerationPort,
    EnqueueGenerationResult,
} from '@/application/generation/generation-command-contract'
import type { PlanGenerationResult } from '@/application/generation/generation-plan-contract'
import type { WorkflowDraftRepositoryPort } from '@/application/workflow/workflow-draft-repository'
import { createAnlasCostConsentSnapshot } from '@/domain/queue/anlas-cost-consent'
import type { BatchImageDraft, SingleImageDraft } from '@/domain/workflow/single-image-draft'
import {
    createWorkflowDraftGenerationInput,
    createWorkflowDraftGenerationPlanDependencies,
    planWorkflowDraftGeneration,
} from '@/presentation/generation/workflow-draft-main-batch-planner'
import type { PreparedMainGeneration } from '@/services/generation/main-generation-plan'
import { enqueueReviewedMainPlan } from '@/services/queue/main-queue-adapter'
import type { FragmentLookupRepository } from '@/stores/fragment-store'
import type { GenerationAssessmentRequirement } from '@/domain/assessment/visual-rubric'

type GuidedDraft = SingleImageDraft | BatchImageDraft

export type WorkflowDraftGenerationCommandResult =
    | EnqueueGenerationResult<PreparedMainGeneration>
    | Extract<PlanGenerationResult<PreparedMainGeneration>, { readonly status: 'needs_input' }>

/** Plans from explicitly injected Guided state, records the user's cost approval, then persists through the application command. */
export async function enqueueWorkflowDraftGenerationCommand(input: {
    readonly draft: GuidedDraft
    readonly maxImages: number
    readonly maxAnlas: number
    readonly pricingBasis: 'paid' | 'all-active-opus'
    readonly approvedAt: string
    readonly drafts: Pick<WorkflowDraftRepositoryPort, 'get'>
    readonly fragmentRepository: FragmentLookupRepository
    readonly assessment?: GenerationAssessmentRequirement
}): Promise<WorkflowDraftGenerationCommandResult> {
    const planInput = { ...createWorkflowDraftGenerationInput(input.draft, {
        maxImages: input.maxImages,
        maxAnlas: input.maxAnlas,
    }), ...(input.assessment === undefined ? {} : { assessment: input.assessment }) }
    const dependencies = createWorkflowDraftGenerationPlanDependencies({
        drafts: input.drafts,
        fragmentRepository: input.fragmentRepository,
        pricingBasis: input.pricingBasis,
    })
    const planned = await planWorkflowDraftGeneration(planInput, {
        drafts: input.drafts,
        fragmentRepository: input.fragmentRepository,
        pricingBasis: input.pricingBasis,
    })
    if (planned.status !== 'ready') return planned

    const costConsent = createAnlasCostConsentSnapshot({
        pricingBasis: input.pricingBasis,
        estimatedAnlas: planned.plan.estimatedAnlas,
        maxAnlas: input.maxAnlas,
        estimatedAt: input.approvedAt,
        approvedAt: input.approvedAt,
    })
    const enqueuePort: EnqueueGenerationPort<PreparedMainGeneration> = {
        enqueue: async request => {
            const result = await enqueueReviewedMainPlan({
                reviewed: request.plan,
                input: {
                    source: planInput.source,
                    count: planInput.count,
                    budget: planInput.budget,
                    ...(planInput.assessment === undefined ? {} : { assessment: planInput.assessment }),
                },
                dependencies,
                submissionPolicy: { kind: 'guided', costConsent: request.costConsent },
                idempotencyScope: request.idempotencyKey,
            })
            if (result.status === 'needs_input') {
                return {
                    status: 'invalid',
                    issues: [{
                        code: 'generation-plan-needs-input',
                        severity: 'blocking',
                        fieldPath: 'reviewedPlan.requiredApprovals',
                        message: 'The reviewed plan still requires approval input.',
                    }],
                }
            }
            if (result.status !== 'enqueued') return result
            return {
                status: 'ready',
                batchId: result.queue.batch.id,
                jobs: result.queue.jobs.map(job => ({ id: job.id, ordinal: job.ordinal })),
            }
        },
    }
    return enqueueGeneration<PreparedMainGeneration>({
        reviewedPlan: planned.plan,
        costConsent,
        idempotencyKey: `guided:${input.draft.id}:revision:${input.draft.revision}`,
        actor: { kind: 'user', id: 'guided-ui:user' },
        replanInput: {
            source: planInput.source,
            count: planInput.count,
            budget: planInput.budget,
            ...(planInput.assessment === undefined ? {} : { assessment: planInput.assessment }),
        },
    }, { replan: dependencies, enqueue: enqueuePort })
}
