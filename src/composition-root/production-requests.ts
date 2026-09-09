import { IndexedDbGenerationPlanRepository } from '@/adapters/generation/indexeddb-generation-plan-repository'
import { getRuntimeGenerationRun } from '@/adapters/generation/indexeddb-generation-run-reader'
import { createProductionRequest, withProductionReview, acknowledgeProductionChild,
    type ProductionRequest, type ProductionTarget } from '@/application/generation/production-request'
import { summarizeGenerationRun } from '@/application/generation/generation-run-monitor'
import { createSceneGenerationBinding, resolveRepositorySceneBatchTargets } from '@/application/scene/plan-scene-batch'
import type { AgentCommandHandler } from '@/application/agent/runtime-capability-registry'
import { getAgentCommandInputContract } from '@/application/agent/agent-command-input'
import type { JsonObject } from '@/domain/composition/types'
import { hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import type { Sha256Digest } from '@/application/generation/generation-plan-contract'
import { hashGenerationSemanticIntent } from '@/application/generation/plan-generation'
import type { GenerationJob } from '@/domain/queue/types'
import { getRuntimeSceneRepository } from '@/lib/scene-migration-startup'
import { flushSceneAuthorityRuntime } from '@/lib/scene-authority-runtime'
import { getRuntimeQueueRepository } from '@/services/queue/indexeddb-queue-repository'
import { enqueueReviewedSceneQueue, getSceneQueuePlanningFacts,
    type SceneQueueTarget, type SceneQueueSubmission, type PreparedSceneQueueReview } from '@/services/queue/scene-queue-adapter'
import { runtimeProductionRequests as requests, requireProductionRequest as required, saveProductionRequest as save,
    reserveRuntimeProductionChild, acknowledgeRuntimeProductionChild } from './production-request-state'

const plans = new IndexedDbGenerationPlanRepository()
type SeedPolicy = { kind: 'random' } | { kind: 'fixed'; seed: number } | { kind: 'increment'; firstSeed: number }
export interface ProductionStatus {
    id: string; title: string; revision: number; totalImages: number; childCount: number; admittedImages: number
    estimatedAnlasReserved: number; maxAnlas: number
    nextAction: 'review-next-batch' | 'wait' | 'check-results' | 'complete'
    children: { index: number; imageCount: number; runId: string | null; status: string }[]
    counts: { generated: number; stored: number; uploaded: number; uploadRequested: number }
    issue: string | null
}

function problem(code: string): never { throw new Error(code) }
const childCount = (child: ProductionRequest['children'][number]) => child.targets.reduce((sum, target) => sum + target.count, 0)

/** IDs, persisted plan association and semantic intent all identify the exact admitted child. */
async function checkedChild(request: ProductionRequest, child: ProductionRequest['children'][number]): Promise<GenerationJob[] | null> {
    if (!child.submission || !child.review) return null
    const runId = child.submission.runId
    const batch = await getRuntimeQueueRepository().getBatch(runId)
    if (!batch) return null
    const plan = await plans.get(child.review.planId)
    const page = await getRuntimeQueueRepository().listJobs({ batchId: runId, limit: 100 })
    const scope = runId.slice('scene-batch-'.length)
    const jobs = [...page.items].sort((a, b) => a.ordinal - b.ordinal)
    if (!runId.startsWith('scene-batch-') || batch.workflow !== 'scene' || batch.idempotencyKey !== `scene-enqueue-${scope}`
        || !plan || plan.planHash !== child.review.planHash || plan.jobs.length !== childCount(child)
        || page.nextCursor !== null || jobs.length !== childCount(child) || jobs.some((job, ordinal) => {
            const binding = job.snapshot.productionBinding
            return job.batchId !== runId || job.workflow !== 'scene' || job.ordinal !== ordinal
                || job.id !== `scene-job-${scope}-${ordinal}` || job.idempotencyKey !== `scene-enqueue-${scope}-${ordinal}`
                || binding?.productionId !== request.id || binding.index !== child.index
                || binding.planId !== plan.planId || binding.planHash !== plan.planHash
                || job.snapshot.providerExecutionEnvelope?.semanticIntentHash !== hashGenerationSemanticIntent(plan.jobs[ordinal].semantic)
                || job.snapshot.outputReservation?.relativePath !== `${plan.jobs[ordinal].destination.expectedBaseName}.${plan.jobs[ordinal].destination.extension}`
        })) problem('PRODUCTION_QUEUE_BINDING_CONFLICT')
    return jobs
}

/** A saved selection is a planning record, not consent to spend or an alternative Queue. */
export async function createRuntimeProductionRequest(input: {
    title: string; targets: readonly SceneQueueTarget[]; budget: { maxImages: number; maxAnlas: number }; seedPolicy?: SeedPolicy
}, id = `production-${globalThis.crypto.randomUUID()}`): Promise<ProductionRequest> {
    await flushSceneAuthorityRuntime()
    const sources = await resolveRepositorySceneBatchTargets(getRuntimeSceneRepository(), input.targets)
    const targets: ProductionTarget[] = sources.map(({ document, scene }, index) => ({
        presetId: document.presetId, sceneId: scene.id, count: input.targets[index].count,
        sourceHash: createSceneGenerationBinding(document, scene.id)!.contentHash,
        ...(input.targets[index].fileNames === undefined ? {} : { fileNames: [...input.targets[index].fileNames!] }),
    }))
    const total = targets.reduce((sum, target) => sum + target.count, 0)
    if (!Number.isSafeInteger(total) || total < 1 || total > 2400) problem('PRODUCTION_IMAGE_LIMIT')
    const policy = input.seedPolicy ?? { kind: 'random' }
    const seeds = policy.kind === 'random' ? [...globalThis.crypto.getRandomValues(new Uint32Array(total))]
        : Array.from({ length: total }, (_, index) => policy.kind === 'fixed' ? policy.seed : (policy.firstSeed + index) >>> 0)
    const request = createProductionRequest({ ...input, id, targets, seeds, createdAt: new Date().toISOString() })
    if (await requests.putIfAbsent(request) === 'conflict') problem('PRODUCTION_ID_CONFLICT')
    return request
}

export const listRuntimeProductionRequests = () => requests.list()

/** Only exact persisted child identities recover a lost parent acknowledgement; absence never retries enqueue. */
async function reconcile(request: ProductionRequest): Promise<ProductionRequest> {
    let current = request
    for (const child of current.children) {
        if (child.submission?.status !== 'submitting') continue
        if (!await checkedChild(current, child)) continue
        current = await save(current, acknowledgeProductionChild(current, child.index, child.submission.runId))
    }
    return current
}

/** Read-only aggregate: completion still requires fulfillment, never parent admission or Queue success alone. */
export async function getRuntimeProductionStatus(id: string): Promise<ProductionStatus | null> {
    const request = await requests.get(id)
    if (!request) return null
    const status: ProductionStatus = { id, title: request.title, revision: request.revision,
        totalImages: request.targets.reduce((sum, target) => sum + target.count, 0), childCount: request.children.length,
        admittedImages: 0, estimatedAnlasReserved: 0, maxAnlas: request.budget.maxAnlas,
        nextAction: 'review-next-batch', children: [], counts: { generated: 0, stored: 0, uploaded: 0, uploadRequested: 0 }, issue: null }
    let completed = 0
    for (const child of request.children) {
        const count = childCount(child)
        const row = { index: child.index, imageCount: count, runId: child.submission?.runId ?? null,
            status: child.review ? 'reviewed' : 'pending' }
        status.children.push(row)
        if (!child.submission) continue
        status.estimatedAnlasReserved += child.submission.estimatedAnlas
        let jobs: GenerationJob[] | null
        try { jobs = await checkedChild(request, child) }
        catch { row.status = 'binding-conflict'; status.nextAction = 'check-results'; status.issue = 'PRODUCTION_QUEUE_BINDING_CONFLICT'; continue }
        const run = jobs ? await getRuntimeGenerationRun(child.submission.runId) : null
        if (!run || run.jobs.length !== count || run.jobs.some(job => !jobs!.some(candidate => candidate.id === job.jobId))) {
            row.status = 'submission-unknown'; status.nextAction = 'check-results'; status.issue = 'PRODUCTION_SUBMISSION_UNKNOWN'
            continue
        }
        status.admittedImages += count
        const monitor = summarizeGenerationRun(run)
        for (const key of ['generated', 'stored', 'uploaded', 'uploadRequested'] as const) status.counts[key] += monitor.counts[key]
        const needsAttention = monitor.attention !== null || monitor.counts.cancelled > 0 || monitor.counts.skipped > 0
            || monitor.nextAction === 'resume-in-app'
        row.status = monitor.complete ? 'complete' : needsAttention ? 'attention' : 'running'
        if (monitor.complete) completed++
        else if (needsAttention) { status.nextAction = 'check-results'; status.issue ??= 'PRODUCTION_CHILD_NEEDS_ATTENTION' }
        else if (status.nextAction !== 'check-results') status.nextAction = 'wait'
    }
    if (completed === request.children.length) status.nextAction = 'complete'
    return status
}

/** Output attachment may advance document revision; the saved authoring hash must still match before a NEW review. */
async function childInput(request: ProductionRequest, index: number) {
    const child = request.children[index] ?? problem('PRODUCTION_CHILD_NOT_FOUND')
    const selected = child.targets.map(part => request.targets[part.targetIndex])
    const sources = await resolveRepositorySceneBatchTargets(getRuntimeSceneRepository(), selected)
    return child.targets.map((part, ordinal) => {
        const target = request.targets[part.targetIndex]
        const { document, scene } = sources[ordinal]
        if (createSceneGenerationBinding(document, scene.id)?.contentHash !== target.sourceHash) problem('PRODUCTION_SOURCE_CHANGED')
        return { presetId: target.presetId, sceneId: target.sceneId, expectedRevision: document.revision, count: part.count }
    })
}

/** Each next child is freshly reviewed against current destinations/settings, then uses the existing approval path. */
export async function prepareRuntimeProductionChild(id: string, expectedRevision: number): Promise<{
    request: ProductionRequest; index: number; prepared: PreparedSceneQueueReview; preview: JsonObject
}> {
    let request = await required(id)
    if (request.revision !== expectedRevision) problem('PRODUCTION_CHANGED')
    request = await reconcile(request)
    const status = await getRuntimeProductionStatus(id)
    if (status?.nextAction !== 'review-next-batch') problem('PRODUCTION_PREVIOUS_CHILD_NOT_COMPLETE')
    const index = request.children.findIndex(child => child.submission === null)
    if (index < 0) problem('PRODUCTION_ALREADY_ADMITTED')
    await flushSceneAuthorityRuntime()
    const targets = await childInput(request, index)
    const child = request.children[index]
    const identity = { reviewId: `scene-review-${globalThis.crypto.randomUUID()}`, reviewedAt: new Date().toISOString(), materializedSeeds: [...child.seeds] }
    const { planAgentSceneGeneration, publicAgentScenePreview } = await import('./agent-scene-generation-plan')
    const fileNames = child.targets.map(part => request.targets[part.targetIndex].fileNames?.slice(part.offset, part.offset + part.count) ?? null)
    const { result, submission } = await planAgentSceneGeneration({ source: { kind: 'scene', targets },
        seedPolicy: { kind: 'random' }, budget: { maxImages: childCount(child), maxAnlas: request.budget.maxAnlas - status.estimatedAnlasReserved } },
    identity, { productionId: id, index, fileNames })
    if (result.status !== 'ready') problem(result.status === 'needs_input' ? 'PRODUCTION_BUDGET_EXCEEDED' : 'PRODUCTION_PLAN_UNAVAILABLE')
    if (await plans.putIfAbsent(result.plan) === 'conflict') problem('PRODUCTION_PLAN_CONFLICT')
    request = await save(request, withProductionReview(request, index, { planId: result.plan.planId,
        planHash: result.plan.planHash, reviewId: identity.reviewId, reviewedAt: identity.reviewedAt, estimatedAnlas: result.plan.estimatedAnlas }))
    return { request, index, prepared: { submission, review: getSceneQueuePlanningFacts(submission).review },
        preview: publicAgentScenePreview(result.plan, submission) }
}

/** Human review uses the identical saved plan and opaque Scene submission; reservation failures cannot spend. */
export async function enqueueRuntimeProductionChild(id: string, index: number, submission: SceneQueueSubmission) {
    const request = await required(id)
    const review = request.children[index]?.review
    const facts = getSceneQueuePlanningFacts(submission)
    if (!review || review.reviewId !== facts.replayIdentity.reviewId) problem('PRODUCTION_REVIEW_CHANGED')
    const result = await enqueueReviewedSceneQueue(submission, undefined, {
        binding: { productionId: id, index, planId: review.planId as Sha256Digest, planHash: review.planHash as Sha256Digest },
        reserve: runId => reserveRuntimeProductionChild(id, index, review.planId, runId),
    })
    await acknowledgeRuntimeProductionChild(id, index, result.batch.id)
    return result
}

/** Metadata commands never create an execution grant. generation.enqueue remains the sole agent dispatch authority. */
export function createProductionRequestHandlers(): AgentCommandHandler[] {
    const read = async (id: string): Promise<JsonObject> => {
        const status = await getRuntimeProductionStatus(id)
        return status ? { found: true, productionId: id, ...status } as unknown as JsonObject : { found: false }
    }
    return ([
        { command: 'production.create', effect: 'plan', execute: async (input, { envelope }) => {
            const source = input.source as JsonObject
            let targets: SceneQueueTarget[]
            if (source.kind === 'preset') {
                const document = await getRuntimeSceneRepository().getDocument(String(source.presetId))
                if (!document || document.revision !== source.expectedRevision) return { code: 'PRODUCTION_SOURCE_CHANGED' }
                targets = document.scenes.map(scene => ({ presetId: document.presetId, sceneId: scene.id,
                    expectedRevision: document.revision, count: scene.productionCount ?? 1 }))
            } else targets = source.targets as unknown as SceneQueueTarget[]
            const request = await createRuntimeProductionRequest({ title: String(input.title), targets,
                budget: input.budget as unknown as { maxImages: number; maxAnlas: number }, seedPolicy: input.seedPolicy as unknown as SeedPolicy },
            `production-${hashCanonicalValue({ client: envelope.context.clientId, request: envelope.requestHash })}`)
            return read(request.id)
        } },
        { command: 'production.list', effect: 'read', execute: async () => ({ requests: (await requests.list()).map(request => ({
            productionId: request.id, title: request.title, revision: request.revision,
            totalImages: request.targets.reduce((sum, target) => sum + target.count, 0), childCount: request.children.length,
        })) }) },
        { command: 'production.get', effect: 'read', execute: input => read(String(input.productionId)) },
        { command: 'production.plan_next', effect: 'plan', execute: async input => {
            const { request, index, prepared, preview } = await prepareRuntimeProductionChild(String(input.productionId), Number(input.expectedRevision))
            const review = request.children[index].review!
            return { status: 'ready', productionId: request.id, revision: request.revision, index, planId: review.planId as Sha256Digest,
                planHash: review.planHash as Sha256Digest, jobCount: prepared.review.imageCount,
                estimatedAnlas: review.estimatedAnlas, review: preview, nextAction: 'generation.enqueue' }
        } },
    ] satisfies Omit<AgentCommandHandler, 'validate'>[]).map(handler => ({ ...handler,
        validate: getAgentCommandInputContract(handler.command)!.validate,
        execute: async (input, context) => {
            try { return await handler.execute(input, context) }
            catch (error) {
                // Only our fixed error codes leave this composition boundary, never local paths or exception text.
                const code = error instanceof Error && /^PRODUCTION_[A-Z_]+$/.test(error.message) ? error.message : 'PRODUCTION_UNAVAILABLE'
                return { code }
            }
        },
    }))
}
