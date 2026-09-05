import { hashCanonicalValue } from '@/domain/composition/canonical-serialize'

export interface RubricCriterion {
    readonly criterionId: string
    readonly label: string
}

export interface WeightedCriterion extends RubricCriterion {
    readonly weight: number
}

/** The plan owns this snapshot; assessment events bind to its canonical hash. */
export interface VisualRubric {
    readonly rubricId: string
    readonly version: number
    readonly hardConstraints: readonly RubricCriterion[]
    readonly softCriteria: readonly WeightedCriterion[]
    readonly acceptanceThreshold: number
}

export interface GenerationAssessmentRequirement {
    readonly rubric: VisualRubric
    readonly rubricHash: `sha256:${string}`
    readonly requiredAcceptedCount: number
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !keys.includes(key))) {
        throw new TypeError('Invalid rubric object or unknown field.')
    }
    return value as Record<string, unknown>
}

function boundedText(value: unknown, max: number): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/u.test(value)) {
        throw new TypeError('Rubric text must be nonempty and bounded.')
    }
    return value
}

export function parseVisualRubric(value: unknown): VisualRubric {
    const input = record(value, ['rubricId', 'version', 'hardConstraints', 'softCriteria', 'acceptanceThreshold'])
    if (!Number.isSafeInteger(input.version) || Number(input.version) < 1
        || typeof input.acceptanceThreshold !== 'number' || !Number.isFinite(input.acceptanceThreshold)
        || input.acceptanceThreshold < 0 || input.acceptanceThreshold > 100
        || !Array.isArray(input.hardConstraints) || !Array.isArray(input.softCriteria)
        || input.hardConstraints.length + input.softCriteria.length === 0
        || input.hardConstraints.length + input.softCriteria.length > 100) {
        throw new TypeError('Invalid rubric version, criteria, or threshold.')
    }
    const ids = new Set<string>()
    function criterion(raw: unknown, weighted: boolean): RubricCriterion | WeightedCriterion {
        const entry = record(raw, weighted ? ['criterionId', 'label', 'weight'] : ['criterionId', 'label'])
        const criterionId = boundedText(entry.criterionId, 512)
        if (ids.has(criterionId)) throw new TypeError('Rubric criterion IDs must be unique.')
        ids.add(criterionId)
        const base = { criterionId, label: boundedText(entry.label, 2000) }
        if (!weighted) return Object.freeze(base)
        if (typeof entry.weight !== 'number' || !Number.isFinite(entry.weight) || entry.weight <= 0) {
            throw new TypeError('Soft criterion weights must be positive finite numbers.')
        }
        return Object.freeze({ ...base, weight: entry.weight })
    }
    return Object.freeze({
        rubricId: boundedText(input.rubricId, 512),
        version: input.version as number,
        hardConstraints: Object.freeze(input.hardConstraints.map(item => criterion(item, false))),
        softCriteria: Object.freeze(input.softCriteria.map(item => criterion(item, true) as WeightedCriterion)),
        acceptanceThreshold: input.acceptanceThreshold,
    })
}

export function createAssessmentRequirement(rubric: unknown, requiredAcceptedCount: number): GenerationAssessmentRequirement {
    if (!Number.isSafeInteger(requiredAcceptedCount) || requiredAcceptedCount < 1) {
        throw new TypeError('requiredAcceptedCount must be a positive safe integer.')
    }
    const snapshot = parseVisualRubric(rubric)
    return Object.freeze({
        rubric: snapshot,
        rubricHash: `sha256:${hashCanonicalValue(snapshot)}` as const,
        requiredAcceptedCount,
    })
}

/** Recompute the hash at the persistence boundary rather than trusting provenance text. */
export function parseAssessmentRequirement(value: unknown): GenerationAssessmentRequirement {
    const input = record(value, ['rubric', 'rubricHash', 'requiredAcceptedCount'])
    const requirement = createAssessmentRequirement(input.rubric, input.requiredAcceptedCount as number)
    if (input.rubricHash !== requirement.rubricHash) throw new TypeError('Rubric hash does not match its snapshot.')
    return requirement
}
