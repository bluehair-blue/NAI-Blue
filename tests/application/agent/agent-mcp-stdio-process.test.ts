import { webcrypto } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentCommandDispatcher } from '@/application/agent/agent-command-dispatcher'
import { getAgentCommandInputContract } from '@/application/agent/agent-command-input'
import type { AgentCommandName } from '@/application/agent/agent-command-contract'
import type { AgentCommandHandler } from '@/application/agent/runtime-capability-registry'
import { IndexedDbCommandReceiptRepository } from '@/adapters/agent/indexeddb-command-receipt-repository'
import { WebCryptoAgentAuthentication } from '@/adapters/agent/webcrypto-agent-authentication'
import { processAgentInboxFile } from '@/adapters/agent/inbox/process-agent-inbox-file'
import { resetIndexedDBConnectionForRetry } from '@/lib/indexed-db'
import { canonicalSerialize, hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import type { JsonObject } from '@/domain/composition/types'

// The parent is an authenticated app fixture with real IndexedDB CAS over
// fake-indexeddb. Killing its child proves sidecar restart only, not app crash,
// native credential success, native filesystem recovery, Queue or Provider work.
const bundledNode = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe')
const node = existsSync(bundledNode) ? bundledNode : process.execPath
const fixtureScript = path.resolve('tests/fixtures/agent-mcp-stdio-process.mjs')
const clients: Client[] = []
const cleanups: (() => Promise<void>)[] = []
const roots: string[] = []
const subtle = webcrypto.subtle as unknown as SubtleCrypto

beforeEach(() => { resetIndexedDBConnectionForRetry(); vi.stubGlobal('indexedDB', new IDBFactory()) })
afterEach(async () => {
    await Promise.all(clients.splice(0).map(client => client.close()))
    for (const cleanup of cleanups.splice(0)) await cleanup()
    resetIndexedDBConnectionForRetry()
    vi.unstubAllGlobals()
    for (const root of roots.splice(0)) {
        if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('nai-mcp-process-')) throw new Error('Unsafe test cleanup')
        await rm(root, { recursive: true, force: true })
    }
})

async function appFixture(heldRequestId?: string) {
    const root = await mkdtemp(path.join(tmpdir(), 'nai-mcp-process-'))
    roots.push(root)
    await Promise.all(['inbox', 'results', 'rejections'].map(name => mkdir(path.join(root, name))))
    const key = await subtle.importKey('raw', Uint8Array.from({ length: 32 }, (_, i) => i), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    const authentication = new WebCryptoAgentAuthentication(async (clientId, keyId) =>
        clientId === 'process-client' && keyId === 'process-key'
            ? { clientId, keyId, actorKind: 'agent', revokedAt: null, key } : null, subtle)
    const executions: { command: AgentCommandName; requestId: string }[] = []
    let releaseHeld = () => {}
    const held = new Promise<void>(resolve => { releaseHeld = resolve })
    const commands: AgentCommandName[] = ['workspace.get_snapshot', 'generation.get_run', 'generation.plan']
    const handlers: AgentCommandHandler[] = commands.map(command => ({ command,
        effect: command === 'generation.plan' ? 'plan' : 'read', validate: getAgentCommandInputContract(command)!.validate,
        execute: async (input, { envelope }): Promise<JsonObject> => {
            executions.push({ command, requestId: envelope.requestId })
            if (envelope.requestId === heldRequestId) await held
            if (command === 'generation.get_run') return { found: true, runId: input.runId, batchId: input.runId, stage: 'running' }
            if (command === 'generation.plan') return { status: 'ready', planId: `sha256:${'a'.repeat(64)}`,
                planHash: `sha256:${'b'.repeat(64)}`, estimatedAnlas: (input.budget as JsonObject).maxAnlas }
            return { workflowDrafts: [], totalDrafts: 0 }
        } }))
    const receipts = new IndexedDbCommandReceiptRepository()
    const dispatcher = new AgentCommandDispatcher({ workspaceId: 'process-workspace', authentication, receipts,
        handlers, runtime: () => ({ ready: true, mode: 'suggest', globalPause: false }) })
    let online = true, pumping = false, stopped = false
    const errors: unknown[] = []
    const publish = async (directory: string, id: string, value: unknown) => {
        const destination = path.join(root, directory, `${id}.json`)
        await writeFile(`${destination}.partial`, canonicalSerialize(value))
        await rename(`${destination}.partial`, destination)
    }
    const timer = setInterval(() => {
        if (stopped || !online || pumping) return
        pumping = true
        void (async () => {
            for (const file of (await readdir(path.join(root, 'inbox'))).filter(name => name.endsWith('.ready.json'))) {
                await processAgentInboxFile(file, {
                    readReady: async id => readFile(path.join(root, 'inbox', `${id}.ready.json`), 'utf8'),
                    publishResult: (id, result) => publish('results', id, result),
                    publishRejection: (id, result) => publish('rejections', id, result),
                }, dispatcher)
                await rm(path.join(root, 'inbox', file))
            }
        })().catch(error => { errors.push(error) }).finally(() => { pumping = false })
    }, 10)
    cleanups.push(async () => {
        releaseHeld()
        stopped = true
        clearInterval(timer)
        await vi.waitFor(() => expect(pumping).toBe(false), { timeout: 3000, interval: 10 })
        expect(errors).toEqual([])
    })
    return { root, dispatcher, receipts, executions, releaseHeld, setOnline: (value: boolean) => { online = value },
        archive: (id: string) => readFile(path.join(root, 'inbox', `${id}.submitted.json`), 'utf8'),
        hasReady: (id: string) => existsSync(path.join(root, 'inbox', `${id}.ready.json`)) }
}

async function connect(root: string, waitMs = 700, clientId?: string) {
    const transport = new StdioClientTransport({ command: node, args: [fixtureScript, root, String(waitMs), ...(clientId ? [clientId] : [])],
        cwd: path.resolve('.'), stderr: 'pipe', maxBufferSize: 262_144 })
    let stderr = ''
    transport.stderr?.on('data', chunk => { stderr += chunk })
    const errors: Error[] = []
    const client = new Client({ name: 'nai-process-integration', version: '1.0.0' },
        { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 5000 } } })
    client.onerror = error => { errors.push(error) }
    clients.push(client)
    await client.connect(transport, { timeout: 10_000 })
    expect(client.getServerVersion()).toMatchObject({ name: 'nai-blue-agent-spike' })
    expect(client.getNegotiatedProtocolVersion()).toBeDefined()
    return { client, transport, errors, stderr: () => stderr }
}

async function assertWire(root: string) {
    const files = (await readdir(root)).filter(name => /^wire-\d+\.jsonl$/.test(name))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
        const raw = await readFile(path.join(root, file), 'utf8')
        for (const line of raw.trim().split('\n').filter(Boolean)) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' })
        expect(raw).not.toContain(root)
        expect(raw).not.toContain('must-not-escape')
    }
}

describe('real SDK stdio child + authenticated application/inbox integration', () => {
    it('negotiates, advertises exact registry schemas and correlates concurrent reads and decimal plan handles', async () => {
        const app = await appFixture(), sidecar = await connect(app.root)
        const listed = await sidecar.client.listTools({}, { cache: 'refresh' })
        const available = app.dispatcher.capabilities().filter(item => item.available)
        expect(listed.tools.map(tool => tool.name).sort()).toEqual(available.map(item => item.command).sort())
        for (const tool of listed.tools) {
            const descriptor = available.find(item => item.command === tool.name)!
            const schema = (tool.inputSchema.properties as Record<string, JsonObject>).input
            expect(`sha256:${hashCanonicalValue(schema)}`).toBe(descriptor.inputSchemaHash)
        }
        const requests = [
            { name: 'workspace.get_snapshot', arguments: { requestId: 'wire-snapshot', input: {} } },
            { name: 'generation.get_run', arguments: { requestId: 'wire-run', input: { runId: 'retained-run' } } },
            { name: 'generation.plan', arguments: { requestId: 'wire-decimal-plan', input: {
                source: { kind: 'workflow-draft', draftId: 'fixture-draft', expectedRevision: 0 }, count: 1,
                seedPolicy: { kind: 'random' }, budget: { maxImages: 1, maxAnlas: 1.5 } } } },
        ]
        const results = await Promise.all(requests.map(request => sidecar.client.callTool(request)))
        for (const [index, result] of results.entries()) {
            expect(result.isError).toBe(false)
            expect(result.structuredContent).toMatchObject({ status: 'application-receipt', requestId: requests[index].arguments.requestId })
            expect(result.structuredContent?.receipt).toEqual(await app.receipts.get(requests[index].arguments.requestId))
        }
        expect((results[1].structuredContent?.receipt as JsonObject).result).toMatchObject({ runId: 'retained-run', batchId: 'retained-run', stage: 'running' })
        expect((results[2].structuredContent?.receipt as JsonObject).result).toMatchObject({ estimatedAnlas: 1.5 })
        expect(app.executions).toHaveLength(3)
        expect(sidecar.errors).toEqual([])
        expect(sidecar.stderr()).toBe('')
        await assertWire(app.root)
    }, 25_000)

    it('survives a sidecar process kill with exact archived timestamps and receipt, refuses changed payload and binds resources to client', async () => {
        const app = await appFixture('crash-replay'), first = await connect(app.root, 3000)
        const call = { name: 'generation.get_run', arguments: { requestId: 'crash-replay', input: { runId: 'retained-run' } } }
        const interrupted = first.client.callTool(call)
        const interruptedResult = expect(interrupted).rejects.toThrow()
        await vi.waitFor(() => expect(app.executions.filter(item => item.requestId === 'crash-replay')).toHaveLength(1), { timeout: 3000, interval: 10 })
        const archived = await app.archive('crash-replay')
        expect(await app.receipts.get('crash-replay')).toMatchObject({ state: 'accepted' })
        expect(first.transport.pid).not.toBeNull()
        process.kill(first.transport.pid!, 'SIGKILL')
        await interruptedResult
        await first.client.close()
        // The app authority survives the sidecar crash and completes its claimed
        // operation once. A restarted transport must reuse that durable outcome.
        app.releaseHeld()
        await vi.waitFor(async () => expect(await app.receipts.get('crash-replay')).toMatchObject({ state: 'completed' }), { timeout: 3000, interval: 10 })
        const receipt = await app.receipts.get('crash-replay')
        const restarted = await connect(app.root)
        const replay = await restarted.client.callTool(call)
        expect(replay.structuredContent).toEqual({ status: 'application-receipt', requestId: 'crash-replay', requiresAppProcess: true, receipt })
        expect(await app.archive('crash-replay')).toBe(archived)
        expect(await app.receipts.get('crash-replay')).toEqual(receipt)
        expect(app.executions.filter(item => item.requestId === 'crash-replay')).toHaveLength(1)
        const changed = await restarted.client.callTool({ ...call, arguments: { ...call.arguments, input: { runId: 'different-run' } } })
        expect(changed).toMatchObject({ isError: true, structuredContent: { status: 'adapter-error', code: 'AGENT_MCP_REQUEST_FAILED' } })
        expect(await app.archive('crash-replay')).toBe(archived)
        const resource = await restarted.client.readResource({ uri: 'nai-blue://requests/crash-replay' })
        expect(JSON.parse(String(resource.contents[0].text)).receipt).toEqual(receipt)
        const other = await connect(app.root, 100, 'different-client')
        await expect(other.client.readResource({ uri: 'nai-blue://requests/crash-replay' })).rejects.toThrow('Agent resource is unavailable.')
        expect(other.stderr()).toBe('')
        await assertWire(app.root)
    }, 35_000)

    it('reports app-off submission without tools and cancels only observation while preserving the submitted command', async () => {
        const app = await appFixture(), sidecar = await connect(app.root, 1000)
        await sidecar.client.listTools({}, { cache: 'refresh' })
        app.setOnline(false)
        expect((await sidecar.client.listTools({}, { cache: 'refresh' })).tools).toEqual([])
        const off = await sidecar.client.callTool({ name: 'workspace.get_snapshot', arguments: { requestId: 'app-off-submit', input: {} } })
        expect(off.structuredContent).toEqual({ status: 'submitted-to-inbox', accepted: false, requestId: 'app-off-submit', requiresAppProcess: true })
        expect(await app.receipts.get('app-off-submit')).toBeNull()
        const controller = new AbortController()
        const pending = sidecar.client.callTool({ name: 'generation.get_run', arguments: { requestId: 'cancel-wait', input: { runId: 'retained-run' } } }, { signal: controller.signal })
        const rejected = expect(pending).rejects.toThrow()
        await vi.waitFor(() => expect(app.hasReady('cancel-wait')).toBe(true), { timeout: 3000, interval: 10 })
        const archive = await app.archive('cancel-wait')
        controller.abort()
        await rejected
        expect(await app.archive('cancel-wait')).toBe(archive)
        expect(await app.receipts.get('cancel-wait')).toBeNull()
        app.setOnline(true)
        await vi.waitFor(async () => expect(await app.receipts.get('cancel-wait')).toMatchObject({ state: 'completed' }), { timeout: 3000, interval: 20 })
        expect(app.executions.filter(item => item.requestId === 'cancel-wait')).toHaveLength(1)
        expect(app.executions.some(item => item.command === 'generation.cancel')).toBe(false)
        expect(sidecar.stderr()).toBe('')
        await assertWire(app.root)
    }, 25_000)

    it.skipIf(process.platform !== 'win32')('boots the exact production stdio CLI with an unregistered key, no tools or submission files, and clean close', async () => {
        const app = await appFixture()
        app.setOnline(false)
        const id = `missing-${crypto.randomUUID()}`
        const connection = { workspaceId: id, clientId: id, keyId: id, actorKind: 'agent' as const }
        const connectionPath = path.join(app.root, 'public-connection.json')
        await writeFile(connectionPath, JSON.stringify(connection))
        const bundledPython = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe')
        // No fixture loader or injected signer: this executes production main(),
        // including TS loading, Python subprocess, SDK stdio setup and shutdown.
        const transport = new StdioClientTransport({ command: node, args: [path.resolve('scripts/run-agent-mcp-stdio.mjs'),
            '--connection', connectionPath, '--inbox-dir', path.join(app.root, 'inbox'),
            '--python', existsSync(bundledPython) ? bundledPython : 'python', '--wait-ms', '0'],
            cwd: path.resolve('.'), stderr: 'pipe', maxBufferSize: 262_144 })
        let stderr = ''
        transport.stderr?.on('data', chunk => { stderr += chunk })
        const errors: Error[] = []
        const client = new Client({ name: 'nai-production-entry-check', version: '1.0.0' },
            { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 5000 } } })
        client.onerror = error => { errors.push(error) }
        clients.push(client)
        await client.connect(transport, { timeout: 10_000 })
        expect(client.getServerVersion()).toMatchObject({ name: 'nai-blue-agent-spike' })
        expect(client.getNegotiatedProtocolVersion()).toBeDefined()
        expect((await client.listTools({}, { cache: 'refresh' })).tools).toEqual([])
        for (const directory of ['inbox', 'results', 'rejections']) expect(await readdir(path.join(app.root, directory))).toEqual([])
        expect(stderr).toBe('')
        expect(errors).toEqual([])
        const pid = transport.pid
        expect(pid).not.toBeNull()
        await client.close()
        expect(transport.pid).toBeNull()
        expect(() => process.kill(pid!, 0)).toThrow()
        expect(stderr).toBe('')
    }, 20_000)
})
