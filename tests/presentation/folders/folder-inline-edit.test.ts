import { describe, expect, it, vi } from 'vitest'
import { inlineEditBlurIntent, inlineEditKeyIntent } from '@/presentation/folders/folder-inline-edit'
import { saveFolderAssetDetails, type SaveFolderAssetDetailsDeps } from '@/presentation/folders/save-folder-asset-details'

const key = (overrides: Partial<Parameters<typeof inlineEditKeyIntent>[0]>) => ({
    key: 'a', ctrlKey: false, metaKey: false, isComposing: false, keyCode: 0, ...overrides,
})

/** A single-scene store whose authority write can be made to fail, mirroring SceneStore's optimistic update. */
function fakeAuthority(initial: string) {
    const state = { live: initial, persisted: initial, failNextFlush: false }
    const deps: SaveFolderAssetDetailsDeps = {
        updateScenePrompts: vi.fn((_presetId, _sceneId, prompts: { additional: string }) => { state.live = prompts.additional }),
        setSceneProductionCounts: vi.fn(),
        flush: vi.fn(async () => {
            if (state.failNextFlush) {
                state.failNextFlush = false
                throw new Error('flush failed')
            }
            state.persisted = state.live
        }),
        getDocument: vi.fn(async () => ({ scenes: [{ id: 'scene-1', prompts: { additional: state.persisted } }] as never })),
        readDescription: () => state.live,
    }
    return { state, deps }
}

describe('inline editor key intent', () => {
    it('saves on Ctrl/Cmd+Enter and cancels on Escape from any focused control', () => {
        expect(inlineEditKeyIntent(key({ key: 'Enter', ctrlKey: true }))).toBe('save')
        expect(inlineEditKeyIntent(key({ key: 'Enter', metaKey: true }))).toBe('save')
        expect(inlineEditKeyIntent(key({ key: 'Escape' }))).toBe('cancel')
        expect(inlineEditKeyIntent(key({ key: 'Enter' }))).toBeNull()
        expect(inlineEditKeyIntent(key({ key: 'a', ctrlKey: true }))).toBeNull()
    })

    it('never cancels or commits mid-composition, deferring the save until the syllable is committed', () => {
        expect(inlineEditKeyIntent(key({ key: 'Enter', ctrlKey: true, isComposing: true }))).toBe('defer-save')
        expect(inlineEditKeyIntent(key({ key: 'Process', ctrlKey: true, keyCode: 229 }))).toBeNull()
        expect(inlineEditKeyIntent(key({ key: 'Enter', ctrlKey: true, keyCode: 229 }))).toBe('defer-save')
        expect(inlineEditKeyIntent(key({ key: 'Escape', isComposing: true }))).toBe('swallow')
    })
})

describe('inline editor blur intent', () => {
    it('commits a dirty draft and closes an untouched one', () => {
        expect(inlineEditBlurIntent({ dirty: true, saving: false, cancelled: false, failed: false })).toBe('commit')
        expect(inlineEditBlurIntent({ dirty: false, saving: false, cancelled: false, failed: false })).toBe('close')
    })

    it('keeps a failed draft open when focus leaves', () => {
        expect(inlineEditBlurIntent({ dirty: true, saving: false, cancelled: false, failed: true })).toBe('keep')
        expect(inlineEditBlurIntent({ dirty: true, saving: true, cancelled: false, failed: false })).toBe('keep')
        expect(inlineEditBlurIntent({ dirty: true, saving: false, cancelled: true, failed: false })).toBe('keep')
    })
})

describe('inline description save failure', () => {
    it('withdraws the optimistic text on failure, stays dirty against the edit baseline, and succeeds on retry', async () => {
        const { state, deps } = fakeAuthority('original')
        const input = { presetId: 'preset-1', sceneId: 'scene-1', description: 'edited', restoreDescriptionOnFailure: 'original' }

        state.failNextFlush = true
        await expect(saveFolderAssetDetails(input, deps)).rejects.toThrow('flush failed')
        expect(state.live).toBe('original')
        expect(state.persisted).toBe('original')
        // The editor compares its draft with the baseline captured at open, so the card still reads as unsaved.
        expect(inlineEditBlurIntent({ dirty: input.description !== 'original', saving: false, cancelled: false, failed: true })).toBe('keep')

        await saveFolderAssetDetails(input, deps)
        expect(state.live).toBe('edited')
        expect(state.persisted).toBe('edited')
    })

    it('leaves the original description in the store when the user cancels after a failed save', async () => {
        const { state, deps } = fakeAuthority('original')
        state.failNextFlush = true
        await expect(saveFolderAssetDetails(
            { presetId: 'preset-1', sceneId: 'scene-1', description: 'edited', restoreDescriptionOnFailure: 'original' },
            deps,
        )).rejects.toThrow()
        expect(inlineEditKeyIntent(key({ key: 'Escape' }))).toBe('cancel')
        expect(state.live).toBe('original')
    })

    it('restores after an unconfirmed readback as well', async () => {
        const { state, deps } = fakeAuthority('original')
        deps.getDocument = vi.fn(async () => ({ scenes: [{ id: 'scene-1', prompts: { additional: 'stale' } }] as never }))
        await expect(saveFolderAssetDetails(
            { presetId: 'preset-1', sceneId: 'scene-1', description: 'edited', restoreDescriptionOnFailure: 'original', unconfirmedMessage: 'unconfirmed' },
            deps,
        )).rejects.toThrow('unconfirmed')
        expect(state.live).toBe('original')
    })

    it('does not overwrite text another writer applied after a revision conflict', async () => {
        const { state, deps } = fakeAuthority('original')
        deps.flush = vi.fn(async () => { state.live = 'agent edit'; state.persisted = 'agent edit' })
        await expect(saveFolderAssetDetails(
            { presetId: 'preset-1', sceneId: 'scene-1', description: 'edited', restoreDescriptionOnFailure: 'original' },
            deps,
        )).rejects.toThrow()
        expect(state.live).toBe('agent edit')
    })

    it('keeps the store untouched on failure when no restore baseline is given (detail dialog path)', async () => {
        const { state, deps } = fakeAuthority('original')
        state.failNextFlush = true
        await expect(saveFolderAssetDetails({ presetId: 'preset-1', sceneId: 'scene-1', description: 'edited' }, deps)).rejects.toThrow()
        expect(state.live).toBe('edited')
    })
})
