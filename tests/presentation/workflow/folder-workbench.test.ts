import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import {
    collectFolderAssets, createFolderAssetPreset, parseFolderAssetTable, UNASSIGNED_FOLDER_ID,
} from '@/presentation/folders/folder-workbench'
import type { GenerationFolder } from '@/domain/generation-folders'
import { DEFAULT_SCENE_GENERATION, DEFAULT_SCENE_PROMPTS, useSceneStore, type SceneFolderTemplate } from '@/stores/scene-store'

const folder = (id: string, parentId: string | null): GenerationFolder => ({
    schemaVersion: 1, id, name: id, parentId, rootDirectory: null, useAbsolutePath: false,
    commonPrompt: '', r2: { autoUpload: false, bucket: null, prefix: null }, createdAt: '', updatedAt: '',
})

describe('Folder production input and scope', () => {
    it('reads pasted table columns without splitting prompt commas and rejects invalid quantities', () => {
        const parsed = parseFolderAssetTable('이름\t프롬프트\t수량\r\nhappy\tsmile, blue eyes\t20\r\nsad\ttears\t\r\nbad\tfrown\t2.5')
        expect(parsed.rows).toEqual([{ name: 'happy', prompt: 'smile, blue eyes', count: 20 }, { name: 'sad', prompt: 'tears', count: 1 }])
        expect(parsed.errors).toEqual([{ line: 4, code: 'count' }])
        expect(parseFolderAssetTable('one,prompt,2').errors).toEqual([{ line: 1, code: 'columns' }])
    })

    it('builds 2,400 independent assets and bounds oversized input without silently reporting success', () => {
        const text = Array.from({ length: 2_400 }, (_, index) => `asset-${index}\tprompt ${index}\t1`).join('\n')
        const parsed = parseFolderAssetTable(text)
        expect(parsed.errors).toEqual([])
        const preset = createFolderAssetPreset({ name: 'bulk', folderId: 'child', rows: parsed.rows })
        expect(preset.scenes).toHaveLength(2_400)
        expect(new Set(preset.scenes.map(scene => scene.id)).size).toBe(2_400)
        expect(preset.scenes.at(-1)).toMatchObject({ generationFolderId: 'child', scenePrompt: 'prompt 2399', productionCount: 1, queueCount: 0 })
        expect(parseFolderAssetTable(`${text}\noverflow\tprompt`).errors).toEqual([{ line: 2_401, code: 'limit' }])
    })

    it('copies generation rules and character/negative prompts without sharing mutable template data or results', () => {
        const template: SceneFolderTemplate = {
            sourceSceneId: 'source', sourceSceneName: 'Source', scenePrompt: 'template detail',
            prompts: { ...DEFAULT_SCENE_PROMPTS, base: 'watercolor', additional: 'template detail', negative: 'blur' },
            generation: { ...DEFAULT_SCENE_GENERATION, steps: 30 },
            characterCaptions: [{ id: 'character', prompt: 'blue hair', negative: 'red hair', enabled: true, position: { x: 0.5, y: 0.5 } }],
        }
        const before = structuredClone(template)
        const result = createFolderAssetPreset({ name: 'batch', folderId: 'child', template,
            rows: [{ name: 'happy', prompt: 'smile', count: 20 }, { name: 'sad', prompt: 'tears', count: 10 }] })
        expect(result.scenes[0]).toMatchObject({ scenePrompt: 'template detail, smile', prompts: { base: 'watercolor', negative: 'blur' }, productionCount: 20, queueCount: 0, images: [] })
        expect(result.scenes[1].scenePrompt).toBe('template detail, tears')
        result.scenes[0].characterCaptions![0].position.x = 0.2
        expect(result.scenes[1].characterCaptions![0].position.x).toBe(0.5)
        expect(template).toEqual(before)
        const locked = createFolderAssetPreset({ name: 'locked', folderId: 'child',
            template: { ...template, generation: { ...template.generation, seedLocked: true } },
            rows: [{ name: 'happy', prompt: 'smile', count: 2 }] })
        expect(locked.scenes[0].filenameTemplate).toBeUndefined()
        expect(locked.scenes[0].generation?.seedLocked).toBe(true)
    })

    it('collects exact folder membership across presets, includes children only on request, and retains manual legacy paths', () => {
        const make = (name: string, folderId: string) => createFolderAssetPreset({ name, folderId, rows: [{ name, prompt: name, count: 1 }] })
        const a = make('one', 'root')
        const b = make('two', 'child')
        const manual = make('manual', 'unused')
        delete manual.scenes[0].generationFolderId
        const presets = [a, b, manual]
        const folders = [folder('root', null), folder('child', 'root')]
        expect(collectFolderAssets(presets, folders, 'root', false).map(row => row.presetName)).toEqual(['one'])
        expect(collectFolderAssets(presets, folders, 'root', true).map(row => row.presetName)).toEqual(['one', 'two'])
        expect(collectFolderAssets(presets, folders, UNASSIGNED_FOLDER_ID, true).map(row => row.presetName)).toEqual(['manual'])
        expect(collectFolderAssets(presets, folders, null, false)).toHaveLength(3)
        expect(manual.scenes[0].generationFolderId).toBeUndefined()
    })

    it('changes 2,400 production quantities in one store update without changing pending Queue entries', () => {
        const preset = createFolderAssetPreset({ name: 'bulk', folderId: 'child', rows:
            Array.from({ length: 2_400 }, (_, index) => ({ name: `asset-${index}`, prompt: 'smile', count: 2 })) })
        preset.scenes[0].queuedFileNames = ['keep.png', 'trim.png']
        preset.scenes[0].queueCount = 2
        useSceneStore.setState({ presets: [preset] })
        let notifications = 0
        const unsubscribe = useSceneStore.subscribe(() => { notifications += 1 })
        try {
            useSceneStore.getState().setSceneProductionCounts(preset.scenes.map(scene => ({ presetId: preset.id, sceneId: scene.id })), 1)
            expect(notifications).toBe(1)
            const scenes = useSceneStore.getState().presets[0].scenes
            expect(scenes.every(scene => scene.productionCount === 1)).toBe(true)
            expect(scenes[0].queuedFileNames).toEqual(['keep.png', 'trim.png'])
            expect(scenes[0].queueCount).toBe(2)
            expect(scenes[1].queueCount).toBe(0)
        } finally { unsubscribe() }
    })
})
