import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IndexedDbIntentAssessmentRepository } from '@/adapters/assessment/indexeddb-intent-assessment-repository'
import { recordArenaWin } from '@/application/style-lab/record-preference'
import { recordMarketAction } from '@/application/style-lab/record-market-action'
import { createAssessmentRequirement, projectRunAcceptance, type IntentAssessmentRunBinding } from '@/domain/assessment/intent-assessment'
import { createStyleEvaluationContext } from '@/domain/style-lab'
import { flushAllPendingWrites, resetIndexedDBConnectionForRetry } from '@/lib/indexed-db'
import { IndexedDbStyleLabRepository } from '@/services/style-lab/indexeddb-style-lab-repository'

beforeEach(() => {
    resetIndexedDBConnectionForRetry()
    vi.stubGlobal('indexedDB', new IDBFactory())
})
afterEach(async () => {
    await flushAllPendingWrites()
    resetIndexedDBConnectionForRetry()
    vi.unstubAllGlobals()
})

it('keeps human intent evidence and acceptance unchanged after Style Lab preference and undo', async () => {
    // Both real adapters share the same IndexedDB database, with independent authority keys.
    const intent = new IndexedDbIntentAssessmentRepository()
    const style = new IndexedDbStyleLabRepository()
    const binding: IntentAssessmentRunBinding = {
        runId: 'isolation:run', planHash: `sha256:${'a'.repeat(64)}`,
        requirement: createAssessmentRequirement({ rubricId: 'isolation:rubric', version: 1,
            hardConstraints: [{ criterionId: 'subject', label: 'Subject present' }],
            softCriteria: [], acceptanceThreshold: 80 }, 1),
    }
    await intent.append(binding, {
        schemaVersion: 1, type: 'artifact-assessment', assessmentId: 'isolation:assessment',
        runId: binding.runId, planHash: binding.planHash, artifactId: 'left',
        rubricId: binding.requirement.rubric.rubricId, rubricVersion: 1, rubricHash: binding.requirement.rubricHash,
        evaluator: { kind: 'human', actorId: 'user:1' }, hardConstraintResults: [{ criterionId: 'subject', result: 'pass' }],
        softScore: null, decision: 'accepted', supersedesAssessmentId: null, createdAt: '2026-09-05T00:00:00.000Z',
    })
    const before = await intent.read(binding.runId)
    if (before === null) throw new Error('Intent fixture did not persist')
    const projection = projectRunAcceptance(binding, ['left'], before.events)
    expect(projection.state).toBe('accepted')
    const assertUnchanged = async () => {
        await flushAllPendingWrites()
        const after = await intent.read(binding.runId)
        expect(after).toEqual(before)
        expect(projectRunAcceptance(binding, ['left'], after!.events)).toEqual(projection)
    }

    const candidates = [{ id: 'left' }, { id: 'right' }]
    const context = createStyleEvaluationContext({ prompt: { base: 'portrait' }, plan: { model: 'model' },
        model: 'model', sampler: 'sampler', seedPack: [7], createdAt: 1 })
    const win = await recordArenaWin({ candidates, winnerId: 'right', loserId: 'left', context, repository: style, now: 2 })
    expect(win.projections.find(item => item.comboId === 'right')!.mu)
        .toBeGreaterThan(win.projections.find(item => item.comboId === 'left')!.mu)
    await assertUnchanged()

    const toggle = { candidates, action: 'like' as const, comboId: 'right', boardId: 'board:1', repository: style }
    const like = await recordMarketAction({ ...toggle, now: 3 })
    expect(like.toggledOn).toBe(true)
    await assertUnchanged()
    const undo = await recordMarketAction({ ...toggle, now: 4 })
    expect(undo.event.action).toBe('undo')
    expect(undo.event.supersedesId).toBe(like.event.id)
    expect(undo.interactions.likedIds.size).toBe(0)
    expect((await style.listPreferenceEvents()).map(event => event.action)).toEqual(['pair-win', 'like', 'undo'])
    await assertUnchanged()

    resetIndexedDBConnectionForRetry()
    expect(await new IndexedDbIntentAssessmentRepository().read(binding.runId)).toEqual(before)
})
