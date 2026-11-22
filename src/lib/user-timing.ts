/** Counts and sizes a span may carry. Keys are fixed identifiers; values that are not finite numbers are dropped. */
export type SpanDetail = Record<string, number>
export interface RecordedSpan { readonly name: string; readonly startMs: number; readonly ms: number; readonly detail?: Readonly<SpanDetail> }

// A release build has no DevTools, so finished spans also stay in memory for the per-request timing file.
const MAX_SPANS = 4_000
const DETAIL_KEY = /^[A-Za-z][A-Za-z0-9]{0,39}$/
const spans: RecordedSpan[] = []
let spanSequence = 0

const now = (): number => {
    try { return globalThis.performance?.now?.() ?? Date.now() } catch { return Date.now() }
}

function record(name: string, startMs: number, detail: SpanDetail): void {
    try {
        const ms = now() - startMs
        const kept = Object.entries(detail).filter(([key, value]) => DETAIL_KEY.test(key) && typeof value === 'number' && Number.isFinite(value))
        // Dropping a slice at a time keeps the bound without shifting the array on every span.
        if (spans.length >= MAX_SPANS) spans.splice(0, MAX_SPANS / 10)
        spans.push(kept.length ? { name, startMs, ms, detail: Object.fromEntries(kept) } : { name, startMs, ms })
    } catch { /* diagnostics only */ }
}

function startUserTiming(name: string): string | null {
    const timing = globalThis.performance
    if (typeof timing?.mark !== 'function' || typeof timing.measure !== 'function') return null
    // Spans of one name can overlap, so each needs its own start mark.
    const start = `${name}:start:${spanSequence += 1}`
    try { timing.mark(start); return start } catch { return null }
}

function endUserTiming(name: string, start: string | null): void {
    if (start === null) return
    // A profile records every span as it happens; the buffer keeps only the latest of each name.
    try { const timing = globalThis.performance; timing.clearMeasures?.(name); timing.measure(name, start); timing.clearMarks(start) } catch { /* diagnostics only */ }
}

/** Records one span (User Timing and the in-memory buffer). `work` may add counts to `detail`; a timing failure never affects it. */
export async function measureSpan<T>(name: string, work: (detail: SpanDetail) => Promise<T>): Promise<T> {
    const detail: SpanDetail = {}
    const startMs = now()
    const mark = startUserTiming(name)
    try { return await work(detail) } finally { endUserTiming(name, mark); record(name, startMs, detail) }
}

/** Synchronous variant for CPU-bound steps such as hashing and projection. */
export function measureSpanSync<T>(name: string, work: (detail: SpanDetail) => T): T {
    const detail: SpanDetail = {}
    const startMs = now()
    const mark = startUserTiming(name)
    try { return work(detail) } finally { endUserTiming(name, mark); record(name, startMs, detail) }
}

/** A point in time; spans that start at or after it belong to the work that follows. */
export function markSpans(): number {
    return now()
}

/** Spans that started at or after `mark` and have finished, in finish order. Unfinished spans are not included. */
export function spansSince(mark: number): RecordedSpan[] {
    return spans.filter(span => span.startMs >= mark)
}

export function clearSpansForTests(): void {
    spans.length = 0
}
