import { hashCanonicalValue } from './canonical-serialize'
import {
    applyCompositionChangeSet,
    CompositionAuthoringError,
} from './authoring'
import { parseCompositionDocument } from './schema'
import type { CompositionChangeSet, CompositionDocument } from './types'

export const COMPOSITION_REPOSITORY_STORAGE_KEY = 'nai-blue-composition-repository' as const
export const COMPOSITION_MIGRATION_BACKUP_STORAGE_KEY = 'nai-blue-composition-migration-backup' as const
export const COMPOSITION_REPOSITORY_FORMAT = 'nai-blue-composition-repository' as const
export const COMPOSITION_REPOSITORY_SCHEMA_VERSION = 1 as const

export type CompositionAuthority = 'legacy' | 'v2'

export interface CompositionMigrationLock {
    id: string
    owner: string
    acquiredAt: string
    expiresAt: string
}

export interface StagedCompositionDocument {
    migrationId: string
    document: CompositionDocument
    documentHash: string
    writtenAt: string
}

export interface CompositionMigrationMarker {
    migrationId: string
    registryVersion: number
    sourceHash: string
    sourceCounts: Record<string, number>
    targetHash: string
    targetCounts: Record<string, number>
    reportHash: string
    committedAt: string
    startupVerifiedAt?: string
}

export interface CompositionRepositoryRecord {
    format: typeof COMPOSITION_REPOSITORY_FORMAT
    repositorySchemaVersion: typeof COMPOSITION_REPOSITORY_SCHEMA_VERSION
    revision: number
    authority: CompositionAuthority
    committedDocument?: CompositionDocument
    committedHash?: string
    staged?: StagedCompositionDocument
    migrationMarker?: CompositionMigrationMarker
    migrationLock?: CompositionMigrationLock
    updatedAt: string
}

export interface CompositionRepositoryStorage {
    getItem(key: string): string | null | Promise<string | null>
    setItem(key: string, value: string): unknown | Promise<unknown>
    removeItem?(key: string): unknown | Promise<unknown>
    flush?(key: string): unknown | Promise<unknown>
    compareAndSet?(
        key: string,
        expected: string | null,
        next: string,
    ): boolean | Promise<boolean>
}

export interface AcquireCompositionMigrationLockInput {
    id: string
    owner: string
    now: string
    ttlMs?: number
}

export interface CommitStagedCompositionInput {
    lockId: string
    marker: CompositionMigrationMarker
    now: string
}

export interface FinalizeCommittedCompositionInput {
    lockId: string
    migrationId: string
    targetHash: string
    now: string
}

export class CompositionRepositoryError extends Error {
    constructor(
        readonly code:
            | 'E_REPOSITORY_JSON_INVALID'
            | 'E_REPOSITORY_SCHEMA_NEWER'
            | 'E_REPOSITORY_RECORD_INVALID'
            | 'E_REPOSITORY_WRITE_VERIFY'
            | 'E_REPOSITORY_CONFLICT'
            | 'E_AUTHORING_STALE_REVISION'
            | 'E_AUTHORING_VALIDATION_FAILED'
            | 'E_MIGRATION_LOCKED'
            | 'E_MIGRATION_LOCK_LOST'
            | 'E_STAGED_DOCUMENT_MISSING'
            | 'E_V2_DOCUMENT_MISSING',
        message: string,
    ) {
        super(message)
        this.name = 'CompositionRepositoryError'
    }
}

function cloneDocument(document: CompositionDocument): CompositionDocument {
    return parseCompositionDocument(JSON.parse(JSON.stringify(document)) as unknown)
}

function emptyRecord(now: string): CompositionRepositoryRecord {
    return {
        format: COMPOSITION_REPOSITORY_FORMAT,
        repositorySchemaVersion: COMPOSITION_REPOSITORY_SCHEMA_VERSION,
        revision: 0,
        authority: 'legacy',
        updatedAt: now,
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireString(record: Record<string, unknown>, key: string): string {
    const value = record[key]
    if (typeof value !== 'string' || value.length === 0) {
        throw new CompositionRepositoryError(
            'E_REPOSITORY_RECORD_INVALID',
            `Composition repository field ${key} must be a non-empty string`,
        )
    }
    return value
}

function requireCounts(value: unknown, key: string): Record<string, number> {
    if (!isRecord(value)) {
        throw new CompositionRepositoryError(
            'E_REPOSITORY_RECORD_INVALID',
            `Composition repository field ${key} must be a count record`,
        )
    }
    const result: Record<string, number> = {}
    for (const [name, count] of Object.entries(value)) {
        if (!Number.isInteger(count) || (count as number) < 0) {
            throw new CompositionRepositoryError(
                'E_REPOSITORY_RECORD_INVALID',
                `Composition repository count ${key}.${name} is invalid`,
            )
        }
        result[name] = count as number
    }
    return result
}

function parseLock(value: unknown): CompositionMigrationLock | undefined {
    if (value === undefined) return undefined
    if (!isRecord(value)) {
        throw new CompositionRepositoryError('E_REPOSITORY_RECORD_INVALID', 'Migration lock must be an object')
    }
    return {
        id: requireString(value, 'id'),
        owner: requireString(value, 'owner'),
        acquiredAt: requireString(value, 'acquiredAt'),
        expiresAt: requireString(value, 'expiresAt'),
    }
}

function parseMarker(value: unknown): CompositionMigrationMarker | undefined {
    if (value === undefined) return undefined
    if (!isRecord(value) || !Number.isInteger(value.registryVersion)) {
        throw new CompositionRepositoryError('E_REPOSITORY_RECORD_INVALID', 'Migration marker is invalid')
    }
    return {
        migrationId: requireString(value, 'migrationId'),
        registryVersion: value.registryVersion as number,
        sourceHash: requireString(value, 'sourceHash'),
        sourceCounts: requireCounts(value.sourceCounts, 'sourceCounts'),
        targetHash: requireString(value, 'targetHash'),
        targetCounts: requireCounts(value.targetCounts, 'targetCounts'),
        reportHash: requireString(value, 'reportHash'),
        committedAt: requireString(value, 'committedAt'),
        ...(value.startupVerifiedAt === undefined
            ? {}
            : { startupVerifiedAt: requireString(value, 'startupVerifiedAt') }),
    }
}

export function compositionDocumentCounts(document: CompositionDocument): Record<string, number> {
    return {
        profiles: document.profiles.length,
        modules: document.modules.length,
        recipes: document.recipes.length,
        characters: document.characters.length,
        paramsPresets: document.paramsPresets.length,
        resources: document.resources.length,
        randomRules: document.randomRules.length,
        contributions: document.profiles.reduce((count, profile) => count + profile.contributions.length, 0)
            + document.modules.reduce((count, module) => count + module.contributions.length, 0)
            + document.recipes.reduce((count, recipe) => count + recipe.steps.reduce(
                (stepCount, step) => stepCount + step.contributions.length,
                0,
            ), 0),
    }
}

export function compositionDocumentHash(document: CompositionDocument): string {
    return `sha256:${hashCanonicalValue(parseCompositionDocument(document))}`
}

function parseRepositoryRecord(value: unknown): CompositionRepositoryRecord {
    if (!isRecord(value)) {
        throw new CompositionRepositoryError('E_REPOSITORY_RECORD_INVALID', 'Composition repository must be an object')
    }
    if (value.repositorySchemaVersion !== COMPOSITION_REPOSITORY_SCHEMA_VERSION) {
        if (typeof value.repositorySchemaVersion === 'number'
            && value.repositorySchemaVersion > COMPOSITION_REPOSITORY_SCHEMA_VERSION) {
            throw new CompositionRepositoryError(
                'E_REPOSITORY_SCHEMA_NEWER',
                `Unsupported composition repository schema ${value.repositorySchemaVersion}`,
            )
        }
        throw new CompositionRepositoryError(
            'E_REPOSITORY_RECORD_INVALID',
            'Unsupported composition repository record',
        )
    }
    if (value.format !== COMPOSITION_REPOSITORY_FORMAT
        || !Number.isInteger(value.revision)
        || (value.revision as number) < 0
        || (value.authority !== 'legacy' && value.authority !== 'v2')) {
        throw new CompositionRepositoryError('E_REPOSITORY_RECORD_INVALID', 'Composition repository header is invalid')
    }

    const committedDocument = value.committedDocument === undefined
        ? undefined
        : parseCompositionDocument(value.committedDocument)
    const committedHash = value.committedHash === undefined
        ? undefined
        : requireString(value, 'committedHash')
    if ((committedDocument === undefined) !== (committedHash === undefined)) {
        throw new CompositionRepositoryError(
            'E_REPOSITORY_RECORD_INVALID',
            'Committed document and hash must be present together',
        )
    }
    if (committedDocument !== undefined && compositionDocumentHash(committedDocument) !== committedHash) {
        throw new CompositionRepositoryError('E_REPOSITORY_RECORD_INVALID', 'Committed document hash mismatch')
    }
    if (value.authority === 'v2' && committedDocument === undefined) {
        throw new CompositionRepositoryError('E_V2_DOCUMENT_MISSING', 'V2 authority requires a committed document')
    }

    let staged: StagedCompositionDocument | undefined
    if (value.staged !== undefined) {
        if (!isRecord(value.staged)) {
            throw new CompositionRepositoryError('E_REPOSITORY_RECORD_INVALID', 'Staged document is invalid')
        }
        const document = parseCompositionDocument(value.staged.document)
        const documentHash = requireString(value.staged, 'documentHash')
        if (compositionDocumentHash(document) !== documentHash) {
            throw new CompositionRepositoryError('E_REPOSITORY_RECORD_INVALID', 'Staged document hash mismatch')
        }
        staged = {
            migrationId: requireString(value.staged, 'migrationId'),
            document,
            documentHash,
            writtenAt: requireString(value.staged, 'writtenAt'),
        }
    }

    const migrationMarker = parseMarker(value.migrationMarker)
    if (migrationMarker !== undefined) {
        if (committedDocument === undefined || committedHash === undefined) {
            throw new CompositionRepositoryError(
                'E_REPOSITORY_RECORD_INVALID',
                'Composition migration marker requires a committed document',
            )
        }
        if (migrationMarker.targetHash !== committedHash) {
            throw new CompositionRepositoryError(
                'E_REPOSITORY_RECORD_INVALID',
                'Composition migration marker target hash does not match the committed document',
            )
        }
        if (hashCanonicalValue(migrationMarker.targetCounts)
            !== hashCanonicalValue(compositionDocumentCounts(committedDocument))) {
            throw new CompositionRepositoryError(
                'E_REPOSITORY_RECORD_INVALID',
                'Composition migration marker target counts do not match the committed document',
            )
        }
    }

    return {
        format: COMPOSITION_REPOSITORY_FORMAT,
        repositorySchemaVersion: COMPOSITION_REPOSITORY_SCHEMA_VERSION,
        revision: value.revision as number,
        authority: value.authority,
        ...(committedDocument === undefined ? {} : { committedDocument }),
        ...(committedHash === undefined ? {} : { committedHash }),
        ...(staged === undefined ? {} : { staged }),
        ...(migrationMarker === undefined ? {} : { migrationMarker }),
        ...(value.migrationLock === undefined ? {} : { migrationLock: parseLock(value.migrationLock)! }),
        updatedAt: requireString(value, 'updatedAt'),
    }
}

/**
 * Strictly validates an externally supplied repository record.
 *
 * Backup/restore code must use the same invariants as live repository reads so
 * malformed locks, staged documents, hashes, or future schemas cannot bypass
 * repository validation.
 */
export function parseCompositionRepositoryRecord(value: unknown): CompositionRepositoryRecord {
    return parseRepositoryRecord(value)
}

export function createCommittedCompositionRepositoryRecord(
    document: CompositionDocument,
    options: {
        updatedAt: string
        authority?: CompositionAuthority
        revision?: number
        migrationMarker?: CompositionMigrationMarker
    },
): CompositionRepositoryRecord {
    const parsed = cloneDocument(document)
    const authority = options.authority ?? 'v2'
    return parseRepositoryRecord({
        format: COMPOSITION_REPOSITORY_FORMAT,
        repositorySchemaVersion: COMPOSITION_REPOSITORY_SCHEMA_VERSION,
        revision: options.revision ?? 1,
        authority,
        committedDocument: parsed,
        committedHash: compositionDocumentHash(parsed),
        ...(options.migrationMarker === undefined ? {} : { migrationMarker: options.migrationMarker }),
        updatedAt: options.updatedAt,
    })
}

function lockExpired(lock: CompositionMigrationLock, now: string): boolean {
    const expiresAt = Date.parse(lock.expiresAt)
    const current = Date.parse(now)
    return !Number.isFinite(expiresAt) || !Number.isFinite(current) || expiresAt <= current
}

export class CompositionRepository {
    constructor(
        private readonly storage: CompositionRepositoryStorage,
        private readonly key = COMPOSITION_REPOSITORY_STORAGE_KEY,
    ) {}

    private async readWithRaw(now: string): Promise<{
        raw: string | null
        record: CompositionRepositoryRecord
    }> {
        const raw = await this.storage.getItem(this.key)
        if (raw === null) return { raw, record: emptyRecord(now) }
        try {
            return { raw, record: parseRepositoryRecord(JSON.parse(raw) as unknown) }
        } catch (error) {
            if (error instanceof CompositionRepositoryError) throw error
            throw new CompositionRepositoryError(
                'E_REPOSITORY_JSON_INVALID',
                `Composition repository JSON is invalid: ${String(error)}`,
            )
        }
    }

    async read(now = new Date().toISOString()): Promise<CompositionRepositoryRecord> {
        return (await this.readWithRaw(now)).record
    }

    private async persist(
        record: CompositionRepositoryRecord,
        expectedRaw?: string | null,
    ): Promise<CompositionRepositoryRecord> {
        const verifiedRecord = parseRepositoryRecord(record)
        const serialized = JSON.stringify(verifiedRecord)
        if (expectedRaw !== undefined && this.storage.compareAndSet !== undefined) {
            const changed = await this.storage.compareAndSet(this.key, expectedRaw, serialized)
            if (!changed) {
                throw new CompositionRepositoryError(
                    'E_REPOSITORY_CONFLICT',
                    'Composition repository changed during an atomic update',
                )
            }
        } else {
            await this.storage.setItem(this.key, serialized)
            await this.storage.flush?.(this.key)
        }
        const readback = await this.storage.getItem(this.key)
        if (readback !== serialized) {
            throw new CompositionRepositoryError(
                'E_REPOSITORY_WRITE_VERIFY',
                'Composition repository write/readback verification failed',
            )
        }
        return parseRepositoryRecord(JSON.parse(readback) as unknown)
    }

    private requireLock(record: CompositionRepositoryRecord, lockId: string, now: string): void {
        if (record.migrationLock?.id !== lockId) {
            throw new CompositionRepositoryError('E_MIGRATION_LOCK_LOST', 'Composition migration lock was lost')
        }
        if (lockExpired(record.migrationLock, now)) {
            throw new CompositionRepositoryError('E_MIGRATION_LOCK_LOST', 'Composition migration lock expired')
        }
    }

    async acquireMigrationLock(
        input: AcquireCompositionMigrationLockInput,
    ): Promise<CompositionMigrationLock> {
        const { raw, record: current } = await this.readWithRaw(input.now)
        if (current.migrationLock !== undefined && !lockExpired(current.migrationLock, input.now)) {
            throw new CompositionRepositoryError(
                'E_MIGRATION_LOCKED',
                `Composition migration is already locked by ${current.migrationLock.owner}`,
            )
        }
        const ttlMs = input.ttlMs ?? 5 * 60 * 1000
        const lock: CompositionMigrationLock = {
            id: input.id,
            owner: input.owner,
            acquiredAt: input.now,
            expiresAt: new Date(Date.parse(input.now) + ttlMs).toISOString(),
        }
        const saved = await this.persist({
            ...current,
            revision: current.revision + 1,
            migrationLock: lock,
            updatedAt: input.now,
        }, raw)
        if (saved.migrationLock?.id !== input.id) {
            throw new CompositionRepositoryError('E_MIGRATION_LOCKED', 'Composition migration lock acquisition lost a race')
        }
        return lock
    }

    async writeStagedDocument(
        lockId: string,
        migrationId: string,
        document: CompositionDocument,
        now: string,
    ): Promise<StagedCompositionDocument> {
        const { raw, record: current } = await this.readWithRaw(now)
        this.requireLock(current, lockId, now)
        const parsed = cloneDocument(document)
        const staged: StagedCompositionDocument = {
            migrationId,
            document: parsed,
            documentHash: compositionDocumentHash(parsed),
            writtenAt: now,
        }
        await this.persist({
            ...current,
            revision: current.revision + 1,
            staged,
            updatedAt: now,
        }, raw)
        return staged
    }

    async commitStagedDocument(input: CommitStagedCompositionInput): Promise<CompositionRepositoryRecord> {
        const { raw, record: current } = await this.readWithRaw(input.now)
        this.requireLock(current, input.lockId, input.now)
        if (current.staged === undefined || current.staged.migrationId !== input.marker.migrationId) {
            throw new CompositionRepositoryError(
                'E_STAGED_DOCUMENT_MISSING',
                'Matching staged CompositionDocument was not found',
            )
        }
        if (current.staged.documentHash !== input.marker.targetHash) {
            throw new CompositionRepositoryError(
                'E_REPOSITORY_RECORD_INVALID',
                'Migration marker target hash does not match the staged document',
            )
        }
        return this.persist({
            ...current,
            revision: current.revision + 1,
            // Authority stays fail-closed until startup reread verification.
            authority: 'legacy',
            committedDocument: current.staged.document,
            committedHash: current.staged.documentHash,
            migrationMarker: input.marker,
            staged: undefined,
            updatedAt: input.now,
        }, raw)
    }

    async finalizeCommittedMigration(
        input: FinalizeCommittedCompositionInput,
    ): Promise<CompositionRepositoryRecord> {
        const { raw, record: current } = await this.readWithRaw(input.now)
        this.requireLock(current, input.lockId, input.now)
        if (current.committedHash !== input.targetHash
            || current.migrationMarker?.migrationId !== input.migrationId
            || current.migrationMarker.targetHash !== input.targetHash) {
            throw new CompositionRepositoryError(
                'E_REPOSITORY_CONFLICT',
                'Committed migration changed before verification completed',
            )
        }
        return this.persist({
            ...current,
            revision: current.revision + 1,
            authority: 'v2',
            migrationMarker: {
                ...current.migrationMarker,
                startupVerifiedAt: input.now,
            },
            migrationLock: undefined,
            updatedAt: input.now,
        }, raw)
    }

    async markStartupVerified(now: string): Promise<CompositionRepositoryRecord> {
        const { raw, record: current } = await this.readWithRaw(now)
        if (current.migrationMarker === undefined) return current
        return this.persist({
            ...current,
            revision: current.revision + 1,
            migrationMarker: { ...current.migrationMarker, startupVerifiedAt: now },
            updatedAt: now,
        }, raw)
    }

    async abortMigration(lockId: string, now: string): Promise<CompositionRepositoryRecord> {
        const { raw, record: current } = await this.readWithRaw(now)
        if (current.migrationLock !== undefined && current.migrationLock.id !== lockId) {
            throw new CompositionRepositoryError('E_MIGRATION_LOCK_LOST', 'Cannot abort another migration lock')
        }
        return this.persist({
            ...current,
            revision: current.revision + 1,
            staged: undefined,
            migrationLock: undefined,
            updatedAt: now,
        }, raw)
    }

    async cleanupInterruptedMigration(now: string): Promise<CompositionRepositoryRecord> {
        const { raw, record: current } = await this.readWithRaw(now)
        if (current.staged === undefined && current.migrationLock === undefined) return current
        if (current.migrationLock !== undefined && !lockExpired(current.migrationLock, now)) return current
        return this.persist({
            ...current,
            revision: current.revision + 1,
            staged: undefined,
            migrationLock: undefined,
            updatedAt: now,
        }, raw)
    }

    /**
     * Applies one validated authoring transaction against the exact committed
     * v2 revision. The repository record CAS protects concurrent tabs/services,
     * while the document base revision gives callers a stable stale-draft error.
     */
    async applyChangeSet(
        changeSet: CompositionChangeSet,
        now = new Date().toISOString(),
    ): Promise<CompositionRepositoryRecord> {
        if (this.storage.compareAndSet === undefined) {
            throw new CompositionRepositoryError(
                'E_REPOSITORY_CONFLICT',
                'Composition authoring requires atomic compare-and-set storage',
            )
        }
        const { raw, record: current } = await this.readWithRaw(now)
        if (current.migrationLock !== undefined && !lockExpired(current.migrationLock, now)) {
            throw new CompositionRepositoryError(
                'E_MIGRATION_LOCKED',
                `Composition authoring is locked by ${current.migrationLock.owner}`,
            )
        }
        if (current.authority !== 'v2' || current.committedDocument === undefined) {
            throw new CompositionRepositoryError(
                'E_V2_DOCUMENT_MISSING',
                'Composition authoring requires an authoritative v2 document',
            )
        }
        if (current.committedDocument.id !== changeSet.documentId
            || current.committedDocument.revision !== changeSet.baseRevision) {
            throw new CompositionRepositoryError(
                'E_AUTHORING_STALE_REVISION',
                `Composition draft revision ${changeSet.baseRevision} is stale; current revision is ${current.committedDocument.revision}`,
            )
        }

        let document: CompositionDocument
        try {
            document = applyCompositionChangeSet(current.committedDocument, changeSet).document
        } catch (error) {
            if (error instanceof CompositionAuthoringError) {
                if (error.code === 'E_CHANGESET_REVISION_INVALID'
                    || error.code === 'E_CHANGESET_DOCUMENT_MISMATCH') {
                    throw new CompositionRepositoryError('E_AUTHORING_STALE_REVISION', error.message)
                }
                if (error.code === 'E_CHANGESET_VALIDATION_FAILED') {
                    throw new CompositionRepositoryError('E_AUTHORING_VALIDATION_FAILED', error.message)
                }
            }
            throw error
        }

        return this.persist({
            ...current,
            revision: current.revision + 1,
            committedDocument: document,
            committedHash: compositionDocumentHash(document),
            // The marker describes the one-time migration target and is no
            // longer truthful after the first canonical authoring commit.
            migrationMarker: undefined,
            updatedAt: now,
        }, raw)
    }

    async readAuthoritativeDocument(now?: string): Promise<CompositionDocument | null> {
        const current = await this.read(now)
        return current.authority === 'v2' && current.committedDocument !== undefined
            ? cloneDocument(current.committedDocument)
            : null
    }
}
