import { spawn } from 'node:child_process'
import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { inspectAgentCommand, inspectPath, readText, readBytes } from './inspect-agent-command.mjs'
import { createHash } from 'node:crypto'
import { adapterFingerprint, createRuntimeGuard, resolveInstalledRuntime } from './agent-runtime-guard.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url))
const maxBytes = 65_536
const maxConcurrentCalls = 8
// A tool call's whole deadline (at most 50 s minus the response reserve) may go to one request's wait.
const maxCallWaitMs = 50_000
const previewFormats = Object.freeze({ __proto__: null,
    'image/png': { extension: 'png', signature: '89504e470d0a1a0a' }, 'image/jpeg': { extension: 'jpg', signature: 'ffd8ff' } })

function requireInput(condition) {
    if (!condition) throw new Error('Agent MCP input is invalid.')
}

/** Private key access remains inside the existing Windows Python bridge. Stdout is only a submission receipt. */
export function submitAgentMcpCommand(python, inboxDir, requestId, payload) {
    return new Promise((resolve, reject) => {
        const child = spawn(python, ['-B', '-X', 'utf8', path.join(repo, 'scripts/submit-agent-mcp-command.py'),
            '--inbox-dir', inboxDir, '--request-id', requestId], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
        let stdout = '', stderr = '', failed = false
        const fail = () => { failed = true; child.kill(); reject(new Error('Agent signing bridge failed.')) }
        const timer = setTimeout(fail, 10_000)
        child.on('error', fail)
        child.stdin.on('error', fail)
        child.stdout.on('data', chunk => { stdout += chunk; if (Buffer.byteLength(stdout) > 4096) fail() })
        child.stderr.on('data', chunk => { stderr += chunk; if (Buffer.byteLength(stderr) > 4096) fail() })
        child.on('close', code => {
            clearTimeout(timer)
            if (failed) return
            try {
                requireInput(code === 0 && stderr === '')
                const result = JSON.parse(stdout)
                requireInput(Object.keys(result).sort().join() === 'accepted,requestId,requiresAppProcess,status'
                    && result.status === 'submitted-to-inbox' && result.accepted === false
                    && result.requestId === requestId && result.requiresAppProcess === true)
                resolve(result)
            } catch { reject(new Error('Agent signing bridge failed.')) }
        })
        child.stdin.end(JSON.stringify(payload))
    })
}

/** One concrete inbox bridge: files own request identity; an in-flight map only serializes same-ID publication. */
export async function createAgentMcpInbox(options, modules, submit = submitAgentMcpCommand) {
    const { connection, python, waitMs = 3000 } = options
    requireInput(Number.isSafeInteger(waitMs) && waitMs >= 0 && waitMs <= 30_000)
    requireInput(connection && Object.keys(connection).sort().join() === 'actorKind,clientId,keyId,workspaceId')
    const inboxDir = await inspectPath(options.inboxDir, true)
    requireInput(path.basename(inboxDir) === 'inbox')
    await Promise.all(['results', 'rejections'].map(name => inspectPath(path.join(inboxDir, '..', name), true)))
    const { parseAgentCommandEnvelope, assertAgentRequestId, assertAgentPublicValue,
        agentRequestHash, canonicalAgentSigningPayload, AgentCommandError } = modules.contract
    const { canonicalSerialize } = modules.canonical
    const { getAgentCommandInputContract } = modules.inputs
    const { projectAgentInboxResult } = modules.projection
    const pending = new Map()
    let active = 0

    function build(command, requestId) {
        const now = Date.now()
        const envelope = { schemaVersion: 1, requestId, requestHash: `sha256:${'0'.repeat(64)}`,
            submittedAt: new Date(now).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(),
            context: { apiVersion: 'nai-blue.agent/v1alpha1', workspaceId: connection.workspaceId,
                clientId: connection.clientId, actor: { kind: connection.actorKind }, idempotencyKey: requestId },
            command, authentication: { scheme: 'hmac-sha256', keyId: connection.keyId, signature: `hmac-sha256:${'0'.repeat(64)}` } }
        const expectedRuntimeHash = options.getRuntimeHash?.()
        if (expectedRuntimeHash) envelope.context.expectedRuntimeHash = expectedRuntimeHash
        return parseAgentCommandEnvelope({ ...envelope, requestHash: agentRequestHash(envelope) })
    }
    build({ name: 'system.describe_capabilities', input: {} }, 'mcp-connection-check')

    function bind(envelope, requestId) {
        requireInput(envelope.requestId === requestId && envelope.context.workspaceId === connection.workspaceId
            && envelope.context.clientId === connection.clientId && envelope.authentication.keyId === connection.keyId
            && envelope.context.actor.kind === connection.actorKind)
        return envelope
    }
    async function archived(requestId) {
        const raw = await readText(path.join(inboxDir, `${requestId}.submitted.json`), maxBytes, true)
            ?? await readText(path.join(inboxDir, `${requestId}.ready.json`), maxBytes, true)
        return raw === null ? null : bind(parseAgentCommandEnvelope(JSON.parse(raw)), requestId)
    }
    function callWait(value) {
        if (value === undefined) return waitMs
        requireInput(Number.isSafeInteger(value) && value >= 0 && value <= maxCallWaitMs)
        return value
    }
    async function inspect(requestId, signal, wait) {
        assertAgentRequestId(requestId)
        const observeMs = callWait(wait)
        requireInput(await archived(requestId) !== null)
        // Re-check the configured identity on every poll, not only before entering the wait.
        return inspectAgentCommand({ inboxDir, requestId, waitMs: observeMs, signal }, (envelope, result, rejection) =>
            projectAgentInboxResult(bind(parseAgentCommandEnvelope(envelope), requestId), result, rejection))
    }
    /** Publishes only a request that left no trace; returns a final observation, or null when the caller should observe. */
    async function prepare(command, requestId) {
        const envelope = await archived(requestId)
        if (envelope) {
            if (canonicalSerialize(envelope.command) !== canonicalSerialize(command)) throw new AgentCommandError('REQUEST_ID_INPUT_MISMATCH')
            // Re-publishing after a result or rejection would let the app execute a request it already answered.
            const seen = await inspect(requestId, undefined, 0)
            if (seen.status === 'submitted-to-inbox') return null
            if (seen.status !== 'submission-unconfirmed') return seen
        }
        // No ready file: the earlier publication, if any, stopped between archive and ready.
        const signed = envelope ?? build(command, requestId)
        const { requestHash: _requestHash, authentication: _authentication, ...unsigned } = signed
        await submit(python, inboxDir, requestId, { connection,
            unsignedPayload: canonicalSerialize(unsigned), signingPayload: canonicalAgentSigningPayload(signed) })
        return null
    }

    return {
        waitMs,
        inspect,
        async readImage(requestId, signal) {
            assertAgentRequestId(requestId)
            const observed = await inspect(requestId, signal)
            const receipt = observed.receipt
            requireInput(observed.status === 'application-receipt' && receipt?.state === 'completed'
                && receipt.command === 'artifact.get_image' && receipt.result?.found === true)
            const image = receipt.result.resource
            // Builds before larger previews write PNG; later ones JPEG. The receipt names which file to read.
            const format = previewFormats[image?.mimeType]
            requireInput(image && format && image.requestId === requestId
                && Number.isSafeInteger(image.byteLength) && image.byteLength > 0 && image.byteLength <= 1_048_576
                && /^sha256:[a-f0-9]{64}$/.test(image.contentChecksum))
            const bytes = await readBytes(path.join(inboxDir, '..', 'images', `${requestId}.${format.extension}`), 1_048_576)
            requireInput(bytes.length === image.byteLength && bytes.subarray(0, format.signature.length / 2).toString('hex') === format.signature
                && `sha256:${createHash('sha256').update(bytes).digest('hex')}` === image.contentChecksum)
            return { data: bytes.toString('base64'), mimeType: image.mimeType }
        },
        async invoke(command, requestId, signal, wait) {
            assertAgentRequestId(requestId)
            const observeMs = callWait(wait)
            const startedAt = performance.now()
            const contract = getAgentCommandInputContract(command.name)
            requireInput(contract && Object.keys(command).sort().join() === 'input,name')
            assertAgentPublicValue(command.input)
            const validated = contract.validate(command.input)
            requireInput(canonicalSerialize(validated) === canonicalSerialize(command.input))
            requireInput(!signal?.aborted && active < maxConcurrentCalls)
            active += 1
            try {
                const fingerprint = canonicalSerialize(command)
                let entry = pending.get(requestId)
                if (entry) { if (entry.fingerprint !== fingerprint) throw new AgentCommandError('REQUEST_ID_INPUT_MISMATCH') }
                else {
                    entry = { fingerprint, promise: prepare(structuredClone(command), requestId) }
                    pending.set(requestId, entry)
                }
                // Once signing begins, cancellation never retries/rolls back an uncertain publication.
                let settled
                try { settled = await entry.promise }
                finally { if (pending.get(requestId) === entry) pending.delete(requestId) }
                // A caller's wait is its deadline for the whole request, so signing and publication count against it.
                return settled ?? await inspect(requestId, signal, wait === undefined ? observeMs
                    : Math.max(0, Math.floor(observeMs - (performance.now() - startedAt))))
            } finally { active -= 1 }
        },
    }
}

/** Sizes of what each response put into the host's context, one JSON line per response and never any content. */
export function createUsageLog(directory) {
    let ready
    return entry => {
        const now = new Date().toISOString()
        ready ??= mkdir(directory, { recursive: true })
        // Measurement is best effort; a full disk or read-only checkout must not fail a tool call.
        void ready.then(() => appendFile(path.join(directory, `${now.slice(0, 10)}.jsonl`),
            `${JSON.stringify({ at: now, pid: process.pid, ...entry })}\n`)).catch(() => {})
    }
}

async function main() {
    let loader, handle
    try {
        const { values } = parseArgs({ options: {
            connection: { type: 'string' }, 'inbox-dir': { type: 'string' }, python: { type: 'string' },
            'wait-ms': { type: 'string', default: '3000' }, 'no-usage-log': { type: 'boolean' }, help: { type: 'boolean' },
        } })
        if (values.help) {
            console.log('NAI Blue development MCP stdio spike.\n'
                + 'node scripts/run-agent-mcp-stdio.mjs --connection <public connection JSON> --inbox-dir <existing inbox> --python <Python executable> [--wait-ms 0..30000] [--no-usage-log]\n'
                + 'Response sizes are appended to output/mcp-usage/<date>.jsonl for scripts/measure-agent-mcp-inflow.mjs.\n'
                + 'Requires an existing registered client. Only plan and mutation requests can launch the registered Windows app. Read nai-blue://runtime for passive status.')
            return
        }
        requireInput(values.connection && values['inbox-dir'] && values.python && /^\d+$/.test(values['wait-ms']))
        requireInput(process.platform === 'win32')
        const initialFingerprint = await adapterFingerprint(repo)
        const connection = JSON.parse(await readText(values.connection, 4096))
        const { createServer } = await import('vite')
        loader = await createServer({ root: repo, configFile: false, logLevel: 'silent',
            resolve: { alias: { '@': path.join(repo, 'src') } },
            server: { middlewareMode: true, watch: null, hmr: false }, appType: 'custom' })
        const [contract, canonical, inputs, projection, adapter] = await Promise.all([
            '/src/application/agent/agent-command-contract.ts', '/src/domain/composition/canonical-serialize.ts',
            '/src/application/agent/agent-command-input.ts', '/src/adapters/agent/mcp/inbox-result-projection.ts',
            '/src/adapters/agent/mcp/mcp-stdio-server.ts',
        ].map(file => loader.ssrLoadModule(file)))
        let targetRuntimeHash
        const inbox = await createAgentMcpInbox({ connection, inboxDir: values['inbox-dir'], python: values.python,
            getRuntimeHash: () => targetRuntimeHash,
            waitMs: Number(values['wait-ms']) }, { contract, canonical, inputs, projection })
        const guard = createRuntimeGuard({ inbox, initialFingerprint,
            fingerprint: () => adapterFingerprint(repo), resolve: allowLaunch => resolveInstalledRuntime(repo, allowLaunch),
            onTarget: value => { targetRuntimeHash = value } })
        inbox.runtimeStatus = allowLaunch => guard.status(allowLaunch)
        if (!values['no-usage-log']) inbox.recordUsage = createUsageLog(path.join(repo, 'output', 'mcp-usage'))
        const { serveStdio, StdioServerTransport } = await import('@modelcontextprotocol/server/stdio')
        const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 262_144 })
        handle = serveStdio(() => adapter.createAgentMcpServer(inbox), { transport,
            onerror: () => { console.error('AGENT_MCP_TRANSPORT_ERROR') } })
        await new Promise(resolve => {
            const stop = () => resolve()
            process.once('SIGINT', stop)
            process.once('SIGTERM', stop)
            process.stdin.once('end', stop)
            process.stdin.once('close', stop)
        })
    } catch {
        console.error('AGENT_MCP_START_FAILED')
        process.exitCode = 1
    } finally {
        try { await handle?.close(); await loader?.close() }
        catch { process.exitCode = 1 }
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
