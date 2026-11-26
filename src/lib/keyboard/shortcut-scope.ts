/**
 * Shared keyboard scope guards used by global shortcuts and route-level Escape
 * handlers so inner dialogs, IME compositions, and inline editors consume keys
 * before outer workspace actions run.
 */

const BLOCKING_LAYER_SELECTOR = [
    '[role="dialog"][data-state="open"]:not([data-shortcut-scope="workspace"])',
    '[role="alertdialog"][data-state="open"]:not([data-shortcut-scope="workspace"])',
    '[role="dialog"][aria-modal="true"]:not([data-state="closed"]):not([data-shortcut-scope="workspace"])',
].join(', ')

export interface ShortcutScopeEvent {
    defaultPrevented: boolean
    isComposing?: boolean
    repeat?: boolean
    keyCode?: number
}

/**
 * Returns true when focus is inside a text-entry or form control that owns
 * typing and Escape cancellation locally.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
    if (!target || typeof target !== 'object') return false
    const element = target as {
        tagName?: unknown
        isContentEditable?: unknown
        getAttribute?: (name: string) => string | null
        closest?: (selector: string) => unknown
    }

    if (element.isContentEditable === true) return true

    const tagName = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : ''
    if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') {
        return true
    }

    const contentEditable = typeof element.getAttribute === 'function'
        ? element.getAttribute('contenteditable')
        : null
    if (contentEditable === '' || contentEditable === 'true') {
        return true
    }

    if (typeof element.closest === 'function') {
        return Boolean(element.closest('[contenteditable=""], [contenteditable="true"], [role="textbox"]'))
    }

    return false
}

/**
 * Detects whether an active modal dialog or alertdialog is mounted above the
 * workspace. Non-modal workspace sheets opt out via data-shortcut-scope="workspace".
 */
export function hasBlockingLayer(root: Pick<Document, 'querySelector'> | null | undefined): boolean {
    if (!root || typeof root.querySelector !== 'function') return false
    return root.querySelector(BLOCKING_LAYER_SELECTOR) !== null
}

/**
 * Pure guard for global shortcuts: back off whenever an inner handler already
 * consumed the key, an IME composition is active, the key is auto-repeating, or
 * a blocking modal layer is open.
 */
export function shouldSkipGlobalShortcut(
    event: ShortcutScopeEvent,
    blockingLayerOpen: boolean,
): boolean {
    if (event.defaultPrevented) return true
    if (event.isComposing || event.keyCode === 229) return true
    if (event.repeat) return true
    if (blockingLayerOpen) return true
    return false
}
