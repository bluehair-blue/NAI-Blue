import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import type { GenerationBatch, GenerationJob, GenerationJobState } from '@/domain/queue/types'
import {
    collectFolderQueueActivity, createFolderQueueActivityReader, projectFolderQueueJob,
    type FolderQueueJob,
} from '@/presentation/folders/folder-queue-activity'

const key = JSON.stringify(['preset-a', 'scene-a'])
const batch = (queueSequence = 1, projectionRevision = 1) => ({
    id: `batch-${queueSequence}`, workflow: 'scene', queueSequence, projectionRevision,
} as GenerationBatch)
const job = (state: GenerationJobState, presetId = 'preset-a', batchId = 'batch-1'): GenerationJob => ({
    id: 'job-a', batchId, workflow: 'scene', sceneId: 'scene-a', state,
    snapshot: {
        schemaVersion: 1, prompt: { positive: '', negative: '' }, resources: [],
        outputPolicy: {}, resumability: 'resumable',
        agentExecutionBinding: { scopeId: 'agent-scope', planId: 'plan-a', planHash: 'plan-hash', grantHash: `sha256:${'a'.repeat(64)}` },
        parameters: {
            generationParams: {}, resourceBindings: [], resourceArrayLengths: {},
            queueExecution: { streaming: false, sourceEdit: false },
            sceneWorkflow: {
                scene: { id: 'scene-a', name: 'Scene' }, finalPrompt: '', mimeType: 'image/png',
                saveContext: { activePresetId: presetId, sceneSavePath: 'output' },
                outputContext: { useAbsoluteScenePath: false, metadataMode: 'embedded', presetName: 'Preset', sceneName: 'Scene' },
            },
        },
    },
} as GenerationJob)
const projected = (state: GenerationJobState, sequence = 1): FolderQueueJob => ({
    key, batchId: `batch-${sequence}`, queueSequence: sequence, state,
})

describe('Folder durable Queue observation', () => {
    it('uses agent jobs and exact preset/Scene identity, rejecting foreign or damaged snapshots', () => {
        const a = projectFolderQueueJob(job('queued'), batch())!
        const b = projectFolderQueueJob(job('running', 'preset-b'), batch())!
        const activity = collectFolderQueueActivity([a, b])
        expect(activity.get(key)).toEqual({ state: 'queued', unfinished: 1 })
        expect(activity.get(JSON.stringify(['preset-b', 'scene-a']))).toEqual({ state: 'running', unfinished: 1 })
        expect(projectFolderQueueJob({ ...job('queued'), workflow: 'main' }, batch())).toBeNull()
        expect(projectFolderQueueJob({ ...job('queued'), sceneId: 'wrong-scene' }, batch())).toBeNull()
        const damaged = job('queued')
        expect(projectFolderQueueJob({ ...damaged, snapshot: { ...damaged.snapshot, parameters: {} } }, batch())).toBeNull()
    })

    it('counts unfinished images across runs and keeps active work visible beside older successes', () => {
        const activity = collectFolderQueueActivity([
            projected('succeeded'), projected('running', 2), projected('queued', 2),
            projected('blocked', 3), projected('failed', 3),
        ])
        expect(activity.get(key)).toEqual({ state: 'running', unfinished: 3 })
    })

    it('shows the newest completed run rather than the last job array entry or an older failure', () => {
        expect(collectFolderQueueActivity([
            projected('succeeded', 2), projected('succeeded', 2), projected('failed', 1),
        ]).get(key)).toEqual({ state: 'succeeded', unfinished: 0 })
        expect(collectFolderQueueActivity([
            projected('succeeded', 1), projected('failed', 2), projected('succeeded', 2),
        ]).get(key)).toEqual({ state: 'failed', unfinished: 0 })
    })

    it.each(['blocked', 'recovering', 'cancelled', 'skipped'] as const)('keeps %s distinct from success', state => {
        expect(collectFolderQueueActivity([projected(state)]).get(key)).toEqual({
            state, unfinished: state === 'blocked' || state === 'recovering' ? 1 : 0,
        })
    })

    it('reads changed batch revisions only, follows pagination, and removes deleted batches', async () => {
        let currentBatch = batch()
        const listBatches = vi.fn(async () => [currentBatch])
        const listJobs = vi.fn(async ({ cursor }: { cursor?: string | null }) => ({
            items: [job(cursor ? 'running' : 'queued')], nextCursor: cursor ? null : 'page-2',
        }))
        const read = createFolderQueueActivityReader({ listBatches, listJobs })
        const first = await read()
        expect(first.get(key)).toEqual({ state: 'running', unfinished: 2 })
        expect(await read()).toBe(first)
        expect(listJobs).toHaveBeenCalledTimes(2)
        currentBatch = batch(1, 2)
        listJobs.mockRejectedValueOnce(new Error('read unavailable'))
        await expect(read()).rejects.toThrow('read unavailable')
        // The hook can retain and label this last-known projection during a failed refresh.
        expect(first.get(key)).toEqual({ state: 'running', unfinished: 2 })
        listJobs.mockResolvedValue({ items: [job('succeeded')], nextCursor: null })
        expect((await read()).get(key)).toEqual({ state: 'succeeded', unfinished: 0 })
        expect(listJobs).toHaveBeenCalledTimes(4)
        listBatches.mockResolvedValue([])
        expect((await read()).size).toBe(0)
    })

    it('retries a failed refresh without keeping a partially updated cache', async () => {
        const listBatches = vi.fn(async () => [batch(), batch(2)])
        const listJobs = vi.fn()
            .mockResolvedValueOnce({ items: [job('queued')], nextCursor: null })
            .mockRejectedValueOnce(new Error('temporary read failure'))
            .mockResolvedValueOnce({ items: [job('running')], nextCursor: null })
            .mockResolvedValueOnce({ items: [job('succeeded', 'preset-a', 'batch-2')], nextCursor: null })
        const read = createFolderQueueActivityReader({ listBatches, listJobs })
        await expect(read()).rejects.toThrow('temporary read failure')
        expect((await read()).get(key)).toEqual({ state: 'running', unfinished: 1 })
        expect(listJobs).toHaveBeenCalledTimes(4)
    })
})
