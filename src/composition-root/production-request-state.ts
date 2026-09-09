import { IndexedDbProductionRequestRepository } from '@/adapters/generation/indexeddb-production-request-repository'
import { reserveProductionChild, acknowledgeProductionChild, type ProductionRequest } from '@/application/generation/production-request'

/** Shared persistence seam for GUI/agent approval adapters; it never plans or executes generation. */
export const runtimeProductionRequests = new IndexedDbProductionRequestRepository()
export async function requireProductionRequest(id: string): Promise<ProductionRequest> {
    const request = await runtimeProductionRequests.get(id)
    if (!request) throw new Error('PRODUCTION_NOT_FOUND')
    return request
}
export async function saveProductionRequest(previous: ProductionRequest, next: ProductionRequest): Promise<ProductionRequest> {
    if (next === previous) return previous
    if (!await runtimeProductionRequests.compareAndSet(previous, next)) throw new Error('PRODUCTION_CHANGED')
    return next
}

/** Reserve only after the existing planner/grant validation and before its single Queue mutation. */
export async function reserveRuntimeProductionChild(id: string, index: number, planId: string, runId: string): Promise<void> {
    const request = await requireProductionRequest(id)
    const child = request.children[index]
    if (!child?.review || child.review.planId !== planId) throw new Error('PRODUCTION_REVIEW_CHANGED')
    if (child.submission !== null) throw new Error('PRODUCTION_SUBMISSION_ALREADY_RESERVED')
    await saveProductionRequest(request, reserveProductionChild(request, index, { runId, estimatedAnlas: child.review.estimatedAnlas }))
}
export async function acknowledgeRuntimeProductionChild(id: string, index: number, runId: string): Promise<void> {
    const request = await requireProductionRequest(id)
    await saveProductionRequest(request, acknowledgeProductionChild(request, index, runId))
}
export async function validateRuntimeProductionPlan(production: { productionId: string; index: number }, planId: string): Promise<boolean> {
    const request = await runtimeProductionRequests.get(production.productionId)
    const child = request?.children[production.index]
    return child?.review?.planId === planId && child.submission === null
}
