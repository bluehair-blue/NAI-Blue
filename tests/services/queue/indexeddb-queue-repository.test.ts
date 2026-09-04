import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createEmptyGenerationBatchSummary } from '@/domain/queue/summary'
import { createOutputCommitSet } from '@/domain/output-commit-set'
import type {
    GenerationAtomicBatchLimits,
    GenerationJobSnapshot,
    OutputCommitSetReservation,
    OutputReservation,
} from '@/domain/queue/types'
import type { ProviderAttemptEvidence } from '@/domain/queue/provider-result'
import {
    IndexedDBQueueRepository,
    QueueRepositoryError,
    type EnqueueGenerationJobInput,
} from '@/services/queue/indexeddb-queue-repository'
import {
    bindOutputReservationSnapshot,
    createGenerationJobSnapshot,
    hashGenerationJobSnapshot,
} from '@/services/queue/job-snapshot'
import { recoverQueueAfterRestart } from '@/services/queue/recovery'

const NOW = '2026-07-14T04:00:00.000Z'
const LATER = '2026-07-14T04:00:02.000Z'
let databaseCounter = 0
const GENERATION_LIMITS = {
    maxJobsPerAtomicBatch: 100,
    maxOutputClaimsPerAtomicBatch: 400,
    measuredAt: '2026-09-04T07:06:52.993Z',
    evidenceId: 'benchmark:queue:edge:webview2-152.0.4191.62@d1118542+b44519c5#docs/releases/evidence/queue-edge-benchmark.json',
} as const

function databaseName(label: string): string {
    databaseCounter += 1
    return `nai-blue-queue-test-${label}-${databaseCounter}`
}

function snapshot(resources: GenerationJobSnapshot['resources'] = []): GenerationJobSnapshot {
    return createGenerationJobSnapshot({
        prompt: { positive: 'fixed queue prompt', negative: 'fixed negative' },
        parameters: { seed: 7, steps: 12 },
        outputPolicy: { format: 'webp', destination: { kind: 'app-data' } },
        resources,
        resumability: 'resumable',
    })
}

function providerSnapshot(): GenerationJobSnapshot {
    return {
        ...snapshot(),
        providerExecutionEnvelope: {
            schemaVersion: 1,
            provider: 'novelai',
            compatibilityProfileId: 'nai-payload-v1-model-generate-none',
            payloadBuilderRevision: 'nai-payload-v1',
            modelCatalogRevision: 'nai-model-catalog-v1',
            action: 'generate',
            responseMode: 'standard',
            semanticIntentHash: `sha256:${'a'.repeat(64)}`,
            queueResourceBindings: [],
        },
    }
}

function repository(
    factory: IDBFactory,
    name: string,
    generationLimits: GenerationAtomicBatchLimits | null = GENERATION_LIMITS,
): IndexedDBQueueRepository {
    return new IndexedDBQueueRepository({
        factory: factory as unknown as globalThis.IDBFactory,
        keyRange: IDBKeyRange as unknown as typeof globalThis.IDBKeyRange,
        databaseName: name,
        generationLimits,
    })
}

function jobInput(overrides: Partial<EnqueueGenerationJobInput> = {}): EnqueueGenerationJobInput {
    return {
        id: 'job:1',
        batchId: 'batch:1',
        workflow: 'main',
        sceneId: null,
        createdAt: NOW,
        priority: 0,
        ordinal: 0,
        snapshot: snapshot(),
        compositionPlanHash: 'sha256:composition-plan',
        maxAttempts: 3,
        idempotencyKey: 'idempotency:1',
        ...overrides,
    }
}

async function createV1Database(
    factory: IDBFactory,
    name: string,
    record: Record<string, unknown>,
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const request = factory.open(name, 1)
        request.onupgradeneeded = () => {
            request.result.createObjectStore('batches', { keyPath: 'id' })
            request.result.createObjectStore('jobs', { keyPath: 'id' })
            request.result.createObjectStore('attempts', { keyPath: 'id' })
        }
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
            const db = request.result
            const transaction = db.transaction(['batches', 'jobs'], 'readwrite')
            transaction.objectStore('batches').put({
                id: 'batch:1',
                workflow: 'main',
                createdAt: NOW,
                updatedAt: NOW,
            })
            transaction.objectStore('jobs').put(record)
            transaction.oncomplete = () => {
                db.close()
                resolve()
            }
            transaction.onerror = () => reject(transaction.error)
            transaction.onabort = () => reject(transaction.error ?? new Error('v1 fixture aborted'))
        }
    })
}

async function createV3Database(factory: IDBFactory, name: string): Promise<void> {
    const fixedSnapshot = snapshot()
    await new Promise<void>((resolve, reject) => {
        const request = factory.open(name, 3)
        request.onupgradeneeded = () => {
            const database = request.result
            const batches = database.createObjectStore('batches', { keyPath: 'id' })
            batches.createIndex('by-created-at', 'createdAt')
            batches.createIndex('by-idempotency-key', 'idempotencyKey', { unique: true })
            const jobs = database.createObjectStore('jobs', { keyPath: 'id' })
            jobs.createIndex('by-idempotency-key', 'idempotencyKey', { unique: true })
            jobs.createIndex('by-global-order', 'globalOrderKey')
            jobs.createIndex('by-batch-order', 'batchOrderKey')
            jobs.createIndex('by-state-order', 'stateOrderKey')
            jobs.createIndex('by-output-transaction', 'outputTransactionId', { unique: true })
            const attempts = database.createObjectStore('attempts', { keyPath: 'id' })
            attempts.createIndex('by-job-attempt', 'jobAttemptKey', { unique: true })
            const leases = database.createObjectStore('leases', { keyPath: 'jobId' })
            leases.createIndex('by-expires-at', 'expiresAt')
            const resources = database.createObjectStore('resources', { keyPath: 'id' })
            resources.createIndex('by-digest', 'digest')
        }
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
            const database = request.result
            const transaction = database.transaction(['batches', 'jobs'], 'readwrite')
            transaction.objectStore('batches').put({
                id: 'batch:1',
                workflow: 'main',
                createdAt: NOW,
                updatedAt: NOW,
                state: 'active',
                failurePolicy: 'continue',
                pauseReason: null,
                origin: 'fresh',
                idempotencyKey: 'batch:1',
                version: 1,
            })
            transaction.objectStore('jobs').put({
                recordSchemaVersion: 3,
                id: 'job:1',
                batchId: 'batch:1',
                workflow: 'main',
                sceneId: null,
                state: 'queued',
                createdAt: NOW,
                updatedAt: NOW,
                priority: 0,
                ordinal: 0,
                snapshotSchemaVersion: fixedSnapshot.schemaVersion,
                snapshot: fixedSnapshot,
                snapshotHash: hashGenerationJobSnapshot(fixedSnapshot),
                compositionPlanHash: null,
                attemptCount: 0,
                maxAttempts: 3,
                idempotencyKey: 'idempotency:1',
                progress: { stage: 'queued', current: 0, total: 0 },
                lastDiagnosticEventId: null,
                outputTransactionId: null,
                artifactReference: null,
                blockReason: null,
                readyAt: NOW,
                cancelRequestedAt: null,
                cancelReason: null,
                retryOfJobId: null,
                rootJobId: 'job:1',
                version: 1,
                globalOrderKey: [0, 0, NOW, 'job:1'],
                batchOrderKey: ['batch:1', 0, 0, NOW, 'job:1'],
                stateOrderKey: ['queued', 0, 0, NOW, 'job:1'],
            })
            transaction.oncomplete = () => {
                database.close()
                resolve()
            }
            transaction.onerror = () => reject(transaction.error)
            transaction.onabort = () => reject(transaction.error ?? new Error('v3 fixture aborted'))
        }
    })
}

async function createV4Database(factory: IDBFactory, name: string): Promise<string> {
    await createV3Database(factory, name)
    const fixedSnapshot = snapshot()
    const snapshotHash = hashGenerationJobSnapshot(fixedSnapshot)
    await new Promise<void>((resolve, reject) => {
        const request = factory.open(name, 4)
        request.onupgradeneeded = () => {
            const jobs = request.transaction?.objectStore('jobs')
            if (jobs !== undefined && !jobs.indexNames.contains('by-batch-state-order')) {
                jobs.createIndex('by-batch-state-order', 'batchStateOrderKey')
            }
        }
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
            const database = request.result
            const transaction = database.transaction(['attempts', 'batches', 'jobs', 'leases'], 'readwrite')
            const emptyFirst = createEmptyGenerationBatchSummary('batch:0')
            const emptySecond = createEmptyGenerationBatchSummary('batch:1')
            transaction.objectStore('batches').put({
                id: 'batch:0',
                workflow: 'main',
                createdAt: NOW,
                updatedAt: NOW,
                state: 'active',
                failurePolicy: 'continue',
                pauseReason: null,
                origin: 'fresh',
                idempotencyKey: 'batch:0',
                version: 3,
                projectionRevision: 9,
                projectionSummary: emptyFirst,
            })
            transaction.objectStore('batches').put({
                id: 'batch:1',
                workflow: 'main',
                createdAt: NOW,
                updatedAt: NOW,
                state: 'active',
                failurePolicy: 'continue',
                pauseReason: null,
                origin: 'fresh',
                idempotencyKey: 'batch:1',
                version: 4,
                projectionRevision: 7,
                projectionSummary: {
                    ...emptySecond,
                    total: 1,
                    progressCurrent: 1 / 3,
                    progressTotal: 1,
                    states: { ...emptySecond.states, running: 1 },
                },
            })
            transaction.objectStore('jobs').put({
                recordSchemaVersion: 3,
                id: 'job:1',
                batchId: 'batch:1',
                workflow: 'main',
                sceneId: null,
                state: 'running',
                createdAt: NOW,
                updatedAt: NOW,
                priority: 0,
                ordinal: 0,
                snapshotSchemaVersion: fixedSnapshot.schemaVersion,
                snapshot: fixedSnapshot,
                snapshotHash,
                compositionPlanHash: null,
                attemptCount: 1,
                maxAttempts: 3,
                idempotencyKey: 'idempotency:1',
                progress: { stage: 'request', current: 1, total: 3 },
                lastDiagnosticEventId: 'diagnostic:v4',
                outputTransactionId: null,
                artifactReference: null,
                blockReason: null,
                readyAt: NOW,
                cancelRequestedAt: null,
                cancelReason: null,
                retryOfJobId: 'job:source',
                rootJobId: 'job:source',
                version: 5,
                globalOrderKey: [0, 0, NOW, 'job:1'],
                batchOrderKey: ['batch:1', 0, 0, NOW, 'job:1'],
                batchStateOrderKey: ['batch:1', 'running', 0, 0, NOW, 'job:1'],
                stateOrderKey: ['running', 0, 0, NOW, 'job:1'],
            })
            transaction.objectStore('attempts').put({
                id: 'job:1:1',
                jobId: 'job:1',
                attemptNumber: 1,
                startedAt: NOW,
                finishedAt: null,
                outcome: 'running',
                diagnosticEventId: null,
                jobAttemptKey: ['job:1', 1],
            })
            transaction.objectStore('leases').put({
                jobId: 'job:1',
                owner: 'worker:v4',
                token: 'lease:v4',
                expiresAt: LATER,
                heartbeatAt: NOW,
            })
            transaction.oncomplete = () => {
                database.close()
                resolve()
            }
            transaction.onerror = () => reject(transaction.error)
            transaction.onabort = () => reject(transaction.error ?? new Error('v4 fixture aborted'))
        }
    })
    return snapshotHash
}

async function readRawJob(factory: IDBFactory, name: string, version: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const request = factory.open(name, version)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
            const db = request.result
            const transaction = db.transaction('jobs', 'readonly')
            const get = transaction.objectStore('jobs').get('job:1')
            get.onsuccess = () => resolve(get.result)
            get.onerror = () => reject(get.error)
            transaction.oncomplete = () => db.close()
        }
    })
}

async function createV7ReservedDatabase(factory: IDBFactory, name: string): Promise<void> {
    const baseReservation = reservation()
    const { directoryIdentity: _directoryIdentity, ...legacyReservation } = baseReservation
    const { batchId: _batchId, jobId: _jobId, state: _state, ...snapshotReservation } = legacyReservation
    const legacySnapshot = { ...snapshot(), outputReservation: snapshotReservation } as unknown as GenerationJobSnapshot
    await new Promise<void>((resolve, reject) => {
        const request = factory.open(name, 7)
        request.onupgradeneeded = () => {
            for (const store of ['attempts', 'batches', 'jobs', 'leases', 'output-reservations', 'resources']) {
                request.result.createObjectStore(store, { keyPath: store === 'output-reservations' ? 'reservationId' : store === 'leases' ? 'jobId' : 'id' })
            }
        }
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
            const database = request.result
            const transaction = database.transaction(['batches', 'jobs', 'output-reservations'], 'readwrite')
            transaction.objectStore('batches').put({
                id: 'batch:1', workflow: 'main', createdAt: NOW, updatedAt: NOW, state: 'active',
                failurePolicy: 'continue', pauseReason: null, origin: 'fresh', idempotencyKey: 'batch:1',
                version: 1, projectionRevision: 1,
                projectionSummary: { ...createEmptyGenerationBatchSummary('batch:1'), total: 1, states: { ...createEmptyGenerationBatchSummary('batch:1').states, queued: 1 } },
                queueSequence: 1,
            })
            transaction.objectStore('jobs').put({
                recordSchemaVersion: 4, id: 'job:1', batchId: 'batch:1', workflow: 'main', sceneId: null,
                state: 'queued', createdAt: NOW, updatedAt: NOW, priority: 0, queueSequence: 1, ordinal: 0,
                snapshotSchemaVersion: legacySnapshot.schemaVersion, snapshot: legacySnapshot,
                snapshotHash: hashGenerationJobSnapshot(legacySnapshot), compositionPlanHash: null,
                attemptCount: 0, maxAttempts: 3, idempotencyKey: 'idempotency:1',
                progress: { stage: 'queued', current: 0, total: 0 }, lastDiagnosticEventId: null,
                outputTransactionId: null, artifactReference: null, blockReason: null, readyAt: NOW,
                cancelRequestedAt: null, cancelReason: null, retryOfJobId: null, rootJobId: 'job:1', version: 1,
                globalOrderKey: [0, 1, 0, NOW, 'job:1'],
                batchOrderKey: ['batch:1', 0, 0, NOW, 'job:1'],
                batchStateOrderKey: ['batch:1', 'queued', 0, 0, NOW, 'job:1'],
                stateOrderKey: ['queued', 0, 1, 0, NOW, 'job:1'],
            })
            transaction.objectStore('output-reservations').put({
                ...legacyReservation,
                normalizedPath: 'portraits/image.webp',
                activePath: 'portraits/image.webp',
            })
            transaction.oncomplete = () => {
                database.close()
                resolve()
            }
            transaction.onerror = () => reject(transaction.error)
            transaction.onabort = () => reject(transaction.error ?? new Error('v7 fixture aborted'))
        }
    })
}

function reservation(overrides: Partial<OutputReservation> = {}): OutputReservation {
    return {
        reservationId: 'reservation:1',
        batchId: 'batch:1',
        jobId: 'job:1',
        folderBinding: {
            resourceType: 'generation-folder-document',
            resourceId: 'folder:1',
            revision: 3,
            contentHash: `sha256:${'a'.repeat(64)}`,
        },
        directoryIdentity: `sha256:${'b'.repeat(64)}`,
        relativePath: 'portraits/Image.webp',
        collisionPolicy: 'fail',
        expectedExistingDigest: null,
        state: 'storage-pending',
        ...overrides,
    }
}

function commitSetReservation(overrides: Partial<OutputCommitSetReservation> = {}): OutputCommitSetReservation {
    const directoryIdentity = `sha256:${'d'.repeat(64)}` as const
    const { commitSet, commitSetHash } = createOutputCommitSet({
        directoryAuthorityId: 'folder:1',
        directoryAuthorityFingerprint: directoryIdentity,
        filesystemSemantics: 'windows',
        filenamePolicyRevision: 'filename-v1',
        pathNormalizationRevision: 'path-v1',
        claims: [
            { claimId: 'image', kind: 'image', relativePath: 'portraits/Image.webp' },
            { claimId: 'metadata', kind: 'metadata-sidecar', relativePath: 'portraits/Image.webp.json' },
        ],
    })
    return {
        reservationId: 'reservation:current:1',
        batchId: 'batch:1',
        jobId: 'job:1',
        folderBinding: reservation().folderBinding,
        directoryIdentity,
        relativePath: 'portraits/Image.webp',
        collisionPolicy: 'fail',
        expectedExistingDigest: null,
        reservationSchemaVersion: 1,
        commitSet,
        commitSetHash,
        state: 'reserved',
        version: 1,
        updatedAt: NOW,
        ...overrides,
    }
}

function reservedJobInput(
    value: OutputReservation,
    overrides: Partial<EnqueueGenerationJobInput> = {},
): EnqueueGenerationJobInput {
    const job = jobInput(overrides)
    const snapshotReservation = value.reservationSchemaVersion === 1
        ? (({ batchId: _batchId, jobId: _jobId, state: _state, version: _version, updatedAt: _updatedAt, ...item }) => item)(value)
        : (({ batchId: _batchId, jobId: _jobId, state: _state, ...item }) => item)(value)
    return {
        ...job,
        snapshot: bindOutputReservationSnapshot(job.snapshot, snapshotReservation),
    }
}

function atomicBatchInput(jobCount: number, claimCount: number) {
    const batchId = `batch:atomic:${jobCount}:${claimCount}`
    const reservations = Array.from({ length: jobCount }, (_, ordinal): OutputCommitSetReservation => {
        const jobId = `job:atomic:${ordinal}`
        const claimsForJob = Math.floor(claimCount / jobCount) + (ordinal < claimCount % jobCount ? 1 : 0)
        const directoryIdentity = `sha256:${'e'.repeat(64)}` as const
        const { commitSet, commitSetHash } = createOutputCommitSet({
            directoryAuthorityId: 'folder:1',
            directoryAuthorityFingerprint: directoryIdentity,
            filesystemSemantics: 'windows',
            filenamePolicyRevision: 'filename-v1',
            pathNormalizationRevision: 'path-v1',
            claims: Array.from({ length: claimsForJob }, (_, claimOrdinal) => ({
                claimId: `claim:${claimOrdinal}`,
                kind: claimOrdinal === 0 ? 'image' as const : 'metadata-sidecar' as const,
                relativePath: `atomic/${ordinal}-${claimOrdinal}.json`,
            })),
        })
        return {
            reservationSchemaVersion: 1,
            reservationId: `reservation:atomic:${ordinal}`,
            batchId,
            jobId,
            folderBinding: reservation().folderBinding,
            directoryIdentity,
            relativePath: `atomic/${ordinal}-0.json`,
            collisionPolicy: 'fail',
            expectedExistingDigest: null,
            commitSet,
            commitSetHash,
            state: 'reserved',
            version: 1,
            updatedAt: NOW,
        }
    })
    return {
        batch: {
            id: batchId,
            workflow: 'main' as const,
            createdAt: NOW,
            failurePolicy: 'continue' as const,
            origin: 'fresh' as const,
            idempotencyKey: batchId,
        },
        jobs: reservations.map((value, ordinal) => reservedJobInput(value, {
            id: value.jobId,
            batchId,
            ordinal,
            idempotencyKey: `atomic:${ordinal}`,
        })),
        reservations,
    }
}

async function updateRawAttempt(
    factory: IDBFactory,
    name: string,
    update: (attempt: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const request = factory.open(name, 9)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
            const database = request.result
            const transaction = database.transaction('attempts', 'readwrite')
            const store = transaction.objectStore('attempts')
            const get = store.get('job:1:1')
            get.onsuccess = () => store.put(update(get.result as Record<string, unknown>))
            get.onerror = () => reject(get.error)
            transaction.oncomplete = () => {
                database.close()
                resolve()
            }
            transaction.onerror = () => reject(transaction.error)
            transaction.onabort = () => reject(transaction.error ?? new Error('attempt mutation aborted'))
        }
    })
}

describe('normalized IndexedDB durable queue repository', () => {
    beforeEach(() => {
        databaseCounter = 0
    })

    it('creates normalized stores and deterministic indexes without a Zustand job blob', async () => {
        const factory = new IDBFactory()
        const name = databaseName('schema')
        const queue = repository(factory, name)
        await queue.initialize()

        const schema = await queue.inspectSchema()
        expect(schema.version).toBe(9)
        expect(schema.stores).toEqual([
            'attempts', 'batches', 'jobs', 'leases', 'output-reservation-claims', 'output-reservations', 'resources',
        ])
        expect(schema.indexes.jobs).toEqual([
            'by-batch-order',
            'by-batch-state-order',
            'by-global-order',
            'by-idempotency-key',
            'by-output-transaction',
            'by-state-order',
        ])
        expect(schema.indexes.leases).toContain('by-expires-at')
        expect(schema.indexes.batches).toContain('by-queue-sequence')
        expect(schema.indexes['output-reservations']).toEqual(['by-job-id', 'by-normalized-path'])
        expect(schema.indexes['output-reservation-claims']).toEqual([
            'by-active-collision-key', 'by-reservation-id',
        ])
        queue.close()
    })

    it('accepts the measured 100-job and 400-claim atomic boundary', async () => {
        const queue = repository(new IDBFactory(), databaseName('atomic-boundary'))
        const result = await queue.createBatchAndEnqueue(atomicBatchInput(100, 400))

        expect(result.jobs).toHaveLength(100)
        expect(result.reservations.flatMap(value => value.reservationSchemaVersion === 1
            ? value.commitSet.claims
            : [])).toHaveLength(400)
    })

    it.each([[101, 400], [100, 401]])(
        'rejects %i jobs / %i claims atomically',
        async (jobCount, claimCount) => {
            const queue = repository(new IDBFactory(), databaseName(`atomic-reject-${jobCount}-${claimCount}`))
            const input = atomicBatchInput(jobCount, claimCount)

            await expect(queue.createBatchAndEnqueue(input)).rejects.toMatchObject({
                code: 'GENERATION_ATOMIC_BATCH_LIMIT_EXCEEDED',
                generationLimits: GENERATION_LIMITS,
            })
            expect(await queue.getBatch(input.batch.id)).toBeNull()
            expect((await queue.listJobs({ batchId: input.batch.id })).items).toEqual([])
        },
    )

    it('rejects new reservations without measured limits but keeps reservation-free legacy enqueue', async () => {
        const queue = repository(new IDBFactory(), databaseName('atomic-unavailable'), null)
        const reserved = atomicBatchInput(1, 1)

        await expect(queue.createBatchAndEnqueue(reserved))
            .rejects.toMatchObject({ code: 'GENERATION_ATOMIC_BATCH_UNAVAILABLE' })
        expect(await queue.getBatch(reserved.batch.id)).toBeNull()

        const legacy = await queue.createBatchAndEnqueue({
            batch: { ...reserved.batch, id: 'batch:legacy', idempotencyKey: 'batch:legacy' },
            jobs: [jobInput({ batchId: 'batch:legacy' })],
        })
        expect(legacy.jobs).toHaveLength(1)
    })

    it('ignores a forged per-batch limit and uses constructor authority', async () => {
        const queue = repository(new IDBFactory(), databaseName('atomic-forged'), null)
        const forged = {
            ...atomicBatchInput(1, 1),
            generationLimits: {
                ...GENERATION_LIMITS,
                maxJobsPerAtomicBatch: Number.MAX_SAFE_INTEGER,
                maxOutputClaimsPerAtomicBatch: Number.MAX_SAFE_INTEGER,
            },
        }

        await expect(queue.createBatchAndEnqueue(forged))
            .rejects.toMatchObject({ code: 'GENERATION_ATOMIC_BATCH_UNAVAILABLE' })
    })

    it('upgrades v7 reservations with a fail-closed synthetic directory identity', async () => {
        const factory = new IDBFactory()
        const name = databaseName('v7-reservation-directory')
        await createV7ReservedDatabase(factory, name)
        const queue = repository(factory, name)

        const migrated = await queue.getOutputReservation('reservation:1')
        const migratedJob = await queue.getJob('job:1')

        expect(migrated?.directoryIdentity).toMatch(/^sha256:[a-f0-9]{64}$/)
        expect(migrated?.reservationSchemaVersion).toBe(0)
        expect(migratedJob?.snapshot.outputReservation?.directoryIdentity).toBe(migrated?.directoryIdentity)
        expect(await queue.listOutputReservationClaims('reservation:1')).toEqual([])
        expect(migratedJob?.snapshotHash).toBe(hashGenerationJobSnapshot(migratedJob!.snapshot))
        expect(await queue.getOutputReservationByPath(
            migrated!.directoryIdentity,
            migrated!.relativePath,
        )).toEqual(migrated)
    })

    it('atomically reserves normalized output paths and reuses an identical replay', async () => {
        const factory = new IDBFactory()
        const name = databaseName('output-reservations')
        const queue = repository(factory, name)
        const input = {
            batch: {
                id: 'batch:1', workflow: 'main' as const, createdAt: NOW,
                failurePolicy: 'continue' as const, origin: 'fresh' as const, idempotencyKey: 'batch:1',
            },
            jobs: [reservedJobInput(reservation())],
            reservations: [reservation()],
        }

        const created = await queue.createBatchAndEnqueue(input)
        const replayed = await queue.createBatchAndEnqueue(input)

        expect(created.reservations).toEqual([reservation()])
        expect(replayed.reservations).toEqual(created.reservations)
        expect(await queue.getOutputReservation('reservation:1')).toEqual(reservation())
        expect(await queue.getOutputReservationByPath(
            reservation().directoryIdentity,
            'portraits/image.webp',
        )).toEqual(reservation())
        expect(await queue.listOutputReservationsByJob('job:1')).toEqual([reservation()])
        expect(created.reservations[0]).not.toHaveProperty('normalizedPath')

        queue.close()
        const restarted = repository(factory, name)
        expect(await restarted.getOutputReservationByPath(
            reservation().directoryIdentity,
            'portraits/image.webp',
        )).toEqual(reservation())
    })

    it('atomically reserves every commit-set claim and replays the same hash', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('output-commit-set-replay'))
        const current = commitSetReservation()
        const input = {
            batch: {
                id: 'batch:1', workflow: 'main' as const, createdAt: NOW,
                failurePolicy: 'continue' as const, origin: 'fresh' as const, idempotencyKey: 'batch:1',
            },
            jobs: [reservedJobInput(current)],
            reservations: [current],
        }

        const created = await queue.createBatchAndEnqueue(input)
        const replayed = await queue.createBatchAndEnqueue(input)

        expect(replayed.reservations).toEqual(created.reservations)
        expect(await queue.listOutputReservationClaims(current.reservationId)).toEqual([
            expect.objectContaining({ claimId: 'image', activeCollisionKey: expect.stringMatching(/^collision:sha256:/) }),
            expect.objectContaining({ claimId: 'metadata', activeCollisionKey: expect.stringMatching(/^collision:sha256:/) }),
        ])
        const changedSet = createOutputCommitSet({
            ...current.commitSet,
            claims: [
                { claimId: 'image', kind: 'image', relativePath: current.relativePath },
                { claimId: 'metadata', kind: 'metadata-sidecar', relativePath: 'portraits/changed.json' },
            ],
        })
        const changed = commitSetReservation({
            commitSet: changedSet.commitSet,
            commitSetHash: changedSet.commitSetHash,
        })
        await expect(queue.createBatchAndEnqueue({
            ...input,
            jobs: [reservedJobInput(changed)],
            reservations: [changed],
        })).rejects.toMatchObject({ code: 'E_QUEUE_IDEMPOTENCY_CONFLICT' })
    })

    it('rejects a commit set bound to a different directory authority', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('output-commit-set-authority'))
        const current = commitSetReservation()
        const changed = createOutputCommitSet({
            ...current.commitSet,
            directoryAuthorityId: 'folder:other',
            claims: current.commitSet.claims,
        })
        const mismatched = commitSetReservation({
            commitSet: changed.commitSet,
            commitSetHash: changed.commitSetHash,
        })

        await expect(queue.createBatchAndEnqueue({
            batch: {
                id: 'batch:1', workflow: 'main', createdAt: NOW,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch:1',
            },
            jobs: [reservedJobInput(mismatched)],
            reservations: [mismatched],
        })).rejects.toMatchObject({ code: 'E_QUEUE_RECORD_INVALID' })
    })

    it('rolls back batch, jobs, header, and claims when only a sidecar claim collides', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('output-commit-set-sidecar-collision'))
        const first = commitSetReservation()
        await queue.createBatchAndEnqueue({
            batch: {
                id: 'batch:1', workflow: 'main', createdAt: NOW,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch:1',
            },
            jobs: [reservedJobInput(first)],
            reservations: [first],
        })
        const changed = createOutputCommitSet({
            directoryAuthorityId: first.commitSet.directoryAuthorityId,
            directoryAuthorityFingerprint: first.commitSet.directoryAuthorityFingerprint,
            filesystemSemantics: 'windows',
            filenamePolicyRevision: 'filename-v1',
            pathNormalizationRevision: 'path-v1',
            claims: [
                { claimId: 'image', kind: 'image', relativePath: 'portraits/Other.webp' },
                { claimId: 'metadata', kind: 'metadata-sidecar', relativePath: 'portraits/Image.webp.json' },
            ],
        })
        const second = commitSetReservation({
            reservationId: 'reservation:current:2', batchId: 'batch:2', jobId: 'job:2',
            relativePath: 'portraits/Other.webp', updatedAt: LATER,
            commitSet: changed.commitSet, commitSetHash: changed.commitSetHash,
        })

        await expect(queue.createBatchAndEnqueue({
            batch: {
                id: 'batch:2', workflow: 'main', createdAt: LATER,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch:2',
            },
            jobs: [reservedJobInput(second, {
                id: 'job:2', batchId: 'batch:2', createdAt: LATER, idempotencyKey: 'idempotency:2',
            })],
            reservations: [second],
        })).rejects.toMatchObject({ code: 'E_QUEUE_IDEMPOTENCY_CONFLICT' })
        expect(await queue.getBatch('batch:2')).toBeNull()
        expect(await queue.getJob('job:2')).toBeNull()
        expect(await queue.getOutputReservation(second.reservationId)).toBeNull()
        expect(await queue.listOutputReservationClaims(second.reservationId)).toEqual([])
    })

    it('uses version CAS and releases all active claim keys on commit', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('output-commit-set-cas'))
        const current = commitSetReservation()
        await queue.createBatchAndEnqueue({
            batch: {
                id: 'batch:1', workflow: 'main', createdAt: NOW,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch:1',
            },
            jobs: [reservedJobInput(current)],
            reservations: [current],
        })
        await expect(queue.transitionOutputReservation({
            reservationId: current.reservationId, owner: current,
            expectedState: 'reserved', expectedVersion: 2, state: 'writing',
        })).rejects.toMatchObject({ code: 'E_QUEUE_INVALID_TRANSITION' })
        const writing = await queue.transitionOutputReservation({
            reservationId: current.reservationId, owner: current,
            expectedState: 'reserved', expectedVersion: 1, state: 'writing',
        })
        expect(writing).toMatchObject({ state: 'writing', version: 2 })
        await expect(queue.transitionOutputReservation({
            reservationId: current.reservationId, owner: current,
            expectedState: 'writing', expectedVersion: 1, state: 'committed',
        })).rejects.toMatchObject({ code: 'E_QUEUE_INVALID_TRANSITION' })
        const committed = await queue.transitionOutputReservation({
            reservationId: current.reservationId, owner: current,
            expectedState: 'writing', expectedVersion: 2, state: 'committed',
        })
        expect(committed).toMatchObject({ state: 'committed', version: 3 })
        expect(await queue.listOutputReservationClaims(current.reservationId)).toEqual([
            expect.objectContaining({ claimId: 'image', activeCollisionKey: null }),
            expect.objectContaining({ claimId: 'metadata', activeCollisionKey: null }),
        ])
    })

    it('retains current claims when an unknown Provider attempt is cancelled until explicit abandon', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('unknown-cancel-retains-reservation'))
        const current = commitSetReservation()
        await queue.createBatchAndEnqueue({
            batch: {
                id: 'batch:1', workflow: 'main', createdAt: NOW,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch:1',
            },
            jobs: [reservedJobInput(current, { snapshot: providerSnapshot() })],
            reservations: [current],
        })
        await queue.transitionOutputReservation({
            reservationId: current.reservationId,
            owner: current,
            expectedState: 'reserved',
            expectedVersion: 1,
            state: 'writing',
        })
        const lease = await queue.acquireLease({ jobId: 'job:1', owner: 'worker:1', now: NOW, ttlMs: 10_000 })
        await queue.transitionJob({
            jobId: 'job:1', to: 'running', now: NOW,
            leaseOwner: 'worker:1', leaseToken: lease?.leaseToken ?? '',
        })
        const prepared: ProviderAttemptEvidence = {
            dispatchState: 'prepared', providerOutcome: 'running', billingRisk: 'none',
            responseDigest: null, spoolReceipt: null,
        }
        const possibly: ProviderAttemptEvidence = {
            dispatchState: 'possibly-dispatched', providerOutcome: 'running', billingRisk: 'possible',
            responseDigest: null, spoolReceipt: null,
        }
        await queue.recordProviderAttemptTransition({
            jobId: 'job:1', attemptNumber: 1,
            leaseOwner: 'worker:1', leaseToken: lease?.leaseToken ?? '', now: LATER,
            expectedEvidence: prepared, nextEvidence: possibly,
        })
        await queue.recordProviderAttemptTransition({
            jobId: 'job:1', attemptNumber: 1,
            leaseOwner: 'worker:1', leaseToken: lease?.leaseToken ?? '', now: '2026-07-14T04:00:03.000Z',
            expectedEvidence: possibly,
            nextEvidence: { ...possibly, providerOutcome: 'unknown' },
            blockReason: 'provider-outcome-unknown',
        })

        await queue.requestCancel({ jobId: 'job:1', now: '2026-07-14T04:00:04.000Z' })
        await expect(queue.requestCancel({ jobId: 'job:1', now: '2026-07-14T04:00:04.000Z' }))
            .resolves.toMatchObject({ state: 'cancelled' })
        expect(await queue.getOutputReservation(current.reservationId)).toMatchObject({ state: 'writing', version: 2 })
        expect(await queue.listOutputReservationClaims(current.reservationId)).toEqual([
            expect.objectContaining({ activeCollisionKey: expect.stringMatching(/^collision:sha256:/) }),
            expect.objectContaining({ activeCollisionKey: expect.stringMatching(/^collision:sha256:/) }),
        ])

        await expect(queue.transitionOutputReservation({
            reservationId: current.reservationId,
            owner: current,
            expectedState: 'writing',
            expectedVersion: 2,
            state: 'abandoned',
        })).rejects.toMatchObject({ code: 'E_QUEUE_INVALID_TRANSITION' })
        await queue.abandonOutputReservation({
            reservationId: current.reservationId,
            owner: current,
            expectedVersion: 2,
            now: '2026-07-14T04:00:05.000Z',
        })
        expect(await queue.listOutputReservationClaims(current.reservationId)).toEqual([
            expect.objectContaining({ activeCollisionKey: null }),
            expect.objectContaining({ activeCollisionKey: null }),
        ])
    })

    it('keeps a spooled result reservation and requires matching discard proof before abandon', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('spooled-cancel-retains-reservation'))
        const current = commitSetReservation()
        await queue.createBatchAndEnqueue({
            batch: {
                id: 'batch:1', workflow: 'main', createdAt: NOW,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch:1',
            },
            jobs: [reservedJobInput(current, { snapshot: providerSnapshot() })],
            reservations: [current],
        })
        await queue.transitionOutputReservation({
            reservationId: current.reservationId, owner: current,
            expectedState: 'reserved', expectedVersion: 1, state: 'writing',
        })
        const lease = await queue.acquireLease({ jobId: 'job:1', owner: 'worker:1', now: NOW, ttlMs: 10_000 })
        await queue.transitionJob({
            jobId: 'job:1', to: 'running', now: NOW,
            leaseOwner: 'worker:1', leaseToken: lease?.leaseToken ?? '',
        })
        const digest = `sha256:${'f'.repeat(64)}` as const
        const receipt = {
            schemaVersion: 1 as const,
            spoolId: 'provider-spool-reservation',
            attemptId: 'job:1:1',
            contentType: 'image/png',
            byteLength: 4,
            sha256: digest,
            committedAt: LATER,
        }
        const evidence: ProviderAttemptEvidence[] = [
            {
                dispatchState: 'prepared', providerOutcome: 'running', billingRisk: 'none',
                responseDigest: null, spoolReceipt: null,
            },
            {
                dispatchState: 'possibly-dispatched', providerOutcome: 'running', billingRisk: 'possible',
                responseDigest: null, spoolReceipt: null,
            },
            {
                dispatchState: 'response-started', providerOutcome: 'running', billingRisk: 'possible',
                responseDigest: null, spoolReceipt: null,
            },
            {
                dispatchState: 'response-complete', providerOutcome: 'succeeded', billingRisk: 'confirmed',
                responseDigest: digest, spoolReceipt: null,
            },
            {
                dispatchState: 'result-spooled', providerOutcome: 'succeeded', billingRisk: 'confirmed',
                responseDigest: digest, spoolReceipt: receipt,
            },
        ]
        for (let index = 1; index < evidence.length; index += 1) {
            await queue.recordProviderAttemptTransition({
                jobId: 'job:1', attemptNumber: 1,
                leaseOwner: 'worker:1', leaseToken: lease?.leaseToken ?? '', now: LATER,
                expectedEvidence: evidence[index - 1], nextEvidence: evidence[index],
            })
        }
        await queue.requeueSpooledResult({
            jobId: 'job:1', attemptNumber: 1,
            leaseOwner: 'worker:1', leaseToken: lease?.leaseToken ?? '',
            now: '2026-07-14T04:00:03.000Z', readyAt: '2026-07-14T04:00:03.000Z',
        })
        await queue.requestCancel({ jobId: 'job:1', now: '2026-07-14T04:00:04.000Z' })
        expect(await queue.getOutputReservation(current.reservationId)).toMatchObject({ state: 'writing' })
        await expect(queue.abandonOutputReservation({
            reservationId: current.reservationId, owner: current, expectedVersion: 2,
            now: '2026-07-14T04:00:05.000Z',
        })).rejects.toMatchObject({ code: 'E_QUEUE_INVALID_TRANSITION' })
        await expect(queue.abandonOutputReservation({
            reservationId: current.reservationId, owner: current, expectedVersion: 2,
            now: '2026-07-14T04:00:05.000Z', discardedSpoolReceipt: receipt,
        })).resolves.toMatchObject({ state: 'abandoned', version: 3 })
    })

    it('CAS-transfers a pre-dispatch failed reservation to one retry successor', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('retry-reservation-transfer'))
        const current = commitSetReservation()
        await queue.createBatchAndEnqueue({
            batch: {
                id: 'batch:1', workflow: 'main', createdAt: NOW,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch:1',
            },
            jobs: [reservedJobInput(current, { snapshot: providerSnapshot(), maxAttempts: 1 })],
            reservations: [current],
        })
        await queue.transitionOutputReservation({
            reservationId: current.reservationId,
            owner: current,
            expectedState: 'reserved',
            expectedVersion: 1,
            state: 'writing',
        })
        const lease = await queue.acquireLease({ jobId: 'job:1', owner: 'worker:1', now: NOW, ttlMs: 10_000 })
        await queue.transitionJob({
            jobId: 'job:1', to: 'running', now: NOW,
            leaseOwner: 'worker:1', leaseToken: lease?.leaseToken ?? '',
        })
        await queue.transitionJob({
            jobId: 'job:1', to: 'failed', now: LATER,
            leaseOwner: 'worker:1', leaseToken: lease?.leaseToken ?? '', failureKind: 'transient',
        })
        const targetBatch = {
            id: 'batch:retry', workflow: 'main' as const, createdAt: '2026-07-14T04:00:03.000Z',
            failurePolicy: 'continue' as const, origin: 'retry' as const, idempotencyKey: 'batch:retry',
        }
        const retried = await queue.retryFailedJobs({ sourceBatchId: 'batch:1', targetBatch })
        const replayed = await queue.retryFailedJobs({ sourceBatchId: 'batch:1', targetBatch })

        expect(retried.jobs).toHaveLength(1)
        expect(replayed.jobs).toEqual(retried.jobs)
        expect(retried.reservations).toEqual([
            expect.objectContaining({
                reservationId: current.reservationId,
                batchId: 'batch:retry',
                jobId: retried.jobs[0].id,
                state: 'reserved',
                version: 3,
            }),
        ])
        expect(retried.jobs[0].snapshot.outputReservation?.reservationId).toBe(current.reservationId)
        expect(await queue.getJob('job:1')).toMatchObject({ state: 'failed' })
        await expect(queue.createBatchAndEnqueue({
            batch: {
                id: 'batch:1', workflow: 'main', createdAt: NOW,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch:1',
            },
            jobs: [reservedJobInput(current, { snapshot: providerSnapshot(), maxAttempts: 1 })],
            reservations: [current],
        })).rejects.toMatchObject({ code: 'E_QUEUE_IDEMPOTENCY_CONFLICT' })
    })

    it.each([
        ['unavailable', null, 'GENERATION_ATOMIC_BATCH_UNAVAILABLE'],
        ['job limit', { ...GENERATION_LIMITS, maxJobsPerAtomicBatch: 1 }, 'GENERATION_ATOMIC_BATCH_LIMIT_EXCEEDED'],
        ['claim limit', { ...GENERATION_LIMITS, maxOutputClaimsPerAtomicBatch: 3 }, 'GENERATION_ATOMIC_BATCH_LIMIT_EXCEEDED'],
    ] as const)('atomically rejects reservation retry when the %s is not satisfied', async (
        label,
        retryLimits,
        code,
    ) => {
        const factory = new IDBFactory()
        const name = databaseName(`retry-${label}`)
        const seedQueue = repository(factory, name)
        const seeded = atomicBatchInput(2, 4)
        await seedQueue.createBatchAndEnqueue(seeded)
        for (const item of seeded.jobs) {
            const lease = await seedQueue.acquireLease({ jobId: item.id, owner: 'worker:1', now: NOW, ttlMs: 10_000 })
            await seedQueue.transitionJob({
                jobId: item.id, to: 'running', now: NOW,
                leaseOwner: 'worker:1', leaseToken: lease?.leaseToken ?? '',
            })
            await seedQueue.transitionJob({
                jobId: item.id, to: 'failed', now: LATER, failureKind: 'transient',
                leaseOwner: 'worker:1', leaseToken: lease?.leaseToken ?? '',
            })
        }
        const sourceBefore = await seedQueue.listJobs({ batchId: seeded.batch.id })
        const reservationsBefore = await Promise.all(seeded.reservations.map(item => (
            seedQueue.getOutputReservation(item.reservationId)
        )))
        seedQueue.close()

        const retryQueue = repository(factory, name, retryLimits)
        await expect(retryQueue.retryFailedJobs({
            sourceBatchId: seeded.batch.id,
            targetBatch: {
                id: `batch:retry:${label}`, workflow: 'main', createdAt: '2026-07-14T04:00:03.000Z',
                failurePolicy: 'continue', origin: 'retry', idempotencyKey: `batch:retry:${label}`,
            },
        })).rejects.toMatchObject({ code })

        expect(await retryQueue.getBatch(`batch:retry:${label}`)).toBeNull()
        expect((await retryQueue.listJobs({ batchId: `batch:retry:${label}` })).items).toEqual([])
        expect(await retryQueue.listJobs({ batchId: seeded.batch.id })).toEqual(sourceBefore)
        expect(await Promise.all(seeded.reservations.map(item => (
            retryQueue.getOutputReservation(item.reservationId)
        )))).toEqual(reservationsBefore)
    })

    it('allows reservation-free legacy retry without measured generation limits', async () => {
        const factory = new IDBFactory()
        const name = databaseName('retry-legacy-unmeasured')
        const seedQueue = repository(factory, name, null)
        await seedQueue.createBatchAndEnqueue({
            batch: {
                id: 'batch:legacy-source', workflow: 'main', createdAt: NOW,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch:legacy-source',
            },
            jobs: [jobInput({ id: 'job:legacy', batchId: 'batch:legacy-source' })],
        })
        const lease = await seedQueue.acquireLease({ jobId: 'job:legacy', owner: 'worker:1', now: NOW, ttlMs: 10_000 })
        await seedQueue.transitionJob({
            jobId: 'job:legacy', to: 'running', now: NOW,
            leaseOwner: 'worker:1', leaseToken: lease?.leaseToken ?? '',
        })
        await seedQueue.transitionJob({
            jobId: 'job:legacy', to: 'failed', now: LATER, failureKind: 'transient',
            leaseOwner: 'worker:1', leaseToken: lease?.leaseToken ?? '',
        })

        const result = await seedQueue.retryFailedJobs({
            sourceBatchId: 'batch:legacy-source',
            targetBatch: {
                id: 'batch:legacy-retry', workflow: 'main', createdAt: '2026-07-14T04:00:03.000Z',
                failurePolicy: 'continue', origin: 'retry', idempotencyKey: 'batch:legacy-retry',
            },
        })
        expect(result.jobs).toHaveLength(1)
        expect(result.reservations).toEqual([])
    })

    it('rejects a reservation that is missing from the immutable job snapshot', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('output-reservation-snapshot'))

        await expect(queue.createBatchAndEnqueue({
            batch: {
                id: 'batch:1', workflow: 'main', createdAt: NOW,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch:1',
            },
            jobs: [jobInput()],
            reservations: [reservation()],
        })).rejects.toMatchObject({ code: 'E_QUEUE_RECORD_INVALID' })

        expect(await queue.getBatch('batch:1')).toBeNull()
        expect(await queue.getJob('job:1')).toBeNull()
        expect(await queue.getOutputReservation('reservation:1')).toBeNull()
    })

    it('rejects multiple output reservations for one job', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('output-reservation-job-identity'))

        await expect(queue.createBatchAndEnqueue({
            batch: {
                id: 'batch:1', workflow: 'main', createdAt: NOW,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch:1',
            },
            jobs: [reservedJobInput(reservation())],
            reservations: [
                reservation(),
                reservation({ reservationId: 'reservation:2', relativePath: 'portraits/other.webp' }),
            ],
        })).rejects.toMatchObject({ code: 'E_QUEUE_IDEMPOTENCY_CONFLICT' })

        expect(await queue.getBatch('batch:1')).toBeNull()
    })

    it('keeps abandoned reservation history without occupying its normalized path', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('output-reservation-abandoned'))
        await queue.createBatchAndEnqueue({
            batch: {
                id: 'batch:1', workflow: 'main', createdAt: NOW,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch:1',
            },
            jobs: [reservedJobInput(reservation())],
            reservations: [reservation()],
        })
        await queue.transitionOutputReservation({
            reservationId: 'reservation:1', owner: reservation(),
            expectedState: 'storage-pending', state: 'abandoned',
        })
        const replacement = reservation({
            reservationId: 'reservation:2', batchId: 'batch:2', jobId: 'job:2', state: 'storage-pending',
        })
        await queue.createBatchAndEnqueue({
            batch: {
                id: 'batch:2', workflow: 'main', createdAt: LATER,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch:2',
            },
            jobs: [reservedJobInput(replacement, {
                id: 'job:2', batchId: 'batch:2', createdAt: LATER, idempotencyKey: 'idempotency:2',
            })],
            reservations: [replacement],
        })

        expect(await queue.getOutputReservation('reservation:1')).toEqual(reservation({ state: 'abandoned' }))
        expect(await queue.getOutputReservationByPath(
            replacement.directoryIdentity,
            'portraits/Image.webp',
        )).toEqual(replacement)
    })

    it('moves reservation ownership through writing and releases only on abandon', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('output-reservation-transitions'))
        await queue.createBatchAndEnqueue({
            batch: {
                id: 'batch:1', workflow: 'main', createdAt: NOW,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch:1',
            },
            jobs: [reservedJobInput(reservation())],
            reservations: [reservation()],
        })

        await expect(queue.transitionOutputReservation({
            reservationId: 'reservation:1', owner: reservation(),
            expectedState: 'storage-pending', state: 'writing',
        })).resolves.toMatchObject({ state: 'writing' })
        await expect(queue.transitionOutputReservation({
            reservationId: 'reservation:1', owner: reservation(),
            expectedState: 'storage-pending', state: 'committed',
        })).rejects.toMatchObject({ code: 'E_QUEUE_INVALID_TRANSITION' })
        await expect(queue.transitionOutputReservation({
            reservationId: 'reservation:1', owner: reservation(),
            expectedState: 'writing', state: 'conflict',
        })).resolves.toMatchObject({ state: 'conflict' })
        expect(await queue.getOutputReservationByPath(
            reservation().directoryIdentity,
            'portraits/image.webp',
        )).not.toBeNull()
        await expect(queue.transitionOutputReservation({
            reservationId: 'reservation:1', owner: reservation(),
            expectedState: 'conflict', state: 'abandoned',
        })).resolves.toMatchObject({ state: 'abandoned' })
        expect(await queue.getOutputReservationByPath(
            reservation().directoryIdentity,
            'portraits/image.webp',
        )).toBeNull()
        expect(await queue.getOutputReservation('reservation:1')).toMatchObject({ state: 'abandoned' })
    })

    it('abandons a queued reservation in the same cancellation boundary', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('queued-cancel-reservation'))
        await queue.createBatchAndEnqueue({
            batch: {
                id: 'batch:1', workflow: 'main', createdAt: NOW,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch:1',
            },
            jobs: [reservedJobInput(reservation())],
            reservations: [reservation()],
        })

        await expect(queue.requestCancel({ jobId: 'job:1', now: LATER })).resolves.toMatchObject({
            state: 'cancelled',
        })
        expect(await queue.getOutputReservation('reservation:1')).toMatchObject({ state: 'abandoned' })
    })

    it('abandons a writing reservation when a running cancellation becomes terminal', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('running-cancel-reservation'))
        await queue.createBatchAndEnqueue({
            batch: {
                id: 'batch:1', workflow: 'main', createdAt: NOW,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch:1',
            },
            jobs: [reservedJobInput(reservation())],
            reservations: [reservation()],
        })
        const lease = await queue.acquireLease({ jobId: 'job:1', owner: 'worker:1', now: NOW, ttlMs: 60_000 })
        await queue.transitionJob({
            jobId: 'job:1', to: 'running', now: NOW,
            leaseOwner: 'worker:1', leaseToken: lease?.leaseToken ?? '',
        })
        await queue.transitionOutputReservation({
            reservationId: 'reservation:1', owner: reservation(),
            expectedState: 'storage-pending', state: 'writing',
        })
        await queue.requestCancel({ jobId: 'job:1', now: LATER })

        await expect(queue.transitionJob({
            jobId: 'job:1', to: 'cancelled', now: LATER,
            leaseOwner: 'worker:1', leaseToken: lease?.leaseToken ?? '',
        })).resolves.toMatchObject({ state: 'cancelled' })
        expect(await queue.getOutputReservation('reservation:1')).toMatchObject({ state: 'abandoned' })
    })

    it('commits a recovered output and its reservation in one repository transaction', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('recovered-reservation-commit'))
        await queue.createBatchAndEnqueue({
            batch: {
                id: 'batch:1', workflow: 'main', createdAt: NOW,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch:1',
            },
            jobs: [reservedJobInput(reservation())],
            reservations: [reservation()],
        })
        const lease = await queue.acquireLease({ jobId: 'job:1', owner: 'worker:1', now: NOW, ttlMs: 60_000 })
        await queue.transitionJob({
            jobId: 'job:1', to: 'running', now: NOW,
            leaseOwner: 'worker:1', leaseToken: lease?.leaseToken ?? '',
        })
        await queue.transitionOutputReservation({
            reservationId: 'reservation:1', owner: reservation(),
            expectedState: 'storage-pending', state: 'writing',
        })
        const artifactReference = {
            kind: 'output-writer' as const, artifactId: 'artifact:1', digest: 'sha256:artifact',
        }
        await queue.bindOutputTransaction({
            jobId: 'job:1', leaseOwner: 'worker:1', leaseToken: lease?.leaseToken ?? '', now: NOW,
            outputTransactionId: 'transaction:1', artifactReference,
        })

        await expect(queue.recoverFilesCommittedSuccess({
            jobId: 'job:1', now: LATER, outputTransactionId: 'transaction:1', artifactReference,
        })).resolves.toMatchObject({ state: 'succeeded' })
        expect(await queue.getOutputReservation('reservation:1')).toMatchObject({ state: 'committed' })
    })

    it('rejects cloning a failed reserved job without a newly planned reservation', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('reserved-failed-retry'))
        await queue.createBatchAndEnqueue({
            batch: {
                id: 'batch:1', workflow: 'main', createdAt: NOW,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch:1',
            },
            jobs: [reservedJobInput(reservation(), { maxAttempts: 1 })],
            reservations: [reservation()],
        })
        const lease = await queue.acquireLease({ jobId: 'job:1', owner: 'worker:1', now: NOW, ttlMs: 60_000 })
        await queue.transitionJob({
            jobId: 'job:1', to: 'running', now: NOW,
            leaseOwner: 'worker:1', leaseToken: lease?.leaseToken ?? '',
        })
        await queue.requeueAfterFailure({
            jobId: 'job:1', leaseOwner: 'worker:1', leaseToken: lease?.leaseToken ?? '',
            now: LATER, readyAt: LATER, failureKind: 'transient',
        })

        await expect(queue.retryFailedJobs({
            sourceBatchId: 'batch:1',
            targetBatch: {
                id: 'batch:retry', workflow: 'main', createdAt: LATER,
                failurePolicy: 'continue', origin: 'retry', idempotencyKey: 'batch:retry',
            },
        })).rejects.toMatchObject({ code: 'E_QUEUE_IDEMPOTENCY_CONFLICT' })
        expect(await queue.getBatch('batch:retry')).toBeNull()
    })

    it('rolls back a whole enqueue when a normalized output path is already reserved', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('output-reservation-collision'))
        await queue.createBatchAndEnqueue({
            batch: {
                id: 'batch:1', workflow: 'main', createdAt: NOW,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch:1',
            },
            jobs: [reservedJobInput(reservation())],
            reservations: [reservation()],
        })

        await expect(queue.createBatchAndEnqueue({
            batch: {
                id: 'batch:2', workflow: 'main', createdAt: LATER,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch:2',
            },
            jobs: [reservedJobInput(reservation({
                reservationId: 'reservation:2', batchId: 'batch:2', jobId: 'job:2',
                relativePath: 'portraits/image.webp',
                folderBinding: {
                    resourceType: 'generation-folder-document',
                    resourceId: 'folder:changed',
                    revision: 9,
                    contentHash: `sha256:${'b'.repeat(64)}`,
                },
            }), {
                id: 'job:2', batchId: 'batch:2', createdAt: LATER, idempotencyKey: 'idempotency:2',
            })],
            reservations: [reservation({
                reservationId: 'reservation:2', batchId: 'batch:2', jobId: 'job:2',
                relativePath: 'portraits/image.webp',
                folderBinding: {
                    resourceType: 'generation-folder-document',
                    resourceId: 'folder:changed',
                    revision: 9,
                    contentHash: `sha256:${'b'.repeat(64)}`,
                },
            })],
        })).rejects.toMatchObject({ code: 'E_QUEUE_IDEMPOTENCY_CONFLICT' })

        expect(await queue.getBatch('batch:2')).toBeNull()
        expect(await queue.getJob('job:2')).toBeNull()
        expect(await queue.getOutputReservation('reservation:2')).toBeNull()
    })

    it('allows the same relative path in distinct physical directories', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('output-reservation-directory-identity'))
        await queue.createBatchAndEnqueue({
            batch: {
                id: 'batch:1', workflow: 'main', createdAt: NOW,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch:1',
            },
            jobs: [reservedJobInput(reservation())],
            reservations: [reservation()],
        })
        const otherDirectory = reservation({
            reservationId: 'reservation:2', batchId: 'batch:2', jobId: 'job:2',
            directoryIdentity: `sha256:${'c'.repeat(64)}`,
        })

        await expect(queue.createBatchAndEnqueue({
            batch: {
                id: 'batch:2', workflow: 'main', createdAt: LATER,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch:2',
            },
            jobs: [reservedJobInput(otherDirectory, {
                id: 'job:2', batchId: 'batch:2', createdAt: LATER, idempotencyKey: 'idempotency:2',
            })],
            reservations: [otherDirectory],
        })).resolves.toMatchObject({ reservations: [otherDirectory] })
    })

    it('rejects a reservation transition from a different owner or destination', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('output-reservation-transition-owner'))
        await queue.createBatchAndEnqueue({
            batch: {
                id: 'batch:1', workflow: 'main', createdAt: NOW,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch:1',
            },
            jobs: [reservedJobInput(reservation())],
            reservations: [reservation()],
        })

        await expect(queue.transitionOutputReservation({
            reservationId: 'reservation:1',
            owner: { ...reservation(), jobId: 'job:other' },
            expectedState: 'storage-pending',
            state: 'writing',
        })).rejects.toMatchObject({ code: 'E_QUEUE_IDEMPOTENCY_CONFLICT' })
        expect(await queue.getOutputReservation('reservation:1')).toMatchObject({ state: 'storage-pending' })
    })

    it('rejects a replay that changes reservation meaning', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('output-reservation-idempotency'))
        const base = {
            batch: {
                id: 'batch:1', workflow: 'main' as const, createdAt: NOW,
                failurePolicy: 'continue' as const, origin: 'fresh' as const, idempotencyKey: 'batch:1',
            },
            jobs: [reservedJobInput(reservation())],
        }
        await queue.createBatchAndEnqueue({
            ...base,
            jobs: [reservedJobInput(reservation())],
            reservations: [reservation()],
        })

        await expect(queue.createBatchAndEnqueue({
            ...base,
            jobs: [reservedJobInput(reservation({ collisionPolicy: 'suffix' }))],
            reservations: [reservation({ collisionPolicy: 'suffix' })],
        })).rejects.toMatchObject({ code: 'E_QUEUE_IDEMPOTENCY_CONFLICT' })
        expect(await queue.getOutputReservation('reservation:1')).toEqual(reservation())
    })

    it('projects the immutable output folder without exposing the full snapshot', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('output-directory-projection'))
        const fixedSnapshot = createGenerationJobSnapshot({
            prompt: { positive: 'prompt', negative: '' },
            parameters: { seed: 7 },
            outputPolicy: {
                workflow: 'main',
                output: { directory: 'D:\\Images\\Prime\\01' },
            },
            resources: [],
            resumability: 'resumable',
        })
        await queue.createBatchAndEnqueue({
            batch: {
                id: 'batch:1', workflow: 'main', createdAt: NOW,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch:1',
            },
            jobs: [jobInput({ snapshot: fixedSnapshot })],
        })

        const page = await queue.listJobProjections({ batchId: 'batch:1' })
        expect(page.items[0]).toMatchObject({ outputDirectory: 'D:\\Images\\Prime\\01' })
        expect(page.items[0]).not.toHaveProperty('snapshot')
        queue.close()
    })

    it('projects rotation Scene jobs under the shared character parent', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('rotation-output-directory-projection'))
        const fixedSnapshot = createGenerationJobSnapshot({
            prompt: { positive: 'prompt', negative: '' },
            parameters: { seed: 7 },
            outputPolicy: {
                workflow: 'scene',
                saveContext: {
                    activePresetId: 'preset-a',
                    sceneSavePath: 'E:\\NAI\\Scenes',
                    rotationCharacterFolderName: 'Hero',
                },
                outputContext: {
                    presetPathSegments: ['Preset A'],
                    sceneName: 'Opening',
                },
            },
            resources: [],
            resumability: 'resumable',
        })
        await queue.createBatchAndEnqueue({
            batch: {
                id: 'batch:scene', workflow: 'scene', createdAt: NOW,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch:scene',
            },
            jobs: [jobInput({
                batchId: 'batch:scene',
                workflow: 'scene',
                sceneId: 'scene:opening',
                snapshot: fixedSnapshot,
            })],
        })

        const page = await queue.listJobProjections({ batchId: 'batch:scene' })
        expect(page.items[0]).toMatchObject({
            outputDirectory: 'E:\\NAI\\Scenes/Preset A/Character_Scenes/Hero/Opening',
        })
        queue.close()
    })

    it('orders the oldest batch before a newer batch ordinal while preserving priority', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('cross-batch-order'))
        const oldBatchId = 'batch:z-old'
        const newBatchId = 'batch:a-new'
        await queue.createBatchAndEnqueue({
            batch: {
                id: oldBatchId, workflow: 'main', createdAt: NOW,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: oldBatchId,
            },
            jobs: [0, 1].map(ordinal => jobInput({
                id: `job:old:${ordinal}`,
                batchId: oldBatchId,
                ordinal,
                idempotencyKey: `job:old:${ordinal}`,
            })),
        })
        await queue.createBatchAndEnqueue({
            batch: {
                id: newBatchId, workflow: 'main', createdAt: NOW,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: newBatchId,
            },
            jobs: [
                jobInput({
                    id: 'job:new:normal', batchId: newBatchId, priority: 0, ordinal: 0,
                    idempotencyKey: 'job:new:normal',
                }),
                jobInput({
                    id: 'job:new:urgent', batchId: newBatchId, priority: 1, ordinal: 1,
                    idempotencyKey: 'job:new:urgent',
                }),
            ],
        })

        expect(await queue.getBatch(oldBatchId)).toMatchObject({ queueSequence: 1 })
        expect(await queue.getBatch(newBatchId)).toMatchObject({ queueSequence: 2 })
        expect((await queue.listJobs({ states: ['queued'] })).items.map(job => job.id)).toEqual([
            'job:new:urgent',
            'job:old:0',
            'job:old:1',
            'job:new:normal',
        ])
    })

    it('allocates unique monotonic batch sequences across repository instances', async () => {
        const factory = new IDBFactory()
        const name = databaseName('sequence-race')
        const first = repository(factory, name)
        const second = repository(factory, name)
        await Promise.all([first.initialize(), second.initialize()])

        const batches = await Promise.all([
            first.createBatch({ id: 'batch:a', workflow: 'main', createdAt: NOW }),
            second.createBatch({ id: 'batch:b', workflow: 'main', createdAt: NOW }),
        ])
        expect(batches.map(batch => batch.queueSequence).sort((left, right) => left - right)).toEqual([1, 2])
    })

    it('migrates v4 order deterministically without rewriting snapshot or runtime records', async () => {
        const factory = new IDBFactory()
        const name = databaseName('v5-order-upgrade')
        const snapshotHash = await createV4Database(factory, name)
        const queue = repository(factory, name)
        await queue.initialize()

        expect(await queue.getBatch('batch:0')).toMatchObject({
            queueSequence: 1,
            version: 3,
            projectionRevision: 9,
        })
        expect(await queue.getBatch('batch:1')).toMatchObject({
            queueSequence: 2,
            version: 4,
            projectionRevision: 7,
            projectionSummary: { total: 1, states: { running: 1 } },
        })
        expect(await queue.getJob('job:1')).toMatchObject({
            state: 'running',
            snapshotSchemaVersion: 1,
            snapshotHash,
            leaseOwner: 'worker:v4',
            attemptCount: 1,
            retryOfJobId: 'job:source',
            rootJobId: 'job:source',
            version: 5,
        })
        expect(await queue.listAttempts('job:1')).toEqual([
            expect.objectContaining({
                recordSchemaVersion: 2,
                attemptNumber: 1,
                outcome: 'running',
                finishedAt: null,
                providerEvidence: null,
                providerTransitions: [],
                executionEnvelopeHash: null,
            }),
        ])
    })

    it('deduplicates the same idempotency key and rejects conflicting content', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('idempotency'))
        await queue.initialize()
        await queue.createBatch({ id: 'batch:1', workflow: 'main', createdAt: NOW })

        const first = await queue.enqueue(jobInput())
        const duplicate = await queue.enqueue(jobInput({ id: 'job:duplicate' }))
        expect(duplicate.id).toBe(first.id)

        await expect(queue.enqueue(jobInput({
            id: 'job:conflict',
            snapshot: createGenerationJobSnapshot({
                prompt: { positive: 'different fixed prompt', negative: '' },
                parameters: { seed: 8 },
                outputPolicy: { format: 'png' },
                resources: [],
                resumability: 'resumable',
            }),
        }))).rejects.toMatchObject({ code: 'E_QUEUE_IDEMPOTENCY_CONFLICT' })
    })

    it('grants exactly one competing CAS lease and preserves owner checks', async () => {
        const factory = new IDBFactory()
        const name = databaseName('lease-race')
        const first = repository(factory, name)
        const second = repository(factory, name)
        await Promise.all([first.initialize(), second.initialize()])
        await first.createBatch({ id: 'batch:1', workflow: 'main', createdAt: NOW })
        await first.enqueue(jobInput())

        const leases = await Promise.all([
            first.acquireLease({ jobId: 'job:1', owner: 'worker:a', now: NOW, ttlMs: 1_000 }),
            second.acquireLease({ jobId: 'job:1', owner: 'worker:b', now: NOW, ttlMs: 1_000 }),
        ])
        expect(leases.filter(Boolean)).toHaveLength(1)
        const winner = leases.find(Boolean)
        expect(winner?.state).toBe('leased')
        expect(winner?.leaseOwner).toMatch(/^worker:[ab]$/)

        const loser = winner?.leaseOwner === 'worker:a' ? 'worker:b' : 'worker:a'
        await expect(first.transitionJob({
            jobId: 'job:1',
            to: 'running',
            now: NOW,
            leaseOwner: loser,
        })).rejects.toMatchObject({ code: 'E_QUEUE_LEASE_LOST' })
    })

    it('recovers an expired running lease after an app restart', async () => {
        const factory = new IDBFactory()
        const name = databaseName('restart')
        const beforeRestart = repository(factory, name)
        await beforeRestart.initialize()
        await beforeRestart.createBatch({ id: 'batch:1', workflow: 'main', createdAt: NOW })
        await beforeRestart.enqueue(jobInput())
        const lease = await beforeRestart.acquireLease({ jobId: 'job:1', owner: 'worker:old', now: NOW, ttlMs: 1_000 })
        await beforeRestart.transitionJob({
            jobId: 'job:1',
            to: 'running',
            now: NOW,
            leaseOwner: 'worker:old',
            leaseToken: lease?.leaseToken ?? '',
        })
        beforeRestart.close()

        const afterRestart = repository(factory, name)
        const recovered = await recoverQueueAfterRestart(afterRestart, { now: LATER })
        expect(recovered).toMatchObject({ recovering: 1, queued: 1, blocked: 0, failed: 0 })
        expect(await afterRestart.getJob('job:1')).toMatchObject({
            state: 'queued',
            attemptCount: 1,
            leaseOwner: null,
            leaseExpiresAt: null,
        })
    })

    it('blocks recovery when a required managed resource is missing', async () => {
        const factory = new IDBFactory()
        const name = databaseName('missing-resource')
        const queue = repository(factory, name)
        await queue.initialize()
        await queue.createBatch({ id: 'batch:1', workflow: 'scene', createdAt: NOW })
        await queue.enqueue(jobInput({
            workflow: 'scene',
            sceneId: 'scene:1',
            snapshot: snapshot([{
                resourceId: 'resource:missing',
                role: 'source',
                persistence: 'managed-app-data',
                digest: 'sha256:missing',
                reference: { relativePath: 'queue-resources/missing.bin' },
            }]),
        }))
        await queue.acquireLease({ jobId: 'job:1', owner: 'worker:old', now: NOW, ttlMs: 1_000 })
        queue.close()

        const restarted = repository(factory, name)
        const recovered = await recoverQueueAfterRestart(restarted, { now: LATER })
        expect(recovered).toMatchObject({ recovering: 1, queued: 0, blocked: 1, failed: 0 })
        expect(await restarted.getJob('job:1')).toMatchObject({
            state: 'blocked',
            blockReason: 'missing-resource',
        })
    })

    it('paginates 10,000 jobs in stable indexed order without gaps or duplicates', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('pagination'))
        await queue.initialize()
        await queue.createBatch({ id: 'batch:1', workflow: 'main', createdAt: NOW })
        const fixedSnapshot = snapshot()
        const jobs: EnqueueGenerationJobInput[] = Array.from({ length: 10_000 }, (_, index) => ({
            id: `job:${index.toString().padStart(5, '0')}`,
            batchId: 'batch:1',
            workflow: 'main',
            sceneId: null,
            createdAt: new Date(Date.parse(NOW) + index).toISOString(),
            priority: index % 7,
            ordinal: 10_000 - index,
            snapshot: fixedSnapshot,
            compositionPlanHash: null,
            maxAttempts: 3,
            idempotencyKey: `idempotency:${index}`,
        }))
        await queue.enqueueMany(jobs)

        const ids: string[] = []
        let cursor: string | null = null
        do {
            const page = await queue.listJobs({ batchId: 'batch:1', cursor, limit: 137 })
            ids.push(...page.items.map(job => job.id))
            cursor = page.nextCursor
        } while (cursor !== null)

        const expected = [...jobs]
            .sort((left, right) => (
                right.priority - left.priority
                || left.ordinal - right.ordinal
                || left.createdAt.localeCompare(right.createdAt)
                || left.id.localeCompare(right.id)
            ))
            .map(job => job.id)
        expect(ids).toEqual(expected)
        expect(new Set(ids).size).toBe(10_000)
    }, 30_000)

    it('backfills v3 batch aggregates and reads bounded indexed projection windows', async () => {
        const factory = new IDBFactory()
        const name = databaseName('projection-upgrade')
        await createV3Database(factory, name)
        const queue = repository(factory, name)
        await queue.initialize()

        const projectionReads = vi.spyOn(queue, 'listJobProjections')
        await expect(queue.getBatchSummary('batch:1')).resolves.toMatchObject({
            total: 1,
            states: { queued: 1 },
        })
        expect(projectionReads).not.toHaveBeenCalled()

        const firstWindow = await queue.listJobProjectionWindow({
            batchId: 'batch:1',
            offset: 0,
            limit: 1,
        })
        expect(firstWindow).toMatchObject({
            revision: 1,
            total: 1,
            state: null,
            items: [expect.objectContaining({ id: 'job:1', state: 'queued' })],
        })
        expect(firstWindow.items[0]).not.toHaveProperty('snapshot')
        expect((await queue.inspectSchema()).indexes.jobs).toContain('by-batch-state-order')
    })

    it('advances the durable summary revision for queue-visible mutations and windows', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('projection-delta'))
        await queue.createBatch({ id: 'batch:1', workflow: 'main', createdAt: NOW })
        await queue.enqueueMany(Array.from({ length: 8 }, (_, index) => jobInput({
            id: `job:${index}`,
            ordinal: index,
            idempotencyKey: `idempotency:${index}`,
        })))

        const initial = await queue.getBatchProjectionMeta('batch:1')
        expect(initial).toMatchObject({ revision: 1, summary: { total: 8, states: { queued: 8 } } })
        const middle = await queue.listJobProjectionWindow({ batchId: 'batch:1', offset: 3, limit: 2 })
        expect(middle.items.map(job => job.id)).toEqual(['job:3', 'job:4'])

        const lease = await queue.acquireLease({ jobId: 'job:3', owner: 'worker:projection', now: NOW, ttlMs: 60_000 })
        const leased = await queue.getBatchProjectionMeta('batch:1')
        expect(leased).toMatchObject({ revision: 2, summary: { states: { queued: 7, leased: 1 } } })
        await queue.transitionJob({
            jobId: 'job:3',
            to: 'running',
            now: NOW,
            leaseOwner: 'worker:projection',
            leaseToken: lease?.leaseToken ?? '',
        })
        await queue.updateProgress({
            jobId: 'job:3',
            leaseOwner: 'worker:projection',
            leaseToken: lease?.leaseToken ?? '',
            now: NOW,
            progress: { stage: 'sampling', current: 1, total: 4 },
        })
        const running = await queue.getBatchProjectionMeta('batch:1')
        expect(running).toMatchObject({
            revision: 4,
            summary: { states: { queued: 7, running: 1 }, progressCurrent: 0.25, progressTotal: 8 },
        })
        const runningWindow = await queue.listJobProjectionWindow({
            batchId: 'batch:1', state: 'running', offset: 0, limit: 4,
        })
        expect(runningWindow).toMatchObject({ total: 1, items: [expect.objectContaining({ id: 'job:3' })] })

        await queue.bindOutputTransaction({
            jobId: 'job:3',
            leaseOwner: 'worker:projection',
            leaseToken: lease?.leaseToken ?? '',
            now: LATER,
            outputTransactionId: 'output:projection',
            artifactReference: { kind: 'output-writer', artifactId: 'artifact:projection', digest: 'sha256:projection' },
        })
        await queue.completeSucceeded({
            jobId: 'job:3',
            leaseOwner: 'worker:projection',
            leaseToken: lease?.leaseToken ?? '',
            now: LATER,
            outputTransactionId: 'output:projection',
            artifactReference: { kind: 'output-writer', artifactId: 'artifact:projection', digest: 'sha256:projection' },
        })
        await expect(queue.getBatchProjectionMeta('batch:1')).resolves.toMatchObject({
            revision: 6,
            summary: {
                completed: 1,
                progressCurrent: 1,
                states: { queued: 7, succeeded: 1 },
                recentCompletedAt: [LATER],
            },
        })
    })

    it('records attempts, output references, and terminal idempotency while rejecting terminal mutation', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('terminal'))
        await queue.initialize()
        await queue.createBatch({ id: 'batch:1', workflow: 'main', createdAt: NOW })
        await queue.enqueue(jobInput())
        const lease = await queue.acquireLease({ jobId: 'job:1', owner: 'worker:1', now: NOW, ttlMs: 5_000 })
        await queue.transitionJob({
            jobId: 'job:1',
            to: 'running',
            now: NOW,
            leaseOwner: 'worker:1',
            leaseToken: lease?.leaseToken ?? '',
        })
        const succeeded = await queue.transitionJob({
            jobId: 'job:1',
            to: 'succeeded',
            now: LATER,
            leaseOwner: 'worker:1',
            leaseToken: lease?.leaseToken ?? '',
            outputTransactionId: 'output-transaction:1',
            artifactReference: {
                kind: 'output-writer',
                artifactId: 'artifact:1',
                digest: 'sha256:artifact',
            },
        })
        const repeated = await queue.transitionJob({
            jobId: 'job:1',
            to: 'succeeded',
            now: '2026-07-14T04:00:03.000Z',
            leaseOwner: 'worker:1',
        })
        expect(repeated).toEqual(succeeded)
        expect(await queue.listAttempts('job:1')).toEqual([
            expect.objectContaining({ attemptNumber: 1, outcome: 'succeeded', finishedAt: LATER }),
        ])
        await expect(queue.transitionJob({
            jobId: 'job:1',
            to: 'queued',
            now: LATER,
        })).rejects.toMatchObject({ code: 'E_QUEUE_TERMINAL_IMMUTABLE' })
    })

    it('starts new Provider attempts at prepared and enforces lease-owned monotonic evidence CAS', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('provider-attempt-cas'))
        await queue.createBatch({ id: 'batch:1', workflow: 'main', createdAt: NOW })
        await queue.enqueue(jobInput({ snapshot: providerSnapshot() }))
        const lease = await queue.acquireLease({ jobId: 'job:1', owner: 'worker:provider', now: NOW, ttlMs: 5_000 })
        await queue.transitionJob({
            jobId: 'job:1', to: 'running', now: NOW,
            leaseOwner: 'worker:provider', leaseToken: lease?.leaseToken ?? '',
        })

        const prepared = {
            dispatchState: 'prepared' as const,
            providerOutcome: 'running' as const,
            billingRisk: 'none' as const,
            responseDigest: null,
            spoolReceipt: null,
        }
        const possiblyDispatched = {
            dispatchState: 'possibly-dispatched' as const,
            providerOutcome: 'running' as const,
            billingRisk: 'possible' as const,
            responseDigest: null,
            spoolReceipt: null,
        }
        expect(await queue.listAttempts('job:1')).toEqual([
            expect.objectContaining({
                recordSchemaVersion: 2,
                providerEvidence: prepared,
                providerTransitions: [],
                executionEnvelopeHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            }),
        ])
        await expect(queue.recordProviderAttemptTransition({
            jobId: 'job:1', attemptNumber: 1,
            leaseOwner: 'worker:provider', leaseToken: lease?.leaseToken ?? '', now: LATER,
            expectedEvidence: prepared,
            nextEvidence: { ...possiblyDispatched, providerOutcome: 'unknown' },
        })).rejects.toMatchObject({ code: 'E_QUEUE_RECORD_INVALID' })
        await expect(queue.recordProviderAttemptTransition({
            jobId: 'job:1', attemptNumber: 1,
            leaseOwner: 'worker:provider', leaseToken: lease?.leaseToken ?? '', now: LATER,
            expectedEvidence: prepared,
            nextEvidence: { ...possiblyDispatched, billingRisk: 'none' },
        })).rejects.toMatchObject({ code: 'E_QUEUE_RECORD_INVALID' })
        await expect(queue.recordProviderAttemptTransition({
            jobId: 'job:1', attemptNumber: 1,
            leaseOwner: 'worker:provider', leaseToken: lease?.leaseToken ?? '', now: LATER,
            expectedEvidence: prepared,
            nextEvidence: possiblyDispatched,
            blockReason: 'provider-outcome-unknown',
        })).rejects.toMatchObject({ code: 'E_QUEUE_RECORD_INVALID' })
        await expect(queue.recordProviderAttemptTransition({
            jobId: 'job:1', attemptNumber: 1,
            leaseOwner: 'worker:provider', leaseToken: lease?.leaseToken ?? '', now: LATER,
            expectedEvidence: prepared,
            nextEvidence: { ...possiblyDispatched, secret: 'must-not-persist' },
        } as Parameters<typeof queue.recordProviderAttemptTransition>[0])).rejects.toMatchObject({
            code: 'E_QUEUE_RECORD_INVALID',
        })
        await expect(queue.recordProviderAttemptTransition({
            jobId: 'job:1', attemptNumber: 1,
            leaseOwner: 'worker:provider', leaseToken: lease?.leaseToken ?? '', now: LATER,
            expectedEvidence: prepared,
            nextEvidence: {
                dispatchState: 'result-spooled',
                providerOutcome: 'succeeded',
                billingRisk: 'confirmed',
                responseDigest: `sha256:${'b'.repeat(64)}`,
                spoolReceipt: {
                    schemaVersion: 1,
                    spoolId: 'spool:job:1:1',
                    attemptId: 'job:1:1',
                    contentType: 'image/png',
                    byteLength: 4,
                    sha256: `sha256:${'b'.repeat(64)}`,
                    committedAt: LATER,
                    path: 'C:\\private\\result.png',
                },
            },
            blockReason: 'provider-result-lost',
        } as Parameters<typeof queue.recordProviderAttemptTransition>[0])).rejects.toMatchObject({
            code: 'E_QUEUE_RECORD_INVALID',
        })
        await expect(queue.recordProviderAttemptTransition({
            jobId: 'job:1', attemptNumber: 1,
            leaseOwner: 'worker:provider', leaseToken: 'wrong-token', now: LATER,
            expectedEvidence: prepared, nextEvidence: possiblyDispatched,
        })).rejects.toMatchObject({ code: 'E_QUEUE_LEASE_LOST' })

        const transitioned = await queue.recordProviderAttemptTransition({
            jobId: 'job:1', attemptNumber: 1,
            leaseOwner: 'worker:provider', leaseToken: lease?.leaseToken ?? '', now: LATER,
            expectedEvidence: prepared, nextEvidence: possiblyDispatched,
        })
        expect(transitioned).toMatchObject({
            providerEvidence: possiblyDispatched,
            providerTransitions: [{
                attemptId: 'job:1:1', jobId: 'job:1', attemptNumber: 1, occurredAt: LATER,
                from: prepared, to: possiblyDispatched, diagnosticEventId: null,
            }],
        })
        await expect(queue.recordProviderAttemptTransition({
            jobId: 'job:1', attemptNumber: 1,
            leaseOwner: 'worker:provider', leaseToken: lease?.leaseToken ?? '', now: LATER,
            expectedEvidence: possiblyDispatched,
            nextEvidence: { ...possiblyDispatched, providerOutcome: 'known-failure' },
        })).rejects.toMatchObject({ code: 'E_QUEUE_RECORD_INVALID' })
        await expect(queue.recordProviderAttemptTransition({
            jobId: 'job:1', attemptNumber: 1,
            leaseOwner: 'worker:provider', leaseToken: lease?.leaseToken ?? '', now: LATER,
            expectedEvidence: prepared, nextEvidence: possiblyDispatched,
        })).rejects.toMatchObject({ code: 'E_QUEUE_INVALID_TRANSITION' })
        const responseStarted = { ...possiblyDispatched, dispatchState: 'response-started' as const }
        const responseComplete = {
            dispatchState: 'response-complete' as const,
            providerOutcome: 'succeeded' as const,
            billingRisk: 'confirmed' as const,
            responseDigest: `sha256:${'e'.repeat(64)}`,
            spoolReceipt: null,
        }
        const resultLost = { ...responseComplete, dispatchState: 'result-lost' as const }
        await queue.recordProviderAttemptTransition({
            jobId: 'job:1', attemptNumber: 1,
            leaseOwner: 'worker:provider', leaseToken: lease?.leaseToken ?? '', now: LATER,
            expectedEvidence: possiblyDispatched, nextEvidence: responseStarted,
        })
        await queue.recordProviderAttemptTransition({
            jobId: 'job:1', attemptNumber: 1,
            leaseOwner: 'worker:provider', leaseToken: lease?.leaseToken ?? '', now: LATER,
            expectedEvidence: responseStarted, nextEvidence: responseComplete,
        })
        await expect(queue.recordProviderAttemptTransition({
            jobId: 'job:1', attemptNumber: 1,
            leaseOwner: 'worker:provider', leaseToken: lease?.leaseToken ?? '', now: LATER,
            expectedEvidence: responseComplete, nextEvidence: resultLost,
        })).rejects.toMatchObject({ code: 'E_QUEUE_RECORD_INVALID' })
        await queue.recordProviderAttemptTransition({
            jobId: 'job:1', attemptNumber: 1,
            leaseOwner: 'worker:provider', leaseToken: lease?.leaseToken ?? '', now: LATER,
            expectedEvidence: responseComplete, nextEvidence: resultLost,
            blockReason: 'provider-result-lost',
        })
        expect(await queue.getJob('job:1')).toMatchObject({
            state: 'blocked', blockReason: 'provider-result-lost', leaseOwner: null,
        })
    })

    it('records unknown Provider evidence and blocks the running job in one transaction', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('provider-attempt-block'))
        await queue.createBatch({ id: 'batch:1', workflow: 'main', createdAt: NOW })
        await queue.enqueue(jobInput({ snapshot: providerSnapshot() }))
        const lease = await queue.acquireLease({ jobId: 'job:1', owner: 'worker:provider', now: NOW, ttlMs: 5_000 })
        await queue.transitionJob({
            jobId: 'job:1', to: 'running', now: NOW,
            leaseOwner: 'worker:provider', leaseToken: lease?.leaseToken ?? '',
        })
        const prepared = {
            dispatchState: 'prepared' as const,
            providerOutcome: 'running' as const,
            billingRisk: 'none' as const,
            responseDigest: null,
            spoolReceipt: null,
        }
        const possiblyDispatched = {
            dispatchState: 'possibly-dispatched' as const,
            providerOutcome: 'running' as const,
            billingRisk: 'possible' as const,
            responseDigest: null,
            spoolReceipt: null,
        }
        await queue.recordProviderAttemptTransition({
            jobId: 'job:1', attemptNumber: 1,
            leaseOwner: 'worker:provider', leaseToken: lease?.leaseToken ?? '',
            now: LATER, expectedEvidence: prepared, nextEvidence: possiblyDispatched,
        })
        const unknown = { ...possiblyDispatched, providerOutcome: 'unknown' as const }
        const blocked = await queue.recordProviderAttemptTransition({
            jobId: 'job:1', attemptNumber: 1,
            leaseOwner: 'worker:provider', leaseToken: lease?.leaseToken ?? '',
            now: '2026-07-14T04:00:03.000Z',
            expectedEvidence: possiblyDispatched,
            nextEvidence: unknown,
            diagnosticEventId: 'diagnostic:provider-timeout',
            blockReason: 'provider-outcome-unknown',
        })

        expect(blocked).toMatchObject({
            outcome: 'interrupted',
            finishedAt: '2026-07-14T04:00:03.000Z',
            providerEvidence: unknown,
            diagnosticEventId: 'diagnostic:provider-timeout',
        })
        expect(await queue.getJob('job:1')).toMatchObject({
            state: 'blocked',
            blockReason: 'provider-outcome-unknown',
            leaseOwner: null,
            leaseToken: null,
            lastDiagnosticEventId: 'diagnostic:provider-timeout',
        })
    })

    it('rejects generic requeue once Provider dispatch evidence exists', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('provider-generic-retry-guard'))
        await queue.createBatch({ id: 'batch:1', workflow: 'main', createdAt: NOW })
        await queue.enqueue(jobInput({ snapshot: providerSnapshot() }))
        const lease = await queue.acquireLease({ jobId: 'job:1', owner: 'worker:provider', now: NOW, ttlMs: 5_000 })
        await queue.transitionJob({
            jobId: 'job:1', to: 'running', now: NOW,
            leaseOwner: 'worker:provider', leaseToken: lease?.leaseToken ?? '',
        })
        const prepared: ProviderAttemptEvidence = {
            dispatchState: 'prepared', providerOutcome: 'running', billingRisk: 'none',
            responseDigest: null, spoolReceipt: null,
        }
        const possiblyDispatched: ProviderAttemptEvidence = {
            ...prepared, dispatchState: 'possibly-dispatched', billingRisk: 'possible',
        }
        await queue.recordProviderAttemptTransition({
            jobId: 'job:1', attemptNumber: 1,
            leaseOwner: 'worker:provider', leaseToken: lease?.leaseToken ?? '', now: LATER,
            expectedEvidence: prepared, nextEvidence: possiblyDispatched,
        })

        await expect(queue.requeueAfterFailure({
            jobId: 'job:1', leaseOwner: 'worker:provider', leaseToken: lease?.leaseToken ?? '',
            now: '2026-07-14T04:00:03.000Z', readyAt: '2026-07-14T04:00:03.000Z',
            failureKind: 'transient',
        })).rejects.toMatchObject({
            code: 'E_QUEUE_INVALID_TRANSITION',
        })
        expect(await queue.getJob('job:1')).toMatchObject({ state: 'running', attemptCount: 1 })
        expect(await queue.listAttempts('job:1')).toEqual([
            expect.objectContaining({ outcome: 'running', providerEvidence: possiblyDispatched }),
        ])
        expect(await queue.getJob('job:1')).toMatchObject({
            leaseOwner: 'worker:provider', leaseToken: lease?.leaseToken,
        })
    })

    it('requeues and resumes a spooled result without closing or incrementing its Provider attempt', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('provider-spooled-resume'))
        await queue.createBatch({ id: 'batch:1', workflow: 'main', createdAt: NOW })
        await queue.enqueue(jobInput({ snapshot: providerSnapshot() }))
        const lease = await queue.acquireLease({ jobId: 'job:1', owner: 'worker:first', now: NOW, ttlMs: 10_000 })
        await queue.transitionJob({
            jobId: 'job:1', to: 'running', now: NOW,
            leaseOwner: 'worker:first', leaseToken: lease?.leaseToken ?? '',
        })
        const prepared = {
            dispatchState: 'prepared' as const, providerOutcome: 'running' as const,
            billingRisk: 'none' as const, responseDigest: null, spoolReceipt: null,
        }
        const possibly = {
            dispatchState: 'possibly-dispatched' as const, providerOutcome: 'running' as const,
            billingRisk: 'possible' as const, responseDigest: null, spoolReceipt: null,
        }
        const started = { ...possibly, dispatchState: 'response-started' as const }
        const digest = `sha256:${'f'.repeat(64)}` as const
        const complete = {
            dispatchState: 'response-complete' as const, providerOutcome: 'succeeded' as const,
            billingRisk: 'confirmed' as const, responseDigest: digest, spoolReceipt: null,
        }
        const receipt = {
            schemaVersion: 1 as const, spoolId: 'provider-spool-1', attemptId: 'job:1:1',
            contentType: 'image/png', byteLength: 4, sha256: digest, committedAt: LATER,
        }
        const spooled = { ...complete, dispatchState: 'result-spooled' as const, spoolReceipt: receipt }
        let expected: ProviderAttemptEvidence = prepared
        for (const next of [possibly, started, complete, spooled]) {
            await queue.recordProviderAttemptTransition({
                jobId: 'job:1', attemptNumber: 1,
                leaseOwner: 'worker:first', leaseToken: lease?.leaseToken ?? '', now: LATER,
                expectedEvidence: expected, nextEvidence: next,
            })
            expected = next
        }
        await queue.requeueSpooledResult({
            jobId: 'job:1', attemptNumber: 1,
            leaseOwner: 'worker:first', leaseToken: lease?.leaseToken ?? '',
            now: '2026-07-14T04:00:03.000Z', readyAt: '2026-07-14T04:00:03.000Z',
        })
        expect(await queue.listAttempts('job:1')).toEqual([
            expect.objectContaining({ attemptNumber: 1, outcome: 'running', finishedAt: null, providerEvidence: spooled }),
        ])
        const resumedLease = await queue.acquireLease({
            jobId: 'job:1', owner: 'worker:second', now: '2026-07-14T04:00:03.000Z', ttlMs: 10_000,
        })
        const resumed = await queue.resumeSpooledAttempt({
            jobId: 'job:1', attemptNumber: 1,
            leaseOwner: 'worker:second', leaseToken: resumedLease?.leaseToken ?? '',
            now: '2026-07-14T04:00:04.000Z',
        })
        expect(resumed).toMatchObject({ state: 'running', attemptCount: 1 })
        expect(await queue.listAttempts('job:1')).toHaveLength(1)
    })

    it('reconciles a committed spool after the previous process lease expired', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('provider-startup-reconcile'))
        await queue.createBatch({ id: 'batch:1', workflow: 'main', createdAt: NOW })
        await queue.enqueue(jobInput({ snapshot: providerSnapshot() }))
        const lease = await queue.acquireLease({ jobId: 'job:1', owner: 'worker:old', now: NOW, ttlMs: 5_000 })
        await queue.transitionJob({
            jobId: 'job:1', to: 'running', now: NOW,
            leaseOwner: 'worker:old', leaseToken: lease?.leaseToken ?? '',
        })
        const prepared: ProviderAttemptEvidence = {
            dispatchState: 'prepared', providerOutcome: 'running', billingRisk: 'none',
            responseDigest: null, spoolReceipt: null,
        }
        const possibly: ProviderAttemptEvidence = {
            ...prepared, dispatchState: 'possibly-dispatched', billingRisk: 'possible',
        }
        const started: ProviderAttemptEvidence = { ...possibly, dispatchState: 'response-started' }
        const digest = `sha256:${'c'.repeat(64)}` as const
        const complete: ProviderAttemptEvidence = {
            dispatchState: 'response-complete', providerOutcome: 'succeeded', billingRisk: 'confirmed',
            responseDigest: null, spoolReceipt: null,
        }
        let expected = prepared
        for (const next of [possibly, started, complete]) {
            await queue.recordProviderAttemptTransition({
                jobId: 'job:1', attemptNumber: 1,
                leaseOwner: 'worker:old', leaseToken: lease?.leaseToken ?? '', now: LATER,
                expectedEvidence: expected, nextEvidence: next,
            })
            expected = next
        }
        const receipt = {
            schemaVersion: 1 as const, spoolId: 'provider-recovered', attemptId: 'job:1:1',
            contentType: 'image/png', byteLength: 3, sha256: digest,
            committedAt: '2026-07-14T04:00:03.000Z',
        }
        const reconciled = await queue.reconcileProviderAttemptAfterRestart({
            jobId: 'job:1', attemptNumber: 1, now: '2026-07-14T04:00:10.000Z',
            expectedEvidence: complete,
            nextEvidence: {
                ...complete, dispatchState: 'result-spooled', responseDigest: digest, spoolReceipt: receipt,
            },
            disposition: 'queued-spooled',
        })
        expect(reconciled).toMatchObject({ state: 'queued', attemptCount: 1, leaseOwner: null })
        expect(await queue.listAttempts('job:1')).toEqual([
            expect.objectContaining({
                outcome: 'running', finishedAt: null,
                providerEvidence: expect.objectContaining({ dispatchState: 'result-spooled', spoolReceipt: receipt }),
            }),
        ])
    })

    it('rejects Provider envelope extras and resource bindings that do not match the immutable snapshot', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('provider-envelope-validation'))
        await queue.createBatch({ id: 'batch:1', workflow: 'main', createdAt: NOW })
        const base = providerSnapshot()
        await expect(queue.enqueue(jobInput({
            snapshot: {
                ...base,
                providerExecutionEnvelope: {
                    ...base.providerExecutionEnvelope,
                    unexpected: 'extra-envelope-field',
                },
            } as GenerationJobSnapshot,
        }))).rejects.toMatchObject({ code: 'E_QUEUE_RECORD_INVALID' })
        await expect(queue.enqueue(jobInput({
            id: 'job:binding',
            idempotencyKey: 'idempotency:binding',
            snapshot: {
                ...base,
                providerExecutionEnvelope: {
                    ...base.providerExecutionEnvelope!,
                    queueResourceBindings: [{
                        resourceId: 'resource:missing',
                        role: 'source',
                        digest: `sha256:${'c'.repeat(64)}`,
                    }],
                },
            },
        }))).rejects.toMatchObject({ code: 'E_QUEUE_RECORD_INVALID' })
        const resource = {
            resourceId: 'resource:source',
            role: 'source' as const,
            persistence: 'managed-app-data' as const,
            digest: `sha256:${'d'.repeat(64)}`,
            reference: { relativePath: 'queue-resources/source.bin' },
        }
        const withResource = snapshot([resource])
        await expect(queue.enqueue(jobInput({
            id: 'job:binding-missing-from-envelope',
            idempotencyKey: 'idempotency:binding-missing-from-envelope',
            snapshot: {
                ...withResource,
                providerExecutionEnvelope: base.providerExecutionEnvelope,
            },
        }))).rejects.toMatchObject({ code: 'E_QUEUE_RECORD_INVALID' })
        const exactBinding = {
            resourceId: resource.resourceId,
            role: resource.role,
            digest: resource.digest,
        }
        await expect(queue.enqueue(jobInput({
            id: 'job:binding-duplicate',
            idempotencyKey: 'idempotency:binding-duplicate',
            snapshot: {
                ...withResource,
                providerExecutionEnvelope: {
                    ...base.providerExecutionEnvelope!,
                    queueResourceBindings: [exactBinding, exactBinding],
                },
            },
        }))).rejects.toMatchObject({ code: 'E_QUEUE_RECORD_INVALID' })
        await expect(queue.enqueue(jobInput({
            id: 'job:binding-extra',
            idempotencyKey: 'idempotency:binding-extra',
            snapshot: {
                ...withResource,
                providerExecutionEnvelope: {
                    ...base.providerExecutionEnvelope!,
                    queueResourceBindings: [{
                        resourceId: resource.resourceId,
                        role: resource.role,
                        digest: resource.digest,
                        unexpected: 'extra-binding-field',
                    }],
                },
            } as GenerationJobSnapshot,
        }))).rejects.toMatchObject({ code: 'E_QUEUE_RECORD_INVALID' })
        expect((await queue.listJobs({ batchId: 'batch:1' })).items).toEqual([])
    })

    it('supports the maximum job identifier length when deriving and parsing attempt identity', async () => {
        const factory = new IDBFactory()
        const queue = repository(factory, databaseName('provider-attempt-long-id'))
        const jobId = 'j'.repeat(256)
        await queue.createBatch({ id: 'batch:1', workflow: 'main', createdAt: NOW })
        await queue.enqueue(jobInput({ id: jobId, idempotencyKey: 'idempotency:long', snapshot: providerSnapshot() }))
        const lease = await queue.acquireLease({ jobId, owner: 'worker:provider', now: NOW, ttlMs: 5_000 })
        await queue.transitionJob({
            jobId, to: 'running', now: NOW,
            leaseOwner: 'worker:provider', leaseToken: lease?.leaseToken ?? '',
        })

        expect(await queue.listAttempts(jobId)).toEqual([
            expect.objectContaining({ id: `${jobId}:1`, jobId, attemptNumber: 1 }),
        ])
    })

    it('rejects persisted Provider transition times before attempt start or earlier journal entries', async () => {
        const factory = new IDBFactory()
        const name = databaseName('provider-attempt-time-order')
        const queue = repository(factory, name)
        await queue.createBatch({ id: 'batch:1', workflow: 'main', createdAt: NOW })
        await queue.enqueue(jobInput({ snapshot: providerSnapshot() }))
        const lease = await queue.acquireLease({ jobId: 'job:1', owner: 'worker:provider', now: NOW, ttlMs: 60_000 })
        await queue.transitionJob({
            jobId: 'job:1', to: 'running', now: NOW,
            leaseOwner: 'worker:provider', leaseToken: lease?.leaseToken ?? '',
        })
        const prepared = {
            dispatchState: 'prepared' as const,
            providerOutcome: 'running' as const,
            billingRisk: 'none' as const,
            responseDigest: null,
            spoolReceipt: null,
        }
        const possiblyDispatched = {
            dispatchState: 'possibly-dispatched' as const,
            providerOutcome: 'running' as const,
            billingRisk: 'possible' as const,
            responseDigest: null,
            spoolReceipt: null,
        }
        const responseStarted = { ...possiblyDispatched, dispatchState: 'response-started' as const }
        await queue.recordProviderAttemptTransition({
            jobId: 'job:1', attemptNumber: 1,
            leaseOwner: 'worker:provider', leaseToken: lease?.leaseToken ?? '', now: LATER,
            expectedEvidence: prepared, nextEvidence: possiblyDispatched,
        })
        await queue.recordProviderAttemptTransition({
            jobId: 'job:1', attemptNumber: 1,
            leaseOwner: 'worker:provider', leaseToken: lease?.leaseToken ?? '',
            now: '2026-07-14T04:00:03.000Z',
            expectedEvidence: possiblyDispatched, nextEvidence: responseStarted,
        })

        await updateRawAttempt(factory, name, attempt => {
            const transitions = attempt.providerTransitions as Record<string, unknown>[]
            return {
                ...attempt,
                providerTransitions: [
                    { ...transitions[0], occurredAt: '2026-07-14T03:59:59.000Z' },
                    transitions[1],
                ],
            }
        })
        await expect(queue.listAttempts('job:1')).rejects.toMatchObject({ code: 'E_QUEUE_RECORD_INVALID' })

        await updateRawAttempt(factory, name, attempt => {
            const transitions = attempt.providerTransitions as Record<string, unknown>[]
            return {
                ...attempt,
                providerTransitions: [
                    { ...transitions[0], occurredAt: LATER },
                    { ...transitions[1], occurredAt: NOW },
                ],
            }
        })
        await expect(queue.listAttempts('job:1')).rejects.toMatchObject({ code: 'E_QUEUE_RECORD_INVALID' })
    })

    it('upgrades a v1 denormalized lease without losing the job', async () => {
        const factory = new IDBFactory()
        const name = databaseName('upgrade')
        const fixedSnapshot = snapshot()
        await createV1Database(factory, name, {
            recordSchemaVersion: 1,
            id: 'job:1',
            batchId: 'batch:1',
            workflow: 'main',
            sceneId: null,
            state: 'running',
            createdAt: NOW,
            updatedAt: NOW,
            priority: 0,
            ordinal: 0,
            snapshotSchemaVersion: fixedSnapshot.schemaVersion,
            snapshot: fixedSnapshot,
            snapshotHash: hashGenerationJobSnapshot(fixedSnapshot),
            compositionPlanHash: null,
            attemptCount: 1,
            maxAttempts: 3,
            idempotencyKey: 'idempotency:1',
            leaseOwner: 'worker:legacy',
            leaseExpiresAt: LATER,
            heartbeatAt: NOW,
            progress: { stage: 'request', current: 1, total: 3 },
            lastDiagnosticEventId: null,
            outputTransactionId: null,
            artifactReference: null,
            blockReason: null,
            version: 3,
        })

        const queue = repository(factory, name)
        await queue.initialize()
        expect(await queue.getJob('job:1')).toMatchObject({
            state: 'running',
            leaseOwner: 'worker:legacy',
            attemptCount: 1,
        })
        expect((await queue.inspectSchema()).stores).toContain('resources')
    })

    it('aborts a malformed schema upgrade and preserves the v1 record', async () => {
        const factory = new IDBFactory()
        const name = databaseName('abort')
        await createV1Database(factory, name, { id: 'job:1', malformed: true })
        const queue = repository(factory, name)

        await expect(queue.initialize()).rejects.toMatchObject({
            name: 'QueueRepositoryError',
            code: 'E_QUEUE_TRANSACTION_ABORTED',
        } satisfies Partial<QueueRepositoryError>)
        expect(await readRawJob(factory, name, 1)).toEqual({ id: 'job:1', malformed: true })
    })
})
