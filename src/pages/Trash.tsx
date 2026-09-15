import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toNativeAssetUrl } from '@/platform/asset-url'
import { readNativeBinaryFile } from '@/platform/native-file-system'
import { FileImage, FileText, FolderTree, Image as ImageIcon, RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { MetadataDialog } from '@/components/metadata/MetadataDialog'
import {
    useTrashStore,
    type TrashItem,
    type TrashedImage,
} from '@/stores/trash-store'
import {
    permanentlyRemoveTrashItem,
    pruneExpiredTrashItems,
    restoreTrashItem,
} from '@/services/trash/asset-trash-service'
import { imageDataUrlFromBytes } from '@/services/trash/image-data-url'
import { toast } from '@/components/ui/use-toast'
import { getWorkflowDraftRepository } from '@/adapters/workflow/indexeddb-workflow-draft-repository'
import type { TrashedWorkflowDraft } from '@/application/workflow/workflow-draft-repository'
import { announceGuidedDraftChange } from '@/presentation/workflow/guided-draft-events'
import { summarizeWorkflowDraftPrompt } from '@/presentation/workflow/workflow-draft-summary'

function imageSource(image: TrashedImage): string {
    return image.url.startsWith('data:') ? image.url : toNativeAssetUrl(image.url)
}

function firstImage(item: TrashItem): TrashedImage | undefined {
    if (item.kind === 'image') return item.image
    if (item.kind === 'scene') return item.scene.scene.images[0]
    if (item.kind === 'folder') return item.folder.presets.flatMap(preset => preset.scenes).flatMap(scene => scene.images)[0]
    const visit = (items: typeof item.library.items): TrashedImage | undefined => {
        for (const libraryItem of items) {
            if (libraryItem.stackItems?.length) {
                const nested = visit(libraryItem.stackItems)
                if (nested) return nested
            } else {
                return {
                    id: libraryItem.id,
                    url: libraryItem.path,
                    originalUrl: libraryItem.path,
                    timestamp: libraryItem.createdAt,
                    isFavorite: false,
                }
            }
        }
        return undefined
    }
    return visit(item.library.items)
}

function imageCount(item: TrashItem): number {
    if (item.kind === 'image') return 1
    if (item.kind === 'scene') return item.scene.scene.images.length
    if (item.kind === 'folder') return item.folder.presets.reduce(
        (total, preset) => total + preset.scenes.reduce((sceneTotal, scene) => sceneTotal + scene.images.length, 0),
        0,
    )
    const count = (items: typeof item.library.items): number => items.reduce(
        (total, libraryItem) => total + (libraryItem.stackItems?.length ? count(libraryItem.stackItems) : 1),
        0,
    )
    return count(item.library.items)
}

/**
 * Depends on the shared trash journal and MetadataDialog. Opening it runs the
 * 30-day cleanup boundary, while the same typed snapshots render images and
 * nested Scene folders without depending on their removed source records.
 */
export default function Trash() {
    const { t } = useTranslation()
    const items = useTrashStore(state => state.items)
    const remove = useTrashStore(state => state.remove)
    const removeMany = useTrashStore(state => state.removeMany)
    const draftRepository = useMemo(() => getWorkflowDraftRepository(), [])
    const [draftItems, setDraftItems] = useState<readonly TrashedWorkflowDraft[]>([])
    const [selected, setSelected] = useState<TrashItem | null>(null)
    const [pendingPurge, setPendingPurge] = useState<TrashItem | 'all' | null>(null)
    const [pendingRestore, setPendingRestore] = useState<TrashItem | null>(null)
    const [pendingDraftPurge, setPendingDraftPurge] = useState<TrashedWorkflowDraft | null>(null)
    const [pendingDraftRestore, setPendingDraftRestore] = useState<TrashedWorkflowDraft | null>(null)
    const [metadataImage, setMetadataImage] = useState<string | undefined>()
    const [metadataOpen, setMetadataOpen] = useState(false)

    useEffect(() => {
        let disposed = false
        void pruneExpiredTrashItems(useTrashStore.getState().items).then(expiredIds => {
            if (!disposed && expiredIds.length > 0) removeMany(expiredIds)
        })
        void (async () => {
            await draftRepository.pruneExpiredTrash(Date.now())
            const drafts = await draftRepository.listTrash()
            if (!disposed) setDraftItems(drafts)
        })().catch(() => {
            if (!disposed) setDraftItems([])
        })
        return () => { disposed = true }
    }, [draftRepository, removeMany])

    const sortedItems = useMemo(
        () => [...items].sort((left, right) => right.deletedAt - left.deletedAt),
        [items],
    )

    const openMetadata = async (image: TrashedImage) => {
        try {
            const dataUrl = image.url.startsWith('data:')
                ? image.url
                : imageDataUrlFromBytes(await readNativeBinaryFile(image.url), image.url)
            setMetadataImage(dataUrl)
            setMetadataOpen(true)
        } catch (error) {
            console.warn('[Trash] Unable to read image metadata:', error)
        }
    }

    const purge = async () => {
        const target = pendingPurge
        if (!target) return
        const targetItems = target === 'all' ? useTrashStore.getState().items : [target]
        const outcomes = await Promise.all(targetItems.map(async item => ({
            id: item.id,
            result: await permanentlyRemoveTrashItem(item),
        })))
        const removedIds = outcomes.filter(outcome => outcome.result.success).map(outcome => outcome.id)
        const failedCount = outcomes.length - removedIds.length
        removeMany(removedIds)
        let draftFailedCount = 0
        if (target === 'all') {
            const draftOutcomes = await Promise.all(draftItems.map(item => (
                draftRepository.permanentlyDeleteFromTrash(item.draft.id).catch(() => false)
            )))
            draftFailedCount = draftOutcomes.filter(success => !success).length
            setDraftItems(current => current.filter((_, index) => !draftOutcomes[index]))
        }
        if (target !== 'all' && removedIds.includes(target.id) && selected?.id === target.id) setSelected(null)
        if (failedCount + draftFailedCount > 0) {
            toast({
                title: t('trash.deleteFailed', '일부 항목을 영구 삭제하지 못했습니다.'),
                description: t('trash.deleteFailedDescription', '파일 접근이 가능해지면 휴지통에서 다시 시도하세요.'),
                variant: 'destructive',
            })
        }
        setPendingPurge(null)
    }

    const purgeDraft = async () => {
        if (!pendingDraftPurge) return
        const id = pendingDraftPurge.draft.id
        const removed = await draftRepository.permanentlyDeleteFromTrash(id).catch(() => false)
        if (removed) setDraftItems(current => current.filter(item => item.draft.id !== id))
        else toast({ title: t('trash.deleteFailed', '일부 항목을 영구 삭제하지 못했습니다.'), variant: 'destructive' })
        setPendingDraftPurge(null)
    }

    /**
     * Depends on the persisted trash journal and the restore service's
     * all-or-nothing result. A journal entry is removed only after its files
     * and domain store are both restored, leaving conflicts and locked files
     * visible for a safe retry.
     */
    const restore = async () => {
        const target = pendingRestore
        if (!target) return
        const result = await restoreTrashItem(target)
        if (result.success) {
            remove(target.id)
            if (selected?.id === target.id) setSelected(null)
            toast({ title: t('trash.restored', '원래 위치로 복원했습니다.'), variant: 'success' })
        } else {
            const hasConflict = result.conflictPaths.length > 0
            toast({
                title: hasConflict
                    ? t('trash.restoreConflict', '같은 항목이 이미 있어 복원하지 않았습니다.')
                    : t('trash.restoreFailed', '복원하지 못했습니다.'),
                description: hasConflict
                    ? t('trash.restoreConflictDescription', '기존 파일이나 데이터를 덮어쓰지 않았습니다. 휴지통 항목은 그대로 보관됩니다.')
                    : t('trash.restoreFailedDescription', '파일 접근이 가능해지면 휴지통에서 다시 시도하세요.'),
                variant: 'destructive',
            })
        }
        setPendingRestore(null)
    }

    const restoreDraft = async () => {
        if (!pendingDraftRestore) return
        const id = pendingDraftRestore.draft.id
        const result = await draftRepository.restoreFromTrash(id).catch(() => ({ status: 'missing' as const }))
        if (result.status === 'restored') {
            setDraftItems(current => current.filter(item => item.draft.id !== id))
            announceGuidedDraftChange()
            toast({ title: t('trash.draftRestored', '초안을 내 작업으로 복원했어요.'), variant: 'success' })
        } else {
            toast({
                title: result.status === 'conflict'
                    ? t('trash.restoreConflict', '같은 항목이 이미 있어 복원하지 않았습니다.')
                    : t('trash.restoreFailed', '복원하지 못했습니다.'),
                variant: 'destructive',
            })
        }
        setPendingDraftRestore(null)
    }

    return (
        <div className="flex h-full min-h-0 flex-col">
            <header className="workspace-page-inset flex shrink-0 flex-wrap items-center justify-between gap-3 border-b">
                <div className="workspace-heading !mb-0">
                    <h1 className="flex items-center gap-2 text-lg font-semibold">
                        {t('trash.title', '휴지통')}
                    </h1>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                        {t('trash.retention', '삭제한 항목은 최대 30일 보관됩니다.')}
                    </p>
                </div>
                <Button
                    variant="outline"
                    className="h-11 shrink-0 text-destructive hover:text-destructive"
                    onClick={() => setPendingPurge('all')}
                    disabled={items.length === 0 && draftItems.length === 0}
                >
                    <Trash2 className="mr-2 h-4 w-4" />
                    {t('trash.empty', '휴지통 비우기')}
                </Button>
            </header>

            <main className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
                {sortedItems.length === 0 && draftItems.length === 0 ? (
                    <div className="flex min-h-72 flex-col items-center justify-center text-center text-muted-foreground">
                        <Trash2 className="mb-3 h-10 w-10 opacity-50" />
                        <p>{t('trash.emptyState', '휴지통이 비어 있습니다.')}</p>
                    </div>
                ) : (
                    <div className="space-y-8">
                        {draftItems.length > 0 && (
                            <section aria-labelledby="trash-drafts-heading">
                                <h2 id="trash-drafts-heading" className="mb-3 text-sm font-semibold">
                                    {t('trash.workflowDrafts', '워크플로우 초안')}
                                </h2>
                                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                                    {draftItems.map(item => {
                                        const draft = item.draft
                                        const title = summarizeWorkflowDraftPrompt(draft)
                                            ?? (draft.kind === 'batch-image'
                                                ? t('guided.activity.batchUntitled', '이미지 여러 장 만들기')
                                                : t('guided.activity.singleUntitled', '이미지 한 장 만들기'))
                                        return (
                                            <Card key={draft.id}>
                                                <CardHeader className="flex-row items-start gap-3 py-4">
                                                    <FileText className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                                                    <div className="min-w-0">
                                                        <CardTitle className="line-clamp-2 break-words text-base leading-snug">{title}</CardTitle>
                                                        <p className="mt-2 text-xs text-muted-foreground">
                                                            {draft.kind === 'batch-image'
                                                                ? t('trash.batchDraft', '여러 장 초안')
                                                                : t('trash.singleDraft', '한 장 초안')}
                                                            {' · '}{t('trash.draftStep', '단계 {{step}}', { step: draft.currentNodeId })}
                                                        </p>
                                                        <p className="mt-1 text-xs text-muted-foreground">
                                                            {t('trash.expires', '만료: {{date}}', { date: new Date(item.expiresAt).toLocaleDateString() })}
                                                        </p>
                                                    </div>
                                                </CardHeader>
                                                <CardContent className="flex justify-end gap-1 border-t p-2">
                                                    <Button variant="ghost" size="sm" className="h-11" onClick={() => setPendingDraftRestore(item)}>
                                                        <RotateCcw className="mr-2 h-4 w-4" />
                                                        {t('trash.restore', '복원')}
                                                    </Button>
                                                    <Button variant="ghost" size="sm" className="h-11 text-destructive hover:text-destructive" onClick={() => setPendingDraftPurge(item)}>
                                                        {t('trash.deletePermanently', '영구 삭제')}
                                                    </Button>
                                                </CardContent>
                                            </Card>
                                        )
                                    })}
                                </div>
                            </section>
                        )}
                        {sortedItems.length > 0 && <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        {sortedItems.map(item => {
                            const preview = firstImage(item)
                            const itemKind = item.kind === 'image'
                                ? t('trash.image', '이미지')
                                : item.kind === 'scene'
                                    ? t('trash.scene', '씬')
                                    : item.kind === 'folder'
                                        ? t('trash.folder', '폴더')
                                        : t('trash.library', '라이브러리')
                            return (
                                <Card key={item.id} className="overflow-hidden">
                                    <button
                                        type="button"
                                        className="flex w-full min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        onClick={() => item.kind === 'image' && preview ? void openMetadata(preview) : setSelected(item)}
                                        aria-label={item.kind === 'image'
                                            ? t('trash.openImageMetadataNamed', '{{name}} 메타데이터 보기', { name: item.title })
                                            : t('trash.openContents', '{{name}} 내용물 보기', { name: item.title })}
                                    >
                                        <div className="flex h-28 w-28 shrink-0 items-center justify-center bg-muted/40">
                                            {preview ? (
                                                <img src={imageSource(preview)} alt="" className="h-full w-full object-cover" />
                                            ) : item.kind === 'folder' ? (
                                                <FolderTree className="h-8 w-8 text-muted-foreground" />
                                            ) : (
                                                <ImageIcon className="h-8 w-8 text-muted-foreground" />
                                            )}
                                        </div>
                                        <CardHeader className="min-w-0 flex-1 py-3">
                                            <CardTitle className="truncate text-base">{item.title}</CardTitle>
                                            <p className="mt-1 text-xs text-muted-foreground">
                                                {itemKind} · {t('trash.imageCount', '이미지 {{count}}개', { count: imageCount(item) })}
                                            </p>
                                            <p className="mt-1 text-xs text-muted-foreground">
                                                {t('trash.expires', '만료: {{date}}', { date: new Date(item.expiresAt).toLocaleDateString() })}
                                            </p>
                                        </CardHeader>
                                    </button>
                                    <CardContent className="flex justify-end gap-1 border-t p-2">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-11"
                                            onClick={() => setPendingRestore(item)}
                                        >
                                            <RotateCcw className="mr-2 h-4 w-4" />
                                            {t('trash.restore', '복원')}
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-11 text-destructive hover:text-destructive"
                                            onClick={() => setPendingPurge(item)}
                                        >
                                            {t('trash.deletePermanently', '영구 삭제')}
                                        </Button>
                                    </CardContent>
                                </Card>
                            )
                        })}
                        </div>}
                    </div>
                )}
            </main>

            <TrashContentsDialog
                item={selected}
                onOpenChange={open => { if (!open) setSelected(null) }}
                onOpenMetadata={openMetadata}
            />
            <MetadataDialog
                open={metadataOpen}
                onOpenChange={open => {
                    setMetadataOpen(open)
                    if (!open) setMetadataImage(undefined)
                }}
                initialImage={metadataImage}
            />
            <ConfirmDialog
                open={pendingRestore !== null}
                onOpenChange={open => { if (!open) setPendingRestore(null) }}
                title={t('trash.confirmRestoreTitle', '원래 위치로 복원할까요?')}
                description={t('trash.confirmRestoreDescription', '같은 경로 또는 항목이 이미 있으면 덮어쓰지 않고 복원을 중단합니다.')}
                confirmText={t('trash.restore', '복원')}
                cancelText={t('common.cancel', '취소')}
                onConfirm={restore}
            />
            <ConfirmDialog
                open={pendingDraftRestore !== null}
                onOpenChange={open => { if (!open) setPendingDraftRestore(null) }}
                title={t('trash.confirmDraftRestoreTitle', '이 초안을 내 작업으로 복원할까요?')}
                description={t('trash.confirmDraftRestoreDescription', '같은 초안이 이미 있으면 덮어쓰지 않고 복원을 중단합니다.')}
                confirmText={t('trash.restore', '복원')}
                cancelText={t('common.cancel', '취소')}
                onConfirm={restoreDraft}
            />
            <ConfirmDialog
                open={pendingPurge !== null}
                onOpenChange={open => { if (!open) setPendingPurge(null) }}
                title={pendingPurge === 'all'
                    ? t('trash.confirmEmptyTitle', '휴지통을 비울까요?')
                    : t('trash.confirmDeleteTitle', '이 항목을 영구 삭제할까요?')}
                description={t('trash.confirmDeleteDescription', '이 작업은 되돌릴 수 없습니다.')}
                confirmText={t('trash.deletePermanently', '영구 삭제')}
                cancelText={t('common.cancel', '취소')}
                variant="destructive"
                onConfirm={purge}
            />
            <ConfirmDialog
                open={pendingDraftPurge !== null}
                onOpenChange={open => { if (!open) setPendingDraftPurge(null) }}
                title={t('trash.confirmDeleteTitle', '이 항목을 영구 삭제할까요?')}
                description={t('trash.confirmDeleteDescription', '이 작업은 되돌릴 수 없습니다.')}
                confirmText={t('trash.deletePermanently', '영구 삭제')}
                cancelText={t('common.cancel', '취소')}
                variant="destructive"
                onConfirm={purgeDraft}
            />
        </div>
    )
}

function TrashContentsDialog({
    item,
    onOpenChange,
    onOpenMetadata,
}: {
    item: TrashItem | null
    onOpenChange: (open: boolean) => void
    onOpenMetadata: (image: TrashedImage) => Promise<void>
}) {
    const { t } = useTranslation()
    if (!item || item.kind === 'image') return null

    const sceneRows = item.kind === 'scene'
        ? [{ path: item.scene.preset.name, scene: item.scene.scene }]
        : item.kind === 'folder'
            ? item.folder.presets.flatMap(preset => preset.scenes.map(scene => ({ path: preset.name, scene })))
            : []
    const libraryItems = item.kind === 'library' ? item.library.items : []

    return (
        <Dialog open={Boolean(item)} onOpenChange={onOpenChange}>
            <DialogContent className="flex max-h-[85dvh] max-w-3xl flex-col overflow-hidden">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <FolderTree className="h-5 w-5" /> {item.title}
                    </DialogTitle>
                    <DialogDescription>{t('trash.contentsDescription', '보관된 씬과 이미지 내용을 확인할 수 있습니다.')}</DialogDescription>
                </DialogHeader>
                <div className="custom-scrollbar min-h-0 space-y-4 overflow-y-auto pr-1">
                    {sceneRows.map(({ path, scene }) => (
                        <section key={scene.id} className="rounded-panel border p-3">
                            <h2 className="truncate text-sm font-semibold">{path} / {scene.name}</h2>
                            <p className="mt-1 text-xs text-muted-foreground">{scene.images.length} {t('trash.images', '개 이미지')}</p>
                            {scene.images.length > 0 && (
                                <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
                                    {scene.images.map(image => (
                                        <button
                                            key={image.id}
                                            type="button"
                                            className="aspect-square overflow-hidden rounded-control bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                            onClick={() => void onOpenMetadata(image)}
                                            aria-label={t('trash.openImageMetadata', '이미지 메타데이터 보기')}
                                        >
                                            <img src={imageSource(image)} alt="" className="h-full w-full object-cover" />
                                        </button>
                                    ))}
                                </div>
                            )}
                        </section>
                    ))}
                    {libraryItems.length > 0 && (
                        <section className="space-y-2 rounded-panel border p-3">
                            {libraryItems.map(libraryItem => (
                                <div key={libraryItem.id} className="flex items-center gap-2 text-sm">
                                    <FileImage className="h-4 w-4 text-muted-foreground" />
                                    <span className="truncate">{libraryItem.name}</span>
                                </div>
                            ))}
                        </section>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    )
}
