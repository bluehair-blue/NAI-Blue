import { describe, expect, it, vi } from 'vitest'
import { createArtifactRecord } from '@/domain/organizer/types'
import { createSavedOutputCatalog, savedOutputImage } from '@/services/organizer/saved-output-catalog'

function record(id: string) {
    return createArtifactRecord({ artifactId: id, sourceJobId: `job:${id}`, sourceSceneId: null,
        file: { directory: { kind: 'standard', root: 'pictures', segments: ['Agent output'] }, fileName: `${id}.png` },
        format: 'png', contentChecksum: `sha256:${'a'.repeat(64)}`, size: 12, createdAt: '2026-10-31T00:00:00.000Z' })
}

describe('saved output folder catalog', () => {
    it('joins every metadata page and live completions without rescanning on navigation', async () => {
        const list = vi.fn(async ({ cursor }: { cursor: string | null }) => cursor === null
            ? { items: [record('first')], nextCursor: 'page-2' }
            : { items: [record('second')], nextCursor: null })
        const catalog = createSavedOutputCatalog({ list, resolve: async value => `C:/Pictures/Agent output/${value.original.file.fileName}` })
        const pending = catalog.load()
        catalog.add([{ path: 'C:\\Pictures\\Other agent\\new.png', timestamp: 100 }])
        await pending
        catalog.add([{ path: 'c:/pictures/agent output/FIRST.png', timestamp: 1 }])
        expect(catalog.getSnapshot().directories).toHaveLength(2)
        expect(catalog.getSnapshot().images).toHaveLength(3)
        expect(catalog.getSnapshot().images.find(image => image.name === 'FIRST.png')?.artifactId).toBe('first')
        await catalog.load()
        expect(list).toHaveBeenCalledTimes(2)
    })

    it('shows recoverable path failures and includes successful retries', async () => {
        const resolve = vi.fn().mockRejectedValueOnce(new Error('grant unavailable')).mockResolvedValue('C:/Pictures/a.png')
        const catalog = createSavedOutputCatalog({ list: async () => ({ items: [record('a')], nextCursor: null }), resolve })
        await catalog.load()
        expect(catalog.getSnapshot().unavailable).toBe(1)
        await catalog.load(true)
        expect(catalog.getSnapshot().unavailable).toBe(0)
        expect(catalog.getSnapshot().directories[0].count).toBe(1)
    })

    it('keeps native paths distinct and excludes in-memory or remote previews', () => {
        expect(savedOutputImage({ path: '/Pictures/A/a.png' })?.directoryKey).not.toBe(savedOutputImage({ path: '/Pictures/a/a.png' })?.directoryKey)
        for (const path of ['data:image/png;base64,a', 'blob:preview/a', 'memory://a.png', 'https://host/a.png']) expect(savedOutputImage({ path })).toBeNull()
    })
})
