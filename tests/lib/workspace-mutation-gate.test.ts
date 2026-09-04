import { describe, expect, it } from 'vitest'

import { ProcessLocalWorkspaceMutationGate } from '@/lib/workspace-mutation-gate'

function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    return { promise, resolve }
}

describe('process-local workspace mutation gate', () => {
    it('runs the same key in FIFO order and cleans up for a later operation', async () => {
        const gate = new ProcessLocalWorkspaceMutationGate()
        const hold = deferred()
        const events: string[] = []
        const first = gate.runExclusive('same', async () => {
            events.push('first:start')
            await hold.promise
            events.push('first:end')
        })
        const second = gate.runExclusive('same', async () => { events.push('second') })
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(events).toEqual(['first:start'])
        hold.resolve()
        await Promise.all([first, second])
        await gate.runExclusive('same', async () => { events.push('third') })
        expect(events).toEqual(['first:start', 'first:end', 'second', 'third'])
    })

    it('allows different keys to overlap', async () => {
        const gate = new ProcessLocalWorkspaceMutationGate()
        const hold = deferred()
        const events: string[] = []
        const first = gate.runExclusive('one', async () => {
            events.push('one:start')
            await hold.promise
        })
        await gate.runExclusive('two', async () => { events.push('two') })
        expect(events).toEqual(['one:start', 'two'])
        hold.resolve()
        await first
    })

    it('does not let a rejected predecessor block the next operation', async () => {
        const gate = new ProcessLocalWorkspaceMutationGate()
        const events: string[] = []
        const failed = gate.runExclusive('same', async () => {
            events.push('failed')
            throw new Error('expected')
        })
        const next = gate.runExclusive('same', async () => { events.push('next') })
        await expect(failed).rejects.toThrow('expected')
        await next
        expect(events).toEqual(['failed', 'next'])
    })
})
