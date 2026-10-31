export interface SerializedProgressReporter {
    enqueue: (stage: string, current: number, total: number) => void
    flush: () => Promise<void>
}

/**
 * Depends on QueueExecutorContext.updateProgress and is used by streaming Main
 * and Scene adapters. Provider callbacks cannot await persistence, so this
 * reporter serializes their writes and surfaces the first failure at flush;
 * IndexedDB versions can no longer race or reject as an unhandled promise.
 */
export function createSerializedProgressReporter(
    update: (stage: string, current: number, total: number) => Promise<void>,
): SerializedProgressReporter {
    let pending = Promise.resolve()
    let firstError: unknown = null
    let latest: { stage: string; current: number; total: number } | null = null

    return {
        enqueue: (stage, current, total) => {
            // Multiple Provider frames can round to the same step. Persist the
            // progress fact once; frame display has its independent transient port.
            if (latest?.stage === stage && latest.current === current && latest.total === total) return
            latest = { stage, current, total }
            pending = pending.then(async () => {
                if (firstError !== null) return
                try {
                    await update(stage, current, total)
                } catch (error) {
                    firstError = error
                }
            })
        },
        flush: async () => {
            await pending
            if (firstError !== null) throw firstError
        },
    }
}
