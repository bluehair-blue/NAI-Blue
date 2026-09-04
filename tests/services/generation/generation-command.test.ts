import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
    generation: { steps: 28, model: 'nai-diffusion-4-5-full', generate: vi.fn(async () => undefined) },
    queue: {
        executionAuthority: 'durable' as 'durable' | 'legacy',
        selectedBatchId: null as string | null,
        setSelectedBatchId: vi.fn((batchId: string | null) => { runtime.queue.selectedBatchId = batchId }),
    },
    batchWorkflows: new Map<string, 'main' | 'scene' | 'style-lab'>(),
    getBatch: vi.fn(async (batchId: string) => {
        const workflow = runtime.batchWorkflows.get(batchId)
        return workflow === undefined ? null : { id: batchId, workflow }
    }),
    auth: {
        token: 'secret', token2: '', isVerified: true, isVerified2: false,
        slot1Enabled: true, slot2Enabled: false, slot1CredentialRef: null, slot2CredentialRef: null,
        tier: 'tablet', tier2: null, isCredentialStateInitialized: true,
        getActiveTokens: vi.fn(() => [{ slot: 1, token: 'secret' }]),
        requestTokenEntry: vi.fn(),
    },
    planner: {
        getRequestedCount: vi.fn(() => 1),
        prepareBatch: vi.fn(async () => [runtime.prepared]),
    },
    prepared: {
        params: { seed: 7 },
        imageFormat: 'png' as const,
        output: {
            directory: 'output', useAbsolutePath: false,
            capabilityFallbackDirectory: 'output', collisionPolicy: 'unique' as const,
        },
    },
    planBatch: vi.fn(),
    enqueue: vi.fn(async () => ({ status: 'ready' as const, batchId: 'batch:main', runId: 'batch:main', jobIds: ['job:1'] })),
    cancelBatch: vi.fn(async (input: { batchId: string }) => ({
        status: 'ready' as const, targetId: input.batchId,
    })),
}))

vi.mock('@/stores/generation-store', () => ({
    useGenerationStore: { getState: () => runtime.generation },
}))
vi.mock('@/stores/queue-store', () => ({
    useQueueStore: { getState: () => runtime.queue },
}))
vi.mock('@/stores/auth-store', () => ({
    useAuthStore: { getState: () => runtime.auth },
    selectActiveCredentialsAreOpus: () => false,
}))
vi.mock('@/stores/settings-store', () => ({
    useSettingsStore: { getState: () => ({ generationFolderDocument: {} }) },
}))
vi.mock('@/application/folder/generation-folder-binding', () => ({
    createGenerationFolderDocumentBinding: () => ({
        resourceType: 'generation-folder-document', resourceId: 'local', revision: 1,
        contentHash: `sha256:${'f'.repeat(64)}`,
    }),
}))
vi.mock('@/services/queue/main-queue-runtime-dependencies', () => ({
    getRuntimeMainQueueDependencies: () => ({
        planner: runtime.planner,
        outputReservations: { planBatch: runtime.planBatch },
    }),
}))
vi.mock('@/services/generation/main-application-generation-command', () => ({
    enqueuePreparedMainGeneration: runtime.enqueue,
}))
vi.mock('@/services/queue/generation-command-adapter', () => ({
    getRuntimeGenerationCommandAdapter: () => ({ cancelBatch: runtime.cancelBatch }),
}))
vi.mock('@/services/queue/indexeddb-queue-repository', () => ({
    getRuntimeQueueRepository: () => ({ getBatch: runtime.getBatch }),
}))

import {
    cancelMainGenerationCommand,
    startMainGenerationCommand,
} from '@/services/generation/generation-command'

describe('Main generation command quality boundary', () => {
    beforeEach(() => {
        runtime.generation.steps = 28
        runtime.queue.executionAuthority = 'durable'
        runtime.queue.selectedBatchId = null
        runtime.batchWorkflows.clear()
        runtime.batchWorkflows.set('batch:main', 'main')
        runtime.auth.getActiveTokens.mockReturnValue([{ slot: 1, token: 'secret' }])
        runtime.planner.getRequestedCount.mockReturnValue(1)
        runtime.planner.prepareBatch.mockResolvedValue([runtime.prepared])
        runtime.enqueue.mockResolvedValue({ status: 'ready', batchId: 'batch:main', runId: 'batch:main', jobIds: ['job:1'] })
        vi.clearAllMocks()
    })

    it('rejects preview-grade steps before either execution authority starts', async () => {
        runtime.generation.steps = 1

        await expect(startMainGenerationCommand()).resolves.toBe('low-quality-steps')
        expect(runtime.enqueue).not.toHaveBeenCalled()
        expect(runtime.generation.generate).not.toHaveBeenCalled()
    })

    it('preserves durable and legacy execution after the quality check', async () => {
        await expect(startMainGenerationCommand()).resolves.toBe('started')
        expect(runtime.enqueue).toHaveBeenCalledOnce()
        expect(runtime.enqueue).toHaveBeenCalledWith(expect.objectContaining({
            prepared: [runtime.prepared],
        }))
        expect(runtime.planBatch).not.toHaveBeenCalled()
        expect(runtime.queue.setSelectedBatchId).toHaveBeenCalledWith('batch:main')

        vi.clearAllMocks()
        runtime.queue.executionAuthority = 'legacy'
        await expect(startMainGenerationCommand()).resolves.toBe('started')
        expect(runtime.generation.generate).toHaveBeenCalledOnce()
        expect(runtime.enqueue).not.toHaveBeenCalled()
    })

    it('returns after the durable enqueue without owning Queue drain', async () => {
        let releaseEnqueue: (() => void) | undefined
        runtime.enqueue.mockImplementationOnce(() => new Promise(resolve => {
            releaseEnqueue = () => resolve({
                status: 'ready', batchId: 'batch:main', runId: 'batch:main', jobIds: ['job:1'],
            })
        }))
        const command = startMainGenerationCommand()

        await vi.waitFor(() => expect(runtime.enqueue).toHaveBeenCalledOnce())
        releaseEnqueue?.()

        await expect(command).resolves.toBe('started')
    })

    it('cancels the exact durable batch returned by the application command', async () => {
        await startMainGenerationCommand()

        await cancelMainGenerationCommand()

        expect(runtime.cancelBatch).toHaveBeenCalledWith({
            batchId: 'batch:main',
            actor: { kind: 'user', id: 'main-ui:user' },
        })
    })

    it('cancels the exact persisted Main batch after a process restart', async () => {
        runtime.queue.selectedBatchId = 'batch:restored-main'
        runtime.batchWorkflows.set('batch:restored-main', 'main')

        await cancelMainGenerationCommand()

        expect(runtime.cancelBatch).toHaveBeenCalledWith({
            batchId: 'batch:restored-main',
            actor: { kind: 'user', id: 'main-ui:user' },
        })
    })

    it.each([
        ['no selected batch', null, undefined],
        ['a missing selected batch', 'batch:missing', undefined],
        ['a selected Scene batch', 'batch:scene', 'scene' as const],
    ])('fails closed without cancellation for %s', async (_label, batchId, workflow) => {
        runtime.queue.selectedBatchId = batchId
        if (batchId !== null && workflow !== undefined) runtime.batchWorkflows.set(batchId, workflow)

        await expect(cancelMainGenerationCommand()).resolves.toBeUndefined()

        expect(runtime.cancelBatch).not.toHaveBeenCalled()
    })

    it('cancels only the selected batch when two Main batches exist', async () => {
        runtime.batchWorkflows.set('batch:main-one', 'main')
        runtime.batchWorkflows.set('batch:main-two', 'main')
        runtime.queue.selectedBatchId = 'batch:main-two'

        await cancelMainGenerationCommand()

        expect(runtime.cancelBatch).toHaveBeenCalledOnce()
        expect(runtime.cancelBatch).toHaveBeenCalledWith({
            batchId: 'batch:main-two',
            actor: { kind: 'user', id: 'main-ui:user' },
        })
    })
})
