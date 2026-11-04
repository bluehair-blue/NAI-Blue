import { describe, expect, it } from 'vitest'

import { typeFixtureDocument } from '@/domain/composition/types.typecheck'
import type { CompositionDocument } from '@/domain/composition/types'
import {
    compositionDocumentHash,
    createCommittedCompositionRepositoryRecord,
} from '@/domain/composition/repository'
import {
    BACKUP_ENVELOPE_FORMAT,
    BACKUP_ENVELOPE_VERSION,
    ASSET_PROFILE_FILE_RESTORE_KEY,
    COMPOSITION_MIGRATION_BACKUP_STORE_KEY,
    COMPOSITION_REPOSITORY_STORE_KEY,
    BackupRestoreCapabilityError,
    BackupRestoreWriteError,
    UnsupportedBackupSchemaError,
    createBackupEnvelopeV3,
    dryRunBackupRestore,
    mergeAllowlistedLegacyStorageEntries,
    prepareBackupRestore,
    restoreBackupToStorage,
} from '@/lib/auto-backup'
import { prepareStoreSnapshotRestore } from '@/lib/store-snapshots'
import type { BackupStoragePort } from '@/lib/indexed-db'
import { GENERATION_PRESET_STORE_VERSION } from '@/lib/composition/preset-store-migration'
import { loadFixtureJson } from '../helpers'

class MemoryStorage implements BackupStoragePort {
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

function document(): CompositionDocument {
    return JSON.parse(JSON.stringify(typeFixtureDocument)) as CompositionDocument
}

function rawBackup(compositionDocument = document()): Record<string, unknown> {
    return {
        _exportedAt: '2026-07-12T00:00:00.000Z',
        _version: '2.3',
        'nai-blue-generation': {
            version: 8,
            state: { seed: 0, seedLocked: false, prompt: 'old prompt' },
        },
        'nai-blue-scenes': {
            version: 1,
            state: { presets: [{ id: 'scene:old', scenes: [] }] },
        },
        [COMPOSITION_REPOSITORY_STORE_KEY]: createCommittedCompositionRepositoryRecord(compositionDocument, {
            updatedAt: '2026-07-12T00:00:00.000Z',
            authority: 'v2',
        }),
        'nai-blue-wildcard-content': { sky: ['blue', 'red'] },
        'old-marketplace-cache': { shouldNeverBeWritten: true },
        'supabase.auth.session': { accessToken: 'secret' },
        'nai-blue-future-store': { future: true },
    }
}

describe('Backup Envelope v3', () => {
    it('detaches mutable backup data without copying archive strings through JSON, preserving JSON normalization', () => {
        const compositionDocument = document()
        const raw = rawBackup(compositionDocument)
        const source = raw['nai-blue-generation'] as { state: Record<string, unknown> }
        const archiveText = '한글🙂\\"\n'.repeat(16000)
        source.state.archives = [{ raw: archiveText }, { raw: archiveText }]
        source.state.unset = undefined
        source.state.nonfinite = Number.POSITIVE_INFINITY
        source.state.zero = -0
        source.state.list = [undefined, Number.NaN, 'kept']
        source.state.special = JSON.parse('{"__proto__":{"safe":true}}')
        const expected = JSON.parse(JSON.stringify(source))
        const envelope = createBackupEnvelopeV3(raw, { compositionDocument })
        const exported = (envelope.legacyStores?.['nai-blue-generation'] ?? envelope.stores['nai-blue-generation']) as typeof source
        expect(exported).toEqual(expected)
        ;(source.state.archives as { raw: string }[])[0].raw = 'changed later'
        ;(source.state.list as unknown[]).push('changed later')
        expect(exported).toEqual(expected)
        expect(Object.prototype.hasOwnProperty.call(exported.state.special, '__proto__')).toBe(true)
    })
    it.each([
        ['profile', (value: CompositionDocument) => { value.activeProfileId = 'profile:missing' }],
        ['module', (value: CompositionDocument) => { value.profiles[0].moduleIds = ['module:missing'] }],
        ['recipe', (value: CompositionDocument) => {
            value.profiles[0].recipeIds = ['recipe:missing']
            value.profiles[0].defaultRecipeId = 'recipe:missing'
        }],
        ['character', (value: CompositionDocument) => { value.profiles[0].characterIds = ['character:missing'] }],
        ['params preset', (value: CompositionDocument) => {
            value.profiles[0].paramsPresetIds = ['params-preset:missing']
            value.profiles[0].defaultParamsPresetId = 'params-preset:missing'
        }],
        ['random rule', (value: CompositionDocument) => {
            value.profiles[0].randomRuleIds = ['random-rule:missing']
        }],
        ['resource binding', (value: CompositionDocument) => {
            value.profiles[0].resourceBindings = [{
                resourceId: 'resource:missing',
                enabled: true,
                referenceType: 'vibe',
                strength: 0.5,
            }]
        }],
        ['contribution character', (value: CompositionDocument) => {
            value.modules[0].contributions[0].target = {
                kind: 'character',
                characterId: 'character:missing',
                polarity: 'positive',
            }
        }],
        ['character patch', (value: CompositionDocument) => {
            value.profiles[0].characterPatches = [{ characterId: 'character:missing' }]
        }],
        ['params resource', (value: CompositionDocument) => {
            value.paramsPresets[0].params.sourceImageResourceId = 'resource:missing'
        }],
    ] as const)('rejects dangling %s references on export and restore dry-run', (_kind, mutate) => {
        const invalidDocument = document()
        mutate(invalidDocument)

        expect(() => createBackupEnvelopeV3(rawBackup(invalidDocument), {
            compositionDocument: invalidDocument,
            createdAt: '2026-07-12T00:00:00.000Z',
        })).toThrow(/E_COMPOSITION_REFERENCES_INVALID/)

        const envelope = createBackupEnvelopeV3(rawBackup(), {
            compositionDocument: document(),
            createdAt: '2026-07-12T00:00:00.000Z',
        })
        const invalidEnvelope = JSON.parse(JSON.stringify(envelope)) as typeof envelope
        invalidEnvelope.compositionDocument = invalidDocument

        expect(dryRunBackupRestore(invalidEnvelope)).toMatchObject({
            canRestore: false,
            errors: expect.arrayContaining([
                expect.objectContaining({ code: 'E_COMPOSITION_REFERENCES_INVALID' }),
            ]),
        })
    })

    it('exports and preflights an empty install without inventing legacy stores', () => {
        const envelope = createBackupEnvelopeV3({}, {
            compositionDocument: document(),
            createdAt: '2026-07-12T00:00:00.000Z',
        })
        const prepared = prepareBackupRestore(envelope)

        expect(envelope.storeManifest).toMatchObject({ storeCount: 0, totalRecordCount: 0 })
        expect(envelope.legacyStores).toBeUndefined()
        expect(prepared.report).toMatchObject({ canRestore: true, manifestVerified: true })
        expect(prepared.restorePayload[COMPOSITION_REPOSITORY_STORE_KEY]).toMatchObject({
            committedDocument: { schemaVersion: 2 },
            authority: 'v2',
        })
    })

    it('accepts the current generation preset persistence version', () => {
        const source = rawBackup()
        source['nai-blue-presets'] = {
            version: GENERATION_PRESET_STORE_VERSION,
            state: { presets: [], activePresetId: 'default' },
        }
        const envelope = createBackupEnvelopeV3(source, {
            compositionDocument: document(),
            createdAt: '2026-07-12T00:00:00.000Z',
        })

        expect(prepareBackupRestore(envelope).report.canRestore).toBe(true)
    })

    it('exports a typed, hashed manifest with CompositionDocument and explicit file inclusion policy', () => {
        const envelope = createBackupEnvelopeV3(rawBackup(), {
            compositionDocument: document(),
            createdAt: '2026-07-12T00:00:00.000Z',
            appVersion: '2.8.1',
            sourceCommit: 'abc123',
        })

        expect(envelope).toMatchObject({
            format: BACKUP_ENVELOPE_FORMAT,
            formatVersion: BACKUP_ENVELOPE_VERSION,
            createdAt: '2026-07-12T00:00:00.000Z',
            appVersion: '2.8.1',
            sourceCommit: 'abc123',
            compositionSchemaVersion: 2,
        })
        expect(envelope.storeManifest.entries.map(entry => entry.key)).toEqual([
            'nai-blue-composition-repository',
            'nai-blue-generation',
            'nai-blue-scenes',
        ])
        expect(envelope.storeManifest.entries.every(entry => entry.hash.digest.length === 64)).toBe(true)
        expect(envelope.stores['nai-blue-generation']).toMatchObject({
            state: { seed: 0, seedLocked: false },
        })
        expect(envelope.legacyStores).toBeUndefined()
        expect(envelope.wildcardContent).toEqual({ sky: ['blue', 'red'] })
        expect(envelope.ignoredLegacyKeys).toEqual([
            'nai-blue-future-store',
            'old-marketplace-cache',
            'supabase.auth.session',
        ])
        expect(envelope.fileManifest.included.map(entry => entry.path)).toEqual(expect.arrayContaining([
            'composition/document.json',
            'stores/nai-blue-generation.json',
            'indexeddb/nai-blue-wildcard-content.json',
        ]))
        expect(envelope.fileManifest.excluded).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: 'NAI_Blue_Library/**' }),
            expect.objectContaining({ path: 'references/**' }),
            expect.objectContaining({ path: 'output/**' }),
        ]))
    })

    it('provides an allowlist-only dry run and reports obsolete or future keys informationally', () => {
        const envelope = createBackupEnvelopeV3(rawBackup(), {
            compositionDocument: document(),
            createdAt: '2026-07-12T00:00:00.000Z',
        })
        const prepared = prepareBackupRestore(envelope)

        expect(prepared.report.canRestore).toBe(true)
        expect(prepared.report.manifestVerified).toBe(true)
        expect(prepared.report.ignoredKeys).toEqual(expect.arrayContaining([
            { key: 'old-marketplace-cache', reason: 'declared-ignored' },
            { key: 'supabase.auth.session', reason: 'declared-ignored' },
            { key: 'nai-blue-future-store', reason: 'declared-ignored' },
        ]))
        expect(prepared.restorePayload).not.toHaveProperty('old-marketplace-cache')
        expect(prepared.restorePayload).not.toHaveProperty('supabase.auth.session')
        expect(prepared.restorePayload).not.toHaveProperty('nai-blue-future-store')

        const old = rawBackup()
        const legacyPrepared = prepareBackupRestore(old)
        expect(legacyPrepared.report.canRestore).toBe(true)
        expect(legacyPrepared.report.ignoredKeys).toEqual(expect.arrayContaining([
            { key: 'old-marketplace-cache', reason: 'legacy-marketplace-supabase' },
            { key: 'supabase.auth.session', reason: 'legacy-marketplace-supabase' },
            { key: 'nai-blue-future-store', reason: 'unknown-key' },
        ]))
        expect(legacyPrepared.restorePayload).not.toHaveProperty('nai-blue-future-store')
    })

    it('restores an old backup fixture while ignoring obsolete Marketplace and Supabase state', async () => {
        const fixture = await loadFixtureJson<Record<string, unknown>>(
            'legacy/old-backup-with-obsolete-remote-state.json',
        )
        const prepared = prepareBackupRestore(fixture)

        expect(prepared.report.canRestore).toBe(true)
        expect(prepared.report.ignoredKeys).toEqual(expect.arrayContaining([
            { key: 'nai-blue-marketplace-cache', reason: 'legacy-marketplace-supabase' },
            { key: 'supabase.auth.session', reason: 'legacy-marketplace-supabase' },
            { key: 'sb-obsolete-project-auth-token', reason: 'legacy-marketplace-supabase' },
        ]))

        const clean = new MemoryStorage()
        const restored = await restoreBackupToStorage(clean, fixture, { overwrite: true })

        expect(restored.failed).toEqual([])
        expect(restored.success).toEqual(expect.arrayContaining([
            'nai-blue-generation',
            'nai-blue-scenes',
        ]))
        expect(JSON.parse(clean.getItem('nai-blue-generation') ?? 'null')).toMatchObject({
            state: { prompt: 'restored local prompt', seed: 1234, seedLocked: true },
        })
        expect(JSON.parse(clean.getItem('nai-blue-scenes') ?? 'null')).toMatchObject({
            state: { activePresetId: 'preset:fixture' },
        })
        expect(clean.getItem('nai-blue-marketplace-cache')).toBeNull()
        expect(clean.getItem('supabase.auth.session')).toBeNull()
        expect(clean.getItem('sb-obsolete-project-auth-token')).toBeNull()
    })

    it('does not carry pre-release localStorage aliases into a clean install backup', async () => {
        const localAliases = new Map<string, string>([
            ['scene-store', JSON.stringify({ version: 1, state: { presets: [{ id: 'alias-scenes' }] } })],
            ['character-positions', JSON.stringify({ positionEnabled: true, positions: [{ x: 0, y: 1 }] })],
            ['novelaiPromptEditorState', JSON.stringify({ tabs: [{ id: 'legacy-tab', windows: [] }] })],
        ])
        const source = mergeAllowlistedLegacyStorageEntries(
            rawBackup(),
            key => localAliases.get(key) ?? null,
        )
        const envelope = createBackupEnvelopeV3(source, {
            compositionDocument: document(),
            createdAt: '2026-07-12T00:00:00.000Z',
        })

        expect(envelope.legacyStores).toBeUndefined()
        const clean = new MemoryStorage()
        await restoreBackupToStorage(clean, envelope, {
            overwrite: true,
            importWildcardContent: async () => undefined,
            readWildcardContent: async () => ({}),
        })
        expect(clean.getItem('scene-store')).toBeNull()
        expect(clean.getItem('character-positions')).toBeNull()
        expect(clean.getItem('novelaiPromptEditorState')).toBeNull()
        expect(localAliases.has('scene-store')).toBe(true)
    })

    it('retains the raw migration archive in the envelope but never restores it', async () => {
        const source = rawBackup()
        source[COMPOSITION_MIGRATION_BACKUP_STORE_KEY] = {
            format: 'nai-blue-composition-raw-migration-backup',
            archives: [{ sourceHash: 'sha256:source-before-migration' }],
        }
        const envelope = createBackupEnvelopeV3(source, {
            compositionDocument: document(),
            createdAt: '2026-07-12T00:00:00.000Z',
        })
        const prepared = prepareBackupRestore(envelope)

        expect(envelope.storeManifest.entries.map(entry => entry.key)).toContain(COMPOSITION_MIGRATION_BACKUP_STORE_KEY)
        expect(prepared.report.canRestore).toBe(true)
        expect(prepared.report.ignoredKeys).toContainEqual({
            key: COMPOSITION_MIGRATION_BACKUP_STORE_KEY,
            reason: 'migration-backup-archive',
        })
        expect(prepared.restorePayload).not.toHaveProperty(COMPOSITION_MIGRATION_BACKUP_STORE_KEY)

        const clean = new MemoryStorage()
        await restoreBackupToStorage(clean, envelope, {
            overwrite: true,
            importWildcardContent: async () => undefined,
            readWildcardContent: async () => ({}),
        })
        expect(clean.getItem(COMPOSITION_MIGRATION_BACKUP_STORE_KEY)).toBeNull()

        const legacyPrepared = prepareBackupRestore(source)
        expect(legacyPrepared.restorePayload).not.toHaveProperty(COMPOSITION_MIGRATION_BACKUP_STORE_KEY)
        expect(legacyPrepared.report.ignoredKeys).toContainEqual({
            key: COMPOSITION_MIGRATION_BACKUP_STORE_KEY,
            reason: 'migration-backup-archive',
        })
    })

    it('rejects consistent future store persistence and state schema versions', () => {
        const futureVersionSource = rawBackup()
        futureVersionSource['nai-blue-scenes'] = {
            version: 999,
            state: { presets: [] },
        }
        const futureVersionEnvelope = createBackupEnvelopeV3(futureVersionSource, {
            compositionDocument: document(),
            createdAt: '2026-07-12T00:00:00.000Z',
        })
        expect(dryRunBackupRestore(futureVersionEnvelope)).toMatchObject({
            canRestore: false,
            errors: expect.arrayContaining([
                expect.objectContaining({ code: 'E_STORE_SCHEMA_NEWER', key: 'nai-blue-scenes' }),
            ]),
        })
        expect(dryRunBackupRestore(futureVersionSource).errors).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'E_STORE_SCHEMA_NEWER', key: 'nai-blue-scenes' }),
        ]))

        const futureSchemaSource = rawBackup()
        futureSchemaSource['nai-blue-wildcards'] = {
            version: 2,
            state: { schemaVersion: 999, files: [] },
        }
        const futureSchemaEnvelope = createBackupEnvelopeV3(futureSchemaSource, {
            compositionDocument: document(),
            createdAt: '2026-07-12T00:00:00.000Z',
        })
        expect(dryRunBackupRestore(futureSchemaEnvelope).errors).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'E_STORE_SCHEMA_NEWER', key: 'nai-blue-wildcards' }),
        ]))
    })

    it('ignores pre-release aliases instead of treating them as restore authority', () => {
        const source = rawBackup()
        source['scene-store'] = {
            version: 2,
            state: {
                schemaVersion: 2,
                presets: [],
            },
        }
        const envelope = createBackupEnvelopeV3(source, {
            compositionDocument: document(),
            createdAt: '2026-07-12T00:00:00.000Z',
        })

        expect(envelope.legacyStores).toBeUndefined()
        expect(dryRunBackupRestore(envelope)).toMatchObject({ canRestore: true, errors: [] })
    })

    it('strictly validates repository state and restores only its committed envelope projection', () => {
        const compositionDocument = document()
        const source = rawBackup(compositionDocument)
        const repository = source[COMPOSITION_REPOSITORY_STORE_KEY] as ReturnType<typeof createCommittedCompositionRepositoryRecord>
        source[COMPOSITION_REPOSITORY_STORE_KEY] = {
            ...repository,
            staged: {
                migrationId: 'migration:interrupted',
                document: compositionDocument,
                documentHash: compositionDocumentHash(compositionDocument),
                writtenAt: '2026-07-12T00:01:00.000Z',
            },
            migrationLock: {
                id: 'lock:interrupted',
                owner: 'migration:test',
                acquiredAt: '2026-07-12T00:01:00.000Z',
                expiresAt: '2026-07-12T00:11:00.000Z',
            },
        }
        const envelope = createBackupEnvelopeV3(source, {
            compositionDocument,
            createdAt: '2026-07-12T00:02:00.000Z',
        })
        const prepared = prepareBackupRestore(envelope)
        const restoredRepository = prepared.restorePayload[COMPOSITION_REPOSITORY_STORE_KEY] as Record<string, unknown>

        expect(prepared.report.canRestore).toBe(true)
        expect(prepared.report.warnings).toContainEqual(expect.objectContaining({
            code: 'W_COMPOSITION_REPOSITORY_TRANSIENT_STATE_IGNORED',
        }))
        expect(restoredRepository).toMatchObject({
            revision: repository.revision,
            authority: repository.authority,
            committedDocument: compositionDocument,
            committedHash: compositionDocumentHash(compositionDocument),
        })
        expect(restoredRepository).not.toHaveProperty('staged')
        expect(restoredRepository).not.toHaveProperty('migrationLock')

        const corruptedSource = rawBackup(compositionDocument)
        corruptedSource[COMPOSITION_REPOSITORY_STORE_KEY] = {
            ...(corruptedSource[COMPOSITION_REPOSITORY_STORE_KEY] as Record<string, unknown>),
            committedHash: 'sha256:not-the-document-hash',
        }
        expect(() => createBackupEnvelopeV3(corruptedSource, {
            compositionDocument,
            createdAt: '2026-07-12T00:00:00.000Z',
        })).toThrow(/invalid composition repository/i)
    })

    it('rejects newer schemas and corrupted store manifests before any write', async () => {
        const envelope = createBackupEnvelopeV3(rawBackup(), {
            compositionDocument: document(),
            createdAt: '2026-07-12T00:00:00.000Z',
        })
        const futureEnvelope = { ...envelope, formatVersion: 4 }
        expect(dryRunBackupRestore(futureEnvelope)).toMatchObject({
            canRestore: false,
            errors: [expect.objectContaining({ code: 'E_BACKUP_SCHEMA_NEWER' })],
        })

        const futureComposition = { ...envelope, compositionSchemaVersion: 3 }
        expect(dryRunBackupRestore(futureComposition).errors).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'E_COMPOSITION_SCHEMA_NEWER' }),
        ]))

        const corrupted = JSON.parse(JSON.stringify(envelope)) as typeof envelope
        const generation = corrupted.stores['nai-blue-generation'] as { state: { prompt: string } }
        generation.state.prompt = 'tampered after export'
        const report = dryRunBackupRestore(corrupted)
        expect(report.canRestore).toBe(false)
        expect(report.errors).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'E_STORE_MANIFEST_MISMATCH', key: 'nai-blue-generation' }),
        ]))

        const storage = new MemoryStorage()
        await expect(restoreBackupToStorage(storage, corrupted, { overwrite: true }))
            .rejects.toBeInstanceOf(UnsupportedBackupSchemaError)
        expect(storage.values.size).toBe(0)
    })

    it('round-trips old stores through v3 into clean storage without losing rollback sources', async () => {
        const source = rawBackup()
        const envelope = createBackupEnvelopeV3(source, {
            compositionDocument: document(),
            createdAt: '2026-07-12T00:00:00.000Z',
        })
        const clean = new MemoryStorage()
        let restoredWildcard: Record<string, string[]> | undefined
        const result = await restoreBackupToStorage(clean, JSON.parse(JSON.stringify(envelope)), {
            overwrite: true,
            importWildcardContent: async content => {
                restoredWildcard = content
            },
            readWildcardContent: async () => ({}),
        })

        expect(result.failed).toEqual([])
        expect(result.report.canRestore).toBe(true)
        expect(result.success).toEqual(expect.arrayContaining([
            'nai-blue-generation',
            'nai-blue-scenes',
            COMPOSITION_REPOSITORY_STORE_KEY,
            'nai-blue-wildcard-content',
        ]))
        for (const key of ['nai-blue-generation', 'nai-blue-scenes', COMPOSITION_REPOSITORY_STORE_KEY]) {
            expect(JSON.parse(clean.getItem(key) ?? 'null')).toEqual(source[key])
        }
        expect(restoredWildcard).toEqual({ sky: ['blue', 'red'] })
        expect(clean.getItem('old-marketplace-cache')).toBeNull()
        expect(clean.getItem('nai-blue-future-store')).toBeNull()
    })

    it('round-trips the exact Asset Profile disk authority through the allowlisted file path', async () => {
        const rawAssetProfile = JSON.stringify({
            revision: 17,
            updatedAt: '2024-01-02T03:04:05.000Z',
            updatedBy: 'legacy-import',
            modules: {},
            recipes: [],
            settings: { unknownLegacySetting: false },
            output: {},
            r2: { enabled: false },
        })
        const envelope = createBackupEnvelopeV3(rawBackup(), {
            compositionDocument: document(),
            createdAt: '2026-07-12T00:00:00.000Z',
            assetProfileJson: rawAssetProfile,
        })
        const prepared = prepareBackupRestore(envelope)

        expect(envelope.assetProfileJson).toBe(rawAssetProfile)
        expect(envelope.fileManifest.included).toContainEqual(expect.objectContaining({
            path: 'asset-profiles/default.json',
            kind: 'file',
        }))
        expect(prepared.report.restoreKeys).toContain(ASSET_PROFILE_FILE_RESTORE_KEY)
        expect(prepared.assetProfileJson).toBe(rawAssetProfile)

        let restoredRaw: string | undefined
        const result = await restoreBackupToStorage(new MemoryStorage(), envelope, {
            overwrite: true,
            importWildcardContent: async () => undefined,
            readWildcardContent: async () => ({}),
            restoreAssetProfileJson: async raw => { restoredRaw = raw },
            rollbackAssetProfileJson: async () => undefined,
        })
        expect(result.success).toContain(ASSET_PROFILE_FILE_RESTORE_KEY)
        expect(restoredRaw).toBe(rawAssetProfile)

        const missingAssetPayload = JSON.parse(JSON.stringify(envelope)) as Record<string, unknown>
        delete missingAssetPayload.assetProfileJson
        expect(dryRunBackupRestore(missingAssetPayload).errors).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: 'E_FILE_MANIFEST_ORPHANED_ENTRY',
                key: 'asset-profiles/default.json',
            }),
        ]))

        const missingWildcardPayload = JSON.parse(JSON.stringify(envelope)) as Record<string, unknown>
        delete missingWildcardPayload.wildcardContent
        expect(dryRunBackupRestore(missingWildcardPayload).errors).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: 'E_FILE_MANIFEST_ORPHANED_ENTRY',
                key: 'indexeddb/nai-blue-wildcard-content.json',
            }),
        ]))
    })

    it('preflights wildcard write and preimage capabilities before any store mutation', async () => {
        const envelope = createBackupEnvelopeV3(rawBackup(), {
            compositionDocument: document(),
            createdAt: '2026-07-12T00:00:00.000Z',
        })

        const missingWriterStorage = new MemoryStorage()
        await expect(restoreBackupToStorage(missingWriterStorage, envelope, {
            overwrite: true,
            readWildcardContent: async () => ({}),
        })).rejects.toMatchObject({
            name: 'BackupRestoreCapabilityError',
            issues: expect.arrayContaining([
                expect.objectContaining({ code: 'E_WILDCARD_RESTORE_WRITE_UNAVAILABLE' }),
            ]),
        })
        expect(missingWriterStorage.values.size).toBe(0)

        const missingPreimageStorage = new MemoryStorage()
        let wildcardWrites = 0
        await expect(restoreBackupToStorage(missingPreimageStorage, envelope, {
            overwrite: true,
            importWildcardContent: async () => { wildcardWrites += 1 },
        })).rejects.toBeInstanceOf(BackupRestoreCapabilityError)
        expect(missingPreimageStorage.values.size).toBe(0)
        expect(wildcardWrites).toBe(0)
    })

    it('preflights Asset Profile finalize and rollback capabilities before any store mutation', async () => {
        const rawAssetProfile = JSON.stringify({
            revision: 1,
            updatedAt: '2025-01-01T00:00:00.000Z',
            updatedBy: 'legacy-import',
            settings: {},
            output: {},
            r2: { enabled: false },
            modules: {},
            recipes: [],
        })
        const envelope = createBackupEnvelopeV3(rawBackup(), {
            compositionDocument: document(),
            createdAt: '2026-07-12T00:00:00.000Z',
            assetProfileJson: rawAssetProfile,
        })
        const wildcardCapabilities = {
            importWildcardContent: async () => undefined,
            readWildcardContent: async () => ({}),
        }

        const missingFinalizeStorage = new MemoryStorage()
        let rollbacks = 0
        await expect(restoreBackupToStorage(missingFinalizeStorage, envelope, {
            overwrite: true,
            ...wildcardCapabilities,
            rollbackAssetProfileJson: async () => { rollbacks += 1 },
        })).rejects.toMatchObject({
            name: 'BackupRestoreCapabilityError',
            issues: expect.arrayContaining([
                expect.objectContaining({ code: 'E_ASSET_PROFILE_RESTORE_FINALIZE_UNAVAILABLE' }),
            ]),
        })
        expect(missingFinalizeStorage.values.size).toBe(0)
        expect(rollbacks).toBe(0)

        const missingRollbackStorage = new MemoryStorage()
        let finalizes = 0
        await expect(restoreBackupToStorage(missingRollbackStorage, envelope, {
            overwrite: true,
            ...wildcardCapabilities,
            restoreAssetProfileJson: async () => { finalizes += 1 },
        })).rejects.toMatchObject({
            name: 'BackupRestoreCapabilityError',
            issues: expect.arrayContaining([
                expect.objectContaining({ code: 'E_ASSET_PROFILE_RESTORE_ROLLBACK_UNAVAILABLE' }),
            ]),
        })
        expect(missingRollbackStorage.values.size).toBe(0)
        expect(finalizes).toBe(0)
    })

    it('compensates store and Asset Profile writes when the file finalize fails', async () => {
        const rawAssetProfile = JSON.stringify({
            revision: 1,
            updatedAt: '2025-01-01T00:00:00.000Z',
            updatedBy: 'legacy-import',
            settings: {},
            output: {},
            r2: { enabled: false },
            modules: {},
            recipes: [],
        })
        const envelope = createBackupEnvelopeV3(rawBackup(), {
            compositionDocument: document(),
            createdAt: '2026-07-12T00:00:00.000Z',
            assetProfileJson: rawAssetProfile,
        })
        const storage = new MemoryStorage()
        const previousGeneration = JSON.stringify({ version: 8, state: { prompt: 'before restore' } })
        storage.values.set('nai-blue-generation', previousGeneration)
        let diskAuthority = 'before-file'

        await expect(restoreBackupToStorage(storage, envelope, {
            overwrite: true,
            importWildcardContent: async () => undefined,
            readWildcardContent: async () => ({}),
            restoreAssetProfileJson: async () => {
                diskAuthority = 'partial-file'
                throw new Error('disk full')
            },
            rollbackAssetProfileJson: async () => { diskAuthority = 'before-file' },
        })).rejects.toBeInstanceOf(BackupRestoreWriteError)

        expect(storage.getItem('nai-blue-generation')).toBe(previousGeneration)
        expect(storage.getItem(COMPOSITION_REPOSITORY_STORE_KEY)).toBeNull()
        expect(diskAuthority).toBe('before-file')
    })

    it('throws instead of reporting a partially failed restore as successful', async () => {
        const envelope = createBackupEnvelopeV3(rawBackup(), {
            compositionDocument: document(),
            createdAt: '2026-07-12T00:00:00.000Z',
        })
        const storage: BackupStoragePort = {
            getItem: () => null,
            setItem: () => undefined,
        }

        await expect(restoreBackupToStorage(storage, envelope, {
            overwrite: true,
            importWildcardContent: async () => undefined,
            readWildcardContent: async () => ({}),
        })).rejects.toBeInstanceOf(BackupRestoreWriteError)
    })

    it('rolls back earlier store writes when a later restore write fails', async () => {
        const envelope = createBackupEnvelopeV3(rawBackup(), {
            compositionDocument: document(),
            createdAt: '2026-07-12T00:00:00.000Z',
        })
        const values = new Map<string, string>([
            ['nai-blue-generation', JSON.stringify({ version: 8, state: { prompt: 'before restore' } })],
        ])
        const storage: BackupStoragePort = {
            getItem: key => values.get(key) ?? null,
            setItem: (key, value) => {
                values.set(key, key === 'nai-blue-scenes' ? `${value}:corrupted-readback` : value)
            },
            removeItem: key => { values.delete(key) },
        }

        await expect(restoreBackupToStorage(storage, envelope, {
            overwrite: true,
            importWildcardContent: async () => undefined,
            readWildcardContent: async () => ({}),
        })).rejects.toBeInstanceOf(BackupRestoreWriteError)

        expect(JSON.parse(values.get('nai-blue-generation') ?? 'null')).toMatchObject({
            state: { prompt: 'before restore' },
        })
        expect(values.has('nai-blue-scenes')).toBe(false)
        expect(values.has(COMPOSITION_REPOSITORY_STORE_KEY)).toBe(false)
    })

    it('uses the repository contract when a portable envelope has no repository store', () => {
        const source = rawBackup()
        delete source[COMPOSITION_REPOSITORY_STORE_KEY]
        const envelope = createBackupEnvelopeV3(source, {
            compositionDocument: document(),
            createdAt: '2026-07-12T00:00:00.000Z',
        })

        const defaultPrepared = prepareBackupRestore(envelope)
        expect(defaultPrepared.report.canRestore).toBe(true)
        expect(defaultPrepared.restorePayload[COMPOSITION_REPOSITORY_STORE_KEY]).toMatchObject({
            format: 'nai-blue-composition-repository',
            repositorySchemaVersion: 1,
            committedDocument: { schemaVersion: 2 },
        })

        const prepared = prepareBackupRestore(envelope, {
            createCompositionRepositoryRecord: (compositionDocument, context) => ({
                repositorySchemaVersion: 1,
                committedDocument: compositionDocument,
                updatedAt: context.updatedAt,
                authority: context.authority,
            }),
        })
        expect(prepared.report.canRestore).toBe(true)
        expect(prepared.restorePayload[COMPOSITION_REPOSITORY_STORE_KEY]).toMatchObject({
            repositorySchemaVersion: 1,
            committedDocument: { schemaVersion: 2 },
        })
    })

    it('keeps store-snapshot/1 compatibility while verifying store-snapshot/2 hashes', () => {
        const payload = { version: 1, state: { value: false, count: 0 } }
        const oldSnapshot = {
            _exportedAt: '2026-07-12T00:00:00.000Z',
            _version: 'store-snapshot/1',
            _kind: 'store-snapshot',
            _storeKey: 'nai-blue-settings',
            'nai-blue-settings': payload,
        }
        expect(prepareStoreSnapshotRestore('nai-blue-settings', oldSnapshot).report.canRestore).toBe(true)

        const v2Envelope = createBackupEnvelopeV3({ 'nai-blue-settings': payload }, {
            compositionDocument: document(),
            createdAt: '2026-07-12T00:00:00.000Z',
        })
        const manifest = v2Envelope.storeManifest.entries[0]
        const newSnapshot = {
            ...oldSnapshot,
            _version: 'store-snapshot/2',
            _manifest: manifest,
        }
        expect(prepareStoreSnapshotRestore('nai-blue-settings', newSnapshot).report).toMatchObject({
            canRestore: true,
            manifestVerified: true,
        })

        const futureSnapshot = { ...newSnapshot, _version: 'store-snapshot/99' }
        expect(prepareStoreSnapshotRestore('nai-blue-settings', futureSnapshot).report).toMatchObject({
            canRestore: false,
            errors: expect.arrayContaining([
                expect.objectContaining({ code: 'E_STORE_SNAPSHOT_VERSION_UNSUPPORTED' }),
            ]),
        })
    })
})
