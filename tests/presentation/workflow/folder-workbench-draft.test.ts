import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    completeFolderDraft, emptyComposerDraft, emptyFolderView, loadFolderDraft,
    loadFolderWorkbenchView, saveFolderDraft, saveFolderWorkbenchView,
} from '@/presentation/folders/folder-workbench-draft'

let storage: Map<string, string>
beforeEach(() => {
    storage = new Map()
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
    })
})

describe('Folder workbench recovery', () => {
    it('restores exact inputs by folder, including invalid input awaiting correction and inactive mode', () => {
        const draft = { ...emptyComposerDraft(), table: 'unfinished\ttable', templateId: 'template-a' }
        draft.rows[0] = { ...draft.rows[0], name: 'unfinished', prompt: 'blue hair', count: '' }
        expect(saveFolderDraft('folder-a', draft)).toBe(true)
        expect(loadFolderDraft('folder-a')).toEqual({ draft, saved: true })
        expect(loadFolderDraft('folder-b').draft).toBeNull()
        expect(loadFolderDraft('__proto__').draft).toBeNull()
        expect(saveFolderDraft('folder-b', { ...emptyComposerDraft(), table: 'other' })).toBe(true)
        expect(saveFolderDraft('folder-a', null)).toBe(true)
        expect(loadFolderDraft('folder-a').draft).toBeNull()
        expect(loadFolderDraft('folder-b').draft?.table).toBe('other')
    })

    it('consumes only the submitted mode after verified import; later edits or explicit discard are not overwritten', () => {
        const submitted = { ...emptyComposerDraft(), table: 'keep this inactive input', templateId: 'preset' }
        submitted.rows[0].prompt = 'submitted prompt'
        saveFolderDraft('folder', submitted)
        const completed = completeFolderDraft('folder', submitted)
        expect(completed?.saved).toBe(true)
        expect(loadFolderDraft('folder').draft).toMatchObject({ table: submitted.table, templateId: '', rows: [{ prompt: '' }] })
        saveFolderDraft('folder', submitted)
        const newer = { ...submitted, table: 'newer edit' }
        saveFolderDraft('folder', newer)
        expect(completeFolderDraft('folder', submitted)).toBeNull()
        expect(loadFolderDraft('folder').draft).toEqual(newer)
        saveFolderDraft('folder', null)
        expect(completeFolderDraft('folder', submitted)).toBeNull()
        expect(loadFolderDraft('folder').draft).toBeNull()
    })

    it('reports quota/corruption/size failures without deleting the last saved draft', () => {
        const draft = { ...emptyComposerDraft(), table: 'saved prompt' }
        saveFolderDraft('folder', draft)
        expect(saveFolderDraft('folder', { ...draft, table: 'x'.repeat(2_000_001) })).toBe(false)
        expect(loadFolderDraft('folder').draft).toEqual(draft)
        const setter = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota') })
        expect(saveFolderDraft('folder', null)).toBe(false)
        expect(loadFolderDraft('folder').draft).toEqual(draft)
        setter.mockRestore()
        storage.set('nai-blue-folder-composer-drafts-v1', '{broken')
        expect(loadFolderDraft('folder')).toEqual({ draft: null, saved: false })
        expect(saveFolderDraft('folder', draft)).toBe(false)
        expect(storage.get('nai-blue-folder-composer-drafts-v1')).toBe('{broken')
    })

    it('bounds saved folders without silently evicting drafts and strips unknown fields', () => {
        const draft = { ...emptyComposerDraft(), table: 'input', credentials: 'must not persist' }
        for (let index = 0; index < 32; index++) expect(saveFolderDraft(`folder-${index}`, draft)).toBe(true)
        expect(saveFolderDraft('folder-33', draft)).toBe(false)
        expect(loadFolderDraft('folder-0').draft?.table).toBe('input')
        expect(storage.get('nai-blue-folder-composer-drafts-v1')).not.toContain('credentials')
    })

    it('restores folder/search/selection/filter/view/page/scroll and sanitizes bounded view state', () => {
        const view = { ...emptyFolderView(), query: 'blue', selected: ['asset-a', 'asset-b'], view: 'list' as const,
            includeChildren: true, filter: 'planned' as const, page: 4, scrollTop: 680 }
        const state = { folderId: null, views: { __all__: view } }
        expect(saveFolderWorkbenchView(state)).toBe(true)
        expect(loadFolderWorkbenchView()).toEqual(state)
        const views = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`folder-${index}`, view]))
        saveFolderWorkbenchView({ folderId: 'folder-39', views })
        expect(Object.keys(loadFolderWorkbenchView()!.views)).toHaveLength(32)
        expect(loadFolderWorkbenchView()!.views['folder-39']).toEqual(view)
        storage.set('nai-blue-folder-workbench-view-v1', JSON.stringify({ folderId: '__proto__', views: {
            safe: { page: -1, scrollTop: -10, filter: 'unknown', selected: ['a', 'a', 4], apiKey: 'secret' },
        } }))
        expect(loadFolderWorkbenchView()?.views.safe).toEqual({ ...emptyFolderView(), selected: ['a'] })
    })
})
