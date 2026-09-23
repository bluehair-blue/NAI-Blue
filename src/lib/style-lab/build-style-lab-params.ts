import type {
    CompositionEngineIssue,
    CompositionEnginePlan,
} from '@/domain/composition/engine'
import type { FragmentSequenceCommitProposal } from '@/domain/composition/fragment-resolver'
import type { DeepReadonly } from '@/domain/composition/provenance'
import type { ResolvedGenerationParams } from '@/domain/composition/types'
import { sha256Utf8 } from '@/domain/composition/canonical-serialize'
import {
    resolveStyleLabComposition,
    type StyleLabCombinationProvenance,
} from '@/lib/composition/style-lab-adapter'
import {
    createStoreFragmentResolverInput,
} from '@/lib/fragment-processor'
import {
    createCharacterStoreResourceRepository,
    useCharacterStore,
} from '@/stores/character-store'
import { useCharacterPromptStore } from '@/stores/character-prompt-store'
import { useAssetModuleStore } from '@/stores/asset-module-store'
import { useGenerationStore } from '@/stores/generation-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useStyleLabStore, type StyleCombination } from '@/stores/style-lab-store'
import type { GenerationParams } from '@/services/novelai-api'
import type { MainReferenceSnapshot } from '@/lib/composition/main-adapter'
import type { StyleLabCompositionMode } from './composition-mode'
import { materializeStyleLabPlanForNai } from './materialize-style-lab-plan'
import { runtimeCapabilities } from '@/platform/capabilities'

export interface BuildStyleLabGenerationOptions {
    /** Accepted for older callers; all requests use the canonical V2 runtime. */
    mode?: StyleLabCompositionMode
    seed?: number
    now?: Date
    requestId?: string
    /** Adapter test/recovery hook; production uses the injected Style Lab recipe. */
    selectedRecipeId?: string
}

interface StyleLabGenerationBuildBase {
    mode: StyleLabCompositionMode
    warnings: readonly DeepReadonly<CompositionEngineIssue>[]
    errors: readonly DeepReadonly<CompositionEngineIssue>[]
}

export interface StyleLabGenerationBuildSuccess extends StyleLabGenerationBuildBase {
    success: true
    params: GenerationParams
    prompt: string
    seed: number
    plan: DeepReadonly<CompositionEnginePlan> | null
    sourceRevision: number | null
    combinationProvenance: StyleLabCombinationProvenance | null
    sequenceCommitProposal: DeepReadonly<FragmentSequenceCommitProposal> | null
}

export interface StyleLabGenerationBuildFailure extends StyleLabGenerationBuildBase {
    success: false
    plan: null
    sourceRevision: number | null
    combinationProvenance: StyleLabCombinationProvenance | null
    sequenceCommitProposal: null
}

export type StyleLabGenerationBuildResult =
    | StyleLabGenerationBuildSuccess
    | StyleLabGenerationBuildFailure

const roundTo64 = (value: number): number => Math.round(value / 64) * 64

function getImageDimensions(base64: string): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = () => {
            const dimensions = { width: image.width, height: image.height }
            image.src = ''
            resolve(dimensions)
        }
        image.onerror = () => {
            image.src = ''
            reject(new Error('Failed to load source image'))
        }
        image.src = base64
    })
}

function collectStringValues(value: unknown, seen = new Set<object>()): string[] {
    if (typeof value === 'string') return [value]
    if (value === null || typeof value !== 'object' || seen.has(value)) return []
    seen.add(value)
    if (Array.isArray(value)) return value.flatMap(item => collectStringValues(item, seen))
    return Object.values(value).flatMap(item => collectStringValues(item, seen))
}

function runtimeDigest(value: string | null | undefined): string | undefined {
    return value ? `sha256:${sha256Utf8(value)}` : undefined
}

function referenceSnapshots(): MainReferenceSnapshot[] {
    const state = useCharacterStore.getState()
    return [
        ...state.characterImages.map(image => ({
            id: image.id,
            enabled: image.enabled !== false,
            kind: 'character' as const,
            referenceType: image.referenceType,
            strength: image.strength,
            fidelity: image.fidelity,
            informationExtracted: image.informationExtracted,
            digest: runtimeDigest(image.thumbnail),
        })),
        ...state.vibeImages.map(image => ({
            id: image.id,
            enabled: image.enabled !== false,
            kind: 'vibe' as const,
            referenceType: image.referenceType,
            strength: image.strength,
            fidelity: image.fidelity,
            informationExtracted: image.informationExtracted,
            digest: runtimeDigest(image.thumbnail),
        })),
    ]
}

function selectedRuntimeSeed(seed: number, locked: boolean): number {
    // The workflow chooses a source seed; CompositionEngine owns numeric
    // normalization, including the deterministic zero-seed case.
    return locked ? seed : Math.floor(Math.random() * 4294967295)
}

export function formatStyleLabCompositionErrors(
    errors: readonly DeepReadonly<CompositionEngineIssue>[],
): string {
    if (errors.length === 0) return 'Invalid Style Lab composition plan'
    return errors.map(error => {
        const path = error.fieldPath.length === 0 ? '' : ` @ ${error.fieldPath.join('.')}`
        return `[${error.code}]${path}`
    }).join('; ')
}

export async function buildStyleLabGenerationParams(
    combination: StyleCombination,
    options: BuildStyleLabGenerationOptions = {},
): Promise<StyleLabGenerationBuildResult> {
    const generation = useGenerationStore.getState()
    const now = options.now ?? new Date()
    const seed = options.seed ?? selectedRuntimeSeed(generation.seed, generation.seedLocked)
    const sourceImage = generation.sourceImage
    const mask = generation.mask
    let width = roundTo64(generation.selectedResolution.width)
    let height = roundTo64(generation.selectedResolution.height)
    if (sourceImage) {
        try {
            const dimensions = await getImageDimensions(sourceImage)
            width = roundTo64(dimensions.width)
            height = roundTo64(dimensions.height)
        } catch (error) {
            console.warn('[StyleLab] Failed to read source image dimensions:', error)
        }
    }

    const characterPrompt = useCharacterPromptStore.getState()
    const styleLab = useStyleLabStore.getState()
    const settings = useSettingsStore.getState()
    const profile = useAssetModuleStore.getState().profile
    const { usePresetStore } = await import('@/stores/preset-store')
    const presets = usePresetStore.getState()
    const params: ResolvedGenerationParams = {
        model: generation.model,
        width: roundTo64(generation.selectedResolution.width),
        height: roundTo64(generation.selectedResolution.height),
        steps: generation.steps,
        cfgScale: generation.cfgScale,
        cfgRescale: generation.cfgRescale,
        sampler: generation.sampler,
        scheduler: generation.scheduler,
        smea: generation.smea,
        smeaDyn: generation.smeaDyn,
        variety: generation.variety,
        seed,
        qualityToggle: generation.qualityToggle,
        ucPreset: generation.ucPreset,
        transparentBackground: false,
        sourceMode: mask ? 'inpaint' : sourceImage ? 'image-to-image' : 'text-to-image',
        strength: generation.strength,
        noise: generation.noise,
        characterPositionEnabled: characterPrompt.positionEnabled,
    }
    const prompt = {
        base: generation.basePrompt,
        inpainting: generation.i2iMode === 'inpaint' ? generation.inpaintingPrompt : '',
        additional: generation.additionalPrompt,
        detail: generation.detailPrompt,
        negative: generation.negativePrompt,
    }
    const fragment = await createStoreFragmentResolverInput(collectStringValues({
        prompt,
        characters: characterPrompt.characters,
        promptTemplate: styleLab.settings.promptTemplate,
        combination: combination.tags,
    }), {
        mode: 'generate',
        strictness: 'compatible',
        maxRecursion: 10,
    })
    const resolution = resolveStyleLabComposition({
        snapshot: {
            profile,
            selectedRecipeId: null,
            prompt,
            characters: characterPrompt.characters,
            characterPresets: characterPrompt.presets,
            characterGroups: characterPrompt.groups,
            positionEnabled: characterPrompt.positionEnabled,
            references: referenceSnapshots(),
            paramsPresets: presets.presets,
            activeParamsPresetId: presets.activePresetId,
            params,
            output: {
                autoSave: settings.autoSave,
                savePath: settings.styleLabSavePath,
                useAbsolutePath: settings.useAbsoluteStyleLabPath,
                imageFormat: settings.imageFormat,
                metadataMode: settings.metadataMode,
                portableRoot: runtimeCapabilities.absoluteOutputPath.supported
                    ? 'pictures'
                    : 'app-data',
            },
            source: {
                hasSourceImage: Boolean(sourceImage),
                hasMask: Boolean(mask),
                sourceImageDigest: runtimeDigest(sourceImage),
                maskDigest: runtimeDigest(mask),
                width,
                height,
                strength: generation.strength,
                noise: generation.noise,
            },
        },
        combination: { id: combination.id, tags: combination.tags },
        promptTemplate: styleLab.settings.promptTemplate,
        requestId: options.requestId ?? `style-lab:${combination.id}:${seed}`,
        now: now.toISOString(),
        seed,
        fragment,
        selectedRecipeId: options.selectedRecipeId,
    })
    if (!resolution.result.success) {
        return {
            success: false,
            mode: 'v2',
            plan: null,
            sourceRevision: profile.revision,
            combinationProvenance: resolution.combination,
            warnings: resolution.result.warnings,
            errors: resolution.result.errors,
            sequenceCommitProposal: null,
        }
    }

    const plan = resolution.result.plan
    const materialized = await materializeStyleLabPlanForNai({
        plan,
        sourceImage,
        mask,
        imageFormat: settings.imageFormat,
        metadataMode: settings.metadataMode,
        useAbsolutePath: settings.useAbsoluteStyleLabPath,
        enforcePortability: true,
        repository: createCharacterStoreResourceRepository(),
    })
    return {
        success: true,
        mode: 'v2',
        params: materialized,
        prompt: plan.positivePrompt,
        seed: plan.params.seed,
        plan,
        sourceRevision: plan.documentRevision,
        combinationProvenance: resolution.combination,
        sequenceCommitProposal: resolution.result.sequenceCommitProposal,
        warnings: resolution.result.warnings,
        errors: [],
    }
}
