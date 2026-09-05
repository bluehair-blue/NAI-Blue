import { describe, expect, it, vi } from 'vitest'
import { recordIntentAssessment } from '@/application/assessment/record-intent-assessment'
import { IndexedDbIntentAssessmentRepository } from '@/adapters/assessment/indexeddb-intent-assessment-repository'
import { createAssessmentRequirement, type HumanIntentAssessmentEventV1, type IntentAssessmentRunBinding } from '@/domain/assessment/intent-assessment'

export function assessmentFixture() {
    const binding: IntentAssessmentRunBinding = {
        runId: 'run:1', planHash: `sha256:${'a'.repeat(64)}`,
        requirement: createAssessmentRequirement({ rubricId: 'rubric:1', version: 1,
            hardConstraints: [{ criterionId: 'subject', label: 'Subject present' }],
            softCriteria: [], acceptanceThreshold: 80 }, 2),
    }
    const event: HumanIntentAssessmentEventV1 = {
        schemaVersion: 1, type: 'artifact-assessment', assessmentId: 'assessment:1',
        runId: binding.runId, planHash: binding.planHash, artifactId: 'artifact:1',
        rubricId: 'rubric:1', rubricVersion: 1, rubricHash: binding.requirement.rubricHash,
        evaluator: { kind: 'human', actorId: 'user:1' }, hardConstraintResults: [{ criterionId: 'subject', result: 'pass' }],
        softScore: null, decision: 'accepted', supersedesAssessmentId: null, createdAt: '2026-09-05T00:00:00.000Z',
    }
    return { binding, event }
}

function repository() {
    const data = new Map<string, string>()
    return new IndexedDbIntentAssessmentRepository({
        getItem: async key => data.get(key) ?? null,
        compareAndSet: async (key, expected, next) => {
            if ((data.get(key) ?? null) !== expected) return false
            data.set(key, next)
            return true
        },
    })
}

describe('human intent assessment use case', () => {
    it('records only authoritative run candidates and returns distinct acceptance', async () => {
        const { binding, event } = assessmentFixture()
        const ports = { repository: repository(), readRun: async () => ({ binding, candidateArtifactIds: ['artifact:1', 'artifact:2', 'artifact:1'] }) }
        expect((await recordIntentAssessment(event, { kind: 'user', id: 'user:1' }, ports)).state).toBe('needs-review')
        expect((await recordIntentAssessment({ ...event, assessmentId: 'assessment:2', artifactId: 'artifact:2' }, { kind: 'user', id: 'user:1' }, ports)).state).toBe('accepted')
        await expect(recordIntentAssessment({ ...event, artifactId: 'foreign' }, { kind: 'user', id: 'user:1' }, ports)).rejects.toThrow()
        await expect(recordIntentAssessment({ ...event, planHash: `sha256:${'b'.repeat(64)}` }, { kind: 'user', id: 'user:1' }, ports)).rejects.toThrow()
    })

    it('rejects external actors and forged user attribution before persistence', async () => {
        const { binding, event } = assessmentFixture()
        const append = vi.fn()
        const ports = { repository: { read: async () => null, append }, readRun: async () => ({ binding, candidateArtifactIds: ['artifact:1'] }) }
        for (const kind of ['agent', 'system', 'service'] as const) {
            await expect(recordIntentAssessment(event, { kind, id: 'user:1' }, ports)).rejects.toThrow(/local user/)
        }
        await expect(recordIntentAssessment(event, { kind: 'user', id: 'another-user' }, ports)).rejects.toThrow(/actor/)
        expect(append).not.toHaveBeenCalled()
    })

    it('does not report success when the recorded event is absent from readback', async () => {
        const { binding, event } = assessmentFixture()
        await expect(recordIntentAssessment(event, { kind: 'user', id: 'user:1' }, {
            repository: { append: async () => undefined, read: async () => ({ binding, events: [] }) },
            readRun: async () => ({ binding, candidateArtifactIds: [event.artifactId] }),
        })).rejects.toThrow(/read back/)
    })
})
