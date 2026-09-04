import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'

import { createArtifactRecord, type ArtifactRecord } from '@/domain/organizer/types'
import type { OutputReservation, QueueArtifactReference } from '@/domain/queue/types'
import type { OutputWriteResult, OutputWriter } from '@/services/output/output-writer'
import { createGenerationOutputCommitSet } from '@/services/output/generation-output-commit-set'
import {
    IndexedDBQueueRepository,
    type EnqueueGenerationJobInput,
} from '@/services/queue/indexeddb-queue-repository'
import { bindOutputReservationSnapshot, createGenerationJobSnapshot } from '@/services/queue/job-snapshot'
import type { QueueArtifactRepository } from '@/services/queue/queue-artifact-lineage'
import { recoverQueueLinkedOutputs, retryQueueLinkedOutput } from '@/services/queue/queue-output-recovery'

const NOW = '2026-07-14T09:00:00.000Z'
const LATER = '2026-07-14T09:01:00.000Z'
const CHECKSUM = `sha256:${'a'.repeat(64)}`

function queue(): IndexedDBQueueRepository {
    const factory = new IDBFactory()
    return new IndexedDBQueueRepository({
        factory: factory as unknown as globalThis.IDBFactory,
        keyRange: IDBKeyRange as unknown as typeof globalThis.IDBKeyRange,
        databaseName: 'queue-output-recovery',
        generationLimits: {
            maxJobsPerAtomicBatch: 100,
            maxOutputClaimsPerAtomicBatch: 400,
            measuredAt: '2026-09-04T07:06:52.993Z',
            evidenceId: 'benchmark:queue:edge:webview2-152.0.4191.62@d1118542+b44519c5#docs/releases/evidence/queue-edge-benchmark.json',
        },
    })
}

function job(): EnqueueGenerationJobInput {
    return {
        id: 'job:1', batchId: 'batch:1', workflow: 'main', sceneId: null,
        createdAt: NOW, priority: 0, ordinal: 0, compositionPlanHash: null,
        maxAttempts: 3, idempotencyKey: 'job-key:1',
        snapshot: createGenerationJobSnapshot({
            prompt: { positive: 'fixed', negative: '' },
            parameters: {}, outputPolicy: {}, resources: [], resumability: 'resumable',
        }),
    }
}

function reservation(): OutputReservation {
    return {
        reservationId: 'reservation:1', batchId: 'batch:1', jobId: 'job:1',
        folderBinding: {
            resourceType: 'generation-folder-document', resourceId: 'folder:1', revision: 1,
            contentHash: `sha256:${'b'.repeat(64)}`,
        },
        directoryIdentity: `sha256:${'c'.repeat(64)}`,
        relativePath: 'queue-output.png', collisionPolicy: 'fail',
        expectedExistingDigest: null, state: 'storage-pending',
    }
}

function reservedJob(): EnqueueGenerationJobInput {
    const value = reservation()
    const base = job()
    const { batchId: _batchId, jobId: _jobId, state: _state, ...snapshotReservation } = value
    return {
        ...base,
        snapshot: bindOutputReservationSnapshot(base.snapshot, snapshotReservation),
    }
}

function currentReservation(): OutputReservation {
    const legacy = reservation()
    const { commitSet, commitSetHash } = createGenerationOutputCommitSet({
        directoryAuthorityId: 'folder:1',
        directoryAuthorityFingerprint: legacy.directoryIdentity,
        filesystemSemantics: 'windows',
        fileName: legacy.relativePath,
        imageFormat: 'png',
        metadataMode: undefined,
        preserveProviderOriginal: false,
    })
    return {
        ...legacy,
        state: 'reserved',
        reservationSchemaVersion: 1,
        commitSet,
        commitSetHash,
        version: 1,
        updatedAt: NOW,
    }
}

function currentReservedJob(): EnqueueGenerationJobInput {
    const value = currentReservation()
    const base = job()
    const { batchId: _batchId, jobId: _jobId, state: _state, version: _version, updatedAt: _updatedAt, ...snapshot } = value
    return { ...base, snapshot: bindOutputReservationSnapshot(base.snapshot, snapshot) }
}

function recoveredOutput(): OutputWriteResult {
    return {
        transactionId: 'txn-bound',
        fileName: 'queue-output.png',
        path: 'C:/Pictures/NAI_Blue_Output/queue-output.png',
        file: { path: 'NAI_Blue_Output/queue-output.png', displayPath: 'C:/Pictures/NAI_Blue_Output/queue-output.png' },
        directory: { path: 'NAI_Blue_Output', displayPath: 'C:/Pictures/NAI_Blue_Output', capabilityFallbackUsed: false },
        capabilityFallbackUsed: false,
        finalImage: {
            contentChecksum: CHECKSUM,
            byteSize: 222,
            portableDirectory: { kind: 'standard', root: 'pictures', segments: ['NAI_Blue_Output'] },
        },
    }
}

function artifactRepository() {
    const records = new Map<string, ArtifactRecord>()
    const value: QueueArtifactRepository = {
        get: async artifactId => records.get(artifactId) ?? null,
        putOriginal: async input => {
            const record = createArtifactRecord(input)
            records.set(record.artifactId, record)
            return record
        },
        removeOriginalIfUnmodified: async input => records.delete(input.artifactId),
    }
    return { value, records }
}

describe('queue-linked OutputWriter recovery', () => {
    it('retries workflow commit from a pre-bound files-committed journal before lease recovery', async () => {
        const repository = queue()
        const artifacts = artifactRepository()
        await repository.createBatchAndEnqueue({
            batch: {
                id: 'batch:1', workflow: 'main', createdAt: NOW,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch-key:1',
            },
            jobs: [job()],
        })
        const lease = await repository.acquireLease({ jobId: 'job:1', owner: 'worker:1', now: NOW, ttlMs: 1_000 })
        await repository.transitionJob({
            jobId: 'job:1', to: 'running', now: NOW,
            leaseOwner: 'worker:1', leaseToken: lease?.leaseToken ?? '',
        })
        const artifact: QueueArtifactReference = {
            kind: 'output-writer', artifactId: 'artifact:1', digest: 'sha256:artifact', mimeType: 'image/png',
        }
        await repository.bindOutputTransaction({
            jobId: 'job:1', leaseOwner: 'worker:1', leaseToken: lease?.leaseToken ?? '', now: NOW,
            outputTransactionId: 'txn-bound', artifactReference: artifact,
        })

        const retryFilesCommittedWorkflow = vi.fn(async (
            _transactionId: string,
            _expectedSourceJobId: string,
            commitWorkflow: Parameters<OutputWriter['retryFilesCommittedWorkflow']>[2],
        ) => {
            await commitWorkflow(recoveredOutput())
            return { transactionId: 'txn-bound', action: 'retried' as const }
        })
        const writer = {
            inspectPendingQueueTransactions: async () => [{
                transactionId: 'txn-bound', sourceJobId: 'job:1', phase: 'files-committed' as const,
            }],
            retryFilesCommittedWorkflow,
        } as unknown as OutputWriter

        const result = await recoverQueueLinkedOutputs(repository, writer, {
            now: LATER,
            artifactRepository: artifacts.value,
        })

        expect(result).toEqual([{ transactionId: 'txn-bound', action: 'retried' }])
        expect(retryFilesCommittedWorkflow).toHaveBeenCalledWith(
            'txn-bound',
            'job:1',
            expect.any(Function),
        )
        expect(await repository.getJob('job:1')).toMatchObject({
            state: 'succeeded',
            outputTransactionId: 'txn-bound',
            artifactReference: artifact,
            leaseOwner: null,
        })
        expect(artifacts.records.get('artifact:1')).toMatchObject({
            sourceJobId: 'job:1',
            sourceSceneId: null,
            contentChecksum: CHECKSUM,
            original: { file: { fileName: 'queue-output.png' }, size: 222 },
        })
    })

    it('compensates only the artifact created by a targeted retry when Queue commit fails', async () => {
        const repository = queue()
        const artifacts = artifactRepository()
        await repository.createBatchAndEnqueue({
            batch: {
                id: 'batch:1', workflow: 'main', createdAt: NOW,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch-key:1',
            },
            jobs: [job()],
        })
        const lease = await repository.acquireLease({ jobId: 'job:1', owner: 'worker:1', now: NOW, ttlMs: 1_000 })
        await repository.transitionJob({
            jobId: 'job:1', to: 'running', now: NOW,
            leaseOwner: 'worker:1', leaseToken: lease?.leaseToken ?? '',
        })
        const artifact: QueueArtifactReference = {
            kind: 'output-writer', artifactId: 'artifact:1', digest: 'sha256:artifact', mimeType: 'image/png',
        }
        await repository.bindOutputTransaction({
            jobId: 'job:1', leaseOwner: 'worker:1', leaseToken: lease?.leaseToken ?? '', now: NOW,
            outputTransactionId: 'txn-bound', artifactReference: artifact,
        })
        vi.spyOn(repository, 'recoverFilesCommittedSuccess').mockRejectedValueOnce(new Error('CAS changed'))
        const writer = {
            retryFilesCommittedWorkflow: async (
                _transactionId: string,
                _expectedSourceJobId: string,
                commitWorkflow: Parameters<OutputWriter['retryFilesCommittedWorkflow']>[2],
            ) => {
                try {
                    await commitWorkflow(recoveredOutput())
                    return { transactionId: 'txn-bound', action: 'retried' as const }
                } catch {
                    return { transactionId: 'txn-bound', action: 'failed' as const, error: 'Queue commit failed' }
                }
            },
        } as unknown as OutputWriter

        await expect(retryQueueLinkedOutput(repository, writer, {
            jobId: 'job:1',
            now: LATER,
            artifactRepository: artifacts.value,
        })).resolves.toEqual({ status: 'failed', message: 'Queue commit failed' })

        expect(artifacts.records.has('artifact:1')).toBe(false)
        expect(await repository.getJob('job:1')).toMatchObject({
            state: 'running',
            outputTransactionId: 'txn-bound',
            artifactReference: artifact,
        })
    })

    it('leaves a files-committed journal untouched when its reservation is not the Queue authority', async () => {
        const repository = queue()
        await repository.createBatchAndEnqueue({
            batch: {
                id: 'batch:1', workflow: 'main', createdAt: NOW,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch-key:1',
            },
            jobs: [reservedJob()],
            reservations: [reservation()],
        })
        const lease = await repository.acquireLease({ jobId: 'job:1', owner: 'worker:1', now: NOW, ttlMs: 1_000 })
        await repository.transitionJob({
            jobId: 'job:1', to: 'running', now: NOW,
            leaseOwner: 'worker:1', leaseToken: lease?.leaseToken ?? '',
        })
        await repository.transitionOutputReservation({
            reservationId: 'reservation:1', owner: reservation(),
            expectedState: 'storage-pending', state: 'writing',
        })
        const artifact: QueueArtifactReference = {
            kind: 'output-writer', artifactId: 'artifact:1', digest: 'sha256:artifact', mimeType: 'image/png',
        }
        await repository.bindOutputTransaction({
            jobId: 'job:1', leaseOwner: 'worker:1', leaseToken: lease?.leaseToken ?? '', now: NOW,
            outputTransactionId: 'txn-bound', artifactReference: artifact,
        })
        const retryFilesCommittedWorkflow = vi.fn()
        const writer = {
            inspectPendingQueueTransactions: async () => [{
                transactionId: 'txn-bound', sourceJobId: 'job:1', phase: 'files-committed' as const,
                outputReservation: {
                    reservationId: 'reservation:other',
                    directoryIdentity: reservation().directoryIdentity,
                    relativePath: reservation().relativePath,
                },
            }],
            retryFilesCommittedWorkflow,
        } as unknown as OutputWriter

        await expect(recoverQueueLinkedOutputs(repository, writer, { now: LATER })).resolves.toEqual([{
            transactionId: 'txn-bound', action: 'failed',
            error: 'Output journal reservation does not match Queue authority',
        }])
        expect(retryFilesCommittedWorkflow).not.toHaveBeenCalled()
        expect(await repository.getJob('job:1')).toMatchObject({ state: 'running' })
        expect(await repository.getOutputReservation('reservation:1')).toMatchObject({ state: 'writing' })
    })

    it('does not terminalize current reservation recovery when Artifact lineage is missing', async () => {
        const repository = queue()
        const current = currentReservation()
        await repository.createBatchAndEnqueue({
            batch: {
                id: 'batch:1', workflow: 'main', createdAt: NOW,
                failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'batch-key:1',
            },
            jobs: [currentReservedJob()],
            reservations: [current],
        })
        const lease = await repository.acquireLease({ jobId: 'job:1', owner: 'worker:1', now: NOW, ttlMs: 1_000 })
        await repository.transitionJob({
            jobId: 'job:1', to: 'running', now: NOW,
            leaseOwner: 'worker:1', leaseToken: lease?.leaseToken ?? '',
        })
        await repository.transitionOutputReservation({
            reservationId: current.reservationId,
            owner: current,
            expectedState: 'reserved',
            expectedVersion: current.version,
            state: 'writing',
        })
        const artifactReference: QueueArtifactReference = {
            kind: 'output-writer', artifactId: 'artifact:1', digest: 'sha256:artifact', mimeType: 'image/png',
        }
        await repository.bindOutputTransaction({
            jobId: 'job:1', leaseOwner: 'worker:1', leaseToken: lease?.leaseToken ?? '', now: NOW,
            outputTransactionId: 'txn-bound', artifactReference,
        })
        const writer = {
            retryFilesCommittedWorkflow: vi.fn(async (
                _transactionId: string,
                _sourceJobId: string,
                commitWorkflow: Parameters<OutputWriter['retryFilesCommittedWorkflow']>[2],
            ) => {
                try {
                    await commitWorkflow(recoveredOutput())
                    return { transactionId: 'txn-bound', action: 'retried' as const }
                } catch (error) {
                    return {
                        transactionId: 'txn-bound',
                        action: 'failed' as const,
                        error: error instanceof Error ? error.message : 'failed',
                    }
                }
            }),
        } as unknown as OutputWriter

        await expect(retryQueueLinkedOutput(repository, writer, {
            jobId: 'job:1', now: LATER, artifactRepository: artifactRepository().value,
        })).resolves.toMatchObject({ status: 'failed', message: expect.stringContaining('commit-set lineage differ') })
        expect(await repository.getJob('job:1')).toMatchObject({ state: 'running' })
        expect(await repository.getOutputReservation(current.reservationId)).toMatchObject({ state: 'writing' })
    })
})
