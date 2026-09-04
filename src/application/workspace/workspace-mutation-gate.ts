/** Serializes final durable mutations for one workspace authority in this process. */
export interface WorkspaceMutationGatePort {
    runExclusive<T>(workspaceId: string, operation: () => Promise<T>): Promise<T>
}

/** Whole-document key shared by Folder CAS and generation Queue commits. */
export function generationFolderDocumentMutationKey(workspaceId: string): string {
    return `generation-folder-document:${workspaceId}`
}
