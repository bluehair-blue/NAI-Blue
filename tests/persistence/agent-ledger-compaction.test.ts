import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IndexedDbAgentExecutionRepository } from '@/adapters/agent/indexeddb-agent-execution-repository'
import { IndexedDbCommandReceiptRepository } from '@/adapters/agent/indexeddb-command-receipt-repository'
import { AgentCommandDispatcher } from '@/application/agent/agent-command-dispatcher'
import { agentRequestHash, type AgentCommandEnvelope } from '@/application/agent/agent-command-contract'
import { createAgentExecutionCoordinator, type AgentExecutionCoordinatorOptions } from '@/application/agent/agent-execution-coordinator'
import { DEFAULT_AGENT_EXECUTION_POLICY, type AgentExecutionPolicy } from '@/application/agent/agent-execution-policy'
import { parseAgentExecutionLedger, type AgentExecutionLedger, type AgentExecutionRecord, type AgentGenerationExecutionRecord } from '@/application/agent/agent-execution-repository'
import { agentResultDigest } from '@/application/agent/command-receipt-repository'
import type { GenerationPlan } from '@/application/generation/generation-plan-contract'
import type { JsonObject } from '@/domain/composition/types'
import { resetIndexedDBConnectionForRetry, setIndexedDBItemStrict } from '@/lib/indexed-db'

const digest = `sha256:${'a'.repeat(64)}` as const
const KEY = 'nai-blue-agent-execution:workspace-1'
const LATER = '2026-09-07T00:00:00.000Z'

function fixture() {
    let time = '2026-09-05T00:00:01.000Z'
    const policy: AgentExecutionPolicy = { ...structuredClone(DEFAULT_AGENT_EXECUTION_POLICY), mode: 'bounded-auto',
        boundedAutoExpiresAt: '2026-09-05T01:00:00.000Z' }
    const plan = { schemaVersion: 1, planId: digest, planHash: digest, semanticPlanHash: digest, sourceBindings: [],
        jobs: [{ ordinal: 0, estimatedAnlas: 7, semantic: { prompt: 'p', negativePrompt: 'n', model: 'nai-diffusion-5-full', width: 832,
            height: 1216, steps: 28, seed: 1, generationParameters: {} }, compatibility: { status: 'captured-pass' }, destination: { collisionPolicy: 'fail' } }],
        estimatedAnlas: 7, issues: [], requiredApprovals: [], executionPolicy: { maxConcurrency: 1 }, budget: { maxImages: 1, maxAnlas: 10 } } as unknown as GenerationPlan
    const enqueue = vi.fn(async (_plan: GenerationPlan, grant: { scopeId: string }) => {
        const batchId = `main-batch-${grant.scopeId}`
        return { status: 'ready', batchId, runId: batchId, jobIds: [`${batchId}:0`] }
    })
    const isOutstanding = vi.fn(async (_grant: { requestId: string }) => false)
    const receipts = new IndexedDbCommandReceiptRepository()
    const opts: AgentExecutionCoordinatorOptions = { workspaceId: 'workspace-1', repository: new IndexedDbAgentExecutionRepository(), receipts,
        plans: { get: async () => structuredClone(plan), putIfAbsent: async () => 'same' }, getPolicy: () => policy, now: () => time,
        isClientAuthorized: async () => true, ports: { validate: async () => true, enqueue, reconcile: async () => null, isOutstanding } }
    function open() {
        const coordinator = createAgentExecutionCoordinator({ ...opts, repository: new IndexedDbAgentExecutionRepository() })
        const dispatcher = new AgentCommandDispatcher({ workspaceId: 'workspace-1', receipts, handlers: [coordinator.handler],
            authentication: { authenticate: async envelope => ({ clientId: envelope.context.clientId, actor: { kind: envelope.context.actor.kind, id: `client:${envelope.context.clientId}` } }) },
            runtime: () => ({ ready: true, mode: policy.mode, globalPause: false }), now: () => time })
        return { coordinator, dispatcher }
    }
    function request(requestId: string, { expiresAt = '2026-09-05T02:00:00.000Z', submittedAt = '2026-09-05T00:00:00.000Z', idempotencyKey = requestId } = {}): AgentCommandEnvelope {
        const envelope: AgentCommandEnvelope = { schemaVersion: 1, requestId, requestHash: digest, submittedAt, expiresAt,
            context: { apiVersion: 'nai-blue.agent/v1alpha1', workspaceId: 'workspace-1', clientId: 'client-1', actor: { kind: 'agent' }, idempotencyKey },
            command: { name: 'generation.enqueue', input: { planId: digest, planHash: digest } },
            authentication: { scheme: 'hmac-sha256', keyId: 'key-1', signature: `hmac-sha256:${'0'.repeat(64)}` } }
        return { ...envelope, requestHash: agentRequestHash(envelope) }
    }
    function record(envelope: AgentCommandEnvelope, state: 'pending' | 'rejected', result: JsonObject): AgentGenerationExecutionRecord {
        return { envelope, policyRevision: 0, originalPolicyRevision: 0, expiresAt: envelope.expiresAt!, estimatedAnlas: 7, imageCount: 1,
            exposureSettledAt: null, state, grant: null, result }
    }
    async function receipt(envelope: AgentCommandEnvelope, final?: { state: 'rejected' | 'needs-input'; result: JsonObject }) {
        const claimed = await receipts.claim({ schemaVersion: 1, requestId: envelope.requestId, requestHash: envelope.requestHash,
            authenticatedClientId: 'client-1', command: 'generation.enqueue', state: 'accepted', observedAt: '2026-09-05T00:00:00.000Z',
            resultSchemaVersion: 1, result: null, resultDigest: null })
        if (final) await receipts.finish(claimed.receipt, { ...claimed.receipt, ...final, resultDigest: agentResultDigest(final.result) })
    }
    /** Appends history as another owner would: raw bytes the repository has never validated. */
    async function append(records: readonly AgentExecutionRecord[], compacted: AgentExecutionLedger['compacted'] = undefined) {
        const current = await new IndexedDbAgentExecutionRepository().get('workspace-1')
        const all = [...current?.compacted ?? [], ...compacted ?? []]
        const next = { workspaceId: 'workspace-1', revision: (current?.revision ?? -1) + 1, records: [...current?.records ?? [], ...records] }
        await setIndexedDBItemStrict(KEY, JSON.stringify(all.length ? { schemaVersion: 2, ...next, compacted: all } : { schemaVersion: 1, ...next }))
    }
    /** Expired rejected records with final receipts: every one is compactable once older than the newest 200. */
    async function fillers(count: number, prefix = 'f') {
        const rejected = { code: 'AGENT_HUMAN_REJECTED' }
        const envelopes = Array.from({ length: count }, (_, index) => request(`${prefix}${index}`))
        await Promise.all(envelopes.map(envelope => receipt(envelope, { state: 'rejected', result: rejected })))
        return envelopes.map(envelope => record(envelope, 'rejected', rejected))
    }
    const ledger = async () => (await new IndexedDbAgentExecutionRepository().get('workspace-1'))!
    return { open, request, record, receipt, append, fillers, ledger, enqueue, isOutstanding, receipts, opts,
        setTime: (next: string) => { time = next } }
}
beforeEach(() => { resetIndexedDBConnectionForRetry(); vi.stubGlobal('indexedDB', new IDBFactory()) })
afterEach(() => { resetIndexedDBConnectionForRetry(); vi.unstubAllGlobals() })

describe('automatic execution history compaction', () => {
    it('compacts only eligible old terminal records of an existing version 1 ledger and keeps their identities', async () => {
        const f = fixture()
        const live = f.open()
        f.isOutstanding.mockResolvedValue(true)
        expect((await live.dispatcher.dispatch(f.request('settled'))).state).toBe('completed')
        expect((await live.dispatcher.dispatch(f.request('unsettled'))).state).toBe('completed')
        f.isOutstanding.mockImplementation(async grant => grant.requestId === 'unsettled')
        await live.coordinator.recover()
        const approval = { code: 'AGENT_APPROVAL_REQUIRED' }
        const rejected = { code: 'AGENT_HUMAN_REJECTED' }
        const pending = f.request('pending', { expiresAt: LATER })
        const unwritten = f.request('unwritten')
        const unexpired = f.request('unexpired', { expiresAt: LATER })
        await f.receipt(pending, { state: 'needs-input', result: approval })
        await f.receipt(unwritten)
        await f.receipt(unexpired, { state: 'rejected', result: rejected })
        await f.append([f.record(pending, 'pending', approval), f.record(unwritten, 'rejected', rejected),
            f.record(unexpired, 'rejected', rejected), ...await f.fillers(300)])
        expect((await f.ledger()).schemaVersion).toBe(1)
        expect((await f.ledger()).records).toHaveLength(305)

        f.setTime('2026-09-05T03:00:00.000Z')
        const active = f.open()
        await active.dispatcher.dispatch(f.request('trigger', { submittedAt: '2026-09-05T02:59:00.000Z', expiresAt: LATER }))
        const compacted = await f.ledger()
        expect(compacted.schemaVersion).toBe(2)
        expect(compacted.compacted).toEqual([{ requestId: 'settled', clientId: 'client-1', idempotencyKey: 'settled' },
            ...Array.from({ length: 100 }, (_, index) => ({ requestId: `f${index}`, clientId: 'client-1', idempotencyKey: `f${index}` }))])
        // 304 terminal records keep the newest 200; of the older 104 only the three ineligible specials stay.
        expect(compacted.records.map(item => item.envelope.requestId).slice(0, 5)).toEqual(['unsettled', 'pending', 'unwritten', 'unexpired', 'f100'])
        expect(compacted.records).toHaveLength(205)
        expect(parseAgentExecutionLedger(compacted, 'workspace-1')).toEqual(compacted)

        // Replay of a compacted request is answered by its saved receipt; nothing runs again.
        expect(await active.dispatcher.dispatch(f.request('settled'))).toMatchObject({ state: 'completed', result: { status: 'ready' } })
        expect(await active.dispatcher.dispatch(f.request('f0'))).toMatchObject({ state: 'rejected', result: rejected })
        // Only the durable ledger enforces operation keys; both identities survive compaction.
        expect(await active.dispatcher.dispatch(f.request('reuse', { idempotencyKey: 'f0', expiresAt: LATER, submittedAt: '2026-09-05T02:59:00.000Z' })))
            .toMatchObject({ state: 'rejected', result: { code: 'AGENT_IDEMPOTENCY_CONFLICT' } })
        const reused = f.request('settled', { expiresAt: LATER, submittedAt: '2026-09-05T02:59:00.000Z', idempotencyKey: 'other' })
        expect(await active.coordinator.handler.execute(reused.command.input, { envelope: reused,
            identity: { clientId: 'client-1', actor: { kind: 'agent', id: 'client:client-1' } } })).toEqual({ code: 'AGENT_EXECUTION_EXISTS' })
        expect(f.enqueue).toHaveBeenCalledTimes(2)

        const recovered = await f.open().coordinator.recover()
        expect(recovered.map(item => item.requestId)).toEqual((await f.ledger()).records.map(item => item.envelope.requestId))
        // recover() still finishes the receipt the ledger outran, which makes it eligible for a later pass.
        expect((await f.receipts.get('unwritten'))?.state).toBe('rejected')
        expect((await f.open().coordinator.pending()).map(item => item.requestId)).toEqual(['pending', 'trigger'])
    })

    it('bounds the identity list to the newest 5,000 entries', async () => {
        const f = fixture()
        const old = Array.from({ length: 4_990 }, (_, index) => ({ requestId: `old${index}`, clientId: 'client-1', idempotencyKey: `old${index}` }))
        await f.append(await f.fillers(310), old)
        f.setTime('2026-09-05T03:00:00.000Z')
        await f.open().dispatcher.dispatch(f.request('trigger', { submittedAt: '2026-09-05T02:59:00.000Z', expiresAt: LATER }))
        const ledger = await f.ledger()
        expect(ledger.compacted).toHaveLength(5_000)
        expect(ledger.compacted![0].requestId).toBe('old100')
        expect(ledger.compacted!.at(-1)!.requestId).toBe('f109')
        expect(ledger.records).toHaveLength(201)
    })

    it('still refuses admission at 1,000 records that cannot be compacted', async () => {
        const f = fixture()
        const rejected = { code: 'AGENT_HUMAN_REJECTED' }
        // Unexpired terminal records are never compacted, whatever their receipts say.
        await f.append(Array.from({ length: 1_000 }, (_, index) => f.record(f.request(`u${index}`, { expiresAt: LATER }), 'rejected', rejected)))
        expect(await f.open().dispatcher.dispatch(f.request('over-capacity')))
            .toMatchObject({ state: 'rejected', result: { code: 'AGENT_EXECUTION_CAPACITY' } })
        expect((await f.ledger()).records).toHaveLength(1_000)
        expect(f.enqueue).not.toHaveBeenCalled()
    })

    it('compacts at capacity once records that were ineligible at the last pass have expired', async () => {
        const f = fixture()
        // Final receipts but unexpired: nothing can be compacted yet, so the same coordinator first refuses.
        await f.append(await f.fillers(1_000))
        const live = f.open()
        // The pass below runs with the size already known and leaves 1,000 records it could not touch.
        await live.coordinator.pending()
        expect(await live.dispatcher.dispatch(f.request('too-early')))
            .toMatchObject({ state: 'rejected', result: { code: 'AGENT_EXECUTION_CAPACITY' } })
        f.setTime('2026-09-05T03:00:00.000Z')
        // Bounded-auto has lapsed by now, so admission shows as a stored approval request rather than a capacity refusal.
        expect(await live.dispatcher.dispatch(f.request('after-expiry', { submittedAt: '2026-09-05T02:59:00.000Z', expiresAt: LATER })))
            .toMatchObject({ state: 'needs-input', result: { code: 'AGENT_APPROVAL_REQUIRED' } })
        const ledger = await f.ledger()
        expect(ledger.compacted).toHaveLength(800)
        expect(ledger.records.map(item => item.envelope.requestId).at(-1)).toBe('after-expiry')
        expect(ledger.records).toHaveLength(201)
    })

    it('parses the pre-compaction shape and stays strict about the compacted shape', () => {
        const base = { schemaVersion: 1, workspaceId: 'workspace-1', revision: 3, records: [] }
        const entry = { requestId: 'r1', clientId: 'client-1', idempotencyKey: 'k1' }
        expect(parseAgentExecutionLedger(JSON.parse(JSON.stringify(base)), 'workspace-1')).toEqual(base)
        expect(parseAgentExecutionLedger({ ...base, schemaVersion: 2, compacted: [entry] }, 'workspace-1').compacted).toEqual([entry])
        for (const invalid of [{ ...base, compacted: [entry] }, { ...base, schemaVersion: 2 }, { ...base, schemaVersion: 2, compacted: [] },
            { ...base, schemaVersion: 2, compacted: [entry], extra: true }, { ...base, schemaVersion: 2, compacted: [{ ...entry, extra: 1 }] },
            { ...base, schemaVersion: 2, compacted: [entry, { ...entry, idempotencyKey: 'k2' }] },
            { ...base, schemaVersion: 2, compacted: [{ ...entry, requestId: 'bad id' }] },
            { ...base, schemaVersion: 2, compacted: Array.from({ length: 5_001 }, (_, index) => ({ ...entry, requestId: `r${index}` })) },
            { ...base, schemaVersion: 3 }]) {
            expect(() => parseAgentExecutionLedger(invalid, 'workspace-1')).toThrow()
        }
    })
})
