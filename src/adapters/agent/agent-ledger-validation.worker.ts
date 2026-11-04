import { canonicalSerialize } from '@/domain/composition/canonical-serialize'
import { parseAgentExecutionLedger, type AgentExecutionLedger } from '@/application/agent/agent-execution-repository'

// Integrity checks remain identical to the synchronous repository contract;
// the history's hashes and canonical serialization no longer block window input.
const worker = globalThis as unknown as {
    onmessage: ((event: MessageEvent<{ value: string | AgentExecutionLedger; workspaceId: string; serialize: boolean }>) => void) | null
    postMessage(value: unknown): void
}
worker.onmessage = ({ data }) => {
    try {
        const ledger = parseAgentExecutionLedger(typeof data.value === 'string' ? JSON.parse(data.value) : data.value, data.workspaceId)
        worker.postMessage({ ledger, serialized: data.serialize ? canonicalSerialize(ledger) : null })
    } catch { worker.postMessage({ error: 'INVALID_EXECUTION_STORE' }) }
}
