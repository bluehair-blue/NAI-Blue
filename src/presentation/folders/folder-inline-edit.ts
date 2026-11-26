/** Decisions for the folder card's inline description editor, kept pure so keyboard and blur rules are testable. */

export interface InlineEditKeyEvent {
    key: string
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
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) return composing ? 'defer-save' : 'save'
    if (event.key === 'Escape') return composing ? 'swallow' : 'cancel'
    return null
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
