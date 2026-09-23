import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/indexed-db', async importOriginal => ({
    ...await importOriginal<typeof import('@/lib/indexed-db')>(),
    indexedDBStorage: {
        getItem: async () => null,
        setItem: async () => undefined,
        removeItem: async () => undefined,
    },
}))

import {
    COMPOSITION_MIGRATION_BACKUP_STORAGE_KEY,
    CompositionRepository,
    type CompositionRepositoryStorage,
} from '@/domain/composition/repository'
import {
    RAW_MIGRATION_BACKUP_FORMAT,
    RAW_MIGRATION_BACKUP_SCHEMA_VERSION,
    compositionMigrationSourceCounts,
    compositionMigrationSourceHash,
    legacyMigrationInputFromSource,
    runCompositionMigrationTransaction,
    type CompositionMigrationSourceSnapshot,
    type RawCompositionMigrationBackupSnapshot,
} from '@/lib/composition-migration-runtime'
import { migrateLegacyStoresToV2 } from '@/domain/composition/migrations/legacy-stores-to-v2'
import {
    createCurrentBackupEnvelopeV3,
    restoreBackupToStorage,
} from '@/lib/auto-backup'
import { runStartupCompositionMigration } from '@/lib/composition-migration-startup'

const NOW = '2026-07-12T00:00:00.000Z'

class MemoryStorage implements CompositionRepositoryStorage {
    readonly values = new Map<string, string>()

    getItem(key: string): string | null {
        return this.values.get(key) ?? null
    }

    setItem(key: string, value: string): void {
        this.values.set(key, value)
    }

    removeItem(key: string): void {
        this.values.delete(key)
    }
}

function source(overrides: Partial<CompositionMigrationSourceSnapshot> = {}): CompositionMigrationSourceSnapshot {
    return {
        serializedStores: {
            'nai-blue-scenes': JSON.stringify({ state: { presets: [] }, version: 0 }),
        },
        wildcardContent: {},
        ...overrides,
    }
}

function rawSnapshotFor(
    snapshot: CompositionMigrationSourceSnapshot,
    registryVersion = 1,
): RawCompositionMigrationBackupSnapshot {
    const sourceHash = compositionMigrationSourceHash(snapshot)
    return {
        migrationId: `composition-migration:v${registryVersion}:${sourceHash.replace(/^sha256:/, '').slice(0, 24)}`,
        createdAt: NOW,
        sourceHash,
        sourceCounts: compositionMigrationSourceCounts(snapshot),
        serializedStores: JSON.parse(JSON.stringify(snapshot.serializedStores)) as Record<string, string>,
        wildcardContent: JSON.parse(JSON.stringify(snapshot.wildcardContent)) as Record<string, string[]>,
        ...(snapshot.assetProfileJson === undefined
            ? {}
            : { assetProfileJson: JSON.parse(JSON.stringify(snapshot.assetProfileJson)) }),
    }
}

describe('repeatable Composition migration transaction', () => {
    it('falls back to retained fragment-content aliases when the separate DB is empty', () => {
        const snapshot = source({
            serializedStores: {
                'wildcard-content': JSON.stringify({ 'legacy-content-key': ['kept line'] }),
            },
            wildcardContent: {},
        })
        const migrated = migrateLegacyStoresToV2(legacyMigrationInputFromSource(snapshot))
        const recovered = migrated.sidecars.fragments.meta[0]

        expect(recovered).toBeDefined()
        expect(migrated.sidecars.fragments.contents[recovered!.id]).toEqual(['kept line'])
    })

    it('fails before atomic commit when a migrated typed reference is dangling', async () => {
        const storage = new MemoryStorage()
        const repository = new CompositionRepository(storage)
        const result = await runCompositionMigrationTransaction({
            repository,
            storage,
            source: source(),
            now: NOW,
            owner: 'typed-reference-validation',
            registryVersion: 1,
            migrate: input => {
                const migrated = migrateLegacyStoresToV2(input)
                migrated.document.profiles[0].randomRuleIds = ['random-rule:missing']
                return migrated
            },
        })

        expect(result.status).toBe('failed')
        expect(result.error).toContain('E_RANDOM_RULE_REF_MISSING')
        expect(result.completedSteps).toContain('temp-cleanup')
        expect(result.completedSteps).not.toContain('atomic-commit')
        expect((await repository.read(NOW)).committedDocument).toBeUndefined()
    })

    it('runs the ordered transaction, verifies startup readback, and is idempotent', async () => {
        const storage = new MemoryStorage()
        storage.values.set('nai-blue-scenes', source().serializedStores['nai-blue-scenes']!)
        const repository = new CompositionRepository(storage)
        const run = () => runCompositionMigrationTransaction({
            repository,
            storage,
            source: async () => {
                expect((await repository.read(NOW)).migrationLock).toBeDefined()
                return source()
            },
            now: NOW,
            owner: 'test',
            registryVersion: 1,
        })

        const first = await run()
        expect(first.status).toBe('committed')
        expect(first.completedSteps).toEqual([
            'migration-lock',
            'raw-backup',
            'source-manifest',
            'dry-run',
            'fatal-check',
            'temp-write',
            'schema-reference-validation',
            'atomic-commit',
            'migration-marker',
            'startup-reread',
        ])
        expect(first.marker?.startupVerifiedAt).toBe(NOW)
        expect((await repository.read(NOW)).authority).toBe('v2')
        expect(storage.getItem('nai-blue-scenes')).toBe(source().serializedStores['nai-blue-scenes'])

        const rawBackup = JSON.parse(storage.getItem(COMPOSITION_MIGRATION_BACKUP_STORAGE_KEY) ?? 'null') as {
            snapshots: Array<{ serializedStores: Record<string, string> }>
        }
        expect(rawBackup.snapshots).toHaveLength(1)
        expect(rawBackup.snapshots[0]?.serializedStores['nai-blue-scenes'])
            .toBe(source().serializedStores['nai-blue-scenes'])

        const second = await run()
        expect(second.status).toBe('already-current')
        expect(second.marker?.targetHash).toBe(first.marker?.targetHash)
        const repeatedBackup = JSON.parse(
            storage.getItem(COMPOSITION_MIGRATION_BACKUP_STORAGE_KEY) ?? 'null',
        ) as { snapshots: unknown[] }
        expect(repeatedBackup.snapshots).toHaveLength(1)
        expect(repeatedBackup.snapshots[0]).toMatchObject({
            projection: {
                documentHash: first.marker?.targetHash,
                report: { migrationId: 'legacy-stores-to-composition-v2' },
                sidecars: { fragments: { schemaVersion: 2 } },
            },
        })
    })

    it.each([
        {
            name: 'missing store payload',
            corrupt: (snapshot: RawCompositionMigrationBackupSnapshot) => ({
                ...snapshot,
                serializedStores: {},
            }),
        },
        {
            name: 'changed store payload',
            corrupt: (snapshot: RawCompositionMigrationBackupSnapshot) => ({
                ...snapshot,
                serializedStores: {
                    ...snapshot.serializedStores,
                    'nai-blue-scenes': JSON.stringify({ state: { presets: [{ id: 'forged' }] }, version: 0 }),
                },
            }),
        },
        {
            name: 'missing wildcard payload',
            corrupt: (snapshot: RawCompositionMigrationBackupSnapshot) => ({
                ...snapshot,
                wildcardContent: {},
            }),
        },
        {
            name: 'changed wildcard payload',
            corrupt: (snapshot: RawCompositionMigrationBackupSnapshot) => ({
                ...snapshot,
                wildcardContent: { subject: ['forged'] },
            }),
        },
        {
            name: 'missing Asset Profile payload',
            corrupt: (snapshot: RawCompositionMigrationBackupSnapshot) => {
                const { assetProfileJson: _assetProfileJson, ...withoutAssetProfile } = snapshot
                return withoutAssetProfile
            },
        },
        {
            name: 'changed Asset Profile payload',
            corrupt: (snapshot: RawCompositionMigrationBackupSnapshot) => ({
                ...snapshot,
                assetProfileJson: { revision: 999, forged: true },
            }),
        },
        {
            name: 'changed source counts',
            corrupt: (snapshot: RawCompositionMigrationBackupSnapshot) => ({
                ...snapshot,
                sourceCounts: { ...snapshot.sourceCounts, stores: 999 },
            }),
        },
    ])('does not trust a matching migration ID/hash with $name', async ({ corrupt }) => {
        const storage = new MemoryStorage()
        const repository = new CompositionRepository(storage)
        const exactSource = source({
            wildcardContent: { subject: ['one', 'two'] },
            assetProfileJson: {
                revision: 4,
                updatedAt: NOW,
                updatedBy: 'legacy',
                settings: {},
                output: {},
                r2: { enabled: false },
                modules: {},
                recipes: [],
            },
        })
        const exactSnapshot = rawSnapshotFor(exactSource)
        const forgedSnapshot = corrupt(exactSnapshot)
        storage.setItem(COMPOSITION_MIGRATION_BACKUP_STORAGE_KEY, JSON.stringify({
            format: RAW_MIGRATION_BACKUP_FORMAT,
            schemaVersion: RAW_MIGRATION_BACKUP_SCHEMA_VERSION,
            snapshots: [forgedSnapshot],
        }))
        let exactPreimageObservedBeforeDryRun = false

        const result = await runCompositionMigrationTransaction({
            repository,
            storage,
            source: exactSource,
            now: NOW,
            owner: 'raw-preimage-verification',
            registryVersion: 1,
            migrate: input => {
                const archive = JSON.parse(
                    storage.getItem(COMPOSITION_MIGRATION_BACKUP_STORAGE_KEY) ?? 'null',
                ) as { snapshots: RawCompositionMigrationBackupSnapshot[] }
                exactPreimageObservedBeforeDryRun = archive.snapshots.some(snapshot => {
                    const snapshotSource: CompositionMigrationSourceSnapshot = {
                        serializedStores: snapshot.serializedStores,
                        wildcardContent: snapshot.wildcardContent,
                        ...(Object.prototype.hasOwnProperty.call(snapshot, 'assetProfileJson')
                            ? { assetProfileJson: snapshot.assetProfileJson }
                            : {}),
                    }
                    return snapshot.migrationId === exactSnapshot.migrationId
                        && snapshot.sourceHash === compositionMigrationSourceHash(snapshotSource)
                        && JSON.stringify(snapshotSource) === JSON.stringify(exactSource)
                        && JSON.stringify(snapshot.sourceCounts)
                            === JSON.stringify(compositionMigrationSourceCounts(snapshotSource))
                })
                if (!exactPreimageObservedBeforeDryRun) {
                    throw new Error('Migration dry-run reached without an exact raw preimage')
                }
                return migrateLegacyStoresToV2(input)
            },
        })

        expect(result.status).toBe('committed')
        expect(exactPreimageObservedBeforeDryRun).toBe(true)
        const persisted = JSON.parse(
            storage.getItem(COMPOSITION_MIGRATION_BACKUP_STORAGE_KEY) ?? 'null',
        ) as { snapshots: RawCompositionMigrationBackupSnapshot[] }
        expect(persisted.snapshots).toHaveLength(2)
        expect(persisted.snapshots[0]).toEqual(forgedSnapshot)
        expect(persisted.snapshots[0]?.projection).toBeUndefined()
        expect(persisted.snapshots[1]).toMatchObject({
            ...exactSnapshot,
            projection: { documentHash: expect.stringMatching(/^sha256:/) },
        })
    })

    it('fails closed before dry-run when a raw archive snapshot is structurally partial', async () => {
        const storage = new MemoryStorage()
        const repository = new CompositionRepository(storage)
        const exactSource = source()
        const { sourceCounts: _sourceCounts, ...partialSnapshot } = rawSnapshotFor(exactSource)
        const seededArchive = JSON.stringify({
            format: RAW_MIGRATION_BACKUP_FORMAT,
            schemaVersion: RAW_MIGRATION_BACKUP_SCHEMA_VERSION,
            snapshots: [partialSnapshot],
        })
        storage.setItem(COMPOSITION_MIGRATION_BACKUP_STORAGE_KEY, seededArchive)
        const migrate = vi.fn(migrateLegacyStoresToV2)

        const result = await runCompositionMigrationTransaction({
            repository,
            storage,
            source: exactSource,
            now: NOW,
            owner: 'raw-preimage-structural-failure',
            registryVersion: 1,
            migrate,
        })

        expect(result.status).toBe('failed')
        expect(result.completedSteps).not.toContain('raw-backup')
        expect(result.completedSteps).not.toContain('dry-run')
        expect(result.error).toContain('sourceCounts must be an object')
        expect(migrate).not.toHaveBeenCalled()
        expect(storage.getItem(COMPOSITION_MIGRATION_BACKUP_STORAGE_KEY)).toBe(seededArchive)
        const repositoryState = await repository.read(NOW)
        expect(repositoryState.authority).toBe('legacy')
        expect(repositoryState.staged).toBeUndefined()
        expect(repositoryState.migrationLock).toBeUndefined()
    })

    it('runs compatibility projection after commit while retaining the migration lease', async () => {
        const storage = new MemoryStorage()
        const repository = new CompositionRepository(storage)
        let callbackObserved = false

        const result = await runCompositionMigrationTransaction({
            repository,
            storage,
            source: source(),
            now: NOW,
            owner: 'post-commit-callback',
            registryVersion: 1,
            postCommitBeforeFinalize: async input => {
                const duringCallback = await repository.read(NOW)
                expect(duringCallback.migrationLock).toBeDefined()
                expect(duringCallback.authority).toBe('legacy')
                expect(duringCallback.committedHash).toBe(input.documentHash)
                expect(duringCallback.migrationMarker?.migrationId).toBe(input.migrationId)
                expect(duringCallback.migrationMarker?.startupVerifiedAt).toBeUndefined()
                callbackObserved = true
            },
        })

        expect(result.status).toBe('committed')
        expect(callbackObserved).toBe(true)
        expect(result.completedSteps.indexOf('post-commit-pre-finalize'))
            .toBeGreaterThan(result.completedSteps.indexOf('migration-marker'))
        expect(result.completedSteps.indexOf('startup-reread'))
            .toBeGreaterThan(result.completedSteps.indexOf('post-commit-pre-finalize'))
        const finalized = await repository.read(NOW)
        expect(finalized.authority).toBe('v2')
        expect(finalized.migrationLock).toBeUndefined()
    })

    it('finalizes safely after a process crash between atomic commit and authority activation', async () => {
        const resumedAt = '2026-07-12T00:06:00.000Z'
        const fixtureStorage = new MemoryStorage()
        const fixtureRepository = new CompositionRepository(fixtureStorage)
        const fixture = await runCompositionMigrationTransaction({
            repository: fixtureRepository,
            storage: fixtureStorage,
            source: source(),
            now: NOW,
            owner: 'fixture',
            registryVersion: 1,
        })
        const fixtureState = await fixtureRepository.read(NOW)
        expect(fixture.marker).toBeDefined()
        expect(fixtureState.committedDocument).toBeDefined()

        const storage = new MemoryStorage()
        const repository = new CompositionRepository(storage)
        const lockId = 'lock:crash-after-commit'
        const crashMarker = { ...fixture.marker! }
        delete crashMarker.startupVerifiedAt
        await repository.acquireMigrationLock({ id: lockId, owner: 'crashed-process', now: NOW })
        await repository.writeStagedDocument(
            lockId,
            crashMarker.migrationId,
            fixtureState.committedDocument!,
            NOW,
        )
        await repository.commitStagedDocument({ lockId, marker: crashMarker, now: NOW })

        const crashedState = await repository.read(NOW)
        expect(crashedState.authority).toBe('legacy')
        expect(crashedState.committedHash).toBe(fixture.marker!.targetHash)
        expect(crashedState.migrationLock?.id).toBe(lockId)
        expect(crashedState.migrationMarker?.startupVerifiedAt).toBeUndefined()

        await repository.cleanupInterruptedMigration(resumedAt)
        const resumed = await runCompositionMigrationTransaction({
            repository,
            storage,
            source: source(),
            now: resumedAt,
            owner: 'restarted-process',
            registryVersion: 1,
        })

        expect(resumed.status).toBe('already-current')
        const recovered = await repository.read(resumedAt)
        expect(recovered.authority).toBe('v2')
        expect(recovered.migrationLock).toBeUndefined()
        expect(recovered.migrationMarker?.startupVerifiedAt).toBe(resumedAt)
    })

    it('recommits an unchanged projection when the migration registry version advances', async () => {
        const storage = new MemoryStorage()
        const repository = new CompositionRepository(storage)
        const run = (registryVersion: number) => runCompositionMigrationTransaction({
            repository,
            storage,
            source: source(),
            now: NOW,
            owner: `registry-${registryVersion}`,
            registryVersion,
        })

        expect((await run(1)).status).toBe('committed')
        const upgraded = await run(2)

        expect(upgraded.status).toBe('committed')
        expect(upgraded.marker?.registryVersion).toBe(2)
        expect((await repository.read(NOW)).authority).toBe('v2')
        const archive = JSON.parse(
            storage.getItem(COMPOSITION_MIGRATION_BACKUP_STORAGE_KEY) ?? 'null',
        ) as { snapshots: Array<{ migrationId: string }> }
        expect(archive.snapshots.map(snapshot => snapshot.migrationId)).toEqual([
            expect.stringContaining('composition-migration:v1:'),
            expect.stringContaining('composition-migration:v2:'),
        ])
    })

    it('recommits instead of finalizing an idempotent marker with stale source counts', async () => {
        const storage = new MemoryStorage()
        const repository = new CompositionRepository(storage)
        const run = () => runCompositionMigrationTransaction({
            repository,
            storage,
            source: source(),
            now: NOW,
            owner: 'source-count-verification',
            registryVersion: 1,
        })

        expect((await run()).status).toBe('committed')
        const raw = JSON.parse(storage.getItem('nai-blue-composition-repository')!) as {
            migrationMarker: { sourceCounts: Record<string, number> }
        }
        raw.migrationMarker.sourceCounts = { stores: 999 }
        storage.setItem('nai-blue-composition-repository', JSON.stringify(raw))

        const repaired = await run()
        expect(repaired.status).toBe('committed')
        expect(repaired.marker?.sourceCounts).toEqual(repaired.sourceCounts)
        expect((await repository.read(NOW)).authority).toBe('v2')
    })

    it('never downgrades v2 authority owned by another live migration lease', async () => {
        const storage = new MemoryStorage()
        const repository = new CompositionRepository(storage)
        const initial = await runCompositionMigrationTransaction({
            repository,
            storage,
            source: source(),
            now: NOW,
            owner: 'initial',
            registryVersion: 1,
        })
        expect(initial.status).toBe('committed')
        await repository.acquireMigrationLock({ id: 'lock:other-live-process', owner: 'other', now: NOW })

        const contender = await runCompositionMigrationTransaction({
            repository,
            storage,
            source: source(),
            now: NOW,
            owner: 'contender',
            registryVersion: 1,
        })

        expect(contender.status).toBe('failed')
        expect(contender.authority).toBe('v2')
        const state = await repository.read(NOW)
        expect(state.authority).toBe('v2')
        expect(state.migrationLock?.id).toBe('lock:other-live-process')
    })

    it('commits transformable legacy data and retains the original source archive', async () => {
        const storage = new MemoryStorage()
        const oldScene = JSON.stringify({ state: { presets: [{ id: 'old-preset', scenes: [] }] }, version: 0 })
        storage.values.set('nai-blue-scenes', oldScene)
        const repository = new CompositionRepository(storage)

        const result = await runCompositionMigrationTransaction({
            repository,
            storage,
            source: source({ serializedStores: { 'nai-blue-scenes': oldScene } }),
            now: NOW,
            owner: 'test',
            registryVersion: 1,
        })

        expect(result.status).toBe('committed')
        expect(result.completedSteps).toContain('temp-write')
        expect(result.completedSteps).toContain('atomic-commit')
        expect(storage.getItem('nai-blue-scenes')).toBe(oldScene)
        const committed = await repository.read(NOW)
        expect(committed.authority).toBe('v2')
        expect(committed.committedDocument).toBeDefined()
        expect(committed.staged).toBeUndefined()
        expect(committed.migrationLock).toBeUndefined()
        expect(storage.getItem(COMPOSITION_MIGRATION_BACKUP_STORAGE_KEY)).not.toBeNull()
    })

    it('fails closed on a missing module reference and keeps the raw Asset Profile for repair', async () => {
        const storage = new MemoryStorage()
        const repository = new CompositionRepository(storage)
        const rawAssetProfile = {
            revision: 3,
            updatedAt: NOW,
            updatedBy: 'legacy-import',
            settings: {},
            output: {},
            r2: { enabled: false },
            modules: {},
            recipes: [{
                id: 'recipe:broken',
                enabled: true,
                steps: [{ moduleId: 'module:missing', enabled: true }],
            }],
        }

        const result = await runCompositionMigrationTransaction({
            repository,
            storage,
            source: source({ assetProfileJson: rawAssetProfile }),
            now: NOW,
            owner: 'test',
            registryVersion: 1,
        })

        expect(result.status).toBe('failed')
        expect(result.error).toContain('references are invalid')
        expect(result.validationIssues).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'E_MODULE_REF_MISSING', blocking: true }),
        ]))
        expect((await repository.read(NOW)).authority).toBe('legacy')
        const rawArchive = JSON.parse(
            storage.getItem(COMPOSITION_MIGRATION_BACKUP_STORAGE_KEY) ?? 'null',
        ) as { snapshots: Array<{ assetProfileJson?: unknown }> }
        expect(rawArchive.snapshots[0]?.assetProfileJson).toEqual(rawAssetProfile)
    })

    it('refuses authority activation when the locked legacy source drifts before commit', async () => {
        const storage = new MemoryStorage()
        const repository = new CompositionRepository(storage)
        let reads = 0
        const result = await runCompositionMigrationTransaction({
            repository,
            storage,
            source: async () => {
                reads += 1
                return source({
                    serializedStores: {
                        'nai-blue-scenes': JSON.stringify({ state: { revision: reads }, version: 0 }),
                    },
                })
            },
            now: NOW,
            owner: 'test',
            registryVersion: 1,
        })

        expect(reads).toBe(2)
        expect(result.status).toBe('failed')
        expect(result.error).toContain('source changed')
        const state = await repository.read(NOW)
        expect(state.authority).toBe('legacy')
        expect(state.staged).toBeUndefined()
        expect(state.migrationLock).toBeUndefined()
    })

    it('commits one v2 projection and retains the original source stores', async () => {
        const storage = new MemoryStorage()
        const repository = new CompositionRepository(storage)
        const result = await runCompositionMigrationTransaction({
            repository,
            storage,
            source: source(),
            now: NOW,
            owner: 'test',
            registryVersion: 1,
        })
        expect(result.status).toBe('committed')

        const v2Document = await repository.readAuthoritativeDocument(NOW)
        expect(v2Document).not.toBeNull()
        expect((await repository.read(NOW)).authority).toBe('v2')
        expect(storage.getItem('nai-blue-scenes')).toBeNull()
    })

    it('round-trips old authority through migration, v3 export, and clean restore', async () => {
        const storage = new MemoryStorage()
        const rawAssetProfile = {
            revision: 9,
            updatedAt: '2025-01-02T03:04:05.000Z',
            updatedBy: 'legacy-import',
            settings: { cfgScale: 0 },
            output: {},
            r2: { enabled: false },
            modules: {},
            recipes: [],
        }
        const oldScene = JSON.stringify({
            state: {
                presets: [{
                    id: 'preset:old',
                    name: 'Old',
                    createdAt: 1,
                    scenes: [{ id: 'scene:old', name: 'Old Scene', scenePrompt: 'portrait' }],
                }],
            },
            version: 0,
        })
        storage.values.set('nai-blue-scenes', oldScene)
        const repository = new CompositionRepository(storage)
        const migrated = await runCompositionMigrationTransaction({
            repository,
            storage,
            source: source({
                serializedStores: { 'nai-blue-scenes': oldScene },
                wildcardContent: { sky: ['blue', 'red'] },
                assetProfileJson: rawAssetProfile,
            }),
            now: NOW,
            owner: 'test',
            registryVersion: 1,
        })
        expect(migrated.status).toBe('committed')
        const committedDocument = await repository.readAuthoritativeDocument(NOW)
        expect(committedDocument).not.toBeNull()

        const rawBackup = Object.fromEntries(
            Array.from(storage.values.entries()).map(([key, value]) => [key, JSON.parse(value) as unknown]),
        )
        rawBackup['nai-blue-wildcard-content'] = { sky: ['blue', 'red'] }
        const legacyLocal = new Map<string, string>([
            ['character-positions', JSON.stringify({ positionEnabled: false, positions: {} })],
        ])
        const envelope = await createCurrentBackupEnvelopeV3({
            compositionDocument: committedDocument!,
            createdAt: NOW,
            readBackupData: async () => rawBackup,
            readRawIndexedEntries: async () => Object.fromEntries(storage.values),
            readLegacyLocalValue: key => legacyLocal.get(key) ?? null,
            readLegacyLocalKeys: () => ['old-marketplace-session', 'supabase.auth.session'],
            readRawAssetProfile: async () => ({
                exists: true,
                rawJson: JSON.stringify(rawAssetProfile),
            }),
        })
        expect(envelope.ignoredLegacyKeys).toEqual(expect.arrayContaining([
            'old-marketplace-session',
            'supabase.auth.session',
        ]))
        const clean = new MemoryStorage()
        let wildcardContent: Record<string, string[]> | undefined
        let restoredAssetProfile: string | undefined
        const restored = await restoreBackupToStorage(clean, envelope, {
            overwrite: true,
            importWildcardContent: async value => {
                wildcardContent = value
            },
            readWildcardContent: async () => wildcardContent ?? {},
            restoreAssetProfileJson: async value => {
                restoredAssetProfile = value
            },
            rollbackAssetProfileJson: async () => {
                restoredAssetProfile = undefined
            },
        })

        expect(restored.failed).toEqual([])
        expect(clean.getItem('nai-blue-scenes')).toBe(oldScene)
        expect(clean.getItem('character-positions')).toBeNull()
        expect(wildcardContent).toEqual({ sky: ['blue', 'red'] })
        expect(JSON.parse(restoredAssetProfile ?? 'null')).toEqual(rawAssetProfile)
        const cleanRepository = new CompositionRepository(clean)
        expect(await cleanRepository.readAuthoritativeDocument(NOW)).toEqual(committedDocument)

        const cleanSource: CompositionMigrationSourceSnapshot = {
            serializedStores: Object.fromEntries(
                [...clean.values.entries()].filter(([key]) => (
                    key !== 'nai-blue-composition-repository'
                    && key !== COMPOSITION_MIGRATION_BACKUP_STORAGE_KEY
                )),
            ),
            wildcardContent: wildcardContent ?? {},
            assetProfileJson: JSON.stringify(rawAssetProfile),
        }
        const restarted = await runStartupCompositionMigration({
            now: NOW,
            clock: () => NOW,
            storage: clean,
            source: cleanSource,
        })
        expect(restarted.status).not.toBe('failed')
        expect(restarted.authority).toBe('v2')
        expect(await cleanRepository.readAuthoritativeDocument(NOW)).not.toBeNull()
    })
})
