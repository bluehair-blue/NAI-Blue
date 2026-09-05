import { beforeEach, describe, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => ({ value: null as string | null, flush: vi.fn(async () => undefined) }))
vi.mock('@/lib/indexed-db', () => ({
    indexedDBStorage: { getItem: async () => storage.value, setItem: async (_key: string, value: string) => { storage.value = value }, removeItem: async () => { storage.value = null } },
    flushIndexedDBKey: () => storage.flush(), getIndexedDBItemStrict: async () => storage.value,
}))
import { DEFAULT_AGENT_EXECUTION_POLICY as defaults } from '@/application/agent/agent-execution-policy'
import { isAgentExecutionPolicyUpdatePending, normalizePersistedSettingsState, useSettingsStore } from '@/stores/settings-store'

beforeEach(async () => {
    storage.flush.mockReset().mockResolvedValue(undefined)
    useSettingsStore.setState({ agentExecutionPolicy: structuredClone(defaults) })
})

describe('settings policy persistence', () => {
    it('normalizes authority both for old migration and same-version hydration', async () => {
        expect(normalizePersistedSettingsState({}).agentExecutionPolicy).toEqual(defaults)
        storage.value = JSON.stringify({ version: 2, state: { agentExecutionPolicy: { ...defaults, output: { allowOverwrite: true } } } })
        await useSettingsStore.persist.rehydrate()
        expect(useSettingsStore.getState().agentExecutionPolicy).toMatchObject({ mode: 'observe', globalPause: true })
        storage.value = JSON.stringify({ version: 1, state: { sceneSavePath: 'existing-scene' } })
        await useSettingsStore.persist.rehydrate()
        expect(useSettingsStore.getState().agentExecutionPolicy).toEqual(defaults)
        expect(useSettingsStore.getState().sceneSavePath).toBe('existing-scene')
    })
    it('awaits persistence, rejects simultaneous changes and survives hydration with its revision', async () => {
        let release!: () => void
        storage.flush.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
        const first = useSettingsStore.getState().setAgentExecutionPolicy(0, { ...defaults, globalPause: true })
        expect(isAgentExecutionPolicyUpdatePending()).toBe(true)
        await expect(useSettingsStore.getState().setAgentExecutionPolicy(0, defaults)).rejects.toThrow('already being saved')
        release(); await expect(first).resolves.toMatchObject({ revision: 1, globalPause: true })
        await useSettingsStore.persist.rehydrate()
        expect(useSettingsStore.getState().agentExecutionPolicy.revision).toBe(1)
        await expect(useSettingsStore.getState().setAgentExecutionPolicy(0, defaults)).rejects.toThrow('revision changed')
    })
    it('fails closed when the write cannot be verified', async () => {
        storage.flush.mockRejectedValueOnce(new Error('disk unavailable'))
        await expect(useSettingsStore.getState().setAgentExecutionPolicy(0, defaults)).rejects.toThrow('disk unavailable')
        expect(isAgentExecutionPolicyUpdatePending()).toBe(false)
        expect(useSettingsStore.getState().agentExecutionPolicy).toMatchObject({ mode: 'observe', globalPause: true })
        await useSettingsStore.persist.rehydrate()
        expect(useSettingsStore.getState().agentExecutionPolicy).toMatchObject({ mode: 'observe', globalPause: true })
    })
})
