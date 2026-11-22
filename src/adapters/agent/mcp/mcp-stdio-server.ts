import { Server, ProtocolError, INTERNAL_ERROR, type CallToolResult } from '@modelcontextprotocol/server'
import { AGENT_COMMAND_NAMES, AgentCommandError, assertAgentPublicValue, assertAgentRequestId, type AgentCommand, type AgentCommandName } from '@/application/agent/agent-command-contract'
import { getAgentCommandInputContract } from '@/application/agent/agent-command-input'
import { AGENT_COMMAND_EFFECTS, describeAgentCommandCapabilities, type RuntimeCapabilityDescriptor } from '@/application/agent/runtime-capability-registry'
import { parseAgentCommandReceipt } from '@/application/agent/command-receipt-repository'
import { hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import type { JsonObject } from '@/domain/composition/types'
import { assertSyncPayloadSafe } from '@/domain/sync/payload-safety'
import { isAgentInboxRejectionCode } from '@/adapters/agent/inbox/process-agent-inbox-file'
import { AGENT_GUIDE_TOPICS, AGENT_GUIDE_URI_PREFIX, AGENT_MCP_INSTRUCTIONS, AGENT_WORKFLOW_GUIDE_URI, agentHint } from './agent-workflow-guide'
import { ADVANCED_COMMANDS, MAX_IMAGES_PER_CALL, MAX_WAIT_SECONDS, REQUEST_ID_REQUIRED, SNAPSHOT_LISTS, advancedCommandGuide, listAgentMcpTools } from './mcp-tool-catalog'
import { compactObservation, completedResult, plannedJobs, summarizePlan, summarizeResult, summarizeRun } from './mcp-result-summary'

export interface McpUsageEntry { kind: 'instructions' | 'tools-list' | 'tool' | 'resource'; name: string; chars: number; images: number }

/** The Node entry owns signing/file I/O; application commands still own all business decisions. */
export interface McpAgentInbox {
    runtimeStatus?(allowLaunch: boolean): Promise<JsonObject>
    readImage?(requestId: string, signal?: AbortSignal): Promise<{ data: string; mimeType: 'image/png' }>
    invoke(command: AgentCommand, requestId: string, signal?: AbortSignal): Promise<JsonObject>
    inspect(requestId: string, signal?: AbortSignal): Promise<JsonObject>
    /** Sizes only, never content: lets a session's real MCP inflow be measured afterwards. */
    recordUsage?(entry: McpUsageEntry): void
}

const capabilitiesUri = 'nai-blue://capabilities'
const runtimeUri = 'nai-blue://runtime'
const runtimeCodes = new Set(['MCP_ADAPTER_RECONNECT_REQUIRED', 'APP_INSTALLATION_NOT_FOUND', 'APP_INSTALLATION_INVALID',
    'APP_INSTALLATION_AMBIGUOUS', 'APP_NOT_RUNNING', 'APP_STARTING', 'APP_RUNTIME_RESTART_REQUIRED', 'APP_RUNTIME_UPGRADE_REQUIRED', 'APP_RUNTIME_CHECK_FAILED'])
const requestUriPrefix = 'nai-blue://requests/'
const imageUriPrefix = 'nai-blue://images/'
const argumentKeys = new Set(['requestId', 'input', 'detail', 'waitSeconds', 'include', 'command', 'planOnly'])
// Hosts commonly stop a tool call at 60 seconds; the last poll needs room to return before that.
const pollReserveMs = 5000
const defaultRunWaitSeconds = 40
const runExistsHint = 'The run exists. Call generation.get_run with this runId; do not run again.'
// Composite tools derive one request ID per stage, so the caller's root must leave room for the suffix.
const maxRootRequestIdLength = 90

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

/** Validate current registry facts before reporting them; local schema hashes are version checks, not policy. */
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

const isRejected = (observed: JsonObject): boolean => observed.status === 'inbox-rejection' || observed.status === 'adapter-error'
    || (observed.status === 'application-receipt' && (observed.receipt as JsonObject).state === 'rejected')

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
        const timer = setTimeout(done, milliseconds)
        signal.addEventListener('abort', done, { once: true })
    })
}

interface CallArguments {
    readonly requestId: string
    readonly input: JsonObject
    readonly full: boolean
    readonly waitSeconds?: number
    readonly include: string[]
    readonly command?: string
    readonly planOnly: boolean
}
/** Tracks whether anything reached the inbox, because only earlier failures prove non-submission. */
interface CallState { readonly signal: AbortSignal; readonly startedAt: number; attempted: boolean; lastRequestId?: string; hint?: string }

/** SDK framing stays outside application; tool names/schemas are static bindings while availability is live. */
export function createAgentMcpServer(inbox: McpAgentInbox): Server {
    const server = new Server({ name: 'nai-blue-agent-spike', version: '0.1.0' }, {
        capabilities: { tools: {}, resources: {} },
        instructions: AGENT_MCP_INSTRUCTIONS,
    })
    const usage = (kind: McpUsageEntry['kind'], name: string, chars: number, images = 0) => {
        try { inbox.recordUsage?.({ kind, name, chars, images }) } catch { /* measurement must never fail a call */ }
    }
    usage('instructions', 'initialize', AGENT_MCP_INSTRUCTIONS.length)

    /** The local locator exports only bounded public identity, never executable paths. */
    async function runtimeStatus(allowLaunch = false): Promise<JsonObject | undefined> {
        if (!inbox.runtimeStatus) return undefined
        const value = await inbox.runtimeStatus(allowLaunch)
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
                    requiresAppProcess: true,
                    capabilities: describeAgentCommandCapabilities([], { ready: false, mode: 'suggest', globalPause: false })
                        .map(descriptor => ({ ...descriptor, reason: 'runtime-not-current' })),
                    schemaMismatches: [] }
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
            return { status: 'fresh-application-capabilities', requestId, requestResource, observedAt: receipt.observedAt,
                ...(runtime ? { runtime } : {}), requiresAppProcess: true, capabilities: descriptors, schemaMismatches }
        } catch {
            // A missing/unfinished receipt describes observation, not process death.
            // Keep availability conservative and expose the same probe for read-only follow-up.
            return { status: 'app-state-unconfirmed', requestId, requestResource, observationStatus,
                ...(receiptState === undefined ? {} : { receiptState }), requiresAppProcess: true,
                capabilities: describeAgentCommandCapabilities([], { ready: false, mode: 'suggest', globalPause: false })
                    .map(descriptor => ({ ...descriptor, reason: 'capability-probe-unconfirmed' })),
                schemaMismatches: [] }
        }
    }

    // Static on purpose: probing the application here cost one inbox command per listing and made the
    // advertised text change with application state, which invalidates a host's cached tool definitions.
    server.setRequestHandler('tools/list', async () => {
        const tools = listAgentMcpTools()
        usage('tools-list', 'tools/list', JSON.stringify(tools).length)
        return { tools }
    })

    function respond(name: string, payload: unknown, isError: boolean, attachments: CallToolResult['content'] = []): CallToolResult {
        const text = JSON.stringify(payload)
        usage('tool', name, text.length + attachments.reduce((sum, item) => sum + (item.type === 'text' ? item.text.length : 0), 0),
            attachments.filter(item => item.type === 'image').length)
        return { content: [{ type: 'text', text }, ...attachments], isError }
    }

    /** One application command through validation, runtime check and the inbox; returns its validated observation. */
    async function submit(state: CallState, name: AgentCommandName, input: JsonObject, requestId: string): Promise<JsonObject> {
        const contract = getAgentCommandInputContract(name)
        if (!contract) throw new AgentCommandError('INVALID_COMMAND_INPUT')
        assertAgentRequestId(requestId)
        assertAgentPublicValue(input)
        const validated = contract.validate(input)
        if (state.signal.aborted) throw new AgentCommandError('REQUEST_CANCELLED')
        const effect = AGENT_COMMAND_EFFECTS[name]
        const runtime = await runtimeStatus(effect === 'plan' || effect === 'mutation')
        if (runtime && runtime.status !== 'ready') {
            return { status: 'adapter-error', code: String(runtime.code), requiresAppProcess: true, accepted: false, submissionAttempted: false }
        }
        if (state.signal.aborted) throw new AgentCommandError('REQUEST_CANCELLED')
        // Only failures before entering the inbox prove that nothing was submitted.
        state.attempted = true
        state.lastRequestId = requestId
        return validatedObservation(await inbox.invoke({ name, input: validated }, requestId, state.signal), requestId, name)
    }

    async function previewAttachments(state: CallState, requestId: string): Promise<CallToolResult['content']> {
        if (!inbox.readImage) return []
        try { return [{ type: 'image', ...await inbox.readImage(requestId, state.signal) }] }
        catch { return [{ type: 'text', text: `Preview unavailable for ${requestId}; inspect its saved receipt. No generation retry is authorized.` }] }
    }

    /** Polls with fresh request IDs because a reused ID replays the earlier observation. */
    async function observeRun(state: CallState, input: JsonObject, firstRequestId: string, waitSeconds: number): Promise<JsonObject> {
        // The budget covers the whole tool call, so earlier stages of generation.run shorten the wait.
        // Only the upper limit gives way to the reserve; a short requested wait is honoured in full.
        const deadline = state.startedAt + Math.min(waitSeconds * 1000, MAX_WAIT_SECONDS * 1000 - pollReserveMs)
        let progress: JsonObject | undefined
        for (let attempt = 0; ; attempt += 1) {
            const observed = await submit(state, 'generation.get_run', input, attempt === 0 ? firstRequestId : `mcp-poll-${crypto.randomUUID()}`)
            const monitor = completedResult(observed)?.monitor as JsonObject | undefined
            // A later poll the application has not answered yet says less than the progress already seen.
            if (monitor?.nextAction !== 'wait') return completedResult(observed) || !progress ? observed : progress
            progress = observed
            const remaining = deadline - Date.now()
            if (remaining <= 0 || state.signal.aborted) return observed
            await pause(Math.min(2000 + attempt * 1000, 5000, remaining), state.signal)
            if (state.signal.aborted) return observed
        }
    }

    async function callCommand(state: CallState, tool: string, command: AgentCommandName, args: CallArguments): Promise<CallToolResult> {
        // A summary without lists needs only the page header, so the application is asked for the smallest page.
        const input = command === 'workspace.get_snapshot' && !args.full && args.include.length === 0 && args.input.limit === undefined
            ? { ...args.input, limit: 1 } : args.input
        const observed = command === 'generation.get_run' && args.waitSeconds
            ? await observeRun(state, input, args.requestId, args.waitSeconds)
            : await submit(state, command, input, args.requestId)
        const result = completedResult(observed)
        const attachments = command === 'artifact.get_image' && result?.found === true ? await previewAttachments(state, args.requestId) : []
        if (args.full) return respond(tool, observed, isRejected(observed), attachments)
        return respond(tool, compactObservation(observed, result && summarizeResult(command, result, args.include)), isRejected(observed), attachments)
    }

    /**
     * Plan, enqueue and wait. Each stage keeps its own application verdict and the first unfinished stage is
     * returned as is. A failure after the plan names the stage's request or run, since the Queue may already hold work.
     */
    async function runGeneration(state: CallState, args: CallArguments): Promise<CallToolResult> {
        const stages: Record<string, JsonObject> = {}
        const finish = (stage: string, summary: Record<string, unknown>, isError: boolean) =>
            respond('generation.run', args.full ? { stage, ...stages } : { stage, ...summary }, isError)
        const failed = (stage: string, facts: Record<string, unknown>, hint?: string) => {
            const error = { status: 'adapter-error', code: 'AGENT_MCP_REQUEST_FAILED' }
            const requestId = typeof facts.requestId === 'string' ? facts.requestId : undefined
            const body = { ...error, ...facts, hint: hint ?? (facts.runId ? runExistsHint : agentHint(error, requestId)) }
            if (args.full) stages[stage] = { ...body, requiresAppProcess: true } as JsonObject
            return finish(stage, body, true)
        }
        const planObserved = stages.plan = await submit(state, 'generation.plan', args.input, `${args.requestId}-plan`)
        const plan = completedResult(planObserved)
        if (args.planOnly || !plan || plan.status !== 'ready' || typeof plan.planId !== 'string' || typeof plan.planHash !== 'string') {
            return finish('plan', compactObservation(planObserved, plan && summarizePlan(plan)), isRejected(planObserved))
        }
        const planFacts = (({ planId, estimatedAnlas, compatibilityStatuses, warnings }) =>
            ({ planId, estimatedAnlas, compatibilityStatuses, warnings }))(summarizePlan(plan))
        const enqueueRequestId = `${args.requestId}-enq`
        let enqueueObserved: JsonObject
        try { enqueueObserved = stages.enqueue = await submit(state, 'generation.enqueue', { planId: plan.planId, planHash: plan.planHash }, enqueueRequestId) }
        catch {
            // Whether the enqueue reached the inbox decides if its request can be inspected or simply was never made.
            return state.lastRequestId === enqueueRequestId
                ? failed('enqueue', { requestId: enqueueRequestId, ...planFacts })
                : failed('enqueue', { code: 'ENQUEUE_NOT_SUBMITTED', ...planFacts, planHash: plan.planHash },
                    'The plan is ready but its enqueue was not submitted. Submit this planId and planHash with generation.enqueue.')
        }
        const runId = completedResult(enqueueObserved)?.runId
        if (typeof runId !== 'string') {
            return finish('enqueue', { ...compactObservation(enqueueObserved), ...planFacts, planHash: plan.planHash }, isRejected(enqueueObserved))
        }
        let runObserved: JsonObject
        try { runObserved = stages.run = await observeRun(state, { runId }, `mcp-poll-${crypto.randomUUID()}`, args.waitSeconds ?? defaultRunWaitSeconds) }
        catch { return failed('run', { runId, ...planFacts }) }
        const run = completedResult(runObserved)
        // The work is enqueued even though this read of it did not complete: say so, and leave out the read's own
        // accepted/submissionAttempted facts, which describe that read and would look like an unsubmitted generation.
        if (!run) {
            const { accepted: _accepted, submissionAttempted: _submissionAttempted, requestId: _requestId, ...read } = compactObservation(runObserved)
            return finish('run', { ...read, runId, ...planFacts, hint: runExistsHint }, isRejected(runObserved))
        }
        const summary = summarizeRun(run, plannedJobs(plan))
        return finish('run', { runId, ...summary, ...planFacts,
            ...(summary.complete === false && summary.nextAction === 'wait'
                ? { hint: 'Still generating. Call generation.get_run with this runId and waitSeconds; do not run again.' } : {}) }, false)
    }

    async function readImages(state: CallState, args: CallArguments): Promise<CallToolResult> {
        const artifactIds = args.input.artifactIds
        if (Object.keys(args.input).join() !== 'artifactIds' || !Array.isArray(artifactIds)
            || artifactIds.length < 1 || artifactIds.length > MAX_IMAGES_PER_CALL) throw new AgentCommandError('INVALID_COMMAND_INPUT')
        const contract = getAgentCommandInputContract('artifact.get_image')!
        // Check every ID first so an invalid later entry cannot leave earlier reads submitted.
        for (const artifactId of artifactIds) { assertAgentPublicValue({ artifactId }); contract.validate({ artifactId }) }
        const images: Record<string, unknown>[] = [], attachments: CallToolResult['content'] = [], observations: JsonObject[] = []
        for (const [index, artifactId] of artifactIds.entries()) {
            const requestId = artifactIds.length === 1 ? args.requestId : `${args.requestId}-${index}`
            const observed = await submit(state, 'artifact.get_image', { artifactId }, requestId)
            observations.push(observed)
            const result = completedResult(observed)
            if (result?.found === true) {
                const resource = result.resource as JsonObject | undefined
                images.push({ artifactId, contentChecksum: result.contentChecksum, width: resource?.width, height: resource?.height })
                attachments.push(...await previewAttachments(state, requestId))
            } else images.push({ artifactId, ...compactObservation(observed, result) })
            if (observed.status === 'adapter-error' || observed.status === 'observation-cancelled' || state.signal.aborted) break
        }
        // Preview images follow in the order of the rows that carry a contentChecksum.
        return respond('artifact.get_images', args.full ? { observations } : { images }, observations.some(isRejected), attachments)
    }

    function parseArguments(state: CallState, tool: string, value: unknown): CallArguments {
        const args = (value ?? {}) as Record<string, unknown>
        const input = args.input === undefined ? {} : args.input
        if (typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !argumentKeys.has(key))
            || input === null || typeof input !== 'object' || Array.isArray(input)
            || ![undefined, 'summary', 'full'].includes(args.detail as string | undefined)
            || (args.command !== undefined && tool !== 'advanced.call')) throw new AgentCommandError('INVALID_COMMAND_INPUT')
        if (args.planOnly !== undefined && (tool !== 'generation.run' || typeof args.planOnly !== 'boolean')) throw new AgentCommandError('INVALID_COMMAND_INPUT')
        const waits = tool === 'generation.run' || tool === 'generation.get_run'
        if (args.waitSeconds !== undefined && (!waits || !Number.isSafeInteger(args.waitSeconds)
            || Number(args.waitSeconds) < 0 || Number(args.waitSeconds) > MAX_WAIT_SECONDS)) throw new AgentCommandError('INVALID_COMMAND_INPUT')
        const include = args.include === undefined ? [] : args.include
        if (!Array.isArray(include) || (args.include !== undefined && tool !== 'workspace.get_snapshot')
            || include.some(name => typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(SNAPSHOT_LISTS, name))) throw new AgentCommandError('INVALID_COMMAND_INPUT')
        if (args.requestId !== undefined) {
            assertAgentRequestId(args.requestId)
            assertAgentPublicValue({ requestId: args.requestId })
        } else if (REQUEST_ID_REQUIRED.includes(tool) && args.planOnly !== true) {
            state.hint = 'This tool needs a requestId you choose, so a cut-off call can be inspected instead of repeated. Nothing was submitted.'
            throw new AgentCommandError('INVALID_COMMAND_INPUT')
        }
        const requestId = (args.requestId as string | undefined) ?? `mcp-${crypto.randomUUID()}`
        const composite = tool === 'generation.run' || tool === 'artifact.get_images'
        if (composite && requestId.length > maxRootRequestIdLength) throw new AgentCommandError('INVALID_COMMAND_INPUT')
        return { requestId, input: input as JsonObject, full: args.detail === 'full', include: include as string[], planOnly: args.planOnly === true,
            ...(args.waitSeconds === undefined ? {} : { waitSeconds: Number(args.waitSeconds) }),
            ...(typeof args.command === 'string' ? { command: args.command } : {}) }
    }

    server.setRequestHandler('tools/call', async (request, context): Promise<CallToolResult> => {
        const tool = request.params.name
        const full = (request.params.arguments as Record<string, unknown> | undefined)?.detail === 'full'
        const state: CallState = { signal: context.mcpReq.signal, startedAt: Date.now(), attempted: false }
        try {
            const args = parseArguments(state, tool, request.params.arguments)
            if (tool === 'generation.run') return await runGeneration(state, args)
            if (tool === 'artifact.get_images') return await readImages(state, args)
            if (tool === 'advanced.call') {
                if (!ADVANCED_COMMANDS.includes(args.command as AgentCommandName)) throw new AgentCommandError('INVALID_COMMAND_INPUT')
                return await callCommand(state, tool, args.command as AgentCommandName, args)
            }
            // Every contract-backed command stays callable by its own name, including those no longer advertised.
            if (!AGENT_COMMAND_NAMES.includes(tool as AgentCommandName)) throw new AgentCommandError('INVALID_COMMAND_INPUT')
            return await callCommand(state, tool, tool as AgentCommandName, args)
        } catch (error) {
            // A failure after submission names the request so the agent can inspect it instead of resubmitting.
            const result: JsonObject = state.attempted
                ? { status: 'adapter-error', code: 'AGENT_MCP_REQUEST_FAILED', requiresAppProcess: true,
                    ...(state.lastRequestId ? { requestId: state.lastRequestId } : {}) }
                : { status: 'adapter-error', requiresAppProcess: true, accepted: false, submissionAttempted: false,
                    code: error instanceof AgentCommandError && ['UNSAFE_PAYLOAD', 'REQUEST_CANCELLED'].includes(error.code)
                        ? error.code : 'INVALID_COMMAND_INPUT' }
            if (full) return respond(tool, result, true)
            const { requiresAppProcess: _requiresAppProcess, ...compact } = result
            return respond(tool, { ...compact, hint: state.hint ?? agentHint(result, state.attempted ? state.lastRequestId : undefined) }, true)
        }
    })

    server.setRequestHandler('resources/list', async () => ({ resources: [{ uri: runtimeUri,
        name: 'Installed runtime freshness', mimeType: 'application/json',
        description: 'Registered installation status without launching it.' }, { uri: capabilitiesUri,
        name: 'Current application capabilities', mimeType: 'application/json',
        description: 'Fresh command availability probe. Unconfirmed means no completed receipt was observed.' }, {
        uri: AGENT_WORKFLOW_GUIDE_URI, name: 'Agent workflow guide', mimeType: 'text/markdown',
        description: 'Optional. Usual order plus links to topic help (recovery, production, image-source, consent, runtime, advanced).',
    }] }))
    server.setRequestHandler('resources/templates/list', async () => ({ resourceTemplates: [{
        uriTemplate: `${requestUriPrefix}{requestId}`, name: 'Saved command receipt', mimeType: 'application/json',
        description: 'Full historical receipt of one request. Reading does not replay the command.',
    }, { uriTemplate: `${imageUriPrefix}{requestId}`, name: 'Authenticated saved image preview', mimeType: 'image/png',
        description: 'Preview from a completed image read belonging to this client.' }] }))
    server.setRequestHandler('resources/read', async (request, context) => {
        const uri = request.params.uri
        const textResource = (name: string, mimeType: string, text: string) => {
            usage('resource', name, text.length)
            return { contents: [{ uri, mimeType, text }] }
        }
        try {
            if (uri === runtimeUri) {
                return textResource(uri, 'application/json', JSON.stringify(await runtimeStatus() ?? { status: 'unavailable', code: 'APP_RUNTIME_CHECK_FAILED' }))
            }
            // Guides must be readable without a native inbox or application probe.
            if (uri.startsWith(AGENT_GUIDE_URI_PREFIX)) {
                const topic = uri.slice(AGENT_GUIDE_URI_PREFIX.length)
                const guide = topic === 'advanced' ? advancedCommandGuide()
                    : Object.prototype.hasOwnProperty.call(AGENT_GUIDE_TOPICS, topic) ? AGENT_GUIDE_TOPICS[topic] : undefined
                if (guide === undefined) throw new AgentCommandError('INVALID_COMMAND_INPUT')
                return textResource(uri, 'text/markdown', guide)
            }
            if (uri.startsWith(imageUriPrefix)) {
                const requestId = uri.slice(imageUriPrefix.length)
                assertAgentRequestId(requestId)
                if (!inbox.readImage) throw new AgentCommandError('IMAGE_RESOURCE_UNAVAILABLE')
                const image = await inbox.readImage(requestId, context.mcpReq.signal)
                usage('resource', imageUriPrefix, 0, 1)
                return { contents: [{ uri, mimeType: image.mimeType, blob: image.data }] }
            }
            let result: JsonObject
            if (uri === capabilitiesUri) {
                const { requestResource, ...snapshot } = await freshCapabilities(context.mcpReq.signal)
                result = snapshot as unknown as JsonObject
                assertAgentPublicValue(result)
                // This URI is built here from a generated request ID, never inbox input.
                // Add it after scanning so the fixed resource scheme is not mistaken for a path.
                result = { ...result, requestResource }
            } else {
                if (!uri.startsWith(requestUriPrefix)) throw new AgentCommandError('INVALID_COMMAND_INPUT')
                const requestId = uri.slice(requestUriPrefix.length)
                assertAgentRequestId(requestId)
                assertAgentPublicValue({ requestId })
                result = validatedObservation(await inbox.inspect(requestId, context.mcpReq.signal), requestId)
            }
            return textResource(uri === capabilitiesUri ? uri : requestUriPrefix, 'application/json', JSON.stringify(result))
        } catch { throw new ProtocolError(INTERNAL_ERROR, 'Agent resource is unavailable.') }
    })
    return server
}
