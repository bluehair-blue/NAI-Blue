import { describe, expect, it } from 'vitest'

import { sha256Utf8 } from '@/domain/composition/canonical-serialize'
import { createFragmentLookup } from '@/domain/composition/fragment-resolver'
import type { CompositionEnginePlan } from '@/domain/composition/engine'
import type { DeepReadonly } from '@/domain/composition/provenance'
import {
    buildMainResolveRequest,
    type MainCompositionSnapshot,
} from '@/lib/composition/main-adapter'
import {
    STYLE_LAB_OUTPUT_FILENAME_TEMPLATE,
    buildStyleLabResolveRequest,
    resolveStyleLabComposition,
    type BuildStyleLabCompositionInput,
} from '@/lib/composition/style-lab-adapter'
import type { AssetProfile } from '@/types/asset-profile'
import { setRuntimeCompositionDocument } from '@/lib/composition-authority'

const NOW = '2026-07-12T00:00:00.000Z' as const
const SEED = 424242

function profile(): AssetProfile {
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

function snapshot(): MainCompositionSnapshot {
    return {
        profile: profile(),
        selectedRecipeId: null,
        prompt: {
            base: '# base note\nportrait',
            inpainting: '',
            additional: 'soft light',
            detail: 'detailed eyes',
            negative: '# negative note\nlowres',
        },
        characters: [],
        positionEnabled: false,
        references: [],
        params: {
            model: 'nai-diffusion-4-5-full',
            width: 832,
            height: 1216,
            steps: 28,
            cfgScale: 5,
            cfgRescale: 0,
            sampler: 'k_euler_ancestral',
            scheduler: 'karras',
            smea: false,
            smeaDyn: false,
            variety: false,
            seed: 999,
            qualityToggle: true,
            ucPreset: 0,
            sourceMode: 'text-to-image',
            strength: 0.7,
            noise: 0,
            characterPositionEnabled: false,
        },
        output: {
            autoSave: false,
            savePath: 'nai-blue-style',
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

function input(overrides: Partial<BuildStyleLabCompositionInput> = {}): BuildStyleLabCompositionInput {
    return {
        snapshot: snapshot(),
        requestId: 'style-lab-request:fixed',
        now: NOW,
        seed: SEED,
        fragment: {
            lookup: createFragmentLookup([]),
            sequenceSnapshot: { revision: 0, counters: {} },
            mode: 'generate',
            strictness: 'strict',
            maxRecursion: 10,
        },
        combination: {
            id: 'combo:alice',
            tags: [{ tag: ' Alice ', kind: 'artist', weight: 1, artist: ' Alice ' }],
        },
        promptTemplate: '{{basePrompt}}, {{inpaintingPrompt}}, {{artist_tags}}, {{additionalPrompt}}, {{detailPrompt}}',
        ...overrides,
    }
}

function planFor(value: BuildStyleLabCompositionInput): DeepReadonly<CompositionEnginePlan> {
    const resolution = resolveStyleLabComposition(value)
    expect(resolution.result.success).toBe(true)
    if (!resolution.result.success) {
        throw new Error(resolution.result.errors.map(issue => issue.code).join(', '))
    }
    return resolution.result.plan
}

describe('Style Lab Composition workflow adapter', () => {
    it('attaches its temporary workflow recipe to the repository active profile', () => {
        const value = input()
        const repositoryDocument = buildMainResolveRequest({
            snapshot: value.snapshot,
            requestId: 'repository:bootstrap',
            now: value.now,
            seed: value.seed,
            fragment: value.fragment,
        }).request.document
        repositoryDocument.profiles[0].id = 'repository:active-profile'
        repositoryDocument.activeProfileId = 'repository:active-profile'

        setRuntimeCompositionDocument(repositoryDocument)
        try {
            const built = buildStyleLabResolveRequest(value)
            const activeProfile = built.request.document.profiles.find(profile => (
                profile.id === 'repository:active-profile'
            ))
            expect(built.request.profileId).toBe('repository:active-profile')
            expect(activeProfile?.recipeIds).toContain(built.combination.recipeId)
            expect(planFor(value).profileId).toBe('repository:active-profile')
        } finally {
            setRuntimeCompositionDocument(null)
        }
    })

    it('renders one artist through ordered main.workflow tokens owned by the engine', () => {
        const value = input()
        const built = buildStyleLabResolveRequest(value)
        const plan = planFor(value)
        const module = built.request.document.modules.find(item => item.id === built.combination.moduleId)
        const recipe = built.request.document.recipes.find(item => item.id === built.combination.recipeId)

        expect(module?.contributions.length).toBeGreaterThan(1)
        expect(module?.contributions.every(item => (
            item.target.kind === 'positive' && item.target.slot === 'workflow'
        ))).toBe(true)
        expect(plan.promptParts).toMatchObject({
            base: '',
            inpainting: '',
            additional: '',
            workflow: 'portrait, 1.0::artist:Alice ::, soft light, detailed eyes',
            detail: '',
            negative: 'lowres',
        })
        expect(plan.positivePrompt).toBe('portrait, 1.0::artist:Alice ::, soft light, detailed eyes')
        expect(recipe?.outputPolicy?.filenameTemplate).toBe(STYLE_LAB_OUTPUT_FILENAME_TEMPLATE)
        expect(plan.filenamePolicyInput.template).toBe(STYLE_LAB_OUTPUT_FILENAME_TEMPLATE)
        expect(plan.params.seed).toBe(SEED)
    })

    it('preserves ordered multi-tag combination provenance and replay trace', () => {
        const value = input({
            combination: {
                id: 'combo:duo',
                tags: [
                    { tag: 'Beta', kind: 'artist', weight: 0.7, artist: 'Beta' },
                    { tag: 'Alpha', kind: 'artist', weight: 1.4, artist: 'Alpha' },
                ],
            },
        })
        const resolution = resolveStyleLabComposition(value)
        expect(resolution.result.success).toBe(true)
        if (!resolution.result.success) return

        const trace = resolution.result.plan.randomTrace.find(item => (
            item.ruleId === resolution.combination.randomRuleId
        ))
        expect(resolution.result.plan.positivePrompt).toContain(
            '0.7::artist:Beta ::, 1.4::artist:Alpha ::',
        )
        expect(resolution.combination.orderedTagDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
        expect(trace).toMatchObject({
            drawIndex: 0,
            seed: SEED,
            result: 'combo:duo',
            provenance: {
                kind: 'external',
                source: 'style-lab:artist-combination:combo:duo',
                digest: resolution.combination.orderedTagDigest,
            },
        })
        expect(resolution.result.plan.provenanceDetails.randomSelections[0]?.sourceChain)
            .toEqual(expect.arrayContaining([
                expect.objectContaining({
                    kind: 'entity',
                    entityKind: 'module',
                    entityId: resolution.combination.moduleId,
                    revision: 7,
                }),
                expect.objectContaining({
                    kind: 'entity',
                    entityKind: 'recipe',
                    entityId: resolution.combination.recipeId,
                    revision: 7,
                }),
            ]))

        const reversed = resolveStyleLabComposition(input({
            combination: {
                ...value.combination,
                tags: [...value.combination.tags].reverse(),
            },
        }))
        expect(reversed.combination.orderedTagDigest).not.toBe(resolution.combination.orderedTagDigest)
    })

    it('lets the engine resolve wildcards in workflow and character prompts', () => {
        const state = snapshot()
        state.prompt.base = '# omit\nportrait, <hair>'
        state.characters = [{
            id: 'character:one',
            name: 'One',
            prompt: '# omit\nsmiling, <mood>',
            negative: 'bad hands\n# omit',
            enabled: true,
            position: { mode: 'ai-choice' },
        }]
        const plan = planFor(input({
            snapshot: state,
            fragment: {
                lookup: createFragmentLookup([
                    { id: 'fragment:hair', path: 'hair', lines: ['red hair'] },
                    { id: 'fragment:mood', path: 'mood', lines: ['calm'] },
                ]),
                sequenceSnapshot: { revision: 0, counters: {} },
                mode: 'generate',
                strictness: 'strict',
                maxRecursion: 10,
            },
        }))

        expect(plan.positivePrompt).toContain('portrait, red hair')
        expect(plan.characters).toContainEqual(expect.objectContaining({
            characterId: 'character:one',
            positive: 'smiling, calm',
            negative: 'bad hands',
        }))
        expect(plan.randomTrace.map(item => item.result)).toEqual(expect.arrayContaining([
            'red hair',
            'calm',
        ]))
    })

    it('keeps semantic plan hash stable across request identity and ambient time', () => {
        const first = planFor(input())
        const second = planFor(input({
            requestId: 'style-lab-request:other',
            now: '2030-01-01T01:02:03.000Z',
        }))

        expect(second.positivePrompt).toBe(first.positivePrompt)
        expect(second.params).toEqual(first.params)
        expect(second.planHash).toEqual(first.planHash)
        expect(second.planId).toBe(first.planId)
    })

    it('uses engine precedence while preserving live false and zero values', () => {
        const state = snapshot()
        state.params = {
            ...state.params,
            seed: 123456789,
            steps: 31,
            smea: false,
            cfgRescale: 0,
        }
        state.source = { ...state.source, width: 640, height: 960 }
        const plan = planFor(input({
            snapshot: state,
            seed: 17,
            recipeParamsOverride: {
                steps: 55,
                smea: true,
                cfgRescale: 0.75,
                width: 1024,
                height: 1024,
                seed: 88,
            },
        }))

        expect(plan.params).toMatchObject({
            seed: 17,
            steps: 31,
            smea: false,
            cfgRescale: 0,
            width: 640,
            height: 960,
        })
        expect(plan.provenanceDetails.params.find(item => item.field === 'smea')?.winner.layer)
            .toBe('workflow-runtime-override')
        expect(plan.provenanceDetails.params.find(item => item.field === 'width')?.winner.layer)
            .toBe('transport-derived-override')
    })

    it('uses profile revision for every temporary workflow entity', () => {
        const built = buildStyleLabResolveRequest(input())
        const module = built.request.document.modules.find(item => item.id === built.combination.moduleId)
        const recipe = built.request.document.recipes.find(item => item.id === built.combination.recipeId)
        const step = recipe?.steps.find(item => item.id === built.combination.stepId)

        expect([module?.revision, recipe?.revision, step?.revision]).toEqual([7, 7, 7])
        expect([module?.updatedAt, recipe?.updatedAt, step?.updatedAt]).toEqual([NOW, NOW, NOW])
    })

    it('allocates deterministic collision-free IDs against the whole Main document', () => {
        const state = snapshot()
        const suffix = sha256Utf8('combo:alice')
        const collidingIds = {
            module: `style-lab:module:${suffix}`,
            recipe: `style-lab:recipe:${suffix}`,
            step: `style-lab:step:${suffix}`,
            rule: `style-lab:combination-rule:${suffix}`,
            option: `style-lab:combination-option:${suffix}`,
            contribution: `style-lab:prompt:${suffix}:000000`,
        }
        state.profile.modules = Object.fromEntries(
            Object.entries(collidingIds).map(([key, id]) => [key, {
                id,
                enabled: true,
                kind: 'prompt',
                settings: {},
            }]),
        )
        const first = buildStyleLabResolveRequest(input({ snapshot: state }))
        const second = buildStyleLabResolveRequest(input({ snapshot: state }))
        const module = first.request.document.modules.find(item => item.id === first.combination.moduleId)
        const recipe = first.request.document.recipes.find(item => item.id === first.combination.recipeId)
        const rule = first.request.document.randomRules.find(item => item.id === first.combination.randomRuleId)

        expect(first.combination).toMatchObject({
            moduleId: `${collidingIds.module}:1`,
            recipeId: `${collidingIds.recipe}:1`,
            stepId: `${collidingIds.step}:1`,
            randomRuleId: `${collidingIds.rule}:1`,
        })
        expect(module?.contributions[0]?.id).toBe(`${collidingIds.contribution}:1`)
        expect(rule?.kind === 'choice' ? rule.options[0]?.id : undefined)
            .toBe(`${collidingIds.option}:1`)
        expect(second.combination.moduleId).toBe(first.combination.moduleId)
        expect(recipe?.steps[0]?.id).toBe(first.combination.stepId)
        expect(resolveStyleLabComposition(input({ snapshot: state })).result.success).toBe(true)
    })

    it('appends artist tags for a custom template without the artist placeholder', () => {
        const plan = planFor(input({ promptTemplate: '# template note\n{{basePrompt}}, cinematic' }))
        expect(plan.positivePrompt).toBe('portrait, cinematic, 1.0::artist:Alice ::')
    })

    it('returns an explicit item-level engine error for an invalid selected recipe', () => {
        const resolution = resolveStyleLabComposition(input({ selectedRecipeId: 'missing:recipe' }))
        expect(resolution.result.success).toBe(false)
        if (resolution.result.success) return

        expect(resolution.result.errors).toContainEqual(expect.objectContaining({
            code: 'E_RECIPE_MISSING',
            blocking: true,
            fieldPath: ['recipeId'],
        }))
    })
})
