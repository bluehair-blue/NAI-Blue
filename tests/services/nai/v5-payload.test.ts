import { describe, expect, it } from 'vitest'

import {
    buildGenerateImagePayload,
    type GenerationRequest,
} from '@/services/nai/payload'
import { UC_PRESETS_V5 } from '@/services/nai/presets'

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
    return {
        prompt: '1girl, blue hair',
        negativePrompt: 'extra fingers',
        model: 'nai-diffusion-5-full',
        width: 832,
        height: 1216,
        steps: 28,
        cfgScale: 5,
        cfgRescale: 0,
        sampler: 'k_euler_ancestral',
        noiseSchedule: 'karras',
        seed: 1,
        variety: false,
        smea: true,
        smeaDyn: true,
        qualityToggle: true,
        ucPreset: 0,
        characterPrompts: [],
        useCoords: false,
        ...overrides,
    }
}

describe('NovelAI V5 payload', () => {
    it.each(['nai-diffusion-5-full', 'nai-diffusion-5-curated']) (
        'uses the captured V5 prompt hints for %s',
        model => {
            const payload = buildGenerateImagePayload(request({ model }))

            expect(payload.input).toBe('1girl, blue hair, very aesthetic, masterpiece, no text')
            expect(payload.parameters).toMatchObject({
                tag_hint_qt: 1,
                tag_hint_uc_preset: 2,
                tag_hint_transparent_background: false,
                negative_prompt: `${UC_PRESETS_V5[0]}, extra fingers`,
            })
            expect(payload.parameters).not.toHaveProperty('sm')
            expect(payload.parameters).not.toHaveProperty('sm_dyn')
        },
    )

    it('adds the transparent prompt hint and wire flag only when requested', () => {
        const payload = buildGenerateImagePayload(request({ transparentBackground: true }))

        expect(payload.input).toBe(
            '1girl, blue hair, transparent background, very aesthetic, masterpiece, no text',
        )
        expect(payload.parameters.tag_hint_transparent_background).toBe(true)
        expect(payload.parameters.straight_alpha).toBe(true)
    })

    it('does not leak the V5 alpha flag into opaque or legacy requests', () => {
        const opaqueV5 = buildGenerateImagePayload(request({ transparentBackground: false }))
        const legacy = buildGenerateImagePayload(request({
            model: 'nai-diffusion-4-5-full',
            transparentBackground: true,
        }))

        expect(opaqueV5.parameters).not.toHaveProperty('straight_alpha')
        expect(legacy.parameters).not.toHaveProperty('straight_alpha')
    })

    it('omits the unsupported Variety+ wire key for V5', () => {
        const payload = buildGenerateImagePayload(request({ variety: true }))

        expect(payload.parameters).not.toHaveProperty('skip_cfg_above_sigma')
    })

    it('omits legacy SMEA flags for every selectable V4+ model', () => {
        for (const model of [
            'nai-diffusion-5-full',
            'nai-diffusion-4-5-full',
            'nai-diffusion-4-full',
        ]) {
            const payload = buildGenerateImagePayload(request({ model, smea: true, smeaDyn: true }))

            expect(payload.parameters).not.toHaveProperty('sm')
            expect(payload.parameters).not.toHaveProperty('sm_dyn')
        }
    })

    it('adds only the provider Enhance MAX flag on img2img payloads', () => {
        const payload = buildGenerateImagePayload(request({
            model: 'nai-diffusion-4-5-full',
            width: 1024,
            height: 1024,
            qualityToggle: false,
        }), {
            enhanceMax: true,
            i2i: {
                imageBase64: 'source',
                strength: 0.3,
                noise: 0,
                extraNoiseSeed: 9,
                colorCorrect: false,
            },
        })

        expect(payload.action).toBe('img2img')
        expect(payload.parameters).toMatchObject({
            width: 1024,
            height: 1024,
            n_samples: 1,
            image: 'source',
            strength: 0.3,
            noise: 0,
            extra_noise_seed: 9,
            upscaled_enhance: true,
        })
    })

    it('assembles Korean quoted text into V5 base text blocks after quality tags', () => {
        const payload = buildGenerateImagePayload(request({
            prompt: '1girl, "안녕", speech bubble, \'괜찮아?\'',
            characterPrompts: [{
                prompt: 'blue dress, “또 만나”',
                negativePrompt: '',
                enabled: true,
            }],
        }))

        expect(payload.input).toBe(
            '1girl, "안녕", speech bubble, \'괜찮아?\', very aesthetic, masterpiece, no text, '
            + 'teXt: 안녕\n\n괜찮아?\n\n또 만나',
        )
        expect((payload.parameters.v4_prompt as { caption: { char_captions: { char_caption: string }[] } })
            .caption.char_captions[0].char_caption).toBe('blue dress, “또 만나”')
    })

    it('keeps manual text prompts authoritative for V5', () => {
        const payload = buildGenerateImagePayload(request({
            prompt: '1girl, text: keep this, "무시"',
            characterPrompts: [{
                prompt: 'speech bubble, "also ignored"',
                negativePrompt: '',
                enabled: true,
            }],
        }))

        expect(payload.input).toBe('1girl, very aesthetic, masterpiece, no text, text: keep this, "무시"')
        expect(payload.input).not.toContain('teXt:')
    })

    it('inserts V5 prompt decorations before a manual text marker', () => {
        const payload = buildGenerateImagePayload(request({
            prompt: 'poster, TEXT: keep this',
            transparentBackground: true,
        }))

        expect(payload.input).toBe(
            'poster, transparent background, very aesthetic, masterpiece, no text, TEXT: keep this',
        )
        expect(payload.parameters.straight_alpha).toBe(true)
    })

    it('does not assemble quoted text for V4 models', () => {
        const payload = buildGenerateImagePayload(request({
            model: 'nai-diffusion-4-5-full',
            prompt: '1girl, "hello"',
        }))

        expect(payload.input).toContain('1girl, "hello"')
        expect(payload.input).not.toContain('teXt:')
    })

    it('orders V5 text blocks by coordinates without reordering character arrays', () => {
        const payload = buildGenerateImagePayload(request({
            prompt: 'duo',
            useCoords: true,
            characterPrompts: [
                {
                    prompt: 'right character, "right"',
                    negativePrompt: 'right negative',
                    enabled: true,
                    center: { x: 0.8, y: 0.2 },
                },
                {
                    prompt: 'left character, "left"',
                    negativePrompt: 'left negative',
                    enabled: true,
                    center: { x: 0.2, y: 0.24 },
                },
            ],
        }))
        const v4Prompt = payload.parameters.v4_prompt as { caption: { char_captions: { char_caption: string }[] } }
        const v4Negative = payload.parameters.v4_negative_prompt as { caption: { char_captions: { char_caption: string }[] } }

        expect(payload.input).toContain('teXt: left\n\nright')
        expect(v4Prompt.caption.char_captions.map(char => char.char_caption)).toEqual([
            'right character, "right"',
            'left character, "left"',
        ])
        expect(v4Negative.caption.char_captions.map(char => char.char_caption)).toEqual([
            'right negative',
            'left negative',
        ])
    })

    it('does not treat apostrophes in contractions as quoted text', () => {
        const payload = buildGenerateImagePayload(request({
            prompt: 'girl\'s jacket, don\'t stop, "speak"',
        }))

        expect(payload.input).toContain('teXt: speak')
        expect(payload.input).not.toContain('teXt: s jacket, don')
    })

    it('sends V5 Precise References with the outfit captions, strength up to 5 and no Fidelity', () => {
        const characterReferences = [
            { referenceType: 'costume' as const, strength: 2.5, fidelity: 0.6, imageBase64: 'OUTFIT' },
            { referenceType: 'character_mainoutfit' as const, strength: 1.5, fidelity: 0.9, imageBase64: 'CHARACTER' },
            { referenceType: 'character&style_anyoutfit' as const, strength: 5, fidelity: 0.1, imageBase64: 'BOTH' },
            { referenceType: 'style' as const, strength: 0.4, fidelity: 1, imageBase64: 'STYLE' },
        ]
        const caption = (base: string) => ({ caption: { base_caption: base, char_captions: [] }, legacy_uc: false })
        for (const model of ['nai-diffusion-5-full', 'nai-diffusion-5-curated']) {
            expect(buildGenerateImagePayload(request({ model }), { characterReferences }).parameters).toMatchObject({
                director_reference_descriptions: ['costume', 'character_mainoutfit', 'character&style_anyoutfit', 'style'].map(caption),
                director_reference_information_extracted: [1, 1, 1, 1],
                director_reference_strength_values: [2.5, 1.5, 5, 0.4],
                director_reference_secondary_strength_values: [0, 0, 0, 0],
                director_reference_images: ['OUTFIT', 'CHARACTER', 'BOTH', 'STYLE'],
            })
        }
        // V4.5 has neither the toggle nor a wider strength range: the base captions and 1 - fidelity stay as they were.
        const legacy = buildGenerateImagePayload(request({ model: 'nai-diffusion-4-5-full' }), {
            characterReferences: characterReferences.slice(1).map(reference => ({ ...reference, strength: 0.5 })),
        }).parameters as { director_reference_secondary_strength_values: number[] }
        expect(legacy).toMatchObject({ director_reference_descriptions: ['character', 'character&style', 'style'].map(caption),
            director_reference_strength_values: [0.5, 0.5, 0.5] })
        expect(legacy.director_reference_secondary_strength_values.map(value => Number(value.toFixed(6)))).toEqual([0.1, 0.9, 0])
    })
})
