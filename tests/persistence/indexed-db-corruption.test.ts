import { webcrypto } from 'node:crypto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IndexedDbCommandReceiptRepository, agentCommandReceiptKey } from '@/adapters/agent/indexeddb-command-receipt-repository'
import { processAgentInboxFile } from '@/adapters/agent/inbox/process-agent-inbox-file'
import { WebCryptoAgentAuthentication } from '@/adapters/agent/webcrypto-agent-authentication'
import { IndexedDbGenerationPlanRepository, generationPlanStorageKey } from '@/adapters/generation/indexeddb-generation-plan-repository'
import { agentRequestHash, canonicalAgentSigningPayload, type AgentCommandEnvelope } from '@/application/agent/agent-command-contract'
import { AgentCommandDispatcher } from '@/application/agent/agent-command-dispatcher'
import { planGeneration } from '@/application/generation/plan-generation'
import { createSingleImageDraft, reviseSingleImageDraft } from '@/domain/workflow/single-image-draft'
import { compareAndSetIndexedDBItem, getIndexedDBItemStrict, resetIndexedDBConnectionForRetry } from '@/lib/indexed-db'

let rawDb: IDBDatabase

// Bypass the string API to reproduce persisted corruption and inspect exact surviving values.
function rawRequest<T>(mode: IDBTransactionMode, request: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        const transaction = rawDb.transaction('keyval', mode)
        const operation = request(transaction.objectStore('keyval'))
        transaction.oncomplete = () => resolve(operation.result)
        transaction.onabort = () => reject(transaction.error)
        transaction.onerror = () => reject(transaction.error)
    })
}

beforeEach(async () => {
    resetIndexedDBConnectionForRetry()
    vi.stubGlobal('indexedDB', new IDBFactory())
    await getIndexedDBItemStrict('initialize')
    rawDb = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('nai-blue-db', 1)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
})
afterEach(() => { rawDb?.close(); resetIndexedDBConnectionForRetry(); vi.unstubAllGlobals() })

describe('non-string IndexedDB authority corruption', () => {
    it.each([{ label: 'object', value: { state: 'accepted' } }, { label: 'null', value: null },
        { label: 'undefined', value: undefined }, { label: 'number', value: 42 }])(
        'rejects strict reads and absent-value CAS for a stored $label without removing it', async ({ value }) => {
            await rawRequest('readwrite', store => store.put(value, 'corrupt'))
            await expect(getIndexedDBItemStrict('corrupt')).rejects.toThrow()
            await expect(compareAndSetIndexedDBItem('corrupt', null, 'replacement')).rejects.toThrow()
            // getAll distinguishes a stored undefined ([undefined]) from a missing key ([]).
            expect(await rawRequest('readonly', store => store.getAll('corrupt'))).toEqual([value])
        },
    )

    it('still inserts missing keys and compares existing strings exactly', async () => {
        expect(await getIndexedDBItemStrict('valid')).toBeNull()
        expect(await compareAndSetIndexedDBItem('valid', null, 'first')).toBe(true)
        expect(await compareAndSetIndexedDBItem('valid', null, 'overwrite')).toBe(false)
        expect(await compareAndSetIndexedDBItem('valid', 'wrong', 'overwrite')).toBe(false)
        expect(await compareAndSetIndexedDBItem('valid', 'first', 'second')).toBe(true)
        expect(await getIndexedDBItemStrict('valid')).toBe('second')
    })

    it.each(['before-read', 'before-claim'] as const)(
        'preserves a corrupt receipt injected %s without executing or publishing rejection', async timing => {
            const subtle = webcrypto.subtle as unknown as SubtleCrypto
            const key = await subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
            const authentication = new WebCryptoAgentAuthentication(async (clientId, keyId) => (
                clientId === 'client-1' && keyId === 'key-1'
                    ? { clientId, keyId, revokedAt: null, actorKind: 'agent', key } : null
            ), subtle)
            const envelope: AgentCommandEnvelope = {
                schemaVersion: 1, requestId: 'corrupt-receipt', requestHash: `sha256:${'0'.repeat(64)}`,
                submittedAt: '2026-09-05T00:00:00.000Z', expiresAt: '2026-09-05T01:00:00.000Z',
                context: { apiVersion: 'nai-blue.agent/v1alpha1', workspaceId: 'workspace-1', clientId: 'client-1',
                    actor: { kind: 'agent' }, idempotencyKey: 'corrupt-receipt' },
                command: { name: 'workspace.get_snapshot', input: {} },
                authentication: { scheme: 'hmac-sha256', keyId: 'key-1', signature: `hmac-sha256:${'0'.repeat(64)}` },
            }
            const hashed = { ...envelope, requestHash: agentRequestHash(envelope) }
            const signature = await subtle.sign('HMAC', key, new TextEncoder().encode(canonicalAgentSigningPayload(hashed)))
            const signed = { ...hashed, authentication: { ...hashed.authentication,
                signature: `hmac-sha256:${Buffer.from(signature).toString('hex')}` } }
            const receiptKey = agentCommandReceiptKey(envelope.requestId)
            const corrupt = { state: 'accepted', requestId: envelope.requestId }
            const insertCorruption = () => rawRequest('readwrite', store => store.put(corrupt, receiptKey))
            const repository = new IndexedDbCommandReceiptRepository()
            if (timing === 'before-read') {
                await insertCorruption()
                await expect(repository.get(envelope.requestId)).rejects.toThrow()
            }
            const racedRead = vi.fn(async (storageKey: string) => {
                const current = await getIndexedDBItemStrict(storageKey)
                expect(current).toBeNull()
                // Another writer commits corruption after the read but before the real atomic claim.
                await insertCorruption()
                return current
            })
            const execute = vi.fn(async () => ({ count: 1 }))
            const dispatcher = new AgentCommandDispatcher({
                workspaceId: 'workspace-1', authentication,
                receipts: timing === 'before-read' ? repository : new IndexedDbCommandReceiptRepository({
                    getItem: racedRead, compareAndSet: compareAndSetIndexedDBItem,
                }),
                handlers: [{ command: 'workspace.get_snapshot', effect: 'read', validate: input => input, execute }],
                runtime: () => ({ ready: true, mode: 'suggest', globalPause: false }),
                now: () => '2026-09-05T00:00:01.000Z',
            })
            const files = { readReady: vi.fn(async () => JSON.stringify(signed)),
                publishResult: vi.fn(), publishRejection: vi.fn() }
            await expect(processAgentInboxFile('corrupt-receipt.ready.json', files, dispatcher)).rejects.toThrow()
            if (timing === 'before-claim') expect(racedRead).toHaveBeenCalledTimes(1)
            expect(execute).not.toHaveBeenCalled()
            expect(files.publishResult).not.toHaveBeenCalled()
            expect(files.publishRejection).not.toHaveBeenCalled()
            expect(await rawRequest('readonly', store => store.getAll(receiptKey))).toEqual([corrupt])
        },
    )

    it('rejects generation plan reads and valid plan writes over a stored object', async () => {
        const initial = createSingleImageDraft({ id: 'draft-1', now: '2026-09-05T00:00:00.000Z', seed: 42 })
        const draft = reviseSingleImageDraft(initial, { updatedAt: '2026-09-05T00:00:01.000Z',
            payload: { ...initial.payload, prompt: { positive: 'blue hair', negative: 'lowres' } } })
        const result = await planGeneration({
            source: { kind: 'workflow-draft', draftId: draft.id, expectedRevision: draft.revision },
            count: 1, seedPolicy: { kind: 'fixed', seed: 42 }, budget: { maxImages: 1, maxAnlas: 100 },
        }, {
            drafts: { get: async () => draft },
            planner: { prepare: async ({ materializedSeeds }) => materializedSeeds.map(seed => ({
                semantic: { prompt: 'blue hair', negativePrompt: 'lowres', model: 'nai-diffusion-4-5-full',
                    width: 832, height: 1216, steps: 28, seed, generationParameters: {}, resourceDigest: `sha256:${'a'.repeat(64)}` },
                preparationDigest: `sha256:${'b'.repeat(64)}`,
                destination: { generationFolderId: null, generationFolderPathHash: null, outputPolicyId: 'local',
                    expectedBaseName: 'image', extension: 'png', collisionPolicy: 'fail', deliveryRequired: true },
                prepared: { output: 'image.png' },
            })) },
            executionPolicy: { failurePolicy: 'continue', retryPolicyId: 'safe-v1', maxAttempts: 2,
                maxConcurrency: 1, pricingBasis: 'paid' },
            estimateAnlas: () => 7,
            resolveCompatibility: () => ({ compatibilityProfileId: 'nai:test', status: 'captured-pass' }),
        })
        if (result.status !== 'ready') throw new Error(`Planner fixture failed: ${result.status}`)
        const repository = new IndexedDbGenerationPlanRepository()
        expect(await repository.putIfAbsent(result.plan)).toBe('stored')
        const storageKey = generationPlanStorageKey(result.plan.planId)
        const corrupt = { schemaVersion: 1, plan: result.plan }
        await rawRequest('readwrite', store => store.put(corrupt, storageKey))
        await expect(repository.get(result.plan.planId)).rejects.toThrow()
        await expect(repository.putIfAbsent(result.plan)).rejects.toThrow()
        expect(await rawRequest('readonly', store => store.getAll(storageKey))).toEqual([corrupt])
    })
})
