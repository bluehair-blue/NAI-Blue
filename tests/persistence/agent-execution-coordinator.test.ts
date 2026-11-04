import { parseAgentExecutionLedger } from '@/application/agent/agent-execution-repository'
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
import { DEFAULT_AGENT_AUTHORING_CONSENT, updateAgentAuthoringConsent } from '@/application/agent/agent-authoring-consent'
import { DEFAULT_AGENT_GENERATION_CONSENT, updateAgentGenerationConsent } from '@/application/agent/agent-generation-consent'

const initialTime = '2026-09-05T00:00:01.000Z'
const digest = `sha256:${'a'.repeat(64)}` as const
function fixture(mode: AgentExecutionPolicy['mode'] = 'suggest') {
    let generationConsent = structuredClone(DEFAULT_AGENT_GENERATION_CONSENT)
    let time = initialTime
    let authorized = true
    let policy: AgentExecutionPolicy = { ...structuredClone(DEFAULT_AGENT_EXECUTION_POLICY), mode,
        boundedAutoExpiresAt: mode === 'bounded-auto' ? '2026-09-05T01:00:00.000Z' : null }
    const plan = { schemaVersion: 1, planId: digest, planHash: digest, semanticPlanHash: digest,
        sourceBindings: [], materializedSeedTrace: { source: 'fixed', traceId: null, seeds: [1] },
        jobs: [{ ordinal: 0, estimatedAnlas: 7, semantic: { prompt: 'rainy bookshop', negativePrompt: 'blur', model: 'nai-diffusion-5-full',
            width: 832, height: 1216, steps: 28, seed: 1, generationParameters: { cfgScale: 5, cfgRescale: 0,
                sampler: 'k_euler_ancestral', scheduler: 'native', smea: false, smeaDyn: false, variety: false,
                characterPrompts: [{ prompt: 'reader by window', negative: 'extra fingers', enabled: true, position: { x: 0.5, y: 0.58 } }] },
            resourceDigest: digest }, compatibility: { status: 'captured-pass', compatibilityProfileId: 'captured' },
            destination: { collisionPolicy: 'fail' }, prepared: { privateSpool: 'E:\\private\\secret.bin' } }],
        estimatedAnlas: 7, issues: [], requiredApprovals: [], executionPolicy: { maxConcurrency: 1 },
        budget: { maxImages: 1, maxAnlas: 10 } } as unknown as GenerationPlan
    const facts = new Map<string, JsonObject>()
    const enqueue = vi.fn(async (_plan, grant) => {
        const batchId = `main-batch-${grant.scopeId}`
        const result = { status: 'ready', batchId, runId: batchId, jobIds: _plan.jobs.map((_: unknown, index: number) => `${batchId}:${index}`) }
        facts.set(grant.scopeId, result)
        return result
    })
    const validate = vi.fn(async () => true)
    const isOutstanding = vi.fn(async () => false)
    const receipts = new IndexedDbCommandReceiptRepository()
    const opts: AgentExecutionCoordinatorOptions = { workspaceId: 'workspace-1', repository: new IndexedDbAgentExecutionRepository(),
        receipts, plans: { get: async () => structuredClone(plan), putIfAbsent: async () => 'same' },
        getPolicy: () => policy, getGenerationConsent: () => generationConsent, now: () => time, isClientAuthorized: async () => authorized,
        ports: { validate, enqueue, reconcile: async grant => facts.get(grant.scopeId) ?? null, isOutstanding } }
    function reopen() {
        const coordinator = createAgentExecutionCoordinator({ ...opts, repository: new IndexedDbAgentExecutionRepository() })
        const dispatcher = new AgentCommandDispatcher({ workspaceId: opts.workspaceId, receipts,
            handlers: [coordinator.handler, ...(coordinator.cancelHandler ? [coordinator.cancelHandler] : []), ...(coordinator.storageRetryHandler ? [coordinator.storageRetryHandler] : []), ...coordinator.authoringHandlers],
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
        generationApproval: (enabled: boolean, workspaceId = 'workspace-1', clientId = 'client-1') => {
            generationConsent = updateAgentGenerationConsent(generationConsent, generationConsent.revision, workspaceId, clientId, enabled)
        },
        setPolicy: (next: AgentExecutionPolicy) => { policy = next }, getPolicy: () => structuredClone(policy),
        setTime: (next: string) => { time = next }, revoke: () => { authorized = false } }
}
beforeEach(() => { resetIndexedDBConnectionForRetry(); vi.stubGlobal('indexedDB', new IDBFactory()) })
afterEach(() => { resetIndexedDBConnectionForRetry(); vi.unstubAllGlobals() })

describe('durable agent execution authority', () => {
    it('uses human-owned persistent generation consent for new synthetic-only poses and random seeds without relabelling evidence', async () => {
        const f = fixture()
        f.generationApproval(true)
        ;(f.plan.jobs[0].compatibility as { status: string }).status = 'synthetic-only'
        expect((await f.dispatcher.dispatch(f.request('synthetic-repeat-first'))).state).toBe('completed')
        const nextHash = `sha256:${'b'.repeat(64)}` as const
        Object.assign(f.plan, { planId: nextHash, planHash: nextHash })
        Object.assign(f.plan.jobs[0].semantic, { seed: 123456789, prompt: 'new hand pose' })
        const nextRequest = (id: string) => {
            const envelope = { ...f.request(id), command: { name: 'generation.enqueue' as const,
                input: { planId: nextHash, planHash: nextHash } } }
            return { ...envelope, requestHash: agentRequestHash(envelope) }
        }
        expect((await f.dispatcher.dispatch(nextRequest('synthetic-repeat-new-seed'))).state).toBe('completed')
        expect(f.enqueue).toHaveBeenCalledTimes(2)
        expect(f.enqueue.mock.calls.map(call => call[1].authorization)).toEqual(['client-always-generate', 'client-always-generate'])
        expect(f.plan.jobs[0].compatibility.status).toBe('synthetic-only')
        expect(f.getPolicy().generation.allowedCompatibilityStatuses).toEqual(['captured-pass', 'live-canary-pass'])
        f.generationApproval(false)
        expect(await f.dispatcher.dispatch(nextRequest('synthetic-repeat-off'))).toMatchObject({ state: 'needs-input',
            result: { issueCodes: ['AGENT_COMPATIBILITY_DENIED'] } })
        f.setPolicy({ ...f.getPolicy(), mode: 'bounded-auto', boundedAutoExpiresAt: '2026-09-05T01:00:00.000Z' })
        expect((await f.dispatcher.dispatch(nextRequest('synthetic-repeat-legacy'))).state).toBe('needs-input')
        expect(f.enqueue).toHaveBeenCalledTimes(2)
    })
    it('uses independent saved generation consent for two new requests across reopen, then stops after OFF', async () => {
        const f = fixture()
        f.generationApproval(true)
        expect((await f.dispatcher.dispatch(f.request('generation-always-first'))).state).toBe('completed')
        expect(f.enqueue.mock.calls[0][1]).toMatchObject({ authorization: 'client-always-generate', consentRevision: 1 })
        resetIndexedDBConnectionForRetry()
        const reopened = f.reopen()
        await reopened.coordinator.recover()
        expect((await reopened.dispatcher.dispatch(f.request('generation-always-second'))).state).toBe('completed')
        f.generationApproval(false)
        expect((await reopened.dispatcher.dispatch(f.request('generation-always-off'))).state).toBe('needs-input')
        expect(f.enqueue).toHaveBeenCalledTimes(2)
        const ledger = await f.opts.repository.get('workspace-1')
        expect(parseAgentExecutionLedger(ledger, 'workspace-1').records).toHaveLength(3)
        const tampered = structuredClone(ledger)!
        Object.assign(tampered.records[0].grant!, { consentRevision: 2 })
        expect(() => parseAgentExecutionLedger(tampered, 'workspace-1')).toThrow()
    })
    it('does not lend persistent compatibility authority to an approve-once path or replay same-revision pending work', async () => {
        const f = fixture()
        f.generationApproval(true)
        ;(f.plan.jobs[0].compatibility as { status: string }).status = 'synthetic-only'
        f.setPolicy({ ...f.getPolicy(), globalPause: true })
        const old = f.request('synthetic-pending-same-consent')
        await f.dispatcher.dispatch(old)
        expect((await f.opts.repository.get('workspace-1'))!.records[0]).toMatchObject({ consentRevision: 1, state: 'pending', grant: null })
        f.setPolicy({ ...f.getPolicy(), globalPause: false })
        await f.coordinator.recover()
        expect((await f.dispatcher.dispatch(old)).state).toBe('needs-input')
        expect(f.enqueue).not.toHaveBeenCalled()
        const [review] = await f.coordinator.pending()
        f.validate.mockImplementationOnce(async () => { f.generationApproval(false); return true })
        await f.coordinator.approve(old.requestId, review)
        expect(f.enqueue).not.toHaveBeenCalled()
    })
    it('does not infer generation consent from editing or grant it to another client/workspace', async () => {
        const f = fixture()
        ;(f.plan.jobs[0].compatibility as { status: string }).status = 'synthetic-only'
        Object.assign(f.opts, { getAuthoringConsent: () => updateAgentAuthoringConsent(DEFAULT_AGENT_AUTHORING_CONSENT, 0, 'workspace-1', 'client-1', true) })
        expect((await f.reopen().dispatcher.dispatch(f.request('editing-only-generation'))).state).toBe('needs-input')
        f.generationApproval(true, 'workspace-other', 'client-1')
        f.generationApproval(true, 'workspace-1', 'client-other')
        expect((await f.dispatcher.dispatch(f.request('generation-foreign'))).state).toBe('needs-input')
        expect(f.enqueue).not.toHaveBeenCalled()
    })
    it('does not replay old pending/unknown records when generation consent becomes active', async () => {
        const f = fixture()
        ;(f.plan.jobs[0].compatibility as { status: string }).status = 'synthetic-only'
        const old = f.request('generation-pending-before-on')
        await f.dispatcher.dispatch(old)
        f.generationApproval(true)
        const reopened = f.reopen()
        await reopened.coordinator.recover()
        expect((await reopened.dispatcher.dispatch(old)).state).toBe('needs-input')
        expect(f.enqueue).not.toHaveBeenCalled()
        f.enqueue.mockRejectedValueOnce(new Error('unknown Provider outcome'))
        const uncertain = f.request('generation-consent-unknown')
        await reopened.dispatcher.dispatch(uncertain)
        f.generationApproval(false); f.generationApproval(true)
        await f.reopen().coordinator.recover()
        await f.reopen().dispatcher.dispatch(uncertain)
        expect(f.enqueue).toHaveBeenCalledTimes(1)
    })
    it.each(['before', 'after'] as const)('blocks consent revocation %s durable reservation', async timing => {
        const f = fixture()
        f.generationApproval(true)
        ;(f.plan.jobs[0].compatibility as { status: string }).status = 'synthetic-only'
        if (timing === 'before') f.validate.mockImplementationOnce(async () => { f.generationApproval(false); return true })
        else {
            let checks = 0
            Object.assign(f.opts, { isClientAuthorized: async () => { if (++checks === 3) f.generationApproval(false); return true } })
        }
        const result = await f.reopen().dispatcher.dispatch(f.request(`generation-revoke-${timing}`))
        expect(result.state).not.toBe('completed')
        expect(f.enqueue).not.toHaveBeenCalled()
    })
    it.each(['observe', 'pause', 'known-divergence', 'unsupported', 'credential', 'budget', 'output', 'r2', 'revoked', 'expired'] as const)(
        'retains %s validation under saved generation consent', async fault => {
            const f = fixture()
            f.generationApproval(true)
            ;(f.plan.jobs[0].compatibility as { status: string }).status = 'synthetic-only'
            if (fault === 'observe') f.setPolicy({ ...f.getPolicy(), mode: 'observe' })
            if (fault === 'pause') f.setPolicy({ ...f.getPolicy(), globalPause: true })
            if (fault === 'known-divergence' || fault === 'unsupported') (f.plan.jobs[0].compatibility as { status: string }).status = fault
            if (fault === 'credential') f.validate.mockResolvedValue(false)
            if (fault === 'budget') (f.plan as { estimatedAnlas: number }).estimatedAnlas = 11
            if (fault === 'output') (f.plan.jobs[0].destination as { collisionPolicy: string }).collisionPolicy = 'overwrite'
            if (fault === 'r2') Object.assign(f.plan.jobs[0].destination, { r2: { profileId: 'unapproved-profile' } })
            if (fault === 'revoked') f.revoke()
            if (fault === 'expired') f.setTime('2026-09-06T00:00:00.000Z')
            if (fault === 'expired') await expect(f.reopen().dispatcher.dispatch(f.request(`generation-gate-${fault}`))).rejects.toThrow()
            else expect((await f.reopen().dispatcher.dispatch(f.request(`generation-gate-${fault}`))).state).not.toBe('completed')
            expect(f.enqueue).not.toHaveBeenCalled()
        })
    it('adds no image/Anlas quota and preserves separate bounded-auto authority after consent OFF', async () => {
        const f = fixture()
        f.generationApproval(true)
        ;(f.plan.jobs[0].compatibility as { status: string }).status = 'synthetic-only'
        Object.assign(f.plan, { jobs: Array.from({ length: 10 }, (_, ordinal) => ({ ...f.plan.jobs[0], ordinal })),
            estimatedAnlas: 12345, budget: { maxImages: 10, maxAnlas: 12345 } })
        expect((await f.dispatcher.dispatch(f.request('generation-no-new-quota'))).state).toBe('completed')
        expect(f.enqueue.mock.calls[0][1]).toMatchObject({ authorization: 'client-always-generate', imageCount: 10, estimatedAnlas: 12345 })
        f.generationApproval(false)
        ;(f.plan.jobs[0].compatibility as { status: string }).status = 'captured-pass'
        f.setPolicy({ ...f.getPolicy(), mode: 'bounded-auto', boundedAutoExpiresAt: '2026-09-05T01:00:00.000Z' })
        expect((await f.dispatcher.dispatch(f.request('generation-legacy-after-off'))).state).toBe('completed')
        expect(f.enqueue.mock.calls[1][1]).toMatchObject({ authorization: 'bounded-auto' })
    })
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
        expect(review).toMatchObject({ previewJobs: [{ prompt: 'rainy bookshop', negativePrompt: 'blur', model: 'nai-diffusion-5-full',
            width: 832, height: 1216, steps: 28, seed: 1, generationParameters: { cfgScale: 5,
                characterPrompts: [{ prompt: 'reader by window', negative: 'extra fingers', enabled: true }] } }] })
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
    it('keeps synthetic compatibility pending until a revised policy and a fresh single-use review approve it', async () => {
        const f = fixture('bounded-auto')
        const initial = f.getPolicy()
        ;(f.plan.jobs[0].compatibility as { status: string }).status = 'synthetic-only'
        const envelope = f.request('adjust-synthetic')
        expect((await f.dispatcher.dispatch(envelope)).state).toBe('needs-input')
        const [oldReview] = await f.coordinator.pending()
        expect(oldReview.reasons).toEqual(['AGENT_COMPATIBILITY_DENIED'])
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

    it('requires the distinct human canary action, consumes it once across restart, and preserves policy and evidence classification', async () => {
        const f = fixture('bounded-auto')
        ;(f.plan.jobs[0].compatibility as { status: string }).status = 'synthetic-only'
        const originalPolicy = structuredClone(f.getPolicy())
        const envelope = f.request('human-canary')
        expect((await f.dispatcher.dispatch(envelope)).result).toEqual({ code: 'AGENT_APPROVAL_REQUIRED',
            issueCodes: ['AGENT_COMPATIBILITY_DENIED'], nextAction: 'review-one-image-canary-in-app' })
        let [review] = await f.coordinator.pending()
        expect(review).toMatchObject({ canaryEligible: true, compatibilityStatuses: ['synthetic-only'] })
        await f.coordinator.approve(review.requestId, review)
        expect(f.enqueue).not.toHaveBeenCalled()
        const reopened = f.reopen()
        ;[review] = await reopened.coordinator.pending()
        await Promise.all([reopened.coordinator.approveCanary(review.requestId, review),
            f.coordinator.approveCanary(review.requestId, review)])
        expect(f.enqueue).toHaveBeenCalledTimes(1)
        expect(f.enqueue.mock.calls[0][1]).toMatchObject({ authorization: 'human-canary', planHash: f.plan.planHash,
            imageCount: 1, estimatedAnlas: 7, policyRevision: 0, requestHash: envelope.requestHash })
        expect(f.getPolicy()).toEqual(originalPolicy)
        expect(f.plan.jobs[0].compatibility.status).toBe('synthetic-only')
        resetIndexedDBConnectionForRetry()
        await f.reopen().coordinator.recover()
        await f.reopen().dispatcher.dispatch(envelope)
        expect(f.enqueue).toHaveBeenCalledTimes(1)
        expect(parseAgentExecutionLedger(await f.opts.repository.get('workspace-1'), 'workspace-1').records[0].grant)
            .toMatchObject({ authorization: 'human-canary' })
        const forged = structuredClone((await f.opts.repository.get('workspace-1'))!)
        const forgedRecord = forged.records[0] as any
        forgedRecord.imageCount = forgedRecord.grant.imageCount = 2
        expect(() => parseAgentExecutionLedger(forged, 'workspace-1')).toThrow()
    })
    it.each(['multiple', 'budget-images', 'budget-anlas', 'r2', 'overwrite', 'unsupported', 'divergence',
        'expiry', 'revoked', 'pause', 'observe', 'source-changed', 'wrong-binding', 'policy-changed'])(
        'does not dispatch a validation image when %s invalidates exact human consent', async kind => {
        const f = fixture()
        ;(f.plan.jobs[0].compatibility as { status: string }).status = 'synthetic-only'
        const envelope = f.request('canary-invalid-' + kind)
        await f.dispatcher.dispatch(envelope)
        const [review] = await f.coordinator.pending()
        const mutable = f.plan as any
        if (kind === 'multiple') mutable.jobs.push(structuredClone(mutable.jobs[0]))
        if (kind === 'budget-images') mutable.budget.maxImages = 2
        if (kind === 'budget-anlas') mutable.budget.maxAnlas = 18
        if (kind === 'r2') mutable.jobs[0].destination.r2 = { profileId: 'profile-1' }
        if (kind === 'overwrite') mutable.jobs[0].destination.collisionPolicy = 'overwrite'
        if (kind === 'unsupported') mutable.jobs[0].compatibility.status = 'unsupported'
        if (kind === 'divergence') mutable.jobs[0].compatibility.status = 'known-divergence'
        if (kind === 'expiry') f.setTime('2026-09-05T02:00:00.000Z')
        if (kind === 'revoked') f.revoke()
        if (kind === 'pause') f.setPolicy({ ...f.getPolicy(), globalPause: true })
        if (kind === 'observe') f.setPolicy({ ...f.getPolicy(), mode: 'observe' })
        if (kind === 'source-changed') f.validate.mockResolvedValue(false)
        if (kind === 'policy-changed') f.setPolicy({ ...f.getPolicy(), revision: 1 })
        if (kind === 'wrong-binding') await expect(f.coordinator.approveCanary(review.requestId,
            { ...review, planHash: `sha256:${'b'.repeat(64)}` })).rejects.toMatchObject({ code: 'AGENT_APPROVAL_BINDING_CHANGED' })
        else await f.coordinator.approveCanary(review.requestId, review)
        expect(f.enqueue).not.toHaveBeenCalled()
    })
    it('never retries a canary after an unknown Queue outcome', async () => {
        const f = fixture()
        ;(f.plan.jobs[0].compatibility as { status: string }).status = 'synthetic-only'
        f.enqueue.mockRejectedValue(new Error('unknown outcome'))
        const envelope = f.request('canary-unknown')
        await f.dispatcher.dispatch(envelope)
        const [review] = await f.coordinator.pending()
        expect(await f.coordinator.approveCanary(review.requestId, review)).toEqual({ code: 'AGENT_EXECUTION_UNKNOWN' })
        const reopened = f.reopen()
        await reopened.coordinator.recover()
        await reopened.coordinator.approveCanary(review.requestId, review)
        await reopened.dispatcher.dispatch(envelope)
        expect(f.enqueue).toHaveBeenCalledTimes(1)
    })

    it('allows opaque batch/job result IDs while still rejecting their path and credential contents', () => {
        expect(() => assertAgentPublicValue({ batchId: `main-batch-agent-${'abcdef0123456789'.repeat(4)}`,
            jobIds: [`main-job-${'abcdef0123456789'.repeat(4)}`] })).not.toThrow()
        for (const value of ['E:\\private\\output.png', 'Bearer abcdef1234567890', 'data:image/png;base64,iVBORw0KGgo=']) {
            expect(() => assertAgentPublicValue({ batchId: value })).toThrow()
            expect(() => assertAgentPublicValue({ jobIds: [value] })).toThrow()
        }
    })
    it('admits reviewed work across clients without artificial rolling quotas', async () => {
        const f = fixture('bounded-auto')
        await Promise.all([f.dispatcher.dispatch(f.request('budget-a', 'client-a')), f.reopen().dispatcher.dispatch(f.request('budget-b', 'client-b'))])
        expect(f.enqueue).toHaveBeenCalledTimes(2)
        const rows = (await f.opts.repository.get('workspace-1'))!.records
        expect(rows.filter(row => row.grant)).toHaveLength(2)
    })
    it.each(['expired-auto', 'pause', 'synthetic', 'run-images', 'observe'])('fails closed or asks the human for %s', async kind => {
        const f = fixture('bounded-auto')
        const policy = f.getPolicy()
        if (kind === 'expired-auto') f.setTime('2026-09-05T01:00:01.000Z')
        if (kind === 'pause') f.setPolicy({ ...policy, globalPause: true })
        if (kind === 'observe') f.setPolicy({ ...policy, mode: 'observe' })
        if (kind === 'synthetic') (f.plan.jobs[0].compatibility as { status: string }).status = 'synthetic-only'
        if (kind === 'run-images') (f.plan.jobs as unknown[]).push(structuredClone(f.plan.jobs[0]))
        const result = await f.dispatcher.dispatch(f.request(`gate-${kind}`))
        expect(f.enqueue).not.toHaveBeenCalled()
        if (kind === 'expired-auto' || kind === 'pause') expect(result.state).toBe('needs-input')
    })
    it('requires the explicit policy allowlist for synthetic-only without persistent consent', async () => {
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
    it('admits a reviewed 50-image plan once without per-run or concurrency policy caps', async () => {
        const f = fixture('bounded-auto')
        Object.assign(f.plan, { jobs: Array.from({ length: 50 }, (_, ordinal) => ({ ...structuredClone(f.plan.jobs[0]), ordinal })),
            estimatedAnlas: 1467, budget: { maxImages: 50, maxAnlas: 1500 }, executionPolicy: { maxConcurrency: 2 } })
        const request = f.request('fifty-reviewed')
        expect((await f.dispatcher.dispatch(request)).state).toBe('completed')
        expect((await f.reopen().dispatcher.dispatch(request)).state).toBe('completed')
        expect(f.enqueue).toHaveBeenCalledTimes(1)
        expect((await f.opts.repository.get('workspace-1'))!.records[0].grant).toMatchObject({ imageCount: 50, estimatedAnlas: 1467 })
    })
    it('records exact Queue settlement after a long delay without dispatching again', async () => {
        const f = fixture('bounded-auto')
        f.isOutstanding.mockResolvedValue(true)
        await f.dispatcher.dispatch(f.request('delayed-original'))
        const settledAt = '2026-09-06T01:00:01.000Z'
        f.setTime(settledAt)
        await f.reopen().coordinator.recover()
        expect((await f.opts.repository.get('workspace-1'))!.records[0].exposureSettledAt).toBeNull()
        f.isOutstanding.mockResolvedValue(false)
        await f.reopen().coordinator.recover()
        expect((await f.opts.repository.get('workspace-1'))!.records[0].exposureSettledAt).toBe(settledAt)
        expect(f.enqueue).toHaveBeenCalledTimes(1)
    })
    it('keeps independent pending approvals and rejects only the selected request without Queue work', async () => {
        const f = fixture()
        await f.dispatcher.dispatch(f.request('pending-first'))
        expect(await f.dispatcher.dispatch(f.request('pending-second'))).toMatchObject({ state: 'needs-input' })
        const [review] = await f.coordinator.pending()
        await f.coordinator.reject(review.requestId, review)
        expect(await f.dispatcher.dispatch(f.request('pending-first'))).toMatchObject({ state: 'rejected', result: { code: 'AGENT_HUMAN_REJECTED' } })
        expect(await f.coordinator.pending()).toEqual([expect.objectContaining({ requestId: 'pending-second' })])
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
    it('shares enqueue/cancel operation identity and preserves the original generation record', async () => {
        const f = fixture('bounded-auto')
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
        expect(await active.dispatcher.dispatch(f.request('after-stop'))).toMatchObject({ state: 'completed' })
        expect(f.enqueue).toHaveBeenCalledTimes(2)
    })
    it('keeps legacy enqueue exposure and cross-command operation identity intact after storage registration', async () => {
        const f = fixture('bounded-auto')
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
        expect(await active.dispatcher.dispatch(f.request('after-registration'))).toMatchObject({ state: 'completed' })
        expect(f.enqueue).toHaveBeenCalledTimes(2)
    })
})


describe('durable local authoring through the shared execution authority', () => {
    function authoring(mode: AgentExecutionPolicy['mode'] = 'suggest') {
        const f = fixture(mode)
        let consent = structuredClone(DEFAULT_AGENT_AUTHORING_CONSENT)
        f.opts.getAuthoringConsent = () => consent
        const target = { command: 'scene.patch_many' as const, resourceId: 'preset-1', expectedRevision: 0,
            targetHash: digest, changeCount: 1, createsFolders: false, renamesPathSegments: false }
        let committed: JsonObject | null = null
        const inspect = vi.fn(async () => structuredClone(target))
        const apply = vi.fn(async (_command, _input, _target, grant) => {
            committed = { status: 'authoring-committed', command: grant.target.command, resourceId: grant.target.resourceId,
                revision: grant.target.expectedRevision + 1, targetHash: grant.target.targetHash }
            return committed
        })
        f.opts.authoring = { inspect, apply, reconcile: async () => committed }
        const base = f.request('authoring-once')
        const unsigned = { ...base, command: { name: 'scene.patch_many' as const,
            input: { presetId: 'preset-1', expectedRevision: 0, changes: [{ sceneId: 'scene-1', name: 'Rain' }] } } }
        const envelope = { ...unsigned, requestHash: agentRequestHash(unsigned) }
        return { ...f, ...f.reopen(), envelope, target, inspect, apply, clearFacts: () => { committed = null },
            consent: (enabled: boolean, workspaceId = 'workspace-1', clientId = 'client-1') => {
                consent = updateAgentAuthoringConsent(consent, consent.revision, workspaceId, clientId, enabled)
            } }
    }
    it('performs two successive opted-in edits across restart, deduplicates, then requires approval immediately after OFF', async () => {
        const f = authoring()
        const initialPolicy = f.getPolicy()
        f.consent(true)
        const request = (id: string, revision: number) => {
            const value = { ...f.envelope, requestId: id, context: { ...f.envelope.context, idempotencyKey: id },
                command: { ...f.envelope.command, input: { ...f.envelope.command.input, expectedRevision: revision } } }
            return { ...value, requestHash: agentRequestHash(value) }
        }
        const first = request('always-edit-first', 0)
        expect(await f.dispatcher.dispatch(first)).toMatchObject({ state: 'completed', result: { revision: 1 } })
        expect(await f.dispatcher.dispatch(first)).toMatchObject({ state: 'completed' })
        f.inspect.mockResolvedValue({ ...f.target, expectedRevision: 1 })
        const reopened = f.reopen()
        await reopened.coordinator.recover()
        expect(await reopened.dispatcher.dispatch(request('always-edit-second', 1))).toMatchObject({ state: 'completed', result: { revision: 2 } })
        expect(f.apply).toHaveBeenCalledTimes(2)
        const ledger = (await f.opts.repository.get('workspace-1'))!
        expect(parseAgentExecutionLedger(ledger, 'workspace-1')).toEqual(ledger)
        expect(ledger.records.map(record => record.grant)).toEqual(expect.arrayContaining([
            expect.objectContaining({ authorization: 'client-always-edit', consentRevision: 1 }),
        ]))
        expect(await reopened.dispatcher.dispatch(f.request('generation-still-asks'))).toMatchObject({ state: 'needs-input', result: { code: 'AGENT_APPROVAL_REQUIRED' } })
        expect(f.enqueue).not.toHaveBeenCalled()
        f.consent(false)
        f.inspect.mockResolvedValue({ ...f.target, expectedRevision: 2 })
        expect(await reopened.dispatcher.dispatch(request('always-edit-off', 2))).toMatchObject({ state: 'needs-input', result: { code: 'AGENT_APPROVAL_REQUIRED' } })
        expect(f.apply).toHaveBeenCalledTimes(2)
        expect(f.getPolicy()).toEqual(initialPolicy)
        // Restoring opt-in does not replay a request already awaiting its own human decision.
        f.consent(true)
        expect(await reopened.dispatcher.dispatch(request('always-edit-off', 2))).toMatchObject({ state: 'needs-input' })
        expect(f.apply).toHaveBeenCalledTimes(2)
    })
    it.each(['foreign-client', 'foreign-workspace', 'paused', 'observe', 'revoked', 'stale-target', 'off-during-inspect'])('retains editing safeguards for %s', async scenario => {
        const f = authoring()
        f.consent(true, scenario === 'foreign-workspace' ? 'workspace-other' : 'workspace-1', scenario === 'foreign-client' ? 'client-other' : 'client-1')
        if (scenario === 'paused') f.setPolicy({ ...f.getPolicy(), globalPause: true })
        if (scenario === 'observe') f.setPolicy({ ...f.getPolicy(), mode: 'observe' })
        if (scenario === 'revoked') f.revoke()
        if (scenario === 'stale-target') f.inspect.mockResolvedValueOnce(f.target).mockResolvedValueOnce({ ...f.target, targetHash: `sha256:${'b'.repeat(64)}` })
        if (scenario === 'off-during-inspect') f.inspect.mockImplementationOnce(async () => f.target).mockImplementationOnce(async () => { f.consent(false); return f.target })
        expect((await f.dispatcher.dispatch(f.envelope)).state).not.toBe('completed')
        expect(f.apply).not.toHaveBeenCalled()
        expect(f.enqueue).not.toHaveBeenCalled()
    })
    it('keeps pending generation approval binding unchanged when editing consent changes', async () => {
        const f = authoring()
        await f.dispatcher.dispatch(f.request('pending-generation'))
        const before = (await f.coordinator.pending()).find(item => item.requestId === 'pending-generation')!
        f.consent(true)
        const after = (await f.coordinator.pending()).find(item => item.requestId === 'pending-generation')!
        expect(after).toEqual(before)
        expect(f.enqueue).not.toHaveBeenCalled()
    })
    it('keeps explicit editing consent independent from expired bounded-auto and preserves a separate valid bounded-auto grant after OFF', async () => {
        const f = authoring('bounded-auto')
        f.setPolicy({ ...f.getPolicy(), boundedAutoExpiresAt: initialTime })
        f.consent(true)
        expect((await f.dispatcher.dispatch(f.envelope)).state).toBe('completed')
        expect((await f.opts.repository.get('workspace-1'))!.records[0].grant?.authorization).toBe('client-always-edit')
        const separate = authoring('bounded-auto')
        separate.setPolicy({ ...separate.getPolicy(), authoring: { allowSceneChanges: true } })
        separate.consent(true); separate.consent(false)
        // OFF withdraws only this consent; an independently enabled legacy policy keeps its original scope/expiry.
        const value = { ...separate.envelope, requestId: 'independent-bounded', context: { ...separate.envelope.context, idempotencyKey: 'independent-bounded' } }
        expect((await separate.dispatcher.dispatch({ ...value, requestHash: agentRequestHash(value) })).state).toBe('completed')
        const ledger = (await separate.opts.repository.get('workspace-1'))!
        expect(ledger.records.find(record => record.envelope.requestId === 'independent-bounded')?.grant?.authorization).toBe('bounded-auto')
    })
    it.each(['patch', 'create-denied', 'create-allowed', 'rename-denied', 'rename-allowed'])('scopes client folder editing consent for %s', async scenario => {
        const f = authoring()
        f.consent(true)
        const createsFolders = scenario.startsWith('create')
        const renamesPathSegments = scenario.startsWith('rename')
        const allowed = scenario === 'patch' || scenario.endsWith('allowed')
        f.setPolicy({ ...f.getPolicy(), output: { ...f.getPolicy().output,
            allowCreateFolders: createsFolders && allowed, allowRenamePathSegments: renamesPathSegments && allowed } })
        f.inspect.mockResolvedValue({ ...f.target, command: 'folder.apply_changes', resourceId: 'local', createsFolders, renamesPathSegments })
        const value = { ...f.envelope, command: { name: 'folder.apply_changes' as const,
            input: { expectedRevision: 0, expectedPlanHash: digest, changes: [createsFolders
                ? { op: 'create', folderId: 'folder-1', parentId: 'root', displayName: 'Folder', pathSegment: 'Folder' }
                : { op: 'patch', folderId: 'folder-1', ...(renamesPathSegments ? { pathSegment: 'Updated' } : { commonPrompt: 'Reviewed text' }) }] } } }
        expect((await f.dispatcher.dispatch({ ...value, requestHash: agentRequestHash(value) })).state).toBe(allowed ? 'completed' : 'needs-input')
        expect(f.apply).toHaveBeenCalledTimes(allowed ? 1 : 0)
        expect(f.enqueue).not.toHaveBeenCalled()
    })
    it('rejects altered client-consent authorization evidence in the durable ledger', async () => {
        const f = authoring()
        f.consent(true)
        await f.dispatcher.dispatch(f.envelope)
        const ledger = (await f.opts.repository.get('workspace-1'))!
        for (const revision of [undefined, -1, 0, 1.5, Number.MAX_SAFE_INTEGER]) {
            const corrupt = structuredClone(ledger)
            ;(corrupt.records[0].grant as any).consentRevision = revision
            expect(() => parseAgentExecutionLedger(corrupt, 'workspace-1')).toThrow()
        }
    })
    it('requires review, persists one grant, survives restart and replays exact saved completion', async () => {
        const f = authoring()
        expect(await f.dispatcher.dispatch(f.envelope)).toMatchObject({ state: 'needs-input', result: { code: 'AGENT_APPROVAL_REQUIRED' } })
        expect(f.apply).not.toHaveBeenCalled()
        const [review] = await f.coordinator.pending()
        expect(review).toMatchObject({ command: 'scene.patch_many', resourceId: 'preset-1', changeCount: 1 })
        await Promise.all([f.coordinator.approve(review.requestId, review), f.reopen().coordinator.approve(review.requestId, review)])
        expect(f.apply).toHaveBeenCalledTimes(1)
        const reopened = f.reopen()
        await reopened.coordinator.recover()
        expect(await reopened.dispatcher.dispatch(f.envelope)).toMatchObject({ state: 'completed', result: { status: 'authoring-committed' } })
        expect(f.enqueue).not.toHaveBeenCalled()
    })
    it.each(['default-deny', 'enabled', 'paused', 'expired'])('scopes bounded authoring authority for %s', async scenario => {
        const f = authoring('bounded-auto')
        f.setPolicy({ ...f.getPolicy(), authoring: { allowSceneChanges: scenario !== 'default-deny' },
            globalPause: scenario === 'paused', boundedAutoExpiresAt: scenario === 'expired' ? initialTime : '2026-09-05T01:00:00.000Z' })
        const receipt = await f.dispatcher.dispatch(f.envelope)
        expect(f.apply).toHaveBeenCalledTimes(scenario === 'enabled' ? 1 : 0)
        expect(receipt.state).toBe(scenario === 'enabled' ? 'completed' : 'needs-input')
        expect(f.enqueue).not.toHaveBeenCalled()
    })
    it.each(['stale-target', 'revoked', 'wrong-binding', 'policy-change'])('does not apply with %s', async scenario => {
        const f = authoring()
        await f.dispatcher.dispatch(f.envelope)
        const [review] = await f.coordinator.pending()
        if (scenario === 'stale-target') f.inspect.mockResolvedValue({ ...f.target, targetHash: `sha256:${'b'.repeat(64)}` })
        if (scenario === 'revoked') f.revoke()
        if (scenario === 'policy-change') f.setPolicy({ ...f.getPolicy(), revision: 1 })
        if (scenario === 'wrong-binding') await expect(f.coordinator.approve(review.requestId, { ...review, targetHash: `sha256:${'b'.repeat(64)}` })).rejects.toThrow()
        else await f.coordinator.approve(review.requestId, review)
        expect(f.apply).not.toHaveBeenCalled()
    })
    it.each([true, false])('reconciles only persisted positive evidence after uncertain apply: %s', async hasFacts => {
        const f = authoring('bounded-auto')
        f.setPolicy({ ...f.getPolicy(), authoring: { allowSceneChanges: true } })
        const original = f.apply.getMockImplementation()!
        f.apply.mockImplementation(async (...args) => { await original(...args); if (!hasFacts) f.clearFacts(); throw new Error('crash') })
        expect(await f.dispatcher.dispatch(f.envelope)).toMatchObject({ state: 'needs-input', result: { code: 'AGENT_EXECUTION_UNKNOWN' } })
        const reopened = f.reopen()
        await reopened.coordinator.recover()
        const receipt = await reopened.dispatcher.dispatch(f.envelope)
        expect(receipt.state).toBe(hasFacts ? 'completed' : 'needs-input')
        expect(f.apply).toHaveBeenCalledTimes(1)
    })
    it.each(['create-denied', 'create-allowed', 'rename-denied', 'rename-allowed'])('enforces existing folder flags for %s', async scenario => {
        const f = authoring('bounded-auto')
        const create = scenario.startsWith('create')
        const permitted = scenario.endsWith('allowed')
        f.setPolicy({ ...f.getPolicy(), output: { ...f.getPolicy().output,
            allowCreateFolders: create && permitted, allowRenamePathSegments: !create && permitted } })
        f.inspect.mockResolvedValue({ ...f.target, command: 'folder.apply_changes', resourceId: 'local',
            createsFolders: create, renamesPathSegments: !create })
        const unsigned = { ...f.envelope, command: { name: 'folder.apply_changes' as const,
            input: { expectedRevision: 0, expectedPlanHash: digest, changes: [create
                ? { op: 'create', folderId: 'folder-1', parentId: 'root', displayName: 'Folder', pathSegment: 'Folder' }
                : { op: 'patch', folderId: 'folder-1', pathSegment: 'Updated' }] } } }
        const receipt = await f.dispatcher.dispatch({ ...unsigned, requestHash: agentRequestHash(unsigned) })
        expect(receipt.state).toBe(permitted ? 'completed' : 'needs-input')
        expect(f.apply).toHaveBeenCalledTimes(permitted ? 1 : 0)
        if (!permitted) {
            const [review] = await f.coordinator.pending()
            await f.coordinator.approve(review.requestId, review)
            expect(f.apply).not.toHaveBeenCalled()
        }
    })
    it('rejects forged authoring result and consent bindings in persisted ledger data', async () => {
        const f = authoring('bounded-auto')
        f.setPolicy({ ...f.getPolicy(), authoring: { allowSceneChanges: true } })
        await f.dispatcher.dispatch(f.envelope)
        const ledger = (await f.opts.repository.get('workspace-1'))!
        expect(parseAgentExecutionLedger(ledger, 'workspace-1')).toEqual(ledger)
        for (const mutate of [
            (record: any) => { record.grant.target.resourceId = 'other-preset' },
            (record: any) => { record.grant.policyRevision += 1 },
            (record: any) => { record.result.revision += 1 },
            (record: any) => { record.target.changeCount += 1 },
        ]) {
            const corrupt = structuredClone(ledger)
            mutate(corrupt.records[0])
            expect(() => parseAgentExecutionLedger(corrupt, 'workspace-1')).toThrow()
        }
    })

})
