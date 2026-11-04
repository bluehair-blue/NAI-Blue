import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import type { AgentCommandHandler } from '@/application/agent/runtime-capability-registry'
import { deriveGenerationFulfillment } from '@/application/generation/generation-fulfillment'

const mocks = vi.hoisted(() => ({ getRun: vi.fn(), inspect: vi.fn() }))
vi.mock('@/adapters/generation/indexeddb-generation-run-reader', async importOriginal => ({
    ...await importOriginal<object>(), getRuntimeGenerationRun: mocks.getRun,
}))
vi.mock('@/composition-root/agent-generation-recovery-inspection', () => ({ inspectGenerationRecovery: mocks.inspect }))
vi.mock('@/adapters/workflow/indexeddb-workflow-draft-repository', () => ({
    getWorkflowDraftRepository: () => ({ list: async () => [] }),
}))

describe('installed runtime get_run handler wiring', () => {
    it('adds inspection only for an explicitly selected job in the read run', async () => {
        const { runtimeAgentCommands } = await import('@/composition-root/runtime-agent-commands')
        // Exercise the registered production handler without starting an app owner or opening private storage.
        const factory = (runtimeAgentCommands as unknown as { dependencies: {
            createHandlers(workspaceId: string): Promise<readonly AgentCommandHandler[]>
        } }).dependencies.createHandlers
        const handler = (await factory('workspace-1')).find(item => item.command === 'generation.get_run')!
        const run = deriveGenerationFulfillment({ batchId: 'run-1', queueState: 'active', jobs: [
            { jobId: 'job-23', queueState: 'blocked', release: { policy: 'not-required' }, acceptance: { required: false } },
        ] })
        mocks.getRun.mockResolvedValue(run)
        mocks.inspect.mockResolvedValue({ found: true, attempt: { providerOutcome: 'unknown' },
            recovery: { localOutputVerified: false } })
        const execute = (input: { runId: string; jobId?: string }) => handler.execute(handler.validate(input), {} as never)
        expect(await execute({ runId: 'run-1' })).not.toHaveProperty('recoveryInspection')
        expect(await execute({ runId: 'run-1', jobId: 'missing' })).toMatchObject({ requestedJobFound: false, jobs: [] })
        expect(mocks.inspect).not.toHaveBeenCalled()
        expect(await execute({ runId: 'run-1', jobId: 'job-23' })).toMatchObject({ requestedJobFound: true,
            jobs: [{ jobId: 'job-23' }], recoveryInspection: { attempt: { providerOutcome: 'unknown' } } })
        expect(mocks.inspect).toHaveBeenCalledExactlyOnceWith('run-1', 'job-23')
        mocks.getRun.mockResolvedValue(null)
        expect(await execute({ runId: 'missing', jobId: 'job-23' })).toEqual({ found: false })
    })
})
