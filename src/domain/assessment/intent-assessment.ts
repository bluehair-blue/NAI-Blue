import { canonicalSerialize } from '@/domain/composition/canonical-serialize'
import { parseAssessmentRequirement, parseVisualRubric, type GenerationAssessmentRequirement, type VisualRubric } from './visual-rubric'

export { createAssessmentRequirement, parseAssessmentRequirement } from './visual-rubric'
export type { GenerationAssessmentRequirement, VisualRubric } from './visual-rubric'

export interface CriterionResult {
    readonly criterionId: string
    readonly result: 'pass' | 'fail' | 'needs-review'
}

export interface IntentAssessmentRunBinding {
    readonly runId: string
    readonly planHash: `sha256:${string}`
    readonly requirement: GenerationAssessmentRequirement
}

interface HumanAssessmentEventBase {
    readonly schemaVersion: 1
    readonly assessmentId: string
    readonly runId: string
    readonly planHash: `sha256:${string}`
    readonly evaluator: { readonly kind: 'human'; readonly actorId: string }
    readonly explanationSummary?: string
    readonly createdAt: string
}

export interface HumanIntentAssessmentEventV1 extends HumanAssessmentEventBase {
    readonly type: 'artifact-assessment'
    readonly artifactId: string
    readonly rubricId: string
    readonly rubricVersion: number
    readonly rubricHash: `sha256:${string}`
    readonly hardConstraintResults: readonly CriterionResult[]
    readonly softScore: number | null
    readonly decision: 'accepted' | 'rejected' | 'needs-review'
    readonly supersedesAssessmentId: string | null
}

export interface HumanRunAssessmentDecisionEventV1 extends HumanAssessmentEventBase {
    readonly type: 'run-decision'
    readonly decision: 'close-as-rejected'
}

export type IntentAssessmentEvent = HumanIntentAssessmentEventV1 | HumanRunAssessmentDecisionEventV1

export interface RunAcceptanceProjection {
    readonly runId: string
    readonly planHash: `sha256:${string}`
    readonly requiredAcceptedCount: number
    readonly candidateArtifactIds: readonly string[]
    readonly acceptedArtifactIds: readonly string[]
    readonly latestAssessmentIds: readonly string[]
    readonly state: 'not-evaluated' | 'needs-review' | 'accepted' | 'rejected'
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !keys.includes(key))) {
        throw new TypeError('Invalid assessment object or unknown field.')
    }
    return value as Record<string, unknown>
}

function identifier(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f]/u.test(value)) {
        throw new TypeError('Assessment identifier must be nonempty and bounded.')
    }
    return value
}

function hash(value: unknown): `sha256:${string}` {
    if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) throw new TypeError('Invalid assessment hash.')
    return value as `sha256:${string}`
}

export function parseIntentAssessmentRunBinding(value: unknown): IntentAssessmentRunBinding {
    const input = record(value, ['runId', 'planHash', 'requirement'])
    return Object.freeze({
        runId: identifier(input.runId),
        planHash: hash(input.planHash),
        requirement: parseAssessmentRequirement(input.requirement),
    })
}

function results(value: unknown): readonly CriterionResult[] {
    if (!Array.isArray(value) || value.length > 100) throw new TypeError('Invalid hard constraint results.')
    const ids = new Set<string>()
    return value.map(raw => {
        const entry = record(raw, ['criterionId', 'result'])
        const criterionId = identifier(entry.criterionId)
        if (ids.has(criterionId) || typeof entry.result !== 'string' || !['pass', 'fail', 'needs-review'].includes(entry.result)) {
            throw new TypeError('Invalid or duplicate criterion result.')
        }
        ids.add(criterionId)
        return { criterionId, result: entry.result as CriterionResult['result'] }
    })
}

function score(value: unknown): number | null {
    if (value === null) return null
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
        throw new TypeError('Soft score must be null or a number from 0 to 100.')
    }
    return value
}

/** V1 accepts only human facts; schema extensions cannot silently enter through extras. */
export function parseIntentAssessmentEvent(value: unknown): IntentAssessmentEvent {
    const commonKeys = ['schemaVersion', 'type', 'assessmentId', 'runId', 'planHash', 'evaluator', 'decision', 'explanationSummary', 'createdAt']
    const type = value && typeof value === 'object' ? (value as Record<string, unknown>).type : undefined
    const input = record(value, type === 'artifact-assessment'
        ? [...commonKeys, 'artifactId', 'rubricId', 'rubricVersion', 'rubricHash', 'hardConstraintResults', 'softScore', 'supersedesAssessmentId']
        : commonKeys)
    const evaluator = record(input.evaluator, ['kind', 'actorId'])
    if (input.schemaVersion !== 1 || evaluator.kind !== 'human'
        || typeof input.createdAt !== 'string' || !Number.isFinite(Date.parse(input.createdAt))
        || new Date(input.createdAt).toISOString() !== input.createdAt) {
        throw new TypeError('Unsupported assessment version, evaluator, or timestamp.')
    }
    if (input.explanationSummary !== undefined && (typeof input.explanationSummary !== 'string'
        || input.explanationSummary.length > 2000 || input.explanationSummary.includes('\0'))) {
        throw new TypeError('Assessment summary must be bounded text.')
    }
    const base: HumanAssessmentEventBase = {
        schemaVersion: 1,
        assessmentId: identifier(input.assessmentId),
        runId: identifier(input.runId),
        planHash: hash(input.planHash),
        evaluator: { kind: 'human', actorId: identifier(evaluator.actorId) },
        ...(input.explanationSummary === undefined ? {} : { explanationSummary: input.explanationSummary as string }),
        createdAt: input.createdAt,
    }
    if (type === 'run-decision' && input.decision === 'close-as-rejected') {
        return { ...base, type, decision: 'close-as-rejected' }
    }
    if (type !== 'artifact-assessment' || !Number.isSafeInteger(input.rubricVersion) || Number(input.rubricVersion) < 1
        || typeof input.decision !== 'string' || !['accepted', 'rejected', 'needs-review'].includes(input.decision)) {
        throw new TypeError('Invalid assessment type, rubric version, or decision.')
    }
    const supersedesAssessmentId = input.supersedesAssessmentId === null ? null : identifier(input.supersedesAssessmentId)
    if (supersedesAssessmentId === base.assessmentId) throw new TypeError('An assessment cannot supersede itself.')
    return {
        ...base, type,
        artifactId: identifier(input.artifactId),
        rubricId: identifier(input.rubricId),
        rubricVersion: input.rubricVersion as number,
        rubricHash: hash(input.rubricHash),
        hardConstraintResults: results(input.hardConstraintResults),
        softScore: score(input.softScore),
        decision: input.decision as HumanIntentAssessmentEventV1['decision'],
        supersedesAssessmentId,
    }
}

/** Hard failures dominate aesthetics; incomplete human review never implies acceptance. */
export function deriveHumanAssessmentDecision(
    rubric: VisualRubric,
    hardConstraintResults: readonly CriterionResult[],
    softScore: number | null,
): HumanIntentAssessmentEventV1['decision'] {
    const snapshot = parseVisualRubric(rubric)
    const checked = results(hardConstraintResults)
    const soft = score(softScore)
    const expected = new Set(snapshot.hardConstraints.map(item => item.criterionId))
    if (checked.length !== expected.size || checked.some(item => !expected.has(item.criterionId))) {
        throw new TypeError('Every hard constraint requires exactly one result.')
    }
    if (snapshot.softCriteria.length === 0 && soft !== null) throw new TypeError('Hard-only rubrics require a null soft score.')
    if (checked.some(item => item.result === 'fail')) return 'rejected'
    if (checked.some(item => item.result === 'needs-review')) return 'needs-review'
    if (snapshot.softCriteria.length === 0) return 'accepted'
    if (soft === null) return 'needs-review'
    return soft >= snapshot.acceptanceThreshold ? 'accepted' : 'rejected'
}

export function validateIntentAssessmentEvent(
    event: IntentAssessmentEvent,
    binding: IntentAssessmentRunBinding,
    candidateArtifactIds: readonly string[],
): IntentAssessmentEvent {
    const parsed = parseIntentAssessmentEvent(event)
    const checkedBinding = parseIntentAssessmentRunBinding(binding)
    const requirement = checkedBinding.requirement
    if (parsed.runId !== checkedBinding.runId || parsed.planHash !== checkedBinding.planHash) {
        throw new TypeError('Assessment does not match its immutable run plan.')
    }
    if (parsed.type === 'artifact-assessment' && (!candidateArtifactIds.includes(parsed.artifactId)
        || parsed.rubricId !== requirement.rubric.rubricId || parsed.rubricVersion !== requirement.rubric.version
        || parsed.rubricHash !== requirement.rubricHash
        || parsed.decision !== deriveHumanAssessmentDecision(requirement.rubric, parsed.hardConstraintResults, parsed.softScore))) {
        throw new TypeError('Assessment candidate, rubric binding, or human decision is invalid.')
    }
    return parsed
}

/** Select an explicit, unbroken chain per artifact, independent of delivery or timestamp order.
 * Conflicting IDs, forks, missing ancestors and malformed facts exclude that artifact entirely.
 */
export function latestArtifactAssessments(
    binding: IntentAssessmentRunBinding,
    candidateArtifactIds: readonly string[],
    events: readonly IntentAssessmentEvent[],
): ReadonlyMap<string, HumanIntentAssessmentEventV1> {
    parseIntentAssessmentRunBinding(binding)
    const candidates = new Set(candidateArtifactIds.map(identifier))
    const invalid = new Set<string>()
    const byId = new Map<string, IntentAssessmentEvent>()
    const grouped = new Map<string, Map<string, HumanIntentAssessmentEventV1>>()
    for (const raw of events) {
        let event: IntentAssessmentEvent
        try { event = validateIntentAssessmentEvent(raw, binding, candidateArtifactIds) } catch {
            if (raw && typeof raw === 'object' && 'artifactId' in raw && typeof raw.artifactId === 'string') invalid.add(raw.artifactId)
            continue
        }
        const previous = byId.get(event.assessmentId)
        if (previous && canonicalSerialize(previous) !== canonicalSerialize(event)) {
            if (previous.type === 'artifact-assessment') invalid.add(previous.artifactId)
            if (event.type === 'artifact-assessment') invalid.add(event.artifactId)
        }
        byId.set(event.assessmentId, event)
        if (event.type !== 'artifact-assessment') continue
        const group = grouped.get(event.artifactId) ?? new Map<string, HumanIntentAssessmentEventV1>()
        group.set(event.assessmentId, event)
        grouped.set(event.artifactId, group)
    }
    const latest = new Map<string, HumanIntentAssessmentEventV1>()
    for (const artifactId of candidates) {
        const group = grouped.get(artifactId)
        if (!group || invalid.has(artifactId)) continue
        const roots = [...group.values()].filter(event => event.supersedesAssessmentId === null)
        const next = new Map<string, HumanIntentAssessmentEventV1>()
        let valid = roots.length === 1
        for (const event of group.values()) {
            if (event.supersedesAssessmentId === null) continue
            if (!group.has(event.supersedesAssessmentId) || next.has(event.supersedesAssessmentId)) valid = false
            next.set(event.supersedesAssessmentId, event)
        }
        if (!valid) continue
        let leaf = roots[0]
        const visited = new Set<string>()
        while (leaf && !visited.has(leaf.assessmentId)) {
            visited.add(leaf.assessmentId)
            const child = next.get(leaf.assessmentId)
            if (!child) break
            leaf = child
        }
        if (leaf && visited.size === group.size) latest.set(artifactId, leaf)
    }
    return latest
}

/** Artifact rejection is recoverable; only an explicit human close makes the run rejected. */
export function projectRunAcceptance(
    binding: IntentAssessmentRunBinding,
    candidateArtifactIds: readonly string[],
    events: readonly IntentAssessmentEvent[],
): RunAcceptanceProjection {
    const candidates = [...new Set(candidateArtifactIds.map(identifier))]
    const latest = latestArtifactAssessments(binding, candidates, events)
    const acceptedArtifactIds = candidates.filter(id => latest.get(id)?.decision === 'accepted')
    const close = events.find(event => {
        try { return validateIntentAssessmentEvent(event, binding, candidates).type === 'run-decision' } catch { return false }
    })
    return {
        runId: identifier(binding.runId),
        planHash: hash(binding.planHash),
        requiredAcceptedCount: binding.requirement.requiredAcceptedCount,
        candidateArtifactIds: candidates,
        acceptedArtifactIds,
        // Fulfillment retains the evidence for both artifact outcomes and terminal human closure.
        latestAssessmentIds: [...new Set([
            ...[...latest.values()].map(event => event.assessmentId),
            ...(close === undefined ? [] : [close.assessmentId]),
        ])],
        state: close !== undefined ? 'rejected' : acceptedArtifactIds.length >= binding.requirement.requiredAcceptedCount
            ? 'accepted' : events.length === 0 ? 'not-evaluated' : 'needs-review',
    }
}
