import type { PreciseReferenceCaption } from './precise-reference'

export type LegacyMainReferenceType = PreciseReferenceCaption | 'delta'

export interface LegacyMainCharacterImageInput {
    readonly base64: string
    readonly strength: number
    readonly fidelity?: number
    readonly referenceType?: LegacyMainReferenceType
    readonly cacheKey?: string | null
}

export interface LegacyMainVibeImageInput {
    readonly base64: string
    readonly informationExtracted: number
    readonly strength: number
    readonly encodedVibe?: string
}

export interface LegacyMainCharacterPromptInput {
    readonly stableId?: string
    readonly name?: string
    readonly prompt: string
    readonly negative: string
    readonly enabled: boolean
    readonly position: { readonly x: number, readonly y: number }
}

export interface BuildLegacyMainParametersInput<TAssetModulePlan, TMetadataMode> {
    readonly prompt: string
    readonly negativePrompt: string
    readonly originalPrompts: {
        readonly base: string
        readonly additional: string
        readonly detail: string
        readonly negative: string
        readonly inpainting: string
    }
    readonly model: string
    readonly width: number
    readonly height: number
    readonly steps: number
    readonly cfgScale: number
    readonly cfgRescale: number
    readonly sampler: string
    readonly scheduler: string
    readonly smea: boolean
    readonly smeaDyn: boolean
    readonly variety: boolean
    readonly seed: number
    readonly sourceImage?: string | null
    readonly strength: number
    readonly noise: number
    readonly mask?: string | null
    readonly characterImages: readonly LegacyMainCharacterImageInput[]
    readonly vibeImages: readonly LegacyMainVibeImageInput[]
    readonly characterPrompts: readonly LegacyMainCharacterPromptInput[]
    readonly characterPositionEnabled: boolean
    readonly modulePromptsActive: boolean
    readonly moduleCharacterPromptsPresent: boolean
    readonly imageFormat: 'png' | 'webp'
    readonly metadataMode: TMetadataMode
    readonly assetModulePlan: TAssetModulePlan | null
    readonly qualityToggle: boolean
    readonly ucPreset: number
    readonly transparentBackground?: boolean
}

export interface LegacyMainGenerationParameters<TAssetModulePlan, TMetadataMode> {
    prompt: string
    negative_prompt: string
    model: string
    width: number
    height: number
    steps: number
    cfg_scale: number
    cfg_rescale: number
    sampler: string
    scheduler: string
    smea: boolean
    smea_dyn: boolean
    variety: boolean
    seed: number
    sourceImage?: string
    strength: number
    noise: number
    mask?: string
    charImages: string[]
    charStrength: number[]
    charFidelity: number[]
    charReferenceType: LegacyMainReferenceType[]
    charCacheKeys: (string | null)[]
    vibeImages: string[]
    vibeInfo: number[]
    vibeStrength: number[]
    preEncodedVibes: (string | null)[]
    characterPrompts: Array<{
        stableId?: string
        name?: string
        prompt: string
        negative: string
        enabled: boolean
        position: { x: number, y: number }
    }>
    characterPositionEnabled: boolean
    imageFormat: 'png' | 'webp'
    metadataMode: TMetadataMode
    assetModulePlan?: TAssetModulePlan
    qualityToggle: boolean
    ucPreset: number
    transparentBackground: boolean
    promptParts: {
        base: string
        additional: string
        detail: string
        negative: string
        inpainting: string
    }
}

/**
 * Builds the legacy provider-neutral parameter projection from already resolved
 * prompts and resources. It depends only on immutable inputs, interacts with the
 * Main Planner before NAI adaptation, and centralizes defaults without Store or
 * transport access so Queue and direct execution receive identical parameters.
 */
export function buildLegacyMainGenerationParameters<TAssetModulePlan, TMetadataMode>(
    input: BuildLegacyMainParametersInput<TAssetModulePlan, TMetadataMode>,
): LegacyMainGenerationParameters<TAssetModulePlan, TMetadataMode> {
    return {
        prompt: input.prompt,
        negative_prompt: input.negativePrompt,
        model: input.model,
        width: input.width,
        height: input.height,
        steps: input.steps,
        cfg_scale: input.cfgScale,
        cfg_rescale: input.cfgRescale,
        sampler: input.sampler,
        scheduler: input.scheduler,
        smea: input.smea,
        smea_dyn: input.smeaDyn,
        variety: input.variety,
        seed: input.seed,
        ...(input.sourceImage ? { sourceImage: input.sourceImage } : {}),
        strength: input.strength,
        noise: input.noise,
        ...(input.mask ? { mask: input.mask } : {}),
        charImages: input.characterImages.map(image => image.base64),
        charStrength: input.characterImages.map(image => image.strength),
        charFidelity: input.characterImages.map(image => image.fidelity ?? 0.6),
        charReferenceType: input.characterImages.map(image => image.referenceType ?? 'character&style'),
        charCacheKeys: input.characterImages.map(image => image.cacheKey || null),
        vibeImages: input.vibeImages.map(image => image.base64),
        vibeInfo: input.vibeImages.map(image => image.informationExtracted),
        vibeStrength: input.vibeImages.map(image => image.strength),
        preEncodedVibes: input.vibeImages.map(image => image.encodedVibe || null),
        characterPrompts: input.characterPrompts.map(character => ({
            // Preserve store/module metadata such as display names while cloning
            // the mutable position leaf used later by metadata and NAI adapters.
            ...character,
            position: { ...character.position },
        })),
        characterPositionEnabled: input.modulePromptsActive && input.moduleCharacterPromptsPresent
            ? true
            : input.characterPositionEnabled,
        imageFormat: input.imageFormat,
        metadataMode: input.metadataMode,
        ...(input.assetModulePlan === null ? {} : { assetModulePlan: input.assetModulePlan }),
        qualityToggle: input.qualityToggle,
        ucPreset: input.ucPreset,
        transparentBackground: input.transparentBackground ?? false,
        promptParts: input.modulePromptsActive
            ? {
                base: input.prompt,
                additional: '',
                detail: '',
                negative: input.negativePrompt,
                inpainting: '',
            }
            : { ...input.originalPrompts },
    }
}
