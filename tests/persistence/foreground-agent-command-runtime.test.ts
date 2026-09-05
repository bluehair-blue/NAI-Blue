import { webcrypto } from 'node:crypto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ForegroundAgentCommandRuntime } from '@/composition-root/foreground-agent-command-runtime'
import type { NativeAgentCommands, AgentClientRegistration } from '@/adapters/agent/native-agent-commands'
import { WebCryptoAgentAuthentication } from '@/adapters/agent/webcrypto-agent-authentication'
import { IndexedDbCommandReceiptRepository } from '@/adapters/agent/indexeddb-command-receipt-repository'
import { AgentCommandError, agentRequestHash, canonicalAgentSigningPayload, type AgentCommandEnvelope } from '@/application/agent/agent-command-contract'
import { resetIndexedDBConnectionForRetry } from '@/lib/indexed-db'
import { createAgentExecutionCoordinator } from '@/application/agent/agent-execution-coordinator'
import { IndexedDbAgentExecutionRepository } from '@/adapters/agent/indexeddb-agent-execution-repository'
import { DEFAULT_AGENT_EXECUTION_POLICY } from '@/application/agent/agent-execution-policy'
import type { GenerationPlan } from '@/application/generation/generation-plan-contract'
import type { JsonObject } from '@/domain/composition/types'

const runtimes: ForegroundAgentCommandRuntime[] = []
const subtle = webcrypto.subtle as unknown as SubtleCrypto
async function fixture() {
    const key = await subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
    let clients: AgentClientRegistration[] = [{ clientId: 'client-1', keyId: 'key-1', label: 'Local reviewer', actorKind: 'agent', createdAt: new Date().toISOString(), revokedAt: null }]
    const ready = new Map<string, string>()
    const results = new Map<string, unknown>()
    let owner: string | null = null
    const authentication = new WebCryptoAgentAuthentication(async (clientId, keyId) => {
        const client = clients.find(item => item.clientId === clientId && item.keyId === keyId)
        return client ? { ...client, key } : null
    }, subtle)
    const native: NativeAgentCommands = {
        initialize: vi.fn(async () => ({ available: true, workspaceId: 'workspace-1', clients })),
        acquire: vi.fn(async () => { if (owner !== null) return null; owner = 'owner-1'; return owner }),
        release: vi.fn(async () => { owner = null }),
        register: vi.fn(async (label, actorKind) => { const client = { ...clients[0], clientId: 'client-2', label, actorKind }; clients = [...clients, client]; return client }),
        rotate: vi.fn(async clientId => { clients = clients.map(client => client.clientId === clientId ? { ...client, keyId: 'key-2' } : client); return clients[0] }),
        revoke: vi.fn(async clientId => { clients = clients.map(client => client.clientId === clientId ? { ...client, revokedAt: new Date().toISOString() } : client); return clients[0] }),
        list: vi.fn(async () => [...ready.keys()].map(id => `${id}.ready.json`)),
        read: vi.fn(async (_token, id) => ready.get(id)!),
        publish: vi.fn(async (_token, id, serialized) => { results.set(id, JSON.parse(serialized)) }),
        reject: vi.fn(async (_token, id, serialized) => { results.set(id, JSON.parse(serialized)) }),
        retire: vi.fn(async (_token, id) => { ready.delete(id) }),
        authentication: () => authentication,
    }
    const execute = vi.fn(async () => ({ totalDrafts: 0 }))
    const createHandlers = vi.fn(async () => [{ command: 'workspace.get_snapshot' as const, effect: 'read' as const, validate: (input: {}) => input, execute }])
    const createRuntime = (overrides: Partial<ConstructorParameters<typeof ForegroundAgentCommandRuntime>[0]> = {}) => {
        const runtime = new ForegroundAgentCommandRuntime({ native, receipts: new IndexedDbCommandReceiptRepository(), createHandlers, ...overrides })
        runtimes.push(runtime)
        return runtime
    }
    const submit = async (id: string, command: AgentCommandEnvelope['command'] = { name: 'workspace.get_snapshot', input: {} }) => {
        const request: AgentCommandEnvelope = { schemaVersion: 1, requestId: id, requestHash: `sha256:${'0'.repeat(64)}`,
            submittedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
            context: { apiVersion: 'nai-blue.agent/v1alpha1', workspaceId: 'workspace-1', clientId: 'client-1', actor: { kind: 'agent' }, idempotencyKey: id },
            command,
            authentication: { scheme: 'hmac-sha256', keyId: 'key-1', signature: `hmac-sha256:${'0'.repeat(64)}` } }
        const hashed = { ...request, requestHash: agentRequestHash(request) }
        const signature = await subtle.sign('HMAC', key, new TextEncoder().encode(canonicalAgentSigningPayload(hashed)))
        const signed = { ...hashed, authentication: { ...hashed.authentication, signature: `hmac-sha256:${Buffer.from(signature).toString('hex')}` } }
        ready.set(id, JSON.stringify(signed))
    }
    return { native, execute, createHandlers, createRuntime, submit, ready, results }
}

async function executionFixture() {
    const f = await fixture()
    const digest = `sha256:${'a'.repeat(64)}` as const
    const plan = { planId: digest, planHash: digest, jobs: [{ compatibility: { status: 'captured-pass' },
        destination: { collisionPolicy: 'fail' } }], estimatedAnlas: 7, requiredApprovals: [],
        sourceBindings: [{ resourceId: 'draft-1' }], budget: { maxImages: 1, maxAnlas: 7 },
        executionPolicy: { maxConcurrency: 1 } } as unknown as GenerationPlan
    let policy = structuredClone(DEFAULT_AGENT_EXECUTION_POLICY)
    let saving = false
    const listeners = new Set<() => void>()
    const receipts = new IndexedDbCommandReceiptRepository()
    const facts = new Map<string, JsonObject>()
    const enqueue = vi.fn(async (_plan: GenerationPlan, grant: { scopeId: string }) => {
        const batchId = `main-batch-${grant.scopeId}`
        const result = { status: 'ready', batchId, runId: batchId, jobIds: [`main-job-${grant.scopeId}-0`] }
        facts.set(grant.scopeId, result)
        return result
    })
    const persistPolicy = vi.fn(async (expected: number, next: typeof policy) => {
        if (expected !== policy.revision) throw new Error('stale policy')
        policy = { ...next, revision: expected + 1 }
        for (const listener of listeners) listener()
        return policy
    })
    const createRuntime = () => f.createRuntime({ receipts, policy: {
        get: () => policy, set: persistPolicy, isSaving: () => saving,
        subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    }, createExecution: async (workspaceId, isClientAuthorized) => createAgentExecutionCoordinator({
        workspaceId, isClientAuthorized, receipts, repository: new IndexedDbAgentExecutionRepository(),
        plans: { get: async () => plan, putIfAbsent: async () => 'same' }, getPolicy: () => policy,
        ports: { enqueue, validate: async () => true, reconcile: async grant => facts.get(grant.scopeId) ?? null,
            isOutstanding: async () => false },
    }) })
    return { ...f, createRuntime, receipts, enqueue, persistPolicy,
        getPolicy: () => policy, setSaving: (value: boolean) => { saving = value },
        submitEnqueue: (id: string) => f.submit(id, { name: 'generation.enqueue', input: { planId: digest, planHash: digest } }) }
}
beforeEach(() => { resetIndexedDBConnectionForRetry(); vi.stubGlobal('indexedDB', new IDBFactory()) })
afterEach(async () => {
    await Promise.all(runtimes.splice(0).map(runtime => runtime.stop().catch(() => undefined)))
    resetIndexedDBConnectionForRetry(); vi.unstubAllGlobals()
})

describe('foreground native inbox composition', () => {
    it('rechecks pending policy persistence after asynchronous native authentication', async () => {
        const f = await executionFixture()
        const original = f.native.authentication(() => 'owner-1')
        let blocked = false
        let release!: () => void
        let entered!: () => void
        const waiting = new Promise<void>(resolve => { entered = resolve })
        f.native.authentication = () => ({ authenticate: async (...args) => {
            const identity = await original.authenticate(...args)
            if (blocked) {
                entered()
                await new Promise<void>(resolve => { release = resolve })
            }
            return identity
        } })
        const runtime = f.createRuntime()
        await f.submitEnqueue('policy-save-during-auth')
        await runtime.start(Promise.resolve({ inboxReady: true }))
        const [review] = runtime.getSnapshot().pendingApprovals
        blocked = true
        const approving = runtime.decideApproval(review.requestId, 'approve', review)
        await waiting
        f.setSaving(true); release()
        await approving
        f.setSaving(false)
        expect(f.enqueue).not.toHaveBeenCalled()
        expect(f.results.get(review.requestId)).toMatchObject({ state: 'rejected' })
    })

    it('restores retired approval requests, publishes the same receipt on approval, and exposes its Queue batch', async () => {
        const f = await executionFixture()
        await f.submitEnqueue('review-after-restart')
        const runtime = f.createRuntime()
        await runtime.start(Promise.resolve({ inboxReady: true }))
        expect(f.ready.size).toBe(0)
        expect(f.results.get('review-after-restart')).toMatchObject({ state: 'needs-input' })
        expect(runtime.getSnapshot().pendingApprovals).toHaveLength(1)
        await runtime.stop()
        resetIndexedDBConnectionForRetry()
        const reopened = f.createRuntime()
        await reopened.start(Promise.resolve({ inboxReady: true }))
        const [review] = reopened.getSnapshot().pendingApprovals
        await reopened.decideApproval(review.requestId, 'approve', review)
        expect(f.enqueue).toHaveBeenCalledTimes(1)
        expect(f.results.get(review.requestId)).toMatchObject({ state: 'completed', result: { status: 'ready' } })
        expect(reopened.getSnapshot().recent[0].batchId).toMatch(/^main-batch-agent-/)
        expect(reopened.getSnapshot().pendingApprovals).toEqual([])
        await reopened.decideApproval(review.requestId, 'approve', review)
        expect(f.enqueue).toHaveBeenCalledTimes(1)
    })

    it('recovers a failed approval projection without another Queue write', async () => {
        const f = await executionFixture(); const runtime = f.createRuntime()
        await f.submitEnqueue('approval-projection')
        await runtime.start(Promise.resolve({ inboxReady: true }))
        const [review] = runtime.getSnapshot().pendingApprovals
        vi.mocked(f.native.publish).mockRejectedValueOnce(new Error('projection failed'))
        await expect(runtime.decideApproval(review.requestId, 'approve', review)).rejects.toThrow('projection failed')
        expect(runtime.getSnapshot().status).toBe('app-unavailable')
        expect(f.enqueue).toHaveBeenCalledTimes(1)
        await runtime.start()
        expect(f.results.get(review.requestId)).toMatchObject({ state: 'completed' })
        expect(f.enqueue).toHaveBeenCalledTimes(1)
    })

    it('gates dispatch while policy persistence is pending and refreshes capabilities when policy changes', async () => {
        const f = await executionFixture(); const runtime = f.createRuntime()
        await runtime.start(Promise.resolve({ inboxReady: true }))
        let finish!: () => void
        f.persistPolicy.mockImplementationOnce(async (revision, next) => {
            f.setSaving(true)
            await new Promise<void>(resolve => { finish = resolve })
            f.setSaving(false)
            return { ...next, revision: revision + 1 }
        })
        const changing = runtime.changePolicy(0, f.getPolicy())
        await vi.waitFor(() => expect(f.persistPolicy).toHaveBeenCalled())
        await f.submitEnqueue('during-policy-save'); await runtime.poll()
        expect(f.ready.has('during-policy-save')).toBe(true)
        expect(runtime.getSnapshot().changingExecution).toBe(true)
        await expect(runtime.changeClient('rotate', 'client-1')).rejects.toThrow()
        finish(); await changing
        await runtime.changePolicy(0, { ...f.getPolicy(), mode: 'observe' })
        expect(runtime.getSnapshot().capabilities.find(item => item.command === 'generation.enqueue')?.available).toBe(false)
        expect(runtime.getSnapshot().capabilities.find(item => item.command === 'workspace.get_snapshot')?.available).toBe(true)
        await runtime.poll()
        expect(f.enqueue).not.toHaveBeenCalled()
    })

    it('stop waits for a local decision and prevents an enqueue whose final authentication crossed stop', async () => {
        const f = await executionFixture(); const runtime = f.createRuntime()
        await f.submitEnqueue('stop-before-approval')
        await runtime.start(Promise.resolve({ inboxReady: true }))
        const [review] = runtime.getSnapshot().pendingApprovals
        const deciding = runtime.decideApproval(review.requestId, 'approve', review)
        const stopped = runtime.stop()
        await expect(deciding).rejects.toThrow('Agent inbox stopped')
        await stopped
        expect(f.enqueue).not.toHaveBeenCalled()
        expect(runtime.getSnapshot().status).toBe('stopped')
    })

    it('retires rejected oversized and invalid-encoding files and continues with a valid request', async () => {
        const f = await fixture()
        f.ready.set('oversized', 'native bounded read fixture')
        f.ready.set('invalid-encoding', 'native encoding fixture')
        await f.submit('valid-after-rejections')
        const read = f.native.read
        f.native.read = vi.fn(async (token, id, max) => {
            if (id === 'oversized') throw new AgentCommandError('REQUEST_TOO_LARGE')
            if (id === 'invalid-encoding') throw new AgentCommandError('INVALID_ENVELOPE')
            return read(token, id, max)
        })
        const runtime = f.createRuntime()
        await runtime.start(Promise.resolve({ inboxReady: true }))
        expect(runtime.getSnapshot().status).toBe('ready')
        expect(f.results.get('oversized')).toEqual({ accepted: false, code: 'REQUEST_TOO_LARGE' })
        expect(f.results.get('invalid-encoding')).toEqual({ accepted: false, code: 'INVALID_ENVELOPE' })
        expect(f.results.get('valid-after-rejections')).toMatchObject({ state: 'completed' })
        expect(f.ready.size).toBe(0)
        expect(f.execute).toHaveBeenCalledTimes(1)
    })

    it('stops the initial scan immediately after in-flight work and serializes resume behind owner cleanup', async () => {
        const f = await fixture(); const runtime = f.createRuntime()
        let finishHandler!: () => void
        const handlerGate = new Promise<void>(resolve => { finishHandler = resolve })
        f.execute.mockImplementationOnce(async () => { await handlerGate; return { totalDrafts: 0 } })
        await f.submit('first-on-start'); await f.submit('second-on-start')
        const starting = runtime.start(Promise.resolve({ inboxReady: true }))
        await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1))
        let finishRelease!: () => void
        const releaseGate = new Promise<void>(resolve => { finishRelease = resolve })
        const originalRelease = f.native.release
        f.native.release = vi.fn(async token => { await releaseGate; await originalRelease(token) })
        const stopping = runtime.stop()
        expect(runtime.getSnapshot().status).toBe('stopping')
        const resuming = runtime.start()
        finishHandler(); await starting
        expect(f.execute).toHaveBeenCalledTimes(1)
        expect(f.native.acquire).toHaveBeenCalledTimes(1)
        finishRelease(); await stopping; await resuming
        expect(f.native.acquire).toHaveBeenCalledTimes(2)
        expect(f.execute).toHaveBeenCalledTimes(2)
        expect(runtime.getSnapshot().status).toBe('ready')
    })

    it('waits for successful recovery before hydration/ownership and rejects both resolved and thrown failures', async () => {
        const f = await fixture()
        let release!: (value: { inboxReady: boolean }) => void
        const recovery = new Promise<{ inboxReady: boolean }>(resolve => { release = resolve })
        const runtime = f.createRuntime()
        const starting = runtime.start(recovery)
        await vi.waitFor(() => expect(f.native.initialize).toHaveBeenCalled())
        expect(f.createHandlers).not.toHaveBeenCalled(); expect(f.native.acquire).not.toHaveBeenCalled()
        expect(runtime.getSnapshot().capabilities.every(item => !item.available)).toBe(true)
        release({ inboxReady: false }); await starting
        expect(runtime.getSnapshot().status).toBe('app-unavailable')
        expect(f.native.list).not.toHaveBeenCalled()
        await f.createRuntime().start(Promise.reject(new Error('recovery failed')))
        expect(f.native.acquire).not.toHaveBeenCalled()
    })
    it('processes separate requests, projects the dispatcher registry and preserves stop/resume ownership', async () => {
        const f = await fixture(); const runtime = f.createRuntime()
        await f.submit('first'); await f.submit('second')
        await runtime.start(Promise.resolve({ inboxReady: true }))
        expect(runtime.getSnapshot().status).toBe('ready')
        expect(f.execute).toHaveBeenCalledTimes(2); expect(f.results.size).toBe(2); expect(f.ready.size).toBe(0)
        expect(runtime.getSnapshot().capabilities.find(item => item.command === 'workspace.get_snapshot')?.available).toBe(true)
        expect(runtime.getSnapshot().capabilities.find(item => item.command === 'generation.enqueue')?.available).toBe(false)
        await runtime.stop()
        expect(runtime.getSnapshot().capabilities.every(item => !item.available)).toBe(true)
        await runtime.start()
        expect(runtime.getSnapshot().status).toBe('ready'); expect(f.execute).toHaveBeenCalledTimes(2)
        expect(f.native.acquire).toHaveBeenCalledTimes(2)
    })
    it('recovers failed publication through an exact saved receipt without entering the handler twice', async () => {
        const f = await fixture(); await f.submit('durable-result')
        vi.mocked(f.native.publish).mockRejectedValueOnce(new Error('disk failed'))
        const runtime = f.createRuntime(); await runtime.start(Promise.resolve({ inboxReady: true }))
        expect(runtime.getSnapshot().status).toBe('app-unavailable'); expect(f.execute).toHaveBeenCalledTimes(1)
        expect(f.native.reject).not.toHaveBeenCalled(); expect(f.ready.has('durable-result')).toBe(true)
        resetIndexedDBConnectionForRetry()
        const reopened = f.createRuntime(); await reopened.start(Promise.resolve({ inboxReady: true }))
        expect(reopened.getSnapshot().status).toBe('ready')
        expect(f.results.get('durable-result')).toMatchObject({ state: 'completed' })
        expect(f.execute).toHaveBeenCalledTimes(1)
    })
    it('drains in-flight planning before a human revokes the client and rejects subsequent signed requests', async () => {
        const f = await fixture(); const runtime = f.createRuntime()
        await runtime.start(Promise.resolve({ inboxReady: true }))
        let release!: () => void
        const pending = new Promise<void>(resolve => { release = resolve })
        f.execute.mockImplementationOnce(async () => { await pending; return { totalDrafts: 0 } })
        await f.submit('inflight'); const polling = runtime.poll()
        await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1))
        const revoking = runtime.changeClient('revoke', 'client-1')
        expect(f.native.revoke).not.toHaveBeenCalled()
        release(); await polling; await revoking
        expect(f.native.revoke).toHaveBeenCalledTimes(1)
        await f.submit('after-revoke'); await runtime.poll()
        expect(f.results.get('after-revoke')).toMatchObject({ accepted: false, code: 'AUTHENTICATION_FAILED' })
        expect(f.execute).toHaveBeenCalledTimes(1)
    })
    it('fails closed before processing when another owner is present or native initialization fails', async () => {
        const f = await fixture(); vi.mocked(f.native.acquire).mockResolvedValueOnce(null)
        const runtime = f.createRuntime(); await runtime.start(Promise.resolve({ inboxReady: true }))
        expect(runtime.getSnapshot().status).toBe('busy'); expect(f.native.list).not.toHaveBeenCalled()
        vi.mocked(f.native.initialize).mockRejectedValueOnce(new Error('ACL is not private'))
        const denied = f.createRuntime(); await denied.start(Promise.resolve({ inboxReady: true }))
        expect(denied.getSnapshot().status).toBe('app-unavailable'); expect(f.execute).not.toHaveBeenCalled()
    })
})
