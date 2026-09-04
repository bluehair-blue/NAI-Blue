import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFile(resolve(process.cwd(), path), 'utf8')

describe('Scene composition workspace information architecture', () => {
    it('uses the prompt-first shell, explicit rail sheets, resolved plan, and mobile command dock', async () => {
        const workspace = await source('src/components/scene/SceneCompositionWorkspace.tsx')

        expect(workspace).toContain('<CompositionWorkspaceLayout')
        expect(workspace).toContain('desktopRails={false}')
        expect(workspace).toContain('<ModuleStack')
        expect(workspace).toContain('<CompositionInspector')
        expect(workspace).toContain('<CompositionCommandBar')
        expect(workspace).toContain('<MobileCommandDock')
        expect(workspace).toContain('<ResolvedPlanView')
        expect(workspace).toContain('testId="scene-modules-sheet"')
        expect(workspace).toContain('testId="scene-inspector-sheet"')
        expect(workspace).toContain('testId="scene-resolved-plan-sheet"')
        expect(workspace).toContain('level="secondary"')
        expect(workspace).toContain('useTranslation()')
        expect(workspace).toContain("t('composition.workspace.moduleStack'")
        expect(workspace).toContain("t('scene.composition.inspector'")
        expect(workspace).toContain("t('composition.plan.help'")
    })

    it('captures the real launcher and opens the inspector as a second-level module flow', async () => {
        const workspace = await source('src/components/scene/SceneCompositionWorkspace.tsx')

        expect(workspace).toContain('document.activeElement instanceof HTMLElement')
        expect(workspace).toContain('returnFocusRef={modulesReturnFocusRef}')
        expect(workspace).toContain('returnFocusRef={inspectorReturnFocusRef}')
        expect(workspace).toContain('returnFocusRef={resolvedReturnFocusRef}')
        expect(workspace).toMatch(/const selectModule[\s\S]*onSelectModule\(moduleId\)[\s\S]*if \(modulesOpen\) openInspector\(\)/)
    })

    it('keeps rollout and diagnostic controls out of simplified Scene surfaces', async () => {
        const workspace = await source('src/components/scene/SceneCompositionWorkspace.tsx')

        expect(workspace).toContain('mode={simplified ? undefined : mode}')
        expect(workspace).toContain('recipe={simplified ? undefined : recipe}')
        expect(workspace).toContain('validation={simplified ? undefined : validation}')
        expect(workspace).toContain('resolved={simplified ? undefined : {')
        expect(workspace).toContain('onOpenModules={simplified ? undefined : openModules}')
        expect(workspace).toContain('onOpenResolved={simplified ? undefined : openResolved}')
    })

    it('keeps Scene grid, create/edit, queue and generation as first-class actions', async () => {
        const sceneMode = await source('src/pages/SceneMode.tsx')
        const compactGroup = sceneMode.indexOf('Compact grouping keeps import')
        const dropdownStart = sceneMode.indexOf('<DropdownMenu>', compactGroup)
        const createAction = sceneMode.indexOf("aria-label={t('scene.addScene')}")
        const editAction = sceneMode.indexOf("aria-label={t('scene.editMode'")

        expect(sceneMode).toContain('data-testid="scene-grid-workspace"')
        expect(sceneMode).toContain('actionTestId: \'scene-generate-action\'')
        expect(sceneMode).toContain('cancelTestId: \'scene-cancel-action\'')
        expect(sceneMode).toContain('handleWorkspaceRecipeChange')
        expect(sceneMode).toContain('setSceneCompositionRef(activePresetId, sceneId')
        expect(sceneMode).not.toContain('data-testid="scene-bulk-recipe"')
        expect(sceneMode).toContain('editSceneSettingsIndividually')
        expect(sceneMode).toContain('<SceneCompositionCardMeta')
        expect(createAction).toBeGreaterThan(-1)
        expect(editAction).toBeGreaterThan(-1)
        expect(createAction).toBeLessThan(dropdownStart)
        expect(editAction).toBeLessThan(dropdownStart)
    })

    it('keeps rollout mode IDs internal while localizing Scene mode and validation labels', async () => {
        const sceneMode = await source('src/pages/SceneMode.tsx')

        expect(sceneMode).toContain("const SCENE_COMPOSITION_MODES: readonly SceneCompositionMode[] = ['legacy', 'shadow', 'v2']")
        expect(sceneMode).toContain("legacy: { key: 'composition.mode.previous', fallback: 'Previous generation engine' }")
        expect(sceneMode).toContain("shadow: { key: 'composition.mode.compatibility', fallback: 'Compatibility comparison' }")
        expect(sceneMode).toContain("v2: { key: 'composition.mode.current', fallback: 'Current generation engine' }")
        expect(sceneMode).toContain("label: t('composition.validation.legacy', 'Previous generation mode')")
        // Formatting may change independently; the contract is that the
        // persisted mode ID resolves through the localized label map.
        expect(sceneMode).toMatch(/label:\s*t\(\s*SCENE_COMPOSITION_MODE_LABEL_KEYS\[mode\]\.key,/)
        expect(sceneMode).not.toContain('options: SCENE_COMPOSITION_MODES.map(mode => ({ value: mode, label: mode }))')
        expect(sceneMode).not.toContain("label: 'legacy'")
    })

    it('keeps import/export/rotation/queue grouped while preserving the worker rollback seam', async () => {
        const sceneMode = await source('src/pages/SceneMode.tsx')
        const generationHook = await source('src/hooks/useSceneGeneration.ts')

        for (const command of [
            'handleImportClick',
            'setShowRotationDialog(true)',
            'addAllToQueue(activePresetId, batchCount)',
            'clearAllQueue(activePresetId)',
            'handleExportJson',
            'handleExportZip',
        ]) {
            expect(sceneMode).toContain(command)
        }
        expect(sceneMode).toContain('startNewGenerationSession()')
        expect(sceneMode).toContain('cancelSceneGeneration()')
        expect(sceneMode).toContain('prepareCurrentSceneQueueReview()')
        expect(sceneMode).toContain('<SceneQueueReviewDialog')
        expect(sceneMode).toContain('selectDurableBatch(result.batch.id)')
        expect(sceneMode).not.toContain('.drain()')
        expect(sceneMode).toContain("queueExecutionAuthority === 'legacy'")
        expect(generationHook).toContain('async function workerLoop')
        expect(generationHook).toContain("executionAuthority !== 'legacy' && !rotationActive")
    })

    it('moves raw prompts to compatibility UI and exposes typed override diff and character layout', async () => {
        const detail = await source('src/pages/SceneDetail.tsx')

        expect(detail).toContain('<SceneCompositionWorkspace')
        expect(detail).toContain('<CharacterLayoutEditor')
        expect(detail).toContain("advancedCompatibility', 'Advanced / compatibility prompt'")
        expect(detail).toContain("id: 'prompt'")
        expect(detail).toContain("id: 'resolution'")
        expect(detail).toContain("id: 'characters'")
        expect(detail).toContain("id: 'params'")
        expect(detail).toContain("id: 'output'")
        expect(detail).toContain('handleCharacterPositionChange')
        expect(detail).toContain('data-testid="scene-detail-workspace"')
        expect(detail).toContain('overflow-y-auto overscroll-contain')
        expect(detail).toContain('min-h-[20rem]')
        expect(detail).toContain('data-testid="scene-resolved-action"')
        expect(detail).toContain('SHORTCUT_EVENTS.OPEN_FRAGMENT_DIALOG')
    })

    it('routes Scene detail durable generation through explicit review and keeps legacy cancellation', async () => {
        const detail = await source('src/pages/SceneDetail.tsx')

        expect(detail).toContain("queueExecutionAuthority === 'legacy'")
        expect(detail).toContain('prepareCurrentSceneQueueReview()')
        expect(detail).toContain('<SceneQueueReviewDialog')
        expect(detail).toContain('selectDurableBatch(result.batch.id)')
        expect(detail).not.toContain('.drain()')
        expect(detail).not.toContain('enqueueCurrentSceneQueue()')
    })
})
