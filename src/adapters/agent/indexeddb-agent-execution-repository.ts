import { canonicalSerialize } from '@/domain/composition/canonical-serialize'
import { compareAndSetIndexedDBItem, getIndexedDBItemStrict } from '@/lib/indexed-db'
import { AgentCommandError } from '@/application/agent/agent-command-contract'
import { parseAgentExecutionLedger, type AgentExecutionLedger, type AgentExecutionRepository } from '@/application/agent/agent-execution-repository'

/** One workspace CAS atomically covers approvals and all clients' rolling exposure. */
export class IndexedDbAgentExecutionRepository implements AgentExecutionRepository {
    private cached: { workspaceId: string; raw: string; ledger: AgentExecutionLedger } | null = null
    constructor(private readonly persistence = { getItem: getIndexedDBItemStrict, compareAndSet: compareAndSetIndexedDBItem }) {}
    private key(workspaceId: string): string {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(workspaceId)) throw new AgentCommandError('INVALID_WORKSPACE')
        return `nai-blue-agent-execution:${workspaceId}`
    }
    async get(workspaceId: string): Promise<AgentExecutionLedger | null> {
        const raw = await this.persistence.getItem(this.key(workspaceId))
        if (raw === null) { this.cached = null; return null }
        // Still read durable bytes on every poll, including writes by other
        // owners. Only identical validated bytes can skip expensive history hashes.
        if (this.cached?.workspaceId === workspaceId && this.cached.raw === raw) return this.cached.ledger
        try {
            const { ledger } = await validateLedger(raw, workspaceId)
            freezeLedgerValue(ledger)
            this.cached = { workspaceId, raw, ledger }
            return ledger
        } catch { this.cached = null; throw new AgentCommandError('INVALID_EXECUTION_STORE') }
    }
    async compareAndSet(expected: AgentExecutionLedger | null, next: AgentExecutionLedger): Promise<boolean> {
        if (next.revision !== (expected?.revision ?? -1) + 1) throw new AgentCommandError('INVALID_EXECUTION_TRANSITION')
        const validatedNext = await validateLedger(next, next.workspaceId, true)
        // CAS still compares exact durable content. Cached data is frozen and
        // never mutated by callers; an uncached preimage must be validated too.
        const expectedRaw = expected === null ? null
            : this.cached?.ledger === expected && this.cached.workspaceId === next.workspaceId ? this.cached.raw
            : (await validateLedger(expected, next.workspaceId, true)).serialized!
        return this.persistence.compareAndSet(this.key(next.workspaceId), expectedRaw, validatedNext.serialized!)
    }
}

async function validateLedger(value: string | AgentExecutionLedger, workspaceId: string, serialize = false):
    Promise<{ ledger: AgentExecutionLedger; serialized: string | null }> {
    // The non-browser repository/test adapter has no event loop to protect.
    if (typeof Worker === 'undefined') {
        const ledger = parseAgentExecutionLedger(typeof value === 'string' ? JSON.parse(value) : value, workspaceId)
        return { ledger, serialized: serialize ? canonicalSerialize(ledger) : null }
    }
    const worker = new Worker(new URL('./agent-ledger-validation.worker.ts', import.meta.url), { type: 'module' })
    try {
        return await new Promise((resolve, reject) => {
            const fail = () => reject(new AgentCommandError('INVALID_EXECUTION_STORE'))
            worker.onerror = fail
            worker.onmessageerror = fail
            worker.onmessage = ({ data }) => data.error ? fail() : resolve(data)
            worker.postMessage({ value, workspaceId, serialize })
        })
    } finally { worker.terminate() }
}

/** Cached data must not become caller-owned mutable authorization state. */
function freezeLedgerValue(value: unknown): void {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return
    for (const child of Object.values(value)) freezeLedgerValue(child)
    Object.freeze(value)
}
