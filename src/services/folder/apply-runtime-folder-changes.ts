import {
    applyGenerationFolderChanges,
    type ApplyGenerationFolderChangesInput,
    type ApplyGenerationFolderChangesResult,
} from '@/application/folder/apply-folder-changes'
import { IndexedDbGenerationFolderRepository } from '@/adapters/folder/indexeddb-generation-folder-repository'
import { inspectRuntimeFolderOccupancy } from './runtime-folder-occupancy'
import { authorizeNativeDirectory } from '@/platform/native-file-system'
import { runtimeWorkspaceMutationGate } from '@/lib/workspace-mutation-gate'

/** Authorizes each resolved directory once, sequentially, while retaining only logical IDs upstream. */
export async function authorizeRequiredNativeDirectories(
    authorizations: readonly { readonly folderId: string; readonly directory: string }[],
): Promise<void> {
    const directories = [...new Set(authorizations.map(item => item.directory.trim()))]
    for (const directory of directories) await authorizeNativeDirectory(directory)
}

/** Production command surface over the Folder CAS and runtime occupancy authorities. */
export function applyRuntimeGenerationFolderChanges(
    input: Omit<ApplyGenerationFolderChangesInput, 'repository' | 'occupancyGuard' | 'mutationGate' | 'authorizeDirectories'>,
): Promise<ApplyGenerationFolderChangesResult> {
    return applyGenerationFolderChanges({
        ...input,
        repository: new IndexedDbGenerationFolderRepository(),
        occupancyGuard: folderIds => inspectRuntimeFolderOccupancy(input.workspaceId, folderIds),
        mutationGate: runtimeWorkspaceMutationGate,
        authorizeDirectories: authorizeRequiredNativeDirectories,
    })
}

/** Refreshes the durable authority after a rejected UI mutation without exposing storage details. */
export function getRuntimeGenerationFolderDocument(workspaceId: string) {
    return new IndexedDbGenerationFolderRepository().getDocument(workspaceId)
}
