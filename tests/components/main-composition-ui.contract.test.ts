import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFile(resolve(process.cwd(), path), 'utf8')

describe('Main composition UI contract', () => {
    it('uses the shared three-zone composition workspace while preserving the result canvas', async () => {
        const [mainMode, workspaceLayout] = await Promise.all([
            source('src/pages/MainMode.tsx'),
            source('src/components/composition-workspace/CompositionWorkspaceLayout.tsx'),
        ])

        expect(mainMode).toContain('<CompositionWorkspaceLayout')
        expect(mainMode).toContain('moduleStack={moduleStack}')
        expect(mainMode).toContain('workspaceClassName="border-y border-border/60 bg-canvas"')
        expect(mainMode).toContain('data-testid="main-result-canvas"')
        expect(mainMode).toContain('<CompositionInspector')
        expect(mainMode).toContain('<ModuleStack')
        expect(workspaceLayout).toContain("desktopRails && '2xl:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)_minmax(18rem,24rem)]'")
        expect(mainMode).toContain('desktopRails={false}')
        expect(workspaceLayout).toContain('overflow-x-hidden')
    })

    it('routes the one-action generation control through the durable command with legacy rollback', async () => {
        const [mainMode, command] = await Promise.all([
            source('src/pages/MainMode.tsx'),
            source('src/services/generation/generation-command.ts'),
        ])

        expect(mainMode).toMatch(/const handlePrimaryGeneration = \(\) => \{[\s\S]*?cancelMainGenerationCommand\(\)[\s\S]*?startMainGenerationCommand\(\)/)
        expect(mainMode).toContain("actionTestId: 'main-generate-action'")
        expect(mainMode).toContain('onGenerate: reviewingBlockedPlan ? handleOpenResolvedPlan : handlePrimaryGeneration')
        expect(mainMode).toContain('onCancel: () => void cancelMainGenerationCommand()')
        expect(mainMode).toContain('<MobileCommandDock')
        expect(mainMode).toContain('safe-area-inset-bottom')
        expect(command).toContain("executionAuthority === 'legacy'")
        expect(command).toContain("return 'low-quality-steps'")
        expect(command).toContain('await generation.generate()')
        expect(command).toContain('enqueuePreparedMainGeneration({')
        expect(command).toContain('cancelGeneration({')
        expect(command).not.toContain('enqueueCurrentMainBatch()')
        expect(mainMode).toContain("outcome !== 'low-quality-steps'")
    })

    it('moves compact module, inspector, and resolved content into focus-managed sheets', async () => {
        const mainMode = await source('src/pages/MainMode.tsx')

        expect(mainMode).toContain('testId="main-module-stack-sheet"')
        expect(mainMode).toContain('testId="main-composition-inspector-sheet"')
        expect(mainMode).toContain('testId="main-resolved-plan-sheet"')
        expect(mainMode).toContain('level="secondary"')
        expect(mainMode).toContain('returnFocusRef={moduleSheetTriggerRef}')
        expect(mainMode).toContain('returnFocusRef={inspectorSheetTriggerRef}')
        expect(mainMode).toContain('returnFocusRef={resolvedSheetTriggerRef}')
        expect(mainMode).toContain('inspectorSheetTriggerRef.current = currentTrigger()')
        expect(mainMode).toMatch(/const handleOpenPromptFromSettings[\s\S]*?setModuleSheetOpen\(false\)[\s\S]*?requestAnimationFrame\(handleOpenPromptSheet\)/)
    })

    it('hands a selected module from its sheet to the Inspector at every desktop width', async () => {
        const mainMode = await source('src/pages/MainMode.tsx')

        expect(mainMode).toMatch(/const handleSelectModule[\s\S]*?setSelectedModuleId\(moduleId\)[\s\S]*?if \(moduleSheetOpen\)[\s\S]*?setInspectorSheetOpen\(true\)/)
        expect(mainMode).not.toContain('isDockedWorkspace')
    })

    it('keeps raw prompt authoring behind the existing Prompt sheet compatibility entry', async () => {
        const mainMode = await source('src/pages/MainMode.tsx')

        expect(mainMode).toContain('const handleOpenPromptSheet = () => promptSurface.ensureVisible()')
        expect(mainMode).not.toContain('LAYOUT_SHEET_EVENTS')
        expect(mainMode).toContain("t('composition.compatibility.rawPrompt', '직접 프롬프트 편집')")
        expect(mainMode).not.toContain('<AutocompleteTextarea')
    })

    it('keeps the simplified mobile dock to Settings, quantity, and a quantity-aware primary action', async () => {
        const mainMode = await source('src/pages/MainMode.tsx')
        const mobileStart = mainMode.indexOf('const mobileDock =')
        const mobileEnd = mainMode.indexOf('\n\n    return (', mobileStart)
        const mobileDock = mainMode.slice(mobileStart, mobileEnd)

        expect(mobileDock).toContain('onOpenSettings={handleOpenModuleStack}')
        expect(mobileDock).toContain('count={mobileCountButton}')
        expect(mobileDock).toContain('simplified')
        expect(mobileDock).toContain("t('generate.settings'")
        expect(mobileDock).toContain("t('generate.imagesButton'")
        expect(mobileDock).not.toContain('onOpenModules=')
        expect(mobileDock).not.toContain('onOpenResolved=')
        expect(mainMode).toContain('data-testid="main-mobile-count"')
        expect(mainMode).toContain('className="min-w-11 px-2 tabular-nums"')
        expect(mainMode).toContain('data-testid="main-mobile-settings-hub"')
        expect(mainMode).toContain("t('composition.compatibility.rawPrompt'")
        expect(mainMode).toContain("t('composition.plan.open'")
        expect(mainMode).toContain('{batchCounter}')
        expect(mainMode).toContain('<RecipeSelector onChange={handleRecipeSelection} />')
        expect(mainMode).toContain('{moduleStack}')
    })

    it('keeps prompt authoring free of duplicated composition diagnostics', async () => {
        const [promptPanel, coreParameters, editor, slotTabs, controls, autocomplete] = await Promise.all([
            source('src/components/layout/PromptPanel.tsx'),
            source('src/components/prompt/PromptCoreParameters.tsx'),
            source('src/components/prompt/PromptEditorSurface.tsx'),
            source('src/components/prompt/PromptSlotTabs.tsx'),
            source('src/components/prompt/PromptGenerationControls.tsx'),
            source('src/components/ui/AutocompleteTextarea.tsx'),
        ])

        expect(promptPanel).not.toMatch(/isMainMode|RecipeSelector|ResolvedPlanPanel|ValidationBadge/)
        expect(promptPanel).toContain('<PromptEditorSurface')
        expect(promptPanel).toContain("const isAdvancedMode = location.pathname === '/advanced'")
        expect(promptPanel).toContain('{!isAdvancedMode && <PromptGenerationControls isSceneMode={isSceneMode} />}')
        expect(promptPanel).toContain('<PromptCoreParameters />')
        expect(coreParameters).toContain("t('generate.restoreRecommendedSteps'")
        expect(promptPanel).toContain('if (!isGenerating) setFragmentDialogOpen')
        expect(promptPanel).toContain('if (isGenerating) setFragmentDialogOpen(false)')
        expect(promptPanel).toContain('onOpenFragment={() => setFragmentDialogOpen(true)}')
        expect(editor).toContain('<AutocompleteTextarea')
        expect(editor).toContain('<PromptSlotTabs')
        expect(slotTabs).toContain('aria-controls={panelId}')
        expect(slotTabs).toContain("event.key === 'ArrowRight'")
        expect(slotTabs).toContain('tabIndex={active ? 0 : -1}')
        expect(slotTabs).toContain('grid grid-cols-4')
        expect(slotTabs).toContain('truncate whitespace-nowrap')
        expect(editor).toContain("'h-40 min-h-40 resize-none rounded-none")
        expect(editor).not.toContain("'h-full min-h-28")
        expect(editor).toContain('data-testid="prompt-frequency-sort-all"')
        expect(editor).toContain('data-testid="prompt-frequency-sort-undo"')
        expect(editor).toContain('<ContextMenuTrigger asChild>')
        expect(editor).toContain("t('promptFrequencySort.sortSelection'")
        expect(editor).toContain('<PromptFrequencySortDialog')
        expect(editor).toContain('range: [contextSnapshot.selectionStart, contextSnapshot.selectionEnd]')
        expect(autocomplete).toContain('onBlur={flushPendingChange}')
        expect(autocomplete).toContain('return flushPendingChange')
        expect(autocomplete).toMatch(/onContextMenu=\{\(event\) => \{[\s\S]*?flushPendingChange\(\)[\s\S]*?onPromptContextMenu\?\.\(\{/)
        expect(controls).toContain('data-testid="prompt-generate-action"')
        expect(controls).toContain('<NovelAiV5UsageLimit')
        expect(controls).toContain("pricingBasis: 'paid'")
    })

    it('shows Variety+ only for the legacy models that support CFG Delay', async () => {
        const promptPanel = await source('src/components/layout/PromptPanel.tsx')

        expect(promptPanel).toMatch(/Variety\+ is a V4\/V4\.5 CFG Delay control[\s\S]*?\{!isV5 && \(/)
        expect(promptPanel).not.toContain('v5VarietyPending')
        expect(promptPanel).not.toMatch(/checked=\{variety\}[\s\S]*?disabled=\{isV5\}/)
        expect(promptPanel).not.toMatch(/setSmea|SMEA DYN|parameters\.smea/)
    })

    it('keeps the shared prompt action cancellable while Style Lab owns the generation store', async () => {
        const [controls, command, shortcuts] = await Promise.all([
            source('src/components/prompt/PromptGenerationControls.tsx'),
            source('src/services/generation/prompt-generation-command.ts'),
            source('src/hooks/useShortcuts.ts'),
        ])

        expect(controls).toContain("const isStyleLabGenerating = generatingMode === 'styleLab'")
        expect(controls).toMatch(/const isConflict = isSceneMode[\s\S]*?: isSceneGenerating\s/)
        expect(controls).not.toMatch(/: isSceneGenerating \|\| isStyleLabGenerating/)
        expect(command).toMatch(/if \(generation\.isGenerating\) \{[\s\S]*?cancelMainGenerationCommand\(\)/)
        expect(command).toContain("if (generation.generatingMode === 'scene') return 'blocked-conflict'")
        expect(shortcuts).toContain("void executePromptGenerationCommand('main')")
        expect(shortcuts).toContain('if (useGenerationStore.getState().isGenerating) return')
        expect(shortcuts).not.toContain('cancelMainGenerationCommand')
        expect(shortcuts).not.toContain('startMainGenerationCommand')
    })

    it('does not connect the Main composition controls to Scene or Style Lab', async () => {
        const [sceneMode, sceneDetail, styleLab] = await Promise.all([
            source('src/pages/SceneMode.tsx'),
            source('src/pages/SceneDetail.tsx'),
            source('src/pages/StyleLab.tsx'),
        ])

        for (const page of [sceneMode, sceneDetail, styleLab]) {
            expect(page).not.toMatch(/RecipeSelector|ResolvedPlanPanel|ValidationBadge/)
        }
    })

    it('offers the stable direct recipe and mirrors the adapter automatic-selection policy', async () => {
        const recipeSelector = await source('src/components/composition/RecipeSelector.tsx')

        expect(recipeSelector).toContain('getMainDirectRecipeId')
        expect(recipeSelector).toContain('MAIN_DIRECT_SELECTION_ID')
        expect(recipeSelector).toContain('mainAssetRecipeSelectionId')
        expect(recipeSelector).toContain('const displayedRecipeId = selectedRecipeId === null')
        expect(recipeSelector).toContain('const titleId = `main-composition-recipe-title-${useId()')
        expect(recipeSelector).toContain('aria-labelledby={titleId}')
        expect(recipeSelector).toContain('<Label id={titleId}')
        expect(recipeSelector).toContain("t('composition.recipe.direct', 'Direct prompts')")
        expect(recipeSelector).toContain('if (recipes.length === 0 && selectedRecipeExists) return null')
        expect(recipeSelector).toContain('onValueChange={onChange ?? setSelectedRecipeId}')
        expect(recipeSelector).not.toMatch(/compositionMode|setCompositionMode|MODE_OPTIONS/)
    })

    it('shows only contextual Main commands and uses a valid cost basis', async () => {
        const [mainMode, generationStore] = await Promise.all([
            source('src/pages/MainMode.tsx'),
            source('src/services/generation/generation-runtime-store.ts'),
        ])
        const commandStart = mainMode.indexOf('const commandBar =')
        const commandEnd = mainMode.indexOf('const mobileDock =', commandStart)
        const commandBar = mainMode.slice(commandStart, commandEnd)

        expect(mainMode).toContain('const hasRecipeControls = assetProfile.recipes.length > 0')
        expect(mainMode).toContain('displayedRecipeSelection !== MAIN_DIRECT_SELECTION_ID')
        expect(mainMode).toContain('const hasModuleSheetContent = hasRecipeControls || hasModuleTools')
        expect(mainMode).toContain('const hasResolvedContent = resolvedPlan !== null')
        expect(commandBar).toContain('summary={generationSummary}')
        expect(commandBar).toContain('onOpenSummary={handleOpenSummaryFocus}')
        expect(commandBar).toContain('count={batchCounter}')
        expect(commandBar).toContain('cost={estimatedCost !== null ? {')
        expect(commandBar).toContain('resolved={hasResolvedContent ? {')
        expect(commandBar).toContain('onOpenModules={hasModuleSheetContent ? handleOpenModuleStack : undefined}')
        expect(commandBar).toContain('omitExecutionControls={renderActionsInRail}')
        expect(mainMode).toContain('createPortal(')
        expect(mainMode).toContain('data-testid="main-rail-actions"')
        expect(commandBar).toContain('simplified')
        expect(commandBar).not.toMatch(/\bmode=|validation=|\bseed=|onOpenInspector/)
        expect(commandBar).not.toContain('recipe=')
        expect(mainMode).toContain('preflightMainGeneration({')
        expect(mainMode).toContain('buildMainCompositionProjection({')
        expect(generationStore).toContain('buildMainCompositionProjection({')
        expect(generationStore).not.toContain('const snapshot: MainCompositionSnapshot')
        expect(mainMode).toContain('const resolvedParams = preflightAuthoritative ? resolvedPlan?.params : undefined')
        expect(mainMode).toContain('(resolvedOutput?.format ?? settings.imageFormat).toUpperCase()')
        expect(mainMode).toContain("t('composition.plan.r2Configured', 'R2 upload configured')")
        expect(mainMode).toContain('const blockingResolutionError = resolvedErrors.length + portableResolvedIssues.length > 0')
        expect(mainMode).toContain("const preflightAuthoritative = compositionMode === 'v2'")
        expect(mainMode).toContain('!ownsActiveGeneration && mainPreflightBlocksGeneration(compositionMode')
        expect(mainMode).toContain('const reviewingBlockedPlan = !isGenerating')
        expect(mainMode).toContain("t('composition.conflict.reviewAction', '변경사항 확인')")
        expect(mainMode).toContain("t('composition.plan.reviewIssues', '문제 확인')")
        expect(mainMode).toContain('onGenerate: reviewingBlockedPlan ? handleOpenResolvedPlan : handlePrimaryGeneration')
        expect(mainMode).toContain('const estimatedCost = preflightAuthoritative')
        expect(mainMode).toContain(': displayedRecipeSelection === MAIN_DIRECT_SELECTION_ID')
        expect(mainMode).toContain("if (compositionMode === 'legacy') return")
        expect(mainMode).not.toContain('lastResolvedPlan')
        expect(mainMode).toContain('onClick={handleOpenResolvedPlan}')
        expect(mainMode).toContain('<RecipeSelector onChange={handleRecipeSelection} />')
        expect(mainMode).toContain('commandBarPlacement="bottom"')
    })

    it('treats Main rollout mode as release authority instead of a persisted UI preference', async () => {
        const store = await source('src/services/generation/generation-runtime-store.ts')
        const partializeStart = store.indexOf('partialize:')
        const hydrateStart = store.indexOf('onRehydrateStorage:', partializeStart)
        const partialize = store.slice(partializeStart, hydrateStart)
        const hydration = store.slice(hydrateStart)

        expect(partialize).not.toContain('compositionMode: state.compositionMode')
        expect(partialize).toContain('selectedRecipeId: state.selectedRecipeId')
        expect(hydration).toContain("state.compositionMode = 'v2'")
    })
})
