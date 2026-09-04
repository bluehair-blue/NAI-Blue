/** Shares one recovery Promise so repeated confirms observe the same success or rejection. */
export class QueueRecoveryActionGate {
    private inFlight: { key: string; promise: Promise<void> } | null = null

    run(key: string, action: () => Promise<void>): Promise<void> {
        if (this.inFlight !== null) {
            return this.inFlight.key === key
                ? this.inFlight.promise
                : Promise.reject(new Error('Another recovery action is already running'))
        }
        const promise = action().finally(() => {
            if (this.inFlight?.promise === promise) this.inFlight = null
        })
        this.inFlight = { key, promise }
        return promise
    }
}
