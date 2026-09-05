import { useState, useCallback, useEffect, useRef } from 'react'
import {
    DndContext,
    pointerWithin,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    DragOverlay,
    defaultDropAnimationSideEffects,
    DragStartEvent,
    DragEndEvent,
    MeasuringStrategy
} from '@dnd-kit/core'
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    rectSortingStrategy,
} from '@dnd-kit/sortable'
import { snapCenterToCursor } from '@dnd-kit/modifiers'
import { useLibraryStore, LibraryItem } from '@/stores/library-store'
import { SortableLibraryItem } from '@/components/library/SortableLibraryItem'
import { LibraryItem as LibraryItemComponent } from '@/components/library/LibraryItem'
import { useTranslation } from 'react-i18next'
import {
    authorizeNativeDirectory,
    createNativeDirectory,
    nativePathExists,
    readNativeBinaryFile,
} from '@/platform/native-file-system'
import { toast } from '@/components/ui/use-toast'
import { ImagePlus, X, Grid3x3, Edit3, Trash2, Layers, ArrowLeft, CheckSquare, FolderOpen, Upload, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings-store'
import {
    MEDIA_STORAGE_BASE_DIRECTORY,
    shouldUseAbsoluteMediaPath,
} from '@/platform/storage'
import {
    LibraryImageWorkflowDialog,
    type LibraryImageWorkflowOptions,
} from '@/components/library/LibraryImageWorkflowDialog'
import { runLibraryImageWorkflow } from '@/services/library/library-image-workflow'
import { renameLibraryFiles } from '@/services/library/library-file-renamer'
import { imageDataUrlFromBytes } from '@/lib/image-data-url'

const dropAnimation = {
    sideEffects: defaultDropAnimationSideEffects({
        styles: {
            active: {
                opacity: '0.5',
            },
        },
    }),
}

import { LibraryRenameDialog } from '@/components/library/LibraryRenameDialog'
import { ImageReferenceDialog } from '@/components/metadata/ImageReferenceDialog'
import { MetadataDialog } from '@/components/metadata/MetadataDialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useTrashStore } from '@/stores/trash-store'
import { archiveLibraryItems } from '@/services/trash/asset-trash-service'
import { runtimeCapabilities } from '@/platform/capabilities'

/**
 * Browser preview depends on FileReader and the IndexedDB-backed Library store.
 * A data URL keeps imported images usable after reload without invoking native fs.
 */
async function createBrowserLibraryItem(file: File, generationFolderId?: string): Promise<LibraryItem> {
    const path = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => typeof reader.result === 'string'
            ? resolve(reader.result)
            : reject(new Error('Image import did not produce a data URL.'))
        reader.onerror = () => reject(reader.error ?? new Error('Image import failed.'))
        reader.readAsDataURL(file)
    })
    const id = crypto.randomUUID()
    return {
        id,
        name: file.name.replace(/\.[^.]+$/, ''),
        path,
        width: 0,
        height: 0,
        createdAt: Date.now(),
        generationFolderId,
    }
}

interface PendingLibrarySource {
    readonly name: string
    readonly file?: File
    readonly item?: LibraryItem
}

function generationFolderLabel(folders: ReturnType<typeof useSettingsStore.getState>['generationFolders'], folderId: string | null | undefined): string | null {
    if (!folderId) return null
    const byId = new Map(folders.map(folder => [folder.id, folder]))
    const names: string[] = []
    const visited = new Set<string>()
    let current = byId.get(folderId)
    while (current && !visited.has(current.id)) {
        visited.add(current.id)
        names.unshift(current.name)
        current = current.parentId ? byId.get(current.parentId) : undefined
    }
    return names.join(' / ') || null
}

export default function Library({ onOpenTools }: { onOpenTools?: () => void } = {}) {
    const { t } = useTranslation()
    const { 
        items, 
        addItem, 
        setItems, 
        gridColumns, 
        setGridColumns,
        // Edit Mode
        isEditMode,
        setEditMode,
        selectedItemIds,
        toggleItemSelection,
        selectItemRange,
        selectItems,
        deleteSelectedItems,
        lastSelectedItemId,
        // Stack
        createStackFromSelected,
        currentStackId,
        setCurrentStackId,
        unstack
    } = useLibraryStore()
    const addToTrash = useTrashStore(state => state.add)
    const { libraryPath, useAbsoluteLibraryPath, generationFolders } = useSettingsStore()
    const [activeId, setActiveId] = useState<string | null>(null)
    const [isDraggingFile, setIsDraggingFile] = useState(false)
    const [folderFilter, setFolderFilter] = useState('')
    const [workflowSources, setWorkflowSources] = useState<PendingLibrarySource[]>([])
    const [workflowOpen, setWorkflowOpen] = useState(false)
    const [busyProgress, setBusyProgress] = useState<{ current: number; total: number } | null>(null)
    const fileInputRef = useRef<HTMLInputElement>(null)
    const workflowRunInFlight = useRef(false)

    // Get current view items (main library or inside a stack)
    const currentStack = currentStackId ? items.find(item => item.id === currentStackId) : null
    const unfilteredViewItems = currentStack?.stackItems || items.filter(() => !currentStackId)
    const viewItems = currentStackId || !folderFilter
        ? unfilteredViewItems
        : unfilteredViewItems.filter(item => item.generationFolderId === folderFilter
            || item.stackItems?.some(stackItem => stackItem.generationFolderId === folderFilter))

    // Dialog States
    const [renameDialogOpen, setRenameDialogOpen] = useState(false)
    const [renameTargets, setRenameTargets] = useState<LibraryItem[]>([])
    const [imageRefDialogOpen, setImageRefDialogOpen] = useState(false)
    const [selectedImageRef, setSelectedImageRef] = useState<string | null>(null)
    const [metadataDialogOpen, setMetadataDialogOpen] = useState(false)
    const [selectedImageForMetadata, setSelectedImageForMetadata] = useState<string | undefined>()
    const [confirmDeleteSelectedOpen, setConfirmDeleteSelectedOpen] = useState(false)

    // Fullscreen viewer state
    const [viewerImageSrc, setViewerImageSrc] = useState<string | null>(null)

    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {
                distance: 8,
            },
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    )

    // ESC key handler for closing viewer
    useEffect(() => {
        const handleEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && viewerImageSrc) {
                setViewerImageSrc(null)
            }
        }
        window.addEventListener('keydown', handleEsc)
        return () => window.removeEventListener('keydown', handleEsc)
    }, [viewerImageSrc])

    // Ensure Library Directory Exists & Sync Files
    useEffect(() => {
        // Browser preview persists data URLs and has no native directory to sync.
        if (!runtimeCapabilities.nativePluginRuntime.supported) return

        const initDir = async () => {
            try {
                // Migrate a Library path saved before persisted-scope was installed.
                // Generation destinations are restored lazily by the output adapter.
                if (shouldUseAbsoluteMediaPath(useAbsoluteLibraryPath) && libraryPath) {
                    await authorizeNativeDirectory(libraryPath)
                }

                // 1. Ensure Dir Exists
                if (shouldUseAbsoluteMediaPath(useAbsoluteLibraryPath) && libraryPath) {
                    // Absolute path
                    const existsDir = await nativePathExists(libraryPath)
                    if (!existsDir) {
                        await createNativeDirectory(libraryPath, { recursive: true })
                    }
                } else {
                    // Relative to Pictures folder
                    const relPath = libraryPath || 'NAI_Blue_Library'
                    const existsDir = await nativePathExists(relPath, { baseDir: MEDIA_STORAGE_BASE_DIRECTORY })
                    if (!existsDir) {
                        await createNativeDirectory(relPath, { baseDir: MEDIA_STORAGE_BASE_DIRECTORY })
                    }
                }

                // 2. Sync: Remove items that no longer exist on disk
                // We process this strictly to keep the library clean.
                // Note: 'items' comes from store, which is persisted.
                // We can't directly map 'items' inside this async function if it changes, 
                // but for init sync (on mount), using the initial state is fine.
                // However, 'items' in dependency array might cause loops if we simply set items.
                // We'll trust the store's current state on mount.

                const currentItems = useLibraryStore.getState().items
                const validItems: LibraryItem[] = []
                let removedCount = 0

                for (const item of currentItems) {
                    try {
                        const fileExists = await nativePathExists(item.path)
                        if (fileExists) {
                            validItems.push(item)
                        } else {
                            removedCount++
                        }
                    } catch (e) {
                        // If checking existence fails (e.g. permission), assume valid to be safe? 
                        // Or assume invalid? 'exists' usually returns false on error or file not found.
                        // But tauri v2 exists might throw.
                        // Let's assume if we can't verify it, we keep it, OR we remove it.
                        // Safest is to keep if uncertain, but if file is surely gone, remove.
                        // If error is "file not found", it's gone.
                        console.warn(`Failed to check file existence for ${item.name}:`, e)
                        // For now, keep it to avoid accidental deletion on IO errors.
                        validItems.push(item)
                    }
                }

                if (removedCount > 0) {
                    setItems(validItems)
                    console.log(`[Library] Synced: Removed ${removedCount} missing items.`)
                }

            } catch (e) {
                console.error('Failed to init/sync library:', e)
            }
        }
        initDir()
    }, [setItems, libraryPath, useAbsoluteLibraryPath])

    const handleDragStart = (event: DragStartEvent) => {
        setActiveId(event.active.id as string)
    }

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event

        if (over && active.id !== over.id) {
            const oldIndex = items.findIndex((item) => item.id === active.id)
            const newIndex = items.findIndex((item) => item.id === over.id)
            setItems(arrayMove(items, oldIndex, newIndex))
        }

        setActiveId(null)
    }

    const stageFiles = useCallback((files: readonly File[], preferredName?: string) => {
        const supported = files.filter(file => file.type === 'image/png'
            || file.type === 'image/webp'
            || file.type === 'image/jpeg'
            || /\.(png|webp|jpe?g)$/iu.test(file.name))
        if (supported.length === 0) {
            toast({ title: t('library.unsupportedFormat', 'PNG, WebP 또는 JPEG 이미지를 선택해 주세요.'), variant: 'destructive' })
            return
        }
        setWorkflowSources(supported.map((file, index) => ({
            file,
            name: preferredName && supported.length === 1 && index === 0 ? preferredName : file.name,
        })))
        setWorkflowOpen(true)
    }, [t])

    const onFileDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
        setIsDraggingFile(false)
        const files = Array.from(e.dataTransfer.files ?? [])
        if (files.length > 0) stageFiles(files, e.dataTransfer.getData('nai-blue/filename'))
    }, [stageFiles])

    const activeItem = activeId ? items.find(i => i.id === activeId) : null

    // Handlers
    const handleRenameClick = (item: LibraryItem) => {
        setRenameTargets([item])
        setRenameDialogOpen(true)
    }

    const openBatchRename = () => {
        const targets = viewItems.filter(item => selectedItemIds.includes(item.id) && !item.isStack)
        if (targets.length === 0) return
        setRenameTargets(targets)
        setRenameDialogOpen(true)
    }

    const handleRenameConfirm = async (template: string): Promise<boolean> => {
        if (renameTargets.length === 0) return false
        try {
            const results = await renameLibraryFiles(renameTargets, template)
            const resultById = new Map(results.map(result => [result.id, result]))
            const applyResult = (item: LibraryItem): LibraryItem => {
                const result = resultById.get(item.id)
                if (result) return {
                    ...item,
                    name: result.name,
                    path: result.path,
                    sidecarPath: result.sidecarPath,
                }
                return item.stackItems
                    ? { ...item, stackItems: item.stackItems.map(applyResult) }
                    : item
            }
            setItems(useLibraryStore.getState().items.map(applyResult))
            if (renameTargets.length > 1) setEditMode(false)
            toast({
                title: t('library.rename.completed', '{{count}}개 이름을 변경했습니다.', { count: results.length }),
                variant: 'success',
            })
            return true
        } catch (error) {
            console.error('Library rename failed:', error)
            toast({
                title: t('library.rename.failed', '파일 이름을 변경하지 못했습니다.'),
                description: error instanceof Error ? error.message : undefined,
                variant: 'destructive',
            })
            return false
        }
    }

    const handleAddRefClick = async (item: LibraryItem) => {
        try {
            if (item.path.startsWith('data:')) {
                setSelectedImageRef(item.path)
                setImageRefDialogOpen(true)
                return
            }
            const data = await readNativeBinaryFile(item.path)
            setSelectedImageRef(imageDataUrlFromBytes(data, item.path))
            setImageRefDialogOpen(true)
        } catch (e) {
            console.error('Failed to load for ref:', e)
            toast({ title: t('library.error', '오류 발생'), variant: 'destructive' })
        }
    }

    const handleLoadMetadata = async (item: LibraryItem) => {
        try {
            if (item.path.startsWith('data:')) {
                setSelectedImageForMetadata(item.path)
                setMetadataDialogOpen(true)
                return
            }
            const data = await readNativeBinaryFile(item.path)
            setSelectedImageForMetadata(imageDataUrlFromBytes(data, item.path))
            setMetadataDialogOpen(true)
        } catch (e) {
            console.error('Failed to load metadata:', e)
            toast({ title: t('library.error', '오류 발생'), variant: 'destructive' })
        }
    }

    const handleToggleGrid = () => {
        const next = gridColumns >= 5 ? 2 : gridColumns + 1
        setGridColumns(next)
    }

    /**
     * Depends on the current stack-aware view and the Library store's existing
     * selection removal. Archiving first preserves every selected file before
     * the UI mutation clears the selection and returns the user to normal mode.
     */
    const handleTrashSelectedItems = async () => {
        const selectedItems = viewItems.filter(item => selectedItemIds.includes(item.id))
        if (selectedItems.length === 0) return
        try {
            const trashItem = await archiveLibraryItems(selectedItems, currentStackId)
            addToTrash(trashItem)
            deleteSelectedItems()
            toast({ title: t('trash.moved', '휴지통으로 이동했습니다.'), variant: 'success' })
        } catch (error) {
            console.error('Failed to move library selection to trash:', error)
            toast({ title: t('common.error', '오류'), variant: 'destructive' })
        }
    }

    const handleImportClick = () => {
        fileInputRef.current?.click()
    }

    const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files?.length) stageFiles(Array.from(e.target.files))
        e.target.value = ''
    }

    const openWorkflowForItems = (selected: readonly LibraryItem[]) => {
        const editable = selected.filter(item => !item.isStack)
        if (editable.length === 0) return
        setWorkflowSources(editable.map(item => ({ item, name: item.name })))
        setWorkflowOpen(true)
    }

    const readWorkflowSource = async (source: PendingLibrarySource): Promise<Uint8Array> => {
        if (source.file) return new Uint8Array(await source.file.arrayBuffer())
        if (!source.item) throw new Error('이미지 원본을 찾지 못했습니다.')
        if (source.item.path.startsWith('data:')) {
            return new Uint8Array(await (await fetch(source.item.path)).arrayBuffer())
        }
        return readNativeBinaryFile(source.item.path)
    }

    const runImageWorkflow = async (options: LibraryImageWorkflowOptions) => {
        if (workflowSources.length === 0 || workflowRunInFlight.current) return
        workflowRunInFlight.current = true
        setBusyProgress({ current: 0, total: workflowSources.length })
        let completed = 0
        let r2Warnings = 0
        try {
            if (!runtimeCapabilities.nativePluginRuntime.supported) {
                for (const source of workflowSources) {
                    if (source.file) {
                        addItem(await createBrowserLibraryItem(source.file, options.folder.id))
                    } else if (source.item) {
                        addItem({
                            ...source.item,
                            id: crypto.randomUUID(),
                            name: `${source.item.name} copy`,
                            createdAt: Date.now(),
                            generationFolderId: options.folder.id,
                        })
                    }
                    completed += 1
                    setBusyProgress({ current: completed, total: workflowSources.length })
                }
            } else {
                for (const source of workflowSources) {
                    const result = await runLibraryImageWorkflow({
                        source: { name: source.name, bytes: await readWorkflowSource(source) },
                        destination: options.folder,
                        format: options.format,
                        stripMetadata: options.stripMetadata,
                        autoUpload: options.autoUpload,
                    })
                    const r2Status: LibraryItem['r2Status'] = !options.autoUpload
                        ? 'not-requested'
                        : result.r2?.status === 'uploaded'
                            ? 'uploaded'
                            : result.r2?.status === 'queued' ? 'queued' : 'pending-or-failed'
                    if (r2Status === 'pending-or-failed') r2Warnings += 1
                    addItem({
                        id: result.operationId,
                        name: result.output.fileName.replace(/\.[^.]+$/u, ''),
                        path: result.output.path,
                        width: result.width,
                        height: result.height,
                        createdAt: Date.now(),
                        generationFolderId: options.folder.id,
                        format: result.format,
                        sidecarPath: result.sidecarPath,
                        r2Status,
                        ...(result.r2?.status === 'queued' ? { r2JobIds: result.r2.jobIds } : {}),
                    })
                    completed += 1
                    setBusyProgress({ current: completed, total: workflowSources.length })
                }
            }
            setWorkflowOpen(false)
            setWorkflowSources([])
            setEditMode(false)
            toast({
                title: t('library.workflow.completed', '{{count}}개 새 파일을 만들었습니다.', { count: completed }),
                description: r2Warnings > 0
                    ? t('library.workflow.r2Warning', '로컬 저장은 완료됐지만 {{count}}개 R2 업로드를 확인해야 합니다.', { count: r2Warnings })
                    : undefined,
                variant: r2Warnings > 0 ? 'default' : 'success',
            })
        } catch (error) {
            console.error('Library image workflow failed:', error)
            if (completed > 0) setWorkflowSources(current => current.slice(completed))
            toast({
                title: t('library.workflow.failed', '이미지 처리를 완료하지 못했습니다.'),
                description: completed > 0
                    ? t('library.workflow.partialFailure', '{{count}}개는 완료했습니다. 남은 이미지부터 다시 시도할 수 있습니다.', { count: completed })
                    : error instanceof Error ? error.message : undefined,
                variant: 'destructive',
            })
        } finally {
            workflowRunInFlight.current = false
            setBusyProgress(null)
        }
    }

    return (
        <div
            data-local-file-drop
            className="h-full flex flex-col relative"
            onDragOver={(e) => {
                e.preventDefault()
                // Check if it's a file drag from OS
                if (e.dataTransfer.types.includes('Files')) {
                    if (!isDraggingFile) setIsDraggingFile(true)
                }
            }}
            onDragLeave={(e) => {
                e.preventDefault()
                // Simple check to see if we left the window
                if (e.currentTarget.contains(e.relatedTarget as Node)) return
                setIsDraggingFile(false)
            }}
            onDrop={onFileDrop}
        >
            {/* Header */}
            <div className="z-10 flex min-h-14 w-full shrink-0 items-center border-b bg-background px-3 py-2 sm:px-4 lg:px-6">
                {isEditMode ? (
                    /* Edit Mode Header */
                    <div className="flex w-full min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex min-w-0 items-center gap-2">
                            <Button variant="ghost" size="sm" className="h-11 shrink-0 hover:bg-accent lg:h-9" onClick={() => setEditMode(false)}>
                                <X className="h-4 w-4 mr-2" /> {t('actions.cancel', '취소')}
                            </Button>
                            <span className="min-w-0 truncate text-sm text-muted-foreground">
                                {selectedItemIds.length} {t('library.selected', '개 선택')}
                            </span>
                        </div>
                        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto">
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-11 min-w-0 flex-1 px-2 hover:bg-accent sm:flex-none sm:px-3 lg:h-9"
                                onClick={() => selectItems(viewItems.filter(item => !item.isStack).map(item => item.id))}
                            >
                                <CheckSquare className="mr-1.5 h-4 w-4 shrink-0" />
                                <span className="min-w-0 truncate">{t('scene.selectAll', '전체 선택')}</span>
                            </Button>
                            <Button
                                size="sm"
                                className="h-11 min-w-0 flex-[1.4] px-3 sm:flex-none lg:h-9"
                                onClick={() => openWorkflowForItems(viewItems.filter(item => selectedItemIds.includes(item.id)))}
                                disabled={selectedItemIds.length === 0}
                            >
                                <Wand2 className="mr-1.5 h-4 w-4 shrink-0" />
                                <span className="min-w-0 truncate">{t('library.workflow.menu', '정리 · 변환')}</span>
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-11 min-w-0 flex-1 px-2 hover:bg-accent sm:flex-none sm:px-3 lg:h-9"
                                onClick={openBatchRename}
                                disabled={selectedItemIds.length === 0}
                            >
                                <Edit3 className="mr-1.5 h-4 w-4 shrink-0" />
                                <span className="min-w-0 truncate">{t('actions.rename', '이름 변경')}</span>
                            </Button>
                            {!currentStackId && (
                                <Tip content={t('library.createStackDesc', '선택한 이미지를 하나의 스택으로 묶음')}>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-11 min-w-0 flex-1 px-2 hover:bg-accent sm:flex-none sm:px-3 lg:h-9"
                                        onClick={createStackFromSelected}
                                        disabled={selectedItemIds.length < 2}
                                    >
                                        <Layers className="mr-1.5 h-4 w-4 shrink-0" />
                                        <span className="min-w-0 truncate">{t('library.createStack', '스택 만들기')}</span>
                                    </Button>
                                </Tip>
                            )}
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-11 min-w-0 flex-1 px-2 text-destructive hover:bg-destructive/10 hover:text-destructive sm:flex-none sm:px-3 lg:h-9"
                                onClick={() => setConfirmDeleteSelectedOpen(true)}
                                disabled={selectedItemIds.length === 0}
                            >
                                <Trash2 className="mr-1.5 h-4 w-4 shrink-0" />
                                <span className="min-w-0 truncate">{t('actions.delete', '삭제')}</span>
                            </Button>
                        </div>
                    </div>
                ) : (
                    /* Normal Header */
                    <div className="flex w-full min-w-0 flex-wrap items-center gap-2">
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                            {currentStackId ? (
                                <>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-11 w-11 shrink-0 px-0 hover:bg-accent sm:w-auto sm:px-3 lg:h-9"
                                        onClick={() => setCurrentStackId(null)}
                                        aria-label={t('actions.back', '뒤로')}
                                    >
                                        <ArrowLeft className="h-4 w-4 shrink-0 sm:mr-2" />
                                        <span className="sr-only sm:not-sr-only">{t('actions.back', '뒤로')}</span>
                                    </Button>
                                    <h2 className="min-w-0 truncate text-lg font-semibold tracking-tight" title={currentStack?.name}>{currentStack?.name}</h2>
                                </>
                            ) : (
                                <>
                                    <h2 className="min-w-0 truncate text-lg font-semibold tracking-tight">{t('library.title', '라이브러리')}</h2>
                                    <select
                                        value={folderFilter}
                                        onChange={event => setFolderFilter(event.target.value)}
                                        className="min-h-10 max-w-44 border-x-0 border-y border-input bg-background px-2 text-xs text-muted-foreground"
                                        aria-label={t('library.folderFilter', '폴더로 필터')}
                                    >
                                        <option value="">{t('library.allFolders', '모든 폴더')}</option>
                                        {generationFolders.map(folder => (
                                            <option key={folder.id} value={folder.id}>{generationFolderLabel(generationFolders, folder.id)}</option>
                                        ))}
                                    </select>
                                </>
                            )}
                        </div>
                        <div className="ml-auto flex min-w-0 items-center justify-end gap-2">
                            {/* Hidden file input for image import */}
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".png,.webp,.jpg,.jpeg,image/png,image/webp,image/jpeg"
                                multiple
                                className="hidden"
                                onChange={handleFileInputChange}
                            />
                            <Button
                                size="sm"
                                className="h-11 shrink-0 px-3 lg:h-9"
                                onClick={handleImportClick}
                            >
                                <Upload className="mr-1.5 h-4 w-4" />
                                <span className="hidden sm:inline">{t('library.import', '이미지 가져오기')}</span>
                                <span className="sm:hidden">{t('library.importShort', '가져오기')}</span>
                            </Button>
                            <Tip content={t('library.editModeDesc', '여러 이미지를 선택하여 일괄 편집')}>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-11 w-11 shrink-0 text-muted-foreground hover:bg-accent hover:text-foreground lg:h-9 lg:w-9"
                                    onClick={() => setEditMode(true)} 
                                    disabled={viewItems.length === 0}
                                    aria-label={t('library.editModeDesc', '여러 이미지를 선택하여 일괄 편집')}
                                >
                                    <Edit3 className="h-4 w-4" />
                                </Button>
                            </Tip>
                            {currentStackId && (
                                <Tip content={t('library.unstackDesc', '스택을 해제하고 개별 이미지로 복원')}>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-11 w-11 shrink-0 px-0 hover:bg-accent sm:w-auto sm:px-3 lg:h-9"
                                        onClick={() => unstack(currentStackId)}
                                        aria-label={t('library.unstack', '스택 해제')}
                                    >
                                        <FolderOpen className="h-4 w-4 shrink-0 sm:mr-2" />
                                        <span className="sr-only sm:not-sr-only">{t('library.unstack', '스택 해제')}</span>
                                    </Button>
                                </Tip>
                            )}
                            <Tip content={t('library.gridColumnsDesc', '그리드 열 개수 변경')}>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-11 shrink-0 px-2 text-muted-foreground hover:bg-accent hover:text-foreground lg:h-9"
                                    onClick={handleToggleGrid}
                                    aria-label={t('library.gridColumnsDesc', '그리드 열 개수 변경')}
                                >
                                    <Grid3x3 className="h-4 w-4 mr-1.5" />
                                    <span className="text-sm font-medium min-[360px]:hidden">1</span>
                                    <span className="hidden text-sm font-medium min-[360px]:inline lg:hidden">{Math.min(gridColumns, 2)}</span>
                                    <span className="hidden text-sm font-medium lg:inline">{gridColumns}</span>
                                </Button>
                            </Tip>
                            <span className="hidden max-w-24 truncate whitespace-nowrap text-sm text-muted-foreground min-[380px]:inline">
                                {viewItems.length} {t('library.items', 'items')}
                            </span>
                        </div>
                    </div>
                )}
            </div>

            {/* Content */}
            <div className="custom-scrollbar min-h-0 w-full flex-1 overflow-y-auto p-3 sm:p-4 lg:p-6">
                <DndContext
                    sensors={sensors}
                    collisionDetection={pointerWithin}
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                    measuring={{
                        droppable: {
                            strategy: MeasuringStrategy.Always,
                        },
                    }}
                >
                    <SortableContext
                        items={viewItems.map(i => i.id)}
                        strategy={rectSortingStrategy}
                    >
                        <div
                            className={cn(
                                "grid min-w-0 grid-cols-1 gap-3 pb-10 min-[360px]:grid-cols-2 sm:gap-4 lg:gap-6",
                                gridColumns === 2 && "lg:grid-cols-2",
                                gridColumns === 3 && "lg:grid-cols-3",
                                gridColumns === 4 && "lg:grid-cols-4",
                                gridColumns === 5 && "lg:grid-cols-5"
                            )}
                        >
                            {viewItems.map((item) => (
                                <SortableLibraryItem
                                    key={item.id}
                                    item={item}
                                    onRename={handleRenameClick}
                                    onAddRef={handleAddRefClick}
                                    onLoadMetadata={handleLoadMetadata}
                                    onEditImage={item => openWorkflowForItems([item])}
                                    onOpenTools={onOpenTools}
                                    folderLabel={generationFolderLabel(generationFolders, item.generationFolderId) ?? undefined}
                                    onImageClick={(imgUrl) => {
                                        if (isEditMode && !item.isStack) {
                                            // Edit mode: toggle selection (stacks cannot be selected)
                                            toggleItemSelection(item.id, false)
                                        } else if (item.isStack) {
                                            // Stack: navigate into it
                                            setCurrentStackId(item.id)
                                        } else {
                                            // Normal: show fullscreen
                                            setViewerImageSrc(imgUrl)
                                        }
                                    }}
                                    isEditMode={isEditMode}
                                    isSelected={selectedItemIds.includes(item.id)}
                                    onSelectionClick={(e: React.MouseEvent) => {
                                        if (item.isStack) return // Stacks cannot be selected
                                        if (e.shiftKey && lastSelectedItemId) {
                                            selectItemRange(lastSelectedItemId, item.id)
                                        } else if (e.ctrlKey || e.metaKey) {
                                            toggleItemSelection(item.id, false)
                                        } else {
                                            toggleItemSelection(item.id, true)
                                        }
                                    }}
                                    disabled={isEditMode}
                                />
                            ))}
                        </div>
                    </SortableContext>

                    <DragOverlay dropAnimation={dropAnimation} modifiers={[snapCenterToCursor]}>
                        {activeItem ? (
                            <LibraryItemComponent item={activeItem} isOverlay />
                        ) : null}
                    </DragOverlay>
                </DndContext>

                {viewItems.length === 0 && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center px-4 text-center">
                        <div className="mb-5 flex h-20 w-20 items-center justify-center rounded-full bg-muted/45">
                            <ImagePlus className="h-10 w-10 text-muted-foreground" />
                        </div>
                        <h3 className="mb-2 text-xl font-semibold text-foreground/80">
                            {folderFilter ? t('library.emptyFolderTitle', '이 폴더에는 아직 이미지가 없습니다') : t('library.emptyTitle', '라이브러리가 비어있습니다')}
                        </h3>
                        <p className="max-w-sm px-4 text-center text-sm leading-relaxed text-muted-foreground [text-wrap:balance]">
                            {t('library.emptyDesc', '이미지를 가져오면 저장 폴더, 형식과 R2 업로드를 순서대로 안내합니다.')}
                        </p>
                        <Button className="mt-5 pointer-events-auto" onClick={handleImportClick}>
                            <Upload className="mr-2 h-4 w-4" />{t('library.import', '이미지 가져오기')}
                        </Button>
                    </div>
                )}
            </div>

            {/* File Drop Overlay - Modern Style from MainMode */}
            {isDraggingFile && (
                <div className="absolute inset-0 z-50 bg-scrim/72 flex items-center justify-center transition-all duration-300 pointer-events-none">
                    <div className="relative">
                        {/* Main card */}
                        <div className="relative rounded-panel bg-popover p-12 shadow-overlay transform transition-transform scale-100">
                            <div className="text-center space-y-4">
                                {/* Animated icon container */}
                                <div className="relative mx-auto w-20 h-20">
                                    <div className="absolute inset-0 rounded-full bg-primary/20 animate-ping" />
                                    <div className="relative w-full h-full rounded-full bg-primary flex items-center justify-center">
                                        <ImagePlus className="h-10 w-10 text-primary-foreground" />
                                    </div>
                                </div>

                                <div>
                                    <p className="text-xl font-bold text-foreground">
                                        {t('library.drop', '여기에 놓아서 추가')}
                                    </p>
                                    <p className="text-sm text-muted-foreground mt-2">
                                        {t('library.dropHint', '놓으면 저장 폴더와 편집 방법을 차례로 안내합니다.')}
                                    </p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Dialogs */}
            <LibraryRenameDialog
                open={renameDialogOpen}
                onOpenChange={setRenameDialogOpen}
                items={renameTargets}
                onConfirm={handleRenameConfirm}
            />

            <ImageReferenceDialog
                open={imageRefDialogOpen}
                onOpenChange={setImageRefDialogOpen}
                imageBase64={selectedImageRef}
            />

            <MetadataDialog
                open={metadataDialogOpen}
                onOpenChange={(open) => {
                    setMetadataDialogOpen(open)
                    if (!open) setSelectedImageForMetadata(undefined)
                }}
                initialImage={selectedImageForMetadata}
            />

            <ConfirmDialog
                open={confirmDeleteSelectedOpen}
                onOpenChange={setConfirmDeleteSelectedOpen}
                title={t('trash.confirmMoveTitle', '휴지통으로 이동할까요?')}
                description={t('trash.confirmMoveDescription', '항목은 30일 동안 휴지통에 보관됩니다.')}
                confirmText={t('trash.move', '휴지통으로 이동')}
                cancelText={t('common.cancel', '취소')}
                variant="destructive"
                onConfirm={handleTrashSelectedItems}
            />

            <LibraryImageWorkflowDialog
                open={workflowOpen}
                sourceNames={workflowSources.map(source => source.name)}
                busyProgress={busyProgress}
                onOpenChange={open => {
                    setWorkflowOpen(open)
                    if (!open) setWorkflowSources([])
                }}
                onConfirm={runImageWorkflow}
            />

            {/* Full-Screen Image Viewer Overlay */}
            {viewerImageSrc && (
                <div
                    className="fixed inset-0 z-50 bg-scrim/90 flex items-center justify-center cursor-pointer"
                    onClick={() => setViewerImageSrc(null)}
                >
                    <img
                        src={viewerImageSrc}
                        alt="Full view"
                        className="max-w-[90vw] max-h-[90vh] object-contain"
                        onClick={(e) => e.stopPropagation()}
                    />
                    <Button
                        variant="ghost"
                        size="icon"
                        className="absolute top-4 right-4 text-primary-foreground bg-scrim/50 hover:bg-scrim/70 rounded-control h-11 w-11"
                        onClick={() => setViewerImageSrc(null)}
                        aria-label={t('common.close', '닫기')}
                    >
                        <X className="h-6 w-6" />
                    </Button>
                </div>
            )}
        </div>
    )
}
