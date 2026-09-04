import { describe, expect, it, vi } from 'vitest'

import { QueueRecoveryActionGate } from '@/services/queue/queue-recovery-action-gate'

describe('QueueRecoveryActionGate', () => {
    it('shares the same rejection and permits a retry only after it settles', async () => {
        const gate = new QueueRecoveryActionGate()
        let reject!: (error: Error) => void
        const action = vi.fn(() => new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise }))

        const first = gate.run('job:1:discard', action)
        const repeated = gate.run('job:1:discard', action)
        expect(repeated).toBe(first)
        await expect(gate.run('job:2:abandon', vi.fn())).rejects.toThrow('already running')

        reject(new Error('discard failed'))
        await expect(first).rejects.toThrow('discard failed')
        await expect(repeated).rejects.toThrow('discard failed')
        expect(action).toHaveBeenCalledOnce()

        await expect(gate.run('job:1:discard', async () => undefined)).resolves.toBeUndefined()
    })
})
