import { describe, expect, it } from 'vitest'

import {
    CompositionRepository,
    CompositionRepositoryError,
    compositionDocumentCounts,
    compositionDocumentHash,
    type CompositionMigrationMarker,
    type CompositionRepositoryStorage,
} from '@/domain/composition/repository'
import type { CompositionDocument } from '@/domain/composition/types'
import { typeFixtureDocument } from '@/domain/composition/types.typecheck'

const NOW = '2026-07-12T00:00:00.000Z'

class MemoryStorage implements CompositionRepositoryStorage {
    readonly values = new Map<string, string>()

    getItem(key: string): string | null {
        return this.values.get(key) ?? null
    }

    setItem(key: string, value: string): void {
        this.values.set(key, value)
    }

    compareAndSet(key: string, expected: string | null, next: string): boolean {
        if ((this.values.get(key) ?? null) !== expected) return false
        this.values.set(key, next)
        return true
    }
}

function document(): CompositionDocument {
    return structuredClone(typeFixtureDocument) as CompositionDocument
}

function marker(value: CompositionDocument): CompositionMigrationMarker {
    return {
        migrationId: 'migration:fixture',
        registryVersion: 1,
        sourceHash: 'sha256:source',
        sourceCounts: { stores: 2 },
        targetHash: compositionDocumentHash(value),
        targetCounts: compositionDocumentCounts(value),
        reportHash: 'sha256:report',
        committedAt: NOW,
    }
}

describe('CompositionRepository migration authority', () => {
    it('stages and atomically commits v2 while retaining a real legacy rollback', async () => {
        const storage = new MemoryStorage()
        const repository = new CompositionRepository(storage)
        const value = document()
        const lock = await repository.acquireMigrationLock({
            id: 'lock:fixture',
            owner: 'test',
            now: NOW,
        })

        await repository.writeStagedDocument(lock.id, 'migration:fixture', value, NOW)
        const staged = await repository.read(NOW)
        expect(staged.authority).toBe('legacy')
        expect(staged.committedDocument).toBeUndefined()
        expect(staged.staged?.documentHash).toBe(compositionDocumentHash(value))

        const committed = await repository.commitStagedDocument({
            lockId: lock.id,
            marker: marker(value),
            now: NOW,
        })
        expect(committed).toMatchObject({
            authority: 'legacy',
            committedHash: compositionDocumentHash(value),
            migrationMarker: { migrationId: 'migration:fixture' },
        })
        expect(committed.staged).toBeUndefined()
        expect(committed.migrationLock?.id).toBe(lock.id)
        expect(await repository.readAuthoritativeDocument(NOW)).toBeNull()

        const finalized = await repository.finalizeCommittedMigration({
            lockId: lock.id,
            migrationId: 'migration:fixture',
            targetHash: compositionDocumentHash(value),
            now: NOW,
        })
        expect(finalized.migrationLock).toBeUndefined()
        expect(finalized.migrationMarker?.startupVerifiedAt).toBe(NOW)
        expect(await repository.readAuthoritativeDocument(NOW)).toEqual(value)

        expect(await repository.readAuthoritativeDocument(NOW)).toEqual(value)
    })

    it('cleans an expired interrupted temp write without changing committed authority', async () => {
        const storage = new MemoryStorage()
        const repository = new CompositionRepository(storage)
        const lock = await repository.acquireMigrationLock({
            id: 'lock:interrupted',
            owner: 'test',
            now: NOW,
            ttlMs: 1,
        })
        await repository.writeStagedDocument(lock.id, 'migration:interrupted', document(), NOW)

        const cleaned = await repository.cleanupInterruptedMigration('2026-07-12T00:00:01.000Z')
        expect(cleaned.authority).toBe('legacy')
        expect(cleaned.staged).toBeUndefined()
        expect(cleaned.migrationLock).toBeUndefined()
    })

    it('rejects a newer repository schema without overwriting it', async () => {
        const storage = new MemoryStorage()
        const raw = JSON.stringify({
            format: 'nai-blue-composition-repository',
            repositorySchemaVersion: 99,
        })
        storage.values.set('nai-blue-composition-repository', raw)
        const repository = new CompositionRepository(storage)

        await expect(repository.read(NOW)).rejects.toMatchObject({
            code: 'E_REPOSITORY_SCHEMA_NEWER',
        } satisfies Partial<CompositionRepositoryError>)
        expect(storage.values.get('nai-blue-composition-repository')).toBe(raw)
    })

    it.each([
        {
            label: 'target hash',
            corrupt: (record: Record<string, any>) => {
                record.migrationMarker.targetHash = 'sha256:not-the-committed-document'
            },
        },
        {
            label: 'target counts',
            corrupt: (record: Record<string, any>) => {
                record.migrationMarker.targetCounts = { profiles: 999 }
            },
        },
        {
            label: 'missing committed document',
            corrupt: (record: Record<string, any>) => {
                record.authority = 'legacy'
                delete record.committedDocument
                delete record.committedHash
            },
        },
    ])('rejects a migration marker with inconsistent $label', async ({ corrupt }) => {
        const storage = new MemoryStorage()
        const repository = new CompositionRepository(storage)
        const value = document()
        const lock = await repository.acquireMigrationLock({ id: 'lock:marker', owner: 'test', now: NOW })
        await repository.writeStagedDocument(lock.id, 'migration:fixture', value, NOW)
        await repository.commitStagedDocument({ lockId: lock.id, marker: marker(value), now: NOW })

        const raw = JSON.parse(storage.values.get('nai-blue-composition-repository')!) as Record<string, any>
        corrupt(raw)
        storage.values.set('nai-blue-composition-repository', JSON.stringify(raw))

        await expect(repository.read(NOW)).rejects.toMatchObject({
            code: 'E_REPOSITORY_RECORD_INVALID',
        } satisfies Partial<CompositionRepositoryError>)
    })

    it('fails closed when storage write/readback does not match', async () => {
        const storage: CompositionRepositoryStorage = {
            getItem: () => null,
            setItem: () => undefined,
        }
        const repository = new CompositionRepository(storage)

        await expect(repository.acquireMigrationLock({
            id: 'lock:failed',
            owner: 'test',
            now: NOW,
        })).rejects.toMatchObject({ code: 'E_REPOSITORY_WRITE_VERIFY' })
    })

    it('grants exactly one migration lease under concurrent compare-and-set acquisition', async () => {
        const storage = new MemoryStorage()
        const first = new CompositionRepository(storage)
        const second = new CompositionRepository(storage)
        const attempts = await Promise.allSettled([
            first.acquireMigrationLock({ id: 'lock:first', owner: 'first', now: NOW }),
            second.acquireMigrationLock({ id: 'lock:second', owner: 'second', now: NOW }),
        ])

        expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1)
        expect((await first.read(NOW)).migrationLock?.id).toMatch(/^lock:(first|second)$/)
    })
})
