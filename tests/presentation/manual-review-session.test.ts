import { describe, expect, it } from 'vitest'

import {
    createManualReviewSession,
    loadManualReviewSession,
    saveManualReviewSession,
} from '@/presentation/manual-review-session'

function memoryStorage() {
    const values = new Map<string, string>()
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value) },
    }
}

describe('manual review session recovery', () => {
    it('restores pending job and completed preview links after route remount', () => {
        const storage = memoryStorage()
        const session = {
            ...createManualReviewSession('bookshop'),
            activeIndex: 1,
            seenIds: ['bookshop', 'greenhouse'],
            completedJobIds: { bookshop: 'job:done' },
            latestCompletedCardId: 'bookshop',
            pending: { cardId: 'greenhouse', cardIndex: 1, batchId: 'batch:1', jobId: 'job:pending' },
        }

        expect(saveManualReviewSession(storage, session)).toBe(true)
        expect(loadManualReviewSession(storage, ['bookshop', 'greenhouse', 'night-train'])).toMatchObject(session)
    })

    it('marks an interrupted enqueue uncertain so remount cannot submit it again', () => {
        const storage = memoryStorage()
        const session = {
            ...createManualReviewSession('bookshop'),
            submitting: { cardId: 'bookshop', requestId: 'request:1' },
        }
        saveManualReviewSession(storage, session)

        expect(loadManualReviewSession(storage, ['bookshop', 'greenhouse'])).toMatchObject({
            submitting: null,
            uncertainCardIds: ['bookshop'],
        })
    })

    it('ignores saved card references that no longer exist', () => {
        const storage = memoryStorage()
        const session = {
            ...createManualReviewSession('removed-card'),
            uncertainCardIds: ['removed-card'],
            pending: { cardId: 'removed-card', cardIndex: 0, batchId: 'batch:old', jobId: 'job:old' },
        }
        saveManualReviewSession(storage, session)

        expect(loadManualReviewSession(storage, ['bookshop'])).toMatchObject({
            pending: null,
            uncertainCardIds: [],
            activeIndex: 0,
        })
    })
})
