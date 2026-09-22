import { describe, expect, it } from 'vitest'
import { linkSceneArtifact, reconcileSceneArtifactLinks } from '@/application/scene/link-scene-artifact'
import type { CommitResult, SceneDocument, SceneRepositoryPort } from '@/application/scene/scene-repository'
import { createArtifactRecord } from '@/domain/organizer/types'

const BASE: SceneDocument = {
    schemaVersion: 1,
    presetId: 'preset-a',
    revision: 1,
    updatedAt: '2026-09-04T00:00:00.000Z',
    scenes: [{
        id: 'scene-a',
        name: 'Scene',
        scenePrompt: '',
        artifactRefs: [],
        createdAt: 1,
    }],
}

function repository(commit: (next: SceneDocument, expected: number) => Promise<CommitResult>): SceneRepositoryPort {
    return {
        readLegacyProjection: async () => null,
        getDocument: async () => structuredClone(BASE),
        listDocuments: async () => [],
        commit,
    }
}

const INPUT = {
    presetId: 'preset-a',
    sceneId: 'scene-a',
    artifactId: 'artifact-a',
    createdAt: '2026-09-04T01:00:00.000Z',
    favorite: false,
}

describe('linkSceneArtifact', () => {
    it('rebases one revision conflict and then commits', async () => {
        let attempts = 0
        const concurrent = { ...BASE, revision: 2, updatedAt: INPUT.createdAt }
        const result = await linkSceneArtifact(repository(async next => {
            attempts += 1
            return attempts === 1
                ? { status: 'REVISION_CONFLICT', current: concurrent }
                : { status: 'COMMITTED', document: next }
        }), INPUT)
        expect(result.status).toBe('LINKED')
        expect(attempts).toBe(2)
        if (result.status === 'LINKED') expect(result.document.revision).toBe(3)
    })

    it('returns pending conflict after three rebases without deleting artifact authority', async () => {
        let revision = 1
        let attempts = 0
        const result = await linkSceneArtifact(repository(async () => {
            attempts += 1
            revision += 1
            return { status: 'REVISION_CONFLICT', current: { ...BASE, revision } }
        }), INPUT)
        expect(result).toEqual({ status: 'PENDING_CONFLICT', artifactId: 'artifact-a' })
        expect(attempts).toBe(3)
    })

    it('is idempotent and reports a missing scene explicitly', async () => {
        const linked = { ...BASE, scenes: [{ ...BASE.scenes[0], artifactRefs: [{
            artifactId: INPUT.artifactId,
            createdAt: INPUT.createdAt,
            favorite: false,
        }] }] }
        const already = await linkSceneArtifact({
            ...repository(async () => { throw new Error('must not commit') }),
            getDocument: async () => linked,
        }, INPUT)
        expect(already.status).toBe('ALREADY_LINKED')

        const missing = await linkSceneArtifact({
            ...repository(async () => { throw new Error('must not commit') }),
            getDocument: async () => null,
        }, INPUT)
        expect(missing).toEqual({ status: 'SCENE_MISSING' })
    })

    it('relinks Organizer records with sourceSceneId on reopen', async () => {
        let document = structuredClone(BASE)
        const scenes: SceneRepositoryPort = {
            readLegacyProjection: async () => null,
            getDocument: async () => structuredClone(document),
            listDocuments: async () => [{ presetId: 'preset-a', revision: 1, sceneCount: 1, updatedAt: BASE.updatedAt }],
            commit: async next => {
                document = structuredClone(next)
                return { status: 'COMMITTED', document }
            },
        }
        const artifact = createArtifactRecord({
            artifactId: 'artifact-a',
            sourceJobId: 'job-a',
            sourceSceneId: 'scene-a',
            file: { directory: { kind: 'standard', root: 'pictures', segments: [] }, fileName: 'a.png' },
            format: 'png',
            contentChecksum: `sha256:${'a'.repeat(64)}`,
            size: 1,
            createdAt: INPUT.createdAt,
        })
        const results = await reconcileSceneArtifactLinks(scenes, {
            list: async () => ({ items: [artifact], nextCursor: null }),
        })
        expect(results[0]?.status).toBe('LINKED')
        expect(document.scenes[0].artifactRefs[0]?.artifactId).toBe('artifact-a')
    })

    it('does not relink an Artifact explicitly hidden by the Scene presentation tombstone', async () => {
        let commits = 0
        const scenes: SceneRepositoryPort = {
            readLegacyProjection: async () => null,
            getDocument: async () => structuredClone(BASE),
            listDocuments: async () => [{ presetId: 'preset-a', revision: 1, sceneCount: 1, updatedAt: BASE.updatedAt }],
            commit: async next => {
                commits += 1
                return { status: 'COMMITTED', document: next }
            },
        }
        const artifact = createArtifactRecord({
            artifactId: 'artifact-hidden',
            sourceSceneId: 'scene-a',
            file: { directory: { kind: 'standard', root: 'pictures', segments: [] }, fileName: 'hidden.png' },
            format: 'png',
            contentChecksum: `sha256:${'c'.repeat(64)}`,
            size: 1,
            createdAt: INPUT.createdAt,
        })

        const results = await reconcileSceneArtifactLinks(scenes, {
            list: async () => ({ items: [artifact], nextCursor: null }),
        }, { shouldLink: input => input.artifactId !== 'artifact-hidden' })

        expect(results).toEqual([])
        expect(commits).toBe(0)
    })

    it('skips an ambiguous imported sceneId instead of guessing its preset', async () => {
        const duplicate = { ...BASE, presetId: 'preset-b' }
        let commits = 0
        const scenes: SceneRepositoryPort = {
            readLegacyProjection: async () => null,
            listDocuments: async () => [
                { presetId: 'preset-a', revision: 1, sceneCount: 1, updatedAt: BASE.updatedAt },
                { presetId: 'preset-b', revision: 1, sceneCount: 1, updatedAt: BASE.updatedAt },
            ],
            getDocument: async presetId => structuredClone(presetId === 'preset-a' ? BASE : duplicate),
            commit: async next => {
                commits += 1
                return { status: 'COMMITTED', document: next }
            },
        }
        const artifact = createArtifactRecord({
            artifactId: 'artifact-ambiguous',
            sourceSceneId: 'scene-a',
            file: { directory: { kind: 'standard', root: 'pictures', segments: [] }, fileName: 'a.png' },
            format: 'png',
            contentChecksum: `sha256:${'b'.repeat(64)}`,
            size: 1,
            createdAt: INPUT.createdAt,
        })
        const results = await reconcileSceneArtifactLinks(scenes, {
            list: async () => ({ items: [artifact], nextCursor: null }),
        })
        expect(results).toEqual([])
        expect(commits).toBe(0)
    })

    it('reads Scene documents sequentially during reconciliation', async () => {
        let activeReads = 0
        let maxActiveReads = 0
        const scenes: SceneRepositoryPort = {
            readLegacyProjection: async () => null,
            listDocuments: async () => [
                { presetId: 'preset-a', revision: 1, sceneCount: 1, updatedAt: BASE.updatedAt },
                { presetId: 'preset-b', revision: 1, sceneCount: 1, updatedAt: BASE.updatedAt },
            ],
            getDocument: async presetId => {
                activeReads += 1
                maxActiveReads = Math.max(maxActiveReads, activeReads)
                await new Promise(resolve => setTimeout(resolve, 0))
                activeReads -= 1
                return structuredClone(presetId === 'preset-a' ? BASE : { ...BASE, presetId: 'preset-b' })
            },
            commit: async next => ({ status: 'COMMITTED', document: next }),
        }

        await reconcileSceneArtifactLinks(scenes, {
            list: async () => ({ items: [], nextCursor: null }),
        })

        expect(maxActiveReads).toBe(1)
    })
})
