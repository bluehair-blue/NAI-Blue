import { describe, expect, it, vi } from 'vitest'

import { createFragmentLookup } from '@/domain/composition/fragment-resolver'
import type { CompositionEnginePlan } from '@/domain/composition/engine'
import type { DeepReadonly } from '@/domain/composition/provenance'
import {
    MAIN_COMPOSITION_PROFILE_ID,
    MAIN_DIRECT_RECIPE_ID,
    MAIN_DIRECT_SELECTION_ID,
    buildMainResolveRequest,
    getMainDirectRecipeId,
    mainAssetRecipeSelectionId,
    resolveMainComposition,
    type BuildMainCompositionInput,
    type MainCompositionResolution,
    type MainCompositionSnapshot,
} from '@/lib/composition/main-adapter'
import type { AssetProfile } from '@/types/asset-profile'
import { setRuntimeCompositionDocument } from '@/lib/composition-authority'

const NOW = '2026-07-12T00:00:00.000Z' as const
const FIXED_SEED = 424242

function emptyProfile(): AssetProfile {
    return {
        revision: 7,
        updatedBy: 'agent',
        updatedAt: NOW,
        settings: {},
        output: {},
        r2: { enabled: false },
        modules: {},
        recipes: [],
    }
}

function defaultParams(): MainCompositionSnapshot['params'] {
    return {
        model: 'nai-diffusion-4-5-full',
        width: 832,
        height: 1216,
        steps: 28,
        cfgScale: 5,
        cfgRescale: 0,
        sampler: 'k_euler_ancestral',
        scheduler: 'karras',
        smea: true,
        smeaDyn: true,
        variety: false,
        seed: FIXED_SEED,
        qualityToggle: true,
        ucPreset: 0,
        sourceMode: 'text-to-image',
        strength: 0.7,
        noise: 0,
        characterPositionEnabled: false,
    }
}

function baseSnapshot(): MainCompositionSnapshot {
    return {
        profile: emptyProfile(),
        selectedRecipeId: null,
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
            autoSave: false,
            savePath: 'NAI_Blue_Output',
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

function adapterInput(
    snapshot: MainCompositionSnapshot,
    seed = FIXED_SEED,
): BuildMainCompositionInput {
    return {
        snapshot,
        requestId: 'main-request:fixed',
        now: NOW,
        seed,
        fragment: {
            lookup: createFragmentLookup([]),
            sequenceSnapshot: { revision: 0, counters: {} },
            mode: 'generate',
            strictness: 'strict',
            maxRecursion: 10,
        },
    }
}

function successfulPlan(resolution: MainCompositionResolution): DeepReadonly<CompositionEnginePlan> {
    if (!resolution.result.success) {
        throw new Error(`Expected Main composition success: ${resolution.result.errors.map(issue => issue.code).join(', ')}`)
    }
    expect(resolution.result.success).toBe(true)
    return resolution.result.plan
}

function singlePromptProfile(options: {
    recipeId?: string
    prompt: string
    negative?: string
}): AssetProfile {
    const recipeId = options.recipeId ?? 'asset-recipe:one'
    return {
        ...emptyProfile(),
        modules: {
            subject: {
                id: 'subject',
                enabled: true,
                kind: 'prompt',
                prompts: {
                    'main.base': options.prompt,
                    ...(options.negative === undefined
                        ? {}
                        : { 'main.negative': options.negative }),
                },
                settings: {},
            },
        },
        recipes: [{
            id: recipeId,
            enabled: true,
            steps: [{ moduleId: 'subject' }],
        }],
    }
}

describe('CompositionRepository runtime authority', () => {
    it('keeps repository document authority while overlaying live Asset Profile edits', () => {
        const repositorySnapshot = baseSnapshot()
        repositorySnapshot.profile = singlePromptProfile({
            recipeId: 'asset-recipe:stable',
            prompt: 'repository subject',
        })
        const repositoryDocument = buildMainResolveRequest(adapterInput(repositorySnapshot)).request.document
        repositoryDocument.id = 'repository:verified-document'

        const liveSnapshot = baseSnapshot()
        liveSnapshot.profile = singlePromptProfile({
            recipeId: 'asset-recipe:stable',
            prompt: 'live edited subject',
        })

        setRuntimeCompositionDocument(repositoryDocument)
        try {
            const built = buildMainResolveRequest(adapterInput(liveSnapshot))
            const plan = successfulPlan(resolveMainComposition(adapterInput(liveSnapshot)))

            expect(built.request.document.id).toBe('repository:verified-document')
            expect(built.request.document.revision).toBe(repositoryDocument.revision)
            expect(plan.documentId).toBe('repository:verified-document')
            expect(plan.positivePrompt).toBe('live edited subject')
            expect(plan.positivePrompt).not.toContain('repository subject')
        } finally {
            setRuntimeCompositionDocument(null)
        }
    })

    it('keeps migrated character-index targets on stable IDs across reorder and delete', () => {
        const repositorySnapshot = baseSnapshot()
        repositorySnapshot.profile = singlePromptProfile({
            recipeId: 'asset-recipe:cast',
            prompt: 'unused',
        })
        repositorySnapshot.profile.modules.subject.prompts = {
            'v4.char.1.positive': 'character focus',
        }
        repositorySnapshot.characters = [
            {
                id: 'character:alpha',
                name: 'Alpha',
                prompt: 'alpha prompt',
                negative: '',
                enabled: true,
                position: { mode: 'manual', x: 0.25, y: 0.5 },
            },
            {
                id: 'character:beta',
                name: 'Beta',
                prompt: 'beta prompt',
                negative: '',
                enabled: true,
                position: { mode: 'manual', x: 0.75, y: 0.5 },
            },
        ]
        repositorySnapshot.positionEnabled = true
        repositorySnapshot.params = {
            ...repositorySnapshot.params,
            characterPositionEnabled: true,
        }
        const repositoryDocument = buildMainResolveRequest(adapterInput(repositorySnapshot)).request.document
        repositoryDocument.profiles[0].characterIds = ['character:alpha', 'character:beta']

        setRuntimeCompositionDocument(repositoryDocument)
        try {
            const reordered = {
                ...repositorySnapshot,
                characters: [repositorySnapshot.characters[1], repositorySnapshot.characters[0]],
            }
            const reorderedPlan = successfulPlan(resolveMainComposition(adapterInput(reordered)))
            expect(reorderedPlan.characters.map(character => character.characterId)).toEqual(['character:beta'])
            expect(reorderedPlan.characters[0].positive).toContain('character focus')

            const afterDelete = {
                ...repositorySnapshot,
                characters: [repositorySnapshot.characters[0]],
            }
            const deletedRequest = buildMainResolveRequest(adapterInput(afterDelete)).request
            const target = deletedRequest.document.recipes
                .find(recipe => recipe.id === 'asset-recipe:cast')
                ?.steps.flatMap(step => step.contributions)
                .find(item => item.target.kind === 'character')
                ?.target
            expect(target).toMatchObject({ kind: 'character', characterId: 'character:beta' })

            const deletedResolution = resolveMainComposition(adapterInput(afterDelete))
            expect(deletedResolution.result.success).toBe(false)
            if (!deletedResolution.result.success) {
                expect(deletedResolution.result.errors.map(error => error.code))
                    .toContain('E_CHARACTER_REF_MISSING')
            }
        } finally {
            setRuntimeCompositionDocument(null)
        }
    })

    it('preserves migrated Scene sidecars while live Asset entities are replaced', () => {
        const migratedSnapshot = baseSnapshot()
        migratedSnapshot.profile = singlePromptProfile({
            recipeId: 'scene:recipe',
            prompt: 'migrated scene prompt',
        })
        const repositoryDocument = buildMainResolveRequest(adapterInput(migratedSnapshot)).request.document
        repositoryDocument.modules[0].id = 'scene:module'
        repositoryDocument.modules[0].extensions = {
            legacyScene: { presetId: 'scene:preset', sceneId: 'scene:card' },
        }
        const sceneRecipe = repositoryDocument.recipes.find(recipe => recipe.id === 'scene:recipe')
        expect(sceneRecipe).toBeDefined()
        sceneRecipe!.steps[0].moduleId = 'scene:module'
        sceneRecipe!.extensions = {
            legacyScene: { presetId: 'scene:preset', sceneId: 'scene:card' },
        }

        const liveSnapshot = baseSnapshot()
        liveSnapshot.profile = singlePromptProfile({
            recipeId: 'asset:live',
            prompt: 'live Asset prompt',
        })
        liveSnapshot.selectedRecipeId = mainAssetRecipeSelectionId('scene:recipe')

        setRuntimeCompositionDocument(repositoryDocument)
        try {
            const built = buildMainResolveRequest(adapterInput(liveSnapshot))
            expect(built.request.document.modules.map(module => module.id)).toEqual(expect.arrayContaining([
                'subject',
                'scene:module',
            ]))
            expect(built.request.document.recipes.map(recipe => recipe.id)).toEqual(expect.arrayContaining([
                'asset:live',
                'scene:recipe',
            ]))
            expect(successfulPlan(resolveMainComposition(adapterInput(liveSnapshot))).positivePrompt)
                .toBe('migrated scene prompt')
        } finally {
            setRuntimeCompositionDocument(null)
        }
    })
})

describe('Main composition direct adapter', () => {
    it('builds an explicit direct recipe with fixed seed, comments removed, and canonical slot order', () => {
        const snapshot = baseSnapshot()
        snapshot.prompt = {
            base: '  # base note\nportrait',
            inpainting: 'repair hands\n# inpainting note',
            additional: 'soft light',
            detail: '# detail note\ndetailed eyes',
            negative: 'lowres\n  # negative note',
        }

        const input = adapterInput(snapshot)
        const built = buildMainResolveRequest(input)
        const resolution = resolveMainComposition(input)
        const plan = successfulPlan(resolution)

        expect(built.selectedRecipeId).toBe(MAIN_DIRECT_RECIPE_ID)
        expect(built.request.recipeId).toBe(MAIN_DIRECT_RECIPE_ID)
        expect(built.request.document.recipes.find(recipe => recipe.id === MAIN_DIRECT_RECIPE_ID))
            .toMatchObject({ enabled: true, steps: [] })
        expect(resolution.selectedRecipeId).toBe(MAIN_DIRECT_RECIPE_ID)
        expect(plan.recipeId).toBe(MAIN_DIRECT_RECIPE_ID)
        expect(plan.profileId).toBe(MAIN_COMPOSITION_PROFILE_ID)
        expect(plan.params.seed).toBe(FIXED_SEED)
        expect(plan.promptParts).toMatchObject({
            base: 'portrait',
            inpainting: 'repair hands',
            additional: 'soft light',
            workflow: '',
            detail: 'detailed eyes',
            negative: 'lowres',
        })
        expect(plan.positivePrompt).toBe(
            'portrait, repair hands, soft light, detailed eyes',
        )
        expect(plan.negativePrompt).toBe('lowres')
        expect(plan.provenanceDetails.prompts.find(item => item.contributionId === 'main:prompt:base')
            ?.sourceChain.at(-1)).toMatchObject({
            kind: 'request',
            requestId: 'main-request:fixed',
        })
    })

    it('repeats an inline wildcard result and semantic hash without ambient randomness', () => {
        const snapshot = baseSnapshot()
        snapshot.prompt.base = 'portrait, <red hair|blue hair|green hair>'
        const randomSpy = vi.spyOn(Math, 'random').mockImplementation(() => {
            throw new Error('Main v2 composition must not consult Math.random')
        })

        const first = successfulPlan(resolveMainComposition(adapterInput(snapshot)))
        const second = successfulPlan(resolveMainComposition(adapterInput(snapshot)))

        expect(first.positivePrompt).toBe(second.positivePrompt)
        expect(first.randomTrace).toEqual(second.randomTrace)
        expect(first.randomTrace).toHaveLength(1)
        expect(first.planHash).toEqual(second.planHash)
        expect(first.planHash.digest).toMatch(/^[0-9a-f]{64}$/)
        expect(randomSpy).not.toHaveBeenCalled()
    })

    it('keeps an inactive Asset recipe on the direct path', () => {
        const snapshot = baseSnapshot()
        snapshot.prompt.base = 'direct subject'
        snapshot.profile = singlePromptProfile({ prompt: 'disabled asset subject' })
        snapshot.profile.recipes[0].enabled = false
        snapshot.profile.modules.subject.enabled = false
        snapshot.profile.settings = { steps: 99 }
        snapshot.profile.output = {
            directory: 'Ignored_Profile_Output',
            filenameTemplate: 'ignored_{seed}',
            format: 'webp',
            metadataMode: 'sidecar-only',
        }

        const resolution = resolveMainComposition(adapterInput(snapshot))
        const plan = successfulPlan(resolution)

        expect(resolution.selectedRecipeId).toBe(MAIN_DIRECT_RECIPE_ID)
        expect(plan.recipeId).toBe(MAIN_DIRECT_RECIPE_ID)
        expect(plan.positivePrompt).toBe('direct subject')
        expect(plan.params.steps).toBe(28)
        expect(plan.outputPolicy).toMatchObject({
            destination: { kind: 'memory' },
            format: 'png',
            filenameTemplate: 'NAI_Blue_{timestamp}',
            metadataMode: 'embedded',
        })
        expect(resolution.output).toMatchObject({
            directory: 'NAI_Blue_Output',
            format: 'png',
            metadataMode: 'embedded',
        })
    })

    it('preserves a stored recipe whose ID collides with the synthetic direct base ID', () => {
        const snapshot = baseSnapshot()
        snapshot.prompt.base = 'direct subject'
        snapshot.profile = singlePromptProfile({
            recipeId: MAIN_DIRECT_RECIPE_ID,
            prompt: 'stored colliding recipe',
        })
        const syntheticDirectId = getMainDirectRecipeId(snapshot.profile.recipes)

        expect(syntheticDirectId).toBe('main:direct:synthetic')
        const storedRecipe = successfulPlan(resolveMainComposition(adapterInput(snapshot)))
        expect(storedRecipe.recipeId).toBe(MAIN_DIRECT_RECIPE_ID)
        expect(storedRecipe.positivePrompt).toBe('stored colliding recipe')

        snapshot.selectedRecipeId = MAIN_DIRECT_SELECTION_ID
        const direct = successfulPlan(resolveMainComposition(adapterInput(snapshot)))
        expect(direct.recipeId).toBe(syntheticDirectId)
        expect(direct.positivePrompt).toBe('direct subject')

        const beforeCollision = baseSnapshot()
        beforeCollision.prompt.base = 'stable direct selection'
        beforeCollision.selectedRecipeId = MAIN_DIRECT_SELECTION_ID
        expect(successfulPlan(resolveMainComposition(adapterInput(beforeCollision))).positivePrompt)
            .toBe('stable direct selection')
        beforeCollision.profile = snapshot.profile
        const afterCollision = successfulPlan(resolveMainComposition(adapterInput(beforeCollision)))
        expect(afterCollision.recipeId).toBe(syntheticDirectId)
        expect(afterCollision.positivePrompt).toBe('stable direct selection')
    })
})

describe('Main composition Asset recipe adapter', () => {
    it('replaces direct prompts and applies params plus output precedence through the real engine', () => {
        const snapshot = baseSnapshot()
        snapshot.prompt = {
            base: 'ignored direct subject',
            inpainting: 'ignored direct inpaint',
            additional: 'ignored direct additional',
            detail: 'ignored direct detail',
            negative: 'ignored direct negative',
        }
        snapshot.output = {
            autoSave: true,
            savePath: 'Runtime_Output',
            useAbsolutePath: false,
            imageFormat: 'png',
            metadataMode: 'embedded',
        }
        snapshot.profile = {
            ...emptyProfile(),
            settings: {
                name: 'Golden Profile',
                steps: 20,
                cfgRescale: 0.3,
                smea: true,
            },
            output: {
                directory: 'Profile_Output',
                filenameTemplate: 'profile_{seed}',
                format: 'png',
                metadataMode: 'embedded',
            },
            modules: {
                subject: {
                    id: 'subject',
                    enabled: true,
                    kind: 'prompt',
                    prompts: {
                        'main.base': 'module subject',
                        'main.negative': 'module negative',
                    },
                    settings: {
                        steps: 30,
                        cfgScale: 7,
                        cfgRescale: 0,
                        smea: false,
                    },
                    output: {
                        directory: 'Module_Output',
                        filenameTemplate: 'module_{seed}',
                        format: 'webp',
                        metadataMode: 'sidecar-only',
                    },
                },
            },
            recipes: [{
                id: 'asset-recipe:golden',
                enabled: true,
                label: 'Golden Recipe',
                steps: [{ moduleId: 'subject', settings: { steps: 40 } }],
                settings: { steps: 50 },
                output: {
                    directory: 'Recipe_Output',
                    filenameTemplate: 'recipe_{seed}',
                    format: 'webp',
                    metadataMode: 'strip-and-sidecar',
                },
            }],
        }
        snapshot.selectedRecipeId = 'asset-recipe:golden'

        const resolution = resolveMainComposition(adapterInput(snapshot))
        const plan = successfulPlan(resolution)

        expect(plan.positivePrompt).toBe('module subject')
        expect(plan.negativePrompt).toBe('module negative')
        expect(plan.promptParts).toMatchObject({
            base: 'module subject',
            inpainting: '',
            additional: '',
            workflow: '',
            detail: '',
            negative: 'module negative',
        })
        expect(plan.params).toMatchObject({
            steps: 50,
            cfgScale: 7,
            cfgRescale: 0,
            smea: false,
        })
        expect(plan.provenanceDetails.params.find(item => item.field === 'steps')?.sourceChain
            .map(item => item.layer)).toEqual([
            'engine-defaults',
            'profile-defaults',
            'module-defaults',
            'recipe-step-override',
            'recipe-override',
        ])
        expect(plan.provenanceDetails.params.find(item => item.field === 'steps')?.winner.layer)
            .toBe('recipe-override')
        expect(plan.provenanceDetails.prompts.find(item => item.contributionId.includes('asset-contribution'))
            ?.sourceChain.map(source => source.kind === 'entity' ? source.entityKind : source.kind))
            .toEqual(['module', 'recipe-step', 'recipe'])
        expect(plan.outputPolicy).toMatchObject({
            destination: {
                kind: 'filesystem',
                directory: {
                    kind: 'standard',
                    root: 'pictures',
                    segments: ['Recipe_Output'],
                },
            },
            format: 'webp',
            filenameTemplate: 'recipe_{seed}',
            metadataMode: 'strip-and-sidecar',
        })
        expect(resolution.output).toEqual({
            directory: 'Recipe_Output',
            portableDirectory: {
                kind: 'standard',
                root: 'pictures',
                segments: ['Recipe_Output'],
            },
            fileName: `recipe_${FIXED_SEED}`,
            format: 'webp',
            metadataMode: 'strip-and-sidecar',
            autoSave: true,
            useAbsolutePath: false,
            capabilityFallbackDirectory: 'Runtime_Output',
        })
    })

    it('honors an explicit recipe ID instead of selecting the first enabled recipe', () => {
        const snapshot = baseSnapshot()
        snapshot.profile = {
            ...emptyProfile(),
            modules: {
                first: {
                    id: 'first',
                    enabled: true,
                    kind: 'prompt',
                    prompts: { 'main.base': 'first recipe subject' },
                    settings: {},
                },
                second: {
                    id: 'second',
                    enabled: true,
                    kind: 'prompt',
                    prompts: { 'main.base': 'second recipe subject' },
                    settings: {},
                },
            },
            recipes: [
                { id: 'recipe:first', enabled: true, steps: [{ moduleId: 'first' }] },
                { id: 'recipe:second', enabled: true, steps: [{ moduleId: 'second' }] },
            ],
        }
        snapshot.selectedRecipeId = 'recipe:second'

        const built = buildMainResolveRequest(adapterInput(snapshot))
        const resolution = resolveMainComposition(adapterInput(snapshot))
        const plan = successfulPlan(resolution)

        expect(built.request.recipeId).toBe('recipe:second')
        expect(resolution.selectedRecipeId).toBe('recipe:second')
        expect(plan.recipeId).toBe('recipe:second')
        expect(plan.positivePrompt).toBe('second recipe subject')
    })

    it('returns a strict blocking error for a selected recipe with a missing module', () => {
        const snapshot = baseSnapshot()
        snapshot.profile = {
            ...emptyProfile(),
            recipes: [{
                id: 'recipe:broken',
                enabled: true,
                steps: [{ moduleId: 'module:missing' }],
            }],
        }
        snapshot.selectedRecipeId = 'recipe:broken'

        const resolution = resolveMainComposition(adapterInput(snapshot))

        expect(resolution.result.success).toBe(false)
        expect(resolution.output).toBeNull()
        expect(resolution.result.errors.map(issue => issue.code)).toContain('E_MODULE_REF_MISSING')
        expect(resolution.result.errors.find(issue => issue.code === 'E_MODULE_REF_MISSING'))
            .toMatchObject({ severity: 'error', blocking: true })
    })

    it('orders sparse Asset character targets by numeric slot rather than lexical ID', () => {
        const snapshot = baseSnapshot()
        snapshot.profile = {
            ...emptyProfile(),
            modules: {
                cast: {
                    id: 'cast',
                    enabled: true,
                    kind: 'prompt',
                    prompts: {
                        'v4.char.10.positive': 'slot ten',
                        'v4.char.2.positive': 'slot two',
                    },
                    settings: {},
                },
            },
            recipes: [{ id: 'recipe:cast', enabled: true, steps: [{ moduleId: 'cast' }] }],
        }
        snapshot.selectedRecipeId = 'recipe:cast'

        const plan = successfulPlan(resolveMainComposition(adapterInput(snapshot)))

        expect(plan.characters.map(character => [character.characterId, character.positive])).toEqual([
            ['asset-character:recipe:cast:2', 'slot two'],
            ['asset-character:recipe:cast:10', 'slot ten'],
        ])
    })
})

describe('Main composition characters and source transport', () => {
    it('preserves stable character IDs and manual positions', () => {
        const snapshot = baseSnapshot()
        snapshot.positionEnabled = true
        snapshot.params = { ...snapshot.params, characterPositionEnabled: true }
        snapshot.characters = [
            {
                id: 'character:zeta',
                name: 'Zeta',
                prompt: 'silver hair',
                negative: 'hat',
                enabled: true,
                position: { x: 0.2, y: 0.8 },
            },
            {
                id: 'character:alpha',
                name: 'Alpha',
                prompt: 'blue eyes',
                negative: 'glasses',
                enabled: true,
                position: { x: 0.75, y: 0.35 },
            },
        ]

        const plan = successfulPlan(resolveMainComposition(adapterInput(snapshot)))

        expect(plan.characters).toEqual([
            expect.objectContaining({
                characterId: 'character:zeta',
                positive: 'silver hair',
                negative: 'hat',
                position: { mode: 'manual', x: 0.2, y: 0.8 },
            }),
            expect.objectContaining({
                characterId: 'character:alpha',
                positive: 'blue eyes',
                negative: 'glasses',
                position: { mode: 'manual', x: 0.75, y: 0.35 },
            }),
        ])
        expect(plan.characters.every(character => !Object.hasOwn(character, 'index'))).toBe(true)
    })

    it('maps disabled coordinate mode to ai-choice without inventing payload indices', () => {
        const snapshot = baseSnapshot()
        snapshot.positionEnabled = false
        snapshot.params = { ...snapshot.params, characterPositionEnabled: false }
        snapshot.characters = [{
            id: 'character:hero',
            prompt: 'hero prompt',
            negative: 'hero negative',
            enabled: true,
            position: { x: 0.1, y: 0.9 },
        }]

        const plan = successfulPlan(resolveMainComposition(adapterInput(snapshot)))

        expect(plan.params.characterPositionEnabled).toBe(false)
        expect(plan.characters).toEqual([
            expect.objectContaining({
                characterId: 'character:hero',
                position: { mode: 'ai-choice' },
            }),
        ])
        expect(plan.characters[0]).not.toHaveProperty('index')
    })

    it('uses source-derived dimensions and emits only stable resource references for infill', () => {
        const snapshot = baseSnapshot()
        snapshot.source = {
            hasSourceImage: true,
            hasMask: true,
            sourceImageDigest: 'sha256:source-a',
            maskDigest: 'sha256:mask-a',
            width: 768,
            height: 1024,
            strength: 0.55,
            noise: 0.12,
        }

        const input = adapterInput(snapshot)
        const built = buildMainResolveRequest(input)
        const plan = successfulPlan(resolveMainComposition(input))

        expect(plan.params).toMatchObject({
            width: 768,
            height: 1024,
            sourceMode: 'inpaint',
            sourceImageResourceId: 'main-resource:source-image',
            maskResourceId: 'main-resource:mask',
            strength: 0.55,
            noise: 0.12,
        })
        expect(plan.provenanceDetails.params.find(item => item.field === 'width')?.winner.layer)
            .toBe('transport-derived-override')
        expect(plan.resources).toEqual([
            expect.objectContaining({
                id: 'main-resource:source-image',
                kind: 'managed',
                role: 'source-image',
                resourceId: 'main-runtime:source-image',
                digest: 'sha256:source-a',
            }),
            expect.objectContaining({
                id: 'main-resource:mask',
                kind: 'managed',
                role: 'mask',
                resourceId: 'main-runtime:mask',
                digest: 'sha256:mask-a',
            }),
        ])
        expect(JSON.stringify(plan)).not.toMatch(/base64|imageBytes|maskBytes/)
        expect(built.request.document.resources).toHaveLength(2)

        const changedSource = structuredClone(snapshot)
        changedSource.source.sourceImageDigest = 'sha256:source-b'
        const changedPlan = successfulPlan(resolveMainComposition(adapterInput(changedSource)))
        expect(changedPlan.planHash).not.toEqual(plan.planHash)
    })

    it('projects the active legacy generation preset without leaking UI fields into params', () => {
        const snapshot = baseSnapshot()
        snapshot.params = {
            ...snapshot.params,
            cfgRescale: 0,
            smea: false,
            smeaDyn: false,
            variety: false,
            qualityToggle: false,
            ucPreset: 0,
        }
        snapshot.paramsPresets = [{
            id: 'preset:active',
            name: 'Active UI preset',
            createdAt: Date.parse(NOW),
            isDefault: true,
            basePrompt: 'UI prompt must not become a param',
            selectedResolution: { label: 'Portrait UI label', width: 640, height: 640 },
            cfgRescale: 0.9,
            smea: true,
            variety: true,
        }]
        snapshot.activeParamsPresetId = 'preset:active'

        const input = adapterInput(snapshot)
        const built = buildMainResolveRequest(input)
        const plan = successfulPlan(resolveMainComposition(input))
        const preset = built.request.document.paramsPresets[0]
        const profile = built.request.document.profiles[0]

        expect(profile.paramsPresetIds).toEqual(['preset:active'])
        expect(profile.defaultParamsPresetId).toBe('preset:active')
        expect(preset.params).toMatchObject({
            width: 832,
            height: 1216,
            cfgRescale: 0,
            smea: false,
            smeaDyn: false,
            variety: false,
            qualityToggle: false,
            ucPreset: 0,
        })
        expect(preset.params).not.toHaveProperty('basePrompt')
        expect(preset.params).not.toHaveProperty('name')
        expect(preset.params).not.toHaveProperty('isDefault')
        expect(preset.params).not.toHaveProperty('selectedResolution')
        expect(plan.params).toMatchObject({
            cfgRescale: 0,
            smea: false,
            smeaDyn: false,
            variety: false,
            qualityToggle: false,
            ucPreset: 0,
        })
    })
})

describe('Main composition settings and filename policy', () => {
    it('keeps unknown legacy settings inert across profile, module, step, and recipe layers', () => {
        const makeSnapshot = (marker: string): MainCompositionSnapshot => {
            const snapshot = baseSnapshot()
            snapshot.profile = {
                ...singlePromptProfile({ prompt: 'stable asset prompt' }),
                settings: { futureProfileSetting: marker },
            }
            snapshot.profile.modules.subject.settings = { futureModuleSetting: marker }
            snapshot.profile.recipes[0].settings = { futureRecipeSetting: marker }
            snapshot.profile.recipes[0].steps[0].settings = { futureStepSetting: marker }
            snapshot.selectedRecipeId = snapshot.profile.recipes[0].id
            return snapshot
        }

        const first = successfulPlan(resolveMainComposition(adapterInput(makeSnapshot('one'))))
        const second = successfulPlan(resolveMainComposition(adapterInput(makeSnapshot('two'))))

        expect(first.positivePrompt).toBe('stable asset prompt')
        expect(second.positivePrompt).toBe(first.positivePrompt)
        expect(second.params).toEqual(first.params)
        expect(second.outputPolicy).toEqual(first.outputPolicy)
        expect(second.planHash).toEqual(first.planHash)
        expect(first.issues.map(issue => issue.code)).not.toContain('W_UNKNOWN_EXTENSION')
    })

    it('materializes a deterministic portable output directory and filename policy', () => {
        const snapshot = baseSnapshot()
        snapshot.output = {
            autoSave: true,
            savePath: 'Runtime_Output',
            useAbsolutePath: false,
            imageFormat: 'png',
            metadataMode: 'embedded',
        }
        snapshot.profile = singlePromptProfile({
            recipeId: 'asset-recipe:portable',
            prompt: 'portable subject',
        })
        snapshot.profile.output = {
            directory: 'Gallery/../Portraits',
            filenameTemplate: 'main_{seed}_{recipe.id}.webp',
            format: '.webp',
            metadataMode: 'sidecar-only',
        }
        snapshot.selectedRecipeId = 'asset-recipe:portable'

        const resolution = resolveMainComposition(adapterInput(snapshot, 24680))
        const plan = successfulPlan(resolution)

        expect(plan.outputPolicy).toEqual({
            destination: {
                kind: 'filesystem',
                directory: {
                    kind: 'standard',
                    root: 'pictures',
                    segments: ['Gallery', 'Portraits'],
                },
            },
            format: 'webp',
            filenameTemplate: 'main_{seed}_{recipe.id}.webp',
            metadataMode: 'sidecar-only',
            collisionPolicy: 'overwrite',
        })
        expect(resolution.output).toEqual({
            directory: 'Gallery/Portraits',
            portableDirectory: {
                kind: 'standard',
                root: 'pictures',
                segments: ['Gallery', 'Portraits'],
            },
            fileName: 'main_24680_asset-recipe_portable.webp',
            format: 'webp',
            metadataMode: 'sidecar-only',
            autoSave: true,
            useAbsolutePath: false,
            capabilityFallbackDirectory: 'Runtime_Output',
        })
    })

    it('keeps an absolute runtime directory outside the semantic plan while materializing its capability', () => {
        const snapshot = baseSnapshot()
        snapshot.output = {
            ...snapshot.output,
            autoSave: true,
            savePath: 'C:\\Users\\Example\\Pictures\\NAI Blue',
        }

        const resolution = resolveMainComposition(adapterInput(snapshot))
        const plan = successfulPlan(resolution)

        expect(plan.outputPolicy.destination).toEqual({
            kind: 'filesystem',
            directory: {
                kind: 'bookmark',
                bookmarkId: 'main-output:absolute-runtime',
                segments: [],
            },
        })
        expect(resolution.output).toMatchObject({
            directory: 'C:\\Users\\Example\\Pictures\\NAI Blue',
            useAbsolutePath: true,
            capabilityFallbackDirectory: 'NAI_Blue_Output',
        })
        const movedSnapshot = structuredClone(snapshot)
        movedSnapshot.output.savePath = 'D:\\Portable\\NAI Blue'
        const moved = successfulPlan(resolveMainComposition(adapterInput(movedSnapshot)))
        expect(moved.planHash).toEqual(plan.planHash)
    })

    it('projects a fresh Android relative output to the portable app-data root', () => {
        const snapshot = baseSnapshot()
        snapshot.output = {
            ...snapshot.output,
            autoSave: true,
            savePath: 'NAI_Blue_Output/mobile',
            portableRoot: 'app-data',
        }

        const resolution = resolveMainComposition(adapterInput(snapshot))
        const plan = successfulPlan(resolution)

        expect(plan.outputPolicy.destination).toEqual({
            kind: 'filesystem',
            directory: {
                kind: 'standard',
                root: 'app-data',
                segments: ['NAI_Blue_Output', 'mobile'],
            },
        })
        expect(resolution.output?.portableDirectory).toEqual({
            kind: 'standard',
            root: 'app-data',
            segments: ['NAI_Blue_Output', 'mobile'],
        })
    })

    it('includes dotted recipe filename tokens in semantic plan identity', () => {
        const snapshot = baseSnapshot()
        snapshot.profile = {
            ...singlePromptProfile({ recipeId: 'recipe:one', prompt: 'same prompt' }),
            recipes: [
                {
                    id: 'recipe:one',
                    enabled: true,
                    steps: [{ moduleId: 'subject' }],
                    output: { filenameTemplate: 'main_{recipe.id}' },
                },
                {
                    id: 'recipe:two',
                    enabled: true,
                    steps: [{ moduleId: 'subject' }],
                    output: { filenameTemplate: 'main_{recipe.id}' },
                },
            ],
        }

        snapshot.selectedRecipeId = 'recipe:one'
        const first = successfulPlan(resolveMainComposition(adapterInput(snapshot)))
        snapshot.selectedRecipeId = 'recipe:two'
        const second = successfulPlan(resolveMainComposition(adapterInput(snapshot)))

        expect(first.positivePrompt).toBe(second.positivePrompt)
        expect(first.outputPolicy).toEqual(second.outputPolicy)
        expect(first.filenamePolicyInput.template).toBe('main_{recipe.id}')
        expect(first.planHash).not.toEqual(second.planHash)
    })

    it('renders and hashes profile plus recipe labels used by filename templates', () => {
        const makeSnapshot = (profileName: string, recipeLabel: string): MainCompositionSnapshot => {
            const snapshot = baseSnapshot()
            snapshot.profile = singlePromptProfile({ recipeId: 'recipe:labeled', prompt: 'same prompt' })
            snapshot.profile.settings = { name: profileName }
            snapshot.profile.recipes[0].label = recipeLabel
            snapshot.profile.recipes[0].output = {
                filenameTemplate: '{profile}_{recipe.label}_{seed}',
            }
            snapshot.selectedRecipeId = 'recipe:labeled'
            return snapshot
        }

        const firstResolution = resolveMainComposition(adapterInput(makeSnapshot('Profile One', 'Label One')))
        const secondResolution = resolveMainComposition(adapterInput(makeSnapshot('Profile Two', 'Label Two')))
        const first = successfulPlan(firstResolution)
        const second = successfulPlan(secondResolution)

        expect(firstResolution.output?.fileName).toBe(`Profile One_Label One_${FIXED_SEED}`)
        expect(secondResolution.output?.fileName).toBe(`Profile Two_Label Two_${FIXED_SEED}`)
        expect(first.filenamePolicyInput).toMatchObject({
            profileName: 'Profile One',
            recipeName: 'Label One',
        })
        expect(first.planHash).not.toEqual(second.planHash)
    })
})
