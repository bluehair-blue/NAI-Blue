import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MainBatchPlannerPort } from '@/application/generation/plan-main-batch'
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
    planBatch: vi.fn(),
    assertAtomic: vi.fn(),
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
            planBatch: runtime.planBatch,
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
    beforeEach(() => {
        vi.clearAllMocks()
        runtime.createBatchAndEnqueue.mockResolvedValue({ batch: {}, jobs: [] })
        runtime.currentFolderBinding.mockReturnValue(folderBinding)
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
