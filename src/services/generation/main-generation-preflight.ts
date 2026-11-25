import { preciseReferenceCaption } from '@/domain/generation/precise-reference'
import type { AnlasPricingBasis } from '@/domain/queue/anlas-cost-consent'
import type { CharacterGroup, CharacterPreset, CharacterPrompt } from '@/stores/character-prompt-store'
import type { ReferenceImage } from '@/stores/character-store'
import type { AssetProfile } from '@/types/asset-profile'
import { calculateAnlasCost } from '@/lib/anlas-calculator'
import { sha256Utf8 } from '@/domain/composition/canonical-serialize'
import { createStoreFragmentResolverInput } from '@/lib/fragment-processor'
import type { FragmentLookupRepository } from '@/stores/fragment-store'
import {
    diagnosticsFromMainResolution,
    resolveMainComposition,
    type BuildMainCompositionInput,
    type MainCompositionDiagnostics,
    type MainCompositionResolution,
    type MainCompositionSnapshot,
    type MainCompositionMode,
    resolveMainRecipeSelection,
} from '@/lib/composition/main-adapter'
import {
    CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
    queryNaiCompatibility,
    type NaiCompatibilityFeature,
    type NaiCompatibilityProfile,
    type NaiGenerationAction,
} from '@/services/nai/compatibility'

export interface MainCompositionGenerationDraft {
    readonly basePrompt: string
    readonly additionalPrompt: string
    readonly detailPrompt: string
    readonly negativePrompt: string
    readonly inpaintingPrompt: string
    readonly model: string
    readonly steps: number
    readonly cfgScale: number
    readonly cfgRescale: number
    readonly sampler: string
    readonly scheduler: string
    readonly smea: boolean
    readonly smeaDyn: boolean
    readonly variety: boolean
    readonly qualityToggle: boolean
    readonly ucPreset: number
    readonly transparentBackground: boolean
    readonly sourceImage: string | null
    readonly mask: string | null
    readonly strength: number
    readonly noise: number
    readonly selectedRecipeId: string | null
}

export interface MainCompositionOutputDraft {
    readonly autoSave: boolean
    readonly savePath: string
    readonly useAbsolutePath: boolean
    readonly imageFormat: 'png' | 'webp'
    readonly metadataMode: MainCompositionSnapshot['output']['metadataMode']
}

export interface BuildMainCompositionProjectionInput {
    readonly generation: MainCompositionGenerationDraft
    readonly effectiveBasePrompt: string
    readonly profile: AssetProfile
    readonly characters: readonly CharacterPrompt[]
    readonly characterPresets: readonly CharacterPreset[]
    readonly characterGroups: readonly CharacterGroup[]
    readonly positionEnabled: boolean
    readonly characterImages: readonly ReferenceImage[]
    readonly vibeImages: readonly ReferenceImage[]
    readonly paramsPresets: readonly unknown[]
    readonly activeParamsPresetId?: string
    readonly output: MainCompositionOutputDraft
    readonly portableRoot: NonNullable<MainCompositionSnapshot['output']['portableRoot']>
    readonly paramsWidth: number
    readonly paramsHeight: number
    readonly sourceWidth: number
    readonly sourceHeight: number
    readonly seed: number
}

export interface MainCompositionProjection {
    readonly snapshot: MainCompositionSnapshot
    readonly fragmentSourceTexts: readonly string[]
}

function collectStringValues(value: unknown, seen = new Set<object>()): string[] {
    if (typeof value === 'string') return [value]
    if (value === null || typeof value !== 'object' || seen.has(value)) return []
    seen.add(value)
    if (Array.isArray(value)) return value.flatMap(item => collectStringValues(item, seen))
    return Object.values(value).flatMap(item => collectStringValues(item, seen))
}

function digest(value: string | null | undefined): string | undefined {
    return value ? `sha256:${sha256Utf8(value)}` : undefined
}

function referenceSnapshots(
    characterImages: readonly ReferenceImage[],
    vibeImages: readonly ReferenceImage[],
): MainCompositionSnapshot['references'] {
    return [
        ...characterImages.map(image => ({
            id: image.id,
            enabled: image.enabled !== false,
            kind: 'character' as const,
            referenceType: preciseReferenceCaption(image.referenceType, image.preferSameOutfit),
            strength: image.strength,
            fidelity: image.fidelity,
            informationExtracted: image.informationExtracted,
            digest: digest(image.thumbnail),
        })),
        ...vibeImages.map(image => ({
            id: image.id,
            enabled: image.enabled !== false,
            kind: 'vibe' as const,
            referenceType: preciseReferenceCaption(image.referenceType, image.preferSameOutfit),
            strength: image.strength,
            fidelity: image.fidelity,
            informationExtracted: image.informationExtracted,
            digest: digest(image.thumbnail),
        })),
    ]
}

/** Projects every synchronous Main draft field shared by execution and passive preflight. */
export function buildMainCompositionProjection(
    input: BuildMainCompositionProjectionInput,
): MainCompositionProjection {
    const { generation } = input
    const recipeSelection = resolveMainRecipeSelection(input.profile, generation.selectedRecipeId)
    const recipe = recipeSelection.isDirect
        ? undefined
        : input.profile.recipes.find(candidate => candidate.id === recipeSelection.recipeId)
    const fragmentSourceTexts = [
        input.effectiveBasePrompt,
        generation.inpaintingPrompt,
        generation.additionalPrompt,
        generation.detailPrompt,
        generation.negativePrompt,
        ...input.characters.flatMap(character => [character.prompt, character.negative]),
        ...collectStringValues(recipe === undefined ? undefined : {
            steps: recipe.steps,
            modules: recipe.steps.map(step => input.profile.modules[step.moduleId]),
        }),
    ]
    const snapshot: MainCompositionSnapshot = {
        profile: input.profile,
        selectedRecipeId: generation.selectedRecipeId,
        prompt: {
            base: input.effectiveBasePrompt,
            inpainting: generation.inpaintingPrompt,
            additional: generation.additionalPrompt,
            detail: generation.detailPrompt,
            negative: generation.negativePrompt,
        },
        characters: input.characters,
        characterPresets: input.characterPresets,
        characterGroups: input.characterGroups,
        positionEnabled: input.positionEnabled,
        references: referenceSnapshots(input.characterImages, input.vibeImages),
        paramsPresets: input.paramsPresets,
        activeParamsPresetId: input.activeParamsPresetId,
        params: {
            model: generation.model,
            width: input.paramsWidth,
            height: input.paramsHeight,
            steps: generation.steps,
            cfgScale: generation.cfgScale,
            cfgRescale: generation.cfgRescale,
            sampler: generation.sampler,
            scheduler: generation.scheduler,
            smea: generation.smea,
            smeaDyn: generation.smeaDyn,
            variety: generation.variety,
            seed: input.seed,
            qualityToggle: generation.qualityToggle,
            ucPreset: generation.ucPreset,
            transparentBackground: generation.transparentBackground,
            sourceMode: 'text-to-image',
            strength: generation.strength,
            noise: generation.noise,
            characterPositionEnabled: input.positionEnabled,
        },
        output: { ...input.output, portableRoot: input.portableRoot },
        source: {
            hasSourceImage: Boolean(generation.sourceImage),
            hasMask: Boolean(generation.mask),
            sourceImageDigest: digest(generation.sourceImage),
            maskDigest: digest(generation.mask),
            width: input.sourceWidth,
            height: input.sourceHeight,
            strength: generation.strength,
            noise: generation.noise,
        },
    }
    return Object.freeze({ snapshot, fragmentSourceTexts: Object.freeze(fragmentSourceTexts) })
}

/** Captures fragment content consistently; preview mode never consumes sequential counters. */
export function buildMainFragmentInput(
    mode: 'preview' | 'generate',
    sourceTexts: readonly string[],
    repository?: FragmentLookupRepository,
) {
    return createStoreFragmentResolverInput(sourceTexts, {
        mode,
        strictness: 'compatible',
        maxRecursion: 10,
        ...(repository === undefined ? {} : { repository }),
    })
}

export interface MainGenerationPreflight {
    readonly resolution: MainCompositionResolution
    readonly diagnostics: MainCompositionDiagnostics
    readonly estimatedCost: number | null
    /** Synthetic evidence is intentionally returned as a plan warning, never a pass. */
    readonly providerCompatibility: NaiCompatibilityProfile
}

/** Legacy and shadow retain their executable fallback; only v2 owns preflight blocking. */
export function mainPreflightBlocksGeneration(
    mode: MainCompositionMode,
    state: {
        readonly profileConflict: boolean
        readonly profileLoading: boolean
        readonly preflightReady: boolean
        readonly resolutionError: boolean
    },
): boolean {
    return mode === 'v2' && (
        state.profileConflict
        || state.profileLoading
        || !state.preflightReady
        || state.resolutionError
    )
}

/** Resolves the current draft without mutating stores or consuming fragment sequences. */
export function preflightMainGeneration(
    input: BuildMainCompositionInput,
    options: {
        readonly batchCount: number
        readonly pricingBasis: AnlasPricingBasis
        readonly streaming?: boolean
    },
): MainGenerationPreflight {
    const resolution = resolveMainComposition({
        ...input,
        fragmentMode: 'preview',
    })
    const diagnostics = diagnosticsFromMainResolution(resolution)
    const params = diagnostics.plan?.params
    const sourceMode = params?.sourceMode ?? input.snapshot.params.sourceMode
    const action: NaiGenerationAction = sourceMode === 'inpaint'
        ? 'infill'
        : sourceMode === 'image-to-image'
            ? 'img2img'
            : 'generate'
    const features: NaiCompatibilityFeature[] = []
    if (options.streaming === true && action === 'generate') features.push('streaming')
    if ((diagnostics.plan?.characters.length ?? input.snapshot.characters.length) > 0) {
        features.push('character-prompts')
    }
    const hasCharacterReference = diagnostics.plan
        ? diagnostics.plan.resources.some(resource => resource.role === 'character-reference')
        : input.snapshot.references.some(reference => reference.kind === 'character')
    const hasVibeReference = diagnostics.plan
        ? diagnostics.plan.resources.some(resource => resource.role === 'vibe-reference')
        : input.snapshot.references.some(reference => reference.kind === 'vibe')
    if (hasCharacterReference) features.push('precise-reference')
    if (hasVibeReference) features.push('vibe-transfer')
    if ((params?.transparentBackground ?? input.snapshot.params.transparentBackground) === true) {
        features.push('transparent-background')
    }
    const providerCompatibility = queryNaiCompatibility({
        model: params?.model ?? input.snapshot.params.model,
        action,
        features,
        payloadBuilderRevision: CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
    })
    const estimatedCost = params === undefined
        ? null
        : calculateAnlasCost({
            model: params.model,
            width: params.width,
            height: params.height,
            steps: params.steps,
            imageCount: 1,
            pricingBasis: options.pricingBasis,
        }) * options.batchCount

    return Object.freeze({ resolution, diagnostics, estimatedCost, providerCompatibility })
}
