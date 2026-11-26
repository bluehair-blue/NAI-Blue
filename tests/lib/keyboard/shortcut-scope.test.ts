import { describe, expect, it } from 'vitest'

import {
    hasBlockingLayer,
    isEditableTarget,
    shouldSkipGlobalShortcut,
} from '@/lib/keyboard/shortcut-scope'

describe('shortcut-scope guards', () => {
    it('allows global shortcuts only when no guard condition is active', () => {
        expect(shouldSkipGlobalShortcut({
            defaultPrevented: false,
            isComposing: false,
            repeat: false,
        }, false)).toBe(false)
    })

    it('skips when event was already prevented by an inner layer', () => {
        expect(shouldSkipGlobalShortcut({
            defaultPrevented: true,
            isComposing: false,
            repeat: false,
        }, false)).toBe(true)
    })

    it('skips during IME composition (isComposing or keyCode 229)', () => {
        expect(shouldSkipGlobalShortcut({
            defaultPrevented: false,
            isComposing: true,
            repeat: false,
        }, false)).toBe(true)

        expect(shouldSkipGlobalShortcut({
            defaultPrevented: false,
            isComposing: false,
            repeat: false,
            keyCode: 229,
        }, false)).toBe(true)
    })

    it('skips repeated keydown events to avoid toggling generate and cancel', () => {
        expect(shouldSkipGlobalShortcut({
            defaultPrevented: false,
            isComposing: false,
            repeat: true,
        }, false)).toBe(true)
    })

    it('skips when a blocking modal layer is open', () => {
        expect(shouldSkipGlobalShortcut({
            defaultPrevented: false,
            isComposing: false,
            repeat: false,
        }, true)).toBe(true)
    })

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

    it('detects blocking dialogs while excluding workspace-scoped non-modal sheets', () => {
        let capturedSelector = ''
        const presentDoc = {
            querySelector: (selector: string) => {
                capturedSelector = selector
                return {} as Element
            },
        }
        const emptyDoc = {
            querySelector: () => null,
        }

        expect(hasBlockingLayer(null)).toBe(false)
        expect(hasBlockingLayer(undefined)).toBe(false)
        expect(hasBlockingLayer(emptyDoc)).toBe(false)
        expect(hasBlockingLayer(presentDoc)).toBe(true)
        expect(capturedSelector).toContain('[role="dialog"][data-state="open"]:not([data-shortcut-scope="workspace"])')
        expect(capturedSelector).toContain('[role="alertdialog"][data-state="open"]:not([data-shortcut-scope="workspace"])')
        expect(capturedSelector).toContain('[role="dialog"][aria-modal="true"]:not([data-state="closed"]):not([data-shortcut-scope="workspace"])')
    })
})
