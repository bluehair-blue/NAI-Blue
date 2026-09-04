import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
    apply: vi.fn(),
    getDocument: vi.fn(),
}))

vi.mock('@/services/folder/apply-runtime-folder-changes', () => ({
    applyRuntimeGenerationFolderChanges: runtime.apply,
    getRuntimeGenerationFolderDocument: runtime.getDocument,
}))

vi.mock('@/lib/indexed-db', () => ({
    indexedDBStorage: {
        getItem: async () => null,
        setItem: async () => undefined,
        removeItem: async () => undefined,
    },
}))

import { planGenerationFolderChanges } from '@/application/folder/plan-folder-changes'
import {
    migrateGenerationFolderV1Projection,
    normalizeGenerationFolderV1Projection,
    type GenerationFolder,
    type GenerationFolderDocument,
} from '@/domain/generation-folders'
import { projectGenerationFolderDocument } from '@/lib/generation-folder-authority-runtime'
import { useSettingsStore } from '@/stores/settings-store'

const NOW = '2026-09-04T00:00:00.000Z'
const legacy = (id: string, name: string, parentId: string | null): GenerationFolder => ({
    schemaVersion: 1, id, name, parentId, rootDirectory: parentId === null ? 'D:\\images' : null,
    useAbsolutePath: parentId === null, commonPrompt: '',
    r2: { autoUpload: false, bucket: null, prefix: null }, createdAt: NOW, updatedAt: NOW,
})
const document = migrateGenerationFolderV1Projection('local', normalizeGenerationFolderV1Projection({
    savePath: 'D:\\images', useAbsolutePath: true, activeGenerationFolderId: 'grandchild',
    generationFolders: [legacy('root', 'Root', null), legacy('child', 'Child', 'root'), legacy('grandchild', 'Grandchild', 'child')],
}))

function committed(current: GenerationFolderDocument, input: Parameters<typeof planGenerationFolderChanges>[1]) {
    const plan = planGenerationFolderChanges(current, input, {
        directory: 'D:\\images', useAbsolutePath: true,
    })
    if (plan.status !== 'PLANNED') throw new Error(plan.reason)
    return { status: 'COMMITTED' as const, plan }
}

describe('settings Folder mutation commands', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        runtime.getDocument.mockResolvedValue(structuredClone(document))
        useSettingsStore.setState({
            generationFolderDocument: structuredClone(document),
            generationFolders: projectGenerationFolderDocument(document),
            savePath: 'D:\\images',
            useAbsolutePath: true,
            activeGenerationFolderId: 'grandchild',
        })
    })

    it('projects a save only after guarded apply reports COMMITTED', async () => {
        let resolveApply!: (value: ReturnType<typeof committed>) => void
        runtime.apply.mockReturnValue(new Promise(resolve => { resolveApply = resolve }))

        const saving = useSettingsStore.getState().saveGenerationFolder('child', 'root', { name: 'Saved' })
        expect(useSettingsStore.getState().generationFolders.find(folder => folder.id === 'child')?.name).toBe('Child')

        resolveApply(committed(document, [{ folderId: 'child', displayName: 'Saved' }]))
        await saving
        expect(useSettingsStore.getState().generationFolders.find(folder => folder.id === 'child')?.name).toBe('Saved')
    })

    it('keeps authoritative projection and active selection when occupied deletion is rejected', async () => {
        runtime.apply.mockResolvedValue({
            status: 'UNSUPPORTED', reason: 'unsupported-needs-relocation-policy',
            occupancy: { status: 'occupied', folderIds: ['child'] },
        })

        await expect(useSettingsStore.getState().deleteGenerationFolders(['child'])).rejects.toThrow(/UNSUPPORTED/)

        const changes = runtime.apply.mock.calls[0][0].changes
        expect(changes).toEqual([
            { op: 'delete', folderId: 'grandchild' },
            { op: 'delete', folderId: 'child' },
        ])
        expect(useSettingsStore.getState().generationFolders.map(folder => folder.id)).toContain('child')
        expect(useSettingsStore.getState().activeGenerationFolderId).toBe('grandchild')
    })

    it('keeps the projection unchanged when an occupied move is rejected', async () => {
        runtime.apply.mockResolvedValue({
            status: 'UNSUPPORTED', reason: 'unsupported-needs-relocation-policy',
            occupancy: { status: 'occupied', folderIds: ['child'] },
        })

        await expect(useSettingsStore.getState().moveGenerationFolders(['child'], null)).rejects.toThrow(/UNSUPPORTED/)

        expect(useSettingsStore.getState().generationFolders.find(folder => folder.id === 'child')?.parentId).toBe('root')
    })
})
