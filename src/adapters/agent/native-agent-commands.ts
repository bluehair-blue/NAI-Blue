import { invoke } from '@tauri-apps/api/core'
import { AgentCommandError, agentRequestHash, assertAgentTimestamp, canonicalAgentSigningPayload, parseAgentCommandEnvelope, type AgentCommandAuthenticator } from '@/application/agent/agent-command-contract'

export interface AgentClientRegistration {
    readonly clientId: string
    readonly keyId: string
    readonly label: string
    readonly actorKind: 'agent' | 'service'
    readonly createdAt: string
    readonly revokedAt: string | null
}
export interface NativeAgentWorkspace {
    readonly available: true
    readonly workspaceId: string
    readonly clients: readonly AgentClientRegistration[]
}

/** Native methods own ACL, keyring and path authority; renderer arguments carry no secret. */
export function createNativeAgentCommands(call: typeof invoke = invoke) {
    return {
        initialize: () => call<NativeAgentWorkspace>('agent_commands_initialize'),
        register: (label: string, actorKind: 'agent' | 'service') => call<AgentClientRegistration>('agent_commands_register_client', { label, actorKind }),
        rotate: (clientId: string) => call<AgentClientRegistration>('agent_commands_rotate_client', { clientId }),
        revoke: (clientId: string) => call<AgentClientRegistration>('agent_commands_revoke_client', { clientId }),
        acquire: () => call<string | null>('agent_commands_acquire_owner'),
        release: (ownerToken: string) => call<void>('agent_commands_release_owner', { ownerToken }),
        list: (ownerToken: string) => call<string[]>('agent_commands_list_ready', { ownerToken }),
        read: async (ownerToken: string, requestId: string, maxBytes: number) => {
            try { return await call<string>('agent_commands_read_ready', { ownerToken, requestId, maxBytes }) }
            catch (error) {
                if (error === 'E_AGENT_REQUEST_TOO_LARGE') throw new AgentCommandError('REQUEST_TOO_LARGE')
                if (error === 'E_AGENT_INVALID_ENVELOPE') throw new AgentCommandError('INVALID_ENVELOPE')
                throw error
            }
        },
        publish: (ownerToken: string, requestId: string, serialized: string) => call<void>('agent_commands_publish_result', { ownerToken, requestId, serialized }),
        reject: (ownerToken: string, requestId: string, serialized: string) => call<void>('agent_commands_publish_rejection', { ownerToken, requestId, serialized }),
        retire: (ownerToken: string, requestId: string) => call<void>('agent_commands_retire_ready', { ownerToken, requestId }),
        authentication: (owner: () => string): AgentCommandAuthenticator => ({
            authenticate: async (input, observedAt, options) => {
                const envelope = parseAgentCommandEnvelope(input)
                assertAgentTimestamp(observedAt)
                if (agentRequestHash(envelope) !== envelope.requestHash) throw new AgentCommandError('REQUEST_HASH_MISMATCH')
                if (!options?.allowExpiredReplay && envelope.expiresAt !== undefined && envelope.expiresAt <= observedAt) {
                    throw new AgentCommandError('REQUEST_EXPIRED')
                }
                try {
                    return await call('agent_commands_authenticate', { ownerToken: owner(),
                        signingPayload: canonicalAgentSigningPayload(envelope), signature: envelope.authentication.signature })
                } catch (error) {
                    if (error === 'E_AGENT_AUTHENTICATION_FAILED') throw new AgentCommandError('AUTHENTICATION_FAILED')
                    throw error
                }
            },
        }),
    }
}
export type NativeAgentCommands = ReturnType<typeof createNativeAgentCommands>
