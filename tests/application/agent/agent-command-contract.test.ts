import { webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
    agentRequestHash, assertAgentPublicValue, assertAgentRequestId, canonicalAgentSigningPayload,
    parseAgentCommandEnvelope, type AgentCommandEnvelope,
} from '@/application/agent/agent-command-contract'
import { WebCryptoAgentAuthentication, type RegisteredAgentIdentity } from '@/adapters/agent/webcrypto-agent-authentication'

const NOW = '2026-09-05T00:00:00.000Z'
const LATER = '2026-09-05T01:00:00.000Z'
const subtle = webcrypto.subtle as SubtleCrypto

function unsigned(): AgentCommandEnvelope {
    const envelope: AgentCommandEnvelope = {
        schemaVersion: 1, requestId: 'request-1', requestHash: `sha256:${'0'.repeat(64)}`,
        submittedAt: NOW, expiresAt: LATER,
        context: {
            apiVersion: 'nai-blue.agent/v1alpha1', workspaceId: 'workspace-1', clientId: 'client-1',
            actor: { kind: 'agent', displayName: 'Local assistant' }, idempotencyKey: 'operation-1',
            correlationId: 'correlation-1', approvalToken: 'approval-1',
        },
        command: { name: 'generation.get_run', input: { batchId: 'batch-1' } },
        authentication: { scheme: 'hmac-sha256', keyId: 'key-1', signature: `hmac-sha256:${'0'.repeat(64)}` },
    }
    return { ...envelope, requestHash: agentRequestHash(envelope) }
}

async function fixture() {
    const key = await subtle.generateKey({ name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify'])
    const envelope = unsigned()
    const signature = await subtle.sign('HMAC', key, new TextEncoder().encode(canonicalAgentSigningPayload(envelope)))
    const signed: AgentCommandEnvelope = {
        ...envelope, authentication: { ...envelope.authentication,
            signature: `hmac-sha256:${Buffer.from(signature).toString('hex')}` },
    }
    const identity: RegisteredAgentIdentity = { clientId: 'client-1', keyId: 'key-1', revokedAt: null, actorKind: 'agent', key }
    return { envelope: signed, identity, verifier: new WebCryptoAgentAuthentication(async () => identity, subtle) }
}

describe('agent command wire boundary', () => {
    it('accepts a canonical bounded request and returns a detached value', () => {
        const value = unsigned()
        expect(parseAgentCommandEnvelope(value)).toEqual(value)
        expect(parseAgentCommandEnvelope(value)).not.toBe(value)
    })
    it.each(['../x', 'x/y', 'x\\y', 'x.tmp', 'x.ready.json', '', 'x'.repeat(101), 'CON', 'nul', 'Com1', 'lpt9', 'a:b'])('rejects unsafe filename ID %s', value => {
        expect(() => assertAgentRequestId(value)).toThrow()
    })
    it('requires every mandatory field and rejects unknown fields and user actor IDs', () => {
        for (const key of ['schemaVersion', 'requestId', 'requestHash', 'submittedAt', 'context', 'command', 'authentication']) {
            const envelope = { ...unsigned() } as Record<string, unknown>
            delete envelope[key]
            expect(() => parseAgentCommandEnvelope(envelope)).toThrow()
        }
        const envelope = unsigned()
        for (const invalid of [
            { ...envelope, args: {} },
            { ...envelope, command: { ...envelope.command, args: {} } },
            { ...envelope, context: { ...envelope.context, actor: { kind: 'user' } } },
            { ...envelope, context: { ...envelope.context, actor: { kind: 'agent', id: 'human-1' } } },
            { ...envelope, authentication: { ...envelope.authentication, secret: 'private' } },
            { ...envelope, submittedAt: '2026-09-05T00:00:00Z' },
            { ...envelope, expiresAt: NOW },
        ]) expect(() => parseAgentCommandEnvelope(invalid)).toThrow()
    })
    it.each([
        { token: 'private-value' }, { base64: 'aGVsbG8=' }, { outputPath: 'C:\\Users\\Private\\file.png' },
        { message: 'Bearer secretvalue012345678901234567890123' },
        { nested: { secretAccessKey: 'private-value' } }, { message: '/home/private/data.png' },
        { message: 'https://example.test/object?X-Amz-Signature=abc' },
    ])('rejects forbidden corpus at ingress and public result boundary', input => {
        expect(() => assertAgentPublicValue(input)).toThrow()
        expect(() => parseAgentCommandEnvelope({ ...unsigned(), command: { name: 'generation.plan', input } })).toThrow()
    })
    it('rejects oversized JSON and non-JSON values without echoing their content', () => {
        for (const value of [{ text: 'a'.repeat(65_537) }, { text: undefined }, { text: Number.NaN }]) {
            expect(() => assertAgentPublicValue(value)).toThrow('Agent command was rejected.')
        }
    })
    it('defines hash projection independently from signature and key rotation', () => {
        const envelope = unsigned()
        expect(agentRequestHash({ ...envelope, authentication: { ...envelope.authentication, keyId: 'rotated' } })).toBe(envelope.requestHash)
        expect(agentRequestHash({ ...envelope, requestId: 'other-request' })).not.toBe(envelope.requestHash)
        expect(canonicalAgentSigningPayload({ ...envelope, authentication: { ...envelope.authentication, signature: 'hmac-sha256:changed' } })).toBe(canonicalAgentSigningPayload(envelope))
        expect(canonicalAgentSigningPayload({ ...envelope, authentication: { ...envelope.authentication, keyId: 'rotated' } })).not.toBe(canonicalAgentSigningPayload(envelope))
    })
})

describe('registered WebCrypto HMAC authentication', () => {
    it('allows expired replay authentication explicitly without bypassing hash, signature or revocation', async () => {
        const { verifier, envelope, identity } = await fixture()
        await expect(verifier.authenticate(envelope, LATER)).rejects.toMatchObject({ code: 'REQUEST_EXPIRED' })
        await expect(verifier.authenticate(envelope, LATER, { allowExpiredReplay: true }))
            .resolves.toEqual({ clientId: 'client-1', actor: { kind: 'agent', id: 'client:client-1' } })
        const changed = { ...envelope, requestId: 'changed-request' }
        await expect(verifier.authenticate(changed, LATER, { allowExpiredReplay: true }))
            .rejects.toMatchObject({ code: 'REQUEST_HASH_MISMATCH' })
        await expect(verifier.authenticate({ ...changed, requestHash: agentRequestHash(changed) }, LATER, { allowExpiredReplay: true }))
            .rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' })
        const revoked = new WebCryptoAgentAuthentication(async () => ({ ...identity, revokedAt: NOW }), subtle)
        await expect(revoked.authenticate(envelope, LATER, { allowExpiredReplay: true }))
            .rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' })
    })
    it('verifies a real signature and derives actor ID exclusively from registry', async () => {
        const { verifier, envelope } = await fixture()
        await expect(verifier.authenticate(envelope, NOW)).resolves.toEqual({ clientId: 'client-1', actor: { kind: 'agent', id: 'client:client-1' } })
    })
    it('binds request metadata, context, command and key ID even when attacker recomputes hash', async () => {
        const { verifier, envelope } = await fixture()
        const mutations: AgentCommandEnvelope[] = [
            { ...envelope, requestId: 'request-2' },
            { ...envelope, submittedAt: '2026-09-04T00:00:00.000Z' },
            { ...envelope, expiresAt: '2026-09-05T02:00:00.000Z' },
            ...['workspaceId', 'clientId', 'correlationId', 'idempotencyKey', 'approvalToken'].map(field => ({
                ...envelope, context: { ...envelope.context, [field]: 'changed' },
            })),
            { ...envelope, context: { ...envelope.context, actor: { kind: 'service' } } },
            { ...envelope, context: { ...envelope.context, actor: { kind: 'agent', displayName: 'changed' } } },
            { ...envelope, command: { name: 'generation.cancel', input: envelope.command.input } },
            { ...envelope, command: { ...envelope.command, input: { batchId: 'batch-2' } } },
            { ...envelope, authentication: { ...envelope.authentication, keyId: 'key-2' } },
        ]
        for (const mutation of mutations) {
            await expect(verifier.authenticate({ ...mutation, requestHash: agentRequestHash(mutation) }, NOW))
                .rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' })
        }
    })
    it('rejects hash mismatch, expiry at boundary, unknown, revoked and substituted keys', async () => {
        const { verifier, envelope, identity } = await fixture()
        await expect(verifier.authenticate({ ...envelope, requestHash: `sha256:${'0'.repeat(64)}` }, NOW))
            .rejects.toMatchObject({ code: 'REQUEST_HASH_MISMATCH' })
        await expect(verifier.authenticate(envelope, LATER)).rejects.toMatchObject({ code: 'REQUEST_EXPIRED' })
        const other = await fixture()
        for (const registered of [null, { ...identity, revokedAt: NOW }, { ...identity, key: other.identity.key },
            { ...identity, clientId: 'another-client' }, { ...identity, keyId: 'another-key' },
            { ...identity, actorKind: 'service' as const }]) {
            await expect(new WebCryptoAgentAuthentication(async () => registered, subtle).authenticate(envelope, NOW))
                .rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' })
        }
    })
})
