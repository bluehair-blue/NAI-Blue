import { afterEach, describe, expect, it, vi } from 'vitest'

const persistence = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@/lib/indexed-db', () => ({
    getIndexedDBItemStrict: persistence.read,
    exportWildcardContentSnapshot: async () => ({ greeting: ['hello'] }),
    compareAndSetIndexedDBItem: vi.fn(),
    setIndexedDBItemStrict: vi.fn(),
    exportRawIndexedDBEntries: () => { throw new Error('Unbounded startup export is forbidden') },
}))
vi.mock('@/services/asset-profile-file', () => ({
    loadRawAssetProfileFile: async () => ({ exists: false }),
}))
vi.mock('@/lib/composition-migration-materialization', () => ({
    materializeCompositionMigrationSidecars: vi.fn(),
}))

import { LEGACY_COMPOSITION_STORE_ALIASES } from '@/domain/composition/migrations'
import { collectCompositionMigrationSource } from '@/lib/composition-migration-startup'

afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
})

describe('bounded Composition startup source capture', () => {
    it('retains exact legacy bytes without reading unrelated journals or rollback archives', async () => {
        const keys = [...new Set(Object.values(LEGACY_COMPOSITION_STORE_ALIASES).flat())]
        const raw = new Map(keys.map((key, index) => [key, ` { "legacy": ${index} }\n`]))
        persistence.read.mockImplementation(async (key: string) => {
            if (!raw.has(key)) throw new Error('Non-migrating data must not enter source capture')
            return raw.get(key)
        })
        vi.stubGlobal('localStorage', { getItem: () => null })

        const result = await collectCompositionMigrationSource()

        expect(result.serializedStores).toEqual(Object.fromEntries(raw))
        expect(result.wildcardContent).toEqual({ greeting: ['hello'] })
        expect(new Set(persistence.read.mock.calls.map(([key]) => key))).toEqual(new Set(keys))
        expect(persistence.read).toHaveBeenCalledTimes(keys.length)
    })

    it('uses missing-key local aliases and propagates strict read failures', async () => {
        persistence.read.mockResolvedValue(null)
        const local = new Map([['scene-store', ' { "state": { "presets": [] } }\n']])
        vi.stubGlobal('localStorage', { getItem: (key: string) => local.get(key) ?? null })
        expect((await collectCompositionMigrationSource()).serializedStores).toEqual(Object.fromEntries(local))
        expect(local.size).toBe(1)

        persistence.read.mockRejectedValue(new Error('IndexedDB read unavailable'))
        await expect(collectCompositionMigrationSource()).rejects.toThrow('IndexedDB read unavailable')
    })
})
