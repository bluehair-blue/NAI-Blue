import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MainBatchPlannerPort } from '@/application/generation/plan-main-batch'
import { createR2ProfileV2, hashR2ProfileV2, type R2DestinationProvenance } from '@/domain/r2/types'
import { createAnlasCostConsentSnapshot } from '@/domain/queue/anlas-cost-consent'
import type { PreparedMainGeneration } from '@/services/generation/main-generation-plan'
import { createGenerationOutputCommitSet } from '@/services/output/generation-output-commit-set'
import type { OutputCommitSetPlanningRequest } from '@/services/queue/main-queue-runtime-dependencies'

const runtime = vi.hoisted(() => ({
    begin: vi.fn(() => 'operation:1'),
    complete: vi.fn(),
    createBatchAndEnqueue: vi.fn(),
    dehydrate: vi.fn(async () => ({
        parameters: { generationParams: {}, resourceBindings: [], resourceArrayLengths: {} },
        records: [],
        resources: [],
    })),
    encode: vi.fn(() => ({
        snapshot: {
            schemaVersion: 1,
            prompt: { positive: '', negative: '' },
            parameters: {}, outputPolicy: {}, resources: [], resumability: 'resumable',
        },
        compositionPlanHash: null,
    })),
    currentFolderBinding: vi.fn(),
    authoritativeFolderBinding: vi.fn(),
    planBatch: vi.fn(),
    assertAtomic: vi.fn(),
    getR2Profile: vi.fn(),
    getR2Readiness: vi.fn(),
}))

vi.mock('@/platform/capabilities', () => ({
    runtimeCapabilities: {
        generationPublication: {
            supported: true,
            outputReservationGuarantee: 'atomic-no-replace',
            generationLimits: {
                maxJobsPerAtomicBatch: 100,
                maxOutputClaimsPerAtomicBatch: 400,
                measuredAt: '2026-09-04T07:06:52.993Z',
                evidenceId: 'benchmark:queue:edge:webview2-152.0.4191.62@d1118542+b44519c5#docs/releases/evidence/queue-edge-benchmark.json',
            },
        },
    },
}))

vi.mock('@/services/queue/main-queue-runtime-dependencies', () => ({
    getRuntimeMainQueueDependencies: () => ({
        planner: null,
        presentation: {
            beginEnqueueOperation: runtime.begin,
            completeEnqueueOperation: runtime.complete,
        },
        outputReservations: {
            getCurrentFolderBinding: runtime.currentFolderBinding,
            getAuthoritativeFolderBinding: runtime.authoritativeFolderBinding,
            planBatch: runtime.planBatch,
        },
        r2Planning: {
            getProfile: runtime.getR2Profile,
            getReadiness: runtime.getR2Readiness,
        },
    }),
}))

vi.mock('@/services/queue/indexeddb-queue-repository', () => ({
    getRuntimeQueueRepository: () => ({ createBatchAndEnqueue: runtime.createBatchAndEnqueue }),
    assertGenerationAtomicBatchAvailable: runtime.assertAtomic,
}))

vi.mock('@/services/queue/queue-resource-materializer', () => ({
    getRuntimeQueueResourceMaterializer: () => ({}),
    dehydrateGenerationParams: runtime.dehydrate,
}))

vi.mock('@/services/queue/main-job-snapshot-codec', () => ({
    encodeMainJobSnapshot: runtime.encode,
}))

import { enqueuePlannedMainBatch } from '@/services/queue/main-queue-adapter'

const prepared = {
    params: {
        model: 'nai-diffusion-4-5-full',
        width: 832,
        height: 1_216,
        steps: 28,
        seed: 7,
    },
    imageFormat: 'png',
    output: {
        directory: 'output', useAbsolutePath: false, capabilityFallbackDirectory: 'output',
        fileName: 'planned.png', collisionPolicy: 'error',
        r2Bucket: null, r2Prefix: null,
    },
} as PreparedMainGeneration

const folderBinding = {
    resourceType: 'generation-folder-document' as const,
    resourceId: 'local',
    revision: 3,
    contentHash: `sha256:${'a'.repeat(64)}` as const,
}

function planner(): MainBatchPlannerPort<PreparedMainGeneration> {
    return {
        getRequestedCount: () => 1,
        prepareBatch: async () => [prepared],
    }
}

function freeCostConsent() {
    return createAnlasCostConsentSnapshot({
        pricingBasis: 'all-active-opus',
        estimatedAnlas: 0,
        maxAnlas: 0,
        estimatedAt: '2026-08-08T12:00:00.000Z',
        approvedAt: '2026-08-08T12:00:01.000Z',
    })
}

describe('planned Main queue adapter', () => {
    it('reserves private sidecar and provider-original claims before enqueue from embedded input', async () => {
        const selected = createR2ProfileV2({
            id: 'private-profile', name: 'Private', accountId: 'account', jurisdiction: null, endpoint: null,
            bucket: 'private-bucket', prefix: '', credentialRef: 'credential-fixture',
            transport: 'native-s3', conflictPolicy: 'fail', publicMode: 'private', publicBaseUrl: null,
        }, '2026-09-05T00:00:00.000Z')
        runtime.getR2Profile.mockResolvedValue(selected)
        runtime.getR2Readiness.mockResolvedValue({ status: 'ready', credentialRef: selected.credentialRef })
        await enqueuePlannedMainBatch({
            planner: { getRequestedCount: () => 1, prepareBatch: async () => [{ ...prepared, metadataMode: 'embedded' }] },
            submissionPolicy: { kind: 'guided', costConsent: freeCostConsent() },
            r2Requirements: [{ mode: 'required', profileId: selected.id }],
        })
        expect(runtime.planBatch.mock.calls[0][0][0].claimPlan).toMatchObject({
            metadataMode: 'strip-and-sidecar', preserveProviderOriginal: true,
        })
        expect(runtime.encode.mock.calls[0][0]).toMatchObject({
            metadataMode: 'strip-and-sidecar', params: { metadataMode: 'strip-and-sidecar' },
        })
    })

    beforeEach(() => {
        vi.clearAllMocks()
        runtime.createBatchAndEnqueue.mockResolvedValue({ batch: {}, jobs: [] })
        runtime.currentFolderBinding.mockReturnValue(folderBinding)
        runtime.authoritativeFolderBinding.mockImplementation(async () => runtime.currentFolderBinding())
        runtime.planBatch.mockImplementation(async (requests: readonly OutputCommitSetPlanningRequest[]) => (
            requests.map(request => ({
                fileName: request.claimPlan.fileName,
                directoryIdentity: `sha256:${'b'.repeat(64)}`,
                ...createGenerationOutputCommitSet({
                    ...request.claimPlan,
                    directoryAuthorityId: request.directoryAuthorityId,
                    directoryAuthorityFingerprint: `sha256:${'b'.repeat(64)}`,
                }),
            }))
        ))
        runtime.getR2Profile.mockResolvedValue(null)
        runtime.getR2Readiness.mockResolvedValue({ status: 'not-ready', reason: 'credential' })
    })

    it('reuses the Main codec/materializer and assigns stable Guided identities', async () => {
        await enqueuePlannedMainBatch({
            planner: planner(),
            submissionPolicy: { kind: 'guided', costConsent: freeCostConsent() },
            idempotencyScope: 'guided:draft-1:revision-2',
        })

        expect(runtime.dehydrate).toHaveBeenCalledOnce()
        expect(runtime.encode).toHaveBeenCalledOnce()
        expect(runtime.createBatchAndEnqueue).toHaveBeenCalledWith(expect.objectContaining({
            batch: expect.objectContaining({
                id: 'main-batch-guided:draft-1:revision-2',
                idempotencyKey: 'main-enqueue-guided:draft-1:revision-2',
            }),
            jobs: [expect.objectContaining({
                id: 'main-job-guided:draft-1:revision-2-0',
                idempotencyKey: 'main-enqueue-guided:draft-1:revision-2-0',
            })],
        }))
        expect(runtime.complete).toHaveBeenCalledWith('operation:1')
    })

    it('always completes the presentation operation when planning fails', async () => {
        const failed: MainBatchPlannerPort<PreparedMainGeneration> = {
            getRequestedCount: () => 1,
            prepareBatch: async () => { throw new Error('planner failed') },
        }

        await expect(enqueuePlannedMainBatch({
            planner: failed,
            submissionPolicy: { kind: 'guided', costConsent: freeCostConsent() },
        })).rejects.toThrow('planner failed')
        expect(runtime.createBatchAndEnqueue).not.toHaveBeenCalled()
        expect(runtime.complete).toHaveBeenCalledWith('operation:1')
    })

    it('fails required R2 readiness before the atomic Queue reservation write', async () => {
        runtime.getR2Profile.mockResolvedValue({
            schemaVersion: 2, id: 'required-profile', name: 'Required', accountId: 'account',
            jurisdiction: null, endpoint: null, bucket: 'required-bucket', prefix: 'images',
            credentialRef: 'stronghold:r2', transport: 'native-s3', conflictPolicy: 'fail',
            publicMode: 'r2-dev', publicBaseUrl: null,
            createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
        })
        await expect(enqueuePlannedMainBatch({
            planner: planner(),
            submissionPolicy: { kind: 'guided', costConsent: freeCostConsent() },
            r2Requirements: [{ mode: 'required', profileId: 'required-profile' }],
        })).rejects.toThrow('required R2 profile and credential are not ready')

        expect(runtime.createBatchAndEnqueue).not.toHaveBeenCalled()
        expect(runtime.encode).not.toHaveBeenCalled()
    })

    it('binds the exact allocated key and immutable profile into the current Queue snapshot', async () => {
        const selected = {
            schemaVersion: 2 as const, id: 'profile-1', name: 'Selected', accountId: 'account',
            jurisdiction: null, endpoint: null, bucket: 'selected-bucket', prefix: 'images',
            credentialRef: 'stronghold:r2', transport: 'native-s3' as const, conflictPolicy: 'fail' as const,
            publicMode: 'r2-dev' as const, publicBaseUrl: null,
            createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
        }
        runtime.getR2Profile.mockResolvedValue(selected)
        runtime.getR2Readiness.mockResolvedValue({ status: 'ready', credentialRef: selected.credentialRef })
        const r2Prepared = {
            ...prepared,
            output: { ...prepared.output, autoR2UploadProfileId: selected.id },
        } as PreparedMainGeneration

        await enqueuePlannedMainBatch({
            planner: { getRequestedCount: () => 1, prepareBatch: async () => [r2Prepared] },
            submissionPolicy: { kind: 'guided', costConsent: freeCostConsent() },
        })

        expect(runtime.encode).toHaveBeenCalledWith(
            expect.objectContaining({ output: expect.objectContaining({ fileName: 'planned.png' }) }),
            expect.anything(), expect.anything(), undefined,
            expect.objectContaining({
                requirement: 'best-effort',
                planned: expect.objectContaining({
                    profile: selected,
                    destination: expect.objectContaining({ bucket: 'selected-bucket', key: 'images/planned.png' }),
                }),
            }),
        )
    })

    it.each([
        { bucket: 'folder-bucket', prefix: 'characters', bucketSource: 'folder', prefixSource: 'folder' },
        { bucket: 'ancestor-bucket', prefix: 'ancestor/child', bucketSource: 'ancestor', prefixSource: 'ancestor' },
        { bucket: 'selected-bucket', prefix: '', bucketSource: 'workspace', prefixSource: 'cleared' },
    ] as const)('preserves resolved Main Folder destination $bucket/$prefix and its provenance', async resolved => {
        const selected = createR2ProfileV2({
            id: 'profile-1', name: 'Selected', accountId: 'account', jurisdiction: null, endpoint: null,
            bucket: 'selected-bucket', prefix: 'base', credentialRef: 'credential-fixture',
            transport: 'native-s3', conflictPolicy: 'fail', publicMode: 'r2-dev', publicBaseUrl: null,
        }, '2026-09-05T00:00:00.000Z')
        const unchanged = structuredClone(selected)
        const provenance: R2DestinationProvenance = {
            profileId: 'generation-folder', bucket: resolved.bucketSource, prefix: resolved.prefixSource,
            key: 'planned-output', folder: { id: 'child', profileId: 'parent', bucket: 'parent', prefix: 'child' },
        }
        runtime.getR2Profile.mockResolvedValue(selected)
        runtime.getR2Readiness.mockResolvedValue({ status: 'ready', credentialRef: selected.credentialRef })
        const item = { ...prepared, output: {
            ...prepared.output, autoR2UploadProfileId: selected.id, generationFolderId: 'child',
            r2Bucket: resolved.bucket, r2Prefix: resolved.prefix, r2Provenance: provenance,
        } } as PreparedMainGeneration
        await enqueuePlannedMainBatch({
            planner: { getRequestedCount: () => 1, prepareBatch: async () => [item] },
            submissionPolicy: { kind: 'guided', costConsent: freeCostConsent() },
            r2Requirements: [{ mode: 'required', profileId: selected.id }],
        })
        const delivery = runtime.encode.mock.calls[0][4]
        expect(delivery).toMatchObject({ requirement: 'required', planned: {
            destination: {
                bucket: resolved.bucket, key: [resolved.prefix, 'planned.png'].filter(Boolean).join('/'), provenance,
                profileHash: hashR2ProfileV2({ ...selected, bucket: resolved.bucket, prefix: resolved.prefix }),
            },
            profile: { ...selected, bucket: resolved.bucket, prefix: resolved.prefix },
            sourceProfileHash: hashR2ProfileV2(selected),
        } })
        expect(selected).toEqual(unchanged)
        expect(runtime.createBatchAndEnqueue).toHaveBeenCalledOnce()
    })

    it('rejects a cleared Main Folder bucket before writing Queue reservations', async () => {
        runtime.getR2Profile.mockResolvedValue(createR2ProfileV2({
            id: 'profile-1', name: 'Selected', accountId: 'account', jurisdiction: null, endpoint: null,
            bucket: 'selected-bucket', prefix: 'base', credentialRef: 'credential-fixture',
            transport: 'native-s3', conflictPolicy: 'fail', publicMode: 'r2-dev', publicBaseUrl: null,
        }, '2026-09-05T00:00:00.000Z'))
        const item = { ...prepared, output: { ...prepared.output,
            autoR2UploadProfileId: 'profile-1', r2Bucket: null, r2Prefix: '',
            r2Provenance: { profileId: 'generation-folder', bucket: 'cleared', prefix: 'folder', key: 'planned-output' },
        } } as PreparedMainGeneration
        await expect(enqueuePlannedMainBatch({
            planner: { getRequestedCount: () => 1, prepareBatch: async () => [item] },
            submissionPolicy: { kind: 'guided', costConsent: freeCostConsent() },
        })).rejects.toThrow('bucket is cleared or invalid')
        expect(runtime.createBatchAndEnqueue).not.toHaveBeenCalled()
    })

    it('preflights and atomically binds the exact output reservation', async () => {
        await enqueuePlannedMainBatch({
            planner: planner(),
            submissionPolicy: { kind: 'guided', costConsent: freeCostConsent() },
            idempotencyScope: 'guided:reserved',
            folderBinding,
        })

        expect(runtime.planBatch).toHaveBeenCalledWith([expect.objectContaining({
            claimPlan: expect.objectContaining({ fileName: 'planned.png' }),
            collisionPolicy: 'fail',
            reservationIdentity: {
                reservationId: 'output-reservation:main-job-guided:reserved-0',
                batchId: 'main-batch-guided:reserved',
                jobId: 'main-job-guided:reserved-0',
            },
        })])
        expect(runtime.createBatchAndEnqueue).toHaveBeenCalledWith(expect.objectContaining({
            jobs: [expect.objectContaining({
                snapshot: expect.objectContaining({
                    outputReservation: expect.objectContaining({
                        relativePath: 'planned.png',
                        directoryIdentity: `sha256:${'b'.repeat(64)}`,
                    }),
                }),
            })],
            reservations: [expect.objectContaining({
                reservationSchemaVersion: 1,
                state: 'reserved',
                relativePath: 'planned.png',
                folderBinding,
                commitSet: expect.objectContaining({
                    claims: [expect.objectContaining({ kind: 'image', relativePath: 'planned.png' })],
                }),
            })],
        }))
    })

    it('rejects a Folder change that lands after materialization but before atomic enqueue', async () => {
        runtime.currentFolderBinding
            .mockReturnValueOnce(folderBinding)
            .mockReturnValueOnce({ ...folderBinding, revision: folderBinding.revision + 1 })

        await expect(enqueuePlannedMainBatch({
            planner: planner(),
            submissionPolicy: { kind: 'guided', costConsent: freeCostConsent() },
            idempotencyScope: 'guided:stale-folder',
            folderBinding,
        })).rejects.toThrow('Generation folder changed before Queue reservation')

        expect(runtime.planBatch).toHaveBeenCalledOnce()
        expect(runtime.authoritativeFolderBinding).toHaveBeenCalledWith(folderBinding.resourceId)
        expect(runtime.createBatchAndEnqueue).not.toHaveBeenCalled()
    })

    it('persists a verified Guided max-Anlas consent with the immutable snapshot', async () => {
        const costConsent = freeCostConsent()

        await enqueuePlannedMainBatch({
            planner: planner(),
            submissionPolicy: { kind: 'guided', costConsent },
        })

        expect(runtime.encode).toHaveBeenCalledWith(
            expect.objectContaining({
                output: expect.objectContaining({
                    fileName: 'planned.png',
                    collisionPolicy: 'error',
                    reservationCollisionPolicy: 'fail',
                }),
            }),
            expect.anything(),
            costConsent,
            undefined,
            { requirement: 'disabled', planned: null },
        )
        expect(runtime.createBatchAndEnqueue).toHaveBeenCalledOnce()
    })

    it('revalidates the paid production estimate before materializing resources', async () => {
        const costConsent = createAnlasCostConsentSnapshot({
            pricingBasis: 'paid',
            estimatedAnlas: 20,
            maxAnlas: 20,
            estimatedAt: '2026-08-08T12:00:00.000Z',
            approvedAt: '2026-08-08T12:00:01.000Z',
        })

        await enqueuePlannedMainBatch({
            planner: planner(),
            submissionPolicy: { kind: 'guided', costConsent },
        })

        expect(runtime.dehydrate).toHaveBeenCalledOnce()
        expect(runtime.encode).toHaveBeenCalledWith(
            expect.objectContaining({ output: expect.objectContaining({ fileName: 'planned.png' }) }),
            expect.anything(),
            costConsent,
            undefined,
            { requirement: 'disabled', planned: null },
        )
        expect(runtime.createBatchAndEnqueue).toHaveBeenCalledOnce()
    })

    it('prices queued jobs as separate one-sample NovelAI requests', async () => {
        const twoRequests: MainBatchPlannerPort<PreparedMainGeneration> = {
            getRequestedCount: () => 2,
            prepareBatch: async () => [
                prepared,
                { ...prepared, output: { ...prepared.output, fileName: 'planned-2.png' } },
            ],
        }
        await enqueuePlannedMainBatch({
            planner: twoRequests,
            submissionPolicy: { kind: 'guided', costConsent: freeCostConsent() },
        })

        expect(runtime.dehydrate).toHaveBeenCalledTimes(2)
        expect(runtime.planBatch).toHaveBeenCalledOnce()
        expect(runtime.planBatch.mock.calls[0][0]).toHaveLength(2)
        expect(runtime.createBatchAndEnqueue).toHaveBeenCalledOnce()
    })

    it('performs no output planning I/O when the runtime limit guard rejects the batch', async () => {
        runtime.assertAtomic.mockImplementationOnce(() => { throw new Error('limit exceeded') })

        await expect(enqueuePlannedMainBatch({
            planner: planner(),
            submissionPolicy: { kind: 'guided', costConsent: freeCostConsent() },
        })).rejects.toThrow('limit exceeded')

        expect(runtime.planBatch).not.toHaveBeenCalled()
        expect(runtime.createBatchAndEnqueue).not.toHaveBeenCalled()
    })

    it('rejects a non-canonical planner commit set before atomic enqueue', async () => {
        const selected = createGenerationOutputCommitSet({
            fileName: 'planned.png', imageFormat: 'png', metadataMode: undefined,
            preserveProviderOriginal: false,
            directoryAuthorityId: folderBinding.resourceId,
            directoryAuthorityFingerprint: `sha256:${'b'.repeat(64)}`,
        })
        runtime.planBatch.mockResolvedValueOnce([{
            fileName: 'planned.png',
            directoryIdentity: `sha256:${'b'.repeat(64)}`,
            ...selected,
            commitSet: { ...selected.commitSet, filesystemSemantics: 'linux' },
        }])

        await expect(enqueuePlannedMainBatch({
            planner: planner(),
            submissionPolicy: { kind: 'guided', costConsent: freeCostConsent() },
            folderBinding,
        })).rejects.toThrow('non-canonical')
        expect(runtime.createBatchAndEnqueue).not.toHaveBeenCalled()
    })

    it('rejects missing or stale Guided consent before resource materialization', async () => {
        await expect(enqueuePlannedMainBatch({
            planner: planner(),
            submissionPolicy: { kind: 'guided' } as never,
        })).rejects.toMatchObject({ code: 'E_ANLAS_CONSENT_REQUIRED' })

        const staleConsent = createAnlasCostConsentSnapshot({
            pricingBasis: 'paid',
            estimatedAnlas: 10,
            maxAnlas: 10,
            estimatedAt: '2026-08-08T12:00:00.000Z',
            approvedAt: '2026-08-08T12:00:01.000Z',
        })
        await expect(enqueuePlannedMainBatch({
            planner: planner(),
            submissionPolicy: { kind: 'guided', costConsent: staleConsent },
        })).rejects.toMatchObject({ code: 'E_ANLAS_ESTIMATE_CHANGED' })

        const lowCeiling = {
            ...freeCostConsent(),
            pricingBasis: 'paid' as const,
            estimatedAnlas: 20,
            maxAnlas: 19,
        }
        await expect(enqueuePlannedMainBatch({
            planner: planner(),
            submissionPolicy: { kind: 'guided', costConsent: lowCeiling },
        })).rejects.toMatchObject({ code: 'E_ANLAS_CEILING_EXCEEDED' })

        expect(runtime.dehydrate).not.toHaveBeenCalled()
        expect(runtime.createBatchAndEnqueue).not.toHaveBeenCalled()
        expect(runtime.complete).toHaveBeenCalledTimes(3)
    })
})
