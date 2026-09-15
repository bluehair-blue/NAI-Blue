export interface ManualReviewPendingRequest {
    readonly cardId: string
    readonly cardIndex: number
    readonly batchId: string
    readonly jobId: string
}

export interface ManualReviewSession {
    readonly activeIndex: number
    readonly seenIds: readonly string[]
    readonly completedJobIds: Readonly<Record<string, string>>
    readonly latestCompletedCardId: string | null
    readonly pending: ManualReviewPendingRequest | null
    readonly submitting: { readonly cardId: string, readonly requestId: string } | null
    readonly uncertainCardIds: readonly string[]
}

const SESSION_KEY = 'nai-blue:manual-review-session:v1'

export function createManualReviewSession(firstCardId: string): ManualReviewSession {
    return {
        activeIndex: 0,
        seenIds: [firstCardId],
        completedJobIds: {},
        latestCompletedCardId: null,
        pending: null,
        submitting: null,
        uncertainCardIds: [],
    }
}

export function loadManualReviewSession(storage: Pick<Storage, 'getItem'>, cardIds: readonly string[]): ManualReviewSession {
    const initial = createManualReviewSession(cardIds[0] ?? '')
    try {
        const serialized = storage.getItem(SESSION_KEY)
        if (serialized === null) return initial
        const saved = JSON.parse(serialized) as Partial<ManualReviewSession> & { version?: number }
        if (saved.version !== 1) return initial

        const validIds = new Set(cardIds)
        const activeIndex = Number.isInteger(saved.activeIndex)
            && Number(saved.activeIndex) >= 0
            && Number(saved.activeIndex) < cardIds.length
            ? Number(saved.activeIndex)
            : 0
        const completedJobIds = Object.fromEntries(Object.entries(saved.completedJobIds ?? {})
            .filter(([cardId, jobId]) => validIds.has(cardId) && typeof jobId === 'string' && jobId.length > 0))
        const pending = saved.pending
            && validIds.has(saved.pending.cardId)
            && Number.isInteger(saved.pending.cardIndex)
            && saved.pending.cardIndex >= 0
            && saved.pending.cardIndex < cardIds.length
            && cardIds[saved.pending.cardIndex] === saved.pending.cardId
            && typeof saved.pending.batchId === 'string'
            && typeof saved.pending.jobId === 'string'
            ? saved.pending
            : null
        const uncertainCardIds = new Set((saved.uncertainCardIds ?? []).filter(id => validIds.has(id)))
        // If the route disappeared during enqueue, treat the outcome as unknown and block a second submission.
        if (saved.submitting && validIds.has(saved.submitting.cardId)) uncertainCardIds.add(saved.submitting.cardId)

        return {
            activeIndex,
            seenIds: [...new Set([...(saved.seenIds ?? []).filter(id => validIds.has(id)), cardIds[activeIndex] ?? ''])].filter(Boolean),
            completedJobIds,
            latestCompletedCardId: typeof saved.latestCompletedCardId === 'string'
                && validIds.has(saved.latestCompletedCardId)
                && completedJobIds[saved.latestCompletedCardId] !== undefined
                ? saved.latestCompletedCardId
                : null,
            pending,
            submitting: null,
            uncertainCardIds: [...uncertainCardIds],
        }
    } catch {
        return initial
    }
}

export function saveManualReviewSession(storage: Pick<Storage, 'setItem'>, session: ManualReviewSession): boolean {
    try {
        storage.setItem(SESSION_KEY, JSON.stringify({ version: 1, ...session }))
        return true
    } catch {
        return false
    }
}
