import {
    CompositionRepository,
    CompositionRepositoryError,
    type CompositionAuthority,
    type CompositionRepositoryRecord,
    type CompositionRepositoryStorage,
} from '@/domain/composition/repository'
import {
    COMPOSITION_MIGRATION_REGISTRY_VERSION,
    LEGACY_COMPOSITION_STORE_ALIASES,
    LEGACY_STORES_MIGRATION_ID,
    runCompositionMigration,
} from '@/domain/composition/migrations'
import {
    exportWildcardContentSnapshot,
    compareAndSetIndexedDBItem,
    getIndexedDBItemStrict,
    setIndexedDBItemStrict,
} from '@/lib/indexed-db'
import {
    COMPOSITION_MIGRATION_POST_COMMIT_SOURCE_CHANGED,
    compositionMigrationSourceHash,
    runCompositionMigrationTransaction,
    type CompositionMigrationSourceSnapshot,
    type CompositionMigrationTransactionResult,
} from '@/lib/composition-migration-runtime'
import { validateCompositionSemantics } from '@/domain/composition/validation'
import { materializeCompositionMigrationSidecars } from '@/lib/composition-migration-materialization'
import { loadRawAssetProfileFile } from '@/services/asset-profile-file'
import {
    setRuntimeCompositionDocument,
} from '@/lib/composition-authority'

const STARTUP_MIGRATION_OWNER = 'nai-blue-startup'

export type CompositionStartupIssue =
    | 'migration-failed'
    | 'repository-verification-failed'
    | 'startup-failed-before-result'

export type CompositionMigrationDiagnosticStatus =
    | 'not-migrated'
    | 'migration-active'
    | 'interrupted-migration'
    | 'committed-unverified'
    | 'startup-verified'
    | 'canonical'
    | 'repository-invalid'

export interface CompositionStartupObservation {
    observedAt: string
    persistedAuthority: CompositionAuthority | 'unavailable'
    runtimeAuthority: 'v2'
    resultStatus: CompositionMigrationTransactionResult['status'] | 'failed-before-result'
    migrationIssue: CompositionStartupIssue | null
}
export interface CompositionAuthorityInspection {
    inspectedAt: string
    persistedAuthority: CompositionAuthority | 'unavailable'
    runtimeAuthority: 'v2'
    repositoryRevision: number | null
    repositoryHash: string | null
    migrationStatus: CompositionMigrationDiagnosticStatus
    startupVerificationTimestamp: string | null
    migrationIssue: CompositionStartupIssue | null
    repositoryErrorCode: string | null
    lastStartup: CompositionStartupObservation | null
}

let lastStartupObservation: CompositionStartupObservation | null = null

export function recordStartupObservation(observation: CompositionStartupObservation): void {
    lastStartupObservation = { ...observation }
}

export function getLastCompositionStartupObservation(): CompositionStartupObservation | null {
    return lastStartupObservation === null ? null : { ...lastStartupObservation }
}

function productionStorage(): CompositionRepositoryStorage {
    return {
        getItem: getIndexedDBItemStrict,
        setItem: setIndexedDBItemStrict,
        compareAndSet: compareAndSetIndexedDBItem,
    }
}

export function mergeLegacyLocalStorageAliases(
    serializedStores: Readonly<Record<string, string>>,
    readLocalValue: (key: string) => string | null,
): Record<string, string> {
    const merged = { ...serializedStores }
    const legacyAliases = [...new Set(Object.values(LEGACY_COMPOSITION_STORE_ALIASES).flat())]
    for (const key of legacyAliases.sort((left, right) => left.localeCompare(right))) {
        if (merged[key] !== undefined) continue
        const raw = readLocalValue(key)
        if (raw !== null) merged[key] = raw
    }
    return merged
}

export async function collectCompositionMigrationSource(environment?: {
    readLocalValue: (key: string) => string | null
    readAssetProfile: typeof loadRawAssetProfileFile
}): Promise<CompositionMigrationSourceSnapshot> {
    // Capture only authorities the legacy migrator consumes. Operational journals
    // and growing rollback archives must never become new migration preimages.
    const aliases = [...new Set(Object.values(LEGACY_COMPOSITION_STORE_ALIASES).flat())]
    const entries = await Promise.all(aliases.map(async key => (
        [key, await getIndexedDBItemStrict(key)] as const
    )))
    let serializedStores: Record<string, string> = Object.fromEntries(
        entries.filter((entry): entry is readonly [typeof aliases[number], string] => entry[1] !== null),
    )

    // Some pre-IndexedDB releases used non-canonical localStorage aliases.
    // Capture them under the migration lock without deleting or rewriting the
    // source; the legacy migrator already understands these exact keys.
    if (environment !== undefined || (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function')) {
        serializedStores = mergeLegacyLocalStorageAliases(
            serializedStores,
            environment?.readLocalValue ?? (key => localStorage.getItem(key)),
        )
    }

    const wildcardContent = await exportWildcardContentSnapshot({ strict: true })
    let assetProfileJson: unknown
    // A read error is not equivalent to a missing profile. Let it abort the
    // migration so an existing disk authority can never be silently omitted.
    const diskProfile = await (environment?.readAssetProfile ?? loadRawAssetProfileFile)()
    if (diskProfile.exists) assetProfileJson = diskProfile.rawJson

    return {
        serializedStores,
        wildcardContent,
        ...(assetProfileJson === undefined ? {} : { assetProfileJson }),
    }
}

export interface StartupCompositionMigrationOptions {
    now?: string
    source?: CompositionMigrationSourceSnapshot
    sourceProvider?: () => Promise<CompositionMigrationSourceSnapshot>
    storage?: CompositionRepositoryStorage
    materializeSidecars?: typeof materializeCompositionMigrationSidecars
    clock?: () => string
}

/** Converts compatible saved stores before hydration into the single Composition runtime. */
export async function runStartupCompositionMigration(
    options: StartupCompositionMigrationOptions = {},
): Promise<CompositionMigrationTransactionResult> {
    setRuntimeCompositionDocument(null)
    const now = options.now ?? new Date().toISOString()
    const storage = options.storage ?? productionStorage()
    const repository = new CompositionRepository(storage)
    const sourceInput = options.sourceProvider ?? (options.source === undefined
        ? collectCompositionMigrationSource
        : async () => options.source!)
    const materializeSidecars = options.materializeSidecars
        ?? (options.source === undefined ? materializeCompositionMigrationSidecars : undefined)
    let repositoryVerificationFailed = false
    const executeMigration = () => runCompositionMigrationTransaction({
        repository,
        storage,
        source: sourceInput,
        now,
        owner: STARTUP_MIGRATION_OWNER,
        registryVersion: COMPOSITION_MIGRATION_REGISTRY_VERSION,
        clock: options.clock ?? (() => new Date().toISOString()),
        migrate: input => runCompositionMigration(LEGACY_STORES_MIGRATION_ID, input),
        ...(materializeSidecars === undefined
            ? {}
            : {
                postCommitBeforeFinalize: async ({ source, document, sidecars }) => {
                    await materializeSidecars({ source, document, sidecars })
                },
            }),
    })
    let result: CompositionMigrationTransactionResult
    try {
        const current = await repository.cleanupInterruptedMigration(now)
        // A finalized migration already materialized its sidecars. Verify its
        // exact live source and repository again, but do not rebuild the raw
        // rollback archive or repeat the legacy conversion on every launch.
        const marker = current.migrationMarker
        if (current.authority === 'v2' && current.committedDocument !== undefined
            && current.migrationLock === undefined && current.staged === undefined
            && marker?.startupVerifiedAt !== undefined
            && marker.registryVersion === COMPOSITION_MIGRATION_REGISTRY_VERSION
            && compositionMigrationSourceHash(await sourceInput()) === marker.sourceHash) {
            const issues = validateCompositionSemantics(current.committedDocument)
            const readback = await repository.read(now)
            if (!issues.some(issue => issue.blocking) && readback.revision === current.revision
                && readback.committedHash === current.committedHash
                && readback.migrationLock === undefined && readback.staged === undefined
                && readback.authority === 'v2'
                && compositionMigrationSourceHash(await sourceInput()) === marker.sourceHash) {
                setRuntimeCompositionDocument(current.committedDocument)
                recordStartupObservation({ observedAt: now, persistedAuthority: 'v2', runtimeAuthority: 'v2',
                    resultStatus: 'already-current', migrationIssue: null })
                return { status: 'already-current', authority: 'v2', migrationId: marker.migrationId,
                    sourceHash: marker.sourceHash, sourceCounts: marker.sourceCounts, marker,
                    validationIssues: issues, oldSourcesRetained: true,
                    completedSteps: ['source-manifest', 'schema-reference-validation', 'startup-reread'] }
            }
        }
        result = await executeMigration()
        if (result.failureCode === COMPOSITION_MIGRATION_POST_COMMIT_SOURCE_CHANGED) {
            result = await executeMigration()
            if (result.failureCode === COMPOSITION_MIGRATION_POST_COMMIT_SOURCE_CHANGED) {
                result = {
                    ...result,
                    error: 'Composition compatibility projection did not reach a stable source hash',
                }
            }
        }
    } catch (error) {
        // Repository cleanup is owned by the transaction. This wrapper never
        // writes repository authority after a concurrent startup can take over.
        recordStartupObservation({
            observedAt: now,
            persistedAuthority: 'unavailable',
            runtimeAuthority: 'v2',
            resultStatus: 'failed-before-result',
            migrationIssue: 'startup-failed-before-result',
        })
        throw error
    }
    if (result.status !== 'failed' && result.authority === 'v2') {
        try {
            const verified = await repository.read(now)
            if (verified.authority === 'v2'
                && verified.committedDocument !== undefined
                && verified.committedHash === result.marker?.targetHash
                && verified.migrationMarker?.startupVerifiedAt !== undefined) {
                const authoritativeDocument = await repository.readAuthoritativeDocument(now)
                if (authoritativeDocument !== null) {
                    setRuntimeCompositionDocument(authoritativeDocument)
                    recordStartupObservation({
                        observedAt: now,
                        persistedAuthority: 'v2',
                        runtimeAuthority: 'v2',
                        resultStatus: result.status,
                        migrationIssue: null,
                    })
                    return result
                }
            }
        } catch {
            repositoryVerificationFailed = true
        }
    }
    let authority: CompositionAuthority = result.authority
    let persistedAuthority: CompositionAuthority | 'unavailable' = authority
    try {
        authority = (await repository.read(now)).authority
        persistedAuthority = authority
    } catch {
        persistedAuthority = 'unavailable'
    }
    const migrationIssue: CompositionStartupIssue | null = repositoryVerificationFailed
        ? 'repository-verification-failed'
        : result.status === 'failed'
            ? 'migration-failed'
            : null
    recordStartupObservation({
        observedAt: now,
        persistedAuthority,
            runtimeAuthority: 'v2',
        resultStatus: result.status,
        migrationIssue,
    })
    return { ...result, authority }
}

function migrationDiagnosticStatus(
    record: CompositionRepositoryRecord,
    now: string,
): CompositionMigrationDiagnosticStatus {
    if (record.migrationLock !== undefined || record.staged !== undefined) {
        const expiresAt = record.migrationLock === undefined
            ? Number.NaN
            : Date.parse(record.migrationLock.expiresAt)
        const inspectedAt = Date.parse(now)
        return record.migrationLock !== undefined
            && Number.isFinite(expiresAt)
            && Number.isFinite(inspectedAt)
            && expiresAt > inspectedAt
            ? 'migration-active'
            : 'interrupted-migration'
    }
    if (record.committedDocument === undefined) return 'not-migrated'
    if (record.migrationMarker?.startupVerifiedAt !== undefined) return 'startup-verified'
    if (record.authority === 'v2') return 'canonical'
    return 'committed-unverified'
}

export async function inspectCompositionAuthority(options: {
    now?: string
    storage?: CompositionRepositoryStorage
} = {}): Promise<CompositionAuthorityInspection> {
    const now = options.now ?? new Date().toISOString()
    const storage = options.storage ?? productionStorage()
    const repository = new CompositionRepository(storage)
    const runtimeAuthority = 'v2'

    try {
        const record = await repository.read(now)
        const migrationIssue = lastStartupObservation?.migrationIssue ?? null
        return {
            inspectedAt: now,
            persistedAuthority: record.authority,
            runtimeAuthority,
            repositoryRevision: record.revision,
            repositoryHash: record.committedHash ?? null,
            migrationStatus: migrationDiagnosticStatus(record, now),
            startupVerificationTimestamp: record.migrationMarker?.startupVerifiedAt ?? null,
            migrationIssue,
            repositoryErrorCode: null,
            lastStartup: getLastCompositionStartupObservation(),
        }
    } catch (error) {
        return {
            inspectedAt: now,
            persistedAuthority: 'unavailable',
            runtimeAuthority,
            repositoryRevision: null,
            repositoryHash: null,
            migrationStatus: 'repository-invalid',
            startupVerificationTimestamp: null,
            migrationIssue: lastStartupObservation?.migrationIssue ?? 'startup-failed-before-result',
            repositoryErrorCode: error instanceof CompositionRepositoryError
                ? error.code
                : 'E_REPOSITORY_READ_FAILED',
            lastStartup: getLastCompositionStartupObservation(),
        }
    }
}
