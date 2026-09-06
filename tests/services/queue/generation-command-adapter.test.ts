import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'

import type { ActorRef } from '@/application/generation/generation-command-contract'
import type { OutputWriter } from '@/services/output/output-writer'
import { createGenerationCommandAdapter } from '@/services/queue/generation-command-adapter'
import {
    IndexedDBQueueRepository,
    type EnqueueGenerationJobInput,
} from '@/services/queue/indexeddb-queue-repository'
import { createGenerationJobSnapshot } from '@/services/queue/job-snapshot'

const NOW = '2026-09-03T00:00:00.000Z'
const ACTOR: ActorRef = { kind: 'user', id: 'local-user' }

function repository(): IndexedDBQueueRepository {
    return new IndexedDBQueueRepository({
        factory: new IDBFactory() as unknown as globalThis.IDBFactory,
        keyRange: IDBKeyRange as unknown as typeof globalThis.IDBKeyRange,
        databaseName: `generation-command-adapter-${crypto.randomUUID()}`,
    })
}

function job(): EnqueueGenerationJobInput {
    return {
        id: 'job:1', batchId: 'batch:1', workflow: 'main', sceneId: null,
        createdAt: NOW, priority: 0, ordinal: 0, compositionPlanHash: null,
        maxAttempts: 3, idempotencyKey: 'job-key:1',
        snapshot: createGenerationJobSnapshot({
            prompt: { positive: 'fixed', negative: '' },
            parameters: {}, outputPolicy: {}, resources: [], resumability: 'resumable',
        }),
    }
}

async function seededRepository(): Promise<IndexedDBQueueRepository> {
    const value = repository()
    await value.createBatchAndEnqueue({
        batch: {
            id: 'batch:1', workflow: 'main', createdAt: NOW,
            failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch-key:1',
        },
        jobs: [job()],
    })
    return value
}

describe('generation Queue command adapter', () => {
    it('checks batch existence and cancels exactly that batch', async () => {
        const queue = await seededRepository()
        const cancelBatch = vi.fn(async () => undefined)
        const adapter = createGenerationCommandAdapter({
            repository: queue,
            writer: {} as OutputWriter,
            coordinator: { cancelBatch },
            now: () => NOW,
        })

        await expect(adapter.cancelBatch({ batchId: 'batch:1', actor: ACTOR }))
            .resolves.toEqual({ status: 'ready', targetId: 'batch:1' })
        expect(cancelBatch).toHaveBeenCalledOnce()
        expect(cancelBatch).toHaveBeenCalledWith('batch:1')

        await expect(adapter.cancelBatch({ batchId: 'batch:missing', actor: ACTOR }))
            .resolves.toMatchObject({ status: 'invalid' })
        expect(cancelBatch).toHaveBeenCalledOnce()
    })

    it('passes the exact operation marker to the existing coordinator', async () => {
        const cancelBatch = vi.fn(async () => undefined)
        const adapter = createGenerationCommandAdapter({
            repository: await seededRepository(), writer: {} as OutputWriter, coordinator: { cancelBatch },
        })
        const operationId = 'b'.repeat(64)
        await expect(adapter.cancelBatch({ batchId: 'batch:1', actor: ACTOR, operationId }))
            .resolves.toEqual({ status: 'ready', targetId: 'batch:1' })
        expect(cancelBatch).toHaveBeenCalledExactlyOnceWith('batch:1', `agent-cancel:${operationId}`)
    })

    it('refuses an unbound job without invoking OutputWriter or Queue execution', async () => {
        const queue = await seededRepository()
        const retryFilesCommittedWorkflow = vi.fn()
        const cancelBatch = vi.fn()
        const adapter = createGenerationCommandAdapter({
            repository: queue,
            writer: { retryFilesCommittedWorkflow } as unknown as OutputWriter,
            coordinator: { cancelBatch },
            now: () => NOW,
        })

        await expect(adapter.retryStorage({ jobId: 'job:1', actor: ACTOR })).resolves.toMatchObject({
            status: 'unsupported',
            capability: 'files-committed-storage-retry',
        })
        expect(retryFilesCommittedWorkflow).not.toHaveBeenCalled()
        expect(cancelBatch).not.toHaveBeenCalled()
    })
})
