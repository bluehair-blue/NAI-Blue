import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { BriefcaseBusiness, Circle, Clock3, Plus, Trash2 } from 'lucide-react'

import { getWorkflowDraftRepository } from '@/adapters/workflow/indexeddb-workflow-draft-repository'
import { QueueActivityLinkView } from '@/components/layout/QueueActivityLink'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { toast } from '@/components/ui/use-toast'
import type { QueueActivitySummary } from '@/domain/queue/types'
import type {
    WorkflowDraft,
} from '@/domain/workflow/single-image-draft'
import { cn } from '@/lib/utils'
import { getRuntimeQueueRepository } from '@/services/queue/indexeddb-queue-repository'
import { useAuthStore } from '@/stores/auth-store'
import { useLayoutStore } from '@/stores/layout-store'
import {
    GUIDED_DRAFTS_CHANGED_EVENT,
    announceGuidedDraftChange,
    announceGuidedQueueActivityRefresh,
} from '@/presentation/workflow/guided-draft-events'
import {
    deriveDraftActivityStatus,
    resolveGuidedActivityTargetNode,
    type GuidedActivityStatus,
} from './activity-status'
import { summarizeWorkflowDraftPrompt } from '@/presentation/workflow/workflow-draft-summary'

const ACTIVITY_REFRESH_MS = 5_000
const QUEUE_REFRESH_MS = 1_000
const MAX_VISIBLE_DRAFTS = 5

const EMPTY_QUEUE_ACTIVITY_SUMMARY: QueueActivitySummary = Object.freeze({
    processing: 0,
    waiting: 0,
    needsAttention: 0,
})

interface ActivityDraft {
    readonly draft: WorkflowDraft
    readonly status: GuidedActivityStatus
}

interface MyWorkActivityReadModel {
    readonly drafts: readonly ActivityDraft[]
    readonly queue: QueueActivitySummary
}

const EMPTY_ACTIVITY_READ_MODEL: MyWorkActivityReadModel = Object.freeze({
    drafts: Object.freeze([]),
    queue: EMPTY_QUEUE_ACTIVITY_SUMMARY,
})

let activityReadModel = EMPTY_ACTIVITY_READ_MODEL
const activityReadModelListeners = new Set<() => void>()

function publishActivityReadModel(readModel: MyWorkActivityReadModel): void {
    if (activityReadModel.queue.processing === readModel.queue.processing
        && activityReadModel.queue.waiting === readModel.queue.waiting
        && activityReadModel.queue.needsAttention === readModel.queue.needsAttention
        && activityReadModel.drafts.length === readModel.drafts.length
        && activityReadModel.drafts.every((item, index) => {
            const next = readModel.drafts[index]
            return item.draft.id === next.draft.id && item.draft.revision === next.draft.revision && item.status === next.status
        })) return
    activityReadModel = readModel
    activityReadModelListeners.forEach(listener => listener())
}

function subscribeActivityReadModel(listener: () => void): () => void {
    activityReadModelListeners.add(listener)
    return () => activityReadModelListeners.delete(listener)
}

export function useMyWorkActivityReadModel(): MyWorkActivityReadModel {
    return useSyncExternalStore(
        subscribeActivityReadModel,
        () => activityReadModel,
        () => EMPTY_ACTIVITY_READ_MODEL,
    )
}

/**
 * One shell-owned poller keeps the shared activity projection current even
 * when the responsive activity Sheet is closed and its presentation unmounted.
 */
export function MyWorkActivityRefreshOwner() {
    const draftRepository = useMemo(() => getWorkflowDraftRepository(), [])
    const queueRepository = useMemo(() => getRuntimeQueueRepository(), [])
    const refreshId = useRef(0)
    const reading = useRef(false)
    const lastDraftRead = useRef(0)

    const refresh = useCallback(async () => {
        if (reading.current) return
        reading.current = true
        const requestId = ++refreshId.current
        const readDrafts = Date.now() - lastDraftRead.current >= ACTIVITY_REFRESH_MS
        const [listedDrafts, queue] = await Promise.all([
            readDrafts ? draftRepository.list().catch(() => null) : Promise.resolve(null),
            queueRepository.getActivitySummary().catch(() => null),
        ])

        const drafts = listedDrafts === null
            ? null
            : await Promise.all(listedDrafts.slice(0, MAX_VISIBLE_DRAFTS).map(async (draft): Promise<ActivityDraft> => {
                if (draft.status !== 'queued' || draft.lastSnapshotId === null) {
                    return { draft, status: draft.status }
                }

                try {
                    // This bounded aggregate is transactionally maintained from durable jobs.
                    const projection = await queueRepository.getBatchProjectionMeta(draft.lastSnapshotId)
                    return {
                        draft,
                        status: deriveDraftActivityStatus(draft.status, projection.summary),
                    }
                } catch {
                    return { draft, status: draft.status }
                }
            }))

        reading.current = false
        if (listedDrafts !== null) lastDraftRead.current = Date.now()
        if (requestId !== refreshId.current) return
        publishActivityReadModel({
            drafts: drafts ?? activityReadModel.drafts,
            queue: queue ?? activityReadModel.queue,
        })
        if (readDrafts) announceGuidedQueueActivityRefresh()
    }, [draftRepository, queueRepository])

    useEffect(() => {
        const refreshWhenVisible = () => {
            if (document.visibilityState !== 'visible') return
            void refresh()
        }

        const refreshForDraftChange = () => { lastDraftRead.current = 0; void refresh() }
        refreshWhenVisible()
        window.addEventListener(GUIDED_DRAFTS_CHANGED_EVENT, refreshForDraftChange)
        document.addEventListener('visibilitychange', refreshWhenVisible)
        const interval = window.setInterval(refreshWhenVisible, QUEUE_REFRESH_MS)
        return () => {
            refreshId.current += 1
            window.clearInterval(interval)
            window.removeEventListener(GUIDED_DRAFTS_CHANGED_EVENT, refreshForDraftChange)
            document.removeEventListener('visibilitychange', refreshWhenVisible)
        }
    }, [refresh])

    return null
}

function CredentialActivityRows() {
    const { t } = useTranslation()
    const slot1Verified = useAuthStore(state => state.isVerified)
    const slot1Enabled = useAuthStore(state => state.slot1Enabled)
    const tier1 = useAuthStore(state => state.tier)
    const slot2Verified = useAuthStore(state => state.isVerified2)
    const slot2Enabled = useAuthStore(state => state.slot2Enabled)
    const tier2 = useAuthStore(state => state.tier2)
    const slots = [
        { ready: slot1Verified && slot1Enabled, tier: tier1 },
        { ready: slot2Verified && slot2Enabled, tier: tier2 },
    ]

    return (
        <section className="px-6 py-5" aria-labelledby="my-work-accounts-heading">
            <h3 id="my-work-accounts-heading" className="text-sm font-semibold text-foreground">
                {t('guided.activity.accounts', '계정별 작업')}
            </h3>
            <div className="mt-3 divide-y divide-border/70">
                {slots.map((slot, index) => (
                    <div key={index} className="flex min-h-16 items-start gap-3 py-3">
                        <Circle
                            className={cn('h-3 w-3 shrink-0', slot.ready ? 'fill-success text-success' : 'text-muted-foreground')}
                            aria-hidden="true"
                        />
                        <div className="min-w-0 flex-1">
                            <p className="break-words text-sm font-medium leading-snug">
                                {t('guided.activity.accountLabel', 'NovelAI 계정 {{number}}', { number: index + 1 })}
                            </p>
                            <p className="mt-1 break-words text-xs leading-snug text-muted-foreground">
                                {slot.ready
                                    ? t('guided.activity.available', '사용 가능 · {{tier}}', { tier: slot.tier ?? '—' })
                                    : t('guided.activity.notReady', '등록 또는 확인 필요')}
                            </p>
                        </div>
                    </div>
                ))}
            </div>
        </section>
    )
}

function DraftActivityRows({ drafts }: { drafts: readonly ActivityDraft[] }) {
    const { t } = useTranslation()
    const closeSupportSheet = useLayoutStore(state => state.closeSupportSheet)
    const repository = useMemo(() => getWorkflowDraftRepository(), [])
    const [pendingDelete, setPendingDelete] = useState<WorkflowDraft | null>(null)
    const [deleting, setDeleting] = useState(false)

    const deleteDraft = async () => {
        if (!pendingDelete) return
        setDeleting(true)
        try {
            const result = await repository.moveToTrash(
                pendingDelete.id,
                pendingDelete.revision,
                Date.now(),
            )
            if (result.status === 'trashed') {
                setPendingDelete(null)
                announceGuidedDraftChange()
                toast({
                    title: t('guided.activity.movedToTrash', '초안을 휴지통으로 옮겼어요.'),
                    variant: 'success',
                })
            } else {
                setPendingDelete(null)
                announceGuidedDraftChange()
                toast({
                    title: t('guided.activity.deleteConflict', '초안이 다른 화면에서 변경되어 삭제하지 않았어요.'),
                    description: t('guided.activity.deleteConflictHelp', '최신 상태를 확인한 뒤 다시 시도해 주세요.'),
                    variant: 'destructive',
                })
            }
        } catch {
            toast({
                title: t('guided.activity.deleteFailed', '초안을 휴지통으로 옮기지 못했어요.'),
                variant: 'destructive',
            })
        } finally {
            setDeleting(false)
        }
    }

    const statusLabel = (status: GuidedActivityStatus) => t(
        `guided.activity.status.${status}`,
        status === 'queued'
            ? '대기 중'
            : status === 'completed'
                ? '완료'
                : status === 'failed'
                    ? '실패'
                    : status === 'cancelled'
                        ? '취소됨'
                        : status === 'needs-attention'
                            ? '확인 필요'
                            : '작성 중',
    )

    return (
        <section className="border-y border-border/55 px-6 py-5" aria-labelledby="my-work-drafts-heading">
            <div className="flex items-center justify-between gap-3">
                <h3 id="my-work-drafts-heading" className="text-sm font-semibold text-foreground">
                    {t('guided.activity.drafts', '작성 중인 초안')}
                </h3>
                <span className="font-mono text-xs text-muted-foreground">{drafts.length}</span>
            </div>
            <div className="mt-3 divide-y divide-border/70">
                {drafts.length === 0 ? (
                    <p className="py-3 text-xs leading-relaxed text-muted-foreground">
                        {t('guided.activity.noDrafts', '새 작업을 시작하면 여기에 기록할게요.')}
                    </p>
                ) : drafts.map(({ draft, status }) => {
                    const title = summarizeWorkflowDraftPrompt(draft)
                        ?? (draft.kind === 'batch-image'
                            ? t('guided.activity.batchUntitled', '이미지 여러 장 만들기')
                            : t('guided.activity.singleUntitled', '이미지 한 장 만들기'))
                    const targetNode = resolveGuidedActivityTargetNode(draft.currentNodeId, status)
                    const stepLabel = t(
                        draft.kind === 'batch-image'
                            ? `guided.batch.steps.${targetNode}.short`
                            : `guided.single.steps.${targetNode}.short`,
                        targetNode,
                    )
                    const href = draft.kind === 'batch-image'
                        ? `/guided-preview/batch/${draft.id}/${targetNode}`
                        : `/guided-preview/work/${draft.id}/${targetNode}`
                    return (
                        <div key={draft.id} className="flex min-h-20 items-start gap-1 py-3">
                            <Link
                                to={href}
                                onClick={closeSupportSheet}
                                className="group flex min-w-0 flex-1 items-start gap-3 focus-ring"
                            >
                                <Clock3 className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-primary" aria-hidden="true" />
                                <span className="min-w-0 flex-1">
                                    <span className="block line-clamp-2 break-words text-sm font-medium leading-snug">{title}</span>
                                    <span className="mt-1 block break-words text-xs leading-snug text-muted-foreground">
                                        {statusLabel(status)} · {stepLabel}
                                        {draft.payload.characterPrompts.items.length > 0
                                            ? ` · ${t('guided.activity.characterCount', '캐릭터 {{count}}명', { count: draft.payload.characterPrompts.items.length })}`
                                            : ''}
                                    </span>
                                </span>
                            </Link>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive"
                                onClick={() => setPendingDelete(draft)}
                                aria-label={t('guided.activity.deleteDraftNamed', '{{name}} 초안 삭제', { name: title })}
                            >
                                <Trash2 className="h-4 w-4" aria-hidden="true" />
                            </Button>
                        </div>
                    )
                })}
            </div>
            <Button asChild variant="ghost" size="sm" className="mt-2 w-full justify-start px-2">
                <Link to="/guided-preview" onClick={closeSupportSheet}>
                    <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
                    {t('guided.activity.startAnother', '다른 작업 시작')}
                </Link>
            </Button>
            <ConfirmDialog
                open={pendingDelete !== null}
                onOpenChange={open => { if (!open && !deleting) setPendingDelete(null) }}
                title={t('guided.activity.confirmDeleteTitle', '이 초안을 삭제할까요?')}
                description={t('guided.activity.confirmDeleteDescription', '초안은 휴지통으로 이동하며 30일 동안 복원할 수 있어요. 실행 중인 대기열 작업은 취소되지 않습니다.')}
                confirmText={t('guided.activity.moveToTrash', '휴지통으로 이동')}
                cancelText={t('common.cancel', '취소')}
                variant="destructive"
                onConfirm={deleteDraft}
            />
        </section>
    )
}

export function MyWorkActivity({
    headingIsDecorative = false,
    queueTarget = '/queue',
}: {
    headingIsDecorative?: boolean
    queueTarget?: string
}) {
    const { t } = useTranslation()
    const readModel = useMyWorkActivityReadModel()

    return (
        <div className="flex h-full min-h-0 flex-col" data-testid="my-work-activity">
            <div className="px-6 pb-4 pt-6" aria-hidden={headingIsDecorative || undefined}>
                <div className="flex items-center gap-2">
                    <BriefcaseBusiness className="h-4 w-4 text-primary" aria-hidden="true" />
                    <h2 className="text-base font-semibold">{t('guided.activity.title', '내 작업')}</h2>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                    {t('guided.activity.description', '화면을 옮겨도 실행 상태를 여기서 확인할 수 있어요.')}
                </p>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
                <DraftActivityRows drafts={readModel.drafts} />
                <QueueActivityLinkView
                    summary={readModel.queue}
                    testId="my-work-queue-activity"
                    to={queueTarget}
                />
                <CredentialActivityRows />
            </div>
        </div>
    )
}
