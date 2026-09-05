import { describe, expect, it } from 'vitest'
import {
    createAssessmentRequirement,
    deriveHumanAssessmentDecision,
    latestArtifactAssessments,
    parseAssessmentRequirement,
    parseIntentAssessmentEvent,
    parseIntentAssessmentRunBinding,
    projectRunAcceptance,
    validateIntentAssessmentEvent,
    type HumanIntentAssessmentEventV1,
    type HumanRunAssessmentDecisionEventV1,
    type IntentAssessmentRunBinding,
} from '@/domain/assessment/intent-assessment'
import { parseVisualRubric } from '@/domain/assessment/visual-rubric'

const rubric = {
    rubricId: 'character-portrait', version: 1,
    hardConstraints: [{ criterionId: 'identity', label: 'Correct character' }],
    softCriteria: [{ criterionId: 'composition', label: 'Composition', weight: 1 }],
    acceptanceThreshold: 80,
}
const binding: IntentAssessmentRunBinding = {
    runId: 'run-1', planHash: `sha256:${'a'.repeat(64)}`,
    requirement: createAssessmentRequirement(rubric, 2),
}
const candidates = ['artifact-1', 'artifact-2']
const pass = [{ criterionId: 'identity', result: 'pass' as const }]
function event(overrides: Partial<HumanIntentAssessmentEventV1> = {}): HumanIntentAssessmentEventV1 {
    return {
        schemaVersion: 1, type: 'artifact-assessment', assessmentId: 'assessment-1',
        runId: binding.runId, planHash: binding.planHash, artifactId: 'artifact-1',
        rubricId: rubric.rubricId, rubricVersion: rubric.version, rubricHash: binding.requirement.rubricHash,
        evaluator: { kind: 'human', actorId: 'local-user' }, hardConstraintResults: pass,
        softScore: 90, decision: 'accepted', supersedesAssessmentId: null,
        createdAt: '2026-09-05T00:00:00.000Z', ...overrides,
    }
}
const close: HumanRunAssessmentDecisionEventV1 = {
    schemaVersion: 1, type: 'run-decision', assessmentId: 'close-1', runId: binding.runId,
    planHash: binding.planHash, evaluator: { kind: 'human', actorId: 'local-user' },
    decision: 'close-as-rejected', createdAt: '2026-09-05T00:01:00.000Z',
}

describe('immutable assessment rubric and strict human schema', () => {
    it('hashes canonical snapshots and rejects hash, count, binding and snapshot tampering', () => {
        const reordered = { acceptanceThreshold: 80, softCriteria: rubric.softCriteria,
            hardConstraints: rubric.hardConstraints, version: 1, rubricId: rubric.rubricId }
        expect(createAssessmentRequirement(reordered, 2)).toEqual(binding.requirement)
        expect(parseAssessmentRequirement(JSON.parse(JSON.stringify(binding.requirement)))).toEqual(binding.requirement)
        expect(parseIntentAssessmentRunBinding(binding)).toEqual(binding)
        expect(() => parseAssessmentRequirement({ ...binding.requirement, rubricHash: `sha256:${'b'.repeat(64)}` })).toThrow(TypeError)
        expect(() => parseAssessmentRequirement({ ...binding.requirement, extra: true })).toThrow(TypeError)
        expect(() => parseIntentAssessmentRunBinding({ ...binding, extra: true })).toThrow(TypeError)
        for (const count of [0, -1, 1.5, NaN, Infinity]) expect(() => createAssessmentRequirement(rubric, count)).toThrow(TypeError)
    })

    it('rejects duplicate IDs, empty rubrics, invalid scores, weights and unknown nested fields', () => {
        for (const invalid of [
            { ...rubric, version: 0 }, { ...rubric, acceptanceThreshold: 101 },
            { ...rubric, hardConstraints: [], softCriteria: [] },
            { ...rubric, softCriteria: [{ ...rubric.softCriteria[0], criterionId: 'identity' }] },
            { ...rubric, softCriteria: [{ ...rubric.softCriteria[0], weight: 0 }] },
            { ...rubric, softCriteria: [{ ...rubric.softCriteria[0], weight: Infinity }] },
            { ...rubric, hardConstraints: [{ ...rubric.hardConstraints[0], confidence: 1 }] },
        ]) expect(() => parseVisualRubric(invalid)).toThrow(TypeError)
    })

    it('rejects agent/hybrid, model and confidence fields at all V1 trust boundaries', () => {
        for (const invalid of [
            { ...event(), evaluator: { kind: 'agent', actorId: 'agent' } },
            { ...event(), evaluator: { kind: 'hybrid', actorId: 'agent' } },
            { ...event(), evaluator: { kind: 'human', actorId: 'user', modelId: 'vision' } },
            { ...event(), modelId: 'vision' }, { ...event(), confidence: 1 },
            { ...event(), hardConstraintResults: [{ ...pass[0], confidence: 1 }] },
            { ...event(), schemaVersion: 2 }, { ...event(), softScore: NaN },
            { ...event(), softScore: 101 }, { ...event(), createdAt: '2026-02-30T00:00:00.000Z' },
            { ...event(), explanationSummary: 'x'.repeat(2001) },
            { ...event(), supersedesAssessmentId: 'assessment-1' },
        ]) expect(() => parseIntentAssessmentEvent(invalid)).toThrow(TypeError)
        expect(parseIntentAssessmentEvent(event())).toEqual(event())
        expect(parseIntentAssessmentEvent(close)).toEqual(close)
    })

    it('enforces hard-first scoring and exact criterion coverage against immutable bindings', () => {
        const fail = [{ criterionId: 'identity', result: 'fail' as const }]
        expect(deriveHumanAssessmentDecision(rubric, fail, 100)).toBe('rejected')
        expect(deriveHumanAssessmentDecision(rubric, pass, 79)).toBe('rejected')
        expect(deriveHumanAssessmentDecision(rubric, pass, 80)).toBe('accepted')
        expect(deriveHumanAssessmentDecision(rubric, pass, null)).toBe('needs-review')
        expect(deriveHumanAssessmentDecision(rubric, [{ criterionId: 'identity', result: 'needs-review' }], 100)).toBe('needs-review')
        const hardOnly = { ...rubric, softCriteria: [] }
        expect(deriveHumanAssessmentDecision(hardOnly, pass, null)).toBe('accepted')
        expect(() => deriveHumanAssessmentDecision(hardOnly, pass, 100)).toThrow(TypeError)
        for (const invalid of [
            event({ hardConstraintResults: fail }), event({ hardConstraintResults: [] }),
            event({ hardConstraintResults: [...pass, ...pass] }),
            event({ rubricVersion: 2 }), event({ rubricHash: `sha256:${'b'.repeat(64)}` }),
            event({ runId: 'other' }), event({ planHash: `sha256:${'c'.repeat(64)}` }),
            event({ artifactId: 'foreign' }),
        ]) expect(() => validateIntentAssessmentEvent(invalid, binding, candidates)).toThrow(TypeError)
    })
})

describe('distinct-candidate, append-only acceptance projection', () => {
    it('requires enough distinct accepted candidates, and explicit human close for rejection', () => {
        const second = event({ assessmentId: 'assessment-2', artifactId: 'artifact-2' })
        expect(projectRunAcceptance(binding, candidates, []).state).toBe('not-evaluated')
        const partial = projectRunAcceptance(binding, [...candidates, 'artifact-1'], [event(), event()])
        expect(partial.state).toBe('needs-review')
        expect(partial.candidateArtifactIds).toEqual(candidates)
        expect(partial.acceptedArtifactIds).toEqual(['artifact-1'])
        expect(projectRunAcceptance(binding, [...candidates, 'surplus'], [event(), second]).state).toBe('accepted')
        expect(projectRunAcceptance(binding, candidates, [event({ softScore: 0, decision: 'rejected' })]).state).toBe('needs-review')
        expect(projectRunAcceptance(binding, candidates, [event(), second, close]).state).toBe('rejected')
        expect(projectRunAcceptance(binding, candidates, [{ ...close, runId: 'foreign' }]).state).toBe('needs-review')
    })

    it('uses superseding links despite late ancestors, duplicate deliveries, or misleading timestamps', () => {
        const root = event()
        const rejected = event({ assessmentId: 'revision-2', supersedesAssessmentId: root.assessmentId, softScore: 10, decision: 'rejected', createdAt: '2026-09-04T00:00:00.000Z' })
        const corrected = event({ assessmentId: 'revision-3', supersedesAssessmentId: rejected.assessmentId })
        const projected = projectRunAcceptance(binding, candidates, [corrected, rejected, root, root])
        expect(projected.latestAssessmentIds).toEqual(['revision-3'])
        expect(projected.acceptedArtifactIds).toEqual(['artifact-1'])
        expect(latestArtifactAssessments(binding, candidates, [rejected, root]).get('artifact-1')).toEqual(rejected)
        expect(root.decision).toBe('accepted')
    })

    it('retains the latest artifact evidence alongside explicit close provenance', () => {
        const corrected = event({ assessmentId: 'revision-2', supersedesAssessmentId: 'assessment-1' })
        const projection = projectRunAcceptance(binding, candidates, [event(), corrected, close, close])
        expect(projection).toMatchObject({
            state: 'rejected', acceptedArtifactIds: ['artifact-1'],
            latestAssessmentIds: ['revision-2', 'close-1'],
        })
        expect(projectRunAcceptance(binding, candidates, [close]).latestAssessmentIds).toEqual(['close-1'])
        expect(projectRunAcceptance(binding, candidates, [event(), { ...close, runId: 'foreign' }]).latestAssessmentIds).toEqual(['assessment-1'])
    })

    it('fails closed on forks, missing ancestors, disconnected cycles, conflicting IDs and separate roots', () => {
        const revision = event({ assessmentId: 'revision-2', supersedesAssessmentId: 'assessment-1' })
        for (const history of [
            [revision],
            [event(), event({ assessmentId: 'root-2' })],
            [event(), revision, event({ assessmentId: 'fork', supersedesAssessmentId: 'assessment-1' })],
            [event(), event({ assessmentId: 'cycle-1', supersedesAssessmentId: 'cycle-2' }), event({ assessmentId: 'cycle-2', supersedesAssessmentId: 'cycle-1' })],
            [event(), event({ softScore: 0, decision: 'rejected' })],
            [event(), event({ assessmentId: 'bad', hardConstraintResults: [] })],
        ]) {
            const projection = projectRunAcceptance(binding, candidates, history)
            expect(projection.acceptedArtifactIds).toEqual([])
            expect(projection.latestAssessmentIds).toEqual([])
            expect(projection.state).toBe('needs-review')
        }
    })

    it('cannot reuse an assessment ID or a supersedes link across distinct artifacts', () => {
        expect(projectRunAcceptance(binding, candidates, [event(), event({ artifactId: 'artifact-2' })]).acceptedArtifactIds).toEqual([])
        const crossArtifact = event({ assessmentId: 'assessment-2', artifactId: 'artifact-2', supersedesAssessmentId: 'assessment-1' })
        expect(projectRunAcceptance(binding, candidates, [event(), crossArtifact]).acceptedArtifactIds).toEqual(['artifact-1'])
    })
})
