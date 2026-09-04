import type { WorkspaceMutationGatePort } from '@/application/workspace/workspace-mutation-gate'

/**
 * Process-local promise tails provide FIFO per key without coupling unrelated workspaces.
 * A rejected predecessor is observed before the next operation, and cleanup removes only
 * the tail installed by that operation so a later waiter cannot be orphaned.
 */
export class ProcessLocalWorkspaceMutationGate implements WorkspaceMutationGatePort {
    private readonly tails = new Map<string, Promise<void>>()

    async runExclusive<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
        const predecessor = this.tails.get(workspaceId) ?? Promise.resolve()
        let release!: () => void
        const ownTail = new Promise<void>(resolve => { release = resolve })
        this.tails.set(workspaceId, ownTail)
        await predecessor.catch(() => undefined)
        try {
            return await operation()
        } finally {
            release()
            if (this.tails.get(workspaceId) === ownTail) this.tails.delete(workspaceId)
        }
    }
}

export const runtimeWorkspaceMutationGate = new ProcessLocalWorkspaceMutationGate()
