import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScenePreset } from '@/stores/scene-store'

const storage = vi.hoisted(() => new Map<string, string>())
vi.mock('@/lib/indexed-db', () => ({
    indexedDBStorage: {
        getItem: async (name: string) => storage.get(name) ?? null,
        setItem: async (name: string, value: string) => { storage.set(name, value) },
        removeItem: async (name: string) => { storage.delete(name) },
    },
}))
vi.mock('@tauri-apps/plugin-fs', () => ({ BaseDirectory: { Picture: 1, AppData: 2 }, exists: async () => false, rename: async () => undefined }))
vi.mock('@tauri-apps/api/path', () => ({
    appDataDir: async () => 'C:/Synthetic/AppData',
    pictureDir: async () => 'C:/Synthetic/Pictures',
    join: async (...parts: string[]) => parts.join('/'),
}))

const KEY = 'nai-blue-scene-presentation'
// Key order follows projectScenePresentationState, so an untouched shell must persist byte for byte.
const shell = (id: string, parentId: string | null = null): ScenePreset => ({ id, name: id, scenes: [], parentId, createdAt: 1 })
const persisted = (presets: ScenePreset[], activePresetId = 'kept') => JSON.stringify({ state: { presets, activePresetId,
    sceneAuthorityInitialized: true, legacyImagePresentation: {}, isEditMode: false, selectedSceneIds: [], lastSelectedSceneId: null,
    gridColumns: 4, thumbnailLayout: 'vertical', scrollPosition: 0, sceneCompositionMode: 'v2' }, version: 0 })
async function loadStore() {
    vi.resetModules()
    const module = await import('@/stores/scene-store')
    await module.useSceneStore.persist.rehydrate()
    return module
}
const writtenPresets = () => JSON.parse(storage.get(KEY)!).state.presets as ScenePreset[]

beforeEach(() => { storage.clear() })

describe('Scene preset archive', () => {
    it('archives a branch, keeps the default preset and Scene arrays, and moves the active preset off it', async () => {
        storage.set(KEY, persisted([shell('scene-default'), shell('kept'), shell('folder'), shell('child', 'folder'), shell('grandchild', 'child')], 'child'))
        const { useSceneStore, visibleScenePresets } = await loadStore()
        const before = useSceneStore.getState().presets
        useSceneStore.getState().archivePresets(['folder', 'scene-default'])
        const state = useSceneStore.getState()
        const archived = state.presets.filter(preset => preset.archivedAt !== undefined).map(preset => preset.id)
        expect(archived).toEqual(['folder', 'child', 'grandchild'])
        expect(new Set(state.presets.filter(preset => preset.archivedAt !== undefined).map(preset => preset.archivedAt)).size).toBe(1)
        expect(state.presets.map(preset => preset.scenes)).toEqual(before.map(preset => preset.scenes))
        state.presets.forEach((preset, index) => expect(preset.scenes).toBe(before[index].scenes))
        expect(state.activePresetId).toBe('scene-default')
        expect(visibleScenePresets(state.presets).map(preset => preset.id)).toEqual(['scene-default', 'kept'])
        expect(visibleScenePresets(state.presets)).toBe(visibleScenePresets(state.presets))
        expect(visibleScenePresets(before)).toBe(before)
        // Archiving again changes nothing, not even the time.
        useSceneStore.getState().archivePresets(['folder'])
        expect(useSceneStore.getState().presets).toBe(state.presets)
    })

    it('restores what one archive action hid, leaves older archives inside it, and restores archived ancestors of a child', async () => {
        storage.set(KEY, persisted([shell('scene-default'), shell('kept'), shell('folder'), shell('old', 'folder'), shell('fresh', 'folder'), shell('leaf', 'fresh')]))
        const { useSceneStore } = await loadStore()
        const now = vi.spyOn(Date, 'now')
        now.mockReturnValue(1_000)
        useSceneStore.getState().archivePresets(['old'])
        now.mockReturnValue(2_000)
        useSceneStore.getState().archivePresets(['folder'])
        const archivedAt = () => Object.fromEntries(useSceneStore.getState().presets.map(preset => [preset.id, preset.archivedAt]))
        expect(archivedAt()).toMatchObject({ folder: 2_000, old: 1_000, fresh: 2_000, leaf: 2_000 })
        useSceneStore.getState().restoreArchivedPresets(['folder'])
        expect(archivedAt()).toEqual({ 'scene-default': undefined, kept: undefined, folder: undefined, old: 1_000, fresh: undefined, leaf: undefined })
        expect(useSceneStore.getState().presets.find(preset => preset.id === 'folder')).not.toHaveProperty('archivedAt')
        now.mockReturnValue(3_000)
        useSceneStore.getState().archivePresets(['folder'])
        useSceneStore.getState().restoreArchivedPresets(['leaf'])
        // The child becomes reachable through its ancestor chain; its archived siblings stay archived.
        expect(archivedAt()).toMatchObject({ folder: undefined, fresh: undefined, leaf: undefined, old: 1_000 })
        now.mockRestore()
    })

    it('names what an archive or a restore changes before it runs, and copies a folder without its archived sub-folders', async () => {
        storage.set(KEY, persisted([shell('scene-default'), shell('kept'), shell('folder'), shell('old', 'folder'), shell('fresh', 'folder')]))
        const { useSceneStore, scenePresetsToArchive, scenePresetsToRestore } = await loadStore()
        useSceneStore.getState().archivePresets(['old'])
        const presets = () => useSceneStore.getState().presets
        expect([...scenePresetsToArchive(presets(), ['folder', 'scene-default', 'missing'])]).toEqual(['folder', 'fresh'])
        expect([...scenePresetsToRestore(presets(), ['folder'])]).toEqual([])
        useSceneStore.getState().duplicatePresets(['folder'])
        const copies = presets().slice(5)
        expect(copies.map(preset => preset.name)).toEqual(['folder (복사본)', 'fresh'])
        expect(copies.every(preset => preset.archivedAt === undefined)).toBe(true)
        useSceneStore.getState().archivePresets(['folder'])
        expect([...scenePresetsToRestore(presets(), ['fresh'])].sort()).toEqual(['folder', 'fresh'])
    })

    it('persists an unarchived shell exactly as before and keeps the flag across a reload', async () => {
        const shells = [shell('scene-default'), shell('kept'), shell('draft')]
        storage.set(KEY, persisted(shells))
        let module = await loadStore()
        module.useSceneStore.getState().setGridColumns(3)
        expect(JSON.stringify(writtenPresets())).toBe(JSON.stringify(shells))
        module.useSceneStore.getState().archivePresets(['draft'])
        const draftTime = module.useSceneStore.getState().presets.find(preset => preset.id === 'draft')!.archivedAt
        expect(writtenPresets()).toEqual([shells[0], shells[1], { ...shells[2], archivedAt: draftTime }])
        expect(JSON.stringify(writtenPresets().slice(0, 2))).toBe(JSON.stringify(shells.slice(0, 2)))
        module = await loadStore()
        expect(module.useSceneStore.getState().presets.find(preset => preset.id === 'draft')?.archivedAt).toBe(draftTime)
        module.useSceneStore.getState().restoreArchivedPresets(['draft'])
        expect(JSON.stringify(writtenPresets())).toBe(JSON.stringify(shells))
    })
})
