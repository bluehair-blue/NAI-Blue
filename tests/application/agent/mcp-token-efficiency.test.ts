import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { createAgentMcpServer, type McpAgentInbox, type McpUsageEntry } from '@/adapters/agent/mcp/mcp-stdio-server'
import { AGENT_MCP_INSTRUCTIONS } from '@/adapters/agent/mcp/agent-workflow-guide'
import { summarizeRun } from '@/adapters/agent/mcp/mcp-result-summary'
import { type AgentCommand, type AgentCommandName } from '@/application/agent/agent-command-contract'
import { agentResultDigest, type AgentCommandReceipt } from '@/application/agent/command-receipt-repository'
import type { JsonObject } from '@/domain/composition/types'

// Pins what an agent actually receives by default: no guide gate, compact results, bundled round trips.
// The receipt-level contract behind detail:"full" is pinned by mcp-stdio-server.test.ts.
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(cleanups.splice(0).map(close => close())) })

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
    const invokes: { command: AgentCommand; requestId: string; waitMs?: number }[] = []
    const usage: McpUsageEntry[] = []
    const defaults: Partial<Record<AgentCommandName, Reply>> = {
        'generation.plan': (command, id) => observed(id, command.name, planResult),
        'generation.enqueue': (command, id) => observed(id, command.name, { status: 'ready', runId, batchId: runId, jobIds }),
        'generation.get_run': (command, id) => observed(id, command.name, runResult(true)),
    }
    const server = createAgentMcpServer({
        invoke: async (command, requestId, _signal, waitMs) => {
            invokes.push({ command, requestId, waitMs })
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
    return { client, call, invokes, usage, names: () => invokes.map(item => item.command.name), ids: () => invokes.map(item => item.requestId),
        waits: () => invokes.map(item => item.waitMs) }
}

/** A manual clock: a reply that "takes" seconds moves it, so the waits handed to the inbox can be pinned exactly. */
function slowClock() {
    let now = 1_800_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const slow = (seconds: number, reply: Reply): Reply => (command, id) => { now += seconds * 1000; return reply(command, id) }
    return { slow, advance: (seconds: number) => { now += seconds * 1000 } }
}
const unanswered: Reply = (_command, id) => ({ status: 'submitted-to-inbox', requestId: id, requiresAppProcess: true, accepted: false })

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
        expect(unanswered.body).toMatchObject({ stage: 'enqueue', status: 'submitted-to-inbox', requestId: 'stop-pending-enq', accepted: false, planId, planHash })
        expect(unanswered.body.hint).toContain('generation.run again with the same requestId and input')
        expect(unanswered.body.hint).toContain('nai-blue://requests/stop-pending-enq')

        const refused = await fixture({ 'generation.plan': (_command, id) => ({ status: 'inbox-rejection', requestId: id, requiresAppProcess: true, accepted: false, code: 'AUTHENTICATION_FAILED' }) })
        const refusal = await refused.call('generation.run', { requestId: 'stop-refused', input: planInput })
        expect(refusal).toMatchObject({ isError: true, body: { stage: 'plan', status: 'inbox-rejection', code: 'AUTHENTICATION_FAILED' } })
        expect(refusal.body.hint).toContain('returns the same refusal')
        expect(refusal.body.hint).toContain('new requestId')
    })

    it('names the request or the run when a stage fails after the plan, so nothing has to be regenerated', async () => {
        const enqueueFails = await fixture({ 'generation.enqueue': () => { throw new Error('signing bridge failed') } })
        const enqueue = await enqueueFails.call('generation.run', { requestId: 'fail-enqueue', input: planInput })
        expect(enqueue).toMatchObject({ isError: true, body: { stage: 'enqueue', status: 'adapter-error', code: 'AGENT_MCP_REQUEST_FAILED', requestId: 'fail-enqueue-enq', planId } })
        expect(enqueue.body.hint).toContain('nai-blue://requests/fail-enqueue-enq')

        const waitFails = await fixture({ 'generation.get_run': () => { throw new Error('transport failed') } })
        const run = await waitFails.call('generation.run', { requestId: 'fail-wait', input: planInput })
        expect(run).toMatchObject({ isError: true, body: { stage: 'run', status: 'adapter-error', code: 'AGENT_MCP_REQUEST_FAILED', runId } })
        expect(run.body.hint).toContain('never start a new generation')
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

    it('never reports an enqueued run as unsubmitted and tells an unsubmitted enqueue apart from a failed one', async () => {
        let checks = 0
        const closedAfterEnqueue = await fixture({}, { runtimeStatus: async () => ++checks <= 2 ? { status: 'ready' } : { status: 'unavailable', code: 'APP_NOT_RUNNING' } })
        const run = await closedAfterEnqueue.call('generation.run', { requestId: 'closed-after', input: planInput })
        expect(closedAfterEnqueue.names()).toEqual(['generation.plan', 'generation.enqueue'])
        expect(run.body).toMatchObject({ stage: 'run', runId, status: 'adapter-error', code: 'APP_NOT_RUNNING', hint: expect.stringContaining('never start a new generation') })
        expect(run.body).not.toHaveProperty('submissionAttempted')
        expect(run.body).not.toHaveProperty('accepted')

        checks = 0
        const blockedBeforeEnqueue = await fixture({}, { runtimeStatus: async () => { if (++checks > 1) throw new Error('locator failed'); return { status: 'ready' } } })
        const enqueue = await blockedBeforeEnqueue.call('generation.run', { requestId: 'not-enqueued', input: planInput })
        expect(blockedBeforeEnqueue.names()).toEqual(['generation.plan'])
        expect(enqueue).toMatchObject({ isError: true, body: { stage: 'enqueue', code: 'ENQUEUE_NOT_SUBMITTED', planId, planHash,
            hint: expect.stringContaining('generation.run again with the same requestId and input') } })
        expect(enqueue.body).not.toHaveProperty('requestId')

        let polls = 0
        const unanswered = await fixture({ 'generation.get_run': (command, id) => ++polls === 1 ? observed(id, command.name, runResult(false))
            : { status: 'submitted-to-inbox', requestId: id, requiresAppProcess: true, accepted: false } })
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        const pending = unanswered.call('generation.get_run', { input: { runId }, waitSeconds: 20 })
        await vi.advanceTimersByTimeAsync(2000)
        expect((await pending).body).toMatchObject({ state: 'completed', result: { complete: false, nextAction: 'wait' } })
    })

    it('rejects malformed adapter options before anything is submitted', async () => {
        const f = await fixture()
        for (const [name, args] of [['workspace.get_snapshot', { input: null }], ['workspace.get_snapshot', { include: null }],
            ['workspace.get_snapshot', { include: [['drafts']] }], ['scene.resolve_many', { include: [] }],
            ['generation.get_run', { input: { runId }, planOnly: true }], ['toString', {}], ['generation.plan', { input: planInput, detail: 'verbose' }]] as const) {
            expect((await f.call(name, args as unknown as JsonObject)).body, name).toMatchObject({ status: 'adapter-error', code: 'INVALID_COMMAND_INPUT', submissionAttempted: false })
        }
        expect(f.invokes).toEqual([])
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

    it('names the committed file from the run row when no plan is in hand, and prefers it over the planned name', () => {
        const run = { found: true, runId: 'run-1', state: 'delivered', monitor: { complete: true, counts: { total: 2 } }, jobs: [
            { jobId: 'job-0', storageState: 'succeeded', artifactId: 'artifact:job-0', fileName: 'saved_0.png' },
            { jobId: 'job-1', storageState: 'succeeded', artifactId: 'artifact:job-1' }] }
        expect(summarizeRun(run).artifacts).toEqual([{ artifactId: 'artifact:job-0', fileName: 'saved_0.png' }, { artifactId: 'artifact:job-1' }])
        const planned = new Map([['0', { sceneId: 'scene-a', fileName: 'planned_0.png' }], ['1', { sceneId: 'scene-b', fileName: 'planned_1.png' }]])
        expect(summarizeRun(run, planned).artifacts).toEqual([{ artifactId: 'artifact:job-0', sceneId: 'scene-a', fileName: 'saved_0.png' },
            { artifactId: 'artifact:job-1', sceneId: 'scene-b', fileName: 'planned_1.png' }])
    })
})

describe('one deadline per tool call', () => {
    it('hands the plan and enqueue stages of generation.run the rest of the budget, not the base wait', async () => {
        const { slow } = slowClock()
        const f = await fixture({ 'generation.plan': slow(12.3456, (command, id) => observed(id, command.name, planResult)),
            'generation.enqueue': slow(30, unanswered) }, { waitMs: 3000 })
        const result = await f.call('generation.run', { requestId: 'budget', input: planInput })
        expect(f.waits()).toEqual([40_000, 27_654])
        expect(result).toMatchObject({ isError: false, body: { stage: 'enqueue', status: 'submitted-to-inbox', requestId: 'budget-enq', planId, planHash } })
        await f.call('generation.run', { requestId: 'budget-max', input: planInput, waitSeconds: 50 })
        // Only the upper limit gives way to the 5-second response reserve.
        expect(f.waits()[2]).toBe(45_000)
    })

    it('still gives every stage the base wait with waitSeconds 0', async () => {
        const { slow } = slowClock()
        const f = await fixture({ 'generation.plan': slow(12, (command, id) => observed(id, command.name, planResult)) }, { waitMs: 3000 })
        const result = await f.call('generation.run', { requestId: 'no-wait', input: planInput, waitSeconds: 0 })
        expect(f.names()).toEqual(['generation.plan', 'generation.enqueue', 'generation.get_run'])
        expect(f.waits()).toEqual([3000, 3000, 3000])
        expect(result.body).toMatchObject({ stage: 'run', complete: true })
    })

    it('passes a zero wait once the hard limit is spent and returns the unfinished stage instead of failing', async () => {
        const { slow } = slowClock()
        const f = await fixture({ 'generation.plan': slow(50, (command, id) => observed(id, command.name, planResult)),
            'generation.enqueue': unanswered }, { waitMs: 3000 })
        const result = await f.call('generation.run', { requestId: 'spent', input: planInput })
        expect(f.waits()).toEqual([40_000, 0])
        expect(f.waits().every(wait => Number.isSafeInteger(wait) && wait! >= 0)).toBe(true)
        expect(result).toMatchObject({ isError: false, body: { stage: 'enqueue', status: 'submitted-to-inbox', requestId: 'spent-enq' } })
        expect(result.body.hint).toContain('generation.run again with the same requestId and input')
    })

    it('gives other tools 20 seconds for the whole call, shared by every image of artifact.get_images', async () => {
        const { slow } = slowClock()
        const f = await fixture({ 'artifact.get_image': slow(8, (command, id) => observed(id, command.name, { found: false })) }, { waitMs: 3000 })
        await f.call('artifact.get_images', { requestId: 'shared', input: { artifactIds: ['artifact:a', 'artifact:b', 'artifact:c', 'artifact:d'] } })
        // The fourth read falls back to the base wait because the hard limit is still far away.
        expect(f.waits()).toEqual([20_000, 12_000, 4000, 3000])
        await f.call('scene.patch_many', { requestId: 'patch', input: { presetId: 'preset-1', expectedRevision: 0, changes: [{ sceneId: 'scene-a' }] } })
        await f.call('generation.get_run', { input: { runId } })
        await f.call('generation.get_run', { input: { runId }, waitSeconds: 0 })
        expect(f.waits().slice(4)).toEqual([20_000, 20_000, 3000])
    })

    it('gives each poll of a waiting read only the time left', async () => {
        const { advance } = slowClock()
        let polls = 0
        const f = await fixture({ 'generation.get_run': (command, id) => { advance(4); return observed(id, command.name, runResult(++polls >= 3)) } }, { waitMs: 3000 })
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        const pending = f.call('generation.get_run', { input: { runId }, waitSeconds: 12, requestId: 'poll-budget' })
        await vi.advanceTimersByTimeAsync(2000)
        await vi.advanceTimersByTimeAsync(3000)
        expect((await pending).body).toMatchObject({ result: { complete: true } })
        expect(f.waits()).toEqual([12_000, 8000, 4000])
    })

    it('keeps the base wait for resource reads and the capability probe', async () => {
        const inspected: (number | undefined)[] = []
        const f = await fixture({}, { waitMs: 3000, inspect: async (requestId, _signal, waitMs) => {
            inspected.push(waitMs)
            return observed(requestId, 'generation.get_run', { found: false })
        } })
        await f.client.readResource({ uri: 'nai-blue://requests/saved-read' })
        await f.client.readResource({ uri: 'nai-blue://capabilities' })
        expect(inspected).toEqual([undefined])
        expect(f.names()).toEqual(['system.describe_capabilities'])
        expect(f.waits()).toEqual([undefined])
    })
})
