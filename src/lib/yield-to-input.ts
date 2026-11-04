/** A task boundary lets input/paint run; Promise.resolve alone stays in the
 * microtask queue. Workers and tests do not need browser scheduling. */
export async function yieldToInput(): Promise<void> {
    if (typeof window === 'undefined') return
    const scheduler = (globalThis as unknown as { scheduler?: { yield?: () => Promise<void> } }).scheduler
    if (scheduler?.yield) await scheduler.yield()
    else await new Promise<void>(resolve => setTimeout(resolve, 0))
}

/** Bound synchronous list work to an 8 ms slice instead of one task per item. */
export function inputBudget(): () => Promise<void> | undefined {
    let deadline = performance.now() + 8
    return () => {
        if (performance.now() < deadline) return undefined
        return yieldToInput().then(() => { deadline = performance.now() + 8 })
    }
}
