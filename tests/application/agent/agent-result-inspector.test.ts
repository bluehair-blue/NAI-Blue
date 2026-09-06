import { spawn } from 'node:child_process'
import { webcrypto } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectAgentCommand } from '../../../scripts/inspect-agent-command.mjs'
import { projectAgentInboxResult } from '@/adapters/agent/mcp/inbox-result-projection'
import { agentRequestHash, canonicalAgentSigningPayload, type AgentCommandEnvelope } from '@/application/agent/agent-command-contract'
import { agentResultDigest } from '@/application/agent/command-receipt-repository'
import { AgentCommandDispatcher } from '@/application/agent/agent-command-dispatcher'
import { IndexedDbCommandReceiptRepository } from '@/adapters/agent/indexeddb-command-receipt-repository'
import { WebCryptoAgentAuthentication } from '@/adapters/agent/webcrypto-agent-authentication'
import { resetIndexedDBConnectionForRetry } from '@/lib/indexed-db'

const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))) })

async function fixture(requestId = 'inspect-request') {
    const root = await mkdtemp(path.join(tmpdir(), 'nai-phase10-inspection-'))
    folders.push(root)
    await Promise.all(['inbox', 'results', 'rejections'].map(name => mkdir(path.join(root, name))))
    const envelope: AgentCommandEnvelope = {
        schemaVersion: 1, requestId, requestHash: `sha256:${'0'.repeat(64)}`, submittedAt: '2026-09-06T00:00:00.000Z',
        context: { apiVersion: 'nai-blue.agent/v1alpha1', workspaceId: 'fixture-workspace', clientId: 'fixture-client',
            actor: { kind: 'agent' }, idempotencyKey: requestId },
        command: { name: 'workspace.get_snapshot', input: {} },
        authentication: { scheme: 'hmac-sha256', keyId: 'fixture-key', signature: `hmac-sha256:${'0'.repeat(64)}` },
    }
    const saved = { ...envelope, requestHash: agentRequestHash(envelope) }
    const bytes = JSON.stringify(saved)
    const inboxDir = path.join(root, 'inbox')
    const archive = path.join(inboxDir, `${requestId}.submitted.json`)
    const ready = path.join(inboxDir, `${requestId}.ready.json`)
    const resultPath = path.join(root, 'results', `${requestId}.json`)
    await writeFile(archive, bytes)
    const result = { totalDrafts: 3, estimatedAnlas: 1.5 }
    const receipt = { schemaVersion: 1, requestId, requestHash: saved.requestHash, authenticatedClientId: 'fixture-client',
        command: saved.command.name, state: 'completed', observedAt: '2026-09-06T00:00:01.000Z',
        resultSchemaVersion: 1, result, resultDigest: agentResultDigest(result) }
    const inspect = (options = {}) => inspectAgentCommand({ inboxDir, requestId, ...options }, projectAgentInboxResult)
    return { root, inboxDir, archive, ready, resultPath, bytes, receipt, inspect, requestId }
}

describe('Phase 10 read-only inbox inspection prerequisite (fixture files, no native app or MCP)', () => {
    it('distinguishes an archive before publication from an actually published pending request without writing', async () => {
        const f = await fixture()
        expect(await f.inspect()).toMatchObject({ status: 'submission-unconfirmed', accepted: false })
        await writeFile(f.ready, f.bytes)
        expect(await f.inspect()).toEqual({ status: 'submitted-to-inbox', accepted: false,
            requestId: f.requestId, requiresAppProcess: true })
        expect(await readFile(f.archive, 'utf8')).toBe(f.bytes)
        expect(await readFile(f.ready, 'utf8')).toBe(f.bytes)
        expect(await readdir(path.join(f.root, 'results'))).toEqual([])
    })

    it('correlates delayed publication and repeated observations to the same exact receipt', async () => {
        const f = await fixture()
        await writeFile(f.ready, f.bytes)
        const pending = f.inspect({ waitMs: 1000 })
        await writeFile(f.resultPath, JSON.stringify(f.receipt))
        const observed = await pending
        expect(observed.receipt).toEqual(f.receipt)
        expect(await f.inspect()).toEqual(observed)
        expect(await readFile(f.archive, 'utf8')).toBe(f.bytes)
    })

    it('projects an actual authenticated dispatcher receipt after closing the IndexedDB connection', async () => {
        const f = await fixture()
        const subtle = webcrypto.subtle as unknown as SubtleCrypto
        const key = await subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
        const request = JSON.parse(f.bytes) as AgentCommandEnvelope
        const signature = await subtle.sign('HMAC', key, new TextEncoder().encode(canonicalAgentSigningPayload(request)))
        const signed = { ...request, authentication: { ...request.authentication,
            signature: `hmac-sha256:${Buffer.from(signature).toString('hex')}` } }
        resetIndexedDBConnectionForRetry()
        vi.stubGlobal('indexedDB', new IDBFactory())
        try {
            const execute = vi.fn(async () => ({ totalDrafts: 3, estimatedAnlas: 1.5 }))
            const receipts = new IndexedDbCommandReceiptRepository()
            const dispatcher = new AgentCommandDispatcher({ workspaceId: request.context.workspaceId, receipts,
                authentication: new WebCryptoAgentAuthentication(async (clientId, keyId) => ({
                    clientId, keyId, actorKind: 'agent', revokedAt: null, key,
                }), subtle),
                handlers: [{ command: 'workspace.get_snapshot', effect: 'read', validate: input => input, execute }],
                runtime: () => ({ ready: true, mode: 'suggest', globalPause: false }),
                now: () => '2026-09-06T00:00:01.000Z' })
            const receipt = await dispatcher.dispatch(signed)
            expect(await receipts.get(request.requestId)).toEqual(receipt)
            await writeFile(f.archive, JSON.stringify(signed))
            await writeFile(f.resultPath, JSON.stringify(receipt))
            resetIndexedDBConnectionForRetry()
            expect((await f.inspect()).receipt).toEqual(receipt)
            expect((await f.inspect()).receipt).toEqual(receipt)
            expect(execute).toHaveBeenCalledTimes(1)
        } finally {
            resetIndexedDBConnectionForRetry()
            vi.unstubAllGlobals()
        }
    })

    it('stops observation without submitting or requesting Queue cancellation', async () => {
        const f = await fixture()
        const controller = new AbortController()
        const pending = f.inspect({ waitMs: 1000, signal: controller.signal })
        controller.abort()
        expect(await pending).toMatchObject({ status: 'observation-cancelled', requestId: f.requestId })
        expect(await readdir(f.inboxDir)).toEqual([`${f.requestId}.submitted.json`])
    })

    it('rejects a changed ready envelope, oversized result, linked result, and a missing archive', async () => {
        const f = await fixture()
        await writeFile(f.ready, '{}')
        await expect(f.inspect()).rejects.toThrow()
        await rm(f.ready)
        await writeFile(f.resultPath, ' '.repeat(69_633))
        await expect(f.inspect()).rejects.toThrow()
        await rm(f.resultPath)
        await link(f.archive, f.resultPath)
        await expect(f.inspect()).rejects.toThrow()
        await rm(f.resultPath)
        await rm(f.archive)
        await expect(f.inspect()).rejects.toThrow()
    })

    it('keeps concurrent request IDs separate and rejects a swapped result', async () => {
        const first = await fixture('request-one'), second = await fixture('request-two')
        await Promise.all([writeFile(first.resultPath, JSON.stringify(first.receipt)),
            writeFile(second.resultPath, JSON.stringify(second.receipt))])
        const results = await Promise.all([first.inspect(), second.inspect()])
        expect(results.map(result => result.requestId)).toEqual(['request-one', 'request-two'])
        await writeFile(first.resultPath, JSON.stringify(second.receipt))
        await expect(first.inspect()).rejects.toThrow()
    })

    it('runs the real CLI with shared TypeScript parsers and emits only redacted JSON on stdout/stderr', async () => {
        const f = await fixture()
        await writeFile(f.resultPath, JSON.stringify(f.receipt))
        const run = () => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
            const child = spawn(process.execPath, ['scripts/inspect-agent-command.mjs', '--inbox-dir', f.inboxDir,
                '--request-id', f.requestId], { windowsHide: true, timeout: 20_000 })
            let stdout = '', stderr = ''
            child.stdout.on('data', chunk => { stdout += chunk })
            child.stderr.on('data', chunk => { stderr += chunk })
            child.on('error', reject)
            child.on('close', code => resolve({ code, stdout, stderr }))
        })
        const success = await run()
        expect(success.code).toBe(0)
        expect(success.stderr).toBe('')
        expect(JSON.parse(success.stdout).receipt).toEqual(f.receipt)
        await writeFile(f.resultPath, JSON.stringify({ secret: 'must-not-escape', note: f.root }))
        const failure = await run()
        expect(failure.code).toBe(1)
        expect(failure.stdout).toBe('')
        expect(JSON.parse(failure.stderr)).toEqual({ status: 'observation-unavailable',
            code: 'AGENT_OBSERVATION_FAILED', requiresAppProcess: true })
    }, 45_000)
})
