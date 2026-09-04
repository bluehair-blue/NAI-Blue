import type { MetadataWriteRequest, OutputMetadataWriter } from './metadata-writer'
import { MetadataWriter } from './metadata-writer'
import type { PortablePathRef, PortablePathRoot } from '@/domain/composition/types'
import { getPortableStorageRoot } from '@/platform/storage'
import {
    ensureImageFileExtension,
    planExactOutputFileName,
    resolveCollisionFileName,
    toArtifactSidecarPath,
    toDiagnosticSidecarPath,
    toSidecarFileName,
    PRIVATE_ORIGINAL_DIRECTORY,
    type OutputCollisionPolicy,
    type PlannedOutputCollisionPolicy,
} from './filename-policy'
import type { OutputCommitSet, OutputPathClaimKind } from '@/domain/queue/types'
import { hashOutputCommitSet, parseOutputCommitSet } from '@/domain/output-commit-set'
import { generationOutputRelativePath, outputFilesystemSemantics } from './generation-output-commit-set'
import {
    childOutputRef,
    directoryIdentityForResolvedOutputDirectory as directoryIdentityForResolvedOutputDirectoryWithSemantics,
    serializeOutputFileRef,
    type OutputDestinationRequest,
    type OutputFileRef,
    type OutputPlatformAdapter,
    type ResolvedOutputDirectory,
} from './platform-adapter'
import { createRuntimeOutputPlatformAdapter } from './tauri-output-adapter'
import { reportDiagnostic } from '@/services/diagnostics/error-registry'
import { sha256Bytes } from '@/lib/binary-digest'
import { eradicateImageMetadata } from '@/lib/image-metadata-purge'
import { hashCanonicalValue } from '@/domain/composition/canonical-serialize'

export type OutputWriterPhase =
    | 'resolve-destination'
    | 'stage-temp-output'
    | 'write-image-temp'
    | 'write-metadata-temp'
    | 'generate-thumbnail-temp'
    | 'can-commit'
    | 'atomic-commit'
    | 'workflow-state-update'
    | 'rollback-cleanup'
    | 'recovery-journal'

export type RecoveryJournalPhase =
    | 'staged'
    | 'image-written'
    | 'metadata-written'
    | 'thumbnail-staged'
    | 'commit-pending'
    | 'files-committed'
    | 'workflow-committed'
    | 'rollback-required'

export interface OutputWriterDestination extends OutputDestinationRequest {
    fileName?: string | null
    extension: 'png' | 'webp'
    collisionPolicy?: OutputCollisionPolicy
}

export interface ExactOutputReservationIdentity {
    readonly reservationId: string
    readonly directoryIdentity: `sha256:${string}`
    readonly relativePath: string
    /** Present on every current reservation; absent only for legacy snapshots. */
    readonly commitSet?: OutputCommitSet
    readonly commitSetHash?: `sha256:${string}`
}

export interface ExactOutputPreflightRequest {
    readonly destination: OutputWriterDestination
    readonly fileName: string
    readonly reservation?: ExactOutputReservationIdentity
    readonly collisionPolicy?: PlannedOutputCollisionPolicy
    /** Exact permanent artifact kinds used while allocating a not-yet-bound commit set. */
    readonly claimKinds?: readonly OutputPathClaimKind[]
    /** Already planned siblings in the same batch; never persisted as path authority. */
    readonly additionalOccupiedFileNames?: readonly string[]
    /** Execution uses a reversible write/read/remove probe before Provider dispatch. */
    readonly probeWrite?: boolean
}

export interface ExactOutputPreflightResult {
    readonly fileName: string
    readonly directoryIdentity: `sha256:${string}`
    readonly availableSpaceCheck: 'unavailable'
    readonly foregroundSingleWriterOnly: true
    readonly crossProcessReservation: false
}

/**
 * Durable facts for the prepared image that Queue can turn into an ArtifactRecord.
 * The directory is projected to the portable composition contract, so neither a
 * display path nor an adapter-specific absolute path can cross this boundary.
 */
export interface OutputFinalImageFacts {
    contentChecksum: string
    byteSize: number
    portableDirectory?: PortablePathRef
}

export interface OutputWriteResult {
    transactionId: string
    fileName: string
    path: string
    file: OutputFileRef
    directory: ResolvedOutputDirectory
    sidecarPath?: string
    sidecarFile?: OutputFileRef
    diagnosticSidecarPath?: string
    artifactSidecarPath?: string
    /** Provider response before pixel/chunk purification; always stored under a scanner-excluded directory. */
    providerOriginalPath?: string
    providerOriginalFile?: OutputFileRef
    /** SHA-256 of the exact final image bytes, after any metadata preparation. */
    contentChecksum?: string
    /** Opt-in durable facts for Queue/ArtifactRecord linkage and retry recovery. */
    finalImage?: OutputFinalImageFacts
    thumbnailDataUrl?: string
    capabilityFallbackUsed: boolean
    capabilityFallbackReason?: string
    capabilityFallbackAlternative?: string
}

export interface OutputWriterRequest {
    /** Pre-bound by durable queue before any file is staged. */
    transactionId?: string
    /** Stable queue linkage only; never contains prompt or credential material. */
    sourceJobId?: string
    /** Queue-owned exact destination. Legacy direct writes leave this absent. */
    outputReservation?: ExactOutputReservationIdentity
    destination: OutputWriterDestination
    imageBytes: Uint8Array
    imageDataUrl: string
    metadata?: MetadataWriteRequest
    /** Pre-encoded sibling metadata sidecar for non-generation image workflows. */
    metadataSidecarBytes?: Uint8Array
    /**
     * A non-generation artifact sidecar written in the same journaled
     * transaction as the image.  This is deliberately bytes-only so callers
     * cannot bypass OutputWriter with a direct file write.
     */
    artifactSidecarBytes?: Uint8Array
    /**
     * Queue opts in when it needs an ArtifactRecord-ready final image reference.
     * Existing output callers avoid the extra digest and keep their result shape.
     */
    includeFinalImageFacts?: boolean
    /** Retain the provider response until the release coordinator explicitly discards it. */
    preserveProviderOriginal?: boolean
    generateThumbnail?: (imageDataUrl: string) => Promise<string>
    canCommit: () => boolean
    commitWorkflow: (result: OutputWriteResult) => void | Promise<void>
    rollbackWorkflow?: (result: OutputWriteResult, cause: unknown) => void | Promise<void>
    /**
     * The workflow callback commits an immutable durable authority. Once it
     * succeeds, journal cleanup may be retried but files must never roll back.
     */
    terminalWorkflowCommit?: boolean
    onPhase?: (phase: OutputWriterPhase) => void
}

export type OutputWriterOutcome =
    | { status: 'committed'; result: OutputWriteResult }
    | { status: 'cancelled' }

interface JournalArtifact {
    kind: 'image' | 'sidecar' | 'diagnostic' | 'artifact-sidecar' | 'provider-original'
    temp: OutputFileRef
    final: OutputFileRef
    backup?: OutputFileRef
    committed: boolean
}

interface OutputRecoveryJournal {
    format: 'nai-blue-output-transaction'
    version: 1
    transactionId: string
    sourceJobId?: string
    outputReservation?: ExactOutputReservationIdentity
    createdAt: string
    updatedAt: string
    phase: RecoveryJournalPhase
    fileName: string
    contentChecksum?: string
    finalImage?: OutputFinalImageFacts
    directory: ResolvedOutputDirectory
    artifacts: JournalArtifact[]
    thumbnailStaged: boolean
    commitStarted: boolean
}

export interface OutputRecoveryResult {
    transactionId: string
    action: 'rolled-back' | 'retried' | 'cleaned' | 'missing' | 'ineligible' | 'failed'
    ineligibility?: 'source-job-mismatch' | 'phase-not-files-committed' | 'reservation-mismatch'
    error?: string
}

export interface PendingQueueOutputTransaction {
    transactionId: string
    sourceJobId: string
    phase: RecoveryJournalPhase
    outputReservation?: ExactOutputReservationIdentity
}

export interface RetryRecoveryOptions {
    mode?: 'rollback' | 'retry-workflow'
    canCommit?: () => boolean
    commitWorkflow?: (result: OutputWriteResult) => void | Promise<void>
}

export class OutputWriterError extends Error {
    /** Queue and other outer boundaries reuse this event instead of notifying twice. */
    diagnosticEventId?: string

    constructor(
        readonly phase: OutputWriterPhase,
        message: string,
        options?: { cause?: unknown },
    ) {
        super(message)
        this.name = 'OutputWriterError'
        if (options?.cause !== undefined) {
            ;(this as Error & { cause?: unknown }).cause = options.cause instanceof Error
                ? options.cause
                : new Error(String(options.cause))
        }
    }
}

/**
 * Links the transaction failure to the cleanup failure using the standard Error.cause chain.
 * Diagnostics depend on that linear chain, so preserving both failures here explains why a
 * recovery journal remains without logging raw platform values or weakening rollback safety.
 */
function rollbackFailureCause(transactionError: unknown, cleanupError: unknown): Error {
    const transactionCause = transactionError instanceof Error
        ? transactionError
        : new Error(`Output transaction failed: ${String(transactionError)}`)
    const cleanupCause = cleanupError instanceof Error
        ? cleanupError
        : new Error(`Output rollback cleanup failed: ${String(cleanupError)}`)
    const linked = new Error(`Rollback cleanup failed: ${cleanupCause.message}`) as Error & { cause?: unknown }
    linked.name = 'OutputRollbackCleanupError'
    linked.cause = transactionCause
    return linked
}

function randomTransactionId(): string {
    const uuid = globalThis.crypto?.randomUUID?.()
    return (uuid ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9-]/g, '')
}

function tempName(
    fileName: string,
    transactionId: string,
    kind: JournalArtifact['kind'],
    compact: boolean,
): string {
    if (compact) {
        const shortHash = hashCanonicalValue({ transactionId, kind }).slice(0, 16)
        return `.nai-blue-txn-${shortHash}-${kind}.tmp`
    }
    return `.${fileName}.nai-blue-txn-${transactionId}.${kind}.tmp`
}

function backupName(fileName: string, transactionId: string): string {
    return `.${fileName}.nai-blue-txn-${transactionId}.backup`
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const CHECKSUM_PATTERN = /^sha256:[a-f0-9]{64}$/i
const PORTABLE_ROOTS: readonly PortablePathRoot[] = [
    'app-data', 'documents', 'pictures', 'downloads', 'media', 'cache',
]
const PORTABLE_BOOKMARK_PATTERN = /^[A-Za-z0-9:_-]{1,256}$/

function isSafePortableSegment(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= 255
        && value !== '.'
        && value !== '..'
        && !/[\\/\0]/.test(value)
}

/**
 * Output adapters materialize paths for I/O, while queue recovery persists only
 * composition portable references. Projecting here keeps the journal/result
 * usable by ArtifactRecord without retaining display paths, extension payloads,
 * or platform-specific tokens that the adapter already owns.
 */
function projectPortableDirectory(value: unknown): PortablePathRef {
    if (!isRecord(value) || !Array.isArray(value.segments)
        || value.segments.length > 256
        || !value.segments.every(isSafePortableSegment)) {
        throw new Error('Invalid portable output directory')
    }
    const segments = [...value.segments]
    if (value.kind === 'standard') {
        if (typeof value.root !== 'string' || !PORTABLE_ROOTS.includes(value.root as PortablePathRoot)) {
            throw new Error('Invalid standard output directory root')
        }
        return {
            kind: 'standard',
            root: value.root as PortablePathRoot,
            segments,
        }
    }
    if (value.kind === 'bookmark') {
        if (typeof value.bookmarkId !== 'string' || !PORTABLE_BOOKMARK_PATTERN.test(value.bookmarkId)) {
            throw new Error('Invalid bookmarked output directory')
        }
        return {
            kind: 'bookmark',
            bookmarkId: value.bookmarkId,
            segments,
        }
    }
    throw new Error('Invalid portable output directory kind')
}

function isAbsoluteOutputPath(value: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{1,2}/.test(value)
}

function projectDirectoryPath(path: string): string[] {
    if (isAbsoluteOutputPath(path)) throw new Error('Absolute output directories are not portable')
    const segments = path === '.' ? [] : path.split(/[\\/]+/)
    if (!segments.every(isSafePortableSegment)) throw new Error('Output directory contains unsafe path segments')
    return segments
}

function portableDirectoryForFinalImage(
    destination: OutputWriterDestination,
    directory: ResolvedOutputDirectory,
): PortablePathRef | undefined {
    if (destination.portableDirectory !== undefined) return projectPortableDirectory(destination.portableDirectory)
    if (isAbsoluteOutputPath(directory.path)) return undefined
    const root = getPortableStorageRoot(directory.baseDir)
    if (root === undefined) {
        throw new Error('Final image facts require a portable destination or a known standard output root')
    }
    return {
        kind: 'standard',
        root,
        segments: projectDirectoryPath(directory.path),
    }
}

function parseReservationIdentity(value: unknown): ExactOutputReservationIdentity {
    if (!isRecord(value)
        || typeof value.reservationId !== 'string'
        || value.reservationId.length === 0
        || value.reservationId.length > 256
        || typeof value.directoryIdentity !== 'string'
        || !/^sha256:[a-f0-9]{64}$/.test(value.directoryIdentity)
        || typeof value.relativePath !== 'string'
        || value.relativePath.length === 0
        || value.relativePath.length > 1_024
        || ((value.commitSet === undefined) !== (value.commitSetHash === undefined))) {
        throw new Error('Invalid output recovery reservation identity')
    }
    if (value.commitSet === undefined) {
        return {
            reservationId: value.reservationId,
            directoryIdentity: value.directoryIdentity as `sha256:${string}`,
            relativePath: value.relativePath,
        }
    }
    const commitSet = parseOutputCommitSet(value.commitSet)
    if (value.commitSetHash !== hashOutputCommitSet(commitSet)
        || commitSet.directoryAuthorityFingerprint !== value.directoryIdentity
        || !commitSet.claims.some(claim => claim.kind === 'image' && claim.relativePath === value.relativePath)) {
        throw new Error('Invalid output recovery reservation commit set')
    }
    return {
        reservationId: value.reservationId,
        directoryIdentity: value.directoryIdentity as `sha256:${string}`,
        relativePath: value.relativePath,
        commitSet,
        commitSetHash: value.commitSetHash as `sha256:${string}`,
    }
}

function artifactClaimKind(kind: JournalArtifact['kind']): OutputPathClaimKind {
    if (kind === 'sidecar') return 'metadata-sidecar'
    if (kind === 'diagnostic') return 'diagnostic-sidecar'
    return kind
}

function assertArtifactsMatchCommitSet(
    identity: ExactOutputReservationIdentity,
    artifacts: readonly JournalArtifact[],
    fileName: string,
): void {
    if (identity.commitSet === undefined) return
    const expected = identity.commitSet.claims
        .map(claim => `${claim.kind}\u0000${claim.relativePath}`)
        .sort()
    const actual = artifacts
        .map(artifact => {
            const kind = artifactClaimKind(artifact.kind)
            return `${kind}\u0000${generationOutputRelativePath(kind, fileName)}`
        })
        .sort()
    if (expected.length !== actual.length || expected.some((claim, index) => claim !== actual[index])) {
        throw new OutputWriterError('resolve-destination', 'Output transaction artifacts do not match the reserved commit set')
    }
}

function sameReservationIdentity(
    left: ExactOutputReservationIdentity,
    right: ExactOutputReservationIdentity,
): boolean {
    return left.reservationId === right.reservationId
        && left.directoryIdentity === right.directoryIdentity
        && left.relativePath === right.relativePath
        && left.commitSetHash === right.commitSetHash
}

/** Compatibility export defaults to the current runtime filesystem semantics. */
export function directoryIdentityForResolvedOutputDirectory(
    directory: ResolvedOutputDirectory,
    filesystemSemantics = outputFilesystemSemantics(),
): `sha256:${string}` {
    return directoryIdentityForResolvedOutputDirectoryWithSemantics(directory, filesystemSemantics)
}

function parseFinalImageFacts(value: unknown): OutputFinalImageFacts {
    if (!isRecord(value)
        || typeof value.contentChecksum !== 'string'
        || !CHECKSUM_PATTERN.test(value.contentChecksum)
        || typeof value.byteSize !== 'number'
        || !Number.isSafeInteger(value.byteSize)
        || value.byteSize < 0) {
        throw new Error('Invalid output recovery final image facts')
    }
    return {
        contentChecksum: value.contentChecksum,
        byteSize: value.byteSize,
        ...(value.portableDirectory === undefined
            ? {}
            : { portableDirectory: projectPortableDirectory(value.portableDirectory) }),
    }
}

function parseFileRef(value: unknown): OutputFileRef {
    if (!isRecord(value) || typeof value.path !== 'string' || typeof value.displayPath !== 'string') {
        throw new Error('Invalid output journal file reference')
    }
    return {
        path: value.path,
        displayPath: value.displayPath,
        ...(typeof value.baseDir === 'number' ? { baseDir: value.baseDir } : {}),
    }
}

function parseJournal(bytes: Uint8Array): OutputRecoveryJournal {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown
    if (!isRecord(value)
        || value.format !== 'nai-blue-output-transaction'
        || value.version !== 1
        || typeof value.transactionId !== 'string'
        || typeof value.createdAt !== 'string'
        || typeof value.updatedAt !== 'string'
        || typeof value.fileName !== 'string'
        || (value.sourceJobId !== undefined
            && (typeof value.sourceJobId !== 'string'
                || value.sourceJobId.length === 0
                || value.sourceJobId.length > 256))
        || !Array.isArray(value.artifacts)
        || !isRecord(value.directory)) {
        throw new Error('Invalid output recovery journal')
    }
    const outputReservation = value.outputReservation === undefined
        ? undefined
        : parseReservationIdentity(value.outputReservation)
    const allowedPhases: RecoveryJournalPhase[] = [
        'staged', 'image-written', 'metadata-written', 'thumbnail-staged',
        'commit-pending', 'files-committed', 'workflow-committed', 'rollback-required',
    ]
    if (!allowedPhases.includes(value.phase as RecoveryJournalPhase)) {
        throw new Error('Invalid output recovery journal phase')
    }
    const directoryRef = parseFileRef(value.directory)
    const directory: ResolvedOutputDirectory = {
        ...directoryRef,
        capabilityFallbackUsed: value.directory.capabilityFallbackUsed === true,
        ...(typeof value.directory.fallbackReason === 'string'
            ? { fallbackReason: value.directory.fallbackReason }
            : {}),
        ...(typeof value.directory.fallbackAlternative === 'string'
            ? { fallbackAlternative: value.directory.fallbackAlternative }
            : {}),
    }
    const artifacts = value.artifacts.map(entry => {
        if (!isRecord(entry)
            || (entry.kind !== 'image'
                && entry.kind !== 'sidecar'
                && entry.kind !== 'diagnostic'
                && entry.kind !== 'artifact-sidecar'
                && entry.kind !== 'provider-original')) {
            throw new Error('Invalid output recovery journal artifact')
        }
        return {
            kind: entry.kind,
            temp: parseFileRef(entry.temp),
            final: parseFileRef(entry.final),
            ...(entry.backup === undefined ? {} : { backup: parseFileRef(entry.backup) }),
            committed: entry.committed === true,
        } satisfies JournalArtifact
    })
    return {
        format: 'nai-blue-output-transaction',
        version: 1,
        transactionId: value.transactionId,
        ...(typeof value.sourceJobId === 'string' ? { sourceJobId: value.sourceJobId } : {}),
        ...(outputReservation === undefined
            ? {}
            : { outputReservation }),
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
        phase: value.phase as RecoveryJournalPhase,
        fileName: value.fileName,
        ...(typeof value.contentChecksum === 'string' && /^sha256:[a-f0-9]{64}$/i.test(value.contentChecksum)
            ? { contentChecksum: value.contentChecksum }
            : {}),
        ...(value.finalImage === undefined ? {} : { finalImage: parseFinalImageFacts(value.finalImage) }),
        directory,
        artifacts,
        thumbnailStaged: value.thumbnailStaged === true,
        commitStarted: value.commitStarted === true,
    }
}

function resultFromJournal(journal: OutputRecoveryJournal): OutputWriteResult {
    const image = journal.artifacts.find(artifact => artifact.kind === 'image')
    if (image === undefined) throw new Error('Recovery journal has no image artifact')
    const sidecar = journal.artifacts.find(artifact => artifact.kind === 'sidecar')
    const diagnostic = journal.artifacts.find(artifact => artifact.kind === 'diagnostic')
    const artifactSidecar = journal.artifacts.find(artifact => artifact.kind === 'artifact-sidecar')
    const providerOriginal = journal.artifacts.find(artifact => artifact.kind === 'provider-original')
    return {
        transactionId: journal.transactionId,
        fileName: journal.fileName,
        path: image.final.displayPath,
        file: image.final,
        directory: journal.directory,
        ...(sidecar === undefined
            ? {}
            : { sidecarPath: sidecar.final.displayPath, sidecarFile: sidecar.final }),
        ...(diagnostic === undefined ? {} : { diagnosticSidecarPath: diagnostic.final.displayPath }),
        ...(artifactSidecar === undefined ? {} : { artifactSidecarPath: artifactSidecar.final.displayPath }),
        ...(providerOriginal === undefined
            ? {}
            : {
                providerOriginalPath: providerOriginal.final.displayPath,
                providerOriginalFile: providerOriginal.final,
            }),
        ...(journal.contentChecksum === undefined ? {} : { contentChecksum: journal.contentChecksum }),
        ...(journal.finalImage === undefined ? {} : { finalImage: journal.finalImage }),
        capabilityFallbackUsed: journal.directory.capabilityFallbackUsed,
        ...(journal.directory.fallbackReason === undefined
            ? {}
            : { capabilityFallbackReason: journal.directory.fallbackReason }),
        ...(journal.directory.fallbackAlternative === undefined
            ? {}
            : { capabilityFallbackAlternative: journal.directory.fallbackAlternative }),
    }
}

export class OutputWriter {
    private readonly outputNameReservations = new Map<string, Promise<void>>()

    constructor(
        private readonly platform: OutputPlatformAdapter,
        private readonly metadataWriter: OutputMetadataWriter = new MetadataWriter(),
        private readonly createTransactionId: () => string = randomTransactionId,
        private readonly now: () => Date = () => new Date(),
        private readonly purgeImageMetadata: typeof eradicateImageMetadata = eradicateImageMetadata,
    ) {}

    private async persistJournal(journal: OutputRecoveryJournal): Promise<void> {
        journal.updatedAt = this.now().toISOString()
        await this.platform.writeJournal(
            journal.transactionId,
            new TextEncoder().encode(JSON.stringify(journal, null, 2)),
        )
    }

    private async safeRemove(file: OutputFileRef): Promise<void> {
        if (await this.platform.exists(file)) await this.platform.remove(file)
    }

    private async rollbackArtifacts(journal: OutputRecoveryJournal): Promise<void> {
        const failures: unknown[] = []
        for (const artifact of [...journal.artifacts].reverse()) {
            try {
                // Capture this before cleanup: a missing temp after commit start
                // can mean rename succeeded before its journal update, while an
                // existing temp proves a late final belongs to another writer.
                const tempExisted = await this.platform.exists(artifact.temp)
                await this.safeRemove(artifact.temp)
                if (artifact.backup !== undefined) {
                    if (await this.platform.exists(artifact.backup)) {
                        await this.safeRemove(artifact.final)
                        await this.platform.rename(artifact.backup, artifact.final)
                    }
                } else if (journal.commitStarted && (artifact.committed || !tempExisted)) {
                    await this.safeRemove(artifact.final)
                }
            } catch (error) {
                failures.push(error)
            }
        }
        if (failures.length > 0) {
            const error = new Error('Output rollback did not finish') as Error & { causes?: unknown[] }
            error.causes = failures
            throw error
        }
    }

    private async cleanupCompleted(journal: OutputRecoveryJournal): Promise<void> {
        for (const artifact of journal.artifacts) {
            await this.safeRemove(artifact.temp)
            if (artifact.backup !== undefined) await this.safeRemove(artifact.backup)
        }
        await this.platform.removeJournal(journal.transactionId)
    }

    private async cancelStaged(journal: OutputRecoveryJournal): Promise<OutputWriterOutcome> {
        try {
            await this.rollbackArtifacts(journal)
            await this.platform.removeJournal(journal.transactionId)
        } catch (error) {
            journal.phase = 'rollback-required'
            try { await this.persistJournal(journal) } catch { /* retain the last durable journal */ }
            throw new OutputWriterError('rollback-cleanup', 'Cancelled output cleanup failed', { cause: error })
        }
        return { status: 'cancelled' }
    }

    /** Snapshots journal-owned final paths once so planning sees interrupted publications. */
    async listPendingFinalOutputRefs(): Promise<readonly OutputFileRef[]> {
        const journalIds = await this.platform.listJournalIds()
        const journals = await Promise.all(journalIds.map(async journalId => {
            const bytes = await this.platform.readJournal(journalId)
            return bytes === null ? null : parseJournal(bytes)
        }))
        return journals.flatMap(journal => journal?.artifacts.map(artifact => artifact.final) ?? [])
    }

    /**
     * Resolves the adapter-owned directory without persisting its path, checks
     * every derived final name, and optionally proves write access with a
     * reversible probe. The adapter has no trustworthy free-space API, so that
     * capability is reported explicitly instead of guessed.
     */
    async preflightExactDestination(request: ExactOutputPreflightRequest): Promise<ExactOutputPreflightResult> {
        const directory = await this.platform.resolveDirectory(request.destination)
        await this.platform.ensureDirectory(directory)
        const requestedFileName = ensureImageFileExtension(request.fileName, request.destination.extension)
        if (requestedFileName === null || requestedFileName !== request.fileName) {
            throw new OutputWriterError('resolve-destination', 'Reserved output filename is not canonical')
        }
        const directoryIdentity = directoryIdentityForResolvedOutputDirectory(directory)
        const reservation = request.reservation === undefined
            ? undefined
            : parseReservationIdentity(request.reservation)
        if (request.reservation !== undefined && request.collisionPolicy === 'suffix') {
            throw new OutputWriterError('resolve-destination', 'A durable reservation cannot be re-suffixed')
        }
        if (reservation !== undefined && reservation.directoryIdentity !== directoryIdentity) {
            throw new OutputWriterError('resolve-destination', 'Reserved output destination no longer matches')
        }

        const journalIds = await this.platform.listJournalIds()
        const journals = (await Promise.all(journalIds.map(async journalId => {
            const bytes = await this.platform.readJournal(journalId)
            return bytes === null ? null : parseJournal(bytes)
        }))).filter((journal): journal is OutputRecoveryJournal => journal !== null)
        const candidateExists = async (candidate: string): Promise<boolean> => {
            if (request.additionalOccupiedFileNames?.some(name => (
                name.normalize('NFC').toLowerCase() === candidate.normalize('NFC').toLowerCase()
            ))) return true
            const kinds = reservation?.commitSet?.claims.map(claim => claim.kind)
                ?? request.claimKinds
                ?? ['image', 'metadata-sidecar', 'diagnostic-sidecar', 'artifact-sidecar', 'provider-original']
            const finals = kinds.map(kind => childOutputRef(
                directory,
                generationOutputRelativePath(kind, candidate),
            ))
            for (const final of finals) {
                if (await this.platform.exists(final)) return true
            }
            const finalPaths = new Set(finals.map(final => final.path.normalize('NFC').toLowerCase()))
            return journals.some(journal => (
                directoryIdentityForResolvedOutputDirectory(journal.directory) === directoryIdentity
                && journal.artifacts.some(artifact => finalPaths.has(artifact.final.path.normalize('NFC').toLowerCase()))
            ))
        }
        let fileName: string
        try {
            fileName = await planExactOutputFileName({
                requestedFileName,
                extension: request.destination.extension,
                collisionPolicy: request.collisionPolicy ?? 'fail',
                exists: candidateExists,
            })
        } catch (error) {
            throw new OutputWriterError('resolve-destination', 'Output destination is already occupied', { cause: error })
        }
        if (reservation !== undefined && reservation.relativePath !== fileName) {
            throw new OutputWriterError('resolve-destination', 'Reserved output destination no longer matches')
        }

        if (request.probeWrite === true) {
            const probeId = this.createTransactionId().replace(/[^A-Za-z0-9-]/g, '').slice(0, 128)
            const probe = childOutputRef(directory, `.nai-blue-preflight-${probeId || 'probe'}.tmp`)
            const probeBytes = new Uint8Array([0x4e, 0x41, 0x49, 0x36])
            try {
                if (await this.platform.exists(probe)) {
                    throw new Error('Output preflight probe is already present')
                }
                await this.platform.writeFile(probe, probeBytes)
                const readback = await this.platform.readFile(probe)
                if (readback.byteLength !== probeBytes.byteLength
                    || readback.some((byte, index) => byte !== probeBytes[index])) {
                    throw new Error('Output preflight probe readback mismatch')
                }
            } catch (error) {
                throw new OutputWriterError('resolve-destination', 'Output directory write probe failed', { cause: error })
            } finally {
                try {
                    if (await this.platform.exists(probe)) await this.platform.remove(probe)
                } catch {
                    // A preflight file has no durable transaction; preserve the
                    // primary error and let the next probe detect the residue.
                }
            }
        }

        return {
            fileName,
            directoryIdentity,
            availableSpaceCheck: 'unavailable',
            foregroundSingleWriterOnly: true,
            crossProcessReservation: false,
        }
    }

    async write(request: OutputWriterRequest): Promise<OutputWriterOutcome> {
        if (!request.canCommit()) return { status: 'cancelled' }
        if (request.outputReservation !== undefined) parseReservationIdentity(request.outputReservation)

        let phase: OutputWriterPhase = 'resolve-destination'
        let journal: OutputRecoveryJournal | null = null
        let releaseOutputName: (() => void) | null = null
        // A workflow persistence failure is not a file-system failure once file
        // compensation and journal removal finish. This flag lets the outer
        // transaction guard preserve that original error for the Queue boundary.
        let workflowFailureRolledBack = false
        const mark = (next: OutputWriterPhase): void => {
            phase = next
            request.onPhase?.(next)
        }

        try {
            mark('resolve-destination')
            const directory = await this.platform.resolveDirectory(request.destination)
            if (!request.canCommit()) return { status: 'cancelled' }
            await this.platform.ensureDirectory(directory)
            if (!request.canCommit()) return { status: 'cancelled' }

            const stripsImageMetadata = request.metadata?.metadataMode === 'strip-and-sidecar'
                || request.metadata?.metadataMode === 'strip-only'
            const preserveProviderOriginal = request.preserveProviderOriginal === true && stripsImageMetadata
            const privateOriginalDirectory = childOutputRef(directory, PRIVATE_ORIGINAL_DIRECTORY)
            if (preserveProviderOriginal) await this.platform.ensureDirectory(privateOriginalDirectory)
            if (!request.canCommit()) return { status: 'cancelled' }

            const fallback = `NAI_Blue_${this.now().getTime()}.${request.destination.extension}`
            const requestedFileName = ensureImageFileExtension(
                request.destination.fileName ?? fallback,
                request.destination.extension,
            ) ?? fallback
            const collisionPolicy = request.destination.collisionPolicy ?? 'unique'
            const directoryIdentity = directoryIdentityForResolvedOutputDirectory(directory)
            if (request.outputReservation !== undefined
                && (collisionPolicy !== 'error'
                    || request.outputReservation.directoryIdentity !== directoryIdentity
                    || request.outputReservation.relativePath !== requestedFileName)) {
                throw new OutputWriterError('resolve-destination', 'Output reservation does not match the write request')
            }
            const candidateExists = async (candidate: string): Promise<boolean> => {
                const reservationKey = `${directory.baseDir ?? 'absolute'}:${childOutputRef(directory, candidate).path}`
                if (this.outputNameReservations.has(reservationKey)) return true
                const imageExists = await this.platform.exists(childOutputRef(directory, candidate))
                if (imageExists) return true
                if (request.metadataSidecarBytes !== undefined) {
                    const explicitSidecarExists = await this.platform.exists(
                        childOutputRef(directory, toSidecarFileName(candidate)),
                    )
                    if (explicitSidecarExists) return true
                } else if (request.metadata !== undefined) {
                    const sidecarNeeded = request.metadata.metadataMode === 'sidecar-only'
                        || request.metadata.metadataMode === 'strip-and-sidecar'
                        || request.metadata.imageFormat === 'webp'
                    if (sidecarNeeded) {
                        const currentSidecarExists = await this.platform.exists(
                            childOutputRef(directory, toSidecarFileName(candidate)),
                        )
                        if (currentSidecarExists) return true
                    }
                }
                if (preserveProviderOriginal
                    && await this.platform.exists(childOutputRef(privateOriginalDirectory, candidate))) return true
                if (request.artifactSidecarBytes === undefined) return false
                const currentArtifactExists = await this.platform.exists(
                    childOutputRef(directory, toArtifactSidecarPath(candidate)),
                )
                return currentArtifactExists
            }
            let fileName = ''
            while (releaseOutputName === null) {
                const candidate = request.outputReservation === undefined
                    ? await resolveCollisionFileName(requestedFileName, collisionPolicy, candidateExists)
                    : requestedFileName
                const reservationKey = `${directory.baseDir ?? 'absolute'}:${childOutputRef(directory, candidate).path}`
                const activeReservation = this.outputNameReservations.get(reservationKey)
                if (activeReservation !== undefined) {
                    if (request.outputReservation !== undefined) {
                        throw new OutputWriterError('resolve-destination', 'Reserved output is already being written')
                    }
                    if (collisionPolicy !== 'unique') await activeReservation
                    continue
                }
                if (request.outputReservation !== undefined && await candidateExists(candidate)) {
                    throw new OutputWriterError('resolve-destination', `Output already exists: ${candidate}`)
                }

                let releaseReservation = (): void => undefined
                const reservation = new Promise<void>(resolve => {
                    releaseReservation = resolve
                })
                this.outputNameReservations.set(reservationKey, reservation)
                fileName = candidate
                releaseOutputName = () => {
                    if (this.outputNameReservations.get(reservationKey) === reservation) {
                        this.outputNameReservations.delete(reservationKey)
                    }
                    releaseReservation()
                }
            }
            const transactionId = request.transactionId ?? this.createTransactionId()
            if (!/^[A-Za-z0-9-]{1,128}$/.test(transactionId)) {
                throw new OutputWriterError(
                    'resolve-destination',
                    'Output transaction identity is not a safe bounded filename component',
                )
            }
            if (request.sourceJobId !== undefined
                && (request.sourceJobId.length === 0 || request.sourceJobId.length > 256)) {
                throw new OutputWriterError('resolve-destination', 'Source job identity is not bounded')
            }
            // Privacy modes depend on the pixel re-encoder to remove provider
            // chunks and stealth payloads before MetadataWriter optionally adds
            // the explicit NAI Blue sidecar. Centralizing here covers every workflow.
            const cleanImage = stripsImageMetadata
                ? await this.purgeImageMetadata(request.imageDataUrl, request.destination.extension)
                : null
            const preparedImageDataUrl = cleanImage?.dataUrl ?? request.imageDataUrl
            const prepared = this.metadataWriter.prepare(cleanImage?.bytes ?? request.imageBytes, request.metadata)
            if (request.metadataSidecarBytes !== undefined && prepared.sidecarBytes !== undefined) {
                throw new OutputWriterError('write-metadata-temp', 'Only one metadata sidecar source can be committed')
            }
            const metadataSidecarBytes = request.metadataSidecarBytes ?? prepared.sidecarBytes
            // Keep the established generation/output scheduling unchanged.
            // Organizer sidecars and Queue's ArtifactRecord recovery facts are
            // explicit callers, so ordinary output writes do not pay a digest.
            const includeFinalImageFacts = request.includeFinalImageFacts === true
            const contentChecksum = request.artifactSidecarBytes === undefined
                ? undefined
                : await sha256Bytes(prepared.imageBytes)
            const finalImageChecksum = includeFinalImageFacts
                ? contentChecksum ?? await sha256Bytes(prepared.imageBytes)
                : undefined
            const finalImagePortableDirectory = finalImageChecksum === undefined
                ? undefined
                : portableDirectoryForFinalImage(request.destination, directory)
            const finalImage = finalImageChecksum === undefined
                ? undefined
                : {
                    contentChecksum: finalImageChecksum,
                    byteSize: prepared.imageBytes.byteLength,
                    ...(finalImagePortableDirectory === undefined
                        ? {}
                        : {
                            portableDirectory: finalImagePortableDirectory,
                        }),
                } satisfies OutputFinalImageFacts
            const imageFinal = childOutputRef(directory, fileName)
            const compactTempNames = request.outputReservation !== undefined
            const artifacts: JournalArtifact[] = [{
                kind: 'image',
                temp: childOutputRef(directory, tempName(fileName, transactionId, 'image', compactTempNames)),
                final: imageFinal,
                committed: false,
            }]
            if (metadataSidecarBytes !== undefined) {
                const sidecarName = toSidecarFileName(fileName)
                artifacts.push({
                    kind: 'sidecar',
                    temp: childOutputRef(directory, tempName(sidecarName, transactionId, 'sidecar', compactTempNames)),
                    final: childOutputRef(directory, sidecarName),
                    committed: false,
                })
            }
            if (prepared.diagnosticSidecarBytes !== undefined) {
                const diagnosticName = toDiagnosticSidecarPath(fileName)
                artifacts.push({
                    kind: 'diagnostic',
                    temp: childOutputRef(directory, tempName(diagnosticName, transactionId, 'diagnostic', compactTempNames)),
                    final: childOutputRef(directory, diagnosticName),
                    committed: false,
                })
            }
            if (request.artifactSidecarBytes !== undefined) {
                const artifactSidecarName = toArtifactSidecarPath(fileName)
                artifacts.push({
                    kind: 'artifact-sidecar',
                    temp: childOutputRef(directory, tempName(artifactSidecarName, transactionId, 'artifact-sidecar', compactTempNames)),
                    final: childOutputRef(directory, artifactSidecarName),
                    committed: false,
                })
            }
            if (preserveProviderOriginal) {
                artifacts.push({
                    kind: 'provider-original',
                    temp: childOutputRef(privateOriginalDirectory, tempName(fileName, transactionId, 'provider-original', compactTempNames)),
                    final: childOutputRef(privateOriginalDirectory, fileName),
                    committed: false,
                })
            }
            if (request.outputReservation !== undefined) {
                assertArtifactsMatchCommitSet(request.outputReservation, artifacts, fileName)
            }

            mark('stage-temp-output')
            const timestamp = this.now().toISOString()
            journal = {
                format: 'nai-blue-output-transaction',
                version: 1,
                transactionId,
                ...(request.sourceJobId === undefined ? {} : { sourceJobId: request.sourceJobId }),
                ...(request.outputReservation === undefined
                    ? {}
                    : { outputReservation: request.outputReservation }),
                createdAt: timestamp,
                updatedAt: timestamp,
                phase: 'staged',
                fileName,
                ...(contentChecksum === undefined ? {} : { contentChecksum }),
                ...(finalImage === undefined ? {} : { finalImage }),
                directory: {
                    ...serializeOutputFileRef(directory),
                    capabilityFallbackUsed: directory.capabilityFallbackUsed,
                    ...(directory.fallbackReason === undefined
                        ? {}
                        : { fallbackReason: directory.fallbackReason }),
                    ...(directory.fallbackAlternative === undefined
                        ? {}
                        : { fallbackAlternative: directory.fallbackAlternative }),
                },
                artifacts,
                thumbnailStaged: false,
                commitStarted: false,
            }
            mark('recovery-journal')
            await this.persistJournal(journal)
            if (!request.canCommit()) return this.cancelStaged(journal)

            mark('write-image-temp')
            await this.platform.writeFile(artifacts[0].temp, prepared.imageBytes)
            journal.phase = 'image-written'
            await this.persistJournal(journal)
            if (!request.canCommit()) return this.cancelStaged(journal)

            mark('write-metadata-temp')
            const sidecarArtifact = artifacts.find(artifact => artifact.kind === 'sidecar')
            if (sidecarArtifact !== undefined && metadataSidecarBytes !== undefined) {
                await this.platform.writeFile(sidecarArtifact.temp, metadataSidecarBytes)
            }
            const diagnosticArtifact = artifacts.find(artifact => artifact.kind === 'diagnostic')
            if (diagnosticArtifact !== undefined && prepared.diagnosticSidecarBytes !== undefined) {
                await this.platform.writeFile(diagnosticArtifact.temp, prepared.diagnosticSidecarBytes)
            }
            const artifactSidecarArtifact = artifacts.find(artifact => artifact.kind === 'artifact-sidecar')
            if (artifactSidecarArtifact !== undefined && request.artifactSidecarBytes !== undefined) {
                await this.platform.writeFile(artifactSidecarArtifact.temp, request.artifactSidecarBytes)
            }
            const providerOriginalArtifact = artifacts.find(artifact => artifact.kind === 'provider-original')
            if (providerOriginalArtifact !== undefined) {
                await this.platform.writeFile(providerOriginalArtifact.temp, request.imageBytes)
            }
            journal.phase = 'metadata-written'
            await this.persistJournal(journal)
            if (!request.canCommit()) return this.cancelStaged(journal)

            mark('generate-thumbnail-temp')
            const thumbnailDataUrl = request.generateThumbnail === undefined
                ? undefined
                : await request.generateThumbnail(preparedImageDataUrl)
            journal.thumbnailStaged = thumbnailDataUrl !== undefined
            journal.phase = 'thumbnail-staged'
            await this.persistJournal(journal)

            mark('can-commit')
            if (!request.canCommit()) return this.cancelStaged(journal)

            journal.phase = 'commit-pending'
            journal.commitStarted = true
            for (const artifact of artifacts) {
                if (await this.platform.exists(artifact.final)) {
                    // A reviewed/reserved destination is fail-only at execution.
                    // Only the explicit legacy overwrite policy may displace an
                    // existing final; late external writers otherwise win and
                    // this transaction rolls its staged files back.
                    if (collisionPolicy !== 'overwrite') {
                        throw new OutputWriterError(
                            'atomic-commit',
                            `Output destination changed before commit: ${artifact.final.displayPath}`,
                        )
                    }
                    artifact.backup = childOutputRef(
                        artifact.kind === 'provider-original' ? privateOriginalDirectory : directory,
                        backupName(artifact.final.path.split(/[\\/]/).pop() ?? fileName, transactionId),
                    )
                }
            }
            await this.persistJournal(journal)

            mark('atomic-commit')
            for (const artifact of artifacts) {
                if (artifact.backup !== undefined) await this.platform.rename(artifact.final, artifact.backup)
            }
            // The image is renamed last: a visible final image means all required
            // metadata artifacts were already committed.
            const orderedArtifacts = [
                ...artifacts.filter(artifact => artifact.kind !== 'image'),
                ...artifacts.filter(artifact => artifact.kind === 'image'),
            ]
            for (const artifact of orderedArtifacts) {
                if (request.outputReservation !== undefined) {
                    const committed = await this.platform.commitSiblingIfAbsent(artifact.temp, artifact.final)
                    if (committed.status === 'destination-exists') {
                        throw new OutputWriterError(
                            'atomic-commit',
                            `Output destination changed before commit: ${artifact.final.displayPath}`,
                        )
                    }
                } else {
                    await this.platform.rename(artifact.temp, artifact.final)
                }
                artifact.committed = true
                await this.persistJournal(journal)
            }
            journal.phase = 'files-committed'
            await this.persistJournal(journal)
            if (!request.canCommit()) {
                await this.rollbackArtifacts(journal)
                await this.platform.removeJournal(journal.transactionId)
                journal = null
                return { status: 'cancelled' }
            }

            const result: OutputWriteResult = {
                transactionId,
                fileName,
                path: imageFinal.displayPath,
                file: imageFinal,
                directory,
                ...(sidecarArtifact === undefined
                    ? {}
                    : { sidecarPath: sidecarArtifact.final.displayPath, sidecarFile: sidecarArtifact.final }),
                ...(diagnosticArtifact === undefined
                    ? {}
                    : { diagnosticSidecarPath: diagnosticArtifact.final.displayPath }),
                ...(artifactSidecarArtifact === undefined
                    ? {}
                    : { artifactSidecarPath: artifactSidecarArtifact.final.displayPath }),
                ...(providerOriginalArtifact === undefined
                    ? {}
                    : {
                        providerOriginalPath: providerOriginalArtifact.final.displayPath,
                        providerOriginalFile: providerOriginalArtifact.final,
                    }),
                ...(contentChecksum === undefined ? {} : { contentChecksum }),
                ...(finalImage === undefined ? {} : { finalImage }),
                ...(thumbnailDataUrl === undefined ? {} : { thumbnailDataUrl }),
                capabilityFallbackUsed: directory.capabilityFallbackUsed,
                ...(directory.fallbackReason === undefined
                    ? {}
                    : { capabilityFallbackReason: directory.fallbackReason }),
                ...(directory.fallbackAlternative === undefined
                    ? {}
                    : { capabilityFallbackAlternative: directory.fallbackAlternative }),
            }

            mark('workflow-state-update')
            try {
                await request.commitWorkflow(result)
            } catch (error) {
                try { await request.rollbackWorkflow?.(result, error) } catch { /* journal remains authoritative */ }
                journal.phase = 'rollback-required'
                try { await this.persistJournal(journal) } catch { /* use previous durable state */ }
                mark('rollback-cleanup')
                await this.rollbackArtifacts(journal)
                await this.platform.removeJournal(journal.transactionId)
                journal = null
                workflowFailureRolledBack = true
                throw error
            }

            journal.phase = 'workflow-committed'
            try {
                await this.persistJournal(journal)
            } catch (error) {
                if (request.terminalWorkflowCommit === true) throw error
                try { await request.rollbackWorkflow?.(result, error) } catch { /* file rollback remains mandatory */ }
                journal.phase = 'rollback-required'
                try { await this.persistJournal(journal) } catch { /* previous files-committed journal remains */ }
                await this.rollbackArtifacts(journal)
                await this.platform.removeJournal(journal.transactionId)
                journal = null
                throw error
            }
            await this.cleanupCompleted(journal)
            return { status: 'committed', result }
        } catch (error) {
            if (workflowFailureRolledBack) throw error
            if (journal !== null && journal.phase !== 'workflow-committed') {
                try {
                    mark('rollback-cleanup')
                    await this.rollbackArtifacts(journal)
                    await this.platform.removeJournal(journal.transactionId)
                } catch (cleanupError) {
                    journal.phase = 'rollback-required'
                    try { await this.persistJournal(journal) } catch { /* retain earlier journal */ }
                    const rollbackError = new OutputWriterError('rollback-cleanup', 'Output failed and rollback is pending', {
                        cause: rollbackFailureCause(error, cleanupError),
                    })
                    rollbackError.diagnosticEventId = reportDiagnostic(rollbackError, {
                        operation: 'output.write',
                        stage: rollbackError.phase,
                    }).eventId
                    throw rollbackError
                }
            }
            const diagnosticError = error instanceof OutputWriterError
                ? error
                : new OutputWriterError(phase, `Output transaction failed during ${phase}`, { cause: error })
            diagnosticError.diagnosticEventId = reportDiagnostic(diagnosticError, {
                operation: 'output.write',
                stage: diagnosticError.phase,
            }).eventId
            throw diagnosticError
        } finally {
            releaseOutputName?.()
        }
    }

    async recoverTransaction(
        transactionId: string,
        options: RetryRecoveryOptions = {},
    ): Promise<OutputRecoveryResult> {
        try {
            const bytes = await this.platform.readJournal(transactionId)
            if (bytes === null) return { transactionId, action: 'missing' }
            const journal = parseJournal(bytes)

            if (journal.phase === 'workflow-committed') {
                await this.cleanupCompleted(journal)
                return { transactionId, action: 'cleaned' }
            }
            if (options.mode === 'retry-workflow'
                && journal.phase === 'files-committed'
                && options.commitWorkflow !== undefined
                && (options.canCommit?.() ?? true)) {
                await options.commitWorkflow(resultFromJournal(journal))
                journal.phase = 'workflow-committed'
                await this.persistJournal(journal)
                await this.cleanupCompleted(journal)
                return { transactionId, action: 'retried' }
            }

            await this.rollbackArtifacts(journal)
            await this.platform.removeJournal(transactionId)
            return { transactionId, action: 'rolled-back' }
        } catch (error) {
            const diagnostic = reportDiagnostic(error, {
                operation: 'output.recovery',
                stage: 'recover-transaction',
            })
            return {
                transactionId,
                action: 'failed',
                error: diagnostic.userSummary,
            }
        }
    }

    /**
     * Retries only the workflow half of one pre-bound Queue transaction. Unlike
     * generic recovery, a changed phase or owner is left untouched for its
     * current authority to reconcile.
     */
    async retryFilesCommittedWorkflow(
        transactionId: string,
        expectedSourceJobId: string,
        commitWorkflow: (result: OutputWriteResult) => void | Promise<void>,
        expectedReservation?: ExactOutputReservationIdentity,
    ): Promise<OutputRecoveryResult> {
        try {
            const bytes = await this.platform.readJournal(transactionId)
            if (bytes === null) return { transactionId, action: 'missing' }
            const journal = parseJournal(bytes)
            if (journal.sourceJobId !== expectedSourceJobId) {
                return { transactionId, action: 'ineligible', ineligibility: 'source-job-mismatch' }
            }
            if (expectedReservation !== undefined) parseReservationIdentity(expectedReservation)
            if ((expectedReservation === undefined) !== (journal.outputReservation === undefined)
                || (expectedReservation !== undefined
                    && (journal.outputReservation === undefined
                        || !sameReservationIdentity(journal.outputReservation, expectedReservation)))) {
                return { transactionId, action: 'ineligible', ineligibility: 'reservation-mismatch' }
            }
            if (journal.phase !== 'files-committed') {
                return { transactionId, action: 'ineligible', ineligibility: 'phase-not-files-committed' }
            }

            await commitWorkflow(resultFromJournal(journal))
            journal.phase = 'workflow-committed'
            await this.persistJournal(journal)
            await this.cleanupCompleted(journal)
            return { transactionId, action: 'retried' }
        } catch (error) {
            const diagnostic = reportDiagnostic(error, {
                operation: 'output.recovery',
                stage: 'retry-files-committed-workflow',
            })
            return { transactionId, action: 'failed', error: diagnostic.userSummary }
        }
    }

    async recoverPending(options: RetryRecoveryOptions = {}): Promise<OutputRecoveryResult[]> {
        const transactionIds = await this.platform.listJournalIds()
        const results: OutputRecoveryResult[] = []
        for (const transactionId of transactionIds) {
            results.push(await this.recoverTransaction(transactionId, options))
        }
        return results
    }

    async inspectPendingQueueTransactions(): Promise<PendingQueueOutputTransaction[]> {
        const transactionIds = await this.platform.listJournalIds()
        const result: PendingQueueOutputTransaction[] = []
        for (const transactionId of transactionIds) {
            const bytes = await this.platform.readJournal(transactionId)
            if (bytes === null) continue
            try {
                const journal = parseJournal(bytes)
                if (journal.sourceJobId !== undefined) {
                    result.push({
                        transactionId: journal.transactionId,
                        sourceJobId: journal.sourceJobId,
                        phase: journal.phase,
                        ...(journal.outputReservation === undefined
                            ? {}
                            : { outputReservation: journal.outputReservation }),
                    })
                }
            } catch {
                // Generic recovery owns malformed/orphan journals. Queue recovery
                // must not guess ownership from a filename or output path.
            }
        }
        return result.sort((left, right) => left.transactionId.localeCompare(right.transactionId))
    }
}

let runtimeWriter: OutputWriter | null = null

export function getRuntimeOutputWriter(): OutputWriter {
    runtimeWriter ??= new OutputWriter(createRuntimeOutputPlatformAdapter())
    return runtimeWriter
}

export function resetRuntimeOutputWriterForTests(): void {
    runtimeWriter = null
}
