import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
    Activity,
    AlertCircle,
    EllipsisVertical,
    KeyRound,
    ListPlus,
    Pause,
    Play,
    RotateCcw,
    SkipForward,
    XCircle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { SceneQueueSelectionDialog } from '@/components/queue/SceneQueueSelectionDialog'
import { SceneQueueReviewDialog } from '@/components/queue/SceneQueueReviewDialog'
import type {
    FulfillmentIssue,
    GenerationFulfillmentProjection,
} from '@/application/generation/generation-fulfillment'
import { getRuntimeGenerationRun } from '@/adapters/generation/indexeddb-generation-run-reader'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type {
    GenerationBatch,
    GenerationBatchProjectionMeta,
    GenerationBatchSummary,
    GenerationJobProjection,
    GenerationJobProjectionWindow,
    GenerationJobState,
    QueueFailurePolicy,
} from '@/domain/queue/types'
import { isTerminalJobState } from '@/domain/queue/state-machine'
import { calculateFixedVirtualRange } from '@/lib/virtualization/fixed-range'
import { cn } from '@/lib/utils'
import { reportDiagnostic } from '@/services/diagnostics/error-registry'
import { getRuntimeQueueRepository } from '@/services/queue/indexeddb-queue-repository'
import { getRuntimeQueueRecoveryCommandAdapter } from '@/services/queue/queue-recovery-command-adapter'
import { QueueRecoveryActionGate } from '@/services/queue/queue-recovery-action-gate'
import { getRuntimeDurableQueueCoordinator } from '@/services/queue/runtime'
import {
    enqueueReviewedSceneQueue,
    prepareCurrentSceneQueueReview,
    prepareSceneQueueReview,
    type PreparedSceneQueueReview,
    type SceneQueueSubmission,
    type SceneQueueTarget,
} from '@/services/queue/scene-queue-adapter'
import { useDiagnosticsStore } from '@/stores/diagnostics-store'
import { useQueueStore } from '@/stores/queue-store'
import { useSceneStore } from '@/stores/scene-store'
import { useAuthStore } from '@/stores/auth-store'
import { isSceneQueueReviewConflict } from '@/application/scene/scene-queue-review'

const QUEUE_ROW_HEIGHT = 96
const QUEUE_OVERSCAN = 5
const STATUS_FILTERS: readonly ('all' | GenerationJobState)[] = [
    'all', 'queued', 'leased', 'running', 'succeeded', 'failed',
    'cancelled', 'skipped', 'blocked', 'recovering',
]

function emptySummary(batchId: string): GenerationBatchSummary {
    return {
        batchId,
        total: 0,
        completed: 0,
        progressCurrent: 0,
        progressTotal: 0,
        states: {
            queued: 0, leased: 0, running: 0, succeeded: 0, failed: 0,
            cancelled: 0, skipped: 0, blocked: 0, recovering: 0,
        },
        recentCompletedAt: [],
    }
}

export function calculateQueueRate(summary: GenerationBatchSummary, nowMs: number): {
    throughput: number
    eta: number | null
} {
    const timestamps = summary.recentCompletedAt
        .map(value => Date.parse(value))
        .filter(value => Number.isFinite(value) && value <= nowMs)
    if (timestamps.length === 0) return { throughput: 0, eta: null }
    const oldest = Math.min(...timestamps)
    const windowMinutes = Math.max(1 / 60, Math.min(60, (nowMs - oldest) / 60_000))
    const throughput = Math.min(10_000, timestamps.length / windowMinutes)
    const remaining = Math.max(0, summary.total - summary.completed)
    const eta = throughput <= 0 ? null : Math.min(86_400, Math.ceil((remaining / throughput) * 60))
    return { throughput, eta }
}

function retryIdentity(batchId: string): string {
    const safeBatch = batchId.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 96)
    return `retry-${safeBatch}`
}

export default function QueueCenter() {
    const { t } = useTranslation()
    const repository = useMemo(() => getRuntimeQueueRepository(), [])
    const coordinator = useMemo(() => getRuntimeDurableQueueCoordinator(), [])
    const executionAuthority = useQueueStore(state => state.executionAuthority)
    const selectedBatchId = useQueueStore(state => state.selectedBatchId)
    const setExecutionAuthority = useQueueStore(state => state.setExecutionAuthority)
    const setSelectedBatchId = useQueueStore(state => state.setSelectedBatchId)
    const scenePresets = useSceneStore(state => state.presets)
    const activeTokenCount = useAuthStore(state => state.getActiveTokens().length)
    const requestTokenEntry = useAuthStore(state => state.requestTokenEntry)
    const legacyQueueCount = useSceneStore(state => {
        const activePreset = state.presets.find(preset => preset.id === state.activePresetId)
        return activePreset?.scenes.reduce((total, scene) => total + scene.queueCount, 0) ?? 0
    })
    const diagnostics = useDiagnosticsStore(state => state.events)
    const openDrawer = useDiagnosticsStore(state => state.openDrawer)
    const viewportRef = useRef<HTMLDivElement>(null)
    const refreshId = useRef(0)
    const windowRequestId = useRef(0)
    const fulfillmentRequestId = useRef(0)
    const pendingFocusIndex = useRef<number | null>(null)
    const recoveryGate = useRef(new QueueRecoveryActionGate())
    const selectedBatchIdRef = useRef<string | null>(selectedBatchId)
    selectedBatchIdRef.current = selectedBatchId
    const [batches, setBatches] = useState<GenerationBatch[]>([])
    const [projectionMeta, setProjectionMeta] = useState<GenerationBatchProjectionMeta | null>(null)
    const [jobWindow, setJobWindow] = useState<GenerationJobProjectionWindow | null>(null)
    const [statusFilter, setStatusFilter] = useState<'all' | GenerationJobState>('all')
    const [scrollTop, setScrollTop] = useState(0)
    const [viewportHeight, setViewportHeight] = useState(560)
    const [focusedIndex, setFocusedIndex] = useState(0)
    const [busy, setBusy] = useState(false)
    const [conversionOpen, setConversionOpen] = useState(false)
    const [sceneSelectionOpen, setSceneSelectionOpen] = useState(false)
    const [legacySceneReview, setLegacySceneReview] = useState<PreparedSceneQueueReview | null>(null)
    const [fulfillment, setFulfillment] = useState<GenerationFulfillmentProjection | null>(null)
    const [fulfillmentLoading, setFulfillmentLoading] = useState(false)
    const [fulfillmentError, setFulfillmentError] = useState(false)
    const [destructiveIssue, setDestructiveIssue] = useState<FulfillmentIssue | null>(null)

    const selectedBatch = batches.find(batch => batch.id === selectedBatchId) ?? null
    const summary = projectionMeta?.batchId === selectedBatchId ? projectionMeta.summary : null
    // The durable batch aggregate is independent from the visible state filter,
    // so retry controls cannot be accidentally hidden by a narrowed viewport.
    const hasRetryableFailures = selectedBatch !== null
        && summary !== null
        && summary.batchId === selectedBatch.id
        && summary.states.failed > 0

    const refresh = useCallback(async () => {
        const requestId = ++refreshId.current
        try {
            const nextBatches = await repository.listBatches()
            if (requestId !== refreshId.current) return
            const batchId = selectedBatchId !== null && nextBatches.some(batch => batch.id === selectedBatchId)
                ? selectedBatchId
                : nextBatches[0]?.id ?? null
            if (batchId !== selectedBatchId) setSelectedBatchId(batchId)
            if (batchId === null) {
                setBatches(nextBatches)
                setProjectionMeta(null)
                setJobWindow(null)
                return
            }
            // Visible-tab polling reads one durable batch record. Job rows stay
            // untouched until this revision changes or the virtual window moves.
            const nextMeta = await repository.getBatchProjectionMeta(batchId)
            if (requestId !== refreshId.current) return
            setBatches(nextBatches)
            setProjectionMeta(current => (
                current?.batchId === nextMeta.batchId && current.revision === nextMeta.revision
                    ? current
                    : nextMeta
            ))
        } catch (error) {
            reportDiagnostic(error, { operation: 'queue-center.refresh', stage: 'read', category: 'persistence' })
        }
    }, [repository, selectedBatchId, setSelectedBatchId])

    useEffect(() => {
        void refresh()
        // Background tabs pause even the small revision poll and refresh once
        // visible again, preventing hidden Queue Center work.
        const refreshWhenVisible = () => {
            if (document.visibilityState === 'visible') void refresh()
        }
        const interval = window.setInterval(refreshWhenVisible, 1_000)
        document.addEventListener('visibilitychange', refreshWhenVisible)
        return () => {
            window.clearInterval(interval)
            document.removeEventListener('visibilitychange', refreshWhenVisible)
        }
    }, [refresh])

    useEffect(() => {
        fulfillmentRequestId.current += 1
        setFulfillment(null)
        setFulfillmentLoading(false)
        setFulfillmentError(false)
    }, [selectedBatchId])

    // This joins several durable authorities, so Queue polling never calls it;
    // opening or refreshing the compact detail is the explicit query boundary.
    const loadFulfillment = useCallback(async () => {
        if (selectedBatchId === null) return
        const requestId = ++fulfillmentRequestId.current
        setFulfillmentLoading(true)
        setFulfillmentError(false)
        try {
            const projection = await getRuntimeGenerationRun(selectedBatchId)
            if (requestId !== fulfillmentRequestId.current
                || selectedBatchIdRef.current !== selectedBatchId) return
            setFulfillment(projection)
            setFulfillmentError(projection === null)
        } catch (error) {
            if (requestId !== fulfillmentRequestId.current) return
            setFulfillmentError(true)
            reportDiagnostic(error, {
                operation: 'queue-center.fulfillment',
                stage: 'read',
                category: 'persistence',
            })
        } finally {
            if (requestId === fulfillmentRequestId.current) setFulfillmentLoading(false)
        }
    }, [selectedBatchId])

    useEffect(() => {
        const viewport = viewportRef.current
        if (viewport === null) return
        const update = () => setViewportHeight(viewport.clientHeight || 560)
        update()
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
        observer?.observe(viewport)
        return () => observer?.disconnect()
    }, [])

    const filteredTotal = summary === null
        ? 0
        : statusFilter === 'all'
            ? summary.total
            : summary.states[statusFilter]
    useEffect(() => {
        setFocusedIndex(current => Math.max(0, Math.min(current, filteredTotal - 1)))
        const viewport = viewportRef.current
        if (viewport !== null) {
            const maximum = Math.max(0, filteredTotal * QUEUE_ROW_HEIGHT - viewport.clientHeight)
            if (viewport.scrollTop > maximum) viewport.scrollTo({ top: maximum, behavior: 'auto' })
        }
    }, [filteredTotal])
    const windowRange = useMemo(() => calculateFixedVirtualRange({
        itemCount: filteredTotal,
        scrollTop,
        viewportHeight,
        rowHeight: QUEUE_ROW_HEIGHT,
        overscan: QUEUE_OVERSCAN,
    }), [filteredTotal, scrollTop, viewportHeight])
    const requestedWindow = useMemo(() => ({
        start: Math.max(0, windowRange.start - QUEUE_OVERSCAN * 2),
        end: Math.min(filteredTotal, windowRange.end + QUEUE_OVERSCAN * 2),
    }), [filteredTotal, windowRange.end, windowRange.start])

    useEffect(() => {
        if (selectedBatchId === null || projectionMeta === null || filteredTotal === 0) {
            // Invalidate an in-flight range before it can repopulate a batch or
            // filter the user has already left.
            windowRequestId.current += 1
            setJobWindow(null)
            return
        }
        const state = statusFilter === 'all' ? null : statusFilter
        const existing = jobWindow
        const coversRange = existing !== null
            && existing.batchId === selectedBatchId
            && existing.revision === projectionMeta.revision
            && existing.state === state
            && existing.offset <= windowRange.start
            && existing.offset + existing.items.length >= windowRange.end
        if (coversRange) return

        const requestId = ++windowRequestId.current
        void repository.listJobProjectionWindow({
            batchId: selectedBatchId,
            ...(state === null ? {} : { state }),
            offset: requestedWindow.start,
            limit: Math.max(1, requestedWindow.end - requestedWindow.start),
        }).then(nextWindow => {
            if (requestId !== windowRequestId.current || selectedBatchIdRef.current !== nextWindow.batchId) return
            setProjectionMeta(current => (
                current?.batchId === nextWindow.batchId && current.revision >= nextWindow.revision
                    ? current
                    : current !== null && current.batchId !== nextWindow.batchId
                        ? current
                    : {
                        batchId: nextWindow.batchId,
                        revision: nextWindow.revision,
                        summary: nextWindow.summary,
                    }
            ))
            setJobWindow(nextWindow)
        }).catch(error => {
            if (requestId !== windowRequestId.current) return
            reportDiagnostic(error, { operation: 'queue-center.window', stage: 'read', category: 'persistence' })
        })
    }, [
        filteredTotal,
        jobWindow,
        projectionMeta,
        repository,
        requestedWindow.end,
        requestedWindow.start,
        selectedBatchId,
        statusFilter,
        windowRange.end,
        windowRange.start,
    ])

    const visibleWindowItems = useMemo(() => {
        if (jobWindow === null
            || jobWindow.batchId !== selectedBatchId
            || jobWindow.revision !== projectionMeta?.revision) return []
        const start = Math.max(windowRange.start, jobWindow.offset)
        const end = Math.min(windowRange.end, jobWindow.offset + jobWindow.items.length)
        return jobWindow.items.slice(start - jobWindow.offset, end - jobWindow.offset).map((job, offset) => ({
            job,
            index: start + offset,
        }))
    }, [jobWindow, projectionMeta?.revision, selectedBatchId, windowRange.end, windowRange.start])

    useEffect(() => {
        const pending = pendingFocusIndex.current
        if (pending === null
            || !visibleWindowItems.some(item => item.index === pending)) return
        pendingFocusIndex.current = null
        const timeout = window.setTimeout(() => {
            viewportRef.current?.querySelector<HTMLElement>(`[data-queue-index="${pending}"]`)?.focus()
        }, 0)
        return () => window.clearTimeout(timeout)
    }, [visibleWindowItems])

    const rate = calculateQueueRate(summary ?? emptySummary(selectedBatchId ?? ''), Date.now())

    const runAction = async (
        action: () => Promise<unknown>,
        rethrow: (error: unknown) => boolean = () => false,
    ) => {
        setBusy(true)
        try {
            await action()
            await refresh()
        } catch (error) {
            reportDiagnostic(error, { operation: 'queue-center.action', stage: 'mutate', category: 'persistence' })
            if (rethrow(error)) throw error
        } finally {
            setBusy(false)
        }
    }

    const retryFailed = async () => {
        if (selectedBatch === null || !hasRetryableFailures) return
        const identity = retryIdentity(selectedBatch.id)
        await runAction(() => repository.retryFailedJobs({
            sourceBatchId: selectedBatch.id,
            targetBatch: {
                id: identity,
                workflow: selectedBatch.workflow,
                createdAt: new Date().toISOString(),
                failurePolicy: selectedBatch.failurePolicy,
                origin: 'retry',
                idempotencyKey: identity,
            },
        }))
    }

    const convertLegacyQueue = async () => {
        await runAction(async () => {
            setLegacySceneReview(await prepareCurrentSceneQueueReview())
        })
    }

    const runFulfillmentAction = (issue: FulfillmentIssue, preserveRejection = false): Promise<void> => {
        const key = `${issue.jobId}:${issue.action.kind}`
        if (issue.action.kind === 'review-provider-unknown') {
            openDrawer()
            return Promise.resolve()
        }
        return recoveryGate.current.run(key, async () => {
            if (busy) throw new Error('Queue Center is busy')
            setBusy(true)
            try {
                await getRuntimeQueueRecoveryCommandAdapter().execute(issue)
                await Promise.all([refresh(), loadFulfillment()])
            } catch (error) {
                reportDiagnostic(error, { operation: 'queue-center.recovery', stage: 'mutate', category: 'persistence' })
                if (preserveRejection) throw error
            } finally {
                setBusy(false)
            }
        })
    }

    const prepareSelectedScenes = async (targets: readonly SceneQueueTarget[]): Promise<PreparedSceneQueueReview | null> => {
        let prepared: PreparedSceneQueueReview | null = null
        await runAction(async () => {
            prepared = await prepareSceneQueueReview(targets)
        })
        return prepared
    }

    const approveSelectedScenes = async (submission: SceneQueueSubmission): Promise<boolean> => {
        let enqueued = false
        await runAction(async () => {
            const result = await enqueueReviewedSceneQueue(submission)
            setSelectedBatchId(result.batch.id)
            enqueued = true
        }, isSceneQueueReviewConflict)
        return enqueued
    }

    const replanLegacySceneReview = async (): Promise<boolean> => {
        let next: PreparedSceneQueueReview | null = null
        await runAction(async () => {
            next = await prepareCurrentSceneQueueReview()
            setLegacySceneReview(next)
        })
        return next !== null
    }

    const focusRow = (index: number) => {
        if (filteredTotal === 0) return
        const bounded = Math.max(0, Math.min(filteredTotal - 1, index))
        pendingFocusIndex.current = bounded
        setFocusedIndex(bounded)
        viewportRef.current?.scrollTo({ top: bounded * QUEUE_ROW_HEIGHT, behavior: 'auto' })
    }

    const handleRowKey = (event: React.KeyboardEvent, index: number) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault()
            focusRow(index + 1)
        } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            focusRow(index - 1)
        } else if (event.key === 'Home') {
            event.preventDefault()
            focusRow(0)
        } else if (event.key === 'End') {
            event.preventDefault()
            focusRow(filteredTotal - 1)
        }
    }

    const showDiagnostic = (job: GenerationJobProjection) => {
        const eventId = job.lastDiagnosticEventId
        const isRecent = eventId !== null && diagnostics.some(event => event.eventId === eventId)
        openDrawer(isRecent ? eventId : undefined)
    }

    const visibleSummary = summary ?? emptySummary(selectedBatchId ?? '')
    const credentialBlocked = activeTokenCount === 0
        && visibleSummary.states.queued + visibleSummary.states.leased + visibleSummary.states.recovering > 0
    const progressPercent = visibleSummary.total === 0
        ? 0
        : Math.round((visibleSummary.progressCurrent / Math.max(1, visibleSummary.progressTotal)) * 100)
    const failureCount = visibleSummary.states.failed + visibleSummary.states.blocked
    const statusLabel = (state: 'all' | GenerationJobState) => t(
        `queue.status.${state}`,
        t('queue.status.unknown', 'Status unavailable'),
    )
    const workflowLabel = (workflow: GenerationJobProjection['workflow']) => {
        switch (workflow) {
            case 'main': return t('queue.workflow.main', 'Main image')
            case 'scene': return t('queue.workflow.scene', 'Scene image')
            case 'style-lab': return t('queue.workflow.styleLab', 'Style Lab')
        }
    }
    // Projection stages are executor-owned IDs shared with queue persistence.
    // Keep those IDs out of the authoring UI while providing a useful fallback
    // for a newer executor stage that this client has not learned yet.
    const stageLabel = (stage: string) => {
        switch (stage) {
            case 'queued': return t('queue.stage.queued', 'Waiting')
            case 'transport': return t('queue.stage.transport', 'Sending request')
            case 'stream': return t('queue.stage.stream', 'Receiving preview')
            case 'executor': return t('queue.stage.executor', 'Processing')
            default: return t('queue.stage.processing', 'Processing')
        }
    }
    const formatEta = (seconds: number | null): string => {
        if (seconds === null) return t('queue.eta.unknown', '—')
        if (seconds < 60) return t('queue.eta.seconds', '{{count}} sec', { count: seconds })
        if (seconds < 3_600) return t('queue.eta.minutes', '{{count}} min', { count: Math.ceil(seconds / 60) })
        return t('queue.eta.hours', '{{count}} hr', { count: Math.ceil(seconds / 3_600) })
    }
    const fulfillmentStateLabel = (state: string): string => {
        const labels: Record<string, string> = {
            'not-required': t('queue.fulfillment.state.notRequired', 'Not required'),
            'not-evaluated': t('queue.fulfillment.state.notEvaluated', 'Not evaluated'),
            pending: t('queue.fulfillment.state.pending', 'Pending'),
            succeeded: t('queue.fulfillment.state.succeeded', 'Succeeded'),
            failed: t('queue.fulfillment.state.failed', 'Failed'),
            uncertain: t('queue.fulfillment.state.uncertain', 'Uncertain'),
            unavailable: t('queue.fulfillment.state.unavailable', 'Unavailable'),
            'needs-review': t('queue.fulfillment.state.needsReview', 'Needs review'),
            accepted: t('queue.fulfillment.state.accepted', 'Accepted'),
            rejected: t('queue.fulfillment.state.rejected', 'Rejected'),
            planned: t('queue.fulfillment.state.planned', 'Planned'),
            running: t('queue.fulfillment.state.running', 'Running'),
            partial: t('queue.fulfillment.state.partial', 'Partial'),
            'needs-attention': t('queue.fulfillment.state.needsAttention', 'Needs attention'),
            delivered: t('queue.fulfillment.state.delivered', 'Delivered'),
        }
        return labels[state] ?? t('queue.status.unknown', 'Status unavailable')
    }
    const fulfillmentIssueLabel = (issue: FulfillmentIssue): string => {
        if (issue.code === 'R2_DELIVERY_MISSING') {
            return t('queue.fulfillment.issue.r2Missing', 'Saved on this device · R2 delivery needs to be queued')
        }
        if (issue.code === 'R2_DELIVERY_FAILED') {
            return t('queue.fulfillment.issue.r2Failed', 'Saved on this device · R2 delivery needs attention')
        }
        if (issue.code === 'SCENE_LINK_PENDING') {
            return t('queue.fulfillment.issue.sceneLinkPending', 'Saved on this device · Scene link needs retry')
        }
        if (issue.code === 'OUTPUT_RESERVATION_CONFLICT') {
            if (issue.action.kind === 'retry-storage') {
                return t('queue.fulfillment.issue.storagePending', 'Provider result retained · Storage commit needs retry')
            }
            if (issue.action.kind === 'discard-result-and-abandon-reservation') {
                return t('queue.fulfillment.issue.spooledResult', 'Received result retained · Output reservation is still held')
            }
            if (issue.action.kind === 'review-provider-unknown') {
                return t('queue.fulfillment.issue.providerUnknown', 'Provider outcome is uncertain · No automatic retry')
            }
            if (issue.action.kind === 'abandon-reservation') {
                return t('queue.fulfillment.issue.reservationHeld', 'Inactive output reservation is still held')
            }
            return t('queue.fulfillment.issue.outputReservationConflict', 'Output reservation conflict · Replan required')
        }
        return t('queue.fulfillment.issue.directoryAuthorizationRequired', 'Output folder access is required')
    }
    const fulfillmentActionLabel = (issue: FulfillmentIssue): string => {
        const labels: Record<FulfillmentIssue['action']['kind'], string> = {
            replan: t('queue.fulfillment.action.replan', 'Replan'),
            'grant-directory-access': t('queue.fulfillment.action.grantDirectoryAccess', 'Grant folder access'),
            'retry-storage': t('queue.fulfillment.action.retryStorage', 'Retry storage only'),
            'retry-scene-link': t('queue.fulfillment.action.retrySceneLink', 'Retry Scene link'),
            'retry-r2-release': t('queue.fulfillment.action.retryR2Release', 'Resume R2 delivery'),
            'abandon-reservation': t('queue.fulfillment.action.abandonReservation', 'Release reservation'),
            'discard-result-and-abandon-reservation': t('queue.fulfillment.action.discardResult', 'Discard result and release reservation'),
            'review-provider-unknown': t('queue.fulfillment.action.reviewProviderUnknown', 'Review Provider status'),
        }
        return labels[issue.action.kind]
    }

    return (
        <main
            className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background"
            style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
            data-testid="queue-center-ready"
        >
            <header className="shrink-0 border-b border-border px-3 py-3 sm:px-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                        <h1 className="text-xl font-semibold">{t('queue.title', 'Queue Center')}</h1>
                        <p className="text-xs text-muted-foreground">
                            {executionAuthority === 'durable'
                                ? t('queue.executionCurrent', 'Durable queue')
                                : t('queue.executionPrevious', 'Existing Scene queue')}
                        </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Button
                            variant="outline"
                            disabled={busy || scenePresets.every(preset => preset.scenes.length === 0)}
                            onClick={() => setSceneSelectionOpen(true)}
                        >
                            <ListPlus className="mr-2 h-4 w-4" />
                            {t('queue.selectScenes', 'Select scenes from folders')}
                        </Button>
                        <label className="text-xs text-muted-foreground">
                            <span className="sr-only">{t('queue.executionMode', 'Execution method')}</span>
                            <select
                                value={executionAuthority}
                                onChange={event => setExecutionAuthority(event.target.value as 'durable' | 'legacy')}
                                className="min-h-11 rounded-control border border-input bg-canvas px-3 text-sm text-foreground"
                                aria-label={t('queue.executionMode', 'Execution method')}
                            >
                                <option value="durable">{t('queue.executionCurrent', 'Durable queue')}</option>
                                <option value="legacy">{t('queue.executionPrevious', 'Existing Scene queue')}</option>
                            </select>
                        </label>
                        <select
                            value={selectedBatchId ?? ''}
                            onChange={event => setSelectedBatchId(event.target.value || null)}
                            className="min-h-11 max-w-56 rounded-control border border-input bg-canvas px-3 text-sm"
                            aria-label={t('queue.batch', 'Job group')}
                        >
                            {batches.length === 0 && <option value="">{t('queue.noBatches', 'No job groups')}</option>}
                            {batches.map(batch => <option key={batch.id} value={batch.id}>{batch.id}</option>)}
                        </select>
                        <select
                            value={selectedBatch?.failurePolicy ?? 'continue'}
                            disabled={selectedBatch === null || busy}
                            onChange={event => {
                                if (selectedBatch === null) return
                                void runAction(() => repository.setBatchControl({
                                    batchId: selectedBatch.id,
                                    state: selectedBatch.state,
                                    now: new Date().toISOString(),
                                    reason: selectedBatch.pauseReason,
                                    failurePolicy: event.target.value as QueueFailurePolicy,
                                }))
                            }}
                            className="min-h-11 rounded-control border border-input bg-canvas px-3 text-sm"
                            aria-label={t('queue.failurePolicy', 'Error handling')}
                        >
                            <option value="continue">{t('queue.continueOnError', 'Continue after errors')}</option>
                            <option value="pause-on-fatal">{t('queue.pauseOnFatal', 'Pause on critical error')}</option>
                            <option value="stop-on-first-error">{t('queue.stopOnFirstError', 'Stop on first error')}</option>
                        </select>
                        <Button
                            variant="outline"
                            disabled={selectedBatch === null || busy}
                            onClick={() => {
                                if (selectedBatch === null) return
                                void runAction(() => repository.setBatchControl({
                                    batchId: selectedBatch.id,
                                    state: selectedBatch.state === 'active' ? 'paused' : 'active',
                                    now: new Date().toISOString(),
                                    reason: selectedBatch.state === 'active' ? 'user' : null,
                                }))
                            }}
                        >
                            {selectedBatch?.state === 'active'
                                ? <><Pause className="mr-2 h-4 w-4" />{t('queue.pause', 'Pause')}</>
                                : <><Play className="mr-2 h-4 w-4" />{t('queue.resume', 'Resume')}</>}
                        </Button>
                        <Button variant="outline" disabled={busy || !hasRetryableFailures} onClick={() => void retryFailed()}>
                            <RotateCcw className="mr-2 h-4 w-4" />{t('queue.retryFailed', 'Retry failed items')}
                        </Button>
                        <Button
                            variant="destructive"
                            disabled={selectedBatch === null || busy}
                            onClick={() => selectedBatch && void runAction(() => coordinator.cancelBatch(selectedBatch.id))}
                        >
                            <XCircle className="mr-2 h-4 w-4" />{t('queue.cancelAll', 'Cancel all')}
                        </Button>
                    </div>
                </div>
            </header>

            {selectedBatch?.pauseReason === 'r2-readiness' && (
                <p role="status" className="border-b border-border bg-muted/30 px-3 py-2 text-sm sm:px-5">
                    {t('queue.r2ReadinessPause', 'Required R2 delivery is waiting for its runtime or credential. Restore access in R2 settings, then resume this job group.')}
                </p>
            )}
            {legacyQueueCount > 0 && (
                <section
                    className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/30 px-3 py-2 sm:px-5"
                    data-testid="legacy-queue-migration"
                    aria-label={t('queue.existingQueueTransfer', 'Existing Scene queue transfer')}
                >
                    <div className="min-w-0 text-xs">
                        <p className="font-medium">
                            {t('queue.legacyPending', '{{count}} existing Scene items are waiting.', {
                                count: legacyQueueCount,
                            })}
                        </p>
                        <p className="text-muted-foreground">
                            {t('queue.legacyRetained', 'Transfer records current parameters and keeps existing item counts available for rollback.')}
                        </p>
                    </div>
                    <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => setConversionOpen(true)}
                        className="min-h-11"
                    >
                        {t('queue.convertLegacy', 'Move to durable queue')}
                    </Button>
                </section>
            )}

            {credentialBlocked && (
                <section
                    className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-warning/30 bg-warning/10 px-3 py-3 sm:px-5"
                    role="status"
                    data-testid="queue-credential-required"
                >
                    <div className="min-w-0 text-sm">
                        <p className="font-semibold text-warning">
                            {t('credentialVault.unlockRequired', 'API 토큰 잠금 해제 필요')}
                        </p>
                        <p className="text-xs text-muted-foreground">
                            {t('settingsPage.api.addTokenToContinue', 'NovelAI API 토큰을 등록하거나 활성화하면 대기 중인 생성이 자동으로 시작됩니다.')}
                        </p>
                    </div>
                    <Button type="button" variant="outline" className="min-h-11" onClick={requestTokenEntry}>
                        <KeyRound className="mr-2 h-4 w-4" />
                        {t('settingsPage.api.manage', 'API 토큰 관리')}
                    </Button>
                </section>
            )}

            <section
                className="shrink-0 border-b border-border px-3 py-3 sm:px-5"
                aria-label={t('queue.summary', 'Queue summary')}
            >
                <dl className="grid grid-cols-3 gap-x-4 gap-y-2 text-xs sm:grid-cols-6 lg:grid-cols-10">
                    {(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped', 'blocked'] as const).map(state => (
                        <div key={state} className="min-w-0">
                            <dt className="truncate text-muted-foreground">{statusLabel(state)}</dt>
                            <dd className="font-mono text-sm font-semibold">{visibleSummary.states[state]}</dd>
                        </div>
                    ))}
                    <div><dt className="text-muted-foreground">{t('queue.progress', 'Progress')}</dt><dd className="font-mono text-sm">{progressPercent}%</dd></div>
                    <div><dt className="text-muted-foreground">{t('queue.speed', 'Processing speed')}</dt><dd className="font-mono text-sm">{t('queue.ratePerMinute', '{{rate}}/min', { rate: rate.throughput.toFixed(1) })}</dd></div>
                    <div><dt className="text-muted-foreground">{t('queue.remainingTime', 'Time remaining')}</dt><dd className="font-mono text-sm">{formatEta(rate.eta)}</dd></div>
                </dl>
                <div
                    className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"
                    role="progressbar"
                    aria-label={t('queue.totalProgress', 'Total queue progress')}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progressPercent}
                >
                    <div className="h-full bg-primary" style={{ width: `${progressPercent}%` }} />
                </div>
                {failureCount > 0 && (
                    <Button
                        variant="ghost"
                        className="mt-2 min-h-11 px-2 text-destructive"
                        onClick={() => openDrawer()}
                    >
                        <AlertCircle className="mr-2 h-4 w-4" />
                        {t('queue.failureSummary', '{{count}} failed or blocked · Open diagnostics', {
                            count: failureCount,
                        })}
                    </Button>
                )}
            </section>

            {selectedBatchId !== null && (
                <details
                    className="shrink-0 border-b border-border bg-muted/10"
                    data-testid="queue-fulfillment-summary"
                    onToggle={event => {
                        if (event.currentTarget.open
                            && fulfillment?.runId !== selectedBatchId
                            && !fulfillmentLoading) void loadFulfillment()
                    }}
                >
                    <summary className="cursor-pointer px-3 py-3 text-sm font-medium sm:px-5">
                        {t('queue.fulfillment.title', 'Fulfillment stages')}
                        {fulfillment !== null && (
                            <span className="ml-2 text-xs text-muted-foreground">
                                {fulfillmentStateLabel(fulfillment.overall)}
                            </span>
                        )}
                    </summary>
                    <div className="px-3 pb-3 sm:px-5">
                        {fulfillmentLoading ? (
                            <p className="text-xs text-muted-foreground">{t('common.loading', 'Loading...')}</p>
                        ) : fulfillmentError || fulfillment === null ? (
                            <p className="text-xs text-muted-foreground">
                                {t('queue.fulfillment.unavailable', 'Fulfillment evidence is unavailable.')}
                            </p>
                        ) : (
                            <div className="space-y-2">
                                <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
                                    {([
                                        ['interpretation', t('queue.fulfillment.interpretation', 'Interpretation'), fulfillment.interpretation.state],
                                        ['provider', t('queue.fulfillment.provider', 'Provider'), fulfillment.provider.state],
                                        ['storage', t('queue.fulfillment.storage', 'Storage'), fulfillment.storage.state],
                                        ['release', t('queue.fulfillment.release', 'Release'), fulfillment.release.state],
                                        ['acceptance', t('queue.fulfillment.acceptance', 'Acceptance'), fulfillment.acceptance.state],
                                    ] as const).map(([key, label, state]) => (
                                        <div key={key} className="rounded-control border border-border bg-card px-2 py-2">
                                            <dt className="text-muted-foreground">{label}</dt>
                                            <dd className="mt-1 font-medium">{fulfillmentStateLabel(state)}</dd>
                                        </div>
                                    ))}
                                </dl>
                                {fulfillment.jobs.some(job => (job.release.jobIds?.length ?? 0) > 0) && (
                                    <details className="text-xs text-muted-foreground">
                                        <summary>{t('queue.fulfillment.deliveryJobs', 'R2 delivery jobs')}</summary>
                                        <ul className="mt-1 break-all">
                                            {fulfillment.jobs.flatMap(job => job.release.jobIds ?? []).map(id => <li key={id}>{id}</li>)}
                                        </ul>
                                    </details>
                                )}
                                {fulfillment.issues.length > 0 && (
                                    <div className="rounded-control border border-warning/30 bg-warning/10 px-3 py-2 text-xs" role="status">
                                        <p className="font-medium">{t('queue.fulfillment.issue.title', 'Recovery actions')}</p>
                                        <ul className="mt-1 space-y-1 text-muted-foreground">
                                            {fulfillment.issues.map(issue => (
                                                <li key={`${issue.jobId}:${issue.code}:${issue.action.kind}`} className="flex flex-wrap items-center gap-2">
                                                    <Button
                                                        type="button"
                                                        variant={issue.action.requiresHuman ? 'outline' : 'default'}
                                                        size="sm"
                                                        disabled={busy}
                                                        onClick={() => {
                                                            if (issue.action.kind === 'abandon-reservation'
                                                                || issue.action.kind === 'discard-result-and-abandon-reservation') {
                                                                setDestructiveIssue(issue)
                                                                return
                                                            }
                                                            void runFulfillmentAction(issue).catch(() => undefined)
                                                        }}
                                                    >
                                                        {fulfillmentActionLabel(issue)}
                                                    </Button>
                                                    <span>{fulfillmentIssueLabel(issue)}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                            </div>
                        )}
                        <Button
                            type="button"
                            variant="ghost"
                            className="mt-2 min-h-11 px-2"
                            disabled={fulfillmentLoading}
                            onClick={() => void loadFulfillment()}
                        >
                            <RotateCcw className="mr-2 h-4 w-4" />
                            {t('queue.fulfillment.refresh', 'Refresh stages')}
                        </Button>
                    </div>
                </details>
            )}

            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 sm:px-5">
                <Activity className="h-4 w-4 text-muted-foreground" />
                <select
                    value={statusFilter}
                    onChange={event => setStatusFilter(event.target.value as typeof statusFilter)}
                    className="min-h-11 rounded-control border border-input bg-canvas px-3 text-sm"
                    aria-label={t('queue.filter', 'Status filter')}
                >
                    {STATUS_FILTERS.map(status => <option key={status} value={status}>{statusLabel(status)}</option>)}
                </select>
                <span className="text-xs text-muted-foreground">{t('queue.jobs', '{{count}} jobs', { count: filteredTotal })}</span>
            </div>

            <div
                ref={viewportRef}
                className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
                onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
                role="list"
                aria-label={t('queue.jobsList', 'Generation jobs')}
            >
                {filteredTotal === 0 ? (
                    <div className="flex min-h-48 items-center justify-center px-4 text-center text-sm text-muted-foreground">
                        {t('queue.empty', 'No jobs match this view.')}
                    </div>
                ) : (
                    <div className="relative w-full" style={{ height: filteredTotal * QUEUE_ROW_HEIGHT }}>
                        {visibleWindowItems.map(({ job, index }) => {
                            const percent = job.progress.total <= 0
                                ? 0
                                : Math.min(100, Math.round((job.progress.current / job.progress.total) * 100))
                            return (
                                <div
                                    key={job.id}
                                    role="listitem"
                                    aria-setsize={filteredTotal}
                                    aria-posinset={index + 1}
                                    tabIndex={focusedIndex === index ? 0 : -1}
                                    data-queue-index={index}
                                    onFocus={() => setFocusedIndex(index)}
                                    onKeyDown={event => handleRowKey(event, index)}
                                    className="absolute left-0 flex min-h-11 w-full items-center gap-3 border-b border-border bg-card px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-5"
                                    style={{
                                        height: QUEUE_ROW_HEIGHT,
                                        transform: `translateY(${index * QUEUE_ROW_HEIGHT}px)`,
                                    }}
                                >
                                    <div className="min-w-0 flex-1">
                                        <div className="flex min-w-0 items-center gap-2">
                                            <span className={cn(
                                                'shrink-0 text-xs font-semibold uppercase',
                                                job.state === 'failed' ? 'text-destructive'
                                                    : job.state === 'succeeded' ? 'text-success'
                                                        : job.state === 'blocked' ? 'text-warning' : 'text-info',
                                            )}>{statusLabel(job.state)}</span>
                                            <span className="truncate font-mono text-xs" title={job.id}>{job.id}</span>
                                        </div>
                                        <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                                            <span>{workflowLabel(job.workflow)}{job.sceneId ? ` · ${job.sceneId}` : ''}</span>
                                            {job.outputDirectory && <span className="max-w-56 truncate" title={job.outputDirectory}>{t('generationFolders.queueFolder', '폴더 · {{path}}', { path: job.outputDirectory })}</span>}
                                            <span>{t('queue.attempt', 'Attempt {{current}}/{{max}}', { current: job.attemptCount, max: job.maxAttempts })}</span>
                                            <span>{stageLabel(job.progress.stage)} · {percent}%</span>
                                        </div>
                                        <div
                                            className="mt-1 h-1 overflow-hidden rounded-full bg-muted"
                                            aria-label={t('queue.itemProgress', 'Item progress {{percent}}%', { percent })}
                                        >
                                            <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
                                        </div>
                                    </div>
                                    {job.lastDiagnosticEventId !== null && (
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            aria-label={t('queue.openJobDetails', 'Open job details')}
                                            onClick={() => showDiagnostic(job)}
                                        >
                                            <AlertCircle className="h-4 w-4" />
                                        </Button>
                                    )}
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <Button variant="ghost" size="icon" aria-label={t('queue.jobActions', 'Job actions')}>
                                                <EllipsisVertical className="h-4 w-4" />
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                            <DropdownMenuItem
                                                className="min-h-11"
                                                disabled={isTerminalJobState(job.state)}
                                                onSelect={() => void runAction(() => coordinator.cancelJob(job.id))}
                                            >
                                                <XCircle className="mr-2 h-4 w-4" />{t('queue.cancelJob', 'Cancel job')}
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                className="min-h-11"
                                                disabled={job.state !== 'queued' && job.state !== 'blocked'}
                                                onSelect={() => void runAction(() => repository.skipJob({
                                                    jobId: job.id,
                                                    now: new Date().toISOString(),
                                                    expectedVersion: job.version,
                                                }))}
                                            >
                                                <SkipForward className="mr-2 h-4 w-4" />{t('queue.skipJob', 'Skip job')}
                                            </DropdownMenuItem>
                                            <DropdownMenuItem className="min-h-11" disabled={job.lastDiagnosticEventId === null} onSelect={() => showDiagnostic(job)}>
                                                <AlertCircle className="mr-2 h-4 w-4" />{t('queue.viewDetails', 'View details')}
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </div>
                            )
                        })}
                    </div>
                )}
            </div>
            <ConfirmDialog
                open={destructiveIssue !== null}
                onOpenChange={open => {
                    if (!open) setDestructiveIssue(null)
                }}
                title={t('queue.fulfillment.confirm.title', 'Confirm recovery action')}
                description={destructiveIssue?.action.kind === 'discard-result-and-abandon-reservation'
                    ? t('queue.fulfillment.confirm.discard', 'The received result will be permanently discarded before its output reservation is released.')
                    : t('queue.fulfillment.confirm.abandon', 'The output reservation will be released. This cannot be undone.')}
                confirmText={destructiveIssue === null ? '' : fulfillmentActionLabel(destructiveIssue)}
                cancelText={t('common.cancel', 'Cancel')}
                variant="destructive"
                busy={busy}
                onConfirm={async () => {
                    if (destructiveIssue === null) return
                    await runFulfillmentAction(destructiveIssue, true)
                }}
            />
            <ConfirmDialog
                open={conversionOpen}
                onOpenChange={setConversionOpen}
                title={t('queue.convertLegacyTitle', 'Move existing Scene queue?')}
                description={t(
                    'queue.convertLegacyDescription',
                    'Current parameters and required resources will be captured for durable jobs. Existing item counts remain available for rollback.',
                )}
                confirmText={t('queue.convertLegacyConfirm', 'Move jobs')}
                cancelText={t('common.cancel', 'Cancel')}
                onConfirm={convertLegacyQueue}
            />
            <SceneQueueSelectionDialog
                open={sceneSelectionOpen}
                onOpenChange={setSceneSelectionOpen}
                presets={scenePresets}
                busy={busy}
                onPrepare={prepareSelectedScenes}
                onApprove={approveSelectedScenes}
            />
            {legacySceneReview !== null && (
                <SceneQueueReviewDialog
                    open
                    onOpenChange={open => { if (!open) setLegacySceneReview(null) }}
                    prepared={legacySceneReview}
                    busy={busy}
                    onApprove={approveSelectedScenes}
                    onReplan={replanLegacySceneReview}
                />
            )}
        </main>
    )
}
