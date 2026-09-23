import { canonicalSerialize } from '@/domain/composition/canonical-serialize'
import { createCompositionChangeSet } from '@/domain/composition/authoring'
import {
    CompositionRepository,
    CompositionRepositoryError,
} from '@/domain/composition/repository'
import type {
    ActorRef,
    CompositionChange,
    CompositionChangeSet,
    CompositionDocument,
    CompositionEntityKind,
    RevisionedEntity,
} from '@/domain/composition/types'
import { setRuntimeCompositionDocument } from '@/lib/composition-authority'
import {
    createCompositionAuthoringSession,
    type CompositionAuthoringRepositorySnapshot,
    type CompositionAuthoringSession,
} from '@/services/composition-authoring-session'

export const ASSET_MODULE_STUDIO_ACTOR: ActorRef = {
    kind: 'user',
    id: 'asset-module-studio',
    displayName: 'Asset Module Studio',
}

function entityChanged(left: RevisionedEntity | undefined, right: RevisionedEntity): boolean {
    return left === undefined || canonicalSerialize(left) !== canonicalSerialize(right)
}

function diffCollection<T extends RevisionedEntity>(
    base: readonly T[],
    draft: readonly T[],
    entityKind: CompositionEntityKind,
    upsert: (value: T) => CompositionChange,
    updatedAt: string,
): CompositionChange[] {
    const changes: CompositionChange[] = []
    const baseById = new Map(base.map(entity => [entity.id, entity]))
    const draftIds = new Set(draft.map(entity => entity.id))

    for (const entity of draft) {
        if (entityChanged(baseById.get(entity.id), entity)) changes.push(upsert(entity))
    }
    for (const entity of base) {
        if (!draftIds.has(entity.id) && entity.deletedAt === undefined) {
            changes.push({
                kind: 'tombstone',
                entityKind,
                entityId: entity.id,
                deletedAt: updatedAt,
            })
        }
    }
    return changes
}

/** Converts one complete Studio draft into the smallest top-level v2 change set. */
export function createCompositionStudioChangeSet(
    base: CompositionDocument,
    draft: CompositionDocument,
    options: {
        now?: string
        actor?: ActorRef
        id?: string
    } = {},
): CompositionChangeSet {
    if (base.id !== draft.id || base.schemaVersion !== draft.schemaVersion) {
        throw new Error('Composition Studio draft does not match its base document')
    }
    if (base.activeProfileId !== draft.activeProfileId) {
        throw new Error('The active profile cannot be changed by the module authoring surface')
    }
    if (base.createdAt !== draft.createdAt
        || canonicalSerialize(base.createdBy) !== canonicalSerialize(draft.createdBy)
        || base.deletedAt !== draft.deletedAt
        || canonicalSerialize(base.extensions ?? null) !== canonicalSerialize(draft.extensions ?? null)) {
        throw new Error('Composition Studio cannot change document-level metadata')
    }

    const updatedAt = options.now ?? new Date().toISOString()
    const changes: CompositionChange[] = [
        ...diffCollection(base.profiles, draft.profiles, 'profile', value => ({ kind: 'upsert-profile', value }), updatedAt),
        ...diffCollection(base.modules, draft.modules, 'module', value => ({ kind: 'upsert-module', value }), updatedAt),
        ...diffCollection(base.recipes, draft.recipes, 'recipe', value => ({ kind: 'upsert-recipe', value }), updatedAt),
        ...diffCollection(base.characters, draft.characters, 'character', value => ({ kind: 'upsert-character', value }), updatedAt),
        ...diffCollection(base.paramsPresets, draft.paramsPresets, 'params-preset', value => ({ kind: 'upsert-params-preset', value }), updatedAt),
        ...diffCollection(base.resources, draft.resources, 'resource', value => ({ kind: 'upsert-resource', value }), updatedAt),
        ...diffCollection(base.randomRules, draft.randomRules, 'random-rule', value => ({ kind: 'upsert-random-rule', value }), updatedAt),
    ]

    return createCompositionChangeSet({
        document: base,
        id: options.id ?? `studio-change:${updatedAt}:${changes.length}`,
        updatedAt,
        updatedBy: options.actor ?? ASSET_MODULE_STUDIO_ACTOR,
        changes,
    })
}

function repositorySnapshot(document: CompositionDocument): CompositionAuthoringRepositorySnapshot {
    return { revision: document.revision, document }
}

async function readSnapshot(repository: CompositionRepository): Promise<CompositionAuthoringRepositorySnapshot> {
    const document = await repository.readAuthoritativeDocument()
    if (document === null) throw new Error('Composition v2 authority is not available')
    return repositorySnapshot(document)
}

/** Wires the pure draft session to the sole repository command boundary. */
export function createRepositoryCompositionAuthoringSession(
    repository: CompositionRepository,
): CompositionAuthoringSession<CompositionChangeSet> {
    return createCompositionAuthoringSession({
        loadDocument: () => readSnapshot(repository),
        createChangeSet: (base, draft) => createCompositionStudioChangeSet(base, draft),
        commitDocument: async ({ changeSet }) => {
            try {
                const saved = await repository.applyChangeSet(changeSet)
                const document = saved.committedDocument
                if (document === undefined) throw new Error('Composition repository commit has no document')
                setRuntimeCompositionDocument(document)
                return { status: 'committed', snapshot: repositorySnapshot(document) }
            } catch (error) {
                if (error instanceof CompositionRepositoryError
                    && (error.code === 'E_AUTHORING_STALE_REVISION'
                        || error.code === 'E_REPOSITORY_CONFLICT')) {
                    return { status: 'stale', external: await readSnapshot(repository) }
                }
                throw error
            }
        },
    })
}

export async function readCompositionAuthoringSnapshot(
    repository: CompositionRepository,
): Promise<CompositionAuthoringRepositorySnapshot> {
    return readSnapshot(repository)
}
