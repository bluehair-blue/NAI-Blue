import { sha256Utf8 } from '@/domain/composition/canonical-serialize'
import {
    createStyleEvaluationContext,
    type StyleEvaluationContext,
} from '@/domain/style-lab'
import { useAssetModuleStore } from '@/stores/asset-module-store'
import { useCharacterPromptStore } from '@/stores/character-prompt-store'
import { useCharacterStore } from '@/stores/character-store'
import { useFragmentStore } from '@/stores/fragment-store'
import { useGenerationStore } from '@/stores/generation-store'
import { usePresetStore } from '@/stores/preset-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useStyleLabStore } from '@/stores/style-lab-store'

function runtimeDigest(value: string | null | undefined): string | null {
    return value ? `sha256:${sha256Utf8(value)}` : null
}

function jsonSnapshot(value: unknown): unknown {
    // Store objects can contain explicit undefined optional fields, which canonical
    // JSON rejects. A JSON projection matches their actual persistence boundary.
    return JSON.parse(JSON.stringify(value)) as unknown
}

/**
 * This runtime adapter reads the live generation, prompt, reference, recipe,
 * and fragment stores. It excludes candidate tags, then the domain constructor
 * hashes the snapshot so both Arena candidates can be checked against one contract.
 */
export function captureCurrentStyleEvaluationContext(
    seedPack: readonly number[],
    createdAt = Date.now(),
): StyleEvaluationContext {
    const generation = useGenerationStore.getState()
    const styleLab = useStyleLabStore.getState()
    const characterPrompts = useCharacterPromptStore.getState()
    const references = useCharacterStore.getState()
    const settings = useSettingsStore.getState()
    const assetProfile = useAssetModuleStore.getState().profile
    const presets = usePresetStore.getState()
    const fragments = useFragmentStore.getState()

    const prompt = {
        template: styleLab.settings.promptTemplate,
        base: generation.basePrompt,
        additional: generation.additionalPrompt,
        detail: generation.detailPrompt,
        negative: generation.negativePrompt,
        inpainting: generation.i2iMode === 'inpaint' ? generation.inpaintingPrompt : '',
        characters: jsonSnapshot(characterPrompts.characters),
        characterPresets: jsonSnapshot(characterPrompts.presets),
        characterGroups: jsonSnapshot(characterPrompts.groups),
        characterPositionEnabled: characterPrompts.positionEnabled,
    }
    const referenceSnapshot = [
        ...references.characterImages.map(reference => ({ kind: 'character' as const, reference })),
        ...references.vibeImages.map(reference => ({ kind: 'vibe' as const, reference })),
    ].map(({ kind, reference }) => ({
        kind,
        id: reference.id,
        enabled: reference.enabled !== false,
        referenceType: reference.referenceType,
        strength: reference.strength,
        fidelity: reference.fidelity,
        informationExtracted: reference.informationExtracted,
        cacheKey: reference.cacheKey ?? null,
        thumbnailDigest: runtimeDigest(reference.thumbnail),
    }))
    const plan = {
        compositionMode: 'v2',
        params: {
            model: generation.model,
            width: generation.selectedResolution.width,
            height: generation.selectedResolution.height,
            steps: generation.steps,
            cfgScale: generation.cfgScale,
            cfgRescale: generation.cfgRescale,
            sampler: generation.sampler,
            scheduler: generation.scheduler,
            smea: generation.smea,
            smeaDyn: generation.smeaDyn,
            variety: generation.variety,
            qualityToggle: generation.qualityToggle,
            ucPreset: generation.ucPreset,
            sourceMode: generation.mask
                ? 'inpaint'
                : generation.sourceImage
                    ? 'image-to-image'
                    : 'text-to-image',
            strength: generation.strength,
            noise: generation.noise,
        },
        sourceImageDigest: runtimeDigest(generation.sourceImage),
        maskDigest: runtimeDigest(generation.mask),
        references: referenceSnapshot,
        assetProfile: jsonSnapshot(assetProfile),
        parameterPresets: jsonSnapshot({
            activePresetId: presets.activePresetId,
            presets: presets.presets,
        }),
        fragments: {
            files: jsonSnapshot(fragments.files),
            sequenceRevision: fragments.getSequenceSnapshot().revision,
        },
        output: {
            autoSave: settings.autoSave,
            imageFormat: settings.imageFormat,
            metadataMode: settings.metadataMode,
            styleLabSavePath: settings.styleLabSavePath,
            useAbsoluteStyleLabPath: settings.useAbsoluteStyleLabPath,
        },
    }

    return createStyleEvaluationContext({
        prompt,
        plan,
        model: generation.model,
        sampler: generation.sampler,
        seedPack,
        createdAt,
    })
}
