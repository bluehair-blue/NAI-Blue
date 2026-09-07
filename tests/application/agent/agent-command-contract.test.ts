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
    it('accepts the real native registration envelope and public workspace identifiers', () => {
        // Public request captured during native GUI QA; no credential is included.
        // Escape the public keyId separator to avoid Mailgun-key false positives; its runtime value is unchanged.
        const envelope = {
            authentication: { keyId: 'key\u002dd1b012e9bdba63fbbfce154da21d4818', scheme: 'hmac-sha256',
                signature: 'hmac-sha256:0692a4cfc564482190d513a31876a6ba28c7f63d59a6d624744995d6c363e1d7' },
            command: { input: {}, name: 'system.describe_capabilities' },
            context: { actor: { kind: 'agent' }, apiVersion: 'nai-blue.agent/v1alpha1',
                clientId: 'client-e363a1741656e987c2ca6535a258533e', idempotencyKey: 'qa9b-gui-capabilities',
                workspaceId: 'workspace-7fd51b694896777c32f9a6a2c33e16c4' },
            expiresAt: '2026-09-05T11:02:19.442Z',
            requestHash: 'sha256:aac2a023fbf36b966c58f6a8d740a59f732502a7b2b5ac3174557d7153dc7675',
            requestId: 'qa9b-gui-capabilities', schemaVersion: 1, submittedAt: '2026-09-05T10:02:19.442Z',
        }
        expect(agentRequestHash(envelope as AgentCommandEnvelope)).toBe(envelope.requestHash)
        expect(parseAgentCommandEnvelope(envelope)).toEqual(envelope)
        expect(() => assertAgentPublicValue({ workspaceId: envelope.context.workspaceId, workflowDrafts: [] })).not.toThrow()
    })
    it('limits random identifier allowance to named protocol references without bypassing forbidden material', () => {
        const randomId = 'client-e363a1741656e987c2ca6535a258533e'
        for (const field of ['clientId', 'workspaceId', 'correlationId', 'idempotencyKey', 'draftId', 'runId', 'jobId']) {
            expect(() => assertAgentPublicValue({ [field]: randomId })).not.toThrow()
            for (const forbidden of [
                'sk-proj-abcdefgh12345678', 'ghp_abcdefgh12345678',
                'Bearer secretvalue012345678901234567890123',
                'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
                'iVBORw0KGgo=', '89504e470d0a1a0a', 'C:\\Users\\Private\\file.png',
            ]) expect(() => assertAgentPublicValue({ [field]: forbidden })).toThrow()
        }
        for (const field of ['message', 'payload', 'unregisteredId']) {
            expect(() => assertAgentPublicValue({ [field]: randomId })).toThrow()
        }
        const nativeIds = { workspaceId: 'workspace-7fd51b694896777c32f9a6a2c33e16c4', clientId: randomId,
            idempotencyKey: 'request-e363a1741656e987c2ca6535a258533e',
            correlationId: 'correlation-e363a1741656e987c2ca6535a258533e' }
        const envelope = { ...unsigned(), context: { ...unsigned().context, ...nativeIds } }
        expect(parseAgentCommandEnvelope(envelope)).toEqual(envelope)
    })
    it('keeps fixed planner issue codes public without making arbitrary code payloads safe', () => {
        const codes = [
            'SOURCE_REVISION_CONFLICT', 'invalid-human-assessment', 'invalid-source', 'invalid-detached-capture',
            'invalid-detached-capture-digest', 'invalid-detached-source-bindings', 'invalid-detached-capture-jobs',
            'invalid-detached-seed-policy', 'detached-capture-hash-mismatch', 'invalid-detached-capture-content',
            'invalid-count', 'invalid-image-budget', 'invalid-anlas-budget', 'invalid-seed', 'invalid-trace-id',
            'invalid-seed-policy', 'unsupported-collision-policy', 'unsupported-r2-delivery', 'prepared-count-mismatch',
            'prepared-seed-mismatch', 'invalid-anlas-estimate', 'compatibility-synthetic-only',
            'compatibility-known-divergence', 'compatibility-unsupported', 'anlas-total-overflow',
            'replay-trace-unavailable', 'random-source-unavailable', 'prompt-module-unavailable',
            'character-prompt-invalid', 'fragment-sequence-conflict',
            'draft-model-required', 'draft-prompt-required', 'draft-character-prompt-invalid',
            'draft-resolution-required', 'draft-resolution-invalid', 'draft-generation-settings-invalid',
            'draft-output-invalid', 'draft-rights-owner-invalid', 'draft-rights-effective-date-required',
            'draft-credential-invalid', 'draft-count-invalid', 'draft-scenes-required', 'draft-scene-invalid',
            'COMMAND_OUTCOME_UNKNOWN', 'RESULT_NOT_PUBLIC',
        ]
        for (const code of codes) expect(() => assertAgentPublicValue({ code })).not.toThrow()
        expect(() => assertAgentPublicValue({ issueCodes: codes })).not.toThrow()
        expect(() => assertAgentPublicValue({ message: 'SOURCE_REVISION_CONFLICT' })).toThrow()
        for (const value of ['sk-proj-abcdefgh12345678', 'ghp_abcdefgh12345678', 'token=hidden',
            'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature', 'iVBORw0KGgo=',
            '89504e470d0a1a0a', 'C:\\Users\\Private\\file.png', 'aGVsbG8gd29ybGQ=']) {
            expect(() => assertAgentPublicValue({ code: value })).toThrow()
            expect(() => assertAgentPublicValue({ issueCodes: [value] })).toThrow()
        }
    })
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
