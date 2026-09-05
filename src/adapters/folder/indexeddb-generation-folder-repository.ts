import type { GenerationFolderCommitResult, GenerationFolderDocumentSummary, GenerationFolderRepositoryPort } from '@/application/folder/generation-folder-repository'
import { isGenerationFolderDocument, migrateGenerationFolderV1Projection, normalizeGenerationFolderV1Projection, type GenerationFolderDocument, type GenerationFolderV1Projection } from '@/domain/generation-folders'
import {
    FOLDER_DOCUMENT_STORE_KEY,
    FOLDER_V1_PREIMAGE_STORE_KEY,
    compareAndSetIndexedDBItem,
    getIndexedDBItemStrict,
} from '@/lib/indexed-db'

const SETTINGS_STORAGE_KEY = 'nai-blue-settings'
const COLLECTION_SCHEMA_VERSION = 1 as const
const MAX_CAS_ATTEMPTS = 3

export interface GenerationFolderPersistencePort { getItem(key: string): Promise<string | null> }
export interface GenerationFolderDocumentPersistencePort extends GenerationFolderPersistencePort {
    compareAndSet(key: string, expected: string | null, next: string): Promise<boolean>
}

const indexedDbPersistence: GenerationFolderDocumentPersistencePort = {
    getItem: getIndexedDBItemStrict,
    compareAndSet: (key, expected, next) => compareAndSetIndexedDBItem(key, expected, next),
}

interface GenerationFolderDocumentCollection {
    readonly schemaVersion: typeof COLLECTION_SCHEMA_VERSION
    readonly documents: readonly GenerationFolderDocument[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseCollection(serialized: string | null): GenerationFolderDocumentCollection {
    if (serialized === null) return { schemaVersion: COLLECTION_SCHEMA_VERSION, documents: [] }
    let parsed: unknown
    try { parsed = JSON.parse(serialized) as unknown } catch { throw new TypeError('Generation folder document collection is invalid') }
    if (!isRecord(parsed)
        || Object.keys(parsed).some(key => key !== 'schemaVersion' && key !== 'documents')
        || parsed.schemaVersion !== COLLECTION_SCHEMA_VERSION
        || !Array.isArray(parsed.documents)
        || !parsed.documents.every(isGenerationFolderDocument)
        || new Set(parsed.documents.map(document => (document as GenerationFolderDocument).workspaceId)).size !== parsed.documents.length) {
        throw new TypeError('Unsupported generation folder document collection')
    }
    return { schemaVersion: COLLECTION_SCHEMA_VERSION, documents: parsed.documents }
}

function serializeCollection(documents: readonly GenerationFolderDocument[]): string {
    return JSON.stringify({
        schemaVersion: COLLECTION_SCHEMA_VERSION,
        documents: [...documents].sort((left, right) => left.workspaceId.localeCompare(right.workspaceId)),
    } satisfies GenerationFolderDocumentCollection)
}

function cloneDocument(document: GenerationFolderDocument): GenerationFolderDocument { return structuredClone(document) }

/** Keeps the V1 key read-only while whole V2 workspace documents use CAS. */
export class IndexedDbGenerationFolderRepository implements GenerationFolderRepositoryPort {
    constructor(private readonly persistence: GenerationFolderPersistencePort & Partial<Pick<GenerationFolderDocumentPersistencePort, 'compareAndSet'>> = indexedDbPersistence) {}

    async readLegacyProjection(): Promise<GenerationFolderV1Projection | null> {
        const preserved = await this.persistence.getItem(FOLDER_V1_PREIMAGE_STORE_KEY)
        const serialized = preserved ?? await this.persistence.getItem(SETTINGS_STORAGE_KEY)
        if (serialized === null) return null
        let parsed: unknown
        try { parsed = JSON.parse(serialized) as unknown } catch { throw new TypeError('Generation folder settings envelope is invalid') }
        if (!isRecord(parsed)) throw new TypeError('Generation folder settings envelope is invalid')
        // Settings v2 adds agent policy; the legacy Folder projection is unchanged.
        // Accept both known envelopes so a v2 preimage cannot block V2 authority on restart.
        if ((parsed.version !== 1 && parsed.version !== 2) || !isRecord(parsed.state)) throw new TypeError('Unsupported generation folder settings envelope')
        return normalizeGenerationFolderV1Projection(parsed.state)
    }

    async getDocument(workspaceId: string): Promise<GenerationFolderDocument | null> {
        if (typeof workspaceId !== 'string' || workspaceId.trim() !== workspaceId || workspaceId.length === 0) throw new TypeError('Generation folder workspace ID is invalid')
        const document = parseCollection(await this.persistence.getItem(FOLDER_DOCUMENT_STORE_KEY)).documents.find(candidate => candidate.workspaceId === workspaceId)
        return document === undefined ? null : cloneDocument(document)
    }

    async listDocuments(): Promise<readonly GenerationFolderDocumentSummary[]> {
        return parseCollection(await this.persistence.getItem(FOLDER_DOCUMENT_STORE_KEY)).documents
            .map(document => ({ workspaceId: document.workspaceId, revision: document.revision, folderCount: document.folders.length }))
            .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId))
    }

    async commit(next: GenerationFolderDocument, expectedRevision: number): Promise<GenerationFolderCommitResult> {
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !isGenerationFolderDocument(next) || next.revision !== expectedRevision + 1) throw new TypeError('Generation folder document CAS input is invalid')
        const compareAndSet = this.persistence.compareAndSet
        if (compareAndSet === undefined) throw new TypeError('Generation folder document persistence is read-only')
        const candidate = cloneDocument(next)
        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
            const serialized = await this.persistence.getItem(FOLDER_DOCUMENT_STORE_KEY)
            const collection = parseCollection(serialized)
            const index = collection.documents.findIndex(document => document.workspaceId === candidate.workspaceId)
            const current = index === -1 ? null : collection.documents[index]
            if ((current === null && expectedRevision !== 0) || (current !== null && current.revision !== expectedRevision)) {
                return { status: 'REVISION_CONFLICT', current: current === null ? null : cloneDocument(current) }
            }
            const documents = [...collection.documents]
            if (index === -1) documents.push(candidate)
            else documents[index] = candidate
            if (await compareAndSet(FOLDER_DOCUMENT_STORE_KEY, serialized, serializeCollection(documents))) return { status: 'COMMITTED', document: cloneDocument(candidate) }
        }
        return { status: 'STORAGE_CONFLICT' }
    }

    /** Materializes once; a CAS loser returns the winner and never writes the V1 key. */
    async materializeLegacy(workspaceId: string): Promise<GenerationFolderDocument | null> {
        const current = await this.getDocument(workspaceId)
        if (current !== null) return current
        const legacy = await this.readLegacyProjection()
        if (legacy === null) return null
        const result = await this.commit(migrateGenerationFolderV1Projection(workspaceId, legacy), 0)
        if (result.status === 'COMMITTED') return result.document
        if (result.status === 'REVISION_CONFLICT') return result.current
        const winner = await this.getDocument(workspaceId)
        if (winner !== null) return winner
        throw new Error('Generation folder migration storage conflict')
    }
}
