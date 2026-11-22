import { describe, expect, it, vi } from 'vitest'
import type { JsonObject } from '@/domain/composition/types'
import { OutputDestinationOccupiedError } from '@/services/output/generation-output-commit-set'
import { assertAgentPublicValue } from '@/application/agent/agent-command-contract'
import { NovelAiModelCapabilityError, validateNovelAiGenerationParams } from '@/services/nai/adapter'
const prepare = vi.hoisted(() => vi.fn())
vi.mock('@/services/queue/scene-queue-adapter', async () => ({
    SceneQueueReviewConflict: (await import('@/application/scene/scene-queue-review')).SceneQueueReviewConflict,
    prepareSceneQueueReview: prepare, getSceneQueuePlanningFacts: vi.fn(), enqueueReviewedSceneQueue: vi.fn(),
}))
vi.mock('@/services/diagnostics/error-registry', () => ({ reportDiagnostic: () => ({ eventId: 'e15729b5-ce3e-4462-801c-125d6d1b6c18' }) }))
// The Scene store is read for archive state only; its persistence stays in memory here.
vi.mock('@/lib/indexed-db', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/indexed-db')>(),
    indexedDBStorage: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }))
import { createAgentSceneGenerationPlanHandler } from '@/composition-root/agent-scene-generation-plan'
import { useSceneStore } from '@/stores/scene-store'

describe('public Scene planning failures', () => {
    it('rejects a target in an archived preset with an issue that names the restore step, before any Scene preparation', async () => {
        const previous = useSceneStore.getState().presets
        useSceneStore.setState({ presets: [{ id: 'kept', name: 'Kept', scenes: [], createdAt: 1 },
            { id: 'draft', name: 'Draft', scenes: [], createdAt: 2, archivedAt: 3 }] })
        try {
            const save = vi.fn(), handler = createAgentSceneGenerationPlanHandler({ save, get: vi.fn() } as never)
            const result = await handler.execute({ source: { kind: 'scene', targets: [
                { presetId: 'kept', sceneId: 'scene', expectedRevision: 1, count: 1 },
                { presetId: 'draft', sceneId: 'scene', expectedRevision: 1, count: 1 },
            ] }, seedPolicy: { kind: 'random' }, budget: { maxImages: 2, maxAnlas: 30 } }, {} as never)
            expect(result).toEqual({ status: 'invalid', issueCodes: ['scene-preset-archived'],
                issues: [{ code: 'scene-preset-archived', fieldPath: 'source.targets[1].presetId' }], nextAction: 'restore-preset' })
            expect(handler.receiptState?.(result)).toBe('rejected')
            expect(() => assertAgentPublicValue(result)).not.toThrow()
            expect(prepare).not.toHaveBeenCalled()
            expect(save).not.toHaveBeenCalled()
        } finally { useSceneStore.setState({ presets: previous }) }
    })
    it('uses the executor settings guard and rejects invalid mode before saving a ready plan', async () => {
        let failure: NovelAiModelCapabilityError | undefined
        try { validateNovelAiGenerationParams({ model: 'nai-diffusion-5-full', promptTextMode: 'verbatim',
            ucPreset: 4, qualityToggle: false } as never) } catch (error) {
            const issue = error as NovelAiModelCapabilityError
            failure = new NovelAiModelCapabilityError(issue.message, `source.targets[0].${issue.fieldPath}`, issue.nextAction)
        }
        expect(failure?.fieldPath).toBe('source.targets[0].promptTextMode')
        prepare.mockRejectedValueOnce(failure)
        const save = vi.fn(), handler = createAgentSceneGenerationPlanHandler({ save, get: vi.fn() } as never)
        const result = await handler.execute({ source: { kind: 'scene', targets: [
            { presetId: 'preset', sceneId: 'scene', expectedRevision: 1, count: 1 },
        ] }, seedPolicy: { kind: 'fixed', seed: 1 }, budget: { maxImages: 1, maxAnlas: 30 } }, {} as never)
        expect(result).toMatchObject({ status: 'invalid', issues: [{ fieldPath: 'source.targets[0].promptTextMode' }] })
        expect(String(result.nextAction)).toContain('V5=standard')
        expect(() => assertAgentPublicValue(result)).not.toThrow()
        expect(save).not.toHaveBeenCalled()
    })
    it('rejects a V5 Scene with Precise References through the same model capability issue', async () => {
        let failure: NovelAiModelCapabilityError | undefined
        try { validateNovelAiGenerationParams({ model: 'nai-diffusion-5-full', steps: 28, sampler: 'k_euler_ancestral', cfg_rescale: 0,
            ucPreset: 0, negative_prompt: '', charImages: ['data:image/webp;base64,AA=='] } as never) } catch (error) {
            const issue = error as NovelAiModelCapabilityError
            failure = new NovelAiModelCapabilityError(issue.message, `source.targets[0].${issue.fieldPath}`, issue.nextAction)
        }
        expect(failure?.message).toContain('Precise Reference')
        prepare.mockRejectedValueOnce(failure)
        const save = vi.fn(), handler = createAgentSceneGenerationPlanHandler({ save, get: vi.fn() } as never)
        const result = await handler.execute({ source: { kind: 'scene', targets: [
            { presetId: 'preset', sceneId: 'scene', expectedRevision: 1, count: 1 },
        ] }, seedPolicy: { kind: 'random' }, budget: { maxImages: 1, maxAnlas: 30 } }, {} as never)
        expect(result).toMatchObject({ status: 'invalid', issueCodes: ['invalid-model-settings'],
            issues: [{ code: 'invalid-model-settings', fieldPath: 'source.targets[0].model' }] })
        expect(save).not.toHaveBeenCalled()
    })
    it('reports an occupied exact output as a filename conflict without misreporting source revision or private paths', async () => {
        prepare.mockRejectedValueOnce(new OutputDestinationOccupiedError('private-output.png'))
        const save = vi.fn()
        const handler = createAgentSceneGenerationPlanHandler({ save, get: vi.fn() } as never)
        const input: JsonObject = { source: { kind: 'scene', targets: [{ presetId: 'preset', sceneId: 'scene', expectedRevision: 3, count: 1 }] },
            seedPolicy: { kind: 'fixed', seed: 1 }, budget: { maxImages: 1, maxAnlas: 17 } }
        const result = await handler.execute(input, {} as never)
        expect(result).toEqual({ status: 'conflict', issueCodes: ['output-destination-occupied'],
            nextAction: 'revise-scene-filename-template' })
        expect(() => assertAgentPublicValue(result)).not.toThrow()
        expect(JSON.stringify(result)).not.toContain('private-output')
        expect(handler.receiptState!(result)).toBe('rejected')
        expect(save).not.toHaveBeenCalled()
        prepare.mockRejectedValueOnce(new Error('C:/private/settings could not be read'))
        const unexpected = await handler.execute(input, {} as never)
        expect(unexpected).toMatchObject({ status: 'invalid', diagnostic: { resourceId: 'e15729b5-ce3e-4462-801c-125d6d1b6c18' } })
        expect(() => assertAgentPublicValue(unexpected)).not.toThrow()
        expect(JSON.stringify(unexpected)).not.toContain('private/settings')
    })
})
