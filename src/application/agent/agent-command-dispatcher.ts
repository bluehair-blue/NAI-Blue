import { getAgentCommandInputContract } from './agent-command-input'
import { canonicalSerialize } from '@/domain/composition/canonical-serialize'
import type { JsonObject } from '@/domain/composition/types'
import { AgentCommandError, assertAgentPublicValue, parseAgentCommandEnvelope, type AgentCommandAuthenticator } from './agent-command-contract'
import { agentResultDigest, type AgentCommandReceipt, type CommandReceiptRepository } from './command-receipt-repository'
import { AGENT_COMMAND_EFFECTS, describeAgentCommandCapabilities, type AgentCommandHandler, type AgentCommandRuntimeState } from './runtime-capability-registry'

export interface AgentCommandDispatcherOptions {
    readonly workspaceId: string
    readonly authentication: AgentCommandAuthenticator
    readonly receipts: CommandReceiptRepository
    readonly handlers: readonly AgentCommandHandler[]
    readonly runtime: () => AgentCommandRuntimeState
    readonly now?: () => string
}

/** Authenticated receipts precede handlers; transport retries only project saved facts. */
export class AgentCommandDispatcher {
    private readonly handlers: readonly AgentCommandHandler[]

    constructor(private readonly options: AgentCommandDispatcherOptions) {
        if (!options.workspaceId || options.handlers.some(handler => handler.command === 'system.describe_capabilities'
            || AGENT_COMMAND_EFFECTS[handler.command] !== handler.effect)
            || new Set(options.handlers.map(handler => handler.command)).size !== options.handlers.length) {
            throw new AgentCommandError('INVALID_COMMAND_REGISTRATION')
        }
        this.handlers = [...options.handlers.map(handler => Object.freeze({ ...handler })), {
            command: 'system.describe_capabilities', effect: 'read',
            validate: getAgentCommandInputContract('system.describe_capabilities')!.validate,
            execute: async () => ({ capabilities: this.capabilities() } as unknown as JsonObject),
        }]
    }

    capabilities() {
        return describeAgentCommandCapabilities(this.handlers, this.options.runtime())
    }

    async dispatch(value: unknown): Promise<AgentCommandReceipt> {
        if (!this.options.runtime().ready) throw new AgentCommandError('APP_UNAVAILABLE')
        const envelope = parseAgentCommandEnvelope(value)
        if (envelope.context.workspaceId !== this.options.workspaceId) throw new AgentCommandError('WORKSPACE_MISMATCH')
        const now = this.options.now ?? (() => new Date().toISOString())
        const observedAt = now()
        const identity = await this.options.authentication.authenticate(envelope, observedAt, { allowExpiredReplay: true })
        // Even injected adapters cannot substitute a caller or claim human authority.
        if (identity.clientId !== envelope.context.clientId || identity.actor.kind !== envelope.context.actor.kind
            || identity.actor.id !== `client:${identity.clientId}`) throw new AgentCommandError('AUTHENTICATION_FAILED')
        if (!this.options.runtime().ready) throw new AgentCommandError('APP_UNAVAILABLE')

        // Expiry controls new work. A still-authorized client can retrieve its
        // exact saved result after expiry or after an application's validator update.
        const existing = await this.options.receipts.get(envelope.requestId)
        if (existing !== null) {
            if (existing.requestHash !== envelope.requestHash || existing.authenticatedClientId !== identity.clientId
                || existing.command !== envelope.command.name) throw new AgentCommandError('IDEMPOTENCY_CONFLICT')
            return existing
        }
        if (envelope.expiresAt !== undefined && Date.parse(envelope.expiresAt) <= Date.parse(now())) {
            throw new AgentCommandError('REQUEST_EXPIRED')
        }

        const handler = this.handlers.find(candidate => candidate.command === envelope.command.name)
        let input: JsonObject | undefined
        if (handler !== undefined) {
            input = handler.validate(structuredClone(envelope.command.input))
            assertAgentPublicValue(input)
            if (canonicalSerialize(input) !== canonicalSerialize(envelope.command.input)) {
                throw new AgentCommandError('COMMAND_INPUT_CHANGED')
            }
        }
        const claim = await this.options.receipts.claim({
            schemaVersion: 1, requestId: envelope.requestId, requestHash: envelope.requestHash,
            authenticatedClientId: identity.clientId, command: envelope.command.name,
            state: 'accepted', observedAt, resultSchemaVersion: 1, result: null, resultDigest: null,
        })
        if (claim.status === 'conflict') throw new AgentCommandError('IDEMPOTENCY_CONFLICT')
        // An accepted receipt after a crash is unresolved, never permission to retry.
        if (claim.status === 'existing') return claim.receipt

        const finish = async (state: Exclude<AgentCommandReceipt['state'], 'accepted'>, result: JsonObject) => {
            const digest = agentResultDigest(result)
            return this.options.receipts.finish(claim.receipt, {
                ...claim.receipt, state, result: structuredClone(result), resultDigest: digest,
            })
        }
        // A queued transaction can cross expiry. Keep the claim as evidence but
        // never enter a new handler after the request's authorization window.
        if (envelope.expiresAt !== undefined && Date.parse(envelope.expiresAt) <= Date.parse(now())) {
            return finish('rejected', { code: 'REQUEST_EXPIRED' })
        }
        // Re-evaluate after the claim: a human may pause or change policy during I/O.
        const capability = this.capabilities().find(item => item.command === envelope.command.name)!
        if (!capability.available || handler === undefined || input === undefined) {
            return finish(capability.requiresHumanApproval ? 'needs-input' : 'rejected', {
                code: capability.reason ?? 'handler-not-registered',
            })
        }
        let result: JsonObject
        try {
            result = await handler.execute(input, { envelope: structuredClone(envelope), identity: structuredClone(identity) })
        } catch {
            // No exception text or guessed failure is exported after entering a handler.
            return finish('needs-input', { code: 'COMMAND_OUTCOME_UNKNOWN' })
        }
        try {
            assertAgentPublicValue(result)
        } catch {
            return finish('needs-input', { code: 'RESULT_NOT_PUBLIC' })
        }
        return finish(handler.receiptState?.(result) ?? 'completed', result)
    }
}
