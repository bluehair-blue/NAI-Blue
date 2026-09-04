import { join } from '@tauri-apps/api/path'
import {
    BaseDirectory,
    exists,
    mkdir,
    readDir,
    readFile,
    remove,
    rename,
    writeFile,
} from '@tauri-apps/plugin-fs'
import {
    createRuntimeCapabilities,
    runtimeCapabilities,
    type RuntimeCapabilities,
} from '@/platform/capabilities'
import {
    assessPortablePath,
    runtimePortablePathTokenRegistry,
    type PlatformTokenRegistry,
    type PortableResourceIssue,
} from '@/platform/portable-resources'
import type { PortablePathRef } from '@/domain/composition/types'
import {
    getMediaStorageRoot,
    getPortableStorageBaseDirectory,
    MEDIA_STORAGE_BASE_DIRECTORY,
    resolveStorageBaseDirectoryRoot,
} from '@/platform/storage'
import { authorizeNativeDirectory, commitNativeSiblingIfAbsent } from '@/platform/native-file-system'
import type {
    OutputDestinationRequest,
    OutputFileRef,
    OutputPlatformAdapter,
    OutputPlatformCapabilities,
    OutputCommitIfAbsentResult,
    ResolvedOutputDirectory,
} from './platform-adapter'

const JOURNAL_DIRECTORY = 'nai-blue/output-journal'
const JOURNAL_SUFFIX = '.json'

export class UnresolvedOutputPathError extends Error {
    constructor(readonly issues: PortableResourceIssue[]) {
        super(issues.map(issue => `${issue.message} ${issue.repairAction.label}`).join(' '))
        this.name = 'UnresolvedOutputPathError'
    }
}

function isAbsoluteLike(path: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]/.test(path)
}

function sanitizeDirectoryComponent(value: string): string {
    return value.replace(/[<>:"|?*\x00-\x1f]/g, '_').trim().replace(/[. ]+$/g, '') || 'output'
}

export function sanitizeRelativeOutputDirectory(value: string, fallback: string): string {
    const segments = value
        .split(/[\\/]+/)
        .map(segment => segment.trim())
        .filter(segment => segment.length > 0 && segment !== '.' && segment !== '..')
        .map(sanitizeDirectoryComponent)
    if (segments.length > 0) return segments.join('/')
    return fallback.split(/[\\/]+/).filter(Boolean).map(sanitizeDirectoryComponent).join('/') || 'NAI_Blue_Output'
}

function optionsFor(file: OutputFileRef): { baseDir?: BaseDirectory } | undefined {
    return file.baseDir === undefined ? undefined : { baseDir: file.baseDir }
}

async function absoluteOutputPath(file: OutputFileRef): Promise<string> {
    if (file.baseDir === undefined) return file.path
    const root = await resolveStorageBaseDirectoryRoot(file.baseDir)
    return join(root, ...file.path.split(/[\\/]+/).filter(Boolean))
}

async function resolvePortableOutputDirectory(
    path: PortablePathRef,
    capabilities: RuntimeCapabilities,
    registry: PlatformTokenRegistry,
): Promise<ResolvedOutputDirectory> {
    if (path.kind === 'bookmark') {
        const token = registry.resolve(path.bookmarkId)
        if (token?.kind === 'file') {
            throw new UnresolvedOutputPathError([{
                code: 'E_PORTABLE_PATH_INVALID',
                message: 'The selected token references a file, not an output directory.',
                blocking: true,
                repairAction: {
                    kind: 'select-directory',
                    bookmarkId: path.bookmarkId,
                    label: 'Choose output directory',
                },
            }])
        }
    }
    const assessment = assessPortablePath(path, capabilities, registry)
    if (assessment.status === 'unresolved') throw new UnresolvedOutputPathError(assessment.issues)
    const materialized = assessment.materialized
    if (materialized.kind === 'standard' && materialized.root !== undefined) {
        const displayRoot = materialized.root === 'app-data'
            ? await resolveStorageBaseDirectoryRoot(BaseDirectory.AppData)
            : materialized.root === 'pictures'
                ? await getMediaStorageRoot()
                : null
        return {
            path: materialized.relativePath || '.',
            displayPath: displayRoot === null
                ? materialized.displayPath
                : await join(displayRoot, materialized.relativePath),
            baseDir: getPortableStorageBaseDirectory(materialized.root),
            capabilityFallbackUsed: false,
        }
    }
    if (!materialized.opaqueToken) {
        throw new Error('Resolved user-selected output is missing its platform token')
    }
    const separator = materialized.relativePath ? '/' : ''
    return {
        path: `${materialized.opaqueToken}${separator}${materialized.relativePath}`,
        displayPath: materialized.displayPath,
        capabilityFallbackUsed: false,
    }
}

async function removeIfExists(file: OutputFileRef): Promise<void> {
    if (await exists(file.path, optionsFor(file))) await remove(file.path, optionsFor(file))
}

abstract class TauriOutputPlatformAdapter implements OutputPlatformAdapter {
    abstract readonly capabilities: OutputPlatformCapabilities

    abstract resolveDirectory(request: OutputDestinationRequest): Promise<ResolvedOutputDirectory>

    async ensureDirectory(directory: OutputFileRef): Promise<void> {
        if (!await exists(directory.path, optionsFor(directory))) {
            await mkdir(directory.path, { ...optionsFor(directory), recursive: true })
        }
    }

    exists(file: OutputFileRef): Promise<boolean> {
        return exists(file.path, optionsFor(file))
    }

    writeFile(file: OutputFileRef, bytes: Uint8Array): Promise<void> {
        return writeFile(file.path, bytes, optionsFor(file))
    }

    readFile(file: OutputFileRef): Promise<Uint8Array> {
        return readFile(file.path, optionsFor(file))
    }

    async readDirectoryEntries(directory: OutputFileRef): Promise<readonly string[]> {
        if (!await exists(directory.path, optionsFor(directory))) return []
        return (await readDir(directory.path, optionsFor(directory))).map(entry => entry.name)
    }

    rename(from: OutputFileRef, to: OutputFileRef): Promise<void> {
        return rename(from.path, to.path, {
            ...(from.baseDir === undefined ? {} : { oldPathBaseDir: from.baseDir }),
            ...(to.baseDir === undefined ? {} : { newPathBaseDir: to.baseDir }),
        })
    }

    async commitSiblingIfAbsent(
        from: OutputFileRef,
        to: OutputFileRef,
    ): Promise<OutputCommitIfAbsentResult> {
        const status = await commitNativeSiblingIfAbsent(
            await absoluteOutputPath(from),
            await absoluteOutputPath(to),
        )
        return { status }
    }

    remove(file: OutputFileRef): Promise<void> {
        return remove(file.path, optionsFor(file))
    }

    private journalRef(transactionId: string, directory = JOURNAL_DIRECTORY): OutputFileRef {
        const fileName = `${transactionId}${JOURNAL_SUFFIX}`
        return {
            path: `${directory}/${fileName}`,
            displayPath: `${directory}/${fileName}`,
            baseDir: BaseDirectory.AppData,
        }
    }

    private journalTempRef(transactionId: string): OutputFileRef {
        return {
            path: `${JOURNAL_DIRECTORY}/.${transactionId}.tmp`,
            displayPath: `${JOURNAL_DIRECTORY}/.${transactionId}.tmp`,
            baseDir: BaseDirectory.AppData,
        }
    }

    async writeJournal(transactionId: string, bytes: Uint8Array): Promise<void> {
        const journalDirectory: OutputFileRef = {
            path: JOURNAL_DIRECTORY,
            displayPath: JOURNAL_DIRECTORY,
            baseDir: BaseDirectory.AppData,
        }
        await this.ensureDirectory(journalDirectory)
        const temp = this.journalTempRef(transactionId)
        const final = this.journalRef(transactionId)
        await removeIfExists(temp)
        await writeFile(temp.path, bytes, { baseDir: BaseDirectory.AppData })
        await rename(temp.path, final.path, {
            oldPathBaseDir: BaseDirectory.AppData,
            newPathBaseDir: BaseDirectory.AppData,
        })
    }

    async readJournal(transactionId: string): Promise<Uint8Array | null> {
        const file = this.journalRef(transactionId)
        return await exists(file.path, { baseDir: BaseDirectory.AppData })
            ? readFile(file.path, { baseDir: BaseDirectory.AppData })
            : null
    }

    async removeJournal(transactionId: string): Promise<void> {
        await removeIfExists(this.journalRef(transactionId))
        await removeIfExists(this.journalTempRef(transactionId))
    }

    async listJournalIds(): Promise<string[]> {
        const ids = new Set<string>()
        if (await exists(JOURNAL_DIRECTORY, { baseDir: BaseDirectory.AppData })) {
            const entries = await readDir(JOURNAL_DIRECTORY, { baseDir: BaseDirectory.AppData })
            for (const entry of entries) {
                if (entry.isFile && entry.name.endsWith(JOURNAL_SUFFIX)) {
                    ids.add(entry.name.slice(0, -JOURNAL_SUFFIX.length))
                }
            }
        }
        return [...ids].sort()
    }
}

export class DesktopOutputPlatformAdapter extends TauriOutputPlatformAdapter {
    readonly capabilities: OutputPlatformCapabilities

    constructor(
        private readonly runtime: RuntimeCapabilities = createRuntimeCapabilities('desktop'),
        private readonly tokenRegistry: PlatformTokenRegistry = runtimePortablePathTokenRegistry,
    ) {
        super()
        this.capabilities = {
            absolutePaths: runtime.absoluteOutputPath.supported,
            atomicSiblingRename: true,
            outputReservationGuarantee: runtime.generationPublication.outputReservationGuarantee,
            runtime: 'desktop',
        }
    }

    async resolveDirectory(request: OutputDestinationRequest): Promise<ResolvedOutputDirectory> {
        if (request.portableDirectory !== undefined) {
            const directory = await resolvePortableOutputDirectory(request.portableDirectory, this.runtime, this.tokenRegistry)
            if (isAbsoluteLike(directory.path)) await authorizeNativeDirectory(directory.path)
            return directory
        }
        const requested = request.directory?.trim() || request.workflowDefaultDirectory
        if (request.useAbsolutePath && isAbsoluteLike(requested)) {
            await authorizeNativeDirectory(requested)
            return {
                path: requested,
                displayPath: requested,
                capabilityFallbackUsed: false,
            }
        }

        const relative = sanitizeRelativeOutputDirectory(requested, request.workflowDefaultDirectory)
        return {
            path: relative,
            displayPath: await join(await getMediaStorageRoot(), ...relative.split('/')),
            baseDir: MEDIA_STORAGE_BASE_DIRECTORY,
            capabilityFallbackUsed: Boolean(request.useAbsolutePath),
        }
    }
}

export class AppScopedOutputPlatformAdapter extends TauriOutputPlatformAdapter {
    readonly capabilities: OutputPlatformCapabilities

    constructor(
        private readonly runtime: RuntimeCapabilities = createRuntimeCapabilities('android'),
        private readonly tokenRegistry: PlatformTokenRegistry = runtimePortablePathTokenRegistry,
    ) {
        super()
        this.capabilities = {
            absolutePaths: runtime.absoluteOutputPath.supported,
            atomicSiblingRename: true,
            outputReservationGuarantee: runtime.generationPublication.outputReservationGuarantee,
            runtime: 'app-scoped',
        }
    }

    async resolveDirectory(request: OutputDestinationRequest): Promise<ResolvedOutputDirectory> {
        if (request.portableDirectory !== undefined) {
            return resolvePortableOutputDirectory(request.portableDirectory, this.runtime, this.tokenRegistry)
        }
        const requested = request.directory?.trim() || request.workflowDefaultDirectory
        const mustFallback = Boolean(request.useAbsolutePath) || isAbsoluteLike(requested)
        const requestedFallback = request.capabilityFallbackDirectory?.trim()
        const safeFallback = requestedFallback && !isAbsoluteLike(requestedFallback)
            ? requestedFallback
            : request.workflowDefaultDirectory
        const selected = mustFallback
            ? safeFallback
            : requested
        const relative = sanitizeRelativeOutputDirectory(selected, request.workflowDefaultDirectory)
        return {
            path: relative,
            displayPath: await join(
                await resolveStorageBaseDirectoryRoot(BaseDirectory.AppData),
                ...relative.split('/'),
            ),
            baseDir: BaseDirectory.AppData,
            capabilityFallbackUsed: mustFallback,
            ...(mustFallback
                ? {
                    fallbackReason: this.runtime.absoluteOutputPath.reason,
                    fallbackAlternative: this.runtime.absoluteOutputPath.alternative,
                }
                : {}),
        }
    }
}

export function createRuntimeOutputPlatformAdapter(
    capabilities: RuntimeCapabilities = runtimeCapabilities,
): OutputPlatformAdapter {
    return capabilities.platform === 'android' || capabilities.platform === 'ios'
        ? new AppScopedOutputPlatformAdapter(capabilities)
        : new DesktopOutputPlatformAdapter(capabilities)
}
