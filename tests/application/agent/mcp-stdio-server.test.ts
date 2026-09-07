import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { createAgentMcpServer, type McpAgentInbox } from '@/adapters/agent/mcp/mcp-stdio-server'
import { AGENT_COMMAND_NAMES, type AgentCommand, type AgentCommandName } from '@/application/agent/agent-command-contract'
import { getAgentCommandInputContract } from '@/application/agent/agent-command-input'
import { AGENT_COMMAND_EFFECTS, describeAgentCommandCapabilities, type AgentCommandHandler } from '@/application/agent/runtime-capability-registry'
import { agentResultDigest, type AgentCommandReceipt } from '@/application/agent/command-receipt-repository'
import { canonicalSerialize, hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import type { JsonObject } from '@/domain/composition/types'

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

async function fixture(overrides: Partial<McpAgentInbox> = {}) {
    const invokes: { command: AgentCommand; requestId: string }[] = []
    const inspections: string[] = []
    const inbox: McpAgentInbox = {
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
    cleanups.push(async () => { await client.close(); await server.close() })
    return { client, invokes, inspections }
}

describe('Phase 10 official SDK server with simulated inbox', () => {
    it('handshakes and advertises exactly the fresh registered available schema-bound tools', async () => {
        const f = await fixture()
        const listed = await f.client.listTools()
        const expected = descriptors().filter(item => item.available)
        expect(listed.tools.map(item => item.name)).toEqual(expected.map(item => item.command))
        for (const tool of listed.tools) {
            expect(tool.inputSchema.properties?.input).toEqual(getAgentCommandInputContract(tool.name as AgentCommandName)!.schema)
        }
        expect(listed.tools.map(item => item.name)).not.toContain('r2.get_readiness')
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
        expect((await f.client.listTools()).tools.map(item => item.name)).not.toContain('generation.plan')
        const resource = await f.client.readResource({ uri: 'nai-blue://capabilities' })
        const snapshot = JSON.parse(String(resource.contents[0].text))
        expect(snapshot.capabilities.find((item: { command: string }) => item.command === 'generation.plan')).toMatchObject({ available: false, reason: 'schema-version-mismatch' })
        current = descriptors(false)
        expect((await f.client.listTools()).tools).toEqual([])
    })

    it('returns no tools and an unconfirmed app state when a fresh probe has no application receipt', async () => {
        const f = await fixture({ invoke: async (_command, requestId) => ({ status: 'submitted-to-inbox', requestId, requiresAppProcess: true, accepted: false }) })
        expect((await f.client.listTools()).tools).toEqual([])
        const resource = await f.client.readResource({ uri: 'nai-blue://capabilities' })
        const snapshot = JSON.parse(String(resource.contents[0].text))
        expect(snapshot.status).toBe('app-state-unconfirmed')
        expect(snapshot.capabilities.every((item: { available: boolean; reason: string }) => !item.available && item.reason === 'app-unavailable')).toBe(true)
        expect(snapshot).not.toHaveProperty('accepted')
    })

    it('refuses malformed or duplicated registry facts without advertising partial success', async () => {
        const values = [descriptors().slice(1), [...descriptors().slice(0, -1), descriptors()[0]],
            descriptors().map(item => item.command === 'generation.plan' ? { ...item, requiresHumanApproval: 'no' } : item),
            descriptors().map(item => item.command === 'generation.plan' ? { ...item, canExecuteWhileAppClosed: true } : item)]
        for (const capabilities of values) {
            const f = await fixture({ invoke: async (command, requestId) => observed(requestId, command.name, { capabilities } as unknown as JsonObject) })
            expect((await f.client.listTools()).tools).toEqual([])
        }
    })

    it('validates public input, implemented command, request ID and shared contract before invoking the port', async () => {
        const f = await fixture()
        for (const params of [
            { name: 'r2.get_readiness', arguments: { requestId: 'request-1', input: {} } },
            { name: 'generation.get_run', arguments: { requestId: '../bad', input: { runId: 'run-1' } } },
            { name: 'generation.get_run', arguments: { requestId: 'CON', input: { runId: 'run-1' } } },
            { name: 'generation.get_run', arguments: { requestId: 'request-1', input: { runId: 'run-1', extra: true } } },
            { name: 'generation.get_run', arguments: { requestId: 'request-1', input: { runId: 'C:\\Users\\Private\\file.png' } } },
            { name: 'generation.get_run', arguments: { requestId: 'request-1', input: { secret: 'hidden' } } },
        ]) {
            const result = await f.client.callTool(params)
            expect(result.isError).toBe(true)
            expect(result.structuredContent).toEqual({ status: 'adapter-error', code: 'AGENT_MCP_REQUEST_FAILED', requiresAppProcess: true })
        }
        expect(f.invokes).toEqual([])
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
