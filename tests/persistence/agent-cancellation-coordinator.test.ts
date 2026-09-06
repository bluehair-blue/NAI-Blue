import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IndexedDbAgentExecutionRepository } from '@/adapters/agent/indexeddb-agent-execution-repository'
import { IndexedDbCommandReceiptRepository } from '@/adapters/agent/indexeddb-command-receipt-repository'
import { AgentCommandDispatcher } from '@/application/agent/agent-command-dispatcher'
import { agentRequestHash, type AgentCommandEnvelope } from '@/application/agent/agent-command-contract'
import { agentCancellationMarker, type AgentCancellationGrant, type AgentCancellationTarget } from '@/application/agent/agent-cancellation-contract'
import { createAgentExecutionCoordinator, type AgentCancellationReview, type AgentExecutionCoordinatorOptions } from '@/application/agent/agent-execution-coordinator'
import { DEFAULT_AGENT_EXECUTION_POLICY } from '@/application/agent/agent-execution-policy'
import { parseAgentExecutionLedger } from '@/application/agent/agent-execution-repository'
import { resetIndexedDBConnectionForRetry, setIndexedDBItemStrict } from '@/lib/indexed-db'

const digest = `sha256:${'a'.repeat(64)}` as const
function fixture() {
    let time = '2026-09-05T00:00:01.000Z'
    let authorized = true
    const policy = structuredClone(DEFAULT_AGENT_EXECUTION_POLICY)
    let target: AgentCancellationTarget | null = { runId: 'main-batch-1', batchId: 'main-batch-1', jobIds: ['job-1', 'job-2'], targetHash: digest, previouslyStoppedJobIds: [] }
    const facts = new Map<string, { status: 'cancel-requested'; runId: string; batchId: string; jobIds: readonly string[] }>()
    const receipts = new IndexedDbCommandReceiptRepository()
    const repository = new IndexedDbAgentExecutionRepository()
    const cancel = vi.fn(async (scope: AgentCancellationTarget, grant: AgentCancellationGrant) => {
        const result = { status: 'cancel-requested' as const, runId: scope.runId, batchId: scope.batchId, jobIds: scope.jobIds }
        facts.set(agentCancellationMarker(grant), result)
        return result
    })
    const reconcile = vi.fn(async (grant: AgentCancellationGrant) => facts.get(agentCancellationMarker(grant)) ?? null)
    const options: AgentExecutionCoordinatorOptions = { workspaceId: 'workspace-1', receipts, repository,
        plans: { get: async () => null, putIfAbsent: async () => 'same' }, getPolicy: () => policy, now: () => time,
        isClientAuthorized: async () => authorized,
        ports: { validate: async () => true, enqueue: vi.fn(), reconcile: vi.fn() },
        cancellation: { inspect: async () => target === null ? null : structuredClone(target), cancel, reconcile } }
    const reopen = () => {
        const coordinator = createAgentExecutionCoordinator(options)
        const dispatcher = new AgentCommandDispatcher({ workspaceId: 'workspace-1', receipts,
            handlers: [coordinator.handler, coordinator.cancelHandler!], now: () => time,
            runtime: () => ({ ready: true, mode: policy.mode, globalPause: policy.globalPause }),
            authentication: { authenticate: async envelope => ({ clientId: envelope.context.clientId, actor: { kind: envelope.context.actor.kind, id: `client:${envelope.context.clientId}` } }) } })
        return { coordinator, dispatcher }
    }
    const request = (requestId = 'cancel-1'): AgentCommandEnvelope => {
        const envelope: AgentCommandEnvelope = { schemaVersion: 1, requestId, requestHash: digest,
            submittedAt: '2026-09-05T00:00:00.000Z', expiresAt: '2026-09-05T01:00:00.000Z',
            context: { apiVersion: 'nai-blue.agent/v1alpha1', workspaceId: 'workspace-1', clientId: 'client-1', actor: { kind: 'service' }, idempotencyKey: requestId },
            command: { name: 'generation.cancel', input: { runId: 'main-batch-1' } },
            authentication: { scheme: 'hmac-sha256', keyId: 'key-1', signature: `hmac-sha256:${'0'.repeat(64)}` } }
        return { ...envelope, requestHash: agentRequestHash(envelope) }
    }
    return { ...reopen(), reopen, options, policy, receipts, repository, cancel, reconcile, facts, request,
        review: async (coordinator: ReturnType<typeof createAgentExecutionCoordinator>) => (await coordinator.pending())[0] as AgentCancellationReview,
        setTarget: (value: AgentCancellationTarget | null) => { target = value }, target: () => structuredClone(target!),
        setTime: (value: string) => { time = value }, revoke: () => { authorized = false } }
}
beforeEach(() => { resetIndexedDBConnectionForRetry(); vi.stubGlobal('indexedDB', new IDBFactory()) })
afterEach(() => { resetIndexedDBConnectionForRetry(); vi.unstubAllGlobals() })

describe('durable whole-batch agent cancellation', () => {
    it.each(['suggest', 'bounded-auto', 'paused'] as const)('requires one human approval in %s and replays without another cancel', async mode => {
        const f = fixture()
        if (mode === 'bounded-auto') Object.assign(f.policy, { mode, boundedAutoExpiresAt: '2026-09-05T00:30:00.000Z' })
        if (mode === 'paused') Object.assign(f.policy, { globalPause: true })
        expect(f.dispatcher.capabilities().find(item => item.command === 'generation.cancel')).toMatchObject({ available: true, requiresHumanApproval: true })
        const request = f.request()
        expect(await f.dispatcher.dispatch(request)).toMatchObject({ state: 'needs-input', result: { code: 'AGENT_APPROVAL_REQUIRED' } })
        expect(f.cancel).not.toHaveBeenCalled()
        const reopened = f.reopen()
        const review = await f.review(reopened.coordinator)
        expect(review).toMatchObject({ command: 'generation.cancel', runId: 'main-batch-1', jobCount: 2, jobIds: ['job-1', 'job-2'] })
        expect(review).not.toHaveProperty('estimatedAnlas')
        await Promise.all([reopened.coordinator.approve(request.requestId, review), reopened.coordinator.approve(request.requestId, review)])
        expect(f.cancel).toHaveBeenCalledTimes(1)
        expect(await reopened.dispatcher.dispatch(request)).toMatchObject({ state: 'completed', result: { status: 'cancel-requested', runId: 'main-batch-1' } })
        const record = (await f.repository.get('workspace-1'))!.records[0]
        expect(record).not.toHaveProperty('exposureSettledAt')
        expect(record.grant).toMatchObject({ actorKind: 'service', authorization: 'human', expiresAt: request.expiresAt })
    })

    it('keeps observe, opt-in registration and malformed inputs closed', async () => {
        const f = fixture()
        expect(createAgentExecutionCoordinator({ ...f.options, cancellation: undefined }).cancelHandler).toBeUndefined()
        Object.assign(f.policy, { mode: 'observe' })
        expect(await f.dispatcher.dispatch(f.request())).toMatchObject({ state: 'needs-input', result: { code: 'observe-only' } })
        expect(await f.repository.get('workspace-1')).toBeNull()
        Object.assign(f.policy, { mode: 'suggest' })
        const envelope = f.request('invalid')
        envelope.command.input.force = true
        envelope.requestHash = agentRequestHash(envelope)
        await expect(f.dispatcher.dispatch(envelope)).rejects.toMatchObject({ code: 'INVALID_COMMAND_INPUT' })
        expect(f.cancel).not.toHaveBeenCalled()
    })

    it('captures newly stopped jobs at consent without rebinding immutable target membership', async () => {
        const f = fixture()
        await f.dispatcher.dispatch(f.request())
        const review = await f.review(f.coordinator)
        f.setTarget({ ...f.target(), previouslyStoppedJobIds: ['job-1'] })
        await f.coordinator.approve('cancel-1', review)
        expect(f.cancel.mock.calls[0][1].target.previouslyStoppedJobIds).toEqual(['job-1'])
    })

    it.each(['target', 'binding', 'expiry', 'revoked', 'observe'] as const)('prevents cancellation after %s changes', async change => {
        const f = fixture()
        await f.dispatcher.dispatch(f.request())
        const review = await f.review(f.coordinator)
        if (change === 'target') f.setTarget({ ...f.target(), jobIds: ['job-3'] })
        if (change === 'binding') Object.assign(review, { targetHash: `sha256:${'b'.repeat(64)}` })
        if (change === 'expiry') f.setTime('2026-09-05T01:00:00.000Z')
        if (change === 'revoked') f.revoke()
        if (change === 'observe') Object.assign(f.policy, { mode: 'observe' })
        if (change === 'binding') await expect(f.coordinator.approve('cancel-1', review)).rejects.toMatchObject({ code: 'AGENT_APPROVAL_BINDING_CHANGED' })
        else await f.coordinator.approve('cancel-1', review)
        expect(f.cancel).not.toHaveBeenCalled()
    })

    it('refreshes policy binding under global pause before accepting the next human decision', async () => {
        const f = fixture()
        await f.dispatcher.dispatch(f.request())
        const old = await f.review(f.coordinator)
        Object.assign(f.policy, { revision: 1, globalPause: true })
        await f.coordinator.approve('cancel-1', old)
        expect(f.cancel).not.toHaveBeenCalled()
        await expect(f.coordinator.approve('cancel-1', old)).rejects.toMatchObject({ code: 'AGENT_APPROVAL_BINDING_CHANGED' })
        await f.coordinator.approve('cancel-1', await f.review(f.coordinator))
        expect(f.cancel).toHaveBeenCalledTimes(1)
    })

    it('shares operation key history and rejects changed envelopes while preserving the original receipt', async () => {
        const f = fixture()
        await f.dispatcher.dispatch(f.request())
        const duplicate = f.request('another-request')
        duplicate.context.idempotencyKey = 'cancel-1'; duplicate.requestHash = agentRequestHash(duplicate)
        expect(await f.dispatcher.dispatch(duplicate)).toMatchObject({ state: 'rejected', result: { code: 'AGENT_IDEMPOTENCY_CONFLICT' } })
        const changed = f.request()
        changed.command.input.runId = 'other-run'; changed.requestHash = agentRequestHash(changed)
        await expect(f.dispatcher.dispatch(changed)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
        expect((await f.repository.get('workspace-1'))!.records).toHaveLength(1)
    })

    it.each([true, false])('recovers exact durable evidence=%s without re-entering cancel', async hasFacts => {
        const f = fixture()
        const original = f.cancel.getMockImplementation()!
        f.cancel.mockImplementation(async (target, grant) => { if (hasFacts) await original(target, grant); throw new Error('commit response lost') })
        await f.dispatcher.dispatch(f.request())
        await f.coordinator.approve('cancel-1', await f.review(f.coordinator))
        const reopened = f.reopen()
        await reopened.coordinator.recover()
        expect(f.cancel).toHaveBeenCalledTimes(1)
        expect(await f.receipts.get('cancel-1')).toMatchObject({ state: hasFacts ? 'completed' : 'needs-input',
            result: hasFacts ? { status: 'cancel-requested' } : { code: 'AGENT_EXECUTION_UNKNOWN' } })
        await reopened.coordinator.recover()
        expect(f.cancel).toHaveBeenCalledTimes(1)
    })

    it('does not accept partial or mismatched result evidence', async () => {
        const f = fixture()
        f.cancel.mockImplementation(async target => ({ status: 'cancel-requested', runId: target.runId, batchId: target.batchId, jobIds: ['job-1'] }))
        await f.dispatcher.dispatch(f.request())
        await f.coordinator.approve('cancel-1', await f.review(f.coordinator))
        expect(await f.receipts.get('cancel-1')).toMatchObject({ state: 'needs-input', result: { code: 'AGENT_EXECUTION_UNKNOWN' } })
    })

    it('checks client authority again after committing the grant', async () => {
        const f = fixture()
        const cas = f.repository.compareAndSet.bind(f.repository)
        vi.spyOn(f.repository, 'compareAndSet').mockImplementation(async (expected, next) => {
            const saved = await cas(expected, next)
            if (saved && next.records.some(item => item.state === 'reserved')) f.revoke()
            return saved
        })
        await f.dispatcher.dispatch(f.request())
        await f.coordinator.approve('cancel-1', await f.review(f.coordinator))
        expect(f.cancel).not.toHaveBeenCalled()
        expect(await f.receipts.get('cancel-1')).toMatchObject({ state: 'rejected', result: { code: 'AGENT_AUTHORITY_CHANGED' } })
    })

    it('repairs a lost completed receipt from the saved cancel result without another mutation', async () => {
        const f = fixture()
        await f.dispatcher.dispatch(f.request())
        const finish = f.receipts.finish.bind(f.receipts)
        vi.spyOn(f.receipts, 'finish').mockImplementationOnce(async () => { throw new Error('receipt I/O failed') }).mockImplementation(finish)
        await expect(f.coordinator.approve('cancel-1', await f.review(f.coordinator))).rejects.toThrow('receipt I/O failed')
        await f.reopen().coordinator.recover()
        expect(f.cancel).toHaveBeenCalledTimes(1)
        expect(await f.receipts.get('cancel-1')).toMatchObject({ state: 'completed', result: { status: 'cancel-requested' } })
    })

    it('never promotes an orphan accepted receipt into cancellation authority', async () => {
        const f = fixture()
        const envelope = f.request()
        await f.receipts.claim({ schemaVersion: 1, requestId: envelope.requestId, requestHash: envelope.requestHash,
            authenticatedClientId: 'client-1', command: 'generation.cancel', state: 'accepted', observedAt: '2026-09-05T00:00:01.000Z',
            resultSchemaVersion: 1, result: null, resultDigest: null })
        expect(await f.dispatcher.dispatch(envelope)).toMatchObject({ state: 'accepted' })
        await f.coordinator.recover()
        expect(await f.coordinator.pending()).toEqual([])
        expect(f.cancel).not.toHaveBeenCalled()
    })

    it('validates the persisted cancellation grant and never resets corrupted workspace history', async () => {
        const f = fixture()
        await f.dispatcher.dispatch(f.request())
        await f.coordinator.approve('cancel-1', await f.review(f.coordinator))
        const ledger = (await f.repository.get('workspace-1'))!
        expect(parseAgentExecutionLedger(ledger, 'workspace-1')).toEqual(ledger)
        Object.assign(ledger.records[0].grant!, { expiresAt: '2026-09-05T02:00:00.000Z' })
        await setIndexedDBItemStrict('nai-blue-agent-execution:workspace-1', JSON.stringify(ledger))
        await expect(f.reopen().coordinator.recover()).rejects.toMatchObject({ code: 'INVALID_EXECUTION_STORE' })
        expect(f.cancel).toHaveBeenCalledTimes(1)
    })
})
