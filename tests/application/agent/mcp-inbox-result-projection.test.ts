import { describe, expect, it } from 'vitest'
import { projectAgentInboxResult } from '@/adapters/agent/mcp/inbox-result-projection'
import { agentRequestHash, AgentCommandError, type AgentCommandEnvelope } from '@/application/agent/agent-command-contract'
import { agentResultDigest, type AgentCommandReceipt } from '@/application/agent/command-receipt-repository'
import { canonicalSerialize, hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import type { JsonObject } from '@/domain/composition/types'

// Pure pre-spike contract fixtures; these do not authenticate a client or prove MCP/native transport.
function envelope(requestId = 'request-1'): AgentCommandEnvelope {
    const value: AgentCommandEnvelope = {
        schemaVersion: 1, requestId, requestHash: `sha256:${'0'.repeat(64)}`,
        submittedAt: '2026-09-06T00:00:00.000Z', expiresAt: '2026-09-06T01:00:00.000Z',
        context: { apiVersion: 'nai-blue.agent/v1alpha1', workspaceId: 'workspace-1',
            clientId: 'client-e363a1741656e987c2ca6535a258533e', actor: { kind: 'agent' }, idempotencyKey: requestId },
        command: { name: 'generation.get_run', input: { runId: 'run-1' } },
        authentication: { scheme: 'hmac-sha256', keyId: 'key-1', signature: `hmac-sha256:${'0'.repeat(64)}` },
    }
    return { ...value, requestHash: agentRequestHash(value) }
}

function receipt(request = envelope(), result: JsonObject | null = { found: false }, state: AgentCommandReceipt['state'] = 'completed'): AgentCommandReceipt {
    return { schemaVersion: 1, requestId: request.requestId, requestHash: request.requestHash,
        authenticatedClientId: request.context.clientId, command: request.command.name,
        state, observedAt: '2026-09-06T00:00:01.000Z', resultSchemaVersion: 1,
        result, resultDigest: result === null ? null : agentResultDigest(result) }
}

function expectCode(action: () => unknown, code: string) {
    try { action(); throw new Error('Expected rejection') }
    catch (error) {
        expect(error).toBeInstanceOf(AgentCommandError)
        expect((error as AgentCommandError).code).toBe(code)
        expect((error as Error).message).toBe('Agent command was rejected.')
    }
}

describe('Phase 10A pre-spike inbox result projection', () => {
    it('preserves the application receipt exactly without claiming generation success or exporting authentication', () => {
        const saved = receipt()
        const projected = projectAgentInboxResult(envelope(), saved, null)
        expect(projected).toEqual({ status: 'application-receipt', requestId: 'request-1', requiresAppProcess: true, receipt: saved })
        expect(projected.receipt).not.toBe(saved)
        expect(JSON.stringify(projected)).not.toContain('authentication')
        expect(projected).not.toHaveProperty('accepted')
    })

    it('reports only submission when caller established ready publication and both files are absent', () => {
        expect(projectAgentInboxResult(envelope(), null, null)).toEqual({ status: 'submitted-to-inbox', accepted: false,
            requestId: 'request-1', requiresAppProcess: true })
    })

    it('retains unresolved acceptance and needs-input handles without advancing their state', () => {
        const accepted = receipt(envelope(), null, 'accepted')
        expect(projectAgentInboxResult(envelope(), accepted, null).receipt).toEqual(accepted)
        const pending = receipt(envelope(), { code: 'AGENT_APPROVAL_REQUIRED', requestId: 'request-1', runId: 'run-1' }, 'needs-input')
        expect(projectAgentInboxResult(envelope(), pending, null).receipt).toEqual(pending)
    })

    it('binds concurrent results to every receipt identity field and archive integrity', () => {
        const first = envelope(), second = envelope('request-2')
        expectCode(() => projectAgentInboxResult(first, receipt(second), null), 'INBOX_RESULT_MISMATCH')
        expect(projectAgentInboxResult(second, receipt(second), null).requestId).toBe('request-2')
        for (const mismatch of [
            { requestHash: `sha256:${'f'.repeat(64)}` }, { authenticatedClientId: 'client-other' },
            { command: 'workspace.get_snapshot' },
        ]) expectCode(() => projectAgentInboxResult(first, { ...receipt(first), ...mismatch }, null), 'INBOX_RESULT_MISMATCH')
        expectCode(() => projectAgentInboxResult({ ...first, command: { name: 'generation.get_run', input: { runId: 'run-2' } } }, null, null), 'REQUEST_HASH_MISMATCH')
    })

    it('preserves exact bounded public payloads plus receipt overhead and finite decimal results', () => {
        const result = { note: ' '.repeat(65_536 - canonicalSerialize({ note: '' }).length) }
        const saved = receipt(envelope(), result)
        expect(new TextEncoder().encode(canonicalSerialize(result)).length).toBe(65_536)
        expect(canonicalSerialize(saved).length).toBeGreaterThan(65_536)
        expect(projectAgentInboxResult(envelope(), saved, null).receipt).toEqual(saved)
        const decimal = receipt(envelope(), { estimatedAnlas: 1.25 })
        expect(projectAgentInboxResult(envelope(), decimal, null).receipt).toEqual(decimal)
        expectCode(() => projectAgentInboxResult(envelope(), { ...saved, result: { note: result.note + ' ' } }, null), 'UNSAFE_PAYLOAD')
    })

    it('validates fixed pre-acceptance rejection files and rejects competing projections', () => {
        expect(projectAgentInboxResult(envelope(), null, { accepted: false, code: 'AUTHENTICATION_FAILED' })).toEqual({
            status: 'inbox-rejection', requestId: 'request-1', requiresAppProcess: true, accepted: false, code: 'AUTHENTICATION_FAILED',
        })
        for (const rejected of [
            { accepted: true, code: 'AUTHENTICATION_FAILED' }, { accepted: false, code: 'ARBITRARY_CODE' },
            { accepted: false, code: 'APP_UNAVAILABLE', message: 'private details' }, [], 'bad',
        ]) expectCode(() => projectAgentInboxResult(envelope(), null, rejected), 'INVALID_INBOX_REJECTION')
        expectCode(() => projectAgentInboxResult(envelope(), receipt(), { accepted: false, code: 'APP_UNAVAILABLE' }), 'INBOX_RESULT_CONFLICT')
    })

    it.each([
        { secret: 'private value' }, { note: 'Bearer secretvalue01234567890123456789' },
        { note: 'iVBORw0KGgo=' }, { base64: 'aGVsbG8gd29ybGQ=' },
        { note: 'C:\\Users\\Private\\file.png' }, { note: '/home/private/file.png' },
        { note: 'https://example.test/file?X-Amz-Signature=private' },
    ])('rejects unsafe saved material without exposing the input: %j', result => {
        const saved = { ...receipt(), result, resultDigest: `sha256:${hashCanonicalValue(result)}` }
        expectCode(() => projectAgentInboxResult(envelope(), saved, null), 'UNSAFE_PAYLOAD')
    })

    it('rejects corrupt digest and malformed envelope before returning any result', () => {
        expectCode(() => projectAgentInboxResult(envelope(), { ...receipt(), resultDigest: `sha256:${'f'.repeat(64)}` }, null), 'INVALID_RECEIPT')
        expectCode(() => projectAgentInboxResult({ unsafe: 'input' }, receipt(), null), 'INVALID_ENVELOPE')
    })
})
