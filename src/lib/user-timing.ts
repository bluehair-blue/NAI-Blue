let spanSequence = 0

/** DevTools User Timing span only: nothing persists, and a timing failure never affects the measured work. */
export async function measureSpan<T>(name: string, work: () => Promise<T>): Promise<T> {
    const timing = globalThis.performance
    if (typeof timing?.mark !== 'function' || typeof timing.measure !== 'function') return work()
    // Spans of one name can overlap, so each needs its own start mark.
    const start = `${name}:start:${spanSequence += 1}`
    try { timing.mark(start) } catch { return work() }
    try { return await work() } finally {
        // A profile records every span as it happens; the buffer keeps only the latest of each name.
        try { timing.clearMeasures?.(name); timing.measure(name, start); timing.clearMarks(start) } catch { /* diagnostics only */ }
    }
}
