import { useId, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { ImageIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/use-toast'
import { flushSceneAuthorityRuntime } from '@/lib/scene-authority-runtime'
import { getRuntimeSceneRepository } from '@/lib/scene-migration-startup'
import { toNativeAssetUrl } from '@/platform/asset-url'
import { folderAssetLatestImage, folderAssetProductionCount, type FolderAssetRow } from '@/presentation/folders/folder-workbench'
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
    const fieldId = useId()
    const [description, setDescription] = useState(() => resolveScenePrompts(row.scene).additional)
    const [count, setCount] = useState(() => String(folderAssetProductionCount(row.scene)))
    const [busy, setBusy] = useState(false)
    const busyRef = useRef(false)
    const [error, setError] = useState<string | null>(null)
    const lastImage = folderAssetLatestImage(row.scene)
    const imageUrl = lastImage?.url.startsWith('data:') ? lastImage.url : lastImage ? toNativeAssetUrl(lastImage.url) : null
    const close = () => { if (!busyRef.current) onClose() }

    const save = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        if (busyRef.current || !ready || !event.currentTarget.reportValidity()) return
        const quantity = Number(count)
        // Empty additional text is valid when the asset uses a base or folder description.
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999 || description.length > 20_000) return
        busyRef.current = true
        setBusy(true)
        setError(null)
        try {
            const store = useSceneStore.getState()
            store.updateScenePrompts(row.presetId, row.scene.id, { additional: description })
            store.setSceneProductionCounts([{ presetId: row.presetId, sceneId: row.scene.id }], quantity)
            // The store is optimistic: only the existing authority's exact readback proves persistence.
            await flushSceneAuthorityRuntime()
            const document = await getRuntimeSceneRepository().getDocument(row.presetId)
            const saved = document?.scenes.find(scene => scene.id === row.scene.id)
            if (saved?.prompts?.additional !== description || saved.productionCount !== quantity) {
                throw new Error(t('folderWorkbench.design.saveUnconfirmed', '저장을 확인하지 못했습니다. 입력한 내용은 이 창에 남아 있습니다.'))
            }
            toast({ title: t('folderWorkbench.design.detailSaved', '설명과 수량을 저장했습니다.'), variant: 'success' })
            onClose()
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : t('folderWorkbench.design.detailSaveFailed', '저장하지 못했습니다. 입력한 내용을 확인하고 다시 시도하세요.'))
        } finally {
            busyRef.current = false
            setBusy(false)
        }
    }

    return (
        <Dialog open onOpenChange={open => { if (!open) close() }}>
            <DialogContent className="folder-workbench-surface fb-asset-dialog" closeLabel={t('folderWorkbench.design.close', '닫기')}
                aria-describedby={`${fieldId}-help`} aria-busy={busy}
                onEscapeKeyDown={event => { if (busyRef.current) event.preventDefault() }}
                onInteractOutside={event => { if (busyRef.current) event.preventDefault() }}>
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
                    <form className="fb-detail-form" onSubmit={save}>
                        <div className="fb-field">
                            <label htmlFor={`${fieldId}-description`}>{t('folderWorkbench.design.description', '그림 설명')}</label>
                            <Textarea id={`${fieldId}-description`} value={description} onChange={event => setDescription(event.target.value)}
                                maxLength={20_000} rows={9} disabled={busy || !ready} />
                        </div>
                        <div className="fb-field">
                            <label htmlFor={`${fieldId}-count`}>{t('folderWorkbench.design.quantity', '장수')}</label>
                            <Input id={`${fieldId}-count`} type="number" inputMode="numeric" required min={1} max={999} step={1}
                                value={count} onChange={event => setCount(event.target.value)} disabled={busy || !ready} className="min-h-11" />
                        </div>
                        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                        <div className="fb-detail-actions">
                            <Button type="submit" className="fb-button fb-primary" disabled={busy || !ready}>
                                {busy ? t('folderWorkbench.design.saving', '저장 중…') : t('folderWorkbench.design.saveDetails', '설명과 수량 저장')}
                            </Button>
                            <Button type="button" variant="outline" className="fb-button fb-secondary" disabled={busy} onClick={close}>
                                {t('folderWorkbench.design.close', '닫기')}
                            </Button>
                        </div>
                        <Link to={`/scenes/${row.scene.id}`} className="inline-flex min-h-11 items-center text-sm text-muted-foreground underline underline-offset-4"
                            aria-disabled={busy} tabIndex={busy ? -1 : undefined}
                            onClick={event => {
                                if (busyRef.current) { event.preventDefault(); return }
                                useSceneStore.getState().setActivePreset(row.presetId)
                                onClose()
                            }}>
                            {t('folderWorkbench.design.advancedEdit', '자세히 편집')}
                        </Link>
                    </form>
                </div>
            </DialogContent>
        </Dialog>
    )
}
