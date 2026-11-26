import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'

export interface NumericDraftRange {
    min: number
    max: number
    integer?: boolean
}

/**
 * Turns the text a person left in a number field into the value to store.
 * An empty or unreadable draft keeps the previous value instead of snapping to
 * the minimum, so clearing a field never silently changes generation cost.
 */
export function resolveNumericDraft(draft: string, previous: number, range: NumericDraftRange): number {
    const trimmed = draft.trim()
    if (trimmed === '') return previous
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) return previous
    const value = range.integer ? Math.round(parsed) : parsed
    return Math.min(range.max, Math.max(range.min, value))
}

/** The value a draft already stands for while typing, or null for an in-between text (empty, out of range, unreadable). */
export function liveNumericDraftValue(draft: string, range: NumericDraftRange): number | null {
    const trimmed = draft.trim()
    if (trimmed === '') return null
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) return null
    if (range.integer && !Number.isInteger(parsed)) return null
    if (parsed < range.min || parsed > range.max) return null
    return parsed
}

/** Typed text plus the stored value it belongs to; a different stored value means someone else changed it. */
export interface NumericDraftState {
    text: string
    value: number
}

export interface NumericDraftInputStep {
    draft: NumericDraftState
    /** Value to store right away so cost and warnings follow the typing, or null to wait. */
    commit: number | null
}

export function numericDraftInput(text: string, stored: number, range: NumericDraftRange): NumericDraftInputStep {
    const live = liveNumericDraftValue(text, range)
    if (live === null) return { draft: { text, value: stored }, commit: null }
    return { draft: { text, value: live }, commit: live === stored ? null : live }
}

/** Keeps "5." or "5.50" on screen after its own commit, but lets an outside change (restore, scene switch) win. */
export function numericDraftText(draft: NumericDraftState | null, stored: number): string {
    return draft !== null && draft.value === stored ? draft.text : String(stored)
}

/**
 * Value to store when the field is left (blur, Enter, unmount): empty or unreadable text goes back to the value
 * the field had on focus, so a digit committed mid-edit does not stay; out-of-range text is clamped.
 */
export function numericDraftLeave(
    draft: NumericDraftState | null,
    stored: number,
    focusValue: number,
    range: NumericDraftRange,
): number | null {
    if (draft === null || draft.value !== stored) return null
    const next = resolveNumericDraft(draft.text, focusValue, range)
    return next === stored ? null : next
}

/**
 * Controlled number inputs that clamp on every keystroke cannot be cleared:
 * React restores the old value and the next digits are appended to it. The
 * draft keeps the raw text while typing, stores it as soon as it is a valid
 * value, and settles in-between text on blur, Enter or unmount.
 */
export function useNumericDraft(
    value: number,
    range: NumericDraftRange,
    onCommit: (next: number) => void,
    disabled = false,
) {
    const [draft, setDraft] = useState<NumericDraftState | null>(null)
    const focusValueRef = useRef<number | null>(null)
    const latestRef = useRef({ draft, value, range, onCommit })
    useEffect(() => {
        latestRef.current = { draft, value, range, onCommit }
    })

    // Disabling an input does not fire blur, so a stale draft would otherwise stay on screen.
    useEffect(() => {
        if (disabled) setDraft(null)
    }, [disabled])

    // React does not fire blur when a focused input unmounts (route change by shortcut), so settle the draft here.
    useEffect(() => () => {
        const latest = latestRef.current
        const next = numericDraftLeave(latest.draft, latest.value, focusValueRef.current ?? latest.value, latest.range)
        if (next !== null) latest.onCommit(next)
    }, [])

    const leave = () => {
        const next = numericDraftLeave(draft, value, focusValueRef.current ?? value, range)
        setDraft(null)
        if (next !== null) onCommit(next)
        return next ?? value
    }

    return {
        value: disabled ? String(value) : numericDraftText(draft, value),
        onFocus: () => { focusValueRef.current = value },
        onChange: (event: ChangeEvent<HTMLInputElement>) => {
            const step = numericDraftInput(event.target.value, value, range)
            setDraft(step.draft)
            if (step.commit !== null) onCommit(step.commit)
        },
        onBlur: () => {
            leave()
            focusValueRef.current = null
        },
        onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
            if (event.key === 'Enter') {
                // Commit before the window Ctrl/Cmd+Enter shortcut reads the store; only plain Enter is consumed here.
                focusValueRef.current = leave()
                if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) event.preventDefault()
            } else if (event.key === 'Escape') {
                const focusValue = focusValueRef.current ?? value
                if (draft === null && focusValue === value) return
                event.preventDefault()
                event.stopPropagation()
                setDraft(null)
                if (focusValue !== value) onCommit(focusValue)
            }
        },
    }
}
