import { afterEach, describe, expect, it } from 'vitest'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { createAgentMcpServer } from '@/adapters/agent/mcp/mcp-stdio-server'
import { AGENT_WORKFLOW_GUIDE_URI } from '@/adapters/agent/mcp/agent-workflow-guide'
import { AGENT_COMMAND_NAMES, type AgentCommandName } from '@/application/agent/agent-command-contract'
import { getAgentCommandInputContract } from '@/application/agent/agent-command-input'
import { AGENT_COMMAND_EFFECTS, describeAgentCommandCapabilities } from '@/application/agent/runtime-capability-registry'
import { agentResultDigest } from '@/application/agent/command-receipt-repository'
import type { JsonObject } from '@/domain/composition/types'

const close: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(close.splice(0).map(fn => fn())) })

async function fixture() {
    const calls: string[] = []
    const descriptors = describeAgentCommandCapabilities(AGENT_COMMAND_NAMES.flatMap(command => {
        const contract = getAgentCommandInputContract(command)
        return contract ? [{ command, effect: AGENT_COMMAND_EFFECTS[command], executionGate: 'durable-approval' as const,
            validate: contract.validate, execute: async () => ({}) }] : []
    }), { ready: true, mode: 'suggest', globalPause: false })
    const observed = (id: string, command: AgentCommandName, result: JsonObject) => ({
        status: 'application-receipt', requestId: id, requiresAppProcess: true, receipt: {
            schemaVersion: 1, requestId: id, command, requestHash: `sha256:${'a'.repeat(64)}`,
            authenticatedClientId: 'guide-client', state: 'completed', observedAt: '2026-10-19T00:00:00.000Z',
            resultSchemaVersion: 1, result, resultDigest: agentResultDigest(result),
        },
    })
    const server = createAgentMcpServer({
        invoke: async (command, id) => { calls.push(command.name); return observed(id, command.name,
            command.name === 'system.describe_capabilities' ? { capabilities: descriptors } as unknown as JsonObject : { found: false }) },
        inspect: async id => observed(id, 'generation.get_run', { found: false }),
    })
    const client = new Client({ name: 'manual-guide-gate', version: '1.0.0' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st); await client.connect(ct)
    close.push(async () => { await client.close(); await server.close() })
    return { client, calls }
}

const tool = (requestId: string) => ({ name: 'workspace.get_snapshot', arguments: { requestId, input: {} } })
const required = { code: 'GUIDE_READ_REQUIRED', accepted: false, submissionAttempted: false,
    guideResource: AGENT_WORKFLOW_GUIDE_URI, nextAction: 'read-guide-resource-and-retry' }

describe('actual SDK one-use manual read gate', () => {
    it('gates every public command before argument validation or inbox submission', async () => {
        const f = await fixture()
        for (const name of AGENT_COMMAND_NAMES) {
            const result = await f.client.callTool({ name, arguments: { requestId: 'unread-command', input: {} } })
            expect(result.structuredContent).toMatchObject(required)
        }
        expect(f.calls).toEqual([])
    })
    it('blocks unread calls, preserves credit through discovery, then consumes it exactly once', async () => {
        const f = await fixture()
        expect((await f.client.callTool(tool('unread'))).structuredContent).toMatchObject(required)
        expect(f.calls).toEqual([])
        await f.client.readResource({ uri: AGENT_WORKFLOW_GUIDE_URI })
        await f.client.listTools()
        await f.client.readResource({ uri: 'nai-blue://capabilities' })
        expect((await f.client.callTool(tool('allowed'))).isError).toBe(false)
        const calls = [...f.calls]
        expect((await f.client.callTool(tool('consumed'))).structuredContent).toMatchObject(required)
        expect(f.calls).toEqual(calls)
    })

    it('does not accept history, client claims, accumulated reads or another connection', async () => {
        const a = await fixture(), b = await fixture()
        await a.client.readResource({ uri: 'nai-blue://requests/history' })
        expect((await a.client.callTool({ ...tool('claim'), arguments: { ...tool('claim').arguments, readGuide: true } }))
            .structuredContent).toMatchObject(required)
        await a.client.readResource({ uri: AGENT_WORKFLOW_GUIDE_URI })
        await a.client.readResource({ uri: AGENT_WORKFLOW_GUIDE_URI })
        expect((await b.client.callTool(tool('other-client'))).structuredContent).toMatchObject(required)
        const results = await Promise.all([a.client.callTool(tool('concurrent-a')), a.client.callTool(tool('concurrent-b'))])
        expect(results.filter(r => r.structuredContent?.code === 'GUIDE_READ_REQUIRED')).toHaveLength(1)
        expect(a.calls).toEqual(['workspace.get_snapshot'])
        expect(b.calls).toEqual([])
    })

    it('consumes the read even when validation rejects the next command', async () => {
        const f = await fixture()
        await f.client.readResource({ uri: AGENT_WORKFLOW_GUIDE_URI })
        expect((await f.client.callTool({ name: 'workspace.get_snapshot', arguments: {} })).structuredContent)
            .toMatchObject({ code: 'INVALID_COMMAND_INPUT', submissionAttempted: false })
        expect((await f.client.callTool(tool('after-invalid'))).structuredContent).toMatchObject(required)
        expect(f.calls).toEqual([])
    })
})
