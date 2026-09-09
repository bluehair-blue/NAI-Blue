import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import type { GenerationJobSnapshot } from '@/domain/queue/types'
import { createGenerationJobSnapshot, hashGenerationJobSnapshot } from '@/services/queue/job-snapshot'
import { IndexedDBQueueRepository } from '@/services/queue/indexeddb-queue-repository'

const digest = `sha256:${'a'.repeat(64)}` as const
const binding = { productionId: 'production-test', index: 0, planId: digest, planHash: digest }
function snapshot(): GenerationJobSnapshot {
    return createGenerationJobSnapshot({ prompt: { positive: 'asset', negative: '' }, parameters: { seed: 42 },
        outputPolicy: { format: 'png' }, resources: [], resumability: 'resumable' })
}

describe('production Queue snapshot binding', () => {
    it('changes the snapshot digest and rejects malformed or changed plan identities', () => {
        const original = snapshot()
        const bound = { ...original, productionBinding: binding }
        expect(hashGenerationJobSnapshot(bound)).not.toBe(hashGenerationJobSnapshot(original))
        for (const invalid of [{ ...binding, index: 24 }, { ...binding, index: -1 }, { ...binding, index: 0.5 },
            { ...binding, productionId: '../bad' }, { ...binding, planHash: `sha256:${'b'.repeat(64)}` },
            { ...binding, extra: true }]) {
            expect(() => hashGenerationJobSnapshot({ ...original, productionBinding: invalid } as GenerationJobSnapshot)).toThrow()
        }
    })

    it('preserves an exact production association and hash after reopening Queue storage', async () => {
        const options = { factory: new IDBFactory() as unknown as globalThis.IDBFactory,
            keyRange: IDBKeyRange as unknown as typeof globalThis.IDBKeyRange, databaseName: 'production-binding-reopen' }
        let queue = new IndexedDBQueueRepository(options)
        const bound = { ...snapshot(), productionBinding: binding }
        const createdAt = '2026-09-09T00:00:00.000Z'
        await queue.createBatchAndEnqueue({ batch: { id: 'batch:1', workflow: 'scene', createdAt,
            failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch-key' },
        jobs: [{ id: 'job:1', batchId: 'batch:1', workflow: 'scene', sceneId: 'scene', createdAt, priority: 0,
            ordinal: 0, snapshot: bound, compositionPlanHash: digest, maxAttempts: 3, idempotencyKey: 'job-key' }] })
        queue.close()
        queue = new IndexedDBQueueRepository(options)
        const job = await queue.getJob('job:1')
        expect(job?.snapshot.productionBinding).toEqual(binding)
        expect(job?.snapshotHash).toBe(hashGenerationJobSnapshot(bound))
        queue.close()
    })
})
