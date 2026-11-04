import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'

import { createSyncEnvelope } from '@/domain/sync'
import { typeFixtureDocument } from '@/domain/composition/types.typecheck'
import type { CompositionDocument } from '@/domain/composition/types'
import {
    IndexedDBSyncOutboxRepository,
    SyncOutboxRepositoryError,
    syncDatabaseNameForUser,
} from '@/services/sync/outbox-repository'
import { LATER, NOW, repository, wrappedImageCanary } from './fixtures'

function localSceneInput(overrides: Record<string, unknown> = {}) {
    return {
        opId: 'op:a:1',
        entityType: 'scene.card' as const,
        entityId: 'scene:1',
        op: 'upsert' as const,
        deviceId: 'device:a',
        userId: 'user:1',
        createdAt: NOW,
        payload: {
            id: 'scene:1', presetId: 'preset:1', name: 'Scene', scenePrompt: 'offline prompt',
            width: 832, height: 1216, createdAt: 1, orderKey: '0001',
        },
        ...overrides,
    }
}

async function clearProjectionExceptTombstone(factory: IDBFactory, databaseName: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const request = factory.open(databaseName, 2)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
            const database = request.result
            const transaction = database.transaction(['entities', 'inbox', 'outbox'], 'readwrite')
            transaction.objectStore('entities').clear()
            transaction.objectStore('inbox').clear()
            transaction.objectStore('outbox').clear()
            transaction.oncomplete = () => {
                database.close()
                resolve()
            }
            transaction.onerror = () => reject(transaction.error)
            transaction.onabort = () => reject(transaction.error ?? new Error('Fixture transaction aborted'))
        }
    })
}

describe('transactional sync outbox repository', () => {
    it('creates normalized stores and atomically writes the entity revision with its outbox operation', async () => {
        const sync = repository('schema')
        await sync.initialize()
        expect(await sync.inspectSchema()).toEqual({
            version: 2,
            stores: ['checkpoints', 'entities', 'inbox', 'outbox', 'tombstones'],
            indexes: {
                entities: ['by-conflict-parent', 'by-entity-type', 'by-original-entity'],
                inbox: ['by-entity', 'by-entity-status', 'by-received-at'],
                outbox: ['by-entity', 'by-entity-revision', 'by-next-at', 'by-state'],
                tombstones: ['by-entity-type'],
            },
        })

        const envelope = await sync.applyLocalMutation(localSceneInput())
        expect(envelope).toMatchObject({ baseRevision: 0, revision: 1, encrypted: false })
        expect(await sync.getEntity('scene.card', 'scene:1')).toMatchObject({
            revision: 1,
            sourceOpId: 'op:a:1',
            payload: { scenePrompt: 'offline prompt' },
        })
        expect(await sync.listEntities('scene.card')).toEqual([
            expect.objectContaining({ entityId: 'scene:1', sourceOpId: 'op:a:1' }),
        ])
        expect(await sync.listEntities('prompt.preset')).toEqual([])
        expect(await sync.getOutbox('op:a:1')).toMatchObject({
            state: 'pending',
            attemptCount: 0,
            nextAttemptAt: NOW,
            envelope: { revision: 1 },
        })
    })

    it('keeps same-op delivery idempotent and rolls back a conflicting duplicate without changing the entity', async () => {
        const sync = repository('duplicate')
        const first = await sync.applyLocalMutation(localSceneInput())
        const repeated = await sync.applyLocalMutation(localSceneInput())
        expect(repeated).toEqual(first)

        await expect(sync.applyLocalMutation(localSceneInput({
            payload: { ...localSceneInput().payload, scenePrompt: 'different content' },
        }))).rejects.toMatchObject({ code: 'E_SYNC_DUPLICATE_CONFLICT' })
        expect(await sync.getEntity('scene.card', 'scene:1')).toMatchObject({
            revision: 1,
            payload: { scenePrompt: 'offline prompt' },
        })
        expect((await sync.listOutbox({ includeAcked: true }))).toHaveLength(1)

        await sync.applyLocalMutation(localSceneInput({
            opId: 'op:a:2',
            createdAt: LATER,
            payload: { ...localSceneInput().payload, scenePrompt: 'later edit' },
        }))
        await expect(sync.applyLocalMutation(localSceneInput())).resolves.toEqual(first)
        expect(await sync.getEntity('scene.card', 'scene:1')).toMatchObject({
            revision: 2,
            sourceOpId: 'op:a:2',
            payload: { scenePrompt: 'later edit' },
        })
    })

    it('persists offline pending edits across close and reconnect without a transport', async () => {
        const factory = new IDBFactory()
        const databaseName = 'nai-blue-sync-offline-reopen'
        const options = {
            factory: factory as unknown as globalThis.IDBFactory,
            keyRange: IDBKeyRange as unknown as typeof globalThis.IDBKeyRange,
            databaseName,
            userId: 'user:1',
        }
        const before = new IndexedDBSyncOutboxRepository(options)
        await before.applyLocalMutation(localSceneInput())
        await before.close()

        const after = new IndexedDBSyncOutboxRepository(options)
        expect(await after.listReadyOutbox({ now: LATER })).toEqual([
            expect.objectContaining({ envelope: expect.objectContaining({ opId: 'op:a:1' }), state: 'pending' }),
        ])
        expect(await after.getEntity('scene.card', 'scene:1')).toMatchObject({ revision: 1 })
    })

    it('stores bounded retry state and atomically advances acknowledgements with a monotonic checkpoint', async () => {
        const sync = repository('retry-ack')
        await sync.applyLocalMutation(localSceneInput())
        const attempt = await sync.markAttempt({ opId: 'op:a:1', attemptedAt: LATER })
        if (attempt.inFlightUntil === null) throw new Error('Expected an in-flight lease')
        await sync.scheduleRetry({
            opId: 'op:a:1',
            nextAttemptAt: '2026-07-15T00:00:05.000Z',
            failureCode: 'E_SYNC_TEMPORARY',
            expectedAttemptCount: attempt.attemptCount,
            expectedInFlightUntil: attempt.inFlightUntil,
        })
        expect(await sync.getOutbox('op:a:1')).toMatchObject({
            state: 'retry', attemptCount: 1, lastAttemptAt: LATER,
            nextAttemptAt: '2026-07-15T00:00:05.000Z', lastFailureCode: 'E_SYNC_TEMPORARY',
        })
        expect(await sync.listReadyOutbox({ now: '2026-07-15T00:00:04.000Z' })).toEqual([])

        const checkpoint = { sequence: 7, cursor: 'YWJjZGVmZ2hpamts' }
        await sync.acknowledge({ opIds: ['op:a:1'], peerId: 'peer:local-sim', checkpoint, ackedAt: LATER })
        await sync.acknowledge({ opIds: ['op:a:1'], peerId: 'peer:local-sim', checkpoint, ackedAt: LATER })
        expect(await sync.getOutbox('op:a:1')).toMatchObject({ state: 'acked', ackedAt: LATER })
        expect(await sync.getCheckpoint('peer:local-sim')).toMatchObject(checkpoint)
        expect(await sync.listReadyOutbox({ now: '2026-07-15T00:00:09.000Z' })).toEqual([])

        await expect(sync.acknowledge({
            opIds: [], peerId: 'peer:local-sim', checkpoint: { sequence: 6, cursor: 'cursor:6' }, ackedAt: LATER,
        })).rejects.toMatchObject({ code: 'E_SYNC_CHECKPOINT_REGRESSION' })
    })

    it('never stores raw retry errors or unsafe payload fields', async () => {
        const sync = repository('safety')
        const canary = 'secret-canary-value'
        await expect(sync.applyLocalMutation(localSceneInput({
            payload: { ...localSceneInput().payload, authorization: canary, images: [`data:image/png;base64,${canary}`] },
        }))).resolves.toMatchObject({ payload: expect.not.objectContaining({ authorization: expect.anything() }) })

        const attempt = await sync.markAttempt({ opId: 'op:a:1', attemptedAt: LATER })
        if (attempt.inFlightUntil === null) throw new Error('Expected an in-flight lease')
        await expect(sync.scheduleRetry({
            opId: 'op:a:1', nextAttemptAt: LATER, failureCode: `provider said ${canary}`,
            expectedAttemptCount: attempt.attemptCount, expectedInFlightUntil: attempt.inFlightUntil,
        })).rejects.toBeInstanceOf(SyncOutboxRepositoryError)

        const stored = JSON.stringify({
            entity: await sync.getEntity('scene.card', 'scene:1'),
            outbox: await sync.getOutbox('op:a:1'),
        })
        expect(stored).not.toContain(canary)
        expect(stored).not.toMatch(/authorization|base64|image/i)
    })

    it('rejects forbidden envelope metadata before an inbox write', async () => {
        const sync = repository('unsafe-envelope-metadata')
        const remoteEnvelope = {
            opId: 'op:remote:1',
            entityType: 'scene.card' as const,
            entityId: 'scene:remote',
            op: 'upsert' as const,
            baseRevision: 0,
            deviceId: 'Bearer metadata-canary',
            userId: 'user:1',
            createdAt: NOW,
            encrypted: false,
            payload: {
                id: 'scene:remote', name: 'Remote', scenePrompt: 'safe prompt', createdAt: 1, orderKey: '0001',
            },
        }

        await expect(sync.applyLocalMutation(remoteEnvelope)).rejects.toMatchObject({ code: 'E_SYNC_RECORD_INVALID' })
        await expect(sync.receiveRemote({ ...remoteEnvelope, schemaVersion: 1, revision: 1 }))
            .rejects.toMatchObject({ code: 'E_SYNC_RECORD_INVALID' })
        expect(await sync.getInbox('op:remote:1')).toBeNull()
        expect(await sync.listOutbox({ includeAcked: true })).toEqual([])
    })

    it('reselects an expired in-flight attempt after reopen without exposing a live lease', async () => {
        const factory = new IDBFactory()
        const options = {
            factory: factory as unknown as globalThis.IDBFactory,
            keyRange: IDBKeyRange as unknown as typeof globalThis.IDBKeyRange,
            databaseName: 'nai-blue-sync-expired-attempt',
            userId: 'user:1',
        }
        const before = new IndexedDBSyncOutboxRepository(options)
        await before.applyLocalMutation(localSceneInput())
        const attempt = await before.markAttempt({ opId: 'op:a:1', attemptedAt: NOW, inFlightUntil: LATER })
        await expect(before.markAttempt({ opId: 'op:a:1', attemptedAt: NOW, inFlightUntil: LATER }))
            .rejects.toMatchObject({ code: 'E_SYNC_RETRY_INVALID' })
        await before.close()

        const after = new IndexedDBSyncOutboxRepository(options)
        expect(await after.listReadyOutbox({ now: NOW })).toEqual([])
        expect(await after.listReadyOutbox({ now: LATER })).toEqual([
            expect.objectContaining({ state: 'in-flight', inFlightUntil: LATER }),
        ])
        await after.scheduleRetry({
            opId: 'op:a:1', nextAttemptAt: '2026-07-15T00:00:02.000Z', failureCode: 'E_SYNC_ATTEMPT_EXPIRED',
            expectedAttemptCount: attempt.attemptCount, expectedInFlightUntil: LATER,
        })
        expect(await after.getOutbox('op:a:1')).toMatchObject({ state: 'retry', inFlightUntil: null })
    })

    it('CAS-fences retry state against a late failure from an older attempt lease', async () => {
        const sync = repository('retry-attempt-cas')
        await sync.applyLocalMutation(localSceneInput())
        const first = await sync.markAttempt({ opId: 'op:a:1', attemptedAt: NOW, inFlightUntil: LATER })
        const second = await sync.markAttempt({ opId: 'op:a:1', attemptedAt: LATER })
        if (first.inFlightUntil === null || second.inFlightUntil === null) throw new Error('Expected in-flight leases')

        await expect(sync.scheduleRetry({
            opId: 'op:a:1', nextAttemptAt: '2026-07-15T00:00:02.000Z', failureCode: 'E_SYNC_STALE_ATTEMPT',
            expectedAttemptCount: first.attemptCount, expectedInFlightUntil: first.inFlightUntil,
        })).rejects.toMatchObject({ code: 'E_SYNC_RETRY_INVALID' })
        expect(await sync.getOutbox('op:a:1')).toMatchObject({
            state: 'in-flight', attemptCount: second.attemptCount, inFlightUntil: second.inFlightUntil,
        })

        await sync.scheduleRetry({
            opId: 'op:a:1', nextAttemptAt: '2026-07-15T00:00:02.000Z', failureCode: 'E_SYNC_CURRENT_ATTEMPT',
            expectedAttemptCount: second.attemptCount, expectedInFlightUntil: second.inFlightUntil,
        })
        expect(await sync.getOutbox('op:a:1')).toMatchObject({
            state: 'retry', attemptCount: second.attemptCount, inFlightUntil: null,
        })
    })

    it('re-drains a duplicated deferred child when its parent is later committed locally', async () => {
        const sync = repository('deferred-local-parent')
        const child = createSyncEnvelope({
            opId: 'op:remote:child', entityType: 'scene.card', entityId: 'scene:1', op: 'upsert',
            baseRevision: 1, baseOpId: 'op:local:parent', deviceId: 'device:remote', userId: 'user:1',
            createdAt: LATER, encrypted: false,
            payload: { ...localSceneInput().payload, scenePrompt: 'child edit' },
        })
        expect(await sync.receiveRemote(child)).toMatchObject({ status: 'deferred', duplicateDelivery: false })
        expect(await sync.receiveRemote(child)).toMatchObject({ status: 'deferred', duplicateDelivery: true })

        await sync.applyLocalMutation(localSceneInput({ opId: 'op:local:parent' }))
        expect(await sync.getEntity('scene.card', 'scene:1')).toMatchObject({
            sourceOpId: 'op:remote:child', revision: 2, payload: { scenePrompt: 'child edit' },
        })
        expect(await sync.getInbox(child.opId)).toMatchObject({ status: 'applied' })
    })

    it('keeps same identifiers isolated by user and rejects records outside the bound user', async () => {
        const factory = new IDBFactory()
        const shared = {
            factory: factory as unknown as globalThis.IDBFactory,
            keyRange: IDBKeyRange as unknown as typeof globalThis.IDBKeyRange,
            databaseName: 'nai-blue-sync-shared-account-base',
        }
        const userOne = new IndexedDBSyncOutboxRepository({ ...shared, userId: 'user:1' })
        const userTwo = new IndexedDBSyncOutboxRepository({ ...shared, userId: 'user:2' })
        await userOne.applyLocalMutation(localSceneInput({ payload: { ...localSceneInput().payload, scenePrompt: 'one' } }))
        await userTwo.applyLocalMutation(localSceneInput({
            userId: 'user:2', payload: { ...localSceneInput().payload, scenePrompt: 'two' },
        }))

        expect(await userOne.getEntity('scene.card', 'scene:1')).toMatchObject({ payload: { scenePrompt: 'one' } })
        expect(await userTwo.getEntity('scene.card', 'scene:1')).toMatchObject({ payload: { scenePrompt: 'two' } })
        expect(syncDatabaseNameForUser(shared.databaseName, 'user:1'))
            .not.toBe(syncDatabaseNameForUser(shared.databaseName, 'user:2'))

        await expect(userOne.applyLocalMutation(localSceneInput({
            opId: 'op:foreign:local', userId: 'user:2',
        }))).rejects.toMatchObject({ code: 'E_SYNC_USER_SCOPE' })
        const foreignRemote = createSyncEnvelope({
            opId: 'op:foreign:remote', entityType: 'scene.card', entityId: 'scene:foreign', op: 'upsert',
            baseRevision: 0, baseOpId: null, deviceId: 'device:foreign', userId: 'user:2', createdAt: NOW,
            encrypted: false,
            payload: { ...localSceneInput().payload, id: 'scene:foreign' },
        })
        await expect(userOne.receiveRemote(foreignRemote)).rejects.toMatchObject({ code: 'E_SYNC_USER_SCOPE' })
        expect(await userOne.getInbox('op:foreign:remote')).toBeNull()
        expect(await userOne.getOutbox('op:foreign:local')).toBeNull()
    })

    it('treats a tombstone-only record as independent authority and rejects resurrection', async () => {
        const factory = new IDBFactory()
        const databaseName = 'nai-blue-sync-tombstone-only'
        const options = {
            factory: factory as unknown as globalThis.IDBFactory,
            keyRange: IDBKeyRange as unknown as typeof globalThis.IDBKeyRange,
            databaseName,
            userId: 'user:1',
        }
        const before = new IndexedDBSyncOutboxRepository(options)
        await before.applyLocalMutation(localSceneInput())
        await before.applyLocalMutation(localSceneInput({
            opId: 'op:a:delete', op: 'delete', createdAt: LATER, payload: undefined,
        }))
        await before.close()
        await clearProjectionExceptTombstone(factory, syncDatabaseNameForUser(databaseName, 'user:1'))

        const after = new IndexedDBSyncOutboxRepository(options)
        await expect(after.applyLocalMutation(localSceneInput({ opId: 'op:a:resurrect' })))
            .rejects.toMatchObject({ code: 'E_SYNC_TOMBSTONED' })
        const staleRoot = createSyncEnvelope({
            opId: 'op:remote:stale-root', entityType: 'scene.card', entityId: 'scene:1', op: 'upsert',
            baseRevision: 0, baseOpId: null, deviceId: 'device:remote', userId: 'user:1', createdAt: NOW,
            encrypted: false, payload: { ...localSceneInput().payload, scenePrompt: 'stale root' },
        })
        await after.receiveRemote(staleRoot)
        expect(await after.getEntity('scene.card', 'scene:1')).toMatchObject({ op: 'delete', sourceOpId: 'op:a:delete' })
        expect(await after.getTombstone('scene.card', 'scene:1')).toMatchObject({ sourceOpId: 'op:a:delete' })
        expect(await after.listConflictCopies('scene.card', 'scene:1')).toEqual([
            expect.objectContaining({ sourceOpId: 'op:remote:stale-root' }),
        ])
    })

    it('rejects entity-key and payload-identity mismatches atomically', async () => {
        const sync = repository('identity-mismatch')
        const mismatch = localSceneInput({
            payload: { ...localSceneInput().payload, id: 'scene:other' },
        })
        await expect(sync.applyLocalMutation(mismatch)).rejects.toMatchObject({ code: 'E_SYNC_PAYLOAD_INVALID' })
        expect(await sync.getEntity('scene.card', 'scene:1')).toBeNull()
        expect(await sync.listOutbox({ includeAcked: true })).toEqual([])
    })

    it('round-trips inert encoded-looking prompt text without decoding or rewriting it', async () => {
        for (const [index, scenePrompt] of ['AAECAwQFBgcICQoL', 'oKGio6Slpqeoqaqr',
            'AAAA AAAA AAAA AAAA', 'a AAAA AAAA AAAA AAAA b',
            'AAECA wQFBg cICQo LDA0O Dw==', 'binary:AAECA wQFBg cICQo LDA0O Dw==;end',
            'binary AAECA wQFBg cICQo LDA0O a', 'binary c2Vj cmV0 LWNh bmFy eQ== end',
            'a c 2 VjcmV 0 LWNhbmFyeQ b', 'a c 2V jcm V0 LWN hbm Fye QB'].entries()) {
            const sync = repository(`inert-text-${index}`)
            const result = await sync.applyLocalMutation(localSceneInput({
                payload: { ...localSceneInput().payload, scenePrompt },
            }))
            expect(result.payload.scenePrompt).toBe(scenePrompt)
        }
    })

    it('rejects encoded image identifiers and explicit binary material before any outbox write', async () => {
        const sync = repository('forbidden-material-atomic')
        await expect(sync.applyLocalMutation(localSceneInput({
            opId: 'AAAAGGZ0eXBhdmlmAAAAAGF2aWZtaWYx',
        }))).rejects.toBeDefined()
        await expect(sync.applyLocalMutation(localSceneInput({
            opId: 'AAAAABhmdHlwYXZpZgAAAABhdmlmbWlmMQ==',
        }))).rejects.toBeDefined()
        await expect(sync.applyLocalMutation(localSceneInput({
            opId: `${'00'.repeat(130)}89504e470d0a1a0a`,
        }))).rejects.toBeDefined()
        await expect(sync.applyLocalMutation(localSceneInput({
            opId: 'f89504e470d0a1a0a',
        }))).rejects.toBeDefined()
        await expect(sync.applyLocalMutation(localSceneInput({
            opId: 'op:binary-text',
            payload: { ...localSceneInput().payload, scenePrompt: String.fromCharCode(0, 1, 2) },
        }))).rejects.toBeDefined()
        await expect(sync.applyLocalMutation(localSceneInput({
            opId: 'op:high-byte-binary-text',
            payload: { ...localSceneInput().payload, scenePrompt: 'data:application/octet-stream;base64,AAAA' },
        }))).rejects.toBeDefined()
        await expect(sync.applyLocalMutation(localSceneInput({
            opId: 'op:svg-text',
            payload: { ...localSceneInput().payload, scenePrompt: '<svg/>' },
        }))).rejects.toBeDefined()
        await expect(sync.applyLocalMutation(localSceneInput({
            opId: 'op:raw-image-text',
            payload: {
                ...localSceneInput().payload,
                scenePrompt: String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
            },
        }))).rejects.toBeDefined()
        for (const [opId, scenePrompt] of [
            ['op:mime-image-text', 'iVBO Rw0K GgoA AAAA'],
            ['op:mime-uneven-image-text', 'iVBOR w0KGg oAAAA A'],
            ['op:mime-embedded-image-text', 'image:iVBOR w0KGg oAAAA A;end'],
            ['op:mime-nbsp-image-text', 'image:iVBO\u00a0Rw0K\u00a0Ggo='],
            ['op:mime-greedy-prefix-image-text', `image ${wrappedImageCanary()}`],
            ['op:mime-irregular-image-text', 'a iVBORw 0 KGgoAAAAA b'],
            ['op:mime-minimal-image-text', 'a iVBO Rw0K Ggo= b'],
            ['op:mime-padded-trailing-image-text', `image ${wrappedImageCanary(true)} end`],
            ['op:wrapped-hex-image-text', 'note=8950 4e47 0d0a 1a0a=end'],
        ]) {
            await expect(sync.applyLocalMutation(localSceneInput({
                opId, payload: { ...localSceneInput().payload, scenePrompt },
            }))).rejects.toBeDefined()
        }
        await expect(sync.applyLocalMutation(localSceneInput({
            opId: 'op:url-path-text',
            payload: {
                ...localSceneInput().payload,
                scenePrompt: 'https://example.invalid/view?p=%2Fhome%2Fcanary%2Ffile.png',
            },
        }))).rejects.toBeDefined()
        const unsafeDocument = structuredClone(typeFixtureDocument) as CompositionDocument
        unsafeDocument.createdBy = {
            ...unsafeDocument.createdBy,
            id: `${'A'.repeat(1_024)}iVBORw0KGgoAAAAA`,
        }
        await expect(sync.applyLocalMutation({
            opId: 'op:nested-image-id', entityType: 'composition.document', entityId: unsafeDocument.id,
            op: 'upsert', deviceId: 'device:a', userId: 'user:1', createdAt: NOW, payload: unsafeDocument,
        })).rejects.toBeDefined()
        expect(await sync.listOutbox({ includeAcked: true })).toEqual([])
    })
})
