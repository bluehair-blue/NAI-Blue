import { beforeEach, describe, expect, it, vi } from 'vitest'
const { prepareReferences } = vi.hoisted(() => ({ prepareReferences: vi.fn() }))
vi.mock('@/services/nai/refs', () => ({ prepareReferences }))
import { adaptGenerationParams } from '@/services/nai/adapter'
import { buildGenerateImagePayload } from '@/services/nai/payload'
import { getNovelAiModelProfile, isNovelAiV5Model, normalizeNaiImageModelId } from '@/services/nai/model-catalog'
import { UC_PRESETS_V5 } from '@/services/nai/presets'
import type { GenerationParams } from '@/services/novelai-types'
import fixture from '../../fixtures/payload/v5-medium.json'

function params(overrides: Partial<GenerationParams> = {}): GenerationParams {
    return {
        model: 'nai-diffusion-5-full-medium', prompt: 'blue ceramic bowl', negative_prompt: '',
        width: 832, height: 1216, steps: 14, cfg_scale: 5, cfg_rescale: 0,
        sampler: 'k_euler_ancestral', scheduler: 'karras', seed: 123, ucPreset: 0,
        qualityToggle: true, variety: false, smea: false, smea_dyn: false, ...overrides,
    }
}

describe('V5 Full Medium compatibility', () => {
    beforeEach(() => prepareReferences.mockReset().mockResolvedValue({ newlyEncodedVibes: [] }))

    it('preserves Medium identity for imported display names and inpainting IDs', () => {
        expect(params()).toMatchObject({ model: fixture.model, steps: fixture.steps, sampler: fixture.sampler,
            cfg_rescale: fixture.cfgRescale, ucPreset: fixture.ucPreset })
        expect(normalizeNaiImageModelId('NovelAI Diffusion V5 Full Medium')).toBe(params().model)
        expect(normalizeNaiImageModelId('nai-diffusion-5-full-medium-inpainting')).toBe(params().model)
        expect(isNovelAiV5Model('nai-diffusion-5-full-medium-inpainting')).toBe(true)
        expect(getNovelAiModelProfile(params().model)?.inpaintModelId).toBe('nai-diffusion-5-full-medium-inpainting')
    })

    it.each(['png', 'webp'] as const)('serializes fixed settings and V5 hints for %s and streaming', async imageFormat => {
        const adapted = await adaptGenerationParams('test-token', params({ imageFormat }), 'msgpack')
        const payload = buildGenerateImagePayload(adapted.request, adapted.buildOptions)
        expect(payload.model).toBe(params().model)
        expect(payload.input).toBe('blue ceramic bowl, very aesthetic, masterpiece, no text')
        expect(payload.parameters).toMatchObject({
            steps: 14, sampler: 'k_euler_ancestral', cfg_rescale: 0, ucPreset: 0,
            negative_prompt: UC_PRESETS_V5[0], tag_hint_uc_preset: 2,
            tag_hint_qt: 1, image_format: imageFormat, stream: 'msgpack',
        })
        expect(payload.parameters).not.toHaveProperty('skip_cfg_above_sigma')
    })

    it.each([
        { steps: 28 }, { sampler: 'k_euler' }, { cfg_rescale: 0.2 }, { ucPreset: 4 },
        { negative_prompt: 'watermark' },
        { characterPrompts: [{ enabled: true, prompt: 'blue hair', negative: 'hat', position: { x: 0.5, y: 0.5 } }] },
    ])('rejects incompatible reviewed inputs before reference/Provider work: %j', async overrides => {
        await expect(adaptGenerationParams('test-token', params(overrides))).rejects.toThrow('Medium')
        expect(prepareReferences).not.toHaveBeenCalled()
    })

    it('uses the Medium inpainting ID without altering fixed settings', async () => {
        prepareReferences.mockResolvedValue({ newlyEncodedVibes: [], source: {
            width: 832, height: 1216, maskBase64: 'mask',
            i2i: { imageBase64: 'source', maskBase64: 'mask', strength: 0.5, noise: 0, extraNoiseSeed: 9, colorCorrect: false },
        } })
        const adapted = await adaptGenerationParams('test-token', params())
        const payload = buildGenerateImagePayload(adapted.request, adapted.buildOptions)
        expect(payload).toMatchObject({ model: 'nai-diffusion-5-full-medium-inpainting', action: 'infill', parameters: { steps: 14 } })
    })

    it('protects direct payload callers from silently losing custom negatives', async () => {
        const adapted = await adaptGenerationParams('test-token', params())
        expect(() => buildGenerateImagePayload({ ...adapted.request, negativePrompt: 'custom' })).toThrow('네거티브')
    })
})
