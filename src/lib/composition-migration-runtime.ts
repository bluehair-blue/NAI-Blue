import { canonicalSerialize, hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import {
    COMPOSITION_MIGRATION_BACKUP_STORAGE_KEY,
    CompositionRepository,
    CompositionRepositoryError,
    compositionDocumentCounts,
    compositionDocumentHash,
    type CompositionAuthority,
    type CompositionMigrationMarker,
    type CompositionRepositoryStorage,
} from '@/domain/composition/repository'
import { safeParseCompositionDocument } from '@/domain/composition/schema'
import type { CompositionDocument, JsonValue, ResolutionIssue } from '@/domain/composition/types'
import { validateCompositionSemantics } from '@/domain/composition/validation'
import {
    migrateLegacyStoresToV2,
    type LegacyStoresMigrationInput,
    type LegacyStoresMigrationResult,
} from '@/domain/composition/migrations/legacy-stores-to-v2'
import type { MigrationReport } from '@/domain/composition/migrations/report-types'

export const RAW_MIGRATION_BACKUP_FORMAT = 'nai-blue-composition-raw-migration-backup' as const
export const RAW_MIGRATION_BACKUP_SCHEMA_VERSION = 1 as const
export const COMPOSITION_MIGRATION_POST_COMMIT_SOURCE_CHANGED = 'E_MIGRATION_POST_COMMIT_SOURCE_CHANGED' as const

let migrationLockSequence = 0

export type CompositionMigrationTransactionStep =
    | 'migration-lock'
    | 'raw-backup'
    | 'source-manifest'
    | 'dry-run'
    | 'fatal-check'
    | 'temp-write'
    | 'schema-reference-validation'
    | 'atomic-commit'
    | 'migration-marker'
    | 'post-commit-pre-finalize'
    | 'startup-reread'
    | 'temp-cleanup'

export interface CompositionMigrationSourceSnapshot {
    /** Exact serialized IndexedDB values, excluding Composition migration targets. */
    serializedStores: Record<string, string>
    wildcardContent: Record<string, string[]>
    assetProfileJson?: unknown
}

export interface RawCompositionMigrationBackupSnapshot {
    migrationId: string
    createdAt: string
    sourceHash: string
    sourceCounts: Record<string, number>
    serializedStores: Record<string, string>
    wildcardContent: Record<string, string[]>
    assetProfileJson?: JsonValue
    /** Detached migration artifacts needed to audit/rebuild non-document stores. */
    projection?: {
        documentHash: string
        targetCounts: Record<string, number>
        report: MigrationReport
        sidecars: LegacyStoresMigrationResult['sidecars']
    }
}

export interface RawCompositionMigrationBackupArchive {
    format: typeof RAW_MIGRATION_BACKUP_FORMAT
    schemaVersion: typeof RAW_MIGRATION_BACKUP_SCHEMA_VERSION
    snapshots: RawCompositionMigrationBackupSnapshot[]
}

/**
 * A compatibility projection may be written only after the v2 document has
 * committed and passed readback verification, but before startup verification
 * releases the migration lease.
 */
export interface CompositionMigrationPostCommitInput {
    migrationId: string
    source: CompositionMigrationSourceSnapshot
    sourceHash: string
    sourceCounts: Record<string, number>
    document: CompositionDocument
    documentHash: string
    report: MigrationReport
    sidecars: LegacyStoresMigrationResult['sidecars']
}

export interface RunCompositionMigrationOptions {
    repository: CompositionRepository
    storage: CompositionRepositoryStorage
    source: CompositionMigrationSourceSnapshot | (() => Promise<CompositionMigrationSourceSnapshot>)
    now: string
    owner: string
    registryVersion: number
    /** Runtime lease clock; tests may keep it fixed. */
    clock?: () => string
    migrate?: (input: LegacyStoresMigrationInput) => LegacyStoresMigrationResult
    postCommitBeforeFinalize?: (
        input: CompositionMigrationPostCommitInput,
    ) => void | Promise<void>
    onStep?: (step: CompositionMigrationTransactionStep) => void
}

export interface CompositionMigrationTransactionResult {
    status: 'committed' | 'already-current' | 'failed'
    migrationId: string
    authority: CompositionAuthority
    sourceHash: string
    sourceCounts: Record<string, number>
    report?: MigrationReport
    sidecars?: LegacyStoresMigrationResult['sidecars']
    validationIssues: ResolutionIssue[]
    marker?: CompositionMigrationMarker
    error?: string
    failureCode?: string
    oldSourcesRetained: true
    completedSteps: CompositionMigrationTransactionStep[]
}

function parseJsonOrRaw(value: string): unknown {
    try {
        return JSON.parse(value) as unknown
    } catch {
        return value
    }
}

function jsonClone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T
}

function jsonSafe(value: unknown): JsonValue | undefined {
    if (value === undefined) return undefined
    return JSON.parse(JSON.stringify(value)) as JsonValue
}

function topLevelCount(value: unknown): number {
    if (Array.isArray(value)) return value.length
    if (value !== null && typeof value === 'object') {
        const record = value as Record<string, unknown>
        if (record.state !== undefined) return topLevelCount(record.state)
        return Object.keys(record).length
    }
    return value === null || value === undefined ? 0 : 1
}

export function compositionMigrationSourceCounts(
    source: CompositionMigrationSourceSnapshot,
): Record<string, number> {
    const counts: Record<string, number> = {
        stores: Object.keys(source.serializedStores).length,
        wildcardContent: Object.keys(source.wildcardContent).length,
        assetProfileJson: source.assetProfileJson === undefined ? 0 : 1,
    }
    for (const [key, raw] of Object.entries(source.serializedStores).sort(([left], [right]) => (
        left < right ? -1 : left > right ? 1 : 0
    ))) {
        counts[`store:${key}`] = topLevelCount(parseJsonOrRaw(raw))
    }
    return counts
}

export function compositionMigrationSourceHash(source: CompositionMigrationSourceSnapshot): string {
    return `sha256:${hashCanonicalValue({
        serializedStores: source.serializedStores,
        wildcardContent: source.wildcardContent,
        ...(source.assetProfileJson === undefined ? {} : { assetProfileJson: source.assetProfileJson }),
    })}`
}

export function legacyMigrationInputFromSource(
    source: CompositionMigrationSourceSnapshot,
): LegacyStoresMigrationInput {
    const stores = Object.fromEntries(
        Object.entries(source.serializedStores).map(([key, value]) => [key, parseJsonOrRaw(value)]),
    )
    return {
        stores,
        indexedDbSnapshots: stores,
        ...(Object.keys(source.wildcardContent).length === 0
            ? {}
            : { fragmentContent: jsonClone(source.wildcardContent) }),
        ...(source.assetProfileJson === undefined
            ? {}
            : { assetProfileJson: jsonClone(source.assetProfileJson) }),
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseStringRecord(value: unknown, path: string): Record<string, string> {
    if (!isRecord(value)) throw new Error(`${path} must be an object`)
    const result: Record<string, string> = {}
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry !== 'string') throw new Error(`${path}.${key} must be a string`)
        result[key] = entry
    }
    return result
}

function parseWildcardContent(value: unknown, path: string): Record<string, string[]> {
    if (!isRecord(value)) throw new Error(`${path} must be an object`)
    const result: Record<string, string[]> = {}
    for (const [key, entry] of Object.entries(value)) {
        if (!Array.isArray(entry) || entry.some(line => typeof line !== 'string')) {
            throw new Error(`${path}.${key} must be a string array`)
        }
        result[key] = [...entry]
    }
    return result
}

function parseCountRecord(value: unknown, path: string): Record<string, number> {
    if (!isRecord(value)) throw new Error(`${path} must be an object`)
    const result: Record<string, number> = {}
    for (const [key, entry] of Object.entries(value)) {
        if (!Number.isInteger(entry) || (entry as number) < 0) {
            throw new Error(`${path}.${key} must be a non-negative integer`)
        }
        result[key] = entry as number
    }
    return result
}

function parseBackupSnapshot(
    value: unknown,
    path: string,
): RawCompositionMigrationBackupSnapshot {
    if (!isRecord(value)) throw new Error(`${path} must be an object`)
    if (typeof value.migrationId !== 'string' || value.migrationId.length === 0) {
        throw new Error(`${path}.migrationId must be a non-empty string`)
    }
    if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
        throw new Error(`${path}.createdAt must be a valid timestamp`)
    }
    if (typeof value.sourceHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value.sourceHash)) {
        throw new Error(`${path}.sourceHash must be a canonical SHA-256 digest`)
    }

    const snapshot: RawCompositionMigrationBackupSnapshot = {
        migrationId: value.migrationId,
        createdAt: value.createdAt,
        sourceHash: value.sourceHash,
        sourceCounts: parseCountRecord(value.sourceCounts, `${path}.sourceCounts`),
        serializedStores: parseStringRecord(value.serializedStores, `${path}.serializedStores`),
        wildcardContent: parseWildcardContent(value.wildcardContent, `${path}.wildcardContent`),
        ...(Object.prototype.hasOwnProperty.call(value, 'assetProfileJson')
            ? { assetProfileJson: value.assetProfileJson as JsonValue }
            : {}),
    }

    if (Object.prototype.hasOwnProperty.call(value, 'projection')) {
        if (!isRecord(value.projection)
            || typeof value.projection.documentHash !== 'string'
            || !isRecord(value.projection.report)
            || !isRecord(value.projection.sidecars)) {
            throw new Error(`${path}.projection is invalid`)
        }
        snapshot.projection = {
            documentHash: value.projection.documentHash,
            targetCounts: parseCountRecord(value.projection.targetCounts, `${path}.projection.targetCounts`),
            report: value.projection.report as unknown as MigrationReport,
            sidecars: value.projection.sidecars as unknown as LegacyStoresMigrationResult['sidecars'],
        }
    }
    return snapshot
}

function parseBackupArchive(raw: string | null): RawCompositionMigrationBackupArchive {
    if (raw === null) {
        return {
            format: RAW_MIGRATION_BACKUP_FORMAT,
            schemaVersion: RAW_MIGRATION_BACKUP_SCHEMA_VERSION,
            snapshots: [],
        }
    }
    const value = JSON.parse(raw) as unknown
    if (!isRecord(value)) {
        throw new Error('Raw migration backup archive must be an object')
    }
    if (value.format !== RAW_MIGRATION_BACKUP_FORMAT
        || value.schemaVersion !== RAW_MIGRATION_BACKUP_SCHEMA_VERSION
        || !Array.isArray(value.snapshots)) {
        throw new Error('Unsupported raw migration backup archive')
    }
    return {
        format: RAW_MIGRATION_BACKUP_FORMAT,
        schemaVersion: RAW_MIGRATION_BACKUP_SCHEMA_VERSION,
        snapshots: value.snapshots.map((snapshot, index) => (
            parseBackupSnapshot(snapshot, `Raw migration backup snapshots[${index}]`)
        )),
    }
}

function rawBackupSnapshotSource(
    snapshot: RawCompositionMigrationBackupSnapshot,
): CompositionMigrationSourceSnapshot {
    return {
        serializedStores: snapshot.serializedStores,
        wildcardContent: snapshot.wildcardContent,
        ...(Object.prototype.hasOwnProperty.call(snapshot, 'assetProfileJson')
            ? { assetProfileJson: snapshot.assetProfileJson }
            : {}),
    }
}

function rawBackupSnapshotExactlyMatches(
    candidate: RawCompositionMigrationBackupSnapshot,
    expected: RawCompositionMigrationBackupSnapshot,
): boolean {
    if (candidate.migrationId !== expected.migrationId
        || candidate.sourceHash !== expected.sourceHash) return false

    const candidateSource = rawBackupSnapshotSource(candidate)
    const expectedSource = rawBackupSnapshotSource(expected)
    const candidateCounts = compositionMigrationSourceCounts(candidateSource)
    return compositionMigrationSourceHash(candidateSource) === candidate.sourceHash
        && canonicalSerialize(candidateSource) === canonicalSerialize(expectedSource)
        && canonicalSerialize(candidate.sourceCounts) === canonicalSerialize(expected.sourceCounts)
        && canonicalSerialize(candidateCounts) === canonicalSerialize(candidate.sourceCounts)
}

async function verifiedStorageWrite(
    storage: CompositionRepositoryStorage,
    key: string,
    value: unknown,
): Promise<void> {
    const serialized = JSON.stringify(value)
    await storage.setItem(key, serialized)
    await storage.flush?.(key)
    if (await storage.getItem(key) !== serialized) {
        throw new Error(`Storage write/readback mismatch for ${key}`)
    }
}

export async function writeRawCompositionMigrationBackup(
    storage: CompositionRepositoryStorage,
    snapshot: RawCompositionMigrationBackupSnapshot,
): Promise<RawCompositionMigrationBackupArchive> {
    const validatedSnapshot = parseBackupSnapshot(snapshot, 'Raw migration backup snapshot')
    if (!rawBackupSnapshotExactlyMatches(validatedSnapshot, validatedSnapshot)) {
        throw new Error('Raw migration backup snapshot source hash/counts do not match its exact payload')
    }
    const archive = parseBackupArchive(await storage.getItem(COMPOSITION_MIGRATION_BACKUP_STORAGE_KEY))
    const existing = archive.snapshots.find(item => rawBackupSnapshotExactlyMatches(item, validatedSnapshot))
    if (existing !== undefined) return archive
    const next: RawCompositionMigrationBackupArchive = {
        ...archive,
        snapshots: [...archive.snapshots, jsonClone(validatedSnapshot)],
    }
    await verifiedStorageWrite(storage, COMPOSITION_MIGRATION_BACKUP_STORAGE_KEY, next)
    const verified = parseBackupArchive(await storage.getItem(COMPOSITION_MIGRATION_BACKUP_STORAGE_KEY))
    if (!verified.snapshots.some(item => rawBackupSnapshotExactlyMatches(item, validatedSnapshot))) {
        throw new Error('Raw migration backup write did not retain an exact source preimage')
    }
    return verified
}

async function attachMigrationProjectionToRawBackup(
    storage: CompositionRepositoryStorage,
    expectedSnapshot: RawCompositionMigrationBackupSnapshot,
    migrated: LegacyStoresMigrationResult,
): Promise<void> {
    const archive = parseBackupArchive(await storage.getItem(COMPOSITION_MIGRATION_BACKUP_STORAGE_KEY))
    const snapshotIndex = archive.snapshots.findIndex(item => (
        rawBackupSnapshotExactlyMatches(item, expectedSnapshot)
    ))
    if (snapshotIndex < 0) throw new Error('Raw migration backup snapshot disappeared before dry-run persistence')
    const snapshots = [...archive.snapshots]
    snapshots[snapshotIndex] = {
        ...snapshots[snapshotIndex],
        projection: {
            documentHash: compositionDocumentHash(migrated.document),
            targetCounts: compositionDocumentCounts(migrated.document),
            report: jsonClone(migrated.report),
            sidecars: jsonClone(migrated.sidecars),
        },
    }
    await verifiedStorageWrite(storage, COMPOSITION_MIGRATION_BACKUP_STORAGE_KEY, {
        ...archive,
        snapshots,
    })
}

function migrationIdFor(sourceHash: string, registryVersion: number): string {
    return `composition-migration:v${registryVersion}:${sourceHash.replace(/^sha256:/, '').slice(0, 24)}`
}

function uniqueMigrationLockId(owner: string, now: string, registryVersion: number): string {
    migrationLockSequence += 1
    const nonce = typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `${now}:${migrationLockSequence}`
    return `composition-migration:v${registryVersion}:lock:${owner}:${nonce}`
}

function resultBase(
    migrationId: string,
    sourceHash: string,
    sourceCounts: Record<string, number>,
    completedSteps: CompositionMigrationTransactionStep[],
    authority: CompositionAuthority = 'v2',
): Pick<
    CompositionMigrationTransactionResult,
    'migrationId' | 'authority' | 'sourceHash' | 'sourceCounts' | 'oldSourcesRetained' | 'completedSteps'
> {
    return {
        migrationId,
        authority,
        sourceHash,
        sourceCounts,
        oldSourcesRetained: true,
        completedSteps,
    }
}

async function assertMigrationSourceUnchanged(
    sourceInput: RunCompositionMigrationOptions['source'],
    expectedHash: string,
): Promise<void> {
    if (typeof sourceInput !== 'function') return
    const reread = await sourceInput()
    if (compositionMigrationSourceHash(reread) !== expectedHash) {
        throw new Error('Legacy migration source changed while the migration lock was held')
    }
}

class CompositionMigrationPostCommitSourceChangedError extends Error {
    readonly code = COMPOSITION_MIGRATION_POST_COMMIT_SOURCE_CHANGED

    constructor() {
        super('Composition post-commit compatibility projection changed the migration source')
        this.name = 'CompositionMigrationPostCommitSourceChangedError'
    }
}

async function migrationSourceMatches(
    sourceInput: RunCompositionMigrationOptions['source'],
    expectedHash: string,
): Promise<boolean> {
    if (typeof sourceInput !== 'function') return true
    return compositionMigrationSourceHash(await sourceInput()) === expectedHash
}

export async function runCompositionMigrationTransaction(
    options: RunCompositionMigrationOptions,
): Promise<CompositionMigrationTransactionResult> {
    const completedSteps: CompositionMigrationTransactionStep[] = []
    const complete = (step: CompositionMigrationTransactionStep): void => {
        completedSteps.push(step)
        options.onStep?.(step)
    }
    let sourceHash = 'sha256:unavailable'
    let sourceCounts: Record<string, number> = {}
    let migrationId = `composition-migration:v${options.registryVersion}:pending`
    const lockId = uniqueMigrationLockId(options.owner, options.now, options.registryVersion)
    let source: CompositionMigrationSourceSnapshot | undefined
    let report: MigrationReport | undefined
    let validationIssues: ResolutionIssue[] = []
    const operationNow = (): string => options.clock?.() ?? options.now
    const assertLeaseOwned = async (): Promise<void> => {
        const leaseNow = operationNow()
        const current = await options.repository.read(leaseNow)
        const expiresAt = current.migrationLock === undefined
            ? Number.NaN
            : Date.parse(current.migrationLock.expiresAt)
        const currentTime = Date.parse(leaseNow)
        if (current.migrationLock?.id !== lockId
            || !Number.isFinite(expiresAt)
            || !Number.isFinite(currentTime)
            || expiresAt <= currentTime) {
            throw new CompositionRepositoryError(
                'E_MIGRATION_LOCK_LOST',
                'Composition migration lock was lost before post-commit projection',
            )
        }
    }
    const runPostCommitBeforeFinalize = async (
        migrated: LegacyStoresMigrationResult,
        document: CompositionDocument,
        documentHash: string,
    ): Promise<void> => {
        if (options.postCommitBeforeFinalize === undefined || source === undefined || report === undefined) return
        await assertLeaseOwned()
        await options.postCommitBeforeFinalize({
            migrationId,
            source,
            sourceHash,
            sourceCounts,
            document,
            documentHash,
            report,
            sidecars: migrated.sidecars,
        })
        complete('post-commit-pre-finalize')
        if (!await migrationSourceMatches(options.source, sourceHash)) {
            throw new CompositionMigrationPostCommitSourceChangedError()
        }
    }

    try {
        await options.repository.acquireMigrationLock({
            id: lockId,
            owner: options.owner,
            now: options.now,
        })
        complete('migration-lock')

        source = typeof options.source === 'function'
            ? await options.source()
            : options.source
        sourceHash = compositionMigrationSourceHash(source)
        sourceCounts = compositionMigrationSourceCounts(source)
        migrationId = migrationIdFor(sourceHash, options.registryVersion)

        const rawBackupSnapshot: RawCompositionMigrationBackupSnapshot = {
            migrationId,
            createdAt: options.now,
            sourceHash,
            sourceCounts,
            serializedStores: jsonClone(source.serializedStores),
            wildcardContent: jsonClone(source.wildcardContent),
            ...(source.assetProfileJson === undefined
                ? {}
                : { assetProfileJson: jsonSafe(source.assetProfileJson)! }),
        }
        await writeRawCompositionMigrationBackup(options.storage, rawBackupSnapshot)
        complete('raw-backup')
        complete('source-manifest')

        const legacyInput = legacyMigrationInputFromSource(source)
        const migrated = (options.migrate ?? migrateLegacyStoresToV2)(legacyInput)
        report = migrated.report
        complete('dry-run')
        await attachMigrationProjectionToRawBackup(options.storage, rawBackupSnapshot, migrated)
        if (report.fatal || report.issues.some(issue => issue.severity === 'fatal')) {
            throw new Error('Migration dry-run reported fatal issues')
        }
        complete('fatal-check')

        const targetHash = compositionDocumentHash(migrated.document)
        const targetCounts = compositionDocumentCounts(migrated.document)
        const current = await options.repository.read(operationNow())
        if (current.committedHash === targetHash
            && current.migrationMarker?.sourceHash === sourceHash
            && current.migrationMarker.migrationId === migrationId
            && current.migrationMarker.registryVersion === options.registryVersion
            && hashCanonicalValue(current.migrationMarker.sourceCounts) === hashCanonicalValue(sourceCounts)
            && hashCanonicalValue(current.migrationMarker.targetCounts) === hashCanonicalValue(targetCounts)) {
            const parsedCurrent = safeParseCompositionDocument(current.committedDocument)
            if (!parsedCurrent.success) {
                throw new Error('Idempotent migration repository document failed schema validation')
            }
            validationIssues = validateCompositionSemantics(parsedCurrent.data)
            if (validationIssues.some(issue => issue.blocking)) {
                throw new Error('Idempotent migration repository document failed reference validation')
            }
            complete('schema-reference-validation')
            await assertMigrationSourceUnchanged(options.source, sourceHash)
            await runPostCommitBeforeFinalize(migrated, parsedCurrent.data, targetHash)
            const activated = await options.repository.finalizeCommittedMigration({
                lockId,
                migrationId,
                targetHash,
                now: operationNow(),
            })
            if (activated.committedHash !== targetHash) {
                throw new Error('Idempotent migration re-read hash mismatch')
            }
            complete('startup-reread')
            return {
                ...resultBase(migrationId, sourceHash, sourceCounts, completedSteps),
                status: 'already-current',
                report,
                sidecars: migrated.sidecars,
                validationIssues,
                marker: activated.migrationMarker,
            }
        }

        await options.repository.writeStagedDocument(lockId, migrationId, migrated.document, operationNow())
        complete('temp-write')

        const parsed = safeParseCompositionDocument(migrated.document)
        if (!parsed.success) {
            throw new Error(`Migrated CompositionDocument schema failed: ${parsed.issues[0]?.message ?? 'unknown'}`)
        }
        validationIssues = validateCompositionSemantics(parsed.data)
        if (validationIssues.some(issue => issue.blocking)) {
            throw new Error(`Migrated CompositionDocument references are invalid: ${validationIssues
                .filter(issue => issue.blocking)
                .map(issue => issue.code)
                .join(', ')}`)
        }
        complete('schema-reference-validation')

        await assertMigrationSourceUnchanged(options.source, sourceHash)

        const marker: CompositionMigrationMarker = {
            migrationId,
            registryVersion: options.registryVersion,
            sourceHash,
            sourceCounts,
            targetHash,
            targetCounts,
            reportHash: `sha256:${hashCanonicalValue(report)}`,
            committedAt: operationNow(),
        }
        await options.repository.commitStagedDocument({
            lockId,
            marker,
            now: operationNow(),
        })
        complete('atomic-commit')
        complete('migration-marker')

        const reread = await options.repository.read(operationNow())
        if (reread.committedHash !== targetHash
            || hashCanonicalValue(compositionDocumentCounts(reread.committedDocument!))
                !== hashCanonicalValue(targetCounts)) {
            throw new Error('Startup CompositionDocument count/hash verification failed')
        }
        await assertMigrationSourceUnchanged(options.source, sourceHash)
        await runPostCommitBeforeFinalize(migrated, parsed.data, targetHash)
        const verified = await options.repository.finalizeCommittedMigration({
            lockId,
            migrationId,
            targetHash,
            now: operationNow(),
        })
        complete('startup-reread')

        return {
            ...resultBase(migrationId, sourceHash, sourceCounts, completedSteps),
            status: 'committed',
            report,
            sidecars: migrated.sidecars,
            validationIssues,
            marker: verified.migrationMarker,
        }
    } catch (error) {
        let persistedAuthority: CompositionAuthority = 'legacy'
        try {
            let state = await options.repository.read(operationNow())
            if (state.migrationLock?.id === lockId) {
                await options.repository.abortMigration(lockId, operationNow())
                complete('temp-cleanup')
                state = await options.repository.read(operationNow())
            }
            persistedAuthority = state.authority
        } catch (cleanupError) {
            console.error('[CompositionMigration] Failed to clean temporary migration state:', cleanupError)
        }
        return {
            ...resultBase(migrationId, sourceHash, sourceCounts, completedSteps, persistedAuthority),
            status: 'failed',
            ...(report === undefined ? {} : { report }),
            validationIssues,
            error: error instanceof Error ? error.message : String(error),
            ...(error instanceof CompositionRepositoryError
                || error instanceof CompositionMigrationPostCommitSourceChangedError
                ? { failureCode: error.code }
                : {}),
        }
    }
}
