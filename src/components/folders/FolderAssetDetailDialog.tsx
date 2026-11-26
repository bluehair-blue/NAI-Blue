import { useId, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { ImageIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/use-toast'
import { toNativeAssetUrl } from '@/platform/asset-url'
import { folderAssetLatestImage, folderAssetProductionCount, type FolderAssetRow } from '@/presentation/folders/folder-workbench'
import { saveFolderAssetDetails } from '@/presentation/folders/save-folder-asset-details'
import { resolveScenePrompts, useSceneStore } from '@/stores/scene-store'

interface FolderAssetDetailDialogProps {
    row: FolderAssetRow | null
    ready: boolean
    onClose: () => void
}

/** A selected asset owns its draft; unrelated SceneStore updates cannot replace typing. */
export function FolderAssetDetailDialog({ row, ready, onClose }: FolderAssetDetailDialogProps) {
    return row ? <AssetDetailEditor key={row.key} row={row} ready={ready} onClose={onClose} /> : null
}

function AssetDetailEditor({ row, ready, onClose }: Omit<FolderAssetDetailDialogProps, 'row'> & { row: FolderAssetRow }) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const fieldId = useId()
    const formRef = useRef<HTMLFormElement>(null)
    const [initialDescription] = useState(() => resolveScenePrompts(row.scene).additional)
    const [initialCount] = useState(() => String(folderAssetProductionCount(row.scene)))
    const [description, setDescription] = useState(initialDescription)
    const [count, setCount] = useState(initialCount)
    const [busy, setBusy] = useState(false)
    const busyRef = useRef(false)
    const [error, setError] = useState<string | null>(null)
    const [confirmDiscard, setConfirmDiscard] = useState(false)
    const lastImage = folderAssetLatestImage(row.scene)
    const imageUrl = lastImage?.url.startsWith('data:') ? lastImage.url : lastImage ? toNativeAssetUrl(lastImage.url) : null
    const isDirty = description !== initialDescription || count !== initialCount

    const requestClose = () => {
        if (busyRef.current) return
        if (isDirty) {
            setConfirmDiscard(true)
            return
        }
        onClose()
    }

    const persistChanges = async (): Promise<boolean> => {
        if (busyRef.current || !ready) return false
        if (formRef.current && !formRef.current.reportValidity()) return false
        const quantity = Number(count)
        // Empty additional text is valid when the asset uses a base or folder description.
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999 || description.length > 20_000) return false
        busyRef.current = true
        setBusy(true)
        setError(null)
        setConfirmDiscard(false)
        try {
            await saveFolderAssetDetails({
                presetId: row.presetId,
                sceneId: row.scene.id,
                description,
                quantity,
                unconfirmedMessage: t('folderWorkbench.design.saveUnconfirmed', '저장을 확인하지 못했습니다. 입력한 내용은 이 창에 남아 있습니다.'),
            })
            toast({ title: t('folderWorkbench.design.detailSaved', '설명과 수량을 저장했습니다.'), variant: 'success' })
            return true
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : t('folderWorkbench.design.detailSaveFailed', '저장하지 못했습니다. 입력한 내용을 확인하고 다시 시도하세요.'))
            return false
        } finally {
            busyRef.current = false
            setBusy(false)
        }
    }

    const save = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        if (await persistChanges()) {
            onClose()
        }
    }

    const openAdvancedEdit = async () => {
        if (busyRef.current) return
        if (isDirty) {
            const saved = await persistChanges()
            if (!saved) return
        }
        useSceneStore.getState().setActivePreset(row.presetId)
        onClose()
        navigate(`/scenes/${row.scene.id}`)
    }

    return (
        <Dialog open onOpenChange={open => { if (!open) requestClose() }}>
            <DialogContent className="folder-workbench-surface fb-asset-dialog" closeLabel={t('folderWorkbench.design.close', '닫기')}
                aria-describedby={`${fieldId}-help`} aria-busy={busy}
                onEscapeKeyDown={event => {
                    if (busyRef.current || isDirty) {
                        event.preventDefault()
                        if (!busyRef.current && isDirty) setConfirmDiscard(true)
                    }
                }}
                onInteractOutside={event => {
                    if (busyRef.current || isDirty) {
                        event.preventDefault()
                        if (!busyRef.current && isDirty) setConfirmDiscard(true)
                    }
                }}>
                <DialogHeader className="pr-10 text-left">
                    <DialogTitle>{row.scene.name}</DialogTitle>
                    <DialogDescription id={`${fieldId}-help`}>{t('folderWorkbench.design.detailIntro', '그림 설명과 만들 수량을 편집하세요.')}</DialogDescription>
                </DialogHeader>
                <div className="fb-asset-detail-layout">
                    <div className="fb-detail-preview">
                        {imageUrl ? <img src={imageUrl} alt={row.scene.name} className="h-full w-full object-contain" /> : (
                            <div className="flex flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
                                <ImageIcon className="h-10 w-10" strokeWidth={1.25} aria-hidden="true" />
                                <span>{t('folderWorkbench.design.noPreview', '완성된 그림이 여기에 표시됩니다.')}</span>
                            </div>
                        )}
                    </div>
                    <form ref={formRef} className="fb-detail-form" onSubmit={save}>
                        <div className="fb-field">
                            <label htmlFor={`${fieldId}-description`}>{t('folderWorkbench.design.description', '그림 설명')}</label>
                            <Textarea id={`${fieldId}-description`} value={description} onChange={event => { setDescription(event.target.value); setConfirmDiscard(false) }}
                                maxLength={20_000} rows={9} disabled={busy || !ready} />
                        </div>
                        <div className="fb-field">
                            <label htmlFor={`${fieldId}-count`}>{t('folderWorkbench.design.quantity', '장수')}</label>
                            <Input id={`${fieldId}-count`} type="number" inputMode="numeric" required min={1} max={999} step={1}
                                value={count} onChange={event => { setCount(event.target.value); setConfirmDiscard(false) }} disabled={busy || !ready} className="min-h-11" />
                        </div>
                        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                        {confirmDiscard && (
                            <div role="alert" className="space-y-3 rounded-[4px] bg-canvas p-3 text-sm">
                                <div>
                                    <p className="font-medium text-foreground">{t('folderWorkbench.design.unsavedTitle', '저장하지 않은 변경이 있어요.')}</p>
                                    <p className="text-muted-foreground">{t('folderWorkbench.design.unsavedDescription', '지금 닫으면 바뀐 내용이 사라져요.')}</p>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    <Button type="button" variant="outline" className="fb-button fb-secondary" onClick={() => setConfirmDiscard(false)}>
                                        {t('folderWorkbench.design.keepEditing', '계속 편집')}
                                    </Button>
                                    <Button type="button" variant="destructive" className="fb-button" onClick={onClose}>
                                        {t('folderWorkbench.design.discardAndClose', '버리고 닫기')}
                                    </Button>
                                </div>
                            </div>
                        )}
                        <div className="fb-detail-actions">
                            <Button type="submit" className="fb-button fb-primary" disabled={busy || !ready}>
                                {busy ? t('folderWorkbench.design.saving', '저장 중…') : t('folderWorkbench.design.saveDetails', '설명과 수량 저장')}
                            </Button>
                            <Button type="button" variant="outline" className="fb-button fb-secondary" disabled={busy} onClick={requestClose}>
                                {t('folderWorkbench.design.close', '닫기')}
                            </Button>
                        </div>
                        <button
                            type="button"
                            className="inline-flex min-h-11 w-fit items-center text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground disabled:opacity-50"
                            disabled={busy}
                            onClick={() => void openAdvancedEdit()}
                        >
                            {t('folderWorkbench.design.advancedEdit', '자세히 편집')}
                        </button>
                    </form>
                </div>
            </DialogContent>
        </Dialog>
    )
}
