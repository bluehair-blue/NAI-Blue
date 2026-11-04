import { describe, expect, it, vi } from 'vitest'
import type { GenerationJob } from '@/domain/queue/types'
import { recoverQueueR2Release, type QueueR2ReleaseRecoveryDependencies } from '@/services/queue/queue-r2-release-recovery'

const dependencies: QueueR2ReleaseRecoveryDependencies = {
    artifacts: { get: vi.fn() },
    platform: { resolveDirectory: vi.fn(), readFile: vi.fn() },
    release: { enqueue: vi.fn() },
    uploads: { getJob: vi.fn(), resumeFailedJob: vi.fn() },
}

function legacyJob(workflow: 'main' | 'scene', overrides: Record<string, unknown> = {}): GenerationJob {
    return {
        id: 'completed-before-r2', workflow, state: 'succeeded',
        artifactReference: { artifactId: 'preserved-artifact' },
        snapshot: { parameters: {
            [workflow === 'main' ? 'mainWorkflow' : 'sceneWorkflow']: {
                [workflow === 'main' ? 'output' : 'outputContext']: {}, ...overrides,
            },
        } },
    } as unknown as GenerationJob
}

describe('pre-R2 terminal job recovery', () => {
    it.each(['main', 'scene'] as const)('ignores a completed %s job with no delivery intent without decoding Provider fields', async workflow => {
        await expect(recoverQueueR2Release(legacyJob(workflow), false, dependencies)).resolves.toBeNull()
        expect(dependencies.artifacts.get).not.toHaveBeenCalled()
        expect(dependencies.release.enqueue).not.toHaveBeenCalled()
    })

    it.each(['main', 'scene'] as const)('ignores an explicitly disabled %s release with obsolete generation parameters', async workflow => {
        await expect(recoverQueueR2Release(legacyJob(workflow, {
            r2Delivery: { requirement: 'disabled', planned: null }, r2DeliveryVersion: 1,
        }), false, dependencies)).resolves.toBeNull()
    })

    it.each([
        { r2Delivery: { requirement: 'required', planned: { corrupted: true } } },
        { r2Delivery: { requirement: 'required', planned: null } },
        { r2Delivery: null },
        { r2DeliveryVersion: 1 },
        { r2DeliveryVersion: 2, r2Delivery: { requirement: 'disabled', planned: null } },
        { output: { autoR2UploadProfileId: 'preserved-profile' } },
        { output: { deleteOriginalAfterRelease: true } },
        { output: { autoR2UploadProfileId: 'profile' }, r2Delivery: { requirement: 'disabled', planned: null } },
    ])('keeps ambiguous or activated delivery strict: %j', async overrides => {
        await expect(recoverQueueR2Release(legacyJob('main', overrides), false, dependencies)).rejects.toThrow('snapshot parameters are invalid')
        expect(dependencies.release.enqueue).not.toHaveBeenCalled()
    })

    it('does not skip Provider validation for an active job', async () => {
        const job = { ...legacyJob('main'), state: 'running' as const }
        await expect(recoverQueueR2Release(job, false, dependencies)).rejects.toThrow('snapshot parameters are invalid')
    })
})
