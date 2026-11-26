import { describe, expect, it, vi } from 'vitest'
import { saveFolderAssetDetails } from '@/presentation/folders/save-folder-asset-details'

describe('saveFolderAssetDetails', () => {
    it('updates prompts and quantity, flushes authority, and confirms readback', async () => {
        const updateScenePrompts = vi.fn()
        const setSceneProductionCounts = vi.fn()
        const flush = vi.fn().mockResolvedValue(undefined)
        const getDocument = vi.fn().mockResolvedValue({
            scenes: [{ id: 'scene-1', prompts: { additional: 'sunrise over bay' }, productionCount: 4 }],
        })

        await saveFolderAssetDetails(
            { presetId: 'preset-1', sceneId: 'scene-1', description: 'sunrise over bay', quantity: 4 },
            { updateScenePrompts, setSceneProductionCounts, flush, getDocument },
        )

        expect(updateScenePrompts).toHaveBeenCalledWith('preset-1', 'scene-1', { additional: 'sunrise over bay' })
        expect(setSceneProductionCounts).toHaveBeenCalledWith([{ presetId: 'preset-1', sceneId: 'scene-1' }], 4)
        expect(flush).toHaveBeenCalledTimes(1)
        expect(getDocument).toHaveBeenCalledWith('preset-1')
    })

    it('updates description only when quantity is omitted', async () => {
        const updateScenePrompts = vi.fn()
        const setSceneProductionCounts = vi.fn()
        const flush = vi.fn().mockResolvedValue(undefined)
        const getDocument = vi.fn().mockResolvedValue({
            scenes: [{ id: 'scene-1', prompts: { additional: '' }, productionCount: 2 }],
        })

        await saveFolderAssetDetails(
            { presetId: 'preset-1', sceneId: 'scene-1', description: '' },
            { updateScenePrompts, setSceneProductionCounts, flush, getDocument },
        )

        expect(updateScenePrompts).toHaveBeenCalledWith('preset-1', 'scene-1', { additional: '' })
        expect(setSceneProductionCounts).not.toHaveBeenCalled()
    })

    it('throws the unconfirmed error when readback does not match', async () => {
        const deps = {
            updateScenePrompts: vi.fn(),
            setSceneProductionCounts: vi.fn(),
            flush: vi.fn().mockResolvedValue(undefined),
            getDocument: vi.fn().mockResolvedValue({
                scenes: [{ id: 'scene-1', prompts: { additional: 'stale' }, productionCount: 1 }],
            }),
        }

        await expect(saveFolderAssetDetails(
            {
                presetId: 'preset-1',
                sceneId: 'scene-1',
                description: 'updated',
                quantity: 1,
                unconfirmedMessage: 'confirm failed',
            },
            deps,
        )).rejects.toThrow('confirm failed')
    })

    it('throws when the saved scene is missing or quantity mismatches', async () => {
        const deps = {
            updateScenePrompts: vi.fn(),
            setSceneProductionCounts: vi.fn(),
            flush: vi.fn().mockResolvedValue(undefined),
            getDocument: vi.fn().mockResolvedValue({
                scenes: [{ id: 'scene-1', prompts: { additional: 'updated' }, productionCount: 1 }],
            }),
        }

        await expect(saveFolderAssetDetails(
            { presetId: 'preset-1', sceneId: 'scene-1', description: 'updated', quantity: 3, unconfirmedMessage: 'count mismatch' },
            deps,
        )).rejects.toThrow('count mismatch')

        deps.getDocument.mockResolvedValueOnce(null)
        await expect(saveFolderAssetDetails(
            { presetId: 'preset-1', sceneId: 'scene-1', description: 'updated', unconfirmedMessage: 'missing doc' },
            deps,
        )).rejects.toThrow('missing doc')
    })

    it('rejects out-of-range inputs before mutating the store', async () => {
        const updateScenePrompts = vi.fn()
        const setSceneProductionCounts = vi.fn()
        const flush = vi.fn()
        const getDocument = vi.fn()
        const deps = { updateScenePrompts, setSceneProductionCounts, flush, getDocument }

        await expect(saveFolderAssetDetails(
            { presetId: 'preset-1', sceneId: 'scene-1', description: 'ok', quantity: 0 },
            deps,
        )).rejects.toThrow()
        await expect(saveFolderAssetDetails(
            { presetId: 'preset-1', sceneId: 'scene-1', description: 'x'.repeat(20_001) },
            deps,
        )).rejects.toThrow()

        expect(updateScenePrompts).not.toHaveBeenCalled()
        expect(setSceneProductionCounts).not.toHaveBeenCalled()
        expect(flush).not.toHaveBeenCalled()
    })
})
