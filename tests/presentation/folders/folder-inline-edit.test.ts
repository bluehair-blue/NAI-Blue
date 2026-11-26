import { describe, expect, it, vi } from 'vitest'
import {
    inlineEditBlurIntent,
    inlineEditKeyIntent,
    inlineEditNeedsSave,
    nextInlineEditPendingSave,
} from '@/presentation/folders/folder-inline-edit'
import {
    FolderAssetSaveUnconfirmedError,
    saveFolderAssetDetails,
    type SaveFolderAssetDetailsDeps,
} from '@/presentation/folders/save-folder-asset-details'

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

    it('recognises Enter and Escape by physical code when a Korean IME reports key "Process"', () => {
        expect(inlineEditKeyIntent(key({ key: 'Process', code: 'Enter', ctrlKey: true, keyCode: 229 }))).toBe('defer-save')
        expect(inlineEditKeyIntent(key({ key: 'Process', code: 'NumpadEnter', metaKey: true, isComposing: true }))).toBe('defer-save')
        expect(inlineEditKeyIntent(key({ key: 'Process', code: 'Escape', keyCode: 229 }))).toBe('swallow')
        expect(inlineEditKeyIntent(key({ key: 'Process', code: 'KeyA', ctrlKey: true, keyCode: 229 }))).toBeNull()
    })
})

describe('inline editor deferred save', () => {
    it('saves when the composition that received Ctrl+Enter ends, including its committing input', () => {
        let step = nextInlineEditPendingSave(false, { type: 'keydown', intent: 'defer-save', key: 'Process' })
        expect(step).toEqual({ pending: true, commit: false })
        step = nextInlineEditPendingSave(step.pending, { type: 'keydown', intent: null, key: 'Control' })
        expect(step.pending).toBe(true)
        step = nextInlineEditPendingSave(step.pending, { type: 'input', composing: true })
        expect(step.pending).toBe(true)
        expect(nextInlineEditPendingSave(step.pending, { type: 'composition-end' })).toEqual({ pending: false, commit: true })
    })

    it('withdraws the deferred save when typing continues, the text changes outside composition, or the edit is cancelled', () => {
        const pending = nextInlineEditPendingSave(false, { type: 'keydown', intent: 'defer-save', key: 'Process' }).pending
        const afterKey = nextInlineEditPendingSave(pending, { type: 'keydown', intent: null, key: 'Process' })
        expect(afterKey.pending).toBe(false)
        // The next syllable ending must not save and close the editor.
        expect(nextInlineEditPendingSave(afterKey.pending, { type: 'composition-end' }).commit).toBe(false)
        expect(nextInlineEditPendingSave(pending, { type: 'input', composing: false }).pending).toBe(false)
        expect(nextInlineEditPendingSave(pending, { type: 'cancel' }).pending).toBe(false)
        expect(nextInlineEditPendingSave(false, { type: 'composition-end' }).commit).toBe(false)
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
        const input = { presetId: 'preset-1', sceneId: 'scene-1', description: 'edited', restoreOnFlushFailure: true }

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
            { presetId: 'preset-1', sceneId: 'scene-1', description: 'edited', restoreOnFlushFailure: true },
            deps,
        )).rejects.toThrow()
        expect(inlineEditKeyIntent(key({ key: 'Escape' }))).toBe('cancel')
        expect(state.live).toBe('original')
    })

    it('keeps the new text when the flush succeeded but the readback threw, so later flushes cannot undo the save', async () => {
        const { state, deps } = fakeAuthority('A')
        deps.getDocument = vi.fn(async () => { throw new Error('read failed') })
        const save = saveFolderAssetDetails(
            { presetId: 'preset-1', sceneId: 'scene-1', description: 'C', restoreOnFlushFailure: true, unconfirmedMessage: 'unconfirmed' },
            deps,
        )
        await expect(save).rejects.toThrow('unconfirmed')
        await expect(save).rejects.toBeInstanceOf(FolderAssetSaveUnconfirmedError)
        expect(state.persisted).toBe('C')
        expect(state.live).toBe('C')
        // The next flush writes what the store holds; it must still be the saved text.
        await deps.flush()
        expect(state.persisted).toBe('C')
    })

    it('keeps the new text when the readback does not match', async () => {
        const { state, deps } = fakeAuthority('A')
        deps.getDocument = vi.fn(async () => ({ scenes: [{ id: 'scene-1', prompts: { additional: 'stale' } }] as never }))
        await expect(saveFolderAssetDetails(
            { presetId: 'preset-1', sceneId: 'scene-1', description: 'C', restoreOnFlushFailure: true, unconfirmedMessage: 'unconfirmed' },
            deps,
        )).rejects.toBeInstanceOf(FolderAssetSaveUnconfirmedError)
        expect(state.live).toBe('C')
    })

    it('restores the text the store held just before this save, not the text seen when the editor opened', async () => {
        const { state, deps } = fakeAuthority('A')
        // The editor opened on "A"; another path then saved "B".
        state.live = 'B'
        state.persisted = 'B'
        state.failNextFlush = true
        await expect(saveFolderAssetDetails(
            { presetId: 'preset-1', sceneId: 'scene-1', description: 'C', restoreOnFlushFailure: true },
            deps,
        )).rejects.toThrow('flush failed')
        expect(state.live).toBe('B')
        expect(state.persisted).toBe('B')
    })

    it('treats unconfirmed text as unsaved: retrying re-confirms the same text and reverting the draft still saves', () => {
        expect(inlineEditNeedsSave({ draft: 'C', baseline: 'A', unconfirmed: null })).toBe(true)
        expect(inlineEditNeedsSave({ draft: 'A', baseline: 'A', unconfirmed: null })).toBe(false)
        expect(inlineEditNeedsSave({ draft: 'C', baseline: 'A', unconfirmed: 'C' })).toBe(true)
        expect(inlineEditNeedsSave({ draft: 'A', baseline: 'A', unconfirmed: 'C' })).toBe(true)
        expect(inlineEditBlurIntent({ dirty: true, saving: false, cancelled: false, failed: true })).toBe('keep')
    })

    it('does not overwrite text another writer applied after a revision conflict', async () => {
        const { state, deps } = fakeAuthority('original')
        deps.flush = vi.fn(async () => {
            // A revision conflict reloads the authority's text into the store, then fails the write.
            state.live = 'agent edit'
            state.persisted = 'agent edit'
            throw new Error('revision conflict')
        })
        await expect(saveFolderAssetDetails(
            { presetId: 'preset-1', sceneId: 'scene-1', description: 'edited', restoreOnFlushFailure: true },
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
