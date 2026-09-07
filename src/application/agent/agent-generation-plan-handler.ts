import type { JsonObject } from '@/domain/composition/types'
import { planGeneration, type PlanGenerationDependencies } from '@/application/generation/plan-generation'
import { persistGenerationPlanResult, type GenerationPlanRepository } from '@/application/generation/generation-plan-repository'
import type { PlanGenerationInput } from '@/application/generation/generation-plan-contract'
import { getAgentCommandInputContract } from './agent-command-input'
import type { AgentCommandHandler } from './runtime-capability-registry'

/** Concrete Phase 9A consumer: persist the internal plan, return only opaque public review facts. */
export function createAgentGenerationPlanHandler<TPrepared>(
    dependencies: PlanGenerationDependencies<TPrepared>, repository: GenerationPlanRepository,
): AgentCommandHandler {
    return {
        command: 'generation.plan', effect: 'plan', validate: getAgentCommandInputContract('generation.plan')!.validate,
        execute: async (input): Promise<JsonObject> => {
            const result = await persistGenerationPlanResult(
                await planGeneration(input as unknown as PlanGenerationInput<TPrepared>, dependencies), repository,
            )
            if (result.status === 'ready' || result.status === 'needs_input') {
                return {
                    status: result.status, planId: result.plan.planId, planHash: result.plan.planHash,
                    jobCount: result.plan.jobs.length, estimatedAnlas: result.plan.estimatedAnlas,
                    requiredApprovals: result.plan.requiredApprovals.map(item => ({
                        kind: item.kind, fieldPath: item.fieldPath, required: item.required, allowed: item.allowed,
                    })),
                }
            }
            if (result.status === 'conflict') return { status: 'conflict', code: 'SOURCE_REVISION_CONFLICT' }
            return { status: result.status, issueCodes: result.issues.map(issue => issue.code) }
        },
    }
}
