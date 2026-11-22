import { canonicalSerialize } from '@/domain/composition/canonical-serialize'
import { compareAndSetIndexedDBItem, getIndexedDBItemStrict } from '@/lib/indexed-db'
import { measureSpan, type SpanDetail } from '@/lib/user-timing'
import { AgentCommandError } from '@/application/agent/agent-command-contract'
import { parseAgentExecutionLedger, type AgentExecutionLedger, type AgentExecutionRepository } from '@/application/agent/agent-execution-repository'

type ValidatedLedger = { ledger: AgentExecutionLedger; serialized: string | null }
type CachedLedger = { workspaceId: string; raw: string; ledger: AgentExecutionLedger }

/** One workspace CAS atomically covers approvals and all clients' rolling exposure. */
export class IndexedDbAgentExecutionRepository implements AgentExecutionRepository {
    private cached: CachedLedger | null = null
    constructor(private readonly persistence = { getItem: getIndexedDBItemStrict, compareAndSet: compareAndSetIndexedDBItem }) {}
    private key(workspaceId: string): string {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(workspaceId)) throw new AgentCommandError('INVALID_WORKSPACE')
        return `nai-blue-agent-execution:${workspaceId}`
    }
    get(workspaceId: string): Promise<AgentExecutionLedger | null> {
        return measureSpan('agent-ledger:get', detail => this.getOnce(workspaceId, detail))
    }
    private async getOnce(workspaceId: string, detail: SpanDetail): Promise<AgentExecutionLedger | null> {
        const before = this.cached
        const key = this.key(workspaceId)
        const raw = await measureSpan('agent-ledger:read', () => this.persistence.getItem(key))
        detail.rawLength = raw?.length ?? 0
        detail.cacheHit = 0
        if (raw === null) { this.cached = null; return null }
        // Still read durable bytes on every poll, including writes by other
        // owners. Only identical validated bytes can skip expensive history hashes.
        if (this.cached?.workspaceId === workspaceId && this.cached.raw === raw) { detail.cacheHit = 1; return this.cached.ledger }
        try {
            const { ledger } = await validateLedger(raw, workspaceId)
            freezeLedgerValue(ledger)
            // A write cached while this read was validating may be newer than these bytes.
            if (this.cached === before || !this.supersedes(this.cached, workspaceId, ledger)) this.cached = { workspaceId, raw, ledger }
            return ledger
        } catch { this.cached = null; throw new AgentCommandError('INVALID_EXECUTION_STORE') }
    }
    compareAndSet(expected: AgentExecutionLedger | null, next: AgentExecutionLedger): Promise<boolean> {
        return measureSpan('agent-ledger:compare-and-set', detail => this.compareAndSetOnce(expected, next, detail))
    }
    private async compareAndSetOnce(expected: AgentExecutionLedger | null, next: AgentExecutionLedger, detail: SpanDetail): Promise<boolean> {
        if (next.revision !== (expected?.revision ?? -1) + 1) throw new AgentCommandError('INVALID_EXECUTION_TRANSITION')
        const validatedNext = await validateLedger(next, next.workspaceId, true)
        // CAS still compares exact durable content. Cached data is frozen and
        // never mutated by callers; an uncached preimage must be validated too.
        detail.expectedCached = expected === null || (this.cached?.ledger === expected && this.cached.workspaceId === next.workspaceId) ? 1 : 0
        const expectedRaw = expected === null ? null
            : this.cached?.ledger === expected && this.cached.workspaceId === next.workspaceId ? this.cached.raw
            : (await validateLedger(expected, next.workspaceId, true)).serialized!
        const key = this.key(next.workspaceId)
        const written = await measureSpan('agent-ledger:cas-write', write => {
            write.serializedLength = validatedNext.serialized!.length
            return this.persistence.compareAndSet(key, expectedRaw, validatedNext.serialized!)
        })
        detail.written = written ? 1 : 0
        // Only confirmed bytes are cached, so the next read of our own write skips revalidation.
        if (written && !this.supersedes(this.cached, next.workspaceId, validatedNext.ledger)) {
            freezeLedgerValue(validatedNext.ledger)
            this.cached = { workspaceId: next.workspaceId, raw: validatedNext.serialized!, ledger: validatedNext.ledger }
        }
        return written
    }
    private supersedes(cached: CachedLedger | null, workspaceId: string, ledger: AgentExecutionLedger): boolean {
        return cached?.workspaceId === workspaceId && cached.ledger.revision > ledger.revision
    }
}

type PendingValidation = { resolve: (value: ValidatedLedger) => void; reject: (error: unknown) => void }
// Shared by every repository instance: runtime restarts construct new repositories, and an idle Worker is a thread.
let validationWorker: ((message: { value: string | AgentExecutionLedger; workspaceId: string; serialize: boolean }) => Promise<ValidatedLedger>) | null = null

function validateLedger(value: string | AgentExecutionLedger, workspaceId: string, serialize = false): Promise<ValidatedLedger> {
    // The largest remaining cost of an agent mutation; its detail says how large the history was and whether it was compacted.
    return measureSpan('agent-ledger:validation', async detail => {
        detail.serialize = serialize ? 1 : 0
        if (typeof value === 'string') detail.rawLength = value.length
        let validated: ValidatedLedger
        // The non-browser repository/test adapter has no event loop to protect.
        if (typeof Worker === 'undefined') {
            detail.worker = 0
            const ledger = parseAgentExecutionLedger(typeof value === 'string' ? JSON.parse(value) : value, workspaceId)
            validated = { ledger, serialized: serialize ? canonicalSerialize(ledger) : null }
        } else {
            detail.worker = 1
            const validate = validationWorker ??= startValidationWorker()
            validated = await validate({ value, workspaceId, serialize })
        }
        try {
            detail.records = validated.ledger.records.length
            detail.compacted = validated.ledger.compacted?.length ?? 0
            if (typeof validated.serialized === 'string') detail.serializedLength = validated.serialized.length
        } catch { /* diagnostics only */ }
        return validated
    })
}

function startValidationWorker() {
    const worker = new Worker(new URL('./agent-ledger-validation.worker.ts', import.meta.url), { type: 'module' })
    const pending = new Map<number, PendingValidation>()
    let nextId = 0
    const invalid = () => new AgentCommandError('INVALID_EXECUTION_STORE')
    const post: NonNullable<typeof validationWorker> = message => new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        try { worker.postMessage({ ...message, id }) } catch { pending.delete(id); reject(invalid()) }
    })
    // A crashed or undecodable Worker fails every outstanding request; the next call starts a fresh one.
    const abandon = () => {
        if (validationWorker === post) validationWorker = null
        // Reject first: a request must never wait on a Worker that is gone.
        for (const request of pending.values()) request.reject(invalid())
        pending.clear()
        try { worker.terminate() } catch { /* already gone */ }
    }
    worker.onerror = worker.onmessageerror = abandon
    worker.onmessage = ({ data }) => {
        // The Worker could not decode a request, so it cannot say which one failed.
        if (data.fatal) { abandon(); return }
        const request = pending.get(data.id)
        pending.delete(data.id)
        if (data.error) request?.reject(invalid())
        else request?.resolve({ ledger: data.ledger, serialized: data.serialized })
    }
    return post
}

/** Cached data must not become caller-owned mutable authorization state. */
function freezeLedgerValue(value: unknown): void {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return
    for (const child of Object.values(value)) freezeLedgerValue(child)
    Object.freeze(value)
}
