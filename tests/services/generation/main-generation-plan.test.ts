import { describe, expect, it } from 'vitest'

import {
    prepareMainGeneration,
    type PrepareMainGenerationOptions,
} from '@/services/generation/main-generation-plan'
import type { GenerationParams } from '@/services/novelai-types'

function params(overrides: Partial<GenerationParams> = {}): GenerationParams {
    return {
        prompt: 'prepared prompt',
        negative_prompt: 'prepared negative',
        model: 'nai-diffusion-4-5-full',
        width: 832,
        height: 1216,
        steps: 28,
        cfg_scale: 5,
        cfg_rescale: 0,
        sampler: 'k_euler_ancestral',
        scheduler: 'karras',
        smea: false,
        smea_dyn: false,
        variety: false,
        seed: 1234,
        ...overrides,
    }
}

function prepare(
    overrides: Partial<PrepareMainGenerationOptions> = {},
) {
    return prepareMainGeneration({
        params: params(),
        fallbackImageFormat: 'png',
        fallbackMetadataMode: 'embedded',
        streamingRequested: true,
        sequenceCommitProposal: null,
        output: {
            autoSave: true,
            directory: 'NAI_Blue_Output',
            useAbsolutePath: false,
            capabilityFallbackDirectory: 'NAI_Blue_Output',
            collisionPolicy: 'unique',
        },
        ...overrides,
    })
}

describe('prepareMainGeneration', () => {
    it('normalizes one shared output policy and disables streaming for source edits', () => {
        const prepared = prepare({
            params: params({
                sourceImage: 'data:image/png;base64,U09VUkNF',
                imageFormat: 'webp',
                metadataMode: 'strip-only',
            }),
            output: {
                autoSave: true,
                directory: '',
                useAbsolutePath: true,
                capabilityFallbackDirectory: '',
                fileName: 'unsafe:name.png',
                collisionPolicy: 'overwrite',
            },
        })

        expect(prepared).toMatchObject({
            finalPrompt: 'prepared prompt',
            imageFormat: 'webp',
            metadataMode: 'strip-only',
            streaming: false,
            sourceEdit: true,
            output: {
                directory: 'NAI_Blue_Output',
                useAbsolutePath: true,
                capabilityFallbackDirectory: 'NAI_Blue_Output',
                fileName: 'unsafe_name.webp',
                collisionPolicy: 'overwrite',
            },
        })
        expect(Object.isFrozen(prepared)).toBe(true)
        expect(Object.isFrozen(prepared.output)).toBe(true)
    })

    it('uses fallback format/metadata and leaves default filename policy to each executor', () => {
        const prepared = prepare({
            params: params(),
            output: {
                autoSave: false,
                directory: 'Custom/Output',
                useAbsolutePath: false,
                capabilityFallbackDirectory: 'Fallback',
                collisionPolicy: 'error',
                r2Requirement: { mode: 'required', profileId: 'private-profile' },
            },
        })

        expect(prepared).toMatchObject({
            imageFormat: 'png',
            metadataMode: 'embedded',
            streaming: true,
            sourceEdit: false,
            output: {
                autoSave: false,
                directory: 'Custom/Output',
                capabilityFallbackDirectory: 'Fallback',
                collisionPolicy: 'error',
                r2Requirement: { mode: 'required', profileId: 'private-profile' },
            },
        })
        expect(prepared.output).not.toHaveProperty('fileName')
    })
})
