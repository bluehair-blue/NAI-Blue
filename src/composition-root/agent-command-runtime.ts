/**
 * Startup barrier for the future native inbox wiring. Recovery must report all
 * unresolved Queue/output/spool/R2 failures; resolving a Promise alone is not readiness.
 */
export interface AgentCommandStartupDependencies {
    migrate(): Promise<void>
    recover(): Promise<{ ready: boolean }>
    hydrate(): Promise<void>
    acquireOwner(): Promise<{ release(): Promise<void> } | null>
    processReadyRequests(): Promise<void>
}

export type AgentCommandStartupResult =
    | { readonly status: 'ready'; readonly stop: () => Promise<void> }
    | { readonly status: 'app-unavailable' | 'busy' }

/** Nothing observes inbox requests until migration, recovery, hydration and ownership pass. */
export async function initializeAgentCommandRuntime(
    dependencies: AgentCommandStartupDependencies,
): Promise<AgentCommandStartupResult> {
    let owner: Awaited<ReturnType<AgentCommandStartupDependencies['acquireOwner']>> = null
    try {
        await dependencies.migrate()
        if (!(await dependencies.recover()).ready) return { status: 'app-unavailable' }
        await dependencies.hydrate()
        owner = await dependencies.acquireOwner()
        if (owner === null) return { status: 'busy' }
        await dependencies.processReadyRequests()
        const acquired = owner
        let stopped: Promise<void> | undefined
        return { status: 'ready', stop: () => stopped ??= acquired.release() }
    } catch {
        if (owner !== null) {
            try { await owner.release() } catch { /* Never upgrade failed cleanup to readiness. */ }
        }
        return { status: 'app-unavailable' }
    }
}
