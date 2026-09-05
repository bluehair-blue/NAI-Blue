import { canonicalSerialize, hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import type { JsonObject } from '@/domain/composition/types'
import { assertSyncPayloadSafe } from '@/domain/sync/payload-safety'
import type { Sha256Digest } from '@/application/generation/generation-plan-contract'

export const AGENT_COMMAND_NAMES = [
    'system.describe_capabilities', 'workspace.get_snapshot', 'generation.plan', 'generation.enqueue',
    'generation.get_run', 'generation.cancel', 'generation.retry_storage', 'scene.retry_link',
    'output.abandon_reservation', 'scene.resolve_many', 'scene.patch_many', 'folder.plan_changes', 'r2.get_readiness',
] as const
export type AgentCommandName = typeof AGENT_COMMAND_NAMES[number]
export interface AgentCommand { readonly name: AgentCommandName; readonly input: JsonObject }
export interface AgentCommandEnvelope {
    readonly schemaVersion: 1
    readonly requestId: string
    readonly requestHash: Sha256Digest
    readonly submittedAt: string
    readonly expiresAt?: string
    readonly context: {
        readonly apiVersion: 'nai-blue.agent/v1alpha1'
        readonly workspaceId: string
        readonly clientId: string
        readonly actor: { readonly kind: 'agent' | 'service'; readonly displayName?: string }
        readonly correlationId?: string
        readonly idempotencyKey: string
        readonly approvalToken?: string
    }
    readonly command: AgentCommand
    readonly authentication: {
        readonly scheme: 'hmac-sha256'
        readonly keyId: string
        readonly signature: `hmac-sha256:${string}`
    }
}
export interface AgentCommandAuthenticator {
    /** Replay lookup may authenticate expired envelopes; new acceptance still enforces expiry. */
    authenticate(envelope: AgentCommandEnvelope, observedAt: string, options?: { allowExpiredReplay?: boolean }): Promise<{
        clientId: string
        actor: { kind: 'agent' | 'service'; id: string }
    }>
}

/** Public errors never interpolate rejected material, including parser/crypto errors. */
export class AgentCommandError extends Error {
    constructor(readonly code: string) {
        super('Agent command was rejected.')
        this.name = 'AgentCommandError'
    }
}
function invalid(): never { throw new AgentCommandError('INVALID_ENVELOPE') }
function record(value: unknown): asserts value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalid()
}
function fields(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
    if (required.some(key => !Object.prototype.hasOwnProperty.call(value, key))
        || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid()
}
function identifier(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value)) invalid()
}
export function assertAgentTimestamp(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
        || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid()
}
/** IDs are filenames only after this validation, including Windows device-name exclusion. */
export function assertAgentRequestId(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)
        || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value)) invalid()
}
/** Shared sync scanner owns secret/byte/path rejection; this boundary adds wire size. */
export function assertAgentPublicValue(value: unknown): asserts value is JsonObject {
    try {
        // Bound work before the shared credential/binary scanner examines strings.
        if (new TextEncoder().encode(canonicalSerialize(value)).byteLength > 65_536) invalid()
        assertSyncPayloadSafe(value)
    } catch { throw new AgentCommandError('UNSAFE_PAYLOAD') }
}

/** v1 request identity excludes the entire authentication block and its own hash. */
export function agentRequestHash(envelope: Omit<AgentCommandEnvelope, 'requestHash' | 'authentication'> | AgentCommandEnvelope): Sha256Digest {
    const { requestHash: _hash, authentication: _authentication, ...unsigned } = envelope as AgentCommandEnvelope
    return `sha256:${hashCanonicalValue(unsigned)}`
}
/** Signature binds every wire field except the signature itself, including key ID. */
export function canonicalAgentSigningPayload(envelope: AgentCommandEnvelope): string {
    const { signature: _signature, ...authentication } = envelope.authentication
    return canonicalSerialize({ ...envelope, authentication })
}

export function parseAgentCommandEnvelope(value: unknown): AgentCommandEnvelope {
    try {
        const serialized = canonicalSerialize(value)
        if (new TextEncoder().encode(serialized).byteLength > 65_536) invalid()
        record(value)
        fields(value, ['schemaVersion', 'requestId', 'requestHash', 'submittedAt', 'context', 'command', 'authentication'], ['expiresAt'])
        if (value.schemaVersion !== 1) invalid()
        assertAgentRequestId(value.requestId)
        if (typeof value.requestHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.requestHash)) invalid()
        assertAgentTimestamp(value.submittedAt)
        if (Object.prototype.hasOwnProperty.call(value, 'expiresAt')) {
            assertAgentTimestamp(value.expiresAt)
            if (value.expiresAt <= value.submittedAt) invalid()
        }
        record(value.context)
        fields(value.context, ['apiVersion', 'workspaceId', 'clientId', 'actor', 'idempotencyKey'], ['correlationId', 'approvalToken'])
        const context = value.context
        if (context.apiVersion !== 'nai-blue.agent/v1alpha1') invalid()
        for (const key of ['workspaceId', 'clientId', 'idempotencyKey']) identifier(context[key])
        for (const key of ['correlationId', 'approvalToken']) if (Object.prototype.hasOwnProperty.call(context, key)) identifier(context[key])
        record(context.actor)
        fields(context.actor, ['kind'], ['displayName'])
        if (context.actor.kind !== 'agent' && context.actor.kind !== 'service') invalid()
        if (Object.prototype.hasOwnProperty.call(context.actor, 'displayName') && (typeof context.actor.displayName !== 'string'
            || context.actor.displayName.length < 1 || context.actor.displayName.length > 100)) invalid()
        // approvalToken is an opaque approval reference, never a credential. Validate it
        // above; scan all other context text with the shared forbidden-material scanner.
        const { approvalToken: _approvalToken, ...publicContext } = context
        assertAgentPublicValue(publicContext)
        record(value.command)
        fields(value.command, ['name', 'input'])
        if (!(AGENT_COMMAND_NAMES as readonly unknown[]).includes(value.command.name)) invalid()
        assertAgentPublicValue(value.command.input)
        record(value.authentication)
        fields(value.authentication, ['scheme', 'keyId', 'signature'])
        if (value.authentication.scheme !== 'hmac-sha256'
            || typeof value.authentication.signature !== 'string'
            || !/^hmac-sha256:[a-f0-9]{64}$/.test(value.authentication.signature)) invalid()
        identifier(value.authentication.keyId)
        return JSON.parse(serialized) as AgentCommandEnvelope
    } catch (error) {
        if (error instanceof AgentCommandError) throw error
        throw new AgentCommandError('INVALID_ENVELOPE')
    }
}
