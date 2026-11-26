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
import { applyMetadataPreview, captureMetadataApplyCurrentState, createMetadataApplyPreview } from '@/services/output/metadata-apply'
import {
    mainPromptHasText,
    SavedOutputActionError,
    runSavedOutputStage,
    savedOutputActionMessage,
    savedOutputValidationError,
} from '@/presentation/folders/saved-output-actions'
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

async function readSavedOutputMetadata(image: SavedOutputImage) {
    const file = await runSavedOutputStage('read', () => readSavedOutputAsFile(image))
    return runSavedOutputStage('metadata', async () => {
        const metadata = await parseMetadataFromFile(file)
        if (metadata === null) throw new TypeError('No metadata')
        return metadata
    })
}

function stripExtension(name: string): string {
    return name.replace(/\.[^.]+$/u, '').trim() || name
}

/** Bounded originals gallery. It never reassigns Scene membership or output
 * policy; pagination and lazy decoding keep large saved folders scrollable.
 */
export function SavedOutputGallery({ directoryKey, images, onFolders, onAddAssetFromPrompt, assetTargetName = null }: {
    directoryKey: string
    images: readonly SavedOutputImage[]
    onFolders: () => void
    onAddAssetFromPrompt?: (input: { name: string; prompt: string }) => Promise<boolean>
    /** Folder that `onAddAssetFromPrompt` writes into; null when no folder exists yet. */
    assetTargetName?: string | null
}) {
    const { t } = useTranslation()
    const translate = (key: string, fallback: string, options?: Record<string, unknown>) => t(key, fallback, options)
    const navigate = useNavigate()
    const [page, setPage] = useState(0)
    const [selected, setSelected] = useState<SavedOutputImage | null>(null)
    const [busyAction, setBusyAction] = useState<'asset' | 'single' | null>(null)
    const [actionError, setActionError] = useState<string | null>(null)
    const [confirmingSingle, setConfirmingSingle] = useState(false)
    const rows = useMemo(() => images.filter(image => image.directoryKey === directoryKey), [images, directoryKey])
    const pageCount = Math.max(1, Math.ceil(rows.length / 60))
    const currentPage = Math.min(page, pageCount - 1)

    const selectImage = (image: SavedOutputImage | null) => {
        setSelected(image)
        setActionError(null)
        setConfirmingSingle(false)
    }

    const handleAddAsset = async () => {
        if (!selected || !onAddAssetFromPrompt || busyAction !== null) return
        setBusyAction('asset')
        setActionError(null)
        try {
            const metadata = await readSavedOutputMetadata(selected)
            const imported = guidedPromptImportFromMetadata(metadata, selected.name)
            const prompt = imported?.positive?.trim() || metadata.prompt?.trim()
            if (!prompt) throw new SavedOutputActionError('metadata', 'No prompt')
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
            } else {
                setActionError(t('folderWorkbench.design.addFailed', '에셋을 추가하지 못했어요. 작업 폴더와 저장 상태를 확인해 주세요.'))
            }
        } catch (cause) {
            setActionError(savedOutputActionMessage(cause, translate))
        } finally {
            setBusyAction(null)
        }
    }

    const requestOpenInSingle = () => {
        if (!selected || busyAction !== null) return
        const presetId = usePresetStore.getState().activePresetId
        if (!confirmingSingle && mainPromptHasText(captureMetadataApplyCurrentState(presetId).generation)) {
            setActionError(null)
            setConfirmingSingle(true)
            return
        }
        void handleOpenInSingle()
    }

    const handleOpenInSingle = async () => {
        if (!selected || busyAction !== null) return
        setBusyAction('single')
        setActionError(null)
        try {
            const metadata = await readSavedOutputMetadata(selected)
            if (guidedPromptImportFromMetadata(metadata, selected.name) === null) {
                throw new SavedOutputActionError('metadata', 'No prompt')
            }
            await runSavedOutputStage('apply', async () => {
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
                if (!preview.validation.valid) throw savedOutputValidationError(preview.validation.errors)
                await applyMetadataPreview(preview)
            })
            selectImage(null)
            navigate('/advanced')
            useLayoutStore.getState().openSupportSheet('prompt')
            toast({
                title: t('metadata.globalApplied', '프롬프트를 불러왔어요.'),
                description: t('metadata.globalAdvanced', '고급 생성의 프롬프트 작성 화면으로 이동했어요.'),
                variant: 'success',
            })
        } catch (cause) {
            setConfirmingSingle(false)
            setActionError(savedOutputActionMessage(cause, translate))
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
                    {confirmingSingle ? (
                        <div className="grid gap-2 pt-2" role="group" aria-labelledby="saved-output-overwrite-notice">
                            <p id="saved-output-overwrite-notice" className="text-sm">
                                {t('savedOutputs.overwriteNotice', '지금 프롬프트와 캐릭터 프롬프트가 이 이미지의 것으로 바뀌고, 지금 프리셋에 저장돼요.')}
                            </p>
                            <div className="flex flex-wrap items-center gap-2">
                                <Button
                                    type="button"
                                    className="min-h-11"
                                    disabled={busyAction !== null}
                                    onClick={() => void handleOpenInSingle()}
                                    data-testid="saved-output-confirm-open-single"
                                >
                                    {busyAction === 'single'
                                        ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                                        : <Sparkles className="mr-2 h-4 w-4" aria-hidden="true" />}
                                    {t('savedOutputs.overwriteAndOpen', '덮어쓰고 열기')}
                                </Button>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    className="min-h-11"
                                    disabled={busyAction !== null}
                                    autoFocus
                                    onClick={() => setConfirmingSingle(false)}
                                >
                                    {t('savedOutputs.cancelOverwrite', '취소')}
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <div className="grid gap-2 pt-2">
                            <div className="flex flex-wrap items-center gap-2">
                                {onAddAssetFromPrompt && (
                                    <Button
                                        type="button"
                                        className="min-h-11"
                                        disabled={busyAction !== null || assetTargetName === null}
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
                                    onClick={requestOpenInSingle}
                                    data-testid="saved-output-open-single"
                                >
                                    {busyAction === 'single'
                                        ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                                        : <Sparkles className="mr-2 h-4 w-4" aria-hidden="true" />}
                                    {t('savedOutputs.openInSingle', '단건 생성으로 열기')}
                                </Button>
                            </div>
                            {onAddAssetFromPrompt && (
                                <p className="text-sm text-muted-foreground" data-testid="saved-output-add-target">
                                    {assetTargetName === null
                                        ? t('savedOutputs.noAddTarget', '에셋을 넣을 폴더가 없어요. 먼저 폴더를 만들어 주세요.')
                                        : t('savedOutputs.addTarget', '에셋은 {{name}} 폴더에 추가돼요.', { name: assetTargetName })}
                                </p>
                            )}
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        </section>
    )
}
