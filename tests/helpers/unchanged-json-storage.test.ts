import { describe, expect, it, vi } from 'vitest'
import { createUnchangedJSONStorage } from '@/lib/unchanged-json-storage'

describe('unchanged JSON persistence projection', () => {
    it('skips serialization/writes of thumbnail history for transient updates', async () => {
        const setItem = vi.fn(async () => undefined)
        const storage = createUnchangedJSONStorage<{ prompt: string; history: unknown[] }>(() => ({
            getItem: () => null, setItem, removeItem: () => undefined,
        }))!
        const serialize = vi.fn(() => 'thumbnail')
        const history = [{ toJSON: serialize }]
        await storage.setItem('generation', { version: 1, state: { prompt: 'a', history } })
        for (let frame = 0; frame < 100; frame++) {
            await storage.setItem('generation', { version: 1, state: { prompt: 'a', history } })
        }
        expect(setItem).toHaveBeenCalledTimes(1)
        expect(serialize).toHaveBeenCalledTimes(1)
        await storage.setItem('generation', { version: 1, state: { prompt: 'b', history } })
        await storage.setItem('generation', { version: 1, state: { prompt: 'b', history: [...history, 'new'] } })
        expect(setItem).toHaveBeenCalledTimes(3)
    })

    it('shares pending failures and allows retry of an identical projection', async () => {
        const failure = new Error('disk unavailable')
        const setItem = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined)
        const storage = createUnchangedJSONStorage<{ prompt: string }>(() => ({
            getItem: () => null, setItem, removeItem: () => undefined,
        }))!
        const value = { state: { prompt: 'a' }, version: 1 }
        const first = storage.setItem('generation', value)
        const duplicate = storage.setItem('generation', value)
        expect(first).toBe(duplicate)
        await expect(first).rejects.toBe(failure)
        await storage.setItem('generation', value)
        expect(setItem).toHaveBeenCalledTimes(2)
    })
})
