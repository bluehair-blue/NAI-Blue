import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { toNativeAssetUrl } from '@/platform/asset-url'
import type { SavedOutputImage } from '@/services/organizer/saved-output-catalog'

/** Bounded originals gallery. It never reassigns Scene membership or output
 * policy; pagination and lazy decoding keep large saved folders scrollable.
 */
export function SavedOutputGallery({ directoryKey, images, onFolders }: {
    directoryKey: string; images: readonly SavedOutputImage[]; onFolders: () => void
}) {
    const { t } = useTranslation()
    const [page, setPage] = useState(0)
    const [selected, setSelected] = useState<SavedOutputImage | null>(null)
    const rows = useMemo(() => images.filter(image => image.directoryKey === directoryKey), [images, directoryKey])
    const pageCount = Math.max(1, Math.ceil(rows.length / 60))
    const currentPage = Math.min(page, pageCount - 1)
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
                        <button key={image.path} type="button" className="min-w-0 rounded-control border border-border p-2 text-left focus-ring" onClick={() => setSelected(image)}>
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
            <Dialog open={selected !== null} onOpenChange={open => { if (!open) setSelected(null) }}>
                <DialogContent className="max-w-4xl">
                    <DialogTitle className="break-all">{selected?.name}</DialogTitle>
                    {selected && <img src={toNativeAssetUrl(selected.path)} alt={selected.name} className="max-h-[75vh] w-full object-contain" />}
                </DialogContent>
            </Dialog>
        </section>
    )
}
