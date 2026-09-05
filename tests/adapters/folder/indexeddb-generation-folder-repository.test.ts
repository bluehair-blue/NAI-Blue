import { describe, expect, it } from 'vitest'

import { IndexedDbGenerationFolderRepository } from '@/adapters/folder/indexeddb-generation-folder-repository'
import {
    DEFAULT_GENERATION_FOLDER_ID,
    migrateGenerationFolderV1Projection,
    resolveGenerationFolder,
    type GenerationFolder,
} from '@/domain/generation-folders'
import { FOLDER_DOCUMENT_STORE_KEY, FOLDER_V1_PREIMAGE_STORE_KEY } from '@/lib/indexed-db'
import { GenerationFolderAuthorityRuntime } from '@/lib/generation-folder-authority-runtime'
import { runGenerationFolderMigrationStartup } from '@/lib/generation-folder-migration-startup'
import { normalizePersistedSettingsState } from '@/stores/settings-store'

const NOW = '2026-09-04T00:00:00.000Z'

function folder(input: Partial<GenerationFolder> & Pick<GenerationFolder, 'id' | 'name'>): GenerationFolder {
    return {
        schemaVersion: 1,
        parentId: null,
        rootDirectory: null,
        useAbsolutePath: false,
        commonPrompt: '',
        r2: { autoUpload: false, bucket: null, prefix: null },
        createdAt: NOW,
        updatedAt: NOW,
        ...input,
    }
}

const legacyState = {
    savePath: 'E:\\NAI\\Images',
    useAbsolutePath: true,
    activeGenerationFolderId: 'grandchild',
    generationFolders: [
        folder({
            id: DEFAULT_GENERATION_FOLDER_ID,
            name: '기본 출력',
            rootDirectory: 'stale-root',
            r2: { autoUpload: false, bucket: 'root-bucket', prefix: 'ancestor/base' },
        }),
        folder({
            id: 'child',
            name: 'Child',
            parentId: DEFAULT_GENERATION_FOLDER_ID,
            r2: { autoUpload: false, bucket: 'child-bucket', prefix: null },
        }),
        folder({
            id: 'grandchild',
            name: 'Grandchild',
            parentId: 'child',
            commonPrompt: 'selected scalar prompt',
            r2: { autoUpload: true, bucket: null, prefix: null },
        }),
    ],
}

describe('IndexedDbGenerationFolderRepository', () => {
    it.each([1, 2])('reads settings version %i without changing its preimage and matches hydration', async version => {
        const preimage = JSON.stringify({ state: legacyState, version })
        const reads: string[] = []
        const persistence = {
            getItem: async (key: string) => {
                reads.push(key)
                return key === 'nai-blue-generation-folder-v1-preimage' ? null : preimage
            },
        }

        const projection = await new IndexedDbGenerationFolderRepository(persistence).readLegacyProjection()
        const hydrated = normalizePersistedSettingsState(legacyState)

        expect(reads).toEqual(['nai-blue-generation-folder-v1-preimage', 'nai-blue-settings'])
        expect(JSON.stringify({ state: legacyState, version })).toBe(preimage)
        expect(legacyState.generationFolders[0].rootDirectory).toBe('stale-root')
        expect(projection).toEqual({
            savePath: hydrated.savePath,
            useAbsolutePath: hydrated.useAbsolutePath,
            generationFolders: hydrated.generationFolders,
            activeGenerationFolderId: hydrated.activeGenerationFolderId,
        })
        expect(projection?.generationFolders[0]).toMatchObject({
            rootDirectory: 'E:\\NAI\\Images',
            useAbsolutePath: true,
        })
    })

    it('preserves the existing local and R2 resolver result for the selected grandchild', async () => {
        const repository = new IndexedDbGenerationFolderRepository({
            getItem: async () => JSON.stringify({ state: legacyState, version: 1 }),
        })
        const projection = await repository.readLegacyProjection()

        expect(resolveGenerationFolder(
            projection?.generationFolders ?? [],
            projection?.activeGenerationFolderId,
            { directory: 'fallback', useAbsolutePath: false, r2Bucket: 'profile-bucket', r2Prefix: 'profile' },
        )).toEqual({
            id: 'grandchild',
            path: '기본 출력 / Child / Grandchild',
            directory: 'E:\\NAI\\Images\\Child\\Grandchild',
            useAbsolutePath: true,
            commonPrompt: 'selected scalar prompt',
            r2: {
                autoUpload: true,
                bucket: 'child-bucket',
                prefix: 'ancestor/base/Child/Grandchild',
                prefixSource: 'ancestor',
            },
        })
    })

    it('matches Settings hydration for mixed valid and invalid V1 folders without mutating the preimage', async () => {
        const mixedState = {
            ...legacyState,
            generationFolders: [
                ...legacyState.generationFolders,
                { ...legacyState.generationFolders[1], id: 'invalid', name: '../escape' },
            ],
        }
        const preimage = JSON.stringify({ state: mixedState, version: 1 })
        const repository = new IndexedDbGenerationFolderRepository({ getItem: async () => preimage })

        const projection = await repository.readLegacyProjection()
        const hydrated = normalizePersistedSettingsState(mixedState)

        expect(JSON.stringify({ state: mixedState, version: 1 })).toBe(preimage)
        expect(projection).toEqual({
            savePath: hydrated.savePath,
            useAbsolutePath: hydrated.useAbsolutePath,
            generationFolders: hydrated.generationFolders,
            activeGenerationFolderId: hydrated.activeGenerationFolderId,
        })
        expect(projection?.generationFolders.some(candidate => candidate.id === 'invalid')).toBe(false)
        expect(projection?.generationFolders.some(candidate => candidate.id === 'child')).toBe(true)
    })

    it('returns null when the legacy settings key is missing', async () => {
        const repository = new IndexedDbGenerationFolderRepository({ getItem: async () => null })
        await expect(repository.readLegacyProjection()).resolves.toBeNull()
    })

    it.each([
        '{',
        'null',
        JSON.stringify({ state: legacyState }),
        JSON.stringify({ state: legacyState, version: 3 }),
        JSON.stringify({ state: [], version: 1 }),
    ])('rejects a malformed or unsupported envelope without repairing it: %s', async serialized => {
        const repository = new IndexedDbGenerationFolderRepository({ getItem: async () => serialized })
        await expect(repository.readLegacyProjection()).rejects.toBeInstanceOf(TypeError)
    })

    it('restores the authoritative Folder projection after settings version 2 is preserved on restart', async () => {
        const document = {
            ...migrateGenerationFolderV1Projection('local', normalizePersistedSettingsState(legacyState)),
            revision: 3,
        }
        // A fresh profile can first preserve settings after Phase 9C wrote its v2 envelope.
        const preimage = JSON.stringify({ version: 2, state: { sceneSavePath: 'existing-scene' } })
        const documents = JSON.stringify({ schemaVersion: 1, documents: [document] })
        const values = new Map([[FOLDER_V1_PREIMAGE_STORE_KEY, preimage], [FOLDER_DOCUMENT_STORE_KEY, documents]])
        const repository = new IndexedDbGenerationFolderRepository({ getItem: async key => values.get(key) ?? null })
        const applied: typeof document[] = []
        const runtime = new GenerationFolderAuthorityRuntime(repository, restored => applied.push(restored), undefined,
            dependencies => runGenerationFolderMigrationStartup({
                ...dependencies,
                persistence: {
                    preservePreimage: async () => preimage,
                    readMarker: async () => ({ reader: 'v2', verifiedAt: NOW }),
                    writeMarker: async () => { throw new Error('Existing authority must not be rewritten') },
                },
            }))

        await expect(runtime.initialize()).resolves.toEqual(document)
        expect(applied).toEqual([document])
        expect(values.get(FOLDER_DOCUMENT_STORE_KEY)).toBe(documents)
        expect(values.get(FOLDER_V1_PREIMAGE_STORE_KEY)).toBe(preimage)
    })

    it('creates revision 1, rejects stale commits, and preserves another workspace through a storage race', async () => {
        const first = migrateGenerationFolderV1Projection('workspace:a', normalizePersistedSettingsState(legacyState))
        const other = migrateGenerationFolderV1Projection('workspace:b', normalizePersistedSettingsState(legacyState))
        const values = new Map<string, string>()
        let races = 0
        const repository = new IndexedDbGenerationFolderRepository({
            getItem: async key => values.get(key) ?? null,
            compareAndSet: async (key, expected, next) => {
                if ((values.get(key) ?? null) !== expected) return false
                if (races++ === 1) {
                    values.set(key, JSON.stringify({ schemaVersion: 1, documents: [first, other] }))
                    return false
                }
                values.set(key, next)
                return true
            },
        })

        await expect(repository.commit(first, 0)).resolves.toMatchObject({ status: 'COMMITTED' })
        const next = { ...first, revision: 2 }
        await expect(repository.commit(next, 1)).resolves.toMatchObject({ status: 'COMMITTED' })
        await expect(repository.commit(next, 1)).resolves.toMatchObject({ status: 'REVISION_CONFLICT' })
        expect((await repository.listDocuments()).map(item => item.workspaceId)).toEqual(['workspace:a', 'workspace:b'])
    })

    it('materializes legacy once, preserves its preimage, and reopens from V2', async () => {
        const legacy = JSON.stringify({ state: legacyState, version: 1 })
        const values = new Map<string, string>([['nai-blue-settings', legacy]])
        const writes: string[] = []
        const port = {
            getItem: async (key: string) => values.get(key) ?? null,
            compareAndSet: async (key: string, expected: string | null, next: string) => {
                if ((values.get(key) ?? null) !== expected) return false
                writes.push(key)
                values.set(key, next)
                return true
            },
        }
        const migrated = await new IndexedDbGenerationFolderRepository(port).materializeLegacy('workspace')
        expect(migrated).toMatchObject({ workspaceId: 'workspace', revision: 1 })
        expect(values.get('nai-blue-settings')).toBe(legacy)
        expect(writes).toEqual([FOLDER_DOCUMENT_STORE_KEY])
        await expect(new IndexedDbGenerationFolderRepository(port).getDocument('workspace')).resolves.toEqual(migrated)
        await expect(new IndexedDbGenerationFolderRepository({ getItem: async key => key === 'nai-blue-settings' ? legacy : null }).readLegacyProjection()).resolves.not.toBeNull()
    })

    it('fails closed on malformed V2 instead of falling back to legacy', async () => {
        const repository = new IndexedDbGenerationFolderRepository({
            getItem: async key => key === FOLDER_DOCUMENT_STORE_KEY ? '{' : JSON.stringify({ state: legacyState, version: 1 }),
        })
        await expect(repository.materializeLegacy('workspace')).rejects.toBeInstanceOf(TypeError)
    })

    it('returns STORAGE_CONFLICT after three failed storage races', async () => {
        let attempts = 0
        const repository = new IndexedDbGenerationFolderRepository({
            getItem: async () => null,
            compareAndSet: async () => {
                attempts += 1
                return false
            },
        })
        const document = migrateGenerationFolderV1Projection('workspace', normalizePersistedSettingsState(legacyState))
        await expect(repository.commit(document, 0)).resolves.toEqual({ status: 'STORAGE_CONFLICT' })
        expect(attempts).toBe(3)
    })
})
