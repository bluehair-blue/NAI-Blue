import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MainBatchPlannerPort } from '@/application/generation/plan-main-batch'
import { createAnlasCostConsentSnapshot } from '@/domain/queue/anlas-cost-consent'
import type { PreparedMainGeneration } from '@/services/generation/main-generation-plan'

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
    preflight: vi.fn(),
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
            preflight: runtime.preflight,
        },
    }),
}))

vi.mock('@/services/queue/indexeddb-queue-repository', () => ({
    getRuntimeQueueRepository: () => ({ createBatchAndEnqueue: runtime.createBatchAndEnqueue }),
    assertGenerationAtomicBatchAvailable: vi.fn(),
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
        runtime.preflight.mockResolvedValue({
            fileName: 'planned.png',
            directoryIdentity: `sha256:${'b'.repeat(64)}`,
            availableSpaceCheck: 'unavailable',
            foregroundSingleWriterOnly: true,
            crossProcessReservation: false,
        })
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

        expect(runtime.preflight).toHaveBeenCalledWith(expect.objectContaining({
            fileName: 'planned.png',
            collisionPolicy: 'fail',
            probeWrite: true,
        }))
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

        expect(runtime.preflight).toHaveBeenCalledOnce()
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
        runtime.preflight
            .mockResolvedValueOnce({
                fileName: 'planned.png', directoryIdentity: `sha256:${'b'.repeat(64)}`,
                availableSpaceCheck: 'unavailable', foregroundSingleWriterOnly: true, crossProcessReservation: false,
            })
            .mockResolvedValueOnce({
                fileName: 'planned-2.png', directoryIdentity: `sha256:${'b'.repeat(64)}`,
                availableSpaceCheck: 'unavailable', foregroundSingleWriterOnly: true, crossProcessReservation: false,
            })

        await enqueuePlannedMainBatch({
            planner: twoRequests,
            submissionPolicy: { kind: 'guided', costConsent: freeCostConsent() },
        })

        expect(runtime.dehydrate).toHaveBeenCalledTimes(2)
        expect(runtime.createBatchAndEnqueue).toHaveBeenCalledOnce()
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
