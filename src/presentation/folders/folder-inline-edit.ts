/** Decisions for the folder card's inline description editor, kept pure so keyboard and blur rules are testable. */

export interface InlineEditKeyEvent {
    key: string
    /** Physical key; Chromium/WebView2 Korean IME reports `key: 'Process'` while composing, so `code` identifies it. */
    code?: string
    ctrlKey: boolean
    metaKey: boolean
    isComposing?: boolean
    keyCode?: number
}

/**
 * `save`/`cancel` own the key (preventDefault + stopPropagation).
 * `defer-save` and `swallow` arrive during IME composition: the key is kept from global shortcuts
 * but its default is left alone so the composing syllable is committed intact.
 */
export type InlineEditKeyIntent = 'save' | 'cancel' | 'defer-save' | 'swallow' | null

export function inlineEditKeyIntent(event: InlineEditKeyEvent): InlineEditKeyIntent {
    // Chromium reports keyCode 229 for keys consumed by the IME even when isComposing is not set yet.
    const composing = event.isComposing === true || event.keyCode === 229
    const isEnter = event.key === 'Enter' || event.code === 'Enter' || event.code === 'NumpadEnter'
    const isEscape = event.key === 'Escape' || event.code === 'Escape'
    if (isEnter && (event.ctrlKey || event.metaKey)) return composing ? 'defer-save' : 'save'
    if (isEscape) return composing ? 'swallow' : 'cancel'
    return null
}

const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Shift', 'Alt', 'AltGraph'])

/** What may happen to a save deferred by Ctrl/Cmd+Enter during composition. */
export type InlineEditPendingSaveEvent =
    | { type: 'keydown'; intent: InlineEditKeyIntent; key: string }
    /** `composing` is the input event's own flag: the commit of the deferred syllable arrives while still composing. */
    | { type: 'input'; composing: boolean }
    | { type: 'composition-end' }
    | { type: 'cancel' }

export interface InlineEditPendingSaveStep {
    pending: boolean
    commit: boolean
}

/** A deferred save fires only when the composition it was pressed in ends; any further editing withdraws it. */
export function nextInlineEditPendingSave(pending: boolean, event: InlineEditPendingSaveEvent): InlineEditPendingSaveStep {
    switch (event.type) {
        case 'keydown':
            if (event.intent === 'defer-save') return { pending: true, commit: false }
            // Pressing or holding a modifier is part of the same chord, not further editing.
            if (MODIFIER_KEYS.has(event.key)) return { pending, commit: false }
            return { pending: false, commit: false }
        case 'input':
            return { pending: pending && event.composing, commit: false }
        case 'composition-end':
            return { pending: false, commit: pending }
        case 'cancel':
            return { pending: false, commit: false }
    }
}

export interface InlineEditDirtyState {
    draft: string
    /** The description the card showed when the editor opened. */
    baseline: string
    /** Text written to the store whose save could not be confirmed; it may or may not be on disk. */
    unconfirmed: string | null
}

/** Whether saving still has work to do: a changed draft, or unconfirmed text that only a successful save can settle. */
export function inlineEditNeedsSave(state: InlineEditDirtyState): boolean {
    return state.unconfirmed !== null || state.draft !== state.baseline
}

export interface InlineEditBlurState {
    dirty: boolean
    saving: boolean
    cancelled: boolean
    /** The last explicit save failed; the draft stays until the user retries or cancels. */
    failed: boolean
}

export type InlineEditBlurIntent = 'commit' | 'close' | 'keep'

export function inlineEditBlurIntent(state: InlineEditBlurState): InlineEditBlurIntent {
    if (state.cancelled || state.saving) return 'keep'
    if (!state.dirty) return 'close'
    if (state.failed) return 'keep'
    return 'commit'
}
