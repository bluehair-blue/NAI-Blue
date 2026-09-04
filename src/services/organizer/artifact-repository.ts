import {
    assertArtifactOriginalUnchanged,
    createArtifactRecord,
    isOrganizerChecksum,
    projectArtifactPortableFile,
    type ArtifactRecord,
    type ArtifactRemoteObjectRef,
    type CreateArtifactRecordInput,
    type DistributionVariant,
} from '@/domain/organizer/types'

// Physical database names stay stable so organizer history survives the rename.
export const ORGANIZER_ARTIFACT_DATABASE_NAME = 'nai-blue-organizer-artifacts'
export const ORGANIZER_ARTIFACT_DATABASE_VERSION = 1

const FORBIDDEN_KEY = /(?:token|authorization|signed.?url|secret|password|prompt|base64|absolute.?path|display.?path|native.?path|opaque.?token)/i
const SIGNED_URL_VALUE = /[?&](?:x-amz-(?:credential|signature|security-token)|signature)=/i

export type ArtifactRepositoryErrorCode =
    | 'E_ARTIFACT_DB_UNAVAILABLE'
    | 'E_ARTIFACT_DB_BLOCKED'
    | 'E_ARTIFACT_NOT_FOUND'
    | 'E_ARTIFACT_VERSION_CONFLICT'
    | 'E_ARTIFACT_RECORD_INVALID'
    | 'E_ARTIFACT_VARIANT_NOT_FOUND'

export class ArtifactRepositoryError extends Error {
    constructor(readonly code: ArtifactRepositoryErrorCode, message: string) {
        super(message)
        this.name = 'ArtifactRepositoryError'
    }
}

export interface ArtifactRepositoryOptions {
    readonly factory?: IDBFactory
    readonly keyRange?: typeof IDBKeyRange
    readonly databaseName?: string
    readonly openTimeoutMs?: number
}

export interface ArtifactPage {
    readonly items: readonly ArtifactRecord[]
    readonly nextCursor: string | null
}

/**
 * Narrow rollback guard for an original that was registered in the same
 * OutputWriter transaction. Distribution/remote state makes the record shared
 * authority, so those records must remain immutable and cannot be removed.
 */
export interface RemoveOriginalIfUnmodifiedInput {
    readonly artifactId: string
    readonly file: CreateArtifactRecordInput['file']
    readonly contentChecksum: string
    readonly size: number
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

function clone<T>(value: T): T {
    return structuredClone(value)
}

function assertSafeValue(value: unknown, path: readonly string[] = []): void {
    if (Array.isArray(value)) {
        value.forEach((entry, index) => assertSafeValue(entry, [...path, String(index)]))
        return
    }
    if (value !== null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            if (FORBIDDEN_KEY.test(key)) {
                throw new ArtifactRepositoryError('E_ARTIFACT_RECORD_INVALID', `Artifact records cannot persist ${[...path, key].join('.')}.`)
            }
            assertSafeValue(child, [...path, key])
        }
        return
    }
    if (typeof value === 'string' && (value.startsWith('Bearer ') || SIGNED_URL_VALUE.test(value))) {
        throw new ArtifactRepositoryError('E_ARTIFACT_RECORD_INVALID', `Artifact records cannot persist provider credentials at ${path.join('.')}.`)
    }
}

function assertTimestamp(value: string, field: string): void {
    if (!Number.isFinite(Date.parse(value))) {
        throw new ArtifactRepositoryError('E_ARTIFACT_RECORD_INVALID', `${field} must be an ISO timestamp.`)
    }
}

function assertDistributionPolicy(variant: DistributionVariant): void {
    const { policy } = variant
    projectArtifactPortableFile({ directory: policy.destination, fileName: 'distribution-probe.png' })
    if (!policy.filenameTemplate.trim()
        || !['unique', 'overwrite', 'error'].includes(policy.collisionPolicy)
        || !Number.isFinite(policy.quality)
        || policy.quality < 0
        || policy.quality > 1
        || !['preserve', 'flatten'].includes(policy.alphaPolicy)
        || !['preserve', 'strip'].includes(policy.metadataPolicy)
        || !/^#[a-f\d]{6}$/i.test(policy.matteColor)) {
        throw new ArtifactRepositoryError('E_ARTIFACT_RECORD_INVALID', 'Distribution policy is invalid.')
    }
    if (policy.r2FollowUp !== null && (!policy.r2FollowUp.profileId.trim()
        || policy.r2FollowUp.remoteKeyPrefix.split('/').some(segment => !segment || segment === '.' || segment === '..' || /[\\\0]/.test(segment)))) {
        throw new ArtifactRepositoryError('E_ARTIFACT_RECORD_INVALID', 'Distribution R2 follow-up policy is invalid.')
    }
}

function assertDistribution(variant: DistributionVariant): void {
    if (!variant.variantId.trim()
        || !variant.requestedFileName.trim()
        || /[\\/\0]/.test(variant.requestedFileName)
        || !['pending', 'running', 'succeeded', 'failed', 'cancelled'].includes(variant.status)
        || !['png', 'webp'].includes(variant.format)
        || !Number.isFinite(variant.sanitizationPolicyVersion)
        || !Number.isFinite(Date.parse(variant.createdAt))
        || !Number.isFinite(Date.parse(variant.updatedAt))) {
        throw new ArtifactRepositoryError('E_ARTIFACT_RECORD_INVALID', 'Distribution variant is invalid.')
    }
    assertDistributionPolicy(variant)
    if (variant.file !== null) projectArtifactPortableFile(variant.file)
    if (variant.contentChecksum !== null && !isOrganizerChecksum(variant.contentChecksum)) {
        throw new ArtifactRepositoryError('E_ARTIFACT_RECORD_INVALID', 'Distribution checksum is invalid.')
    }
    if (variant.sidecar !== null) {
        projectArtifactPortableFile(variant.sidecar.file)
        if (!isOrganizerChecksum(variant.sidecar.digest)) {
            throw new ArtifactRepositoryError('E_ARTIFACT_RECORD_INVALID', 'Distribution sidecar checksum is invalid.')
        }
    }
}

export function validateArtifactRecord(record: ArtifactRecord): void {
    assertSafeValue(record)
    if (record.schemaVersion !== 1
        || !record.artifactId.trim()
        || (record.outputCommitSetHash !== undefined
            && record.outputCommitSetHash !== null
            && !isOrganizerChecksum(record.outputCommitSetHash))
        || !isOrganizerChecksum(record.contentChecksum)
        || record.original.contentChecksum !== record.contentChecksum
        || record.original.variantId !== 'original'
        || !Number.isSafeInteger(record.original.size)
        || record.original.size < 0
        || !Number.isSafeInteger(record.version)
        || record.version < 1
        || !Number.isFinite(record.sanitizationPolicyVersion)) {
        throw new ArtifactRepositoryError('E_ARTIFACT_RECORD_INVALID', 'Artifact record is invalid.')
    }
    if ((record.sourceJobId !== null && !record.sourceJobId.trim())
        || (record.sourceSceneId !== null && !record.sourceSceneId.trim())) {
        throw new ArtifactRepositoryError('E_ARTIFACT_RECORD_INVALID', 'Artifact source identities cannot be empty.')
    }
    projectArtifactPortableFile(record.original.file)
    assertTimestamp(record.createdAt, 'artifact.createdAt')
    assertTimestamp(record.updatedAt, 'artifact.updatedAt')
    assertTimestamp(record.original.createdAt, 'artifact.original.createdAt')
    const variants = new Set<string>()
    for (const variant of record.distributionVariants) {
        assertDistribution(variant)
        if (variants.has(variant.variantId)) {
            throw new ArtifactRepositoryError('E_ARTIFACT_RECORD_INVALID', 'Distribution variant identities must be unique.')
        }
        variants.add(variant.variantId)
    }
    if (record.sidecar !== null) {
        projectArtifactPortableFile(record.sidecar.file)
        if (!isOrganizerChecksum(record.sidecar.digest)) {
            throw new ArtifactRepositoryError('E_ARTIFACT_RECORD_INVALID', 'Artifact sidecar checksum is invalid.')
        }
    }
    for (const remote of record.remoteObjectRefs) {
        if (!remote.profileId.trim()
            || !remote.artifactId.trim()
            || !remote.variantId.trim()
            || !remote.remoteKey.trim()
            || remote.artifactId !== record.artifactId
            || !variants.has(remote.variantId)
            || !['queued', 'succeeded', 'failed', 'cancelled'].includes(remote.state)
            || !Number.isFinite(Date.parse(remote.updatedAt))) {
            throw new ArtifactRepositoryError('E_ARTIFACT_RECORD_INVALID', 'Artifact remote object reference is invalid.')
        }
    }
}

function projectRecord(record: ArtifactRecord): ArtifactRecord {
    return {
        ...clone(record),
        outputCommitSetHash: record.outputCommitSetHash ?? null,
        original: {
            ...record.original,
            file: projectArtifactPortableFile(record.original.file),
        },
        distributionVariants: record.distributionVariants.map(variant => ({
            ...variant,
            ...(variant.file === null ? {} : { file: projectArtifactPortableFile(variant.file) }),
            ...(variant.sidecar === null
                ? {}
                : { sidecar: { ...variant.sidecar, file: projectArtifactPortableFile(variant.sidecar.file) } }),
        })),
        ...(record.sidecar === null
            ? {}
            : { sidecar: { ...record.sidecar, file: projectArtifactPortableFile(record.sidecar.file) } }),
        remoteObjectRefs: record.remoteObjectRefs.map(reference => ({ ...reference })),
    }
}

export class IndexedDBArtifactRepository {
    private readonly factory: IDBFactory
    private readonly keyRange: typeof IDBKeyRange
    private readonly databaseName: string
    private readonly openTimeoutMs: number
    private dbPromise: Promise<IDBDatabase> | null = null

    constructor(options: ArtifactRepositoryOptions = {}) {
        this.factory = options.factory ?? indexedDB
        this.keyRange = options.keyRange ?? IDBKeyRange
        this.databaseName = options.databaseName ?? ORGANIZER_ARTIFACT_DATABASE_NAME
        this.openTimeoutMs = options.openTimeoutMs ?? 5_000
    }

    private open(): Promise<IDBDatabase> {
        if (this.dbPromise !== null) return this.dbPromise
        this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
            const request = this.factory.open(this.databaseName, ORGANIZER_ARTIFACT_DATABASE_VERSION)
            const timeout = setTimeout(() => {
                request.result?.close()
                reject(new ArtifactRepositoryError('E_ARTIFACT_DB_UNAVAILABLE', 'Artifact database open timed out.'))
            }, this.openTimeoutMs)
            request.onblocked = () => {
                clearTimeout(timeout)
                reject(new ArtifactRepositoryError('E_ARTIFACT_DB_BLOCKED', 'Artifact database upgrade is blocked.'))
            }
            request.onupgradeneeded = () => {
                const database = request.result
                if (!database.objectStoreNames.contains('artifacts')) {
                    const store = database.createObjectStore('artifacts', { keyPath: 'artifactId' })
                    store.createIndex('by-source-job', 'sourceJobId')
                    store.createIndex('by-source-scene', 'sourceSceneId')
                    store.createIndex('by-updated-at', ['updatedAt', 'artifactId'])
                }
            }
            request.onerror = () => {
                clearTimeout(timeout)
                reject(new ArtifactRepositoryError('E_ARTIFACT_DB_UNAVAILABLE', 'Artifact database could not be opened.'))
            }
            request.onsuccess = () => {
                clearTimeout(timeout)
                request.result.onversionchange = () => request.result.close()
                resolve(request.result)
            }
        }).catch(error => {
            this.dbPromise = null
            throw error
        })
        return this.dbPromise
    }

    async close(): Promise<void> {
        const database = await this.dbPromise?.catch(() => null)
        database?.close()
        this.dbPromise = null
    }

    async putOriginal(input: CreateArtifactRecordInput): Promise<ArtifactRecord> {
        const candidate = createArtifactRecord(input)
        validateArtifactRecord(candidate)
        const database = await this.open()
        const transaction = database.transaction('artifacts', 'readwrite')
        const store = transaction.objectStore('artifacts')
        const existing = await requestValue(store.get(candidate.artifactId)) as ArtifactRecord | undefined
        if (existing !== undefined) {
            validateArtifactRecord(existing)
            try {
                assertArtifactOriginalUnchanged(existing, candidate.original, candidate.outputCommitSetHash)
            } catch (error) {
                transaction.abort()
                throw error
            }
        } else {
            store.add(projectRecord(candidate))
        }
        await transactionDone(transaction)
        const readback = await this.get(candidate.artifactId)
        if (readback === null) throw new ArtifactRepositoryError('E_ARTIFACT_NOT_FOUND', 'Artifact write was not readable.')
        return readback
    }

    async removeOriginalIfUnmodified(input: RemoveOriginalIfUnmodifiedInput): Promise<boolean> {
        const expectedFile = projectArtifactPortableFile(input.file)
        if (!input.artifactId.trim()
            || !isOrganizerChecksum(input.contentChecksum)
            || !Number.isSafeInteger(input.size)
            || input.size < 0) {
            throw new ArtifactRepositoryError('E_ARTIFACT_RECORD_INVALID', 'Artifact rollback identity is invalid.')
        }
        const database = await this.open()
        const transaction = database.transaction('artifacts', 'readwrite')
        const store = transaction.objectStore('artifacts')
        const existing = await requestValue(store.get(input.artifactId)) as ArtifactRecord | undefined
        if (existing === undefined) {
            await transactionDone(transaction)
            return false
        }
        validateArtifactRecord(existing)
        const removable = existing.version === 1
            && existing.distributionVariants.length === 0
            && existing.remoteObjectRefs.length === 0
            && existing.sidecar === null
            && existing.contentChecksum === input.contentChecksum
            && existing.original.size === input.size
            && JSON.stringify(existing.original.file) === JSON.stringify(expectedFile)
        if (!removable) {
            await transactionDone(transaction)
            return false
        }
        store.delete(input.artifactId)
        await transactionDone(transaction)
        return true
    }

    async get(artifactId: string): Promise<ArtifactRecord | null> {
        const database = await this.open()
        const transaction = database.transaction('artifacts', 'readonly')
        const value = await requestValue(transaction.objectStore('artifacts').get(artifactId)) as ArtifactRecord | undefined
        await transactionDone(transaction)
        if (value === undefined) return null
        validateArtifactRecord(value)
        return projectRecord(value)
    }

    async list(options: { cursor?: string | null; limit?: number } = {}): Promise<ArtifactPage> {
        const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 100)))
        const database = await this.open()
        const transaction = database.transaction('artifacts', 'readonly')
        const store = transaction.objectStore('artifacts')
        const range = options.cursor === undefined || options.cursor === null
            ? undefined
            : this.keyRange.lowerBound(options.cursor, true)
        const items: ArtifactRecord[] = []
        let nextCursor: string | null = null
        await new Promise<void>((resolve, reject) => {
            const request = store.openCursor(range)
            request.onerror = () => reject(request.error ?? new Error('Artifact cursor failed.'))
            request.onsuccess = () => {
                const cursor = request.result
                if (cursor === null) {
                    resolve()
                    return
                }
                if (items.length >= limit) {
                    // `cursor` is the first unconsumed record.  Keep the last
                    // emitted key as an exclusive cursor so no artifact is
                    // silently skipped between virtual-browser pages.
                    nextCursor = items[items.length - 1]?.artifactId ?? null
                    resolve()
                    return
                }
                const record = cursor.value as ArtifactRecord
                validateArtifactRecord(record)
                items.push(projectRecord(record))
                cursor.continue()
            }
        })
        await transactionDone(transaction)
        return { items, nextCursor }
    }

    async addDistribution(artifactId: string, variant: DistributionVariant, now = new Date().toISOString()): Promise<ArtifactRecord> {
        return this.mutate(artifactId, undefined, record => {
            if (record.distributionVariants.some(candidate => candidate.variantId === variant.variantId)) {
                return record
            }
            return {
                ...record,
                distributionVariants: [...record.distributionVariants, clone(variant)],
                updatedAt: now,
                version: record.version + 1,
            }
        })
    }

    async updateDistribution(
        artifactId: string,
        variantId: string,
        expectedVersion: number | undefined,
        update: (variant: DistributionVariant, record: ArtifactRecord) => DistributionVariant,
        now = new Date().toISOString(),
    ): Promise<ArtifactRecord> {
        return this.mutate(artifactId, expectedVersion, record => {
            let found = false
            const distributionVariants = record.distributionVariants.map(variant => {
                if (variant.variantId !== variantId) return variant
                found = true
                return update(variant, record)
            })
            if (!found) throw new ArtifactRepositoryError('E_ARTIFACT_VARIANT_NOT_FOUND', 'Artifact distribution variant was not found.')
            const latestSidecar = [...distributionVariants].reverse().find(variant => variant.sidecar !== null)?.sidecar ?? record.sidecar
            return {
                ...record,
                distributionVariants,
                sidecar: latestSidecar,
                updatedAt: now,
                version: record.version + 1,
            }
        })
    }

    async replaceRemoteObjectRef(
        artifactId: string,
        remote: ArtifactRemoteObjectRef,
        now = new Date().toISOString(),
    ): Promise<ArtifactRecord> {
        return this.mutate(artifactId, undefined, record => {
            const remaining = record.remoteObjectRefs.filter(reference => !(
                reference.profileId === remote.profileId
                && reference.variantId === remote.variantId
                && reference.remoteKey === remote.remoteKey
            ))
            return {
                ...record,
                remoteObjectRefs: [...remaining, clone(remote)],
                updatedAt: now,
                version: record.version + 1,
            }
        })
    }

    private async mutate(
        artifactId: string,
        expectedVersion: number | undefined,
        update: (record: ArtifactRecord) => ArtifactRecord,
    ): Promise<ArtifactRecord> {
        const database = await this.open()
        const transaction = database.transaction('artifacts', 'readwrite')
        const store = transaction.objectStore('artifacts')
        const existing = await requestValue(store.get(artifactId)) as ArtifactRecord | undefined
        if (existing === undefined) {
            transaction.abort()
            throw new ArtifactRepositoryError('E_ARTIFACT_NOT_FOUND', 'Artifact record was not found.')
        }
        validateArtifactRecord(existing)
        if (expectedVersion !== undefined && existing.version !== expectedVersion) {
            transaction.abort()
            throw new ArtifactRepositoryError('E_ARTIFACT_VERSION_CONFLICT', 'Artifact record version changed.')
        }
        const next = projectRecord(update(projectRecord(existing)))
        try {
            assertArtifactOriginalUnchanged(existing, next.original, next.outputCommitSetHash)
            validateArtifactRecord(next)
        } catch (error) {
            transaction.abort()
            throw error
        }
        store.put(next)
        await transactionDone(transaction)
        const readback = await this.get(artifactId)
        if (readback === null || readback.version !== next.version) {
            throw new ArtifactRepositoryError('E_ARTIFACT_NOT_FOUND', 'Artifact mutation was not readable.')
        }
        return readback
    }
}
