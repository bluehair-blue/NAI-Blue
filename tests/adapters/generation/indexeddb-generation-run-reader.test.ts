import { describe, expect, it, vi } from 'vitest'

import {
    IndexedDbGenerationRunReader,
    type GenerationRunAuthorityReaders,
} from '@/adapters/generation/indexeddb-generation-run-reader'
import { getGenerationRun } from '@/application/generation/get-generation-run'
import type { GenerationBatch, GenerationJob } from '@/domain/queue/types'
import type { GenerationAttempt, OutputReservation } from '@/domain/queue/types'
import type { PendingQueueOutputTransaction } from '@/services/output/output-writer'
import type { R2ProfileV2, UploadJob } from '@/domain/r2/types'

const observedAt = '2026-09-03T00:00:00.000Z'
const commitSetHash = `sha256:${'c'.repeat(64)}` as const
const directoryIdentity = `sha256:${'e'.repeat(64)}` as const

function batch(): GenerationBatch {
    return {
        id: 'batch-1',
        workflow: 'main',
        queueSequence: 1,
        createdAt: observedAt,
        updatedAt: observedAt,
        state: 'active',
        failurePolicy: 'continue',
        pauseReason: null,
        origin: 'fresh',
        idempotencyKey: 'batch-1',
        version: 1,
        projectionRevision: 1,
        projectionSummary: {
            batchId: 'batch-1',
            total: 1,
            completed: 1,
            progressCurrent: 1,
            progressTotal: 1,
            states: {
                queued: 0, leased: 0, running: 0, succeeded: 1, failed: 0,
                cancelled: 0, skipped: 0, blocked: 0, recovering: 0,
            },
            recentCompletedAt: [observedAt],
        },
    }
}

function job(overrides: Partial<GenerationJob> = {}): GenerationJob {
    return {
        id: 'job-1',
        batchId: 'batch-1',
        workflow: 'main',
        sceneId: null,
        state: 'succeeded',
        createdAt: observedAt,
        updatedAt: observedAt,
        priority: 0,
        ordinal: 0,
        snapshotSchemaVersion: 1,
        snapshot: {
            schemaVersion: 1,
            prompt: { positive: 'private prompt', negative: '' },
            parameters: {
                mainWorkflow: { output: { autoR2UploadProfileId: null } },
            },
            outputPolicy: {},
            resources: [],
            resumability: 'resumable',
        },
        snapshotHash: 'sha256:snapshot-private',
        compositionPlanHash: null,
        attemptCount: 1,
        maxAttempts: 3,
        idempotencyKey: 'job-1',
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        progress: { stage: 'done', current: 1, total: 1 },
        lastDiagnosticEventId: null,
        outputTransactionId: 'transaction-1',
        artifactReference: {
            kind: 'output-writer', artifactId: 'artifact:job-1', digest: 'sha256:private',
        },
        blockReason: null,
        readyAt: observedAt,
        cancelRequestedAt: null,
        cancelReason: null,
        retryOfJobId: null,
        rootJobId: 'job-1',
        version: 1,
        ...overrides,
    }
}

function authorities(
    queueJob: GenerationJob,
    options: {
        readonly r2Jobs?: readonly UploadJob[]
        readonly manifestMatches?: boolean
        readonly publicMode?: R2ProfileV2['publicMode']
        readonly sceneLinked?: boolean
        readonly artifactCommitSetHash?: `sha256:${string}` | null
        readonly reservation?: OutputReservation | null
        readonly attempts?: readonly GenerationAttempt[]
        readonly pendingTransactions?: readonly PendingQueueOutputTransaction[]
        readonly journalReject?: boolean
        readonly attemptsReject?: boolean
    } = {},
): GenerationRunAuthorityReaders {
    return {
        queue: {
            getBatch: vi.fn(async () => batch()),
            listJobs: vi.fn(async () => ({ items: [queueJob], nextCursor: null })),
            getOutputReservation: vi.fn(async () => options.reservation ?? null),
            listAttempts: vi.fn(async () => {
                if (options.attemptsReject) throw new Error('attempts unavailable')
                return [...(options.attempts ?? [])]
            }),
        },
        output: { inspectPendingQueueTransactions: vi.fn(async () => {
            if (options.journalReject) throw new Error('journal unavailable')
            return [...(options.pendingTransactions ?? [])]
        }) },
        artifacts: {
            get: vi.fn(async () => ({
                artifactId: 'artifact:job-1',
                sourceJobId: 'job-1',
                ...(options.artifactCommitSetHash === undefined
                    ? {}
                    : { outputCommitSetHash: options.artifactCommitSetHash }),
                updatedAt: observedAt,
            }) as never),
        },
        r2: {
            listJobs: vi.fn(async () => [...(options.r2Jobs ?? [])]),
            getProfile: vi.fn(async profileId => ({
                id: profileId,
                publicMode: options.publicMode,
            }) as R2ProfileV2),
            getManifest: vi.fn(async profile => ({
                schemaVersion: 2,
                profileId: profile.id,
                bucket: 'bucket',
                prefix: '',
                updatedAt: observedAt,
                items: options.manifestMatches && options.r2Jobs?.[0]
                    ? [{
                        profileId: options.r2Jobs[0].profileId,
                        artifactId: options.r2Jobs[0].artifactId,
                        localVariant: options.r2Jobs[0].localVariant,
                        remoteKey: options.r2Jobs[0].remoteKey,
                        contentSha256: options.r2Jobs[0].contentSha256,
                        size: options.r2Jobs[0].size,
                        completedAt: observedAt,
                    }]
                    : [],
            })),
        },
        ...(options.sceneLinked === undefined
            ? {}
            : {
                    scenes: {
                        getDocument: vi.fn(async () => ({
                            presetId: 'preset-1',
                            revision: 1,
                            scenes: [{
                                id: 'scene-1',
                                artifactRefs: options.sceneLinked
                                    ? [{ artifactId: 'artifact:job-1', createdAt: observedAt, favorite: false }]
                                    : [],
                            }],
                        }) as never),
                    },
                }),
    }
}

function upload(state: UploadJob['state']): UploadJob {
    return {
        id: 'upload-1',
        profileId: 'generated-profile-1',
        artifactId: 'job-1:release-image',
        localVariant: 'private-path',
        remoteKey: 'private/key.webp',
        contentSha256: 'sha256:private',
        contentType: 'image/webp',
        size: 100,
        state,
        attempt: 1,
        maxAttempts: 3,
        nextAttemptAt: observedAt,
        multipart: { uploadId: null, completedParts: [], partSize: 1 },
        diagnosticEventId: null,
        createdAt: observedAt,
        updatedAt: observedAt,
        version: 1,
    }
}

function reservedJob(overrides: Partial<GenerationJob> = {}): { queueJob: GenerationJob; reservation: OutputReservation } {
    const snapshot = {
        reservationSchemaVersion: 0 as const,
        reservationId: 'reservation:1',
        folderBinding: {
            resourceType: 'generation-folder-document' as const,
            resourceId: 'folder:1', revision: 1, contentHash: commitSetHash,
        },
        directoryIdentity,
        relativePath: 'image.png',
        collisionPolicy: 'fail' as const,
        expectedExistingDigest: null,
    }
    return {
        queueJob: job({
            state: 'failed', outputTransactionId: null, artifactReference: null,
            snapshot: { ...job().snapshot, outputReservation: snapshot },
            ...overrides,
        }),
        reservation: { ...snapshot, batchId: 'batch-1', jobId: 'job-1', state: 'conflict' },
    }
}

function providerAttempt(dispatchState: 'possibly-dispatched' | 'result-spooled'): GenerationAttempt {
    return {
        recordSchemaVersion: 2, id: 'job-1:1', jobId: 'job-1', attemptNumber: 1,
        startedAt: observedAt, finishedAt: null, outcome: 'running', diagnosticEventId: null,
        providerEvidence: {
            dispatchState,
            providerOutcome: dispatchState === 'possibly-dispatched' ? 'unknown' : 'succeeded',
            billingRisk: dispatchState === 'possibly-dispatched' ? 'possible' : 'confirmed',
            responseDigest: dispatchState === 'result-spooled' ? commitSetHash : null,
            spoolReceipt: dispatchState === 'result-spooled' ? {
                schemaVersion: 1, spoolId: 'spool:1', attemptId: 'job-1:1', contentType: 'image/png',
                byteLength: 4, sha256: commitSetHash, committedAt: observedAt,
            } : null,
        },
        providerTransitions: [], executionEnvelopeHash: null,
    }
}

describe('IndexedDbGenerationRunReader', () => {
    it('joins a Queue output commit with its ArtifactRecord without leaking source payloads', async () => {
        const result = await getGenerationRun(new IndexedDbGenerationRunReader(authorities(job())), 'batch-1')

        expect(result?.overall).toBe('delivered')
        expect(result?.interpretation.state).toBe('succeeded')
        expect(result?.provider.evidence[0]?.kind).toBe('derived')
        expect(result?.storage.evidence[0]?.source).toBe('artifact-record')
        expect(JSON.stringify(result)).not.toContain('private prompt')
        expect(JSON.stringify(result)).not.toContain('private-path')
        expect(JSON.stringify(result)).not.toContain('private/key.webp')
        expect(JSON.stringify(result)).not.toContain('sha256:private')
    })

    it('uses Artifact evidence for current reservations only when the commit-set hash matches', async () => {
        const queueJob = job({
            snapshot: {
                ...job().snapshot,
                outputReservation: {
                    reservationSchemaVersion: 1,
                    commitSetHash,
                },
            },
        } as Partial<GenerationJob>)
        const matched = await getGenerationRun(new IndexedDbGenerationRunReader(authorities(
            queueJob, { artifactCommitSetHash: commitSetHash },
        )), 'batch-1')
        const missing = await getGenerationRun(new IndexedDbGenerationRunReader(authorities(
            queueJob, { artifactCommitSetHash: null },
        )), 'batch-1')
        const mismatched = await getGenerationRun(new IndexedDbGenerationRunReader(authorities(
            queueJob, { artifactCommitSetHash: `sha256:${'d'.repeat(64)}` },
        )), 'batch-1')

        expect(matched?.storage.evidence[0]?.source).toBe('artifact-record')
        expect(missing?.storage.evidence[0]?.source).toBe('queue-output-commit')
        expect(mismatched?.storage.evidence[0]?.source).toBe('queue-output-commit')
    })

    it('keeps a failed best-effort R2 job visible as partial fulfillment', async () => {
        const queueJob = job({
            snapshot: {
                ...job().snapshot,
                parameters: {
                    mainWorkflow: {
                        metadataMode: 'strip-and-sidecar',
                        output: { autoR2UploadProfileId: 'profile-1' },
                    },
                },
            },
        })
        const result = await getGenerationRun(
            new IndexedDbGenerationRunReader(authorities(queueJob, { r2Jobs: [upload('failed')] })),
            'batch-1',
        )

        expect(result?.release.state).toBe('failed')
        expect(result?.overall).toBe('partial')
    })

    it('projects a Scene-link issue without changing successful local storage', async () => {
        const sceneJob = job({
            workflow: 'scene',
            sceneId: 'scene-1',
            snapshot: {
                ...job().snapshot,
                parameters: {
                    sceneWorkflow: { saveContext: { activePresetId: 'preset-1' } },
                },
            },
        })
        const result = await getGenerationRun(
            new IndexedDbGenerationRunReader(authorities(sceneJob, { sceneLinked: false })),
            'batch-1',
        )

        expect(result?.storage.state).toBe('succeeded')
        expect(result?.issues).toEqual([expect.objectContaining({
            code: 'SCENE_LINK_PENDING',
            jobId: 'job-1',
            action: { kind: 'retry-scene-link', requiresHuman: false },
        })])
        expect(result?.overall).toBe('partial')
    })

    it('requires the R2 manifest before treating a succeeded upload job as released', async () => {
        const queueJob = job({
            snapshot: {
                ...job().snapshot,
                parameters: {
                    mainWorkflow: {
                        metadataMode: 'strip-and-sidecar',
                        output: { autoR2UploadProfileId: 'profile-1' },
                    },
                },
            },
        })
        const projection = await getGenerationRun(
            new IndexedDbGenerationRunReader(authorities(queueJob, { r2Jobs: [upload('succeeded')] })),
            'batch-1',
        )
        const verified = await getGenerationRun(new IndexedDbGenerationRunReader(authorities(queueJob, {
            r2Jobs: [upload('succeeded')],
            manifestMatches: true,
        })), 'batch-1')

        expect(projection?.release.state).toBe('uncertain')
        expect(projection?.overall).toBe('partial')
        expect(verified?.release.state).toBe('succeeded')
        expect(verified?.overall).toBe('delivered')
    })

    it('does not call a private release complete when its required sidecar job is absent', async () => {
        const queueJob = job({
            snapshot: {
                ...job().snapshot,
                parameters: {
                    mainWorkflow: {
                        metadataMode: 'strip-and-sidecar',
                        output: { autoR2UploadProfileId: 'profile-1' },
                    },
                },
            },
        })
        const result = await getGenerationRun(new IndexedDbGenerationRunReader(authorities(queueJob, {
            r2Jobs: [upload('succeeded')],
            manifestMatches: true,
            publicMode: 'private',
        })), 'batch-1')

        expect(result?.release.state).toBe('uncertain')
        expect(result?.overall).toBe('partial')
    })

    it('reports a failed attempted job as an uncertain Provider outcome', async () => {
        const failed = job({
            state: 'failed',
            outputTransactionId: null,
            artifactReference: null,
        })
        const result = await getGenerationRun(new IndexedDbGenerationRunReader(authorities(failed)), 'batch-1')

        expect(result?.provider.state).toBe('uncertain')
        expect(result?.storage.state).toBe('unavailable')
        expect(result?.overall).toBe('needs-attention')
    })

    it('emits storage recovery only for an exact files-committed journal', async () => {
        const current = job({
            state: 'running', outputTransactionId: 'transaction-1',
            artifactReference: { kind: 'output-writer', artifactId: 'artifact:job-1', digest: commitSetHash },
        })
        const result = await getGenerationRun(new IndexedDbGenerationRunReader(authorities(current, {
            pendingTransactions: [{ transactionId: 'transaction-1', sourceJobId: current.id, phase: 'files-committed' }],
        })), 'batch-1')
        const stale = await getGenerationRun(new IndexedDbGenerationRunReader(authorities(current, {
            pendingTransactions: [{ transactionId: 'transaction:stale', sourceJobId: current.id, phase: 'files-committed' }],
        })), 'batch-1')

        expect(result?.issues).toContainEqual(expect.objectContaining({ action: { kind: 'retry-storage', requiresHuman: false } }))
        expect(stale?.issues).toHaveLength(0)
    })

    it('projects conflict, Provider-unknown, and spooled-result actions from current durable evidence', async () => {
        const { queueJob, reservation } = reservedJob()
        const conflict = await getGenerationRun(new IndexedDbGenerationRunReader(authorities(queueJob, { reservation })), 'batch-1')
        const unknown = await getGenerationRun(new IndexedDbGenerationRunReader(authorities(queueJob, {
            reservation, attempts: [providerAttempt('possibly-dispatched')],
        })), 'batch-1')
        const spooled = await getGenerationRun(new IndexedDbGenerationRunReader(authorities(queueJob, {
            reservation, attempts: [providerAttempt('result-spooled')],
        })), 'batch-1')

        expect(conflict?.issues[0]?.action.kind).toBe('abandon-reservation')
        expect(unknown?.issues[0]?.action.kind).toBe('review-provider-unknown')
        expect(spooled?.issues[0]?.action.kind).toBe('discard-result-and-abandon-reservation')
        expect(spooled?.provider.state).toBe('succeeded')
    })

    it('does not invent directory authorization from a generic local-io failure', async () => {
        const failed = job({ state: 'failed', outputTransactionId: null, artifactReference: null })
        const result = await getGenerationRun(new IndexedDbGenerationRunReader(authorities(failed)), 'batch-1')

        expect(result?.issues.filter(issue => issue.code === 'DIRECTORY_AUTHORIZATION_REQUIRED')).toHaveLength(0)
        expect(JSON.stringify(result)).not.toMatch(/[A-Z]:\\|\/Users\//)
    })

    it('makes files-committed exclusive even when the current attempt is spooled', async () => {
        const { queueJob, reservation } = reservedJob({
            state: 'failed', outputTransactionId: 'transaction-1',
            artifactReference: { kind: 'output-writer', artifactId: 'artifact:job-1', digest: commitSetHash },
        })
        const result = await getGenerationRun(new IndexedDbGenerationRunReader(authorities(queueJob, {
            reservation,
            attempts: [providerAttempt('result-spooled')],
            pendingTransactions: [{
                transactionId: 'transaction-1', sourceJobId: queueJob.id, phase: 'files-committed',
                outputReservation: {
                    reservationId: reservation.reservationId,
                    directoryIdentity: reservation.directoryIdentity,
                    relativePath: reservation.relativePath,
                },
            }],
        })), 'batch-1')

        expect(result?.issues.map(issue => issue.action.kind)).toEqual(['retry-storage'])
    })

    it('fails destructive projections closed when journal or attempt evidence is unavailable', async () => {
        const { queueJob, reservation } = reservedJob()
        const journalMissing = await getGenerationRun(new IndexedDbGenerationRunReader(authorities(queueJob, {
            reservation, attempts: [providerAttempt('result-spooled')], journalReject: true,
        })), 'batch-1')
        const attemptsMissing = await getGenerationRun(new IndexedDbGenerationRunReader(authorities(queueJob, {
            reservation, attemptsReject: true,
        })), 'batch-1')

        expect(journalMissing?.issues).toHaveLength(0)
        expect(attemptsMissing?.issues).toHaveLength(0)
    })

    it('never offers destructive recovery for committed, abandoned, or already-bound output', async () => {
        const { queueJob, reservation } = reservedJob()
        for (const state of ['committed', 'abandoned'] as const) {
            const result = await getGenerationRun(new IndexedDbGenerationRunReader(authorities(queueJob, {
                reservation: { ...reservation, state }, attempts: [providerAttempt('result-spooled')],
            })), 'batch-1')
            expect(result?.issues).toHaveLength(0)
        }
        const bound = { ...queueJob, outputTransactionId: 'txn:bound' }
        const result = await getGenerationRun(new IndexedDbGenerationRunReader(authorities(bound, {
            reservation, attempts: [providerAttempt('result-spooled')],
        })), 'batch-1')
        expect(result?.issues).toHaveLength(0)
    })
})
