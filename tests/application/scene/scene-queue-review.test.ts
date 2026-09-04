import { describe, expect, it, vi } from 'vitest'

import {
    approveSceneQueueCostEstimates,
    assertSceneQueueReviewCondition,
    canApproveSceneQueueReview,
    createSceneQueueResourcePlan,
    materializeApprovedSceneQueueResources,
    SceneQueueApprovalRegistry,
    SceneQueueReviewConflict,
    shouldAcceptSceneQueueDialogOpenChange,
    type SceneQueueReplanIssue,
} from '@/application/scene/scene-queue-review'

describe('Scene Queue review behavior', () => {
    it('blocks dismiss and approval only while submission or stale review requires it', () => {
        expect(shouldAcceptSceneQueueDialogOpenChange(true, false)).toBe(false)
        expect(shouldAcceptSceneQueueDialogOpenChange(false, false)).toBe(true)
        expect(shouldAcceptSceneQueueDialogOpenChange(true, true)).toBe(true)
        expect(canApproveSceneQueueReview({ submitting: false, busy: false, issue: null })).toBe(true)
        expect(canApproveSceneQueueReview({
            submitting: false,
            busy: false,
            issue: { code: 'SCENE_QUEUE_REPLAN_REQUIRED', action: 'replan', reason: 'scene-changed' },
        })).toBe(false)
    })

    it('keeps raw resources in memory until explicit approval materializes them', async () => {
        const write = vi.fn(async (value: string) => `stored:${value}`)
        const plan = createSceneQueueResourcePlan(['source', 'mask'])

        expect(plan.raw).toEqual(['source', 'mask'])
        expect(write).not.toHaveBeenCalled()

        await expect(materializeApprovedSceneQueueResources(plan, write)).resolves.toEqual([
            'stored:source',
            'stored:mask',
        ])
        expect(write).toHaveBeenCalledTimes(2)
    })

    it('creates one approval timestamp after the earlier review estimate', () => {
        const estimatedAt = '2026-09-04T01:00:00.000Z'
        const approvedAt = '2026-09-04T01:05:00.000Z'
        const consents = approveSceneQueueCostEstimates([
            { pricingBasis: 'paid', estimatedAnlas: 10, maxAnlas: 10, estimatedAt },
            { pricingBasis: 'paid', estimatedAnlas: 20, maxAnlas: 20, estimatedAt },
        ], approvedAt)

        expect(consents.map(consent => consent.approvedAt)).toEqual([approvedAt, approvedAt])
        expect(consents.every(consent => consent.estimatedAt !== consent.approvedAt)).toBe(true)
    })

    it.each<SceneQueueReplanIssue['reason']>([
        'scene-changed',
        'folder-changed',
        'pricing-changed',
        'runtime-limit-changed',
        'commit-set-changed',
    ])('returns a structured replan conflict for stale %s evidence', reason => {
        expect(() => assertSceneQueueReviewCondition(false, reason, 'stale')).toThrowError(SceneQueueReviewConflict)
        try {
            assertSceneQueueReviewCondition(false, reason, 'stale')
        } catch (error) {
            expect(error).toMatchObject({
                issue: { code: 'SCENE_QUEUE_REPLAN_REQUIRED', action: 'replan', reason },
            })
        }
    })

    it('shares concurrent approvals and retries only after a rejected attempt', async () => {
        const registry = new SceneQueueApprovalRegistry<object, string>()
        const submission = {}
        let resolveFirst!: (value: string) => void
        const operation = vi.fn(() => new Promise<string>(resolve => { resolveFirst = resolve }))

        const first = registry.run(submission, operation)
        const duplicate = registry.run(submission, operation)
        expect(duplicate).toBe(first)
        expect(operation).toHaveBeenCalledOnce()
        resolveFirst('batch')
        await expect(first).resolves.toBe('batch')
        await expect(registry.run(submission, operation)).resolves.toBe('batch')
        expect(operation).toHaveBeenCalledOnce()

        const retryRegistry = new SceneQueueApprovalRegistry<object, string>()
        const retry = vi.fn()
            .mockRejectedValueOnce(new Error('transient'))
            .mockResolvedValueOnce('recovered')
        await expect(retryRegistry.run(submission, retry)).rejects.toThrow('transient')
        await expect(retryRegistry.run(submission, retry)).resolves.toBe('recovered')
        expect(retry).toHaveBeenCalledTimes(2)
    })
})
