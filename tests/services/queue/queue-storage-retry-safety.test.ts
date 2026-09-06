import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createArtifactRecord, type ArtifactRecord } from '@/domain/organizer/types'
import type { ProviderAttemptEvidence } from '@/domain/queue/provider-result'
import type { QueueArtifactReference } from '@/domain/queue/types'
import { IndexedDBQueueRepository, assertFilesCommittedRecoveryEligibility } from '@/services/queue/indexeddb-queue-repository'
import { createGenerationJobSnapshot } from '@/services/queue/job-snapshot'
import type { QueueArtifactRepository } from '@/services/queue/queue-artifact-lineage'
import { recoverQueueLinkedOutputs, retryQueueLinkedOutput } from '@/services/queue/queue-output-recovery'
import { storageRetryWriterFixture } from './queue-storage-retry-fixture'

const NOW = '2026-09-06T01:00:00.000Z'
const EXPIRED = '2026-09-06T01:01:00.000Z'
const DIGEST = `sha256:${'a'.repeat(64)}` as const
const PREPARED: ProviderAttemptEvidence = {
    dispatchState: 'prepared', providerOutcome: 'running', billingRisk: 'none', responseDigest: null, spoolReceipt: null,
}
const POSSIBLY: ProviderAttemptEvidence = { ...PREPARED, dispatchState: 'possibly-dispatched', billingRisk: 'possible' }
const UNKNOWN: ProviderAttemptEvidence = { ...POSSIBLY, providerOutcome: 'unknown' }

async function fixture(modern = false) {
    const repository = new IndexedDBQueueRepository({
        factory: new IDBFactory() as unknown as globalThis.IDBFactory,
        keyRange: IDBKeyRange as unknown as typeof globalThis.IDBKeyRange,
        databaseName: `storage-retry-${crypto.randomUUID()}`,
    })
    const snapshot = createGenerationJobSnapshot({
        prompt: { positive: 'fixed', negative: '' }, parameters: {}, outputPolicy: {}, resources: [], resumability: 'resumable',
        ...(modern ? { providerExecutionEnvelope: {
            schemaVersion: 1 as const, provider: 'novelai' as const,
            compatibilityProfileId: 'nai-payload-v1-model-generate-none', payloadBuilderRevision: 'nai-payload-v1',
            modelCatalogRevision: 'nai-model-catalog-v1', action: 'generate' as const, responseMode: 'standard' as const,
            semanticIntentHash: DIGEST, queueResourceBindings: [],
        } } : {}),
    })
    await repository.createBatchAndEnqueue({
        batch: { id: 'batch:1', workflow: 'main', createdAt: NOW, failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch-key' },
        jobs: [1, 2].map(number => ({
            id: `job:${number}`, batchId: 'batch:1', workflow: 'main', sceneId: null, createdAt: NOW,
            priority: 0, ordinal: number, compositionPlanHash: null, maxAttempts: 3,
            idempotencyKey: `job-key:${number}`, snapshot,
        })),
    })
    const lease = await repository.acquireLease({ jobId: 'job:1', owner: 'worker', now: NOW, ttlMs: 1_000 })
    const leaseIdentity = { jobId: 'job:1', leaseOwner: 'worker', leaseToken: lease!.leaseToken!, now: NOW }
    await repository.transitionJob({ ...leaseIdentity, to: 'running' })
    const artifactReference: QueueArtifactReference = { kind: 'output-writer', artifactId: 'artifact:1', digest: DIGEST, mimeType: 'image/png' }
    await repository.bindOutputTransaction({ ...leaseIdentity, outputTransactionId: 'txn-bound', artifactReference })
    const records = new Map<string, ArtifactRecord>()
    const artifacts: QueueArtifactRepository = {
        get: async id => records.get(id) ?? null,
        putOriginal: async input => {
            const record = createArtifactRecord(input)
            records.set(record.artifactId, record)
            return record
        },
        removeOriginalIfUnmodified: async input => records.delete(input.artifactId),
    }
    const output = storageRetryWriterFixture()
    await output.seedFilesCommitted()
    const otherJob = await repository.getJob('job:2')
    const fetch = vi.fn(() => { throw new Error('Provider/network must not run') })
    vi.stubGlobal('fetch', fetch)
    const acquireLease = vi.spyOn(repository, 'acquireLease')
    const retry = (now = EXPIRED) => retryQueueLinkedOutput(repository, output.writer, { jobId: 'job:1', now, artifactRepository: artifacts })
    const transition = async (expectedEvidence: ProviderAttemptEvidence, nextEvidence: ProviderAttemptEvidence, unknown = false) => {
        await repository.recordProviderAttemptTransition({
            ...leaseIdentity, attemptNumber: 1, expectedEvidence, nextEvidence,
            ...(unknown ? { blockReason: 'provider-outcome-unknown' as const } : {}),
        })
    }
    async function expectNoDispatchOrOtherJobChange() {
        expect(fetch).not.toHaveBeenCalled()
        expect(acquireLease).not.toHaveBeenCalled()
        expect(await repository.getJob('job:2')).toEqual(otherJob)
        expect(output.calls).not.toContain('write-file')
    }
    return { repository, artifacts, records, output, retry, transition, artifactReference, expectNoDispatchOrOtherJobChange }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('files-committed recovery with actual Queue and OutputWriter', () => {
    it('recovers an expired legacy attempt and leaves other jobs and Provider untouched', async () => {
        const value = await fixture()
        expect((await value.repository.listAttempts('job:1'))[0].providerEvidence).toBeNull()
        await expect(value.retry()).resolves.toEqual({ status: 'ready' })
        expect(await value.repository.getJob('job:1')).toMatchObject({ state: 'succeeded', attemptCount: 1 })
        expect(value.records.get('artifact:1')).toMatchObject({ sourceJobId: 'job:1' })
        expect(value.output.journals.size).toBe(0)
        expect(value.output.files.size).toBe(1)
        await value.expectNoDispatchOrOtherJobChange()
    })

    it('rejects a live lease but preserves prior-process startup recovery authority', async () => {
        const value = await fixture()
        await expect(value.retry(NOW)).resolves.toMatchObject({ status: 'failed', message: expect.stringContaining('active Queue executor') })
        expect(value.records.size).toBe(0)
        expect(value.output.journals.size).toBe(1)
        expect(await recoverQueueLinkedOutputs(value.repository, value.output.writer, { now: NOW, artifactRepository: value.artifacts }))
            .toEqual([{ transactionId: 'txn-bound', action: 'retried' }])
        await value.expectNoDispatchOrOtherJobChange()
    })

    it('preserves verified spooled Provider evidence while repairing only files-committed workflow', async () => {
        const value = await fixture(true)
        const started: ProviderAttemptEvidence = { ...POSSIBLY, dispatchState: 'response-started' }
        const complete: ProviderAttemptEvidence = {
            ...started, dispatchState: 'response-complete', providerOutcome: 'succeeded', billingRisk: 'confirmed', responseDigest: DIGEST,
        }
        const spooled: ProviderAttemptEvidence = { ...complete, dispatchState: 'result-spooled', spoolReceipt: {
            schemaVersion: 1, spoolId: 'spool-1', attemptId: 'job:1:1', contentType: 'image/png', byteLength: 4, sha256: DIGEST, committedAt: NOW,
        } }
        for (const [before, after] of [[PREPARED, POSSIBLY], [POSSIBLY, started], [started, complete], [complete, spooled]]) {
            await value.transition(before, after)
        }
        await expect(value.retry()).resolves.toEqual({ status: 'ready' })
        expect((await value.repository.listAttempts('job:1'))[0].providerEvidence).toEqual(spooled)
        await value.expectNoDispatchOrOtherJobChange()
    })

    it.each(['cancel', 'unknown'] as const)('rejects a %s race after Artifact registration and preserves files and journal', async race => {
        const value = await fixture(race === 'unknown')
        if (race === 'unknown') await value.transition(PREPARED, POSSIBLY)
        const putOriginal = value.artifacts.putOriginal
        vi.spyOn(value.artifacts, 'putOriginal').mockImplementationOnce(async input => {
            const result = await putOriginal(input)
            if (race === 'cancel') await value.repository.requestCancel({ jobId: 'job:1', now: NOW })
            else await value.transition(POSSIBLY, UNKNOWN, true)
            return result
        })
        await expect(value.retry()).resolves.toMatchObject({ status: 'failed' })
        expect(value.records.size).toBe(0)
        expect((await value.repository.getJob('job:1'))?.state).not.toBe('succeeded')
        expect((await value.output.writer.inspectQueueTransaction('txn-bound'))?.phase).toBe('files-committed')
        expect(value.output.files.size).toBe(1)
        await value.expectNoDispatchOrOtherJobChange()
    })

    it.each(['cancel', 'unknown'] as const)('leaves %s files-committed evidence outside startup orphan rollback', async disposition => {
        const value = await fixture(disposition === 'unknown')
        if (disposition === 'cancel') await value.repository.requestCancel({ jobId: 'job:1', now: NOW })
        else { await value.transition(PREPARED, POSSIBLY); await value.transition(POSSIBLY, UNKNOWN, true) }
        await value.output.seedFilesCommitted('orphan', 'missing-job')
        const linked = await recoverQueueLinkedOutputs(value.repository, value.output.writer, { now: EXPIRED, artifactRepository: value.artifacts })
        expect(linked).toContainEqual(expect.objectContaining({ transactionId: 'txn-bound', action: 'failed' }))
        expect(linked).toContainEqual({ transactionId: 'orphan', action: 'rolled-back' })
        await value.output.writer.recoverPending({ excludeTransactionIds: linked.map(result => result.transactionId) })
        expect(value.output.journals.has('txn-bound')).toBe(true)
        expect(value.output.journals.has('orphan')).toBe(false)
        expect(value.output.files.size).toBe(1)
        expect(value.records.size).toBe(0)
        await value.expectNoDispatchOrOtherJobChange()
    })

    it('rejects changed attempt CAS and unknown attempt evidence independently of the job projection', async () => {
        const value = await fixture(true)
        await expect(value.repository.recoverFilesCommittedSuccess({
            jobId: 'job:1', now: EXPIRED, outputTransactionId: 'txn-bound', artifactReference: value.artifactReference,
            expectedAttemptCount: 0, rejectActiveLease: true,
        })).rejects.toMatchObject({ code: 'E_QUEUE_IDEMPOTENCY_CONFLICT' })
        await value.transition(PREPARED, POSSIBLY)
        await value.transition(POSSIBLY, UNKNOWN, true)
        const attempt = (await value.repository.listAttempts('job:1'))[0]
        expect(() => assertFilesCommittedRecoveryEligibility({
            state: 'running', cancelRequestedAt: null, blockReason: null, leaseExpiresAt: null,
        }, attempt, EXPIRED, true)).toThrow('Provider evidence')
        expect(value.output.journals.size).toBe(1)
        await value.expectNoDispatchOrOtherJobChange()
    })

    it('keeps active write ownership through workflow persistence and rejects recovery before journal reads', async () => {
        const output = storageRetryWriterFixture()
        let entered!: () => void
        let finish!: () => void
        const started = new Promise<void>(resolve => { entered = resolve })
        const waiting = new Promise<void>(resolve => { finish = resolve })
        const active = output.writer.write({
            transactionId: 'active-write', sourceJobId: 'job:1',
            destination: {
                directory: 'output', workflowDefaultDirectory: 'output', useAbsolutePath: false,
                extension: 'png', fileName: 'active.png', collisionPolicy: 'unique',
            },
            imageBytes: new Uint8Array([1]), imageDataUrl: 'data:image/png;base64,AQ==',
            canCommit: () => true, commitWorkflow: async () => { entered(); await waiting },
        })
        await started
        expect(output.writer.isTransactionActive('active-write')).toBe(true)
        output.calls.length = 0
        await expect(output.writer.retryFilesCommittedWorkflow('active-write', 'job:1', vi.fn()))
            .resolves.toMatchObject({ ineligibility: 'transaction-active' })
        await expect(output.writer.recoverTransaction('active-write'))
            .resolves.toMatchObject({ ineligibility: 'transaction-active' })
        expect(output.calls).toEqual([])
        finish()
        await expect(active).resolves.toMatchObject({ status: 'committed' })
        expect(output.writer.isTransactionActive('active-write')).toBe(false)
        expect(output.files.size).toBe(1)
    })

    it('fails closed on malformed or mismatched targeted journal identity without modifying evidence', async () => {
        const value = await fixture()
        const journal = value.output.journals.get('txn-bound')!
        value.output.journals.set('mismatch', journal)
        await expect(value.output.writer.inspectQueueTransaction('mismatch')).rejects.toThrow('identity differs')
        await expect(value.output.writer.retryFilesCommittedWorkflow('mismatch', 'job:1', vi.fn()))
            .resolves.toMatchObject({ action: 'failed' })
        value.output.journals.set('malformed', new TextEncoder().encode('{}'))
        await expect(value.output.writer.inspectQueueTransaction('malformed')).rejects.toThrow()
        expect(value.output.journals.get('mismatch')).toEqual(journal)
        expect(value.output.files.size).toBe(1)
        await value.expectNoDispatchOrOtherJobChange()
    })

    it('excludes a shared active writer even with an expired Queue lease, and targets inspection to one journal', async () => {
        const value = await fixture()
        let entered!: () => void
        let finish!: () => void
        const started = new Promise<void>(resolve => { entered = resolve })
        const waiting = new Promise<void>(resolve => { finish = resolve })
        const active = value.output.writer.retryFilesCommittedWorkflow('txn-bound', 'job:1', async () => { entered(); await waiting })
        await started
        expect(value.output.writer.isTransactionActive('txn-bound')).toBe(true)
        await expect(value.retry()).resolves.toEqual({ status: 'ineligible', reason: 'transaction-active' })
        await expect(value.output.writer.recoverTransaction('txn-bound')).resolves.toMatchObject({ ineligibility: 'transaction-active' })
        value.output.calls.length = 0
        expect((await value.output.writer.inspectQueueTransaction('txn-bound'))?.phase).toBe('files-committed')
        expect(value.output.calls).toEqual(['read:txn-bound'])
        expect(value.records.size).toBe(0)
        finish()
        await active
        expect(value.output.writer.isTransactionActive('txn-bound')).toBe(false)
        await value.expectNoDispatchOrOtherJobChange()
    })
})
