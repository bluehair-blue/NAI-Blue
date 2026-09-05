import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IndexedDbGenerationPlanRepository, generationPlanStorageKey } from '@/adapters/generation/indexeddb-generation-plan-repository'
import { persistGenerationPlanResult } from '@/application/generation/generation-plan-repository'
import { planGeneration, type PlanGenerationDependencies } from '@/application/generation/plan-generation'
import type { PlanGenerationInput } from '@/application/generation/generation-plan-contract'
import type { JsonObject } from '@/domain/composition/types'
import { createAgentGenerationPlanHandler } from '@/application/agent/agent-generation-plan-handler'
import { createSingleImageDraft, reviseSingleImageDraft } from '@/domain/workflow/single-image-draft'
import { getIndexedDBItemStrict, resetIndexedDBConnectionForRetry, setIndexedDBItemStrict } from '@/lib/indexed-db'

function plannerFixture(maxAnlas = 100) {
    const initial = createSingleImageDraft({ id: 'draft-1', now: '2026-09-05T00:00:00.000Z', seed: 42 })
    const draft = reviseSingleImageDraft(initial, { updatedAt: '2026-09-05T00:00:01.000Z',
        payload: { ...initial.payload, prompt: { positive: 'blue hair', negative: 'lowres' } } })
    const input: PlanGenerationInput = {
        source: { kind: 'workflow-draft', draftId: draft.id, expectedRevision: draft.revision },
        count: 1, seedPolicy: { kind: 'fixed', seed: 42 }, budget: { maxImages: 1, maxAnlas },
    }
    const dependencies: PlanGenerationDependencies<{ privateAbsolutePath: string }> = {
        drafts: { get: async () => draft },
        planner: { prepare: async ({ materializedSeeds }) => materializedSeeds.map(seed => ({
            semantic: { prompt: 'blue hair', negativePrompt: 'lowres', model: 'nai-diffusion-4-5-full',
                width: 832, height: 1216, steps: 28, seed, generationParameters: {}, resourceDigest: `sha256:${'a'.repeat(64)}` },
            preparationDigest: `sha256:${'b'.repeat(64)}`,
            destination: { generationFolderId: null, generationFolderPathHash: null, outputPolicyId: 'local',
                expectedBaseName: 'image', extension: 'png', collisionPolicy: 'fail', deliveryRequired: true },
            prepared: { privateAbsolutePath: 'E:\\private\\image.png' },
        })) },
        executionPolicy: { failurePolicy: 'continue', retryPolicyId: 'safe-v1', maxAttempts: 2,
            maxConcurrency: 1, pricingBasis: 'paid' },
        estimateAnlas: () => 7,
        resolveCompatibility: () => ({ compatibilityProfileId: 'nai:test', status: 'captured-pass' }),
    }
    return { input, dependencies }
}

async function fixture(maxAnlas = 100) {
    const { input, dependencies } = plannerFixture(maxAnlas)
    const result = await planGeneration(input, dependencies)
    if (result.status !== 'ready' && result.status !== 'needs_input') throw new Error(`Fixture failed: ${JSON.stringify(result)}`)
    return result
}

beforeEach(() => { resetIndexedDBConnectionForRetry(); vi.stubGlobal('indexedDB', new IDBFactory()) })
afterEach(() => { resetIndexedDBConnectionForRetry(); vi.unstubAllGlobals() })

describe('immutable generation plan authority', () => {
    it('uses the agent handler to durably save full plans and return only public review facts', async () => {
        for (const budget of [100, 1]) {
            const { input, dependencies } = plannerFixture(budget)
            const expected = await fixture(budget)
            const handler = createAgentGenerationPlanHandler(dependencies, new IndexedDbGenerationPlanRepository())
            const publicInput = handler.validate(input as unknown as JsonObject)
            const result = await handler.execute(publicInput, {} as Parameters<typeof handler.execute>[1])
            expect(result).toMatchObject({ status: budget === 100 ? 'ready' : 'needs_input',
                planId: expected.plan.planId, planHash: expected.plan.planHash, jobCount: 1, estimatedAnlas: 7 })
            expect(JSON.stringify(result)).not.toContain('private')
            expect(JSON.stringify(result)).not.toContain('prepared')
            resetIndexedDBConnectionForRetry()
            expect(await new IndexedDbGenerationPlanRepository().get(String(result.planId))).toEqual(expected.plan)
        }
    })

    it('validates workflow-only source, exact input keys, seeds and budgets before planning', () => {
        const { input, dependencies } = plannerFixture()
        const prepare = vi.spyOn(dependencies.planner, 'prepare')
        const handler = createAgentGenerationPlanHandler(dependencies, new IndexedDbGenerationPlanRepository())
        const publicInput = input as unknown as JsonObject
        for (const value of [
            { ...publicInput, source: { kind: 'detached-generation-capture', capture: {} } },
            { ...publicInput, unexpected: true },
            { ...publicInput, source: { kind: 'workflow-draft', draftId: 'draft-1', expectedRevision: -1 } },
            { ...publicInput, count: 101 },
            ...[{ kind: 'replay', traceId: 'trace' }, { kind: 'fixed', seed: -1 }, { kind: 'increment', firstSeed: 0x1_0000_0000 },
                { kind: 'random', seed: 1 }].map(seedPolicy => ({ ...publicInput, seedPolicy })),
            ...[{ maxImages: 101, maxAnlas: 1 }, { maxImages: 1, maxAnlas: -1 }, { maxImages: 1, maxAnlas: Infinity },
                { maxImages: 1, maxAnlas: 1, extra: true }].map(budget => ({ ...publicInput, budget })),
        ]) expect(() => handler.validate(value as JsonObject)).toThrow()
        expect(prepare).not.toHaveBeenCalled()
        for (const seedPolicy of [{ kind: 'random' }, { kind: 'fixed', seed: 0 }, { kind: 'increment', firstSeed: 0xffff_ffff }]) {
            const valid = { ...publicInput, seedPolicy } as JsonObject
            expect(handler.validate(valid)).toBe(valid)
        }
    })
    it('persists actual ready and approval-pending planner results across database close/reopen', async () => {
        for (const budget of [100, 1]) {
            const result = await fixture(budget)
            expect(result.status).toBe(budget === 100 ? 'ready' : 'needs_input')
            expect(await persistGenerationPlanResult(result, new IndexedDbGenerationPlanRepository())).toBe(result)
            resetIndexedDBConnectionForRetry()
            const repository = new IndexedDbGenerationPlanRepository()
            expect(await repository.get(result.plan.planId)).toEqual(result.plan)
            expect(await repository.putIfAbsent(result.plan)).toBe('same')
        }
    })

    it('allows only one competing insert, preserving exact replay and conflicting content', async () => {
        const { plan } = await fixture()
        const first = new IndexedDbGenerationPlanRepository()
        const second = new IndexedDbGenerationPlanRepository()
        expect((await Promise.all([first.putIfAbsent(plan), second.putIfAbsent(plan)])).sort()).toEqual(['same', 'stored'])
        const other = await fixture(1)
        const changed = { ...other.plan, jobs: other.plan.jobs.map(job => ({ ...job, prepared: { privateAbsolutePath: 'different' } })) }
        expect((await Promise.all([first.putIfAbsent(other.plan), second.putIfAbsent(changed)])).sort()).toEqual(['conflict', 'stored'])
        await expect(persistGenerationPlanResult({ ...other, plan: changed }, first)).rejects.toThrow(/conflicts/)
    })

    it('isolates caller objects before writes and after reads', async () => {
        const { plan } = await fixture()
        const mutable = structuredClone(plan)
        const repository = new IndexedDbGenerationPlanRepository()
        const pending = repository.putIfAbsent(mutable)
        mutable.jobs[0].prepared.privateAbsolutePath = 'mutated during write'
        await pending
        const loaded = await repository.get(plan.planId)
        expect(loaded).toEqual(plan)
        ;(loaded!.jobs[0].prepared as { privateAbsolutePath: string }).privateAbsolutePath = 'mutated read'
        expect(await repository.get(plan.planId)).toEqual(plan)
        expect(await repository.get(`sha256:${'f'.repeat(64)}`)).toBeNull()
    })

    it('fails closed on corruption, identity mismatch, and unsupported schemas', async () => {
        const { plan } = await fixture()
        const repository = new IndexedDbGenerationPlanRepository()
        await repository.putIfAbsent(plan)
        const key = generationPlanStorageKey(plan.planId)
        const original = JSON.parse((await getIndexedDBItemStrict(key))!)
        for (const corrupt of [
            { ...original, schemaVersion: 2 },
            { ...original, contentDigest: `sha256:${'0'.repeat(64)}` },
            { ...original, plan: { ...plan, estimatedAnlas: 9 } },
            { ...original, plan: { ...plan, planId: `sha256:${'c'.repeat(64)}` } },
        ]) {
            await setIndexedDBItemStrict(key, JSON.stringify(corrupt))
            await expect(repository.get(plan.planId)).rejects.toThrow()
            await expect(repository.putIfAbsent(plan)).rejects.toThrow()
        }
    })

    it('propagates read/CAS failures and bounds contention before returning a handle', async () => {
        const result = await fixture()
        const fault = new Error('storage unavailable')
        for (const persistence of [
            { getItem: async () => { throw fault }, compareAndSet: async () => true },
            { getItem: async () => null, compareAndSet: async () => { throw fault } },
        ]) {
            await expect(persistGenerationPlanResult(result, new IndexedDbGenerationPlanRepository(persistence))).rejects.toBe(fault)
        }
        const cas = vi.fn(async () => false)
        await expect(new IndexedDbGenerationPlanRepository({ getItem: async () => null, compareAndSet: cas }).putIfAbsent(result.plan)).rejects.toThrow(/three attempts/)
        expect(cas).toHaveBeenCalledTimes(3)
    })

    it('rejects non-JSON executable preparation and oversized records without persistence writes', async () => {
        const { plan } = await fixture()
        const getItem = vi.fn(async () => null)
        const repository = new IndexedDbGenerationPlanRepository({ getItem, compareAndSet: async () => true })
        for (const prepared of [new Blob(['image']), new Uint8Array([1]), undefined, { image: 'x'.repeat(8 * 1024 * 1024) }]) {
            await expect(repository.putIfAbsent({ ...plan, jobs: plan.jobs.map(job => ({ ...job, prepared })) })).rejects.toThrow()
        }
        expect(getItem).not.toHaveBeenCalled()
    })
})
