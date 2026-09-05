import { describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_EXECUTION_POLICY as defaults, effectiveAgentExecutionPolicy,
    normalizeAgentExecutionPolicy, updateAgentExecutionPolicy, validateAgentExecutionPolicy } from '@/application/agent/agent-execution-policy'

const now = Date.parse('2026-09-05T10:00:00.000Z')
describe('human execution policy authority', () => {
    it('defaults missing authority to suggest and rejects malformed authority without granting permissions', () => {
        expect(normalizeAgentExecutionPolicy(undefined)).toEqual(defaults)
        for (const invalid of [null, {}, { ...defaults, unknown: true }, { ...defaults, revision: -1 },
            { ...defaults, generation: { ...defaults.generation, maxConcurrentJobs: 3 } },
            { ...defaults, generation: { ...defaults.generation, maxImagesPerRun: 1.5 } },
            { ...defaults, output: { ...defaults.output, allowOverwrite: true } },
            { ...defaults, r2: { ...defaults.r2, allowOverwrite: true } },
            { ...defaults, rollingLimits: { ...defaults.rollingLimits, maxAnlasPerDay: Infinity } },
            { ...defaults, generation: { ...defaults.generation, allowedCompatibilityStatuses: ['unchecked'] } },
            { ...defaults, mode: 'bounded-auto' },
        ]) {
            expect(validateAgentExecutionPolicy(invalid)).toBe(false)
            expect(normalizeAgentExecutionPolicy(invalid)).toMatchObject({ mode: 'observe', globalPause: true })
        }
    })
    it('increments revisions, rejects stale reviews, and bounds explicit automatic grants', () => {
        const next = { ...defaults, mode: 'bounded-auto' as const, boundedAutoExpiresAt: new Date(now + 60_000).toISOString() }
        const saved = updateAgentExecutionPolicy(defaults, 0, next, now)
        expect(saved.revision).toBe(1)
        expect(() => updateAgentExecutionPolicy(saved, 0, next, now)).toThrow('revision changed')
        for (const expiry of [now, now - 1, now + 24 * 60 * 60 * 1_000 + 1]) {
            expect(() => updateAgentExecutionPolicy(defaults, 0, { ...next, boundedAutoExpiresAt: new Date(expiry).toISOString() }, now)).toThrow('24 hours')
        }
    })
    it('rechecks expiry and global pause after persisted policy hydration', () => {
        const stored = { ...defaults, mode: 'bounded-auto' as const, boundedAutoExpiresAt: new Date(now + 60_000).toISOString() }
        const hydrated = normalizeAgentExecutionPolicy(JSON.parse(JSON.stringify(stored)))
        expect(effectiveAgentExecutionPolicy(hydrated, now).mode).toBe('bounded-auto')
        expect(effectiveAgentExecutionPolicy(hydrated, now + 60_000).mode).toBe('suggest')
        expect(effectiveAgentExecutionPolicy({ ...hydrated, globalPause: true }, now).mode).toBe('suggest')
        expect(effectiveAgentExecutionPolicy({ ...hydrated, mode: 'observe', globalPause: true }, now).mode).toBe('observe')
    })
})
