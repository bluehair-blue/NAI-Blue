import { exists, mkdir, readDir, remove } from '@tauri-apps/plugin-fs'
import { readBackupJson } from './read-backup-stream'
import { writeBackupWithWorker } from './write-backup-worker'
import { isTauri } from '@tauri-apps/api/core'
import {
    BACKUP_STORE_KEYS,
    flushAllPendingWrites,
    importAllData,
    registerIndexedDBWriteListener,
    type BackupStoreKey,
} from '@/lib/indexed-db'
import {
    createBackupStoreManifestEntry,
    prepareBackupRestore,
    UnsupportedBackupSchemaError,
    type BackupRestoreDryRunReport,
    type BackupRestoreResult,
    type PrepareBackupRestoreOptions,
    type PreparedBackupRestore,
} from '@/lib/auto-backup'
import { projectStoreForBackup } from '@/lib/backup-projection'
import { MEDIA_STORAGE_BASE_DIRECTORY } from '@/platform/storage'

const BACKUP_ROOT = 'NAI_Blue_Backup'
const DEBOUNCE_MS = 5000
const MAX_SNAPSHOTS_PER_STORE = 30
const STORE_SNAPSHOT_VERSION = 'store-snapshot/2'
const SUPPORTED_STORE_SNAPSHOT_VERSIONS = new Set(['store-snapshot/1', STORE_SNAPSHOT_VERSION])

export interface StoreSnapshotEntry {
    storeKey: BackupStoreKey
    fileName: string
    relPath: string
    timestamp: string
    exportedAt?: string
}

export interface StoreSnapshotGroup {
    storeKey: BackupStoreKey
    entries: StoreSnapshotEntry[]
}

const timers = new Map<BackupStoreKey, ReturnType<typeof setTimeout>>()
const inflight = new Set<BackupStoreKey>()
const pendingAfterInflight = new Set<BackupStoreKey>()

let stopScheduler: (() => void) | null = null

function isBackupStoreKey(key: string): key is BackupStoreKey {
    return (BACKUP_STORE_KEYS as readonly string[]).includes(key)
}

function tsStamp(d = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export function formatStoreSnapshotTimestamp(timestamp: string): string {
    if (timestamp.length < 15) return timestamp
    return `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)} ${timestamp.slice(9, 11)}:${timestamp.slice(11, 13)}:${timestamp.slice(13, 15)}`
}

function storeSnapshotDir(storeKey: BackupStoreKey): string {
    return `${BACKUP_ROOT}/${storeKey}`
}

async function ensureStoreSnapshotDir(storeKey: BackupStoreKey): Promise<void> {
    if (!(await exists(BACKUP_ROOT, { baseDir: MEDIA_STORAGE_BASE_DIRECTORY }))) {
        await mkdir(BACKUP_ROOT, { baseDir: MEDIA_STORAGE_BASE_DIRECTORY, recursive: true })
    }

    const dirRel = storeSnapshotDir(storeKey)
    if (!(await exists(dirRel, { baseDir: MEDIA_STORAGE_BASE_DIRECTORY }))) {
        await mkdir(dirRel, { baseDir: MEDIA_STORAGE_BASE_DIRECTORY, recursive: true })
    }
}

function parseStoreSnapshotEntry(storeKey: BackupStoreKey, fileName: string): StoreSnapshotEntry | null {
    if (!fileName.startsWith(`${storeKey}_`) || !fileName.endsWith('.json')) {
        return null
    }

    const timestamp = fileName.slice(storeKey.length + 1, -5)
    return {
        storeKey,
        fileName,
        relPath: `${storeSnapshotDir(storeKey)}/${fileName}`,
        timestamp,
    }
}

async function rotateStoreSnapshots(storeKey: BackupStoreKey): Promise<void> {
    const entries = await listStoreSnapshotEntries(storeKey)
    for (const entry of entries.slice(MAX_SNAPSHOTS_PER_STORE)) {
        try {
            await remove(entry.relPath, { baseDir: MEDIA_STORAGE_BASE_DIRECTORY })
        } catch (error) {
            console.warn('[StoreSnapshot] Failed to remove old snapshot:', entry.fileName, error)
        }
    }
}

async function listStoreSnapshotEntries(storeKey: BackupStoreKey): Promise<StoreSnapshotEntry[]> {
    const dirRel = storeSnapshotDir(storeKey)
    if (!(await exists(dirRel, { baseDir: MEDIA_STORAGE_BASE_DIRECTORY }))) return []

    const entries = await readDir(dirRel, { baseDir: MEDIA_STORAGE_BASE_DIRECTORY })
    return entries
        .map((entry) => entry.name ? parseStoreSnapshotEntry(storeKey, entry.name) : null)
        .filter((entry): entry is StoreSnapshotEntry => entry !== null)
        .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
}

async function writeStoreSnapshot(storeKey: BackupStoreKey): Promise<StoreSnapshotEntry | null> {
    await flushAllPendingWrites()

    await ensureStoreSnapshotDir(storeKey)

    const exportedAt = new Date().toISOString()
    const timestamp = tsStamp()
    const fileName = `${storeKey}_${timestamp}.json`
    const relPath = `${storeSnapshotDir(storeKey)}/${fileName}`

    await writeBackupWithWorker(relPath, { kind: 'store', storeKey, createdAt: exportedAt },
        { baseDir: MEDIA_STORAGE_BASE_DIRECTORY })
    await rotateStoreSnapshots(storeKey)

    return { storeKey, fileName, relPath, timestamp, exportedAt }
}

export function createStoreSnapshotBackup(
    storeKey: BackupStoreKey,
    persistedPayload: unknown,
    exportedAt = new Date().toISOString(),
): Record<string, unknown> {
    const projectedPayload = projectStoreForBackup(
        storeKey,
        persistedPayload,
        'store-snapshot',
    ).payload
    return {
        _exportedAt: exportedAt,
        _version: STORE_SNAPSHOT_VERSION,
        _kind: 'store-snapshot',
        _storeKey: storeKey,
        _manifest: createBackupStoreManifestEntry(storeKey, projectedPayload),
        [storeKey]: projectedPayload,
    }
}

function scheduleStoreSnapshot(storeKey: BackupStoreKey): void {
    const existing = timers.get(storeKey)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
        timers.delete(storeKey)
        void flushStoreSnapshot(storeKey)
    }, DEBOUNCE_MS)

    timers.set(storeKey, timer)
}

export async function flushStoreSnapshot(storeKey: BackupStoreKey): Promise<StoreSnapshotEntry | null> {
    const existing = timers.get(storeKey)
    if (existing) {
        clearTimeout(existing)
        timers.delete(storeKey)
    }

    if (inflight.has(storeKey)) {
        pendingAfterInflight.add(storeKey)
        return null
    }

    inflight.add(storeKey)
    try {
        return await writeStoreSnapshot(storeKey)
    } catch (error) {
        console.error(`[StoreSnapshot] ${storeKey} snapshot failed:`, error)
        return null
    } finally {
        inflight.delete(storeKey)
        if (pendingAfterInflight.delete(storeKey)) {
            scheduleStoreSnapshot(storeKey)
        }
    }
}

export function startStoreSnapshotScheduler(): () => void {
    if (stopScheduler) return stopScheduler
    if (!isTauri()) return () => {}

    const unregister = registerIndexedDBWriteListener((key) => {
        if (isBackupStoreKey(key)) {
            scheduleStoreSnapshot(key)
        }
    })

    const flushPendingTimers = () => {
        for (const storeKey of timers.keys()) {
            void flushStoreSnapshot(storeKey)
        }
    }

    if (typeof window !== 'undefined') {
        window.addEventListener('beforeunload', flushPendingTimers)
    }

    stopScheduler = () => {
        unregister()
        if (typeof window !== 'undefined') {
            window.removeEventListener('beforeunload', flushPendingTimers)
        }
        for (const timer of timers.values()) {
            clearTimeout(timer)
        }
        timers.clear()
        stopScheduler = null
    }

    return stopScheduler
}

export async function listStoreSnapshots(): Promise<StoreSnapshotGroup[]> {
    if (!isTauri()) return []

    const groups: StoreSnapshotGroup[] = []
    for (const storeKey of BACKUP_STORE_KEYS) {
        try {
            const entries = await listStoreSnapshotEntries(storeKey)
            if (entries.length > 0) {
                groups.push({ storeKey, entries })
            }
        } catch (error) {
            console.warn(`[StoreSnapshot] Failed to list ${storeKey}:`, error)
        }
    }

    return groups
}

export async function restoreStoreSnapshot(
    storeKey: BackupStoreKey,
    fileRelPath: string,
    options: PrepareBackupRestoreOptions = {},
): Promise<BackupRestoreResult> {
    if (!isTauri()) {
        throw new Error('Store snapshot restore is only available in the Tauri app.')
    }

    const backup = await readBackupJson(fileRelPath, { baseDir: MEDIA_STORAGE_BASE_DIRECTORY })
    const prepared = prepareStoreSnapshotRestore(storeKey, backup, options)
    if (!prepared.report.canRestore) throw new UnsupportedBackupSchemaError(prepared.report)

    const result = await importAllData(prepared.restorePayload, true)
    await flushAllPendingWrites()
    return { ...result, report: prepared.report }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Pure store-snapshot preflight. Only the explicitly selected registry key is
 * projected into the generic restore payload; every other raw key is ignored.
 */
export function prepareStoreSnapshotRestore(
    storeKey: BackupStoreKey,
    backup: unknown,
    options: PrepareBackupRestoreOptions = {},
): PreparedBackupRestore {
    const exportedAt = isRecord(backup) && typeof backup._exportedAt === 'string'
        ? backup._exportedAt
        : new Date(0).toISOString()
    const safeBackup: Record<string, unknown> = {
        _exportedAt: exportedAt,
        _version: '2.3',
    }
    if (isRecord(backup) && storeKey in backup) safeBackup[storeKey] = backup[storeKey]

    const prepared = prepareBackupRestore(safeBackup, options)
    if (!isRecord(backup)) {
        prepared.report.errors.push({ code: 'E_STORE_SNAPSHOT_NOT_OBJECT', message: 'Store snapshot must be a JSON object.' })
    } else {
        if (backup._kind !== 'store-snapshot'
            || typeof backup._version !== 'string'
            || !SUPPORTED_STORE_SNAPSHOT_VERSIONS.has(backup._version)) {
            prepared.report.errors.push({
                code: 'E_STORE_SNAPSHOT_VERSION_UNSUPPORTED',
                message: `Store snapshot version ${String(backup._version)} is not supported.`,
            })
        }
        if (backup._storeKey !== undefined && backup._storeKey !== storeKey) {
            prepared.report.errors.push({
                code: 'E_STORE_SNAPSHOT_KEY_MISMATCH',
                key: storeKey,
                message: `Snapshot belongs to ${String(backup._storeKey)}, not ${storeKey}.`,
            })
        }
        if (!(storeKey in backup)) {
            prepared.report.errors.push({
                code: 'E_STORE_SNAPSHOT_PAYLOAD_MISSING',
                key: storeKey,
                message: 'Selected store payload is missing from the snapshot.',
            })
        }

        if (backup._version === STORE_SNAPSHOT_VERSION) {
            const actual = createBackupStoreManifestEntry(storeKey, backup[storeKey])
            const manifest = backup._manifest
            if (!isRecord(manifest)
                || manifest.key !== actual.key
                || manifest.schemaVersion !== actual.schemaVersion
                || manifest.version !== actual.version
                || manifest.count !== actual.count
                || !isRecord(manifest.hash)
                || manifest.hash.algorithm !== actual.hash.algorithm
                || manifest.hash.canonicalization !== actual.hash.canonicalization
                || manifest.hash.digest !== actual.hash.digest) {
                prepared.report.errors.push({
                    code: 'E_STORE_SNAPSHOT_MANIFEST_MISMATCH',
                    key: storeKey,
                    message: 'Store snapshot count, schema, or hash does not match its payload.',
                })
            } else {
                prepared.report.manifestVerified = true
            }
        }
    }
    prepared.report.canRestore = prepared.report.errors.length === 0
    return prepared
}

export async function dryRunStoreSnapshot(
    storeKey: BackupStoreKey,
    fileRelPath: string,
    options: PrepareBackupRestoreOptions = {},
): Promise<BackupRestoreDryRunReport> {
    if (!isTauri()) throw new Error('Store snapshot restore is only available in the Tauri app.')
    return prepareStoreSnapshotRestore(storeKey,
        await readBackupJson(fileRelPath, { baseDir: MEDIA_STORAGE_BASE_DIRECTORY }), options).report
}
