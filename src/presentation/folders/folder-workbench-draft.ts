import { MAX_FOLDER_ASSET_ROWS } from './folder-workbench'

export interface FolderComposerDraft {
    mode: 'form' | 'table'
    rows: Array<{ id: string; name: string; prompt: string; count: string }>
    table: string
    templateId: string
}

export interface FolderView {
    query: string
    selected: string[]
    view: 'list' | 'grid'
    includeChildren: boolean
    filter: 'all' | 'images' | 'planned'
    page: number
    scrollTop: number
}

export interface FolderWorkbenchViewState {
    folderId: string | null
    views: Record<string, FolderView>
}

const DRAFT_KEY = 'nai-blue-folder-composer-drafts-v1'
const VIEW_KEY = 'nai-blue-folder-workbench-view-v1'
const MAX_DRAFT_CHARS = 2_000_000
const MAX_SCOPES = 32
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const isText = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit

export const emptyComposerDraft = (): FolderComposerDraft => ({
    mode: 'form', rows: [{ id: crypto.randomUUID(), name: '', prompt: '', count: '1' }], table: '', templateId: '',
})
export const emptyFolderView = (): FolderView => ({ query: '', selected: [], view: 'grid', includeChildren: false, filter: 'all', page: 0, scrollTop: 0 })

// Only presentation inputs are retained; templates, credentials, approvals and execution state never enter this record.
function parseDraft(value: unknown): FolderComposerDraft {
    if (!isRecord(value) || !['form', 'table'].includes(String(value.mode)) || !isText(value.table, MAX_DRAFT_CHARS)
        || !isText(value.templateId, 256) || !Array.isArray(value.rows) || value.rows.length < 1 || value.rows.length > MAX_FOLDER_ASSET_ROWS) throw new Error('Invalid draft')
    const rows = value.rows.map(row => {
        if (!isRecord(row) || !isText(row.id, 256) || !isText(row.name, 96) || !isText(row.prompt, 20_000) || !isText(row.count, 32)) throw new Error('Invalid draft row')
        return { id: row.id, name: row.name, prompt: row.prompt, count: row.count }
    })
    return { mode: value.mode as FolderComposerDraft['mode'], rows, table: value.table, templateId: value.templateId }
}

function readDrafts(): Record<string, FolderComposerDraft> {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (raw === null) return {}
    if (raw.length > MAX_DRAFT_CHARS) throw new Error('Draft storage limit')
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value) || Object.keys(value).length > MAX_SCOPES) throw new Error('Invalid draft storage')
    return Object.fromEntries(Object.entries(value).map(([key, draft]) => [key, parseDraft(draft)]))
}

export function loadFolderDraft(folderId: string): { draft: FolderComposerDraft | null; saved: boolean } {
    try {
        const drafts = readDrafts()
        return { draft: Object.prototype.hasOwnProperty.call(drafts, folderId) ? drafts[folderId] : null, saved: true }
    }
    catch { return { draft: null, saved: false } }
}

export function hasFolderDraftInput(draft: FolderComposerDraft): boolean {
    return !!draft.table || !!draft.templateId || draft.rows.some(row => !!row.name || !!row.prompt || row.count !== '1')
}

/** Synchronous writes survive immediate dialog close/navigation. Limits reject rather than evict another folder's work. */
export function saveFolderDraft(folderId: string, draft: FolderComposerDraft | null): boolean {
    try {
        const drafts = readDrafts()
        if (draft && hasFolderDraftInput(draft)) Object.defineProperty(drafts, folderId, { value: parseDraft(draft), enumerable: true, configurable: true })
        else delete drafts[folderId]
        const raw = JSON.stringify(drafts)
        if (Object.keys(drafts).length > MAX_SCOPES || raw.length > MAX_DRAFT_CHARS) return false
        localStorage.setItem(DRAFT_KEY, raw)
        return true
    } catch { return false }
}

/** A verified import consumes only its submitted mode; later edits and the other input mode survive. */
export function completeFolderDraft(folderId: string, submitted: FolderComposerDraft): { draft: FolderComposerDraft; saved: boolean } | null {
    const current = loadFolderDraft(folderId)
    if (!current.saved || !current.draft || JSON.stringify(current.draft) !== JSON.stringify(submitted)) return null
    const draft = submitted.mode === 'form'
        ? { ...submitted, rows: emptyComposerDraft().rows, templateId: '' }
        : { ...submitted, table: '', templateId: '' }
    return { draft, saved: saveFolderDraft(folderId, draft) }
}

function parseView(value: unknown): FolderView {
    if (!isRecord(value)) throw new Error('Invalid view')
    return {
        query: isText(value.query, 2_000) ? value.query : '',
        selected: Array.isArray(value.selected) ? [...new Set(value.selected.filter((id): id is string => isText(id, 512)))].slice(0, MAX_FOLDER_ASSET_ROWS) : [],
        view: value.view === 'list' ? 'list' : 'grid',
        includeChildren: value.includeChildren === true,
        filter: value.filter === 'images' || value.filter === 'planned' ? value.filter : 'all',
        page: Number.isSafeInteger(value.page) && Number(value.page) >= 0 ? Math.min(Number(value.page), 100_000) : 0,
        scrollTop: typeof value.scrollTop === 'number' && Number.isFinite(value.scrollTop) ? Math.max(0, Math.min(value.scrollTop, 10_000_000)) : 0,
    }
}

export function loadFolderWorkbenchView(): FolderWorkbenchViewState | null {
    try {
        const raw = localStorage.getItem(VIEW_KEY)
        if (!raw || raw.length > 2_000_000) return null
        const value: unknown = JSON.parse(raw)
        if (!isRecord(value) || !(value.folderId === null || isText(value.folderId, 256)) || !isRecord(value.views)) return null
        return { folderId: value.folderId, views: Object.fromEntries(Object.entries(value.views).slice(-MAX_SCOPES).map(([key, view]) => [key, parseView(view)])) }
    } catch { return null }
}

export function saveFolderWorkbenchView(state: FolderWorkbenchViewState): boolean {
    try {
        const views = Object.fromEntries(Object.entries(state.views).slice(-MAX_SCOPES).map(([key, view]) => [key, parseView(view)]))
        const raw = JSON.stringify({ folderId: state.folderId, views })
        if (raw.length > 2_000_000) return false
        localStorage.setItem(VIEW_KEY, raw)
        return true
    } catch { return false }
}
