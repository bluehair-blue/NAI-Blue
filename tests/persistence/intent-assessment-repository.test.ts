import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IndexedDbIntentAssessmentRepository, intentAssessmentStorageKey } from '@/adapters/assessment/indexeddb-intent-assessment-repository'
import { createAssessmentRequirement, type HumanIntentAssessmentEventV1, type IntentAssessmentRunBinding } from '@/domain/assessment/intent-assessment'
import { resetIndexedDBConnectionForRetry, setIndexedDBItemStrict } from '@/lib/indexed-db'

function fixture() {
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

beforeEach(() => {
    resetIndexedDBConnectionForRetry()
    vi.stubGlobal('indexedDB', new IDBFactory())
})
afterEach(() => { resetIndexedDBConnectionForRetry(); vi.unstubAllGlobals() })

describe('durable append-only intent assessment', () => {
    it('restores full binding and events after a physical database close and reopen', async () => {
        const { binding, event } = fixture()
        const repository = new IndexedDbIntentAssessmentRepository()
        await repository.append(binding, event)
        await repository.append(binding, event)
        await expect(repository.append(binding, { ...event, explanationSummary: 'conflicting content' })).rejects.toThrow(/collision/)
        resetIndexedDBConnectionForRetry()
        expect(await new IndexedDbIntentAssessmentRepository().read(binding.runId)).toEqual({ binding, events: [event] })
    })

    it('serializes concurrent new artifacts and rejects superseding forks', async () => {
        const { binding, event } = fixture()
        const first = new IndexedDbIntentAssessmentRepository()
        const second = new IndexedDbIntentAssessmentRepository()
        await Promise.all([
            first.append(binding, event),
            second.append(binding, { ...event, assessmentId: 'assessment:2', artifactId: 'artifact:2' }),
        ])
        const attempts = await Promise.allSettled([
            first.append(binding, { ...event, assessmentId: 'correction:1', supersedesAssessmentId: event.assessmentId }),
            second.append(binding, { ...event, assessmentId: 'correction:2', supersedesAssessmentId: event.assessmentId }),
        ])
        expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1)
        expect((await first.read(binding.runId))?.events).toHaveLength(3)
    })

    it('rejects changed binding, closes terminally, and preserves exact replay after close', async () => {
        const { binding, event } = fixture()
        const repository = new IndexedDbIntentAssessmentRepository()
        await repository.append(binding, event)
        await expect(repository.append({ ...binding, requirement: { ...binding.requirement, requiredAcceptedCount: 3 } }, event)).rejects.toThrow(/binding changed/)
        await repository.append(binding, { schemaVersion: 1, type: 'run-decision', assessmentId: 'close:1', runId: binding.runId,
            planHash: binding.planHash, evaluator: event.evaluator, decision: 'close-as-rejected', createdAt: event.createdAt })
        await repository.append(binding, event)
        await expect(repository.append(binding, { ...event, assessmentId: 'late', artifactId: 'artifact:2' })).rejects.toThrow(/closed/)
    })

    it('fails closed on corrupt persisted data and storage faults', async () => {
        const { binding, event } = fixture()
        await setIndexedDBItemStrict(intentAssessmentStorageKey(binding.runId), JSON.stringify({ schemaVersion: 1, binding, events: [{ ...event, evaluator: { kind: 'agent', actorId: 'forged' } }] }))
        const repository = new IndexedDbIntentAssessmentRepository()
        await expect(repository.read(binding.runId)).rejects.toThrow()
        await expect(repository.append(binding, event)).rejects.toThrow()
        const fault = new Error('storage unavailable')
        const failing = new IndexedDbIntentAssessmentRepository({ getItem: async () => null, compareAndSet: async () => { throw fault } })
        await expect(failing.append(binding, event)).rejects.toBe(fault)
        const stale = new IndexedDbIntentAssessmentRepository({ getItem: async () => null, compareAndSet: async () => false })
        await expect(stale.append(binding, event)).rejects.toThrow(/three attempts/)
    })
})
