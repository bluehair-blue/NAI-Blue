import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { createAgentMcpServer, type McpAgentInbox, type McpUsageEntry } from '@/adapters/agent/mcp/mcp-stdio-server'
import { AGENT_MCP_INSTRUCTIONS } from '@/adapters/agent/mcp/agent-workflow-guide'
import { type AgentCommand, type AgentCommandName } from '@/application/agent/agent-command-contract'
import { agentResultDigest, type AgentCommandReceipt } from '@/application/agent/command-receipt-repository'
import type { JsonObject } from '@/domain/composition/types'

// Pins what an agent actually receives by default: no guide gate, compact results, bundled round trips.
// The receipt-level contract behind detail:"full" is pinned by mcp-stdio-server.test.ts.
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.useRealTimers(); await Promise.all(cleanups.splice(0).map(close => close())) })

const hash = '8b8311c4580cd5c1b7e3d8aff77154ff0a637b7a99322271938524f89661a594'
const runId = `scene-batch-agent-${hash}`
const jobIds = [0, 1].map(ordinal => `scene-job-agent-${hash}-${ordinal}`)
const planId = `sha256:${'a'.repeat(64)}`, planHash = `sha256:${'b'.repeat(64)}`
const longPrompt = 'masterpiece, detailed background, '.repeat(40)
const planInput = { source: { kind: 'scene', targets: [{ presetId: 'preset-1', sceneId: 'scene-a', expectedRevision: 1, count: 1 },
    { presetId: 'preset-1', sceneId: 'scene-b', expectedRevision: 1, count: 1 }] }, seedPolicy: { kind: 'random' }, budget: { maxImages: 2, maxAnlas: 0 } }

const planResult: JsonObject = { status: 'ready', planId, planHash, jobCount: 2, estimatedAnlas: 0, requiredApprovals: [], review: {
    compatibilityStatuses: ['synthetic-only'], omittedJobs: 0, sourceCount: 2,
    jobs: ['scene-a', 'scene-b'].map((sceneId, ordinal) => ({ ordinal, sceneId, presetId: 'preset-1', seed: 100 + ordinal,
        prompt: longPrompt, negativePrompt: longPrompt, destination: { fileName: `${sceneId}.png` } })),
    sources: ['scene-a', 'scene-b'].map(sceneId => ({ presetId: 'preset-1', sceneId, name: sceneId, count: 1, expectedRevision: 1 })) } }
function runResult(complete: boolean): JsonObject {
    return { found: true, runId, state: complete ? 'delivered' : 'running', queueState: 'active', jobCount: 2, truncated: false,
        jobs: jobIds.map(jobId => ({ jobId, artifactId: `artifact:${jobId}`, queueState: complete ? 'succeeded' : 'waiting',
            providerState: complete ? 'succeeded' : 'pending', storageState: complete ? 'succeeded' : 'pending',
            providerExecution: { attemptCount: 1, attempts: [{ attemptNumber: 1, outcome: 'succeeded', transitions: [{ note: longPrompt }] }] } })),
        monitor: { complete, attention: null, nextAction: complete ? 'review-results' : 'wait', recoveryActions: [],
            stateHash: `sha256:${'c'.repeat(64)}`,
            counts: { total: 2, generated: complete ? 2 : 0, stored: complete ? 2 : 0, fulfilled: complete ? 2 : 0, failed: 0, cancelled: 0 } } }
}

function observed(requestId: string, command: AgentCommandName, result: JsonObject | null, state: AgentCommandReceipt['state'] = 'completed'): JsonObject {
    return { status: 'application-receipt', requestId, requiresAppProcess: true, receipt: {
        schemaVersion: 1, requestId, command, requestHash: `sha256:${'d'.repeat(64)}`,
        authenticatedClientId: 'client-e363a1741656e987c2ca6535a258533e', state,
        observedAt: '2026-11-22T00:00:01.000Z', resultSchemaVersion: 1,
        result, resultDigest: result === null ? null : agentResultDigest(result),
    } }
}

type Reply = (command: AgentCommand, requestId: string) => JsonObject | Promise<JsonObject>
async function fixture(replies: Partial<Record<AgentCommandName, Reply>> = {}, overrides: Partial<McpAgentInbox> = {}) {
    const invokes: { command: AgentCommand; requestId: string }[] = []
    const usage: McpUsageEntry[] = []
    const defaults: Partial<Record<AgentCommandName, Reply>> = {
        'generation.plan': (command, id) => observed(id, command.name, planResult),
        'generation.enqueue': (command, id) => observed(id, command.name, { status: 'ready', runId, batchId: runId, jobIds }),
        'generation.get_run': (command, id) => observed(id, command.name, runResult(true)),
    }
    const server = createAgentMcpServer({
        invoke: async (command, requestId) => {
            invokes.push({ command, requestId })
            const reply = replies[command.name] ?? defaults[command.name]
            return reply ? reply(command, requestId) : observed(requestId, command.name, { found: false })
        },
        inspect: async requestId => observed(requestId, 'generation.get_run', { found: false }),
        recordUsage: entry => { usage.push(entry) },
        ...overrides,
    })
    const client = new Client({ name: 'mcp-token-efficiency', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    cleanups.push(async () => { await client.close(); await server.close() })
    const call = async (name: string, args: JsonObject) => {
        const result = await client.callTool({ name, arguments: args })
        const content = result.content as { type: string; text?: string }[]
        return { isError: result.isError === true, text: String(content[0].text), body: JSON.parse(String(content[0].text)) as Record<string, any>,
            images: content.filter(item => item.type === 'image').length, structured: result.structuredContent }
    }
    return { client, call, invokes, usage, names: () => invokes.map(item => item.command.name), ids: () => invokes.map(item => item.requestId) }
}

describe('MCP adapter default view for agents', () => {
    it('runs tools with no prior guide read, generates a request ID and omits receipt overhead', async () => {
        const f = await fixture({ 'workspace.get_snapshot': (command, id) => observed(id, command.name, {
            editingApproval: { active: true }, generationApproval: { active: true, allowsSyntheticOnly: true },
            queueActivity: { processing: 0, waiting: 0, needsAttention: 0 }, folderRevision: 1, offset: 0, nextOffset: 1, truncated: true,
            totalPresets: 320, totalScenes: 3240, totalFolders: 3, totalDrafts: 4,
            scenePresets: [{ presetId: 'preset-1', name: 'Preset', revision: 6 }], scenes: [{ sceneId: 'scene-a', name: longPrompt }],
            folders: [{ folderId: 'folder-1' }], workflowDrafts: [{ draftId: 'draft-1', ready: false, generation: { steps: 28 }, review: { promptDigest: planId } }] }) })
        const plain = await f.call('workspace.get_snapshot', {})
        expect(plain.isError).toBe(false)
        expect(plain.structured).toBeUndefined()
        expect(plain.body).toEqual({ state: 'completed', requestId: expect.stringMatching(/^mcp-[0-9a-f-]{36}$/), result: {
            editingApproval: { active: true }, generationApproval: { active: true, allowsSyntheticOnly: true },
            queueActivity: { processing: 0, waiting: 0, needsAttention: 0 }, folderRevision: 1,
            totals: { presets: 320, scenes: 3240, folders: 3, drafts: 4 } } })
        expect(f.invokes[0].command.input).toEqual({ limit: 1 })
        const listed = await f.call('workspace.get_snapshot', { input: { offset: 0, limit: 50 }, include: ['presets', 'drafts'] })
        expect(f.invokes[1].command.input).toEqual({ offset: 0, limit: 50 })
        expect(listed.body.result).toMatchObject({ presets: [{ presetId: 'preset-1', name: 'Preset', revision: 6 }],
            drafts: [{ draftId: 'draft-1', ready: false }], nextOffset: 1, truncated: true })
        expect(listed.body.result).not.toHaveProperty('scenes')
        expect(listed.text).not.toContain('promptDigest')
        const full = await f.call('workspace.get_snapshot', { detail: 'full', requestId: 'snapshot-full' })
        expect(full.body).toMatchObject({ status: 'application-receipt', requestId: 'snapshot-full', receipt: { result: { totalScenes: 3240 } } })
        expect(f.invokes[2].command.input).toEqual({})
    })

    it('plans, enqueues and waits in one generation.run call and returns artifacts without prompt text', async () => {
        const f = await fixture()
        const result = await f.call('generation.run', { requestId: 'nhr-cut1', input: planInput })
        expect(f.names()).toEqual(['generation.plan', 'generation.enqueue', 'generation.get_run'])
        expect(f.ids().slice(0, 2)).toEqual(['nhr-cut1-plan', 'nhr-cut1-enq'])
        expect(f.invokes[1].command.input).toEqual({ planId, planHash })
        expect(result.isError).toBe(false)
        expect(result.body).toEqual({ stage: 'run', runId, state: 'delivered', complete: true, counts: { total: 2, generated: 2, stored: 2, fulfilled: 2 },
            nextAction: 'review-results', planId, estimatedAnlas: 0, compatibilityStatuses: ['synthetic-only'],
            artifacts: [{ artifactId: `artifact:${jobIds[0]}`, sceneId: 'scene-a', seed: 100, fileName: 'scene-a.png' },
                { artifactId: `artifact:${jobIds[1]}`, sceneId: 'scene-b', seed: 101, fileName: 'scene-b.png' }] })
        expect(result.text).not.toContain('masterpiece')
        expect(result.text.length).toBeLessThan(760)
        const full = await f.call('generation.run', { requestId: 'nhr-cut1', input: planInput, detail: 'full' })
        expect(full.body).toMatchObject({ stage: 'run', plan: { receipt: { result: { planId } } }, enqueue: { receipt: { result: { runId } } },
            run: { receipt: { result: { monitor: { complete: true } } } } })
    })

    it('requires a caller-chosen request ID for generation requests and previews with planOnly', async () => {
        const f = await fixture()
        for (const [name, input] of [['generation.run', planInput], ['generation.enqueue', { planId, planHash }]] as const) {
            const missing = await f.call(name, { input })
            expect(missing).toMatchObject({ isError: true, body: { status: 'adapter-error', code: 'INVALID_COMMAND_INPUT', submissionAttempted: false } })
            expect(missing.body.hint).toContain('requestId')
        }
        expect((await f.call('generation.run', { requestId: 'x'.repeat(91), input: planInput })).body.code).toBe('INVALID_COMMAND_INPUT')
        expect(f.invokes).toEqual([])
        const preview = await f.call('generation.run', { input: planInput, planOnly: true })
        expect(f.names()).toEqual(['generation.plan'])
        expect(preview.body).toMatchObject({ stage: 'plan', state: 'completed', result: { status: 'ready', planId, planHash, jobCount: 2, estimatedAnlas: 0,
            sources: [{ presetId: 'preset-1', sceneId: 'scene-a', count: 1 }, { presetId: 'preset-1', sceneId: 'scene-b', count: 1 }] } })
        expect(preview.text).not.toContain('masterpiece')
    })

    it('stops at the first unfinished stage and keeps the application verdict', async () => {
        const rejected = await fixture({ 'generation.plan': (command, id) => observed(id, command.name,
            { status: 'invalid', issues: [{ code: 'output-destination-occupied', fieldPath: 'targets.0' }], nextAction: 'revise-scene-filename-template' }, 'rejected') })
        const plan = await rejected.call('generation.run', { requestId: 'stop-plan', input: planInput })
        expect(plan).toMatchObject({ isError: true, body: { stage: 'plan', state: 'rejected', requestId: 'stop-plan-plan',
            result: { issues: [{ code: 'output-destination-occupied', fieldPath: 'targets.0' }], nextAction: 'revise-scene-filename-template' } } })
        expect(rejected.names()).toEqual(['generation.plan'])

        const approval = await fixture({ 'generation.enqueue': (command, id) => observed(id, command.name, { code: 'AGENT_APPROVAL_REQUIRED', requestId: id }, 'needs-input') })
        const enqueue = await approval.call('generation.run', { requestId: 'stop-enqueue', input: planInput })
        expect(enqueue).toMatchObject({ isError: false, body: { stage: 'enqueue', state: 'needs-input', requestId: 'stop-enqueue-enq', planId, planHash } })
        expect(enqueue.body.hint).toContain('nai-blue://requests/stop-enqueue-enq')
        expect(approval.names()).toEqual(['generation.plan', 'generation.enqueue'])

        const pending = await fixture({ 'generation.enqueue': (_command, id) => ({ status: 'submitted-to-inbox', requestId: id, requiresAppProcess: true, accepted: false }) })
        const unanswered = await pending.call('generation.run', { requestId: 'stop-pending', input: planInput })
        expect(unanswered.body).toMatchObject({ stage: 'enqueue', status: 'submitted-to-inbox', requestId: 'stop-pending-enq', accepted: false })
        expect(unanswered.body.hint).toContain('do not resubmit')
    })

    it('names the request or the run when a stage fails after the plan, so nothing has to be regenerated', async () => {
        const enqueueFails = await fixture({ 'generation.enqueue': () => { throw new Error('signing bridge failed') } })
        const enqueue = await enqueueFails.call('generation.run', { requestId: 'fail-enqueue', input: planInput })
        expect(enqueue).toMatchObject({ isError: true, body: { stage: 'enqueue', status: 'adapter-error', code: 'AGENT_MCP_REQUEST_FAILED', requestId: 'fail-enqueue-enq', planId } })
        expect(enqueue.body.hint).toContain('nai-blue://requests/fail-enqueue-enq')

        const waitFails = await fixture({ 'generation.get_run': () => { throw new Error('transport failed') } })
        const run = await waitFails.call('generation.run', { requestId: 'fail-wait', input: planInput })
        expect(run).toMatchObject({ isError: true, body: { stage: 'run', status: 'adapter-error', code: 'AGENT_MCP_REQUEST_FAILED', runId } })
        expect(run.body.hint).toContain('do not run again')
    })

    it('waits for completion across polls with fresh request IDs inside one call', async () => {
        let polls = 0
        const f = await fixture({ 'generation.get_run': (command, id) => observed(id, command.name, runResult(++polls >= 3)) })
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        const pending = f.call('generation.get_run', { input: { runId }, waitSeconds: 30, requestId: 'poll-first' })
        await vi.advanceTimersByTimeAsync(2000)
        await vi.advanceTimersByTimeAsync(3000)
        const result = await pending
        expect(f.names()).toEqual(['generation.get_run', 'generation.get_run', 'generation.get_run'])
        expect(new Set(f.ids()).size).toBe(3)
        expect(f.ids()[0]).toBe('poll-first')
        expect(result.body).toMatchObject({ state: 'completed', result: { complete: true, artifacts: [{ artifactId: `artifact:${jobIds[0]}` }, { artifactId: `artifact:${jobIds[1]}` }] } })
        vi.useRealTimers()
        const unfinished = await f.call('generation.get_run', { input: { runId } })
        expect(unfinished.body.result).not.toHaveProperty('unfinished')
        polls = 0
        const waiting = await f.call('generation.get_run', { input: { runId } })
        expect(waiting.body.result).toMatchObject({ complete: false, nextAction: 'wait', artifacts: [],
            unfinished: [{ jobId: jobIds[0], queueState: 'waiting', providerState: 'pending', storageState: 'pending' }, { jobId: jobIds[1] }] })
        expect(waiting.text).not.toContain('transitions')
        expect((await f.call('generation.get_run', { input: { runId }, waitSeconds: 51 })).body.code).toBe('INVALID_COMMAND_INPUT')
    })

    it('reads several saved images in one call and validates every ID before the first read', async () => {
        const readImage = vi.fn(async () => ({ mimeType: 'image/png' as const, data: 'iVBORw0KGgo=' }))
        const f = await fixture({ 'artifact.get_image': (command, id) => observed(id, command.name, command.input.artifactId === 'artifact:missing'
            ? { found: false } : { found: true, artifactId: command.input.artifactId, contentChecksum: planHash,
                resource: { requestId: id, width: 480, height: 480, mimeType: 'image/png', byteLength: 12, contentChecksum: planId } }) }, { readImage })
        const result = await f.call('artifact.get_images', { requestId: 'view', input: { artifactIds: ['artifact:job-0', 'artifact:missing', 'artifact:job-2'] } })
        expect(f.ids()).toEqual(['view-0', 'view-1', 'view-2'])
        expect(result.images).toBe(2)
        expect(result.body.images).toEqual([{ artifactId: 'artifact:job-0', contentChecksum: planHash, width: 480, height: 480 },
            { artifactId: 'artifact:missing', state: 'completed', requestId: 'view-1', result: { found: false } },
            { artifactId: 'artifact:job-2', contentChecksum: planHash, width: 480, height: 480 }])
        expect(result.text).not.toContain('iVBOR')
        const count = f.invokes.length
        for (const artifactIds of [[], ['a', 'b', 'c', 'd', 'e'], ['artifact:ok', 'C:\\Users\\Private\\file.png']]) {
            expect((await f.call('artifact.get_images', { input: { artifactIds } })).body).toMatchObject({ status: 'adapter-error', submissionAttempted: false })
        }
        expect(f.invokes).toHaveLength(count)
    })

    it('routes rare commands through advanced.call and refuses anything outside that list before submission', async () => {
        const f = await fixture({ 'production.list': (command, id) => observed(id, command.name, { requests: [] }) })
        const listed = await f.call('advanced.call', { command: 'production.list', input: {} })
        expect(listed.body).toMatchObject({ state: 'completed', result: { requests: [] } })
        expect(f.invokes[0].command).toEqual({ name: 'production.list', input: {} })
        for (const command of ['generation.enqueue', 'scene.retry_link', 'toString']) {
            expect((await f.call('advanced.call', { command, input: {} })).body).toMatchObject({ code: 'INVALID_COMMAND_INPUT', submissionAttempted: false })
        }
        expect((await f.call('workspace.get_snapshot', { command: 'production.list' })).body.code).toBe('INVALID_COMMAND_INPUT')
        expect(f.invokes).toHaveLength(1)
    })

    it('attaches a corrective hint to failures instead of requiring a guide', async () => {
        const f = await fixture({ 'scene.resolve_many': (_command, id) => ({ status: 'submission-unconfirmed', requestId: id, requiresAppProcess: true, accepted: false }),
            'scene.patch_many': () => { throw new Error('after submission') } })
        const invalid = await f.call('scene.resolve_many', { input: { targets: [] }, readGuide: true })
        expect(invalid.body).toEqual({ status: 'adapter-error', code: 'INVALID_COMMAND_INPUT', accepted: false, submissionAttempted: false,
            hint: expect.stringContaining('Nothing was submitted') })
        const unconfirmed = await f.call('scene.resolve_many', { requestId: 'resolve-1', input: { targets: [{ presetId: 'preset-1', sceneId: 'scene-a' }] } })
        expect(unconfirmed.body).toMatchObject({ status: 'submission-unconfirmed', requestId: 'resolve-1', hint: expect.stringContaining('nai-blue://requests/resolve-1') })
        const failed = await f.call('scene.patch_many', { requestId: 'patch-1', input: { presetId: 'preset-1', expectedRevision: 0, changes: [{ sceneId: 'scene-a' }] } })
        expect(failed.body).toMatchObject({ status: 'adapter-error', code: 'AGENT_MCP_REQUEST_FAILED', requestId: 'patch-1' })
        expect(failed.body).not.toHaveProperty('submissionAttempted')
        expect(failed.body.hint).toContain('does not prove non-submission')
        const closed = await fixture({}, { runtimeStatus: async () => ({ status: 'unavailable', code: 'APP_NOT_RUNNING' }) })
        expect((await closed.call('generation.get_run', { input: { runId } })).body).toMatchObject({ code: 'APP_NOT_RUNNING', submissionAttempted: false,
            hint: expect.stringContaining('closed') })
        expect(closed.invokes).toEqual([])
    })

    it('keeps the fixed per-session cost small and reports sizes for measurement without content', async () => {
        const f = await fixture()
        const listed = await f.client.listTools()
        expect(AGENT_MCP_INSTRUCTIONS.length + JSON.stringify(listed.tools).length).toBeLessThan(9000)
        await f.call('generation.run', { requestId: 'usage', input: planInput })
        await f.client.readResource({ uri: 'nai-blue://guides/recovery' })
        expect(f.usage.map(entry => [entry.kind, entry.name])).toEqual([['instructions', 'initialize'], ['tools-list', 'tools/list'],
            ['tool', 'generation.run'], ['resource', 'nai-blue://guides/recovery']])
        expect(f.usage.every(entry => Number.isSafeInteger(entry.chars) && Object.keys(entry).sort().join() === 'chars,images,kind,name')).toBe(true)
        expect(f.usage[2].chars).toBeLessThan(760)
    })
})
