import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SceneQueueReviewDialog } from '@/components/queue/SceneQueueReviewDialog'
import { isSceneQueueReviewConflict } from '@/application/scene/scene-queue-review'
import { createRuntimeProductionRequest, enqueueRuntimeProductionChild, getRuntimeProductionStatus, listRuntimeProductionRequests, prepareRuntimeProductionChild, type ProductionStatus } from '@/composition-root/production-requests'
import type { SceneQueueSubmission, SceneQueueTarget } from '@/services/queue/scene-queue-adapter'
import { useQueueStore } from '@/stores/queue-store'

interface FolderProductionRequestsProps {
    targets: SceneQueueTarget[] | null
    defaultTitle: string
    disabled: boolean
    canExecute: boolean
    onClose: () => void
}

/** Saved selection resumes here; the existing review dialog and Queue still own each explicit submission. */
export function FolderProductionRequests({ targets, defaultTitle, disabled, canExecute, onClose }: FolderProductionRequestsProps) {
    const { t } = useTranslation()
    const [requests, setRequests] = useState<Awaited<ReturnType<typeof listRuntimeProductionRequests>>>([])
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const [status, setStatus] = useState<ProductionStatus | null>(null)
    const [expanded, setExpanded] = useState(false)
    const [title, setTitle] = useState('')
    const [maxAnlas, setMaxAnlas] = useState('')
    const [busy, setBusy] = useState(false)
    const busyRef = useRef(false)
    const refreshVersion = useRef(0)
    const [error, setError] = useState<string | null>(null)
    const [notice, setNotice] = useState<string | null>(null)
    const [review, setReview] = useState<Awaited<ReturnType<typeof prepareRuntimeProductionChild>> | null>(null)
    const selectBatch = useQueueStore(state => state.setSelectedBatchId)
    const imageCount = targets?.reduce((sum, target) => sum + target.count, 0) ?? 0
    const errorMessage = useCallback((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause)
        return message.startsWith('PRODUCTION_') ? t(`productionRequests.errors.${message}`, { defaultValue: t('productionRequests.failed') }) : message
    }, [t])
    const reportError = (cause: unknown) => setError(errorMessage(cause))
    // One selected request is read on demand; QueueCenter owns live monitoring of admitted batches.
    const refresh = useCallback(async (id = selectedId) => {
        const version = ++refreshVersion.current
        try {
            const nextRequests = await listRuntimeProductionRequests()
            const nextStatus = id ? await getRuntimeProductionStatus(id) : null
            if (version !== refreshVersion.current) return
            setRequests(nextRequests)
            setStatus(nextStatus)
        } catch (cause) {
            if (version !== refreshVersion.current) return
            setStatus(null)
            setError(errorMessage(cause))
        }
    }, [selectedId, errorMessage])
    useEffect(() => { void refresh() }, [refresh])
    useEffect(() => {
        if (targets) { setTitle(defaultTitle.slice(0, 200)); setMaxAnlas(''); setError(null); setNotice(null) }
    }, [targets, defaultTitle])
    const lock = () => { busyRef.current = true; setBusy(true); setError(null); setNotice(null) }
    const unlock = () => { busyRef.current = false; setBusy(false) }
    const validBudget = maxAnlas.trim() !== '' && Number.isSafeInteger(Number(maxAnlas)) && Number(maxAnlas) >= 0
    const save = async () => {
        if (busyRef.current || disabled || !targets || !title.trim() || !validBudget || imageCount < 1 || imageCount > 2400) return
        lock()
        try {
            const saved = await createRuntimeProductionRequest({ title: title.trim(), targets, budget: { maxImages: imageCount, maxAnlas: Number(maxAnlas) } })
            onClose()
            setExpanded(true)
            setSelectedId(saved.id)
            setNotice(t('productionRequests.saved'))
            await refresh(saved.id)
        } catch (cause) { reportError(cause) }
        finally { unlock() }
    }
    const prepare = async (id: string, revision?: number): Promise<boolean> => {
        if (busyRef.current || disabled || !canExecute) return false
        lock()
        try {
            const current = revision ?? (await getRuntimeProductionStatus(id))?.revision
            if (current === undefined) throw new Error(t('productionRequests.failed'))
            setReview(await prepareRuntimeProductionChild(id, current))
            await refresh()
            return true
        } catch (cause) { reportError(cause); return false }
        finally { unlock() }
    }
    const approve = async (submission: SceneQueueSubmission): Promise<boolean> => {
        if (busyRef.current || disabled || !canExecute || !review) return false
        lock()
        try {
            const result = await enqueueRuntimeProductionChild(review.request.id, review.index, submission)
            selectBatch(result.batch.id)
            setNotice(t('productionRequests.queued'))
            await refresh()
            return true
        } catch (cause) {
            await refresh()
            if (isSceneQueueReviewConflict(cause)) throw cause
            reportError(cause)
            return false
        } finally { unlock() }
    }
    return <>
        <details className="mx-4 mb-4 rounded-lg border border-border bg-card p-4 text-sm sm:mx-6" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
            <summary className="cursor-pointer font-medium">{t('productionRequests.heading', { count: requests.length })}</summary>
            <div className="mt-3 space-y-3">
                <p className="text-muted-foreground">{t('productionRequests.description')}</p>
                {notice && <p role="status">{notice}</p>}
                {error && !targets && !review && <p role="alert" className="break-words text-destructive">{error}</p>}
                <div className="flex flex-wrap gap-3"><Button variant="outline" size="sm" disabled={busy || disabled} onClick={() => { setError(null); void refresh() }}>{t('productionRequests.refresh')}</Button><Link className="self-center underline" to="/queue">{t('productionRequests.openQueue')}</Link></div>
                {requests.length === 0 && !error && <p className="text-muted-foreground">{t('productionRequests.empty')}</p>}
                <ul className="space-y-3">
                    {requests.map(request => <li key={request.id} className="min-w-0 rounded-lg border border-border p-3">
                        <h3 className="break-words font-medium">{request.title}</h3>
                        <p>{t('productionRequests.selection', { images: request.targets.reduce((sum, target) => sum + target.count, 0), batches: request.children.length })}</p>
                        <Button className="mt-2" variant="outline" size="sm" disabled={busy || disabled} onClick={() => { setError(null); if (selectedId === request.id) void refresh(); else { setStatus(null); setSelectedId(request.id) } }}>{t('productionRequests.showStatus')}</Button>
                        {status?.id === request.id && <div className="mt-3 space-y-1">
                            <p>{t('productionRequests.summary', { images: status.totalImages, batches: status.childCount, admitted: status.admittedImages })}</p>
                            <p>{t('productionRequests.counts', { generated: status.counts.generated, stored: status.counts.stored, uploaded: status.counts.uploaded, uploadRequested: status.counts.uploadRequested })}</p>
                            <p>{t('productionRequests.budget', { reserved: status.estimatedAnlasReserved, max: status.maxAnlas })}</p>
                            <p className="mt-2 font-medium">{t(`productionRequests.next.${status.nextAction}`)}</p>
                            {status.issue && <p className="break-words text-destructive">{errorMessage(status.issue)}</p>}
                            <div className="mt-2 flex flex-wrap gap-3">
                                {status.nextAction === 'review-next-batch' && <Button size="sm" disabled={busy || disabled || !canExecute} onClick={() => { void prepare(status.id, status.revision) }}>{t('productionRequests.review')}</Button>}
                                {status.children.some(child => child.runId) && <Link className="self-center underline" to="/queue" onClick={() => selectBatch(status.children.filter(child => child.runId).slice(-1)[0]?.runId ?? null)}>{t('productionRequests.openQueue')}</Link>}
                            </div>
                        </div>}
                    </li>)}
                </ul>
            </div>
        </details>
        <Dialog open={targets !== null} onOpenChange={open => { if (!open && !busyRef.current) onClose() }}>
            <DialogContent closeLabel={t('folderWorkbench.design.close')} className="folder-workbench-surface fb-composer-dialog" onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onPointerDownOutside={event => { if (busy) event.preventDefault() }}>
                <form onSubmit={event => { event.preventDefault(); void save() }} className="space-y-4">
                    <DialogHeader className="pr-10 text-left"><DialogTitle>{t('productionRequests.save')}</DialogTitle><DialogDescription>{t('productionRequests.description')}</DialogDescription></DialogHeader>
                    <p>{t('productionRequests.selection', { images: imageCount, batches: Math.ceil(imageCount / 100) })}</p>
                    <label className="block space-y-1"><span>{t('productionRequests.title')}</span><Input value={title} maxLength={200} required disabled={busy} onChange={event => setTitle(event.target.value)} /></label>
                    <label className="block space-y-1"><span>{t('productionRequests.maxAnlas')}</span><Input type="number" min={0} step={1} required value={maxAnlas} disabled={busy} onChange={event => setMaxAnlas(event.target.value)} aria-describedby="production-budget-hint" /></label>
                    <p id="production-budget-hint" className="text-sm text-muted-foreground">{t('productionRequests.budgetHint')}</p>
                    {error && <p role="alert" className="break-words text-destructive">{error}</p>}
                    <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t('productionRequests.cancel')}</Button><Button type="submit" disabled={busy || disabled || !title.trim() || !validBudget}>{busy ? t('productionRequests.saving') : t('productionRequests.save')}</Button></DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
        {review && <SceneQueueReviewDialog open={true} onOpenChange={open => { if (!open && !busyRef.current) setReview(null) }} prepared={review.prepared} busy={busy} error={error} onApprove={approve} onReplan={() => prepare(review.request.id)} />}
    </>
}
