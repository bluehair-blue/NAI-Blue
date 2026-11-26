import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { FolderPlus, LoaderCircle, Sparkles } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/use-toast'
import { parseMetadataFromFile } from '@/lib/metadata-parser'
import { toNativeAssetUrl } from '@/platform/asset-url'
import { readNativeBinaryFile } from '@/platform/native-file-system'
import { guidedPromptImportFromMetadata } from '@/presentation/workflow/guided-prompt-import'
import type { SavedOutputImage } from '@/services/organizer/saved-output-catalog'
import { applyMetadataPreview, createMetadataApplyPreview } from '@/services/output/metadata-apply'
import { useLayoutStore } from '@/stores/layout-store'
import { usePresetStore } from '@/stores/preset-store'

async function readSavedOutputAsFile(image: SavedOutputImage): Promise<File> {
    const ext = image.name.split('.').pop()?.toLowerCase()
    const mime = ext === 'webp' ? 'image/webp' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png'
    try {
        const bytes = await readNativeBinaryFile(image.path)
        const copy = new Uint8Array(bytes.byteLength)
        copy.set(bytes)
        return new File([copy.buffer], image.name, { type: mime })
    } catch {
        const response = await fetch(toNativeAssetUrl(image.path))
        if (!response.ok) throw new Error('Unable to read saved image')
        const buffer = await response.arrayBuffer()
        return new File([buffer], image.name, { type: mime })
    }
}

function stripExtension(name: string): string {
    return name.replace(/\.[^.]+$/u, '').trim() || name
}

/** Bounded originals gallery. It never reassigns Scene membership or output
 * policy; pagination and lazy decoding keep large saved folders scrollable.
 */
export function SavedOutputGallery({ directoryKey, images, onFolders, onAddAssetFromPrompt }: {
    directoryKey: string
    images: readonly SavedOutputImage[]
    onFolders: () => void
    onAddAssetFromPrompt?: (input: { name: string; prompt: string }) => Promise<boolean>
}) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const [page, setPage] = useState(0)
    const [selected, setSelected] = useState<SavedOutputImage | null>(null)
    const [busyAction, setBusyAction] = useState<'asset' | 'single' | null>(null)
    const [actionError, setActionError] = useState<string | null>(null)
    const rows = useMemo(() => images.filter(image => image.directoryKey === directoryKey), [images, directoryKey])
    const pageCount = Math.max(1, Math.ceil(rows.length / 60))
    const currentPage = Math.min(page, pageCount - 1)

    const selectImage = (image: SavedOutputImage | null) => {
        setSelected(image)
        setActionError(null)
    }

    const handleAddAsset = async () => {
        if (!selected || !onAddAssetFromPrompt || busyAction !== null) return
        setBusyAction('asset')
        setActionError(null)
        try {
            const file = await readSavedOutputAsFile(selected)
            const metadata = await parseMetadataFromFile(file)
            if (metadata === null) throw new TypeError('No metadata')
            const imported = guidedPromptImportFromMetadata(metadata, selected.name)
            const prompt = imported?.positive?.trim() || metadata.prompt?.trim()
            if (!prompt) throw new TypeError('No prompt')
            const added = await onAddAssetFromPrompt({
                name: stripExtension(selected.name).slice(0, 96),
                prompt,
            })
            if (added) {
                selectImage(null)
                toast({
                    title: t('savedOutputs.addedAsAsset', '프롬프트로 에셋을 추가했어요.'),
                    variant: 'success',
                })
            }
        } catch {
            setActionError(t('metadata.globalNoPrompt', '이 이미지에서 불러올 프롬프트 메타데이터를 찾지 못했어요.'))
        } finally {
            setBusyAction(null)
        }
    }

    const handleOpenInSingle = async () => {
        if (!selected || busyAction !== null) return
        setBusyAction('single')
        setActionError(null)
        try {
            const file = await readSavedOutputAsFile(selected)
            const metadata = await parseMetadataFromFile(file)
            if (metadata === null) throw new TypeError('No metadata')
            const imported = guidedPromptImportFromMetadata(metadata, selected.name)
            if (imported === null) throw new TypeError('No prompt')
            const presetId = usePresetStore.getState().activePresetId
            const preview = createMetadataApplyPreview(metadata, {
                targetPresetId: presetId,
                prompts: true,
                parameters: false,
                resolution: false,
                seed: false,
                characterPrompts: true,
                vibeTransfer: false,
            })
            await applyMetadataPreview(preview)
            selectImage(null)
            navigate('/advanced')
            useLayoutStore.getState().openSupportSheet('prompt')
            toast({
                title: t('metadata.globalApplied', '프롬프트를 불러왔어요.'),
                description: t('metadata.globalAdvanced', '고급 생성의 프롬프트 작성 화면으로 이동했어요.'),
                variant: 'success',
            })
        } catch {
            setActionError(t('metadata.globalNoPrompt', '이 이미지에서 불러올 프롬프트 메타데이터를 찾지 못했어요.'))
        } finally {
            setBusyAction(null)
        }
    }

    return (
        <section className="fb-main" aria-label={t('savedOutputs.title', '저장된 이미지 폴더')}>
            <div className="fb-content-scroll">
                <header className="fb-workspace-header">
                    <Button variant="ghost" className="fb-mobile-folders" onClick={onFolders}>{t('folderWorkbench.design.folders', '폴더')}</Button>
                    <h1 className="break-all text-xl font-semibold">{rows[0]?.directory ?? directoryKey}</h1>
                    <p className="mt-2 text-base text-muted-foreground">{t('savedOutputs.count', '저장된 이미지 {{count}}장', { count: rows.length })}</p>
                </header>
                <div className="grid grid-cols-2 gap-4 p-4 md:grid-cols-3 xl:grid-cols-4">
                    {rows.slice(currentPage * 60, (currentPage + 1) * 60).map(image => (
                        <button key={image.path} type="button" className="min-w-0 rounded-control bg-card p-2 text-left transition-colors hover:bg-accent/35 focus-ring" onClick={() => selectImage(image)}>
                            <img src={toNativeAssetUrl(image.path)} alt={image.name} loading="lazy" decoding="async" className="aspect-square w-full rounded object-contain" />
                            <span className="mt-2 block truncate text-sm" title={image.name}>{image.name}</span>
                        </button>
                    ))}
                </div>
            </div>
            {pageCount > 1 && <nav className="flex items-center justify-center gap-4 border-t p-3" aria-label={t('folderWorkbench.pagination', '항목 페이지')}>
                <Button variant="outline" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t('folderWorkbench.previous', '이전')}</Button>
                <span>{currentPage + 1} / {pageCount}</span>
                <Button variant="outline" disabled={currentPage + 1 === pageCount} onClick={() => setPage(currentPage + 1)}>{t('folderWorkbench.next', '다음')}</Button>
            </nav>}
            <Dialog open={selected !== null} onOpenChange={open => { if (!open && busyAction === null) selectImage(null) }}>
                <DialogContent className="max-w-4xl" closeLabel={t('folderWorkbench.design.close', '닫기')}>
                    <DialogTitle className="break-all pr-10">{selected?.name}</DialogTitle>
                    <DialogDescription className="sr-only">
                        {t('savedOutputs.detailDescription', '저장된 이미지를 확인하고 프롬프트로 에셋을 추가하거나 단건 생성으로 열 수 있어요.')}
                    </DialogDescription>
                    {selected && <img src={toNativeAssetUrl(selected.path)} alt={selected.name} className="max-h-[68vh] w-full object-contain" />}
                    {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
                    <div className="flex flex-wrap items-center gap-2 pt-2">
                        {onAddAssetFromPrompt && (
                            <Button
                                type="button"
                                className="min-h-11"
                                disabled={busyAction !== null}
                                onClick={() => void handleAddAsset()}
                                data-testid="saved-output-add-asset"
                            >
                                {busyAction === 'asset'
                                    ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                                    : <FolderPlus className="mr-2 h-4 w-4" aria-hidden="true" />}
                                {t('savedOutputs.addAsAsset', '이 프롬프트로 에셋 추가')}
                            </Button>
                        )}
                        <Button
                            type="button"
                            variant="outline"
                            className="min-h-11"
                            disabled={busyAction !== null}
                            onClick={() => void handleOpenInSingle()}
                            data-testid="saved-output-open-single"
                        >
                            {busyAction === 'single'
                                ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                                : <Sparkles className="mr-2 h-4 w-4" aria-hidden="true" />}
                            {t('savedOutputs.openInSingle', '단건 생성으로 열기')}
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </section>
    )
}
