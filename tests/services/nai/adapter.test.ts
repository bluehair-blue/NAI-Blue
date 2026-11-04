import { beforeEach, describe, expect, it, vi } from 'vitest'

const { prepareReferences } = vi.hoisted(() => ({ prepareReferences: vi.fn() }))

vi.mock('@/services/nai/refs', () => ({ prepareReferences }))

import {
    adaptGenerationParams,
    NovelAiModelCapabilityError,
} from '@/services/nai/adapter'
import { buildGenerateImagePayload } from '@/services/nai/payload'
import type { GenerationParams } from '@/services/novelai-types'

function params(overrides: Partial<GenerationParams> = {}): GenerationParams {
    return {
        prompt: '1girl',
        negative_prompt: '',
        model: 'nai-diffusion-5-full',
        width: 832,
        height: 1216,
        steps: 28,
        cfg_scale: 5,
        cfg_rescale: 0,
        sampler: 'k_euler_ancestral',
        scheduler: 'native',
        smea: false,
        smea_dyn: false,
        variety: false,
        seed: 1,
        ...overrides,
    }
}

function characterPrompts(count: number): NonNullable<GenerationParams['characterPrompts']> {
    return Array.from({ length: count }, (_, index) => ({
        prompt: `character ${index + 1}`,
        negative: '',
        enabled: true,
        position: { x: 0.5, y: 0.5 },
    }))
}

describe('adaptGenerationParams V5 capability boundary', () => {
    beforeEach(() => {
        prepareReferences.mockReset()
        prepareReferences.mockResolvedValue({ newlyEncodedVibes: [] })
    })

    it('rejects conflicting verbatim settings before reference encoding or Provider work', async () => {
        for (const change of [{ ucPreset: 0 }, { qualityToggle: true }, { model: 'nai-diffusion-5-full' }]) {
            await expect(adaptGenerationParams('token', params({ model: 'nai-diffusion-4-5-full',
                promptTextMode: 'verbatim', ucPreset: 4, qualityToggle: false, ...change }))).rejects.toThrow('원문 보존')
        }
        expect(prepareReferences).not.toHaveBeenCalled()
    })

    it('normalizes V5 transport fields without changing user-owned generation values', async () => {
        const adapted = await adaptGenerationParams('token', params({ transparentBackground: true }))

        expect(adapted.request).toMatchObject({
            model: 'nai-diffusion-5-full',
            steps: 28,
            cfgScale: 5,
            sampler: 'k_euler_ancestral',
            noiseSchedule: 'karras',
            smea: false,
            smeaDyn: false,
            transparentBackground: true,
        })
    })

    it('uses the catalog inpainting ID, including the legacy V4 curated exception', async () => {
        prepareReferences.mockResolvedValueOnce({
            newlyEncodedVibes: [],
            source: { width: 832, height: 1216, maskBase64: 'mask', i2i: {} },
        })
        const adapted = await adaptGenerationParams('token', params({
            model: 'nai-diffusion-4-curated-preview',
            negative_prompt: 'custom negative',
            qualityToggle: true,
            ucPreset: 0,
        }))

        expect(adapted.request.model).toBe('nai-diffusion-4-curated-inpainting')
        const payload = buildGenerateImagePayload(adapted.request, adapted.buildOptions)
        expect(payload.input).toBe(
            '1girl, rating:general, amazing quality, very aesthetic, absurdres',
        )
        expect(payload.parameters.negative_prompt).toBe(
            'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, logo, dated, signature, multiple views, gigantic breasts, custom negative',
        )
    })

    it('routes V5 inpainting through the provider-supported model IDs', async () => {
        prepareReferences.mockResolvedValue({
            newlyEncodedVibes: [],
            source: { width: 832, height: 1216, maskBase64: 'mask', i2i: {} },
        })

        await expect(adaptGenerationParams('token', params({ model: 'nai-diffusion-5-full' })))
            .resolves.toMatchObject({ request: { model: 'nai-diffusion-5-full-inpainting' } })
        await expect(adaptGenerationParams('token', params({ model: 'nai-diffusion-5-curated' })))
            .resolves.toMatchObject({ request: { model: 'nai-diffusion-5-curated-inpainting' } })
    })

    it('allows 32 V5 character prompts and rejects the 33rd before transport work', async () => {
        await expect(adaptGenerationParams('token', params({ characterPrompts: characterPrompts(32) })))
            .resolves.toMatchObject({ request: { characterPrompts: expect.arrayContaining([
                expect.objectContaining({ prompt: 'character 32' }),
            ]) } })

        prepareReferences.mockClear()
        await expect(adaptGenerationParams('token', params({ characterPrompts: characterPrompts(33) })))
            .rejects.toThrow('최대 32개')
        expect(prepareReferences).not.toHaveBeenCalled()
    })

    it('keeps legacy model character prompts unrestricted by the V5 cap', async () => {
        await expect(adaptGenerationParams('token', params({
            model: 'nai-diffusion-4-5-full',
            characterPrompts: characterPrompts(33),
        }))).resolves.toMatchObject({ request: { characterPrompts: expect.arrayContaining([
            expect.objectContaining({ prompt: 'character 33' }),
        ]) } })
    })

    it('allows V5 Enhance MAX while preserving the V4/V4.5 img2img payload', async () => {
        prepareReferences.mockResolvedValue({
            newlyEncodedVibes: [],
            source: {
                width: 1400,
                height: 1600,
                i2i: {
                    imageBase64: 'source',
                    strength: 0.3,
                    noise: 0,
                    extraNoiseSeed: 99,
                    colorCorrect: false,
                },
            },
        })

        await expect(adaptGenerationParams('token', params({
            model: 'nai-diffusion-5-full',
            sourceImage: 'data:image/png;base64,source',
            upscaledEnhance: true,
        }))).resolves.toMatchObject({ buildOptions: { enhanceMax: true }, request: { model: 'nai-diffusion-5-full' } })

        const adapted = await adaptGenerationParams('token', params({
            model: 'nai-diffusion-4-5-full',
            sourceImage: 'data:image/png;base64,source',
            upscaledEnhance: true,
        }))
        const payload = buildGenerateImagePayload(adapted.request, adapted.buildOptions)

        expect(payload).toMatchObject({
            action: 'img2img',
            model: 'nai-diffusion-4-5-full',
            parameters: {
                width: 1400,
                height: 1600,
                upscaled_enhance: true,
            },
        })
    })

    it('rejects Enhance MAX masks and inputs at the 80% boundary before transport', async () => {
        await expect(adaptGenerationParams('token', params({
            model: 'nai-diffusion-4-5-full',
            sourceImage: 'data:image/png;base64,source',
            mask: 'data:image/png;base64,mask',
            upscaledEnhance: true,
        }))).rejects.toThrow('마스크')
        expect(prepareReferences).not.toHaveBeenCalled()

        prepareReferences.mockResolvedValue({
            newlyEncodedVibes: [],
            source: {
                width: 2048,
                height: 1536,
                i2i: {
                    imageBase64: 'source',
                    strength: 0.7,
                    noise: 0,
                    extraNoiseSeed: 1,
                    colorCorrect: false,
                },
            },
        })
        await expect(adaptGenerationParams('token', params({
            model: 'nai-diffusion-4-5-full',
            sourceImage: 'data:image/png;base64,source',
            upscaledEnhance: true,
        }))).rejects.toThrow('80%')
    })

    it.each([
        ['Vibe Transfer', { vibeImages: ['data:image/png;base64,AA=='] }],
        ['Precise Reference', { charImages: ['data:image/png;base64,AA=='] }],
    ])('rejects unsupported V5 %s before reference preprocessing', async (feature, overrides) => {
        await expect(adaptGenerationParams('token', params(overrides))).rejects.toThrow(feature)
        expect(prepareReferences).not.toHaveBeenCalled()
    })

    it('fails closed for an unknown provider model', async () => {
        await expect(adaptGenerationParams('token', params({ model: 'future-model' })))
            .rejects.toBeInstanceOf(NovelAiModelCapabilityError)
        expect(prepareReferences).not.toHaveBeenCalled()
    })
})
