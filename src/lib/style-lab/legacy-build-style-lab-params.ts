import { preciseReferenceCaption } from '@/domain/generation/precise-reference'
import { buildStyleLabPrompt, formatWeightedPromptTags } from '@/lib/style-lab'
import { createWildcardResolutionSession } from '@/lib/fragment-processor'
import type { FragmentSequenceCommitProposal } from '@/domain/composition/fragment-resolver'
import type { DeepReadonly } from '@/domain/composition/provenance'
import type { GenerationParams } from '@/services/novelai-api'
import { useCharacterPromptStore } from '@/stores/character-prompt-store'
import { useCharacterStore } from '@/stores/character-store'
import { useGenerationStore } from '@/stores/generation-store'
import { useSettingsStore } from '@/stores/settings-store'
import type { StyleCombination } from '@/stores/style-lab-store'
import { useStyleLabStore } from '@/stores/style-lab-store'

export interface LegacyStyleLabGenerationBuildResult {
    params: GenerationParams
    prompt: string
    seed: number
    sequenceCommitProposal: DeepReadonly<FragmentSequenceCommitProposal> | null
}

export interface LegacyStyleLabGenerationBuildOptions {
    /** EvaluationContext supplies this seed so every Arena candidate shares it. */
    seed?: number
}

const removeComments = (text: string): string => text
    .split('\n')
    .filter(line => !line.trimStart().startsWith('#'))
    .join('\n')

const roundTo64 = (value: number): number => Math.round(value / 64) * 64

function getImageDimensions(base64: string): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => {
            const size = { width: img.width, height: img.height }
            img.src = ''
            resolve(size)
        }
        img.onerror = () => {
            img.src = ''
            reject(new Error('Failed to load source image'))
        }
        img.src = base64
    })
}

/** Exact rollback path for the pre-CompositionEngine Style Lab request builder. */
export async function buildLegacyStyleLabGenerationParams(
    combo: StyleCombination,
    options: LegacyStyleLabGenerationBuildOptions = {},
): Promise<LegacyStyleLabGenerationBuildResult> {
    const genState = useGenerationStore.getState()
    const styleState = useStyleLabStore.getState()
    let seed = options.seed ?? (genState.seedLocked
        ? genState.seed
        : Math.floor(Math.random() * 4294967295))
    // Preserve the legacy zero-reroll only outside an explicit evaluation contract.
    if (options.seed === undefined && seed === 0) seed = Math.floor(Math.random() * 4294967295)
    seed = Math.trunc(seed) >>> 0
    const fragmentSession = options.seed === undefined
        ? createWildcardResolutionSession()
        : createWildcardResolutionSession({
            seed,
            scope: 'style-lab:evaluation',
        })

    const artistTags = formatWeightedPromptTags(combo.tags)
    const templatedPrompt = buildStyleLabPrompt(styleState.settings.promptTemplate, artistTags, {
        basePrompt: removeComments(genState.basePrompt),
        additionalPrompt: removeComments(genState.additionalPrompt),
        detailPrompt: removeComments(genState.detailPrompt),
        inpaintingPrompt: genState.i2iMode === 'inpaint' ? removeComments(genState.inpaintingPrompt) : '',
    })
    const finalPrompt = await fragmentSession.process(templatedPrompt)

    await useCharacterStore.getState().ensureImagesLoaded()
    const characterState = useCharacterStore.getState()
    const characterImages = characterState.characterImages.filter(img => img.enabled !== false && img.base64)
    const vibeImages = characterState.vibeImages.filter(img => img.enabled !== false && img.base64)

    const { characters, positionEnabled } = useCharacterPromptStore.getState()
    const processedCharacterPrompts = await Promise.all(
        characters.filter(character => character.enabled).map(async character => ({
            ...character,
            prompt: await fragmentSession.process(character.prompt),
            negative: await fragmentSession.process(character.negative),
        })),
    )

    let width = roundTo64(genState.selectedResolution.width)
    let height = roundTo64(genState.selectedResolution.height)

    if (genState.sourceImage) {
        try {
            const dimensions = await getImageDimensions(genState.sourceImage)
            width = roundTo64(dimensions.width)
            height = roundTo64(dimensions.height)
        } catch (error) {
            console.warn('[StyleLab] Failed to read source image dimensions:', error)
        }
    }

    const { imageFormat } = useSettingsStore.getState()

    return {
        prompt: finalPrompt,
        seed,
        sequenceCommitProposal: fragmentSession.sequenceCommitProposal,
        params: {
            prompt: finalPrompt,
            negative_prompt: removeComments(genState.negativePrompt),
            model: genState.model,
            width,
            height,
            steps: genState.steps,
            cfg_scale: genState.cfgScale,
            cfg_rescale: genState.cfgRescale,
            sampler: genState.sampler,
            scheduler: genState.scheduler,
            smea: genState.smea,
            smea_dyn: genState.smeaDyn,
            variety: genState.variety,
            seed,
            sourceImage: genState.sourceImage || undefined,
            strength: genState.strength,
            noise: genState.noise,
            mask: genState.mask || undefined,
            charImages: characterImages.map(img => img.base64!),
            charStrength: characterImages.map(img => img.strength),
            charFidelity: characterImages.map(img => img.fidelity ?? 0.6),
            charReferenceType: characterImages.map(img => preciseReferenceCaption(img.referenceType ?? 'character&style', img.preferSameOutfit)),
            charCacheKeys: characterImages.map(img => img.cacheKey || null),
            vibeImages: vibeImages.map(img => img.base64!),
            vibeInfo: vibeImages.map(img => img.informationExtracted),
            vibeStrength: vibeImages.map(img => img.strength),
            preEncodedVibes: vibeImages.map(img => img.encodedVibe || null),
            characterPrompts: processedCharacterPrompts,
            characterPositionEnabled: positionEnabled,
            imageFormat,
            qualityToggle: genState.qualityToggle,
            ucPreset: genState.ucPreset,
            promptParts: {
                base: finalPrompt,
                additional: '',
                detail: '',
                negative: genState.negativePrompt,
                inpainting: genState.i2iMode === 'inpaint' ? genState.inpaintingPrompt : '',
            },
        },
    }
}
