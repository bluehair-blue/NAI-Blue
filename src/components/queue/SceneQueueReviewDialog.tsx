import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import type { PreparedSceneQueueReview, SceneQueueSubmission } from '@/services/queue/scene-queue-adapter'
import {
    canApproveSceneQueueReview,
    isSceneQueueReviewConflict,
    sceneQueueReplanDescription,
    shouldAcceptSceneQueueDialogOpenChange,
    type SceneQueueReplanIssue,
} from '@/application/scene/scene-queue-review'

interface SceneQueueReviewDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    prepared: PreparedSceneQueueReview
    busy?: boolean
    onApprove: (submission: SceneQueueSubmission) => Promise<boolean>
    onReplan: () => Promise<boolean>
    onBack?: () => void
}

/** Modal submission lock prevents dismiss/re-entry; success closes only after the durable Queue commit. */
export function SceneQueueReviewDialog({
    open,
    onOpenChange,
    prepared,
    busy = false,
    onApprove,
    onReplan,
    onBack,
}: SceneQueueReviewDialogProps) {
    const { t } = useTranslation()
    const [submitting, setSubmitting] = useState(false)
    const [replanIssue, setReplanIssue] = useState<SceneQueueReplanIssue | null>(null)

    useEffect(() => setReplanIssue(null), [prepared.review.reviewId])

    const handleOpenChange = (nextOpen: boolean) => {
        if (shouldAcceptSceneQueueDialogOpenChange(submitting, nextOpen)) onOpenChange(nextOpen)
    }

    const approve = async () => {
        if (!canApproveSceneQueueReview({ submitting, busy, issue: replanIssue })) return
        setSubmitting(true)
        try {
            if (await onApprove(prepared.submission)) onOpenChange(false)
        } catch (error) {
            if (isSceneQueueReviewConflict(error)) {
                setReplanIssue(error.issue)
                return
            }
            throw error
        } finally {
            setSubmitting(false)
        }
    }

    const replan = async () => {
        if (submitting || busy || replanIssue === null) return
        setSubmitting(true)
        try {
            if (await onReplan()) setReplanIssue(null)
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent
                className="flex max-h-[85dvh] max-w-2xl flex-col overflow-hidden"
                onEscapeKeyDown={event => { if (submitting) event.preventDefault() }}
                onPointerDownOutside={event => { if (submitting) event.preventDefault() }}
            >
                <DialogHeader>
                    <DialogTitle>{t('queue.reviewScenesTitle', 'Review Scene queue')}</DialogTitle>
                    <DialogDescription>
                        {t('queue.reviewScenesDescription', 'Approve the exact cost and output reservation plan below.')}
                    </DialogDescription>
                </DialogHeader>
                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1" data-testid="scene-queue-review">
                    <div className="rounded-panel border border-border p-3 text-sm">
                        <p className="font-medium">
                            {t('queue.selectionSummary', '{{scenes}} scenes · {{images}} images', {
                                scenes: prepared.review.sceneCount,
                                images: prepared.review.imageCount,
                            })}
                        </p>
                        <p>{t('queue.reviewAnlas', 'Estimated {{estimated}} Anlas · maximum {{maximum}}', {
                            estimated: prepared.review.estimatedAnlas,
                            maximum: prepared.review.maxAnlas,
                        })}</p>
                        <p>{t('queue.reviewClaims', '{{count}} output files reserved', { count: prepared.review.claimCount })}</p>
                        <p className="text-xs text-muted-foreground">
                            {t('queue.reservationSummary', 'The complete output file set is reserved before work starts. Existing files are never overwritten.')}
                        </p>
                        <p className="text-xs text-muted-foreground">
                            {t('queue.appOpenProcessing', 'Jobs run while NAI Blue is open. Interrupted work resumes after the app reopens.')}
                        </p>
                    </div>
                    {prepared.review.destinations.map((destination, index) => (
                        <section key={`${destination.logicalFolderLabel}:${index}`} className="rounded-panel border border-border p-3 text-sm">
                            <h3 className="font-semibold">{destination.logicalFolderLabel}</h3>
                            <p>{t('queue.reviewDestinationCounts', '{{images}} images · {{claims}} files', {
                                images: destination.imageCount,
                                claims: destination.claimCount,
                            })}</p>
                            <p className="break-all text-xs text-muted-foreground">
                                {destination.filenameSummary.kind === 'filenames'
                                    ? destination.filenameSummary.filenames?.join(', ')
                                    : `${destination.filenameSummary.first} … ${destination.filenameSummary.last} (${destination.filenameSummary.count})`}
                            </p>
                        </section>
                    ))}
                    {prepared.review.r2Destinations.slice(0, 5).map((destination, index) => (
                        <section key={`r2:${index}`} className="rounded-panel border border-border p-3 text-sm">
                            <h3 className="font-semibold">R2 · {t(`queue.r2Requirement.${destination.requirement}`, destination.requirement)}</h3>
                            <p className="break-all">{destination.bucket}/{destination.key}</p>
                            {destination.provenance !== null && (
                                <p className="text-xs text-muted-foreground">
                                    {t('queue.r2DestinationSource', 'Bucket: {{bucket}} · prefix: {{prefix}}', {
                                        bucket: t(`queue.r2Source.${destination.provenance.bucket}`, destination.provenance.bucket),
                                        prefix: t(`queue.r2Source.${destination.provenance.prefix}`, destination.provenance.prefix),
                                    })}
                                </p>
                            )}
                        </section>
                    ))}
                    {prepared.review.r2Destinations.length > 5 && <p className="text-sm">{t('queue.r2MoreDestinations', '{{count}} more R2 destinations', { count: prepared.review.r2Destinations.length - 5 })}</p>}
                    {replanIssue !== null && (
                        <div className="rounded-panel border border-destructive/50 bg-destructive/10 p-3 text-sm" role="alert">
                            <p className="font-semibold">{t('queue.reviewStaleTitle', 'Review is out of date')}</p>
                            <p>{t(
                                `queue.replanReason.${replanIssue.reason}`,
                                sceneQueueReplanDescription(replanIssue.reason),
                            )}</p>
                        </div>
                    )}
                </div>
                <DialogFooter>
                    <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
                        {t('common.cancel', 'Cancel')}
                    </Button>
                    {onBack !== undefined && (
                        <Button type="button" variant="outline" disabled={submitting} onClick={onBack}>
                            {t('common.back', 'Back')}
                        </Button>
                    )}
                    {replanIssue === null ? (
                        <Button type="button" disabled={!canApproveSceneQueueReview({ submitting, busy, issue: replanIssue })} onClick={() => void approve()}>
                            {t('queue.approveSceneQueue', 'Approve and add to queue')}
                        </Button>
                    ) : (
                        <Button type="button" disabled={busy || submitting} onClick={() => void replan()}>
                            {t('queue.reviewAgain', 'Review again')}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
