import { useCharacterStore } from '@/stores/character-store'
import { useCharacterPromptStore } from '@/stores/character-prompt-store'
import { useGenerationStore } from '@/stores/generation-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useRotationStore } from '@/stores/character-rotation-store'
import {
    resolveSceneCharacterCaptions,
    resolveSceneGeneration,
    resolveScenePrompts,
    useSceneStore,
    type SceneCard,
} from '@/stores/scene-store'
import { type GenerationParams } from '@/services/novelai-api'
import { createWildcardResolutionSession } from '@/lib/fragment-processor'
import type { FragmentSequenceCommitProposal } from '@/domain/composition/fragment-resolver'
import type { DeepReadonly } from '@/domain/composition/provenance'
import { useAssetModuleStore } from '@/stores/asset-module-store'
import { resolveAssetModulePlan, type AssetModulePlan } from '@/lib/asset-modules/resolver'
import { generateRandomSeed } from '@/lib/utils'

export interface SceneGenerationBuildResult {
    params: GenerationParams
    finalPrompt: string
    mimeType: string
    sequenceCommitProposal: DeepReadonly<FragmentSequenceCommitProposal> | null
}

const roundTo64 = (value: number): number => Math.round(value / 64) * 64

const removeComments = (text: string) => text
    .split('\n')
    .filter(line => !line.trimStart().startsWith('#'))
    .join('\n')

export async function resolveLegacySceneAssetModulePlan(
    scene: SceneCard,
    seed: number,
    options: {
        recipeId?: string
        presetId?: string
        now?: Date
        wildcardProcessor?: (prompt: string) => string | Promise<string>
    } = {},
): Promise<AssetModulePlan | null> {
    const profile = useAssetModuleStore.getState().profile
    if (!profile.recipes.some(recipe => recipe.enabled)) return null

    const sceneState = useSceneStore.getState()
    // Queue Center supplies presetId so filename/module snapshots retain the
    // selected folder even when it is not the UI's active preset.
    const targetPresetId = options.presetId ?? sceneState.activePresetId
    const activePreset = targetPresetId
        ? sceneState.presets.find(preset => preset.id === targetPresetId)
        : undefined
    const sceneNumber = activePreset
        ? activePreset.scenes.findIndex(item => item.id === scene.id) + 1
        : undefined

    try {
        const plan = await resolveAssetModulePlan({
            profile,
            recipeId: options.recipeId,
            seed,
            now: options.now,
            wildcardProcessor: options.wildcardProcessor,
            baseParams: {
                prompt: '',
                negative_prompt: '',
            },
            filenameContext: {
                seed,
                scene: {
                    id: scene.id,
                    name: scene.name,
                    number: sceneNumber && sceneNumber > 0 ? sceneNumber : undefined,
                },
                preset: activePreset
                    ? { id: activePreset.id, name: activePreset.name }
                    : undefined,
            },
        })

        return plan.recipe && plan.modules.length > 0 ? plan : null
    } catch (error) {
        console.warn('[AssetModules] Failed to resolve scene generation plan; falling back to scene prompts.', error)
        return null
    }
}

// useSceneGeneration workers call this helper before the NovelAI API request.
// It keeps B's existing scene parameter sources together: generation settings,
// character/vibe image memory, scene text, and rotation pinned-character state.
export function selectSceneGenerationSeed(seedLocked: boolean, seed: number): number {
    return seedLocked && seed !== 0 ? seed : generateRandomSeed()
}

export async function buildLegacySceneGenerationParams(
    scene: SceneCard,
    options: { presetId?: string; seed?: number } = {},
): Promise<SceneGenerationBuildResult> {
    const genState = useGenerationStore.getState()
    // Queue review/replay supplies a seed: wildcard choices must replay with the same
    // Scene identity. Unseeded direct legacy generation keeps its existing random session.
    const fragmentSession = createWildcardResolutionSession(options.seed === undefined ? {} : {
        seed: options.seed, scope: `scene:${options.presetId ?? ''}:${scene.id}`,
    })
    const scenePrompts = resolveScenePrompts(scene)
    const sceneGeneration = resolveSceneGeneration(scene)

    const finalSeed = options.seed ?? selectSceneGenerationSeed(sceneGeneration.seedLocked, sceneGeneration.seed)

    // Scene is the prompt-module authority. Asset recipes and Main prompt-panel
    // values are intentionally excluded from Scene generation.
    const parts = [
        removeComments(scenePrompts.base),
        removeComments(scenePrompts.additional),
    ].filter(p => p && p.trim())
    const finalPrompt = await fragmentSession.process(parts.join(', '))
    const finalNegativePrompt = removeComments(scenePrompts.negative)

    // CharacterStore owns lazy file-backed image loading. Workers must force
    // this load before building char/vibe arrays, and useSceneGeneration later
    // releases the same data once the last worker exits.
    await useCharacterStore.getState().ensureImagesLoaded()
    const latestCharStore = useCharacterStore.getState()
    const characterImages = latestCharStore.characterImages.filter(img => img.enabled !== false && img.base64)
    const vibeImages = latestCharStore.vibeImages.filter(img => img.enabled !== false && img.base64)
    const rotation = useRotationStore.getState()
    const characterState = useCharacterPromptStore.getState()
    const excludedPinnedIds = rotation.active && scene.excludePinned
        ? new Set(rotation.pinnedCharacterIds)
        : null
    const sceneCharacterCaptions = resolveSceneCharacterCaptions(scene)
    const processedCharacterPrompts = rotation.active
        ? await Promise.all(characterState.characters
            .filter(character => character.enabled && !excludedPinnedIds?.has(character.id))
            .map(async character => ({
                stableId: character.id,
                prompt: await fragmentSession.process(character.prompt),
                negative: await fragmentSession.process(character.negative),
                enabled: true,
                position: character.position,
            })))
        : await Promise.all(sceneCharacterCaptions
            .filter(character => character.enabled)
            .map(async character => ({
                stableId: character.id,
                prompt: await fragmentSession.process(character.prompt),
                negative: await fragmentSession.process(character.negative),
                enabled: true,
                position: character.position,
            })))

    let finalWidth = roundTo64(scene.width || genState.selectedResolution.width)
    let finalHeight = roundTo64(scene.height || genState.selectedResolution.height)

    if (genState.sourceImage) {
        try {
            const img = new Image()
            await new Promise<void>((resolve, reject) => {
                img.onload = () => resolve()
                img.onerror = () => reject(new Error('Failed to load source image'))
                img.src = genState.sourceImage!
            })
            finalWidth = roundTo64(img.width)
            finalHeight = roundTo64(img.height)
            console.log(`[SceneGeneration] Using source image dimensions: ${img.width}x${img.height} -> ${finalWidth}x${finalHeight}`)
            img.src = ''
        } catch {
            console.warn('[SceneGeneration] Failed to get source image dimensions, using scene/global resolution')
        }
    }

    const { imageFormat, metadataMode } = useSettingsStore.getState()
    // Scene policy overrides Settings so folder templates and per-Scene toggles survive every builder path.
    const effectiveMetadataMode = scene.metadataMode ?? metadataMode
    const mimeType = imageFormat === 'webp' ? 'image/webp' : 'image/png'
    const characterImagesWithData = characterImages.filter(img => img.base64)
    const vibeImagesWithData = vibeImages.filter(img => img.base64)

    return {
        finalPrompt,
        mimeType,
        sequenceCommitProposal: fragmentSession.sequenceCommitProposal,
        params: {
            prompt: finalPrompt,
            negative_prompt: finalNegativePrompt,
            steps: sceneGeneration.steps,
            cfg_scale: sceneGeneration.cfgScale,
            cfg_rescale: sceneGeneration.cfgRescale,
            sampler: sceneGeneration.sampler,
            scheduler: sceneGeneration.scheduler,
            smea: sceneGeneration.smea,
            smea_dyn: sceneGeneration.smeaDyn,
            variety: sceneGeneration.variety,
            seed: finalSeed,
            width: finalWidth,
            height: finalHeight,
            model: sceneGeneration.model,
            sourceImage: genState.sourceImage || undefined,
            strength: genState.strength,
            noise: genState.noise,
            mask: genState.mask || undefined,
            charImages: characterImagesWithData.map(img => img.base64!),
            charStrength: characterImagesWithData.map(img => img.strength),
            charFidelity: characterImagesWithData.map(img => img.fidelity ?? 0.6),
            charReferenceType: characterImagesWithData.map(img => img.referenceType ?? 'character&style'),
            charCacheKeys: characterImagesWithData.map(img => img.cacheKey || null),
            vibeImages: vibeImagesWithData.map(img => img.base64!),
            vibeInfo: vibeImagesWithData.map(img => img.informationExtracted),
            vibeStrength: vibeImagesWithData.map(img => img.strength),
            preEncodedVibes: vibeImagesWithData.map(img => img.encodedVibe || null),
            characterPrompts: processedCharacterPrompts,
            characterPositionEnabled: rotation.active
                ? characterState.positionEnabled
                : scene.characterPositionEnabled === true,
            imageFormat,
            metadataMode: effectiveMetadataMode,
            qualityToggle: sceneGeneration.qualityToggle,
            ucPreset: sceneGeneration.ucPreset,
            promptParts: {
                base: scenePrompts.base,
                additional: scenePrompts.additional,
                detail: '',
                negative: scenePrompts.negative,
                inpainting: '',
            },
        },
    }
}
