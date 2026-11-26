import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
    calculateCharacterLayoutVirtualRange,
    calculateModuleStackVirtualRange,
    CHARACTER_LAYOUT_ROW_HEIGHT,
    CharacterLayoutEditor,
    CompositionCommandBar,
    MobileCommandDock,
    MODULE_STACK_ROW_HEIGHT,
    ModuleStack,
    type CharacterLayoutItem,
    type ModuleStackItem,
} from '@/components/composition-workspace'
import { calculateSceneGridVirtualRange } from '@/components/scene/scene-grid-virtualization'

const source = (path: string) => readFile(resolve(process.cwd(), path), 'utf8')

const longNames = {
    ko: '매우 긴 캐릭터 조명 및 배경 합성 모듈 이름 — 전체 접근성 이름을 보존해야 합니다',
    en: 'Extremely long character lighting and background composition module name that must remain accessible',
    ja: '非常に長いキャラクター照明と背景コンポジションモジュール名は完全なアクセシブル名を保持します',
} as const

function makeModules(count: number): ModuleStackItem[] {
    return Array.from({ length: count }, (_, index) => ({
        id: `module:${index}`,
        name: index < 3 ? Object.values(longNames)[index] : `Module ${index}`,
        kind: index % 2 === 0 ? 'prompt' : 'params',
        enabled: index % 7 !== 0,
        order: index,
        summary: `A deliberately long summary ${index}`,
        validation: { severity: index % 11 === 0 ? 'warning' : 'valid' },
    }))
}

describe('composition workspace module virtualization', () => {
    it('keeps a bounded, clamped window for a 500-module stack', () => {
        expect(calculateModuleStackVirtualRange({
            itemCount: 500,
            scrollTop: 0,
            viewportHeight: 560,
        })).toEqual({ start: 0, end: 12 })
        expect(calculateModuleStackVirtualRange({
            itemCount: 500,
            scrollTop: 250 * MODULE_STACK_ROW_HEIGHT,
            viewportHeight: 560,
        })).toEqual({ start: 245, end: 262 })
        expect(calculateModuleStackVirtualRange({
            itemCount: 5,
            scrollTop: Number.POSITIVE_INFINITY,
            viewportHeight: Number.NaN,
        })).toEqual({ start: 0, end: 5 })
    })

    it('renders only the virtual window and preserves long locale names', () => {
        const modules = makeModules(500)
        const markup = renderToStaticMarkup(createElement(ModuleStack, {
            modules,
            activeModuleId: modules[0].id,
            onSelectModule: () => undefined,
            onToggleModule: () => undefined,
            onMoveModule: () => undefined,
            onEditModule: () => undefined,
        }))

        expect(markup.match(/data-module-id=/g)).toHaveLength(12)
        expect(markup).toContain(`height:${500 * MODULE_STACK_ROW_HEIGHT}px`)
        for (const name of Object.values(longNames)) expect(markup).toContain(name)
        expect(markup).toContain('role="list"')
        expect(markup).toContain('aria-label="Move up')
        expect(markup).toContain('aria-label="Edit')
    })
})

describe('composition workspace large data contracts', () => {
    it('keeps 200 character controls in a bounded virtual window with non-drag ordering', () => {
        const characters: CharacterLayoutItem[] = Array.from({ length: 200 }, (_, index) => ({
            id: `character:${index}`,
            name: `Character ${index}`,
            enabled: true,
            order: index,
            position: { mode: 'ai-choice' },
        }))
        expect(calculateCharacterLayoutVirtualRange({
            itemCount: 200,
            scrollTop: 100 * CHARACTER_LAYOUT_ROW_HEIGHT,
            viewportHeight: 560,
        })).toEqual({ start: 97, end: 105 })
        const markup = renderToStaticMarkup(createElement(CharacterLayoutEditor, {
            characters,
            onChangePosition: () => undefined,
            onMoveCharacter: () => undefined,
        }))
        expect(markup.match(/<fieldset/g)).toHaveLength(5)
        expect(markup).toContain('data-virtualized="true"')
        expect(markup).toContain(`height:${200 * CHARACTER_LAYOUT_ROW_HEIGHT}px`)
        expect(markup).toContain('aria-label="Move down Character 0"')
    })

    it('row-aligns a bounded virtual range for 1,000 responsive scene cards', () => {
        expect(calculateSceneGridVirtualRange({
            itemCount: 1_000,
            columnCount: 4,
            scrollTop: 100 * 480,
            viewportHeight: 960,
            rowHeight: 480,
        })).toEqual({
            startRow: 98,
            endRow: 104,
            startIndex: 392,
            endIndex: 416,
            paddingTop: 47_040,
            paddingBottom: 70_080,
        })
    })

    it('preserves a 20,000-character prompt in wrapping editor/preview contracts', async () => {
        const prompt = '긴 prompt / long prompt / 長いプロンプト '.repeat(800).slice(0, 20_000)
        expect(prompt).toHaveLength(20_000)
        const resolved = await source('src/components/composition-workspace/ResolvedPlanView.tsx')
        expect(resolved).toContain('whitespace-pre-wrap break-words')
        expect(resolved).not.toMatch(/positivePrompt\.slice|positivePrompt\.substring/)
    })
})

describe('composition workspace contextual commands', () => {
    const generation = {
        generating: false,
        onGenerate: () => undefined,
        onCancel: () => undefined,
    }

    it('renders only generation when compact controls have no applicable context', () => {
        const bar = renderToStaticMarkup(createElement(CompositionCommandBar, {
            generation,
            simplified: true,
        }))
        const dock = renderToStaticMarkup(createElement(MobileCommandDock, { generation }))

        for (const markup of [bar, dock]) {
            expect(markup).toContain('Generate')
            expect(markup).not.toContain('aria-label="Modules"')
            expect(markup).not.toContain('aria-label="Inspector"')
            expect(markup).not.toContain('aria-label="Resolved"')
        }
    })

    it('renders contextual actions only when their handlers and data are provided', () => {
        const bar = renderToStaticMarkup(createElement(CompositionCommandBar, {
            generation,
            simplified: true,
            cost: { value: '5 Anlas' },
            resolved: { available: true, onOpen: () => undefined },
            onOpenModules: () => undefined,
        }))
        const dock = renderToStaticMarkup(createElement(MobileCommandDock, {
            generation,
            resolvedAvailable: true,
            onOpenModules: () => undefined,
            onOpenResolved: () => undefined,
        }))

        expect(bar).toContain('5 Anlas')
        expect(bar).toContain('aria-label="Prompt groups"')
        expect(bar).toContain('Generation values')
        expect(bar).not.toContain('aria-label="Applied content"')
        expect(dock).toContain('aria-label="Modules"')
        expect(dock).toContain('aria-label="Resolved"')
        expect(dock).not.toContain('aria-label="Inspector"')
    })

    it('keeps storage settings separately actionable with every displayed value in its accessible name', () => {
        const bar = renderToStaticMarkup(createElement(CompositionCommandBar, {
            generation,
            simplified: true,
            summary: 'V4.5 · 832×1216 · 28 Steps',
            onOpenSummary: () => undefined,
            storage: {
                folder: 'Default / Portraits',
                format: 'WEBP',
                r2Status: 'R2 auto-upload off',
                label: 'Open storage settings',
                onOpen: () => undefined,
            },
        }))

        expect(bar).toContain('data-testid="composition-open-storage"')
        expect(bar).toContain('aria-label="Open storage settings: Default / Portraits · WEBP · R2 auto-upload off"')
        expect(bar).toContain('V4.5 · 832×1216 · 28 Steps')
        expect(bar).toContain('Default / Portraits')
        expect(bar).toContain('WEBP')
    })

    it('omits cost, count, and Generate columns when the docked Main rail owns execution controls', () => {
        const bar = renderToStaticMarkup(createElement(CompositionCommandBar, {
            generation: { ...generation, actionTestId: 'main-generate-action' },
            simplified: true,
            omitExecutionControls: true,
            summary: 'V5 · 832×1216 · 28 Steps',
            cost: { value: '29 Anlas' },
            count: createElement('span', null, '1'),
        }))

        expect(bar).toContain('grid-cols-1')
        expect(bar).toContain('V5 · 832×1216 · 28 Steps')
        expect(bar).not.toContain('29 Anlas')
        expect(bar).not.toContain('data-testid="main-generate-action"')
    })

    it('renders the simplified Main-style dock as exactly three command groups', () => {
        const dock = renderToStaticMarkup(createElement(MobileCommandDock, {
            generation: { ...generation, generateLabel: 'Generate 3 images' },
            labels: { settings: 'Settings' },
            onOpenSettings: () => undefined,
            count: createElement('button', { type: 'button', 'aria-label': 'Edit image count, currently 3' }, '3 images'),
            simplified: true,
        }))

        expect(dock.match(/<button/g)).toHaveLength(3)
        expect(dock).toContain('data-testid="composition-mobile-settings"')
        expect(dock).toContain('data-testid="composition-mobile-count"')
        expect(dock).toContain('data-command-group="primary"')
        expect(dock).toContain('Settings')
        expect(dock).toContain('3 images')
        expect(dock).toContain('Generate 3 images')
        expect(dock).not.toContain('aria-label="Modules"')
        expect(dock).not.toContain('aria-label="Resolved"')
    })
})

describe('composition workspace source contracts', () => {
    it('keeps shared components controlled and store-free', async () => {
        const files = [
            'src/components/composition-workspace/ModuleStack.tsx',
            'src/components/composition-workspace/CompositionInspector.tsx',
            'src/components/composition-workspace/CharacterLayoutEditor.tsx',
            'src/components/composition-workspace/CompositionCommandBar.tsx',
            'src/components/composition-workspace/MobileCommandDock.tsx',
        ]
        for (const file of files) {
            const contents = await source(file)
            expect(contents).not.toMatch(/useGenerationStore|useSceneStore|useAssetModuleStore|\.setState\(/)
        }
    })

    it('provides keyboard and explicit non-drag ordering', async () => {
        const [modules, characters] = await Promise.all([
            source('src/components/composition-workspace/ModuleStack.tsx'),
            source('src/components/composition-workspace/CharacterLayoutEditor.tsx'),
        ])
        for (const contents of [modules, characters]) {
            expect(contents).toContain("event.altKey")
            expect(contents).toContain("event.key === 'ArrowUp'")
            expect(contents).toContain("event.key === 'ArrowDown'")
            expect(contents).toContain("direction: 'up' | 'down'")
            expect(contents).toContain('h-11')
        }
    })

    it('uses focus-trapped sheets with explicit focus return and four-edge safe area', async () => {
        const [workspaceSheet, primitiveSheet] = await Promise.all([
            source('src/components/composition-workspace/CompositionWorkspaceSheet.tsx'),
            source('src/components/ui/sheet.tsx'),
        ])
        expect(workspaceSheet).toContain('<Sheet open={open} onOpenChange={onOpenChange} modal>')
        expect(workspaceSheet).toContain('onCloseAutoFocus')
        expect(workspaceSheet).toContain('returnFocusRef.current.focus()')
        for (const edge of ['top', 'right', 'bottom', 'left']) {
            expect(workspaceSheet).toContain(`safe-area-inset-${edge}`)
        }
        expect(primitiveSheet).toContain('h-11 w-11')
        expect(primitiveSheet).toContain('aria-label={closeLabel}')
    })

    it('keeps the command dock direct and safe-area aware', async () => {
        const [bar, dock, layout] = await Promise.all([
            source('src/components/composition-workspace/CompositionCommandBar.tsx'),
            source('src/components/composition-workspace/MobileCommandDock.tsx'),
            source('src/components/composition-workspace/CompositionWorkspaceLayout.tsx'),
        ])
        expect(bar).toContain('data-testid="composition-command-bar"')
        expect(bar).toContain('data-testid="composition-open-modules"')
        expect(bar).toContain('data-testid="composition-open-inspector"')
        expect(bar).toContain('h-11 min-w-11 max-w-full')
        expect(bar).not.toContain('2xl:hidden')
        expect(bar).toContain('generation.onCancel')
        expect(bar).toContain('generation.onGenerate')
        expect(bar).toContain('mode?: CompositionSelectControl')
        expect(bar).toContain('recipe?: CompositionSelectControl')
        expect(bar).toContain('validation?: CompositionValidationSummary')
        expect(bar).toContain('resolved?: CompositionResolvedControl')
        expect(dock).toContain('safe-area-inset-bottom')
        expect(dock).toContain("testId = 'composition-mobile-command-dock'")
        expect(dock).toContain('data-testid={testId}')
        expect(dock).toContain('generation.actionTestId')
        expect(dock).toContain('aria-label={labels.modules}')
        expect(dock).toContain('data-testid="composition-open-modules"')
        expect(dock).toContain('aria-label={labels.inspector}')
        expect(dock).toContain('aria-label={labels.resolved}')
        expect(dock).toContain('onOpenModules?: () => void')
        expect(dock).toContain('onOpenInspector?: () => void')
        expect(dock).toContain('onOpenResolved?: () => void')
        expect(dock).toContain('{onOpenModules && (')
        expect(dock).toContain('{onOpenResolved && resolvedAvailable && (')
        expect(layout).toContain('grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)_minmax(18rem,24rem)]')
        expect(layout).toContain('overflow-x-hidden')
        expect(layout).not.toContain('<main')
    })

    it('renders Counter values immediately when reduced motion is requested', async () => {
        const counter = await source('src/components/ui/counter.tsx')

        expect(counter).toContain('useReducedMotion()')
        expect(counter).toMatch(/shouldReduceMotion[\s\S]*?<span className="counter-static-number">\{value\}<\/span>[\s\S]*?: places\.map/)
    })

    it('covers resolved prompts, params winners, output, issues, random trace, and provenance', async () => {
        const resolved = await source('src/components/composition-workspace/ResolvedPlanView.tsx')
        for (const field of [
            'positivePrompt',
            'negativePrompt',
            'promptParts',
            'characters',
            'param.winner.layer',
            'outputPolicy',
            'randomTrace',
            'provenanceDetails',
            'planHash.digest',
            'onRepairIssue',
        ]) {
            expect(resolved).toContain(field)
        }
        expect(resolved).not.toMatch(/overflow-x-(?:auto|scroll)/)
    })

    it('formalizes all requested Composition workspace contracts in DESIGN.md', async () => {
        const design = await source('DESIGN.md')
        for (const contract of [
            'Composition action rail',
            'Module Stack row anatomy',
            'Inspector and sheet behavior',
            'Resolved Plan',
            'Conflict severity',
            'Long text',
            'Virtualization',
            'Mobile command dock',
        ]) {
            expect(design).toContain(contract)
        }
    })
})
