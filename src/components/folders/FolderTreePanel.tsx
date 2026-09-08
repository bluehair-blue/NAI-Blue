import { useId, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Folder, FolderOpen, Images, Plus, Search } from 'lucide-react'
import type { GenerationFolder } from '@/domain/generation-folders'
import { UNASSIGNED_FOLDER_ID } from '@/presentation/folders/folder-workbench'

interface FolderTreePanelProps {
    folders: readonly GenerationFolder[]
    activeFolderId: string | null
    counts: Readonly<Record<string, number>>
    onSelect: (id: string | null) => void
    onManage: () => void
}

/** Read-only navigation over the existing folder projection; management stays with its dialog. */
export function FolderTreePanel({ folders, activeFolderId, counts, onSelect, onManage }: FolderTreePanelProps) {
    const { t } = useTranslation()
    const searchId = useId()
    const headingId = useId()
    const [query, setQuery] = useState('')
    const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
    const normalizedQuery = query.trim().toLocaleLowerCase().replace(/\s*\/\s*/gu, '/')
    const { children, totals, visible, paths } = useMemo(() => {
        const byId = new Map(folders.map(folder => [folder.id, folder]))
        const children = new Map<string | null, GenerationFolder[]>()
        const totals = new Map<string, number>()
        const visible = new Set<string>()
        const paths = new Map<string, string>()

        for (const folder of byId.values()) {
            const parentId = folder.parentId !== null && byId.has(folder.parentId) ? folder.parentId : null
            const siblings = children.get(parentId) ?? []
            siblings.push(folder)
            children.set(parentId, siblings)

            // Walking parents also supplies branch counts and search context. A seen set
            // prevents malformed legacy projections from trapping the navigation in a cycle.
            const chain: GenerationFolder[] = []
            const seen = new Set<string>()
            let current: GenerationFolder | undefined = folder
            while (current && !seen.has(current.id)) {
                seen.add(current.id)
                chain.unshift(current)
                totals.set(current.id, (totals.get(current.id) ?? 0) + (counts[folder.id] ?? 0))
                current = current.parentId === null ? undefined : byId.get(current.parentId)
            }
            const path = chain.map(item => item.name).join('/')
            paths.set(folder.id, path)
            if (!normalizedQuery || path.toLocaleLowerCase().includes(normalizedQuery)) {
                for (const ancestor of chain) visible.add(ancestor.id)
            }
        }
        return { children, totals, visible, paths }
    }, [folders, counts, normalizedQuery])

    const toggleFolder = (id: string) => setCollapsed(previous => {
        const next = new Set(previous)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
    })

    const renderFolders = (parentId: string | null, ancestors = new Set<string>()): ReactNode => {
        const siblings = (children.get(parentId) ?? []).filter(folder => visible.has(folder.id) && !ancestors.has(folder.id))
        if (siblings.length === 0) return null
        return (
            <ul className="fb-folder-list">
                {siblings.map(folder => {
                    const branch = (children.get(folder.id) ?? []).some(child => !ancestors.has(child.id) && child.id !== folder.id)
                    // Search reveals matching descendants without discarding the user's folded branches.
                    const expanded = normalizedQuery.length > 0 || !collapsed.has(folder.id)
                    const active = activeFolderId === folder.id
                    const nextAncestors = new Set(ancestors).add(folder.id)
                    return (
                        <li key={folder.id}>
                            <div className={`fb-folder-row${active ? ' is-active' : ''}`}>
                                {branch ? (
                                    <button
                                        type="button"
                                        className="fb-folder-toggle min-h-11 min-w-11"
                                        aria-label={expanded
                                            ? t('folderWorkbench.design.collapseFolder', '{{name}} 접기', { name: folder.name })
                                            : t('folderWorkbench.design.expandFolder', '{{name}} 펼치기', { name: folder.name })}
                                        aria-expanded={expanded}
                                        disabled={normalizedQuery.length > 0}
                                        onClick={() => toggleFolder(folder.id)}
                                    >
                                        {expanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
                                    </button>
                                ) : <span className="fb-folder-toggle min-w-11" aria-hidden="true" />}
                                <button
                                    type="button"
                                    className="fb-folder-select min-h-11 text-base"
                                    aria-current={active ? 'page' : undefined}
                                    title={paths.get(folder.id)}
                                    onClick={() => onSelect(folder.id)}
                                >
                                    {active ? <FolderOpen size={18} aria-hidden="true" /> : <Folder size={18} aria-hidden="true" />}
                                    <span className="fb-folder-name">{folder.name}</span>
                                    <span className="fb-folder-count" aria-label={t('folderWorkbench.design.folderImageCount', '이미지 {{count}}개', { count: totals.get(folder.id) ?? 0 })}>
                                        {totals.get(folder.id) ?? 0}
                                    </span>
                                </button>
                            </div>
                            {branch && expanded && renderFolders(folder.id, nextAncestors)}
                        </li>
                    )
                })}
            </ul>
        )
    }

    return (
        <nav className="fb-folder-panel" aria-labelledby={headingId}>
            <div className="fb-folder-heading">
                <h2 id={headingId}>{t('folderWorkbench.design.folders', '폴더')}</h2>
                <button type="button" className="fb-folder-add min-h-11 text-base" onClick={onManage}>
                    <Plus size={16} aria-hidden="true" />
                    {t('folderWorkbench.design.newFolder', '새 폴더')}
                </button>
            </div>
            <label htmlFor={searchId} className="fb-folder-search-label">{t('folderWorkbench.design.findFolder', '폴더 찾기')}</label>
            <div className="fb-folder-search">
                <Search size={18} aria-hidden="true" />
                <input
                    id={searchId}
                    type="search"
                    className="min-h-11 text-base"
                    value={query}
                    placeholder={t('folderWorkbench.design.findFolder', '폴더 찾기')}
                    onChange={event => setQuery(event.target.value)}
                />
            </div>
            <div className="fb-folder-tree">
                {renderFolders(null)}
                {normalizedQuery && visible.size === 0 && (
                    <p className="fb-folder-empty" role="status">{t('folderWorkbench.design.noFolderMatches', '찾는 폴더가 없어요')}</p>
                )}
            </div>
            <div className="fb-folder-shortcuts">
                <button type="button" className="min-h-11 text-base" aria-current={activeFolderId === null ? 'page' : undefined} onClick={() => onSelect(null)}>
                    <Images size={18} aria-hidden="true" />
                    {t('folderWorkbench.design.allImages', '모든 이미지')}
                </button>
                <button type="button" className="min-h-11 text-base" aria-current={activeFolderId === UNASSIGNED_FOLDER_ID ? 'page' : undefined} onClick={() => onSelect(UNASSIGNED_FOLDER_ID)}>
                    <FolderOpen size={18} aria-hidden="true" />
                    {t('folderWorkbench.design.unfiled', '폴더 없는 이미지')}
                </button>
            </div>
        </nav>
    )
}
