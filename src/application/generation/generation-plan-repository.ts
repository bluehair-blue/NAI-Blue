import type { GenerationPlan, PlanGenerationResult } from './generation-plan-contract'

/** Internal immutable authority. Prepared values stay private; replay remains the execution validator. */
export interface GenerationPlanRepository {
    putIfAbsent(plan: GenerationPlan): Promise<'stored' | 'same' | 'conflict'>
    get(planId: string): Promise<GenerationPlan | null>
}

/**
 * Future inbox handlers publish plan handles only after persistence succeeds.
 * Expiry belongs to command authorization, not mutable state on the reviewed plan.
 */
export async function persistGenerationPlanResult<TPrepared>(
    result: PlanGenerationResult<TPrepared>,
    repository: GenerationPlanRepository,
): Promise<PlanGenerationResult<TPrepared>> {
    if (result.status === 'ready' || result.status === 'needs_input') {
        if (await repository.putIfAbsent(result.plan) === 'conflict') {
            throw new Error('Generation plan identity conflicts with persisted content')
        }
    }
    return result
}
