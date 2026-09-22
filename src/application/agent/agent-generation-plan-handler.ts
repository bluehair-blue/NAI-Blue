import { assertAgentPublicValue } from './agent-command-contract'
import type { JsonObject, JsonValue } from '@/domain/composition/types'
import { planGeneration, type PlanGenerationDependencies } from '@/application/generation/plan-generation'
import { persistGenerationPlanResult, type GenerationPlanRepository } from '@/application/generation/generation-plan-repository'
import { hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import type { GenerationPlan, PlanGenerationInput, Sha256Digest } from '@/application/generation/generation-plan-contract'
import { getAgentCommandInputContract } from './agent-command-input'
import type { AgentCommandHandler } from './runtime-capability-registry'

function digest(value: unknown): Sha256Digest {
    return `sha256:${hashCanonicalValue(value)}`
}

function previewText(value: string, limit: number): string | null {
    const preview = value.slice(0, limit)
    try {
        assertAgentPublicValue({ text: preview })
        return preview
    } catch {
        return null
    }
}

function publicGenerationSettings(value: JsonValue): JsonObject {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
    const result: JsonObject = {}
    for (const key of ['cfgScale', 'cfgRescale', 'sampler', 'scheduler', 'smea', 'smeaDyn',
        'variety', 'qualityToggle', 'ucPreset', 'transparentBackground']) {
        const candidate = (value as Record<string, JsonValue>)[key]
        if (candidate === null || typeof candidate === 'string'
            || typeof candidate === 'number' || typeof candidate === 'boolean') {
            result[key] = candidate
        }
    }
    return result
}

/** Bounded review facts let an agent diagnose a plan without exporting prepared jobs or paths. */
function publicPlanReview<TPrepared>(plan: GenerationPlan<TPrepared>): JsonObject {
    const jobs = plan.jobs.slice(0, 10).map(job => ({
        ordinal: job.ordinal,
        promptDigest: digest({ positive: job.semantic.prompt, negative: job.semantic.negativePrompt }),
        promptLengths: { positive: job.semantic.prompt.length, negative: job.semantic.negativePrompt.length },
        model: previewText(job.semantic.model, 96),
        width: job.semantic.width,
        height: job.semantic.height,
        steps: job.semantic.steps,
        seed: job.semantic.seed,
        settings: publicGenerationSettings(job.semantic.generationParameters),
        estimatedAnlas: job.estimatedAnlas,
        compatibility: {
            profileId: previewText(job.compatibility.compatibilityProfileId, 128),
            status: job.compatibility.status,
        },
        destination: {
            generationFolderSelected: job.destination.generationFolderId !== null,
            extension: job.destination.extension,
            collisionPolicy: job.destination.collisionPolicy,
            deliveryRequired: job.destination.deliveryRequired,
            r2Requested: job.destination.r2 !== undefined,
        },
    }))
    return {
        jobCount: plan.jobs.length,
        omittedJobs: Math.max(0, plan.jobs.length - jobs.length),
        jobs,
        sourceBindings: plan.sourceBindings.map(binding => ({
            resourceType: binding.resourceType,
            resourceId: previewText(binding.resourceId, 200),
            revision: binding.revision,
            contentHash: binding.contentHash,
        })),
        seedTrace: { source: plan.materializedSeedTrace.source, count: plan.materializedSeedTrace.seeds.length },
        warnings: plan.issues.map(issue => ({ code: issue.code, fieldPath: issue.fieldPath })),
        compatibilityStatuses: [...new Set(plan.jobs.map(job => job.compatibility.status))],
        executionPolicy: {
            retryPolicyId: previewText(plan.executionPolicy.retryPolicyId, 128),
            maxAttempts: plan.executionPolicy.maxAttempts,
            maxConcurrency: plan.executionPolicy.maxConcurrency,
            dispatchMode: { kind: plan.executionPolicy.credentialDispatch.kind },
            pricingBasis: plan.executionPolicy.pricingBasis,
            metadataMode: previewText(plan.executionPolicy.metadataMode, 64),
        },
    }
}

function nextActionForStatus(status: string, issueCodes: readonly string[]): string {
    if (status === 'conflict') return 'refresh-workspace-snapshot'
    if (issueCodes.includes('draft-count-mismatch')) return 'use-saved-draft-image-count'
    if (issueCodes.includes('draft-resolution-required')) return 'repair-workflow-draft-in-guided-ui'
    if (issueCodes.some(code => code.startsWith('draft-'))) return 'repair-workflow-draft-in-guided-ui'
    return status === 'unsupported' ? 'change-workflow-source-or-settings' : 'revise-generation-input'
}

/** Concrete Phase 9A consumer: persist the internal plan, return only opaque public review facts. */
export function createAgentGenerationPlanHandler<TPrepared>(
    dependencies: PlanGenerationDependencies<TPrepared>, repository: GenerationPlanRepository,
): AgentCommandHandler {
    return {
        command: 'generation.plan', effect: 'plan', validate: getAgentCommandInputContract('generation.plan')!.validate,
        // Invalid/conflicted plans are application rejections, not successful approval requests.
        receiptState: result => result.status === 'ready' || result.status === 'needs_input'
            ? 'completed' : 'rejected',
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
                    review: publicPlanReview(result.plan),
                }
            }
            if (result.status === 'conflict') return {
                status: 'conflict', code: 'SOURCE_REVISION_CONFLICT',
                currentRevision: result.currentRevision,
                nextAction: nextActionForStatus(result.status, []),
            }
            const issueCodes = result.issues.map(issue => issue.code)
            return {
                status: result.status,
                issueCodes,
                issues: result.issues.map(issue => ({ code: issue.code, fieldPath: issue.fieldPath })),
                nextAction: nextActionForStatus(result.status, issueCodes),
                ...(result.status === 'unsupported' ? { capability: result.capability } : {}),
            }
        },
    }
}
