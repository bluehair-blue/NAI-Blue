import { exists, mkdir, readDir, readFile, remove } from '@tauri-apps/plugin-fs'
import { writeUtf8TextFile } from './write-utf8-text-file'
import { startupCheckpoint } from './startup-checkpoint'
import { isTauri } from '@tauri-apps/api/core'
import packageMetadata from '../../package.json'
import {
    CANONICAL_HASH_ALGORITHM,
    CANONICAL_SERIALIZATION_VERSION,
    canonicalUtf8ByteLength,
    hashCanonicalValue,
} from '@/domain/composition/canonical-serialize'
import { safeParseCompositionDocument } from '@/domain/composition/schema'
import { validateCompositionSemantics } from '@/domain/composition/validation'
import {
    COMPOSITION_REPOSITORY_SCHEMA_VERSION,
    compositionDocumentHash,
    createCommittedCompositionRepositoryRecord,
    parseCompositionRepositoryRecord,
    type CompositionRepositoryRecord,
} from '@/domain/composition/repository'
import {
    COMPOSITION_SCHEMA_VERSION,
    type ActorRef,
    type CompositionDocument,
} from '@/domain/composition/types'
import {
    FULL_BACKUP_STORE_KEYS,
    LEGACY_BACKUP_STORE_KEYS,
    STRUCTURED_PROMPT_MODULE_STORE_KEY,
    exportAllData,
    exportRawIndexedDBEntries,
    flushAllPendingWrites,
    importBackupToStorage,
    importAllData,
    type BackupStoragePort,
} from '@/lib/indexed-db'
import {
    AUTH_BACKUP_STORE_KEY,
    projectStoreForBackup,
    type BackupProjectionPurpose,
} from '@/lib/backup-projection'
import { MEDIA_STORAGE_BASE_DIRECTORY } from '@/platform/storage'
import {
    STYLE_LAB_REPOSITORY_SCHEMA_VERSION,
    STYLE_LAB_REPOSITORY_STORE_KEY,
} from '@/domain/style-lab/persistence'
import {
    ASSET_PROFILE_FILE_PATH,
    loadRawAssetProfileFile,
    restoreRawAssetProfileFile,
    restoreRawAssetProfileFilePreimage,
} from '@/services/asset-profile-file'
import { GENERATION_PRESET_STORE_VERSION } from '@/lib/composition/preset-store-migration'

const BACKUP_ROOT = 'NAI_Blue_Backup'
const FULL_BACKUP_DIR = `${BACKUP_ROOT}/full`
const FULL_BACKUP_PREFIX = 'nai-blue-full'
const MAX_FULL_BACKUPS = 10

export const DISK_AUTO_BACKUP_LAST_KEY = 'nai-blue-last-disk-auto-backup'
export const BACKUP_ENVELOPE_FORMAT = 'nai-blue-backup-envelope' as const
export const BACKUP_ENVELOPE_VERSION = 3 as const
export const BACKUP_STORE_MANIFEST_VERSION = 1 as const
export const COMPOSITION_REPOSITORY_STORE_KEY = 'nai-blue-composition-repository' as const
export const COMPOSITION_MIGRATION_BACKUP_STORE_KEY = 'nai-blue-composition-migration-backup' as const

const WILDCARD_CONTENT_KEY = 'nai-blue-wildcard-content'
export const ASSET_PROFILE_FILE_RESTORE_KEY = 'file:asset-profile' as const
const CURRENT_APP_VERSION = packageMetadata.version
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const legacyStoreKeySet = new Set<string>(LEGACY_BACKUP_STORE_KEYS)

/**
 * These two keys are included here as a compatibility bridge while the central
 * IndexedDB registry is rolled out. Keeping the restore boundary explicit also
 * prevents a future envelope key from becoming writable by accident.
 */
const backupStoreKeySet = new Set<string>([
    ...FULL_BACKUP_STORE_KEYS,
    COMPOSITION_REPOSITORY_STORE_KEY,
])

/**
 * The raw pre-migration archive is portable backup evidence, not live
 * application state. It may be included in an envelope, but restore must never
 * write it over the destination installation's own rollback archive.
 */
export const BACKUP_V3_RESTORE_STORE_KEYS = Object.freeze(Array.from(new Set<string>([
    ...FULL_BACKUP_STORE_KEYS.filter(key => key !== COMPOSITION_MIGRATION_BACKUP_STORE_KEY),
    COMPOSITION_REPOSITORY_STORE_KEY,
])))

const restoreStoreKeySet = new Set<string>(BACKUP_V3_RESTORE_STORE_KEYS)

interface SupportedBackupStoreVersion {
    version?: number
    schemaVersion?: number
}

/**
 * Maximum persistence/schema versions this build knows how to hydrate. The
 * values deliberately include retained v1/v2 fixture formats; a future writer
 * must update this registry before its payload becomes restorable.
 */
export const SUPPORTED_BACKUP_STORE_VERSIONS: Readonly<Record<string, SupportedBackupStoreVersion>> = Object.freeze({
    'nai-blue-generation': { version: 8, schemaVersion: 2 },
    'nai-blue-character-store': { version: 2, schemaVersion: 2 },
    'nai-blue-character-prompts': { version: 2, schemaVersion: 2 },
    'nai-blue-presets': { version: GENERATION_PRESET_STORE_VERSION, schemaVersion: 2 },
    'nai-blue-settings': { version: 2, schemaVersion: 2 },
    'nai-blue-auth': { version: 3, schemaVersion: 2 },
    'nai-blue-scenes': { version: 1, schemaVersion: 2 },
    'nai-blue-character-rotation': { version: 2, schemaVersion: 2 },
    'nai-blue-shortcuts': { version: 2, schemaVersion: 2 },
    'nai-blue-theme': { version: 2, schemaVersion: 2 },
    'nai-blue-wildcards': { version: 2, schemaVersion: 2 },
    'nai-blue-prompt-library': { version: 2, schemaVersion: 2 },
    [STRUCTURED_PROMPT_MODULE_STORE_KEY]: { version: 1, schemaVersion: 1 },
    'nai-blue-layout': { version: 2, schemaVersion: 2 },
    'nai-blue-library': { version: 2, schemaVersion: 2 },
    'nai-blue-tools': { version: 2, schemaVersion: 2 },
    'nai-blue-update': { version: 2, schemaVersion: 2 },
    'nai-blue-style-lab': { version: 2, schemaVersion: 2 },
    [STYLE_LAB_REPOSITORY_STORE_KEY]: { schemaVersion: STYLE_LAB_REPOSITORY_SCHEMA_VERSION },
    'nai-blue-asset-modules': { version: 2, schemaVersion: 2 },
    [COMPOSITION_REPOSITORY_STORE_KEY]: { schemaVersion: COMPOSITION_REPOSITORY_SCHEMA_VERSION },
})

const LEGACY_STORE_VERSION_POLICY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
    scenes: 'nai-blue-scenes',
    'scene-store': 'nai-blue-scenes',
    wildcards: 'nai-blue-wildcards',
    fragments: 'nai-blue-wildcards',
    'character-prompts': 'nai-blue-character-prompts',
    characterPrompts: 'nai-blue-character-prompts',
    'generation-presets': 'nai-blue-presets',
    generationPresets: 'nai-blue-presets',
    novelaiPromptEditorState: 'nai-blue-prompt-library',
    'prompt-presets': 'nai-blue-prompt-library',
    promptPresets: 'nai-blue-prompt-library',
    'asset-profile': 'nai-blue-asset-modules',
    assetProfile: 'nai-blue-asset-modules',
})

const SUPPORTED_AUXILIARY_LEGACY_STORE_VERSION = Object.freeze({
    version: 2,
    schemaVersion: 2,
})

export interface FullAutoBackupEntry {
    fileName: string
    relPath: string
    timestamp: string
    exportedAt?: string
}

export type CreateFullAutoBackupResult =
    | { status: 'created'; entry: FullAutoBackupEntry; storeCount: number }
    | { status: 'skipped'; reason: 'not-tauri' | 'interval'; nextBackupAt?: string }

export interface BackupContentHash {
    algorithm: typeof CANONICAL_HASH_ALGORITHM
    canonicalization: typeof CANONICAL_SERIALIZATION_VERSION
    digest: string
}

export interface BackupStoreManifestEntry {
    key: string
    schemaVersion: string | number | null
    version: string | number | null
    count: number
    hash: BackupContentHash
    source: 'store' | 'legacy-store'
}

export interface BackupStoreManifest {
    schemaVersion: typeof BACKUP_STORE_MANIFEST_VERSION
    storeCount: number
    totalRecordCount: number
    hash: BackupContentHash
    entries: BackupStoreManifestEntry[]
}

export interface BackupIncludedFileEntry {
    path: string
    kind: 'composition-document' | 'store' | 'legacy-store' | 'wildcard-content' | 'file'
    sizeBytes: number
    hash: BackupContentHash
}

export interface BackupExcludedFileEntry {
    path: string
    reason: string
}

export interface BackupFileManifest {
    included: BackupIncludedFileEntry[]
    excluded: BackupExcludedFileEntry[]
}

export interface BackupEnvelopeV3 {
    format: typeof BACKUP_ENVELOPE_FORMAT
    formatVersion: typeof BACKUP_ENVELOPE_VERSION
    createdAt: string
    appVersion: string
    sourceCommit?: string
    compositionSchemaVersion: typeof COMPOSITION_SCHEMA_VERSION
    storeManifest: BackupStoreManifest
    compositionDocument: CompositionDocument
    stores: Record<string, unknown>
    legacyStores?: Record<string, unknown>
    wildcardContent?: Record<string, string[]>
    /** Exact allowlisted disk authority; no image/library bytes are embedded. */
    assetProfileJson?: string
    ignoredLegacyKeys: string[]
    fileManifest: BackupFileManifest
}

export type BackupRestoreSourceFormat = 'envelope-v3' | 'legacy-v2'
export type BackupIgnoredKeyReason =
    | 'legacy-marketplace-supabase'
    | 'migration-backup-archive'
    | 'unknown-key'
    | 'declared-ignored'

export interface BackupIgnoredKeyReport {
    key: string
    reason: BackupIgnoredKeyReason
}

export interface BackupRestoreIssue {
    code: string
    message: string
    key?: string
}

export interface BackupRestoreDryRunReport {
    sourceFormat: BackupRestoreSourceFormat
    sourceVersion: string | number
    createdAt?: string
    canRestore: boolean
    manifestVerified: boolean
    compositionSchemaVersion?: number
    restoreKeys: string[]
    ignoredKeys: BackupIgnoredKeyReport[]
    wildcardContentCount: number
    errors: BackupRestoreIssue[]
    warnings: BackupRestoreIssue[]
    credentialReentryRequired: boolean
}

export interface PreparedBackupRestore {
    report: BackupRestoreDryRunReport
    /** A detached, allowlisted legacy-shaped payload suitable for importAllData. */
    restorePayload: Record<string, unknown>
    assetProfileJson?: string
}

export interface BackupRestoreResult {
    success: string[]
    failed: string[]
    report: BackupRestoreDryRunReport
}

export class UnsupportedBackupSchemaError extends Error {
    readonly report: BackupRestoreDryRunReport

    constructor(report: BackupRestoreDryRunReport) {
        const detail = report.errors.map(issue => `${issue.code}: ${issue.message}`).join('; ')
        super(detail || 'Backup schema is not supported.')
        this.name = 'UnsupportedBackupSchemaError'
        this.report = report
    }
}

export class BackupRestoreWriteError extends Error {
    readonly result: BackupRestoreResult

    constructor(result: BackupRestoreResult) {
        super(`Backup restore failed for: ${result.failed.join(', ')}`)
        this.name = 'BackupRestoreWriteError'
        this.result = result
    }
}

export class BackupRestoreCapabilityError extends Error {
    readonly issues: BackupRestoreIssue[]

    constructor(issues: readonly BackupRestoreIssue[]) {
        super(issues.map(issue => `${issue.code}: ${issue.message}`).join('; '))
        this.name = 'BackupRestoreCapabilityError'
        this.issues = [...issues]
    }
}

export class BackupCompositionReferencesError extends TypeError {
    readonly code = 'E_COMPOSITION_REFERENCES_INVALID' as const
    readonly referenceIssues: string[]

    constructor(referenceIssues: readonly string[]) {
        super(`E_COMPOSITION_REFERENCES_INVALID: ${compositionReferenceErrorMessage(referenceIssues)}`)
        this.name = 'BackupCompositionReferencesError'
        this.referenceIssues = [...referenceIssues]
    }
}

export interface CreateBackupEnvelopeV3Options {
    /** Required by the pure builder; callers must take it from the committed repository authority. */
    compositionDocument: CompositionDocument
    createdAt?: string
    appVersion?: string
    sourceCommit?: string
    includeLegacyStores?: boolean
    ignoredLegacyKeys?: readonly string[]
    includedFiles?: readonly BackupIncludedFileEntry[]
    excludedFiles?: readonly BackupExcludedFileEntry[]
    assetProfileJson?: string
    purpose?: Exclude<BackupProjectionPurpose, 'store-snapshot' | 'restore-preflight'>
}

export interface PrepareBackupRestoreOptions {
    /**
     * Repository-owned factory used only when an otherwise valid v3 envelope
     * does not carry the repository store. No guessed persistence wrapper is
     * ever written.
     */
    createCompositionRepositoryRecord?: (
        document: CompositionDocument,
        context: { updatedAt: string; authority: 'v2' },
    ) => unknown
}

export interface RestoreBackupToStorageOptions extends PrepareBackupRestoreOptions {
    overwrite?: boolean
    flushStore?: (key: string) => void | Promise<void>
    importWildcardContent?: (content: Record<string, string[]>) => Promise<void>
    readWildcardContent?: () => Promise<Record<string, string[]>>
    restoreAssetProfileJson?: (rawJson: string) => Promise<void>
    rollbackAssetProfileJson?: () => Promise<void>
}

export interface CreateCurrentBackupEnvelopeV3Options {
    compositionDocument?: CompositionDocument
    readCompositionDocument?: () => CompositionDocument | null | Promise<CompositionDocument | null>
    sourceCommit?: string
    createdAt?: string
    appVersion?: string
    readRawAssetProfile?: () => Promise<{ exists: boolean; rawJson: string | null }>
    readBackupData?: () => Promise<Record<string, unknown>>
    readRawIndexedEntries?: () => Promise<Record<string, string>>
    readLegacyLocalValue?: (key: string) => string | null
    readLegacyLocalKeys?: () => readonly string[]
    purpose?: Exclude<BackupProjectionPurpose, 'store-snapshot' | 'restore-preflight'>
}

export interface CreateFullAutoBackupOptions extends CreateCurrentBackupEnvelopeV3Options {
    force?: boolean
    minIntervalMs?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function detachedJsonValue<T>(value: T): T {
    // Rollback archives contain very large immutable strings. A stringify/parse
    // clone duplicates their entire escaped representation before hashing.
    const ancestors = new Set<object>()
    const omitted = (item: unknown) => item === undefined || typeof item === 'function' || typeof item === 'symbol'
    const clone = (item: unknown): unknown => {
        if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
        if (typeof item === 'number') return Number.isFinite(item) ? (Object.is(item, -0) ? 0 : item) : null
        if (item && typeof item === 'object') {
            const prototype = Object.getPrototypeOf(item)
            if ((Array.isArray(item) || prototype === Object.prototype || prototype === null)
                && typeof (item as { toJSON?: unknown }).toJSON !== 'function') {
                if (ancestors.has(item)) throw new TypeError('Circular backup payload')
                ancestors.add(item)
                try {
                    return Array.isArray(item)
                        ? Array.from(item, child => omitted(child) ? null : clone(child))
                        : Object.fromEntries(Object.entries(item).filter(([, child]) => !omitted(child))
                            .map(([key, child]) => [key, clone(child)]))
                } finally { ancestors.delete(item) }
            }
        }
        // Preserve JSON conversion for uncommon non-JSON inputs such as Dates,
        // and its rejection of BigInt or an unsupported root value.
        return JSON.parse(JSON.stringify(item)) as unknown
    }
    return clone(value) as T
}

function contentHash(value: unknown): BackupContentHash {
    return {
        algorithm: CANONICAL_HASH_ALGORITHM,
        canonicalization: CANONICAL_SERIALIZATION_VERSION,
        digest: hashCanonicalValue(value),
    }
}

function jsonByteLength(value: unknown): number {
    return canonicalUtf8ByteLength(value)
}

function storeSchemaVersion(value: unknown): string | number | null {
    if (!isRecord(value)) return null
    if (typeof value.repositorySchemaVersion === 'string' || typeof value.repositorySchemaVersion === 'number') {
        return value.repositorySchemaVersion
    }
    if (typeof value.schemaVersion === 'string' || typeof value.schemaVersion === 'number') {
        return value.schemaVersion
    }
    if (isRecord(value.state)) {
        if (typeof value.state.schemaVersion === 'string' || typeof value.state.schemaVersion === 'number') {
            return value.state.schemaVersion
        }
    }
    return null
}

function storeVersion(value: unknown): string | number | null {
    if (!isRecord(value)) return null
    if (typeof value.version === 'string' || typeof value.version === 'number') return value.version
    if (isRecord(value.state)
        && (typeof value.state.version === 'string' || typeof value.state.version === 'number')) {
        return value.state.version
    }
    return null
}

/** Stable, intentionally shallow logical record count used for restore readback. */
function storeRecordCount(value: unknown): number {
    if (value === null || value === undefined) return 0
    if (Array.isArray(value)) return value.length
    if (!isRecord(value)) return 1
    const logicalValue = isRecord(value.state) || Array.isArray(value.state) ? value.state : value
    if (Array.isArray(logicalValue)) return logicalValue.length
    return Object.keys(logicalValue).length
}

export function createBackupStoreManifestEntry(
    key: string,
    value: unknown,
    source: BackupStoreManifestEntry['source'] = 'store',
): BackupStoreManifestEntry {
    return {
        key,
        schemaVersion: storeSchemaVersion(value),
        version: storeVersion(value),
        count: storeRecordCount(value),
        hash: contentHash(value),
        source,
    }
}

function createStoreManifest(
    stores: Readonly<Record<string, unknown>>,
    legacyStores: Readonly<Record<string, unknown>>,
): BackupStoreManifest {
    const entries = [
        ...Object.entries(stores).map(([key, value]) => createBackupStoreManifestEntry(key, value, 'store')),
        ...Object.entries(legacyStores).map(([key, value]) => createBackupStoreManifestEntry(key, value, 'legacy-store')),
    ].sort((left, right) => left.key.localeCompare(right.key))

    return {
        schemaVersion: BACKUP_STORE_MANIFEST_VERSION,
        storeCount: entries.length,
        totalRecordCount: entries.reduce((total, entry) => total + entry.count, 0),
        hash: contentHash(entries),
        entries,
    }
}

function normalizeWildcardContent(value: unknown): Record<string, string[]> | undefined {
    if (!isRecord(value)) return undefined
    const normalized: Record<string, string[]> = {}
    for (const [key, lines] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
        if (!Array.isArray(lines) || !lines.every(line => typeof line === 'string')) return undefined
        normalized[key] = [...lines]
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined
}

function parseAssetProfileBackupJson(value: unknown): string | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'string') throw new TypeError('Asset Profile backup payload must be a JSON string')
    let parsed: unknown
    try {
        parsed = JSON.parse(value) as unknown
    } catch (error) {
        throw new TypeError(`Asset Profile backup JSON is invalid: ${String(error)}`)
    }
    if (!isRecord(parsed)) throw new TypeError('Asset Profile backup must contain a JSON object')
    if (typeof parsed.schemaVersion === 'number' && parsed.schemaVersion > 2) {
        throw new TypeError(`Unsupported Asset Profile schema ${parsed.schemaVersion}`)
    }
    return value
}

function assetProfileIncludedFile(rawJson: string): BackupIncludedFileEntry {
    return {
        path: ASSET_PROFILE_FILE_PATH,
        kind: 'file',
        sizeBytes: encoder.encode(rawJson).byteLength,
        hash: contentHash(rawJson),
    }
}

function defaultExcludedFiles(): BackupExcludedFileEntry[] {
    return [
        { path: 'NAI_Blue_Library/**', reason: 'external library/resource files are not embedded in JSON backups' },
        { path: 'references/**', reason: 'character/vibe bytes and encoded caches remain in the resource repository' },
        { path: 'output/**', reason: 'generated output files are not embedded in JSON backups' },
    ]
}

function includedPayloadFiles(
    compositionDocument: CompositionDocument,
    stores: Readonly<Record<string, unknown>>,
    legacyStores: Readonly<Record<string, unknown>>,
    wildcardContent?: Readonly<Record<string, string[]>>,
    assetProfileJson?: string,
): BackupIncludedFileEntry[] {
    const included: BackupIncludedFileEntry[] = [{
        path: 'composition/document.json',
        kind: 'composition-document',
        sizeBytes: jsonByteLength(compositionDocument),
        hash: contentHash(compositionDocument),
    }]
    for (const [key, value] of Object.entries(stores).sort(([left], [right]) => left.localeCompare(right))) {
        included.push({
            path: `stores/${key}.json`,
            kind: 'store',
            sizeBytes: jsonByteLength(value),
            hash: contentHash(value),
        })
    }
    for (const [key, value] of Object.entries(legacyStores).sort(([left], [right]) => left.localeCompare(right))) {
        included.push({
            path: `legacy-stores/${key}.json`,
            kind: 'legacy-store',
            sizeBytes: jsonByteLength(value),
            hash: contentHash(value),
        })
    }
    if (wildcardContent) {
        included.push({
            path: 'indexeddb/nai-blue-wildcard-content.json',
            kind: 'wildcard-content',
            sizeBytes: jsonByteLength(wildcardContent),
            hash: contentHash(wildcardContent),
        })
    }
    if (assetProfileJson !== undefined) included.push(assetProfileIncludedFile(assetProfileJson))
    return included
}

function isMarketplaceOrSupabaseKey(key: string): boolean {
    const normalized = key.toLowerCase()
    return normalized.includes('marketplace')
        || normalized.includes('supabase')
        || /^sb-.+-auth-token$/.test(normalized)
}

function ignoredKeyReport(key: string, declared = false): BackupIgnoredKeyReport {
    return {
        key,
        reason: declared
            ? 'declared-ignored'
            : key === COMPOSITION_MIGRATION_BACKUP_STORE_KEY
                ? 'migration-backup-archive'
            : isMarketplaceOrSupabaseKey(key)
                ? 'legacy-marketplace-supabase'
                : 'unknown-key',
    }
}

function sameHash(left: BackupContentHash, right: BackupContentHash): boolean {
    return left.algorithm === right.algorithm
        && left.canonicalization === right.canonicalization
        && left.digest === right.digest
}

function isBackupContentHash(value: unknown): value is BackupContentHash {
    return isRecord(value)
        && value.algorithm === CANONICAL_HASH_ALGORITHM
        && value.canonicalization === CANONICAL_SERIALIZATION_VERSION
        && typeof value.digest === 'string'
}

function uniqueSorted(values: readonly string[]): string[] {
    return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right))
}

const BLOCKING_REFERENCE_ISSUE_CODES = new Set([
    'E_PROFILE_MISSING',
    'E_RECIPE_MISSING',
    'E_MODULE_REF_MISSING',
    'E_PARAMS_PRESET_MISSING',
    'E_CHARACTER_REF_MISSING',
    'E_RANDOM_RULE_REF_MISSING',
    'E_RESOURCE_REF_MISSING',
])

/**
 * Shape validation deliberately accepts stable IDs without dereferencing them.
 * Backup v3 must not make a syntactically valid but unresolvable document the
 * clean-install authority, so it additionally rejects every blocking reference
 * issue known to the domain validator.
 */
function blockingCompositionReferenceIssues(document: Readonly<CompositionDocument>): string[] {
    return uniqueSorted(validateCompositionSemantics(document)
        .filter(issue => issue.blocking && BLOCKING_REFERENCE_ISSUE_CODES.has(issue.code))
        .map(issue => `${issue.code}@${JSON.stringify(issue.fieldPath)}`))
}

function compositionReferenceErrorMessage(issues: readonly string[]): string {
    return `CompositionDocument has dangling references: ${issues.join(', ')}`
}

/**
 * Pure Backup Envelope v3 builder. It never reads a live store and therefore
 * cannot accidentally mix authorities or timestamps during a migration.
 */
export function createBackupEnvelopeV3(
    rawBackup: Readonly<Record<string, unknown>>,
    options: CreateBackupEnvelopeV3Options,
): BackupEnvelopeV3 {
    const parsedDocument = safeParseCompositionDocument(options.compositionDocument)
    if (!parsedDocument.success) {
        throw new TypeError(`Cannot export invalid CompositionDocument: ${parsedDocument.issues.map(issue => issue.code).join(', ')}`)
    }
    const referenceIssues = blockingCompositionReferenceIssues(parsedDocument.data)
    if (referenceIssues.length > 0) {
        throw new BackupCompositionReferencesError(referenceIssues)
    }

    const stores: Record<string, unknown> = {}
    const legacyStores: Record<string, unknown> = {}
    const ignoredKeys: string[] = [...(options.ignoredLegacyKeys ?? [])]
    let wildcardContent: Record<string, string[]> | undefined
    const assetProfileJson = parseAssetProfileBackupJson(options.assetProfileJson)

    for (const [key, value] of Object.entries(rawBackup)) {
        if (key.startsWith('_')) continue
        if (key === WILDCARD_CONTENT_KEY) {
            wildcardContent = normalizeWildcardContent(value)
            continue
        }
        if (!backupStoreKeySet.has(key)) {
            ignoredKeys.push(key)
            continue
        }
        if (legacyStoreKeySet.has(key)) {
            if (options.includeLegacyStores !== false) legacyStores[key] = detachedJsonValue(value)
            else ignoredKeys.push(key)
            continue
        }
        stores[key] = detachedJsonValue(projectStoreForBackup(
            key,
            value,
            options.purpose ?? 'manual-full',
        ).payload)
    }

    const compositionDocument = detachedJsonValue(parsedDocument.data)
    void startupCheckpoint('backup:payloads-detached')
    const repositoryPayload = stores[COMPOSITION_REPOSITORY_STORE_KEY]
    if (repositoryPayload !== undefined) {
        let repository: CompositionRepositoryRecord
        try {
            repository = parseCompositionRepositoryRecord(repositoryPayload)
        } catch (error) {
            throw new TypeError(`Cannot export invalid composition repository: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (repository.committedDocument
            && compositionDocumentHash(repository.committedDocument) !== compositionDocumentHash(compositionDocument)) {
            throw new TypeError('Cannot export mismatched CompositionDocument and committed repository document.')
        }
    }
    void startupCheckpoint('backup:store-manifest')
    const storeManifest = createStoreManifest(stores, legacyStores)
    void startupCheckpoint('backup:file-manifest')
    const fileManifest: BackupFileManifest = {
        included: [
            ...includedPayloadFiles(
                compositionDocument,
                stores,
                legacyStores,
                wildcardContent,
                assetProfileJson,
            ),
            ...(options.includedFiles ?? []).map(detachedJsonValue),
        ],
        excluded: [
            ...defaultExcludedFiles(),
            ...(options.excludedFiles ?? []).map(detachedJsonValue),
        ],
    }

    return {
        format: BACKUP_ENVELOPE_FORMAT,
        formatVersion: BACKUP_ENVELOPE_VERSION,
        createdAt: options.createdAt ?? new Date().toISOString(),
        appVersion: options.appVersion ?? CURRENT_APP_VERSION,
        ...(options.sourceCommit ? { sourceCommit: options.sourceCommit } : {}),
        compositionSchemaVersion: COMPOSITION_SCHEMA_VERSION,
        storeManifest,
        compositionDocument,
        stores,
        ...(Object.keys(legacyStores).length > 0 ? { legacyStores } : {}),
        ...(wildcardContent ? { wildcardContent } : {}),
        ...(assetProfileJson === undefined ? {} : { assetProfileJson }),
        ignoredLegacyKeys: uniqueSorted(ignoredKeys),
        fileManifest,
    }
}

function emptyRestoreReport(sourceFormat: BackupRestoreSourceFormat, sourceVersion: string | number): BackupRestoreDryRunReport {
    return {
        sourceFormat,
        sourceVersion,
        canRestore: true,
        manifestVerified: false,
        restoreKeys: [],
        ignoredKeys: [],
        wildcardContentCount: 0,
        errors: [],
        warnings: [],
        credentialReentryRequired: false,
    }
}

function readVersionMajor(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
    if (typeof value !== 'string') return null
    const match = /^(\d+)/.exec(value.trim())
    return match ? Number(match[1]) : null
}

function addStoreVersionIssue(
    report: BackupRestoreDryRunReport,
    key: string,
    field: 'version' | 'schemaVersion',
    actualValue: unknown,
    supported: number,
): void {
    const actual = readVersionMajor(actualValue)
    if (actual === null || actual <= supported) return
    if (report.errors.some(issue => issue.code === 'E_STORE_SCHEMA_NEWER' && issue.key === key)) return
    report.errors.push({
        code: 'E_STORE_SCHEMA_NEWER',
        key,
        message: `${key} ${field} ${String(actualValue)} is newer than supported ${field} ${supported}.`,
    })
}

function validateSupportedStoreVersion(
    report: BackupRestoreDryRunReport,
    key: string,
    value: unknown,
): void {
    const canonicalPolicyKey = LEGACY_STORE_VERSION_POLICY_ALIASES[key]
    const supported = SUPPORTED_BACKUP_STORE_VERSIONS[key]
        ?? (canonicalPolicyKey === undefined
            ? undefined
            : SUPPORTED_BACKUP_STORE_VERSIONS[canonicalPolicyKey])
        ?? (legacyStoreKeySet.has(key) ? SUPPORTED_AUXILIARY_LEGACY_STORE_VERSION : undefined)
    if (!supported) return
    if (supported.version !== undefined) {
        addStoreVersionIssue(report, key, 'version', storeVersion(value), supported.version)
    }
    if (supported.schemaVersion !== undefined) {
        addStoreVersionIssue(report, key, 'schemaVersion', storeSchemaVersion(value), supported.schemaVersion)
    }
}

function strictRepositoryRecord(
    report: BackupRestoreDryRunReport,
    value: unknown,
): CompositionRepositoryRecord | null {
    try {
        return parseCompositionRepositoryRecord(value)
    } catch (error) {
        const code = isRecord(error) && error.code === 'E_REPOSITORY_SCHEMA_NEWER'
            ? 'E_STORE_SCHEMA_NEWER'
            : 'E_COMPOSITION_REPOSITORY_INVALID'
        if (!report.errors.some(issue => issue.code === code && issue.key === COMPOSITION_REPOSITORY_STORE_KEY)) {
            report.errors.push({
                code,
                key: COMPOSITION_REPOSITORY_STORE_KEY,
                message: error instanceof Error
                    ? error.message
                    : 'Composition repository payload failed strict validation.',
            })
        }
        return null
    }
}

function sanitizedRepositoryRecord(
    repository: CompositionRepositoryRecord,
    document: CompositionDocument,
): CompositionRepositoryRecord {
    return createCommittedCompositionRepositoryRecord(document, {
        updatedAt: repository.updatedAt,
        authority: repository.authority,
        revision: repository.revision,
        migrationMarker: repository.migrationMarker,
    })
}

function addIgnoredKey(report: BackupRestoreDryRunReport, key: string, declared = false): void {
    if (!report.ignoredKeys.some(item => item.key === key)) {
        report.ignoredKeys.push(ignoredKeyReport(key, declared))
    }
}

function projectStoreForRestore(
    report: BackupRestoreDryRunReport,
    key: string,
    value: unknown,
): unknown {
    const projected = projectStoreForBackup(key, value, 'restore-preflight')
    if (projected.credentialReentryRequired) {
        report.credentialReentryRequired = true
        if (!report.warnings.some(issue => issue.code === 'W_AUTH_CREDENTIAL_REENTRY_REQUIRED')) {
            report.warnings.push({
                code: 'W_AUTH_CREDENTIAL_REENTRY_REQUIRED',
                key: AUTH_BACKUP_STORE_KEY,
                message: 'NovelAI credentials and runtime account data were sanitized; credential re-entry is required.',
            })
        }
    }
    return detachedJsonValue(projected.payload)
}

function prepareLegacyRestore(backup: Readonly<Record<string, unknown>>): PreparedBackupRestore {
    const sourceVersion = typeof backup._version === 'string' || typeof backup._version === 'number'
        ? backup._version
        : 'unknown'
    const report = emptyRestoreReport('legacy-v2', sourceVersion)
    const restorePayload: Record<string, unknown> = {
        _exportedAt: typeof backup._exportedAt === 'string' ? backup._exportedAt : new Date(0).toISOString(),
        _version: sourceVersion,
    }
    report.createdAt = typeof backup._exportedAt === 'string' ? backup._exportedAt : undefined

    const versionMajor = readVersionMajor(backup._version)
    if (versionMajor === null) {
        report.errors.push({ code: 'E_BACKUP_VERSION_MISSING', message: 'Legacy backup version is missing or invalid.' })
    } else if (versionMajor > 2) {
        report.errors.push({
            code: 'E_BACKUP_SCHEMA_NEWER',
            message: `Legacy backup schema ${String(backup._version)} is newer than supported schema 2.x.`,
        })
    }

    for (const [key, value] of Object.entries(backup)) {
        if (key.startsWith('_')) continue
        if (key === WILDCARD_CONTENT_KEY) {
            const wildcardContent = normalizeWildcardContent(value)
            if (!wildcardContent && isRecord(value) && Object.keys(value).length > 0) {
                report.errors.push({ code: 'E_WILDCARD_CONTENT_INVALID', key, message: 'Wildcard content must map IDs to string arrays.' })
                continue
            }
            if (wildcardContent) {
                restorePayload[key] = wildcardContent
                report.restoreKeys.push(key)
                report.wildcardContentCount = Object.keys(wildcardContent).length
            }
            continue
        }
        if (restoreStoreKeySet.has(key)) {
            validateSupportedStoreVersion(report, key, value)
            if (key === COMPOSITION_REPOSITORY_STORE_KEY) {
                const repository = strictRepositoryRecord(report, value)
                if (repository) {
                    const { staged: _staged, migrationLock: _migrationLock, ...safeRepository } = repository
                    restorePayload[key] = repository.committedDocument
                        ? sanitizedRepositoryRecord(repository, repository.committedDocument)
                        : detachedJsonValue(safeRepository)
                    report.restoreKeys.push(key)
                    if (repository.staged || repository.migrationLock) {
                        report.warnings.push({
                            code: 'W_COMPOSITION_REPOSITORY_TRANSIENT_STATE_IGNORED',
                            key,
                            message: 'Transient composition staging and migration lock state will not be restored.',
                        })
                    }
                }
            } else {
                restorePayload[key] = projectStoreForRestore(report, key, value)
                report.restoreKeys.push(key)
            }
        } else {
            addIgnoredKey(report, key)
        }
    }

    report.restoreKeys.sort((left, right) => left.localeCompare(right))
    report.ignoredKeys.sort((left, right) => left.key.localeCompare(right.key))
    report.canRestore = report.errors.length === 0
    return { report, restorePayload }
}

function parseManifestEntry(value: unknown): BackupStoreManifestEntry | null {
    if (!isRecord(value)
        || typeof value.key !== 'string'
        || (value.source !== 'store' && value.source !== 'legacy-store')
        || (value.schemaVersion !== null && typeof value.schemaVersion !== 'string' && typeof value.schemaVersion !== 'number')
        || (value.version !== null && typeof value.version !== 'string' && typeof value.version !== 'number')
        || typeof value.count !== 'number'
        || !Number.isInteger(value.count)
        || value.count < 0
        || !isBackupContentHash(value.hash)) {
        return null
    }
    return value as unknown as BackupStoreManifestEntry
}

function prepareEnvelopeRestore(
    envelope: Readonly<Record<string, unknown>>,
    options: PrepareBackupRestoreOptions,
): PreparedBackupRestore {
    const sourceVersion = typeof envelope.formatVersion === 'number' || typeof envelope.formatVersion === 'string'
        ? envelope.formatVersion
        : 'unknown'
    const report = emptyRestoreReport('envelope-v3', sourceVersion)
    const restorePayload: Record<string, unknown> = {
        _exportedAt: typeof envelope.createdAt === 'string' ? envelope.createdAt : new Date(0).toISOString(),
        _version: '3.0',
    }
    report.createdAt = typeof envelope.createdAt === 'string' ? envelope.createdAt : undefined

    if (typeof envelope.createdAt !== 'string' || !Number.isFinite(Date.parse(envelope.createdAt))) {
        report.errors.push({ code: 'E_BACKUP_CREATED_AT_INVALID', message: 'Backup createdAt must be a valid ISO timestamp.' })
    }
    if (typeof envelope.appVersion !== 'string' || envelope.appVersion.length === 0) {
        report.errors.push({ code: 'E_BACKUP_APP_VERSION_INVALID', message: 'Backup appVersion must be a non-empty string.' })
    }
    if (envelope.sourceCommit !== undefined && typeof envelope.sourceCommit !== 'string') {
        report.errors.push({ code: 'E_BACKUP_SOURCE_COMMIT_INVALID', message: 'Backup sourceCommit must be a string when present.' })
    }

    const formatVersion = typeof envelope.formatVersion === 'number' ? envelope.formatVersion : null
    if (formatVersion !== BACKUP_ENVELOPE_VERSION) {
        report.errors.push({
            code: formatVersion !== null && formatVersion > BACKUP_ENVELOPE_VERSION
                ? 'E_BACKUP_SCHEMA_NEWER'
                : 'E_BACKUP_FORMAT_VERSION_UNSUPPORTED',
            message: `Backup envelope version ${String(envelope.formatVersion)} is not supported.`,
        })
        report.canRestore = false
        return { report, restorePayload }
    }

    if (typeof envelope.compositionSchemaVersion !== 'number'
        || envelope.compositionSchemaVersion > COMPOSITION_SCHEMA_VERSION) {
        report.errors.push({
            code: 'E_COMPOSITION_SCHEMA_NEWER',
            message: `Composition schema ${String(envelope.compositionSchemaVersion)} is newer than supported schema ${COMPOSITION_SCHEMA_VERSION}.`,
        })
    } else if (envelope.compositionSchemaVersion !== COMPOSITION_SCHEMA_VERSION) {
        report.errors.push({
            code: 'E_COMPOSITION_SCHEMA_UNSUPPORTED',
            message: `Composition schema ${String(envelope.compositionSchemaVersion)} is not supported by this restore path.`,
        })
    }

    const parsedDocument = safeParseCompositionDocument(envelope.compositionDocument)
    if (!parsedDocument.success) {
        report.errors.push({
            code: 'E_COMPOSITION_DOCUMENT_INVALID',
            message: `CompositionDocument failed schema validation: ${parsedDocument.issues.map(issue => issue.code).join(', ')}`,
        })
    } else {
        report.compositionSchemaVersion = parsedDocument.data.schemaVersion
        const referenceIssues = blockingCompositionReferenceIssues(parsedDocument.data)
        if (referenceIssues.length > 0) {
            report.errors.push({
                code: 'E_COMPOSITION_REFERENCES_INVALID',
                message: compositionReferenceErrorMessage(referenceIssues),
            })
        }
    }

    const stores = isRecord(envelope.stores) ? envelope.stores : {}
    const legacyStores = envelope.legacyStores === undefined
        ? {}
        : isRecord(envelope.legacyStores)
            ? envelope.legacyStores
            : {}
    if (!isRecord(envelope.stores)) {
        report.errors.push({ code: 'E_STORE_PAYLOAD_INVALID', message: 'Envelope stores must be an object.' })
    }
    if (envelope.legacyStores !== undefined && !isRecord(envelope.legacyStores)) {
        report.errors.push({ code: 'E_LEGACY_STORE_PAYLOAD_INVALID', message: 'Envelope legacyStores must be an object.' })
    }

    const payloadEntries = new Map<string, { value: unknown; source: BackupStoreManifestEntry['source'] }>()
    for (const [key, value] of Object.entries(stores)) payloadEntries.set(key, { value, source: 'store' })
    for (const [key, value] of Object.entries(legacyStores)) {
        if (payloadEntries.has(key)) {
            report.errors.push({ code: 'E_STORE_KEY_DUPLICATE', key, message: 'Store key appears in both stores and legacyStores.' })
        } else {
            payloadEntries.set(key, { value, source: 'legacy-store' })
        }
    }

    const manifest = isRecord(envelope.storeManifest) ? envelope.storeManifest : null
    const manifestEntries: BackupStoreManifestEntry[] = []
    if (!manifest
        || manifest.schemaVersion !== BACKUP_STORE_MANIFEST_VERSION
        || !Array.isArray(manifest.entries)) {
        report.errors.push({ code: 'E_STORE_MANIFEST_INVALID', message: 'Store manifest is missing or unsupported.' })
    } else {
        for (const value of manifest.entries) {
            const entry = parseManifestEntry(value)
            if (!entry) {
                report.errors.push({ code: 'E_STORE_MANIFEST_ENTRY_INVALID', message: 'Store manifest contains an invalid entry.' })
            } else {
                manifestEntries.push(entry)
            }
        }

        const duplicateManifestKeys = manifestEntries
            .map(entry => entry.key)
            .filter((key, index, all) => all.indexOf(key) !== index)
        for (const key of uniqueSorted(duplicateManifestKeys)) {
            report.errors.push({ code: 'E_STORE_MANIFEST_KEY_DUPLICATE', key, message: 'Store manifest contains a duplicate key.' })
        }

        for (const entry of manifestEntries) {
            const payload = payloadEntries.get(entry.key)
            if (!payload) {
                report.errors.push({ code: 'E_STORE_MANIFEST_PAYLOAD_MISSING', key: entry.key, message: 'Manifest store payload is missing.' })
                continue
            }
            const actual = createBackupStoreManifestEntry(entry.key, payload.value, payload.source)
            if (actual.source !== entry.source
                || actual.schemaVersion !== entry.schemaVersion
                || actual.version !== entry.version
                || actual.count !== entry.count
                || !sameHash(actual.hash, entry.hash)) {
                report.errors.push({ code: 'E_STORE_MANIFEST_MISMATCH', key: entry.key, message: 'Store count, schema, source, or hash does not match its manifest.' })
            }
        }
        for (const key of payloadEntries.keys()) {
            if (!manifestEntries.some(entry => entry.key === key)) {
                report.errors.push({ code: 'E_STORE_MANIFEST_ENTRY_MISSING', key, message: 'Store payload has no manifest entry.' })
            }
        }

        const actualEntries = Array.from(payloadEntries.entries())
            .map(([key, payload]) => createBackupStoreManifestEntry(key, payload.value, payload.source))
            .sort((left, right) => left.key.localeCompare(right.key))
        if (manifest.storeCount !== actualEntries.length
            || manifest.totalRecordCount !== actualEntries.reduce((total, entry) => total + entry.count, 0)
            || !isBackupContentHash(manifest.hash)
            || !sameHash(contentHash(actualEntries), manifest.hash)) {
            report.errors.push({ code: 'E_STORE_MANIFEST_SUMMARY_MISMATCH', message: 'Store manifest summary count or hash does not match its payloads.' })
        }
        report.manifestVerified = report.errors.every(issue => !issue.code.startsWith('E_STORE_MANIFEST'))
    }

    for (const [key, payload] of payloadEntries) {
        if (restoreStoreKeySet.has(key)) {
            validateSupportedStoreVersion(report, key, payload.value)
            if (key !== COMPOSITION_REPOSITORY_STORE_KEY) {
                restorePayload[key] = projectStoreForRestore(report, key, payload.value)
                report.restoreKeys.push(key)
            }
        } else {
            addIgnoredKey(report, key)
        }
    }

    const repositoryPayload = payloadEntries.get(COMPOSITION_REPOSITORY_STORE_KEY)?.value
    if (repositoryPayload !== undefined) {
        const repository = strictRepositoryRecord(report, repositoryPayload)
        if (repository && parsedDocument.success) {
            if (repository.committedDocument
                && compositionDocumentHash(repository.committedDocument) !== compositionDocumentHash(parsedDocument.data)) {
                report.errors.push({
                    code: 'E_COMPOSITION_REPOSITORY_DOCUMENT_MISMATCH',
                    key: COMPOSITION_REPOSITORY_STORE_KEY,
                    message: 'Envelope CompositionDocument does not match the committed repository document.',
                })
            } else {
                restorePayload[COMPOSITION_REPOSITORY_STORE_KEY] = sanitizedRepositoryRecord(
                    repository,
                    parsedDocument.data,
                )
                report.restoreKeys.push(COMPOSITION_REPOSITORY_STORE_KEY)
                if (repository.staged || repository.migrationLock) {
                    report.warnings.push({
                        code: 'W_COMPOSITION_REPOSITORY_TRANSIENT_STATE_IGNORED',
                        key: COMPOSITION_REPOSITORY_STORE_KEY,
                        message: 'Transient composition staging and migration lock state will not be restored.',
                    })
                }
            }
        }
    }

    if (parsedDocument.success && repositoryPayload === undefined) {
        const repositoryFactory = options.createCompositionRepositoryRecord
            ?? createCommittedCompositionRepositoryRecord
        restorePayload[COMPOSITION_REPOSITORY_STORE_KEY] = repositoryFactory(
            parsedDocument.data,
            {
                updatedAt: typeof envelope.createdAt === 'string' ? envelope.createdAt : new Date(0).toISOString(),
                authority: 'v2',
            },
        )
        report.restoreKeys.push(COMPOSITION_REPOSITORY_STORE_KEY)
        report.warnings.push({
            code: 'W_COMPOSITION_REPOSITORY_SYNTHESIZED',
            key: COMPOSITION_REPOSITORY_STORE_KEY,
            message: 'Composition repository payload was reconstructed from the envelope document.',
        })
    }

    const wildcardContent = envelope.wildcardContent === undefined
        ? undefined
        : normalizeWildcardContent(envelope.wildcardContent)
    if (envelope.wildcardContent !== undefined && !wildcardContent) {
        const source = isRecord(envelope.wildcardContent) ? envelope.wildcardContent : null
        if (!source || Object.keys(source).length > 0) {
            report.errors.push({ code: 'E_WILDCARD_CONTENT_INVALID', key: WILDCARD_CONTENT_KEY, message: 'Wildcard content must map IDs to string arrays.' })
        }
    } else if (wildcardContent) {
        restorePayload[WILDCARD_CONTENT_KEY] = wildcardContent
        report.restoreKeys.push(WILDCARD_CONTENT_KEY)
        report.wildcardContentCount = Object.keys(wildcardContent).length
    }

    let assetProfileJson: string | undefined
    try {
        assetProfileJson = parseAssetProfileBackupJson(envelope.assetProfileJson)
        if (assetProfileJson !== undefined) report.restoreKeys.push(ASSET_PROFILE_FILE_RESTORE_KEY)
    } catch (error) {
        report.errors.push({
            code: String(error).includes('Unsupported Asset Profile schema')
                ? 'E_ASSET_PROFILE_SCHEMA_NEWER'
                : 'E_ASSET_PROFILE_FILE_INVALID',
            key: ASSET_PROFILE_FILE_RESTORE_KEY,
            message: error instanceof Error ? error.message : String(error),
        })
    }

    if (Array.isArray(envelope.ignoredLegacyKeys)) {
        if (!envelope.ignoredLegacyKeys.every(key => typeof key === 'string')) {
            report.errors.push({ code: 'E_IGNORED_KEYS_INVALID', message: 'ignoredLegacyKeys must contain only strings.' })
        }
        for (const key of envelope.ignoredLegacyKeys) {
            if (typeof key === 'string') addIgnoredKey(report, key, true)
        }
    } else {
        report.errors.push({ code: 'E_IGNORED_KEYS_INVALID', message: 'ignoredLegacyKeys must be an array of strings.' })
    }

    const knownEnvelopeKeys = new Set([
        'format', 'formatVersion', 'createdAt', 'appVersion', 'sourceCommit',
        'compositionSchemaVersion', 'storeManifest', 'compositionDocument', 'stores',
        'legacyStores', 'wildcardContent', 'assetProfileJson', 'ignoredLegacyKeys', 'fileManifest',
    ])
    for (const key of Object.keys(envelope)) {
        if (!knownEnvelopeKeys.has(key)) addIgnoredKey(report, `envelope.${key}`)
    }

    if (!isRecord(envelope.fileManifest)
        || !Array.isArray(envelope.fileManifest.included)
        || !Array.isArray(envelope.fileManifest.excluded)) {
        report.errors.push({ code: 'E_FILE_MANIFEST_INVALID', message: 'Included/excluded file manifest is missing or invalid.' })
    } else {
        const included = envelope.fileManifest.included
        const excluded = envelope.fileManifest.excluded
        const includedPaths = included
            .filter(isRecord)
            .map(entry => entry.path)
            .filter((path): path is string => typeof path === 'string')
        for (const path of uniqueSorted(includedPaths.filter((item, index) => includedPaths.indexOf(item) !== index))) {
            report.errors.push({ code: 'E_FILE_MANIFEST_PATH_DUPLICATE', key: path, message: 'Included file path appears more than once.' })
        }
        for (const entry of included) {
            if (!isRecord(entry)
                || typeof entry.path !== 'string'
                || typeof entry.kind !== 'string'
                || typeof entry.sizeBytes !== 'number'
                || !Number.isInteger(entry.sizeBytes)
                || entry.sizeBytes < 0
                || !isBackupContentHash(entry.hash)) {
                report.errors.push({ code: 'E_FILE_MANIFEST_ENTRY_INVALID', message: 'Included file manifest entry is invalid.' })
            }
        }
        for (const entry of excluded) {
            if (!isRecord(entry) || typeof entry.path !== 'string' || typeof entry.reason !== 'string') {
                report.errors.push({ code: 'E_FILE_MANIFEST_ENTRY_INVALID', message: 'Excluded file manifest entry is invalid.' })
            }
        }

        if (parsedDocument.success) {
            const expectedFiles = includedPayloadFiles(
                parsedDocument.data,
                stores,
                legacyStores,
                wildcardContent,
                assetProfileJson,
            )
            const expectedPaths = new Set(expectedFiles.map(entry => entry.path))
            for (const expected of expectedFiles) {
                const actual = included.find(entry => isRecord(entry) && entry.path === expected.path)
                if (!isRecord(actual)
                    || actual.kind !== expected.kind
                    || actual.sizeBytes !== expected.sizeBytes
                    || !isBackupContentHash(actual.hash)
                    || !sameHash(actual.hash, expected.hash)) {
                    report.errors.push({
                        code: 'E_FILE_MANIFEST_MISMATCH',
                        key: expected.path,
                        message: 'Included file size, type, or hash does not match its payload.',
                    })
                }
            }
            const isPayloadBackedPath = (path: string) => path === 'composition/document.json'
                || path === 'indexeddb/nai-blue-wildcard-content.json'
                || path === ASSET_PROFILE_FILE_PATH
                || path.startsWith('stores/')
                || path.startsWith('legacy-stores/')
            for (const entry of included) {
                if (isRecord(entry)
                    && typeof entry.path === 'string'
                    && isPayloadBackedPath(entry.path)
                    && !expectedPaths.has(entry.path)) {
                    report.errors.push({
                        code: 'E_FILE_MANIFEST_ORPHANED_ENTRY',
                        key: entry.path,
                        message: 'Included payload-backed file has no matching envelope payload.',
                    })
                }
            }
        }
    }

    report.restoreKeys = uniqueSorted(report.restoreKeys)
    report.ignoredKeys.sort((left, right) => left.key.localeCompare(right.key))
    report.canRestore = report.errors.length === 0
    return {
        report,
        restorePayload,
        ...(assetProfileJson === undefined ? {} : { assetProfileJson }),
    }
}

/** Pure pre-restore inspection. No storage write can occur through this API. */
export function prepareBackupRestore(
    backup: unknown,
    options: PrepareBackupRestoreOptions = {},
): PreparedBackupRestore {
    if (!isRecord(backup)) {
        const report = emptyRestoreReport('legacy-v2', 'unknown')
        report.canRestore = false
        report.errors.push({ code: 'E_BACKUP_NOT_OBJECT', message: 'Backup payload must be a JSON object.' })
        return { report, restorePayload: {} }
    }
    if (backup.format === BACKUP_ENVELOPE_FORMAT) return prepareEnvelopeRestore(backup, options)
    if ('format' in backup && backup.format !== undefined) {
        const report = emptyRestoreReport('envelope-v3', typeof backup.formatVersion === 'number' ? backup.formatVersion : 'unknown')
        report.canRestore = false
        report.errors.push({ code: 'E_BACKUP_FORMAT_UNSUPPORTED', message: `Unknown backup format: ${String(backup.format)}` })
        return { report, restorePayload: {} }
    }
    return prepareLegacyRestore(backup)
}

export function dryRunBackupRestore(
    backup: unknown,
    options: PrepareBackupRestoreOptions = {},
): BackupRestoreDryRunReport {
    return prepareBackupRestore(backup, options).report
}

function assertExternalRestoreCapabilities(
    prepared: Readonly<PreparedBackupRestore>,
    options: Readonly<RestoreBackupToStorageOptions>,
): void {
    const issues: BackupRestoreIssue[] = []

    if (Object.prototype.hasOwnProperty.call(prepared.restorePayload, WILDCARD_CONTENT_KEY)) {
        if (options.importWildcardContent === undefined) {
            issues.push({
                code: 'E_WILDCARD_RESTORE_WRITE_UNAVAILABLE',
                key: WILDCARD_CONTENT_KEY,
                message: 'Wildcard restore requires an atomic write capability.',
            })
        }
        if (options.readWildcardContent === undefined) {
            issues.push({
                code: 'E_WILDCARD_RESTORE_PREIMAGE_UNAVAILABLE',
                key: WILDCARD_CONTENT_KEY,
                message: 'Wildcard restore requires a readable pre-restore snapshot for rollback.',
            })
        }
    }

    if (prepared.assetProfileJson !== undefined) {
        if (options.restoreAssetProfileJson === undefined) {
            issues.push({
                code: 'E_ASSET_PROFILE_RESTORE_FINALIZE_UNAVAILABLE',
                key: ASSET_PROFILE_FILE_RESTORE_KEY,
                message: 'Asset Profile restore requires an exact file finalize capability.',
            })
        }
        if (options.rollbackAssetProfileJson === undefined) {
            issues.push({
                code: 'E_ASSET_PROFILE_RESTORE_ROLLBACK_UNAVAILABLE',
                key: ASSET_PROFILE_FILE_RESTORE_KEY,
                message: 'Asset Profile restore requires a captured preimage rollback capability.',
            })
        }
    }

    if (issues.length > 0) throw new BackupRestoreCapabilityError(issues)
}

/**
 * Port-based safe restore used by tests and migration tooling. The existing
 * importer only sees the allowlisted payload created by the dry-run.
 */
export async function restoreBackupToStorage(
    storage: BackupStoragePort,
    backup: unknown,
    options: RestoreBackupToStorageOptions = {},
): Promise<BackupRestoreResult> {
    const prepared = prepareBackupRestore(backup, options)
    if (!prepared.report.canRestore) throw new UnsupportedBackupSchemaError(prepared.report)
    assertExternalRestoreCapabilities(prepared, options)

    const result = await importBackupToStorage(storage, prepared.restorePayload, {
        overwrite: options.overwrite,
        flushStore: options.flushStore,
        importWildcardContent: options.importWildcardContent,
        readWildcardContent: options.readWildcardContent,
        ...(prepared.assetProfileJson === undefined
            ? {}
            : {
                finalizeKey: ASSET_PROFILE_FILE_RESTORE_KEY,
                finalizeRestore: () => options.restoreAssetProfileJson!(prepared.assetProfileJson!),
                rollbackFinalize: options.rollbackAssetProfileJson!,
            }),
    })
    const restoreResult = { ...result, report: prepared.report }
    if (restoreResult.failed.length > 0) throw new BackupRestoreWriteError(restoreResult)
    return restoreResult
}

function extractCompositionDocument(value: unknown): CompositionDocument | null {
    if (!isRecord(value)) return null
    const candidates = [
        value.committedDocument,
        isRecord(value.state) ? value.state.committedDocument : undefined,
        value.document,
    ]
    for (const candidate of candidates) {
        const parsed = safeParseCompositionDocument(candidate)
        if (parsed.success) return parsed.data
    }
    return null
}

export function extractCompositionDocumentFromBackup(rawBackup: Readonly<Record<string, unknown>>): CompositionDocument | null {
    return extractCompositionDocument(rawBackup[COMPOSITION_REPOSITORY_STORE_KEY])
        ?? extractCompositionDocument(rawBackup.compositionDocument)
}

export function mergeAllowlistedLegacyStorageEntries(
    rawBackup: Readonly<Record<string, unknown>>,
    readValue: (key: string) => string | null,
): Record<string, unknown> {
    const merged = { ...rawBackup }
    for (const key of LEGACY_BACKUP_STORE_KEYS) {
        if (merged[key] !== undefined) continue
        const raw = readValue(key)
        if (raw === null) continue
        try {
            merged[key] = JSON.parse(raw) as unknown
        } catch {
            merged[key] = raw
        }
    }
    return merged
}

function createEmptyCompositionDocument(createdAt: string): CompositionDocument {
    const actor: ActorRef = { kind: 'service', id: 'backup-envelope-v3' }
    return {
        schemaVersion: COMPOSITION_SCHEMA_VERSION,
        id: 'composition-document:empty-install',
        revision: 1,
        createdAt,
        createdBy: actor,
        updatedAt: createdAt,
        updatedBy: actor,
        profiles: [],
        modules: [],
        recipes: [],
        characters: [],
        paramsPresets: [],
        resources: [],
        randomRules: [],
    }
}

/** Browser/Tauri-neutral current authority export used by manual and disk backups. */
export async function createCurrentBackupEnvelopeV3(
    options: CreateCurrentBackupEnvelopeV3Options = {},
): Promise<BackupEnvelopeV3> {
    await startupCheckpoint('backup:export-stores')
    let rawBackup = await (options.readBackupData ?? (() => exportAllData({
        strict: true,
        purpose: options.purpose ?? 'manual-full',
    })))()
    await startupCheckpoint('backup:export-raw')
    const rawEntries = await (options.readRawIndexedEntries ?? exportRawIndexedDBEntries)()
    await startupCheckpoint('backup:merge-raw')
    for (const [key, raw] of Object.entries(rawEntries)) {
        if (rawBackup[key] !== undefined) continue
        try {
            rawBackup[key] = JSON.parse(raw) as unknown
        } catch {
            // Unknown data is still surfaced to ignoredLegacyKeys; it is never
            // made restorable merely because it existed in IndexedDB.
            rawBackup[key] = raw
        }
    }
    const readLegacyLocalValue = options.readLegacyLocalValue
        ?? (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function'
            ? (key: string) => localStorage.getItem(key)
            : undefined)
    if (readLegacyLocalValue !== undefined) {
        rawBackup = mergeAllowlistedLegacyStorageEntries(
            rawBackup,
            readLegacyLocalValue,
        )
    }
    const readLegacyLocalKeys = options.readLegacyLocalKeys
        ?? (typeof localStorage !== 'undefined'
            && typeof localStorage.key === 'function'
            && typeof localStorage.length === 'number'
            ? () => Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
                .filter((key): key is string => key !== null)
            : undefined)
    for (const key of readLegacyLocalKeys?.() ?? []) {
        if (isMarketplaceOrSupabaseKey(key) && rawBackup[key] === undefined) {
            // The key name is enough for an informational ignored report;
            // obsolete remote credentials are never embedded in the envelope.
            rawBackup[key] = { ignoredLegacyRemoteKey: true }
        }
    }
    const createdAt = options.createdAt ?? new Date().toISOString()
    const providedDocument = options.compositionDocument ?? await options.readCompositionDocument?.()
    const extractedDocument = extractCompositionDocumentFromBackup(rawBackup)
    const rawAssetProfile = await (options.readRawAssetProfile ?? loadRawAssetProfileFile)()
    const assetProfileJson = rawAssetProfile.exists && rawAssetProfile.rawJson !== null
        ? rawAssetProfile.rawJson
        : undefined
    const hasLegacyData = Object.keys(rawBackup).some(key => !key.startsWith('_'))
        || assetProfileJson !== undefined
    if (providedDocument === undefined && extractedDocument === null && hasLegacyData) {
        throw new Error('Cannot export legacy data without a committed CompositionDocument')
    }
    const compositionDocument = providedDocument
        ?? extractedDocument
        ?? createEmptyCompositionDocument(createdAt)
    await startupCheckpoint('backup:build-envelope')
    const envelope = createBackupEnvelopeV3(rawBackup, {
        compositionDocument,
        createdAt,
        appVersion: options.appVersion ?? CURRENT_APP_VERSION,
        sourceCommit: options.sourceCommit,
        assetProfileJson,
        purpose: options.purpose,
    })
    await startupCheckpoint('backup:envelope-ready')
    return envelope
}

function tsStamp(d = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export function formatAutoBackupTimestamp(timestamp: string): string {
    if (timestamp.length < 15) return timestamp
    return `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)} ${timestamp.slice(9, 11)}:${timestamp.slice(11, 13)}:${timestamp.slice(13, 15)}`
}

async function ensureBackupDir(): Promise<void> {
    if (!(await exists(BACKUP_ROOT, { baseDir: MEDIA_STORAGE_BASE_DIRECTORY }))) {
        await mkdir(BACKUP_ROOT, { baseDir: MEDIA_STORAGE_BASE_DIRECTORY, recursive: true })
    }
    if (!(await exists(FULL_BACKUP_DIR, { baseDir: MEDIA_STORAGE_BASE_DIRECTORY }))) {
        await mkdir(FULL_BACKUP_DIR, { baseDir: MEDIA_STORAGE_BASE_DIRECTORY, recursive: true })
    }
}

async function rotateFullBackups(): Promise<void> {
    const entries = await listFullAutoBackups()
    for (const entry of entries.slice(MAX_FULL_BACKUPS)) {
        try {
            await remove(entry.relPath, { baseDir: MEDIA_STORAGE_BASE_DIRECTORY })
        } catch (error) {
            console.warn('[AutoBackup] Failed to remove old disk snapshot:', entry.fileName, error)
        }
    }
}

function parseBackupEntry(fileName: string): FullAutoBackupEntry | null {
    if (!fileName.startsWith(`${FULL_BACKUP_PREFIX}_`) || !fileName.endsWith('.json')) return null
    const timestamp = fileName.slice(FULL_BACKUP_PREFIX.length + 1, -5)
    return { fileName, relPath: `${FULL_BACKUP_DIR}/${fileName}`, timestamp }
}

export async function listFullAutoBackups(): Promise<FullAutoBackupEntry[]> {
    if (!isTauri()) return []
    if (!(await exists(FULL_BACKUP_DIR, { baseDir: MEDIA_STORAGE_BASE_DIRECTORY }))) return []

    const entries = await readDir(FULL_BACKUP_DIR, { baseDir: MEDIA_STORAGE_BASE_DIRECTORY })
    return entries
        .map(entry => entry.name ? parseBackupEntry(entry.name) : null)
        .filter((entry): entry is FullAutoBackupEntry => entry !== null)
        .sort((left, right) => left.timestamp < right.timestamp ? 1 : -1)
}

export async function createFullAutoBackup(options: CreateFullAutoBackupOptions = {}): Promise<CreateFullAutoBackupResult> {
    if (!isTauri()) return { status: 'skipped', reason: 'not-tauri' }

    const now = Date.now()
    const minIntervalMs = options.minIntervalMs ?? 24 * 60 * 60 * 1000
    const lastBackup = Number(localStorage.getItem(DISK_AUTO_BACKUP_LAST_KEY) ?? 0)
    if (!options.force && Number.isFinite(lastBackup) && now - lastBackup < minIntervalMs) {
        return {
            status: 'skipped',
            reason: 'interval',
            nextBackupAt: new Date(lastBackup + minIntervalMs).toISOString(),
        }
    }

    await ensureBackupDir()
    const createdAt = new Date(now).toISOString()
    const backup = await createCurrentBackupEnvelopeV3({
        compositionDocument: options.compositionDocument,
        readCompositionDocument: options.readCompositionDocument,
        createdAt,
        appVersion: options.appVersion,
        sourceCommit: options.sourceCommit,
        purpose: 'disk-auto',
    })
    const timestamp = tsStamp(new Date(now))
    const fileName = `${FULL_BACKUP_PREFIX}_${timestamp}.json`
    const relPath = `${FULL_BACKUP_DIR}/${fileName}`

    await startupCheckpoint('backup:serialize-json')
    const serialized = JSON.stringify(backup, null, 2)
    await startupCheckpoint('backup:write-file')
    await writeUtf8TextFile(relPath, serialized, { baseDir: MEDIA_STORAGE_BASE_DIRECTORY })
    await startupCheckpoint('backup:file-written')
    localStorage.setItem(DISK_AUTO_BACKUP_LAST_KEY, String(now))
    localStorage.setItem('nai-blue-last-disk-auto-backup-file', relPath)
    await rotateFullBackups()

    return {
        status: 'created',
        entry: { fileName, relPath, timestamp, exportedAt: backup.createdAt },
        storeCount: backup.storeManifest.storeCount,
    }
}

async function readBackupFile(fileRelPath: string): Promise<unknown> {
    const bytes = await readFile(fileRelPath, { baseDir: MEDIA_STORAGE_BASE_DIRECTORY })
    return JSON.parse(decoder.decode(bytes)) as unknown
}

export async function dryRunFullAutoBackup(
    fileRelPath: string,
    options: PrepareBackupRestoreOptions = {},
): Promise<BackupRestoreDryRunReport> {
    if (!isTauri()) throw new Error('Disk auto-backup restore is only available in the Tauri app.')
    return dryRunBackupRestore(await readBackupFile(fileRelPath), options)
}

export async function restoreFullAutoBackup(
    fileRelPath: string,
    options: PrepareBackupRestoreOptions = {},
): Promise<BackupRestoreResult> {
    if (!isTauri()) throw new Error('Disk auto-backup restore is only available in the Tauri app.')

    const prepared = prepareBackupRestore(await readBackupFile(fileRelPath), options)
    if (!prepared.report.canRestore) throw new UnsupportedBackupSchemaError(prepared.report)
    const assetPreimage = prepared.assetProfileJson === undefined
        ? undefined
        : await loadRawAssetProfileFile()
    const result = await importAllData(prepared.restorePayload, true, {
        ...(prepared.assetProfileJson === undefined
            ? {}
            : {
                finalizeKey: ASSET_PROFILE_FILE_RESTORE_KEY,
                finalizeRestore: () => restoreRawAssetProfileFile(prepared.assetProfileJson!),
                rollbackFinalize: () => restoreRawAssetProfileFilePreimage(assetPreimage!),
            }),
    })
    await flushAllPendingWrites()
    const restoreResult = { ...result, report: prepared.report }
    if (restoreResult.failed.length > 0) throw new BackupRestoreWriteError(restoreResult)
    return restoreResult
}
