import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
    auth: {
        getActiveTokens: vi.fn(() => ['test-credential']),
        requestTokenEntry: vi.fn(),
    },
    queue: {
        executionAuthority: 'durable' as 'durable' | 'legacy',
        setSelectedBatchId: vi.fn(),
    },
    settings: {
        generationFolderDocument: { schemaVersion: 2, workspaceId: 'local', revision: 1, folders: [] },
        generationFolders: [],
        activeGenerationFolderId: 'generation-folder-default',
        savePath: 'NAI_Blue_Output',
        useAbsolutePath: false,
        imageFormat: 'png' as const,
        metadataMode: 'embedded' as const,
        useStreaming: false,
        autoSave: true,
    },
    enqueue: vi.fn(async () => ({
        status: 'ready' as const,
        batchId: 'batch:manual-review',
        runId: 'batch:manual-review',
        jobIds: ['job:manual-review'],
    })),
}))

vi.mock('@/stores/auth-store', () => ({
    useAuthStore: { getState: () => runtime.auth },
    selectActiveCredentialsAreOpus: () => false,
}))
vi.mock('@/stores/queue-store', () => ({ useQueueStore: { getState: () => runtime.queue } }))
vi.mock('@/stores/settings-store', () => ({ useSettingsStore: { getState: () => runtime.settings } }))
vi.mock('@/lib/generation-folder-authority-runtime', () => ({ resolveGenerationFolderAuthority: () => null }))
vi.mock('@/lib/anlas-calculator', () => ({ resolveAnlasPricingBasis: () => 'paid' }))
vi.mock('@/lib/utils', () => ({ generateRandomSeed: () => 4242 }))
vi.mock('@/application/folder/generation-folder-binding', () => ({
    createGenerationFolderDocumentBinding: () => ({
        resourceType: 'generation-folder-document', resourceId: 'local', revision: 1,
        contentHash: `sha256:${'a'.repeat(64)}`,
    }),
}))
vi.mock('@/services/generation/main-application-generation-command', () => ({
    enqueuePreparedMainGeneration: runtime.enqueue,
}))
vi.mock('@/services/generation/generation-command', () => ({
    credentialReadinessFingerprint: () => `sha256:${'b'.repeat(64)}`,
}))

import type { GenerationParams } from '@/services/novelai-types'
import { ManualReviewGenerationError, queueManualReviewGeneration } from '@/services/generation/manual-review-generation-command'

const params: GenerationParams = {
    prompt: 'reviewed prompt', negative_prompt: 'lowres', model: 'nai-diffusion-5-full',
    width: 832, height: 1216, steps: 28, cfg_scale: 5, cfg_rescale: 0,
    sampler: 'k_euler_ancestral', scheduler: 'native', smea: false, smea_dyn: false,
    variety: false, seed: 0,
    characterPrompts: [{
        stableId: 'character-1', prompt: 'character prompt', negative: 'character negative',
        enabled: true, position: { x: 0.5, y: 0.5 },
    }],
}

describe('manual review generation command', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        runtime.queue.executionAuthority = 'durable'
        runtime.auth.getActiveTokens.mockReturnValue(['test-credential'])
    })

    it('enqueues exactly one reviewed image with one Provider attempt', async () => {
        await expect(queueManualReviewGeneration('card-1', params, 'request-1')).resolves.toEqual({
            batchId: 'batch:manual-review', jobId: 'job:manual-review',
        })

        const command = runtime.enqueue.mock.calls[0][0]
        expect(command.prepared).toHaveLength(1)
        expect(command.prepared[0].params).toMatchObject({
            prompt: 'reviewed prompt', seed: 4242, model: 'nai-diffusion-5-full',
            steps: 28, cfg_scale: 5, characterPrompts: params.characterPrompts,
        })
        expect(command.maxAttempts).toBe(1)
        expect(command.captureId).toBe('manual-review:card-1:request-1')
        expect(command.idempotencyKey).toBe('manual-review:manual-review:card-1:request-1')
        expect(runtime.queue.setSelectedBatchId).toHaveBeenCalledWith('batch:manual-review')
    })

    it('opens credential entry and stops before Queue when no verified credential is active', async () => {
        runtime.auth.getActiveTokens.mockReturnValueOnce([])

        await expect(queueManualReviewGeneration('card-1', params)).rejects.toBeInstanceOf(ManualReviewGenerationError)

        expect(runtime.auth.requestTokenEntry).toHaveBeenCalledOnce()
        expect(runtime.enqueue).not.toHaveBeenCalled()
    })

    it('refuses to fall back to the legacy generator', async () => {
        runtime.queue.executionAuthority = 'legacy'

        await expect(queueManualReviewGeneration('card-1', params)).rejects.toMatchObject({ mayHaveEnqueued: false })

        expect(runtime.enqueue).not.toHaveBeenCalled()
    })
})
