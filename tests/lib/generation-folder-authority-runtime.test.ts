import { describe, expect, it } from 'vitest'

import type { GenerationFolderRepositoryPort } from '@/application/folder/generation-folder-repository'
import { planGenerationFolderChanges } from '@/application/folder/plan-folder-changes'
import {
    migrateGenerationFolderV1Projection,
    normalizeGenerationFolderV1Projection,
    type GenerationFolderDocument,
} from '@/domain/generation-folders'
import {
    GenerationFolderAuthorityRuntime,
    projectGenerationFolderDocument,
    resolveGenerationFolderAuthority,
} from '@/lib/generation-folder-authority-runtime'

const projection = normalizeGenerationFolderV1Projection({
    savePath: 'D:\images',
    useAbsolutePath: true,
    activeGenerationFolderId: 'child',
    generationFolders: [{
        schemaVersion: 1,
        id: 'child',
        name: 'Physical',
        parentId: 'generation-folder-default',
        rootDirectory: null,
        useAbsolutePath: false,
        commonPrompt: '',
        r2: { autoUpload: true, bucket: null, prefix: null },
        createdAt: '2026-09-04T00:00:00.000Z',
        updatedAt: '2026-09-04T00:00:00.000Z',
    }],
})

describe('generation folder authority runtime', () => {
    it('projects displayName as the UI label while a label rename preserves local and R2 paths', () => {
        const document = migrateGenerationFolderV1Projection('local', projection)
        const planned = planGenerationFolderChanges(document, [{ folderId: 'child', displayName: '표시 이름' }], {
            directory: 'fallback', useAbsolutePath: false, r2Prefix: 'profile',
        })
        expect(planned.status).toBe('PLANNED')
        if (planned.status !== 'PLANNED') return

        const before = resolveGenerationFolderAuthority(document, projection.generationFolders, 'child', {
            directory: 'fallback', useAbsolutePath: false, r2Prefix: 'profile',
        })
        const folders = projectGenerationFolderDocument(planned.document, projection.generationFolders)
        const after = resolveGenerationFolderAuthority(planned.document, folders, 'child', {
            directory: 'fallback', useAbsolutePath: false, r2Prefix: 'profile',
        })

        expect(folders.find(folder => folder.id === 'child')).toMatchObject({ name: '표시 이름', pathSegment: 'Physical' })
        expect(after?.path).toContain('표시 이름')
        expect(after?.directory).toBe(before?.directory)
        expect(after?.r2.prefix).toBe(before?.r2.prefix)
    })

    it('keeps explicit clear policies in V2 and exposes their cleared downstream values', () => {
        const document = migrateGenerationFolderV1Projection('local', projection)
        const cleared: GenerationFolderDocument = {
            ...document,
            revision: 2,
            folders: document.folders.map(folder => folder.id === 'child' ? {
                ...folder,
                r2ProfilePolicy: { mode: 'clear' },
                r2BucketPolicy: { mode: 'clear' },
                r2PrefixPolicy: { mode: 'clear' },
            } : folder),
        }
        const planned = planGenerationFolderChanges(cleared, [{ folderId: 'child', displayName: 'Renamed' }], {
            directory: 'fallback', useAbsolutePath: false, r2Bucket: 'bucket', r2Prefix: 'profile',
        })
        expect(planned.status).toBe('PLANNED')
        if (planned.status !== 'PLANNED') return

        expect(planned.document.folders.find(folder => folder.id === 'child')).toMatchObject({
            r2ProfilePolicy: { mode: 'clear' },
            r2BucketPolicy: { mode: 'clear' },
            r2PrefixPolicy: { mode: 'clear' },
        })
        expect(resolveGenerationFolderAuthority(planned.document, projectGenerationFolderDocument(planned.document), 'child', {
            directory: 'fallback', useAbsolutePath: false, r2Bucket: 'bucket', r2Prefix: 'profile',
        })?.r2).toEqual({ autoUpload: false, profileId: null, bucket: null, prefix: '', prefixSource: 'folder' })
    })

    it('resolves an explicit R2 profile instead of silently falling back to the workspace profile', () => {
        const document = migrateGenerationFolderV1Projection('local', projection)
        const explicitProfile: GenerationFolderDocument = {
            ...document,
            revision: 2,
            folders: document.folders.map(folder => folder.id === 'child' ? {
                ...folder,
                r2ProfilePolicy: { mode: 'set', value: 'profile-special' },
            } : folder),
        }

        expect(resolveGenerationFolderAuthority(
            explicitProfile,
            projectGenerationFolderDocument(explicitProfile),
            'child',
            {
                directory: 'fallback',
                useAbsolutePath: false,
                r2ProfileId: 'profile-default',
                r2Bucket: 'bucket',
                r2Prefix: 'profile',
            },
        )?.r2.profileId).toBe('profile-special')
    })

    it('restores the preserved V1 projection when the authority marker is rolled back', async () => {
        const base = migrateGenerationFolderV1Projection('local', projection)
        const appliedDocuments: GenerationFolderDocument[] = []
        const appliedLegacy: typeof projection[] = []
        const repository: GenerationFolderRepositoryPort = {
            readLegacyProjection: async () => projection,
            getDocument: async () => base,
            listDocuments: async () => [],
            materializeLegacy: async () => base,
            commit: async () => ({ status: 'STORAGE_CONFLICT' }),
        }
        const runtime = new GenerationFolderAuthorityRuntime(
            repository,
            document => appliedDocuments.push(document),
            legacy => appliedLegacy.push(legacy),
            async () => ({
                status: 'V1_FALLBACK',
                reason: 'ROLLED_BACK',
                legacy: projection,
            }),
        )

        await expect(runtime.initialize()).resolves.toBeNull()

        expect(appliedDocuments).toHaveLength(0)
        expect(appliedLegacy).toEqual([projection])
    })
})
