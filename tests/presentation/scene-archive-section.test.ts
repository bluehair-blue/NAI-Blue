import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance, type TFunction } from 'i18next'
import { describe, expect, it, vi } from 'vitest'
import { ArchivedPresetsSection, archivedPresetRows } from '@/components/scene/SceneFolderManagerDialog'
import type { ScenePreset, SceneCard } from '@/stores/scene-store'

const scene = (id: string) => ({ id, name: id, scenePrompt: '', queueCount: 0, images: [], createdAt: 1 }) as SceneCard
const preset = (id: string, patch: Partial<ScenePreset> = {}): ScenePreset => ({ id, name: `${id} name`, scenes: [], parentId: null, createdAt: 1, ...patch })
const presets: ScenePreset[] = [
    preset('scene-default'),
    preset('working', { scenes: [scene('w1')] }),
    preset('draft', { archivedAt: 2_000, scenes: [scene('d1'), scene('d2')] }),
    preset('draft-child', { parentId: 'draft', archivedAt: 2_000, scenes: [scene('c1')] }),
    preset('old', { archivedAt: 1_000 }),
    preset('archived-under-working', { parentId: 'working', archivedAt: 3_000 }),
]

async function translator(): Promise<TFunction> {
    const i18n = createInstance()
    await i18n.init({ lng: 'ko', resources: {}, interpolation: { escapeValue: false } })
    return i18n.t
}
function props(t: TFunction, patch: Partial<Parameters<typeof ArchivedPresetsSection>[0]> = {}) {
    return { rows: archivedPresetRows(presets), expanded: false, onToggle: vi.fn(), confirmDeleteId: null, onRestore: vi.fn(),
        onRequestDelete: vi.fn(), onCancelDelete: vi.fn(), onConfirmDelete: vi.fn(), t, ...patch }
}
/** Finds an element by aria-label in the tree the section returns, so its handlers can be called without a DOM. */
function byLabel(node: ReactNode, label: string): ReactElement<{ onClick: () => void }> | undefined {
    if (Array.isArray(node)) return node.map(child => byLabel(child, label)).find(Boolean)
    if (!isValidElement(node)) return undefined
    const element = node as ReactElement<{ 'aria-label'?: string; children?: ReactNode; onClick: () => void }>
    return element.props['aria-label'] === label ? element : byLabel(element.props.children, label)
}

describe('preset manager archive section', () => {
    it('lists one row per archive action, newest first, with the branch it restores or deletes', () => {
        expect(archivedPresetRows(presets).map(row => [row.preset.id, row.path, row.folders, row.scenes])).toEqual([
            ['archived-under-working', 'working name / archived-under-working name', 1, 0],
            ['draft', 'draft name', 2, 3],
            ['old', 'old name', 1, 0],
        ])
        expect(archivedPresetRows([preset('scene-default'), preset('working')])).toEqual([])
        // An archived parentId cycle from old data has no member under an active parent; it still gets one row.
        const cycle = [preset('scene-default'), preset('a', { parentId: 'b', archivedAt: 5 }), preset('b', { parentId: 'a', archivedAt: 5 })]
        expect(archivedPresetRows(cycle).map(row => [row.preset.id, row.folders])).toEqual([['a', 2]])
    })

    it('is collapsed by default with its count, hidden when empty, and shows restore and delete per row when opened', async () => {
        const t = await translator()
        const collapsed = renderToStaticMarkup(createElement(ArchivedPresetsSection, props(t)))
        expect(collapsed).toContain('보관함 (3)')
        expect(collapsed).toContain('aria-expanded="false"')
        expect(collapsed).not.toContain('draft name')
        expect(renderToStaticMarkup(createElement(ArchivedPresetsSection, props(t, { rows: [] })))).toBe('')
        const open = renderToStaticMarkup(createElement(ArchivedPresetsSection, props(t, { expanded: true })))
        expect(open).toContain('aria-expanded="true"')
        expect(open).toContain('draft name')
        expect(open).toContain('폴더 2개 · 씬 3개')
        expect(open).toContain('aria-label="draft name 복원"')
        expect(open).toContain('aria-label="draft name 삭제"')
        expect(open).not.toContain('role="alert"')
    })

    it('restores at once but deletes only through the confirmation that names the branch', async () => {
        const t = await translator()
        const handlers = props(t, { expanded: true })
        const tree = ArchivedPresetsSection(handlers)
        byLabel(tree, 'draft name 복원')!.props.onClick()
        expect(handlers.onRestore).toHaveBeenCalledWith('draft')
        byLabel(tree, 'draft name 삭제')!.props.onClick()
        expect(handlers.onRequestDelete).toHaveBeenCalledWith('draft')
        expect(handlers.onConfirmDelete).not.toHaveBeenCalled()
        const confirming = renderToStaticMarkup(createElement(ArchivedPresetsSection, { ...handlers, confirmDeleteId: 'draft' }))
        expect(confirming).toContain('role="alert"')
        expect(confirming).toContain('폴더 2개와 씬 3개를 삭제할까요?')
        expect(confirming).toContain('휴지통으로 이동')
    })
})
