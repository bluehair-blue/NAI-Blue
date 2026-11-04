import { afterEach, describe, expect, it, vi } from 'vitest'

const upscaleImageMock = vi.fn()
const generateImageMock = vi.fn()

vi.mock('@gradio/client', () => ({
    Client: { connect: vi.fn() },
}))

vi.mock('@/services/novelai-api', () => ({
    augmentImage: vi.fn(),
    generateImage: generateImageMock,
    upscaleImage: upscaleImageMock,
}))

class TestImage {
    width = Number(globalThis.__smartToolsImageWidth ?? 512)
    height = Number(globalThis.__smartToolsImageHeight ?? 512)
    onload: (() => void) | null = null
    onerror: (() => void) | null = null

    set src(value: string) {
        if (value) queueMicrotask(() => this.onload?.())
    }
}

declare global {
    var __smartToolsImageWidth: number | undefined
    var __smartToolsImageHeight: number | undefined
}

describe('Smart Tools upscale guard', () => {
    afterEach(() => {
        delete globalThis.__smartToolsImageWidth
        delete globalThis.__smartToolsImageHeight
        vi.unstubAllGlobals()
        vi.clearAllMocks()
    })

    it('blocks images over 3MP before calling the NovelAI upscale endpoint', async () => {
        vi.stubGlobal('Image', TestImage)
        globalThis.__smartToolsImageWidth = 2048
        globalThis.__smartToolsImageHeight = 1537
        const { smartTools } = await import('@/services/smart-tools')

        await expect(smartTools.upscale(`data:image/png;base64,${btoa('source')}`, 'token'))
            .rejects.toThrow(/3MP/)
        expect(upscaleImageMock).not.toHaveBeenCalled()
    })

    it('blocks non-PNG inputs before calling the NovelAI upscale endpoint', async () => {
        vi.stubGlobal('Image', TestImage)
        const { smartTools } = await import('@/services/smart-tools')

        await expect(smartTools.upscale(`data:image/jpeg;base64,${btoa('source')}`, 'token'))
            .rejects.toThrow(/PNG/)
        expect(upscaleImageMock).not.toHaveBeenCalled()
    })
})

describe('Smart Tools Enhance MAX', () => {
    afterEach(() => {
        delete globalThis.__smartToolsImageWidth
        delete globalThis.__smartToolsImageHeight
        vi.unstubAllGlobals()
        vi.clearAllMocks()
    })

    it('exposes the provider 3MP scale and 80% threshold contract', async () => {
        const {
            NAI_ENHANCE_MAX_EXPOSE_PIXELS,
            calculateEnhanceMaxScale,
            canUseEnhanceMaxForPixels,
        } = await import('@/services/smart-tools')

        expect(NAI_ENHANCE_MAX_EXPOSE_PIXELS).toBe(0.8 * 3_145_728)
        expect(canUseEnhanceMaxForPixels(1024, 1024)).toBe(true)
        expect(canUseEnhanceMaxForPixels(2048, 1536)).toBe(false)
        expect(calculateEnhanceMaxScale(1024, 1024)).toBeCloseTo(Math.sqrt(3_145_728 / 1_048_576))
    })

    it('sends Enhance MAX as a V4 img2img generation request with original dimensions', async () => {
        vi.stubGlobal('Image', TestImage)
        globalThis.__smartToolsImageWidth = 1024
        globalThis.__smartToolsImageHeight = 1536
        generateImageMock.mockResolvedValue({ success: true, imageData: btoa('enhanced') })
        const { smartTools } = await import('@/services/smart-tools')

        const result = await smartTools.enhanceMax(
            `data:image/png;base64,${btoa('source')}`,
            'token',
            {
                prompt: 'current prompt',
                negative_prompt: 'current negative',
                model: 'nai-diffusion-4-5-full',
                steps: 31,
                cfg_scale: 6,
                cfg_rescale: 0.2,
                sampler: 'k_euler',
                scheduler: 'exponential',
                smea: true,
                smea_dyn: false,
                variety: true,
                strength: 0.61,
                noise: 0.08,
                qualityToggle: true,
                ucPreset: 1,
            },
        )

        expect(result).toBe(`data:image/png;base64,${btoa('enhanced')}`)
        expect(generateImageMock).toHaveBeenCalledWith('token', expect.objectContaining({
            model: 'nai-diffusion-4-5-full',
            width: 1024,
            height: 1536,
            sourceImage: `data:image/png;base64,${btoa('source')}`,
            prompt: 'current prompt',
            negative_prompt: 'current negative',
            steps: 31,
            strength: 0.61,
            noise: 0.08,
            upscaledEnhance: true,
            metadataMode: 'strip-only',
        }))
    })

    it('routes supported V5 Enhance MAX through the existing generation client', async () => {
        vi.stubGlobal('Image', TestImage)
        const { smartTools } = await import('@/services/smart-tools')
        generateImageMock.mockResolvedValue({ success: true, imageData: btoa('enhanced') })

        await expect(smartTools.enhanceMax(
            `data:image/png;base64,${btoa('source')}`,
            'token',
            {
                prompt: '', negative_prompt: '', model: 'nai-diffusion-5-full', steps: 28,
                cfg_scale: 5, cfg_rescale: 0, sampler: 'k_euler', scheduler: 'karras',
                smea: false, smea_dyn: false, variety: false, strength: 0.7, noise: 0,
                qualityToggle: false, ucPreset: 0,
            },
        )).resolves.toBe(`data:image/png;base64,${btoa('enhanced')}`)
        expect(generateImageMock).toHaveBeenCalledWith('token', expect.objectContaining({
            model: 'nai-diffusion-5-full', upscaledEnhance: true,
        }))
    })

    it('blocks images at or above 80% of the 3MP target before generation', async () => {
        vi.stubGlobal('Image', TestImage)
        globalThis.__smartToolsImageWidth = 2048
        globalThis.__smartToolsImageHeight = 1536
        const { smartTools } = await import('@/services/smart-tools')

        await expect(smartTools.enhanceMax(
            `data:image/png;base64,${btoa('source')}`,
            'token',
            {
                prompt: '', negative_prompt: '', model: 'nai-diffusion-4-5-full', steps: 28,
                cfg_scale: 5, cfg_rescale: 0, sampler: 'k_euler', scheduler: 'karras',
                smea: false, smea_dyn: false, variety: false, strength: 0.7, noise: 0,
                qualityToggle: false, ucPreset: 0,
            },
        )).rejects.toThrow(/80%/)
        expect(generateImageMock).not.toHaveBeenCalled()
    })
})
