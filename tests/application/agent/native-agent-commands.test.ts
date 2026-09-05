import { describe, expect, it, vi } from 'vitest'
import { createNativeAgentCommands } from '@/adapters/agent/native-agent-commands'
import { agentRequestHash, canonicalAgentSigningPayload, type AgentCommandEnvelope } from '@/application/agent/agent-command-contract'

function envelope(): AgentCommandEnvelope {
    const request: AgentCommandEnvelope = { schemaVersion: 1, requestId: 'request-1', requestHash: `sha256:${'0'.repeat(64)}`,
        submittedAt: '2026-09-05T00:00:00.000Z', expiresAt: '2026-09-05T00:05:00.000Z',
        context: { apiVersion: 'nai-blue.agent/v1alpha1', workspaceId: 'workspace-1', clientId: 'client-1', actor: { kind: 'agent' }, idempotencyKey: 'request-1' },
        command: { name: 'system.describe_capabilities', input: {} },
        authentication: { scheme: 'hmac-sha256', keyId: 'key-1', signature: `hmac-sha256:${'a'.repeat(64)}` } }
    return { ...request, requestHash: agentRequestHash(request) }
}

describe('native agent boundary', () => {
    it('passes exactly the canonical signed bytes and signature to native authentication, with no secret getter', async () => {
        const identity = { clientId: 'client-1', actor: { kind: 'agent', id: 'client:client-1' } }
        const call = vi.fn(async () => identity)
        const native = createNativeAgentCommands(call as never)
        const request = envelope()
        expect(await native.authentication(() => 'owner').authenticate(request, request.submittedAt)).toEqual(identity)
        expect(call).toHaveBeenCalledWith('agent_commands_authenticate', { ownerToken: 'owner',
            signingPayload: canonicalAgentSigningPayload(request), signature: request.authentication.signature })
        expect(Object.keys(native).some(key => /secret|credential|loadKey/i.test(key))).toBe(false)
    })
    it('rejects hash mismatch and fresh expiry before invoking native, while preserving expired replay', async () => {
        const call = vi.fn()
        const authenticate = createNativeAgentCommands(call as never).authentication(() => 'owner')
        const request = envelope()
        await expect(authenticate.authenticate({ ...request, requestId: 'changed' }, request.submittedAt)).rejects.toMatchObject({ code: 'REQUEST_HASH_MISMATCH' })
        await expect(authenticate.authenticate(request, request.expiresAt!)).rejects.toMatchObject({ code: 'REQUEST_EXPIRED' })
        expect(call).not.toHaveBeenCalled()
        await authenticate.authenticate(request, request.expiresAt!, { allowExpiredReplay: true })
        expect(call).toHaveBeenCalledTimes(1)
    })
    it('only maps known pre-accept errors and leaves storage/ACL faults unavailable', async () => {
        const call = vi.fn().mockRejectedValue('E_AGENT_AUTHENTICATION_FAILED')
        const native = createNativeAgentCommands(call as never)
        await expect(native.authentication(() => 'owner').authenticate(envelope(), envelope().submittedAt)).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' })
        call.mockRejectedValue('E_AGENT_REQUEST_TOO_LARGE')
        await expect(native.read('owner', 'request-1', 65_536)).rejects.toMatchObject({ code: 'REQUEST_TOO_LARGE' })
        call.mockRejectedValue('E_AGENT_INVALID_ENVELOPE')
        await expect(native.read('owner', 'request-1', 65_536)).rejects.toMatchObject({ code: 'INVALID_ENVELOPE' })
        call.mockRejectedValue('AGENT_PRIVATE_DIRECTORY_REQUIRED')
        await expect(native.read('owner', 'request-1', 65_536)).rejects.toBe('AGENT_PRIVATE_DIRECTORY_REQUIRED')
    })
})
