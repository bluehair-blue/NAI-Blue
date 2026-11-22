import { afterEach, describe, expect, it, vi } from 'vitest'
import { IndexedDbAgentExecutionRepository } from '@/adapters/agent/indexeddb-agent-execution-repository'
import { parseAgentExecutionLedger, type AgentExecutionLedger } from '@/application/agent/agent-execution-repository'
import { canonicalSerialize } from '@/domain/composition/canonical-serialize'

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

/** Runs the same parser as the real Worker and counts every validation request. */
class FakeWorker {
    static instances: FakeWorker[] = []
    static messages = 0
    onmessage: ((event: { data: unknown }) => void) | null = null
    onerror: (() => void) | null = null
    onmessageerror: (() => void) | null = null
    terminated = false
    constructor() { FakeWorker.instances.push(this) }
    postMessage(data: { id: number; value: string | AgentExecutionLedger; workspaceId: string; serialize: boolean }) {
        FakeWorker.messages++
        const value = structuredClone(data)
        queueMicrotask(() => {
            if (this.terminated) return
            try {
                const ledger = parseAgentExecutionLedger(typeof value.value === 'string' ? JSON.parse(value.value) : value.value, value.workspaceId)
                this.onmessage?.({ data: { id: value.id, ledger: structuredClone(ledger), serialized: value.serialize ? canonicalSerialize(ledger) : null } })
            } catch { this.onmessage?.({ data: { id: value.id, error: 'INVALID_EXECUTION_STORE' } }) }
        })
    }
    terminate() { this.terminated = true }
}

const ledgerAt = (revision: number): AgentExecutionLedger => ({ schemaVersion: 1, workspaceId: 'workspace-1', revision, records: [] })
async function workerRepository() {
    FakeWorker.instances = []
    FakeWorker.messages = 0
    vi.stubGlobal('Worker', FakeWorker)
    // The validation Worker is module state shared by repository instances.
    vi.resetModules()
    const { IndexedDbAgentExecutionRepository: Repository } = await import('@/adapters/agent/indexeddb-agent-execution-repository')
    const store = { raw: canonicalSerialize(ledgerAt(0)) as string | null }
    const getItem = vi.fn(async () => store.raw)
    const compareAndSet = vi.fn(async (_key: string, expected: string | null, next: string) => {
        if (store.raw !== expected) return false
        store.raw = next
        return true
    })
    return { repository: new Repository({ getItem, compareAndSet }), store, getItem }
}
afterEach(() => { vi.unstubAllGlobals() })

describe('execution ledger write cache and validation Worker', () => {
    it('caches its own confirmed write and validates bytes written by another owner', async () => {
        const { repository, store } = await workerRepository()
        const initial = await repository.get('workspace-1')
        expect(FakeWorker.messages).toBe(1)
        expect(await repository.compareAndSet(initial, ledgerAt(1))).toBe(true)
        // Only the new value is validated; the cached preimage supplies the exact expected bytes.
        expect(FakeWorker.messages).toBe(2)
        const written = await repository.get('workspace-1')
        expect(FakeWorker.messages).toBe(2)
        expect(written).toEqual(ledgerAt(1))
        expect(Object.isFrozen(written)).toBe(true)
        expect(await repository.get('workspace-1')).toBe(written)
        store.raw = canonicalSerialize(ledgerAt(2))
        expect(await repository.get('workspace-1')).toEqual(ledgerAt(2))
        expect(FakeWorker.messages).toBe(3)
        store.raw = canonicalSerialize({ ...ledgerAt(2), records: [{}] })
        await expect(repository.get('workspace-1')).rejects.toMatchObject({ code: 'INVALID_EXECUTION_STORE' })
        expect(FakeWorker.instances).toHaveLength(1)
    })
    it('does not let a slower read of an older revision replace the cached newer write', async () => {
        const { repository, store, getItem } = await workerRepository()
        const initial = await repository.get('workspace-1')
        const oldRaw = store.raw
        let release!: () => void
        getItem.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(oldRaw) }))
        const slowRead = repository.get('workspace-1')
        expect(await repository.compareAndSet(initial, ledgerAt(1))).toBe(true)
        release()
        expect(await slowRead).toEqual(ledgerAt(0))
        const messages = FakeWorker.messages
        expect(await repository.get('workspace-1')).toEqual(ledgerAt(1))
        expect(FakeWorker.messages).toBe(messages)
    })
    it('leaves no cache entry for bytes a failed CAS did not write', async () => {
        const { repository, store } = await workerRepository()
        const initial = await repository.get('workspace-1')
        const foreign: AgentExecutionLedger = { ...ledgerAt(1), schemaVersion: 2,
            compacted: [{ requestId: 'foreign', clientId: 'client-1', idempotencyKey: 'foreign' }] }
        store.raw = canonicalSerialize(foreign)
        expect(await repository.compareAndSet(initial, ledgerAt(1))).toBe(false)
        const messages = FakeWorker.messages
        expect(await repository.get('workspace-1')).toEqual(foreign)
        expect(FakeWorker.messages).toBe(messages + 1)
    })
    it('reuses one Worker across calls and starts a fresh one after a Worker error', async () => {
        const { repository } = await workerRepository()
        let current = await repository.get('workspace-1')
        for (let revision = 1; revision <= 3; revision++) {
            expect(await repository.compareAndSet(current, ledgerAt(revision))).toBe(true)
            current = await repository.get('workspace-1')
        }
        expect(FakeWorker.instances).toHaveLength(1)
        const [broken] = FakeWorker.instances
        broken.terminated = true
        const pending = repository.compareAndSet(current, ledgerAt(4))
        broken.onerror!()
        await expect(pending).rejects.toMatchObject({ code: 'INVALID_EXECUTION_STORE' })
        expect(await repository.compareAndSet(current, ledgerAt(4))).toBe(true)
        expect(FakeWorker.instances).toHaveLength(2)
    })
})
