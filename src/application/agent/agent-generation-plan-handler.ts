import type { JsonObject } from '@/domain/composition/types'
import { planGeneration, type PlanGenerationDependencies } from '@/application/generation/plan-generation'
import { persistGenerationPlanResult, type GenerationPlanRepository } from '@/application/generation/generation-plan-repository'
import type { PlanGenerationInput } from '@/application/generation/generation-plan-contract'
import { AgentCommandError } from './agent-command-contract'
import type { AgentCommandHandler } from './runtime-capability-registry'

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) {
        throw new AgentCommandError('INVALID_COMMAND_INPUT')
    }
    return value as Record<string, unknown>
}

/** External plans start from existing workflow authority, never detached prepared payloads. */
function validatePlanInput(value: JsonObject): JsonObject {
    const input = record(value, ['source', 'count', 'seedPolicy', 'budget'])
    const source = record(input.source, ['kind', 'draftId', 'expectedRevision'])
    if (source.kind !== 'workflow-draft' || typeof source.draftId !== 'string'
        || source.draftId.trim() !== source.draftId || source.draftId.length === 0 || source.draftId.length > 200
        || !Number.isSafeInteger(source.expectedRevision) || Number(source.expectedRevision) < 0
        || !Number.isSafeInteger(input.count) || Number(input.count) < 1 || Number(input.count) > 100) {
        throw new AgentCommandError('INVALID_COMMAND_INPUT')
    }
    if (typeof input.seedPolicy !== 'object' || input.seedPolicy === null || Array.isArray(input.seedPolicy)) {
        throw new AgentCommandError('INVALID_COMMAND_INPUT')
    }
    const seedKind = (input.seedPolicy as Record<string, unknown>).kind
    const seed = record(input.seedPolicy, seedKind === 'random' ? ['kind']
        : seedKind === 'fixed' ? ['kind', 'seed'] : ['kind', 'firstSeed'])
    if (!['random', 'fixed', 'increment'].includes(seed.kind as string)) throw new AgentCommandError('INVALID_COMMAND_INPUT')
    const seedValue = seed.kind === 'fixed' ? seed.seed : seed.firstSeed
    if (seed.kind !== 'random' && (!Number.isSafeInteger(seedValue) || Number(seedValue) < 0
        || Number(seedValue) > 0xffff_ffff)) throw new AgentCommandError('INVALID_COMMAND_INPUT')
    const budget = record(input.budget, ['maxImages', 'maxAnlas'])
    if (!Number.isSafeInteger(budget.maxImages) || Number(budget.maxImages) < 0 || Number(budget.maxImages) > 100
        || typeof budget.maxAnlas !== 'number' || !Number.isFinite(budget.maxAnlas) || budget.maxAnlas < 0) {
        throw new AgentCommandError('INVALID_COMMAND_INPUT')
    }
    return value
}

/** Concrete Phase 9A consumer: persist the internal plan, return only opaque public review facts. */
export function createAgentGenerationPlanHandler<TPrepared>(
    dependencies: PlanGenerationDependencies<TPrepared>, repository: GenerationPlanRepository,
): AgentCommandHandler {
    return {
        command: 'generation.plan', effect: 'plan', validate: validatePlanInput,
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
