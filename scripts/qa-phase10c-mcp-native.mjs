import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { inspectAgentCommand, inspectPath, readText } from './inspect-agent-command.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url))
const requestOptions = { timeout: 20_000 }
const freshOptions = { ...requestOptions, cache: 'refresh' }
const sha256 = value => `sha256:${createHash('sha256').update(value).digest('hex')}`

/** Bounded shutdown also covers a child that cannot finish its normal SDK close. */
async function bounded(promise, milliseconds) {
    let timer
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('QA_TIMEOUT')), milliseconds)
        })])
    } finally { clearTimeout(timer) }
}

async function main() {
    const { values } = parseArgs({ options: {
        connection: { type: 'string' }, 'inbox-dir': { type: 'string' }, python: { type: 'string' },
        output: { type: 'string' }, mode: { type: 'string', default: 'live' }, help: { type: 'boolean' },
    } })
    if (values.help) {
        console.log('Read-only commands through the real native-app MCP stdio entry.\n'
            + 'node scripts/qa-phase10c-mcp-native.mjs --connection <public JSON> --inbox-dir <existing inbox> '
            + '--python <Python executable> --output <new evidence JSON> [--mode live|app-off|revoked]\n'
            + 'Run with Node 24. The app/client must already be prepared. App-off leaves read requests for startup recovery. '
            + 'Revoked requires the existing client credential to have already been revoked. No app control or registration.')
        return
    }
    assert(values.connection && values['inbox-dir'] && values.python && values.output, 'QA_ARGUMENTS_REQUIRED')
    assert(['live', 'app-off', 'revoked'].includes(values.mode), 'QA_MODE_INVALID')
    assert.equal(process.versions.node.split('.')[0], '24', 'QA_NODE_24_REQUIRED')

    const report = { schemaVersion: 1, startedAt: new Date().toISOString(), mode: values.mode,
        configuration: { node: process.execPath, nodeVersion: process.version,
            runner: path.join(repo, 'scripts/run-agent-mcp-stdio.mjs'), connection: path.resolve(values.connection),
            inboxDir: path.resolve(values['inbox-dir']), python: values.python, waitMs: 3000 },
        status: 'failed', phase: 'prepare', stderrBytes: 0, protocolErrorCount: 0, checks: [] }
    let client, transport, loader
    try {
        const inboxDir = await inspectPath(values['inbox-dir'], true)
        await inspectPath(values.connection)
        const execution = `qa10c-${randomUUID()}`
        const requests = [
            { name: 'workspace.get_snapshot', arguments: { requestId: `${execution}-snapshot`, input: {} } },
            { name: 'generation.get_run', arguments: { requestId: `${execution}-run`, input: { runId: `${execution}-missing` } } },
        ]
        report.requestIds = requests.map(request => request.arguments.requestId)
        transport = new StdioClientTransport({ command: process.execPath,
            args: [report.configuration.runner, '--connection', path.resolve(values.connection), '--inbox-dir', inboxDir,
                '--python', values.python, '--wait-ms', '3000'], cwd: repo, stderr: 'pipe', maxBufferSize: 262_144 })
        // Never preserve stderr or protocol-error messages: they can contain paths or rejected payloads.
        transport.stderr?.on('data', chunk => { report.stderrBytes += Buffer.byteLength(chunk) })
        client = new Client({ name: 'nai-blue-phase10c-native-qa', version: '1.0.0' },
            { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 5000 } } })
        client.onerror = () => { report.protocolErrorCount += 1 }
        report.phase = 'handshake'
        await client.connect(transport, requestOptions)
        assert.equal(client.getServerVersion()?.name, 'nai-blue-agent-spike')
        assert(client.getNegotiatedProtocolVersion())
        report.handshake = { server: client.getServerVersion(), protocol: client.getNegotiatedProtocolVersion(),
            capabilities: client.getServerCapabilities(), childPid: transport.pid }
        report.checks.push('sdk-handshake-production-runner')

        const resource = async uri => {
            const result = await client.readResource({ uri }, freshOptions)
            assert.equal(result.contents.length, 1)
            assert.equal(result.contents[0].uri, uri)
            return JSON.parse(result.contents[0].text)
        }
        const call = async request => {
            const result = await client.callTool(request, requestOptions)
            assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent)
            return result
        }
        report.phase = 'fresh-capabilities'
        const listed = await client.listTools({}, freshOptions)
        const capabilities = await resource('nai-blue://capabilities')
        report.capabilities = capabilities
        report.toolNames = listed.tools.map(tool => tool.name).sort()

        if (values.mode === 'live') {
            assert.equal(capabilities.status, 'fresh-application-capabilities')
            assert.deepEqual(capabilities.schemaMismatches, [])
            // Use the application parsers/hash implementation, without creating a second native runtime.
            const { createServer } = await import('vite')
            loader = await createServer({ root: repo, configFile: false, logLevel: 'silent',
                resolve: { alias: { '@': path.join(repo, 'src') } },
                server: { middlewareMode: true, watch: null, hmr: false }, appType: 'custom' })
            const [projection, canonical] = await Promise.all([
                '/src/adapters/agent/mcp/inbox-result-projection.ts', '/src/domain/composition/canonical-serialize.ts',
            ].map(file => loader.ssrLoadModule(file)))
            const available = capabilities.capabilities.filter(item => item.available)
            assert.deepEqual(report.toolNames, available.map(item => item.command).sort())
            report.schemaHashes = listed.tools.map(tool => {
                const hash = `sha256:${canonical.hashCanonicalValue(tool.inputSchema.properties.input)}`
                assert.equal(hash, available.find(item => item.command === tool.name).inputSchemaHash)
                return { command: tool.name, inputSchemaHash: hash }
            })
            assert(requests.every(request => report.toolNames.includes(request.name)))
            const nativeCapabilities = await inspectAgentCommand({ inboxDir, requestId: capabilities.requestId },
                projection.projectAgentInboxResult)
            assert.equal(nativeCapabilities.status, 'application-receipt')
            assert.deepEqual(capabilities.capabilities, nativeCapabilities.receipt.result.capabilities)
            report.checks.push('fresh-native-capability-receipt', 'exact-tool-and-schema-hash-projection')

            report.phase = 'concurrent-read-correlation'
            const results = await Promise.all(requests.map(call))
            report.reads = []
            for (const [index, result] of results.entries()) {
                const request = requests[index], requestId = request.arguments.requestId
                assert.equal(result.isError, false)
                const observed = result.structuredContent
                assert.equal(observed.status, 'application-receipt')
                assert.equal(observed.requestId, requestId)
                assert.equal(observed.receipt.command, request.name)
                assert.equal(observed.receipt.state, 'completed')
                assert.deepEqual(await resource(`nai-blue://requests/${requestId}`), observed)
                const native = await inspectAgentCommand({ inboxDir, requestId }, projection.projectAgentInboxResult)
                assert.deepEqual(native, observed)
                const rawReceipt = await readText(path.join(inboxDir, '..', 'results', `${requestId}.json`), 69_632)
                assert.deepEqual(JSON.parse(rawReceipt), observed.receipt)
                if (index === 1) assert.deepEqual(observed.receipt.result, { found: false })
                report.reads.push({ requestId, command: request.name, state: observed.receipt.state,
                    resultDigest: observed.receipt.resultDigest, nativeReceiptSha256: sha256(rawReceipt),
                    resourceAndNativeReceiptEqual: true })
            }
            report.checks.push('concurrent-read-correlation', 'resource-and-native-receipt-exact-equality', 'nonexistent-run-found-false')
            report.phase = 'same-id-replay'
            const first = requests[0], archivePath = path.join(inboxDir, `${first.arguments.requestId}.submitted.json`)
            const archiveBefore = await readText(archivePath, 65_536)
            const replay = await call(first)
            assert.deepEqual(replay, results[0])
            const archiveAfter = await readText(archivePath, 65_536)
            assert.equal(archiveAfter, archiveBefore)
            report.replay = { requestId: first.arguments.requestId, archivedEnvelopeSha256: sha256(archiveBefore),
                archiveBytesUnchanged: true, responseUnchanged: true }
            report.checks.push('same-id-replay-archive-and-receipt-unchanged')
        } else {
            assert.equal(capabilities.status, 'app-state-unconfirmed')
            assert.deepEqual(listed.tools, [])
            assert(capabilities.capabilities.every(item => item.available === false))
            report.checks.push('unconfirmed-app-empty-tools')
            const request = requests[0], requestId = request.arguments.requestId
            report.phase = values.mode === 'app-off' ? 'app-off-submission' : 'revoked-submission'
            const result = await call(request)
            if (values.mode === 'app-off') {
                const expected = { status: 'submitted-to-inbox', accepted: false, requestId, requiresAppProcess: true }
                assert.equal(result.isError, false)
                assert.deepEqual(result.structuredContent, expected)
                assert.deepEqual(await resource(`nai-blue://requests/${requestId}`), expected)
                const archive = await readText(path.join(inboxDir, `${requestId}.submitted.json`), 65_536)
                assert.equal(await readText(path.join(inboxDir, `${requestId}.ready.json`), 65_536), archive)
                assert.equal(await readText(path.join(inboxDir, '..', 'results', `${requestId}.json`), 69_632, true), null)
                report.submission = { ...expected, archiveSha256: sha256(archive), readyEqualsArchive: true }
                report.checks.push('app-off-submission-not-accepted', 'ready-preserved-for-startup-recovery')
            } else {
                assert.equal(result.isError, true)
                assert.equal(result.structuredContent.status, 'adapter-error')
                assert.equal(result.structuredContent.code, 'AGENT_MCP_REQUEST_FAILED')
                for (const id of [requestId, capabilities.requestId]) {
                    for (const suffix of ['ready.json', 'submitted.json']) {
                        assert.equal(await readText(path.join(inboxDir, `${id}.${suffix}`), 65_536, true), null)
                    }
                }
                report.checks.push('revoked-new-request-refused-without-publication')
            }
        }
        report.phase = 'shutdown'
    } catch {
        report.failureCode = 'PHASE10C_NATIVE_QA_FAILED'
        process.exitCode = 1
    } finally {
        // Capture before SDK close clears its process handle; pid absence proves termination,
        // while the SDK's public API does not expose the child's numeric exit code.
        const childPid = transport?.pid
        try { await bounded(client?.close() ?? Promise.resolve(), 5000) }
        catch {
            report.status = 'failed'; report.failureCode = 'PHASE10C_NATIVE_QA_CLOSE_FAILED'; process.exitCode = 1
            if (childPid) { try { process.kill(childPid) } catch { /* Child already exited. */ } }
        }
        try { await bounded(loader?.close() ?? Promise.resolve(), 5000) }
        catch { report.status = 'failed'; report.failureCode = 'PHASE10C_NATIVE_QA_CLOSE_FAILED'; process.exitCode = 1 }
        try {
            assert.equal(report.stderrBytes, 0)
            assert.equal(report.protocolErrorCount, 0)
            if (childPid) {
                let childExited = false
                try { process.kill(childPid, 0) }
                catch (error) { if (error.code === 'ESRCH') childExited = true }
                report.shutdown = { childPid, childExited }
                assert(childExited, 'QA_CHILD_STILL_RUNNING')
            }
            if (!report.failureCode) {
                report.checks.push('no-stderr-or-protocol-errors-after-close', 'stdio-child-exited')
                report.status = 'passed'
                report.phase = 'complete'
            }
        } catch {
            report.status = 'failed'
            report.failureCode ??= 'PHASE10C_NATIVE_QA_SHUTDOWN_VERIFICATION_FAILED'
            process.exitCode = 1
        }
        report.finishedAt = new Date().toISOString()
        // Exclusive creation preserves earlier evidence. Never record envelopes, signatures or raw result payloads.
        await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
        console.log(JSON.stringify({ status: report.status, mode: report.mode, phase: report.phase, checks: report.checks }))
    }
}

try { await main() }
catch { console.error('PHASE10C_NATIVE_QA_INPUT_OR_REPORT_FAILED'); process.exitCode = 1 }
