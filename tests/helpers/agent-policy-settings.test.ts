import { beforeEach, describe, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => ({ value: null as string | null, flush: vi.fn(async () => undefined),
    read: vi.fn(async (): Promise<string | null> => storage.value) }))
vi.mock('@/lib/indexed-db', () => ({
    indexedDBStorage: { getItem: async () => storage.value, setItem: async (_key: string, value: string) => { storage.value = value }, removeItem: async () => { storage.value = null } },
    flushIndexedDBKey: () => storage.flush(), getIndexedDBItemStrict: () => storage.read(),
}))
import { DEFAULT_AGENT_EXECUTION_POLICY as defaults } from '@/application/agent/agent-execution-policy'
import { DEFAULT_AGENT_AUTHORING_CONSENT, hasAgentAuthoringConsent } from '@/application/agent/agent-authoring-consent'
import { DEFAULT_AGENT_GENERATION_CONSENT, hasAgentGenerationConsent } from '@/application/agent/agent-generation-consent'
import { isAgentExecutionPolicyUpdatePending, normalizePersistedSettingsState, useSettingsStore } from '@/stores/settings-store'

beforeEach(async () => {
    storage.flush.mockReset().mockResolvedValue(undefined)
    storage.read.mockReset().mockImplementation(async () => storage.value)
    useSettingsStore.setState({ agentExecutionPolicy: structuredClone(defaults), agentAuthoringConsent: structuredClone(DEFAULT_AGENT_AUTHORING_CONSENT),
        agentGenerationConsent: structuredClone(DEFAULT_AGENT_GENERATION_CONSENT) })
})

describe('settings policy persistence', () => {
    it('keeps generation consent default OFF, independent of editing, and durable across ON/OFF hydration', async () => {
        expect(normalizePersistedSettingsState({ agentAuthoringConsent: { schemaVersion: 1, revision: 1,
            approvedClients: [{ workspaceId: 'workspace-1', clientId: 'client-1' }] } }).agentGenerationConsent).toEqual(DEFAULT_AGENT_GENERATION_CONSENT)
        await useSettingsStore.getState().setAgentAuthoringConsent(0, 'workspace-1', 'client-1', true)
        await useSettingsStore.getState().setAgentGenerationConsent(0, 'workspace-1', 'client-1', true)
        await useSettingsStore.persist.rehydrate()
        expect(hasAgentGenerationConsent(useSettingsStore.getState().agentGenerationConsent, 'workspace-1', 'client-1')).toBe(true)
        await useSettingsStore.getState().setAgentGenerationConsent(1, 'workspace-1', 'client-1', false)
        await useSettingsStore.persist.rehydrate()
        expect(useSettingsStore.getState().agentGenerationConsent).toEqual({ schemaVersion: 1, revision: 2, approvedClients: [] })
        expect(useSettingsStore.getState().agentAuthoringConsent.revision).toBe(1)
        expect(useSettingsStore.getState().agentExecutionPolicy).toEqual(defaults)
    })
    it('stages generation consent with normal exclusions and blocks concurrent authority writes before readback', async () => {
        let release!: () => void
        storage.flush.mockImplementationOnce(async () => {
            const staged = JSON.parse(storage.value!).state
            expect(staged).not.toHaveProperty('generationFolders')
            expect(staged).not.toHaveProperty('generationFolderDocument')
            expect(staged).not.toHaveProperty('savePath')
            expect(staged).not.toHaveProperty('useAbsolutePath')
            expect(useSettingsStore.getState().agentGenerationConsent).toEqual(DEFAULT_AGENT_GENERATION_CONSENT)
            await new Promise<void>(resolve => { release = resolve })
        })
        const saving = useSettingsStore.getState().setAgentGenerationConsent(0, 'workspace-1', 'client-1', true)
        await expect(useSettingsStore.getState().setAgentAuthoringConsent(0, 'workspace-1', 'client-1', true)).rejects.toThrow('already being saved')
        expect(isAgentExecutionPolicyUpdatePending()).toBe(true)
        release(); await saving
        expect(isAgentExecutionPolicyUpdatePending()).toBe(false)
    })
    it('never publishes unverified generation ON and never restores ON after a failed OFF', async () => {
        const observed: number[] = []
        const unsubscribe = useSettingsStore.subscribe(state => observed.push(state.agentGenerationConsent.approvedClients.length))
        storage.read.mockRejectedValueOnce(new Error('generation readback failed'))
        await expect(useSettingsStore.getState().setAgentGenerationConsent(0, 'workspace-1', 'client-1', true)).rejects.toThrow('generation readback failed')
        expect(observed.every(count => count === 0)).toBe(true)
        await useSettingsStore.persist.rehydrate()
        expect(useSettingsStore.getState().agentGenerationConsent.approvedClients).toEqual([])
        await useSettingsStore.getState().setAgentGenerationConsent(1, 'workspace-1', 'client-1', true)
        storage.flush.mockRejectedValueOnce(new Error('generation OFF failed'))
        await expect(useSettingsStore.getState().setAgentGenerationConsent(2, 'workspace-1', 'client-1', false)).rejects.toThrow('generation OFF failed')
        await useSettingsStore.persist.rehydrate()
        expect(useSettingsStore.getState().agentGenerationConsent).toEqual({ schemaVersion: 1, revision: 3, approvedClients: [] })
        unsubscribe()
    })
    it('excludes Folder authority from the staged consent write before publication', async () => {
        const folderState = useSettingsStore.getState().generationFolders
        storage.flush.mockImplementationOnce(async () => {
            const staged = JSON.parse(storage.value!).state
            for (const key of ['generationFolders', 'generationFolderDocument', 'savePath', 'useAbsolutePath']) {
                expect(staged).not.toHaveProperty(key)
            }
            expect(staged.agentAuthoringConsent.approvedClients).toEqual([{ workspaceId: 'workspace-1', clientId: 'client-1' }])
            expect(staged.activeGenerationFolderId).toBe(useSettingsStore.getState().activeGenerationFolderId)
        })
        await useSettingsStore.getState().setAgentAuthoringConsent(0, 'workspace-1', 'client-1', true)
        expect(useSettingsStore.getState().generationFolders).toEqual(folderState)
    })
    it('saves independent per-client editing consent, survives hydration and immediately removes it without changing generation policy', async () => {
        const initial = structuredClone(useSettingsStore.getState().agentExecutionPolicy)
        const saved = await useSettingsStore.getState().setAgentAuthoringConsent(0, 'workspace-1', 'client-1', true)
        expect(saved.revision).toBe(1)
        await useSettingsStore.persist.rehydrate()
        const hydrated = useSettingsStore.getState().agentAuthoringConsent
        expect(hasAgentAuthoringConsent(hydrated, 'workspace-1', 'client-1')).toBe(true)
        expect(hasAgentAuthoringConsent(hydrated, 'workspace-2', 'client-1')).toBe(false)
        expect(hasAgentAuthoringConsent(hydrated, 'workspace-1', 'client-2')).toBe(false)
        await useSettingsStore.getState().setAgentAuthoringConsent(1, 'workspace-1', 'client-1', false)
        await useSettingsStore.persist.rehydrate()
        expect(useSettingsStore.getState().agentAuthoringConsent).toMatchObject({ revision: 2, approvedClients: [] })
        expect(useSettingsStore.getState().agentExecutionPolicy).toEqual(initial)
        await expect(useSettingsStore.getState().setAgentAuthoringConsent(0, 'workspace-1', 'client-1', true)).rejects.toThrow('revision changed')
    })
    it('does not grant consent from legacy or malformed settings or after an unverified write', async () => {
        expect(normalizePersistedSettingsState({}).agentAuthoringConsent).toEqual(DEFAULT_AGENT_AUTHORING_CONSENT)
        expect(normalizePersistedSettingsState({ agentAuthoringConsent: { schemaVersion: 1, revision: 1,
            approvedClients: ['client-1'] } }).agentAuthoringConsent).toEqual(DEFAULT_AGENT_AUTHORING_CONSENT)
        storage.flush.mockRejectedValueOnce(new Error('disk unavailable'))
        await expect(useSettingsStore.getState().setAgentAuthoringConsent(0, 'workspace-1', 'client-1', true)).rejects.toThrow('disk unavailable')
        await useSettingsStore.persist.rehydrate()
        expect(useSettingsStore.getState().agentAuthoringConsent.approvedClients).toEqual([])
        expect(useSettingsStore.getState().agentExecutionPolicy).toEqual(defaults)
        expect(isAgentExecutionPolicyUpdatePending()).toBe(false)
    })
    it('blocks new dispatch and concurrent settings changes until editing consent readback finishes', async () => {
        let release!: () => void
        storage.flush.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
        const saving = useSettingsStore.getState().setAgentAuthoringConsent(0, 'workspace-1', 'client-1', true)
        expect(isAgentExecutionPolicyUpdatePending()).toBe(true)
        expect(useSettingsStore.getState().agentAuthoringConsent).toEqual(DEFAULT_AGENT_AUTHORING_CONSENT)
        await expect(useSettingsStore.getState().setAgentExecutionPolicy(0, defaults)).rejects.toThrow('already being saved')
        await expect(useSettingsStore.getState().setAgentAuthoringConsent(0, 'workspace-1', 'client-2', true)).rejects.toThrow('already being saved')
        release(); await saving
        expect(isAgentExecutionPolicyUpdatePending()).toBe(false)
    })
    it('does not publish staged ON before readback or restore ON after failed OFF', async () => {
        const observed: unknown[] = []
        const unsubscribe = useSettingsStore.subscribe(state => { observed.push(structuredClone(state.agentAuthoringConsent)) })
        storage.read.mockRejectedValueOnce(new Error('readback unavailable'))
        await expect(useSettingsStore.getState().setAgentAuthoringConsent(0, 'workspace-1', 'client-1', true)).rejects.toThrow('readback unavailable')
        expect(observed.every(value => (value as typeof DEFAULT_AGENT_AUTHORING_CONSENT).approvedClients.length === 0)).toBe(true)
        await useSettingsStore.persist.rehydrate()
        expect(useSettingsStore.getState().agentAuthoringConsent.approvedClients).toEqual([])
        await useSettingsStore.getState().setAgentAuthoringConsent(1, 'workspace-1', 'client-1', true)
        storage.flush.mockRejectedValueOnce(new Error('OFF flush unavailable'))
        await expect(useSettingsStore.getState().setAgentAuthoringConsent(2, 'workspace-1', 'client-1', false)).rejects.toThrow('OFF flush unavailable')
        expect(useSettingsStore.getState().agentAuthoringConsent).toMatchObject({ revision: 3, approvedClients: [] })
        await useSettingsStore.persist.rehydrate()
        expect(useSettingsStore.getState().agentAuthoringConsent).toMatchObject({ revision: 3, approvedClients: [] })
        expect(useSettingsStore.getState().agentExecutionPolicy).toEqual(defaults)
        unsubscribe()
    })
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
