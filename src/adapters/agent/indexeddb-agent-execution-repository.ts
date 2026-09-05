import { canonicalSerialize } from '@/domain/composition/canonical-serialize'
import { compareAndSetIndexedDBItem, getIndexedDBItemStrict } from '@/lib/indexed-db'
import { AgentCommandError } from '@/application/agent/agent-command-contract'
import { parseAgentExecutionLedger, type AgentExecutionLedger, type AgentExecutionRepository } from '@/application/agent/agent-execution-repository'

/** One workspace CAS atomically covers approvals and all clients' rolling exposure. */
export class IndexedDbAgentExecutionRepository implements AgentExecutionRepository {
    constructor(private readonly persistence = { getItem: getIndexedDBItemStrict, compareAndSet: compareAndSetIndexedDBItem }) {}
    private key(workspaceId: string): string {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(workspaceId)) throw new AgentCommandError('INVALID_WORKSPACE')
        return `nai-blue-agent-execution:${workspaceId}`
    }
    async get(workspaceId: string): Promise<AgentExecutionLedger | null> {
        const raw = await this.persistence.getItem(this.key(workspaceId))
        if (raw === null) return null
        try { return parseAgentExecutionLedger(JSON.parse(raw), workspaceId) }
        catch { throw new AgentCommandError('INVALID_EXECUTION_STORE') }
    }
    async compareAndSet(expected: AgentExecutionLedger | null, next: AgentExecutionLedger): Promise<boolean> {
        parseAgentExecutionLedger(next, next.workspaceId)
        if (expected) parseAgentExecutionLedger(expected, next.workspaceId)
        if (next.revision !== (expected?.revision ?? -1) + 1) throw new AgentCommandError('INVALID_EXECUTION_TRANSITION')
        return this.persistence.compareAndSet(this.key(next.workspaceId), expected === null ? null : canonicalSerialize(expected), canonicalSerialize(next))
    }
}
