import type { AgentCommandHandler } from '@/application/agent/runtime-capability-registry'
import { getAgentCommandInputContract } from '@/application/agent/agent-command-input'
import { assertAgentPublicValue } from '@/application/agent/agent-command-contract'
import type { AgentExecutionGrant } from '@/application/agent/agent-execution-repository'
import type { GenerationPlan, DetachedGenerationCapture, PlanGenerationResult, Sha256Digest } from '@/application/generation/generation-plan-contract'
import { compareGenerationPlans, hashDetachedGenerationCapture, planGeneration } from '@/application/generation/plan-generation'
import { persistGenerationPlanResult, type GenerationPlanRepository } from '@/application/generation/generation-plan-repository'
import { hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import type { JsonObject } from '@/domain/composition/types'
import { CURRENT_MAIN_QUEUE_POLICY } from '@/domain/queue/types'
import { projectMainGenerationSemantic } from '@/services/generation/main-generation-semantic'
import { CURRENT_NAI_PAYLOAD_BUILDER_REVISION, queryNaiGenerationCompatibility } from '@/services/nai/compatibility'
import { enqueueReviewedSceneQueue, getSceneQueuePlanningFacts, prepareSceneQueueReview,
    type SceneQueueReplayIdentity, type SceneQueueSubmission } from '@/services/queue/scene-queue-adapter'

export interface AgentSceneGenerationInput {
    readonly source: { readonly kind: 'scene'; readonly targets: readonly {
        readonly presetId: string; readonly sceneId: string; readonly expectedRevision: number; readonly count: number
    }[] }
    readonly seedPolicy: { readonly kind: 'random' } | { readonly kind: 'fixed'; readonly seed: number }
        | { readonly kind: 'increment'; readonly firstSeed: number }
    readonly budget: { readonly maxImages: number; readonly maxAnlas: number }
}

interface SceneReplay {
    readonly input: AgentSceneGenerationInput
    readonly identity: SceneQueueReplayIdentity
    readonly production?: ProductionSceneReplay
}

/** Internal parent reference, never accepted as a public generation.plan parameter. */
export interface ProductionSceneReplay {
    readonly productionId: string
    readonly index: number
    readonly fileNames: readonly (readonly string[] | null)[]
}

/** Only hashes and replay identity persist. Rebuilt Scene preparation owns resources and Queue snapshots. */
interface AgentScenePreparedJob {
    readonly kind: 'agent-scene-generation'
    readonly ordinal: number
    readonly executionDigest: Sha256Digest
    readonly replay?: SceneReplay
}

function digest(value: unknown): Sha256Digest {
    // Scene output options use optional undefined fields; persist their existing JSON snapshot meaning.
    return `sha256:${hashCanonicalValue(JSON.parse(JSON.stringify(value)))}`
}

function replayOf(plan: GenerationPlan): SceneReplay | null {
    const prepared = plan.jobs[0]?.prepared as Partial<AgentScenePreparedJob> | undefined
    if (prepared?.kind !== 'agent-scene-generation' || !prepared.replay
        || plan.jobs.some((job, ordinal) => {
            const item = job.prepared as Partial<AgentScenePreparedJob> | null
            return item?.kind !== 'agent-scene-generation' || item.ordinal !== ordinal
        })) return null
    return prepared.replay
}

function validatedInput(value: unknown): AgentSceneGenerationInput {
    const input = getAgentCommandInputContract('generation.plan')!.validate(value as JsonObject)
    if ((input.source as JsonObject).kind !== 'scene') throw new TypeError('Expected revisioned Scene targets')
    return structuredClone(input) as unknown as AgentSceneGenerationInput
}

function previewText(value: string, limit: number): string | null {
    const preview = value.slice(0, limit)
    try { assertAgentPublicValue({ text: preview }); return preview } catch { return null }
}

/** A bounded public sample identifies reviewed work without exporting local paths or resource bytes. */
export function publicAgentScenePreview(plan: GenerationPlan<AgentScenePreparedJob>, submission: SceneQueueSubmission): JsonObject {
    const facts = getSceneQueuePlanningFacts(submission)
    const targets = plan.jobs[0].prepared.replay!.input.source.targets
    const sources = targets.slice(0, 20).map(target => ({ ...target,
        name: previewText(facts.prepared.find(item => item.presetId === target.presetId && item.sceneId === target.sceneId)!
            .prepared.scene.name, 96),
    }))
    const jobs = plan.jobs.slice(0, 10).map(job => ({
        ordinal: job.ordinal, presetId: facts.prepared[job.ordinal].presetId, sceneId: facts.prepared[job.ordinal].sceneId,
        prompt: previewText(job.semantic.prompt, 256), negativePrompt: previewText(job.semantic.negativePrompt, 96),
        promptDigest: digest({ positive: job.semantic.prompt, negative: job.semantic.negativePrompt }),
        model: previewText(job.semantic.model, 96), width: job.semantic.width, height: job.semantic.height,
        steps: job.semantic.steps, seed: job.semantic.seed, estimatedAnlas: job.estimatedAnlas,
        destination: { generationFolderId: job.destination.generationFolderId === null ? null
            : previewText(job.destination.generationFolderId, 200),
        fileName: previewText(`${job.destination.expectedBaseName}.${job.destination.extension}`, 255),
        collisionPolicy: job.destination.collisionPolicy,
        r2ProfileId: job.destination.r2?.profileId ?? null,
        r2DestinationDigest: job.destination.r2 === undefined ? null : digest(job.destination.r2) },
    }))
    return { sources, jobs, sourceCount: targets.length,
        omittedSources: Math.max(0, targets.length - sources.length), omittedJobs: Math.max(0, plan.jobs.length - jobs.length) }
}

/** Reuses GUI Scene preparation and the generic plan hash/budget engine; never creates Queue state. */
export async function planAgentSceneGeneration(
    inputValue: AgentSceneGenerationInput,
    identity?: SceneQueueReplayIdentity,
    production?: ProductionSceneReplay,
): Promise<{ result: PlanGenerationResult<AgentScenePreparedJob>; submission: SceneQueueSubmission }> {
    const input = validatedInput(inputValue)
    const count = input.source.targets.reduce((sum, target) => sum + target.count, 0)
    const policy = input.seedPolicy
    const materializedSeeds = identity?.materializedSeeds ?? (policy.kind === 'random'
        ? [...globalThis.crypto.getRandomValues(new Uint32Array(count))]
        : Array.from({ length: count }, (_, ordinal) => policy.kind === 'fixed'
            ? policy.seed : (policy.firstSeed + ordinal) >>> 0))
    const replay: SceneReplay = { input, ...(production === undefined ? {} : { production }), identity: identity ?? {
        reviewId: `scene-review-${globalThis.crypto.randomUUID()}`,
        reviewedAt: new Date().toISOString(), materializedSeeds,
    } }
    const review = await prepareSceneQueueReview(input.source.targets.map((target, index) => ({ ...target,
        ...(production?.fileNames[index] == null ? {} : { fileNames: production.fileNames[index]! }),
    })), { replayIdentity: replay.identity })
    if (review === null) throw new TypeError('Scene plan must contain at least one image')
    const facts = getSceneQueuePlanningFacts(review.submission)
    const pricingBasis = facts.prepared[0].prepared.costEstimate.pricingBasis
    if (facts.prepared.some(item => item.prepared.costEstimate.pricingBasis !== pricingBasis)) {
        throw new TypeError('Scene plan pricing must use one credential tier')
    }
    const jobs = facts.prepared.map((item, ordinal) => {
        const prepared = item.prepared
        const allocation = facts.allocations[ordinal]
        const delivery = facts.r2Deliveries[ordinal]
        if (delivery.requirement !== 'disabled' && delivery.planned === null) {
            throw new TypeError('Agent Scene R2 delivery needs an immutable reviewed destination')
        }
        const semantic = projectMainGenerationSemantic(prepared.params, prepared.imageFormat)
        const executionDigest = digest({ semantic, scene: prepared.scene, sceneBinding: item.sceneBinding,
            saveContext: prepared.saveContext, outputContext: prepared.outputContext,
            sequenceCommitProposal: prepared.sequenceCommitProposal, planHash: prepared.planHash,
            costEstimate: prepared.costEstimate, allocation, delivery, streaming: facts.streaming })
        return {
            semantic, preparationDigest: executionDigest,
            destination: {
                generationFolderId: prepared.outputContext.generationFolderId ?? null,
                generationFolderPathHash: prepared.outputContext.generationFolderPath
                    ? digest(prepared.outputContext.generationFolderPath) : null,
                outputPolicyId: digest({ output: prepared.outputContext, allocation }),
                expectedBaseName: allocation.fileName.replace(/\.(?:png|webp)$/i, ''),
                extension: prepared.imageFormat, collisionPolicy: 'fail' as const, deliveryRequired: true,
                ...(delivery.planned === null ? {} : { r2: delivery.planned.destination }),
            },
            prepared: { kind: 'agent-scene-generation' as const, ordinal, executionDigest,
                ...(ordinal === 0 ? { replay } : {}) },
        }
    })
    const sceneBindings = [...new Map(facts.prepared.map(item => [item.sceneBinding.resourceId, item.sceneBinding])).values()]
    const metadataModes = new Set(facts.prepared.map(item => item.prepared.outputContext.metadataMode ?? 'embedded'))
    const captureContent: Omit<DetachedGenerationCapture<AgentScenePreparedJob>, 'contentHash'> = {
        schemaVersion: 1, captureId: replay.identity.reviewId,
        sourceBindings: [facts.folderBinding, ...sceneBindings],
        materializedSeeds: facts.replayIdentity.materializedSeeds, jobs,
        executionPolicy: { failurePolicy: 'continue', ...CURRENT_MAIN_QUEUE_POLICY, maxAttempts: 3,
            credentialDispatch: { kind: 'auto' }, pricingBasis,
            metadataMode: metadataModes.size === 1 ? [...metadataModes][0] : 'mixed' },
        credentialReadinessFingerprint: digest({ pricingBasis }),
    }
    const capture = { ...captureContent, contentHash: hashDetachedGenerationCapture(captureContent) }
    const result = await planGeneration({ source: { kind: 'detached-generation-capture', capture }, count,
        seedPolicy: { kind: 'replay', traceId: capture.captureId }, budget: input.budget }, {
        // Detached planning never reads a WorkflowDraft or enters its planner.
        drafts: { get: async () => null }, planner: { prepare: async () => [] },
        executionPolicy: capture.executionPolicy,
        estimateAnlas: job => facts.prepared[job.prepared.ordinal].estimatedAnlas,
        resolveCompatibility: job => {
            const params = facts.prepared[job.prepared.ordinal].prepared.params
            const compatibility = queryNaiGenerationCompatibility(params, CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
                facts.streaming && !Boolean(params.sourceImage || params.mask))
            return { compatibilityProfileId: compatibility.compatibilityProfileId, status: compatibility.status }
        },
    })
    return { result, submission: review.submission }
}

export function createAgentSceneGenerationPlanHandler(plans: GenerationPlanRepository): AgentCommandHandler {
    return {
        command: 'generation.plan', effect: 'plan', validate: getAgentCommandInputContract('generation.plan')!.validate,
        // A failed Scene plan must be visible as a rejected receipt so MCP does
        // not mistake an application validation result for approval progress.
        receiptState: result => result.status === 'ready' || result.status === 'needs_input'
            ? 'completed' : 'rejected',
        execute: async (input): Promise<JsonObject> => {
            try {
                const { result, submission } = await planAgentSceneGeneration(input as unknown as AgentSceneGenerationInput)
                await persistGenerationPlanResult(result, plans)
                if (result.status === 'ready' || result.status === 'needs_input') return {
                    status: result.status, planId: result.plan.planId, planHash: result.plan.planHash,
                    jobCount: result.plan.jobs.length, estimatedAnlas: result.plan.estimatedAnlas,
                    requiredApprovals: result.plan.requiredApprovals.map(item => ({ ...item })),
                    review: publicAgentScenePreview(result.plan, submission),
                }
                const issueCodes = 'issues' in result
                    ? result.issues.map(issue => issue.code) : ['scene-source-changed']
                return {
                    status: result.status, issueCodes,
                    ...( 'issues' in result
                        ? { issues: result.issues.map(issue => ({ code: issue.code, fieldPath: issue.fieldPath })) }
                        : {}),
                    nextAction: 'revise-scene-source-or-settings',
                }
            } catch {
                // Local paths and repository details must not cross the public receipt boundary.
                return { status: 'invalid', issueCodes: ['scene-plan-unavailable'], nextAction: 'refresh-scene-snapshot' }
            }
        },
    }
}

async function rebuild(plan: GenerationPlan): Promise<SceneQueueSubmission | null> {
    const replay = replayOf(plan)
    if (replay === null || plan.requiredApprovals.length !== 0 || plan.jobs.length > 100) return null
    const rebuilt = await planAgentSceneGeneration(replay.input, replay.identity, replay.production)
    return rebuilt.result.status === 'ready' && compareGenerationPlans(plan, rebuilt.result.plan) === null
        ? rebuilt.submission : null
}

export async function validateAgentSceneGenerationPlan(plan: GenerationPlan): Promise<boolean> {
    try {
        const production = replayOf(plan)?.production
        if (production && !await (await import('./production-request-state')).validateRuntimeProductionPlan(production, plan.planId)) return false
        return await rebuild(plan) !== null
    } catch { return false }
}

/** The existing coordinator supplies the grant; this adapter only binds it to the existing Scene Queue. */
export async function enqueueAgentSceneGenerationPlan(plan: GenerationPlan, grant: AgentExecutionGrant): Promise<JsonObject> {
    if (plan.planId !== grant.planId || plan.planHash !== grant.planHash
        || plan.jobs.length !== grant.imageCount || plan.estimatedAnlas !== grant.estimatedAnlas
        || plan.requiredApprovals.length > 0 || plan.jobs.length > plan.budget.maxImages
        || plan.estimatedAnlas > plan.budget.maxAnlas) {
        return { status: 'invalid', issueCodes: ['agent-plan-grant-mismatch'] }
    }
    let submission: SceneQueueSubmission | null
    try { submission = await rebuild(plan) } catch { submission = null }
    if (submission === null) return { status: 'conflict', issueCodes: ['reviewed-scene-source-conflict'] }
    const production = replayOf(plan)?.production
    const queued = await enqueueReviewedSceneQueue(submission, {
        binding: { scopeId: grant.scopeId, planId: grant.planId, planHash: grant.planHash,
            grantHash: `sha256:${hashCanonicalValue(grant)}` },
        approvedAt: grant.consentedAt, actor: { kind: grant.actorKind, id: `client:${grant.clientId}` },
        imageCount: grant.imageCount, estimatedAnlas: grant.estimatedAnlas, budget: plan.budget,
    }, production === undefined ? undefined : {
        binding: { productionId: production.productionId, index: production.index, planId: plan.planId, planHash: plan.planHash },
        reserve: async runId => (await import('./production-request-state')).reserveRuntimeProductionChild(
            production.productionId, production.index, plan.planId, runId,
        ),
    })
    if (production) await (await import('./production-request-state')).acknowledgeRuntimeProductionChild(
        production.productionId, production.index, queued.batch.id,
    )
    return { status: 'ready', batchId: queued.batch.id, runId: queued.batch.id,
        jobIds: [...queued.jobs].sort((left, right) => left.ordinal - right.ordinal).map(job => job.id) }
}
