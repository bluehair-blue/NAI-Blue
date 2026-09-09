import { describe, expect, it } from 'vitest'
import { deriveGenerationFulfillment, type GenerationFulfillmentJobFacts, type ObservedTechnicalFact } from '@/application/generation/generation-fulfillment'
import { projectGenerationRunStatus, summarizeGenerationRun } from '@/application/generation/generation-run-monitor'
import { assertAgentPublicValue } from '@/application/agent/agent-command-contract'

const fact = (state: ObservedTechnicalFact['state']): ObservedTechnicalFact => ({ state,
    source: 'fixture', referenceId: 'result-1', observedAt: '2026-09-09T00:00:00.000Z', kind: 'direct' })
const job = (overrides: Partial<GenerationFulfillmentJobFacts> = {}): GenerationFulfillmentJobFacts => ({
    jobId: 'job-1', queueState: 'succeeded', interpretation: fact('succeeded'),
    provider: fact('succeeded'), storage: fact('succeeded'), release: { policy: 'not-required' },
    acceptance: { required: false }, ...overrides,
})
const run = (jobs: GenerationFulfillmentJobFacts[], queueState = 'active') =>
    deriveGenerationFulfillment({ batchId: 'run-1', queueState, jobs })

describe('shared production monitoring from durable fulfillment evidence', () => {
    it('never equates a successful Queue or command with a saved image', () => {
        const monitor = summarizeGenerationRun(run([job({ storage: undefined })]))
        expect(monitor).toMatchObject({ complete: false, attention: 'needs-input', nextAction: 'inspect-status',
            counts: { total: 1, generated: 1, stored: 0, fulfilled: 0 } })
        expect(summarizeGenerationRun(run([])).complete).toBe(false)
    })

    it('waits for requested upload and distinguishes technical fulfillment from human acceptance', () => {
        const pending = summarizeGenerationRun(run([job({ release: { policy: 'required', fact: fact('pending') } })]))
        expect(pending).toMatchObject({ complete: false, nextAction: 'wait', counts: { stored: 1, uploaded: 0, uploadRequested: 1 } })
        const delivered = job({ release: { policy: 'required', fact: fact('succeeded') } })
        expect(summarizeGenerationRun(run([delivered]))).toMatchObject({ complete: true, nextAction: 'review-results', counts: { fulfilled: 1, uploaded: 1 } })
        expect(summarizeGenerationRun(run([job({ acceptance: { required: true } })])))
            .toMatchObject({ complete: false, attention: 'needs-input', nextAction: 'inspect-status', counts: { fulfilled: 1 } })
    })

    it('surfaces failed uploads beside successful local output without proposing regeneration', () => {
        const issue = { code: 'R2_DELIVERY_FAILED' as const, jobId: 'job-1', severity: 'warning' as const,
            action: { kind: 'retry-r2-release' as const, requiresHuman: false } }
        const result = summarizeGenerationRun(run([job({ release: { policy: 'best-effort', fact: fact('failed') }, issues: [issue, issue] })]))
        expect(result).toMatchObject({ complete: false, attention: 'error', nextAction: 'review-recovery', counts: { generated: 1, stored: 1, failed: 1 } })
        expect(result.recoveryActions).toEqual([{ kind: 'retry-r2-release', requiresHuman: false, jobCount: 1 }])
    })

    it('keeps uncertain outcomes ahead of a failed sibling and respects deliberate pause/cancel', () => {
        expect(summarizeGenerationRun(run([job({ provider: fact('uncertain') }), job({ jobId: 'job-2', queueState: 'failed' })])))
            .toMatchObject({ complete: false, attention: 'needs-input', nextAction: 'review-uncertain-result', counts: { uncertain: 1, failed: 1 } })
        expect(summarizeGenerationRun(run([job({ queueState: 'queued', storage: fact('pending'), provider: undefined })], 'paused')))
            .toMatchObject({ complete: false, attention: null, nextAction: 'resume-in-app' })
        expect(summarizeGenerationRun(run([job({ queueState: 'cancelled' }), job({ jobId: 'job-2', queueState: 'skipped' })])))
            .toMatchObject({ complete: false, nextAction: 'inspect-status', counts: { cancelled: 1, skipped: 1, fulfilled: 0 } })
    })

    it('versions meaningful job state, ignoring timestamps/order but retaining the identity of a failed sibling', () => {
        const a = job({ jobId: 'a', queueState: 'failed' }), b = job({ jobId: 'b' })
        const version = summarizeGenerationRun(run([a, b])).stateHash
        const newer = { ...fact('succeeded'), observedAt: '2026-09-09T02:00:00.000Z' }
        expect(summarizeGenerationRun(run([{ ...b, storage: newer }, a])).stateHash).toBe(version)
        expect(summarizeGenerationRun(run([{ ...a, queueState: 'succeeded' }, { ...b, queueState: 'failed' }])).stateHash).not.toBe(version)
    })

    it('aggregates all 2400 read facts while keeping the agent response bounded and public', () => {
        const projection = run(Array.from({ length: 2400 }, (_, i) => job({ jobId: `job-${i}` })))
        const result = projectGenerationRunStatus(projection)
        expect(result).toMatchObject({ found: true, jobCount: 2400, truncated: true,
            monitor: { complete: true, counts: { total: 2400, generated: 2400, stored: 2400, fulfilled: 2400 } } })
        expect(result.jobs).toHaveLength(100)
        expect(() => assertAgentPublicValue(result)).not.toThrow()
        expect(JSON.stringify(result)).not.toContain('observedAt')
    })

    it('transports uncertainty and every existing recovery action through the unchanged public scanner', () => {
        for (const kind of ['replan', 'grant-directory-access', 'retry-storage', 'retry-scene-link', 'retry-r2-release',
            'abandon-reservation', 'discard-result-and-abandon-reservation', 'review-provider-unknown'] as const) {
            const projection = run([job({ provider: fact('uncertain'), issues: [{ code: 'OUTPUT_RESERVATION_CONFLICT',
                jobId: 'job-1', severity: 'blocking', action: { kind, requiresHuman: true } }] })])
            expect(() => assertAgentPublicValue(projectGenerationRunStatus(projection)), kind).not.toThrow()
        }
    })
})
