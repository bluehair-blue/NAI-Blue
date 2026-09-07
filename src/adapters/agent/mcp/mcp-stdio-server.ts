import { Server, ProtocolError, INTERNAL_ERROR, type JsonSchemaType, type CallToolResult } from '@modelcontextprotocol/server'
import { AGENT_COMMAND_NAMES, AgentCommandError, assertAgentPublicValue, assertAgentRequestId, type AgentCommand, type AgentCommandName } from '@/application/agent/agent-command-contract'
import { getAgentCommandInputContract } from '@/application/agent/agent-command-input'
import { describeAgentCommandCapabilities, type RuntimeCapabilityDescriptor } from '@/application/agent/runtime-capability-registry'
import { parseAgentCommandReceipt } from '@/application/agent/command-receipt-repository'
import { hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import type { JsonObject } from '@/domain/composition/types'
import { assertSyncPayloadSafe } from '@/domain/sync/payload-safety'
import { isAgentInboxRejectionCode } from '@/adapters/agent/inbox/process-agent-inbox-file'

/** The Node entry owns signing/file I/O; application commands still own all business decisions. */
export interface McpAgentInbox {
    invoke(command: AgentCommand, requestId: string, signal?: AbortSignal): Promise<JsonObject>
    inspect(requestId: string, signal?: AbortSignal): Promise<JsonObject>
}

const capabilitiesUri = 'nai-blue://capabilities'
const requestUriPrefix = 'nai-blue://requests/'
const requestIdSchema = { type: 'string', minLength: 1, maxLength: 100,
    pattern: '^[A-Za-z0-9_-]+$', not: { pattern: '^(?:[cC][oO][nN]|[pP][rR][nN]|[aA][uU][xX]|[nN][uU][lL]|[cC][oO][mM][0-9]|[lL][pP][tT][0-9])$' } }

// Result values originate in the shared receipt parser, while this transport wrapper
// projects submission/observation states without inventing MCP task or approval state.
export const MCP_AGENT_RESULT_SCHEMA: JsonSchemaType = {
    type: 'object', required: ['status', 'requiresAppProcess'], additionalProperties: false,
    properties: {
        status: { enum: ['application-receipt', 'inbox-rejection', 'submitted-to-inbox', 'submission-unconfirmed', 'observation-cancelled', 'adapter-error'] },
        requestId: requestIdSchema, requiresAppProcess: { const: true }, accepted: { const: false },
        code: { type: 'string' }, receipt: { type: 'object' },
    },
}

function validatedObservation(value: JsonObject, requestId: string, command?: AgentCommandName): JsonObject {
    if (value.requestId !== requestId || value.requiresAppProcess !== true) throw new AgentCommandError('INBOX_RESULT_MISMATCH')
    if (value.status === 'application-receipt') {
        if (Object.keys(value).sort().join() !== 'receipt,requestId,requiresAppProcess,status') throw new AgentCommandError('INVALID_INBOX_RESULT')
        const receipt = parseAgentCommandReceipt(value.receipt)
        if (receipt.requestId !== requestId || (command !== undefined && receipt.command !== command)) {
            throw new AgentCommandError('INBOX_RESULT_MISMATCH')
        }
        // Preserve the bounded public result plus receipt overhead. The scanner's
        // identity alias applies only to this copy; the original receipt is returned.
        const { authenticatedClientId, ...publicReceipt } = receipt
        assertSyncPayloadSafe({ ...value, receipt: { ...publicReceipt, clientId: authenticatedClientId } })
        return { status: value.status, requestId, requiresAppProcess: true, receipt: receipt as unknown as JsonObject }
    }
    assertAgentPublicValue(value)
    if (value.status === 'observation-cancelled') {
        // Stopping observation says nothing about prior application acceptance.
        if (Object.keys(value).sort().join() !== 'requestId,requiresAppProcess,status') throw new AgentCommandError('INVALID_INBOX_RESULT')
        return structuredClone(value)
    }
    const rejected = value.status === 'inbox-rejection'
    if (value.accepted !== false || Object.keys(value).sort().join() !== (rejected
        ? 'accepted,code,requestId,requiresAppProcess,status' : 'accepted,requestId,requiresAppProcess,status')
        || (rejected ? !isAgentInboxRejectionCode(value.code)
            : !['submitted-to-inbox', 'submission-unconfirmed'].includes(String(value.status)))) {
        throw new AgentCommandError('INVALID_INBOX_RESULT')
    }
    return structuredClone(value)
}

/** Validate current registry facts before advertising; local schema hashes are version checks, not policy. */
function capabilityDescriptors(value: unknown): RuntimeCapabilityDescriptor[] {
    if (!Array.isArray(value) || value.length !== AGENT_COMMAND_NAMES.length) throw new AgentCommandError('INVALID_CAPABILITIES')
    const seen = new Set<string>()
    return value.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)
            || Object.keys(item).some(key => !['command', 'available', 'reason', 'requiresAppProcess', 'canExecuteWhileAppClosed', 'requiresHumanApproval', 'inputSchemaHash'].includes(key))
            || !AGENT_COMMAND_NAMES.includes(item.command) || seen.has(item.command)
            || typeof item.available !== 'boolean' || typeof item.requiresHumanApproval !== 'boolean'
            || item.requiresAppProcess !== true || item.canExecuteWhileAppClosed !== false
            || (item.available ? item.reason !== undefined : typeof item.reason !== 'string' || !item.reason)
            || (item.inputSchemaHash !== undefined && (typeof item.inputSchemaHash !== 'string'
                || !/^sha256:[a-f0-9]{64}$/.test(item.inputSchemaHash)))) throw new AgentCommandError('INVALID_CAPABILITIES')
        seen.add(item.command)
        return structuredClone(item) as RuntimeCapabilityDescriptor
    })
}

/** SDK stdio framing/correlation stays outside application; every list probes current app facts. */
export function createAgentMcpServer(inbox: McpAgentInbox): Server {
    const server = new Server({ name: 'nai-blue-agent-spike', version: '0.1.0' }, {
        capabilities: { tools: {}, resources: {} },
        instructions: 'Local foreground inbox. Keep the same requestId after timeout or restart. '
            + 'Receipt completion is command completion; inspect its result for Queue/run state. '
            + 'Human approval happens in NAI Blue. Transport cancellation only stops waiting.',
    })

    async function freshCapabilities(signal: AbortSignal) {
        const requestId = `mcp-cap-${crypto.randomUUID()}`
        try {
            const observed = validatedObservation(await inbox.invoke({ name: 'system.describe_capabilities', input: {} }, requestId, signal), requestId, 'system.describe_capabilities')
            if (observed.status !== 'application-receipt') throw new AgentCommandError('APP_UNAVAILABLE')
            const receipt = parseAgentCommandReceipt(observed.receipt)
            if (receipt.command !== 'system.describe_capabilities' || receipt.state !== 'completed'
                || !Array.isArray(receipt.result?.capabilities)) throw new AgentCommandError('APP_UNAVAILABLE')
            const schemaMismatches: string[] = []
            const descriptors = capabilityDescriptors(receipt.result.capabilities).map(descriptor => {
                const contract = getAgentCommandInputContract(descriptor.command)
                if (descriptor.available && (contract === undefined
                    || descriptor.inputSchemaHash !== `sha256:${hashCanonicalValue(contract.schema)}`)) {
                    schemaMismatches.push(descriptor.command)
                    return { ...descriptor, available: false, reason: 'schema-version-mismatch' }
                }
                return descriptor
            })
            const available = descriptors.filter(descriptor => descriptor.available)
            return { status: 'fresh-application-capabilities', requestId, observedAt: receipt.observedAt,
                requiresAppProcess: true, capabilities: descriptors,
                schemaMismatches,
                available }
        } catch {
            return { status: 'app-state-unconfirmed', requestId, requiresAppProcess: true,
                capabilities: describeAgentCommandCapabilities([], { ready: false, mode: 'suggest', globalPause: false }),
                schemaMismatches: [], available: [] as RuntimeCapabilityDescriptor[] }
        }
    }

    server.setRequestHandler('tools/list', async (_request, context) => {
        const snapshot = await freshCapabilities(context.mcpReq.signal)
        return { tools: snapshot.available.map(descriptor => ({
            name: descriptor.command,
            description: `${descriptor.command}. Foreground app required. ${descriptor.requiresHumanApproval ? 'Human approval required in NAI Blue.' : ''} Preserve requestId across retries.`,
            inputSchema: { type: 'object' as const, properties: { requestId: requestIdSchema,
                input: getAgentCommandInputContract(descriptor.command)!.schema },
                required: ['requestId', 'input'], additionalProperties: false },
            outputSchema: MCP_AGENT_RESULT_SCHEMA as JsonSchemaType & { type: 'object' },
        })) }
    })

    server.setRequestHandler('tools/call', async (request, context): Promise<CallToolResult> => {
        try {
            const name = request.params.name as AgentCommandName
            const contract = getAgentCommandInputContract(name)
            const args = request.params.arguments
            if (!contract || !args || Object.keys(args).sort().join() !== 'input,requestId'
                || args.input === null || typeof args.input !== 'object' || Array.isArray(args.input)) {
                throw new AgentCommandError('INVALID_COMMAND_INPUT')
            }
            assertAgentRequestId(args.requestId)
            assertAgentPublicValue({ requestId: args.requestId })
            assertAgentPublicValue(args.input)
            const input = contract.validate(args.input as JsonObject)
            if (context.mcpReq.signal.aborted) throw new AgentCommandError('REQUEST_CANCELLED')
            const observed = validatedObservation(await inbox.invoke({ name, input }, args.requestId, context.mcpReq.signal), args.requestId, name)
            const rejected = observed.status === 'inbox-rejection'
                || (observed.status === 'application-receipt' && (observed.receipt as JsonObject).state === 'rejected')
            return { content: [{ type: 'text', text: JSON.stringify(observed) }], structuredContent: observed, isError: rejected }
        } catch {
            const result = { status: 'adapter-error', code: 'AGENT_MCP_REQUEST_FAILED', requiresAppProcess: true }
            return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: true }
        }
    })

    server.setRequestHandler('resources/list', async () => ({ resources: [{ uri: capabilitiesUri,
        name: 'Current foreground capabilities', mimeType: 'application/json',
        description: 'A fresh application probe; unavailable reasons are returned when no current receipt is obtained.' }] }))
    server.setRequestHandler('resources/templates/list', async () => ({ resourceTemplates: [{
        uriTemplate: `${requestUriPrefix}{requestId}`, name: 'Saved command receipt', mimeType: 'application/json',
        description: 'Historical receipt for this configured client. Reading does not replay a command or prove current app readiness.',
    }] }))
    server.setRequestHandler('resources/read', async (request, context) => {
        try {
            let result: JsonObject
            if (request.params.uri === capabilitiesUri) {
                const { available: _available, ...snapshot } = await freshCapabilities(context.mcpReq.signal)
                result = snapshot as unknown as JsonObject
                assertAgentPublicValue(result)
            } else {
                if (!request.params.uri.startsWith(requestUriPrefix)) throw new AgentCommandError('INVALID_COMMAND_INPUT')
                const requestId = request.params.uri.slice(requestUriPrefix.length)
                assertAgentRequestId(requestId)
                assertAgentPublicValue({ requestId })
                result = validatedObservation(await inbox.inspect(requestId, context.mcpReq.signal), requestId)
            }
            return { contents: [{ uri: request.params.uri, mimeType: 'application/json', text: JSON.stringify(result) }] }
        } catch { throw new ProtocolError(INTERNAL_ERROR, 'Agent resource is unavailable.') }
    })
    return server
}
