import {
    createAnlasCostConsentSnapshot,
    type AnlasCostConsentSnapshot,
    type AnlasPricingBasis,
} from '@/domain/queue/anlas-cost-consent'

export interface SceneQueueReplanIssue {
    readonly code: 'SCENE_QUEUE_REPLAN_REQUIRED'
    readonly action: 'replan'
    readonly reason:
        | 'scene-changed'
        | 'folder-changed'
        | 'pricing-changed'
        | 'runtime-limit-changed'
        | 'commit-set-changed'
}

export class SceneQueueReviewConflict extends Error {
    constructor(readonly issue: SceneQueueReplanIssue, message: string) {
        super(message)
        this.name = 'SceneQueueReviewConflict'
    }
}

export function isSceneQueueReviewConflict(error: unknown): error is SceneQueueReviewConflict {
    return error instanceof SceneQueueReviewConflict
}

export function shouldAcceptSceneQueueDialogOpenChange(submitting: boolean, nextOpen: boolean): boolean {
    return nextOpen || !submitting
}

export function canApproveSceneQueueReview(input: {
    readonly submitting: boolean
    readonly busy: boolean
    readonly issue: SceneQueueReplanIssue | null
}): boolean {
    return !input.submitting && !input.busy && input.issue === null
}

export function sceneQueueReplanDescription(reason: SceneQueueReplanIssue['reason']): string {
    switch (reason) {
        case 'scene-changed': return 'A selected Scene changed. Review the current Scene values again.'
        case 'folder-changed': return 'The output folder changed. Review the current destination again.'
        case 'pricing-changed': return 'The Anlas pricing basis changed. Review the updated estimate again.'
        case 'runtime-limit-changed': return 'This device’s batch limit changed. Review a supported batch again.'
        case 'commit-set-changed': return 'The exact output filenames or claims changed. Review the new reservation again.'
    }
}

export function assertSceneQueueReviewCondition(
    condition: boolean,
    reason: SceneQueueReplanIssue['reason'],
    message: string,
): asserts condition {
    if (!condition) {
        throw new SceneQueueReviewConflict({ code: 'SCENE_QUEUE_REPLAN_REQUIRED', action: 'replan', reason }, message)
    }
}

export interface SceneQueueCostEstimate {
    readonly pricingBasis: AnlasPricingBasis
    readonly estimatedAnlas: number
    readonly maxAnlas: number
    readonly estimatedAt: string
}

/** One batch approval instant is attached only after review revalidation succeeds. */
export function approveSceneQueueCostEstimates(
    estimates: readonly SceneQueueCostEstimate[],
    approvedAt: string,
): readonly AnlasCostConsentSnapshot[] {
    return Object.freeze(estimates.map(estimate => createAnlasCostConsentSnapshot({ ...estimate, approvedAt })))
}

export interface SceneQueueResourcePlan<T> {
    readonly raw: readonly T[]
}

/** Captures raw resource-bearing values in process memory without invoking persistence. */
export function createSceneQueueResourcePlan<T>(raw: readonly T[]): SceneQueueResourcePlan<T> {
    return Object.freeze({ raw: Object.freeze([...raw]) })
}

export async function materializeApprovedSceneQueueResources<T, TResult>(
    plan: SceneQueueResourcePlan<T>,
    materialize: (value: T, ordinal: number) => Promise<TResult>,
): Promise<readonly TResult[]> {
    const results: TResult[] = []
    for (let ordinal = 0; ordinal < plan.raw.length; ordinal += 1) {
        results.push(await materialize(plan.raw[ordinal], ordinal))
    }
    return Object.freeze(results)
}

/** Shares concurrent/successful approvals while allowing a rejected transient attempt to retry. */
export class SceneQueueApprovalRegistry<TKey extends object, TResult> {
    private readonly pending = new WeakMap<TKey, Promise<TResult>>()

    run(key: TKey, operation: () => Promise<TResult>): Promise<TResult> {
        const existing = this.pending.get(key)
        if (existing !== undefined) return existing
        const pending = operation()
        this.pending.set(key, pending)
        void pending.catch(() => {
            if (this.pending.get(key) === pending) this.pending.delete(key)
        })
        return pending
    }
}
