import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { createAgentMcpInbox } from '../../../scripts/run-agent-mcp-stdio.mjs'
import { createAgentMcpServer, type McpAgentInbox } from '@/adapters/agent/mcp/mcp-stdio-server'
import { parseAgentCommandEnvelope, type AgentCommand } from '@/application/agent/agent-command-contract'
import { agentResultDigest } from '@/application/agent/command-receipt-repository'
import { canonicalSerialize } from '@/domain/composition/canonical-serialize'
import type { JsonObject } from '@/domain/composition/types'

// Real inbox bridge over a temp folder; only signing (fixed zero signature) and the app pump are simulated.
// Pins the resume rule: a request ID that already left a trace is observed and never published again.
const folders: string[] = []
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
    await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })))
})

const connection = { workspaceId: 'resume-workspace', clientId: 'resume-client', keyId: 'resume-key', actorKind: 'agent' }
const modules = async () => ({ contract: await import('@/application/agent/agent-command-contract'),
    canonical: await import('@/domain/composition/canonical-serialize'), inputs: await import('@/application/agent/agent-command-input'),
    projection: await import('@/adapters/agent/mcp/inbox-result-projection') })
const hash = '8b8311c4580cd5c1b7e3d8aff77154ff0a637b7a99322271938524f89661a594'
const runId = `scene-batch-agent-${hash}`
const planId = `sha256:${'a'.repeat(64)}`, planHash = `sha256:${'b'.repeat(64)}`
const planInput = { source: { kind: 'scene', targets: [{ presetId: 'preset-1', sceneId: 'scene-a', expectedRevision: 1, count: 1 }] },
    seedPolicy: { kind: 'random' }, budget: { maxImages: 1, maxAnlas: 0 } }
const readRun: AgentCommand = { name: 'generation.get_run', input: { runId: 'run-1' } }

async function inboxFixture(waitMs = 0) {
    const root = await mkdtemp(path.join(tmpdir(), 'nai-mcp-resume-'))
    folders.push(root)
    await Promise.all(['inbox', 'results', 'rejections'].map(name => mkdir(path.join(root, name))))
    const inboxDir = path.join(root, 'inbox')
    const write = async (file: string, value: unknown) => {
        await writeFile(`${file}.partial`, typeof value === 'string' ? value : JSON.stringify(value))
        await rename(`${file}.partial`, file)
    }
    // Stands in for the Python bridge: archive first, then the ready file the app reads.
    const signer = vi.fn(async (_python: string, directory: string, requestId: string, payload: { signingPayload: string }) => {
        const signed = JSON.parse(payload.signingPayload)
        signed.authentication.signature = `hmac-sha256:${'0'.repeat(64)}`
        const raw = canonicalSerialize(parseAgentCommandEnvelope(signed))
        await write(path.join(directory, `${requestId}.submitted.json`), raw)
        await write(path.join(directory, `${requestId}.ready.json`), raw)
        return { status: 'submitted-to-inbox', accepted: false, requestId, requiresAppProcess: true }
    })
    const inbox = await createAgentMcpInbox({ connection, inboxDir, python: 'unused', waitMs }, await modules(), signer) as McpAgentInbox
    const ready = (id: string) => path.join(inboxDir, `${id}.ready.json`)
    /** The app's order: write the answer, then retire the ready file. */
    const answer = async (id: string, result: JsonObject) => {
        const envelope = JSON.parse(await readFile(path.join(inboxDir, `${id}.submitted.json`), 'utf8'))
        await write(path.join(root, 'results', `${id}.json`), { schemaVersion: 1, requestId: id, requestHash: envelope.requestHash,
            authenticatedClientId: envelope.context.clientId, command: envelope.command.name, state: 'completed',
            observedAt: '2026-11-22T00:00:01.000Z', resultSchemaVersion: 1, result, resultDigest: agentResultDigest(result) })
        await rm(ready(id), { force: true })
    }
    const refuse = async (id: string) => {
        await write(path.join(root, 'rejections', `${id}.json`), { accepted: false, code: 'AUTHENTICATION_FAILED' })
        await rm(ready(id), { force: true })
    }
    return { root, inboxDir, inbox, signer, answer, refuse, ready, published: (id: string) => signer.mock.calls.filter(call => call[2] === id).length }
}

describe('inbox never re-publishes a request that already left a trace', () => {
    it('returns a saved result or rejection without publishing, observes a pending ready file and republishes only an archive', async () => {
        const f = await inboxFixture()
        expect(await f.inbox.invoke(readRun, 'saved-result')).toMatchObject({ status: 'submitted-to-inbox' })
        await f.answer('saved-result', { found: false })
        expect(await f.inbox.invoke(readRun, 'saved-result')).toMatchObject({ status: 'application-receipt', receipt: { state: 'completed' } })
        expect(f.published('saved-result')).toBe(1)
        expect(existsSync(f.ready('saved-result'))).toBe(false)

        await f.inbox.invoke(readRun, 'refused')
        await f.refuse('refused')
        expect(await f.inbox.invoke(readRun, 'refused')).toEqual({ status: 'inbox-rejection', requestId: 'refused',
            requiresAppProcess: true, accepted: false, code: 'AUTHENTICATION_FAILED' })
        expect(f.published('refused')).toBe(1)
        // Re-creating the ready file here is what let a refused request run in the background.
        expect(existsSync(f.ready('refused'))).toBe(false)

        await f.inbox.invoke(readRun, 'pending')
        expect(await f.inbox.invoke(readRun, 'pending', undefined, 0)).toMatchObject({ status: 'submitted-to-inbox' })
        expect(f.published('pending')).toBe(1)

        await f.inbox.invoke(readRun, 'cut-off')
        await rm(f.ready('cut-off'))
        expect(await f.inbox.invoke(readRun, 'cut-off')).toMatchObject({ status: 'submitted-to-inbox' })
        expect(f.published('cut-off')).toBe(2)
    })

    it('refuses different input under an existing request ID with a typed error and publishes nothing', async () => {
        const f = await inboxFixture()
        await f.inbox.invoke(readRun, 'taken')
        const archive = await readFile(path.join(f.inboxDir, 'taken.submitted.json'), 'utf8')
        for (const state of ['pending', 'answered']) {
            if (state === 'answered') await f.answer('taken', { found: false })
            await expect(f.inbox.invoke({ name: 'generation.get_run', input: { runId: 'run-2' } }, 'taken'))
                .rejects.toMatchObject({ name: 'AgentCommandError', code: 'REQUEST_ID_INPUT_MISMATCH' })
        }
        expect(f.published('taken')).toBe(1)
        expect(await readFile(path.join(f.inboxDir, 'taken.submitted.json'), 'utf8')).toBe(archive)
    })

    it('waits per call up to the tool-call cap and keeps the base wait when none is given', async () => {
        const f = await inboxFixture(0)
        await f.inbox.invoke(readRun, 'timed')
        const started = performance.now()
        const pending = f.inbox.inspect('timed', undefined, 2000)
        setTimeout(() => { void f.answer('timed', { found: false }) }, 300)
        expect(await pending).toMatchObject({ status: 'application-receipt' })
        expect(performance.now() - started).toBeGreaterThanOrEqual(250)
        await expect(f.inbox.inspect('timed', undefined, 50_001)).rejects.toThrow()
        await expect(f.inbox.inspect('timed', undefined, -1)).rejects.toThrow()
        expect(await f.inbox.inspect('timed', undefined, 50_000)).toMatchObject({ status: 'application-receipt' })
    })
})

describe('generation.run resumes with the same requestId and input', () => {
    async function connected(waitMs = 0) {
        const f = await inboxFixture(waitMs)
        const allowed = new Set<string>()
        let busy = false
        // The pump answers only the commands a test lets through, like an app that is slow on one stage.
        const timer = setInterval(() => {
            if (busy) return
            busy = true
            void (async () => {
                for (const file of (await readdir(f.inboxDir)).filter(name => name.endsWith('.ready.json'))) {
                    const id = file.slice(0, -'.ready.json'.length)
                    const command = JSON.parse(await readFile(path.join(f.inboxDir, file), 'utf8')).command.name as string
                    if (!allowed.has(command)) continue
                    await f.answer(id, command === 'generation.plan'
                        ? { status: 'ready', planId, planHash, jobCount: 1, estimatedAnlas: 0, requiredApprovals: [],
                            review: { jobs: [{ ordinal: 0, sceneId: 'scene-a', seed: 7, destination: { fileName: 'scene-a.png' } }] } }
                        : command === 'generation.enqueue' ? { status: 'ready', runId, batchId: runId, jobIds: [`scene-job-agent-${hash}-0`] }
                            : { found: true, runId, state: 'delivered', jobs: [{ jobId: `scene-job-agent-${hash}-0`,
                                artifactId: `artifact:scene-job-agent-${hash}-0`, storageState: 'succeeded' }],
                            monitor: { complete: true, nextAction: 'review-results', counts: { total: 1, fulfilled: 1 } } })
                }
            // A Windows read/delete collision with the adapter only delays this file to the next tick.
            })().catch(() => {}).finally(() => { busy = false })
        }, 10)
        const server = createAgentMcpServer(f.inbox)
        const client = new Client({ name: 'mcp-request-resume', version: '1.0.0' })
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        await server.connect(serverTransport)
        await client.connect(clientTransport)
        cleanups.push(async () => {
            clearInterval(timer)
            await vi.waitFor(() => expect(busy).toBe(false))
            await client.close(); await server.close()
        })
        const call = async (name: string, args: JsonObject) => {
            const result = await client.callTool({ name, arguments: args })
            return { isError: result.isError === true, body: JSON.parse(String((result.content as { text: string }[])[0].text)) as Record<string, any> }
        }
        return { ...f, allowed, call }
    }

    it('continues after a call that ended at the plan stage without submitting any stage twice', async () => {
        const f = await connected()
        const first = await f.call('generation.run', { requestId: 'resume-plan', input: planInput, waitSeconds: 0 })
        expect(first.body).toMatchObject({ stage: 'plan', status: 'submitted-to-inbox', requestId: 'resume-plan-plan' })
        expect(first.body.hint).toContain('generation.run again with the same requestId and input')
        f.allowed.add('generation.plan').add('generation.enqueue').add('generation.get_run')
        const second = await f.call('generation.run', { requestId: 'resume-plan', input: planInput, waitSeconds: 10 })
        expect(second.body).toMatchObject({ stage: 'run', runId, complete: true, planId,
            artifacts: [{ artifactId: `artifact:scene-job-agent-${hash}-0`, sceneId: 'scene-a', seed: 7, fileName: 'scene-a.png' }] })
        expect([f.published('resume-plan-plan'), f.published('resume-plan-enq')]).toEqual([1, 1])
        const third = await f.call('generation.run', { requestId: 'resume-plan', input: planInput, waitSeconds: 10 })
        expect(third.body).toMatchObject({ stage: 'run', runId, complete: true })
        expect([f.published('resume-plan-plan'), f.published('resume-plan-enq')]).toEqual([1, 1])
    }, 20_000)

    it('continues after a call that ended at the enqueue stage and observes the pending enqueue instead of publishing it', async () => {
        const f = await connected()
        f.allowed.add('generation.plan')
        const first = await f.call('generation.run', { requestId: 'resume-enq', input: planInput, waitSeconds: 1 })
        expect(first.body).toMatchObject({ stage: 'enqueue', status: 'submitted-to-inbox', requestId: 'resume-enq-enq', planId, planHash })
        expect(first.body.hint).toContain('generation.run again with the same requestId and input')
        f.allowed.add('generation.enqueue').add('generation.get_run')
        const second = await f.call('generation.run', { requestId: 'resume-enq', input: planInput, waitSeconds: 10 })
        expect(second.body).toMatchObject({ stage: 'run', runId, complete: true })
        expect([f.published('resume-enq-plan'), f.published('resume-enq-enq')]).toEqual([1, 1])
    }, 20_000)

    it('reports reused request IDs with different input as their own error, never as an unsubmitted request', async () => {
        const f = await connected()
        f.allowed.add('generation.plan').add('generation.get_run')
        await f.call('generation.run', { requestId: 'taken-run', input: planInput, planOnly: true, waitSeconds: 5 })
        const changed = { ...planInput, budget: { maxImages: 1, maxAnlas: 5 } }
        const run = await f.call('generation.run', { requestId: 'taken-run', input: changed })
        expect(run).toMatchObject({ isError: true, body: { stage: 'plan', status: 'adapter-error', code: 'REQUEST_ID_INPUT_MISMATCH', requestId: 'taken-run-plan' } })
        expect(run.body.hint).toContain('nothing new was submitted')
        for (const key of ['accepted', 'submissionAttempted']) expect(run.body).not.toHaveProperty(key)
        const full = await f.call('generation.run', { requestId: 'taken-run', input: changed, detail: 'full' })
        expect(full.body).toMatchObject({ stage: 'plan', plan: { status: 'adapter-error', code: 'REQUEST_ID_INPUT_MISMATCH', requestId: 'taken-run-plan' } })
        expect(full.body.plan).not.toHaveProperty('submissionAttempted')

        await f.call('generation.get_run', { requestId: 'taken-read', input: { runId } })
        for (const detail of ['summary', 'full']) {
            const read = await f.call('generation.get_run', { requestId: 'taken-read', input: { runId: 'run-other' }, detail })
            expect(read).toMatchObject({ isError: true, body: { status: 'adapter-error', code: 'REQUEST_ID_INPUT_MISMATCH', requestId: 'taken-read' } })
            for (const key of ['accepted', 'submissionAttempted']) expect(read.body).not.toHaveProperty(key)
        }
        expect([f.published('taken-run-plan'), f.published('taken-read')]).toEqual([1, 1])
    }, 20_000)
})
