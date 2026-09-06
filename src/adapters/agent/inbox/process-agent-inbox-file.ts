import { AgentCommandError, assertAgentRequestId } from '@/application/agent/agent-command-contract'
import type { AgentCommandDispatcher } from '@/application/agent/agent-command-dispatcher'
import type { AgentCommandReceipt } from '@/application/agent/command-receipt-repository'

export interface InboxSubmissionReceipt {
    readonly status: 'submitted-to-inbox'
    readonly accepted: false
    readonly requestId: string
    readonly requiresAppProcess: true
}

/** Call only after the writer has atomically published its ready file. */
export function createInboxSubmissionReceipt(requestId: string): InboxSubmissionReceipt {
    assertAgentRequestId(requestId)
    return { status: 'submitted-to-inbox', accepted: false, requestId, requiresAppProcess: true }
}

export interface AgentInboxFilePort {
    /** Native implementation must enforce the byte limit while reading, before allocation. */
    readReady(requestId: string, maxBytes: number): Promise<string>
    publishResult(requestId: string, receipt: AgentCommandReceipt): Promise<void>
    publishRejection(requestId: string, rejection: { accepted: false; code: string }): Promise<void>
}

// Only pre-acceptance protocol errors become rejection files. Repository faults
// must remain unavailable, and arbitrary adapter error codes must never leak.
const REJECTION_CODES = new Set([
    'INVALID_ENVELOPE', 'UNSAFE_PAYLOAD', 'REQUEST_HASH_MISMATCH', 'REQUEST_EXPIRED',
    'AUTHENTICATION_FAILED', 'WORKSPACE_MISMATCH', 'IDEMPOTENCY_CONFLICT',
    'INVALID_COMMAND_INPUT', 'COMMAND_INPUT_CHANGED', 'APP_UNAVAILABLE',
    'REQUEST_TOO_LARGE', 'REQUEST_ID_MISMATCH',
])

/** Ingress and result readers share the same fixed pre-acceptance error vocabulary. */
export function isAgentInboxRejectionCode(value: unknown): value is string {
    return typeof value === 'string' && REJECTION_CODES.has(value)
}

/** Only validated basenames reach I/O; native path/ACL ownership stays in the port. */
export async function processAgentInboxFile(
    fileName: string, files: AgentInboxFilePort, dispatcher: AgentCommandDispatcher,
): Promise<'ignored' | 'projected' | 'rejected'> {
    const suffix = '.ready.json'
    if (!fileName.endsWith(suffix)) return 'ignored'
    const requestId = fileName.slice(0, -suffix.length)
    try { assertAgentRequestId(requestId) } catch { return 'ignored' }
    let receipt: AgentCommandReceipt
    try {
        const serialized = await files.readReady(requestId, 65_536)
        if (new TextEncoder().encode(serialized).byteLength > 65_536) throw new AgentCommandError('REQUEST_TOO_LARGE')
        let value: unknown
        try { value = JSON.parse(serialized) } catch { throw new AgentCommandError('INVALID_ENVELOPE') }
        if (value === null || typeof value !== 'object' || Array.isArray(value)
            || (value as Record<string, unknown>).requestId !== requestId) throw new AgentCommandError('REQUEST_ID_MISMATCH')
        receipt = await dispatcher.dispatch(value)
    } catch (error) {
        // Storage/transport faults stay retryable; no false rejection replaces an accepted record.
        if (!(error instanceof AgentCommandError) || !isAgentInboxRejectionCode(error.code)) throw error
        await files.publishRejection(requestId, { accepted: false, code: error.code })
        return 'rejected'
    }
    // Deliberately outside the rejection catch: a failed projection never redispatches.
    await files.publishResult(requestId, receipt)
    return 'projected'
}
