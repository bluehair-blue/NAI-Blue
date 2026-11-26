import { describe, expect, it } from 'vitest'

import {
    hasBlockingLayer,
    isEditableTarget,
    resolveGlobalShortcutDisposition,
} from '@/lib/keyboard/shortcut-scope'

const idle = { defaultPrevented: false, isComposing: false, repeat: false }

describe('global shortcut disposition', () => {
    it('runs only when no guard condition is active', () => {
        expect(resolveGlobalShortcutDisposition(idle, false)).toBe('run')
    })

    it('passes through untouched when an inner layer already handled the key', () => {
        expect(resolveGlobalShortcutDisposition({ ...idle, defaultPrevented: true }, false)).toBe('pass-through')
        expect(resolveGlobalShortcutDisposition({ ...idle, defaultPrevented: true }, true)).toBe('pass-through')
    })

    it('passes through untouched during IME composition (isComposing or keyCode 229)', () => {
        expect(resolveGlobalShortcutDisposition({ ...idle, isComposing: true }, false)).toBe('pass-through')
        expect(resolveGlobalShortcutDisposition({ ...idle, keyCode: 229 }, false)).toBe('pass-through')
        expect(resolveGlobalShortcutDisposition({ ...idle, isComposing: true, repeat: true }, true)).toBe('pass-through')
    })

    it('suppresses (blocks the browser default without running) repeated keydown events', () => {
        expect(resolveGlobalShortcutDisposition({ ...idle, repeat: true }, false)).toBe('suppress')
    })

    it('suppresses (blocks the browser default without running) while a blocking layer is open', () => {
        expect(resolveGlobalShortcutDisposition(idle, true)).toBe('suppress')
    })
})

describe('isEditableTarget', () => {
    it('identifies editable targets accurately', () => {
        expect(isEditableTarget(null)).toBe(false)
        expect(isEditableTarget({ tagName: 'DIV' } as unknown as EventTarget)).toBe(false)
        expect(isEditableTarget({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false)
        expect(isEditableTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true)
        expect(isEditableTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true)
        expect(isEditableTarget({ tagName: 'SELECT' } as unknown as EventTarget)).toBe(true)
        expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true)
        expect(isEditableTarget({
            tagName: 'DIV',
            getAttribute: (name: string) => (name === 'contenteditable' ? '' : null),
        } as unknown as EventTarget)).toBe(true)
        expect(isEditableTarget({
            tagName: 'SPAN',
            closest: (selector: string) => (selector.includes('[role="textbox"]') ? {} : null),
        } as unknown as EventTarget)).toBe(true)
    })
})

type Attributes = Record<string, string>

// The test runner has no DOM, so this evaluates the attribute-only selector list
// hasBlockingLayer builds against plain attribute maps.
function matchesCompound(attributes: Attributes, compound: string): boolean {
    const negatives = [...compound.matchAll(/:not\(\[([\w-]+)="([^"]*)"\]\)/g)]
    const positivePart = compound.replace(/:not\(\[[^\]]*\]\)/g, '')
    const positives = [...positivePart.matchAll(/\[([\w-]+)="([^"]*)"\]/g)]
    expect(positivePart.replace(/\[([\w-]+)="([^"]*)"\]/g, '')).toBe('')
    return positives.every(([, name, value]) => attributes[name] === value)
        && negatives.every(([, name, value]) => attributes[name] !== value)
}

function blocks(...elements: Attributes[]): boolean {
    return hasBlockingLayer({
        querySelector: (selector: string) => {
            const compounds = selector.split(',').map(part => part.trim())
            const hit = elements.some(attributes => compounds.some(compound => matchesCompound(attributes, compound)))
            return hit ? ({} as Element) : null
        },
    })
}

describe('hasBlockingLayer', () => {
    it('handles missing roots and plain workspace content', () => {
        expect(hasBlockingLayer(null)).toBe(false)
        expect(hasBlockingLayer(undefined)).toBe(false)
        expect(blocks()).toBe(false)
        expect(blocks({ role: 'textbox' })).toBe(false)
    })

    it('blocks on open modal dialogs and alertdialogs', () => {
        expect(blocks({ role: 'dialog', 'data-state': 'open' })).toBe(true)
        expect(blocks({ role: 'alertdialog', 'data-state': 'open' })).toBe(true)
        expect(blocks({ role: 'dialog', 'aria-modal': 'true' })).toBe(true)
        expect(blocks({ role: 'dialog', 'data-state': 'closed' })).toBe(false)
        expect(blocks({ role: 'dialog', 'aria-modal': 'true', 'data-state': 'closed' })).toBe(false)
    })

    it('blocks on open Radix menus (DropdownMenu, ContextMenu) and Select listboxes', () => {
        expect(blocks({ role: 'menu', 'data-state': 'open' })).toBe(true)
        expect(blocks({ role: 'listbox', 'data-state': 'open' })).toBe(true)
        expect(blocks({ role: 'menu', 'data-state': 'closed' })).toBe(false)
        expect(blocks({ role: 'listbox', 'data-state': 'closed' })).toBe(false)
    })

    it('does not block on the prompt autocomplete or static listboxes', () => {
        expect(blocks({ role: 'listbox', 'aria-label': 'Prompt suggestions', 'data-shortcut-scope': 'workspace' })).toBe(false)
        expect(blocks({ role: 'listbox', 'aria-label': 'Prompt suggestions' })).toBe(false)
        expect(blocks({ role: 'listbox', 'aria-label': 'Folder list' })).toBe(false)
    })

    it('excludes workspace-scoped non-modal surfaces of every kind', () => {
        expect(blocks({ id: 'nai-blue-prompt-sheet', role: 'dialog', 'data-state': 'open', 'data-shortcut-scope': 'workspace' })).toBe(false)
        expect(blocks({ role: 'menu', 'data-state': 'open', 'data-shortcut-scope': 'workspace' })).toBe(false)
        expect(blocks({ role: 'listbox', 'data-state': 'open', 'data-shortcut-scope': 'workspace' })).toBe(false)
    })

    it('still blocks when a menu opens on top of the workspace prompt sheet', () => {
        expect(blocks(
            { role: 'dialog', 'data-state': 'open', 'data-shortcut-scope': 'workspace' },
            { role: 'menu', 'data-state': 'open' },
        )).toBe(true)
    })
})
