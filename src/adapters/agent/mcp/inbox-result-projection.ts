import { AgentCommandError, agentRequestHash, assertAgentPublicValue, parseAgentCommandEnvelope } from '@/application/agent/agent-command-contract'
import { parseAgentCommandReceipt } from '@/application/agent/command-receipt-repository'
import { createInboxSubmissionReceipt, isAgentInboxRejectionCode } from '@/adapters/agent/inbox/process-agent-inbox-file'
import type { JsonObject } from '@/domain/composition/types'
import { assertSyncPayloadSafe } from '@/domain/sync/payload-safety'

/**
 * SDK-independent pre-spike projection: the caller owns bounded file reads and must
 * prove ready-file publication before a no-result submission claim. Parsing verifies
 * archive integrity and receipt correlation, never HMAC authentication or app liveness.
 */
export function projectAgentInboxResult(envelope: unknown, result: unknown | null, rejection: unknown | null): JsonObject {
    try {
        const archived = parseAgentCommandEnvelope(envelope)
        if (agentRequestHash(archived) !== archived.requestHash) throw new AgentCommandError('REQUEST_HASH_MISMATCH')
        if (result !== null && rejection !== null) throw new AgentCommandError('INBOX_RESULT_CONFLICT')
        if (result !== null) {
            const receipt = parseAgentCommandReceipt(result)
            if (receipt.requestId !== archived.requestId || receipt.requestHash !== archived.requestHash
                || receipt.authenticatedClientId !== archived.context.clientId || receipt.command !== archived.command.name) {
                throw new AgentCommandError('INBOX_RESULT_MISMATCH')
            }
            // The parser separately bounds the 64 KiB public result. Scan the full
            // wrapper without applying that payload limit again to receipt overhead;
            // the already-validated identity uses the scanner's public reference name.
            const projected = { status: 'application-receipt', requestId: archived.requestId, requiresAppProcess: true, receipt }
            const { authenticatedClientId, ...publicReceipt } = receipt
            assertSyncPayloadSafe({ ...projected, receipt: { ...publicReceipt, clientId: authenticatedClientId } })
            return projected as unknown as JsonObject
        }
        if (rejection !== null) {
            if (typeof rejection !== 'object' || Array.isArray(rejection)
                || Object.keys(rejection).sort().join() !== 'accepted,code'
                || (rejection as Record<string, unknown>).accepted !== false
                || !isAgentInboxRejectionCode((rejection as Record<string, unknown>).code)) {
                throw new AgentCommandError('INVALID_INBOX_REJECTION')
            }
            const projected = { status: 'inbox-rejection', requestId: archived.requestId, requiresAppProcess: true,
                accepted: false, code: (rejection as Record<string, unknown>).code }
            assertAgentPublicValue(projected)
            return projected
        }
        const submitted = { ...createInboxSubmissionReceipt(archived.requestId) }
        assertAgentPublicValue(submitted)
        return submitted
    } catch (error) {
        if (error instanceof AgentCommandError) throw error
        throw new AgentCommandError('INVALID_INBOX_RESULT')
    }
}
