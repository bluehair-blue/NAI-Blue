import {
    AgentCommandError, agentRequestHash, assertAgentTimestamp, canonicalAgentSigningPayload,
    parseAgentCommandEnvelope, type AgentCommandAuthenticator, type AgentCommandEnvelope,
} from '@/application/agent/agent-command-contract'

export interface RegisteredAgentIdentity {
    readonly clientId: string
    readonly keyId: string
    readonly revokedAt: string | null
    readonly actorKind: 'agent' | 'service'
    readonly key: CryptoKey
}
export type RegisteredAgentIdentityLookup = (clientId: string, keyId: string) => Promise<RegisteredAgentIdentity | null>

/** Injected registry owns keys; this verifier never provisions or persists secrets. */
export class WebCryptoAgentAuthentication implements AgentCommandAuthenticator {
    constructor(
        private readonly lookup: RegisteredAgentIdentityLookup,
        private readonly subtle: SubtleCrypto = globalThis.crypto.subtle,
    ) {}

    async authenticate(
        input: AgentCommandEnvelope,
        observedAt: string,
        options: { allowExpiredReplay?: boolean } = {},
    ): ReturnType<AgentCommandAuthenticator['authenticate']> {
        const envelope = parseAgentCommandEnvelope(input)
        assertAgentTimestamp(observedAt)
        if (agentRequestHash(envelope) !== envelope.requestHash) throw new AgentCommandError('REQUEST_HASH_MISMATCH')
        // Only an authenticated durable replay lookup may bypass age. Its caller
        // must reject expiry before accepting any request absent from the ledger.
        if (!options.allowExpiredReplay && envelope.expiresAt !== undefined && envelope.expiresAt <= observedAt) {
            throw new AgentCommandError('REQUEST_EXPIRED')
        }
        try {
            const identity = await this.lookup(envelope.context.clientId, envelope.authentication.keyId)
            if (identity === null || identity.revokedAt !== null || identity.clientId !== envelope.context.clientId
                || identity.keyId !== envelope.authentication.keyId || identity.actorKind !== envelope.context.actor.kind
                || identity.key.algorithm.name !== 'HMAC'
                || (identity.key.algorithm as HmacKeyAlgorithm).hash.name !== 'SHA-256') {
                throw new AgentCommandError('AUTHENTICATION_FAILED')
            }
            const hex = envelope.authentication.signature.slice('hmac-sha256:'.length)
            const signature = Uint8Array.from(hex.match(/../g)!, byte => Number.parseInt(byte, 16))
            const valid = await this.subtle.verify('HMAC', identity.key, signature,
                new TextEncoder().encode(canonicalAgentSigningPayload(envelope)))
            if (!valid) throw new AgentCommandError('AUTHENTICATION_FAILED')
            return { clientId: identity.clientId, actor: { kind: identity.actorKind, id: `client:${identity.clientId}` } }
        } catch { throw new AgentCommandError('AUTHENTICATION_FAILED') }
    }
}
