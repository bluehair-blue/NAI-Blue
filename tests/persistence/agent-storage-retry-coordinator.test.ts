import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IndexedDbAgentExecutionRepository } from '@/adapters/agent/indexeddb-agent-execution-repository'
import { IndexedDbCommandReceiptRepository } from '@/adapters/agent/indexeddb-command-receipt-repository'
import { AgentCommandDispatcher } from '@/application/agent/agent-command-dispatcher'
import { agentRequestHash, type AgentCommandEnvelope } from '@/application/agent/agent-command-contract'
import { createAgentExecutionCoordinator, type AgentExecutionCoordinatorOptions, type AgentStorageRetryReview } from '@/application/agent/agent-execution-coordinator'
import { DEFAULT_AGENT_EXECUTION_POLICY } from '@/application/agent/agent-execution-policy'
import { parseAgentExecutionLedger } from '@/application/agent/agent-execution-repository'
import type { AgentStorageRetryGrant, AgentStorageRetryResult, AgentStorageRetryTarget } from '@/application/agent/agent-storage-retry-contract'
import { resetIndexedDBConnectionForRetry, setIndexedDBItemStrict } from '@/lib/indexed-db'

const scope = 'dbe4f2d96161f10b48104a1522e7269abfb8a16ee223c7514912b5c8afc282d2'
const digest = `sha256:${scope}` as const
function fixture() {
    let time = '2026-09-06T00:00:01.000Z'
    let authorized = true
    const policy = structuredClone(DEFAULT_AGENT_EXECUTION_POLICY)
    let target: AgentStorageRetryTarget | null = { runId: `main-batch-agent-${scope}`, batchId: `main-batch-agent-${scope}`,
        jobId: `main-job-agent-${scope}-0`, artifactId: `artifact:main-job-agent-${scope}-0`,
        outputTransactionId: `queue-${scope.slice(0, 48)}`, targetHash: digest }
    const facts = new Map<string, AgentStorageRetryResult>()
    const receipts = new IndexedDbCommandReceiptRepository()
    const repository = new IndexedDbAgentExecutionRepository()
    const retry = vi.fn(async (value: AgentStorageRetryTarget, _grant: AgentStorageRetryGrant): Promise<AgentStorageRetryResult> => {
        const result = { status: 'storage-registered' as const, runId: value.runId, batchId: value.batchId, jobId: value.jobId, artifactId: value.artifactId }
        facts.set(value.targetHash, result)
        return result
    })
    const reconcile = vi.fn(async (grant: AgentStorageRetryGrant) => facts.get(grant.target.targetHash) ?? null)
    const options: AgentExecutionCoordinatorOptions = { workspaceId: 'workspace-1', receipts, repository,
        plans: { get: async () => null, putIfAbsent: async () => 'same' }, getPolicy: () => policy, now: () => time,
        isClientAuthorized: async () => authorized,
        ports: { validate: async () => true, enqueue: vi.fn(), reconcile: vi.fn() },
        storageRetry: { inspect: async () => target === null ? null : structuredClone(target), retry, reconcile } }
    function reopen() {
        const coordinator = createAgentExecutionCoordinator(options)
        const dispatcher = new AgentCommandDispatcher({ workspaceId: 'workspace-1', receipts,
            handlers: [coordinator.handler, coordinator.storageRetryHandler!], now: () => time,
            runtime: () => ({ ready: true, mode: policy.mode, globalPause: policy.globalPause }),
            authentication: { authenticate: async envelope => ({ clientId: envelope.context.clientId, actor: { kind: envelope.context.actor.kind, id: `client:${envelope.context.clientId}` } }) } })
        return { coordinator, dispatcher }
    }
    function request(requestId = 'storage-1'): AgentCommandEnvelope {
        const envelope: AgentCommandEnvelope = { schemaVersion: 1, requestId, requestHash: digest,
            submittedAt: '2026-09-06T00:00:00.000Z', expiresAt: '2026-09-06T01:00:00.000Z',
            context: { apiVersion: 'nai-blue.agent/v1alpha1', workspaceId: 'workspace-1', clientId: 'client-1', actor: { kind: 'service' }, idempotencyKey: requestId },
            command: { name: 'generation.retry_storage', input: { runId: `main-batch-agent-${scope}`, jobId: `main-job-agent-${scope}-0` } },
            authentication: { scheme: 'hmac-sha256', keyId: 'key-1', signature: `hmac-sha256:${'0'.repeat(64)}` } }
        return { ...envelope, requestHash: agentRequestHash(envelope) }
    }
    return { ...reopen(), reopen, options, policy, receipts, repository, retry, reconcile, facts, request,
        review: async (coordinator: ReturnType<typeof createAgentExecutionCoordinator>) => (await coordinator.pending())[0] as AgentStorageRetryReview,
        target: () => structuredClone(target!), setTarget: (value: AgentStorageRetryTarget | null) => { target = value },
        setTime: (value: string) => { time = value }, revoke: () => { authorized = false } }
}
beforeEach(() => { resetIndexedDBConnectionForRetry(); vi.stubGlobal('indexedDB', new IDBFactory()) })
afterEach(() => { resetIndexedDBConnectionForRetry(); vi.unstubAllGlobals() })

describe('durable targeted files-committed registration authority', () => {
    it.each(['suggest', 'bounded-auto', 'paused'] as const)('requires exactly one human approval in %s and preserves the exact native-shaped target', async mode => {
        const f = fixture()
        if (mode === 'bounded-auto') Object.assign(f.policy, { mode, boundedAutoExpiresAt: '2026-09-06T00:30:00.000Z' })
        if (mode === 'paused') Object.assign(f.policy, { globalPause: true })
        expect(f.dispatcher.capabilities().find(item => item.command === 'generation.retry_storage')).toMatchObject({ available: true, requiresHumanApproval: true })
        const envelope = f.request()
        expect(await f.dispatcher.dispatch(envelope)).toMatchObject({ state: 'needs-input', result: { code: 'AGENT_APPROVAL_REQUIRED' } })
        expect(f.retry).not.toHaveBeenCalled()
        const reopened = f.reopen()
        const review = await f.review(reopened.coordinator)
        expect(review).toMatchObject({ command: 'generation.retry_storage', runId: f.target().runId, jobId: f.target().jobId, artifactId: f.target().artifactId })
        expect(review).not.toHaveProperty('estimatedAnlas')
        await Promise.all([reopened.coordinator.approve(envelope.requestId, review), reopened.coordinator.approve(envelope.requestId, review)])
        expect(f.retry).toHaveBeenCalledTimes(1)
        expect(f.retry.mock.calls[0][1]).toMatchObject({ actorKind: 'service', authorization: 'human', target: f.target(), expiresAt: envelope.expiresAt })
        expect(await reopened.dispatcher.dispatch(envelope)).toMatchObject({ state: 'completed', result: { status: 'storage-registered', artifactId: f.target().artifactId } })
        expect((await f.repository.get('workspace-1'))!.records[0]).not.toHaveProperty('exposureSettledAt')
    })

    it('keeps observe and absent registration closed without reserving authority', async () => {
        const f = fixture()
        expect(createAgentExecutionCoordinator({ ...f.options, storageRetry: undefined }).storageRetryHandler).toBeUndefined()
        Object.assign(f.policy, { mode: 'observe' })
        expect(await f.dispatcher.dispatch(f.request())).toMatchObject({ state: 'needs-input', result: { code: 'observe-only' } })
        expect(await f.repository.get('workspace-1')).toBeNull()
        expect(f.retry).not.toHaveBeenCalled()
    })

    it.each([{ force: true }, { jobId: '' }, { jobId: 'C:\\private\\file' }])('rejects malformed input before receipt claim: %j', override => {
        const f = fixture()
        const envelope = f.request()
        Object.assign(envelope.command.input, override)
        return expect(f.dispatcher.dispatch(envelope)).rejects.toBeDefined()
    })

    it.each(['job', 'transaction', 'artifact', 'hash', 'unavailable', 'expiry', 'revoked', 'observe'] as const)('blocks stale %s before the storage call', async change => {
        const f = fixture()
        await f.dispatcher.dispatch(f.request())
        const review = await f.review(f.coordinator)
        if (change === 'job') f.setTarget({ ...f.target(), jobId: 'other-job' })
        if (change === 'transaction') f.setTarget({ ...f.target(), outputTransactionId: 'other-transaction' })
        if (change === 'artifact') f.setTarget({ ...f.target(), artifactId: 'other-artifact' })
        if (change === 'hash') f.setTarget({ ...f.target(), targetHash: `sha256:${'b'.repeat(64)}` })
        if (change === 'unavailable') f.setTarget(null)
        if (change === 'expiry') f.setTime('2026-09-06T01:00:00.000Z')
        if (change === 'revoked') f.revoke()
        if (change === 'observe') Object.assign(f.policy, { mode: 'observe' })
        await f.coordinator.approve('storage-1', review)
        expect(f.retry).not.toHaveBeenCalled()
        expect(await f.receipts.get('storage-1')).toMatchObject({ state: 'rejected' })
    })

    it('binds approval to job and policy revision and refreshes review while paused', async () => {
        const f = fixture()
        await f.dispatcher.dispatch(f.request())
        const old = await f.review(f.coordinator)
        await expect(f.coordinator.approve('storage-1', { ...old, jobId: 'other-job' })).rejects.toMatchObject({ code: 'AGENT_APPROVAL_BINDING_CHANGED' })
        Object.assign(f.policy, { revision: 1, globalPause: true })
        await f.coordinator.approve('storage-1', old)
        expect(f.retry).not.toHaveBeenCalled()
        await expect(f.coordinator.approve('storage-1', old)).rejects.toMatchObject({ code: 'AGENT_APPROVAL_BINDING_CHANGED' })
        await f.coordinator.approve('storage-1', await f.review(f.coordinator))
        expect(f.retry).toHaveBeenCalledTimes(1)
    })

    it('rechecks client authorization after the durable grant has committed', async () => {
        const f = fixture()
        const cas = f.repository.compareAndSet.bind(f.repository)
        vi.spyOn(f.repository, 'compareAndSet').mockImplementation(async (expected, next) => {
            const saved = await cas(expected, next)
            if (saved && next.records.some(item => item.state === 'reserved')) f.revoke()
            return saved
        })
        await f.dispatcher.dispatch(f.request())
        await f.coordinator.approve('storage-1', await f.review(f.coordinator))
        expect(f.retry).not.toHaveBeenCalled()
        expect(await f.receipts.get('storage-1')).toMatchObject({ state: 'rejected', result: { code: 'AGENT_AUTHORITY_CHANGED' } })
    })

    it.each([true, false])('reconciles exact completion=%s without a second storage retry after unknown', async hasFacts => {
        const f = fixture()
        const original = f.retry.getMockImplementation()!
        f.retry.mockImplementation(async (target, grant) => { if (hasFacts) await original(target, grant); throw new Error('response lost') })
        await f.dispatcher.dispatch(f.request())
        await f.coordinator.approve('storage-1', await f.review(f.coordinator))
        await f.reopen().coordinator.recover()
        expect(await f.receipts.get('storage-1')).toMatchObject({ state: hasFacts ? 'completed' : 'needs-input',
            result: hasFacts ? { status: 'storage-registered' } : { code: 'AGENT_EXECUTION_UNKNOWN' } })
        await f.reopen().coordinator.recover()
        expect(f.retry).toHaveBeenCalledTimes(1)
    })

    it('refuses mismatched Artifact completion evidence and never promotes an orphan accepted receipt', async () => {
        const f = fixture()
        f.retry.mockImplementation(async target => ({ status: 'storage-registered', runId: target.runId, batchId: target.batchId, jobId: target.jobId, artifactId: 'other-artifact' }))
        await f.dispatcher.dispatch(f.request())
        await f.coordinator.approve('storage-1', await f.review(f.coordinator))
        expect(await f.receipts.get('storage-1')).toMatchObject({ state: 'needs-input', result: { code: 'AGENT_EXECUTION_UNKNOWN' } })
        const envelope = f.request('orphan')
        await f.receipts.claim({ schemaVersion: 1, requestId: envelope.requestId, requestHash: envelope.requestHash,
            authenticatedClientId: 'client-1', command: 'generation.retry_storage', state: 'accepted', observedAt: '2026-09-06T00:00:01.000Z',
            resultSchemaVersion: 1, result: null, resultDigest: null })
        expect(await f.dispatcher.dispatch(envelope)).toMatchObject({ state: 'accepted' })
        await f.coordinator.recover()
        expect(await f.coordinator.pending()).toEqual([])
        expect(f.retry).toHaveBeenCalledTimes(1)
    })

    it('repairs receipt publication from the saved completion without replaying storage', async () => {
        const f = fixture()
        await f.dispatcher.dispatch(f.request())
        const finish = f.receipts.finish.bind(f.receipts)
        vi.spyOn(f.receipts, 'finish').mockImplementationOnce(async () => { throw new Error('receipt I/O failed') }).mockImplementation(finish)
        await expect(f.coordinator.approve('storage-1', await f.review(f.coordinator))).rejects.toThrow('receipt I/O failed')
        await f.reopen().coordinator.recover()
        expect(f.retry).toHaveBeenCalledTimes(1)
        expect(await f.receipts.get('storage-1')).toMatchObject({ state: 'completed' })
    })

    it('keeps operation idempotency and strict persisted grant parsing', async () => {
        const f = fixture()
        await f.dispatcher.dispatch(f.request())
        const duplicate = f.request('another-request')
        duplicate.context.idempotencyKey = 'storage-1'; duplicate.requestHash = agentRequestHash(duplicate)
        expect(await f.dispatcher.dispatch(duplicate)).toMatchObject({ state: 'rejected', result: { code: 'AGENT_IDEMPOTENCY_CONFLICT' } })
        await f.coordinator.approve('storage-1', await f.review(f.coordinator))
        const ledger = (await f.repository.get('workspace-1'))!
        expect(parseAgentExecutionLedger(ledger, 'workspace-1')).toEqual(ledger)
        Object.assign(ledger.records[0].grant!, { authorization: 'bounded-auto' })
        await setIndexedDBItemStrict('nai-blue-agent-execution:workspace-1', JSON.stringify(ledger))
        await expect(f.coordinator.recover()).rejects.toMatchObject({ code: 'INVALID_EXECUTION_STORE' })
        expect(f.retry).toHaveBeenCalledTimes(1)
    })
})
