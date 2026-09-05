import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBatchImageDraft, reviseBatchImageDraft } from '@/domain/workflow/single-image-draft'
import { planGeneration } from '@/application/generation/plan-generation'
import type { AgentExecutionGrant } from '@/application/agent/agent-execution-repository'
import { createWorkflowDraftGenerationPlanDependencies } from '@/presentation/generation/workflow-draft-main-batch-planner'
import { createGenerationOutputCommitSet } from '@/services/output/generation-output-commit-set'
import type { OutputCommitSetPlanningRequest } from '@/services/queue/main-queue-runtime-dependencies'
import { IndexedDBQueueRepository } from '@/services/queue/indexeddb-queue-repository'
import { createAgentGenerationExecutionPort } from '@/composition-root/agent-generation-execution'
import * as generationCommands from '@/application/generation/enqueue-generation-plan'

const runtime = vi.hoisted(() => ({ repository: vi.fn(), folder: vi.fn(), authoritative: vi.fn(), planBatch: vi.fn() }))
vi.mock('@/services/queue/indexeddb-queue-repository', async importOriginal => ({
    ...await importOriginal<typeof import('@/services/queue/indexeddb-queue-repository')>(),
    getRuntimeQueueRepository: runtime.repository,
}))
vi.mock('@/services/queue/main-queue-runtime-dependencies', () => ({ getRuntimeMainQueueDependencies: () => ({
    presentation: { beginEnqueueOperation: () => 'agent-test', completeEnqueueOperation: vi.fn() },
    outputReservations: { getCurrentFolderBinding: runtime.folder, getAuthoritativeFolderBinding: runtime.authoritative,
        planBatch: runtime.planBatch }, r2Planning: {},
}) }))
vi.mock('@/services/queue/queue-resource-materializer', () => ({
    getRuntimeQueueResourceMaterializer: () => ({}),
    dehydrateGenerationParams: async () => ({ parameters: { generationParams: {}, resourceBindings: [], resourceArrayLengths: {} },
        resources: [], records: [] }),
}))
vi.mock('@/platform/capabilities', async importOriginal => {
    const original = await importOriginal<typeof import('@/platform/capabilities')>()
    return { ...original, runtimeCapabilities: { ...original.runtimeCapabilities,
        generationPublication: { ...original.runtimeCapabilities.generationPublication,
            generationLimits: { maxJobsPerAtomicBatch: 100, maxOutputClaimsPerAtomicBatch: 400,
                measuredAt: '2026-09-05T00:00:00.000Z', evidenceId: 'agent-bridge-test' } } } }
})

const now = '2026-09-05T00:00:00.000Z'
const folder = { resourceType: 'generation-folder-document' as const, resourceId: 'workspace', revision: 1,
    contentHash: `sha256:${'a'.repeat(64)}` as const }
let repository: IndexedDBQueueRepository
let options: ConstructorParameters<typeof IndexedDBQueueRepository>[0]

async function fixture(count = 2, maxAnlas = 100, generationFolderId: string | null = null) {
    const initial = createBatchImageDraft({ id: 'agent-draft', now, seed: 42, batchMode: 'same-settings' })
    const draft = reviseBatchImageDraft(initial, { updatedAt: now, currentNodeId: 'review', status: 'review',
        payload: { ...initial.payload, count, model: 'nai-diffusion-4-5-full',
            prompt: { positive: 'blue hair', negative: 'lowres' }, resolution: { width: 832, height: 1216 },
            output: { ...initial.payload.output, generationFolderId, directory: 'reviewed-direct-path' } } })
    const dependencies = createWorkflowDraftGenerationPlanDependencies({ drafts: { get: async () => draft },
        fragmentRepository: { findMetadataByPath: () => undefined, loadDefinitionByPath: async () => null,
            getSequenceSnapshot: () => ({ revision: 0, counters: {} }), commitSequenceProposal: () => false },
        pricingBasis: 'paid' })
    const planned = await planGeneration({ source: { kind: 'workflow-draft', draftId: draft.id, expectedRevision: draft.revision },
        count, seedPolicy: { kind: 'increment', firstSeed: 42 }, budget: { maxImages: count, maxAnlas } }, dependencies)
    if (planned.status !== 'ready' && planned.status !== 'needs_input') throw new Error(JSON.stringify(planned))
    const grant: AgentExecutionGrant = { requestId: 'request', requestHash: `sha256:${'b'.repeat(64)}`,
        workspaceId: 'workspace', clientId: 'client', actorKind: 'agent', planId: planned.plan.planId, planHash: planned.plan.planHash,
        scopeId: 'agent-scope', policyRevision: 1, consentedAt: now, authorization: 'human',
        estimatedAnlas: planned.plan.estimatedAnlas, imageCount: count }
    const replan = vi.fn(async () => dependencies)
    const port = createAgentGenerationExecutionPort({ repository, replan })
    return { plan: planned.plan, grant, port, replan, dependencies }
}

beforeEach(() => {
    vi.clearAllMocks()
    options = { factory: new IDBFactory(), keyRange: IDBKeyRange, databaseName: 'agent-execution-bridge',
        generationLimits: { maxJobsPerAtomicBatch: 100, maxOutputClaimsPerAtomicBatch: 400,
            measuredAt: now, evidenceId: 'agent-bridge-test' } }
    repository = new IndexedDBQueueRepository(options)
    runtime.repository.mockReturnValue(repository)
    runtime.folder.mockReturnValue(folder)
    runtime.authoritative.mockResolvedValue(folder)
    runtime.planBatch.mockImplementation(async (requests: readonly OutputCommitSetPlanningRequest[]) => requests.map(request => ({
        fileName: request.claimPlan.fileName, directoryIdentity: `sha256:${'c'.repeat(64)}`,
        ...createGenerationOutputCommitSet({ ...request.claimPlan, directoryAuthorityId: request.directoryAuthorityId,
            directoryAuthorityFingerprint: `sha256:${'c'.repeat(64)}` }),
    })))
})
afterEach(() => repository.close())

describe('agent execution through real Main Queue', () => {
    it('preserves the authenticated service actor and client identity at the application boundary', async () => {
        const { plan, grant, port } = await fixture(1)
        const enqueue = vi.spyOn(generationCommands, 'enqueueGeneration')
        try {
            expect(await port.enqueue(plan, { ...grant, actorKind: 'service' })).toMatchObject({ status: 'ready' })
            expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ actor: { kind: 'service', id: 'client:client' } }),
                expect.anything())
            expect(await port.reconcile(grant)).toBeNull()
        } finally { enqueue.mockRestore() }
    })
    it('atomically binds a paid two-job plan, reopens and reconciles before stale source validation', async () => {
        const { plan, grant, port, replan } = await fixture()
        expect(await port.validate(plan)).toBe(true)
        const result = await port.enqueue(plan, grant)
        expect(result).toEqual({ status: 'ready', batchId: 'main-batch-agent-scope', runId: 'main-batch-agent-scope',
            jobIds: ['main-job-agent-scope-0', 'main-job-agent-scope-1'] })
        const jobs = (await repository.listJobs({ batchId: String(result.batchId) })).items
        expect(jobs).toHaveLength(2)
        expect(jobs.map(job => job.snapshot.agentExecutionBinding?.planHash)).toEqual([plan.planHash, plan.planHash])
        const consent = jobs.map(job => (job.snapshot.parameters as unknown as { mainWorkflow: { costConsent: {
            estimatedAnlas: number; maxAnlas: number; approvedAt: string } } }).mainWorkflow.costConsent)
        expect(consent.map(item => item.estimatedAnlas)).toEqual([20, 20])
        expect(consent.reduce((sum, item) => sum + item.maxAnlas, 0)).toBe(plan.estimatedAnlas)
        expect(consent.every(item => item.approvedAt === grant.consentedAt)).toBe(true)
        // Global Folder state is reservation ownership only; the reviewed path remains exact.
        expect(runtime.planBatch.mock.calls[0][0][0].destination.directory).toBe('reviewed-direct-path')
        repository.close()
        repository = new IndexedDBQueueRepository(options)
        replan.mockRejectedValue(new Error('source is now missing'))
        const reopened = createAgentGenerationExecutionPort({ repository, replan })
        expect(await reopened.reconcile(grant)).toEqual(result)
        expect(await reopened.enqueue(plan, grant)).toEqual(result)
        expect(await reopened.reconcile({ ...grant, clientId: 'other-client' })).toBeNull()
        expect(await reopened.isOutstanding(grant)).toBe(true)
        expect((await repository.listJobs()).items).toHaveLength(2)
    })

    it('fails closed on missing jobs and releases outstanding slots only for exact terminal Queue facts', async () => {
        const { plan, grant, port } = await fixture(1)
        expect(await port.isOutstanding(grant)).toBe(true)
        await port.enqueue(plan, grant)
        await repository.requestCancel({ jobId: 'main-job-agent-scope-0', now, reason: 'user' })
        expect(await port.isOutstanding(grant)).toBe(false)
        expect(await port.isOutstanding({ ...grant, consentedAt: '2026-09-05T00:00:01.000Z' })).toBe(true)
    })

    it('rejects insufficient original budget without rewriting review limits or materializing jobs', async () => {
        const { plan, grant, port } = await fixture(2, 20)
        expect(await port.validate(plan)).toBe(false)
        expect(await port.enqueue(plan, grant)).toMatchObject({ status: 'invalid' })
        expect(runtime.planBatch).not.toHaveBeenCalled()
        expect((await repository.listJobs()).items).toHaveLength(0)
    })

    it('rejects selected-folder plans without immutable folder authority at the actual Queue boundary', async () => {
        const { plan, grant, port } = await fixture(1, 100, 'selected-folder')
        expect(await port.validate(plan)).toBe(false)
        expect(await port.enqueue(plan, grant)).toMatchObject({ status: 'invalid', issueCodes: ['unbound-reviewed-destination'] })
        expect(runtime.planBatch).not.toHaveBeenCalled()
    })
})
