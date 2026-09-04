import {
    hashR2ProfileV2,
    type R2ProfileHash,
    type R2ProfileV2,
    type R2ManifestV2,
    type R2ManifestV2Item,
    type Phase7ArtifactBinding,
    type Phase7RemoteObjectRef,
    type UploadCompletedPart,
    type UploadJob,
    type UploadJobState,
} from '@/domain/r2/types'
import type { ArtifactRecord, ArtifactRemoteObjectRef } from '@/domain/organizer/types'

// Physical database names stay stable so pending uploads survive the rename.
export const R2_UPLOAD_DATABASE_NAME = 'nai-blue-r2-upload-queue'
export const R2_UPLOAD_DATABASE_VERSION = 2

const SECRET_KEY_PATTERN = /(?:access.?key|secret|authorization|signed.?url|session.?token|private.?key)/i
const SIGNED_URL_PATTERN = /[?&](?:x-amz-(?:credential|signature|security-token)|signature)=/i

interface StoredUploadJob extends UploadJob {
    readonly dedupeKey: string
}

export type R2UploadRepositoryErrorCode =
    | 'E_R2_DB_UNAVAILABLE'
    | 'E_R2_DB_BLOCKED'
    | 'E_R2_RECORD_INVALID'
    | 'E_R2_NOT_FOUND'
    | 'E_R2_VERSION_CONFLICT'
    | 'E_R2_TERMINAL_IMMUTABLE'

export class R2UploadRepositoryError extends Error {
    constructor(readonly code: R2UploadRepositoryErrorCode, message: string) {
        super(message)
        this.name = 'R2UploadRepositoryError'
    }
}

export interface R2UploadRepositoryOptions {
    factory?: IDBFactory
    keyRange?: typeof IDBKeyRange
    databaseName?: string
    openTimeoutMs?: number
    artifactReader?: R2ArtifactAuthorityReader
}

export interface R2ArtifactAuthorityReader {
    get(artifactId: string): Promise<Pick<ArtifactRecord, 'remoteObjectRefs'> | null>
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
    })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
        transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    })
}

function cloneProfile(profile: R2ProfileV2): R2ProfileV2 {
    return structuredClone(profile)
}

function cloneJob(job: UploadJob): UploadJob {
    return structuredClone(job)
}

function assertSafeValue(value: unknown, path: readonly string[] = []): void {
    if (Array.isArray(value)) {
        value.forEach((item, index) => assertSafeValue(item, [...path, String(index)]))
        return
    }
    if (value !== null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            if (SECRET_KEY_PATTERN.test(key) && key !== 'credentialRef') {
                throw new R2UploadRepositoryError('E_R2_RECORD_INVALID', `Secret-shaped field is prohibited at ${[...path, key].join('.')}`)
            }
            assertSafeValue(child, [...path, key])
        }
        return
    }
    if (typeof value === 'string' && (value.startsWith('Bearer ') || SIGNED_URL_PATTERN.test(value))) {
        throw new R2UploadRepositoryError('E_R2_RECORD_INVALID', `Secret-shaped value is prohibited at ${path.join('.')}`)
    }
}

function assertTimestamp(value: string, field: string): void {
    if (!Number.isFinite(Date.parse(value))) {
        throw new R2UploadRepositoryError('E_R2_RECORD_INVALID', `${field} must be an ISO timestamp`)
    }
}

export function validateR2ProfileV2(profile: R2ProfileV2): void {
    assertSafeValue(profile)
    if (profile.schemaVersion !== 2
        || !profile.id
        || !profile.name.trim()
        || !profile.bucket.trim()
        || !profile.credentialRef.trim()
        || !['native-s3', 'wrangler', 'relay'].includes(profile.transport)
        || !['fail', 'skip-same', 'overwrite', 'suffix'].includes(profile.conflictPolicy)
        || !['private', 'r2-dev', 'custom'].includes(profile.publicMode)) {
        throw new R2UploadRepositoryError('E_R2_RECORD_INVALID', 'R2 profile is invalid')
    }
    if (profile.publicMode === 'custom' && !profile.publicBaseUrl?.startsWith('https://')) {
        throw new R2UploadRepositoryError('E_R2_RECORD_INVALID', 'Custom public mode requires an HTTPS base URL')
    }
    assertTimestamp(profile.createdAt, 'profile.createdAt')
    assertTimestamp(profile.updatedAt, 'profile.updatedAt')
}

function validateUploadJob(job: UploadJob): void {
    assertSafeValue(job)
    if (!job.id || !job.profileId || !job.artifactId || !job.localVariant || !job.remoteKey
        || !/^sha256:[a-f0-9]{64}$/i.test(job.contentSha256)
        || !Number.isSafeInteger(job.size) || job.size < 0
        || !['queued', 'running', 'uploaded', 'verifying', 'verified', 'linking', 'succeeded', 'failed', 'cancelled'].includes(job.state)
        || !Number.isSafeInteger(job.attempt) || job.attempt < 0
        || !Number.isSafeInteger(job.maxAttempts) || job.maxAttempts < 1
        || job.version < 1) {
        throw new R2UploadRepositoryError('E_R2_RECORD_INVALID', 'R2 upload job is invalid')
    }
    if (job.contractVersion === 'legacy-v1') {
        if (job.profileSnapshot !== null || job.artifactBinding !== null || job.linkExpectedArtifactVersion !== null || job.remoteRef !== null
            || ['uploaded', 'verifying', 'verified', 'linking'].includes(job.state)) {
            throw new R2UploadRepositoryError('E_R2_RECORD_INVALID', 'Legacy R2 job contains Phase 7 authority')
        }
    } else if (job.contractVersion === 'phase7-v1') {
        const requiresRemoteRef = ['verified', 'linking', 'succeeded'].includes(job.state)
        const forbidsRemoteRef = ['queued', 'running', 'uploaded', 'verifying'].includes(job.state)
        if (!job.profileSnapshot || !job.artifactBinding
            || job.profileSnapshot.id !== job.profileId
            || !['fail', 'suffix'].includes(job.profileSnapshot.conflictPolicy)
            || (job.remoteRef !== null && hashR2ProfileV2(job.profileSnapshot) !== job.remoteRef.profileHash)
            || job.artifactBinding.artifactId !== job.artifactId
            || !Number.isSafeInteger(job.artifactBinding.artifactVersion)
            || job.artifactBinding.artifactVersion < 1
            || !Number.isSafeInteger(job.linkExpectedArtifactVersion)
            || (job.linkExpectedArtifactVersion ?? 0) < 1
            || !['original', 'sidecar'].includes(job.artifactBinding.localVariant)
            || (requiresRemoteRef && job.remoteRef === null)
            || (forbidsRemoteRef && job.remoteRef !== null)
            || (job.remoteRef !== null && (job.remoteRef.contractVersion !== 'phase7-v1'
                || job.remoteRef.profileId !== job.profileId
                || job.remoteRef.uploadJobId !== job.id
                || job.remoteRef.artifactId !== job.artifactId
                || job.remoteRef.variantId !== job.artifactBinding.localVariant
                || job.remoteRef.remoteKey !== job.remoteKey
                || job.remoteRef.contentSha256 !== job.contentSha256
                || job.remoteRef.size !== job.size
                || job.remoteRef.bucket !== job.profileSnapshot.bucket
                || !Number.isFinite(Date.parse(job.remoteRef.verifiedAt))))) {
            throw new R2UploadRepositoryError('E_R2_RECORD_INVALID', 'Phase 7 R2 job binding is invalid')
        }
        validateR2ProfileV2(job.profileSnapshot)
    } else {
        throw new R2UploadRepositoryError('E_R2_RECORD_INVALID', 'R2 upload job contract is invalid')
    }
    assertTimestamp(job.createdAt, 'job.createdAt')
    assertTimestamp(job.updatedAt, 'job.updatedAt')
    assertTimestamp(job.nextAttemptAt, 'job.nextAttemptAt')
}

function dedupeKey(job: UploadJob): string {
    return [
        job.contractVersion,
        job.profileId,
        job.contractVersion === 'phase7-v1' && job.profileSnapshot ? hashR2ProfileV2(job.profileSnapshot) : '',
        job.artifactId,
        job.localVariant,
        job.remoteKey,
        job.contentSha256,
    ].join('\u001f')
}

function isTerminal(state: UploadJobState): boolean {
    return state === 'succeeded' || state === 'failed' || state === 'cancelled'
}

function validateInitialUploadJob(job: UploadJob): void {
    const expectedLinkVersion = job.contractVersion === 'phase7-v1' ? job.artifactBinding?.artifactVersion ?? null : null
    if (job.state !== 'queued'
        || job.attempt !== 0
        || job.version !== 1
        || job.remoteRef !== null
        || job.diagnosticEventId !== null
        || job.multipart.uploadId !== null
        || job.multipart.completedParts.length !== 0
        || job.linkExpectedArtifactVersion !== expectedLinkVersion
        || job.updatedAt !== job.createdAt
        || job.nextAttemptAt !== job.createdAt) {
        throw new R2UploadRepositoryError('E_R2_RECORD_INVALID', 'New R2 upload jobs must use the initial queued contract')
    }
}

const PHASE7_TRANSITIONS: Readonly<Record<UploadJobState, readonly UploadJobState[]>> = {
    queued: ['queued', 'running', 'cancelled'],
    running: ['running', 'queued', 'uploaded', 'failed', 'cancelled'],
    uploaded: ['uploaded', 'verifying', 'failed', 'cancelled'],
    verifying: ['verifying', 'verified', 'failed', 'cancelled'],
    verified: ['verified', 'linking', 'failed', 'cancelled'],
    linking: ['linking', 'failed'],
    succeeded: [],
    failed: [],
    cancelled: [],
}

function isExactPhase7ArtifactRef(
    reference: ArtifactRemoteObjectRef,
    remote: NonNullable<UploadJob['remoteRef']>,
): boolean {
    return reference.contractVersion === 'phase7-v1'
        && reference.profileId === remote.profileId
        && reference.profileHash === remote.profileHash
        && reference.bucket === remote.bucket
        && reference.uploadJobId === remote.uploadJobId
        && reference.artifactId === remote.artifactId
        && reference.variantId === remote.variantId
        && reference.remoteKey === remote.remoteKey
        && reference.contentSha256 === remote.contentSha256
        && reference.size === remote.size
        && reference.verifiedAt === remote.verifiedAt
        && reference.state === 'succeeded'
}

export class IndexedDBR2UploadRepository {
    private readonly factory: IDBFactory
    private readonly keyRange: typeof IDBKeyRange
    private readonly databaseName: string
    private readonly openTimeoutMs: number
    private readonly artifactReader: R2ArtifactAuthorityReader | undefined
    private dbPromise: Promise<IDBDatabase> | null = null

    constructor(options: R2UploadRepositoryOptions = {}) {
        this.factory = options.factory ?? indexedDB
        this.keyRange = options.keyRange ?? IDBKeyRange
        this.databaseName = options.databaseName ?? R2_UPLOAD_DATABASE_NAME
        this.openTimeoutMs = options.openTimeoutMs ?? 5_000
        this.artifactReader = options.artifactReader
    }

    private open(): Promise<IDBDatabase> {
        if (this.dbPromise) return this.dbPromise
        this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
            const request = this.factory.open(this.databaseName, R2_UPLOAD_DATABASE_VERSION)
            const timeout = setTimeout(() => {
                request.result?.close()
                reject(new R2UploadRepositoryError('E_R2_DB_UNAVAILABLE', 'R2 upload database open timed out'))
            }, this.openTimeoutMs)
            request.onblocked = () => {
                clearTimeout(timeout)
                reject(new R2UploadRepositoryError('E_R2_DB_BLOCKED', 'R2 upload database upgrade is blocked'))
            }
            request.onupgradeneeded = event => {
                const db = request.result
                if (!db.objectStoreNames.contains('profiles')) db.createObjectStore('profiles', { keyPath: 'id' })
                if (!db.objectStoreNames.contains('jobs')) {
                    const jobs = db.createObjectStore('jobs', { keyPath: 'id' })
                    jobs.createIndex('by-state-ready', ['state', 'nextAttemptAt', 'createdAt', 'id'])
                    jobs.createIndex('by-profile', ['profileId', 'createdAt', 'id'])
                    jobs.createIndex('by-dedupe', 'dedupeKey', { unique: true })
                }
                if (!db.objectStoreNames.contains('manifest')) {
                    const manifest = db.createObjectStore('manifest', { keyPath: 'id' })
                    manifest.createIndex('by-profile', ['profileId', 'remoteKey'])
                }
                if ((event.oldVersion ?? 0) < 2 && db.objectStoreNames.contains('jobs')) {
                    const jobs = request.transaction?.objectStore('jobs')
                    const cursorRequest = jobs?.openCursor()
                    if (cursorRequest) cursorRequest.onsuccess = cursorEvent => {
                        const cursor = (cursorEvent.target as IDBRequest<IDBCursorWithValue | null>).result
                        if (!cursor) return
                        const legacy = cursor.value as Record<string, unknown>
                        const migrated = {
                            ...legacy,
                            contractVersion: 'legacy-v1',
                            profileSnapshot: null,
                            artifactBinding: null,
                            linkExpectedArtifactVersion: null,
                            remoteRef: null,
                        } as unknown as UploadJob
                        cursor.update({ ...migrated, dedupeKey: dedupeKey(migrated) })
                        cursor.continue()
                    }
                }
            }
            request.onerror = () => {
                clearTimeout(timeout)
                reject(new R2UploadRepositoryError('E_R2_DB_UNAVAILABLE', 'R2 upload database could not be opened'))
            }
            request.onsuccess = () => {
                clearTimeout(timeout)
                request.result.onversionchange = () => request.result.close()
                resolve(request.result)
            }
        }).catch((error) => {
            this.dbPromise = null
            throw error
        })
        return this.dbPromise
    }

    async close(): Promise<void> {
        const db = await this.dbPromise?.catch(() => null)
        db?.close()
        this.dbPromise = null
    }

    async putProfile(profile: R2ProfileV2, expectedProfileHash: R2ProfileHash | null): Promise<R2ProfileV2> {
        validateR2ProfileV2(profile)
        if (expectedProfileHash !== null && !/^sha256:[a-f0-9]{64}$/u.test(expectedProfileHash)) {
            throw new R2UploadRepositoryError('E_R2_RECORD_INVALID', 'Expected R2 profile hash is invalid')
        }
        const db = await this.open()
        const transaction = db.transaction('profiles', 'readwrite')
        const store = transaction.objectStore('profiles')
        const current = await requestValue(store.get(profile.id)) as R2ProfileV2 | undefined
        if (current) validateR2ProfileV2(current)
        const currentHash = current ? hashR2ProfileV2(current) : null
        if (current && expectedProfileHash === null && currentHash === hashR2ProfileV2(profile)) {
            await transactionDone(transaction)
            return cloneProfile(current)
        }
        if (currentHash !== expectedProfileHash) {
            transaction.abort()
            throw new R2UploadRepositoryError('E_R2_VERSION_CONFLICT', 'R2 profile changed')
        }
        store.put(cloneProfile(profile))
        const readback = await requestValue(store.get(profile.id)) as R2ProfileV2 | undefined
        await transactionDone(transaction)
        if (!readback) throw new R2UploadRepositoryError('E_R2_NOT_FOUND', 'R2 profile write was not readable')
        validateR2ProfileV2(readback)
        return cloneProfile(readback)
    }

    async getProfile(id: string): Promise<R2ProfileV2 | null> {
        const db = await this.open()
        const transaction = db.transaction('profiles', 'readonly')
        const value = await requestValue(transaction.objectStore('profiles').get(id)) as R2ProfileV2 | undefined
        await transactionDone(transaction)
        if (!value) return null
        validateR2ProfileV2(value)
        return cloneProfile(value)
    }

    async listProfiles(): Promise<R2ProfileV2[]> {
        const db = await this.open()
        const transaction = db.transaction('profiles', 'readonly')
        const values = await requestValue(transaction.objectStore('profiles').getAll()) as R2ProfileV2[]
        await transactionDone(transaction)
        values.forEach(validateR2ProfileV2)
        return values.map(cloneProfile).sort((left, right) => left.name.localeCompare(right.name))
    }

    async enqueue(jobs: readonly UploadJob[]): Promise<UploadJob[]> {
        jobs.forEach(job => {
            validateUploadJob(job)
            validateInitialUploadJob(job)
        })
        const db = await this.open()
        const transaction = db.transaction('jobs', 'readwrite')
        const store = transaction.objectStore('jobs')
        const results: Promise<UploadJob>[] = []
        for (const job of jobs) {
            results.push((async () => {
                const key = dedupeKey(job)
                const existing = await requestValue(store.index('by-dedupe').get(key)) as StoredUploadJob | undefined
                if (existing) return cloneJob(existing)
                const stored: StoredUploadJob = { ...cloneJob(job), dedupeKey: key }
                store.add(stored)
                return cloneJob(stored)
            })())
        }
        const resolved = await Promise.all(results)
        await transactionDone(transaction)
        return resolved
    }

    async getJob(id: string): Promise<UploadJob | null> {
        const db = await this.open()
        const transaction = db.transaction('jobs', 'readonly')
        const value = await requestValue(transaction.objectStore('jobs').get(id)) as StoredUploadJob | undefined
        await transactionDone(transaction)
        if (!value) return null
        validateUploadJob(value)
        return cloneJob(value)
    }

    async listJobs(profileId?: string): Promise<UploadJob[]> {
        const db = await this.open()
        const transaction = db.transaction('jobs', 'readonly')
        const store = transaction.objectStore('jobs')
        const values = profileId
            ? await requestValue(store.index('by-profile').getAll(this.keyRange.bound([profileId, ''], [profileId, '\uffff']))) as StoredUploadJob[]
            : await requestValue(store.getAll()) as StoredUploadJob[]
        await transactionDone(transaction)
        values.forEach(validateUploadJob)
        return values.map(cloneJob).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    }

    async updateJob(
        id: string,
        expectedVersion: number,
        update: Partial<Pick<UploadJob, 'state' | 'attempt' | 'nextAttemptAt' | 'multipart' | 'diagnosticEventId' | 'remoteKey' | 'linkExpectedArtifactVersion' | 'remoteRef'>>,
        now = new Date().toISOString(),
    ): Promise<UploadJob> {
        const db = await this.open()
        const transaction = db.transaction('jobs', 'readwrite')
        const store = transaction.objectStore('jobs')
        const current = await requestValue(store.get(id)) as StoredUploadJob | undefined
        if (!current) {
            transaction.abort()
            throw new R2UploadRepositoryError('E_R2_NOT_FOUND', 'R2 upload job was not found')
        }
        if (current.version !== expectedVersion) {
            transaction.abort()
            throw new R2UploadRepositoryError('E_R2_VERSION_CONFLICT', 'R2 upload job version changed')
        }
        if (isTerminal(current.state)) {
            transaction.abort()
            throw new R2UploadRepositoryError('E_R2_TERMINAL_IMMUTABLE', 'Terminal R2 upload jobs are immutable')
        }
        const nextState = update.state ?? current.state
        if (current.contractVersion === 'phase7-v1') {
            if (!PHASE7_TRANSITIONS[current.state].includes(nextState)) {
                transaction.abort()
                throw new R2UploadRepositoryError('E_R2_VERSION_CONFLICT', 'Phase 7 R2 job state transition is invalid')
            }
            if (update.remoteKey !== undefined && update.remoteKey !== current.remoteKey) {
                transaction.abort()
                throw new R2UploadRepositoryError('E_R2_RECORD_INVALID', 'Phase 7 R2 remote key is immutable after enqueue')
            }
            const settingVerifiedRef = current.state === 'verifying'
                && nextState === 'verified'
                && current.remoteRef === null
                && update.remoteRef !== undefined
                && update.remoteRef !== null
            if (update.remoteRef !== undefined && !settingVerifiedRef
                && JSON.stringify(update.remoteRef) !== JSON.stringify(current.remoteRef)) {
                transaction.abort()
                throw new R2UploadRepositoryError('E_R2_RECORD_INVALID', 'Phase 7 verified remote reference is immutable')
            }
            if (update.linkExpectedArtifactVersion !== undefined
                && update.linkExpectedArtifactVersion !== current.linkExpectedArtifactVersion
                && (current.state !== 'linking' || nextState !== 'linking')) {
                transaction.abort()
                throw new R2UploadRepositoryError('E_R2_RECORD_INVALID', 'Phase 7 Artifact CAS cursor may change only during linkage recovery')
            }
        }
        const next: StoredUploadJob = {
            ...current,
            ...update,
            updatedAt: now,
            version: current.version + 1,
            dedupeKey: current.dedupeKey,
        }
        validateUploadJob(next)
        store.put(next)
        await transactionDone(transaction)
        return cloneJob(next)
    }

    /** Commits the verified manifest fact and terminal job transition without a crash window. */
    async succeedJobWithManifest(
        profile: R2ProfileV2,
        id: string,
        expectedVersion: number,
        item: R2ManifestV2Item,
        now = new Date().toISOString(),
    ): Promise<UploadJob> {
        assertSafeValue(item)
        if (item.profileId !== profile.id) {
            throw new R2UploadRepositoryError('E_R2_RECORD_INVALID', 'R2 manifest item profile does not match its authority')
        }
        const observed = await this.getJob(id)
        if (!observed) throw new R2UploadRepositoryError('E_R2_NOT_FOUND', 'R2 upload job was not found')
        if (observed.contractVersion === 'phase7-v1') {
            if (observed.version !== expectedVersion || observed.state !== 'linking' || observed.remoteRef === null) {
                throw new R2UploadRepositoryError('E_R2_VERSION_CONFLICT', 'Phase 7 R2 job is not ready for terminal commit')
            }
            if (!observed.profileSnapshot
                || profile.id !== observed.profileId
                || profile.bucket !== observed.profileSnapshot.bucket
                || hashR2ProfileV2(profile) !== hashR2ProfileV2(observed.profileSnapshot)
                || observed.remoteRef.profileHash !== hashR2ProfileV2(profile)
                || observed.remoteRef.bucket !== profile.bucket) {
                throw new R2UploadRepositoryError('E_R2_RECORD_INVALID', 'Supplied R2 profile does not match the durable Phase 7 authority')
            }
            const artifact = await this.artifactReader?.get(observed.artifactId)
            if (!artifact || !artifact.remoteObjectRefs.some(reference => isExactPhase7ArtifactRef(reference, observed.remoteRef!))) {
                throw new R2UploadRepositoryError('E_R2_RECORD_INVALID', 'Phase 7 Artifact authority does not confirm the verified remote reference')
            }
        }
        const db = await this.open()
        const manifestId = `${item.profileId}\u001f${item.remoteKey}`
        const transaction = db.transaction(['jobs', 'manifest'], 'readwrite')
        const jobs = transaction.objectStore('jobs')
        const current = await requestValue(jobs.get(id)) as StoredUploadJob | undefined
        if (!current) {
            transaction.abort()
            throw new R2UploadRepositoryError('E_R2_NOT_FOUND', 'R2 upload job was not found')
        }
        if (current.version !== expectedVersion) {
            transaction.abort()
            throw new R2UploadRepositoryError('E_R2_VERSION_CONFLICT', 'R2 upload job version changed')
        }
        if (isTerminal(current.state)) {
            transaction.abort()
            throw new R2UploadRepositoryError('E_R2_TERMINAL_IMMUTABLE', 'Terminal R2 upload jobs are immutable')
        }
        if (current.contractVersion === 'legacy-v1' && current.state !== 'running') {
            transaction.abort()
            throw new R2UploadRepositoryError('E_R2_VERSION_CONFLICT', 'R2 upload job is not running')
        }
        if (current.contractVersion === 'phase7-v1' && (current.state !== 'linking'
            || current.remoteRef === null
            || observed.contractVersion !== 'phase7-v1'
            || JSON.stringify(current.remoteRef) !== JSON.stringify(observed.remoteRef)
            || current.profileSnapshot === null
            || current.profileId !== profile.id
            || current.profileSnapshot.bucket !== profile.bucket
            || hashR2ProfileV2(current.profileSnapshot) !== hashR2ProfileV2(profile)
            || current.remoteRef.profileHash !== hashR2ProfileV2(profile)
            || current.remoteRef.bucket !== profile.bucket)) {
            transaction.abort()
            throw new R2UploadRepositoryError('E_R2_VERSION_CONFLICT', 'Phase 7 R2 job is not linked')
        }
        if (item.artifactId !== current.artifactId
            || item.localVariant !== current.localVariant
            || item.remoteKey !== current.remoteKey
            || item.contentSha256 !== current.contentSha256
            || item.size !== current.size
            || item.completedAt !== now) {
            transaction.abort()
            throw new R2UploadRepositoryError('E_R2_RECORD_INVALID', 'R2 manifest item does not exactly match its upload job')
        }
        const succeeded: StoredUploadJob = {
            ...current,
            state: 'succeeded',
            updatedAt: now,
            version: current.version + 1,
        }
        validateUploadJob(succeeded)
        jobs.put(succeeded)
        transaction.objectStore('manifest').put({ ...item, id: manifestId })
        await transactionDone(transaction)

        const readback = db.transaction(['jobs', 'manifest'], 'readonly')
        const [storedJob, storedItem] = await Promise.all([
            requestValue(readback.objectStore('jobs').get(id)) as Promise<StoredUploadJob | undefined>,
            requestValue(readback.objectStore('manifest').get(manifestId)) as Promise<(R2ManifestV2Item & { id: string }) | undefined>,
        ])
        await transactionDone(readback)
        if (!storedJob || storedJob.state !== 'succeeded' || storedJob.version !== succeeded.version
            || !storedItem || storedItem.contentSha256 !== item.contentSha256 || storedItem.size !== item.size
            || storedItem.completedAt !== item.completedAt) {
            throw new R2UploadRepositoryError('E_R2_NOT_FOUND', 'Atomic R2 completion was not readable')
        }
        validateUploadJob(storedJob)
        return cloneJob(storedJob)
    }

    async recoverInterrupted(now = new Date().toISOString()): Promise<number> {
        const jobs = await this.listJobs()
        let recovered = 0
        for (const job of jobs) {
            if (job.state !== 'running') continue
            await this.updateJob(job.id, job.version, { state: 'queued', nextAttemptAt: now }, now)
            recovered += 1
        }
        return recovered
    }

    async putManifestItem(profile: R2ProfileV2, item: R2ManifestV2Item): Promise<void> {
        assertSafeValue(item)
        if (item.profileId !== profile.id) {
            throw new R2UploadRepositoryError('E_R2_RECORD_INVALID', 'R2 manifest item profile does not match its authority')
        }
        const db = await this.open()
        const id = `${item.profileId}\u001f${item.remoteKey}`
        const transaction = db.transaction('manifest', 'readwrite')
        transaction.objectStore('manifest').put({ ...item, id })
        await transactionDone(transaction)

        // Manifest identity depends on the profile and remote key. Reading that exact record verifies
        // durable commit without rebuilding the growing profile manifest after every uploaded object.
        const readbackTransaction = db.transaction('manifest', 'readonly')
        const readback = await requestValue(readbackTransaction.objectStore('manifest').get(id)) as
            | (R2ManifestV2Item & { id: string })
            | undefined
        await transactionDone(readbackTransaction)
        if (!readback || readback.contentSha256 !== item.contentSha256 || readback.size !== item.size) {
            throw new R2UploadRepositoryError('E_R2_NOT_FOUND', 'R2 manifest write was not readable')
        }
    }

    async getManifest(profile: R2ProfileV2): Promise<R2ManifestV2> {
        const db = await this.open()
        const transaction = db.transaction('manifest', 'readonly')
        const values = await requestValue(transaction.objectStore('manifest').index('by-profile').getAll(
            this.keyRange.bound([profile.id, ''], [profile.id, '\uffff']),
        )) as Array<R2ManifestV2Item & { id: string }>
        await transactionDone(transaction)
        const items = values.map(({ id: _id, ...item }) => item).sort((left, right) => left.remoteKey.localeCompare(right.remoteKey))
        return {
            schemaVersion: 2,
            profileId: profile.id,
            bucket: profile.bucket,
            prefix: profile.prefix,
            updatedAt: items[items.length - 1]?.completedAt ?? profile.updatedAt,
            items,
        }
    }
}

export function createUploadJob(
    profileId: string,
    artifact: Pick<UploadJob, 'artifactId' | 'localVariant' | 'remoteKey' | 'contentSha256' | 'contentType' | 'size'>,
    options: {
        id?: string
        now?: string
        maxAttempts?: number
        partSize?: number
        profileSnapshot?: R2ProfileV2
        artifactBinding?: Phase7ArtifactBinding
    } = {},
): UploadJob {
    const now = options.now ?? new Date().toISOString()
    const phase7 = options.profileSnapshot !== undefined || options.artifactBinding !== undefined
    if (phase7 && (!options.profileSnapshot || !options.artifactBinding)) {
        throw new R2UploadRepositoryError('E_R2_RECORD_INVALID', 'Phase 7 upload jobs require both durable bindings')
    }
    return {
        id: options.id ?? crypto.randomUUID(),
        contractVersion: phase7 ? 'phase7-v1' : 'legacy-v1',
        profileId,
        profileSnapshot: options.profileSnapshot ? structuredClone(options.profileSnapshot) : null,
        artifactBinding: options.artifactBinding ? structuredClone(options.artifactBinding) : null,
        linkExpectedArtifactVersion: options.artifactBinding?.artifactVersion ?? null,
        remoteRef: null as Phase7RemoteObjectRef | null,
        ...artifact,
        state: 'queued',
        attempt: 0,
        maxAttempts: options.maxAttempts ?? 5,
        nextAttemptAt: now,
        multipart: {
            uploadId: null,
            completedParts: [],
            partSize: options.partSize ?? 8 * 1024 * 1024,
        },
        diagnosticEventId: null,
        createdAt: now,
        updatedAt: now,
        version: 1,
    }
}

export function appendCompletedPart(job: UploadJob, part: UploadCompletedPart): UploadJob['multipart'] {
    const completedParts = [...job.multipart.completedParts.filter(item => item.partNumber !== part.partNumber), part]
        .sort((left, right) => left.partNumber - right.partNumber)
    return { ...job.multipart, completedParts }
}
