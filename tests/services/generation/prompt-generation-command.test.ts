import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
    main: {
        isGenerating: false,
        generatingMode: null as 'main' | 'scene' | 'styleLab' | null,
        cancelGeneration: vi.fn(),
    },
    rotation: { active: false, stop: vi.fn() },
    queue: { executionAuthority: 'durable' as 'durable' | 'legacy' },
    auth: {
        getActiveTokens: vi.fn(() => [{ slot: 1, token: 'token' }]),
        requestTokenEntry: vi.fn(),
    },
    scene: {
        activePresetId: 'preset:1' as string | null,
        isGenerating: false,
        isCancelling: false,
        getTotalQueueCount: vi.fn(() => 2),
        cancelSceneGeneration: vi.fn(),
        startNewGenerationSession: vi.fn(),
    },
    startMain: vi.fn(async (): Promise<'started' | 'low-quality-steps'> => 'started'),
    cancelMain: vi.fn(async () => undefined),
}))

vi.mock('@/stores/generation-store', () => ({ useGenerationStore: { getState: () => runtime.main } }))
vi.mock('@/stores/character-rotation-store', () => ({ useRotationStore: { getState: () => runtime.rotation } }))
vi.mock('@/stores/queue-store', () => ({ useQueueStore: { getState: () => runtime.queue } }))
vi.mock('@/stores/auth-store', () => ({ useAuthStore: { getState: () => runtime.auth } }))
vi.mock('@/stores/scene-store', () => ({ useSceneStore: { getState: () => runtime.scene } }))
vi.mock('@/services/generation/generation-command', () => ({
    startMainGenerationCommand: runtime.startMain,
    cancelMainGenerationCommand: runtime.cancelMain,
}))

import { executePromptGenerationCommand } from '@/services/generation/prompt-generation-command'

describe('prompt route generation command adapter', () => {
    beforeEach(() => {
        runtime.main.isGenerating = false
        runtime.main.generatingMode = null
        runtime.rotation.active = false
        runtime.queue.executionAuthority = 'durable'
        runtime.auth.getActiveTokens.mockReturnValue([{ slot: 1, token: 'token' }])
        runtime.scene.activePresetId = 'preset:1'
        runtime.scene.isGenerating = false
        runtime.scene.isCancelling = false
        runtime.scene.getTotalQueueCount.mockReturnValue(2)
        runtime.startMain.mockResolvedValue('started')
        vi.clearAllMocks()
    })

    it('routes Main start and cancellation through the established command boundary', async () => {
        await expect(executePromptGenerationCommand('main')).resolves.toBe('started')
        expect(runtime.startMain).toHaveBeenCalledOnce()

        runtime.main.isGenerating = true
        runtime.main.generatingMode = 'main'
        await expect(executePromptGenerationCommand('main')).resolves.toBe('cancel-requested')
        expect(runtime.cancelMain).toHaveBeenCalledOnce()
        expect(runtime.main.cancelGeneration).not.toHaveBeenCalled()

        vi.clearAllMocks()
        runtime.queue.executionAuthority = 'legacy'
        await expect(executePromptGenerationCommand('main')).resolves.toBe('cancel-requested')
        expect(runtime.cancelMain).toHaveBeenCalledOnce()
        expect(runtime.main.cancelGeneration).not.toHaveBeenCalled()
    })

    it('propagates the low-step guard without claiming that Main started', async () => {
        runtime.startMain.mockResolvedValue('low-quality-steps')

        await expect(executePromptGenerationCommand('main')).resolves.toBe('low-quality-steps')
        expect(runtime.startMain).toHaveBeenCalledOnce()
        expect(runtime.cancelMain).not.toHaveBeenCalled()
    })

    it('cancels a direct Style Lab generation through its owning store under durable authority', async () => {
        runtime.main.isGenerating = true
        runtime.main.generatingMode = 'styleLab'

        await expect(executePromptGenerationCommand('main')).resolves.toBe('cancel-requested')

        expect(runtime.main.cancelGeneration).toHaveBeenCalledOnce()
        expect(runtime.cancelMain).not.toHaveBeenCalled()
    })

    it('blocks cross-route generation instead of cancelling the wrong owner', async () => {
        runtime.main.isGenerating = true
        runtime.main.generatingMode = 'scene'

        await expect(executePromptGenerationCommand('main')).resolves.toBe('blocked-conflict')
        expect(runtime.cancelMain).not.toHaveBeenCalled()
        expect(runtime.main.cancelGeneration).not.toHaveBeenCalled()

        runtime.scene.isGenerating = false
        runtime.main.generatingMode = 'main'
        await expect(executePromptGenerationCommand('scene')).resolves.toBe('blocked-conflict')
        expect(runtime.scene.startNewGenerationSession).not.toHaveBeenCalled()
    })

    it('stops rotation before any Scene executor is selected', async () => {
        runtime.rotation.active = true

        await expect(executePromptGenerationCommand('scene')).resolves.toBe('rotation-stopped')

        expect(runtime.rotation.stop).toHaveBeenCalledWith({ reason: 'prompt controls stop', keepSnapshot: true })
        expect(runtime.scene.startNewGenerationSession).not.toHaveBeenCalled()
    })

    it('preserves legacy Scene sessions while requiring review for durable Scene work', async () => {
        runtime.queue.executionAuthority = 'legacy'
        await expect(executePromptGenerationCommand('scene')).resolves.toBe('started')
        expect(runtime.scene.startNewGenerationSession).toHaveBeenCalledOnce()

        vi.clearAllMocks()
        runtime.queue.executionAuthority = 'durable'
        await expect(executePromptGenerationCommand('scene')).resolves.toBe('review-required')
        expect(runtime.scene.startNewGenerationSession).not.toHaveBeenCalled()
    })

    it('opens the credential vault instead of silently enqueueing work without an active token', async () => {
        runtime.auth.getActiveTokens.mockReturnValue([])

        await expect(executePromptGenerationCommand('scene')).resolves.toBe('credential-required')

        expect(runtime.auth.requestTokenEntry).toHaveBeenCalledOnce()
    })
})
