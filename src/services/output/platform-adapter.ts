import type { BaseDirectory } from '@tauri-apps/plugin-fs'
import type { PortablePathRef } from '@/domain/composition/types'
import type { OutputReservationGuarantee } from '@/platform/capabilities'
import type { OutputCommitSet } from '@/domain/queue/types'
import { hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import { normalizeOutputDirectoryPath } from '@/domain/output-commit-set'

export type OutputRuntimeKind = 'desktop' | 'app-scoped'

export interface OutputFileRef {
    path: string
    displayPath: string
    baseDir?: BaseDirectory
}

export interface OutputDestinationRequest {
    /** Canonical v2 destination. Raw directory fields below are legacy adapters only. */
    portableDirectory?: PortablePathRef
    directory?: string | null
    useAbsolutePath?: boolean
    capabilityFallbackDirectory?: string | null
    workflowDefaultDirectory: string
}

export interface ResolvedOutputDirectory extends OutputFileRef {
    capabilityFallbackUsed: boolean
    fallbackReason?: string
    fallbackAlternative?: string
}

export interface OutputPlatformCapabilities {
    absolutePaths: boolean
    atomicSiblingRename: boolean
    outputReservationGuarantee: OutputReservationGuarantee
    runtime: OutputRuntimeKind
}

export type OutputCommitIfAbsentResult =
    | { readonly status: 'committed' }
    | { readonly status: 'destination-exists' }

export interface OutputPlatformAdapter {
    readonly capabilities: OutputPlatformCapabilities
    resolveDirectory(request: OutputDestinationRequest): Promise<ResolvedOutputDirectory>
    ensureDirectory(directory: OutputFileRef): Promise<void>
    exists(file: OutputFileRef): Promise<boolean>
    writeFile(file: OutputFileRef, bytes: Uint8Array): Promise<void>
    readFile(file: OutputFileRef): Promise<Uint8Array>
    /** Reads only direct child names; batch planning owns recursion and collision semantics. */
    readDirectoryEntries(directory: OutputFileRef): Promise<readonly string[]>
    rename(from: OutputFileRef, to: OutputFileRef): Promise<void>
    commitSiblingIfAbsent(from: OutputFileRef, to: OutputFileRef): Promise<OutputCommitIfAbsentResult>
    remove(file: OutputFileRef): Promise<void>
    writeJournal(transactionId: string, bytes: Uint8Array): Promise<void>
    readJournal(transactionId: string): Promise<Uint8Array | null>
    removeJournal(transactionId: string): Promise<void>
    listJournalIds(): Promise<string[]>
}

/** Hashes adapter-owned path authority without persisting a raw local path. */
export function directoryIdentityForResolvedOutputDirectory(
    directory: ResolvedOutputDirectory,
    filesystemSemantics: OutputCommitSet['filesystemSemantics'],
): `sha256:${string}` {
    return `sha256:${hashCanonicalValue({
        baseDir: directory.baseDir ?? null,
        path: normalizeOutputDirectoryPath(directory.path, filesystemSemantics),
    })}`
}

export function childOutputRef(directory: OutputFileRef, fileName: string): OutputFileRef {
    const separator = directory.path.endsWith('/') || directory.path.endsWith('\\') ? '' : '/'
    const displaySeparator = directory.displayPath.endsWith('/') || directory.displayPath.endsWith('\\') ? '' : '/'
    return {
        path: `${directory.path}${separator}${fileName}`,
        displayPath: `${directory.displayPath}${displaySeparator}${fileName}`,
        ...(directory.baseDir === undefined ? {} : { baseDir: directory.baseDir }),
    }
}

export function serializeOutputFileRef(file: OutputFileRef): OutputFileRef {
    return {
        path: file.path,
        displayPath: file.displayPath,
        ...(file.baseDir === undefined ? {} : { baseDir: file.baseDir }),
    }
}
