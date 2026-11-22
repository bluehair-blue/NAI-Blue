import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SceneAuthoringRecord } from '@/application/scene/scene-repository'
import { assertAgentPublicValue } from '@/application/agent/agent-command-contract'

const runtime = vi.hoisted(() => ({ getDocument: vi.fn(), listDocumentRecords: vi.fn(), flush: vi.fn(async () => undefined) }))
vi.mock('@/lib/scene-migration-startup', () => ({ getRuntimeSceneRepository: () => ({ getDocument: runtime.getDocument,
    listDocumentRecords: runtime.listDocumentRecords }) }))
vi.mock('@/lib/scene-authority-runtime', () => ({ flushSceneAuthorityRuntime: runtime.flush, publishAgentSceneDocument: vi.fn() }))
vi.mock('@/services/folder/apply-runtime-folder-changes', () => ({ getRuntimeGenerationFolderDocument: async () => null,
    applyRuntimeGenerationFolderChanges: vi.fn() }))

import { createAgentAuthoringReadHandlers, getAgentAuthoringSnapshot } from '@/composition-root/agent-authoring'
import { useSceneStore, type ScenePreset } from '@/stores/scene-store'

const scene = (id: string, patch: Partial<SceneAuthoringRecord> = {}): SceneAuthoringRecord => ({
    id, name: id, scenePrompt: '', artifactRefs: [], createdAt: 1, ...patch,
})
const context = { requestId: 'read-request', workspaceId: 'local', actor: { kind: 'agent', id: 'test-agent' }, observedAt: '2026-09-08T00:00:00.000Z' } as const
function read(sceneIds: string[]) {
    const handler = createAgentAuthoringReadHandlers().find(candidate => candidate.command === 'scene.resolve_many')!
    return handler.execute(handler.validate({ targets: sceneIds.map(sceneId => ({ presetId: 'preset-a', sceneId })) }), context)
}

beforeEach(() => { vi.clearAllMocks() })

describe('agent Scene read pagination', () => {
    it('reports an individually oversized Scene explicitly and advances to subsequent targets', async () => {
        const longPrompt = 'smile, '.repeat(2_000)
        runtime.getDocument.mockResolvedValue({ presetId: 'preset-a', revision: 7, scenes: [
            scene('large', { prompts: { base: longPrompt, additional: longPrompt, character: longPrompt, negative: longPrompt } }),
            scene('next'),
        ] })
        const result = await read(['large', 'next'])
        expect(result).toMatchObject({ results: [
            { found: true, presetId: 'preset-a', sceneId: 'large', revision: 7, code: 'RESULT_TOO_LARGE' },
            { found: true, sceneId: 'next' },
        ], truncated: false, nextIndex: null })
        assertAgentPublicValue(result)
        expect(runtime.flush).toHaveBeenCalledOnce()
    })

    it('returns a positive next index when cumulative size fills the page and the sliced request progresses', async () => {
        const prompts = { base: 'smile, '.repeat(2_000), additional: 'quiet, '.repeat(2_000) }
        runtime.getDocument.mockResolvedValue({ presetId: 'preset-a', revision: 8,
            scenes: [scene('first', { prompts }), scene('second', { prompts }), scene('third')] })
        const targets = ['first', 'second', 'third']
        const first = await read(targets)
        expect(first).toMatchObject({ results: [{ sceneId: 'first' }], truncated: true, nextIndex: 1 })
        const second = await read(targets.slice(first.nextIndex as number))
        expect(second).toMatchObject({ results: [{ sceneId: 'second' }, { sceneId: 'third' }], truncated: false, nextIndex: null })
        assertAgentPublicValue(first)
        assertAgentPublicValue(second)
    })

    it('returns the latest 100 Artifact IDs and the full history count without hiding editable fields', async () => {
        const refs = Array.from({ length: 125 }, (_, index) => ({ artifactId: `artifact-${index}`, favorite: false,
            createdAt: new Date(Date.UTC(2026, 8, 8, 0, 0, index)).toISOString() }))
        runtime.getDocument.mockResolvedValue({ presetId: 'preset-a', revision: 9,
            scenes: [scene('history', { prompts: { additional: 'editable prompt' }, artifactRefs: refs })] })
        const result = await read(['history'])
        expect(result.results).toEqual([expect.objectContaining({
            sceneId: 'history', prompts: { additional: 'editable prompt' }, totalArtifactCount: 125,
            artifactIds: refs.slice(-100).reverse().map(ref => ref.artifactId),
        })])
        expect(refs[0].artifactId).toBe('artifact-0')
        assertAgentPublicValue(result)
    })

    it('exposes a generated native Scene with sentence prompts and durable Artifact IDs', async () => {
        const artifactId = 'artifact:scene-job-agent-2173702dcd6cdff0c1997cb0637de986fabc967a57f9fc9401d3d1dd98efb148-0'
        const prompt = 'A simple blue circle on a plain white background, clean flat illustration'
        runtime.getDocument.mockResolvedValue({ presetId: 'preset-a', revision: 3,
            scenes: [scene('generated', { prompts: { additional: prompt }, artifactRefs: [
                { artifactId, favorite: false, createdAt: context.observedAt },
            ] })] })
        const result = await read(['generated'])
        expect(result).toMatchObject({ results: [{ revision: 3, prompts: { additional: prompt },
            artifactIds: [artifactId], totalArtifactCount: 1 }] })
        assertAgentPublicValue(result)
    })

    it('keeps credential, image and local-path rejection in Artifact ID lists', () => {
        for (const artifactId of ['Bearer credential-canary', 'iVBORw0KGgoAAAAA', 'E:/private/output.png']) {
            expect(() => assertAgentPublicValue({ artifactIds: [artifactId] })).toThrow()
        }
        expect(() => assertAgentPublicValue({ prompt: 'A c2Vj cmV0 LWNh bmFy eQ== end' })).not.toThrow()
        expect(() => assertAgentPublicValue({ prompt: 'I iVBO Rw0K Ggo= end' })).toThrow()
    })
})

describe('archived presets in agent reads', () => {
    const shell = (id: string, archivedAt?: number): ScenePreset => ({ id, name: `${id} name`, scenes: [], parentId: null, createdAt: 1,
        ...(archivedAt === undefined ? {} : { archivedAt }) })
    const document = (presetId: string, revision: number, sceneIds: string[]) => ({ schemaVersion: 1, presetId, revision,
        updatedAt: context.observedAt, scenes: sceneIds.map(id => scene(id)) })
    beforeEach(() => {
        useSceneStore.setState({ presets: [shell('preset-a'), shell('draft-old', Date.UTC(2026, 10, 22)), shell('draft-empty', Date.UTC(2026, 10, 21))] })
        runtime.listDocumentRecords.mockResolvedValue([document('preset-a', 4, ['a1', 'a2']), document('draft-old', 9, ['d1', 'd2', 'd3'])])
    })

    it('reports a Scene of an archived preset as not found with an archived marker, without reading it', async () => {
        runtime.getDocument.mockResolvedValue(document('preset-a', 4, ['a1']))
        const handler = createAgentAuthoringReadHandlers().find(candidate => candidate.command === 'scene.resolve_many')!
        const result = await handler.execute(handler.validate({ targets: [{ presetId: 'draft-old', sceneId: 'd1' },
            { presetId: 'preset-a', sceneId: 'a1' }, { presetId: 'preset-a', sceneId: 'gone' }] }), context)
        expect(result.results).toEqual([{ found: false, presetId: 'draft-old', sceneId: 'd1', archived: true },
            expect.objectContaining({ found: true, presetId: 'preset-a', sceneId: 'a1' }), { found: false, presetId: 'preset-a', sceneId: 'gone' }])
        expect(runtime.getDocument).not.toHaveBeenCalledWith('draft-old')
        assertAgentPublicValue(result)
    })

    it('leaves archived presets out of snapshot totals and lists, counting them, and lists them only on request', async () => {
        const plain = await getAgentAuthoringSnapshot(0, 20)
        expect(plain).toMatchObject({ totalPresets: 1, totalScenes: 2, totalArchivedPresets: 2,
            scenePresets: [{ presetId: 'preset-a', revision: 4, sceneCount: 2 }] })
        expect((plain.scenes as { presetId: string }[]).map(row => row.presetId)).toEqual(['preset-a', 'preset-a'])
        expect(plain).not.toHaveProperty('archivedPresets')
        expect(JSON.stringify(plain)).not.toContain('draft-old')
        const listed = await getAgentAuthoringSnapshot(0, 20, true)
        expect(listed.archivedPresets).toEqual([
            { presetId: 'draft-empty', name: 'draft-empty name', revision: 0, sceneCount: 0, archivedAt: '2026-11-21T00:00:00.000Z' },
            { presetId: 'draft-old', name: 'draft-old name', revision: 9, sceneCount: 3, archivedAt: '2026-11-22T00:00:00.000Z' }])
        expect(listed).toMatchObject({ totalPresets: 1, totalScenes: 2 })
        assertAgentPublicValue(plain)
        assertAgentPublicValue(listed)
        const paged = await getAgentAuthoringSnapshot(1, 1, true)
        expect(paged).toMatchObject({ archivedPresets: [{ presetId: 'draft-old' }], nextOffset: null })
    })
})
