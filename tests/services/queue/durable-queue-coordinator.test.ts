import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'

import type { GenerationJobSnapshot, QueueArtifactReference } from '@/domain/queue/types'
import type { ProviderAttemptEvidence } from '@/domain/queue/provider-result'
import {
    DurableQueueCoordinator,
    QueueExecutionError,
    type QueueExecutorContext,
} from '@/services/queue/durable-queue-coordinator'
import { OutputWriterError } from '@/services/output/output-writer'
import {
    IndexedDBQueueRepository,
    QueueRepositoryError,
    type EnqueueGenerationJobInput,
} from '@/services/queue/indexeddb-queue-repository'
import { createGenerationJobSnapshot } from '@/services/queue/job-snapshot'
import { useDiagnosticsStore } from '@/stores/diagnostics-store'

const NOW = '2026-07-14T08:00:00.000Z'
let databaseCounter = 0

function snapshot(streaming = false, sourceEdit = false): GenerationJobSnapshot {
    return createGenerationJobSnapshot({
        prompt: { positive: 'durable executor prompt', negative: '' },
        parameters: { queueExecution: { streaming, sourceEdit } },
        outputPolicy: { format: 'png' },
        resources: [],
        resumability: 'resumable',
    })
}

function sequentialMainSnapshot(ordinal: number): GenerationJobSnapshot {
    return createGenerationJobSnapshot({
        prompt: { positive: 'sequential durable prompt', negative: '' },
        parameters: {
            queueExecution: { streaming: false, sourceEdit: false },
            mainWorkflow: {
                sequenceCommitProposal: {
                    expectedRevision: ordinal,
                    changes: [{
                        fragmentId: 'fragment:sequential',
                        fragmentPath: 'sequential',
                        expectedCounter: ordinal,
                        nextCounter: ordinal + 1,
                    }],
                },
            },
        },
        outputPolicy: { format: 'png' },
        resources: [],
        resumability: 'resumable',
    })
}

function repository(label: string): IndexedDBQueueRepository {
    databaseCounter += 1
    const factory = new IDBFactory()
    return new IndexedDBQueueRepository({
        factory: factory as unknown as globalThis.IDBFactory,
        keyRange: IDBKeyRange as unknown as typeof globalThis.IDBKeyRange,
        databaseName: `coordinator-${label}-${databaseCounter}`,
    })
}

function jobs(count: number, options: { streaming?: boolean; sourceEdit?: boolean } = {}): EnqueueGenerationJobInput[] {
    return Array.from({ length: count }, (_, index) => ({
        id: `job:${index}`,
        batchId: 'batch:1',
        workflow: 'scene' as const,
        sceneId: `scene:${index}`,
        createdAt: NOW,
        priority: 0,
        ordinal: index,
        snapshot: snapshot(options.streaming, options.sourceEdit),
        compositionPlanHash: null,
        maxAttempts: 3,
        idempotencyKey: `job-key:${index}`,
    }))
}

function sequentialMainJobs(count: number): EnqueueGenerationJobInput[] {
    return Array.from({ length: count }, (_, index) => ({
        id: `job:${index}`,
        batchId: 'batch:1',
        workflow: 'main' as const,
        sceneId: null,
        createdAt: NOW,
        priority: 0,
        ordinal: index,
        snapshot: sequentialMainSnapshot(index),
        compositionPlanHash: null,
        maxAttempts: 3,
        idempotencyKey: `job-key:${index}`,
    }))
}

function providerSnapshot(): GenerationJobSnapshot {
    return {
        ...snapshot(),
        providerExecutionEnvelope: {
            schemaVersion: 1,
            provider: 'novelai',
            compatibilityProfileId: 'profile',
            payloadBuilderRevision: 'nai-blue-payload-v1',
            modelCatalogRevision: 'nai-blue-model-catalog-v1',
            action: 'generate',
            responseMode: 'standard',
            semanticIntentHash: `sha256:${'a'.repeat(64)}`,
            queueResourceBindings: [],
        },
    }
}

function providerWorkflowJob(id = 'job:provider'): EnqueueGenerationJobInput {
    return {
        ...workflowJob({ id, batchId: 'batch:1', workflow: 'main' }),
        snapshot: providerSnapshot(),
    }
}

function workflowJob(input: {
    id: string
    batchId: string
    workflow: 'main' | 'scene'
    streaming?: boolean
    ordinal?: number
}): EnqueueGenerationJobInput {
    return {
        id: input.id,
        batchId: input.batchId,
        workflow: input.workflow,
        sceneId: input.workflow === 'scene' ? `scene:${input.id}` : null,
        createdAt: NOW,
        priority: 0,
        ordinal: input.ordinal ?? 0,
        snapshot: snapshot(input.streaming),
        compositionPlanHash: null,
        maxAttempts: 3,
        idempotencyKey: `job-key:${input.id}`,
    }
}

async function enqueue(queue: IndexedDBQueueRepository, inputs: EnqueueGenerationJobInput[]): Promise<void> {
    await queue.createBatchAndEnqueue({
        batch: {
            id: 'batch:1', workflow: inputs[0]?.workflow ?? 'scene', createdAt: NOW,
            failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch-key:1',
        },
        jobs: inputs,
    })
}

async function enqueueWorkflowBatch(
    queue: IndexedDBQueueRepository,
    batchId: string,
    workflow: 'main' | 'scene',
    inputs: EnqueueGenerationJobInput[],
): Promise<void> {
    await queue.createBatchAndEnqueue({
        batch: {
            id: batchId,
            workflow,
            createdAt: NOW,
            failurePolicy: 'continue',
            origin: 'fresh',
            idempotencyKey: `batch-key:${batchId}`,
        },
        jobs: inputs,
    })
}

function artifact(jobId: string): QueueArtifactReference {
    return {
        kind: 'output-writer',
        artifactId: `artifact:${jobId}`,
        digest: `sha256:${jobId}`,
        mimeType: 'image/png',
    }
}

async function commit(context: QueueExecutorContext, jobId: string): Promise<void> {
    const transactionId = `txn-${jobId.replace(/[^A-Za-z0-9-]/g, '-')}`
    const reference = artifact(jobId)
    await context.bindOutput(transactionId, reference)
    await context.commitOutput(transactionId, reference)
}

function coordinator(
    queue: IndexedDBQueueRepository,
    execute: (context: QueueExecutorContext, jobId: string) => Promise<void>,
    now: () => string = () => NOW,
    slots: readonly { readonly slotId: string; readonly token: string }[] = [
        { slotId: 'slot-1', token: 'runtime-token-one' },
        { slotId: 'slot-2', token: 'runtime-token-two' },
    ],
): DurableQueueCoordinator {
    return new DurableQueueCoordinator({
        repository: queue,
        tokenProvider: () => slots,
        executor: {
            execute: (job, context) => execute(context, job.id),
        },
        now,
        leaseTtlMs: 60_000,
    })
}

async function waitUntil(predicate: () => boolean): Promise<void> {
    for (let index = 0; index < 100; index += 1) {
        if (predicate()) return
        await new Promise(resolve => setTimeout(resolve, 0))
    }
    throw new Error('condition did not become true')
}

describe('durable queue coordinator', () => {
    it('uses two free token slots for overlapping Main and Scene work', async () => {
        const queue = repository('mixed-workflow-overlap')
        await enqueueWorkflowBatch(queue, 'batch:main', 'main', [workflowJob({
            id: 'job:main', batchId: 'batch:main', workflow: 'main',
        })])
        await enqueueWorkflowBatch(queue, 'batch:scene', 'scene', [workflowJob({
            id: 'job:scene', batchId: 'batch:scene', workflow: 'scene',
        })])

        let releaseBoth: () => void = () => undefined
        const bothStarted = new Promise<void>(resolve => { releaseBoth = resolve })
        const started: string[] = []
        const slotsByJob = new Map<string, string>()
        const runtime = coordinator(queue, async (context, jobId) => {
            started.push(jobId)
            slotsByJob.set(jobId, context.tokenSlotId)
            await bothStarted
            await commit(context, jobId)
        })

        const draining = runtime.drain()
        try {
            await waitUntil(() => started.length === 2)
            expect(started).toEqual(expect.arrayContaining(['job:main', 'job:scene']))
            expect(new Set(slotsByJob.values())).toEqual(new Set(['slot-1', 'slot-2']))
        } finally {
            releaseBoth()
        }
        await draining
        expect(await queue.getJob('job:main')).toMatchObject({ state: 'succeeded' })
        expect(await queue.getJob('job:scene')).toMatchObject({ state: 'succeeded' })
    })

    it('runs a preview stream beside non-streaming work on a different token', async () => {
        const queue = repository('streaming-mixed-workflow')
        await enqueueWorkflowBatch(queue, 'batch:main', 'main', [workflowJob({
            id: 'job:main', batchId: 'batch:main', workflow: 'main',
        })])
        await enqueueWorkflowBatch(queue, 'batch:scene', 'scene', [workflowJob({
            id: 'job:scene-stream', batchId: 'batch:scene', workflow: 'scene', streaming: true,
        })])

        let releaseBoth: () => void = () => undefined
        const bothStarted = new Promise<void>(resolve => { releaseBoth = resolve })
        const started: string[] = []
        const slotsByJob = new Map<string, string>()
        const runtime = coordinator(queue, async (context, jobId) => {
            started.push(jobId)
            slotsByJob.set(jobId, context.tokenSlotId)
            await bothStarted
            await commit(context, jobId)
        })

        const draining = runtime.drain()
        try {
            await waitUntil(() => started.length === 2)
            expect(started).toEqual(expect.arrayContaining(['job:main', 'job:scene-stream']))
            expect(new Set(slotsByJob.values())).toEqual(new Set(['slot-1', 'slot-2']))
        } finally {
            releaseBoth()
        }
        await draining
        expect(await queue.getJob('job:main')).toMatchObject({ state: 'succeeded' })
        expect(await queue.getJob('job:scene-stream')).toMatchObject({ state: 'succeeded' })
    })

    it('runs two normal Main jobs on distinct token slots while a third waits', async () => {
        const queue = repository('main-workflow-cap')
        await enqueueWorkflowBatch(queue, 'batch:main', 'main', [
            workflowJob({ id: 'job:main:0', batchId: 'batch:main', workflow: 'main', ordinal: 0 }),
            workflowJob({ id: 'job:main:1', batchId: 'batch:main', workflow: 'main', ordinal: 1 }),
            workflowJob({ id: 'job:main:2', batchId: 'batch:main', workflow: 'main', ordinal: 2 }),
        ])

        let active = 0
        let maximum = 0
        let releaseFirstPair: () => void = () => undefined
        const firstPair = new Promise<void>(resolve => { releaseFirstPair = resolve })
        const started: string[] = []
        const slotsByJob = new Map<string, string>()
        const runtime = coordinator(queue, async (context, jobId) => {
            started.push(jobId)
            slotsByJob.set(jobId, context.tokenSlotId)
            active += 1
            maximum = Math.max(maximum, active)
            await firstPair
            await commit(context, jobId)
            active -= 1
        })

        const draining = runtime.drain()
        await waitUntil(() => started.length === 2)
        expect(started).toEqual(['job:main:0', 'job:main:1'])
        expect(new Set(started.map(jobId => slotsByJob.get(jobId)))).toEqual(new Set(['slot-1', 'slot-2']))
        expect(runtime.activeCount).toBe(2)
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(started).toHaveLength(2)
        releaseFirstPair()
        await draining

        expect(started).toEqual(['job:main:0', 'job:main:1', 'job:main:2'])
        expect(maximum).toBe(2)
        expect((await queue.getBatchSummary('batch:main')).states.succeeded).toBe(3)
    })

    it('keeps every Main job sequential with one active token', async () => {
        const queue = repository('main-single-token')
        await enqueueWorkflowBatch(queue, 'batch:main', 'main', [
            workflowJob({ id: 'job:main:0', batchId: 'batch:main', workflow: 'main', ordinal: 0 }),
            workflowJob({ id: 'job:main:1', batchId: 'batch:main', workflow: 'main', ordinal: 1 }),
            workflowJob({ id: 'job:main:2', batchId: 'batch:main', workflow: 'main', ordinal: 2 }),
        ])

        let active = 0
        let maximum = 0
        const started: string[] = []
        const runtime = coordinator(queue, async (context, jobId) => {
            started.push(jobId)
            active += 1
            maximum = Math.max(maximum, active)
            await new Promise(resolve => setTimeout(resolve, 0))
            await commit(context, jobId)
            active -= 1
        }, () => NOW, [{ slotId: 'slot-1', token: 'runtime-token-one' }])

        await runtime.drain()
        expect(maximum).toBe(1)
        expect(started).toEqual(['job:main:0', 'job:main:1', 'job:main:2'])
    })

    it('does not multiply concurrency when two slots contain the same token', async () => {
        const queue = repository('main-duplicate-token')
        await enqueueWorkflowBatch(queue, 'batch:main', 'main', [
            workflowJob({ id: 'job:main:0', batchId: 'batch:main', workflow: 'main', ordinal: 0 }),
            workflowJob({ id: 'job:main:1', batchId: 'batch:main', workflow: 'main', ordinal: 1 }),
        ])

        let active = 0
        let maximum = 0
        const runtime = coordinator(queue, async (context, jobId) => {
            active += 1
            maximum = Math.max(maximum, active)
            await new Promise(resolve => setTimeout(resolve, 0))
            await commit(context, jobId)
            active -= 1
        }, () => NOW, [
            { slotId: 'slot-1', token: 'same-runtime-token' },
            { slotId: 'slot-2', token: 'same-runtime-token' },
        ])

        await runtime.drain()
        expect(maximum).toBe(1)
    })

    it('keeps sequence-dependent Main jobs exclusive across batches', async () => {
        const queue = repository('main-sequence-cross-batch')
        const [template] = sequentialMainJobs(1)
        await enqueueWorkflowBatch(queue, 'batch:sequence:a', 'main', [{
            ...template,
            id: 'job:sequence:a',
            batchId: 'batch:sequence:a',
            idempotencyKey: 'job-key:sequence:a',
        }])
        await enqueueWorkflowBatch(queue, 'batch:sequence:b', 'main', [{
            ...template,
            id: 'job:sequence:b',
            batchId: 'batch:sequence:b',
            idempotencyKey: 'job-key:sequence:b',
        }])

        let active = 0
        let maximum = 0
        const runtime = coordinator(queue, async (context, jobId) => {
            active += 1
            maximum = Math.max(maximum, active)
            await new Promise(resolve => setTimeout(resolve, 0))
            await commit(context, jobId)
            active -= 1
        })

        await runtime.drain()
        expect(maximum).toBe(1)
    })

    it('preserves the Scene dual-token maximum concurrency', async () => {
        const queue = repository('dual')
        await enqueue(queue, jobs(5))
        let active = 0
        let maximum = 0
        const runtime = coordinator(queue, async (context, jobId) => {
            active += 1
            maximum = Math.max(maximum, active)
            await new Promise(resolve => setTimeout(resolve, 5))
            await commit(context, jobId)
            active -= 1
        })

        await runtime.drain()
        expect(maximum).toBe(2)
        expect((await queue.getBatchSummary('batch:1')).states.succeeded).toBe(5)
    })

    it('serializes two preview streams even when two tokens are active', async () => {
        const queue = repository('streaming')
        await enqueue(queue, jobs(2, { streaming: true }))
        let active = 0
        let maximum = 0
        let releaseFirst: () => void = () => undefined
        const firstMayFinish = new Promise<void>(resolve => { releaseFirst = resolve })
        const started: string[] = []
        const runtime = coordinator(queue, async (context, jobId) => {
            started.push(jobId)
            active += 1
            maximum = Math.max(maximum, active)
            if (jobId === 'job:0') await firstMayFinish
            await commit(context, jobId)
            active -= 1
        })

        const draining = runtime.drain()
        await waitUntil(() => started.length === 1)
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(started).toEqual(['job:0'])
        releaseFirst()
        await draining
        expect(started).toEqual(['job:0', 'job:1'])
        expect(maximum).toBe(1)
    })

    it('pauses the durable batch on 401 and preserves the current job for resume', async () => {
        const queue = repository('auth')
        await enqueue(queue, jobs(2))
        const runtime = coordinator(queue, async () => {
            throw new QueueExecutionError('authentication', 'credential rejected')
        })

        await runtime.drain()
        expect(await queue.getBatch('batch:1')).toMatchObject({
            state: 'paused',
            pauseReason: 'authentication',
        })
        expect((await queue.getBatchSummary('batch:1')).states.queued).toBe(2)
    })

    it('pauses an unsupported compatibility profile before retrying the same job', async () => {
        const queue = repository('compatibility')
        await enqueue(queue, jobs(1))
        const runtime = coordinator(queue, async () => {
            throw new QueueExecutionError('compatibility', 'unsupported payload builder revision')
        })

        await runtime.drain()

        expect(await queue.getBatch('batch:1')).toMatchObject({
            state: 'paused',
            pauseReason: 'compatibility',
        })
        expect(await queue.getJob('job:0')).toMatchObject({ state: 'queued', attemptCount: 1 })
    })

    it.each([1, 3])('keeps an R2 readiness pause resumable with a %s-attempt budget before any Provider dispatch', async maxAttempts => {
        const queue = repository(`r2-readiness-${maxAttempts}`)
        await enqueue(queue, [{ ...providerWorkflowJob(), maxAttempts }])
        let ready = false
        const providerCall = vi.fn()
        const execute = vi.fn(async (context: QueueExecutorContext, jobId: string) => {
            expect(context.executionMode).toBe('provider')
            expect(context.providerAttempt.providerEvidence).toMatchObject({ dispatchState: 'prepared', billingRisk: 'none' })
            expect(context.providerAttempt.diagnosticEventId).toBeNull()
            expect(context.providerAttempt.failureKind ?? null).toBeNull()
            if (!ready) throw new QueueExecutionError('r2-readiness', 'Required R2 credential is locked')
            providerCall()
            const prepared = context.providerAttempt.providerEvidence!
            const dispatched: ProviderAttemptEvidence = { ...prepared, dispatchState: 'possibly-dispatched', billingRisk: 'possible' }
            const started: ProviderAttemptEvidence = { ...dispatched, dispatchState: 'response-started' }
            const complete: ProviderAttemptEvidence = { ...started, dispatchState: 'response-complete',
                providerOutcome: 'succeeded', billingRisk: 'confirmed', responseDigest: `sha256:${'c'.repeat(64)}` }
            await context.recordProviderTransition(dispatched)
            await context.recordProviderTransition(started)
            await context.recordProviderTransition(complete)
            await context.recordProviderTransition({ ...complete, dispatchState: 'result-spooled', spoolReceipt: {
                schemaVersion: 1, spoolId: `ready-${maxAttempts}`, attemptId: context.providerAttempt.id,
                contentType: 'image/png', byteLength: 3, sha256: complete.responseDigest!, committedAt: NOW,
            } })
            await commit(context, jobId)
        })
        const runtime = coordinator(queue, execute)
        await runtime.drain()
        expect(providerCall).not.toHaveBeenCalled()
        expect(await queue.getBatch('batch:1')).toMatchObject({ state: 'paused', pauseReason: 'r2-readiness' })
        expect(await queue.getJob('job:provider')).toMatchObject({ state: 'queued', attemptCount: 1, leaseOwner: null })
        const pausedAttempts = await queue.listAttempts('job:provider')
        expect(pausedAttempts).toHaveLength(1)
        expect(pausedAttempts[0]).toMatchObject({ attemptNumber: 1,
            providerEvidence: { dispatchState: 'prepared', providerOutcome: 'running', billingRisk: 'none', spoolReceipt: null },
            providerTransitions: [],
        })
        await runtime.drain()
        expect(execute).toHaveBeenCalledOnce()
        for (let retry = 0; retry < 4; retry += 1) {
            await runtime.resumeBatch('batch:1')
            await runtime.drain()
            expect(await queue.getJob('job:provider')).toMatchObject({ state: 'queued', attemptCount: 1 })
            expect(await queue.listAttempts('job:provider')).toHaveLength(1)
        }
        expect(providerCall).not.toHaveBeenCalled()
        ready = true
        await runtime.resumeBatch('batch:1')
        await runtime.drain()
        expect(providerCall).toHaveBeenCalledOnce()
        expect(await queue.getJob('job:provider')).toMatchObject({ state: 'succeeded', attemptCount: 1, lastDiagnosticEventId: null })
        const completedAttempts = await queue.listAttempts('job:provider')
        expect(completedAttempts).toHaveLength(1)
        expect(completedAttempts[0]?.id).toBe(pausedAttempts[0]?.id)
        expect(completedAttempts.filter(attempt => attempt.providerEvidence?.billingRisk === 'confirmed')).toHaveLength(1)
    })

    it('does not generic-retry after Provider evidence becomes uncertain', async () => {
        const queue = repository('provider-unknown-generic-guard')
        await enqueue(queue, [providerWorkflowJob()])
        const genericRetry = vi.spyOn(queue, 'requeueAfterFailure')
        const runtime = coordinator(queue, async context => {
            const prepared = context.providerAttempt.providerEvidence
            if (prepared === null) throw new Error('provider evidence fixture missing')
            const possiblyDispatched: ProviderAttemptEvidence = {
                ...prepared, dispatchState: 'possibly-dispatched', billingRisk: 'possible',
            }
            await context.recordProviderTransition(possiblyDispatched)
            await context.recordProviderTransition(
                { ...possiblyDispatched, providerOutcome: 'unknown' },
                { blockReason: 'provider-outcome-unknown' },
            )
            throw new QueueExecutionError('transient', 'late transport failure')
        })

        await runtime.drain()
        expect(genericRetry).not.toHaveBeenCalled()
        expect(await queue.getJob('job:provider')).toMatchObject({
            state: 'blocked', blockReason: 'provider-outcome-unknown', leaseOwner: null,
        })
    })

    it('does not generic-retry when the Provider-safe spool requeue write fails', async () => {
        const queue = repository('provider-spool-requeue-write-failure')
        await enqueue(queue, [providerWorkflowJob()])
        const genericRetry = vi.spyOn(queue, 'requeueAfterFailure')
        const spoolRequeue = vi.spyOn(queue, 'requeueSpooledResult').mockRejectedValue(
            new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'spool requeue readback failed'),
        )
        let expectedEvidence: ProviderAttemptEvidence | null = null
        const runtime = coordinator(queue, async context => {
            const prepared = context.providerAttempt.providerEvidence
            if (prepared === null) throw new Error('provider evidence fixture missing')
            const possiblyDispatched: ProviderAttemptEvidence = {
                ...prepared, dispatchState: 'possibly-dispatched', billingRisk: 'possible',
            }
            const responseStarted: ProviderAttemptEvidence = {
                ...possiblyDispatched, dispatchState: 'response-started',
            }
            const responseComplete: ProviderAttemptEvidence = {
                ...responseStarted, dispatchState: 'response-complete',
                providerOutcome: 'succeeded', billingRisk: 'confirmed',
                responseDigest: `sha256:${'b'.repeat(64)}`,
            }
            const receipt = {
                schemaVersion: 1 as const, spoolId: 'provider-requeue-failure', attemptId: context.providerAttempt.id,
                contentType: 'image/png', byteLength: 3, sha256: responseComplete.responseDigest!,
                committedAt: NOW,
            }
            const resultSpooled: ProviderAttemptEvidence = {
                ...responseComplete, dispatchState: 'result-spooled', spoolReceipt: receipt,
            }
            expectedEvidence = resultSpooled
            await context.recordProviderTransition(possiblyDispatched)
            await context.recordProviderTransition(responseStarted)
            await context.recordProviderTransition(responseComplete)
            await context.recordProviderTransition(resultSpooled)
            await context.requeueSpooledResult({ pauseReason: 'local-io' })
        })

        await runtime.drain()
        expect(spoolRequeue).toHaveBeenCalledTimes(1)
        expect(genericRetry).not.toHaveBeenCalled()
        expect(await queue.getBatch('batch:1')).toMatchObject({
            state: 'paused', pauseReason: 'local-io',
        })
        expect(await queue.getJob('job:provider')).toMatchObject({ state: 'running' })
        expect(await queue.listAttempts('job:provider')).toEqual([
            expect.objectContaining({ outcome: 'running', providerEvidence: expectedEvidence }),
        ])
    })

    it('requeues an unhandled downstream failure from the existing spool without a new attempt', async () => {
        const queue = repository('provider-spool-downstream-fallback')
        await enqueue(queue, [providerWorkflowJob()])
        const genericRetry = vi.spyOn(queue, 'requeueAfterFailure')
        const runtime = coordinator(queue, async context => {
            const prepared = context.providerAttempt.providerEvidence
            if (prepared === null) throw new Error('provider evidence fixture missing')
            const possiblyDispatched: ProviderAttemptEvidence = {
                ...prepared, dispatchState: 'possibly-dispatched', billingRisk: 'possible',
            }
            const responseStarted: ProviderAttemptEvidence = {
                ...possiblyDispatched, dispatchState: 'response-started',
            }
            const responseComplete: ProviderAttemptEvidence = {
                ...responseStarted, dispatchState: 'response-complete',
                providerOutcome: 'succeeded', billingRisk: 'confirmed',
                responseDigest: `sha256:${'b'.repeat(64)}`,
            }
            const resultSpooled: ProviderAttemptEvidence = {
                ...responseComplete,
                dispatchState: 'result-spooled',
                spoolReceipt: {
                    schemaVersion: 1, spoolId: 'provider-downstream', attemptId: context.providerAttempt.id,
                    contentType: 'image/png', byteLength: 3, sha256: responseComplete.responseDigest!,
                    committedAt: NOW,
                },
            }
            await context.recordProviderTransition(possiblyDispatched)
            await context.recordProviderTransition(responseStarted)
            await context.recordProviderTransition(responseComplete)
            await context.recordProviderTransition(resultSpooled)
            throw new Error('output binding storage unavailable')
        })

        await runtime.drain()
        expect(genericRetry).not.toHaveBeenCalled()
        expect(await queue.getBatch('batch:1')).toMatchObject({ state: 'paused', pauseReason: 'fatal' })
        expect(await queue.getJob('job:provider')).toMatchObject({ state: 'queued', attemptCount: 1 })
        expect(await queue.listAttempts('job:provider')).toEqual([
            expect.objectContaining({ outcome: 'running', attemptNumber: 1 }),
        ])
    })

    it('leases a verified spool while R2 readiness is unavailable without Provider credentials or a new attempt', async () => {
        const queue = repository('credential-free-spool-resume')
        await enqueue(queue, [providerWorkflowJob()])
        const prepare = coordinator(queue, async context => {
            const prepared = context.providerAttempt.providerEvidence
            if (prepared === null) throw new Error('provider evidence fixture missing')
            const possiblyDispatched: ProviderAttemptEvidence = {
                ...prepared, dispatchState: 'possibly-dispatched', billingRisk: 'possible',
            }
            const responseStarted: ProviderAttemptEvidence = {
                ...possiblyDispatched, dispatchState: 'response-started',
            }
            const responseComplete: ProviderAttemptEvidence = {
                ...responseStarted, dispatchState: 'response-complete', providerOutcome: 'succeeded',
                billingRisk: 'confirmed', responseDigest: `sha256:${'c'.repeat(64)}`,
            }
            await context.recordProviderTransition(possiblyDispatched)
            await context.recordProviderTransition(responseStarted)
            await context.recordProviderTransition(responseComplete)
            await context.recordProviderTransition({
                ...responseComplete,
                dispatchState: 'result-spooled',
                spoolReceipt: {
                    schemaVersion: 1,
                    spoolId: 'credential-free-spool',
                    attemptId: context.providerAttempt.id,
                    contentType: 'image/png',
                    byteLength: 3,
                    sha256: responseComplete.responseDigest!,
                    committedAt: NOW,
                },
            })
            await context.requeueSpooledResult({ pauseReason: 'local-io' })
        })
        await prepare.drain()
        await queue.setBatchControl({ batchId: 'batch:1', state: 'active', now: NOW })

        const r2DispatchReadiness = vi.fn(async () => { throw new QueueExecutionError('r2-readiness', 'R2 credential unavailable') })
        const execute = vi.fn(async (context: QueueExecutorContext, jobId: string) => {
            expect(context.executionMode).toBe('storage-only')
            expect(context.token).toBe('')
            expect(context.providerAttempt.attemptNumber).toBe(1)
            if (context.executionMode === 'provider') await r2DispatchReadiness()
            await commit(context, jobId)
        })
        const resume = coordinator(queue, execute, () => NOW, [])
        await resume.drain()

        expect(execute).toHaveBeenCalledOnce()
        expect(r2DispatchReadiness).not.toHaveBeenCalled()
        expect(await queue.getJob('job:provider')).toMatchObject({ state: 'succeeded', attemptCount: 1 })
        expect(await queue.listAttempts('job:provider')).toEqual([
            expect.objectContaining({ attemptNumber: 1, outcome: 'succeeded' }),
        ])
    })

    it('persists 429 backoff and does not turn it into a global pause', async () => {
        const queue = repository('rate-limit')
        await enqueue(queue, jobs(1))
        const runtime = coordinator(queue, async () => {
            throw new QueueExecutionError('rate-limited', 'provider asked to retry', { retryAfterMs: 5_000 })
        })

        await runtime.drain()
        expect(await queue.getBatch('batch:1')).toMatchObject({ state: 'active' })
        expect(await queue.getJob('job:0')).toMatchObject({
            state: 'queued',
            readyAt: '2026-07-14T08:00:05.000Z',
            attemptCount: 1,
        })
    })

    it('keeps a sequential Main tail queued while its predecessor retry is not ready', async () => {
        const queue = repository('main-sequence-retry')
        await enqueue(queue, sequentialMainJobs(2))
        const providerCalls: string[] = []
        const runtime = coordinator(queue, async (context, jobId) => {
            providerCalls.push(jobId)
            if (jobId === 'job:0') {
                throw new QueueExecutionError('rate-limited', 'retry the sequence head later', { retryAfterMs: 5_000 })
            }
            await commit(context, jobId)
        })

        await runtime.drain()
        expect(providerCalls).toEqual(['job:0'])
        expect(await queue.getJob('job:0')).toMatchObject({
            state: 'queued',
            readyAt: '2026-07-14T08:00:05.000Z',
            attemptCount: 1,
        })
        expect(await queue.getJob('job:1')).toMatchObject({ state: 'queued', attemptCount: 0 })
    })

    it('skips a sequential Main tail without provider calls after a terminal predecessor failure', async () => {
        const queue = repository('main-sequence-failure')
        await enqueue(queue, sequentialMainJobs(3))
        const providerCalls: string[] = []
        const runtime = coordinator(queue, async (context, jobId) => {
            providerCalls.push(jobId)
            if (jobId === 'job:0') throw new QueueExecutionError('decode', 'sequence head failed')
            await commit(context, jobId)
        })

        await runtime.drain()
        expect(providerCalls).toEqual(['job:0'])
        expect(await queue.getJob('job:0')).toMatchObject({ state: 'failed', attemptCount: 1 })
        expect(await queue.getJob('job:1')).toMatchObject({ state: 'skipped', attemptCount: 0 })
        expect(await queue.getJob('job:2')).toMatchObject({ state: 'skipped', attemptCount: 0 })
    })

    it('continues after one decode error and commits the next item', async () => {
        const queue = repository('decode')
        await enqueue(queue, jobs(2))
        const runtime = coordinator(queue, async (context, jobId) => {
            if (jobId === 'job:0') throw new QueueExecutionError('decode', 'invalid image archive')
            await commit(context, jobId)
        })

        await runtime.drain()
        expect(await queue.getJob('job:0')).toMatchObject({
            state: 'failed',
            lastDiagnosticEventId: expect.any(String),
        })
        expect(await queue.getJob('job:1')).toMatchObject({ state: 'succeeded' })
        expect(await queue.getBatch('batch:1')).toMatchObject({ state: 'active' })
    })

    it('blocks a missing managed resource and continues with the next item', async () => {
        const queue = repository('missing-resource')
        await enqueue(queue, jobs(2))
        const runtime = coordinator(queue, async (context, jobId) => {
            if (jobId === 'job:0') {
                throw Object.assign(new Error('managed resource unavailable'), {
                    code: 'E_QUEUE_RESOURCE_MISSING',
                })
            }
            await commit(context, jobId)
        })

        await runtime.drain()
        expect(await queue.getJob('job:0')).toMatchObject({
            state: 'blocked',
            blockReason: 'missing-resource',
            lastDiagnosticEventId: expect.any(String),
        })
        expect(await queue.getJob('job:1')).toMatchObject({ state: 'succeeded' })
    })

    it('pauses on disk-full and reuses the OutputWriter diagnostic without notifying twice', async () => {
        const queue = repository('disk-full')
        await enqueue(queue, jobs(1))
        const diagnosticEventId = 'diagnostic:output-writer-disk-full'
        const diagnosticCount = useDiagnosticsStore.getState().events.length
        const runtime = coordinator(queue, async () => {
            const cause = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
            const error = new OutputWriterError('atomic-commit', 'Output commit failed', { cause })
            error.diagnosticEventId = diagnosticEventId
            throw error
        })

        await runtime.drain()
        expect(await queue.getBatch('batch:1')).toMatchObject({ state: 'paused', pauseReason: 'local-io' })
        expect(await queue.getJob('job:0')).toMatchObject({
            state: 'queued',
            lastDiagnosticEventId: diagnosticEventId,
        })
        expect(useDiagnosticsStore.getState().events).toHaveLength(diagnosticCount)
    })

    it('aborts an active item and rejects a late output commit after cancel', async () => {
        const queue = repository('late-cancel')
        await enqueue(queue, jobs(1))
        let context: QueueExecutorContext | null = null
        let release: (() => void) | null = null
        const runtime = coordinator(queue, async (activeContext, jobId) => {
            context = activeContext
            await new Promise<void>(resolve => { release = resolve })
            expect(activeContext.canCommit()).toBe(false)
            await expect(commit(activeContext, jobId)).rejects.toMatchObject({ code: 'E_QUEUE_CANCEL_REQUESTED' })
        })

        const draining = runtime.drain()
        await waitUntil(() => context !== null)
        await runtime.cancelJob('job:0')
        expect(context?.signal.aborted).toBe(true)
        release?.()
        await draining
        expect(await queue.getJob('job:0')).toMatchObject({
            state: 'cancelled',
            artifactReference: null,
        })
    })
})
