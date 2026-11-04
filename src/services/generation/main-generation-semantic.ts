import type { PreparedGenerationJobDraft, Sha256Digest } from '@/application/generation/generation-plan-contract'
import { hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import type { GenerationParams } from '@/services/novelai-types'

function digest(value: unknown): Sha256Digest {
    return `sha256:${hashCanonicalValue(value)}`
}

/** Projects the exact Provider meaning reviewed by planning and rechecked before dispatch. */
export function projectMainGenerationSemantic(
    params: GenerationParams,
    imageFormat: NonNullable<GenerationParams['imageFormat']>,
): PreparedGenerationJobDraft['semantic'] {
    const pathHash = (value: string | null): Sha256Digest | null => value ? digest(value) : null
    const resources = {
        sourceImage: params.sourceImage ?? null,
        mask: params.mask ?? null,
        characterImages: params.charImages ?? [],
        vibeImages: params.vibeImages ?? [],
        preEncodedVibes: params.preEncodedVibes ?? [],
    }
    return {
        prompt: params.prompt,
        negativePrompt: params.negative_prompt,
        model: params.model,
        width: params.width,
        height: params.height,
        steps: params.steps,
        seed: params.seed,
        generationParameters: {
            ...(params.promptTextMode === undefined ? {} : { promptTextMode: params.promptTextMode }),
            cfgScale: params.cfg_scale,
            cfgRescale: params.cfg_rescale,
            sampler: params.sampler,
            scheduler: params.scheduler,
            smea: params.smea,
            smeaDyn: params.smea_dyn,
            variety: params.variety,
            strength: params.strength ?? null,
            noise: params.noise ?? null,
            sourceImageDigest: pathHash(params.sourceImage ?? null),
            maskDigest: pathHash(params.mask ?? null),
            characterImageDigests: (params.charImages ?? []).map(digest),
            characterStrength: params.charStrength ?? [],
            characterFidelity: params.charFidelity ?? [],
            characterReferenceType: params.charReferenceType ?? [],
            vibeImageDigests: (params.vibeImages ?? []).map(digest),
            preEncodedVibeDigests: (params.preEncodedVibes ?? []).map(value => value === null ? null : digest(value)),
            vibeInformation: params.vibeInfo ?? [],
            vibeStrength: params.vibeStrength ?? [],
            characterPrompts: (params.characterPrompts ?? []).map(character => ({
                prompt: character.prompt,
                negative: character.negative,
                enabled: character.enabled,
                position: { ...character.position },
            })),
            characterPositionEnabled: params.characterPositionEnabled ?? false,
            imageFormat,
            upscaledEnhance: params.upscaledEnhance ?? false,
            qualityToggle: params.qualityToggle ?? false,
            ucPreset: params.ucPreset ?? 0,
            transparentBackground: params.transparentBackground ?? false,
        },
        resourceDigest: digest(resources),
    }
}
