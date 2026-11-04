import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { createAgentMcpServer, type McpAgentInbox } from '@/adapters/agent/mcp/mcp-stdio-server'
import { AGENT_MCP_INSTRUCTIONS, AGENT_WORKFLOW_GUIDE, AGENT_WORKFLOW_GUIDE_URI } from '@/adapters/agent/mcp/agent-workflow-guide'
import { AGENT_COMMAND_NAMES, AgentCommandError, type AgentCommand, type AgentCommandName } from '@/application/agent/agent-command-contract'
import { getAgentCommandInputContract } from '@/application/agent/agent-command-input'
import { AGENT_COMMAND_EFFECTS, describeAgentCommandCapabilities, type AgentCommandHandler } from '@/application/agent/runtime-capability-registry'
import { agentResultDigest, type AgentCommandReceipt } from '@/application/agent/command-receipt-repository'
import { canonicalSerialize, hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import type { JsonObject } from '@/domain/composition/types'
import { deriveGenerationFulfillment } from '@/application/generation/generation-fulfillment'
import { projectGenerationRunStatus } from '@/application/generation/generation-run-monitor'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(close => close())) })

function descriptors(ready = true) {
    const handlers: AgentCommandHandler[] = AGENT_COMMAND_NAMES.flatMap(command => {
        const contract = getAgentCommandInputContract(command)
        return contract ? [{ command, effect: AGENT_COMMAND_EFFECTS[command], executionGate: 'durable-approval' as const,
            validate: contract.validate, execute: async () => ({}) }] : []
    })
    return describeAgentCommandCapabilities(handlers, { ready, mode: 'suggest', globalPause: false })
}

function observed(requestId: string, command: AgentCommandName, result: JsonObject | null = { found: false }, state: AgentCommandReceipt['state'] = 'completed'): JsonObject {
    return { status: 'application-receipt', requestId, requiresAppProcess: true, receipt: {
        schemaVersion: 1, requestId, command, requestHash: `sha256:${'a'.repeat(64)}`,
        authenticatedClientId: 'client-e363a1741656e987c2ca6535a258533e', state,
        observedAt: '2026-09-06T00:00:01.000Z', resultSchemaVersion: 1,
        result, resultDigest: result === null ? null : agentResultDigest(result),
    } }
}

async function fixture(overrides: Partial<McpAgentInbox> = {}, autoReadGuide = true) {
    const invokes: { command: AgentCommand; requestId: string }[] = []
    const inspections: string[] = []
    const inbox: McpAgentInbox = {
        runtimeStatus: overrides.runtimeStatus,
        readImage: overrides.readImage,
        invoke: async (command, requestId, signal) => {
            invokes.push({ command, requestId })
            if (overrides.invoke) return overrides.invoke(command, requestId, signal)
            return observed(requestId, command.name, command.name === 'system.describe_capabilities'
                ? { capabilities: descriptors() } as unknown as JsonObject : { found: false })
        },
        inspect: async (requestId, signal) => {
            inspections.push(requestId)
            return overrides.inspect ? overrides.inspect(requestId, signal) : observed(requestId, 'generation.get_run')
        },
    }
    // Actual official SDK handshake, request dispatch, result validation and correlation;
    // only the filesystem/native inbox port is simulated in this focused suite.
    const server = createAgentMcpServer(inbox)
    const client = new Client({ name: 'phase10-sdk-contract-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    if (autoReadGuide) {
        const call = client.callTool.bind(client)
        let admission = Promise.resolve()
        vi.spyOn(client, 'callTool').mockImplementation((...args) => {
            let pending!: ReturnType<typeof call>
            const start = admission.then(async () => {
                await client.readResource({ uri: AGENT_WORKFLOW_GUIDE_URI })
                pending = call(...args)
            })
            admission = start.catch(() => {})
            return start.then(() => pending)
        })
    }
    cleanups.push(async () => { await client.close(); await server.close() })
    return { client, invokes, inspections }
}

describe('Phase 10 official SDK server with simulated inbox', () => {
    it('blocks stale runtimes before submitting work but keeps guide and historical receipts readable', async () => {
        const f = await fixture({ runtimeStatus: async () => ({ status: 'unavailable', code: 'APP_RUNTIME_RESTART_REQUIRED' }) })
        const result = await f.client.callTool({ name: 'workspace.get_snapshot', arguments: { requestId: 'blocked-runtime', input: {} } })
        expect(result.structuredContent).toMatchObject({ code: 'APP_RUNTIME_RESTART_REQUIRED', accepted: false, submissionAttempted: false })
        expect(f.invokes).toHaveLength(0)
        await expect(f.client.readResource({ uri: 'nai-blue://requests/saved-runtime' })).resolves.toMatchObject({ contents: expect.any(Array) })
        expect(f.inspections).toEqual(['saved-runtime'])
        await expect(f.client.readResource({ uri: 'nai-blue://runtime' })).resolves.toMatchObject({
            contents: [{ text: expect.stringContaining('APP_RUNTIME_RESTART_REQUIRED') }] })
        await expect(f.client.readResource({ uri: 'nai-blue://capabilities' })).resolves.toMatchObject({
            contents: [{ text: expect.stringContaining('runtime-unavailable') }] })
    })
    it('carries generated Queue references unchanged through enqueue results, run input and saved source results', async () => {
        const hash = '8b8311c4580cd5c1b7e3d8aff77154ff0a637b7a99322271938524f89661a594'
        const runId = `scene-batch-agent-${hash}`
        const jobIds = [0, 1].map(ordinal => `scene-job-agent-${hash}-${ordinal}`)
        const artifactIds = jobIds.map(id => `artifact:${id}`)
        const f = await fixture({ invoke: async (command, requestId) => observed(requestId, command.name,
            command.name === 'generation.enqueue' ? { status: 'ready', runId, batchId: runId, jobIds }
                : command.name === 'generation.get_run' ? { found: true, runId,
                    jobs: jobIds.map((jobId, index) => ({ jobId, artifactId: artifactIds[index], attemptId: `${jobId}:1` })) }
                    : { results: [{ found: true, artifactIds }] }) })
        const cases: { name: AgentCommandName; input: JsonObject; expected: JsonObject }[] = [
            { name: 'generation.enqueue', input: { planId: `sha256:${'a'.repeat(64)}`, planHash: `sha256:${'a'.repeat(64)}` },
                expected: { status: 'ready', runId, batchId: runId, jobIds } },
            { name: 'generation.get_run', input: { runId, jobId: jobIds[0] }, expected: { found: true, runId } },
            { name: 'scene.resolve_many', input: { targets: [{ presetId: 'preset-1', sceneId: 'scene-1' }] },
                expected: { results: [{ found: true, artifactIds }] } },
        ]
        for (const [index, testCase] of cases.entries()) {
            const requestId = `reference-boundary-${index}`
            const result = await f.client.callTool({ name: testCase.name, arguments: { requestId, input: testCase.input } })
            expect(result.isError).toBe(false)
            expect(result.structuredContent).toMatchObject({ status: 'application-receipt', requestId,
                receipt: { state: 'completed', result: testCase.expected } })
            expect(f.invokes.at(-1)).toEqual({ requestId, command: { name: testCase.name, input: testCase.input } })
        }
    })

    it('still performs the inbox lookup for a shaped reference and rejects a long image header before submission', async () => {
        const f = await fixture()
        const runId = `scene-batch-agent-ff0a${'ab'.repeat(30)}`
        const missing = await f.client.callTool({ name: 'generation.get_run', arguments: {
            requestId: 'reference-not-authority', input: { runId },
        } })
        expect(missing.structuredContent).toMatchObject({ receipt: { state: 'completed', result: { found: false } } })
        expect(f.invokes).toEqual([{ requestId: 'reference-not-authority', command: { name: 'generation.get_run', input: { runId } } }])
        const blocked = await f.client.callTool({ name: 'generation.get_run', arguments: {
            requestId: 'reference-still-scans-images', input: { runId: `scene-batch-agent-89504e470d0a1a0a${'ab'.repeat(24)}` },
        } })
        expect(blocked.structuredContent).toMatchObject({ status: 'adapter-error', code: 'UNSAFE_PAYLOAD',
            accepted: false, submissionAttempted: false })
        expect(f.invokes).toHaveLength(1)
    })

    it('returns verified receipt hash metadata even when its hex resembles image bytes', async () => {
        const expected = observed('request-hash-collision', 'generation.get_run', { found: true, sequence: 2963 })
        const receipt = expected.receipt as JsonObject
        receipt.requestHash = receipt.resultDigest
        const f = await fixture({ invoke: async (command, requestId) => command.name === 'system.describe_capabilities'
            ? observed(requestId, command.name, { capabilities: descriptors() } as unknown as JsonObject) : expected })
        await f.client.listTools()
        const actual = await f.client.callTool({ name: 'generation.get_run',
            arguments: { requestId: 'request-hash-collision', input: { runId: 'run-1' } } })
        expect(actual.isError).toBe(false)
        expect(actual.structuredContent).toEqual(expected)
    })

    it('returns image content and a request-bound image resource without putting bytes in a receipt', async () => {
        const readImage = vi.fn(async () => ({ mimeType: 'image/png' as const, data: 'iVBORw0KGgo=' }))
        const f = await fixture({ readImage, invoke: async (command, requestId) => observed(requestId, command.name,
            command.name === 'system.describe_capabilities' ? { capabilities: descriptors() } as unknown as JsonObject
                : { found: true, artifactId: 'artifact:job', resource: { requestId } }) })
        await f.client.listTools()
        const result = await f.client.callTool({ name: 'artifact.get_image', arguments: { requestId: 'image-read-1', input: { artifactId: 'artifact:job' } } })
        expect(result.content).toContainEqual({ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' })
        expect(JSON.stringify(result.structuredContent)).not.toContain('iVBOR')
        expect((await f.client.listResourceTemplates()).resourceTemplates).toContainEqual(expect.objectContaining({ uriTemplate: 'nai-blue://images/{requestId}' }))
        expect((await f.client.readResource({ uri: 'nai-blue://images/image-read-1' })).contents).toEqual([
            { uri: 'nai-blue://images/image-read-1', mimeType: 'image/png', blob: 'iVBORw0KGgo=' },
        ])
        await expect(f.client.readResource({ uri: 'nai-blue://images/../../private' })).rejects.toThrow()
        expect(readImage).toHaveBeenCalledTimes(2)
    })
    it('rejects production total overflow before submitting to the authenticated inbox', async () => {
        const f = await fixture()
        const result = await f.client.callTool({ name: 'production.create', arguments: { requestId: 'production-invalid', input: {
            title: 'Overflow', source: { kind: 'scene', targets: [
                { presetId: 'preset-1', sceneId: 'scene-1', expectedRevision: 0, count: 2400 },
                { presetId: 'preset-1', sceneId: 'scene-2', expectedRevision: 0, count: 1 },
            ] }, seedPolicy: { kind: 'random' }, budget: { maxImages: 2400, maxAnlas: 10 },
        } } })
        expect(result.isError).toBe(true)
        expect(f.invokes).toEqual([])
    })

    it('delivers bounded handshake guidance and reads the versioned manual only on demand, even with the app off', async () => {
        const f = await fixture({ invoke: async () => { throw new Error('app off') },
            inspect: async () => { throw new Error('no saved receipt') } })
        expect(f.client.getInstructions()).toBe(AGENT_MCP_INSTRUCTIONS)
        expect(f.client.getInstructions()!.length).toBeLessThan(700)
        expect(f.client.getInstructions()).toContain(AGENT_WORKFLOW_GUIDE_URI)
        expect(f.client.getInstructions()).not.toContain(AGENT_WORKFLOW_GUIDE)
        const listed = await f.client.listResources()
        expect(listed.resources).toContainEqual(expect.objectContaining({ uri: AGENT_WORKFLOW_GUIDE_URI, mimeType: 'text/markdown' }))
        expect(JSON.stringify(listed)).not.toContain(AGENT_WORKFLOW_GUIDE)
        const guide = await f.client.readResource({ uri: AGENT_WORKFLOW_GUIDE_URI })
        expect(guide.contents).toEqual([{ uri: AGENT_WORKFLOW_GUIDE_URI, mimeType: 'text/markdown', text: AGENT_WORKFLOW_GUIDE }])
        expect(AGENT_WORKFLOW_GUIDE).toContain('100 images total')
        expect(AGENT_WORKFLOW_GUIDE).toContain('monitor.complete')
        expect(AGENT_WORKFLOW_GUIDE).toContain('COMMAND_OUTCOME_UNKNOWN')
        expect(AGENT_MCP_INSTRUCTIONS).toContain('no window focus, visibility or topmost requirement')
        expect(AGENT_WORKFLOW_GUIDE).toContain('active saved consent needs no repeated approval')
        expect(AGENT_WORKFLOW_GUIDE).toContain('Do not add agent-imposed time, count, cost or concurrency quotas')
        expect(AGENT_WORKFLOW_GUIDE).not.toContain('Keep NAI Blue running in the foreground')
        expect(listed.resources.find(resource => resource.uri === 'nai-blue://capabilities')?.name).toBe('Current application capabilities')
        expect(f.invokes).toEqual([])
        expect(f.inspections).toEqual([])
        await expect(f.client.readResource({ uri: 'nai-blue://guides/agent-workflow/v999' })).rejects.toThrow('Agent resource is unavailable.')
    })

    it('returns shared production counts and storage-only recovery through generation.get_run', async () => {
        const fact = { source: 'fixture', referenceId: 'result-1', observedAt: '2026-09-09T00:00:00.000Z', kind: 'direct' as const }
        const status = projectGenerationRunStatus(deriveGenerationFulfillment({ batchId: 'run-1', queueState: 'active', jobs: [{
            jobId: 'job-1', queueState: 'failed', interpretation: { ...fact, state: 'succeeded' },
            provider: { ...fact, state: 'succeeded' }, storage: { ...fact, state: 'failed' },
            release: { policy: 'not-required' }, acceptance: { required: false },
            issues: [{ code: 'OUTPUT_RESERVATION_CONFLICT', jobId: 'job-1', severity: 'blocking',
                action: { kind: 'retry-storage', requiresHuman: false } }],
        }] }))
        const f = await fixture({ invoke: async (command, requestId) => observed(requestId, command.name,
            command.name === 'system.describe_capabilities' ? { capabilities: descriptors() } as unknown as JsonObject : status) })
        await f.client.listTools()
        const result = await f.client.callTool({ name: 'generation.get_run', arguments: { requestId: 'monitor-1', input: { runId: 'run-1' } } })
        expect(result.isError).toBe(false)
        expect(result.structuredContent).toMatchObject({ receipt: { state: 'completed', result: {
            monitor: { complete: false, nextAction: 'review-recovery', counts: { generated: 1, stored: 0 },
                recoveryActions: [{ kind: 'retry-storage', requiresHuman: false, jobCount: 1 }] },
        } } })
        expect(f.invokes.map(item => item.command.name)).toEqual(['system.describe_capabilities', 'generation.get_run'])
    })

    it('handshakes and advertises stable schema-bound tools with fresh availability metadata', async () => {
        const f = await fixture()
        const listed = await f.client.listTools()
        const expected = descriptors().filter(item => getAgentCommandInputContract(item.command) !== undefined)
        expect(listed.tools.map(item => item.name)).toEqual(expected.map(item => item.command))
        for (const tool of listed.tools) {
            expect(tool.inputSchema.properties?.input).toEqual(getAgentCommandInputContract(tool.name as AgentCommandName)!.schema)
            expect(tool.description).toContain('window focus, visibility and topmost position are not required')
            expect(tool.description).not.toContain('Foreground app required')
        }
        for (const name of ['scene.patch_many', 'folder.apply_changes', 'generation.enqueue']) {
            expect(listed.tools.find(tool => tool.name === name)?.description).toContain('honors active per-client always-approve consent')
            expect(listed.tools.find(tool => tool.name === name)?.description).not.toContain('Human approval required in NAI Blue')
        }
        expect(listed.tools.find(tool => tool.name === 'scene.patch_many')?.inputSchema).toMatchObject({
            properties: { input: { properties: { changes: { items: { properties: {
                promptTextMode: { enum: ['standard', 'verbatim'] }, generation: { properties: { ucPreset: { maximum: 4 } } },
            } } } } } },
        })
        expect(listed.tools.map(item => item.name)).not.toContain('scene.retry_link')
        expect(f.invokes).toHaveLength(1)
        expect(f.invokes[0].command).toEqual({ name: 'system.describe_capabilities', input: {} })
        const resource = await f.client.readResource({ uri: 'nai-blue://capabilities' })
        const snapshot = JSON.parse(String(resource.contents[0].text))
        expect(snapshot.status).toBe('fresh-application-capabilities')
        expect(snapshot.capabilities).toEqual(descriptors())
        expect(f.invokes).toHaveLength(2)
        expect(f.invokes[1].requestId).not.toBe(f.invokes[0].requestId)
    })

    it('uses fresh results on each list and marks schema drift unavailable in the capability resource', async () => {
        let current = descriptors()
        const f = await fixture({ invoke: async (command, requestId) => observed(requestId, command.name, { capabilities: current } as unknown as JsonObject) })
        expect((await f.client.listTools()).tools.length).toBeGreaterThan(0)
        current = current.map(item => item.command === 'generation.plan' ? { ...item, inputSchemaHash: `sha256:${'b'.repeat(64)}` } : item)
        expect((await f.client.listTools()).tools.map(item => item.name)).toContain('generation.plan')
        expect((await f.client.listTools()).tools.find(item => item.name === 'generation.plan')?.description)
            .toContain('schema-version-mismatch')
        const resource = await f.client.readResource({ uri: 'nai-blue://capabilities' })
        const snapshot = JSON.parse(String(resource.contents[0].text))
        expect(snapshot.capabilities.find((item: { command: string }) => item.command === 'generation.plan')).toMatchObject({ available: false, reason: 'schema-version-mismatch' })
        current = descriptors(false)
        expect((await f.client.listTools()).tools.map(item => item.name))
            .toEqual(descriptors().filter(item => getAgentCommandInputContract(item.command) !== undefined).map(item => item.command))
    })

    it('keeps stable bindings and reports an unconfirmed app state when a fresh probe has no application receipt', async () => {
        const f = await fixture({ invoke: async (_command, requestId) => ({ status: 'submitted-to-inbox', requestId, requiresAppProcess: true, accepted: false }) })
        const listed = await f.client.listTools()
        expect(listed.tools.map(item => item.name))
            .toEqual(descriptors().filter(item => getAgentCommandInputContract(item.command) !== undefined).map(item => item.command))
        expect(listed.tools[0]?.description).toContain('Availability unconfirmed (capability-probe-unconfirmed)')
        expect(listed.tools[0]?.description).not.toContain('app-unavailable')
        const resource = await f.client.readResource({ uri: 'nai-blue://capabilities' })
        const snapshot = JSON.parse(String(resource.contents[0].text))
        expect(snapshot.status).toBe('app-state-unconfirmed')
        expect(snapshot.capabilities.every((item: { available: boolean; reason: string }) => !item.available && item.reason === 'capability-probe-unconfirmed')).toBe(true)
        expect(snapshot).toMatchObject({ observationStatus: 'submitted-to-inbox', requestResource: `nai-blue://requests/${snapshot.requestId}` })
        expect(snapshot).not.toHaveProperty('accepted')
    })

    it('follows a delayed capability receipt through the same resource without resubmitting and then refreshes availability', async () => {
        let completed = false
        const f = await fixture({
            invoke: async (command, requestId) => completed
                ? observed(requestId, command.name, { capabilities: descriptors() } as unknown as JsonObject)
                : { status: 'submitted-to-inbox', requestId, requiresAppProcess: true, accepted: false },
            inspect: async requestId => observed(requestId, 'system.describe_capabilities', { capabilities: descriptors() } as unknown as JsonObject),
        })
        const initial = JSON.parse(String((await f.client.readResource({ uri: 'nai-blue://capabilities' })).contents[0].text))
        expect(initial).toMatchObject({ status: 'app-state-unconfirmed', observationStatus: 'submitted-to-inbox' })
        completed = true
        const saved = JSON.parse(String((await f.client.readResource({ uri: initial.requestResource })).contents[0].text))
        expect(saved).toMatchObject({ status: 'application-receipt', requestId: initial.requestId,
            receipt: { state: 'completed', result: { capabilities: descriptors() } } })
        expect(f.invokes).toHaveLength(1)
        expect(f.inspections).toEqual([initial.requestId])
        const fresh = JSON.parse(String((await f.client.readResource({ uri: 'nai-blue://capabilities' })).contents[0].text))
        expect(fresh.status).toBe('fresh-application-capabilities')
        expect(fresh.requestId).not.toBe(initial.requestId)
        expect(fresh.capabilities).toEqual(descriptors())
    })

    it.each(['submission-unconfirmed', 'observation-cancelled', 'inbox-rejection', 'probe-error'])('does not infer process exit from %s', async status => {
        const f = await fixture({ invoke: async (_command, requestId) => {
            if (status === 'probe-error') throw new Error('transport failed')
            return { status, requestId, requiresAppProcess: true,
                ...(status === 'observation-cancelled' ? {} : { accepted: false }),
                ...(status === 'inbox-rejection' ? { code: 'INVALID_ENVELOPE' } : {}) }
        } })
        const snapshot = JSON.parse(String((await f.client.readResource({ uri: 'nai-blue://capabilities' })).contents[0].text))
        expect(snapshot).toMatchObject({ status: 'app-state-unconfirmed', observationStatus: status,
            requestResource: `nai-blue://requests/${snapshot.requestId}` })
        expect(snapshot.capabilities.every((item: { available: boolean; reason: string }) => !item.available && item.reason === 'capability-probe-unconfirmed')).toBe(true)
    })

    it('preserves unfinished receipt state and actual application-reported unavailability separately', async () => {
        const f = await fixture({ invoke: async (command, requestId) => observed(requestId, command.name, null, 'accepted') })
        const pending = JSON.parse(String((await f.client.readResource({ uri: 'nai-blue://capabilities' })).contents[0].text))
        expect(pending).toMatchObject({ status: 'app-state-unconfirmed', observationStatus: 'application-receipt', receiptState: 'accepted' })
        const unavailable = await fixture({ invoke: async (command, requestId) => observed(requestId, command.name,
            { capabilities: descriptors(false) } as unknown as JsonObject) })
        const snapshot = JSON.parse(String((await unavailable.client.readResource({ uri: 'nai-blue://capabilities' })).contents[0].text))
        expect(snapshot.status).toBe('fresh-application-capabilities')
        expect(snapshot.capabilities.every((item: { available: boolean; reason: string }) => !item.available && item.reason === 'app-unavailable')).toBe(true)
        expect((await unavailable.client.listTools()).tools[0]?.description).toContain('Currently unavailable (app-unavailable)')
    })

    it('refuses malformed or duplicated registry facts without advertising partial availability', async () => {
        const values = [descriptors().slice(1), [...descriptors().slice(0, -1), descriptors()[0]],
            descriptors().map(item => item.command === 'generation.plan' ? { ...item, requiresHumanApproval: 'no' } : item),
            descriptors().map(item => item.command === 'generation.plan' ? { ...item, canExecuteWhileAppClosed: true } : item)]
        for (const capabilities of values) {
            const f = await fixture({ invoke: async (command, requestId) => observed(requestId, command.name, { capabilities } as unknown as JsonObject) })
            expect((await f.client.listTools()).tools.map(item => item.name))
                .toEqual(descriptors().filter(item => getAgentCommandInputContract(item.command) !== undefined).map(item => item.command))
        }
    })

    it('validates public input, implemented command, request ID and shared contract before invoking the port', async () => {
        const f = await fixture()
        for (const params of [
            { name: 'scene.retry_link', arguments: { requestId: 'request-1', input: {} } },
            { name: 'generation.get_run', arguments: { requestId: '../bad', input: { runId: 'run-1' } } },
            { name: 'generation.get_run', arguments: { requestId: 'CON', input: { runId: 'run-1' } } },
            { name: 'generation.get_run', arguments: { requestId: 'request-1', input: { runId: 'run-1', extra: true } } },
            { name: 'generation.get_run', arguments: { requestId: 'request-1', input: { runId: 'C:\\Users\\Private\\file.png' } } },
            { name: 'generation.get_run', arguments: { requestId: 'request-1', input: { secret: 'hidden' } } },
        ]) {
            const result = await f.client.callTool(params)
            expect(result.isError).toBe(true)
            expect(result.structuredContent).toMatchObject({ status: 'adapter-error', requiresAppProcess: true,
                accepted: false, submissionAttempted: false })
            expect(['INVALID_COMMAND_INPUT', 'UNSAFE_PAYLOAD']).toContain(result.structuredContent?.code)
        }
        expect(f.invokes).toEqual([])
    })

    it('distinguishes unsafe path rejection from an unknown submission without exposing input', async () => {
        const f = await fixture()
        const prose = ['C:/Private/prompt']
        for (const base of prose) {
            const input = { presetId: 'preset-1', expectedRevision: 0, changes: [{ sceneId: 'scene-1', prompts: { base } }] }
            expect(() => getAgentCommandInputContract('scene.patch_many')!.validate(input)).not.toThrow()
            const result = await f.client.callTool({ name: 'scene.patch_many', arguments: { requestId: 'request-1', input } })
            expect(result.structuredContent).toEqual({ status: 'adapter-error', code: 'UNSAFE_PAYLOAD',
                requiresAppProcess: true, accepted: false, submissionAttempted: false })
            expect(JSON.stringify(result)).not.toContain(base)
        }
        expect(f.invokes).toEqual([])
        await f.client.listTools() // Validate the new error fields against the advertised output schema.
        const result = await f.client.callTool({ name: 'scene.patch_many', arguments: { requestId: 'request-2',
            input: { presetId: 'preset-1', expectedRevision: 0, changes: [{ sceneId: 'scene-1',
                prompts: { base: 'broad white, key light, upper front, image left' } }] } } })
        expect(result.isError).toBe(false)
        expect(f.invokes.at(-1)?.requestId).toBe('request-2')
    })

    it('does not infer non-submission from an error code thrown after entering the inbox', async () => {
        const f = await fixture({ invoke: async () => { throw new AgentCommandError('UNSAFE_PAYLOAD') } })
        const result = await f.client.callTool({ name: 'generation.get_run',
            arguments: { requestId: 'request-1', input: { runId: 'run-1' } } })
        expect(f.invokes).toHaveLength(1)
        expect(result.structuredContent).toEqual({ status: 'adapter-error', code: 'AGENT_MCP_REQUEST_FAILED', requiresAppProcess: true })
    })

    it('passes gesture prose unchanged through pre-inbox safety validation', async () => {
        const f = await fixture()
        await f.client.listTools()
        const prose = [
            'left hand gesture: sideways v, sideways peace sign, back of hand facing viewer,',
            'fingertips at shoulder height',
            'consistent soft front upper-left white illumination',
        ]
        for (const [index, character] of prose.entries()) {
            const input = { presetId: 'preset-1', expectedRevision: 0, changes: [{ sceneId: 'scene-1', prompts: { character } }] }
            const requestId = `gesture-prose-${index}`
            const result = await f.client.callTool({ name: 'scene.patch_many', arguments: { requestId, input } })
            expect(result.isError).toBe(false)
            expect(f.invokes.at(-1)).toEqual({ requestId, command: { name: 'scene.patch_many', input } })
        }
    })

    it('passes structured filenames through authoring without changing their text or accepting encoded payload names', async () => {
        const f = await fixture()
        await f.client.listTools()
        const input = { presetId: 'preset-1', expectedRevision: 0, changes: [{ sceneId: 'scene-1',
            filenameTemplate: 'LPS_KV_20261016_cut4_V45_g' }] }
        const result = await f.client.callTool({ name: 'scene.patch_many', arguments: { requestId: 'filename-1', input } })
        expect(result.isError).toBe(false)
        expect(f.invokes.at(-1)?.command.input).toEqual(input)
        const count = f.invokes.length
        const bad = { ...input, changes: [{ ...input.changes[0], filenameTemplate: 'c2VjcmV0Y2FuYXJ5' }] }
        const rejected = await f.client.callTool({ name: 'scene.patch_many', arguments: { requestId: 'filename-2', input: bad } })
        expect(rejected.structuredContent).toMatchObject({ code: 'UNSAFE_PAYLOAD', accepted: false, submissionAttempted: false })
        expect(f.invokes).toHaveLength(count)
    })

    it('preserves request correlation when concurrent responses finish in reverse order', async () => {
        let releaseFirst: (() => void) | undefined
        const firstWaiting = new Promise<void>(resolve => { releaseFirst = resolve })
        const f = await fixture({ invoke: async (command, requestId) => {
            if (requestId === 'request-first') await firstWaiting
            else releaseFirst!()
            return observed(requestId, command.name, { runId: String(command.input.runId) })
        } })
        const results = await Promise.all(['first', 'second'].map(value => f.client.callTool({ name: 'generation.get_run',
            arguments: { requestId: `request-${value}`, input: { runId: `run-${value}` } } })))
        for (const [index, suffix] of ['first', 'second'].entries()) {
            expect(results[index].structuredContent).toMatchObject({ requestId: `request-${suffix}`, receipt: { result: { runId: `run-${suffix}` } } })
        }
    })

    it('preserves accepted, approval, unknown outcome and cancel facts without claiming Queue completion', async () => {
        const cases: { state: AgentCommandReceipt['state']; result: JsonObject | null; command: AgentCommandName; input: JsonObject }[] = [
            { state: 'accepted', result: null, command: 'generation.get_run', input: { runId: 'run-1' } },
            { state: 'needs-input', result: { code: 'AGENT_APPROVAL_REQUIRED', requestId: 'request-1', runId: 'run-1' }, command: 'generation.get_run', input: { runId: 'run-1' } },
            { state: 'needs-input', result: { code: 'AGENT_EXECUTION_UNKNOWN' }, command: 'generation.cancel', input: { runId: 'run-1' } },
            { state: 'completed', result: { status: 'cancel-requested', runId: 'run-1', batchId: 'run-1', jobIds: ['job-1'] }, command: 'generation.cancel', input: { runId: 'run-1' } },
        ]
        for (const item of cases) {
            const expected = observed('request-1', item.command, item.result, item.state)
            const f = await fixture({ invoke: async () => expected, inspect: async () => expected })
            const result = await f.client.callTool({ name: item.command, arguments: { requestId: 'request-1', input: item.input } })
            expect(result.structuredContent).toEqual(expected)
            expect(result.isError).toBe(false)
            const resource = await f.client.readResource({ uri: 'nai-blue://requests/request-1' })
            expect(JSON.parse(String(resource.contents[0].text))).toEqual(expected)
            expect(f.invokes).toHaveLength(1)
            expect(f.inspections).toEqual(['request-1'])
        }
    })

    it('marks an application-rejected generation plan as an MCP error instead of approval progress', async () => {
        const rejected = observed('plan-invalid', 'generation.plan', {
            status: 'invalid',
            issueCodes: ['draft-resolution-required'],
            issues: [{ code: 'draft-resolution-required', fieldPath: 'source.draft.payload.resolution' }],
            nextAction: 'repair-workflow-draft-in-guided-ui',
        }, 'rejected')
        const f = await fixture({ invoke: async (command, requestId) => command.name === 'system.describe_capabilities'
            ? observed(requestId, command.name, { capabilities: descriptors() } as unknown as JsonObject) : rejected })

        const result = await f.client.callTool({ name: 'generation.plan', arguments: { requestId: 'plan-invalid', input: {
            source: { kind: 'workflow-draft', draftId: 'guided-batch-1', expectedRevision: 9 },
            count: 80, seedPolicy: { kind: 'increment', firstSeed: 42 }, budget: { maxImages: 80, maxAnlas: 3_000 },
        } } })

        expect(result.isError).toBe(true)
        expect(result.structuredContent).toEqual(rejected)
    })

    it('preserves all pending submission observations and fixed authentication rejection semantics', async () => {
        for (const status of ['submitted-to-inbox', 'submission-unconfirmed', 'observation-cancelled', 'inbox-rejection']) {
            const expected = { status, requestId: 'request-1', requiresAppProcess: true,
                ...(status === 'observation-cancelled' ? {} : { accepted: false }),
                ...(status === 'inbox-rejection' ? { code: 'AUTHENTICATION_FAILED' } : {}) }
            const f = await fixture({ invoke: async () => expected })
            const result = await f.client.callTool({ name: 'generation.get_run', arguments: { requestId: 'request-1', input: { runId: 'run-1' } } })
            expect(result.structuredContent).toEqual(expected)
            expect(result.isError).toBe(status === 'inbox-rejection')
        }
    })

    it('transports the maximum public result with receipt overhead unchanged', async () => {
        const payload = { note: ' '.repeat(65_536 - canonicalSerialize({ note: '' }).length) }
        const expected = observed('request-1', 'generation.get_run', payload)
        const f = await fixture({ invoke: async (command, requestId) => command.name === 'system.describe_capabilities'
            ? observed(requestId, command.name, { capabilities: descriptors() } as unknown as JsonObject) : expected })
        await f.client.listTools() // Exercises official client output-schema validation too.
        const result = await f.client.callTool({ name: 'generation.get_run', arguments: { requestId: 'request-1', input: { runId: 'run-1' } } })
        expect(result.structuredContent).toEqual(expected)
        expect(canonicalSerialize(result.structuredContent).length).toBeGreaterThan(65_536)
    })

    it('propagates SDK caller cancellation only to observation and does not submit a Queue cancel', async () => {
        let entered!: () => void
        let observedAbort = false
        const waiting = new Promise<void>(resolve => { entered = resolve })
        const f = await fixture({ invoke: async (_command, requestId, signal) => new Promise(resolve => {
            signal!.addEventListener('abort', () => {
                observedAbort = true
                resolve({ status: 'observation-cancelled', requestId, requiresAppProcess: true })
            }, { once: true })
            entered()
        }) })
        const controller = new AbortController()
        const rejected = expect(f.client.callTool({ name: 'generation.get_run',
            arguments: { requestId: 'request-1', input: { runId: 'run-1' } } }, { signal: controller.signal })).rejects.toThrow()
        await waiting
        controller.abort()
        await rejected
        await vi.waitFor(() => expect(observedAbort).toBe(true))
        expect(f.invokes.map(item => item.command.name)).toEqual(['generation.get_run'])
    })

    it('redacts malicious or mismatched observations and resource errors', async () => {
        for (const unsafe of [
            { secret: 'hidden' }, { note: 'C:\\Users\\Private\\file.png' }, { note: 'iVBORw0KGgo=' },
            { note: 'Bearer secretvalue01234567890123456789' }, { note: 'https://example.test/file?X-Amz-Signature=hidden' },
        ]) {
            const bad = observed('request-1', 'generation.get_run')
            Object.assign(bad.receipt as JsonObject, { result: unsafe, resultDigest: `sha256:${hashCanonicalValue(unsafe)}` })
            const f = await fixture({ invoke: async () => bad, inspect: async () => bad })
            expect((await f.client.callTool({ name: 'generation.get_run', arguments: { requestId: 'request-1', input: { runId: 'run-1' } } })).structuredContent)
                .toEqual({ status: 'adapter-error', code: 'AGENT_MCP_REQUEST_FAILED', requiresAppProcess: true })
            await expect(f.client.readResource({ uri: 'nai-blue://requests/request-1' })).rejects.toThrow('Agent resource is unavailable.')
        }
        for (const bad of [observed('other-request', 'generation.get_run'), observed('request-1', 'generation.cancel'),
            { status: 'submitted-to-inbox', requestId: 'request-1', requiresAppProcess: true, accepted: true },
            { status: 'submitted-to-inbox', requestId: 'request-1', requiresAppProcess: true, accepted: false, extra: 'unexpected' },
            { status: 'observation-cancelled', requestId: 'request-1', requiresAppProcess: true, accepted: false },
            { status: 'observation-cancelled', requestId: 'request-1', requiresAppProcess: true, accepted: true },
            { status: 'inbox-rejection', requestId: 'request-1', requiresAppProcess: true, accepted: false, code: 'ARBITRARY_CODE' }]) {
            const f = await fixture({ invoke: async () => bad })
            expect((await f.client.callTool({ name: 'generation.get_run', arguments: { requestId: 'request-1', input: { runId: 'run-1' } } })).isError).toBe(true)
        }
    })
})
