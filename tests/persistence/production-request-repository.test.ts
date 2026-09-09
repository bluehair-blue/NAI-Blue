import { describe, expect, it } from 'vitest'
import { IndexedDbProductionRequestRepository } from '@/adapters/generation/indexeddb-production-request-repository'
import { createProductionRequest, withProductionReview } from '@/application/generation/production-request'

const digest = `sha256:${'a'.repeat(64)}` as const
const create = (id = 'production-1') => createProductionRequest({ id, title: 'Assets', createdAt: '2026-09-09T00:00:00.000Z',
    targets: [{ presetId: 'preset', sceneId: 'scene', sourceHash: digest, count: 101 }],
    seeds: Array.from({ length: 101 }, (_, index) => index), budget: { maxImages: 101, maxAnlas: 100 } })
const reviewed = (request: ReturnType<typeof create>) => withProductionReview(request, 0, {
    planId: digest, planHash: digest, reviewId: 'scene-review-test', reviewedAt: request.createdAt, estimatedAnlas: 10,
})
function memory() {
    let raw: string | null = null
    return { getItem: async () => raw, compareAndSet: async (_key: string, expected: string | null, next: string) => {
        if (raw !== expected) return false
        raw = next
        return true
    }, corrupt: () => { raw = raw!.replace('Assets', 'Altered') } }
}

describe('production request persistence', () => {
    it('survives repository recreation, uses CAS, and rejects corruption', async () => {
        const store = memory()
        const repository = new IndexedDbProductionRequestRepository(store)
        const initial = create()
        expect(await repository.putIfAbsent(initial)).toBe('stored')
        expect(await repository.putIfAbsent(initial)).toBe('same')
        expect(await repository.compareAndSet(initial, reviewed(initial))).toBe(true)
        expect(await repository.compareAndSet(initial, reviewed(initial))).toBe(false)
        const reopened = new IndexedDbProductionRequestRepository(store)
        expect(await reopened.get(initial.id)).toEqual(reviewed(initial))
        expect(await reopened.list()).toHaveLength(1)
        store.corrupt()
        await expect(reopened.list()).rejects.toThrow()
    })

    it('rejects altered base and initializes only unreviewed requests', async () => {
        const repository = new IndexedDbProductionRequestRepository(memory())
        const initial = create()
        await repository.putIfAbsent(initial)
        await expect(repository.putIfAbsent(reviewed(create('another')))).rejects.toThrow()
        await expect(repository.compareAndSet(initial, { ...reviewed(initial), budget: { maxImages: 101, maxAnlas: 200 } })).rejects.toThrow()
    })
})
