/** Process-only test fixture: fixed public HMAC key replaces credential access.
 * Real SDK stdio, root inbox bridge, file reads and TS projection run unchanged.
 * The parent test owns the authenticated app dispatcher and fake IndexedDB.
 */
import { createHmac } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { createAgentMcpInbox } from '../../scripts/run-agent-mcp-stdio.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const root = path.resolve(process.argv[2])
const waitMs = Number(process.argv[3])
const connection = { workspaceId: 'process-workspace', clientId: process.argv[4] ?? 'process-client',
    keyId: 'process-key', actorKind: 'agent' }
if (!path.basename(root).startsWith('nai-mcp-process-')) throw new Error('Fixture directory required')

// Capture raw child stdout independently of SDK decoding; every line must be JSON-RPC.
const write = process.stdout.write.bind(process.stdout)
process.stdout.write = function (chunk, ...args) {
    appendFileSync(path.join(root, `wire-${process.pid}.jsonl`), chunk)
    return write(chunk, ...args)
}
const loader = await createServer({ root: repo, configFile: false, logLevel: 'silent',
    resolve: { alias: { '@': path.join(repo, 'src') } },
    server: { middlewareMode: true, watch: null, hmr: false }, appType: 'custom' })
const [contract, canonical, inputs, projection, adapter] = await Promise.all([
    '/src/application/agent/agent-command-contract.ts', '/src/domain/composition/canonical-serialize.ts',
    '/src/application/agent/agent-command-input.ts', '/src/adapters/agent/mcp/inbox-result-projection.ts',
    '/src/adapters/agent/mcp/mcp-stdio-server.ts',
].map(file => loader.ssrLoadModule(file)))

async function publishExact(file, bytes) {
    try { await writeFile(file, bytes, { flag: 'wx' }) }
    catch (error) {
        if (error.code !== 'EEXIST' || await readFile(file, 'utf8') !== bytes) throw error
    }
}

const inbox = await createAgentMcpInbox({ connection, inboxDir: path.join(root, 'inbox'),
    python: 'test-only-unused', waitMs }, { contract, canonical, inputs, projection },
async (_python, inboxDir, requestId, payload) => {
    // This injection exists only in this fixture. Production Python/keyring flags
    // and the production CLI are unchanged; native no-replace has its own suite.
    const signed = JSON.parse(payload.signingPayload)
    if (contract.agentRequestHash(JSON.parse(payload.unsignedPayload)) !== signed.requestHash) throw new Error('Fixture hash mismatch')
    signed.authentication.signature = `hmac-sha256:${createHmac('sha256', Buffer.from(Array.from({ length: 32 }, (_, i) => i)))
        .update(payload.signingPayload, 'utf8').digest('hex')}`
    const raw = canonical.canonicalSerialize(contract.parseAgentCommandEnvelope(signed))
    await publishExact(path.join(inboxDir, `${requestId}.submitted.json`), raw)
    await publishExact(path.join(inboxDir, `${requestId}.ready.json`), raw)
    return { status: 'submitted-to-inbox', accepted: false, requestId, requiresAppProcess: true }
})
const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 262_144 })
const handle = serveStdio(() => adapter.createAgentMcpServer(inbox), { transport,
    onerror: () => { process.stderr.write('FIXTURE_TRANSPORT_ERROR\n') } })
await new Promise(resolve => {
    process.once('SIGTERM', resolve)
    process.once('SIGINT', resolve)
    process.stdin.once('end', resolve)
    process.stdin.once('close', resolve)
})
await handle.close()
await loader.close()
