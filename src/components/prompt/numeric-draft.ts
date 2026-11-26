import { useEffect, useState, type ChangeEvent, type KeyboardEvent } from 'react'

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

/**
 * Controlled number inputs that clamp on every keystroke cannot be cleared:
 * React restores the old value and the next digits are appended to it. The
 * draft keeps the raw text while typing and commits on blur or Enter.
 */
export function useNumericDraft(
    value: number,
    range: NumericDraftRange,
    onCommit: (next: number) => void,
    disabled = false,
) {
    const [draft, setDraft] = useState<string | null>(null)

    // A store change from elsewhere (restore button, scene switch, new random seed) wins over the draft.
    useEffect(() => setDraft(null), [value])
    // Disabling an input does not fire blur, so a stale draft would otherwise stay on screen.
    useEffect(() => {
        if (disabled) setDraft(null)
    }, [disabled])

    const commit = () => {
        if (draft === null) return
        const next = resolveNumericDraft(draft, value, range)
        setDraft(null)
        if (next !== value) onCommit(next)
    }

    return {
        value: draft ?? String(value),
        onChange: (event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
        onBlur: commit,
        onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
            if (event.key === 'Enter') {
                // Commit before the window Ctrl/Cmd+Enter shortcut reads the store; only plain Enter is consumed here.
                commit()
                if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) event.preventDefault()
            } else if (event.key === 'Escape' && draft !== null) {
                event.preventDefault()
                event.stopPropagation()
                setDraft(null)
            }
        },
    }
}
