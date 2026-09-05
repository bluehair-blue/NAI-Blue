import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreparedMainGeneration } from '@/services/generation/main-generation-plan'
import { createR2ProfileV2, type R2ProfileV2 } from '@/domain/r2/types'
import { planGeneration } from '@/application/generation/plan-generation'

const runtime = vi.hoisted(() => ({
    enqueueReviewed: vi.fn(async () => ({
        status: 'enqueued' as const,
        queue: {
            batch: { id: 'batch:main' },
            jobs: [{ id: 'job:main:0', ordinal: 0 }],
        },
    })),
    compatibility: vi.fn(() => ({
        compatibilityProfileId: 'nai:test:capture',
        status: 'captured-pass' as const,
    })),
    getProfile: vi.fn(async (): Promise<R2ProfileV2 | null> => null),
    getReadiness: vi.fn(async () => ({ status: 'ready' as 'ready' | 'not-ready', credentialRef: 'private-credential-binding' })),
}))

vi.mock('@/services/queue/main-queue-adapter', () => ({
    enqueueReviewedMainPlan: runtime.enqueueReviewed,
}))
vi.mock('@/services/nai/compatibility', () => ({
    CURRENT_NAI_PAYLOAD_BUILDER_REVISION: 'test-revision',
    queryNaiGenerationCompatibility: runtime.compatibility,
}))
vi.mock('@/services/queue/main-queue-runtime-dependencies', () => ({
    getRuntimeMainQueueDependencies: () => ({ r2Planning: { getProfile: runtime.getProfile, getReadiness: runtime.getReadiness } }),
}))

import { enqueuePreparedMainGeneration } from '@/services/generation/main-application-generation-command'

const FOLDER_BINDING = {
    resourceType: 'generation-folder-document' as const,
    resourceId: 'local',
    revision: 3,
    contentHash: `sha256:${'f'.repeat(64)}` as const,
}

function commandInput(output: Partial<PreparedMainGeneration['output']> = {}) {
    return {
        prepared: [prepared(output)], captureId: 'main-capture:test', idempotencyKey: 'main:test-action',
        pricingBasis: 'paid' as const, approvedAt: '2026-09-03T00:00:00.000Z',
        credentialReadinessFingerprint: `sha256:${'d'.repeat(64)}` as const, folderBinding: FOLDER_BINDING,
    }
}

function prepared(overrides: Partial<PreparedMainGeneration['output']> = {}): PreparedMainGeneration {
    return {
        params: {
            prompt: 'main prompt',
            negative_prompt: 'lowres',
            model: 'nai-diffusion-4-5-full',
            width: 832,
            height: 1_216,
            steps: 28,
            cfg_scale: 5,
            cfg_rescale: 0,
            sampler: 'k_euler_ancestral',
            scheduler: 'karras',
            smea: false,
            smea_dyn: false,
            variety: false,
            seed: 17,
            imageFormat: 'png',
            metadataMode: 'embedded',
        },
        finalPrompt: 'main prompt',
        imageFormat: 'png',
        metadataMode: 'embedded',
        streaming: false,
        sourceEdit: false,
        sequenceCommitProposal: null,
        output: {
            autoSave: true,
            directory: 'NAI_Blue_Output',
            useAbsolutePath: false,
            capabilityFallbackDirectory: 'NAI_Blue_Output',
            collisionPolicy: 'unique',
            generationFolderId: null,
            generationFolderPath: null,
            autoR2UploadProfileId: null,
            r2Bucket: null,
            r2Prefix: null,
            deleteOriginalAfterRelease: false,
            rightsXmpEnabled: false,
            rightsOwner: 'BlueHair',
            rightsEffectiveDate: null,
            ...overrides,
        },
    }
}

describe('Main application generation command', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        runtime.getProfile.mockResolvedValue(createR2ProfileV2({
            id: 'private-profile', name: 'Private', accountId: 'account', jurisdiction: null, endpoint: null,
            bucket: 'profile-bucket', prefix: 'profile-prefix', credentialRef: 'private-credential-binding',
            transport: 'native-s3', conflictPolicy: 'fail', publicMode: 'private', publicBaseUrl: null,
        }))
        runtime.getReadiness.mockResolvedValue({ status: 'ready', credentialRef: 'private-credential-binding' })
    })

    it('reviews the detached capture and returns only its durable handle', async () => {
        const result = await enqueuePreparedMainGeneration({
            prepared: [prepared()],
            captureId: 'main-capture:test',
            idempotencyKey: 'main:test-action',
            pricingBasis: 'paid',
            approvedAt: '2026-09-03T00:00:00.000Z',
            credentialReadinessFingerprint: `sha256:${'d'.repeat(64)}`,
            folderBinding: FOLDER_BINDING,
        })

        expect(result).toEqual({
            status: 'ready',
            batchId: 'batch:main',
            runId: 'batch:main',
            jobIds: ['job:main:0'],
        })
        expect(runtime.enqueueReviewed).toHaveBeenCalledOnce()
        const request = runtime.enqueueReviewed.mock.calls[0][0]
        expect(request.input.source).toMatchObject({
            kind: 'detached-generation-capture',
            capture: {
                captureId: 'main-capture:test',
                materializedSeeds: [17],
                credentialReadinessFingerprint: `sha256:${'d'.repeat(64)}`,
                sourceBindings: [FOLDER_BINDING],
            },
        })
        expect(request.submissionPolicy).toMatchObject({
            kind: 'reviewed',
            costConsent: { estimatedAnlas: expect.any(Number), maxAnlas: expect.any(Number) },
        })
        expect(request.idempotencyScope).toBe('main:test-action')
    })

    it.each([
        [{ collisionPolicy: 'overwrite' as const }, 'unsupported-collision-policy'],
        [{ deleteOriginalAfterRelease: true }, 'r2-delete-original-unsupported'],
    ])('blocks unsupported output policy before Queue persistence', async (output, code) => {
        const result = await enqueuePreparedMainGeneration({
            prepared: [prepared(output)],
            captureId: 'main-capture:blocked',
            idempotencyKey: 'main:blocked',
            pricingBasis: 'paid',
            approvedAt: '2026-09-03T00:00:00.000Z',
            credentialReadinessFingerprint: `sha256:${'d'.repeat(64)}`,
            folderBinding: FOLDER_BINDING,
        })

        expect(result.status).toBe('unsupported')
        if (result.status === 'unsupported') expect(result.issues[0]?.code).toBe(code)
        expect(runtime.enqueueReviewed).not.toHaveBeenCalled()
    })

    it('captures required Folder delivery with exact filename and private sidecar before review', async () => {
        const provenance = { profileId: 'generation-folder', bucket: 'folder', prefix: 'ancestor', key: 'planned-output' } as const
        const result = await enqueuePreparedMainGeneration(commandInput({
            r2Requirement: { mode: 'required', profileId: 'private-profile' },
            r2Bucket: 'folder-bucket', r2Prefix: 'characters', r2Provenance: provenance,
            fileName: 'reviewed-output.png',
        }))
        expect(result.status).toBe('ready')
        const request = runtime.enqueueReviewed.mock.calls[0][0]
        const job = request.reviewed.jobs[0]
        expect(job.destination.r2).toMatchObject({
            requirement: 'required', bucket: 'folder-bucket', key: 'characters/reviewed-output.png', provenance,
        })
        expect(job.prepared).toMatchObject({
            metadataMode: 'strip-and-sidecar', params: { metadataMode: 'strip-and-sidecar' },
            output: { fileName: 'reviewed-output.png', r2Delivery: {
                requirement: 'required', planned: { credentialBinding: { credentialRef: 'private-credential-binding' } },
            } },
        })
        const replanned = await planGeneration({
            ...request.input,
            seedPolicy: { kind: 'replay', traceId: request.input.source.capture.captureId },
        }, request.dependencies)
        expect(replanned.status).toBe('ready')
        if (replanned.status !== 'ready') throw new Error('Expected ready public review')
        expect(replanned.view.jobs[0].destination.r2).toEqual(job.destination.r2)
        expect(JSON.stringify(replanned.view)).not.toMatch(/credentialRef|private-credential-binding/)
    })

    it('defaults profile delivery to best-effort and preserves explicit disabled without credential lookup', async () => {
        await enqueuePreparedMainGeneration(commandInput({ autoR2UploadProfileId: 'private-profile' }))
        expect(runtime.enqueueReviewed.mock.calls[0][0].reviewed.jobs[0].destination.r2).toMatchObject({
            requirement: 'best-effort', bucket: 'profile-bucket', key: 'profile-prefix/NAI_Blue_17.png',
        })
        runtime.getProfile.mockClear()
        runtime.getReadiness.mockClear()
        await enqueuePreparedMainGeneration(commandInput({
            autoR2UploadProfileId: 'private-profile', r2Requirement: { mode: 'disabled' },
        }))
        const job = runtime.enqueueReviewed.mock.calls[1][0].reviewed.jobs[0]
        expect(job.destination.r2).toBeUndefined()
        expect(job.prepared.output).toMatchObject({ autoR2UploadProfileId: null, r2Delivery: { requirement: 'disabled', planned: null } })
        expect(job.prepared.metadataMode).toBe('embedded')
        expect(runtime.getProfile).not.toHaveBeenCalled()
        expect(runtime.getReadiness).not.toHaveBeenCalled()
    })

    it('blocks required credential loss before Queue persistence', async () => {
        runtime.getReadiness.mockResolvedValue({ status: 'not-ready', credentialRef: 'private-credential-binding' })
        const result = await enqueuePreparedMainGeneration(commandInput({
            r2Requirement: { mode: 'required', profileId: 'private-profile' },
        }))
        expect(result).toMatchObject({ status: 'invalid', issues: [{ code: 'r2-required-not-ready' }] })
        expect(runtime.enqueueReviewed).not.toHaveBeenCalled()
    })

    it('rejects a cleared Folder bucket and retains a cleared prefix in the reviewed hash', async () => {
        const provenance = { profileId: 'generation-folder', bucket: 'cleared', prefix: 'cleared', key: 'planned-output' } as const
        const cleared = await enqueuePreparedMainGeneration(commandInput({
            autoR2UploadProfileId: 'private-profile', r2Bucket: null, r2Prefix: '', r2Provenance: provenance,
        }))
        expect(cleared).toMatchObject({ status: 'invalid', issues: [{ code: 'r2-destination-unavailable' }] })
        expect(runtime.enqueueReviewed).not.toHaveBeenCalled()
        const output = {
            autoR2UploadProfileId: 'private-profile', r2Bucket: 'folder-bucket', r2Prefix: '',
            r2Provenance: { ...provenance, bucket: 'folder' as const },
        }
        await enqueuePreparedMainGeneration(commandInput(output))
        await enqueuePreparedMainGeneration(commandInput({ ...output, r2Prefix: 'changed' }))
        const [first, second] = runtime.enqueueReviewed.mock.calls.map(call => call[0].reviewed)
        expect(first.jobs[0].destination.r2.key).toBe('NAI_Blue_17.png')
        expect(second.jobs[0].destination.r2.key).toBe('changed/NAI_Blue_17.png')
        expect(first.planHash).not.toBe(second.planHash)
    })
})
