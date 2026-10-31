import { describe, expect, it, vi } from 'vitest'

import { createSerializedProgressReporter } from '@/services/queue/serialized-progress-reporter'

describe('serialized queue progress reporter', () => {
    it('does not persist every preview frame at an unchanged step', async () => {
        const update = vi.fn(async () => undefined)
        const reporter = createSerializedProgressReporter(update)
        for (let frame = 0; frame < 100; frame++) reporter.enqueue('stream', 7, 28)
        reporter.enqueue('stream', 8, 28)
        reporter.enqueue('storage', 8, 28)
        await reporter.flush()
        expect(update).toHaveBeenCalledTimes(3)
    })
    it('persists provider callbacks one at a time and in arrival order', async () => {
        const events: string[] = []
        let active = 0
        let maxActive = 0
        const reporter = createSerializedProgressReporter(async (stage, current) => {
            active += 1
            maxActive = Math.max(maxActive, active)
            await Promise.resolve()
            events.push(`${stage}:${current}`)
            active -= 1
        })

        reporter.enqueue('stream', 1, 28)
        reporter.enqueue('stream', 8, 28)
        reporter.enqueue('stream', 28, 28)
        await reporter.flush()

        expect(maxActive).toBe(1)
        expect(events).toEqual(['stream:1', 'stream:8', 'stream:28'])
    })

    it('captures the first persistence failure without creating an unhandled rejection', async () => {
        const failure = new Error('synthetic progress failure')
        const update = vi.fn(async () => { throw failure })
        const reporter = createSerializedProgressReporter(update)

        reporter.enqueue('stream', 1, 28)
        reporter.enqueue('stream', 2, 28)

        await expect(reporter.flush()).rejects.toBe(failure)
        expect(update).toHaveBeenCalledOnce()
    })
})
