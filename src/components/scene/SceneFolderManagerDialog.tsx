import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { scenePresetDisplayPath } from '@/presentation/folders/default-names'
import type { TFunction } from 'i18next'
import {
    Archive,
    ArchiveRestore,
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    Copy,
    FilePlus2,
    Folder,
    FolderTree,
    Info,
    Move,
    Pencil,
    Search,
    Sparkles,
    Trash2,
    X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils'
import { DEFAULT_SCENE_PRESET_ID, getScenePresetPathSegments, scenePresetBranchIds, useSceneStore, visibleScenePresets, type ScenePreset } from '@/stores/scene-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useTrashStore } from '@/stores/trash-store'
import { archiveSceneFolder } from '@/services/trash/asset-trash-service'

interface SceneFolderManagerDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
}

interface FolderRow {
    preset: ScenePreset
    depth: number
    path: string
}

interface SourceSceneRow {
    key: string
    preset: ScenePreset
    scene: ScenePreset['scenes'][number]
    path: string
}

type FolderFilter = 'all' | 'template' | 'empty'
type FolderSort = 'tree' | 'name' | 'recent' | 'sceneCount'

const MAX_VISIBLE_FOLDERS = 300
const MAX_VISIBLE_SOURCE_SCENES = 200

/**
 * Depends on ScenePreset.parentId and feeds the searchable folder navigator below.
 * It replaces repeated per-parent scans so large persisted trees remain responsive,
 * while the visited guard also keeps malformed legacy cycles from locking the dialog.
 */
function buildFolderRows(presets: readonly ScenePreset[]): FolderRow[] {
    const children = new Map<string | null, ScenePreset[]>()
    presets.forEach(preset => {
        const parentId = preset.parentId ?? null
        const siblings = children.get(parentId) ?? []
        siblings.push(preset)
        children.set(parentId, siblings)
    })

    const result: FolderRow[] = []
    const visited = new Set<string>()
    const append = (preset: ScenePreset, depth: number, parentPath: string) => {
        if (visited.has(preset.id)) return
        visited.add(preset.id)
        const path = parentPath ? `${parentPath} / ${preset.name}` : preset.name
        result.push({ preset, depth, path })
        ;(children.get(preset.id) ?? []).forEach(child => append(child, depth + 1, path))
    }

    ;(children.get(null) ?? []).forEach(preset => append(preset, 0, ''))
    presets.filter(preset => !visited.has(preset.id)).forEach(preset => append(preset, 0, ''))
    return result
}

/**
 * Depends on deletePreset's descendant-cascade contract and is shown by the inline
 * confirmation panel. Counting folders and scenes before deletion makes the scope
 * explicit, preventing an innocent parent-folder click from silently removing a branch.
 */
function getDeletionImpact(presets: readonly ScenePreset[], selectedIds: readonly string[]) {
    const deleted = new Set(selectedIds.filter(id => id !== DEFAULT_SCENE_PRESET_ID))
    let changed = true
    while (changed) {
        changed = false
        presets.forEach(preset => {
            if (preset.parentId && deleted.has(preset.parentId) && !deleted.has(preset.id)) {
                deleted.add(preset.id)
                changed = true
            }
        })
    }
    return {
        folders: deleted.size,
        scenes: presets
            .filter(preset => deleted.has(preset.id))
            .reduce((sum, preset) => sum + preset.scenes.length, 0),
    }
}

export interface ArchivedPresetRow {
    preset: ScenePreset
    path: string
    folders: number
    scenes: number
}

/**
 * One row per archived branch: an archived preset whose parent is still active. The counts are the whole branch, which
 * is what delete moves to the trash; restore brings back the part archived together and leaves a folder archived
 * earlier inside it as its own row. Newest archive first.
 */
export function archivedPresetRows(presets: readonly ScenePreset[]): ArchivedPresetRow[] {
    const archivedPresets = presets.filter(preset => preset.archivedAt !== undefined)
    const archived = new Set(archivedPresets.map(preset => preset.id))
    const roots = archivedPresets.filter(preset => !(preset.parentId && archived.has(preset.parentId)))
    // Old data can hold a parentId cycle: none of its members has an active parent, so the first one stands for it.
    const covered = scenePresetBranchIds(presets, roots.map(preset => preset.id))
    for (const preset of archivedPresets) {
        if (covered.has(preset.id)) continue
        roots.push(preset)
        scenePresetBranchIds(presets, [preset.id]).forEach(id => covered.add(id))
    }
    return roots
        .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
        .map(preset => ({ preset, path: getScenePresetPathSegments(presets, preset.id).join(' / '), ...getDeletionImpact(presets, [preset.id]) }))
}

/**
 * In a short window the opened rows and the delete confirmation land below the visible part of the folder column.
 * A module-level ref callback runs once when the element appears, so it never pulls the view back while the user scrolls.
 */
const revealOnMount = (node: HTMLElement | null) => node?.scrollIntoView({ block: 'nearest' })

/**
 * The archive at the bottom of the preset manager: collapsed by default and absent when empty. Controlled by the dialog
 * so restore and delete stay on the store's own actions; delete asks for the same confirmation as the folder delete.
 */
export function ArchivedPresetsSection({ rows, expanded, onToggle, confirmDeleteId, onRestore, onRequestDelete, onCancelDelete, onConfirmDelete, t }: {
    rows: readonly ArchivedPresetRow[]
    expanded: boolean
    onToggle: () => void
    confirmDeleteId: string | null
    onRestore: (presetId: string) => void
    onRequestDelete: (presetId: string) => void
    onCancelDelete: () => void
    onConfirmDelete: (presetId: string) => void
    t: TFunction
}) {
    if (rows.length === 0) return null
    const title = t('scene.folderManager.archiveTitle', '보관함 ({{count}})', { count: rows.length })
    return (
        <section className="shrink-0 border-t border-border" aria-label={title}>
            <button
                type="button"
                className="flex min-h-11 w-full items-center gap-2 px-4 py-2 text-left text-sm font-semibold hover:bg-accent"
                aria-expanded={expanded}
                onClick={onToggle}
            >
                {expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                <Archive className="h-4 w-4 shrink-0 text-muted-foreground" />
                {title}
            </button>
            {expanded && (
                <div ref={revealOnMount} className="custom-scrollbar max-h-72 space-y-1 overflow-y-auto px-2 pb-2">
                    {rows.map(({ preset, path, folders, scenes }) => (
                        <div key={preset.id} className="rounded-control border border-border px-3 py-2">
                            <div className="flex min-h-11 items-center gap-2">
                                <span className="min-w-0 flex-1" title={path}>
                                    <span className="block truncate text-sm font-medium">{preset.name}</span>
                                    <span className="block truncate text-xs text-muted-foreground">
                                        {t('scene.folderManager.archivedRowSummary', '폴더 {{folders}}개 · 씬 {{scenes}}개', { folders, scenes })}
                                    </span>
                                </span>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-11 shrink-0"
                                    aria-label={t('scene.folderManager.restoreNamed', '{{name}} 복원', { name: preset.name })}
                                    onClick={() => onRestore(preset.id)}
                                >
                                    <ArchiveRestore className="mr-1 h-4 w-4" />
                                    {t('scene.folderManager.restore', '복원')}
                                </Button>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-11 shrink-0 text-destructive hover:text-destructive"
                                    aria-label={t('scene.folderManager.deleteNamed', '{{name}} 삭제', { name: preset.name })}
                                    onClick={() => onRequestDelete(preset.id)}
                                >
                                    <Trash2 className="mr-1 h-4 w-4" />
                                    {t('scene.folderManager.delete', '삭제')}
                                </Button>
                            </div>
                            {confirmDeleteId === preset.id && (
                                <div ref={revealOnMount} className="mt-2 rounded-panel border border-destructive/50 bg-destructive/10 p-3" role="alert">
                                    <p className="text-sm font-semibold text-destructive">
                                        {t('scene.folderManager.deleteImpactTitle', '폴더 {{folders}}개와 씬 {{scenes}}개를 삭제할까요?', { folders, scenes })}
                                    </p>
                                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                                        {t('trash.folderMoveDescription', '하위 폴더와 씬을 포함해 휴지통으로 이동하며, 최대 30일 보관됩니다.')}
                                    </p>
                                    <div className="mt-2 flex justify-end gap-2">
                                        <Button type="button" variant="ghost" onClick={onCancelDelete}>{t('common.cancel', '취소')}</Button>
                                        <Button type="button" variant="destructive" onClick={() => onConfirmDelete(preset.id)}>{t('trash.move', '휴지통으로 이동')}</Button>
                                    </div>
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </section>
    )
}

function WorkflowStep({
    number,
    title,
    description,
    complete,
    active,
}: {
    number: number
    title: string
    description: string
    complete: boolean
    active: boolean
}) {
    return (
        <div
            className={cn(
                'flex min-w-0 items-start gap-3 rounded-panel border px-3 py-3 transition-colors',
                complete
                    ? 'border-success/40 bg-success/10'
                    : active
                        ? 'border-primary/50 bg-primary/10'
                        : 'border-border bg-canvas/60',
            )}
            aria-current={active ? 'step' : undefined}
        >
            <span
                className={cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                    complete ? 'bg-success text-background' : active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                )}
            >
                {complete ? <CheckCircle2 className="h-4 w-4" /> : number}
            </span>
            <span className="min-w-0">
                <strong className="block text-sm font-semibold leading-tight">{title}</strong>
                <span className="mt-1 block text-xs leading-snug text-muted-foreground">{description}</span>
            </span>
        </div>
    )
}

export function SceneFolderManagerDialog({ open, onOpenChange }: SceneFolderManagerDialogProps) {
    const { t } = useTranslation()
    const presets = useSceneStore(state => state.presets)
    const addPreset = useSceneStore(state => state.addPreset)
    const deletePreset = useSceneStore(state => state.deletePreset)
    const archivePresets = useSceneStore(state => state.archivePresets)
    const restoreArchivedPresets = useSceneStore(state => state.restoreArchivedPresets)
    const renamePreset = useSceneStore(state => state.renamePreset)
    const movePresets = useSceneStore(state => state.movePresets)
    const duplicatePresets = useSceneStore(state => state.duplicatePresets)
    const setPresetDefaultFromScene = useSceneStore(state => state.setPresetDefaultFromScene)
    const clearPresetDefault = useSceneStore(state => state.clearPresetDefault)
    const addToTrash = useTrashStore(state => state.add)
    const sceneSavePath = useSettingsStore(state => state.sceneSavePath)
    const useAbsoluteScenePath = useSettingsStore(state => state.useAbsoluteScenePath)
    // The working tree leaves archived presets out; deletion impact and trash snapshots still read every preset.
    const workingPresets = visibleScenePresets(presets)
    const rows = useMemo(() => buildFolderRows(workingPresets), [workingPresets])
    const archivedRows = useMemo(() => archivedPresetRows(presets), [presets])
    const [archiveExpanded, setArchiveExpanded] = useState(false)
    const [confirmArchivedDelete, setConfirmArchivedDelete] = useState<string | null>(null)
    // Snapshotting a branch into the trash is asynchronous; a second click must not snapshot it again.
    const trashMoveRunning = useRef(false)
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const [newFolderName, setNewFolderName] = useState('')
    const [renameValue, setRenameValue] = useState('')
    const [moveTarget, setMoveTarget] = useState('__root__')
    const [sourceScene, setSourceScene] = useState('')
    const [folderQuery, setFolderQuery] = useState('')
    const [sourceQuery, setSourceQuery] = useState('')
    const [folderFilter, setFolderFilter] = useState<FolderFilter>('all')
    const [folderSort, setFolderSort] = useState<FolderSort>('tree')
    const [confirmDelete, setConfirmDelete] = useState(false)
    const deferredFolderQuery = useDeferredValue(folderQuery.trim().toLocaleLowerCase())
    const deferredSourceQuery = useDeferredValue(sourceQuery.trim().toLocaleLowerCase())

    useEffect(() => {
        if (!open) return
        setSelected(new Set())
        setNewFolderName('')
        setRenameValue('')
        setMoveTarget('__root__')
        setSourceScene('')
        setFolderQuery('')
        setSourceQuery('')
        setFolderFilter('all')
        setFolderSort('tree')
        setConfirmDelete(false)
        setArchiveExpanded(false)
        setConfirmArchivedDelete(null)
    }, [open])

    // A folder archived or removed while this dialog is open (an agent can do that) leaves the tree, so it leaves the selection too.
    const workingIds = useMemo(() => new Set(workingPresets.map(preset => preset.id)), [workingPresets])
    const selectedIds = [...selected].filter(id => workingIds.has(id))
    const selectedKey = [...selectedIds].sort().join('\u001f')
    const selectedPreset = selectedIds.length === 1
        ? presets.find(preset => preset.id === selectedIds[0])
        : undefined
    const selectedTemplateCount = selectedIds.filter(id => presets.find(preset => preset.id === id)?.defaultTemplate).length
    const deletableSelectedIds = selectedIds.filter(id => id !== DEFAULT_SCENE_PRESET_ID)
    const deletionImpact = useMemo(
        () => getDeletionImpact(presets, deletableSelectedIds),
        [deletableSelectedIds, presets],
    )
    const sourceScenes = useMemo<SourceSceneRow[]>(() => workingPresets.flatMap(preset => {
        const folderPath = scenePresetDisplayPath(presets, preset.id, t)
        return preset.scenes.map(scene => ({
            key: `${preset.id}\u001f${scene.id}`,
            preset,
            scene,
            path: `${folderPath} / ${scene.name}`,
        }))
    }), [presets, workingPresets, t])

    useEffect(() => {
        setRenameValue(selectedPreset?.name ?? '')
    }, [selectedPreset?.id, selectedPreset?.name])

    useEffect(() => {
        setConfirmDelete(false)
    }, [selectedKey])

    /** Search, filter, sort, and render-cap are linked so thousands of folders never
     * become thousands of mounted rows. Search remains the primary navigation path,
     * while sort/filter provide predictable recovery when users do not know a name. */
    const filteredRows = useMemo(() => {
        const matched = rows.filter(row => {
            const searchable = `${row.preset.name} ${row.path}`.toLocaleLowerCase()
            if (deferredFolderQuery && !searchable.includes(deferredFolderQuery)) return false
            if (folderFilter === 'template' && !row.preset.defaultTemplate) return false
            if (folderFilter === 'empty' && row.preset.scenes.length > 0) return false
            return true
        })
        if (folderSort === 'name') return [...matched].sort((a, b) => a.path.localeCompare(b.path))
        if (folderSort === 'recent') return [...matched].sort((a, b) => b.preset.createdAt - a.preset.createdAt)
        if (folderSort === 'sceneCount') return [...matched].sort((a, b) => b.preset.scenes.length - a.preset.scenes.length)
        return matched
    }, [deferredFolderQuery, folderFilter, folderSort, rows])
    const visibleRows = filteredRows.slice(0, MAX_VISIBLE_FOLDERS)

    const filteredSourceScenes = useMemo(() => {
        const matched = sourceScenes.filter(row => !deferredSourceQuery || row.path.toLocaleLowerCase().includes(deferredSourceQuery))
        const visible = matched.slice(0, MAX_VISIBLE_SOURCE_SCENES)
        const selectedSource = sourceScenes.find(row => row.key === sourceScene)
        if (selectedSource && !visible.some(row => row.key === selectedSource.key)) visible.unshift(selectedSource)
        return { matched, visible }
    }, [deferredSourceQuery, sourceScene, sourceScenes])

    const rootLabel = useAbsoluteScenePath
        ? (sceneSavePath || t('scene.folderManager.defaultRoot', '최초 저장 폴더'))
        : `Pictures/${sceneSavePath || 'NAI_Blue_Scene'}`

    const toggleFolder = (id: string) => {
        setSelected(current => {
            const next = new Set(current)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    const handleAdd = () => {
        const name = newFolderName.trim()
        if (!name) return
        const parentId = selectedIds.length === 1 ? selectedIds[0] : null
        const createdId = addPreset(name, parentId)
        setSelected(new Set([createdId]))
        setNewFolderName('')
        toast({
            title: t('scene.folderManager.folderCreated', '폴더를 만들었습니다'),
            description: parentId
                ? t('scene.folderManager.createdUnderSelected', '선택한 폴더 아래에 추가했습니다.')
                : t('scene.folderManager.createdUnderRoot', '최상위 경로에 추가했습니다.'),
            variant: 'success',
        })
    }

    const handleRename = () => {
        const name = renameValue.trim()
        if (!selectedPreset || !name || name === selectedPreset.name) return
        renamePreset(selectedPreset.id, name)
        toast({ title: t('scene.folderManager.renamed', '폴더 이름을 변경했습니다'), variant: 'success' })
    }

    const handleMove = () => {
        if (selectedIds.length === 0) return
        movePresets(selectedIds, moveTarget === '__root__' ? null : moveTarget)
        toast({
            title: t('scene.folderManager.movedCount', '{{count}}개 폴더를 이동했습니다', { count: selectedIds.length }),
            variant: 'success',
        })
    }

    const handleDuplicate = () => {
        if (selectedIds.length === 0) return
        duplicatePresets(selectedIds)
        toast({
            title: t('scene.folderManager.duplicatedCount', '{{count}}개 폴더를 복제했습니다', { count: selectedIds.length }),
            variant: 'success',
        })
    }

    /**
     * Depends on SceneStore's existing descendant cascade and snapshots the
     * exact same branch into the trash first. This preserves hierarchy and image previews in
     * the shared trash instead of leaving the folder manager as a bypass path.
     */
    const moveBranchesToTrash = async (ids: readonly string[]) => {
        // Selected descendants are already included when their parent is
        // processed, so only snapshot roots to prevent duplicates.
        const selectedSet = new Set(ids)
        const roots = ids.filter(id => {
            const visited = new Set([id])
            let current = presets.find(preset => preset.id === id)
            while (current?.parentId && !visited.has(current.parentId)) {
                if (selectedSet.has(current.parentId)) return false
                visited.add(current.parentId)
                current = presets.find(preset => preset.id === current?.parentId)
            }
            return true
        })
        for (const rootId of roots) {
            const trashItem = await archiveSceneFolder(rootId, presets)
            if (trashItem) addToTrash(trashItem)
        }
        roots.forEach(deletePreset)
    }

    const handleDelete = async () => {
        if (deletableSelectedIds.length === 0 || trashMoveRunning.current) return
        trashMoveRunning.current = true
        try {
            await moveBranchesToTrash(deletableSelectedIds)
            setSelected(new Set())
            setConfirmDelete(false)
            toast({
                title: t('trash.moved', '휴지통으로 이동했습니다.'),
                description: t('scene.folderManager.deletedSceneCount', '포함된 씬 {{count}}개도 함께 이동했습니다.', { count: deletionImpact.scenes }),
                variant: 'success',
            })
        } catch (error) {
            console.error('Failed to move folder selection to trash:', error)
            toast({ title: t('common.error', '오류'), variant: 'destructive' })
        } finally {
            trashMoveRunning.current = false
        }
    }

    const handleArchive = () => {
        if (deletableSelectedIds.length === 0) return
        archivePresets(deletableSelectedIds)
        setSelected(new Set())
        toast({
            title: t('scene.folderManager.archivedCount', '{{count}}개 폴더를 보관함으로 옮겼습니다', { count: deletableSelectedIds.length }),
            description: t('scene.folderManager.archivedDescription', '씬과 결과 이미지는 그대로입니다. 아래 보관함에서 복원하거나 삭제할 수 있습니다.'),
            variant: 'success',
        })
    }

    const handleRestoreArchived = (presetId: string) => {
        const name = presets.find(preset => preset.id === presetId)?.name ?? ''
        restoreArchivedPresets([presetId])
        if (confirmArchivedDelete === presetId) setConfirmArchivedDelete(null)
        toast({ title: t('scene.folderManager.restoredNamed', '{{name}} 폴더를 복원했습니다', { name }), variant: 'success' })
    }

    const handleDeleteArchived = async (presetId: string) => {
        if (trashMoveRunning.current) return
        trashMoveRunning.current = true
        const impact = getDeletionImpact(presets, [presetId])
        try {
            await moveBranchesToTrash([presetId])
            setConfirmArchivedDelete(null)
            toast({
                title: t('trash.moved', '휴지통으로 이동했습니다.'),
                description: t('scene.folderManager.deletedSceneCount', '포함된 씬 {{count}}개도 함께 이동했습니다.', { count: impact.scenes }),
                variant: 'success',
            })
        } catch (error) {
            console.error('Failed to move archived folder to trash:', error)
            toast({ title: t('common.error', '오류'), variant: 'destructive' })
        } finally {
            trashMoveRunning.current = false
        }
    }

    const handleApplyTemplate = () => {
        if (!sourceScene || selectedIds.length === 0) return
        const [sourcePresetId, sceneId] = sourceScene.split('\u001f')
        setPresetDefaultFromScene(selectedIds, sourcePresetId, sceneId)
        const sourceName = sourceScenes.find(row => row.key === sourceScene)?.scene.name ?? ''
        toast({
            title: t('scene.folderManager.templateAppliedCount', '{{count}}개 폴더에 새 씬 기본값을 적용했습니다', { count: selectedIds.length }),
            description: sourceName,
            variant: 'success',
        })
    }

    const handleClearTemplate = () => {
        if (selectedIds.length === 0) return
        clearPresetDefault(selectedIds)
        toast({ title: t('scene.folderManager.templateCleared', '새 씬 기본값을 해제했습니다') })
    }

    const selectAllVisible = () => {
        setSelected(current => new Set([...current, ...visibleRows.map(row => row.preset.id)]))
    }

    const workflowHasSelection = selectedIds.length > 0
    const workflowHasSource = Boolean(sourceScene)
    const workflowHasTemplate = selectedTemplateCount > 0

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex max-h-[94dvh] max-w-6xl flex-col gap-0 overflow-hidden rounded-panel p-0">
                <DialogHeader className="border-b border-border px-5 py-4 pr-16">
                    <DialogTitle className="flex items-center gap-2 text-xl">
                        <FolderTree className="h-6 w-6 text-primary" />
                        {t('scene.folderManager.title', '씬 폴더 관리')}
                    </DialogTitle>
                    <p className="break-all text-sm leading-relaxed text-muted-foreground" title={rootLabel}>
                        {t('scene.folderManager.root', '최상위 경로')}: {rootLabel}
                    </p>
                </DialogHeader>

                <section className="border-b border-border bg-muted/20 px-4 py-3" aria-label={t('scene.folderManager.workflowTitle', '이 화면 사용 순서')}>
                    <div className="mb-2 flex items-center justify-between gap-3">
                        <h2 className="text-sm font-semibold">{t('scene.folderManager.workflowTitle', '이 화면은 이렇게 사용하세요')}</h2>
                        <span className="hidden text-xs text-muted-foreground lg:inline">
                            {t('scene.folderManager.autoSaveHint', '변경사항은 즉시 저장됩니다')}
                        </span>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                        <WorkflowStep
                            number={1}
                            title={t('scene.folderManager.step1Title', '폴더 찾고 선택')}
                            description={t('scene.folderManager.step1Description', '검색하거나 목록에서 체크하세요')}
                            complete={workflowHasSelection}
                            active={!workflowHasSelection}
                        />
                        <WorkflowStep
                            number={2}
                            title={t('scene.folderManager.step2Title', '폴더 정리')}
                            description={t('scene.folderManager.step2Description', '이름·위치·복제를 정리하세요')}
                            complete={workflowHasSelection}
                            active={workflowHasSelection && !workflowHasSource && !workflowHasTemplate}
                        />
                        <WorkflowStep
                            number={3}
                            title={t('scene.folderManager.step3Title', '새 씬 기본값 지정')}
                            description={t('scene.folderManager.step3Description', '기준 씬을 골라 적용하세요')}
                            complete={workflowHasTemplate}
                            active={workflowHasSelection && !workflowHasTemplate}
                        />
                        <WorkflowStep
                            number={4}
                            title={t('scene.folderManager.step4Title', '씬 추가')}
                            description={t('scene.folderManager.step4Description', '닫은 뒤 해당 폴더에서 + 씬 추가')}
                            complete={false}
                            active={workflowHasTemplate}
                        />
                    </div>
                </section>

                <div className="grid min-h-0 flex-1 overflow-y-auto md:grid-cols-[minmax(22rem,0.9fr)_minmax(28rem,1.1fr)] md:overflow-hidden">
                    {/* The column scrolls as a whole when the window is too short for the list and the opened archive together. */}
                    <div className="custom-scrollbar flex min-h-[28rem] flex-col border-b border-border md:min-h-0 md:overflow-y-auto md:border-b-0 md:border-r">
                        <div className="space-y-3 border-b border-border p-4">
                            <div className="relative">
                                <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
                                <Input
                                    value={folderQuery}
                                    onChange={event => setFolderQuery(event.target.value)}
                                    placeholder={t('scene.folderManager.searchFolders', '폴더 이름 또는 경로 검색')}
                                    aria-label={t('scene.folderManager.searchFolders', '폴더 이름 또는 경로 검색')}
                                    className="h-12 pl-10 pr-10"
                                />
                                {folderQuery && (
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="absolute right-0 top-1/2 h-10 w-10 -translate-y-1/2"
                                        onClick={() => setFolderQuery('')}
                                        aria-label={t('common.clear', '지우기')}
                                    >
                                        <X className="h-4 w-4" />
                                    </Button>
                                )}
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                <Select value={folderFilter} onValueChange={value => setFolderFilter(value as FolderFilter)}>
                                    <SelectTrigger className="h-11" aria-label={t('scene.folderManager.filter', '폴더 필터')}>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="all">{t('scene.folderManager.filterAll', '모든 폴더')}</SelectItem>
                                        <SelectItem value="template">{t('scene.folderManager.filterTemplate', '기본값 있는 폴더')}</SelectItem>
                                        <SelectItem value="empty">{t('scene.folderManager.filterEmpty', '빈 폴더')}</SelectItem>
                                    </SelectContent>
                                </Select>
                                <Select value={folderSort} onValueChange={value => setFolderSort(value as FolderSort)}>
                                    <SelectTrigger className="h-11" aria-label={t('scene.folderManager.sort', '폴더 정렬')}>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="tree">{t('scene.folderManager.sortTree', '경로 순서')}</SelectItem>
                                        <SelectItem value="name">{t('scene.folderManager.sortName', '이름 순서')}</SelectItem>
                                        <SelectItem value="recent">{t('scene.folderManager.sortRecent', '최근 생성 순서')}</SelectItem>
                                        <SelectItem value="sceneCount">{t('scene.folderManager.sortSceneCount', '씬 많은 순서')}</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="flex items-center gap-2">
                                <Input
                                    value={newFolderName}
                                    onChange={event => setNewFolderName(event.target.value)}
                                    onKeyDown={event => event.key === 'Enter' && handleAdd()}
                                    placeholder={t('scene.folderManager.newFolder', '새 폴더 이름')}
                                    aria-label={t('scene.folderManager.newFolder', '새 폴더 이름')}
                                    className="h-11"
                                />
                                <Button className="h-11 shrink-0" onClick={handleAdd} disabled={!newFolderName.trim()}>
                                    <FilePlus2 className="mr-2 h-4 w-4" />
                                    {selectedIds.length === 1
                                        ? t('scene.folderManager.addChild', '하위 폴더 만들기')
                                        : t('scene.folderManager.addRoot', '최상위에 만들기')}
                                </Button>
                            </div>
                            <p className="text-xs leading-relaxed text-muted-foreground">
                                {selectedIds.length === 1
                                    ? t('scene.folderManager.addChildHint', '현재 선택한 폴더 아래에 만들어집니다.')
                                    : t('scene.folderManager.addRootHint', '폴더 하나를 선택하면 그 아래에 하위 폴더를 만들 수 있습니다.')}
                            </p>
                        </div>

                        <div className="flex min-h-11 items-center justify-between gap-2 border-b border-border px-4 py-2">
                            <span className="text-sm font-semibold">
                                {t('scene.folderManager.resultCount', '{{visible}} / {{total}}개 폴더', {
                                    visible: visibleRows.length,
                                    total: filteredRows.length,
                                })}
                            </span>
                            <div className="flex items-center gap-1">
                                <Button type="button" variant="ghost" size="sm" onClick={selectAllVisible} disabled={visibleRows.length === 0}>
                                    {t('scene.folderManager.selectVisible', '보이는 폴더 선택')}
                                </Button>
                                <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(new Set())} disabled={selectedIds.length === 0}>
                                    {t('common.clearSelection', '선택 해제')}
                                </Button>
                            </div>
                        </div>

                        <ScrollArea className="min-h-40 flex-1 p-2">
                            <div className="space-y-1" role="listbox" aria-multiselectable="true" aria-label={t('scene.folderManager.folderList', '검색 가능한 씬 폴더 목록')}>
                                {visibleRows.map(({ preset, path }) => {
                                    const checked = selected.has(preset.id)
                                    return (
                                        <div
                                            key={preset.id}
                                            role="option"
                                            tabIndex={0}
                                            aria-selected={checked}
                                            className={cn(
                                                'flex min-h-14 w-full items-center gap-3 rounded-control border px-3 py-2 text-left transition-colors',
                                                checked
                                                    ? 'border-primary/60 bg-primary/12 text-foreground'
                                                    : 'border-transparent hover:border-border hover:bg-accent',
                                            )}
                                            onClick={() => toggleFolder(preset.id)}
                                            onKeyDown={event => {
                                                if (event.key === 'Enter' || event.key === ' ') {
                                                    event.preventDefault()
                                                    toggleFolder(preset.id)
                                                }
                                            }}
                                            title={path}
                                        >
                                            <Checkbox
                                                checked={checked}
                                                aria-label={t('scene.folderManager.selectFolderNamed', '{{name}} 폴더 선택', { name: preset.name })}
                                                onClick={event => event.stopPropagation()}
                                                onCheckedChange={() => toggleFolder(preset.id)}
                                            />
                                            <Folder className="h-5 w-5 shrink-0 text-primary" />
                                            <span className="min-w-0 flex-1">
                                                <span className="block truncate text-sm font-semibold">{preset.name}</span>
                                                <span className="block truncate text-xs leading-snug text-muted-foreground">{path}</span>
                                            </span>
                                            <span className="shrink-0 rounded-control bg-muted px-2 py-1 text-xs text-muted-foreground">
                                                {t('scene.folderManager.sceneCountShort', '{{count}}씬', { count: preset.scenes.length })}
                                            </span>
                                            {preset.defaultTemplate && (
                                                <span className="shrink-0 rounded-control bg-success/15 px-2 py-1 text-xs font-medium text-success">
                                                    {t('scene.folderManager.defaultBadge', '기본값')}
                                                </span>
                                            )}
                                        </div>
                                    )
                                })}
                                {visibleRows.length === 0 && (
                                    <div className="flex min-h-44 flex-col items-center justify-center gap-2 px-4 text-center text-muted-foreground">
                                        <Search className="h-8 w-8" />
                                        <p className="text-sm font-medium">{t('scene.folderManager.noFolderResults', '조건에 맞는 폴더가 없습니다')}</p>
                                        <p className="text-xs">{t('scene.folderManager.noFolderResultsHint', '검색어나 필터를 바꿔보세요.')}</p>
                                    </div>
                                )}
                            </div>
                            {filteredRows.length > MAX_VISIBLE_FOLDERS && (
                                <div className="m-2 flex items-start gap-2 rounded-control bg-info/10 p-3 text-xs leading-relaxed text-info">
                                    <Info className="mt-0.5 h-4 w-4 shrink-0" />
                                    {t('scene.folderManager.renderLimitHint', '속도를 위해 처음 {{count}}개만 표시합니다. 검색으로 범위를 좁혀주세요.', { count: MAX_VISIBLE_FOLDERS })}
                                </div>
                            )}
                        </ScrollArea>
                        <ArchivedPresetsSection
                            rows={archivedRows}
                            expanded={archiveExpanded}
                            onToggle={() => setArchiveExpanded(current => !current)}
                            confirmDeleteId={confirmArchivedDelete}
                            onRestore={handleRestoreArchived}
                            onRequestDelete={setConfirmArchivedDelete}
                            onCancelDelete={() => setConfirmArchivedDelete(null)}
                            onConfirmDelete={presetId => void handleDeleteArchived(presetId)}
                            t={t}
                        />
                    </div>

                    <div className="custom-scrollbar min-h-0 overflow-y-auto p-4">
                        {selectedIds.length === 0 ? (
                            <div className="flex min-h-full flex-col items-center justify-center rounded-panel border border-dashed border-border bg-canvas/40 px-6 py-12 text-center">
                                <FolderTree className="h-12 w-12 text-primary" />
                                <h2 className="mt-4 text-lg font-semibold">{t('scene.folderManager.selectFolderTitle', '먼저 왼쪽에서 폴더를 선택하세요')}</h2>
                                <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
                                    {t('scene.folderManager.selectFolderDescription', '검색창에서 폴더를 찾고 체크하면 이름 변경·이동·복제·기본값 설정이 여기에 나타납니다.')}
                                </p>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                <div className="rounded-panel border border-primary/30 bg-primary/8 p-4">
                                    <div className="flex flex-wrap items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <p className="text-xs font-semibold uppercase tracking-wide text-primary">
                                                {t('scene.folderManager.selectedTarget', '현재 작업 대상')}
                                            </p>
                                            <h2 className="mt-1 truncate text-lg font-semibold">
                                                {selectedPreset?.name ?? t('scene.folderManager.selectedCount', '{{count}}개 폴더 선택됨', { count: selectedIds.length })}
                                            </h2>
                                            {selectedPreset && (
                                                <p className="mt-1 break-all text-xs leading-relaxed text-muted-foreground">
                                                    {scenePresetDisplayPath(presets, selectedPreset.id, t)}
                                                </p>
                                            )}
                                        </div>
                                        <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                                            {t('common.clearSelection', '선택 해제')}
                                        </Button>
                                    </div>
                                </div>

                                <section className="space-y-3 rounded-panel border border-border p-4">
                                    <div>
                                        <h3 className="text-base font-semibold">{t('scene.folderManager.folderActions', '2. 폴더 정리')}</h3>
                                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                                            {t('scene.folderManager.folderActionsDescription', '선택한 폴더의 이름과 위치를 정리하거나 그대로 복제합니다.')}
                                        </p>
                                    </div>
                                    <div className="flex flex-col gap-2 sm:flex-row">
                                        <Input
                                            value={renameValue}
                                            onChange={event => setRenameValue(event.target.value)}
                                            onKeyDown={event => event.key === 'Enter' && handleRename()}
                                            placeholder={selectedPreset?.name || t('scene.folderManager.renameSingleOnly', '이름 변경은 폴더 하나를 선택하세요')}
                                            aria-label={t('scene.folderManager.renameFolder', '선택한 폴더 이름 변경')}
                                            disabled={!selectedPreset}
                                            className="h-11"
                                        />
                                        <Button
                                            variant="outline"
                                            className="h-11 shrink-0"
                                            onClick={handleRename}
                                            disabled={!selectedPreset || !renameValue.trim() || renameValue.trim() === selectedPreset.name}
                                        >
                                            <Pencil className="mr-2 h-4 w-4" />
                                            {t('scene.rename', '이름 변경')}
                                        </Button>
                                    </div>
                                    <div className="flex flex-col gap-2 sm:flex-row">
                                        <Select value={moveTarget} onValueChange={setMoveTarget}>
                                            <SelectTrigger className="h-11 min-w-0 flex-1" aria-label={t('scene.folderManager.moveTarget', '이동할 폴더 위치')}>
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent className="max-h-80">
                                                <SelectItem value="__root__">{t('scene.folderManager.moveToRoot', '최상위 경로로 이동')}</SelectItem>
                                                {rows.filter(row => !selected.has(row.preset.id)).map(({ preset, path }) => (
                                                    <SelectItem key={preset.id} value={preset.id}>{path}</SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                        <Button variant="outline" className="h-11 shrink-0" onClick={handleMove}>
                                            <Move className="mr-2 h-4 w-4" />
                                            {t('scene.folderManager.moveSelected', '선택 폴더 이동')}
                                        </Button>
                                    </div>
                                    <div className="grid gap-2 sm:grid-cols-3">
                                        <Button variant="outline" className="h-11" onClick={handleDuplicate}>
                                            <Copy className="mr-2 h-4 w-4" />
                                            {t('scene.folderManager.duplicateSelected', '선택 폴더 복제')}
                                        </Button>
                                        <Button
                                            variant="outline"
                                            className="h-11"
                                            onClick={handleArchive}
                                            disabled={deletableSelectedIds.length === 0}
                                        >
                                            <Archive className="mr-2 h-4 w-4" />
                                            {t('scene.folderManager.archiveSelected', '선택 폴더 보관')}
                                        </Button>
                                        <Button
                                            variant="outline"
                                            className="h-11 text-destructive hover:text-destructive"
                                            onClick={() => setConfirmDelete(true)}
                                            disabled={deletableSelectedIds.length === 0}
                                        >
                                            <Trash2 className="mr-2 h-4 w-4" />
                                            {t('scene.folderManager.deleteSelected', '선택 폴더 삭제')}
                                        </Button>
                                    </div>
                                    {confirmDelete && (
                                        <div className="rounded-panel border border-destructive/50 bg-destructive/10 p-4" role="alert">
                                            <p className="font-semibold text-destructive">
                                                {t('scene.folderManager.deleteImpactTitle', '폴더 {{folders}}개와 씬 {{scenes}}개를 삭제할까요?', deletionImpact)}
                                            </p>
                                            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                                                {t('trash.folderMoveDescription', '하위 폴더와 씬을 포함해 휴지통으로 이동하며, 최대 30일 보관됩니다.')}
                                            </p>
                                            <div className="mt-3 flex justify-end gap-2">
                                                <Button variant="ghost" onClick={() => setConfirmDelete(false)}>{t('common.cancel', '취소')}</Button>
                                                <Button variant="destructive" onClick={() => void handleDelete()}>{t('trash.move', '휴지통으로 이동')}</Button>
                                            </div>
                                        </div>
                                    )}
                                </section>

                                <section className="space-y-3 rounded-panel border border-border p-4">
                                    <div className="flex items-start gap-3">
                                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-primary/12 text-primary">
                                            <Sparkles className="h-5 w-5" />
                                        </span>
                                        <div>
                                            <h3 className="text-base font-semibold">{t('scene.folderManager.templateTitle', '3. 새 씬 기본값 만들기')}</h3>
                                            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                                                {t('scene.folderManager.templateDescription', '기준 씬 하나를 고르면 프롬프트·캐릭터·파라미터·해상도가 선택 폴더의 새 씬에 자동으로 들어갑니다.')}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="relative">
                                        <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
                                        <Input
                                            value={sourceQuery}
                                            onChange={event => setSourceQuery(event.target.value)}
                                            placeholder={t('scene.folderManager.searchScenes', '기준으로 삼을 씬 이름 또는 폴더 검색')}
                                            aria-label={t('scene.folderManager.searchScenes', '기준으로 삼을 씬 이름 또는 폴더 검색')}
                                            className="h-11 pl-10"
                                        />
                                    </div>
                                    <Select value={sourceScene} onValueChange={setSourceScene}>
                                        <SelectTrigger className="h-12" aria-label={t('scene.folderManager.selectScene', '기본값으로 사용할 씬 선택')}>
                                            <SelectValue placeholder={t('scene.folderManager.selectScene', '기본값으로 사용할 씬 선택')} />
                                        </SelectTrigger>
                                        <SelectContent className="max-h-80">
                                            {filteredSourceScenes.visible.map(({ key, path }) => (
                                                <SelectItem key={key} value={key}>{path}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                    <p className="text-xs leading-relaxed text-muted-foreground">
                                        {filteredSourceScenes.matched.length === 0
                                            ? t('scene.folderManager.noSceneResults', '조건에 맞는 씬이 없습니다.')
                                            : t('scene.folderManager.sourceResultCount', '{{visible}} / {{total}}개 씬 표시', {
                                                visible: Math.min(filteredSourceScenes.visible.length, MAX_VISIBLE_SOURCE_SCENES),
                                                total: filteredSourceScenes.matched.length,
                                            })}
                                    </p>
                                    <div className="grid gap-2 sm:grid-cols-2">
                                        <Button className="h-auto min-h-11 whitespace-normal px-3 py-2 leading-snug" onClick={handleApplyTemplate} disabled={!sourceScene}>
                                            {t('scene.folderManager.applyTemplateCount', '선택한 {{count}}개 폴더에 기본값 적용', { count: selectedIds.length })}
                                        </Button>
                                        <Button variant="outline" className="h-11" onClick={handleClearTemplate} disabled={selectedTemplateCount === 0}>
                                            {t('scene.folderManager.clearTemplate', '기본값 해제')}
                                        </Button>
                                    </div>
                                    {selectedPreset?.defaultTemplate && (
                                        <div className="flex items-start gap-2 rounded-control bg-success/10 px-3 py-3 text-sm text-success">
                                            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
                                            <span>
                                                <strong>{t('scene.folderManager.currentTemplate', '현재 기본값')}:</strong>{' '}
                                                {selectedPreset.defaultTemplate.sourceSceneName}
                                            </span>
                                        </div>
                                    )}
                                    {!selectedPreset && selectedTemplateCount > 0 && (
                                        <div className="flex items-start gap-2 rounded-control bg-success/10 px-3 py-3 text-sm text-success">
                                            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
                                            {t('scene.folderManager.templateFolderCount', '선택한 폴더 중 {{count}}개에 기본값이 있습니다.', { count: selectedTemplateCount })}
                                        </div>
                                    )}
                                </section>

                                <div className="flex items-start gap-3 rounded-panel border border-info/30 bg-info/10 p-4 text-info">
                                    <Info className="mt-0.5 h-5 w-5 shrink-0" />
                                    <div>
                                        <p className="text-sm font-semibold">{t('scene.folderManager.nextStepTitle', '다음 할 일')}</p>
                                        <p className="mt-1 text-xs leading-relaxed">
                                            {t('scene.folderManager.nextStepDescription', '완료를 누른 뒤 씬 화면에서 이 폴더를 선택하고 [+ 씬 추가]를 누르세요. 지정한 기본값이 채워진 편집 화면이 열립니다.')}
                                        </p>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                <DialogFooter className="flex-row items-center justify-between border-t border-border px-5 py-3 sm:space-x-0">
                    <p className="hidden text-xs text-muted-foreground sm:block">
                        {t('scene.folderManager.autoSaveHint', '변경사항은 즉시 저장됩니다')}
                    </p>
                    <DialogClose asChild>
                        <Button className="ml-auto min-w-36">
                            {t('scene.folderManager.done', '완료하고 씬 화면으로')}
                        </Button>
                    </DialogClose>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
