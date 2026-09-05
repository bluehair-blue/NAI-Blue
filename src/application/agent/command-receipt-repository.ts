import type { JsonObject } from '@/domain/composition/types'
import { hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import type { Sha256Digest } from '@/application/generation/generation-plan-contract'
import { AGENT_COMMAND_NAMES, AgentCommandError, assertAgentPublicValue, assertAgentRequestId, type AgentCommandName } from './agent-command-contract'

/** Device-local command facts; result files are projections and never own replay. */
export interface AgentCommandReceipt {
    readonly schemaVersion: 1
    readonly requestId: string
    readonly requestHash: Sha256Digest
    readonly authenticatedClientId: string
    readonly command: AgentCommandName
    readonly state: 'accepted' | 'rejected' | 'needs-input' | 'completed'
    readonly observedAt: string
    readonly resultSchemaVersion: 1
    readonly result: JsonObject | null
    readonly resultDigest: Sha256Digest | null
}

export interface CommandReceiptRepository {
    get(requestId: string): Promise<AgentCommandReceipt | null>
    claim(receipt: AgentCommandReceipt): Promise<{
        readonly status: 'claimed' | 'existing' | 'conflict'
        readonly receipt: AgentCommandReceipt
    }>
    finish(expected: AgentCommandReceipt, next: AgentCommandReceipt): Promise<AgentCommandReceipt>
}

export function agentResultDigest(result: JsonObject): Sha256Digest {
    assertAgentPublicValue(result)
    return `sha256:${hashCanonicalValue(result)}`
}

/** Validate again at persistence reads so corrupt results never become public replay. */
export function parseAgentCommandReceipt(value: unknown): AgentCommandReceipt {
    const invalid = (): never => { throw new AgentCommandError('INVALID_RECEIPT') }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid()
    const raw = value as Record<string, unknown>
    const keys = ['schemaVersion', 'requestId', 'requestHash', 'authenticatedClientId', 'command', 'state',
        'observedAt', 'resultSchemaVersion', 'result', 'resultDigest']
    if (Object.keys(raw).length !== keys.length || Object.keys(raw).some(key => !keys.includes(key))) return invalid()
    assertAgentRequestId(raw.requestId)
    if (raw.schemaVersion !== 1 || raw.resultSchemaVersion !== 1
        || typeof raw.requestHash !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(raw.requestHash)
        || typeof raw.authenticatedClientId !== 'string' || !raw.authenticatedClientId
        || raw.authenticatedClientId.length > 200
        || !AGENT_COMMAND_NAMES.includes(raw.command as AgentCommandName)
        || !['accepted', 'rejected', 'needs-input', 'completed'].includes(raw.state as string)
        || typeof raw.observedAt !== 'string' || !Number.isFinite(Date.parse(raw.observedAt))
        || new Date(raw.observedAt).toISOString() !== raw.observedAt) return invalid()
    assertAgentPublicValue({ id: raw.authenticatedClientId })
    if (raw.state === 'accepted') {
        if (raw.result !== null || raw.resultDigest !== null) return invalid()
    } else {
        assertAgentPublicValue(raw.result)
        if (raw.resultDigest !== agentResultDigest(raw.result)) return invalid()
    }
    return structuredClone(raw) as unknown as AgentCommandReceipt
}
