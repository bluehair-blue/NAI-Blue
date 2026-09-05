import { canonicalSerialize } from '@/domain/composition/canonical-serialize'
import { AgentCommandDispatcher } from '@/application/agent/agent-command-dispatcher'
import type { CommandReceiptRepository } from '@/application/agent/command-receipt-repository'
import { describeAgentCommandCapabilities, type AgentCommandHandler, type RuntimeCapabilityDescriptor } from '@/application/agent/runtime-capability-registry'
import { processAgentInboxFile } from '@/adapters/agent/inbox/process-agent-inbox-file'
import type { AgentClientRegistration, NativeAgentCommands } from '@/adapters/agent/native-agent-commands'
import { initializeAgentCommandRuntime } from './agent-command-runtime'

export interface ForegroundAgentSnapshot {
    readonly status: 'unsupported' | 'starting' | 'ready' | 'busy' | 'app-unavailable' | 'stopping' | 'stopped'
    readonly workspaceId: string | null
    readonly clients: readonly AgentClientRegistration[]
    readonly capabilities: readonly RuntimeCapabilityDescriptor[]
    readonly changingClient: boolean
    readonly recent: readonly { requestId: string; state: string }[]
}

/** One foreground owner uses the same dispatcher for processing and UI capability snapshots. */
export class ForegroundAgentCommandRuntime {
    private snapshot: ForegroundAgentSnapshot = { status: 'unsupported', workspaceId: null, clients: [],
        capabilities: describeAgentCommandCapabilities([], { ready: false, mode: 'suggest', globalPause: false }), changingClient: false, recent: [] }
    private listeners = new Set<() => void>()
    private dispatcher: AgentCommandDispatcher | null = null
    private owner: string | null = null
    private timer: ReturnType<typeof setTimeout> | undefined
    private polling: Promise<void> | null = null
    private starting: Promise<void> | null = null
    private stopping: Promise<void> | null = null
    private stopRequested = false
    private recovery: Promise<{ inboxReady: boolean }> | null = null
    private running = false

    constructor(private readonly dependencies: {
        readonly native: NativeAgentCommands
        readonly receipts: CommandReceiptRepository
        readonly createHandlers: (workspaceId: string) => Promise<readonly AgentCommandHandler[]>
    }) {}

    getSnapshot = (): ForegroundAgentSnapshot => this.snapshot
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

    private update(patch: Partial<ForegroundAgentSnapshot>): void {
        this.snapshot = { ...this.snapshot, ...patch }
        this.snapshot = { ...this.snapshot, capabilities: this.dispatcher?.capabilities()
            ?? describeAgentCommandCapabilities([], { ready: false, mode: 'suggest', globalPause: false }) }
        for (const listener of this.listeners) listener()
    }

    start(recovery = this.recovery): Promise<void> {
        if (this.stopping !== null) return this.stopping.then(() => this.start(recovery))
        if (this.starting !== null) return this.starting
        if (this.running || recovery === null) return Promise.resolve()
        this.stopRequested = false
        this.recovery = recovery
        // Attach immediately: Queue failure must not become an unhandled rejection
        // while native metadata initialization is still pending.
        const recovered = recovery.then(value => value.inboxReady, () => false)
        this.starting = (async () => {
            this.update({ status: 'starting' })
            const native = this.dependencies.native
            const result = await initializeAgentCommandRuntime({
                migrate: async () => {
                    const workspace = await native.initialize()
                    this.update({ workspaceId: workspace.workspaceId, clients: workspace.clients })
                },
                recover: async () => ({ ready: await recovered }),
                hydrate: async () => {
                    const workspaceId = this.snapshot.workspaceId!
                    const handlers = await this.dependencies.createHandlers(workspaceId)
                    this.dispatcher = new AgentCommandDispatcher({ workspaceId, handlers,
                        authentication: native.authentication(() => {
                            if (this.owner === null) throw new Error('Agent inbox has no owner')
                            return this.owner
                        }), receipts: this.dependencies.receipts,
                        runtime: () => ({ ready: this.running && !this.snapshot.changingClient,
                            mode: 'suggest', globalPause: false }),
                    })
                },
                acquireOwner: async () => {
                    this.owner = await native.acquire()
                    if (this.owner === null) return null
                    const token = this.owner
                    return { release: async () => { await native.release(token); if (this.owner === token) this.owner = null } }
                },
                processReadyRequests: async () => {
                    if (this.stopRequested) return
                    this.running = true; this.update({ status: 'ready' }); await this.poll()
                },
            })
            if (result.status !== 'ready') {
                this.running = false
                this.update({ status: result.status })
            } else this.schedule()
        })().finally(() => { this.starting = null })
        return this.starting
    }

    private schedule(): void {
        if (!this.running || this.snapshot.changingClient) return
        this.timer = setTimeout(() => {
            void this.poll().catch(async () => {
                this.running = false
                this.update({ status: 'app-unavailable' })
                await this.releaseOwner().catch(() => undefined)
            }).finally(() => this.schedule())
        }, 1_000)
    }

    /** Serial polling matches the existing Main planner and avoids concurrent preparation. */
    poll(): Promise<void> {
        if (this.polling !== null) return this.polling
        if (!this.running || this.snapshot.changingClient || this.dispatcher === null || this.owner === null) return Promise.resolve()
        const token = this.owner
        const native = this.dependencies.native
        const dispatcher = this.dispatcher
        const activity = (requestId: string, state: string) => this.update({
            recent: [{ requestId, state }, ...this.snapshot.recent.filter(item => item.requestId !== requestId)].slice(0, 20),
        })
        this.polling = (async () => {
            for (const file of await native.list(token)) {
                if (!this.running || this.snapshot.changingClient) break
                const outcome = await processAgentInboxFile(file, {
                    readReady: (id, max) => native.read(token, id, max),
                    publishResult: async (id, receipt) => { await native.publish(token, id, canonicalSerialize(receipt)); activity(id, receipt.state) },
                    publishRejection: async (id, rejection) => { await native.reject(token, id, canonicalSerialize(rejection)); activity(id, 'rejected') },
                }, dispatcher)
                if (outcome !== 'ignored') await native.retire(token, file.slice(0, -'.ready.json'.length))
            }
        })().finally(() => { this.polling = null })
        return this.polling
    }

    private async releaseOwner(): Promise<void> {
        if (this.owner === null) return
        const token = this.owner
        await this.dependencies.native.release(token)
        if (this.owner === token) this.owner = null
    }

    stop(): Promise<void> {
        if (this.stopping !== null) return this.stopping
        this.stopRequested = true
        this.running = false
        clearTimeout(this.timer)
        this.update({ status: 'stopping' })
        this.stopping = (async () => {
            try {
                await this.starting
                try { await this.polling } finally { await this.releaseOwner() }
                this.update({ status: 'stopped' })
            } catch (error) {
                this.update({ status: 'app-unavailable' })
                throw error
            } finally { this.running = false; this.stopping = null }
        })()
        return this.stopping
    }

    /** Human UI changes wait for in-flight work; no command can race a key rotation. */
    async changeClient(action: 'register' | 'rotate' | 'revoke', value: string, actorKind: 'agent' | 'service' = 'agent'): Promise<void> {
        if (!this.running || this.snapshot.changingClient) throw new Error('Agent inbox is not ready')
        clearTimeout(this.timer)
        this.update({ changingClient: true })
        try {
            await this.polling
            const native = this.dependencies.native
            if (action === 'register') await native.register(value, actorKind)
            else if (action === 'rotate') await native.rotate(value)
            else await native.revoke(value)
            const workspace = await native.initialize()
            if (workspace.workspaceId !== this.snapshot.workspaceId) throw new Error('Agent workspace identity changed')
            this.update({ clients: workspace.clients })
        } finally {
            this.update({ changingClient: false })
            this.schedule()
        }
    }
}
