import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const persistedSceneStorage = vi.hoisted(() => ({ value: null as string | null }))

vi.mock('@/lib/indexed-db', () => ({
    indexedDBStorage: {
        getItem: async () => persistedSceneStorage.value,
        setItem: async () => undefined,
        removeItem: async () => undefined,
    },
}))

const source = (path: string) => readFile(resolve(process.cwd(), path), 'utf8')

describe('Scene composition minimal UI contract', () => {
    it('keeps internal rollout and recipes out of the simplified Scene surface', async () => {
        const sceneMode = await source('src/pages/SceneMode.tsx')
        const sceneDetail = await source('src/pages/SceneDetail.tsx')
        const editor = await source('src/components/scene/ScenePromptEditor.tsx')

        expect(sceneMode).toContain('<SceneCompositionWorkspace')
        expect(sceneMode).toContain('simplified')
        expect(sceneMode).not.toContain('data-testid="scene-bulk-recipe"')
        expect(sceneDetail).toContain('<ScenePromptEditor')
        expect(editor).toContain("type PromptSlot = Exclude<keyof ScenePromptConfig")
        expect(editor).toContain("t('scene.copyMainPrompts'")
        expect(editor).toContain('<SceneCharacterCaptionsEditor')
        expect(sceneMode).toContain('<SceneCompositionCardMeta')
        for (const page of [sceneMode, sceneDetail]) {
            expect(page).not.toContain('SCENE_COMPOSITION_MODES')
            expect(page).not.toContain('setSceneCompositionMode')
            expect(page).not.toContain('mode={{')
        }
        const workspace = await source('src/components/scene/SceneCompositionWorkspace.tsx')
        expect(workspace).toContain('mode?: CompositionSelectControl')
        expect(workspace).toContain('mode={simplified ? undefined : mode}')
    })

    it.each(['legacy', 'shadow', 'v2', 'unknown', undefined])(
        'normalizes persisted mode %s to v2 while preserving Scene data',
        async mode => {
            persistedSceneStorage.value = null
            const { useSceneStore } = await import('@/stores/scene-store')
            await useSceneStore.persist.rehydrate()
            const scene = {
                id: 'scene:preserved', name: 'Saved Scene', scenePrompt: 'saved prompt',
                queueCount: 0, images: [], createdAt: 123, excludePinned: true,
                compositionRef: { recipeId: 'recipe:preserved' },
            }
            const preset = { id: 'scene-default', name: 'Saved folder', scenes: [scene], createdAt: 123 }
            persistedSceneStorage.value = JSON.stringify({
                state: {
                    presets: [preset], activePresetId: preset.id, gridColumns: 3,
                    sceneCompositionMode: mode,
                },
                version: 0,
            })
            try {
                await useSceneStore.persist.rehydrate()
                const state = useSceneStore.getState()
                expect(state.sceneCompositionMode).toBe('v2')
                expect(state.presets).toEqual([preset])
                expect(state.activePresetId).toBe(preset.id)
                expect(state.gridColumns).toBe(3)
            } finally {
                persistedSceneStorage.value = null
            }
        },
    )

    it('resolves the visible Scene prompt and keeps reset local/store state aligned', async () => {
        const sceneDetail = await source('src/pages/SceneDetail.tsx')
        const sceneBuilder = await source('src/lib/scene-generation/build-scene-params.ts')

        expect(sceneDetail).toContain('<ScenePromptEditor')
        expect(sceneBuilder).toContain('resolveScenePrompts(scene)')
        expect(sceneBuilder).toContain('resolveSceneGeneration(scene)')
        expect(sceneBuilder).toContain('SCENE_DIRECT_RECIPE_ID')
        expect(sceneBuilder).toContain("inpainting: ''")
    })

    it('shows the requested resolved summary without mounting Main controls', async () => {
        const controls = await source('src/components/scene/SceneCompositionControls.tsx')

        expect(controls).toContain('plan?.positivePrompt')
        expect(controls).toContain('plan?.negativePrompt')
        expect(controls).toContain('JSON.stringify(plan.params, null, 2)')
        expect(controls).toContain('result.errors')
        expect(controls).toContain('result.warnings')
        expect(controls).toContain('plan.planHash.digest')
        expect(controls).not.toMatch(/RecipeSelector|ResolvedPlanPanel|ValidationBadge/)
    })

    it('keeps the empty Scene prompt guidance visible at its initial height', async () => {
        const editor = await source('src/components/scene/ScenePromptEditor.tsx')
        const autocomplete = await source('src/components/ui/AutocompleteTextarea.tsx')

        expect(editor).toContain('<PromptSlotTabs')
        expect(editor).toContain("'h-32 min-h-32 resize-y rounded-none")
        expect(autocomplete).toContain('.prompt-editor-wrapper textarea::placeholder')
        expect(autocomplete).toContain('-webkit-text-fill-color: oklch(var(--muted-foreground))')
    })

    it('edits an ordered Scene-owned character caption array instead of flattening characters', async () => {
        const editor = await source('src/components/scene/SceneCharacterCaptionsEditor.tsx')
        const mainCharacterPanel = await source('src/components/character/CharacterPromptPanel.tsx')
        const sceneBuilder = await source('src/lib/scene-generation/build-scene-params.ts')
        const legacyBuilder = await source('src/lib/scene-generation/legacy-build-scene-params.ts')

        expect(editor).toContain('data-testid="scene-character-caption"')
        expect(editor).toContain('updateSceneCharacterCaptions')
        expect(editor).toContain("t('scene.addCharacterCaption'")
        expect(editor).toContain('<DndContext')
        expect(editor).toContain('data-testid="scene-available-characters"')
        expect(editor).toContain('testId="scene-character-included-zone"')
        expect(editor).toContain('testId="scene-character-excluded-zone"')
        expect(editor).toContain('placeSceneCharacterCaption')
        expect(await source('src/components/scene/ScenePromptEditor.tsx')).toContain('availableCharacters={mainCharacters}')
        expect(mainCharacterPanel).toContain('onUpdate({ prompt: value })')
        expect(mainCharacterPanel).toContain('onUpdate({ negative: value })')
        expect(mainCharacterPanel).not.toContain('const debounceRef')
        expect(sceneBuilder).toContain('resolveSceneCharacterCaptions(scene)')
        expect(legacyBuilder).toContain('resolveSceneCharacterCaptions(scene)')
    })

    it('owns resolution per scene and fits every generated preview without cropping', async () => {
        const sceneDetail = await source('src/pages/SceneDetail.tsx')
        const editor = await source('src/components/scene/ScenePromptEditor.tsx')
        const sceneBuilder = await source('src/lib/scene-generation/build-scene-params.ts')

        expect(editor).toContain('data-testid="scene-resolution-selector"')
        expect(editor).toContain('updateSettings(presetId, scene.id')
        expect(sceneBuilder).toContain('width: roundTo64(scene.width ?? 832)')
        expect(sceneBuilder).toContain('height: roundTo64(scene.height ?? 1216)')
        expect(sceneDetail).toContain('style={{ aspectRatio: previewAspectRatio }}')
        expect(sceneDetail).toContain('data-scene-preview-resolution={resolutionLabel}')
        expect(sceneDetail).toContain('className="h-full w-full object-contain"')
        expect(sceneDetail).not.toContain('thumbnailLayout={thumbnailLayout}')
    })

    it('keeps a saved V4.5 Variety+ choice hidden while a scene uses V5', async () => {
        const editor = await source('src/components/scene/ScenePromptEditor.tsx')

        expect(editor).toContain('const isV5 = isNovelAiV5Model(generation.model)')
        expect(editor).toMatch(/\{!isV5 && \([\s\S]*?generation\.variety/)
        expect(editor).not.toMatch(/generation\.variety[\s\S]*?disabled=\{isV5\}/)
        expect(editor).toContain("value={isV5 ? 'karras' : generation.scheduler}")
        expect(editor).toContain('disabled={disabled || isV5}')
        expect(editor).toContain("t('parameters.v5Karras'")
    })
})
