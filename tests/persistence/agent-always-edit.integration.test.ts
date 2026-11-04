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
import { flushIndexedDBKey, getIndexedDBItemStrict, resetIndexedDBConnectionForRetry } from '@/lib/indexed-db'
import { useSettingsStore } from '@/stores/settings-store'
import type { GenerationFolderDocument } from '@/domain/generation-folders'
import type { JsonObject } from '@/domain/composition/types'

it('edits real persisted Scenes twice using signed requests and durable consent; restart, OFF and validation retain authority', async () => {
    // Isolated IndexedDB and an ephemeral test HMAC: no installed-app, native keyring or Provider evidence.
    await useSettingsStore.persist.rehydrate()
    useSettingsStore.setState({ agentExecutionPolicy: structuredClone(DEFAULT_AGENT_EXECUTION_POLICY),
        agentAuthoringConsent: structuredClone(DEFAULT_AGENT_AUTHORING_CONSENT) })
    await flushIndexedDBKey('nai-blue-settings')
    const workspaceId = 'always-edit-integration'
    const clientId = 'always-edit-client'
    const presetId = 'always-edit-preset'
    const sceneId = 'always-edit-scene'
    const subtle = webcrypto.subtle as unknown as SubtleCrypto
    const key = await subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
    const authentication = new WebCryptoAgentAuthentication(async (id, keyId) => id === clientId && keyId === 'test-key'
        ? { clientId, keyId, label: 'Isolated test client', actorKind: 'agent', createdAt: new Date().toISOString(), revokedAt: null, key } : null, subtle)
    const folders: GenerationFolderDocument = { schemaVersion: 2, workspaceId: 'local', revision: 0, folders: [] }
    const enqueue = vi.fn(async () => { throw new Error('Provider/Queue execution is excluded') })
    const open = () => {
        const scenes = new IndexedDbSceneRepository()
        const authoring = createAgentAuthoringService({ scenes, folderWorkspaceId: 'local', readFolders: async () => folders,
            folderDefaults: () => ({ directory: 'output', useAbsolutePath: false, r2ProfileId: null }),
            applyFolders: async () => { throw new Error('Scene fixture never changes folders') },
            flushScenes: async () => undefined, projectScene: async () => undefined, projectFolders: () => undefined, hasPreset: () => true })
        const receipts = new IndexedDbCommandReceiptRepository()
        const coordinator = createAgentExecutionCoordinator({ workspaceId, receipts, authoring,
            repository: new IndexedDbAgentExecutionRepository(), plans: { get: async () => null, putIfAbsent: async () => 'same' },
            getPolicy: () => useSettingsStore.getState().agentExecutionPolicy,
            getAuthoringConsent: () => useSettingsStore.getState().agentAuthoringConsent,
            isClientAuthorized: async envelope => { await authentication.authenticate(envelope, new Date().toISOString()); return true },
            ports: { enqueue, validate: async () => false, reconcile: async () => null, isOutstanding: async () => false } })
        const dispatcher = new AgentCommandDispatcher({ workspaceId, receipts, authentication,
            handlers: [coordinator.handler, ...coordinator.authoringHandlers],
            runtime: () => ({ ready: true, mode: 'suggest', globalPause: false }) })
        return { scenes, coordinator, dispatcher }
    }
    const signed = async (requestId: string, input: JsonObject): Promise<AgentCommandEnvelope> => {
        const envelope: AgentCommandEnvelope = { schemaVersion: 1, requestId, requestHash: `sha256:${'0'.repeat(64)}`,
            submittedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
            context: { apiVersion: 'nai-blue.agent/v1alpha1', workspaceId, clientId, actor: { kind: 'agent' }, idempotencyKey: requestId },
            command: { name: 'scene.patch_many', input }, authentication: { scheme: 'hmac-sha256', keyId: 'test-key', signature: `hmac-sha256:${'0'.repeat(64)}` } }
        const hashed = { ...envelope, requestHash: agentRequestHash(envelope) }
        const signature = await subtle.sign('HMAC', key, new TextEncoder().encode(canonicalAgentSigningPayload(hashed)))
        return { ...hashed, authentication: { ...hashed.authentication, signature: `hmac-sha256:${Buffer.from(signature).toString('hex')}` } }
    }
    let runtime = open()
    await useSettingsStore.getState().setAgentAuthoringConsent(0, workspaceId, clientId, true)
    const first = await signed('real-edit-first', { presetId, presetName: 'Isolated editing proof', expectedRevision: 0,
        changes: [{ sceneId, name: 'First edit', prompts: { base: 'first fixture prompt' } }] })
    expect(await runtime.dispatcher.dispatch(first)).toMatchObject({ state: 'completed', result: { revision: 1 } })
    expect(await runtime.dispatcher.dispatch(first)).toMatchObject({ state: 'completed', result: { revision: 1 } })
    const settingsBytes = (await getIndexedDBItemStrict('nai-blue-settings'))!
    expect(JSON.parse(settingsBytes).state.agentAuthoringConsent.approvedClients).toEqual([{ workspaceId, clientId }])
    resetIndexedDBConnectionForRetry()
    await useSettingsStore.persist.rehydrate()
    runtime = open()
    await runtime.coordinator.recover()
    const second = await signed('real-edit-second', { presetId, expectedRevision: 1,
        changes: [{ sceneId, name: 'Second edit', prompts: { base: 'second fixture prompt' } }] })
    expect(await runtime.dispatcher.dispatch(second)).toMatchObject({ state: 'completed', result: { revision: 2 } })
    expect(await runtime.scenes.getDocument(presetId)).toMatchObject({ revision: 2,
        scenes: [{ id: sceneId, name: 'Second edit', prompts: { base: 'second fixture prompt' }, artifactRefs: [] }] })
    const forged = await signed('real-forged-edit', { presetId, expectedRevision: 2, changes: [{ sceneId, name: 'Forged' }] })
    await expect(runtime.dispatcher.dispatch({ ...forged, authentication: { ...forged.authentication,
        signature: `hmac-sha256:${'0'.repeat(64)}` } })).rejects.toThrow()
    const stale = await signed('real-stale-edit', { presetId, expectedRevision: 1, changes: [{ sceneId, name: 'Stale' }] })
    expect((await runtime.dispatcher.dispatch(stale)).state).not.toBe('completed')
    await useSettingsStore.getState().setAgentAuthoringConsent(1, workspaceId, clientId, false)
    const third = await signed('real-off-edit', { presetId, expectedRevision: 2, changes: [{ sceneId, name: 'Requires approval' }] })
    expect(await runtime.dispatcher.dispatch(third)).toMatchObject({ state: 'needs-input', result: { code: 'AGENT_APPROVAL_REQUIRED' } })
    expect((await runtime.scenes.getDocument(presetId))?.revision).toBe(2)
    expect(useSettingsStore.getState().agentExecutionPolicy).toEqual(DEFAULT_AGENT_EXECUTION_POLICY)
    expect(enqueue).not.toHaveBeenCalled()
})
