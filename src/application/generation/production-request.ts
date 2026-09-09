import { canonicalSerialize } from '@/domain/composition/canonical-serialize'

export interface ProductionTarget {
    readonly presetId: string
    readonly sceneId: string
    readonly count: number
    readonly sourceHash: string
    readonly fileNames?: readonly string[]
}
export interface ProductionReview {
    readonly planId: `sha256:${string}`
    readonly planHash: `sha256:${string}`
    readonly reviewId: string
    readonly reviewedAt: string
    readonly estimatedAnlas: number
}
export interface ProductionChild {
    readonly index: number
    readonly targets: readonly { readonly targetIndex: number; readonly count: number; readonly offset: number }[]
    readonly seeds: readonly number[]
    readonly review: ProductionReview | null
    readonly submission: { readonly runId: string; readonly estimatedAnlas: number; readonly status: 'submitting' | 'queued' } | null
}
export interface ProductionRequest {
    readonly schemaVersion: 1
    readonly id: string
    readonly title: string
    readonly createdAt: string
    readonly revision: number
    readonly budget: { readonly maxImages: number; readonly maxAnlas: number }
    readonly targets: readonly ProductionTarget[]
    readonly materializedSeeds: readonly number[]
    readonly children: readonly ProductionChild[]
}
export interface CreateProductionRequestInput {
    readonly id: string
    readonly title: string
    readonly createdAt: string
    readonly targets: readonly ProductionTarget[]
    readonly budget: ProductionRequest['budget']
    readonly seeds: readonly number[]
}

const hash = /^sha256:[a-f0-9]{64}$/
const identity = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const same = (left: unknown, right: unknown) => canonicalSerialize(left) === canonicalSerialize(right)
const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const monetary = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
    && value >= 0 && value <= Number.MAX_SAFE_INTEGER
const text = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= maximum
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
function requireValid(condition: unknown): asserts condition {
    if (!condition) throw new TypeError('Invalid production request or transition')
}
function keys(value: object, allowed: readonly string[]): boolean {
    return Object.keys(value).every(key => allowed.includes(key))
}

/** Records reviewed selection only; existing Scene planning and Queue retain execution authority. */
export function createProductionRequest(input: CreateProductionRequestInput): ProductionRequest {
    requireValid(text(input.id, 200) && identity.test(input.id) && text(input.title, 200) && timestamp(input.createdAt))
    requireValid(Array.isArray(input.targets) && input.targets.length > 0 && input.targets.length <= 2400)
    const total = input.targets.reduce((sum, target) => {
        requireValid(keys(target, ['presetId', 'sceneId', 'count', 'sourceHash', 'fileNames'])
            && text(target.presetId, 200) && text(target.sceneId, 200) && typeof target.sourceHash === 'string' && hash.test(target.sourceHash)
            && nonnegative(target.count) && target.count > 0 && target.count <= 2400)
        requireValid(target.fileNames === undefined || (Array.isArray(target.fileNames) && target.fileNames.length <= target.count
            && target.fileNames.every((name: unknown) => typeof name === 'string' && name.length <= 255 && !/[\\/\r\n]/.test(name))))
        return sum + target.count
    }, 0)
    requireValid(keys(input.budget, ['maxImages', 'maxAnlas']) && total <= 2400 && nonnegative(input.budget.maxImages) && input.budget.maxImages >= total
        && input.budget.maxImages <= 2400 && monetary(input.budget.maxAnlas))
    requireValid(Array.isArray(input.seeds) && input.seeds.length === total
        && input.seeds.every(seed => nonnegative(seed) && seed <= 0xffff_ffff))
    const children: ProductionChild[] = []
    let ordinal = 0
    input.targets.forEach((target, targetIndex) => {
        let offset = 0
        while (offset < target.count) {
            const previous = children[children.length - 1]
            const child = previous && previous.seeds.length < 100 ? previous : {
                index: children.length, targets: [], seeds: [], review: null, submission: null,
            }
            if (child !== previous) children.push(child)
            const count = Math.min(100 - child.seeds.length, target.count - offset)
            children[child.index] = { ...child,
                targets: [...child.targets, { targetIndex, count, offset }],
                seeds: [...child.seeds, ...input.seeds.slice(ordinal, ordinal + count)],
            }
            offset += count
            ordinal += count
        }
    })
    return structuredClone({ schemaVersion: 1, id: input.id, title: input.title, createdAt: input.createdAt,
        revision: 0, budget: input.budget, targets: input.targets, materializedSeeds: input.seeds, children })
}

export function productionReservedAnlas(request: ProductionRequest): number {
    return request.children.reduce((sum, child) => sum + (child.submission?.estimatedAnlas ?? 0), 0)
}

/** Strict durable shape check reconstructs child partitions instead of trusting persisted offsets. */
export function parseProductionRequest(value: unknown): ProductionRequest {
    requireValid(typeof value === 'object' && value !== null)
    const request = value as ProductionRequest
    const base = createProductionRequest({ ...request, seeds: request.materializedSeeds })
    requireValid(request.schemaVersion === 1 && nonnegative(request.revision) && Array.isArray(request.children)
        && request.children.length === base.children.length)
    request.children.forEach((child, index) => {
        requireValid(same({ ...child, review: null, submission: null }, base.children[index]))
        if (child.review !== null) {
            const review = child.review
            requireValid(keys(review, ['planId', 'planHash', 'reviewId', 'reviewedAt', 'estimatedAnlas'])
                && typeof review.planId === 'string' && hash.test(review.planId) && review.planId === review.planHash
                && /^scene-review-[A-Za-z0-9-]{1,100}$/.test(review.reviewId) && timestamp(review.reviewedAt)
                && monetary(review.estimatedAnlas))
            requireValid(request.children.slice(0, index).every(previous => previous.submission?.status === 'queued'))
        }
        if (child.submission !== null) {
            requireValid(keys(child.submission, ['runId', 'estimatedAnlas', 'status'])
                && child.review !== null && text(child.submission.runId, 200) && identity.test(child.submission.runId)
                && child.submission.estimatedAnlas === child.review.estimatedAnlas
                && ['submitting', 'queued'].includes(child.submission.status))
        }
    })
    requireValid(productionReservedAnlas(request) <= request.budget.maxAnlas)
    // Canonical equality rejects unknown root fields and undefined rather than silently discarding them.
    requireValid(same(request, { ...base, revision: request.revision, children: request.children }))
    return structuredClone(request)
}

function replaceChild(request: ProductionRequest, index: number, child: ProductionChild): ProductionRequest {
    return parseProductionRequest({ ...request, revision: request.revision + 1,
        children: request.children.map(current => current.index === index ? child : current) })
}
export function withProductionReview(request: ProductionRequest, index: number, review: ProductionReview): ProductionRequest {
    parseProductionRequest(request)
    const child = request.children[index]
    requireValid(child && Number.isSafeInteger(index))
    if (child.review !== null && same(child.review, review)) return request
    requireValid(child.submission === null)
    return replaceChild(request, index, { ...child, review: structuredClone(review) })
}

/** Reserve before calling Queue. An uncertain submission stays charged and cannot be replaced. */
export function reserveProductionChild(request: ProductionRequest, index: number,
    submission: { readonly runId: string; readonly estimatedAnlas: number }): ProductionRequest {
    parseProductionRequest(request)
    const child = request.children[index]
    requireValid(child && Number.isSafeInteger(index) && child.review !== null)
    if (child.submission !== null) {
        requireValid(child.submission.runId === submission.runId && child.submission.estimatedAnlas === submission.estimatedAnlas)
        return request
    }
    return replaceChild(request, index, { ...child, submission: { ...submission, status: 'submitting' } })
}

export function acknowledgeProductionChild(request: ProductionRequest, index: number, runId: string): ProductionRequest {
    parseProductionRequest(request)
    const child = request.children[index]
    requireValid(child && Number.isSafeInteger(index) && child.submission?.runId === runId)
    if (child.submission.status === 'queued') return request
    return replaceChild(request, index, { ...child, submission: { ...child.submission, status: 'queued' } })
}

/** Repository CAS accepts precisely one supported mutation, preserving selection and prior consent. */
export function assertProductionTransition(expected: ProductionRequest, next: ProductionRequest): void {
    parseProductionRequest(expected)
    parseProductionRequest(next)
    requireValid(next.revision === expected.revision + 1)
    const changed = next.children.filter((child, index) => !same(child, expected.children[index]))
    requireValid(changed.length === 1)
    const child = changed[0]
    const previous = expected.children[child.index]
    let allowed: ProductionRequest
    if (!same(previous.review, child.review) && child.review !== null) allowed = withProductionReview(expected, child.index, child.review)
    else if (previous.submission === null && child.submission !== null) allowed = reserveProductionChild(expected, child.index, child.submission)
    else {
        requireValid(child.submission !== null)
        allowed = acknowledgeProductionChild(expected, child.index, child.submission.runId)
    }
    requireValid(same(allowed, next))
}
