import { canonicalSerialize } from '@/domain/composition/canonical-serialize'
import { AgentCommandDispatcher } from '@/application/agent/agent-command-dispatcher'
import type { CommandReceiptRepository } from '@/application/agent/command-receipt-repository'
import { describeAgentCommandCapabilities, type AgentCommandHandler, type RuntimeCapabilityDescriptor } from '@/application/agent/runtime-capability-registry'
import { processAgentInboxFile } from '@/adapters/agent/inbox/process-agent-inbox-file'
import type { AgentClientRegistration, NativeAgentCommands } from '@/adapters/agent/native-agent-commands'
import { initializeAgentCommandRuntime } from './agent-command-runtime'
import { DEFAULT_AGENT_EXECUTION_POLICY, effectiveAgentExecutionPolicy, type AgentExecutionPolicy } from '@/application/agent/agent-execution-policy'
import type { AgentApprovalExpectation, AgentExecutionCoordinator, AgentPendingApproval } from '@/application/agent/agent-execution-coordinator'
import type { AgentCommandEnvelope } from '@/application/agent/agent-command-contract'
import type { AgentCommandReceipt } from '@/application/agent/command-receipt-repository'

export interface ForegroundAgentSnapshot {
    readonly status: 'unsupported' | 'starting' | 'ready' | 'busy' | 'app-unavailable' | 'stopping' | 'stopped'
    readonly workspaceId: string | null
    readonly clients: readonly AgentClientRegistration[]
    readonly capabilities: readonly RuntimeCapabilityDescriptor[]
    readonly changingClient: boolean
    readonly changingExecution: boolean
    readonly policy: AgentExecutionPolicy
    readonly pendingApprovals: readonly AgentPendingApproval[]
    readonly recent: readonly { requestId: string; state: string; batchId?: string; cancelRequested?: boolean }[]
}

/** One foreground owner uses the same dispatcher for processing and UI capability snapshots. */
export class ForegroundAgentCommandRuntime {
    private snapshot: ForegroundAgentSnapshot = { status: 'unsupported', workspaceId: null, clients: [],
        capabilities: describeAgentCommandCapabilities([], { ready: false, mode: 'suggest', globalPause: false }),
        changingClient: false, changingExecution: false, policy: structuredClone(DEFAULT_AGENT_EXECUTION_POLICY), pendingApprovals: [], recent: [] }
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
    private execution: AgentExecutionCoordinator | null = null
    private humanWork: Promise<void> | null = null
    private unsubscribePolicy: (() => void) | null = null

    constructor(private readonly dependencies: {
        readonly native: NativeAgentCommands
        readonly receipts: CommandReceiptRepository
        readonly createHandlers: (workspaceId: string) => Promise<readonly AgentCommandHandler[]>
        readonly createExecution?: (workspaceId: string, isClientAuthorized: (envelope: AgentCommandEnvelope) => Promise<boolean>) => Promise<AgentExecutionCoordinator>
        readonly policy?: {
            get(): AgentExecutionPolicy
            set(expectedRevision: number, next: AgentExecutionPolicy): Promise<AgentExecutionPolicy>
            subscribe(listener: () => void): () => void
            isSaving(): boolean
        }
    }) {}

    getSnapshot = (): ForegroundAgentSnapshot => this.snapshot
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

    private update(patch: Partial<ForegroundAgentSnapshot>): void {
        this.snapshot = { ...this.snapshot, ...patch, policy: this.dependencies.policy?.get() ?? this.snapshot.policy }
        this.snapshot = { ...this.snapshot, capabilities: this.dispatcher?.capabilities()
            ?? describeAgentCommandCapabilities([], { ready: false, mode: 'suggest', globalPause: false }) }
        for (const listener of this.listeners) listener()
    }

    private runtimeState() {
        const policy = effectiveAgentExecutionPolicy(this.dependencies.policy?.get() ?? DEFAULT_AGENT_EXECUTION_POLICY)
        return { ready: this.running && !this.snapshot.changingClient && !this.snapshot.changingExecution
            && !this.dependencies.policy?.isSaving(), mode: policy.mode, globalPause: policy.globalPause }
    }

    private async refreshApprovals(): Promise<void> {
        this.update({ pendingApprovals: await this.execution?.pending() ?? [] })
    }

    /** Publication is a projection of the durable receipt, including after a local approval. */
    private async publishReceipt(receipt: AgentCommandReceipt): Promise<void> {
        if (this.owner === null) throw new Error('Agent inbox has no owner')
        try { await this.dependencies.native.publish(this.owner, receipt.requestId, canonicalSerialize(receipt)) }
        catch (error) {
            this.running = false
            this.update({ status: 'app-unavailable' })
            throw error
        }
        this.recordActivity(receipt.requestId, receipt.state, receipt)
    }

    private recordActivity(requestId: string, state: string, receipt?: AgentCommandReceipt): void {
        const batchId = receipt?.result?.batchId
        this.update({ recent: [{ requestId, state, ...(typeof batchId === 'string' ? { batchId } : {}),
            ...(receipt?.result?.status === 'cancel-requested' ? { cancelRequested: true } : {}) },
            ...this.snapshot.recent.filter(item => item.requestId !== requestId)].slice(0, 20) })
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
                    const authentication = native.authentication(() => {
                        if (this.owner === null) throw new Error('Agent inbox has no owner')
                        return this.owner
                    })
                    this.execution = await this.dependencies.createExecution?.(workspaceId, async envelope => {
                        // Stop/revoke cannot open a new execution after the final asynchronous authorization check.
                        if (!this.running || this.stopRequested || this.dependencies.policy?.isSaving()) return false
                        try {
                            const identity = await authentication.authenticate(envelope, new Date().toISOString(), { allowExpiredReplay: true })
                            return this.running && !this.stopRequested && !this.dependencies.policy?.isSaving()
                                && identity.clientId === envelope.context.clientId
                                && identity.actor.kind === envelope.context.actor.kind && identity.actor.id === `client:${identity.clientId}`
                        } catch { return false }
                    }) ?? null
                    this.dispatcher = new AgentCommandDispatcher({ workspaceId,
                        handlers: [...handlers, ...(this.execution === null ? [] : [this.execution.handler]),
                            ...(this.execution?.cancelHandler === undefined ? [] : [this.execution.cancelHandler])],
                        authentication, receipts: this.dependencies.receipts, runtime: () => this.runtimeState(),
                    })
                    this.unsubscribePolicy?.()
                    this.unsubscribePolicy = this.dependencies.policy?.subscribe(() => this.update({})) ?? null
                },
                acquireOwner: async () => {
                    this.owner = await native.acquire()
                    if (this.owner === null) return null
                    const token = this.owner
                    return { release: async () => { await native.release(token); if (this.owner === token) this.owner = null } }
                },
                processReadyRequests: async () => {
                    if (this.stopRequested) return
                    this.running = true
                    // Queue recovery already completed. Execution recovery reads its committed facts;
                    // it never treats an unresolved request as permission to enqueue again.
                    for (const receipt of await this.execution?.recover() ?? []) await this.publishReceipt(receipt)
                    await this.refreshApprovals()
                    if (this.stopRequested) return
                    this.update({ status: 'ready' }); await this.poll()
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
        if (!this.running || this.snapshot.changingClient || this.snapshot.changingExecution) return
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
        if (!this.runtimeState().ready || this.dispatcher === null || this.owner === null) return Promise.resolve()
        const token = this.owner
        const native = this.dependencies.native
        const dispatcher = this.dispatcher
        this.polling = (async () => {
            for (const file of await native.list(token)) {
                if (!this.runtimeState().ready) break
                const outcome = await processAgentInboxFile(file, {
                    readReady: (id, max) => native.read(token, id, max),
                    publishResult: async (id, receipt) => { await native.publish(token, id, canonicalSerialize(receipt)); this.recordActivity(id, receipt.state, receipt) },
                    publishRejection: async (id, rejection) => { await native.reject(token, id, canonicalSerialize(rejection)); this.recordActivity(id, 'rejected') },
                }, dispatcher)
                if (outcome !== 'ignored') await native.retire(token, file.slice(0, -'.ready.json'.length))
            }
            await this.refreshApprovals()
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
                try { await this.polling; await this.humanWork } finally { await this.releaseOwner() }
                this.unsubscribePolicy?.(); this.unsubscribePolicy = null
                this.update({ status: 'stopped' })
            } catch (error) {
                this.update({ status: 'app-unavailable' })
                throw error
            } finally { this.running = false; this.stopping = null }
        })()
        return this.stopping
    }

    /** Human decisions and policy writes share the foreground drain with client changes and stop. */
    private runHumanExecution(action: () => Promise<void>): Promise<void> {
        if (!this.running || this.snapshot.changingClient || this.humanWork !== null) return Promise.reject(new Error('Agent inbox is not ready'))
        clearTimeout(this.timer)
        this.update({ changingExecution: true })
        this.humanWork = (async () => {
            await this.polling
            if (!this.running || this.stopRequested) throw new Error('Agent inbox stopped')
            await action()
            await this.refreshApprovals()
        })().finally(async () => {
            this.humanWork = null
            this.update({ changingExecution: false })
            if (!this.running) await this.releaseOwner()
            this.schedule()
        })
        return this.humanWork
    }

    changePolicy(expectedRevision: number, next: AgentExecutionPolicy): Promise<void> {
        return this.runHumanExecution(async () => {
            if (this.dependencies.policy === undefined) throw new Error('Agent policy is unavailable')
            await this.dependencies.policy.set(expectedRevision, next)
        })
    }

    decideApproval(requestId: string, decision: 'approve' | 'reject', expected: AgentApprovalExpectation): Promise<void> {
        return this.runHumanExecution(async () => {
            if (this.execution === null) throw new Error('Agent approval is unavailable')
            if (decision === 'approve') await this.execution.approve(requestId, expected)
            else await this.execution.reject(requestId, expected)
            const receipt = await this.dependencies.receipts.get(requestId)
            if (receipt === null) throw new Error('Agent receipt is unavailable')
            await this.publishReceipt(receipt)
        })
    }

    /** Human UI changes wait for in-flight work; no command can race a key rotation. */
    async changeClient(action: 'register' | 'rotate' | 'revoke', value: string, actorKind: 'agent' | 'service' = 'agent'): Promise<void> {
        if (!this.running || this.snapshot.changingClient || this.snapshot.changingExecution) throw new Error('Agent inbox is not ready')
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
