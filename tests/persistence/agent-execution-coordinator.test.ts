import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IndexedDbAgentExecutionRepository } from '@/adapters/agent/indexeddb-agent-execution-repository'
import { IndexedDbCommandReceiptRepository } from '@/adapters/agent/indexeddb-command-receipt-repository'
import { AgentCommandDispatcher } from '@/application/agent/agent-command-dispatcher'
import { agentRequestHash, assertAgentPublicValue, type AgentCommandEnvelope } from '@/application/agent/agent-command-contract'
import { createAgentExecutionCoordinator, type AgentExecutionCoordinatorOptions } from '@/application/agent/agent-execution-coordinator'
import { DEFAULT_AGENT_EXECUTION_POLICY, effectiveAgentExecutionPolicy, type AgentExecutionPolicy } from '@/application/agent/agent-execution-policy'
import { describeAgentCommandCapabilities } from '@/application/agent/runtime-capability-registry'
import type { GenerationPlan } from '@/application/generation/generation-plan-contract'
import type { JsonObject } from '@/domain/composition/types'
import { resetIndexedDBConnectionForRetry, setIndexedDBItemStrict } from '@/lib/indexed-db'

const initialTime = '2026-09-05T00:00:01.000Z'
const digest = `sha256:${'a'.repeat(64)}` as const
function fixture(mode: AgentExecutionPolicy['mode'] = 'suggest') {
    let time = initialTime
    let authorized = true
    let policy: AgentExecutionPolicy = { ...structuredClone(DEFAULT_AGENT_EXECUTION_POLICY), mode,
        boundedAutoExpiresAt: mode === 'bounded-auto' ? '2026-09-05T01:00:00.000Z' : null }
    const plan = { schemaVersion: 1, planId: digest, planHash: digest, semanticPlanHash: digest,
        sourceBindings: [], materializedSeedTrace: { source: 'fixed', traceId: null, seeds: [1] },
        jobs: [{ ordinal: 0, estimatedAnlas: 7, compatibility: { status: 'captured-pass', compatibilityProfileId: 'captured' },
            destination: { collisionPolicy: 'fail' }, prepared: { privateSpool: 'E:\\private\\secret.bin' } }],
        estimatedAnlas: 7, issues: [], requiredApprovals: [], executionPolicy: { maxConcurrency: 1 },
        budget: { maxImages: 1, maxAnlas: 10 } } as unknown as GenerationPlan
    const facts = new Map<string, JsonObject>()
    const enqueue = vi.fn(async (_plan, grant) => {
        const batchId = `main-batch-${grant.scopeId}`
        const result = { status: 'ready', batchId, runId: batchId, jobIds: [`${batchId}:0`] }
        facts.set(grant.scopeId, result)
        return result
    })
    const validate = vi.fn(async () => true)
    const isOutstanding = vi.fn(async () => false)
    const receipts = new IndexedDbCommandReceiptRepository()
    const opts: AgentExecutionCoordinatorOptions = { workspaceId: 'workspace-1', repository: new IndexedDbAgentExecutionRepository(),
        receipts, plans: { get: async () => structuredClone(plan), putIfAbsent: async () => 'same' },
        getPolicy: () => policy, now: () => time, isClientAuthorized: async () => authorized,
        ports: { validate, enqueue, reconcile: async grant => facts.get(grant.scopeId) ?? null, isOutstanding } }
    function reopen() {
        const coordinator = createAgentExecutionCoordinator({ ...opts, repository: new IndexedDbAgentExecutionRepository() })
        const dispatcher = new AgentCommandDispatcher({ workspaceId: opts.workspaceId, receipts,
            handlers: [coordinator.handler, ...(coordinator.cancelHandler ? [coordinator.cancelHandler] : []), ...(coordinator.storageRetryHandler ? [coordinator.storageRetryHandler] : [])],
            authentication: { authenticate: async envelope => ({ clientId: envelope.context.clientId, actor: { kind: envelope.context.actor.kind, id: `client:${envelope.context.clientId}` } }) },
            runtime: () => ({ ready: true, mode: policy.mode, globalPause: policy.globalPause }), now: () => time })
        return { coordinator, dispatcher }
    }
    function request(requestId: string, clientId = 'client-1'): AgentCommandEnvelope {
        const envelope: AgentCommandEnvelope = { schemaVersion: 1, requestId, requestHash: digest,
            submittedAt: '2026-09-05T00:00:00.000Z', expiresAt: '2026-09-05T02:00:00.000Z',
            context: { apiVersion: 'nai-blue.agent/v1alpha1', workspaceId: 'workspace-1', clientId, actor: { kind: 'agent' }, idempotencyKey: requestId },
            command: { name: 'generation.enqueue', input: { planId: digest, planHash: digest } },
            authentication: { scheme: 'hmac-sha256', keyId: 'key-1', signature: `hmac-sha256:${'0'.repeat(64)}` } }
        return { ...envelope, requestHash: agentRequestHash(envelope) }
    }
    return { ...reopen(), reopen, request, enqueue, validate, isOutstanding, receipts, opts, facts, plan,
        setPolicy: (next: AgentExecutionPolicy) => { policy = next }, getPolicy: () => structuredClone(policy),
        setTime: (next: string) => { time = next }, revoke: () => { authorized = false } }
}
beforeEach(() => { resetIndexedDBConnectionForRetry(); vi.stubGlobal('indexedDB', new IDBFactory()) })
afterEach(() => { resetIndexedDBConnectionForRetry(); vi.unstubAllGlobals() })

describe('durable agent execution authority', () => {
    it.each(['suggest', 'observe', 'bounded-auto', 'paused', 'expired', 'unmanaged'] as const)('projects effective human approval authority for %s', scenario => {
        const f = fixture('bounded-auto')
        const base = f.getPolicy()
        const effective = effectiveAgentExecutionPolicy({ ...base,
            mode: scenario === 'suggest' || scenario === 'observe' ? scenario : 'bounded-auto',
            globalPause: scenario === 'paused',
            boundedAutoExpiresAt: scenario === 'expired' ? initialTime : base.boundedAutoExpiresAt }, Date.parse(initialTime))
        const handler = scenario === 'unmanaged' ? { ...f.coordinator.handler, executionGate: undefined } : f.coordinator.handler
        const descriptors = describeAgentCommandCapabilities([handler], { ready: true, mode: effective.mode, globalPause: effective.globalPause })
        expect(descriptors.find(item => item.command === 'generation.enqueue')?.requiresHumanApproval).toBe(scenario !== 'bounded-auto')
        expect(descriptors.find(item => item.command === 'generation.cancel')).toMatchObject({ available: false, requiresHumanApproval: true })
    })
    it('reopens human review, consumes concurrent approval once, and replays the original signed envelope with the updated receipt', async () => {
        const f = fixture()
        const envelope = f.request('approve-once')
        expect(await f.dispatcher.dispatch(envelope)).toMatchObject({ state: 'needs-input', result: { code: 'AGENT_APPROVAL_REQUIRED' } })
        expect(f.enqueue).not.toHaveBeenCalled()
        resetIndexedDBConnectionForRetry()
        const reopened = f.reopen()
        const [review] = await reopened.coordinator.pending()
        expect(JSON.stringify(review)).not.toContain('privateSpool')
        await Promise.all([reopened.coordinator.approve(review.requestId, review), f.reopen().coordinator.approve(review.requestId, review)])
        expect(f.enqueue).toHaveBeenCalledTimes(1)
        expect(await reopened.dispatcher.dispatch(envelope)).toMatchObject({ state: 'completed', result: { status: 'ready' } })
        expect(await reopened.coordinator.approve(review.requestId, review)).toEqual({ code: 'AGENT_APPROVAL_UNAVAILABLE' })
        const record = (await f.opts.repository.get('workspace-1'))!.records[0]
        expect(record.envelope).toEqual(envelope)
        expect(record.grant).toMatchObject({ authorization: 'human', consentedAt: initialTime })
    })
    it.each(['expiry', 'revocation', 'stale-plan', 'wrong-binding'])('keeps Queue empty for %s at human approval', async kind => {
        const f = fixture()
        await f.dispatcher.dispatch(f.request('blocked'))
        const [review] = await f.coordinator.pending()
        if (kind === 'expiry') f.setTime('2026-09-05T02:00:00.000Z')
        if (kind === 'revocation') f.revoke()
        if (kind === 'stale-plan') f.validate.mockResolvedValue(false)
        if (kind === 'wrong-binding') await expect(f.coordinator.approve(review.requestId, { ...review, planHash: `sha256:${'b'.repeat(64)}` })).rejects.toMatchObject({ code: 'AGENT_APPROVAL_BINDING_CHANGED' })
        else await f.coordinator.approve(review.requestId, review)
        expect(f.enqueue).not.toHaveBeenCalled()
    })
    it('preserves the authenticated service actor and refuses a changed approval-token envelope', async () => {
        const f = fixture('bounded-auto')
        const base = f.request('service-actor')
        const service = { ...base, context: { ...base.context, actor: { kind: 'service' as const } } }
        const envelope = { ...service, requestHash: agentRequestHash(service) }
        expect((await f.dispatcher.dispatch(envelope)).state).toBe('completed')
        expect(f.enqueue.mock.calls[0][1]).toMatchObject({ actorKind: 'service', clientId: 'client-1' })
        const altered = { ...envelope, context: { ...envelope.context, approvalToken: 'new-consent' } }
        await expect(f.dispatcher.dispatch({ ...altered, requestHash: agentRequestHash(altered) })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
        expect(f.enqueue).toHaveBeenCalledTimes(1)
    })
    it('atomically rejects a new request ID reusing the same client operation key', async () => {
        const f = fixture('bounded-auto')
        const first = f.request('operation-first')
        const second = { ...f.request('operation-second'), context: { ...first.context } }
        const receipts = await Promise.all([f.dispatcher.dispatch(first),
            f.reopen().dispatcher.dispatch({ ...second, requestHash: agentRequestHash(second) })])
        expect(receipts.some(receipt => receipt.result?.code === 'AGENT_IDEMPOTENCY_CONFLICT')).toBe(true)
        expect(f.enqueue).toHaveBeenCalledTimes(1)
    })
    it('invalidates old policy consent, exposes a fresh review, and does not change the original request hash', async () => {
        const f = fixture()
        const envelope = f.request('policy-change')
        await f.dispatcher.dispatch(envelope)
        const [review] = await f.coordinator.pending()
        f.setPolicy({ ...f.getPolicy(), revision: 1 })
        expect(await f.coordinator.approve(review.requestId, review)).toEqual({ code: 'AGENT_APPROVAL_REQUIRED' })
        expect(f.enqueue).not.toHaveBeenCalled()
        const [fresh] = await f.coordinator.pending()
        expect(fresh).toMatchObject({ policyRevision: 1, requestHash: envelope.requestHash })
        await f.coordinator.approve(fresh.requestId, fresh)
        expect(f.enqueue).toHaveBeenCalledTimes(1)
    })
    it('holds human approval under global pause and executes once after unpause with a fresh policy binding', async () => {
        const f = fixture()
        await f.dispatcher.dispatch(f.request('human-paused'))
        f.setPolicy({ ...f.getPolicy(), globalPause: true, revision: 1 })
        const [paused] = await f.coordinator.pending()
        expect(paused.reasons).toEqual(['AGENT_GLOBAL_PAUSE'])
        expect(await f.coordinator.approve(paused.requestId, paused)).toEqual({ code: 'AGENT_APPROVAL_REQUIRED', issueCodes: ['AGENT_GLOBAL_PAUSE'] })
        expect(f.enqueue).not.toHaveBeenCalled()
        f.setPolicy({ ...f.getPolicy(), globalPause: false, revision: 2 })
        const [fresh] = await f.coordinator.pending()
        expect(fresh.policyRevision).toBe(2)
        await expect(f.coordinator.approve(paused.requestId, paused)).rejects.toMatchObject({ code: 'AGENT_APPROVAL_BINDING_CHANGED' })
        expect((await f.coordinator.approve(fresh.requestId, fresh)).status).toBe('ready')
        expect(f.enqueue).toHaveBeenCalledTimes(1)
    })
    it('still permits explicit human approval when only the bounded-auto window has expired', async () => {
        const f = fixture('bounded-auto')
        f.setTime('2026-09-05T01:00:01.000Z')
        expect((await f.dispatcher.dispatch(f.request('expired-auto-human'))).state).toBe('needs-input')
        const [review] = await f.coordinator.pending()
        expect((await f.coordinator.approve(review.requestId, review)).status).toBe('ready')
        expect(f.enqueue).toHaveBeenCalledTimes(1)
    })
    it.each(['run-cap', 'synthetic'])('keeps %s pending until a revised human policy and a fresh single-use review approve it', async kind => {
        const f = fixture('bounded-auto')
        const initial = f.getPolicy()
        if (kind === 'run-cap') f.setPolicy({ ...initial, generation: { ...initial.generation, maxAnlasPerRun: 0 } })
        else (f.plan.jobs[0].compatibility as { status: string }).status = 'synthetic-only'
        const envelope = f.request(`adjust-${kind}`)
        expect((await f.dispatcher.dispatch(envelope)).state).toBe('needs-input')
        const [oldReview] = await f.coordinator.pending()
        expect(oldReview.reasons).toEqual([kind === 'run-cap' ? 'AGENT_RUN_LIMIT' : 'AGENT_COMPATIBILITY_DENIED'])
        f.setPolicy({ ...initial, revision: 1, generation: { ...initial.generation,
            allowedCompatibilityStatuses: ['captured-pass', 'synthetic-only'] } })
        const [fresh] = await f.coordinator.pending()
        expect(fresh.policyRevision).toBe(1)
        await expect(f.coordinator.approve(oldReview.requestId, oldReview)).rejects.toMatchObject({ code: 'AGENT_APPROVAL_BINDING_CHANGED' })
        await f.coordinator.approve(fresh.requestId, fresh)
        expect((await f.dispatcher.dispatch(envelope)).state).toBe('completed')
        expect(f.enqueue).toHaveBeenCalledTimes(1)
        expect((await f.opts.repository.get('workspace-1'))!.records[0].originalPolicyRevision).toBe(0)
    })
    it('allows opaque batch/job result IDs while still rejecting their path and credential contents', () => {
        expect(() => assertAgentPublicValue({ batchId: `main-batch-agent-${'abcdef0123456789'.repeat(4)}`,
            jobIds: [`main-job-${'abcdef0123456789'.repeat(4)}`] })).not.toThrow()
        for (const value of ['E:\\private\\output.png', 'Bearer abcdef1234567890', 'data:image/png;base64,iVBORw0KGgo=']) {
            expect(() => assertAgentPublicValue({ batchId: value })).toThrow()
            expect(() => assertAgentPublicValue({ jobIds: [value] })).toThrow()
        }
    })
    it.each(['maxRunsPerHour', 'maxImagesPerHour', 'maxAnlasPerHour', 'maxAnlasPerDay'] as const)('atomically reserves workspace exposure across clients for %s', async limit => {
        const f = fixture('bounded-auto')
        const policy = f.getPolicy()
        f.setPolicy({ ...policy, rollingLimits: { ...policy.rollingLimits, [limit]: limit.includes('Anlas') ? 7 : 1 } })
        await Promise.all([f.dispatcher.dispatch(f.request('budget-a', 'client-a')), f.reopen().dispatcher.dispatch(f.request('budget-b', 'client-b'))])
        expect(f.enqueue).toHaveBeenCalledTimes(1)
        const rows = (await f.opts.repository.get('workspace-1'))!.records
        expect(rows.filter(row => row.grant)).toHaveLength(1)
        expect(rows.some(row => row.state === 'pending' && (row.result.issueCodes as string[])?.includes('AGENT_ROLLING_LIMIT'))).toBe(true)
    })
    it.each(['expired-auto', 'pause', 'synthetic', 'run-images', 'run-anlas', 'concurrency', 'observe'])('fails closed or asks the human for %s', async kind => {
        const f = fixture('bounded-auto')
        const policy = f.getPolicy()
        if (kind === 'expired-auto') f.setTime('2026-09-05T01:00:01.000Z')
        if (kind === 'pause') f.setPolicy({ ...policy, globalPause: true })
        if (kind === 'observe') f.setPolicy({ ...policy, mode: 'observe' })
        if (kind === 'synthetic') (f.plan.jobs[0].compatibility as { status: string }).status = 'synthetic-only'
        if (kind === 'run-images') (f.plan.jobs as unknown[]).push(structuredClone(f.plan.jobs[0]))
        if (kind === 'run-anlas') f.setPolicy({ ...policy, generation: { ...policy.generation, maxAnlasPerRun: 0 } })
        if (kind === 'concurrency') (f.plan.executionPolicy as { maxConcurrency: number }).maxConcurrency = 3
        const result = await f.dispatcher.dispatch(f.request(`gate-${kind}`))
        expect(f.enqueue).not.toHaveBeenCalled()
        if (kind === 'expired-auto' || kind === 'pause') expect(result.state).toBe('needs-input')
    })
    it('accepts synthetic-only only with an explicit policy allowlist', async () => {
        const f = fixture('bounded-auto')
        const policy = f.getPolicy()
        ;(f.plan.jobs[0].compatibility as { status: string }).status = 'synthetic-only'
        f.setPolicy({ ...policy, generation: { ...policy.generation, allowedCompatibilityStatuses: ['synthetic-only'] } })
        expect((await f.dispatcher.dispatch(f.request('synthetic-explicit'))).state).toBe('completed')
    })
    it('reconciles Queue commit before receipt write using exact facts after reopening, without enqueue retry', async () => {
        const f = fixture('bounded-auto')
        const finish = vi.spyOn(f.receipts, 'finish').mockRejectedValue(new Error('simulated receipt crash'))
        const envelope = f.request('commit-before-receipt')
        await expect(f.dispatcher.dispatch(envelope)).rejects.toThrow()
        expect(f.enqueue).toHaveBeenCalledTimes(1)
        finish.mockRestore()
        resetIndexedDBConnectionForRetry()
        const reopened = f.reopen()
        const receipts = await reopened.coordinator.recover()
        expect(receipts).toEqual([expect.objectContaining({ state: 'completed' })])
        expect((await reopened.dispatcher.dispatch(envelope)).state).toBe('completed')
        expect(f.enqueue).toHaveBeenCalledTimes(1)
    })
    it('repairs a dispatcher unknown receipt only from its completed durable grant after a one-off receipt failure', async () => {
        const f = fixture('bounded-auto')
        const finish = vi.spyOn(f.receipts, 'finish').mockRejectedValueOnce(new Error('single receipt write failure'))
        const envelope = f.request('one-receipt-failure')
        expect(await f.dispatcher.dispatch(envelope)).toMatchObject({ state: 'needs-input', result: { code: 'COMMAND_OUTCOME_UNKNOWN' } })
        finish.mockRestore()
        expect((await f.reopen().coordinator.recover())[0].state).toBe('completed')
        expect(f.enqueue).toHaveBeenCalledTimes(1)
    })
    it('preserves unknown exposure and never reruns unknown or absent Queue outcomes', async () => {
        const f = fixture('bounded-auto')
        f.enqueue.mockRejectedValue(new Error('Provider outcome must not be inferred'))
        const envelope = f.request('unknown')
        expect(await f.dispatcher.dispatch(envelope)).toMatchObject({ state: 'needs-input', result: { code: 'AGENT_EXECUTION_UNKNOWN' } })
        await f.reopen().coordinator.recover()
        await f.reopen().dispatcher.dispatch(envelope)
        expect(await f.coordinator.approve(envelope.requestId, { requestHash: envelope.requestHash, planHash: digest, policyRevision: 0 }))
            .toEqual({ code: 'AGENT_APPROVAL_UNAVAILABLE' })
        expect(f.enqueue).toHaveBeenCalledTimes(1)
        expect((await f.opts.repository.get('workspace-1'))!.records[0].grant).not.toBeNull()
    })
    it('never ages unknown rolling exposure without exact Queue settlement', async () => {
        const f = fixture('bounded-auto')
        const policy = f.getPolicy()
        f.setPolicy({ ...policy, rollingLimits: { ...policy.rollingLimits, maxAnlasPerHour: 7 } })
        f.enqueue.mockRejectedValueOnce(new Error('unknown queue outcome'))
        await f.dispatcher.dispatch(f.request('retained-first'))
        expect(await f.reopen().dispatcher.dispatch(f.request('retained-second'))).toMatchObject({ state: 'needs-input', result: { issueCodes: ['AGENT_ROLLING_LIMIT'] } })
        expect(f.enqueue).toHaveBeenCalledTimes(1)
        f.setTime('2026-09-05T01:01:00.000Z')
        f.setPolicy({ ...f.getPolicy(), boundedAutoExpiresAt: '2026-09-05T02:00:00.000Z' })
        expect((await f.reopen().dispatcher.dispatch(f.request('retained-third'))).state).toBe('needs-input')
        expect((await f.opts.repository.get('workspace-1'))!.records.filter(row => row.grant)).toHaveLength(1)
        expect((await f.opts.repository.get('workspace-1'))!.records[0].exposureSettledAt).toBeNull()
    })
    it('retains a Queue blocked for 25 hours, then starts full hourly/day windows at the first observed settlement', async () => {
        const f = fixture('bounded-auto')
        f.isOutstanding.mockResolvedValue(true)
        const policy = f.getPolicy()
        f.setPolicy({ ...policy, rollingLimits: { ...policy.rollingLimits, maxAnlasPerHour: 7, maxAnlasPerDay: 7 } })
        await f.dispatcher.dispatch(f.request('delayed-original'))
        const fresh = (id: string, timestamp: string) => {
            f.setTime(timestamp)
            const expiresAt = new Date(Date.parse(timestamp) + 7_200_000).toISOString()
            f.setPolicy({ ...f.getPolicy(), revision: f.getPolicy().revision + 1, boundedAutoExpiresAt: expiresAt })
            const envelope = { ...f.request(id), submittedAt: timestamp, expiresAt }
            return { ...envelope, requestHash: agentRequestHash(envelope) }
        }
        const settledAt = '2026-09-06T01:00:01.000Z'
        expect((await f.reopen().dispatcher.dispatch(fresh('delayed-new', settledAt))).state).toBe('needs-input')
        expect(f.enqueue).toHaveBeenCalledTimes(1)
        f.isOutstanding.mockResolvedValue(false)
        await f.reopen().coordinator.recover()
        expect((await f.opts.repository.get('workspace-1'))!.records[0].exposureSettledAt).toBe(settledAt)
        expect((await f.reopen().dispatcher.dispatch(fresh('settled-hour', '2026-09-06T02:01:01.000Z'))).state).toBe('needs-input')
        expect((await f.reopen().dispatcher.dispatch(fresh('settled-day', '2026-09-07T01:01:01.000Z'))).state).toBe('completed')
        expect(f.enqueue).toHaveBeenCalledTimes(2)
    })
    it('bounds pending approvals and rejects a human decision without creating Queue work', async () => {
        const f = fixture()
        const policy = f.getPolicy()
        f.setPolicy({ ...policy, rollingLimits: { ...policy.rollingLimits, maxOutstandingRequestsPerClient: 1 } })
        await f.dispatcher.dispatch(f.request('pending-first'))
        expect(await f.dispatcher.dispatch(f.request('pending-second'))).toMatchObject({ state: 'rejected', result: { code: 'AGENT_OUTSTANDING_LIMIT' } })
        const [review] = await f.coordinator.pending()
        await f.coordinator.reject(review.requestId, review)
        expect(await f.dispatcher.dispatch(f.request('pending-first'))).toMatchObject({ state: 'rejected', result: { code: 'AGENT_HUMAN_REJECTED' } })
        expect(await f.coordinator.pending()).toEqual([])
        expect(f.enqueue).not.toHaveBeenCalled()
    })
    it('does not resume legacy accepted, unknown-outcome, or non-public receipts as human approvals', async () => {
        const f = fixture()
        for (const code of [null, 'COMMAND_OUTCOME_UNKNOWN', 'RESULT_NOT_PUBLIC']) {
            const envelope = f.request(`legacy-${code ?? 'accepted'}`)
            const claimed = await f.receipts.claim({ schemaVersion: 1, requestId: envelope.requestId, requestHash: envelope.requestHash,
                authenticatedClientId: 'client-1', command: 'generation.enqueue', state: 'accepted', observedAt: initialTime,
                resultSchemaVersion: 1, result: null, resultDigest: null })
            if (code) {
                const { agentResultDigest } = await import('@/application/agent/command-receipt-repository')
                await f.receipts.finish(claimed.receipt, { ...claimed.receipt, state: 'needs-input', result: { code }, resultDigest: agentResultDigest({ code }) })
            }
            await f.dispatcher.dispatch(envelope)
            expect(await f.coordinator.approve(envelope.requestId, { requestHash: envelope.requestHash, planHash: digest, policyRevision: 0 }))
                .toEqual({ code: 'AGENT_APPROVAL_UNAVAILABLE' })
        }
        expect(await f.coordinator.recover()).toEqual([])
        expect(f.enqueue).not.toHaveBeenCalled()
    })
    it('recovers an uncertain reservation from a matching committed Queue fact', async () => {
        const f = fixture('bounded-auto')
        const realEnqueue = f.enqueue.getMockImplementation()!
        f.enqueue.mockImplementation(async (plan, grant) => { await realEnqueue(plan, grant); throw new Error('post-commit crash') })
        await f.dispatcher.dispatch(f.request('queue-fact'))
        expect((await f.reopen().coordinator.recover())[0].state).toBe('completed')
        expect(f.enqueue).toHaveBeenCalledTimes(1)
    })
    it('rejects corrupt execution storage without resetting its reservations', async () => {
        const f = fixture('bounded-auto')
        await setIndexedDBItemStrict('nai-blue-agent-execution:workspace-1', '{"schemaVersion":1,"records":[]}')
        expect(await f.dispatcher.dispatch(f.request('corrupt'))).toMatchObject({ state: 'needs-input', result: { code: 'COMMAND_OUTCOME_UNKNOWN' } })
        await expect(f.coordinator.recover()).rejects.toMatchObject({ code: 'INVALID_EXECUTION_STORE' })
        expect(f.enqueue).not.toHaveBeenCalled()
    })
    it('shares enqueue/cancel operation identity and preserves generation exposure even at its outstanding limit', async () => {
        const f = fixture('bounded-auto')
        f.setPolicy({ ...f.getPolicy(), rollingLimits: { ...f.getPolicy().rollingLimits, maxOutstandingRequestsPerClient: 1 } })
        f.isOutstanding.mockResolvedValue(true)
        const generated = await f.dispatcher.dispatch(f.request('generation-operation'))
        const originalRecord = (await f.opts.repository.get('workspace-1'))!.records[0]
        const target = { runId: String(generated.result!.runId), batchId: String(generated.result!.batchId),
            jobIds: generated.result!.jobIds as string[], targetHash: digest, previouslyStoppedJobIds: [] }
        const cancel = vi.fn(async () => ({ status: 'cancel-requested' as const, runId: target.runId, batchId: target.batchId, jobIds: target.jobIds }))
        Object.assign(f.opts, { cancellation: { inspect: async () => target, cancel, reconcile: async () => null } })
        const active = f.reopen()
        const makeCancel = (requestId: string, operation: string) => {
            const envelope = f.request(requestId)
            envelope.command = { name: 'generation.cancel', input: { runId: target.runId } }
            envelope.context.idempotencyKey = operation
            return { ...envelope, requestHash: agentRequestHash(envelope) }
        }
        expect(await active.dispatcher.dispatch(makeCancel('duplicate-cancel', 'generation-operation')))
            .toMatchObject({ state: 'rejected', result: { code: 'AGENT_IDEMPOTENCY_CONFLICT' } })
        expect(await active.dispatcher.dispatch(makeCancel('stop-generation', 'stop-generation'))).toMatchObject({ state: 'needs-input' })
        const review = (await active.coordinator.pending())[0]
        await active.coordinator.approve('stop-generation', review)
        await active.coordinator.recover()
        expect(cancel).toHaveBeenCalledTimes(1)
        expect((await f.opts.repository.get('workspace-1'))!.records[0]).toEqual(originalRecord)
        expect(await active.dispatcher.dispatch(f.request('after-stop'))).toMatchObject({ state: 'rejected', result: { code: 'AGENT_OUTSTANDING_LIMIT' } })
        expect(f.enqueue).toHaveBeenCalledTimes(1)
    })
    it('keeps legacy enqueue exposure and cross-command operation identity intact after storage registration', async () => {
        const f = fixture('bounded-auto')
        f.setPolicy({ ...f.getPolicy(), rollingLimits: { ...f.getPolicy().rollingLimits, maxOutstandingRequestsPerClient: 1 } })
        f.isOutstanding.mockResolvedValue(true)
        const generated = await f.dispatcher.dispatch(f.request('generation-operation'))
        const originalRecord = (await f.opts.repository.get('workspace-1'))!.records[0]
        const target = { runId: String(generated.result!.runId), batchId: String(generated.result!.batchId),
            jobId: (generated.result!.jobIds as string[])[0], outputTransactionId: 'queue-native-transaction', artifactId: 'artifact-native', targetHash: digest }
        const retry = vi.fn(async () => ({ status: 'storage-registered' as const, runId: target.runId, batchId: target.batchId, jobId: target.jobId, artifactId: target.artifactId }))
        Object.assign(f.opts, { storageRetry: { inspect: async () => target, retry, reconcile: async () => null } })
        const active = f.reopen()
        const makeRetry = (requestId: string, operation: string) => {
            const envelope = f.request(requestId)
            envelope.command = { name: 'generation.retry_storage', input: { runId: target.runId, jobId: target.jobId } }
            envelope.context.idempotencyKey = operation
            return { ...envelope, requestHash: agentRequestHash(envelope) }
        }
        expect(await active.dispatcher.dispatch(makeRetry('duplicate-storage', 'generation-operation')))
            .toMatchObject({ state: 'rejected', result: { code: 'AGENT_IDEMPOTENCY_CONFLICT' } })
        expect(await active.dispatcher.dispatch(makeRetry('register-storage', 'register-storage'))).toMatchObject({ state: 'needs-input' })
        await active.coordinator.approve('register-storage', (await active.coordinator.pending())[0])
        await active.coordinator.recover()
        expect(retry).toHaveBeenCalledTimes(1)
        expect((await f.opts.repository.get('workspace-1'))!.records[0]).toEqual(originalRecord)
        expect(await active.dispatcher.dispatch(f.request('after-registration'))).toMatchObject({ state: 'rejected', result: { code: 'AGENT_OUTSTANDING_LIMIT' } })
        expect(f.enqueue).toHaveBeenCalledTimes(1)
    })
})
