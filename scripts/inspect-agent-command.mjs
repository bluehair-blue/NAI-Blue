import { parseArgs } from 'node:util'
import { lstat, open } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const REQUEST_LIMIT = 65_536
const RECEIPT_LIMIT = REQUEST_LIMIT + 4_096 // Native agent_commands.rs permits receipt metadata overhead.

// The development stdio entry reuses these bounded reads instead of owning a second file reader.
export { inspectPath, readText }

function requireInput(condition) {
    if (!condition) throw new Error('Invalid observation input')
}

/** Existing native directories own ACLs. This read-only harness rejects redirected paths and linked files. */
async function inspectPath(target, directory = false) {
    const absolute = path.resolve(target)
    const ancestors = []
    for (let current = absolute; ; current = path.dirname(current)) {
        ancestors.push(current)
        if (path.dirname(current) === current) break
    }
    for (const candidate of ancestors.reverse()) {
        const info = await lstat(candidate)
        requireInput(!info.isSymbolicLink())
        if (candidate === absolute) requireInput(directory ? info.isDirectory() : info.isFile() && info.nlink === 1)
        else requireInput(info.isDirectory())
    }
    return absolute
}

async function readText(target, limit, optional = false) {
    let handle
    try {
        await inspectPath(target)
        handle = await open(target, 'r')
        const info = await handle.stat()
        requireInput(info.isFile() && info.nlink === 1 && info.size <= limit)
        const bytes = Buffer.alloc(limit + 1)
        let length = 0
        while (length < bytes.length) {
            const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null)
            if (bytesRead === 0) break
            length += bytesRead
        }
        requireInput(length <= limit)
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
    } catch (error) {
        if (optional && error.code === 'ENOENT') return null
        throw error
    } finally {
        await handle?.close()
    }
}

/** Observe one saved request; never submit/replay, create IDs, or cancel a Queue operation. */
export async function inspectAgentCommand({ inboxDir, requestId, waitMs = 0, signal }, project) {
    requireInput(typeof requestId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(requestId)
        && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(requestId))
    requireInput(Number.isSafeInteger(waitMs) && waitMs >= 0 && waitMs <= 30_000)
    const inbox = await inspectPath(inboxDir, true)
    requireInput(path.basename(inbox) === 'inbox')
    const root = path.dirname(inbox)
    await Promise.all(['results', 'rejections'].map(name => inspectPath(path.join(root, name), true)))
    const archivedText = await readText(path.join(inbox, `${requestId}.submitted.json`), REQUEST_LIMIT)
    const envelope = JSON.parse(archivedText)
    requireInput(envelope.requestId === requestId)
    const deadline = performance.now() + waitMs
    const cancelled = () => ({ status: 'observation-cancelled', requestId, requiresAppProcess: true })
    while (true) {
        if (signal?.aborted) return cancelled()
        const [result, rejection, ready] = await Promise.all([
            readText(path.join(root, 'results', `${requestId}.json`), RECEIPT_LIMIT, true),
            readText(path.join(root, 'rejections', `${requestId}.json`), REQUEST_LIMIT, true),
            readText(path.join(inbox, `${requestId}.ready.json`), REQUEST_LIMIT, true),
        ])
        if (ready !== null) requireInput(ready === archivedText)
        const projection = project(envelope, result === null ? null : JSON.parse(result),
            rejection === null ? null : JSON.parse(rejection))
        if (result !== null || rejection !== null) return projection
        if (performance.now() >= deadline) {
            // The signer archives before publication: archive alone cannot prove submission.
            return ready === null
                ? { status: 'submission-unconfirmed', accepted: false, requestId, requiresAppProcess: true }
                : projection
        }
        try { await delay(Math.min(100, Math.max(1, deadline - performance.now())), undefined, { signal }) }
        catch (error) { if (error.name === 'AbortError') return cancelled(); throw error }
    }
}

async function main() {
    let server
    const controller = new AbortController()
    const cancel = () => controller.abort()
    try {
        const { values } = parseArgs({ options: {
            'inbox-dir': { type: 'string' }, 'request-id': { type: 'string' },
            'wait-ms': { type: 'string', default: '0' }, help: { type: 'boolean' },
        } })
        if (values.help) {
            console.log('Read-only Phase 10 prerequisite harness (not an MCP server).\n'
                + 'node scripts/inspect-agent-command.mjs --inbox-dir <existing native inbox> --request-id <saved ID> [--wait-ms 0..30000]\n'
                + 'Requires repository dev dependencies. Never reads credentials, submits, or starts the app.\n'
                + 'An archived HMAC envelope is checked for integrity, not freshly authenticated. A receipt is historical, not app liveness.')
            return
        }
        requireInput(values['inbox-dir'] && values['request-id'] && /^\d+$/.test(values['wait-ms']))
        process.on('SIGINT', cancel)
        process.on('SIGTERM', cancel)
        // Development-only TS loading reuses the application's exact parser/redaction authority.
        // No listener, SDK, generated sidecar package, or user MCP configuration is created.
        const { createServer } = await import('vite')
        const repo = fileURLToPath(new URL('../', import.meta.url))
        server = await createServer({ root: repo, configFile: false, logLevel: 'silent',
            resolve: { alias: { '@': path.join(repo, 'src') } },
            server: { middlewareMode: true, watch: null, hmr: false }, appType: 'custom' })
        const { projectAgentInboxResult } = await server.ssrLoadModule('/src/adapters/agent/mcp/inbox-result-projection.ts')
        const observed = await inspectAgentCommand({ inboxDir: values['inbox-dir'], requestId: values['request-id'],
            waitMs: Number(values['wait-ms']), signal: controller.signal }, projectAgentInboxResult)
        console.log(JSON.stringify(observed))
    } catch {
        // Raw OS/parser errors may contain user paths or rejected payloads.
        console.error(JSON.stringify({ status: 'observation-unavailable', code: 'AGENT_OBSERVATION_FAILED', requiresAppProcess: true }))
        process.exitCode = 1
    } finally {
        process.off('SIGINT', cancel)
        process.off('SIGTERM', cancel)
        await server?.close()
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
