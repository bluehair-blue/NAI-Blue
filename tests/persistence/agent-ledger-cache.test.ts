import { describe, expect, it, vi } from 'vitest'
import { IndexedDbAgentExecutionRepository } from '@/adapters/agent/indexeddb-agent-execution-repository'

describe('validated execution ledger cache', () => {
    it('reuses immutable validation but observes same-revision corruption, deletion and recovery', async () => {
        const initial = JSON.stringify({ schemaVersion: 1, workspaceId: 'workspace-1', revision: 0, records: [] })
        let raw: string | null = initial
        const getItem = vi.fn(async () => raw)
        const repository = new IndexedDbAgentExecutionRepository({ getItem, compareAndSet: vi.fn() })
        const first = await repository.get('workspace-1')
        expect(await repository.get('workspace-1')).toBe(first)
        expect(getItem).toHaveBeenCalledTimes(2)
        expect(Object.isFrozen(first)).toBe(true)
        expect(Object.isFrozen(first!.records)).toBe(true)
        raw = initial.replace('"records":[]', '"records":[{}]')
        await expect(repository.get('workspace-1')).rejects.toThrow()
        raw = null
        expect(await repository.get('workspace-1')).toBeNull()
        raw = initial
        expect(await repository.get('workspace-1')).toEqual(first)
        expect(await repository.get('workspace-1')).not.toBe(first)
    })
})
