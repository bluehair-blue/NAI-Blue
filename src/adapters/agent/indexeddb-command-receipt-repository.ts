import { canonicalSerialize } from '@/domain/composition/canonical-serialize'
import { compareAndSetIndexedDBItem, getIndexedDBItemStrict } from '@/lib/indexed-db'
import { AgentCommandError, assertAgentRequestId } from '@/application/agent/agent-command-contract'
import { parseAgentCommandReceipt, type AgentCommandReceipt, type CommandReceiptRepository } from '@/application/agent/command-receipt-repository'

export function agentCommandReceiptKey(requestId: string): string {
    assertAgentRequestId(requestId)
    return `nai-blue-agent-command-receipt:${requestId}`
}

function read(serialized: string, requestId: string): AgentCommandReceipt {
    try {
        const receipt = parseAgentCommandReceipt(JSON.parse(serialized))
        if (receipt.requestId !== requestId) throw new AgentCommandError('INVALID_RECEIPT')
        return receipt
    } catch {
        // Persisted contents and parser exception messages may contain private material.
        throw new AgentCommandError('INVALID_RECEIPT')
    }
}

/** Native IndexedDB CAS commits the claim before execution, across repository instances. */
export class IndexedDbCommandReceiptRepository implements CommandReceiptRepository {
    constructor(private readonly persistence = {
        getItem: getIndexedDBItemStrict,
        compareAndSet: compareAndSetIndexedDBItem,
    }) {}

    async get(requestId: string): Promise<AgentCommandReceipt | null> {
        const serialized = await this.persistence.getItem(agentCommandReceiptKey(requestId))
        return serialized === null ? null : read(serialized, requestId)
    }

    async claim(input: AgentCommandReceipt): ReturnType<CommandReceiptRepository['claim']> {
        const receipt = parseAgentCommandReceipt(input)
        if (receipt.state !== 'accepted') throw new AgentCommandError('INVALID_RECEIPT_TRANSITION')
        const key = agentCommandReceiptKey(receipt.requestId)
        if (await this.persistence.compareAndSet(key, null, canonicalSerialize(receipt))) {
            return { status: 'claimed', receipt }
        }
        const existing = await this.get(receipt.requestId)
        if (existing === null) throw new AgentCommandError('RECEIPT_STORAGE_CONFLICT')
        const same = existing.requestHash === receipt.requestHash
            && existing.authenticatedClientId === receipt.authenticatedClientId
            && existing.command === receipt.command
        return { status: same ? 'existing' : 'conflict', receipt: existing }
    }

    async finish(expectedInput: AgentCommandReceipt, nextInput: AgentCommandReceipt): Promise<AgentCommandReceipt> {
        const expected = parseAgentCommandReceipt(expectedInput)
        const next = parseAgentCommandReceipt(nextInput)
        const { state: _state, result: _result, resultDigest: _digest, ...binding } = next
        const resumable = ['generation.enqueue', 'generation.cancel', 'generation.retry_storage'].includes(expected.command) && expected.state === 'needs-input'
            && (['AGENT_APPROVAL_REQUIRED', 'AGENT_EXECUTION_UNKNOWN'].includes(String(expected.result?.code))
                || (expected.result?.code === 'COMMAND_OUTCOME_UNKNOWN' && next.state === 'completed'))
        const { state: _expectedState, result: _expectedResult, resultDigest: _expectedDigest, ...expectedBinding } = expected
        if ((expected.state !== 'accepted' && !resumable) || next.state === 'accepted'
            || canonicalSerialize(binding) !== canonicalSerialize(expectedBinding)) {
            throw new AgentCommandError('INVALID_RECEIPT_TRANSITION')
        }
        const key = agentCommandReceiptKey(expected.requestId)
        if (await this.persistence.compareAndSet(key, canonicalSerialize(expected), canonicalSerialize(next))) return next
        const existing = await this.get(expected.requestId)
        if (existing !== null && canonicalSerialize(existing) === canonicalSerialize(next)) return existing
        throw new AgentCommandError('RECEIPT_STORAGE_CONFLICT')
    }
}
