import { useState, useSyncExternalStore } from 'react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { ImageIcon } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { queueLivePreview } from '@/services/queue/queue-live-preview'
import { useGenerationStore } from '@/stores/generation-store'
import { useQueueStore } from '@/stores/queue-store'
import { useLayoutStore } from '@/stores/layout-store'
import { toNativeAssetUrl } from '@/platform/asset-url'
import { useMyWorkActivityReadModel } from '@/presentation/activity/MyWorkActivity'

function imageSource(path: string) {
    return /^(?:data:|blob:|https?:|asset:)/u.test(path) ? path : toNativeAssetUrl(path)
}

/** Always mounted beside routed content. Only this small strip subscribes to
 * streaming frames; all clients share Queue identity and committed history.
 */
export function LiveGenerationMonitor() {
    const { t } = useTranslation()
    const live = useSyncExternalStore(queueLivePreview.subscribe, queueLivePreview.getSnapshot, queueLivePreview.getServerSnapshot)
    const history = useGenerationStore(state => state.history)
    const selectBatch = useQueueStore(state => state.setSelectedBatchId)
    const openSupport = useLayoutStore(state => state.openSupportSheet)
    const { queue } = useMyWorkActivityReadModel()
    const [selected, setSelected] = useState<string | null>(null)
    const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
    const selectedJob = live.find(item => item.jobId === selectedJobId)
    const processing = Math.max(live.length, queue.processing)
    if (!processing && !queue.waiting && !queue.needsAttention && history.length === 0) return null

    return (
        <section className="flex shrink-0 items-center gap-3 overflow-x-auto border-b border-border bg-card px-4 py-2" aria-label={t('liveGeneration.title', '실시간 생성')}>
            <button type="button" onClick={() => openSupport('activity')} className="min-w-36 shrink-0 text-left text-sm focus-ring">
                <span className="block font-semibold">{t('liveGeneration.title', '실시간 생성')}</span>
                <span className="block text-muted-foreground">{t('liveGeneration.counts', '생성 {{processing}} · 대기 {{waiting}}', { processing, waiting: queue.waiting })}</span>
                {queue.needsAttention > 0 && <span className="block text-warning">{t('liveGeneration.attention', '확인 필요 {{count}}', { count: queue.needsAttention })}</span>}
            </button>
            {live.slice(0, 4).map(item => (
                <button type="button" key={item.jobId} onClick={() => setSelectedJobId(item.jobId)}
                    className="flex min-w-44 shrink-0 items-center gap-2 rounded-control border border-primary/30 p-1 focus-ring">
                    {item.preview
                        ? <img src={item.preview} alt={t('liveGeneration.inProgress', '생성 중 프리뷰')} decoding="async" className="h-16 w-16 rounded object-contain" />
                        : <span className="flex h-16 w-16 items-center justify-center rounded bg-muted"><ImageIcon aria-hidden="true" /></span>}
                    <span className="text-sm">
                        <span className="block">{item.sceneId ? t('liveGeneration.scene', '장면 생성') : t('liveGeneration.image', '이미지 생성')}</span>
                        <span className="block text-muted-foreground">{item.progress.total > 0 ? `${item.progress.current} / ${item.progress.total}` : t('liveGeneration.preparing', '준비 중')}</span>
                        {!item.preview && <span className="block text-xs text-muted-foreground">{t('liveGeneration.waitPreview', '프리뷰 수신 대기')}</span>}
                    </span>
                </button>
            ))}
            {live.length > 4 && <button type="button" onClick={() => openSupport('activity')} className="min-h-11 shrink-0 px-2">+{live.length - 4}</button>}
            {history.slice(0, 4).map(item => (
                <button key={item.id} type="button" onClick={() => setSelected(item.url)}
                    className="relative shrink-0 rounded-control focus-ring" aria-label={t('liveGeneration.openResult', '완성 이미지 열기')}>
                    <img src={imageSource(item.thumbnail ?? item.url)} alt={t('liveGeneration.completed', '완성 이미지')} loading="lazy" decoding="async" className="h-16 w-16 rounded object-cover" />
                    <span className="absolute bottom-0 left-0 right-0 rounded-b bg-background/90 text-xs">{t('liveGeneration.saved', '완료')}</span>
                </button>
            ))}
            <button type="button" onClick={() => openSupport('history')} className="min-h-11 shrink-0 px-2 text-sm underline focus-ring">{t('liveGeneration.history', '생성 내역')}</button>
            <Dialog open={selected !== null || selectedJobId !== null} onOpenChange={open => { if (!open) { setSelected(null); setSelectedJobId(null) } }}>
                <DialogContent className="max-w-4xl">
                    <DialogTitle>{selectedJobId ? t('liveGeneration.inProgress', '생성 중 프리뷰') : t('liveGeneration.completed', '완성 이미지')}</DialogTitle>
                    {selected && <img src={imageSource(selected)} alt={t('liveGeneration.completed', '완성 이미지')} className="max-h-[75vh] w-full object-contain" />}
                    {selectedJob?.preview && <img src={selectedJob.preview} alt={t('liveGeneration.inProgress', '생성 중 프리뷰')} className="max-h-[65vh] w-full object-contain" />}
                    {selectedJob && <>
                        <p>{selectedJob.progress.current} / {selectedJob.progress.total}</p>
                        <Link to="/queue" className="min-h-11 underline" onClick={() => { selectBatch(selectedJob.batchId); setSelectedJobId(null) }}>{t('liveGeneration.queue', '큐 센터에서 보기')}</Link>
                    </>}
                    {selectedJobId && !selectedJob && <button type="button" className="min-h-11 underline" onClick={() => { setSelectedJobId(null); openSupport('history') }}>{t('liveGeneration.history', '생성 내역')}</button>}
                </DialogContent>
            </Dialog>
        </section>
    )
}
