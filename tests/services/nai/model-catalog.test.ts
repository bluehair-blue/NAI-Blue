import { describe, expect, it } from 'vitest'

import {
    DEFAULT_NAI_IMAGE_MODEL,
    NAI_IMAGE_MODELS,
    getNovelAiModelProfile,
    isNovelAiV5Model,
    normalizeNaiImageModelId,
    novelAiVerbatimSettingsIssue,
} from '@/services/nai/model-catalog'

describe('NovelAI model catalog', () => {
    it('accepts explicit standard mode and limits exact verbatim to its supported settings', () => {
        expect(novelAiVerbatimSettingsIssue({ model: 'nai-diffusion-5-full', promptTextMode: 'standard', ucPreset: 4 })).toBeNull()
        expect(novelAiVerbatimSettingsIssue({ model: 'nai-diffusion-4-5-full', promptTextMode: 'verbatim',
            ucPreset: 4, qualityToggle: false })).toBeNull()
        expect(novelAiVerbatimSettingsIssue({ model: 'nai-diffusion-5-full', promptTextMode: 'verbatim',
            ucPreset: 4, qualityToggle: false })).toContain('V4.5')
    })
    it('keeps V5 Full and Curated as the first selectable models with verified V5 contracts', () => {
        expect(DEFAULT_NAI_IMAGE_MODEL).toBe('nai-diffusion-5-full')
        expect(NAI_IMAGE_MODELS.slice(0, 2).map(model => model.id)).toEqual([
            'nai-diffusion-5-full',
            'nai-diffusion-5-curated',
        ])
        expect(new Set(NAI_IMAGE_MODELS.map(model => model.id)).size).toBe(NAI_IMAGE_MODELS.length)
        expect(NAI_IMAGE_MODELS[0]).toMatchObject({
            inpaintId: 'nai-diffusion-5-full-inpainting',
            recommended: true,
            capabilities: {
                imageToImage: true,
                inpainting: true,
                characterPrompts: true,
                animeFurryMode: true,
                transparentBackground: true,
                vibeTransfer: false,
                preciseReference: false,
                enhanceMax: true,
                maxCharacters: 32,
            },
        })
        expect(NAI_IMAGE_MODELS[1]).toMatchObject({
            inpaintId: 'nai-diffusion-5-curated-inpainting',
            capabilities: { enhanceMax: true, maxCharacters: 32 },
        })
    })

    it('preserves V4 and V4.5 as selectable compatibility models', () => {
        expect(NAI_IMAGE_MODELS.map(model => model.id)).toEqual(expect.arrayContaining([
            'nai-diffusion-4-5-full',
            'nai-diffusion-4-5-curated',
            'nai-diffusion-4-full',
            'nai-diffusion-4-curated-preview',
        ]))
        expect(NAI_IMAGE_MODELS.slice(2).every(model => model.capabilities.enhanceMax)).toBe(true)
    })

    it('normalizes provider display names and inpaint IDs to selectable model IDs', () => {
        expect(normalizeNaiImageModelId('NovelAI Diffusion V5 Full')).toBe('nai-diffusion-5-full')
        expect(normalizeNaiImageModelId('NovelAI Diffusion V5 Curated')).toBe('nai-diffusion-5-curated')
        expect(normalizeNaiImageModelId('nai-diffusion-5-full-inpainting')).toBe('nai-diffusion-5-full')
        expect(normalizeNaiImageModelId('nai-diffusion-5-curated-inpainting')).toBe('nai-diffusion-5-curated')
        expect(normalizeNaiImageModelId('nai-diffusion-4-5-full-inpainting')).toBe('nai-diffusion-4-5-full')
        expect(normalizeNaiImageModelId('NovelAI Diffusion V4.5 Full')).toBe('nai-diffusion-4-5-full')
    })

    it('exposes payload-friendly V5 profile helpers without sampler defaults', () => {
        expect(isNovelAiV5Model('nai-diffusion-5-curated-inpainting')).toBe(true)
        expect(getNovelAiModelProfile('nai-diffusion-5-curated')).toMatchObject({
            modelId: 'nai-diffusion-5-curated',
            inpaintModelId: 'nai-diffusion-5-curated-inpainting',
            capabilities: { transparentBackground: true, vibeTransfer: false },
        })
        expect(getNovelAiModelProfile('nai-diffusion-5-curated-inpainting')).toMatchObject({
            modelId: 'nai-diffusion-5-curated',
            inpaintModelId: 'nai-diffusion-5-curated-inpainting',
        })
        expect(getNovelAiModelProfile('nai-diffusion-4-5-full-inpainting')).toMatchObject({
            modelId: 'nai-diffusion-4-5-full',
            inpaintModelId: 'nai-diffusion-4-5-full-inpainting',
        })
        expect(getNovelAiModelProfile('unknown-model')).toBeUndefined()
        expect(getNovelAiModelProfile('nai-diffusion-4-curated-preview')).toMatchObject({
            modelId: 'nai-diffusion-4-curated-preview',
            inpaintModelId: 'nai-diffusion-4-curated-inpainting',
        })
    })
})
