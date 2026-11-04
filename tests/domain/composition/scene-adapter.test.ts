import { describe, expect, it } from 'vitest'

import { createFragmentLookup } from '@/domain/composition/fragment-resolver'
import type { CompositionEnginePlan } from '@/domain/composition/engine'
import type { DeepReadonly } from '@/domain/composition/provenance'
import type { PromptContribution } from '@/domain/composition/types'
import {
    SCENE_DIRECT_RECIPE_ID,
    buildSceneResolveRequest,
    resolveSceneComposition,
    type BuildSceneCompositionInput,
    type SceneCompositionResolution,
    type SceneCompositionSnapshot,
} from '@/lib/composition/scene-adapter'
import type { AssetProfile } from '@/types/asset-profile'

const NOW = '2026-07-12T00:00:00.000Z' as const
const FIXED_SEED = 808080

function emptyProfile(): AssetProfile {
    return {
        revision: 9,
        updatedBy: 'agent',
        updatedAt: NOW,
        settings: {},
        output: {},
        r2: { enabled: false },
        modules: {},
        recipes: [],
    }
}

function defaultParams(): SceneCompositionSnapshot['params'] {
    return {
        model: 'nai-diffusion-4-5-full',
        width: 832,
        height: 1216,
        steps: 28,
        cfgScale: 5,
        cfgRescale: 0.4,
        sampler: 'k_euler_ancestral',
        scheduler: 'karras',
        smea: true,
        smeaDyn: true,
        variety: true,
        seed: FIXED_SEED,
        qualityToggle: true,
        ucPreset: 0,
        sourceMode: 'text-to-image',
        strength: 0.7,
        noise: 0,
        characterPositionEnabled: false,
    }
}

function baseSnapshot(): SceneCompositionSnapshot {
    return {
        profile: emptyProfile(),
        scene: {
            id: 'scene:old-card',
            name: 'Old scene',
            scenePrompt: '',
            createdAt: Date.parse(NOW),
        },
        preset: {
            id: 'preset:one',
            name: 'Preset One',
            sceneNumber: 1,
        },
        prompt: {
            base: '',
            inpainting: '',
            additional: '',
            detail: '',
            negative: '',
        },
        characters: [],
        positionEnabled: false,
        references: [],
        params: defaultParams(),
        output: {
            autoSave: true,
            savePath: 'NAI_Blue_Scene',
            useAbsolutePath: false,
            imageFormat: 'png',
            metadataMode: 'embedded',
        },
        source: {
            hasSourceImage: false,
            hasMask: false,
            width: 832,
            height: 1216,
            strength: 0.7,
            noise: 0,
        },
    }
}

function adapterInput(snapshot: SceneCompositionSnapshot): BuildSceneCompositionInput {
    return {
        snapshot,
        requestId: 'scene-request:fixed',
        now: NOW,
        seed: FIXED_SEED,
        fragment: {
            lookup: createFragmentLookup([]),
            sequenceSnapshot: { revision: 0, counters: {} },
            mode: 'generate',
            strictness: 'strict',
            maxRecursion: 10,
        },
    }
}

function successfulPlan(
    resolution: SceneCompositionResolution,
): DeepReadonly<CompositionEnginePlan> {
    expect(resolution.result.success).toBe(true)
    if (!resolution.result.success) {
        throw new Error(
            `Expected Scene composition success: ${resolution.result.errors.map(issue => issue.code).join(', ')}`,
        )
    }
    return resolution.result.plan
}

function sceneContribution(
    id: string,
    slot: 'base' | 'additional' | 'workflow' | 'detail',
    text: string,
    merge: PromptContribution['merge'] = 'append',
): PromptContribution {
    const actor = { kind: 'user' as const, id: 'scene-test:user' }
    return {
        id,
        orderKey: `zz:${id}`,
        revision: 0,
        createdAt: NOW,
        createdBy: actor,
        updatedAt: NOW,
        updatedBy: actor,
        enabled: true,
        target: { kind: 'positive', slot },
        text,
        merge,
        separator: 'comma-space',
    }
}

function recipeProfile(recipeId = 'recipe:common'): AssetProfile {
    return {
        ...emptyProfile(),
        modules: {
            common: {
                id: 'common',
                enabled: true,
                kind: 'prompt',
                prompts: {
                    'main.base': 'recipe base',
                    'main.additional': 'recipe additional',
                    'main.detail': 'recipe detail',
                    'main.negative': 'recipe negative',
                },
                settings: {
                    cfgRescale: 0.2,
                    smea: true,
                    variety: true,
                },
            },
        },
        recipes: [{
            id: recipeId,
            enabled: true,
            label: 'Common recipe',
            steps: [{ moduleId: 'common' }],
            settings: {
                cfgRescale: 0.1,
                smea: true,
                variety: true,
            },
        }],
    }
}

describe('Scene composition direct adapter', () => {
    it('binds verbatim processing into the plan hash even when canonical text happens to be identical', () => {
        const snapshot = baseSnapshot()
        snapshot.prompt.base = 'fixed style'
        snapshot.prompt.negative = 'fixed negative'
        snapshot.params.ucPreset = 4
        snapshot.params.qualityToggle = false
        const standard = successfulPlan(resolveSceneComposition(adapterInput(snapshot)))
        snapshot.scene.promptTextMode = 'verbatim'
        const verbatim = successfulPlan(resolveSceneComposition(adapterInput(snapshot)))
        expect(verbatim.positivePrompt).toBe(standard.positivePrompt)
        expect(verbatim.negativePrompt).toBe(standard.negativePrompt)
        expect(verbatim.promptTextMode).toBe('verbatim')
        expect(verbatim.planHash.digest).not.toBe(standard.planHash.digest)
    })

    it('accepts an old SceneCard snapshot without compositionRef', () => {
        const snapshot = baseSnapshot()
        snapshot.prompt.base = 'common prompt'
        snapshot.scene.scenePrompt = 'legacy scene prompt'

        expect(snapshot.scene).not.toHaveProperty('compositionRef')

        const built = buildSceneResolveRequest(adapterInput(snapshot))
        const plan = successfulPlan(resolveSceneComposition(adapterInput(snapshot)))

        expect(built.selectedRecipeId).toBe(built.directRecipeId)
        expect(plan.recipeId).toBe(built.directRecipeId)
        expect(plan.promptParts.workflow).toBe('legacy scene prompt')
        expect(plan.positivePrompt).toBe('common prompt, legacy scene prompt')
    })

    it('maps the legacy scene prompt to workflow in canonical slot order', () => {
        const snapshot = baseSnapshot()
        snapshot.prompt = {
            base: 'base prompt',
            inpainting: 'inpainting prompt',
            additional: 'additional prompt',
            detail: 'detail prompt',
            negative: 'negative prompt',
        }
        snapshot.scene.scenePrompt = 'scene workflow prompt'

        const built = buildSceneResolveRequest(adapterInput(snapshot))
        const workflow = built.request.contributions.find(contribution => (
            contribution.id === 'scene:scene:old-card:workflow'
        ))
        const plan = successfulPlan(resolveSceneComposition(adapterInput(snapshot)))

        expect(workflow).toMatchObject({
            target: { kind: 'positive', slot: 'workflow' },
            text: 'scene workflow prompt',
            merge: 'append',
        })
        expect(plan.promptParts).toMatchObject({
            base: 'base prompt',
            inpainting: 'inpainting prompt',
            additional: 'additional prompt',
            workflow: 'scene workflow prompt',
            detail: 'detail prompt',
            negative: 'negative prompt',
        })
        expect(plan.positivePrompt).toBe(
            'base prompt, inpainting prompt, additional prompt, scene workflow prompt, detail prompt',
        )
        expect(plan.negativePrompt).toBe('negative prompt')
    })
})

describe('Scene composition recipe and override adapter', () => {
    it('combines an explicit common recipe with scene-local contributions', () => {
        const snapshot = baseSnapshot()
        snapshot.profile = recipeProfile()
        snapshot.prompt.base = 'direct prompt cleared by recipe'
        snapshot.scene.scenePrompt = 'scene workflow'
        snapshot.scene.compositionRef = {
            recipeId: 'recipe:common',
            recipeRevision: 9,
            sceneContributions: [
                sceneContribution('scene:replace-base', 'base', 'scene-specific base', 'replace'),
                sceneContribution('scene:extra-detail', 'detail', 'scene-specific detail'),
            ],
        }

        const built = buildSceneResolveRequest(adapterInput(snapshot))
        const plan = successfulPlan(resolveSceneComposition(adapterInput(snapshot)))

        expect(built.request.recipeId).toBe('recipe:common')
        expect(plan.recipeId).toBe('recipe:common')
        expect(plan.promptParts).toMatchObject({
            base: 'scene-specific base',
            additional: 'recipe additional',
            workflow: 'scene workflow',
            detail: 'recipe detail, scene-specific detail',
            negative: 'recipe negative',
        })
        expect(plan.positivePrompt).toBe(
            'scene-specific base, recipe additional, scene workflow, recipe detail, scene-specific detail',
        )
    })

    it('preserves explicit false and zero values at the scene precedence layer', () => {
        const snapshot = baseSnapshot()
        snapshot.profile = recipeProfile()
        snapshot.scene.compositionRef = {
            recipeId: 'recipe:common',
            paramsOverride: {
                cfgRescale: 0,
                smea: false,
                variety: false,
            },
        }

        const plan = successfulPlan(resolveSceneComposition(adapterInput(snapshot)))

        expect(plan.params).toMatchObject({
            cfgRescale: 0,
            smea: false,
            variety: false,
        })
        for (const field of ['cfgRescale', 'smea', 'variety'] as const) {
            expect(plan.provenanceDetails.params.find(item => item.field === field)?.winner.layer)
                .toBe('scene-override')
        }
    })

    it('keeps raw stored recipe IDs distinct from the explicit direct selection', () => {
        const storedRecipeId = SCENE_DIRECT_RECIPE_ID
        const recipeSnapshot = baseSnapshot()
        recipeSnapshot.profile = recipeProfile(storedRecipeId)
        recipeSnapshot.scene.compositionRef = { recipeId: storedRecipeId }

        const recipeBuild = buildSceneResolveRequest(adapterInput(recipeSnapshot))
        const recipePlan = successfulPlan(resolveSceneComposition(adapterInput(recipeSnapshot)))

        expect(recipeBuild.request.recipeId).toBe(storedRecipeId)
        expect(recipeBuild.selectedRecipeId).toBe(storedRecipeId)
        expect(recipePlan.recipeId).toBe(storedRecipeId)
        expect(recipePlan.positivePrompt).toContain('recipe base')

        const directSnapshot = structuredClone(recipeSnapshot)
        directSnapshot.prompt.base = 'explicit direct prompt'
        directSnapshot.scene.compositionRef = {
            recipeId: SCENE_DIRECT_RECIPE_ID,
            selectionKind: 'direct',
        }

        const directBuild = buildSceneResolveRequest(adapterInput(directSnapshot))
        const directPlan = successfulPlan(resolveSceneComposition(adapterInput(directSnapshot)))

        expect(directBuild.selectedRecipeId).toBe(directBuild.directRecipeId)
        expect(directBuild.selectedRecipeId).not.toBe(storedRecipeId)
        expect(directPlan.positivePrompt).toBe('explicit direct prompt')
    })
})

describe('Scene runtime character rotation adapter', () => {
    it('applies only transient character patches and records the selected source/result', () => {
        const snapshot = baseSnapshot()
        snapshot.characters = [
            {
                id: 'character:alpha',
                name: 'Alpha',
                prompt: 'alpha prompt',
                negative: '',
                enabled: true,
                position: { x: 0.5, y: 0.5 },
            },
            {
                id: 'character:beta',
                name: 'Beta',
                prompt: 'beta prompt',
                negative: '',
                enabled: false,
                position: { x: 0.5, y: 0.5 },
            },
        ]
        const input: BuildSceneCompositionInput = {
            ...adapterInput(snapshot),
            runtimeCharacterOverride: {
                characterPatches: [
                    { characterId: 'character:alpha', enabled: false },
                    { characterId: 'character:beta', enabled: true },
                ],
                randomTrace: {
                    ruleId: 'rotation:scene:old-card',
                    streamKey: 'character-rotation:preset:one',
                    drawIndex: 1,
                    seed: FIXED_SEED,
                    result: 'character:beta',
                    selectedOptionIds: ['character:beta'],
                    extensions: {
                        source: 'rotation-store-sequence',
                        currentIndex: 1,
                        currentRepeat: 0,
                    },
                },
            },
        }

        const built = buildSceneResolveRequest(input)
        const plan = successfulPlan(resolveSceneComposition(input))

        expect(snapshot.characters.map(character => character.enabled)).toEqual([true, false])
        expect(built.request.characterPatches.slice(-2)).toEqual(
            input.runtimeCharacterOverride?.characterPatches,
        )
        expect(plan.characters.map(character => ({
            id: character.characterId,
            enabled: character.enabled,
        }))).toEqual([
            { id: 'character:alpha', enabled: false },
            { id: 'character:beta', enabled: true },
        ])
        expect(plan.randomTrace).toContainEqual(expect.objectContaining({
            ruleId: 'rotation:scene:old-card',
            streamKey: 'character-rotation:preset:one',
            drawIndex: 1,
            seed: FIXED_SEED,
            result: 'character:beta',
            selectedOptionIds: ['rotation:scene:old-card:selected'],
            extensions: expect.objectContaining({ source: 'rotation-store-sequence' }),
        }))
    })
})
