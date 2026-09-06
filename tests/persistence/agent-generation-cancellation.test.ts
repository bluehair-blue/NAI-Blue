import 'fake-indexeddb/auto'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentCancellationMarker, type AgentCancellationGrant } from '@/application/agent/agent-cancellation-contract'
import { createAgentGenerationCancellationPort } from '@/composition-root/agent-generation-cancellation'
import { DurableQueueCoordinator } from '@/services/queue/durable-queue-coordinator'
import { createGenerationCommandAdapter } from '@/services/queue/generation-command-adapter'
import { IndexedDBQueueRepository } from '@/services/queue/indexeddb-queue-repository'
import { createGenerationJobSnapshot } from '@/services/queue/job-snapshot'
import type { OutputWriter } from '@/services/output/output-writer'
import * as generationCommands from '@/application/generation/enqueue-generation-plan'

const NOW = '2026-09-06T00:00:00.000Z'
const NATIVE_SCOPE = 'dbe4f2d96161f10b48104a1522e7269abfb8a16ee223c7514912b5c8afc282d2'
let queue: IndexedDBQueueRepository
let options: ConstructorParameters<typeof IndexedDBQueueRepository>[0]
const execute = vi.fn(async () => undefined)

beforeEach(() => {
    vi.clearAllMocks()
    options = { factory: new IDBFactory(), keyRange: IDBKeyRange, databaseName: 'agent-cancellation-bridge' }
    queue = new IndexedDBQueueRepository(options)
})
afterEach(() => queue.close())

async function seed(batchId = 'run', count = 2, jobIds?: readonly string[]) {
    await queue.createBatchAndEnqueue({
        batch: { id: batchId, workflow: 'main', createdAt: NOW, failurePolicy: 'continue', origin: 'fresh',
            idempotencyKey: `batch-key:${batchId}` },
        jobs: Array.from({ length: count }, (_, ordinal) => ({
            id: jobIds?.[ordinal] ?? `${batchId}:${ordinal}`, batchId, workflow: 'main' as const, sceneId: null,
            createdAt: NOW, priority: 0, ordinal, compositionPlanHash: null, maxAttempts: 3,
            idempotencyKey: `job-key:${batchId}:${ordinal}`,
            snapshot: createGenerationJobSnapshot({ prompt: { positive: 'fixed', negative: '' },
                parameters: {}, outputPolicy: {}, resources: [], resumability: 'resumable' }),
        })),
    })
}

function port() {
    const coordinator = new DurableQueueCoordinator({ repository: queue, tokenProvider: () => [],
        executor: { execute }, now: () => NOW })
    const commands = createGenerationCommandAdapter({ repository: queue, writer: {} as OutputWriter, coordinator })
    return createAgentGenerationCancellationPort({ repository: queue, commands })
}

async function grant(runId = 'run'): Promise<AgentCancellationGrant> {
    const target = await port().inspect(runId)
    if (target === null) throw new Error('Missing test target')
    return { requestId: 'cancel-request', requestHash: `sha256:${'b'.repeat(64)}`, workspaceId: 'workspace',
        clientId: 'client', actorKind: 'agent', policyRevision: 1, consentedAt: NOW,
        expiresAt: '2026-09-06T00:05:00.000Z', authorization: 'human', target }
}

async function finishNaturally(jobId: string, completedAt = NOW) {
    const leased = await queue.acquireLease({ jobId, owner: 'worker', now: NOW, ttlMs: 10_000 })
    if (leased?.leaseToken == null) throw new Error('Missing test lease')
    await queue.transitionJob({ jobId, to: 'running', now: NOW, leaseOwner: 'worker', leaseToken: leased.leaseToken })
    await queue.completeSucceeded({ jobId, now: completedAt, leaseOwner: 'worker', leaseToken: leased.leaseToken,
        outputTransactionId: `txn:${jobId}`, artifactReference: { kind: 'output-writer', artifactId: `artifact:${jobId}`,
            digest: 'sha256:artifact' } })
}

describe('Agent cancellation through the real Queue and coordinator', () => {
    it.each([
        { shape: 'short fixture', batchId: 'run', jobIds: ['run:0', 'run:1'] },
        { shape: 'native opaque IDs', batchId: `main-batch-agent-${NATIVE_SCOPE}`, jobIds: [`main-job-agent-${NATIVE_SCOPE}-0`] },
    ])('persists exact grant markers with $shape and reconciles after reopen without execution', async ({ batchId, jobIds }) => {
        await seed(batchId, jobIds.length, jobIds)
        await seed('unrelated', 1)
        const approved = { ...await grant(batchId), actorKind: 'service' as const }
        const application = vi.spyOn(generationCommands, 'cancelGeneration')
        const original = await queue.getJob(jobIds[0])
        try {
            const result = await port().cancel(approved.target, approved)
            expect(result).toEqual({ status: 'cancel-requested', runId: batchId, batchId, jobIds })
            expect(application).toHaveBeenCalledExactlyOnceWith({ batchId,
                actor: { kind: 'service', id: 'client:client' },
                operationId: agentCancellationMarker(approved).slice('agent-cancel:'.length) }, expect.anything())
            expect(await queue.getJob(jobIds[0])).toMatchObject({ state: 'cancelled', cancelReason: agentCancellationMarker(approved),
                attemptCount: 0, snapshotHash: original?.snapshotHash, snapshot: original?.snapshot })
            expect(await port().inspect(batchId)).toEqual({ ...approved.target, previouslyStoppedJobIds: jobIds })
            expect(await queue.getJob('unrelated:0')).toMatchObject({ state: 'queued', cancelRequestedAt: null })
            queue.close()
            queue = new IndexedDBQueueRepository(options)
            expect(await port().reconcile(approved)).toEqual(result)
            expect(await port().reconcile({ ...approved, clientId: 'other-client' })).toBeNull()
            expect(execute).not.toHaveBeenCalled()
            expect(application).toHaveBeenCalledOnce()
        } finally { application.mockRestore() }
    })

    it('does not retry a partial cancellation or infer grant success from later natural completion', async () => {
        await seed()
        const approved = await grant()
        await queue.requestCancel({ jobId: 'run:0', now: NOW, reason: agentCancellationMarker(approved) as `agent-cancel:${string}` })
        queue.close()
        queue = new IndexedDBQueueRepository(options)
        expect(await port().reconcile(approved)).toBeNull()
        expect(await queue.getJob('run:1')).toMatchObject({ state: 'queued', cancelRequestedAt: null })
        await finishNaturally('run:1')
        expect(await port().reconcile(approved)).toBeNull()
        expect(execute).not.toHaveBeenCalled()
    })

    it('acknowledges a running cancellation without closing or creating a Provider attempt', async () => {
        await seed('run', 1)
        const leased = await queue.acquireLease({ jobId: 'run:0', owner: 'worker', now: NOW, ttlMs: 10_000 })
        await queue.transitionJob({ jobId: 'run:0', to: 'running', now: NOW,
            leaseOwner: 'worker', leaseToken: leased?.leaseToken ?? '' })
        const attempts = await queue.listAttempts('run:0')
        const approved = await grant()
        await port().cancel(approved.target, approved)
        expect(await queue.getJob('run:0')).toMatchObject({ state: 'running', attemptCount: 1,
            cancelReason: agentCancellationMarker(approved), cancelRequestedAt: NOW })
        expect(await queue.listAttempts('run:0')).toEqual(attempts)
        expect(await port().reconcile(approved)).toMatchObject({ status: 'cancel-requested' })
        expect(execute).not.toHaveBeenCalled()
    })

    it('accepts proven preexisting stopped jobs without overwriting their reason', async () => {
        await seed()
        await queue.requestCancel({ jobId: 'run:0', now: NOW, reason: 'user' })
        const approved = await grant()
        expect(approved.target.previouslyStoppedJobIds).toEqual(['run:0'])
        expect(await port().reconcile(approved)).toBeNull()
        await port().cancel(approved.target, approved)
        expect(await queue.getJob('run:0')).toMatchObject({ cancelReason: 'user' })
        expect(await port().reconcile(approved)).toMatchObject({ status: 'cancel-requested' })
    })

    it.each(['natural-completion', 'other-cancellation'] as const)('rejects forged preexisting stops after consent: %s', async mode => {
        await seed('run', 1)
        const approved = await grant()
        const later = '2026-09-06T00:00:01.000Z'
        if (mode === 'natural-completion') await finishNaturally('run:0', later)
        else await queue.requestCancel({ jobId: 'run:0', now: later, reason: 'user' })
        const forged = { ...approved, target: { ...approved.target, previouslyStoppedJobIds: [...approved.target.jobIds] } }
        expect(await port().reconcile(forged)).toBeNull()
        expect(execute).not.toHaveBeenCalled()
    })

    it('reconciles a terminal fact proven to predate consent and rejects noncanonical consent time', async () => {
        await seed('run', 1)
        await finishNaturally('run:0')
        const approved = { ...await grant(), consentedAt: '2026-09-06T00:00:01.000Z' }
        expect(approved.target.previouslyStoppedJobIds).toEqual(['run:0'])
        expect(await port().reconcile(approved)).toMatchObject({ status: 'cancel-requested' })
        expect(await port().reconcile({ ...approved, consentedAt: '2026-09-06' })).toBeNull()
    })

    it('acknowledges natural completion only after a successful in-process cancellation call', async () => {
        await seed('run', 1)
        const approved = await grant()
        const commands = { cancelBatch: vi.fn(async () => {
            await finishNaturally('run:0')
            return { status: 'ready' as const, targetId: 'run' }
        }) }
        const bridge = createAgentGenerationCancellationPort({ repository: queue, commands })
        expect(await bridge.cancel(approved.target, approved)).toMatchObject({ status: 'cancel-requested' })
        expect(await bridge.reconcile(approved)).toBeNull()
        expect(commands.cancelBatch).toHaveBeenCalledOnce()
    })

    it('rejects changed membership, malformed scope, and snapshot integrity failures before cancelling', async () => {
        await seed()
        const approved = await grant()
        const commands = { cancelBatch: vi.fn() }
        const bridge = createAgentGenerationCancellationPort({ repository: queue, commands })
        expect(await bridge.inspect('../run')).toBeNull()
        expect(await bridge.inspect('missing')).toBeNull()
        await expect(bridge.cancel({ ...approved.target, jobIds: ['run:0'] }, approved))
            .rejects.toMatchObject({ code: 'CANCELLATION_TARGET_CHANGED' })
        expect(await bridge.reconcile({ ...approved, target: { ...approved.target, batchId: 'other' } })).toBeNull()
        const actual = await queue.listJobs({ batchId: 'run', limit: 100 })
        const unboundedRead = vi.spyOn(queue, 'listJobs').mockResolvedValue({ ...actual, nextCursor: 'more-jobs' })
        expect(await bridge.inspect('run')).toBeNull()
        unboundedRead.mockRestore()
        const corruptRead = vi.spyOn(queue, 'listJobs').mockResolvedValue({ ...actual, items: actual.items.map((job, index) => (
            index === 0 ? { ...job, snapshot: { ...job.snapshot, prompt: { positive: 'changed', negative: '' } } } : job
        )) })
        try {
            expect(await bridge.inspect('run')).toBeNull()
            expect(await bridge.reconcile(approved)).toBeNull()
            await expect(bridge.cancel(approved.target, approved)).rejects.toMatchObject({ code: 'CANCELLATION_TARGET_CHANGED' })
        } finally { corruptRead.mockRestore() }
        expect(commands.cancelBatch).not.toHaveBeenCalled()
    })
})
