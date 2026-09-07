import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { inspectAgentCommand, inspectPath, readText } from './inspect-agent-command.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url))
const maxBytes = 65_536
const maxConcurrentCalls = 8

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
        agentRequestHash, canonicalAgentSigningPayload } = modules.contract
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
    async function inspect(requestId, signal) {
        assertAgentRequestId(requestId)
        requireInput(await archived(requestId) !== null)
        // Re-check the configured identity on every poll, not only before entering the wait.
        return inspectAgentCommand({ inboxDir, requestId, waitMs, signal }, (envelope, result, rejection) =>
            projectAgentInboxResult(bind(parseAgentCommandEnvelope(envelope), requestId), result, rejection))
    }
    async function publish(command, requestId) {
        const envelope = await archived(requestId) ?? build(command, requestId)
        requireInput(canonicalSerialize(envelope.command) === canonicalSerialize(command))
        const { requestHash: _requestHash, authentication: _authentication, ...unsigned } = envelope
        return submit(python, inboxDir, requestId, { connection,
            unsignedPayload: canonicalSerialize(unsigned), signingPayload: canonicalAgentSigningPayload(envelope) })
    }

    return {
        inspect,
        async invoke(command, requestId, signal) {
            assertAgentRequestId(requestId)
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
                if (entry) requireInput(entry.fingerprint === fingerprint)
                else {
                    entry = { fingerprint, promise: publish(structuredClone(command), requestId) }
                    pending.set(requestId, entry)
                }
                // Once signing begins, cancellation never retries/rolls back an uncertain publication.
                try { await entry.promise }
                finally { if (pending.get(requestId) === entry) pending.delete(requestId) }
                return await inspect(requestId, signal)
            } finally { active -= 1 }
        },
    }
}

async function main() {
    let loader, handle
    try {
        const { values } = parseArgs({ options: {
            connection: { type: 'string' }, 'inbox-dir': { type: 'string' }, python: { type: 'string' },
            'wait-ms': { type: 'string', default: '3000' }, help: { type: 'boolean' },
        } })
        if (values.help) {
            console.log('NAI Blue development MCP stdio spike.\n'
                + 'node scripts/run-agent-mcp-stdio.mjs --connection <public connection JSON> --inbox-dir <existing inbox> --python <Python executable> [--wait-ms 0..30000]\n'
                + 'Requires a client already registered by a human in the Windows app. No app launch, installation or MCP configuration changes.')
            return
        }
        requireInput(values.connection && values['inbox-dir'] && values.python && /^\d+$/.test(values['wait-ms']))
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
        const inbox = await createAgentMcpInbox({ connection, inboxDir: values['inbox-dir'], python: values.python,
            waitMs: Number(values['wait-ms']) }, { contract, canonical, inputs, projection })
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
