import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SceneAuthoringRecord } from '@/application/scene/scene-repository'
import { assertAgentPublicValue } from '@/application/agent/agent-command-contract'

const runtime = vi.hoisted(() => ({ getDocument: vi.fn(), flush: vi.fn(async () => undefined) }))
vi.mock('@/lib/scene-migration-startup', () => ({ getRuntimeSceneRepository: () => ({ getDocument: runtime.getDocument }) }))
vi.mock('@/lib/scene-authority-runtime', () => ({ flushSceneAuthorityRuntime: runtime.flush, publishAgentSceneDocument: vi.fn() }))

import { createAgentAuthoringReadHandlers } from '@/composition-root/agent-authoring'

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
})
