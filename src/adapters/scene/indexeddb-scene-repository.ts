import type {
    CommitResult,
    SceneArtifactRef,
    SceneAuthoringRecord,
    SceneDocument,
    SceneDocumentSummary,
    SceneRepositoryPort,
    SceneV1AuthoringRecord,
    SceneV1CompatibilityProjection,
    SceneV1GenerationConfig,
    SceneV1PromptConfig,
    SceneV1PresetProjection,
} from '@/application/scene/scene-repository'
import { isSceneCompositionRef } from '@/application/scene/patch-scenes'
import { generationFolderDocumentMutationKey } from '@/application/workspace/workspace-mutation-gate'
import { runtimeWorkspaceMutationGate } from '@/lib/workspace-mutation-gate'
import {
    SCENE_DOCUMENT_STORE_KEY,
    compareAndSetIndexedDBItem,
    getIndexedDBItemStrict,
} from '@/lib/indexed-db'

const SCENE_STORAGE_KEY = 'nai-blue-scenes'
// Zustand persist defaults to version 0 when the store does not specify one.
const SCENE_PERSIST_VERSION = 0
const SCENE_COLLECTION_SCHEMA_VERSION = 1 as const
const MAX_CAS_ATTEMPTS = 3

export interface ScenePersistencePort {
    getItem(key: string): Promise<string | null>
}

export interface SceneDocumentPersistencePort extends ScenePersistencePort {
    compareAndSet(key: string, expected: string | null, next: string): Promise<boolean>
}

const indexedDbPersistence: SceneDocumentPersistencePort = {
    getItem: getIndexedDBItemStrict,
    compareAndSet: (key, expected, next) => compareAndSetIndexedDBItem(key, expected, next),
}

interface SceneDocumentCollection {
    readonly schemaVersion: typeof SCENE_COLLECTION_SCHEMA_VERSION
    readonly documents: readonly SceneDocument[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const allowed = new Set(keys)
    return Object.keys(value).every(key => allowed.has(key))
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0
}

function isJsonValue(value: unknown): boolean {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
    if (typeof value === 'number') return Number.isFinite(value)
    if (Array.isArray(value)) return value.every(isJsonValue)
    return isRecord(value) && Object.values(value).every(isJsonValue)
}

function isPromptConfig(value: unknown): value is SceneV1PromptConfig {
    if (!isRecord(value) || !hasOnlyKeys(value, [
        'base', 'additional', 'character', 'negative', 'characterNegative',
    ])) return false
    return Object.values(value).every(field => typeof field === 'string')
}

function isCharacterCaption(value: unknown): boolean {
    if (!isRecord(value) || !hasOnlyKeys(value, [
        'id', 'name', 'prompt', 'negative', 'enabled', 'position',
    ])) return false
    const position = value.position
    return isNonEmptyString(value.id)
        && (value.name === undefined || typeof value.name === 'string')
        && typeof value.prompt === 'string'
        && typeof value.negative === 'string'
        && typeof value.enabled === 'boolean'
        && isRecord(position)
        && hasOnlyKeys(position, ['x', 'y'])
        && typeof position.x === 'number'
        && Number.isFinite(position.x)
        && typeof position.y === 'number'
        && Number.isFinite(position.y)
}

function isGenerationConfig(value: unknown): value is SceneV1GenerationConfig {
    if (!isRecord(value) || !hasOnlyKeys(value, [
        'model', 'steps', 'cfgScale', 'cfgRescale', 'sampler', 'scheduler', 'smea', 'smeaDyn',
        'variety', 'qualityToggle', 'ucPreset', 'seed', 'seedLocked',
    ])) return false
    const strings = ['model', 'sampler', 'scheduler'] as const
    const numbers = ['steps', 'cfgScale', 'cfgRescale', 'ucPreset', 'seed'] as const
    const booleans = ['smea', 'smeaDyn', 'variety', 'qualityToggle', 'seedLocked'] as const
    return strings.every(key => value[key] === undefined || typeof value[key] === 'string')
        && numbers.every(key => value[key] === undefined
            || (typeof value[key] === 'number' && Number.isFinite(value[key])))
        && booleans.every(key => value[key] === undefined || typeof value[key] === 'boolean')
}

function isArtifactRef(value: unknown): value is SceneArtifactRef {
    return isRecord(value)
        && hasOnlyKeys(value, ['artifactId', 'createdAt', 'favorite'])
        && isNonEmptyString(value.artifactId)
        && isNonEmptyString(value.createdAt)
        && Number.isFinite(Date.parse(value.createdAt))
        && typeof value.favorite === 'boolean'
}

function isSceneAuthoringRecord(value: unknown): value is SceneAuthoringRecord {
    if (!isRecord(value) || !isJsonValue(value) || !hasOnlyKeys(value, [
        'id', 'name', 'scenePrompt', 'prompts', 'characterCaptions', 'characterPositionEnabled',
        'generation', 'width', 'height', 'metadataMode', 'generationFolderId', 'filenameTemplate',
        'excludePinned', 'compositionRef', 'artifactRefs', 'createdAt',
    ])) return false
    const dimensions = [value.width, value.height]
    const metadataModes = ['embedded', 'sidecar-only', 'strip-and-sidecar', 'strip-only']
    return isNonEmptyString(value.id)
        && isNonEmptyString(value.name)
        && typeof value.scenePrompt === 'string'
        && (value.prompts === undefined || isPromptConfig(value.prompts))
        && (value.characterCaptions === undefined
            || (Array.isArray(value.characterCaptions) && value.characterCaptions.every(isCharacterCaption)))
        && (value.characterPositionEnabled === undefined || typeof value.characterPositionEnabled === 'boolean')
        && (value.generation === undefined || isGenerationConfig(value.generation))
        && dimensions.every(dimension => dimension === undefined
            || (typeof dimension === 'number' && Number.isSafeInteger(dimension) && dimension > 0))
        && (value.metadataMode === undefined || metadataModes.includes(value.metadataMode as string))
        && (value.generationFolderId === undefined || isNonEmptyString(value.generationFolderId))
        && (value.filenameTemplate === undefined || typeof value.filenameTemplate === 'string')
        && (value.excludePinned === undefined || typeof value.excludePinned === 'boolean')
        && isSceneCompositionRef(value.compositionRef)
        && Array.isArray(value.artifactRefs)
        && value.artifactRefs.every(isArtifactRef)
        && new Set(value.artifactRefs.map(ref => (ref as SceneArtifactRef).artifactId)).size === value.artifactRefs.length
        && typeof value.createdAt === 'number'
        && Number.isSafeInteger(value.createdAt)
        && value.createdAt >= 0
}

function isSceneDocument(value: unknown): value is SceneDocument {
    if (!isRecord(value) || !hasOnlyKeys(value, [
        'schemaVersion', 'presetId', 'revision', 'scenes', 'updatedAt',
    ])) return false
    return value.schemaVersion === 1
        && isNonEmptyString(value.presetId)
        && typeof value.revision === 'number'
        && Number.isSafeInteger(value.revision)
        && value.revision >= 1
        && Array.isArray(value.scenes)
        && value.scenes.every(isSceneAuthoringRecord)
        && new Set(value.scenes.map(scene => (scene as SceneAuthoringRecord).id)).size === value.scenes.length
        && isNonEmptyString(value.updatedAt)
        && Number.isFinite(Date.parse(value.updatedAt))
}

function emptyCollection(): SceneDocumentCollection {
    return { schemaVersion: SCENE_COLLECTION_SCHEMA_VERSION, documents: [] }
}

function parseCollection(serialized: string | null): SceneDocumentCollection {
    if (serialized === null) return emptyCollection()
    let parsed: unknown
    try {
        parsed = JSON.parse(serialized) as unknown
    } catch {
        throw new TypeError('Scene document collection is invalid')
    }
    if (!isRecord(parsed)
        || !hasOnlyKeys(parsed, ['schemaVersion', 'documents'])
        || parsed.schemaVersion !== SCENE_COLLECTION_SCHEMA_VERSION
        || !Array.isArray(parsed.documents)
        || !parsed.documents.every(isSceneDocument)
        || new Set(parsed.documents.map(document => (document as SceneDocument).presetId)).size
            !== parsed.documents.length) {
        throw new TypeError('Unsupported Scene document collection')
    }
    return { schemaVersion: SCENE_COLLECTION_SCHEMA_VERSION, documents: parsed.documents }
}

function serializeCollection(documents: readonly SceneDocument[]): string {
    return JSON.stringify({
        schemaVersion: SCENE_COLLECTION_SCHEMA_VERSION,
        documents: [...documents].sort((left, right) => left.presetId.localeCompare(right.presetId)),
    } satisfies SceneDocumentCollection)
}

function cloneDocument(document: SceneDocument): SceneDocument {
    return structuredClone(document)
}

function assertSceneRecord(value: unknown): asserts value is Record<string, unknown> {
    if (!isRecord(value)
        || typeof value.id !== 'string'
        || typeof value.name !== 'string'
        || typeof value.scenePrompt !== 'string'
        || !Array.isArray(value.images)
        || typeof value.createdAt !== 'number') {
        throw new TypeError('Scene V1 authoring record is invalid')
    }
}

function defined<K extends string>(source: Record<string, unknown>, key: K): Record<K, unknown> | object {
    return source[key] === undefined ? {} : { [key]: structuredClone(source[key]) }
}

function projectScene(value: unknown): SceneV1AuthoringRecord {
    assertSceneRecord(value)
    return {
        id: value.id,
        name: value.name,
        scenePrompt: value.scenePrompt,
        ...defined(value, 'prompts'),
        ...defined(value, 'characterCaptions'),
        ...defined(value, 'characterPositionEnabled'),
        ...defined(value, 'generation'),
        images: structuredClone(value.images),
        ...defined(value, 'width'),
        ...defined(value, 'height'),
        ...defined(value, 'metadataMode'),
        ...defined(value, 'generationFolderId'),
        ...defined(value, 'filenameTemplate'),
        ...defined(value, 'excludePinned'),
        ...defined(value, 'compositionRef'),
        createdAt: value.createdAt,
    } as SceneV1AuthoringRecord
}

function projectPreset(value: unknown): SceneV1PresetProjection {
    if (!isRecord(value)
        || typeof value.id !== 'string'
        || typeof value.name !== 'string'
        || !Array.isArray(value.scenes)
        || typeof value.createdAt !== 'number') {
        throw new TypeError('Scene V1 preset is invalid')
    }
    return {
        id: value.id,
        name: value.name,
        scenes: value.scenes.map(projectScene),
        ...defined(value, 'parentId'),
        ...defined(value, 'defaultTemplate'),
        createdAt: value.createdAt,
    } as SceneV1PresetProjection
}

/** Pure authoring projection shared by IndexedDB reads and migration parity tests. */
export function projectSceneV1Compatibility(value: unknown): SceneV1CompatibilityProjection {
    if (!isRecord(value) || !Array.isArray(value.presets)) {
        throw new TypeError('Scene V1 persisted state is invalid')
    }
    return { presets: value.presets.map(projectPreset) }
}

/** Parses one exact legacy Zustand preimage without consulting the live store key. */
export function projectSceneV1Preimage(serialized: string): SceneV1CompatibilityProjection {
    let parsed: unknown
    try {
        parsed = JSON.parse(serialized) as unknown
    } catch {
        throw new TypeError('Scene Zustand envelope is invalid')
    }
    if (!isRecord(parsed)) throw new TypeError('Scene Zustand envelope is invalid')
    if (parsed.version !== SCENE_PERSIST_VERSION || !isRecord(parsed.state)) {
        throw new TypeError('Unsupported Scene Zustand envelope')
    }
    return projectSceneV1Compatibility(parsed.state)
}

/** Keeps legacy Zustand reads isolated while V2 documents commit to their own CAS key. */
export class IndexedDbSceneRepository implements SceneRepositoryPort {
    constructor(private readonly persistence: ScenePersistencePort & Partial<Pick<
        SceneDocumentPersistencePort,
        'compareAndSet'
    >> = indexedDbPersistence) {}

    async readLegacyProjection(): Promise<SceneV1CompatibilityProjection | null> {
        const serialized = await this.persistence.getItem(SCENE_STORAGE_KEY)
        if (serialized === null) return null
        return projectSceneV1Preimage(serialized)
    }

    async getDocument(presetId: string): Promise<SceneDocument | null> {
        if (!isNonEmptyString(presetId)) throw new TypeError('Scene preset ID is invalid')
        const collection = parseCollection(await this.persistence.getItem(SCENE_DOCUMENT_STORE_KEY))
        const document = collection.documents.find(candidate => candidate.presetId === presetId)
        return document === undefined ? null : cloneDocument(document)
    }

    async listDocuments(): Promise<readonly SceneDocumentSummary[]> {
        return parseCollection(await this.persistence.getItem(SCENE_DOCUMENT_STORE_KEY)).documents
            .map(document => ({
                presetId: document.presetId,
                revision: document.revision,
                sceneCount: document.scenes.length,
                updatedAt: document.updatedAt,
            }))
            .sort((left, right) => left.presetId.localeCompare(right.presetId))
    }

    async commit(next: SceneDocument, expectedRevision: number): Promise<CommitResult> {
        if (!Number.isSafeInteger(expectedRevision)
            || expectedRevision < 0
            || !isSceneDocument(next)
            || next.revision !== expectedRevision + 1) {
            throw new TypeError('Scene document CAS input is invalid')
        }
        return runtimeWorkspaceMutationGate.runExclusive(
            generationFolderDocumentMutationKey('local'),
            async () => {
                const compareAndSet = this.persistence.compareAndSet
                if (compareAndSet === undefined) throw new TypeError('Scene document persistence is read-only')
                const candidate = cloneDocument(next)

                for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
                    const serialized = await this.persistence.getItem(SCENE_DOCUMENT_STORE_KEY)
                    const collection = parseCollection(serialized)
                    const index = collection.documents.findIndex(document => document.presetId === candidate.presetId)
                    const current = index === -1 ? null : collection.documents[index]
                    if ((current === null && expectedRevision !== 0)
                        || (current !== null && current.revision !== expectedRevision)) {
                        return {
                            status: 'REVISION_CONFLICT',
                            current: current === null ? null : cloneDocument(current),
                        }
                    }

                    const documents = [...collection.documents]
                    if (index === -1) documents.push(candidate)
                    else documents[index] = candidate
                    if (await compareAndSet(
                        SCENE_DOCUMENT_STORE_KEY,
                        serialized,
                        serializeCollection(documents),
                    )) return { status: 'COMMITTED', document: cloneDocument(candidate) }
                }
                return { status: 'STORAGE_CONFLICT' }
            },
        )
    }
}
