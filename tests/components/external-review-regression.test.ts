import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import en from '../../src/i18n/locales/en.json'
import ja from '../../src/i18n/locales/ja.json'
import ko from '../../src/i18n/locales/ko.json'
import { reducer } from '../../src/components/ui/use-toast'

const source = (path: string) => readFile(resolve(process.cwd(), path), 'utf8')

describe('External review regression fixes', () => {
    it('keeps the Advanced action rail and prompt tabs stable without panel-card drift', async () => {
        const [commandBar, promptEditor, promptTabs, ...panels] = await Promise.all([
            source('src/components/composition-workspace/CompositionCommandBar.tsx'),
            source('src/components/prompt/PromptEditorSurface.tsx'),
            source('src/components/prompt/PromptSlotTabs.tsx'),
            source('src/components/composition-workspace/ModuleStack.tsx'),
            source('src/components/composition-workspace/CompositionInspector.tsx'),
            source('src/components/composition-workspace/ResolvedPlanView.tsx'),
        ])

        expect(commandBar).toContain('grid-cols-[minmax(0,1fr)_auto_auto_minmax(10rem,12rem)]')
        expect(commandBar).not.toContain('flex-wrap')
        expect(commandBar).not.toContain('rounded-panel')
        expect(promptEditor).not.toContain('flex-wrap')
        expect(promptTabs).toContain('grid grid-cols-4')
        expect(promptTabs).toContain('truncate whitespace-nowrap')
        for (const panel of panels) expect(panel).not.toContain('rounded-panel')
    })

    it('keeps engine vocabulary out of everyday authoring labels', () => {
        const forbidden = /\b(?:composition|canonical|repository revision|provenance|plan hash|3-way|override diff|resolved plan)\b/i
        for (const locale of [ko, en, ja]) {
            const publicCopy = [
                locale.composition.commandBar,
                ...Object.values(locale.composition.workspace),
                locale.composition.conflict.label,
                locale.composition.conflict.externalEdit,
                locale.composition.conflict.review,
                locale.composition.plan.title,
                locale.composition.plan.open,
                locale.composition.plan.resolved,
                locale.composition.plan.help,
                locale.composition.compatibility.rawPrompt,
            ].join(' ')
            expect(publicCopy).not.toMatch(forbidden)
            expect(locale.composition.plan.technical.trim()).not.toHaveLength(0)
        }
    })

    it('keeps storage-result labels in parity and describes R2 as configuration state', () => {
        for (const locale of [ko, en, ja]) {
            for (const key of ['generationFolder', 'outputDirectory', 'format', 'metadata', 'r2AutoUpload', 'r2Configured', 'r2Off', 'openStorage'] as const) {
                expect(locale.composition.plan[key].trim()).not.toHaveLength(0)
            }
            expect(locale.composition.plan.r2Configured).not.toMatch(/ready|scheduled|준비|예정|準備|予定/i)
            expect(locale.composition.plan.uploadOff).toMatch(/R2/i)
        }
    })

    it('projects Main storage authority into presentation props without widening the engine plan', async () => {
        const [main, resolved] = await Promise.all([
            source('src/pages/MainMode.tsx'),
            source('src/components/composition-workspace/ResolvedPlanView.tsx'),
        ])

        expect(main).toContain("navigate('/settings?section=storage')")
        expect(main).toContain('generationFolderPath: activeGenerationFolder.path')
        expect(main).toContain('outputDirectory,')
        expect(main).toContain('r2AutoUpload: activeGenerationFolder.r2.autoUpload')
        expect(resolved).toContain('saveContext?: {')
        expect(resolved).not.toMatch(/CompositionEnginePlan[^\n]*saveContext/)
    })

    it('preserves native Tab traversal and assigns page cycling to modified keys', async () => {
        const [hook, store] = await Promise.all([
            source('src/hooks/useShortcuts.ts'),
            source('src/stores/shortcut-store.ts'),
        ])

        expect(hook).toContain('if (shouldPreserveNativeTabNavigation(e)) return')
        expect(hook).toContain("event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey")
        expect(store).toContain("'navigate:next': { key: 'PageDown', ctrl: true")
        expect(store).toContain("'navigate:prev': { key: 'PageUp', ctrl: true")
        expect(store).toContain("binding.key.toLowerCase() === 'tab'")
    })

    it('does not emit retired asset-module routes from active UI entry points', async () => {
        const paths = [
            'src/pages/MainMode.tsx',
            'src/pages/SceneMode.tsx',
            'src/pages/SceneDetail.tsx',
            'src/components/guidance/ProductGuidance.tsx',
        ]
        const sources = await Promise.all(paths.map(source))

        for (const contents of sources) expect(contents).not.toContain('/asset-modules')
        expect(sources.at(-1)).toContain("navigate('/r2')")
    })

    it('keeps three recent notifications instead of silently replacing each one', () => {
        let state = { toasts: [] as Array<{ id: string; title: string }> }
        for (const id of ['1', '2', '3', '4']) {
            state = reducer(state, {
                type: 'ADD_TOAST',
                toast: { id, title: id },
            }) as typeof state
        }

        expect(state.toasts.map(toast => toast.id)).toEqual(['4', '3', '2'])
    })

    it('describes the analysis provider that the current UI actually calls', () => {
        for (const locale of [ko, en, ja]) {
            expect(locale.smartTools.analysisDescription).toMatch(/Kaloscope/i)
            expect(locale.smartTools.analysisDescription).not.toMatch(/WD Tagger/i)
        }
    })

    it('keeps Enhance MAX visible with a V5 compatibility explanation', async () => {
        const toolsMode = await source('src/pages/ToolsMode.tsx')

        expect(toolsMode).toContain('smartTools.enhanceMax')
        expect(toolsMode).toContain('smartTools.enhanceMaxUnsupported')
        expect(ko.smartTools.enhanceMaxUnsupported).toContain('선택한 이미지 모델')
        expect(ko.smartTools.enhanceMaxTooLarge).toContain('80%')
    })
})
