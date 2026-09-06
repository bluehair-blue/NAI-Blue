import 'fake-indexeddb/auto'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStorageRetryGrant } from '@/application/agent/agent-storage-retry-contract'
import type { ProviderResultSpool } from '@/application/generation/provider-result-spool'
import { createAgentGenerationStorageRetryPort } from '@/composition-root/agent-generation-storage-retry'
import type { OutputReservation } from '@/domain/queue/types'
import type { ProviderAttemptEvidence } from '@/domain/queue/provider-result'
import { IndexedDBArtifactRepository } from '@/services/organizer/artifact-repository'
import { OutputWriter, type OutputWriteResult } from '@/services/output/output-writer'
import * as outputRuntime from '@/services/output/output-writer'
import { createGenerationOutputCommitSet } from '@/services/output/generation-output-commit-set'
import { directoryIdentityForResolvedOutputDirectory, type OutputPlatformAdapter } from '@/services/output/platform-adapter'
import { createGenerationCommandAdapter } from '@/services/queue/generation-command-adapter'
import { IndexedDBQueueRepository } from '@/services/queue/indexeddb-queue-repository'
import * as queueRuntime from '@/services/queue/indexeddb-queue-repository'
import { bindOutputReservationSnapshot, createGenerationJobSnapshot } from '@/services/queue/job-snapshot'
import { recoverQueueLinkedOutputs } from '@/services/queue/queue-output-recovery'
import { initializeQueueAfterRestart, resetQueueStartupForTests } from '@/services/queue/queue-startup'
import * as generationCommands from '@/application/generation/enqueue-generation-plan'

const NOW = '2026-09-06T00:00:00.000Z'
const LATER = '2026-09-06T00:01:00.000Z'
const HASH = 'dbe4f2d96161f10b48104a1522e7269abfb8a16ee223c7514912b5c8afc282d2'
const RUN = `main-batch-agent-${HASH}`
const JOB = `main-job-agent-${HASH}-0`
const TX = `queue-output-${JOB}-1`
const ARTIFACT = `artifact-${HASH}`
let queue: IndexedDBQueueRepository
let artifacts: IndexedDBArtifactRepository
let options: ConstructorParameters<typeof IndexedDBQueueRepository>[0]
let artifactOptions: ConstructorParameters<typeof IndexedDBArtifactRepository>[0]
vi.mock('@/services/organizer/runtime', () => ({ getRuntimeArtifactRepository: () => artifacts }))
vi.mock('@/services/style-lab/style-lab-queue-adapter', () => ({ reconcileStyleLabRenderReservations: async () => ({ spent: 0, released: 0 }) }))
vi.mock('@/application/scene/link-scene-artifact', () => ({ reconcileSceneArtifactLinks: async () => [] }))
vi.mock('@/lib/scene-migration-startup', () => ({ getRuntimeSceneRepository: () => ({}) }))
vi.mock('@/services/queue/queue-r2-release-recovery', () => ({ recoverQueueR2Release: async () => null }))

beforeEach(() => {
    vi.clearAllMocks()
    resetQueueStartupForTests()
    const factory = new IDBFactory()
    options = { factory, keyRange: IDBKeyRange, databaseName: 'agent-storage-retry-queue', generationLimits: {
        maxJobsPerAtomicBatch: 100, maxOutputClaimsPerAtomicBatch: 400, measuredAt: NOW, evidenceId: 'test:bridge',
    } }
    artifactOptions = { factory, keyRange: IDBKeyRange, databaseName: 'agent-storage-retry-artifacts' }
    queue = new IndexedDBQueueRepository(options)
    artifacts = new IndexedDBArtifactRepository(artifactOptions)
})
afterEach(() => { vi.restoreAllMocks(); queue.close(); artifacts.close() })

/** Map storage is the platform fixture; journal parsing, final image facts, and retry use the real OutputWriter. */
async function seed(modern: false | 'response-complete' | 'result-spooled' = false) {
    const files = new Map<string, Uint8Array>()
    const journals = new Map<string, Uint8Array>()
    const directory = { path: 'output', displayPath: '/app-data/output', baseDir: 1, capabilityFallbackUsed: false }
    const platform: OutputPlatformAdapter = {
        capabilities: { absolutePaths: false, atomicSiblingRename: true, outputReservationGuarantee: 'atomic-no-replace', runtime: 'app-scoped' },
        resolveDirectory: async () => directory, ensureDirectory: async () => undefined,
        exists: async file => files.has(file.path), readDirectoryEntries: async () => [],
        writeFile: async (file, bytes) => { files.set(file.path, bytes.slice()) },
        readFile: async file => { const bytes = files.get(file.path); if (!bytes) throw new Error('Missing fixture file'); return bytes.slice() },
        rename: async (from, to) => { files.set(to.path, files.get(from.path)!); files.delete(from.path) },
        commitSiblingIfAbsent: async (from, to) => {
            if (files.has(to.path)) return { status: 'destination-exists' }
            files.set(to.path, files.get(from.path)!); files.delete(from.path)
            return { status: 'committed' }
        },
        remove: async file => { files.delete(file.path) },
        writeJournal: async (id, bytes) => { journals.set(id, bytes.slice()) },
        readJournal: async id => journals.get(id)?.slice() ?? null,
        removeJournal: async id => { journals.delete(id) },
        listJournalIds: vi.fn(async () => [...journals.keys()]),
    }
    const directoryIdentity = directoryIdentityForResolvedOutputDirectory(directory, 'windows')
    const commit = createGenerationOutputCommitSet({ directoryAuthorityId: 'folder', directoryAuthorityFingerprint: directoryIdentity,
        filesystemSemantics: 'windows', fileName: 'result.png', imageFormat: 'png', metadataMode: undefined, preserveProviderOriginal: false })
    const reservation: OutputReservation = { reservationId: 'reservation', batchId: RUN, jobId: JOB,
        folderBinding: { resourceType: 'generation-folder-document', resourceId: 'folder', revision: 1, contentHash: `sha256:${HASH}` },
        directoryIdentity, relativePath: 'result.png', collisionPolicy: 'fail', expectedExistingDigest: null,
        state: 'reserved', reservationSchemaVersion: 1, ...commit, version: 1, updatedAt: NOW }
    const { batchId: _batch, jobId: _job, state: _state, version: _version, updatedAt: _updated, ...snapshotReservation } = reservation
    const snapshot = bindOutputReservationSnapshot(createGenerationJobSnapshot({
        prompt: { positive: 'private prompt never returned', negative: '' }, parameters: {}, outputPolicy: {}, resources: [], resumability: 'resumable',
        ...(modern ? { providerExecutionEnvelope: {
            schemaVersion: 1 as const, provider: 'novelai' as const, compatibilityProfileId: 'nai-payload-v1-model-generate-none',
            payloadBuilderRevision: 'nai-payload-v1', modelCatalogRevision: 'nai-model-catalog-v1', action: 'generate' as const,
            responseMode: 'standard' as const, semanticIntentHash: `sha256:${HASH}` as const, queueResourceBindings: [],
        } } : {}),
    }), snapshotReservation)
    await queue.createBatchAndEnqueue({ batch: { id: RUN, workflow: 'main', createdAt: NOW, failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch-key' },
        jobs: [{ id: JOB, batchId: RUN, workflow: 'main', sceneId: null, createdAt: NOW, priority: 0, ordinal: 0,
            compositionPlanHash: null, maxAttempts: 3, idempotencyKey: 'job-key', snapshot }], reservations: [reservation] })
    const lease = await queue.acquireLease({ jobId: JOB, owner: 'worker', now: NOW, ttlMs: 1_000 })
    const leaseToken = lease?.leaseToken ?? ''
    await queue.transitionJob({ jobId: JOB, to: 'running', now: NOW, leaseOwner: 'worker', leaseToken })
    const reference = { kind: 'output-writer' as const, artifactId: ARTIFACT, digest: `sha256:${HASH}`, mimeType: 'image/png' }
    await queue.bindOutputTransaction({ jobId: JOB, leaseOwner: 'worker', leaseToken, now: NOW, outputTransactionId: TX, artifactReference: reference })
    const receipt = { schemaVersion: 1 as const, spoolId: 'provider-spool', attemptId: `${JOB}:1`, contentType: 'image/png', byteLength: 4,
        sha256: `sha256:${HASH}` as const, committedAt: NOW }
    if (modern) {
        let previous = (await queue.listAttempts(JOB))[0].providerEvidence!
        const states: ProviderAttemptEvidence[] = [
            { ...previous, dispatchState: 'possibly-dispatched', billingRisk: 'possible' },
            { ...previous, dispatchState: 'response-started', billingRisk: 'possible' },
            { ...previous, dispatchState: 'response-complete', providerOutcome: 'succeeded', billingRisk: 'confirmed', responseDigest: receipt.sha256 },
        ]
        if (modern === 'result-spooled') states.push({ ...states[2], dispatchState: 'result-spooled', spoolReceipt: receipt })
        for (const next of states) {
            await queue.recordProviderAttemptTransition({ jobId: JOB, attemptNumber: 1, leaseOwner: 'worker', leaseToken,
                now: NOW, expectedEvidence: previous, nextEvidence: next })
            previous = next
        }
    }
    await queue.transitionOutputReservation({ reservationId: reservation.reservationId, owner: reservation, expectedState: 'reserved', expectedVersion: 1, state: 'writing', now: NOW })
    const writer = new OutputWriter(platform, { prepare: bytes => ({ imageBytes: bytes }) }, () => TX, () => new Date(NOW))
    let pending: Uint8Array | undefined
    let output: OutputWriteResult | undefined
    await writer.write({ transactionId: TX, sourceJobId: JOB, outputReservation: { reservationId: reservation.reservationId,
        directoryIdentity, relativePath: reservation.relativePath, ...commit },
        destination: { directory: 'output', useAbsolutePath: false, workflowDefaultDirectory: 'output', extension: 'png', fileName: 'result.png', collisionPolicy: 'error',
            portableDirectory: { kind: 'standard', root: 'app-data', segments: ['output'] } },
        imageBytes: new Uint8Array([1, 2, 3, 4]), imageDataUrl: 'data:image/png;base64,AQIDBA==', includeFinalImageFacts: true,
        canCommit: () => true, commitWorkflow: result => { pending = journals.get(TX)?.slice(); output = result },
    })
    if (!pending || !output?.finalImage?.portableDirectory) throw new Error('Missing real writer crash fixture')
    journals.set(TX, pending)
    const commands = createGenerationCommandAdapter({ repository: queue, writer, coordinator: { cancelBatch: vi.fn() }, now: () => LATER })
    const bridge = createAgentGenerationStorageRetryPort({ repository: queue, writer, artifacts, commands, now: () => LATER })
    const target = await bridge.inspect({ runId: RUN, jobId: JOB })
    if (target === null) throw new Error('Missing storage retry target')
    const grant: AgentStorageRetryGrant = { requestId: 'retry-request', requestHash: `sha256:${HASH}`, workspaceId: 'workspace', clientId: 'client',
        actorKind: 'agent', policyRevision: 1, consentedAt: LATER, expiresAt: '2026-09-06T00:05:00.000Z', authorization: 'human', target }
    return { bridge, grant, writer, commands, platform, journals, files, output, reference, reservation, receipt }
}

describe('Agent exact storage retry bridge with real Queue, Artifact repository, and OutputWriter', () => {
    it('retries one native-ID target via the application adapter and reconciles after both databases reopen', async () => {
        const fixture = await seed()
        const application = vi.spyOn(generationCommands, 'retryGenerationStorage')
        const before = await queue.getJob(JOB)
        const result = await fixture.bridge.retry(fixture.grant.target, fixture.grant)
        expect(result).toEqual({ status: 'storage-registered', runId: RUN, batchId: RUN, jobId: JOB, artifactId: ARTIFACT })
        expect(application).toHaveBeenCalledExactlyOnceWith({ jobId: JOB, actor: { kind: 'agent', id: 'client:client' } }, fixture.commands)
        expect(await queue.getJob(JOB)).toMatchObject({ state: 'succeeded', attemptCount: 1, snapshotHash: before?.snapshotHash })
        expect(await artifacts.get(ARTIFACT)).toMatchObject({ sourceJobId: JOB, outputCommitSetHash: fixture.reservation.reservationSchemaVersion === 1 ? fixture.reservation.commitSetHash : null })
        expect(fixture.journals.size).toBe(0)
        expect(await fixture.bridge.inspect({ runId: RUN, jobId: JOB })).toBeNull()
        queue.close(); artifacts.close()
        queue = new IndexedDBQueueRepository(options); artifacts = new IndexedDBArtifactRepository(artifactOptions)
        const commands = { retryStorage: vi.fn() }
        const reopened = createAgentGenerationStorageRetryPort({ repository: queue, artifacts, writer: fixture.writer, commands, now: () => LATER })
        expect(await reopened.reconcile(fixture.grant)).toEqual(result)
        expect(commands.retryStorage).not.toHaveBeenCalled()
        expect(fixture.platform.listJournalIds).not.toHaveBeenCalled()
        expect(JSON.stringify([fixture.grant.target, result])).not.toMatch(/private prompt|app-data|result\.png|base64|outputReservation/)
    })

    it('leaves partial or lost outcomes unresolved without another storage call', async () => {
        const fixture = await seed()
        const commands = { retryStorage: vi.fn(async () => { throw new Error('Lost result C:/private/output.png Bearer secret') }) }
        const bridge = createAgentGenerationStorageRetryPort({ repository: queue, artifacts, writer: fixture.writer, commands, now: () => LATER })
        await expect(bridge.retry(fixture.grant.target, fixture.grant)).rejects.toMatchObject({ code: 'STORAGE_RETRY_NOT_ACKNOWLEDGED', message: 'Agent command was rejected.' })
        expect(await bridge.reconcile(fixture.grant)).toBeNull()
        expect(commands.retryStorage).toHaveBeenCalledOnce()
        await artifacts.putOriginal({ artifactId: ARTIFACT, sourceJobId: JOB, sourceSceneId: null,
            outputCommitSetHash: fixture.reservation.reservationSchemaVersion === 1 ? fixture.reservation.commitSetHash : null,
            file: { directory: fixture.output.finalImage!.portableDirectory!, fileName: fixture.output.fileName },
            format: 'png', contentChecksum: fixture.output.finalImage!.contentChecksum, size: fixture.output.finalImage!.byteSize })
        expect(await bridge.reconcile(fixture.grant)).toBeNull()
        expect(commands.retryStorage).toHaveBeenCalledOnce()
    })

    it('recognizes the exact completed goal when startup recovery cleaned the journal before Agent reconciliation', async () => {
        const fixture = await seed()
        const application = vi.spyOn(generationCommands, 'retryGenerationStorage')
        await expect(recoverQueueLinkedOutputs(queue, fixture.writer, { now: LATER, artifactRepository: artifacts }))
            .resolves.toEqual([{ transactionId: TX, action: 'retried' }])
        expect(fixture.journals.size).toBe(0)
        const commands = { retryStorage: vi.fn() }
        const bridge = createAgentGenerationStorageRetryPort({ repository: queue, artifacts, writer: fixture.writer, commands, now: () => LATER })
        expect(await bridge.inspect({ runId: RUN, jobId: JOB })).toBeNull()
        expect(await bridge.reconcile(fixture.grant)).toEqual({ status: 'storage-registered', runId: RUN, batchId: RUN, jobId: JOB, artifactId: ARTIFACT })
        expect(commands.retryStorage).not.toHaveBeenCalled()
        expect(application).not.toHaveBeenCalled()
    })

    it.each(['response-complete', 'result-spooled'] as const)(
        'completes a modern %s crash through full startup without redispatching or rewriting files', async state => {
            const fixture = await seed(state)
            vi.spyOn(queueRuntime, 'getRuntimeQueueRepository').mockReturnValue(queue)
            vi.spyOn(outputRuntime, 'getRuntimeOutputWriter').mockReturnValue(fixture.writer)
            const write = vi.spyOn(fixture.platform, 'writeFile')
            const acquire = vi.spyOn(queue, 'acquireLease')
            const dispatch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Provider must not run'))
            const application = vi.spyOn(generationCommands, 'retryGenerationStorage')
            const providerResultSpool: ProviderResultSpool = {
                commit: vi.fn(), verify: vi.fn(), read: vi.fn(), discard: vi.fn(), removeIfEligible: vi.fn(), list: vi.fn(),
                reconcile: vi.fn(async () => ({ receipts: [fixture.receipt], promotedSpoolIds: [], removedTemporarySpoolIds: [],
                    removedOrphanSpoolIds: [], corruptSpoolIds: [] })),
            }
            const result = await initializeQueueAfterRestart({ providerResultSpool })
            expect(result).toMatchObject({ inboxReady: true, recoveryIssues: [], linkedOutputs: [{ transactionId: TX, action: 'retried' }] })
            expect(await queue.getJob(JOB)).toMatchObject({ state: 'succeeded', attemptCount: 1 })
            expect(await artifacts.get(ARTIFACT)).toMatchObject({ sourceJobId: JOB, outputCommitSetHash: fixture.output.outputCommitSetHash })
            expect(fixture.journals.size).toBe(0)
            expect(await fixture.bridge.reconcile(fixture.grant)).toMatchObject({ status: 'storage-registered' })
            expect(write).not.toHaveBeenCalled()
            expect(acquire).not.toHaveBeenCalled()
            expect(dispatch).not.toHaveBeenCalled()
            expect(application).not.toHaveBeenCalled()
            expect(providerResultSpool.read).not.toHaveBeenCalled()
        },
    )

    it.each(['missing spool', 'reservation mismatch', 'cancelled'] as const)(
        'preserves modern files and reservation when full startup rejects %s', async problem => {
            const fixture = await seed('result-spooled')
            vi.spyOn(queueRuntime, 'getRuntimeQueueRepository').mockReturnValue(queue)
            vi.spyOn(outputRuntime, 'getRuntimeOutputWriter').mockReturnValue(fixture.writer)
            const write = vi.spyOn(fixture.platform, 'writeFile')
            const dispatch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Provider must not run'))
            if (problem === 'reservation mismatch') {
                const journal = JSON.parse(new TextDecoder().decode(fixture.journals.get(TX)))
                journal.outputReservation.reservationId = 'foreign-reservation'
                fixture.journals.set(TX, new TextEncoder().encode(JSON.stringify(journal)))
            }
            if (problem === 'cancelled') await queue.requestCancel({ jobId: JOB, now: NOW, reason: 'user' })
            const providerResultSpool: ProviderResultSpool = {
                commit: vi.fn(), verify: vi.fn(), read: vi.fn(), discard: vi.fn(), removeIfEligible: vi.fn(), list: vi.fn(),
                reconcile: vi.fn(async () => ({ receipts: problem === 'missing spool' ? [] : [fixture.receipt], promotedSpoolIds: [],
                    removedTemporarySpoolIds: [], removedOrphanSpoolIds: [], corruptSpoolIds: [] })),
            }
            const result = await initializeQueueAfterRestart({ providerResultSpool })
            expect(result).toMatchObject({ inboxReady: false, recoveryIssues: ['linked-output-recovery'] })
            if (problem === 'missing spool') expect(await queue.getJob(JOB)).toMatchObject({ state: 'blocked', blockReason: 'provider-result-lost' })
            expect((await queue.getJob(JOB))?.state).not.toBe('succeeded')
            expect(await artifacts.get(ARTIFACT)).toBeNull()
            expect((await queue.getOutputReservation('reservation'))?.state).toBe('writing')
            expect(fixture.journals.has(TX)).toBe(true)
            expect(fixture.files.has('output/result.png')).toBe(true)
            expect(write).not.toHaveBeenCalled()
            expect(dispatch).not.toHaveBeenCalled()
            expect(providerResultSpool.read).not.toHaveBeenCalled()
        },
    )

    it.each(['live lease', 'active writer', 'wrong run', 'wrong journal owner', 'wrong journal phase', 'missing journal', 'cancelled'] as const)(
        'rejects %s before calling storage', async mode => {
            const fixture = await seed()
            const commands = { retryStorage: vi.fn() }
            let runId = RUN
            if (mode === 'active writer') vi.spyOn(fixture.writer, 'isTransactionActive').mockReturnValue(true)
            if (mode === 'wrong run') runId = 'other-run'
            if (mode === 'missing journal') fixture.journals.clear()
            if (mode === 'wrong journal owner' || mode === 'wrong journal phase') {
                const journal = JSON.parse(new TextDecoder().decode(fixture.journals.get(TX)))
                if (mode === 'wrong journal owner') journal.sourceJobId = 'foreign'
                else journal.phase = 'workflow-committed'
                fixture.journals.set(TX, new TextEncoder().encode(JSON.stringify(journal)))
            }
            if (mode === 'cancelled') await queue.requestCancel({ jobId: JOB, now: LATER, reason: 'user' })
            const bridge = createAgentGenerationStorageRetryPort({ repository: queue, artifacts, writer: fixture.writer, commands,
                now: () => mode === 'live lease' ? NOW : LATER })
            expect(await bridge.inspect({ runId, jobId: JOB })).toBeNull()
            await expect(bridge.retry({ ...fixture.grant.target, runId }, fixture.grant)).rejects.toThrow()
            expect(commands.retryStorage).not.toHaveBeenCalled()
        },
    )

    it.each(['hash', 'artifact id', 'snapshot hash', 'reservation owner', 'commit set'] as const)('rechecks changed %s before retry', async mode => {
        const fixture = await seed()
        const commands = { retryStorage: vi.fn() }
        let target = fixture.grant.target
        if (mode === 'hash') target = { ...target, targetHash: `sha256:${'e'.repeat(64)}` }
        if (mode === 'artifact id') target = { ...target, artifactId: 'other-artifact' }
        if (mode === 'snapshot hash') {
            const original = await queue.getJob(JOB)
            vi.spyOn(queue, 'getJob').mockResolvedValue({ ...original!, snapshotHash: 'changed' })
        }
        if (mode === 'reservation owner' || mode === 'commit set') {
            const original = await queue.getOutputReservation('reservation')
            vi.spyOn(queue, 'getOutputReservation').mockResolvedValue({ ...original!,
                ...(mode === 'reservation owner' ? { jobId: 'other-job' } : { commitSetHash: `sha256:${'e'.repeat(64)}` as const }) })
        }
        const bridge = createAgentGenerationStorageRetryPort({ repository: queue, artifacts, writer: fixture.writer, commands, now: () => LATER })
        await expect(bridge.retry(target, { ...fixture.grant, target })).rejects.toMatchObject({ code: 'STORAGE_RETRY_TARGET_CHANGED' })
        expect(commands.retryStorage).not.toHaveBeenCalled()
    })

    it.each(['foreign artifact', 'wrong commit set', 'wrong filename', 'missing artifact'] as const)('never reconciles %s as completed', async mode => {
        const fixture = await seed()
        await fixture.bridge.retry(fixture.grant.target, fixture.grant)
        const original = await artifacts.get(ARTIFACT)
        vi.spyOn(artifacts, 'get').mockResolvedValue(mode === 'missing artifact' ? null : { ...original!,
            ...(mode === 'foreign artifact' ? { sourceJobId: 'other-job' } : {}),
            ...(mode === 'wrong commit set' ? { outputCommitSetHash: `sha256:${'e'.repeat(64)}` } : {}),
            ...(mode === 'wrong filename' ? { original: { ...original!.original, file: { ...original!.original.file, fileName: 'other.png' } } } : {}),
        })
        expect(await fixture.bridge.reconcile(fixture.grant)).toBeNull()
    })

    it.each(['unknown', 'result-lost', 'prepared', 'known-failure', 'missing attempt', 'failed attempt'] as const)(
        'rejects unsafe current Provider evidence: %s', async mode => {
            const fixture = await seed()
            const [attempt] = await queue.listAttempts(JOB)
            const evidence = { dispatchState: 'response-complete' as const, providerOutcome: 'succeeded' as const,
                billingRisk: 'confirmed' as const, responseDigest: `sha256:${HASH}` as const, spoolReceipt: null }
            vi.spyOn(queue, 'listAttempts').mockResolvedValue(mode === 'missing attempt' ? [] : [{ ...attempt,
                ...(mode === 'failed attempt' ? { outcome: 'failed' } : {}),
                providerEvidence: { ...evidence,
                    ...(mode === 'unknown' ? { providerOutcome: 'unknown' } : {}),
                    ...(mode === 'result-lost' ? { dispatchState: 'result-lost' } : {}),
                    ...(mode === 'prepared' ? { dispatchState: 'prepared', providerOutcome: 'running' } : {}),
                    ...(mode === 'known-failure' ? { providerOutcome: 'known-failure' } : {}),
                },
            }])
            const commands = { retryStorage: vi.fn() }
            const bridge = createAgentGenerationStorageRetryPort({ repository: queue, artifacts, writer: fixture.writer, commands, now: () => LATER })
            expect(await bridge.inspect({ runId: RUN, jobId: JOB })).toBeNull()
            await expect(bridge.retry(fixture.grant.target, fixture.grant)).rejects.toMatchObject({ code: 'STORAGE_RETRY_TARGET_CHANGED' })
            expect(commands.retryStorage).not.toHaveBeenCalled()
        },
    )
})
