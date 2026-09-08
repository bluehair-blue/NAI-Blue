import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { createAssessmentRequirement } from '@/domain/assessment/visual-rubric'

import type { GenerationFolderDocument, GenerationFolderV2 } from '@/domain/generation-folders'
import { createR2ProfileV2, hashR2ProfileV2 } from '@/domain/r2/types'
import { createGenerationOutputCommitSet } from '@/services/output/generation-output-commit-set'
import type { OutputCommitSetPlanningRequest } from '@/services/queue/main-queue-runtime-dependencies'

const runtime = vi.hoisted(() => ({
    folder: vi.fn(), scene: vi.fn(), profile: vi.fn(), readiness: vi.fn(), allocation: vi.fn(), enqueue: vi.fn(),
    build: vi.fn(), dehydrate: vi.fn(),
}))
vi.mock('@/adapters/folder/indexeddb-generation-folder-repository', () => ({
    IndexedDbGenerationFolderRepository: class { getDocument = runtime.folder },
}))
vi.mock('@/lib/scene-migration-startup', () => ({ getRuntimeSceneRepository: () => ({ getDocument: runtime.scene }) }))
vi.mock('@/stores/auth-store', () => ({ selectActiveCredentialsAreOpus: () => true, useAuthStore: { getState: () => ({}) } }))
vi.mock('@/stores/character-store', () => ({ useCharacterStore: { getState: () => ({ releaseImageData: () => undefined }) } }))
vi.mock('@/stores/character-rotation-store', () => ({ useRotationStore: { getState: () => ({ active: false }) } }))
vi.mock('@/stores/queue-store', () => ({ useQueueStore: { getState: () => ({
    beginEnqueueOperation: () => 'operation', completeEnqueueOperation: () => undefined,
}) } }))
vi.mock('@/stores/settings-store', () => ({ useSettingsStore: { getState: () => ({
    generationFolders: [], sceneSavePath: 'output', useAbsoluteScenePath: false,
    sceneSubfoldersEnabled: false, metadataMode: 'embedded', useStreaming: false,
}) } }))
vi.mock('@/stores/scene-store', () => ({
    getScenePresetPathSegments: () => ['Preset'],
    resolveSceneGeneration: () => ({ seed: 7, seedLocked: true }),
    useSceneStore: { getState: () => ({ presets: [{ id: 'preset', name: 'Preset', scenes: [], createdAt: 0 }],
        recordSceneCompositionResult: () => undefined, consumeSceneGenerationSeed: () => undefined,
        consumeSceneQueueEntries: () => undefined,
    }) },
}))
vi.mock('@/lib/scene-generation/build-scene-params', () => ({ buildSceneGenerationParams: runtime.build }))
vi.mock('@/lib/scene-output-path', () => ({ getRotationCharacterFolderName: () => null }))
vi.mock('@/lib/workspace-mutation-gate', () => ({ runtimeWorkspaceMutationGate: {
    runExclusive: async (_key: string, work: () => Promise<unknown>) => work(),
} }))
vi.mock('@/platform/capabilities', () => ({ runtimeCapabilities: {
    generationPublication: { supported: true, outputReservationGuarantee: 'atomic-no-replace', generationLimits: {
        maxJobsPerAtomicBatch: 100, maxOutputClaimsPerAtomicBatch: 400,
    } },
} }))
vi.mock('@/services/queue/main-queue-runtime-dependencies', () => ({ getRuntimeMainQueueDependencies: () => ({
    r2Planning: { getProfile: runtime.profile, getReadiness: runtime.readiness },
    outputReservations: { planBatch: runtime.allocation },
}) }))
vi.mock('@/services/queue/indexeddb-queue-repository', () => ({
    assertGenerationAtomicBatchAvailable: () => undefined,
    getRuntimeQueueRepository: () => ({ createBatchAndEnqueue: runtime.enqueue }),
}))
vi.mock('@/services/queue/queue-resource-materializer', () => ({
    getRuntimeQueueResourceMaterializer: () => ({}), dehydrateGenerationParams: runtime.dehydrate,
}))

import { enqueueReviewedSceneQueue, prepareSceneQueueReview, type SceneQueueTarget } from '@/services/queue/scene-queue-adapter'
import { decodeSceneJobSnapshot } from '@/services/queue/scene-job-snapshot-codec'
import { planAgentSceneGeneration, validateAgentSceneGenerationPlan, enqueueAgentSceneGenerationPlan,
    type AgentSceneGenerationInput } from '@/composition-root/agent-scene-generation-plan'
import { IndexedDbGenerationPlanRepository } from '@/adapters/generation/indexeddb-generation-plan-repository'
import type { AgentExecutionGrant } from '@/application/agent/agent-execution-repository'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { createAgentMcpServer } from '@/adapters/agent/mcp/mcp-stdio-server'
import { AgentCommandDispatcher } from '@/application/agent/agent-command-dispatcher'
import { agentRequestHash, type AgentCommandEnvelope } from '@/application/agent/agent-command-contract'
import { createAgentExecutionCoordinator } from '@/application/agent/agent-execution-coordinator'
import { DEFAULT_AGENT_EXECUTION_POLICY } from '@/application/agent/agent-execution-policy'
import { IndexedDbCommandReceiptRepository } from '@/adapters/agent/indexeddb-command-receipt-repository'
import { IndexedDbAgentExecutionRepository } from '@/adapters/agent/indexeddb-agent-execution-repository'
import { createAgentSceneGenerationPlanHandler } from '@/composition-root/agent-scene-generation-plan'
import type { JsonObject } from '@/domain/composition/types'

const selected = createR2ProfileV2({
    id: 'profile-1', name: 'Profile', accountId: 'account', jurisdiction: null, endpoint: null,
    bucket: 'profile-bucket', prefix: 'base', credentialRef: 'credential-fixture', transport: 'native-s3',
    conflictPolicy: 'fail', publicMode: 'r2-dev', publicBaseUrl: null,
}, '2026-09-05T00:00:00.000Z')
const parent: GenerationFolderV2 = {
    id: 'parent', displayName: 'Parent', pathSegment: 'parent', parentId: null, rootDirectory: 'output',
    useAbsolutePath: false, commonPrompt: '', autoUpload: true,
    r2ProfilePolicy: { mode: 'set', value: selected.id },
    r2BucketPolicy: { mode: 'set', value: 'ancestor-bucket' },
    r2PrefixPolicy: { mode: 'set', value: 'ancestor' },
}
const child: GenerationFolderV2 = {
    ...parent, id: 'child', displayName: 'Child', pathSegment: 'child', parentId: 'parent', rootDirectory: null,
    r2ProfilePolicy: { mode: 'inherit' }, r2BucketPolicy: { mode: 'inherit' }, r2PrefixPolicy: { mode: 'inherit' },
}
function folder(patch: Partial<GenerationFolderV2> = {}): GenerationFolderDocument {
    return { schemaVersion: 2, workspaceId: 'local', revision: 3, folders: [parent, { ...child, ...patch }] }
}
const target: SceneQueueTarget = { presetId: 'preset', sceneId: 'scene', count: 1, fileNames: ['scene.png'] }
const params = {
    model: 'nai-diffusion-4-5-full', width: 832, height: 1216, steps: 28, seed: 7,
    prompt: 'A room', negative_prompt: '', cfg_scale: 5, cfg_rescale: 0, sampler: 'k_euler', scheduler: 'karras',
    smea: false, smea_dyn: false, variety: false, imageFormat: 'png', metadataMode: 'embedded',
}

beforeEach(() => {
    vi.clearAllMocks()
    runtime.folder.mockResolvedValue(folder())
    runtime.scene.mockResolvedValue({ schemaVersion: 1, presetId: 'preset', revision: 2, updatedAt: '2026-09-05T00:00:00.000Z',
        scenes: [{ id: 'scene', name: 'Scene', scenePrompt: 'A room', generationFolderId: 'child',
            generation: { seed: 7, seedLocked: true }, artifactRefs: [], createdAt: 1 }],
    })
    runtime.profile.mockResolvedValue(selected)
    runtime.readiness.mockResolvedValue({ status: 'ready', credentialRef: selected.credentialRef })
    runtime.build.mockResolvedValue({ success: true, params, finalPrompt: 'A room', mimeType: 'image/png',
        sequenceCommitProposal: null, planHash: null, mode: 'legacy', warnings: [], errors: [],
    })
    runtime.dehydrate.mockImplementation(async value => ({ parameters: {
        generationParams: value, resourceBindings: [], resourceArrayLengths: {},
    }, records: [], resources: [] }))
    runtime.enqueue.mockResolvedValue({ batch: {}, jobs: [] })
    runtime.allocation.mockImplementation(async (requests: readonly OutputCommitSetPlanningRequest[]) => requests.map(request => ({
        fileName: request.claimPlan.fileName, directoryIdentity: `sha256:${'b'.repeat(64)}`,
        imageDisplayPath: `output/${request.claimPlan.fileName}`,
        ...createGenerationOutputCommitSet({ ...request.claimPlan, directoryAuthorityId: request.directoryAuthorityId,
            directoryAuthorityFingerprint: `sha256:${'b'.repeat(64)}` }),
    })))
})

const agentInput: AgentSceneGenerationInput = {
    source: { kind: 'scene', targets: [{ presetId: 'preset', sceneId: 'scene', expectedRevision: 2, count: 1 }] },
    seedPolicy: { kind: 'fixed', seed: 7 }, budget: { maxImages: 1, maxAnlas: 100 },
}

async function agentFixture(input = agentInput) {
    const { result } = await planAgentSceneGeneration(input)
    if (result.status !== 'ready' && result.status !== 'needs_input') throw new Error(JSON.stringify(result))
    const grant: AgentExecutionGrant = {
        requestId: 'request', requestHash: `sha256:${'b'.repeat(64)}`, workspaceId: 'workspace',
        clientId: 'client', actorKind: 'service', planId: result.plan.planId, planHash: result.plan.planHash,
        scopeId: 'agent-scene-scope', policyRevision: 1, consentedAt: new Date().toISOString(),
        authorization: 'human', estimatedAnlas: result.plan.estimatedAnlas, imageCount: result.plan.jobs.length,
    }
    return { plan: result.plan, grant }
}

describe('agent Scene plans use the existing durable Scene Queue', () => {
    it('advertises and executes the SDK Scene tool chain through dispatcher, approval policy and the actual Queue once', async () => {
        const { IndexedDBQueueRepository } = await vi.importActual<typeof import('@/services/queue/indexeddb-queue-repository')>('@/services/queue/indexeddb-queue-repository')
        const { createAgentGenerationExecutionPort } = await import('@/composition-root/agent-generation-execution')
        const storage = new Map<string, string>()
        const persistence = { getItem: async (key: string) => storage.get(key) ?? null,
            compareAndSet: async (key: string, expected: string | null, next: string) => {
                if ((storage.get(key) ?? null) !== expected) return false
                storage.set(key, next); return true
            } }
        const plans = new IndexedDbGenerationPlanRepository(persistence)
        const receipts = new IndexedDbCommandReceiptRepository(persistence)
        const ledger = new IndexedDbAgentExecutionRepository(persistence)
        const startedAt = new Date().toISOString()
        const expiresAt = new Date(Date.parse(startedAt) + 3_600_000).toISOString()
        const queue = new IndexedDBQueueRepository({ factory: new IDBFactory(), keyRange: IDBKeyRange,
            databaseName: 'mcp-scene-chain', generationLimits: { maxJobsPerAtomicBatch: 100, maxOutputClaimsPerAtomicBatch: 400,
                measuredAt: startedAt, evidenceId: 'mcp-scene-test' } })
        runtime.enqueue.mockImplementation(input => queue.createBatchAndEnqueue(input))
        const policy = { ...structuredClone(DEFAULT_AGENT_EXECUTION_POLICY), mode: 'bounded-auto' as const,
            boundedAutoExpiresAt: expiresAt,
            generation: { ...DEFAULT_AGENT_EXECUTION_POLICY.generation,
                allowedCompatibilityStatuses: ['captured-pass', 'live-canary-pass', 'synthetic-only'] as const },
            r2: { ...DEFAULT_AGENT_EXECUTION_POLICY.r2, allowUpload: true, allowedProfileIds: [selected.id] } }
        const coordinator = createAgentExecutionCoordinator({ workspaceId: 'workspace', repository: ledger, receipts, plans,
            getPolicy: () => policy, isClientAuthorized: async () => true,
            ports: createAgentGenerationExecutionPort({ repository: queue }) })
        const dispatcher = new AgentCommandDispatcher({ workspaceId: 'workspace', receipts,
            handlers: [createAgentSceneGenerationPlanHandler(plans), coordinator.handler],
            authentication: { authenticate: async envelope => ({ clientId: envelope.context.clientId,
                actor: { kind: envelope.context.actor.kind, id: `client:${envelope.context.clientId}` } }) },
            runtime: () => ({ ready: true, mode: policy.mode, globalPause: false }) })
        // SDK transport and business pipeline are real. Only native signing/inbox delivery and
        // metadata/resource adapters are simulated; no Queue runner or Provider is started.
        const server = createAgentMcpServer({
            invoke: async (command, requestId) => {
                const unsigned: AgentCommandEnvelope = { schemaVersion: 1, requestId, requestHash: `sha256:${'a'.repeat(64)}`,
                    submittedAt: startedAt, expiresAt, command,
                    context: { apiVersion: 'nai-blue.agent/v1alpha1', workspaceId: 'workspace', clientId: 'client',
                        actor: { kind: 'agent' }, idempotencyKey: requestId },
                    authentication: { scheme: 'hmac-sha256', keyId: 'test-key', signature: `hmac-sha256:${'0'.repeat(64)}` } }
                const receipt = await dispatcher.dispatch({ ...unsigned, requestHash: agentRequestHash(unsigned) })
                return { status: 'application-receipt', requestId, requiresAppProcess: true, receipt } as unknown as JsonObject
            },
            inspect: async requestId => ({ status: 'application-receipt', requestId, requiresAppProcess: true,
                receipt: await receipts.get(requestId) }) as unknown as JsonObject,
        })
        const client = new Client({ name: 'scene-end-to-end-test', version: '1.0.0' })
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        try {
            await server.connect(serverTransport)
            await client.connect(clientTransport)
            const tools = await client.listTools()
            expect(tools.tools.map(tool => tool.name)).toContain('generation.plan')
            expect(tools.tools.map(tool => tool.name)).toContain('generation.enqueue')
            expect(JSON.stringify(tools.tools.find(tool => tool.name === 'generation.plan')!.inputSchema)).toContain('targets')
            const planned = await client.callTool({ name: 'generation.plan', arguments: {
                requestId: 'scene-plan-request', input: agentInput as unknown as JsonObject,
            } })
            expect(planned.isError).toBe(false)
            const planReceipt = (planned.structuredContent as JsonObject).receipt as JsonObject
            expect(planReceipt, JSON.stringify(planReceipt)).toMatchObject({ state: 'completed', result: { status: 'ready' } })
            const planResult = planReceipt.result as JsonObject
            expect(planResult.status).toBe('ready')
            expect(planResult.review).toMatchObject({ sources: [{ presetId: 'preset', sceneId: 'scene', name: 'Scene', count: 1 }],
                jobs: [{ prompt: 'A room', model: params.model, seed: 7, destination: { generationFolderId: 'child' } }] })
            expect(JSON.stringify(planResult)).not.toContain('output/')
            const request = { name: 'generation.enqueue', arguments: { requestId: 'scene-enqueue-request',
                input: { planId: planResult.planId, planHash: planResult.planHash } } }
            const first = await client.callTool(request)
            expect(first.isError).toBe(false)
            expect(first.structuredContent).toMatchObject({ receipt: { state: 'completed', result: { status: 'ready' } } })
            const repeated = await client.callTool(request)
            expect(repeated.structuredContent).toEqual(first.structuredContent)
            const jobs = (await queue.listJobs()).items
            expect(jobs).toHaveLength(1)
            expect(jobs[0]).toMatchObject({ workflow: 'scene', sceneId: 'scene',
                snapshot: { agentExecutionBinding: { planHash: planResult.planHash } } })
            expect(jobs[0].batchId).toMatch(/^scene-batch-/)
            expect(runtime.enqueue).toHaveBeenCalledTimes(1)
            expect((await ledger.get('workspace'))?.records[0]).toMatchObject({ state: 'completed',
                grant: { authorization: 'bounded-auto', imageCount: 1 } })
        } finally { await client.close(); await server.close(); queue.close() }
    })

    it('persists replay facts, reconstructs without the old submission, then reopens and reconciles one exact grant', async () => {
        const { IndexedDBQueueRepository } = await vi.importActual<typeof import('@/services/queue/indexeddb-queue-repository')>('@/services/queue/indexeddb-queue-repository')
        const { createAgentGenerationExecutionPort } = await import('@/composition-root/agent-generation-execution')
        const storage = new Map<string, string>()
        const persistence = { getItem: async (key: string) => storage.get(key) ?? null,
            compareAndSet: async (key: string, expected: string | null, next: string) => {
                if ((storage.get(key) ?? null) !== expected) return false
                storage.set(key, next); return true
            } }
        const { plan, grant } = await agentFixture()
        await new IndexedDbGenerationPlanRepository(persistence).putIfAbsent(plan)
        const reopenedPlan = await new IndexedDbGenerationPlanRepository(persistence).get(plan.planId)
        expect(reopenedPlan).toEqual(plan)
        expect([...storage.values()].join('')).not.toContain('resourcePlan')
        expect([...storage.values()].join('')).not.toContain('generationParams')
        const options = { factory: new IDBFactory(), keyRange: IDBKeyRange, databaseName: 'agent-scene-restart',
            generationLimits: { maxJobsPerAtomicBatch: 100, maxOutputClaimsPerAtomicBatch: 400,
                measuredAt: '2026-09-05T00:00:00.000Z', evidenceId: 'agent-scene-test' } }
        let queue = new IndexedDBQueueRepository(options)
        runtime.enqueue.mockImplementation(input => queue.createBatchAndEnqueue(input))
        try {
            const execution = createAgentGenerationExecutionPort({ repository: queue })
            expect(await execution.validate(reopenedPlan!)).toBe(true)
            const committed = await execution.enqueue(reopenedPlan!, grant)
            expect(committed).toEqual({ status: 'ready', batchId: 'scene-batch-agent-scene-scope',
                runId: 'scene-batch-agent-scene-scope', jobIds: ['scene-job-agent-scene-scope-0'] })
            const jobs = (await queue.listJobs()).items
            expect(jobs).toHaveLength(1)
            expect(jobs[0]).toMatchObject({ workflow: 'scene', sceneId: 'scene',
                snapshot: { agentExecutionBinding: { planId: plan.planId, planHash: plan.planHash, scopeId: grant.scopeId } } })
            const snapshot = decodeSceneJobSnapshot(jobs[0].snapshot)
            expect(snapshot.sceneWorkflow.costConsent?.approvedAt).toBe(grant.consentedAt)
            expect(snapshot.sceneWorkflow.batch?.request.actor).toEqual({ kind: 'service', id: 'client:client' })
            expect(snapshot.sceneWorkflow.saveContext.activePresetId).toBe('preset')
            expect(snapshot.sceneWorkflow.sceneBinding?.resourceId).toBe('preset:scene')
            queue.close()
            queue = new IndexedDBQueueRepository(options)
            runtime.scene.mockResolvedValue(null)
            const afterRestart = createAgentGenerationExecutionPort({ repository: queue })
            expect(await afterRestart.validate(reopenedPlan!)).toBe(false)
            expect(await afterRestart.reconcile(grant)).toEqual(committed)
            expect(await afterRestart.enqueue(reopenedPlan!, grant)).toEqual(committed)
            expect(await afterRestart.reconcile({ ...grant, clientId: 'different-client' })).toBeNull()
            expect(runtime.enqueue).toHaveBeenCalledTimes(1)
            expect((await queue.listJobs()).items).toHaveLength(1)
        } finally { queue.close() }
    })

    it.each(['scene', 'folder', 'r2', 'destination'] as const)('rejects %s drift on replay before Queue writes', async kind => {
        const { plan, grant } = await agentFixture()
        if (kind === 'scene') {
            const document = await runtime.scene()
            runtime.scene.mockResolvedValue({ ...document, revision: document.revision + 1 })
        } else if (kind === 'folder') {
            runtime.folder.mockResolvedValue({ ...folder(), revision: 4 })
        } else if (kind === 'r2') {
            runtime.profile.mockResolvedValue({ ...selected, bucket: 'changed-bucket', updatedAt: '2026-09-06T00:00:00.000Z' })
        } else {
            const allocate = runtime.allocation.getMockImplementation()!
            runtime.allocation.mockImplementation(async requests => (await allocate(requests)).map((allocation: object) => ({
                ...allocation, imageDisplayPath: 'changed/location.png',
            })))
        }
        expect(await validateAgentSceneGenerationPlan(plan)).toBe(false)
        expect(await enqueueAgentSceneGenerationPlan(plan, grant)).toMatchObject({ status: 'conflict' })
        expect(runtime.enqueue).not.toHaveBeenCalled()
        expect(runtime.dehydrate).not.toHaveBeenCalled()
    })

    it('retains insufficient reviewed budget instead of minting a larger grant', async () => {
        const { plan, grant } = await agentFixture({ ...agentInput, budget: { maxImages: 0, maxAnlas: 0 } })
        expect(plan.requiredApprovals.length).toBeGreaterThan(0)
        expect(await validateAgentSceneGenerationPlan(plan)).toBe(false)
        expect(await enqueueAgentSceneGenerationPlan(plan, grant)).toMatchObject({ status: 'invalid' })
        expect(runtime.enqueue).not.toHaveBeenCalled()
    })

    it.each(['random', 'fixed', 'increment'] as const)('materializes and replays the %s seed policy', async kind => {
        runtime.build.mockImplementation(async (_scene, options) => ({ success: true,
            params: { ...params, seed: options.seed }, finalPrompt: 'A room', mimeType: 'image/png',
            sequenceCommitProposal: null, planHash: null, mode: 'legacy', warnings: [], errors: [],
        }))
        const { plan } = await agentFixture({ source: { kind: 'scene', targets: [{ ...agentInput.source.targets[0], count: 2 }] },
            seedPolicy: kind === 'fixed' ? { kind, seed: 10 } : kind === 'increment' ? { kind, firstSeed: 0xffff_ffff } : { kind },
            budget: { maxImages: 2, maxAnlas: 100 } })
        const seeds = plan.materializedSeedTrace.seeds
        expect(seeds).toHaveLength(2)
        if (kind === 'fixed') expect(seeds).toEqual([10, 10])
        if (kind === 'increment') expect(seeds).toEqual([0xffff_ffff, 0])
        expect(await validateAgentSceneGenerationPlan(structuredClone(plan))).toBe(true)
        expect(runtime.enqueue).not.toHaveBeenCalled()
    })
})

describe('Scene Queue R2 reviewed planning', () => {
    it('restores one human assessment binding across selected preset outputs after Queue reopen', async () => {
        const { IndexedDBQueueRepository } = await vi.importActual<typeof import('@/services/queue/indexeddb-queue-repository')>('@/services/queue/indexeddb-queue-repository')
        const options = {
            factory: new IDBFactory(), keyRange: IDBKeyRange, databaseName: 'scene-reviewed-human-assessment',
            generationLimits: { maxJobsPerAtomicBatch: 100, maxOutputClaimsPerAtomicBatch: 400,
                measuredAt: '2026-09-05T00:00:00.000Z', evidenceId: 'test-scene-assessment' },
        }
        const queue = new IndexedDBQueueRepository(options)
        const document = await runtime.scene()
        runtime.scene.mockImplementation(async (presetId: string) => ({ ...document, presetId }))
        const assessment = createAssessmentRequirement({ rubricId: 'scene-rubric', version: 2,
            hardConstraints: [{ criterionId: 'layout', label: 'Requested layout' }], softCriteria: [], acceptanceThreshold: 80 }, 2)
        runtime.enqueue.mockImplementationOnce(input => queue.createBatchAndEnqueue(input))
        try {
            const prepared = await prepareSceneQueueReview([
                { ...target, r2Requirement: { mode: 'disabled' } },
                { ...target, presetId: 'second-preset', fileNames: ['second-scene.png'], r2Requirement: { mode: 'disabled' } },
            ], { assessment })
            expect(prepared).not.toBeNull()
            expect(prepared!.review.assessment).toEqual(assessment)
            await enqueueReviewedSceneQueue(prepared!.submission)
            const before = await queue.listJobs()
            expect(before.items).toHaveLength(2)
            const expected = before.items[0].snapshot.intentAssessment
            expect(expected).toMatchObject({ runId: before.items[0].batchId, requirement: assessment })
            expect(expected?.planHash).toMatch(/^sha256:[a-f0-9]{64}$/u)
            expect(before.items[1].snapshot.intentAssessment).toEqual(expected)
            expect(new Set(before.items.map(item => decodeSceneJobSnapshot(item.snapshot).sceneWorkflow.batch?.planHash)).size).toBe(2)
            queue.close()
            const reopened = new IndexedDBQueueRepository(options)
            try {
                const restored = await reopened.listJobs({ batchId: expected!.runId })
                expect(restored.items).toHaveLength(2)
                expect(restored.items.every(item => JSON.stringify(item.snapshot.intentAssessment) === JSON.stringify(expected))).toBe(true)
                expect((await reopened.getJob(before.items[1].id))?.snapshot.intentAssessment).toEqual(expected)
            } finally { reopened.close() }
        } finally { queue.close() }
    })

    it('rejects Scene acceptance counts above selected outputs before any Queue enqueue', async () => {
        const assessment = createAssessmentRequirement({ rubricId: 'scene-rubric', version: 1,
            hardConstraints: [{ criterionId: 'layout', label: 'Requested layout' }], softCriteria: [], acceptanceThreshold: 80 }, 2)
        await expect(prepareSceneQueueReview([target], { assessment })).rejects.toThrow()
        expect(runtime.enqueue).not.toHaveBeenCalled()
        expect(runtime.build).not.toHaveBeenCalled()
    })

    it.each([
        { patch: {}, bucket: 'ancestor-bucket', prefix: 'ancestor/child', bucketSource: 'ancestor', prefixSource: 'ancestor', sourceId: 'parent' },
        { patch: { r2BucketPolicy: { mode: 'set', value: 'child-bucket' }, r2PrefixPolicy: { mode: 'set', value: 'chosen' } }, bucket: 'child-bucket', prefix: 'chosen', bucketSource: 'folder', prefixSource: 'folder', sourceId: 'child' },
        { patch: { r2PrefixPolicy: { mode: 'clear' } }, bucket: 'ancestor-bucket', prefix: '', bucketSource: 'ancestor', prefixSource: 'cleared', sourceId: 'child' },
    ] as const)('keeps $prefixSource destination from review through Queue snapshot', async expected => {
        runtime.folder.mockResolvedValue(folder(expected.patch))
        const unchanged = structuredClone(selected)
        const prepared = await prepareSceneQueueReview([{ ...target, r2Requirement: { mode: 'required', profileId: selected.id } }])
        expect(runtime.enqueue).not.toHaveBeenCalled()
        const destination = prepared!.review.r2Destinations[0]!
        expect(destination).toMatchObject({ requirement: 'required', bucket: expected.bucket,
            key: [expected.prefix, 'scene.png'].filter(Boolean).join('/'), provenance: {
                bucket: expected.bucketSource, prefix: expected.prefixSource,
                folder: { id: 'child', profileId: 'parent', prefix: expected.sourceId },
            },
        })
        expect(JSON.stringify(prepared!.review)).not.toContain('credential')
        expect(prepared!.review.outputs).toEqual([expect.objectContaining({
            fileName: 'scene.png', localPath: 'output/scene.png',
            r2Bucket: destination.bucket, r2Key: destination.key, publicUrl: null,
        })])
        await enqueueReviewedSceneQueue(prepared!.submission)
        const queued = runtime.enqueue.mock.calls[0][0].jobs[0]
        const workflow = decodeSceneJobSnapshot(queued.snapshot).sceneWorkflow
        expect(workflow.r2Delivery).toMatchObject({ requirement: 'required', planned: {
            destination, profile: { ...selected, bucket: expected.bucket, prefix: expected.prefix },
            sourceProfileHash: hashR2ProfileV2(selected),
        } })
        expect(workflow.batch!.planHash).toBe(queued.compositionPlanHash)
        expect(selected).toEqual(unchanged)
    })

    it('blocks required readiness before Queue writes and rechecks after review', async () => {
        const requested = [{ ...target, r2Requirement: { mode: 'required' as const, profileId: selected.id } }]
        runtime.readiness.mockResolvedValue({ status: 'not-ready', reason: 'credential' })
        await expect(prepareSceneQueueReview(requested)).rejects.toThrow('required R2 profile and credential are not ready')
        expect(runtime.enqueue).not.toHaveBeenCalled()
        runtime.readiness.mockResolvedValue({ status: 'ready', credentialRef: selected.credentialRef })
        const prepared = await prepareSceneQueueReview(requested)
        runtime.readiness.mockResolvedValue({ status: 'not-ready', reason: 'credential' })
        await expect(enqueueReviewedSceneQueue(prepared!.submission)).rejects.toThrow()
        expect(runtime.enqueue).not.toHaveBeenCalled()
    })

    it('rejects bucket clear and respects profile clear or explicit disabled', async () => {
        runtime.folder.mockResolvedValue(folder({ r2BucketPolicy: { mode: 'clear' } }))
        await expect(prepareSceneQueueReview([target])).rejects.toThrow('bucket is cleared or invalid')
        expect(runtime.enqueue).not.toHaveBeenCalled()
        for (const explicit of [false, true]) {
            runtime.folder.mockResolvedValue(folder(explicit ? {} : { r2ProfilePolicy: { mode: 'clear' } }))
            const prepared = await prepareSceneQueueReview([{ ...target, ...(explicit ? { r2Requirement: { mode: 'disabled' as const } } : {}) }])
            expect(prepared!.review.r2Destinations).toEqual([])
            await enqueueReviewedSceneQueue(prepared!.submission)
            const queued = runtime.enqueue.mock.lastCall![0].jobs[0]
            expect(decodeSceneJobSnapshot(queued.snapshot).sceneWorkflow.r2Delivery).toEqual({ requirement: 'disabled', planned: null })
        }
    })

    it('binds a changed requirement into batch and composition hashes with all other planning inputs fixed', async () => {
        vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000000')
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-09-05T00:00:00.000Z'))
        try {
            const hashes: string[] = []
            for (const mode of ['best-effort', 'required'] as const) {
                const prepared = await prepareSceneQueueReview([{ ...target, r2Requirement: { mode, profileId: selected.id } }])
                await enqueueReviewedSceneQueue(prepared!.submission)
                const queued = runtime.enqueue.mock.lastCall![0].jobs[0]
                const workflow = decodeSceneJobSnapshot(queued.snapshot).sceneWorkflow
                expect(workflow.r2Delivery.requirement).toBe(mode)
                expect(workflow.batch!.planHash).toBe(queued.compositionPlanHash)
                hashes.push(queued.compositionPlanHash)
            }
            expect(hashes[0]).not.toBe(hashes[1])
        } finally { vi.useRealTimers() }
    })
})
