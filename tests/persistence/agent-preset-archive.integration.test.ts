import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { IndexedDbSceneRepository } from '@/adapters/scene/indexeddb-scene-repository'
import { IndexedDbCommandReceiptRepository } from '@/adapters/agent/indexeddb-command-receipt-repository'
import { IndexedDbAgentExecutionRepository } from '@/adapters/agent/indexeddb-agent-execution-repository'
import { WebCryptoAgentAuthentication } from '@/adapters/agent/webcrypto-agent-authentication'
import { createAgentAuthoringService } from '@/application/agent/agent-authoring-service'
import { createAgentExecutionCoordinator } from '@/application/agent/agent-execution-coordinator'
import { AgentCommandDispatcher } from '@/application/agent/agent-command-dispatcher'
import { agentRequestHash, canonicalAgentSigningPayload, type AgentCommandEnvelope } from '@/application/agent/agent-command-contract'
import { DEFAULT_AGENT_EXECUTION_POLICY } from '@/application/agent/agent-execution-policy'
import { DEFAULT_AGENT_AUTHORING_CONSENT } from '@/application/agent/agent-authoring-consent'
import { flushIndexedDBKey } from '@/lib/indexed-db'
import { useSettingsStore } from '@/stores/settings-store'
import type { GenerationFolderDocument } from '@/domain/generation-folders'
import type { JsonObject } from '@/domain/composition/types'

it('archives and restores a preset through signed scene.patch_many with durable consent, leaving Scene content and revision alone', async () => {
    // Isolated IndexedDB and an ephemeral test HMAC; the archive flag lives in an in-memory stand-in for the navigation shell.
    await useSettingsStore.persist.rehydrate()
    useSettingsStore.setState({ agentExecutionPolicy: structuredClone(DEFAULT_AGENT_EXECUTION_POLICY),
        agentAuthoringConsent: structuredClone(DEFAULT_AGENT_AUTHORING_CONSENT) })
    await flushIndexedDBKey('nai-blue-settings')
    const workspaceId = 'preset-archive-integration'
    const clientId = 'preset-archive-client'
    const presetId = 'preset-archive-draft'
    const subtle = webcrypto.subtle as unknown as SubtleCrypto
    const key = await subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
    const authentication = new WebCryptoAgentAuthentication(async (id, keyId) => id === clientId && keyId === 'test-key'
        ? { clientId, keyId, label: 'Isolated test client', actorKind: 'agent', createdAt: new Date().toISOString(), revokedAt: null, key } : null, subtle)
    const folders: GenerationFolderDocument = { schemaVersion: 2, workspaceId: 'local', revision: 0, folders: [] }
    const archived = new Set<string>()
    const setArchived = vi.fn(async (id: string, value: boolean) => { if (value) archived.add(id); else archived.delete(id) })
    const scenes = new IndexedDbSceneRepository()
    const authoring = createAgentAuthoringService({ scenes, folderWorkspaceId: 'local', readFolders: async () => folders,
        folderDefaults: () => ({ directory: 'output', useAbsolutePath: false, r2ProfileId: null }),
        applyFolders: async () => { throw new Error('Scene fixture never changes folders') },
        flushScenes: async () => undefined, projectScene: async () => undefined, projectFolders: () => undefined,
        hasPreset: id => id === presetId || id === 'scene-default',
        presetArchive: { isArchived: id => archived.has(id), canArchive: id => id !== 'scene-default', set: setArchived } })
    const receipts = new IndexedDbCommandReceiptRepository()
    const coordinator = createAgentExecutionCoordinator({ workspaceId, receipts, authoring,
        repository: new IndexedDbAgentExecutionRepository(), plans: { get: async () => null, putIfAbsent: async () => 'same' },
        getPolicy: () => useSettingsStore.getState().agentExecutionPolicy,
        getAuthoringConsent: () => useSettingsStore.getState().agentAuthoringConsent,
        isClientAuthorized: async envelope => { await authentication.authenticate(envelope, new Date().toISOString()); return true },
        ports: { enqueue: async () => { throw new Error('excluded') }, validate: async () => false, reconcile: async () => null, isOutstanding: async () => false } })
    const dispatcher = new AgentCommandDispatcher({ workspaceId, receipts, authentication,
        handlers: [coordinator.handler, ...coordinator.authoringHandlers],
        runtime: () => ({ ready: true, mode: 'suggest', globalPause: false }) })
    const signed = async (requestId: string, input: JsonObject): Promise<AgentCommandEnvelope> => {
        const envelope: AgentCommandEnvelope = { schemaVersion: 1, requestId, requestHash: `sha256:${'0'.repeat(64)}`,
            submittedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
            context: { apiVersion: 'nai-blue.agent/v1alpha1', workspaceId, clientId, actor: { kind: 'agent' }, idempotencyKey: requestId },
            command: { name: 'scene.patch_many', input }, authentication: { scheme: 'hmac-sha256', keyId: 'test-key', signature: `hmac-sha256:${'0'.repeat(64)}` } }
        const hashed = { ...envelope, requestHash: agentRequestHash(envelope) }
        const signature = await subtle.sign('HMAC', key, new TextEncoder().encode(canonicalAgentSigningPayload(hashed)))
        return { ...hashed, authentication: { ...hashed.authentication, signature: `hmac-sha256:${Buffer.from(signature).toString('hex')}` } }
    }
    const dispatch = async (requestId: string, input: JsonObject) => dispatcher.dispatch(await signed(requestId, input))

    // Without editing consent an archive waits for the human like any other edit, and nothing changes.
    await useSettingsStore.getState().setAgentAuthoringConsent(0, workspaceId, clientId, true)
    expect(await dispatch('archive-create', { presetId, presetName: 'Throw-away draft', expectedRevision: 0,
        changes: [{ sceneId: 'draft-scene', name: 'Draft', prompts: { base: 'draft prompt' } }] })).toMatchObject({ state: 'completed', result: { revision: 1 } })
    await useSettingsStore.getState().setAgentAuthoringConsent(1, workspaceId, clientId, false)
    expect(await dispatch('archive-without-consent', { presetId, expectedRevision: 1, changes: [], presetArchived: true }))
        .toMatchObject({ state: 'needs-input', result: { code: 'AGENT_APPROVAL_REQUIRED' } })
    expect(archived.size).toBe(0)
    await useSettingsStore.getState().setAgentAuthoringConsent(2, workspaceId, clientId, true)

    const before = JSON.stringify(await scenes.getDocument(presetId))
    const archiveRequest = await signed('archive-draft', { presetId, expectedRevision: 1, changes: [], presetArchived: true })
    const archive = await dispatcher.dispatch(archiveRequest)
    expect(archive).toMatchObject({ state: 'completed', result: { status: 'authoring-committed', revision: 1 } })
    expect(archived.has(presetId)).toBe(true)
    expect(JSON.stringify(await scenes.getDocument(presetId))).toBe(before)
    // The same request replays its receipt and does not archive twice.
    expect(await dispatcher.dispatch(archiveRequest)).toEqual(archive)
    expect(setArchived).toHaveBeenCalledTimes(1)

    expect(await dispatch('edit-archived', { presetId, expectedRevision: 1, changes: [{ sceneId: 'draft-scene', name: 'Edited' }] }))
        .toMatchObject({ state: 'rejected', result: { code: 'AGENT_PRESET_ARCHIVED' } })
    expect(JSON.stringify(await scenes.getDocument(presetId))).toBe(before)
    expect(await dispatch('archive-default', { presetId: 'scene-default', expectedRevision: 0, changes: [], presetArchived: true }))
        .toMatchObject({ state: 'rejected', result: { code: 'AGENT_PRESET_NOT_ARCHIVABLE' } })
    await expect(dispatch('empty-edit', { presetId, expectedRevision: 1, changes: [] })).rejects.toThrow()

    expect(await dispatch('restore-and-edit', { presetId, expectedRevision: 1, presetArchived: false,
        changes: [{ sceneId: 'draft-scene', name: 'Edited after restore' }] })).toMatchObject({ state: 'completed', result: { revision: 2 } })
    expect(archived.has(presetId)).toBe(false)
    expect(await scenes.getDocument(presetId)).toMatchObject({ revision: 2, scenes: [{ id: 'draft-scene', name: 'Edited after restore',
        prompts: { base: 'draft prompt' } }] })
})
