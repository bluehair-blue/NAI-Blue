import { Server, ProtocolError, INTERNAL_ERROR, type JsonSchemaType, type CallToolResult } from '@modelcontextprotocol/server'
import { AGENT_COMMAND_NAMES, AgentCommandError, assertAgentPublicValue, assertAgentRequestId, type AgentCommand, type AgentCommandName } from '@/application/agent/agent-command-contract'
import { getAgentCommandInputContract } from '@/application/agent/agent-command-input'
import { describeAgentCommandCapabilities, type RuntimeCapabilityDescriptor } from '@/application/agent/runtime-capability-registry'
import { parseAgentCommandReceipt } from '@/application/agent/command-receipt-repository'
import { hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import type { JsonObject } from '@/domain/composition/types'
import { assertSyncPayloadSafe } from '@/domain/sync/payload-safety'
import { isAgentInboxRejectionCode } from '@/adapters/agent/inbox/process-agent-inbox-file'
import { AGENT_MCP_INSTRUCTIONS, AGENT_TOOL_DESCRIPTIONS, AGENT_WORKFLOW_GUIDE, AGENT_WORKFLOW_GUIDE_URI } from './agent-workflow-guide'

/** The Node entry owns signing/file I/O; application commands still own all business decisions. */
export interface McpAgentInbox {
    runtimeStatus?(): Promise<JsonObject>
    readImage?(requestId: string, signal?: AbortSignal): Promise<{ data: string; mimeType: 'image/png' }>
    invoke(command: AgentCommand, requestId: string, signal?: AbortSignal): Promise<JsonObject>
    inspect(requestId: string, signal?: AbortSignal): Promise<JsonObject>
}

const capabilitiesUri = 'nai-blue://capabilities'
const runtimeUri = 'nai-blue://runtime'
const runtimeCodes = new Set(['MCP_ADAPTER_RECONNECT_REQUIRED', 'APP_INSTALLATION_NOT_FOUND', 'APP_INSTALLATION_INVALID',
    'APP_INSTALLATION_AMBIGUOUS', 'APP_STARTING', 'APP_RUNTIME_RESTART_REQUIRED', 'APP_RUNTIME_UPGRADE_REQUIRED', 'APP_RUNTIME_CHECK_FAILED'])
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
        code: { type: 'string' }, receipt: { type: 'object' }, submissionAttempted: { const: false },
        guideResource: { const: AGENT_WORKFLOW_GUIDE_URI },
        nextAction: { const: 'read-guide-resource-and-retry' },
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
        // The parser already validates SHA256 metadata and recomputes resultDigest;
        // scanning its hex as image bytes would reject legitimate hash coincidences.
        const { authenticatedClientId, requestHash: _requestHash, resultDigest: _resultDigest, ...publicReceipt } = receipt
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

/** SDK framing stays outside application; tool names/schemas are stable bindings while availability is live. */
export function createAgentMcpServer(inbox: McpAgentInbox): Server {
    // A resource read grants one non-accumulating credit in this connection;
    // discovery bypasses the gate and never consumes another command's credit.
    let guideRead = false
    const server = new Server({ name: 'nai-blue-agent-spike', version: '0.1.0' }, {
        capabilities: { tools: {}, resources: {} },
        instructions: AGENT_MCP_INSTRUCTIONS,
    })

    /** The local locator exports only bounded public identity, never executable paths. */
    async function runtimeStatus(): Promise<JsonObject | undefined> {
        if (!inbox.runtimeStatus) return undefined
        const value = await inbox.runtimeStatus()
        const { requestResource, ...publicValue } = value
        assertAgentPublicValue(publicValue)
        if (value.status !== 'ready' && (value.status !== 'unavailable' || !runtimeCodes.has(String(value.code)))) {
            throw new AgentCommandError('INVALID_RUNTIME_STATUS')
        }
        if (requestResource !== undefined && (typeof requestResource !== 'string'
            || !requestResource.startsWith(requestUriPrefix))) throw new AgentCommandError('INVALID_RUNTIME_STATUS')
        if (typeof requestResource === 'string') assertAgentRequestId(requestResource.slice(requestUriPrefix.length))
        return value
    }

    async function freshCapabilities(signal: AbortSignal) {
        const requestId = `mcp-cap-${crypto.randomUUID()}`
        const requestResource = `${requestUriPrefix}${requestId}`
        let observationStatus = 'probe-error'
        let receiptState: string | undefined
        try {
            const runtime = await runtimeStatus()
            if (runtime && runtime.status !== 'ready') {
                return { status: 'runtime-unavailable', runtime: { status: runtime.status, code: runtime.code }, requestResource: runtimeUri,
                    requiresAppProcess: true, guideReadRequired: true, guideDigest: `sha256:${hashCanonicalValue(AGENT_WORKFLOW_GUIDE)}`,
                    capabilities: describeAgentCommandCapabilities([], { ready: false, mode: 'suggest', globalPause: false })
                        .map(descriptor => ({ ...descriptor, reason: 'runtime-not-current' })),
                    schemaMismatches: [], available: [] as RuntimeCapabilityDescriptor[] }
            }
            const observed = validatedObservation(await inbox.invoke({ name: 'system.describe_capabilities', input: {} }, requestId, signal), requestId, 'system.describe_capabilities')
            observationStatus = String(observed.status)
            if (observed.status !== 'application-receipt') throw new AgentCommandError('CAPABILITY_PROBE_UNCONFIRMED')
            const receipt = parseAgentCommandReceipt(observed.receipt)
            receiptState = receipt.state
            if (receipt.command !== 'system.describe_capabilities' || receipt.state !== 'completed'
                || !Array.isArray(receipt.result?.capabilities)) throw new AgentCommandError('CAPABILITY_PROBE_UNCONFIRMED')
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
            return { status: 'fresh-application-capabilities', requestId, requestResource, observedAt: receipt.observedAt,
                ...(runtime ? { runtime } : {}),
                guideReadRequired: true, guideDigest: `sha256:${hashCanonicalValue(AGENT_WORKFLOW_GUIDE)}`,
                requiresAppProcess: true, capabilities: descriptors,
                schemaMismatches,
                available }
        } catch {
            // A missing/unfinished receipt describes observation, not process death.
            // Keep bindings conservative and expose the same probe for read-only follow-up.
            return { status: 'app-state-unconfirmed', requestId, requestResource, observationStatus,
                ...(receiptState === undefined ? {} : { receiptState }), requiresAppProcess: true,
                guideReadRequired: true, guideDigest: `sha256:${hashCanonicalValue(AGENT_WORKFLOW_GUIDE)}`,
                capabilities: describeAgentCommandCapabilities([], { ready: false, mode: 'suggest', globalPause: false })
                    .map(descriptor => ({ ...descriptor, reason: 'capability-probe-unconfirmed' })),
                schemaMismatches: [], available: [] as RuntimeCapabilityDescriptor[] }
        }
    }

    server.setRequestHandler('tools/list', async (_request, context) => {
        const snapshot = await freshCapabilities(context.mcpReq.signal)
        // Keep the transport binding discoverable when the application runtime is
        // still starting or temporarily unavailable. The capability resource and
        // description remain the execution authority, so this does not turn an
        // unavailable application command into an executable one.
        return { tools: snapshot.capabilities.flatMap(descriptor => {
            const contract = getAgentCommandInputContract(descriptor.command)
            if (contract === undefined) return []
            const availability = snapshot.status === 'app-state-unconfirmed'
                ? `Availability unconfirmed (${descriptor.reason}); inspect ${snapshot.requestResource} for the existing probe.`
                : snapshot.status === 'runtime-unavailable'
                ? `Runtime check required (${snapshot.runtime?.code ?? 'APP_RUNTIME_UNAVAILABLE'}); read nai-blue://runtime. Do not search old executable copies.`
                : descriptor.available
                ? 'Currently available.'
                : `Currently unavailable (${descriptor.reason ?? 'app-unavailable'}); read nai-blue://capabilities before calling.`
            const approval = ['scene.patch_many', 'folder.apply_changes', 'generation.enqueue'].includes(descriptor.command)
                ? 'NAI Blue honors active per-client always-approve consent; request human approval only if the application result requires it.'
                : descriptor.requiresHumanApproval ? 'NAI Blue checks command approval; request human action only if the application result requires it.'
                    : 'NAI Blue validates input and current policy.'
            return [{
                name: descriptor.command,
                description: `Do not use Computer Use, CDP, private APIs or extracted tokens for NAI Blue; diagnose the registered automation path if blocked. ${AGENT_TOOL_DESCRIPTIONS[descriptor.command]} ${availability} App process required; window focus, visibility and topmost position are not required. ${approval}`,
                inputSchema: { type: 'object' as const, properties: { requestId: requestIdSchema,
                    input: contract.schema },
                    required: ['requestId', 'input'], additionalProperties: false },
                outputSchema: MCP_AGENT_RESULT_SCHEMA as JsonSchemaType & { type: 'object' },
            }]
        }) }
    })

    server.setRequestHandler('tools/call', async (request, context): Promise<CallToolResult> => {
        if (!guideRead) {
            const result = { status: 'adapter-error', requiresAppProcess: true, accepted: false,
                submissionAttempted: false, code: 'GUIDE_READ_REQUIRED', guideResource: AGENT_WORKFLOW_GUIDE_URI,
                nextAction: 'read-guide-resource-and-retry' }
            return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: true }
        }
        // Consume before validation or awaiting anything: concurrent calls cannot share a read.
        guideRead = false
        let submissionAttempted = false
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
            const runtime = await runtimeStatus()
            if (runtime && runtime.status !== 'ready') {
                const result = { status: 'adapter-error', code: String(runtime.code), requiresAppProcess: true,
                    accepted: false, submissionAttempted: false }
                return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: true }
            }
            // Only failures before entering the inbox prove that nothing was submitted.
            submissionAttempted = true
            const observed = validatedObservation(await inbox.invoke({ name, input }, args.requestId, context.mcpReq.signal), args.requestId, name)
            const rejected = observed.status === 'inbox-rejection'
                || (observed.status === 'application-receipt' && (observed.receipt as JsonObject).state === 'rejected')
            const content: CallToolResult['content'] = [{ type: 'text', text: JSON.stringify(observed) }]
            if (name === 'artifact.get_image' && observed.status === 'application-receipt'
                && (observed.receipt as JsonObject).state === 'completed' && inbox.readImage) {
                content.push({ type: 'resource_link', uri: `nai-blue://images/${args.requestId}`,
                    name: 'Saved image preview', mimeType: 'image/png' })
                try { content.push({ type: 'image', ...await inbox.readImage(args.requestId, context.mcpReq.signal) }) }
                catch { content.push({ type: 'text', text: 'Image resource is unavailable; inspect its saved receipt. No generation retry is authorized.' }) }
            }
            return { content, structuredContent: observed, isError: rejected }
        } catch (error) {
            const result = submissionAttempted
                ? { status: 'adapter-error', code: 'AGENT_MCP_REQUEST_FAILED', requiresAppProcess: true }
                : { status: 'adapter-error', requiresAppProcess: true, accepted: false, submissionAttempted: false,
                    code: error instanceof AgentCommandError && ['UNSAFE_PAYLOAD', 'REQUEST_CANCELLED'].includes(error.code)
                        ? error.code : 'INVALID_COMMAND_INPUT' }
            return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: true }
        }
    })

    server.setRequestHandler('resources/list', async () => ({ resources: [{ uri: runtimeUri,
        name: 'Installed runtime freshness', mimeType: 'application/json',
        description: 'Resolve the registered installation, normally launch it if closed, and verify the live PID/version/executable hash. No process termination or installation. Reuse the pending probe resource.' }, { uri: capabilitiesUri,
        name: 'Current application capabilities', mimeType: 'application/json',
        description: 'Fresh command-runtime probe. Unconfirmed means no valid completed receipt was observed; inspect its requestResource. Window focus is not required.' }, {
        uri: AGENT_WORKFLOW_GUIDE_URI, name: 'Agent workflow guide v1', mimeType: 'text/markdown',
        description: 'On-demand authoring, production, receipt replay, approval and recovery workflow. Static guidance, not live capability evidence.',
    }] }))
    server.setRequestHandler('resources/templates/list', async () => ({ resourceTemplates: [{
        uriTemplate: `${requestUriPrefix}{requestId}`, name: 'Saved command receipt', mimeType: 'application/json',
        description: 'Historical receipt for this configured client. Reading does not replay a command or prove current app readiness.',
    }, { uriTemplate: 'nai-blue://images/{requestId}', name: 'Authenticated saved image preview', mimeType: 'image/png',
        description: 'Bounded metadata-free preview from a completed artifact.get_image receipt belonging to this configured client.' }] }))
    server.setRequestHandler('resources/read', async (request, context) => {
        try {
            if (request.params.uri === runtimeUri) {
                return { contents: [{ uri: runtimeUri, mimeType: 'application/json',
                    text: JSON.stringify(await runtimeStatus() ?? { status: 'unavailable', code: 'APP_RUNTIME_CHECK_FAILED' }) }] }
            }
            // Guide discovery/read must work without a native inbox or application probe.
            if (request.params.uri === AGENT_WORKFLOW_GUIDE_URI) {
                guideRead = true
                return { contents: [{ uri: AGENT_WORKFLOW_GUIDE_URI, mimeType: 'text/markdown', text: AGENT_WORKFLOW_GUIDE }] }
            }
            if (request.params.uri.startsWith('nai-blue://images/')) {
                const requestId = request.params.uri.slice('nai-blue://images/'.length)
                assertAgentRequestId(requestId)
                if (!inbox.readImage) throw new AgentCommandError('IMAGE_RESOURCE_UNAVAILABLE')
                const image = await inbox.readImage(requestId, context.mcpReq.signal)
                return { contents: [{ uri: request.params.uri, mimeType: image.mimeType, blob: image.data }] }
            }
            let result: JsonObject
            if (request.params.uri === capabilitiesUri) {
                const { available: _available, requestResource, ...snapshot } = await freshCapabilities(context.mcpReq.signal)
                result = snapshot as unknown as JsonObject
                assertAgentPublicValue(result)
                // This URI is built here from a generated request ID, never inbox input.
                // Add it after scanning so the fixed resource scheme is not mistaken for a path.
                result = { ...result, requestResource }
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
