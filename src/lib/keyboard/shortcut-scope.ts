/**
 * Shared keyboard scope guards used by global shortcuts and route-level Escape
 * handlers so inner dialogs, open menus/listboxes, IME compositions, and inline
 * editors consume keys before outer workspace actions run.
 */

const WORKSPACE_SCOPE_EXCLUSION = ':not([data-shortcut-scope="workspace"])'

// Radix Select (listbox) and DropdownMenu/ContextMenu (menu) render data-state on
// their open content; static listboxes and the prompt autocomplete do not.
const BLOCKING_LAYER_SELECTOR = [
    `[role="dialog"][data-state="open"]${WORKSPACE_SCOPE_EXCLUSION}`,
    `[role="alertdialog"][data-state="open"]${WORKSPACE_SCOPE_EXCLUSION}`,
    `[role="dialog"][aria-modal="true"]:not([data-state="closed"])${WORKSPACE_SCOPE_EXCLUSION}`,
    `[role="menu"][data-state="open"]${WORKSPACE_SCOPE_EXCLUSION}`,
    `[role="listbox"][data-state="open"]${WORKSPACE_SCOPE_EXCLUSION}`,
].join(', ')

export interface ShortcutScopeEvent {
    defaultPrevented: boolean
    isComposing?: boolean
    repeat?: boolean
    keyCode?: number
}

/**
 * - `pass-through`: another owner already handled the key (inner handler, IME);
 *   leave the event untouched.
 * - `suppress`: the app owns the key but must not run it now (key repeat or a
 *   blocking layer is open); cancel the browser default (find bar, print, reload)
 *   without executing the action.
 * - `run`: execute the bound action.
 */
export type GlobalShortcutDisposition = 'pass-through' | 'suppress' | 'run'

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
 * Detects whether a modal dialog, alertdialog, open menu, or open select
 * listbox is mounted above the workspace. Non-modal workspace surfaces opt out
 * via data-shortcut-scope="workspace".
 */
export function hasBlockingLayer(root: Pick<Document, 'querySelector'> | null | undefined): boolean {
    if (!root || typeof root.querySelector !== 'function') return false
    return root.querySelector(BLOCKING_LAYER_SELECTOR) !== null
}

/** Pure decision for a keydown that already matched an app shortcut binding. */
export function resolveGlobalShortcutDisposition(
    event: ShortcutScopeEvent,
    blockingLayerOpen: boolean,
): GlobalShortcutDisposition {
    if (event.defaultPrevented) return 'pass-through'
    if (event.isComposing || event.keyCode === 229) return 'pass-through'
    if (event.repeat) return 'suppress'
    if (blockingLayerOpen) return 'suppress'
    return 'run'
}
