import { StateStorage } from 'zustand/middleware'
import {
    projectStoreForBackup,
    type BackupProjectionPurpose,
} from '@/lib/backup-projection'
import {
    PersistenceFault,
    toPersistenceFault,
    type PersistenceCriticality,
    type PersistenceFaultKind,
} from '@/domain/persistence/fault'
import { reportDiagnostic, reportPersistenceFault } from '@/services/diagnostics/error-registry'
import { STYLE_LAB_REPOSITORY_STORE_KEY } from '@/domain/style-lab/persistence'
import { WORKFLOW_DRAFT_STORE_KEY } from '@/domain/workflow/single-image-draft'
// Since I cannot install packages, I will implement a minimal wrapper similar to idb-keyval logic
// or I can implement a raw IndexedDB wrapper.
// Given constraints, raw IndexedDB is safer as strict dependency rules apply.

const DB_NAME = 'nai-blue-db'
const STORE_NAME = 'keyval'
const DB_TIMEOUT_MS = 10000 // 10초 타임아웃

export const STRUCTURED_PROMPT_MODULE_STORE_KEY = 'nai-blue-structured-prompt-modules' as const
export const SCENE_DOCUMENT_STORE_KEY = 'nai-blue-scene-documents' as const
export const FOLDER_DOCUMENT_STORE_KEY = 'nai-blue-generation-folder-documents' as const
export const SCENE_AUTHORITY_MARKER_STORE_KEY = 'nai-blue-scene-authority' as const
export const SCENE_PRESENTATION_STORE_KEY = 'nai-blue-scene-presentation' as const
/** Device-local opaque path tokens are deliberately excluded from backup/export keys. */
export const SCENE_OUTPUT_PORTABLE_TOKEN_STORE_KEY = 'nai-blue-scene-output-portable-tokens' as const
export const FOLDER_V1_PREIMAGE_STORE_KEY = 'nai-blue-generation-folder-v1-preimage' as const
export const FOLDER_AUTHORITY_MARKER_STORE_KEY = 'nai-blue-generation-folder-authority' as const

// Central backup registry used by full exports, size diagnostics, and the
// store snapshot layer so new persisted stores are added in one place.
export const BACKUP_STORE_KEYS = [
    'nai-blue-generation',
    'nai-blue-character-store',
    'nai-blue-character-prompts',
    'nai-blue-presets',
    'nai-blue-settings',
    'nai-blue-auth',
    'nai-blue-scenes',
    SCENE_DOCUMENT_STORE_KEY,
    SCENE_AUTHORITY_MARKER_STORE_KEY,
    SCENE_PRESENTATION_STORE_KEY,
    FOLDER_DOCUMENT_STORE_KEY,
    FOLDER_V1_PREIMAGE_STORE_KEY,
    FOLDER_AUTHORITY_MARKER_STORE_KEY,
    'nai-blue-character-rotation',
    'nai-blue-shortcuts',
    'nai-blue-theme',
    'nai-blue-wildcards',
    'nai-blue-prompt-library',
    STRUCTURED_PROMPT_MODULE_STORE_KEY,
    'nai-blue-layout',
    'nai-blue-library',
    'nai-blue-tools',
    'nai-blue-update',
    'nai-blue-style-lab',
    STYLE_LAB_REPOSITORY_STORE_KEY,
    'nai-blue-asset-modules',
    'nai-blue-composition-repository',
    'nai-blue-composition-migration-backup',
    WORKFLOW_DRAFT_STORE_KEY,
] as const

export type BackupStoreKey = typeof BACKUP_STORE_KEYS[number]

export const LEGACY_BACKUP_STORE_KEYS = [] as const

export const FULL_BACKUP_STORE_KEYS = [
    ...BACKUP_STORE_KEYS,
    ...LEGACY_BACKUP_STORE_KEYS,
] as const

// IndexedDB 초기화 실패 추적
let dbInitFailed = false
let dbInitError: Error | null = null

// 지연 초기화 - 모듈 로드 시점이 아닌 첫 사용 시점에 초기화
let dbPromise: Promise<IDBDatabase> | null = null
let activeDb: IDBDatabase | null = null

const BEST_EFFORT_PERSISTENCE_KEYS = new Set([
    'nai-blue-layout',
    'nai-blue-theme',
    'nai-blue-shortcuts',
    'nai-blue-tools',
    'nai-blue-update',
])

export const CRITICAL_PERSISTENCE_KEYS = Object.freeze([
    'nai-blue-auth',
    'nai-blue-auth-v3-migration-complete',
    'nai-blue-scenes',
    SCENE_DOCUMENT_STORE_KEY,
    SCENE_AUTHORITY_MARKER_STORE_KEY,
    SCENE_PRESENTATION_STORE_KEY,
    SCENE_OUTPUT_PORTABLE_TOKEN_STORE_KEY,
    FOLDER_DOCUMENT_STORE_KEY,
    FOLDER_V1_PREIMAGE_STORE_KEY,
    FOLDER_AUTHORITY_MARKER_STORE_KEY,
    'nai-blue-composition-repository',
    'nai-blue-composition-migration-backup',
    'nai-blue-backup-restore-journal',
    'nai-blue-queue-repository',
    STYLE_LAB_REPOSITORY_STORE_KEY,
    WORKFLOW_DRAFT_STORE_KEY,
] as const)

export function getPersistenceCriticality(name: string): PersistenceCriticality {
    return BEST_EFFORT_PERSISTENCE_KEYS.has(name) ? 'best-effort' : 'critical'
}

function persistenceFault(
    error: unknown,
    operation: string,
    storeKey?: string,
    kind?: PersistenceFaultKind,
): PersistenceFault {
    return toPersistenceFault(error, {
        operation,
        ...(storeKey === undefined ? {} : { storeKey }),
        criticality: storeKey === undefined ? 'critical' : getPersistenceCriticality(storeKey),
        ...(kind === undefined ? {} : { kind }),
    })
}

function markDbInitializationFailed(error: PersistenceFault): PersistenceFault {
    dbInitFailed = true
    dbInitError = error
    return error
}

function getDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise
    
    // 이전에 초기화 실패했으면 즉시 reject
    if (dbInitFailed) {
        return Promise.reject(dbInitError || new Error('IndexedDB initialization previously failed'))
    }
    
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        let settled = false
        let timeoutId: ReturnType<typeof setTimeout> | undefined
        const finishResolve = (db: IDBDatabase) => {
            if (settled) {
                db.onclose = null
                db.close()
                return
            }
            settled = true
            if (timeoutId !== undefined) clearTimeout(timeoutId)
            activeDb = db
            resolve(db)
        }
        const finishReject = (error: unknown, kind: PersistenceFaultKind = 'database-unavailable') => {
            if (settled) return
            settled = true
            if (timeoutId !== undefined) clearTimeout(timeoutId)
            reject(markDbInitializationFailed(persistenceFault(error, 'persistence.initialize', undefined, kind)))
        }

        // IndexedDB 지원 체크
        if (typeof indexedDB === 'undefined') {
            finishReject(new Error('IndexedDB is not supported in this environment'))
            return
        }
        
        // 타임아웃 설정 - DB 열기가 무한 대기되는 것 방지
        timeoutId = setTimeout(() => {
            finishReject(new Error(`IndexedDB open timed out after ${DB_TIMEOUT_MS}ms`), 'operation-timeout')
        }, DB_TIMEOUT_MS)
        
        try {
            const request = indexedDB.open(DB_NAME, 1)
            
            request.onupgradeneeded = (event) => {
                try {
                    const db = (event.target as IDBOpenDBRequest).result
                    if (!db.objectStoreNames.contains(STORE_NAME)) {
                        db.createObjectStore(STORE_NAME)
                    }
                } catch (err) {
                    request.transaction?.abort()
                    finishReject(err, 'transaction-aborted')
                }
            }
            
            request.onsuccess = () => {
                const db = request.result
                
                // DB 연결 끊김 감지
                db.onclose = () => {
                    console.warn('[IndexedDB] Database connection closed unexpectedly')
                    if (activeDb === db) activeDb = null
                    dbPromise = null // 다음 요청 시 재연결 시도
                }
                
                db.onerror = (event) => {
                    console.error('[IndexedDB] Database error:', event)
                }
                
                console.log('[IndexedDB] Database opened successfully')
                finishResolve(db)
            }
            
            request.onerror = () => {
                finishReject(request.error || new Error('Failed to open IndexedDB'))
            }
            
            request.onblocked = () => {
                console.warn('[IndexedDB] Database blocked - another connection is open')
                finishReject(new Error('IndexedDB open blocked by another connection'), 'database-blocked')
            }
        } catch (err) {
            finishReject(err)
        }
    })
    
    return dbPromise
}

// DB 초기화 상태 확인용 (마이그레이션 전 체크용)
export async function ensureDbReady(): Promise<boolean> {
    try {
        await getDb()
        return true
    } catch (err) {
        console.error('[IndexedDB] ensureDbReady failed:', err)
        return false
    }
}

// DB 초기화 실패 여부 확인
export function isDbInitFailed(): boolean {
    return dbInitFailed
}

const OPERATION_TIMEOUT_MS = 5000 // 개별 작업 타임아웃

// ============================================
// Debounced Write System
// Zustand persist calls setItem on EVERY state change.
// Without debouncing, typing a single character triggers full JSON.stringify + IndexedDB write.
// With thousands of scene images, each write serializes megabytes of data.
// ============================================
const WRITE_DEBOUNCE_MS: Record<string, number> = {
    'nai-blue-layout': 500,
    'nai-blue-theme': 500,
    'nai-blue-shortcuts': 750,
    'nai-blue-tools': 750,
    'nai-blue-update': 750,
}
const DEFAULT_WRITE_DEBOUNCE = 500
const MAX_WRITE_INTERVAL = 10000   // Force write at least every 10 seconds even during rapid changes

const pendingWriteTimers = new Map<string, ReturnType<typeof setTimeout>>()
const pendingWriteValues = new Map<string, string>()
const lastWriteTime = new Map<string, number>()
const indexedDBWriteListeners = new Set<(key: string) => void>()
const inFlightWrites = new Map<Promise<void>, string>()
const writeTails = new Map<string, Promise<void>>()
let tauriCloseFlushInstalled = false
let tauriCloseFlushInProgress = false
let tauriCloseFlushCompleted = false

export function registerIndexedDBWriteListener(listener: (key: string) => void): () => void {
    indexedDBWriteListeners.add(listener)
    return () => indexedDBWriteListeners.delete(listener)
}

function notifyIndexedDBWrite(key: string): void {
    for (const listener of indexedDBWriteListeners) {
        try {
            listener(key)
        } catch (error) {
            console.warn(`[IndexedDB] write listener failed for ${key}:`, error)
        }
    }
}

/** Write directly to IndexedDB (no debounce) */
async function rawSetItem(name: string, value: string): Promise<void> {
    try {
        const db = await getDb()
        await new Promise<void>((resolve, reject) => {
            let settled = false
            let transaction: IDBTransaction | undefined
            const finishResolve = () => {
                if (settled) return
                settled = true
                clearTimeout(timeoutId)
                resolve()
            }
            const finishReject = (error: unknown, kind?: PersistenceFaultKind) => {
                if (settled) return
                settled = true
                clearTimeout(timeoutId)
                reject(persistenceFault(error, 'persistence.write', name, kind))
            }
            const timeoutId = setTimeout(() => {
                try { transaction?.abort() } catch { /* timeout remains authoritative */ }
                finishReject(new Error(`setItem timed out for key: ${name}`), 'operation-timeout')
            }, OPERATION_TIMEOUT_MS)

            try {
                transaction = db.transaction(STORE_NAME, 'readwrite')

                transaction.onerror = () => {
                    finishReject(transaction?.error ?? new Error(`setItem transaction failed for ${name}`))
                }

                transaction.onabort = () => {
                    finishReject(transaction?.error ?? new Error(`setItem transaction aborted for ${name}`), 'transaction-aborted')
                }

                transaction.oncomplete = finishResolve

                const store = transaction.objectStore(STORE_NAME)
                const request = store.put(value, name)

                request.onerror = () => {
                    finishReject(request.error ?? new Error(`setItem request failed for ${name}`))
                }
            } catch (err) {
                finishReject(err)
            }
        })
    } catch (err) {
        throw persistenceFault(err, 'persistence.write', name)
    }
}

function enqueueTrackedWrite<T>(name: string, write: () => Promise<T>): Promise<T> {
    const previous = writeTails.get(name) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(write)
    const completion = result.then(() => undefined)
    void completion.catch(() => undefined)
    writeTails.set(name, completion)
    inFlightWrites.set(completion, name)
    const cleanup = () => {
        inFlightWrites.delete(completion)
        if (writeTails.get(name) === completion) writeTails.delete(name)
    }
    completion.then(cleanup, cleanup)
    return result
}

function reportWriteFault(error: unknown, name: string, stage: string): PersistenceFault {
    const fault = persistenceFault(error, 'persistence.write', name)
    reportPersistenceFault(fault, { stage })
    return fault
}

/** Flush a single pending write immediately */
async function flushKey(name: string): Promise<void> {
    const timer = pendingWriteTimers.get(name)
    if (timer) {
        clearTimeout(timer)
        pendingWriteTimers.delete(name)
    }
    const value = pendingWriteValues.get(name)
    if (value !== undefined) {
        try {
            await enqueueTrackedWrite(name, () => rawSetItem(name, value))
            if (pendingWriteValues.get(name) === value) pendingWriteValues.delete(name)
            lastWriteTime.set(name, Date.now())
            notifyIndexedDBWrite(name)
        } catch (error) {
            throw reportWriteFault(error, name, 'debounced-flush')
        }
        return
    }
    await writeTails.get(name)
}

export interface PersistenceFlushFailure {
    key: string
    fault: PersistenceFault
}

export class PersistenceFlushError extends Error {
    constructor(readonly failures: PersistenceFlushFailure[]) {
        super(`Failed to flush ${failures.length} IndexedDB store${failures.length === 1 ? '' : 's'}.`)
        this.name = 'PersistenceFlushError'
    }
}

function collectFlushFailures(
    failures: Map<string, PersistenceFlushFailure>,
    keys: readonly string[],
    results: readonly PromiseSettledResult<void>[],
): void {
    results.forEach((result, index) => {
        if (result.status === 'fulfilled') return
        const key = keys[index]
        const fault = persistenceFault(result.reason, 'persistence.flush', key, 'flush-failed')
        failures.set(`${key}:${fault.code}`, { key, fault })
    })
}

/** Flush ALL pending writes and throw a keyed failure list if any commit fails. */
export async function flushAllPendingWrites(): Promise<void> {
    const keys = new Set([...pendingWriteTimers.keys(), ...pendingWriteValues.keys()])
    const failures = new Map<string, PersistenceFlushFailure>()
    const pendingKeys = [...keys]
    collectFlushFailures(failures, pendingKeys, await Promise.allSettled(pendingKeys.map(flushKey)))

    if (inFlightWrites.size > 0) {
        const entries = [...inFlightWrites.entries()]
        collectFlushFailures(
            failures,
            entries.map(([, key]) => key),
            await Promise.allSettled(entries.map(([write]) => write)),
        )
    }
    if (failures.size > 0) throw new PersistenceFlushError([...failures.values()])
}

export interface CloseApplicationOptions {
    flush?: () => Promise<void>
    cleanup?: () => Promise<void>
    notify?: (message: string) => void
    exit: () => Promise<void>
}

export type CloseApplicationResult = {
    status: 'closed' | 'closed-with-persistence-failure' | 'closed-with-cleanup-failure'
}

function defaultCloseFailureNotification(message: string): void {
    if (typeof window !== 'undefined' && typeof window.alert === 'function') window.alert(message)
}

export async function closeApplicationWithFlush(
    options: CloseApplicationOptions,
): Promise<CloseApplicationResult> {
    let status: CloseApplicationResult['status'] = 'closed'
    try {
        await (options.flush ?? flushAllPendingWrites)()
    } catch (error) {
        status = 'closed-with-persistence-failure'
        const fault = persistenceFault(error, 'persistence.close-flush', undefined, 'flush-failed')
        const event = reportPersistenceFault(fault, {
            operation: 'persistence.close-flush',
            stage: 'close',
            fatal: true,
        })
        const notify = options.notify ?? defaultCloseFailureNotification
        try {
            notify(`${event.userSummary}\n일부 변경이 안전하게 저장되지 않았습니다. 앱은 종료됩니다.`)
        } catch (notificationError) {
            reportDiagnostic(notificationError, {
                operation: 'persistence.close-flush-notification',
                stage: 'close',
                category: 'persistence',
                severity: 'warning',
                recoverable: true,
            })
        }
    }
    if (options.cleanup !== undefined) {
        try {
            await options.cleanup()
        } catch (error) {
            if (status === 'closed') status = 'closed-with-cleanup-failure'
            const event = reportDiagnostic(error, {
                operation: 'application.shutdown-cleanup',
                stage: 'close',
                category: 'local_io',
                severity: 'error',
                recoverable: true,
            })
            const notify = options.notify ?? defaultCloseFailureNotification
            try {
                notify(`${event.userSummary}\n종료 정리를 완료하지 못했지만 앱 프로세스를 종료합니다.`)
            } catch (notificationError) {
                reportDiagnostic(notificationError, {
                    operation: 'application.shutdown-cleanup-notification',
                    stage: 'close',
                    category: 'local_io',
                    severity: 'warning',
                    recoverable: true,
                })
            }
        }
    }
    await options.exit()
    return { status }
}

function requestBestEffortFlush(reason: string): void {
    void flushAllPendingWrites().catch((error) => {
        const fault = persistenceFault(error, `persistence.${reason}-flush`, undefined, 'flush-failed')
        reportPersistenceFault(fault, { operation: `persistence.${reason}-flush`, stage: reason })
    })
}

async function installTauriCloseFlushHandler(): Promise<void> {
    if (tauriCloseFlushInstalled) return
    tauriCloseFlushInstalled = true

    try {
        const [{ invoke, isTauri }, { getCurrentWindow }] = await Promise.all([
            import('@tauri-apps/api/core'),
            import('@tauri-apps/api/window'),
        ])
        if (!isTauri()) return

        const appWindow = getCurrentWindow()
        await appWindow.onCloseRequested(async (event) => {
            if (tauriCloseFlushCompleted) return

            event.preventDefault()
            if (tauriCloseFlushInProgress) return

            tauriCloseFlushInProgress = true
            try {
                await closeApplicationWithFlush({
                    exit: async () => {
                        // Mark complete before fallback close so its close event is not intercepted again.
                        tauriCloseFlushCompleted = true
                        try {
                            await invoke('exit_app')
                        } catch (error) {
                            console.warn('[IndexedDB] Failed to exit after close flush:', error)
                            await appWindow.close()
                        }
                    },
                })
            } finally {
                tauriCloseFlushInProgress = false
            }
        })
    } catch (error) {
        console.warn('[IndexedDB] Failed to install Tauri close flush handler:', error)
    }
}

// Flush pending writes on app close
if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => requestBestEffortFlush('pagehide'))
    window.addEventListener('beforeunload', () => requestBestEffortFlush('beforeunload'))
    void installTauriCloseFlushHandler()
}

/** Shared read/CAS invariant: a present non-string is corruption, never an absent key. */
function readStoredString(
    store: IDBObjectStore, name: string,
    accept: (value: string | null) => void, reject: (error: unknown) => void,
): void {
    const request = store.get(name)
    const invalid = () => reject(new Error('IndexedDB keyval contains a non-string record.'))
    request.onerror = () => reject(request.error ?? new Error('IndexedDB keyval read failed.'))
    request.onsuccess = () => {
        if (typeof request.result === 'string') return accept(request.result)
        if (request.result !== undefined) return invalid()
        // IndexedDB can store undefined explicitly. Check existence in this same
        // transaction so neither reads nor null-to-value CAS can overwrite it.
        const key = store.getKey(name)
        key.onerror = () => reject(key.error ?? new Error('IndexedDB key existence read failed.'))
        key.onsuccess = () => key.result === undefined ? accept(null) : invalid()
    }
}

async function readIndexedDBItem(name: string): Promise<string | null> {
    try {
        const db = await getDb()
        return await new Promise<string | null>((resolve, reject) => {
            let settled = false
            let transaction: IDBTransaction | undefined
            const finishResolve = (value: string | null) => {
                if (settled) return
                settled = true
                clearTimeout(timeoutId)
                resolve(value)
            }
            const finishReject = (error: unknown, kind?: PersistenceFaultKind) => {
                if (settled) return
                settled = true
                clearTimeout(timeoutId)
                reject(persistenceFault(error, 'persistence.read', name, kind))
            }
            const timeoutId = setTimeout(() => {
                try { transaction?.abort() } catch { /* timeout remains authoritative */ }
                finishReject(new Error(`getItem timed out for key: ${name}`), 'operation-timeout')
            }, OPERATION_TIMEOUT_MS)

            try {
                transaction = db.transaction(STORE_NAME, 'readonly')
                transaction.onerror = () => finishReject(
                    transaction?.error ?? new Error(`getItem transaction failed for ${name}`),
                )
                transaction.onabort = () => finishReject(
                    transaction?.error ?? new Error(`getItem transaction aborted for ${name}`),
                    'transaction-aborted',
                )
                readStoredString(transaction.objectStore(STORE_NAME), name, finishResolve, finishReject)
            } catch (error) {
                finishReject(error)
            }
        })
    } catch (error) {
        throw persistenceFault(error, 'persistence.read', name)
    }
}

export const indexedDBStorage: StateStorage = {
    getItem: async (name: string): Promise<string | null> => {
        if (getPersistenceCriticality(name) === 'critical') {
            return getIndexedDBItemStrict(name)
        }

        // Return pending value if exists (debounced write hasn't flushed yet)
        const pendingVal = pendingWriteValues.get(name)
        if (pendingVal !== undefined) return pendingVal

        try {
            return await readIndexedDBItem(name)
        } catch (error) {
            const fault = persistenceFault(error, 'persistence.read', name)
            reportPersistenceFault(fault, { stage: 'best-effort-read', fatal: false })
            return null
        }
    },

    setItem: async (name: string, value: string): Promise<void> => {
        if (getPersistenceCriticality(name) === 'critical') {
            await setIndexedDBItemStrict(name, value)
            return
        }

        // Store latest value (always keep the newest)
        pendingWriteValues.set(name, value)

        // Clear existing debounce timer
        const existingTimer = pendingWriteTimers.get(name)
        if (existingTimer) clearTimeout(existingTimer)

        // Check if we need to force-write (prevent starvation during rapid changes)
        const lastWrite = lastWriteTime.get(name)
        const elapsed = lastWrite === undefined ? 0 : Date.now() - lastWrite

        if (lastWrite !== undefined && elapsed >= MAX_WRITE_INTERVAL) {
            // Too long since last write — flush immediately
            pendingWriteTimers.delete(name)
            await flushKey(name)
            return
        }

        // Schedule debounced write
        const debounceMs = WRITE_DEBOUNCE_MS[name] ?? DEFAULT_WRITE_DEBOUNCE
        const timer = setTimeout(() => {
            void flushKey(name).catch((error) => {
                const fault = persistenceFault(error, 'persistence.write', name)
                console.warn(`[IndexedDB] Debounced write failed for ${name}: ${fault.code}`)
            })
        }, debounceMs)

        pendingWriteTimers.set(name, timer)
    },
    
    removeItem: async (name: string): Promise<void> => {
        await removeIndexedDBItemStrict(name)
    },
}

/**
 * 특정 키의 데이터 크기가 너무 크면 정리
 * (대용량 wildcard 데이터 마이그레이션 이슈 해결용)
 */
export async function cleanupLargeData(key: string, maxSizeKB: number = 100): Promise<boolean> {
    try {
        const data = await indexedDBStorage.getItem(key)
        if (data && data.length > maxSizeKB * 1024) {
            console.warn(`[IndexedDB] ${key} data is too large (${(data.length / 1024).toFixed(1)}KB), cleaning up...`)
            
            // JSON 파싱해서 content 필드 제거
            try {
                const parsed = JSON.parse(data)
                if (parsed.state?.files) {
                    parsed.state.files = parsed.state.files.map((f: any) => {
                        const { content, ...meta } = f
                        return {
                            ...meta,
                            lineCount: Array.isArray(content) ? content.length : (meta.lineCount || 0)
                        }
                    })
                    parsed.state._migrated = true
                    await indexedDBStorage.setItem(key, JSON.stringify(parsed))
                    console.log(`[IndexedDB] ${key} cleaned up successfully`)
                    return true
                }
            } catch {
                // JSON 파싱 실패하면 그냥 삭제
                await indexedDBStorage.removeItem(key)
                console.log(`[IndexedDB] ${key} removed due to parse error`)
                return true
            }
        }
        return false
    } catch (error) {
        console.error('[IndexedDB] cleanup error:', error)
        return false
    }
}

export interface StoreMigrationReader {
    getItem: (key: string) => string | null | Promise<string | null>
}

export async function initializeIndexedDB(): Promise<void> {
    await getDb()
}

export function resetIndexedDBConnectionForRetry(): void {
    if (activeDb !== null) {
        activeDb.onclose = null
        activeDb.close()
    }
    activeDb = null
    dbPromise = null
    dbInitFailed = false
    dbInitError = null
}

/** Strict storage read for migration/repository authority; never converts I/O failures to null. */
export async function getIndexedDBItemStrict(name: string): Promise<string | null> {
    try {
        await flushKey(name)
        return await readIndexedDBItem(name)
    } catch (error) {
        const fault = persistenceFault(error, 'persistence.read', name)
        reportPersistenceFault(fault, { stage: 'strict-read' })
        throw fault
    }
}

/** Strict immediate write used by critical stores and repository commits; commit is read back before success. */
export async function setIndexedDBItemStrict(name: string, value: string): Promise<void> {
    const pendingTimer = pendingWriteTimers.get(name)
    if (pendingTimer !== undefined) clearTimeout(pendingTimer)
    pendingWriteTimers.delete(name)
    pendingWriteValues.delete(name)
    try {
        await enqueueTrackedWrite(name, async () => {
            await rawSetItem(name, value)
            if (await readIndexedDBItem(name) !== value) {
                throw new PersistenceFault('readback-mismatch', {
                    operation: 'persistence.write',
                    storeKey: name,
                    criticality: getPersistenceCriticality(name),
                })
            }
        })
        lastWriteTime.set(name, Date.now())
        notifyIndexedDBWrite(name)
    } catch (error) {
        throw reportWriteFault(error, name, 'strict-write')
    }
}

/** Strict immediate delete used only by restore compensation. */
export async function removeIndexedDBItemStrict(name: string): Promise<void> {
    const pendingTimer = pendingWriteTimers.get(name)
    if (pendingTimer !== undefined) clearTimeout(pendingTimer)
    pendingWriteTimers.delete(name)
    pendingWriteValues.delete(name)
    try {
        await enqueueTrackedWrite(name, async () => {
            const db = await getDb()
            await new Promise<void>((resolve, reject) => {
                let settled = false
                let transaction: IDBTransaction | undefined
                const finishResolve = () => {
                    if (settled) return
                    settled = true
                    clearTimeout(timeoutId)
                    resolve()
                }
                const finishReject = (error: unknown, kind?: PersistenceFaultKind) => {
                    if (settled) return
                    settled = true
                    clearTimeout(timeoutId)
                    reject(persistenceFault(error, 'persistence.remove', name, kind))
                }
                const timeoutId = setTimeout(() => {
                    try { transaction?.abort() } catch { /* timeout remains authoritative */ }
                    finishReject(new Error(`removeItem timed out for key: ${name}`), 'operation-timeout')
                }, OPERATION_TIMEOUT_MS)
                try {
                    transaction = db.transaction(STORE_NAME, 'readwrite')
                    const request = transaction.objectStore(STORE_NAME).delete(name)
                    request.onerror = () => finishReject(request.error ?? new Error(`removeItem request failed for ${name}`))
                    transaction.oncomplete = finishResolve
                    transaction.onerror = () => finishReject(
                        transaction?.error ?? new Error(`removeItem transaction failed for ${name}`),
                    )
                    transaction.onabort = () => finishReject(
                        transaction?.error ?? new Error(`removeItem transaction aborted for ${name}`),
                        'transaction-aborted',
                    )
                } catch (error) {
                    finishReject(error)
                }
            })
            if (await readIndexedDBItem(name) !== null) {
                throw new PersistenceFault('readback-mismatch', {
                    operation: 'persistence.remove',
                    storeKey: name,
                    criticality: getPersistenceCriticality(name),
                })
            }
        })
        notifyIndexedDBWrite(name)
    } catch (error) {
        const fault = persistenceFault(error, 'persistence.remove', name)
        reportPersistenceFault(fault, { stage: 'strict-remove' })
        throw fault
    }
}

/** Atomic compare-and-set used to acquire and advance the persisted migration lease. */
export async function compareAndSetIndexedDBItem(
    name: string,
    expected: string | null,
    next: string | null,
): Promise<boolean> {
    try {
        await flushKey(name)
        const changed = await enqueueTrackedWrite(name, async () => {
            const db = await getDb()
            return new Promise<boolean>((resolve, reject) => {
                let settled = false
                let transaction: IDBTransaction | undefined
                let matched = false
                const finishResolve = () => {
                    if (settled) return
                    settled = true
                    clearTimeout(timeoutId)
                    resolve(matched)
                }
                const finishReject = (error: unknown, kind?: PersistenceFaultKind) => {
                    if (settled) return
                    settled = true
                    clearTimeout(timeoutId)
                    reject(persistenceFault(error, 'persistence.compare-and-set', name, kind))
                }
                const timeoutId = setTimeout(() => {
                    try { transaction?.abort() } catch { /* timeout remains authoritative */ }
                    finishReject(new Error(`CAS timed out for key: ${name}`), 'operation-timeout')
                }, OPERATION_TIMEOUT_MS)
                try {
                    transaction = db.transaction(STORE_NAME, 'readwrite')
                    const store = transaction.objectStore(STORE_NAME)
                    readStoredString(store, name, current => {
                        if (current !== expected) return
                        matched = true
                        if (next === null) store.delete(name)
                        else store.put(next, name)
                    }, finishReject)
                    transaction.oncomplete = finishResolve
                    transaction.onerror = () => finishReject(
                        transaction?.error ?? new Error(`CAS transaction failed for ${name}`),
                    )
                    transaction.onabort = () => finishReject(
                        transaction?.error ?? new Error(`CAS transaction aborted for ${name}`),
                        'transaction-aborted',
                    )
                } catch (error) {
                    finishReject(error)
                }
            })
        })
        if (changed) {
            lastWriteTime.set(name, Date.now())
            notifyIndexedDBWrite(name)
        }
        return changed
    } catch (error) {
        const fault = persistenceFault(error, 'persistence.compare-and-set', name)
        reportPersistenceFault(fault, { stage: 'compare-and-set' })
        throw fault
    }
}

/** Exact serialized key/value snapshot used by non-destructive migrations. */
export async function exportRawIndexedDBEntries(): Promise<Record<string, string>> {
    const db = await getDb()
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readonly')
        const store = transaction.objectStore(STORE_NAME)
        const keysRequest = store.getAllKeys()
        const valuesRequest = store.getAll()
        let keys: IDBValidKey[] | null = null
        let values: unknown[] | null = null

        const finish = () => {
            if (keys === null || values === null) return
            const result: Record<string, string> = {}
            for (let index = 0; index < keys.length; index += 1) {
                const key = keys[index]
                const value = values[index]
                if (typeof key === 'string' && typeof value === 'string') {
                    result[key] = value
                }
            }
            resolve(result)
        }
        keysRequest.onsuccess = () => {
            keys = keysRequest.result
            finish()
        }
        valuesRequest.onsuccess = () => {
            values = valuesRequest.result
            finish()
        }
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error ?? new Error('Raw IndexedDB snapshot aborted'))
    })
}

/** Migration/repository writes use an explicit flush + readback boundary. */
export async function flushIndexedDBKey(name: string): Promise<void> {
    await flushKey(name)
}

export interface StoreMigrationWriter extends StoreMigrationReader {
    setItem: (key: string, value: string) => unknown | Promise<unknown>
}

export type RetainedStoreMigrationStatus =
    | 'source-missing'
    | 'target-present'
    | 'copied'
    | 'verification-failed'
    | 'failed'

export interface RetainedStoreMigrationResult {
    sourceKey: string
    targetKey: string
    status: RetainedStoreMigrationStatus
    sourceRetained: true
}

/**
 * Dual-read/single-write migration primitive. It intentionally has no delete
 * capability: the legacy value remains available for rollback and old backups.
 */
export async function copyStoreKeysRetainingSource(
    renames: readonly (readonly [string, string])[],
    source: StoreMigrationReader,
    target: StoreMigrationWriter,
    flushTarget: (key: string) => void | Promise<void> = () => undefined,
): Promise<RetainedStoreMigrationResult[]> {
    const results: RetainedStoreMigrationResult[] = []
    for (const [sourceKey, targetKey] of renames) {
        try {
            const targetData = await target.getItem(targetKey)
            if (targetData !== null) {
                results.push({ sourceKey, targetKey, status: 'target-present', sourceRetained: true })
                continue
            }

            const sourceData = await source.getItem(sourceKey)
            if (sourceData === null) {
                results.push({ sourceKey, targetKey, status: 'source-missing', sourceRetained: true })
                continue
            }

            await target.setItem(targetKey, sourceData)
            await flushTarget(targetKey)
            const verified = await target.getItem(targetKey)
            results.push({
                sourceKey,
                targetKey,
                status: verified === sourceData ? 'copied' : 'verification-failed',
                sourceRetained: true,
            })
        } catch (error) {
            console.error(`[Migration] ${sourceKey} → ${targetKey}: Failed`, error)
            results.push({ sourceKey, targetKey, status: 'failed', sourceRetained: true })
        }
    }
    return results
}

function logRetainedMigrationResults(prefix: string, results: readonly RetainedStoreMigrationResult[]): void {
    for (const result of results) {
        const route = `${result.sourceKey} → ${result.targetKey}`
        if (result.status === 'copied') {
            console.log(`${prefix} ${route}: copied and verified; legacy source retained`)
        } else if (result.status === 'verification-failed' || result.status === 'failed') {
            console.error(`${prefix} ${route}: ${result.status}; legacy source retained`)
        } else {
            console.log(`${prefix} ${route}: ${result.status}; legacy source retained`)
        }
    }
}

/** Copy renamed IndexedDB keys while retaining the old key for rollback. */
export async function migrateIndexedDBKeys(renames: [string, string][]): Promise<RetainedStoreMigrationResult[]> {
    const results = await copyStoreKeysRetainingSource(
        renames,
        indexedDBStorage,
        indexedDBStorage,
        flushKey,
    )
    logRetainedMigrationResults('[IndexedDB Migration]', results)
    return results
}

/** Copy renamed localStorage keys into IndexedDB without deleting local data. */
export async function migrateRenamedLocalStorageKeys(renames: [string, string][]): Promise<RetainedStoreMigrationResult[]> {
    const localReader: StoreMigrationReader = {
        getItem: key => localStorage.getItem(key),
    }
    const results = await copyStoreKeysRetainingSource(
        renames,
        localReader,
        indexedDBStorage,
        flushKey,
    )
    logRetainedMigrationResults('[Migration]', results)
    return results
}

/**
 * Copy canonical localStorage values into IndexedDB before Zustand hydrates.
 * The source remains intact until a separately approved cleanup phase.
 */
export async function migrateFromLocalStorage(keys: string[]): Promise<RetainedStoreMigrationResult[]> {
    const localReader: StoreMigrationReader = {
        getItem: key => localStorage.getItem(key),
    }
    const results = await copyStoreKeysRetainingSource(
        keys.map(key => [key, key] as const),
        localReader,
        indexedDBStorage,
        flushKey,
    )
    logRetainedMigrationResults('[Migration]', results)
    return results
}

export interface BackupStoragePort {
    getItem: (key: string) => string | null | Promise<string | null>
    setItem: (key: string, value: string) => unknown | Promise<unknown>
    removeItem?: (key: string) => unknown | Promise<unknown>
}

export interface BackupExportOptions {
    storeKeys?: readonly string[]
    exportedAt?: string
    exportWildcardContent?: () => Promise<{ [id: string]: string[] }>
    /** Backup Envelope v3 must not turn read failures into silent omissions. */
    strict?: boolean
    purpose?: BackupProjectionPurpose
}

/**
 * Storage-port form used by tests and migrations to prove a real JSON
 * export/import round trip without coupling the contract to browser IndexedDB.
 */
export async function exportBackupFromStorage(
    storage: Pick<BackupStoragePort, 'getItem'>,
    options: BackupExportOptions = {},
): Promise<{ [key: string]: unknown }> {
    const backup: { [key: string]: unknown } = {
        _exportedAt: options.exportedAt ?? new Date().toISOString(),
        _version: '2.3',
    }

    for (const key of options.storeKeys ?? FULL_BACKUP_STORE_KEYS) {
        try {
            const data = await storage.getItem(key)
            if (data !== null) {
                const parsed = filterLargeImageData(key, JSON.parse(data))
                backup[key] = projectStoreForBackup(
                    key,
                    parsed,
                    options.purpose ?? 'manual-full',
                ).payload
            }
        } catch (err) {
            console.error(`[Backup] Failed to export ${key}:`, err)
            if (options.strict) throw err
        }
    }

    if (options.exportWildcardContent) {
        try {
            const wildcardContent = await options.exportWildcardContent()
            if (Object.keys(wildcardContent).length > 0) {
                backup['nai-blue-wildcard-content'] = wildcardContent
                console.log('[Backup] Wildcard content exported:', Object.keys(wildcardContent).length, 'files')
            }
        } catch (err) {
            console.error('[Backup] Failed to export wildcard content:', err)
            if (options.strict) throw err
        }
    }

    return backup
}

/**
 * Full JSON backup. Retained legacy keys are exported alongside canonical keys;
 * character/vibe bytes stay in their existing stores and are never projected
 * into Composition documents by this path.
 */
export async function exportAllData(
    options: { strict?: boolean; purpose?: BackupProjectionPurpose } = {},
): Promise<{ [key: string]: unknown }> {
    const backup = await exportBackupFromStorage(indexedDBStorage, {
        strict: options.strict,
        purpose: options.purpose,
        exportWildcardContent: () => exportWildcardContentSnapshot({ strict: options.strict }),
    })
    console.log('[Backup] Export complete:', Object.keys(backup).length - 2, 'stores')
    return backup
}

/**
 * Filter out disposable preview data from store data.
 * Character/Vibe bytes and existing encoded-vibe caches are retained verbatim:
 * migration/restore must never force an API re-encode.
 */
function filterLargeImageData(key: string, data: unknown): unknown {
    if (!data || typeof data !== 'object') return data
    
    const obj = data as Record<string, unknown>
    
    // Handle Zustand persist wrapper structure: { state: {...}, version: number }
    if ('state' in obj && 'version' in obj) {
        return {
            ...obj,
            state: filterLargeImageData(key, obj.state)
        }
    }
    
    switch (key) {
        case 'nai-blue-character-store':
            return data
            
        case 'nai-blue-generation':
            // Filter history thumbnails (files exist) and temp images
            return {
                ...obj,
                history: Array.isArray(obj.history)
                    ? obj.history.map((item: Record<string, unknown>) => ({
                        ...item,
                        thumbnail: item.thumbnail && typeof item.thumbnail === 'string' && item.thumbnail.startsWith('data:')
                            ? '[THUMBNAIL_EXCLUDED]'
                            : item.thumbnail,
                    }))
                    : obj.history,
                sourceImage: null,
                previewImage: null,
                mask: null,
            }
            
        default:
            return data
    }
}

/**
 * Export all wildcard content from separate IndexedDB
 * Fixed: Race condition where getAllRequest might complete before handler is attached
 */
export interface WildcardContentExportOptions {
    /** Migration capture must fail closed instead of treating a timeout as an empty DB. */
    strict?: boolean
    timeoutMs?: number
}

export async function exportWildcardContentSnapshot(
    options: WildcardContentExportOptions = {},
): Promise<{ [id: string]: string[] }> {
    return new Promise((resolve, reject) => {
        let settled = false
        const finishResolve = (value: { [id: string]: string[] }) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            resolve(value)
        }
        const finishReject = (error: unknown) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            reject(error)
        }
        // Add timeout to prevent infinite waiting
        const timeout = setTimeout(() => {
            const error = new Error(`Wildcard export timed out after ${options.timeoutMs ?? 30000}ms`)
            console.error('[Backup]', error.message)
            if (options.strict) finishReject(error)
            else finishResolve({})
        }, options.timeoutMs ?? 30000)
        
        const request = indexedDB.open('nai-blue-wildcard-content', 1)
        
        request.onerror = () => {
            finishReject(request.error)
        }
        
        request.onsuccess = () => {
            const db = request.result
            if (!db.objectStoreNames.contains('contents')) {
                finishResolve({})
                return
            }
            
            const transaction = db.transaction('contents', 'readonly')
            const store = transaction.objectStore('contents')
            const getAllRequest = store.getAll()
            const getAllKeysRequest = store.getAllKeys()
            
            const result: { [id: string]: string[] } = {}
            let keys: string[] = []
            let values: string[][] = []
            let keysReady = false
            let valuesReady = false
            
            const tryResolve = () => {
                if (keysReady && valuesReady) {
                    for (let i = 0; i < keys.length; i++) {
                        result[keys[i]] = values[i]
                    }
                    finishResolve(result)
                }
            }
            
            getAllKeysRequest.onsuccess = () => {
                keys = getAllKeysRequest.result as string[]
                keysReady = true
                tryResolve()
            }
            
            getAllRequest.onsuccess = () => {
                values = getAllRequest.result as string[][]
                valuesReady = true
                tryResolve()
            }
            
            transaction.onerror = () => {
                finishReject(transaction.error)
            }
        }
        
        request.onupgradeneeded = (event) => {
            const db = (event.target as IDBOpenDBRequest).result
            if (!db.objectStoreNames.contains('contents')) {
                db.createObjectStore('contents')
            }
        }
    })
}

/**
 * Import wildcard content to separate IndexedDB
 */
export async function importWildcardContentSnapshot(content: { [id: string]: string[] }): Promise<void> {
    const normalized = Object.fromEntries(
        Object.entries(content).sort(([left], [right]) => left.localeCompare(right)),
    )
    for (const [id, lines] of Object.entries(normalized)) {
        if (!Array.isArray(lines) || lines.some(line => typeof line !== 'string')) {
            throw new Error(`Invalid wildcard content for ${id}`)
        }
    }

    await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('nai-blue-wildcard-content', 1)
        
        request.onerror = () => reject(request.error)
        
        request.onsuccess = () => {
            const db = request.result
            const transaction = db.transaction('contents', 'readwrite')
            const store = transaction.objectStore('contents')
            store.clear()
            for (const [id, lines] of Object.entries(normalized)) {
                store.put(lines, id)
            }
            
            transaction.oncomplete = () => {
                console.log('[Restore] Wildcard content restored:', Object.keys(normalized).length, 'files')
                resolve()
            }
            transaction.onerror = () => reject(transaction.error)
        }
        
        request.onupgradeneeded = (event) => {
            const db = (event.target as IDBOpenDBRequest).result
            if (!db.objectStoreNames.contains('contents')) {
                db.createObjectStore('contents')
            }
        }
    })

    const readback = await exportWildcardContentSnapshot({ strict: true })
    const canonical = (value: { [id: string]: string[] }) => JSON.stringify(
        Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))),
    )
    if (canonical(readback) !== canonical(normalized)) {
        throw new Error('Wildcard restore readback mismatch')
    }
}

function canonicalWildcardContent(value: { [id: string]: string[] }): string {
    return JSON.stringify(
        Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))),
    )
}

/** Atomic compare-and-replace used by startup migration sidecar materialization. */
export async function compareAndReplaceWildcardContentSnapshot(
    expected: { [id: string]: string[] },
    replacement: { [id: string]: string[] },
): Promise<boolean> {
    return new Promise((resolve, reject) => {
        let settled = false
        let comparisonFailed = false
        const finish = (value: boolean) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            resolve(value)
        }
        const fail = (error: unknown) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            reject(error)
        }
        const timeout = setTimeout(() => fail(new Error('Wildcard compare-and-replace timed out')), 30000)
        const request = indexedDB.open('nai-blue-wildcard-content', 1)

        request.onerror = () => fail(request.error)
        request.onupgradeneeded = event => {
            const db = (event.target as IDBOpenDBRequest).result
            if (!db.objectStoreNames.contains('contents')) db.createObjectStore('contents')
        }
        request.onsuccess = () => {
            const transaction = request.result.transaction('contents', 'readwrite')
            const store = transaction.objectStore('contents')
            const keysRequest = store.getAllKeys()
            const valuesRequest = store.getAll()
            let keys: IDBValidKey[] | null = null
            let values: unknown[] | null = null

            const compareAndWrite = () => {
                if (keys === null || values === null) return
                const current: Record<string, string[]> = {}
                for (let index = 0; index < keys.length; index += 1) {
                    if (typeof keys[index] === 'string' && Array.isArray(values[index])) {
                        current[keys[index] as string] = values[index] as string[]
                    }
                }
                if (canonicalWildcardContent(current) !== canonicalWildcardContent(expected)) {
                    comparisonFailed = true
                    transaction.abort()
                    return
                }
                store.clear()
                for (const [id, lines] of Object.entries(replacement)) store.put([...lines], id)
            }
            keysRequest.onsuccess = () => { keys = keysRequest.result; compareAndWrite() }
            valuesRequest.onsuccess = () => { values = valuesRequest.result; compareAndWrite() }
            keysRequest.onerror = () => transaction.abort()
            valuesRequest.onerror = () => transaction.abort()
            transaction.oncomplete = () => finish(true)
            transaction.onabort = () => {
                if (comparisonFailed) finish(false)
                else fail(transaction.error ?? new Error('Wildcard compare-and-replace aborted'))
            }
            transaction.onerror = () => {
                if (!comparisonFailed) fail(transaction.error)
            }
        }
    })
}

export interface BackupImportOptions {
    overwrite?: boolean
    flushStore?: (key: string) => void | Promise<void>
    importWildcardContent?: (content: { [id: string]: string[] }) => Promise<void>
    readWildcardContent?: () => Promise<{ [id: string]: string[] }>
    allowedKeys?: readonly string[]
    /** External allowlisted file commit kept inside the restore journal. */
    finalizeRestore?: () => Promise<void>
    rollbackFinalize?: () => Promise<void>
    finalizeKey?: string
}

export type BackupRestoreIgnoredReason =
    | 'metadata'
    | 'legacy-marketplace-or-supabase'
    | 'unknown-store-key'

export interface BackupRestoreIgnoredKey {
    key: string
    reason: BackupRestoreIgnoredReason
}

export interface BackupRestoreDryRunReport {
    acceptedKeys: string[]
    ignoredKeys: BackupRestoreIgnoredKey[]
}

export interface BackupImportResult {
    success: string[]
    failed: string[]
    ignored: BackupRestoreIgnoredKey[]
}

export const RESTORE_STORE_ALLOWLIST = [
    ...FULL_BACKUP_STORE_KEYS,
    'nai-blue-wildcard-content',
] as const

function ignoredRestoreReason(key: string): BackupRestoreIgnoredReason {
    if (key.startsWith('_')) return 'metadata'
    if (/market(?:place)?|supabase|^sb-/i.test(key)) return 'legacy-marketplace-or-supabase'
    return 'unknown-store-key'
}

/**
 * Pure preflight used by every restore surface. Unknown raw keys are reported
 * but never written to IndexedDB.
 */
export function dryRunBackupRestore(
    backup: Readonly<Record<string, unknown>>,
    allowedKeys: readonly string[] = RESTORE_STORE_ALLOWLIST,
): BackupRestoreDryRunReport {
    const allowed = new Set(allowedKeys)
    const acceptedKeys: string[] = []
    const ignoredKeys: BackupRestoreIgnoredKey[] = []
    for (const key of Object.keys(backup).sort()) {
        if (allowed.has(key)) {
            acceptedKeys.push(key)
        } else {
            ignoredKeys.push({ key, reason: ignoredRestoreReason(key) })
        }
    }
    return { acceptedKeys, ignoredKeys }
}

/** Restore backup payloads with write/flush/readback verification. */
export async function importBackupToStorage(
    storage: BackupStoragePort,
    backup: { [key: string]: unknown },
    options: BackupImportOptions = {},
): Promise<BackupImportResult> {
    const dryRun = dryRunBackupRestore(backup, options.allowedKeys)
    const accepted = new Set(dryRun.acceptedKeys)
    const result: BackupImportResult = {
        success: [],
        failed: [],
        ignored: dryRun.ignoredKeys,
    }
    const previousValues = new Map<string, string | null>()
    let previousWildcardContent: { [id: string]: string[] } | undefined
    const attemptedMutations: string[] = []

    try {
        for (const key of dryRun.acceptedKeys) {
            if (key === 'nai-blue-wildcard-content') {
                if (options.readWildcardContent !== undefined) {
                    previousWildcardContent = await options.readWildcardContent()
                }
            } else {
                previousValues.set(key, await storage.getItem(key))
            }
        }
    } catch (error) {
        console.error('[Restore] Failed to create pre-restore journal:', error)
        result.failed.push('pre-restore-journal')
        return result
    }

    for (const [key, value] of Object.entries(backup)) {
        if (!accepted.has(key)) continue

        if (key === 'nai-blue-wildcard-content') {
            if (!options.importWildcardContent) {
                result.failed.push(key)
                continue
            }
            try {
                attemptedMutations.push(key)
                await options.importWildcardContent(value as { [id: string]: string[] })
                result.success.push(key)
            } catch (err) {
                console.error(`[Restore] ${key}: Failed`, err)
                result.failed.push(key)
            }
            continue
        }

        try {
            if (!options.overwrite) {
                const existing = await storage.getItem(key)
                if (existing !== null) {
                    console.log(`[Restore] ${key}: Skipping (data exists)`)
                    continue
                }
            }

            const projected = projectStoreForBackup(key, value, 'restore-preflight')
            const serialized = JSON.stringify(projected.payload)
            attemptedMutations.push(key)
            await storage.setItem(key, serialized)
            await options.flushStore?.(key)
            const verified = await storage.getItem(key)
            if (verified !== serialized) {
                throw new Error(`Restore readback mismatch for ${key}`)
            }
            result.success.push(key)
            console.log(`[Restore] ${key}: Restored and verified`)
        } catch (err) {
            console.error(`[Restore] ${key}: Failed`, err)
            result.failed.push(key)
        }
    }

    if (result.failed.length === 0 && options.finalizeRestore !== undefined) {
        const finalizeKey = options.finalizeKey ?? 'external-finalize'
        try {
            await options.finalizeRestore()
            result.success.push(finalizeKey)
        } catch (error) {
            console.error(`[Restore] Finalize failed for ${finalizeKey}:`, error)
            result.failed.push(finalizeKey)
            if (options.rollbackFinalize !== undefined) {
                try {
                    await options.rollbackFinalize()
                } catch (rollbackError) {
                    console.error(`[Restore] Finalize rollback failed for ${finalizeKey}:`, rollbackError)
                    result.failed.push(`rollback:${finalizeKey}`)
                }
            }
        }
    }

    if (result.failed.length > 0 && attemptedMutations.length > 0) {
        const restoredKeys = [...new Set(attemptedMutations)].reverse()
        for (const key of restoredKeys) {
            try {
                if (key === 'nai-blue-wildcard-content') {
                    if (options.importWildcardContent === undefined || previousWildcardContent === undefined) {
                        throw new Error('Wildcard rollback snapshot is unavailable')
                    }
                    await options.importWildcardContent(previousWildcardContent)
                } else {
                    const previous = previousValues.get(key) ?? null
                    if (previous === null) {
                        if (storage.removeItem === undefined) {
                            throw new Error(`Storage port cannot remove newly restored key ${key}`)
                        }
                        await storage.removeItem(key)
                        await options.flushStore?.(key)
                        if (await storage.getItem(key) !== null) {
                            throw new Error(`Rollback removal readback mismatch for ${key}`)
                        }
                    } else {
                        await storage.setItem(key, previous)
                        await options.flushStore?.(key)
                        if (await storage.getItem(key) !== previous) {
                            throw new Error(`Rollback readback mismatch for ${key}`)
                        }
                    }
                }
            } catch (error) {
                console.error(`[Restore] Rollback failed for ${key}:`, error)
                result.failed.push(`rollback:${key}`)
            }
        }
        result.success = []
    }

    return result
}

/**
 * Restore data produced by exportAllData. Unknown/legacy store keys remain
 * round-trippable and no old store is removed as a side effect.
 */
export async function importAllData(
    backup: { [key: string]: unknown },
    overwrite = false,
    options: Pick<BackupImportOptions, 'finalizeRestore' | 'rollbackFinalize' | 'finalizeKey'> = {},
): Promise<BackupImportResult> {
    await flushAllPendingWrites()
    const strictRestoreStorage: BackupStoragePort = {
        getItem: getIndexedDBItemStrict,
        setItem: setIndexedDBItemStrict,
        removeItem: removeIndexedDBItemStrict,
    }
    const result = await importBackupToStorage(strictRestoreStorage, backup, {
        overwrite,
        importWildcardContent: importWildcardContentSnapshot,
        readWildcardContent: () => exportWildcardContentSnapshot({ strict: true }),
        ...options,
    })
    console.log('[Restore] Complete:', result.success.length, 'success,', result.failed.length, 'failed')
    return result
}

/**
 * 특정 스토어 데이터 크기 확인 (디버깅용)
 */
export async function getStoreSizes(): Promise<{ [key: string]: number }> {
    const sizes: { [key: string]: number } = {}
    
    for (const key of FULL_BACKUP_STORE_KEYS) {
        try {
            const data = await indexedDBStorage.getItem(key)
            sizes[key] = data ? data.length : 0
        } catch {
            sizes[key] = -1 // 에러 표시
        }
    }
    
    return sizes
}
