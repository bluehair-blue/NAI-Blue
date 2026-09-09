import { describe, expect, it } from 'vitest'
import { acknowledgeProductionChild, assertProductionTransition, createProductionRequest, parseProductionRequest,
    productionReservedAnlas, reserveProductionChild, withProductionReview } from '@/application/generation/production-request'

const digest = `sha256:${'a'.repeat(64)}` as const
const review = { planId: digest, planHash: digest, reviewId: 'scene-review-test', reviewedAt: '2026-09-09T00:00:00.000Z', estimatedAnlas: 10 }
const create = (count = 101) => createProductionRequest({ id: 'production-1', title: 'Selected assets',
    createdAt: review.reviewedAt, targets: [{ presetId: 'preset', sceneId: 'scene', sourceHash: digest, count }],
    seeds: Array.from({ length: count }, (_, index) => index), budget: { maxImages: count, maxAnlas: 15 } })

describe('production request', () => {
    it('preserves fractional money budgets and rejects aggregate exposure beyond the exact limit', () => {
        const base = create()
        const request = createProductionRequest({ ...base, seeds: base.materializedSeeds,
            budget: { ...base.budget, maxAnlas: 10.5 } })
        const first = reserveProductionChild(withProductionReview(request, 0, { ...review, estimatedAnlas: 5.25 }),
            0, { runId: 'fractional-1', estimatedAnlas: 5.25 })
        const queued = acknowledgeProductionChild(first, 0, 'fractional-1')
        const second = withProductionReview(queued, 1, { ...review, estimatedAnlas: 5.25 })
        expect(productionReservedAnlas(reserveProductionChild(second, 1, { runId: 'fractional-2', estimatedAnlas: 5.25 }))).toBe(10.5)
        const over = withProductionReview(queued, 1, { ...review, estimatedAnlas: 5.5 })
        expect(() => reserveProductionChild(over, 1, { runId: 'fractional-2', estimatedAnlas: 5.5 })).toThrow()
        expect(() => withProductionReview(request, 0, { ...review, estimatedAnlas: Infinity })).toThrow()
    })
    it('preserves ordered targets, seed trace and offsets across the measured child limit', () => {
        const input = create()
        expect(input.children.map(child => child.seeds.length)).toEqual([100, 1])
        expect(input.children[1].targets).toEqual([{ targetIndex: 0, count: 1, offset: 100 }])
        expect(input.children[1].seeds).toEqual([100])
        expect(create(2400).children).toHaveLength(24)
        expect(() => create(2401)).toThrow()
        expect(() => parseProductionRequest({ ...input, children: input.children.map(child => ({ ...child, seeds: [1] })) })).toThrow()
        const mixed = createProductionRequest({ id: 'mixed', title: 'Mixed selection', createdAt: review.reviewedAt,
            targets: [{ presetId: 'preset', sceneId: 'first', count: 99, sourceHash: digest },
                { presetId: 'preset', sceneId: 'second', count: 2, sourceHash: digest, fileNames: ['one.png', 'two.png'] }],
            seeds: input.materializedSeeds, budget: input.budget })
        expect(mixed.children[0].targets).toEqual([{ targetIndex: 0, count: 99, offset: 0 }, { targetIndex: 1, count: 1, offset: 0 }])
        expect(mixed.children[1].targets).toEqual([{ targetIndex: 1, count: 1, offset: 1 }])
        expect(mixed.targets[1].fileNames?.[mixed.children[1].targets[0].offset]).toBe('two.png')
    })

    it('retains uncertain reservation, prevents later child review, and charges total across queued children', () => {
        const first = withProductionReview(create(), 0, review)
        const reserved = reserveProductionChild(first, 0, { runId: 'run-1', estimatedAnlas: 10 })
        expect(productionReservedAnlas(reserved)).toBe(10)
        expect(reserveProductionChild(reserved, 0, { runId: 'run-1', estimatedAnlas: 10 })).toBe(reserved)
        expect(() => reserveProductionChild(reserved, 0, { runId: 'run-2', estimatedAnlas: 10 })).toThrow()
        expect(() => withProductionReview(reserved, 1, review)).toThrow()
        const queued = acknowledgeProductionChild(reserved, 0, 'run-1')
        const second = withProductionReview(queued, 1, review)
        expect(() => reserveProductionChild(second, 1, { runId: 'run-2', estimatedAnlas: 10 })).toThrow()
        expect(() => reserveProductionChild(first, 0, { runId: 'run-1', estimatedAnlas: 0 })).toThrow()
    })

    it('allows explicit unsubmitted review replacement but binds consent after reservation', () => {
        const first = withProductionReview(create(), 0, review)
        const replacement = { ...review, reviewId: 'scene-review-replanned', estimatedAnlas: 8 }
        const revised = withProductionReview(first, 0, replacement)
        expect(() => assertProductionTransition(first, revised)).not.toThrow()
        const reserved = reserveProductionChild(revised, 0, { runId: 'run-1', estimatedAnlas: 8 })
        expect(() => withProductionReview(reserved, 0, review)).toThrow()
        expect(() => assertProductionTransition(revised, { ...reserved, title: 'changed' })).toThrow()
        expect(() => acknowledgeProductionChild(reserved, 0, 'wrong-run')).toThrow()
    })
})
