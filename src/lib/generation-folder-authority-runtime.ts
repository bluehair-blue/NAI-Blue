import type { GenerationFolderRepositoryPort } from '@/application/folder/generation-folder-repository'
import {
    DEFAULT_GENERATION_FOLDER_ID,
    resolveGenerationFolder,
    resolveGenerationFolderV2,
    type GenerationFolder,
    type GenerationFolderDocument,
    type GenerationFolderV2Defaults,
    type GenerationFolderV1Projection,
    type ResolvedGenerationFolder,
} from '@/domain/generation-folders'
import type { GenerationFolderMigrationStartupResult } from '@/lib/generation-folder-migration-startup'

export const DEFAULT_GENERATION_FOLDER_WORKSPACE_ID = 'local' as const

/** UI compatibility row: labels remain mutable while physical resolution uses pathSegment. */
export type ProjectedGenerationFolder = GenerationFolder & { readonly pathSegment?: string }

export function projectGenerationFolderDocument(
    document: GenerationFolderDocument,
    previous: readonly GenerationFolder[] = [],
): ProjectedGenerationFolder[] {
    const previousById = new Map(previous.map(folder => [folder.id, folder]))
    return document.folders.map(folder => {
        const prior = previousById.get(folder.id)
        return {
            schemaVersion: 1,
            id: folder.id,
            name: folder.displayName,
            pathSegment: folder.pathSegment,
            parentId: folder.parentId,
            rootDirectory: folder.rootDirectory,
            useAbsolutePath: folder.useAbsolutePath,
            commonPrompt: folder.commonPrompt,
            r2: {
                autoUpload: folder.autoUpload,
                bucket: folder.r2BucketPolicy.mode === 'set' ? folder.r2BucketPolicy.value : null,
                prefix: folder.r2PrefixPolicy.mode === 'set' ? folder.r2PrefixPolicy.value : null,
            },
            createdAt: prior?.createdAt ?? '1970-01-01T00:00:00.000Z',
            updatedAt: prior?.updatedAt ?? '1970-01-01T00:00:00.000Z',
        }
    })
}

/** Maps the V2 resolver to the stable V1 consumer shape without recomputing paths from labels. */
export function resolveGenerationFolderAuthority(
    document: GenerationFolderDocument | null,
    folders: readonly GenerationFolder[],
    folderId: string | null | undefined,
    defaults: GenerationFolderV2Defaults,
): ResolvedGenerationFolder | null {
    if (document === null) {
        // The V1 fallback is only reachable before the one-time V2 materialization completes.
        return resolveGenerationFolder(folders, folderId, defaults)
    }
    const resolved = resolveGenerationFolderV2(document, folderId, defaults)
    if (resolved === null) return null
    const prefixSourceId = resolved.sources.r2Prefix
    return {
        id: resolved.id,
        path: resolved.displayPath,
        directory: resolved.directory,
        useAbsolutePath: resolved.useAbsolutePath,
        commonPrompt: resolved.commonPrompt,
        r2: {
            autoUpload: resolved.autoUpload && resolved.r2.enabled,
            profileId: resolved.r2.profileId,
            bucket: resolved.r2.bucket,
            prefix: resolved.r2.prefix,
            prefixSource: prefixSourceId === resolved.id
                ? 'folder'
                : prefixSourceId === null
                    ? 'profile'
                    : 'ancestor',
        },
    }
}

/** Startup-only bridge that projects the migration-selected Folder authority. */
export class GenerationFolderAuthorityRuntime {
    constructor(
        private readonly repository: GenerationFolderRepositoryPort,
        private readonly applyDocument: (document: GenerationFolderDocument) => void,
        private readonly applyLegacy: (projection: GenerationFolderV1Projection) => void = () => undefined,
        private readonly migrate?: (dependencies: {
            readonly repository: GenerationFolderRepositoryPort
            readonly workspaceId: string
        }) => Promise<GenerationFolderMigrationStartupResult>,
    ) {}

    async initialize(workspaceId = DEFAULT_GENERATION_FOLDER_WORKSPACE_ID): Promise<GenerationFolderDocument | null> {
        const migrate = this.migrate
            ?? (await import('@/lib/generation-folder-migration-startup')).runGenerationFolderMigrationStartup
        const result = await migrate({ repository: this.repository, workspaceId })
        if (result.status !== 'V2_ACTIVE') {
            if (result.legacy !== null) this.applyLegacy(result.legacy)
            return null
        }
        this.applyDocument(result.document)
        return result.document
    }
}

export function generationFolderRootProjection(document: GenerationFolderDocument): {
    readonly savePath: string
    readonly useAbsolutePath: boolean
} {
    const root = document.folders.find(folder => folder.id === DEFAULT_GENERATION_FOLDER_ID)
        ?? document.folders.find(folder => folder.parentId === null)
    return {
        savePath: root?.rootDirectory ?? 'NAI_Blue_Output',
        useAbsolutePath: root?.useAbsolutePath ?? false,
    }
}
