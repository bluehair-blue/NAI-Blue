import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import type { AgentCommandHandler } from '@/application/agent/runtime-capability-registry'
import { deriveGenerationFulfillment, type ObservedTechnicalFact } from '@/application/generation/generation-fulfillment'
import { assertAgentPublicValue } from '@/application/agent/agent-command-contract'

const mocks = vi.hoisted(() => ({ getRun: vi.fn(), inspect: vi.fn(), getJob: vi.fn(), getArtifact: vi.fn(async (): Promise<unknown> => null) }))
vi.mock('@/services/organizer/runtime', () => ({ getRuntimeArtifactRepository: () => ({ get: mocks.getArtifact }) }))
vi.mock('@/adapters/generation/indexeddb-generation-run-reader', async importOriginal => ({
    ...await importOriginal<object>(), getRuntimeGenerationRun: mocks.getRun,
}))
vi.mock('@/composition-root/agent-generation-recovery-inspection', async importOriginal => ({
    ...await importOriginal<object>(), inspectGenerationRecovery: mocks.inspect,
}))
vi.mock('@/services/queue/indexeddb-queue-repository', async importOriginal => ({
    ...await importOriginal<object>(), getRuntimeQueueRepository: () => ({ getJob: mocks.getJob }),
}))
vi.mock('@/adapters/workflow/indexeddb-workflow-draft-repository', () => ({
    getWorkflowDraftRepository: () => ({ list: async () => [] }),
}))

async function getRunHandler() {
    const { runtimeAgentCommands } = await import('@/composition-root/runtime-agent-commands')
    // Exercise the registered production handler without starting an app owner or opening private storage.
    const factory = (runtimeAgentCommands as unknown as { dependencies: {
        createHandlers(workspaceId: string): Promise<readonly AgentCommandHandler[]>
    } }).dependencies.createHandlers
    const handler = (await factory('workspace-1')).find(item => item.command === 'generation.get_run')!
    return (input: { runId: string; jobId?: string }) => handler.execute(handler.validate(input), {} as never)
}

describe('installed runtime get_run handler wiring', () => {
    it('adds inspection only for an explicitly selected job in the read run', async () => {
        const execute = await getRunHandler()
        const run = deriveGenerationFulfillment({ batchId: 'run-1', queueState: 'active', jobs: [
            { jobId: 'job-23', queueState: 'blocked', release: { policy: 'not-required' }, acceptance: { required: false } },
        ] })
        mocks.getRun.mockResolvedValue(run)
        mocks.inspect.mockResolvedValue({ found: true, attempt: { providerOutcome: 'unknown' },
            recovery: { localOutputVerified: false } })
        expect(await execute({ runId: 'run-1' })).not.toHaveProperty('recoveryInspection')
        expect(await execute({ runId: 'run-1', jobId: 'missing' })).toMatchObject({ requestedJobFound: false, jobs: [] })
        expect(mocks.inspect).not.toHaveBeenCalled()
        expect(await execute({ runId: 'run-1', jobId: 'job-23' })).toMatchObject({ requestedJobFound: true,
            jobs: [{ jobId: 'job-23' }], recoveryInspection: { attempt: { providerOutcome: 'unknown' } } })
        expect(mocks.inspect).toHaveBeenCalledExactlyOnceWith('run-1', 'job-23')
        expect(mocks.getJob).not.toHaveBeenCalled()
        mocks.getRun.mockResolvedValue(null)
        expect(await execute({ runId: 'missing', jobId: 'job-23' })).toEqual({ found: false })
    })

    it('names the committed file of stored jobs from the job read it already makes, within the public bound', async () => {
        const execute = await getRunHandler()
        const fact = (state: ObservedTechnicalFact['state']): ObservedTechnicalFact => ({ state,
            source: 'fixture', referenceId: 'result', observedAt: '2026-11-22T00:00:00.000Z', kind: 'direct' })
        const stored = (jobId: string, storage: ObservedTechnicalFact['state'] = 'succeeded') => ({ jobId, queueState: 'succeeded',
            interpretation: fact('succeeded'), provider: fact('succeeded'), storage: fact(storage),
            release: { policy: 'not-required' as const }, acceptance: { required: false } })
        const name = (ordinal: number) => `NAI_Blue_SCENE_nhr-photobooth-v5-draft3-20261122_nhr-v5-pose-draft3-1_${ordinal}.png`
        const paths: Record<string, string | undefined> = { 'job-0': name(0), 'job-4': name(4), 'job-nested': `sub/${name(8)}`, 'job-legacy': undefined }
        mocks.getJob.mockImplementation(async (jobId: string) => ({ id: jobId, artifactReference: { artifactId: `artifact:${jobId}` },
            snapshot: paths[jobId] === undefined ? {} : { outputReservation: { relativePath: paths[jobId] } } }))
        mocks.getRun.mockResolvedValue(deriveGenerationFulfillment({ batchId: 'run-2', queueState: 'completed', jobs: [
            stored('job-0'), stored('job-4'), stored('job-nested'), stored('job-legacy'), stored('job-pending', 'pending'),
        ] }))
        const result = await execute({ runId: 'run-2' })
        expect(result.jobs).toEqual([
            expect.objectContaining({ jobId: 'job-0', artifactId: 'artifact:job-0', fileName: name(0) }),
            expect.objectContaining({ jobId: 'job-4', fileName: name(4) }),
            expect.not.objectContaining({ fileName: expect.anything() }),
            expect.not.objectContaining({ fileName: expect.anything() }),
            { jobId: 'job-pending', queueState: 'succeeded', providerState: 'succeeded', storageState: 'pending',
                releaseState: 'not-required', acceptanceState: 'not-required' },
        ])
        expect(mocks.getJob).toHaveBeenCalledTimes(4)
        expect(() => assertAgentPublicValue(result)).not.toThrow()

        // Near-limit names push enriched rows past the wire bound, which must be re-applied after enrichment.
        const longName = (ordinal: number) => `NAI_Blue_SCENE_${'nhr-photobooth-v5-draft3-'.repeat(9)}${ordinal}.png`
        const many = Array.from({ length: 150 }, (_, index) => `job-${index}`)
        mocks.getJob.mockImplementation(async (jobId: string) => ({ id: jobId, artifactReference: { artifactId: `artifact:${jobId}` },
            snapshot: { outputReservation: { relativePath: longName(Number(jobId.slice(4))) } } }))
        mocks.getArtifact.mockImplementation(async (artifactId: string) => ({ artifactId, original: { file: { fileName: 'x.png',
            directory: { kind: 'standard', root: 'pictures', segments: ['NAI_Blue_Scene', 'nhr-photobooth-v5-draft3-20261122'] } } } }))
        mocks.getRun.mockResolvedValue(deriveGenerationFulfillment({ batchId: 'run-3', queueState: 'completed', jobs: many.map(id => stored(id)) }))
        const bounded = await execute({ runId: 'run-3' })
        const rows = bounded.jobs as { fileName?: string; directory?: unknown }[]
        expect(rows.every(job => job.directory !== undefined)).toBe(true)
        expect(new TextEncoder().encode(JSON.stringify(bounded)).byteLength).toBeLessThanOrEqual(40_000)
        expect(rows.length).toBeLessThan(100)
        expect(bounded).toMatchObject({ truncated: true, jobCount: 150 })
        expect(rows.every((job, index) => job.fileName === longName(index))).toBe(true)
        expect(() => assertAgentPublicValue(bounded)).not.toThrow()
    })

    it('adds the committed portable folder as root and separate segments, never a joined path or bookmark identity', async () => {
        const execute = await getRunHandler()
        const fact = (state: ObservedTechnicalFact['state']): ObservedTechnicalFact => ({ state,
            source: 'fixture', referenceId: 'result', observedAt: '2026-11-22T00:00:00.000Z', kind: 'direct' })
        const stored = (jobId: string) => ({ jobId, queueState: 'succeeded', interpretation: fact('succeeded'), provider: fact('succeeded'),
            storage: fact('succeeded'), release: { policy: 'not-required' as const }, acceptance: { required: false } })
        const folders: Record<string, unknown> = {
            'job-standard': { kind: 'standard', root: 'pictures', segments: ['NAI_Blue_Scene', '나하린 포토부스'], displayPath: 'C:/Users/Private/Pictures/NAI_Blue_Scene' },
            'job-bookmark': { kind: 'bookmark', bookmarkId: 'bookmark-secret-1', segments: ['selected', 'sub'], displayPath: 'D:/Private/selected' },
            'job-nested': { kind: 'standard', root: 'pictures', segments: ['NAI_Blue_Scene', 'sub'] },
            'job-unsafe': { kind: 'standard', root: 'pictures', segments: ['C:/Users/Private'] },
        }
        mocks.getJob.mockImplementation(async (jobId: string) => ({ id: jobId, artifactReference: jobId === 'job-unreferenced' ? null : { artifactId: `artifact:${jobId}` },
            snapshot: { outputReservation: { relativePath: jobId === 'job-nested' ? 'sub/nested_0.png' : `${jobId}.png` } } }))
        mocks.getArtifact.mockImplementation(async (artifactId: string) => {
            const jobId = artifactId.slice('artifact:'.length)
            if (jobId === 'job-failing') throw new Error('store failed')
            return folders[jobId] === undefined ? null : { artifactId, original: { file: { directory: folders[jobId], fileName: jobId === 'job-nested' ? 'nested_0.png' : `${jobId}.png` } } }
        })
        mocks.getRun.mockResolvedValue(deriveGenerationFulfillment({ batchId: 'run-4', queueState: 'completed', jobs: [
            stored('job-standard'), stored('job-bookmark'), stored('job-nested'), stored('job-unsafe'), stored('job-missing'), stored('job-failing'), stored('job-unreferenced'),
        ] }))
        const result = await execute({ runId: 'run-4' })
        const rows = result.jobs as Record<string, unknown>[]
        expect(rows[0]).toMatchObject({ fileName: 'job-standard.png', directory: { root: 'pictures', segments: ['NAI_Blue_Scene', '나하린 포토부스'] } })
        expect(rows[1]).toMatchObject({ directory: { root: 'bookmark', segments: ['selected', 'sub'] } })
        // A subfolder output has no bare reservation name; the committed Artifact supplies it.
        expect(rows[2]).toMatchObject({ fileName: 'nested_0.png', directory: { root: 'pictures', segments: ['NAI_Blue_Scene', 'sub'] } })
        for (const row of rows.slice(3)) expect(row).not.toHaveProperty('directory')
        expect(rows[6]).not.toHaveProperty('artifactId')
        expect(JSON.stringify(result)).not.toMatch(/Private|bookmark-secret|displayPath/)
        expect(() => assertAgentPublicValue(result)).not.toThrow()
    })
})
