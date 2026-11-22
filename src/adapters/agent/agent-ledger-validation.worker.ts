import { canonicalSerialize } from '@/domain/composition/canonical-serialize'
import { parseAgentExecutionLedger, type AgentExecutionLedger } from '@/application/agent/agent-execution-repository'

// Integrity checks remain identical to the synchronous repository contract;
// the history's hashes and canonical serialization no longer block window input.
// One long-lived Worker serves many requests, so every reply echoes its request id.
const worker = globalThis as unknown as {
    onmessage: ((event: MessageEvent<{ id: number; value: string | AgentExecutionLedger; workspaceId: string; serialize: boolean }>) => void) | null
    onmessageerror: (() => void) | null
    postMessage(value: unknown): void
}
// An undecodable request carries no readable id; the owner fails every outstanding request and restarts.
worker.onmessageerror = () => worker.postMessage({ fatal: true })
worker.onmessage = ({ data }) => {
    try {
        const ledger = parseAgentExecutionLedger(typeof data.value === 'string' ? JSON.parse(data.value) : data.value, data.workspaceId)
        worker.postMessage({ id: data.id, ledger, serialized: data.serialize ? canonicalSerialize(ledger) : null })
    } catch { worker.postMessage({ id: data.id, error: 'INVALID_EXECUTION_STORE' }) }
}
