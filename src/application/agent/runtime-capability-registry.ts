import type { JsonObject } from '@/domain/composition/types'
import { AGENT_COMMAND_NAMES, type AgentCommandEnvelope, type AgentCommandName, type AgentCommandAuthenticator } from './agent-command-contract'

/** Command semantics are application authority, never a claim made by a handler. */
export const AGENT_COMMAND_EFFECTS: Readonly<Record<AgentCommandName, 'read' | 'plan' | 'mutation'>> = Object.freeze({
    'system.describe_capabilities': 'read',
    'workspace.get_snapshot': 'read',
    'generation.plan': 'plan',
    'generation.enqueue': 'mutation',
    'generation.get_run': 'read',
    'generation.cancel': 'mutation',
    'generation.retry_storage': 'mutation',
    'scene.retry_link': 'mutation',
    'output.abandon_reservation': 'mutation',
    'scene.resolve_many': 'read',
    'scene.patch_many': 'mutation',
    'folder.plan_changes': 'plan',
    'r2.get_readiness': 'read',
})

export interface AgentCommandHandler {
    readonly command: AgentCommandName
    readonly effect: 'read' | 'plan' | 'mutation'
    /** Only the durable approval coordinator registers this execution gate. */
    readonly executionGate?: 'durable-approval'
    readonly receiptState?: (result: JsonObject) => 'completed' | 'needs-input' | 'rejected'
    /** Validation is local and pure; it must finish before durable acceptance. */
    readonly validate: (input: JsonObject) => JsonObject
    readonly execute: (input: JsonObject, context: {
        readonly envelope: AgentCommandEnvelope
        readonly identity: Awaited<ReturnType<AgentCommandAuthenticator['authenticate']>>
    }) => Promise<JsonObject>
}

export interface AgentCommandRuntimeState {
    readonly ready: boolean
    readonly mode: 'observe' | 'suggest' | 'bounded-auto'
    readonly globalPause: boolean
}

export interface RuntimeCapabilityDescriptor {
    readonly command: AgentCommandName
    readonly available: boolean
    readonly reason?: string
    readonly requiresAppProcess: true
    readonly canExecuteWhileAppClosed: false
    readonly requiresHumanApproval: boolean
}

/** The dispatcher and future UI/MCP projections consume these same handler facts. */
export function describeAgentCommandCapabilities(
    handlers: readonly AgentCommandHandler[], state: AgentCommandRuntimeState,
): readonly RuntimeCapabilityDescriptor[] {
    return AGENT_COMMAND_NAMES.map(command => {
        const handler = handlers.find(candidate => candidate.command === command)
        const effect = AGENT_COMMAND_EFFECTS[command]
        const managedEnqueue = command === 'generation.enqueue' && handler?.effect === effect
            && handler.executionGate === 'durable-approval'
        const managedCancellation = command === 'generation.cancel' && handler?.effect === effect
            && handler.executionGate === 'durable-approval'
        // Effective runtime policy controls the general approval requirement;
        // the coordinator still checks each plan and its durable budget reservation.
        const reason = !state.ready ? 'app-unavailable'
            : handler === undefined ? 'handler-not-registered'
                : handler.effect !== effect ? 'invalid-command-registration'
                    : effect === 'mutation' && !managedEnqueue && !managedCancellation ? 'human-approval-unavailable'
                    : state.mode === 'observe' && effect !== 'read' ? 'observe-only'
                        : undefined
        return {
            command, available: reason === undefined,
            ...(reason === undefined ? {} : { reason }),
            requiresAppProcess: true, canExecuteWhileAppClosed: false,
            requiresHumanApproval: effect === 'mutation'
                && !(managedEnqueue && state.mode === 'bounded-auto' && !state.globalPause),
        }
    })
}
