import { describe, expect, it, vi } from 'vitest'

import {
    cancelGeneration,
    enqueueGeneration,
    retryGenerationStorage,
} from '@/application/generation/enqueue-generation-plan'
import { planGeneration, type PlanGenerationDependencies } from '@/application/generation/plan-generation'
import type {
    PlanGenerationInput,
    PreparedGenerationJobDraft,
} from '@/application/generation/generation-plan-contract'
import { createAnlasCostConsentSnapshot } from '@/domain/queue/anlas-cost-consent'
import { createSingleImageDraft, reviseSingleImageDraft } from '@/domain/workflow/single-image-draft'

type Prepared = { readonly privateBase64: string; readonly privateSpool: string }

const planInput: PlanGenerationInput = {
    source: { kind: 'workflow-draft', draftId: 'draft-1', expectedRevision: 1 },
    count: 2,
    seedPolicy: { kind: 'fixed', seed: 42 },
    budget: { maxImages: 2, maxAnlas: 20 },
}

function draft(prompt = 'blue hair') {
    const created = createSingleImageDraft({
        id: 'draft-1',
        now: '2026-09-03T00:00:00.000Z',
        seed: 1,
    })
    return reviseSingleImageDraft(created, {
        updatedAt: '2026-09-03T00:00:01.000Z',
        payload: {
            ...created.payload,
            prompt: { positive: prompt, negative: 'lowres' },
            output: { ...created.payload.output, collisionPolicy: 'unique' },
        },
    })
}

function dependencies(source = draft()): PlanGenerationDependencies<Prepared> {
    return {
        drafts: { get: vi.fn(async () => source) },
        planner: {
            prepare: vi.fn(async ({ draft: loaded, materializedSeeds }) => materializedSeeds.map(seed => ({
                semantic: {
                    prompt: loaded.payload.prompt.positive,
                    negativePrompt: loaded.payload.prompt.negative,
                    model: loaded.payload.model ?? 'missing',
                    width: loaded.payload.resolution?.width ?? 0,
                    height: loaded.payload.resolution?.height ?? 0,
                    steps: loaded.payload.generation.steps,
                    seed,
                    generationParameters: {},
                    resourceDigest: `sha256:${'a'.repeat(64)}`,
                },
                preparationDigest: `sha256:${'b'.repeat(64)}`,
                destination: {
                    generationFolderId: null,
                    generationFolderPathHash: null,
                    outputPolicyId: 'output:test',
                    expectedBaseName: 'image',
                    extension: 'png',
                    collisionPolicy: 'fail',
                    deliveryRequired: false,
                },
                prepared: {
                    privateBase64: 'data:image/png;base64,PRIVATE',
                    privateSpool: 'E:\\private\\spool.bin',
                },
            } satisfies PreparedGenerationJobDraft<Prepared>))),
        },
        executionPolicy: {
            failurePolicy: 'continue',
            retryPolicyId: 'safe-v1',
            maxAttempts: 2,
            maxConcurrency: 1,
            pricingBasis: 'paid',
        },
        estimateAnlas: () => 7,
        resolveCompatibility: () => ({ compatibilityProfileId: 'nai:test', status: 'captured-pass' }),
    }
}

async function reviewedPlan() {
    const result = await planGeneration(planInput, dependencies())
    if (result.status !== 'ready') throw new Error(`Expected ready plan, received ${result.status}`)
    return result.plan
}

function consent(estimatedAnlas = 14) {
    return createAnlasCostConsentSnapshot({
        pricingBasis: 'paid',
        estimatedAnlas,
        maxAnlas: 20,
        estimatedAt: '2026-09-03T00:01:00.000Z',
        approvedAt: '2026-09-03T00:01:01.000Z',
    })
}

const actor = { kind: 'user', id: 'user-1', displayName: 'Reviewer' } as const

describe('generation application commands', () => {
    it('replays before enqueue and returns only the durable ordered run handle', async () => {
        const reviewed = await reviewedPlan()
        const enqueue = vi.fn(async () => ({
            status: 'ready' as const,
            batchId: 'batch-1',
            jobs: [
                { id: 'job-1', ordinal: 0 },
                { id: 'job-2', ordinal: 1 },
            ],
            privatePayload: 'PRIVATE',
            spoolPath: 'E:\\private\\spool.bin',
        }))

        const result = await enqueueGeneration({
            reviewedPlan: reviewed,
            costConsent: consent(),
            idempotencyKey: 'request-1',
            actor,
            replanInput: {
                source: planInput.source,
                count: planInput.count,
                budget: planInput.budget,
            },
        }, { replan: dependencies(), enqueue: { enqueue } })

        expect(result).toEqual({
            status: 'ready',
            batchId: 'batch-1',
            runId: 'batch-1',
            jobIds: ['job-1', 'job-2'],
        })
        expect(JSON.stringify(result)).not.toContain('PRIVATE')
        expect(enqueue).toHaveBeenCalledOnce()
    })

    it('returns stale-plan conflict without touching the enqueue port', async () => {
        const reviewed = await reviewedPlan()
        const enqueue = vi.fn()
        const result = await enqueueGeneration({
            reviewedPlan: reviewed,
            costConsent: consent(),
            idempotencyKey: 'request-1',
            actor,
            replanInput: {
                source: planInput.source,
                count: planInput.count,
                budget: planInput.budget,
            },
        }, { replan: dependencies(draft('changed')), enqueue: { enqueue } })

        expect(result.status).toBe('conflict')
        expect(enqueue).not.toHaveBeenCalled()
    })

    it('rejects invalid identity and mismatched consent before persistence', async () => {
        const reviewed = await reviewedPlan()
        const enqueue = vi.fn()
        const invalidIdentity = await enqueueGeneration({
            reviewedPlan: reviewed,
            costConsent: consent(),
            idempotencyKey: ' ',
            actor,
            replanInput: {
                source: planInput.source,
                count: planInput.count,
                budget: planInput.budget,
            },
        }, { replan: dependencies(), enqueue: { enqueue } })
        const invalidConsent = await enqueueGeneration({
            reviewedPlan: reviewed,
            costConsent: consent(13),
            idempotencyKey: 'request-1',
            actor,
            replanInput: {
                source: planInput.source,
                count: planInput.count,
                budget: planInput.budget,
            },
        }, { replan: dependencies(), enqueue: { enqueue } })

        expect(invalidIdentity.status).toBe('invalid')
        expect(invalidConsent.status).toBe('invalid')
        expect(enqueue).not.toHaveBeenCalled()
    })

    it('carries only an exact cancellation digest while preserving legacy callers', async () => {
        const cancelBatch = vi.fn(async () => ({ status: 'ready' as const, targetId: 'batch-1' }))
        const operationId = 'a'.repeat(64)
        await expect(cancelGeneration({ batchId: 'batch-1', actor, operationId }, { cancelBatch }))
            .resolves.toEqual({ status: 'ready', targetId: 'batch-1' })
        expect(cancelBatch).toHaveBeenLastCalledWith({ batchId: 'batch-1', actor, operationId })
        await cancelGeneration({ batchId: 'batch-1', actor }, { cancelBatch })
        expect(cancelBatch).toHaveBeenLastCalledWith({ batchId: 'batch-1', actor })
        for (const invalid of ['', 'A'.repeat(64), 'a'.repeat(63), `${operationId}\n`, `sha256:${operationId}`, null, 10]) {
            await expect(cancelGeneration({ batchId: 'batch-1', actor, operationId: invalid as string }, { cancelBatch }))
                .resolves.toMatchObject({ status: 'invalid', issues: [{ code: 'invalid-cancel-operation-id' }] })
        }
        expect(cancelBatch).toHaveBeenCalledTimes(2)
    })

    it('validates actors and strips adapter details from cancel and storage retry', async () => {
        const cancelBatch = vi.fn(async () => ({ status: 'ready' as const, targetId: 'private-batch' }))
        const retryStorage = vi.fn(async () => ({ status: 'ready' as const, targetId: 'private-job' }))

        await expect(cancelGeneration({ batchId: 'batch-1', actor }, { cancelBatch }))
            .resolves.toEqual({ status: 'ready', targetId: 'batch-1' })
        await expect(retryGenerationStorage({ jobId: 'job-1', actor }, { retryStorage }))
            .resolves.toEqual({ status: 'ready', targetId: 'job-1' })
        const rejected = await cancelGeneration({
            batchId: 'batch-2',
            actor: { kind: 'user', id: ' ' },
        }, { cancelBatch })

        expect(rejected.status).toBe('invalid')
        expect(cancelBatch).toHaveBeenCalledOnce()
        expect(retryStorage).toHaveBeenCalledOnce()
    })
})
