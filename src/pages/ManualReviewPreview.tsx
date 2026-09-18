import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Check, ChevronLeft, ChevronRight, Eye, Image as ImageIcon, Layers3, LoaderCircle, Sparkles, TriangleAlert } from 'lucide-react'
import { Link } from 'react-router'

import { Button } from '@/components/ui/button'
import { resolveGenerationFolderAuthority } from '@/lib/generation-folder-authority-runtime'
import { getRuntimeQueueRepository } from '@/services/queue/indexeddb-queue-repository'
import { ManualReviewGenerationError, queueManualReviewGeneration } from '@/services/generation/manual-review-generation-command'
import {
    createManualReviewSession,
    loadManualReviewSession,
    saveManualReviewSession,
    type ManualReviewSession,
} from '@/presentation/manual-review-session'
import type { GenerationParams } from '@/services/novelai-types'
import { useGenerationStore } from '@/stores/generation-store'
import { useSettingsStore } from '@/stores/settings-store'
import { AgentCommandPanel } from '@/presentation/agent/AgentCommandPanel'

import './manual-review-preview.css'

type ReviewCard = {
    id: string
    title: string
    subtitle: string
    tags: string[]
    params: GenerationParams
}

type PreviewResult = { url: string, seed: number }

const reviewCards: ReviewCard[] = [
    {
        id: 'bookshop',
        title: '비 오는 날의 작은 서점',
        subtitle: '장면 · 분위기 · 조명',
        tags: ['따뜻한 창가', '오래된 책장', '잔잔한 빗방울'],
        params: {
            prompt: '골목 모퉁이의 아늑한 서점, 비가 내리는 창밖, 책 사이로 스며드는 따뜻한 오후 빛, 섬세한 배경 묘사',
            negative_prompt: '읽을 수 없는 글자, 과도한 흐림, 잘린 화면',
            model: 'nai-diffusion-5-full', width: 832, height: 1216, steps: 28, cfg_scale: 5, cfg_rescale: 0,
            sampler: 'k_euler_ancestral', scheduler: 'native', smea: false, smea_dyn: false, variety: false, seed: 0,
            characterPrompts: [{
                stableId: 'bookshop-reader', prompt: '짧은 밤색 머리의 젊은 여성, 크림색 카디건, 창가에서 책을 읽는 모습',
                negative: '추가 손가락, 흐릿한 얼굴', enabled: true, position: { x: 0.5, y: 0.58 },
            }],
        },
    },
    {
        id: 'greenhouse',
        title: '햇빛이 드는 온실',
        subtitle: '장면 · 색감 · 질감',
        tags: ['맑은 유리', '초록 식물', '부드러운 그림자'],
        params: {
            prompt: '아침 햇살이 비치는 작은 온실, 잎사귀에 맺힌 물방울, 차분한 녹색과 크림색, 정돈된 구도',
            negative_prompt: '과한 채도, 겹쳐 보이는 잎, 잘린 화분',
            model: 'nai-diffusion-5-full', width: 1024, height: 1024, steps: 30, cfg_scale: 5.5, cfg_rescale: 0,
            sampler: 'k_euler_ancestral', scheduler: 'native', smea: false, smea_dyn: false, variety: false, seed: 0,
            characterPrompts: [{
                stableId: 'greenhouse-gardener', prompt: '긴 짙은 녹색 머리, 린넨 앞치마, 작은 화분을 들고 있는 정원사',
                negative: '중복된 팔, 가려진 얼굴', enabled: true, position: { x: 0.5, y: 0.54 },
            }],
        },
    },
    {
        id: 'night-train',
        title: '밤 기차의 창가 자리',
        subtitle: '장면 · 구도 · 무드',
        tags: ['푸른 밤', '창문 반사', '고요한 이동'],
        params: {
            prompt: '밤 기차 창가에서 바라본 도시의 불빛, 유리창의 은은한 반사, 차분한 청색 톤, 영화적인 구도',
            negative_prompt: '강한 렌즈 플레어, 과도한 노이즈, 기울어진 수평선',
            model: 'nai-diffusion-5-full', width: 1216, height: 832, steps: 28, cfg_scale: 5, cfg_rescale: 0,
            sampler: 'k_euler_ancestral', scheduler: 'native', smea: false, smea_dyn: false, variety: false, seed: 0,
            characterPrompts: [{
                stableId: 'night-train-traveler', prompt: '검은 단발머리, 남색 코트, 기차 창밖을 바라보는 여행자',
                negative: '유리 밖에 비친 중복 인물, 왜곡된 얼굴', enabled: true, position: { x: 0.38, y: 0.56 },
            }],
        },
    },
]

function SideCard({
    card,
    side,
    status,
}: {
    card: ReviewCard | null
    side: 'previous' | 'next'
    status: string
}) {
    return (
        <div className={`manual-review-side manual-review-side--${side}`} aria-hidden="true">
            <div className="manual-review-side-copy">
                <span className="text-xs font-medium text-muted-foreground">{status}</span>
                <p className="mt-2 text-lg font-semibold leading-tight">{card?.title ?? (side === 'previous' ? '첫 번째 카드' : '모든 카드 검토 완료')}</p>
                {card && <p className="mt-2 text-xs text-muted-foreground">{card.subtitle}</p>}
            </div>
        </div>
    )
}

export default function ManualReviewPreview() {
    const [direction, setDirection] = useState(1)
    const [session, setSession] = useState<ManualReviewSession>(() => {
        try {
            return loadManualReviewSession(window.sessionStorage, reviewCards.map(card => card.id))
        } catch {
            return createManualReviewSession(reviewCards[0].id)
        }
    })
    const sessionRef = useRef(session)
    const [submitting, setSubmitting] = useState(false)
    const [queuePhase, setQueuePhase] = useState<'queued' | 'running' | 'attention'>('queued')
    const [message, setMessage] = useState(() => session.pending
        ? '이전 요청 상태를 확인하고 있습니다…'
        : session.uncertainCardIds.includes(reviewCards[session.activeIndex]?.id ?? '')
            ? '이전 요청의 접수 상태가 확인되지 않았습니다. 큐 센터에서 먼저 확인하세요.'
            : '내용을 확인한 뒤 이 프롬프트로 한 장을 생성하세요.')
    const [requestError, setRequestError] = useState<{ message: string, mayHaveEnqueued: boolean } | null>(null)
    const actionLock = useRef(false)
    const prefersReducedMotion = useReducedMotion()
    const settings = useSettingsStore()
    const history = useGenerationStore(state => state.history)
    const pending = session.pending
    const activeIndex = session.activeIndex
    const seenIds = session.seenIds
    const uncertainCardIds = session.uncertainCardIds
    const completedPreviews = Object.fromEntries(Object.entries(session.completedJobIds).flatMap(([cardId, jobId]) => {
        const result = history.find(item => item.sourceJobId === jobId)
        return result ? [[cardId, { url: result.thumbnail ?? result.url, seed: result.seed }]] : []
    })) as Record<string, PreviewResult>
    const latestPreview = session.latestCompletedCardId ? completedPreviews[session.latestCompletedCardId] ?? null : null
    const folder = resolveGenerationFolderAuthority(
        settings.generationFolderDocument,
        settings.generationFolders,
        settings.activeGenerationFolderId,
        { directory: settings.savePath, useAbsolutePath: settings.useAbsolutePath },
    )

    const activeCard = reviewCards[activeIndex]
    const previousCard = activeIndex > 0 ? reviewCards[activeIndex - 1] : null
    const nextCard = activeIndex + 1 < reviewCards.length ? reviewCards[activeIndex + 1] : null
    const activePreview = completedPreviews[activeCard.id]
    const activeCompleted = Boolean(session.completedJobIds[activeCard.id])
    const activeRequestUncertain = uncertainCardIds.includes(activeCard.id)
    const completedCount = Object.keys(session.completedJobIds).length
    const isBusy = submitting || pending !== null
    const finalPrompt = [folder?.commonPrompt.trim(), activeCard.params.prompt].filter(Boolean).join(', ')
    const progress = (completedCount / reviewCards.length) * 100

    const moveTo = (nextIndex: number) => {
        if (isBusy || nextIndex < 0 || nextIndex >= reviewCards.length || nextIndex === activeIndex) return
        const nextCardId = reviewCards[nextIndex].id
        setDirection(nextIndex > activeIndex ? 1 : -1)
        const current = sessionRef.current
        const nextSession = {
            ...current,
            activeIndex: nextIndex,
            seenIds: current.seenIds.includes(nextCardId) ? current.seenIds : [...current.seenIds, nextCardId],
        }
        persistSession(nextSession)
        setRequestError(null)
        setMessage(uncertainCardIds.includes(nextCardId)
            ? '이 카드의 접수 상태가 확인되지 않았습니다. 중복 요청 방지를 위해 큐 센터에서 먼저 확인하세요.'
            : session.completedJobIds[nextCardId]
            ? '이 카드의 결과 프리뷰가 준비되어 있습니다.'
            : '내용을 확인한 뒤 이 프롬프트로 한 장을 생성하세요.')
    }

    const persistSession = (nextSession: ManualReviewSession): boolean => {
        let stored = false
        try {
            stored = saveManualReviewSession(window.sessionStorage, nextSession)
        } catch {
            stored = false
        }
        sessionRef.current = nextSession
        setSession(nextSession)
        return stored
    }

    const generateActiveCard = async () => {
        if (actionLock.current || isBusy || activeCompleted || requestError?.mayHaveEnqueued || activeRequestUncertain) return
        actionLock.current = true
        try {
            const requestId = globalThis.crypto.randomUUID()
            const beforeEnqueue = {
                ...sessionRef.current,
                submitting: { cardId: activeCard.id, requestId },
            }
            if (!persistSession(beforeEnqueue)) {
                persistSession({ ...beforeEnqueue, submitting: null })
                setRequestError({ message: '중복 요청 방지 상태를 저장할 수 없어 생성을 시작하지 않았습니다.', mayHaveEnqueued: false })
                setMessage('브라우저 세션 저장을 사용할 수 없어 생성 요청을 보류했습니다.')
                return
            }
            setSubmitting(true)
            setRequestError(null)
            setMessage('검토한 요청을 내구성 큐에 등록하고 있습니다…')
            const result = await queueManualReviewGeneration(activeCard.id, {
                ...activeCard.params,
                prompt: finalPrompt,
            }, requestId)
            persistSession({
                ...sessionRef.current,
                submitting: null,
                pending: { cardId: activeCard.id, cardIndex: activeIndex, ...result },
            })
            setQueuePhase('queued')
            setMessage('요청을 큐에 등록했습니다. 이 카드의 결과를 기다리는 중입니다.')
        } catch (error) {
            const safeError = error instanceof ManualReviewGenerationError
                ? error
                : new ManualReviewGenerationError('생성 설정을 준비하지 못했습니다. 설정을 확인한 뒤 다시 시도해 주세요.', false)
            setRequestError({ message: safeError.message, mayHaveEnqueued: safeError.mayHaveEnqueued })
            if (safeError.mayHaveEnqueued) {
                const current = sessionRef.current
                persistSession({
                    ...current,
                    submitting: null,
                    uncertainCardIds: current.uncertainCardIds.includes(activeCard.id)
                        ? current.uncertainCardIds
                        : [...current.uncertainCardIds, activeCard.id],
                })
            } else if (sessionRef.current.submitting !== null) {
                persistSession({ ...sessionRef.current, submitting: null })
            }
            setMessage(safeError.message)
        } finally {
            setSubmitting(false)
            actionLock.current = false
        }
    }

    useEffect(() => {
        if (pending === null) return
        let stopped = false
        let polling = false
        const checkJob = async () => {
            if (stopped || polling) return
            polling = true
            try {
                const job = await getRuntimeQueueRepository().getJob(pending.jobId)
                if (stopped || job === null) return
                if (job.state === 'succeeded') {
                    const result = useGenerationStore.getState().history.find(item => item.sourceJobId === pending.jobId)
                    if (!result) {
                        setMessage('생성이 끝났습니다. 결과 프리뷰를 연결하고 있습니다…')
                        return
                    }
                    const preview = { url: result.thumbnail ?? result.url, seed: result.seed }
                    try {
                        const image = new Image()
                        image.src = preview.url
                        await image.decode()
                    } catch {
                        if (!stopped) {
                            setQueuePhase('attention')
                            setMessage('생성 결과는 저장됐지만 프리뷰를 불러오지 못했습니다. 다시 확인하는 동안 새 요청은 보내지 않습니다.')
                        }
                        return
                    }
                    if (stopped) return
                    setRequestError(null)
                    const nextIndex = pending.cardIndex + 1
                    const current = sessionRef.current
                    const completedJobIds = { ...current.completedJobIds, [pending.cardId]: pending.jobId }
                    const shouldAdvance = current.activeIndex === pending.cardIndex && nextIndex < reviewCards.length
                    const nextCardId = shouldAdvance ? reviewCards[nextIndex].id : null
                    persistSession({
                        ...current,
                        pending: null,
                        completedJobIds,
                        latestCompletedCardId: pending.cardId,
                        activeIndex: shouldAdvance ? nextIndex : current.activeIndex,
                        seenIds: nextCardId && !current.seenIds.includes(nextCardId)
                            ? [...current.seenIds, nextCardId]
                            : current.seenIds,
                    })
                    if (shouldAdvance) {
                        setDirection(1)
                        setMessage('프리뷰가 준비되어 다음 프롬프트로 이동했습니다. 다음 생성은 직접 눌러 시작하세요.')
                    } else if (Object.keys(completedJobIds).length === reviewCards.length) {
                        setMessage('모든 프롬프트의 결과 프리뷰가 준비되었습니다.')
                    } else {
                        setMessage('이 카드의 프리뷰가 준비되었습니다. 남은 프롬프트를 선택해 검토하세요.')
                    }
                    return
                }
                if (job.state === 'failed' || job.state === 'cancelled' || job.state === 'skipped') {
                    const current = sessionRef.current
                    persistSession({
                        ...current,
                        pending: null,
                        uncertainCardIds: current.uncertainCardIds.includes(pending.cardId)
                            ? current.uncertainCardIds
                            : [...current.uncertainCardIds, pending.cardId],
                    })
                    setRequestError({
                        message: job.state === 'failed'
                            ? '생성이 실패했습니다. 큐 센터에서 결과와 원인을 확인하세요.'
                            : '요청이 완료되지 않았습니다. 큐 센터에서 상태를 확인하세요.',
                        mayHaveEnqueued: true,
                    })
                    return
                }
                if (job.state === 'blocked' || job.state === 'recovering') {
                    setQueuePhase('attention')
                    setMessage('요청 상태 확인이 필요합니다. 큐 센터에서 확인한 뒤 이 화면으로 돌아오세요.')
                } else if (job.state === 'running' || job.state === 'leased') {
                    setQueuePhase('running')
                    setMessage('이미지 생성 중입니다. 결과가 저장되면 프리뷰가 표시됩니다.')
                } else {
                    setQueuePhase('queued')
                    setMessage('요청이 큐에서 대기 중입니다.')
                }
            } catch {
                setQueuePhase('attention')
                setMessage('큐 상태를 확인 중입니다. 연결이 복구될 때까지 요청을 다시 보내지 않습니다.')
            } finally {
                polling = false
            }
        }
        void checkJob()
        const intervalId = globalThis.setInterval(() => { void checkJob() }, 1_000)
        return () => {
            stopped = true
            globalThis.clearInterval(intervalId)
        }
    }, [pending])

    const sideStatus = (card: ReviewCard | null, side: 'previous' | 'next') => {
        if (!card) return side === 'previous' ? '이전 카드 없음' : '다음 카드 없음'
        if (session.completedJobIds[card.id]) return '생성 완료'
        if (seenIds.includes(card.id)) return '이미 살펴봄'
        return '다음 검토'
    }

    return (
        <main className="h-full min-h-0 overflow-y-auto bg-background" data-testid="manual-review-preview">
            <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-7 px-4 py-6 sm:px-8 sm:py-10">
                <header className="flex flex-wrap items-start justify-between gap-5">
                    <div className="min-w-0">
                        <Button asChild variant="ghost" className="-ml-3 mb-5">
                            <Link to="/queue"><ChevronLeft className="mr-1 h-4 w-4" />큐 센터</Link>
                        </Button>
                        <p className="mb-2 text-sm font-medium text-primary">사람이 확인하는 생성 흐름</p>
                        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">한 장씩 보고, 직접 시작</h1>
                        <p className="mt-3 max-w-2xl text-base text-muted-foreground">
                            프롬프트 내용을 확인하고 누르면 한 장만 요청합니다. 프리뷰가 준비되면 다음 카드로 이동하며, 다음 생성은 직접 시작합니다.
                        </p>
                    </div>
                    <span className="inline-flex min-h-10 items-center gap-2 rounded-control bg-secondary px-3 text-sm text-secondary-foreground">
                        <Eye className="h-4 w-4" />예시 모듈 · 클릭당 한 장
                    </span>
                </header>

                <section aria-label="파일 기반 에이전트 생성 연결" className="rounded-panel border bg-card px-4 py-3 sm:px-5">
                    <details data-testid="manual-review-agent-connection">
                        <summary className="cursor-pointer font-medium">파일 에이전트 요청과 생성 설정 검토</summary>
                        <p className="mt-2 text-sm text-muted-foreground">
                            파일 요청에서 만들어진 동일한 생성 계획을 확인하고 승인하면 Main Queue가 실행합니다. 승인된 배치와 결과 프리뷰는 큐 센터에서 확인할 수 있습니다.
                        </p>
                        <div className="mt-4"><AgentCommandPanel /></div>
                    </details>
                </section>

                <section aria-label="생성 진행 상태" className="space-y-3">
                    <div className="flex items-center justify-between gap-4 text-sm">
                        <span className="font-medium">프리뷰 준비 완료</span>
                        <span className="font-mono text-muted-foreground">{completedCount} / {reviewCards.length}</span>
                    </div>
                    <div
                        className="h-1.5 overflow-hidden rounded-full bg-muted"
                        role="progressbar"
                        aria-label="프리뷰 진행률"
                        aria-valuemin={0}
                        aria-valuemax={reviewCards.length}
                        aria-valuenow={completedCount}
                    >
                        <div className="h-full bg-primary transition-[width] duration-300" style={{ width: `${progress}%` }} />
                    </div>
                </section>

                <section aria-roledescription="carousel" aria-label="프롬프트 모듈 카드" className="space-y-4">
                    <div className="flex items-center justify-between gap-4">
                        <p className="text-sm text-muted-foreground">모듈 {String(activeIndex + 1).padStart(2, '0')} / {String(reviewCards.length).padStart(2, '0')}</p>
                        <div className="flex items-center gap-2">
                            <Button variant="outline" size="icon" aria-label="이전 카드" disabled={isBusy || activeIndex === 0} onClick={() => moveTo(activeIndex - 1)}>
                                <ChevronLeft className="h-5 w-5" />
                            </Button>
                            <Button variant="outline" size="icon" aria-label="다음 카드" disabled={isBusy || activeIndex === reviewCards.length - 1} onClick={() => moveTo(activeIndex + 1)}>
                                <ChevronRight className="h-5 w-5" />
                            </Button>
                        </div>
                    </div>

                    <div className={`manual-review-deck${prefersReducedMotion ? ' manual-review-deck--reduced' : ''}`}>
                        <SideCard card={previousCard} side="previous" status={sideStatus(previousCard, 'previous')} />
                        <SideCard card={nextCard} side="next" status={sideStatus(nextCard, 'next')} />
                        <AnimatePresence mode="wait" custom={direction}>
                            <motion.article
                                key={activeCard.id}
                                custom={direction}
                                initial={{ opacity: 0, x: prefersReducedMotion ? 0 : direction * 34 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0, x: prefersReducedMotion ? 0 : direction * -34 }}
                                transition={{ duration: prefersReducedMotion ? 0 : 0.22, ease: 'easeOut' }}
                                aria-live="polite"
                                className="manual-review-center flex min-h-[640px] flex-col rounded-panel border border-border bg-card p-5 sm:p-7"
                            >
                                <div className="flex items-start justify-between gap-4">
                                    <div className="flex min-w-0 items-center gap-3">
                                        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-control bg-accent text-accent-foreground">
                                            <Sparkles className="h-5 w-5" aria-hidden="true" />
                                        </span>
                                        <div className="min-w-0">
                                            <p className="text-xs font-medium text-muted-foreground">{activeCard.subtitle}</p>
                                            <p className="mt-1 truncate text-sm">프롬프트 모듈</p>
                                        </div>
                                    </div>
                                    {activePreview && (
                                        <span className="inline-flex shrink-0 items-center gap-1 rounded-control bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground">
                                            <Check className="h-3.5 w-3.5" aria-hidden="true" />프리뷰 준비 완료
                                        </span>
                                    )}
                                </div>

                                <h2 className="mt-6 text-2xl font-semibold leading-tight sm:text-3xl">{activeCard.title}</h2>
                                <div className="mt-3 flex flex-wrap gap-2" aria-label="포함된 모듈">
                                    {activeCard.tags.map(tag => (
                                        <span key={tag} className="rounded-control bg-secondary px-3 py-1.5 text-sm text-secondary-foreground">{tag}</span>
                                    ))}
                                </div>

                                <div className="mt-5 grid gap-3 rounded-panel bg-muted/40 p-4 text-sm sm:grid-cols-2 lg:grid-cols-4" aria-label="생성 파라미터">
                                    <div><p className="text-xs text-muted-foreground">모델</p><p className="mt-1 break-all font-medium">{activeCard.params.model}</p></div>
                                    <div><p className="text-xs text-muted-foreground">Steps</p><p className="mt-1 font-medium">{activeCard.params.steps}</p></div>
                                    <div><p className="text-xs text-muted-foreground">CFG</p><p className="mt-1 font-medium">{activeCard.params.cfg_scale}</p></div>
                                    <div><p className="text-xs text-muted-foreground">크기 · 시드</p><p className="mt-1 font-medium">{activeCard.params.width} × {activeCard.params.height} · 자동</p></div>
                                    <div><p className="text-xs text-muted-foreground">CFG Rescale</p><p className="mt-1 font-medium">{activeCard.params.cfg_rescale}</p></div>
                                    <div><p className="text-xs text-muted-foreground">Sampler</p><p className="mt-1 break-all font-medium">{activeCard.params.sampler}</p></div>
                                    <div><p className="text-xs text-muted-foreground">Scheduler</p><p className="mt-1 font-medium">{activeCard.params.scheduler}</p></div>
                                    <div><p className="text-xs text-muted-foreground">SMEA · SMEA Dyn · Variety</p><p className="mt-1 font-medium">{activeCard.params.smea ? '켜짐' : '꺼짐'} · {activeCard.params.smea_dyn ? '켜짐' : '꺼짐'} · {activeCard.params.variety ? '켜짐' : '꺼짐'}</p></div>
                                </div>

                                <div className="mt-5 grid gap-4 lg:grid-cols-2">
                                    <section className="min-w-0 rounded-panel border border-border p-4">
                                        <h3 className="text-sm font-semibold">전체 프롬프트</h3>
                                        {folder?.commonPrompt.trim() && (
                                            <p className="mt-3 rounded-control bg-secondary/60 p-3 text-sm">
                                                <span className="font-medium">폴더 공통 프롬프트</span><br />{folder.commonPrompt}
                                            </p>
                                        )}
                                        <h4 className="mt-3 text-xs font-semibold">모듈 프롬프트</h4>
                                        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">{activeCard.params.prompt}</p>
                                        <h4 className="mt-4 text-xs font-semibold">제외할 요소</h4>
                                        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">{activeCard.params.negative_prompt}</p>
                                    </section>
                                    <section className="min-w-0 rounded-panel border border-border p-4">
                                        <h3 className="text-sm font-semibold">캐릭터 프롬프트</h3>
                                        {activeCard.params.characterPrompts?.filter(character => character.enabled).map((character, index) => (
                                            <div key={character.stableId ?? index} className="mt-3 border-t border-border pt-3 first:mt-2 first:border-0 first:pt-0">
                                                <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{character.prompt}</p>
                                                <p className="mt-2 text-xs text-muted-foreground">캐릭터 제외 요소: {character.negative || '없음'}</p>
                                                <p className="mt-1 text-xs text-muted-foreground">위치: {character.position.x.toFixed(2)}, {character.position.y.toFixed(2)}</p>
                                            </div>
                                        ))}
                                    </section>
                                </div>

                                <div className="mt-auto flex flex-col gap-4 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
                                    <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
                                        <span className="inline-flex items-center gap-1.5"><ImageIcon className="h-4 w-4" aria-hidden="true" />1장</span>
                                        <span className="inline-flex items-center gap-1.5"><Layers3 className="h-4 w-4" aria-hidden="true" />모듈 {reviewCards.length}개</span>
                                    </div>
                                    <Button
                                        onClick={() => { void generateActiveCard() }}
                                        disabled={isBusy || activeCompleted || Boolean(requestError?.mayHaveEnqueued) || activeRequestUncertain}
                                        className="min-h-11"
                                    >
                                        {submitting || pending ? <><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />{submitting ? '요청 등록 중' : queuePhase === 'running' ? '생성 중' : queuePhase === 'attention' ? '상태 확인 필요' : '큐 대기 중'}</> : activePreview ? <><Check className="mr-2 h-4 w-4" />생성 완료</> : '검토 완료 · 이 프롬프트로 1장 생성'}
                                    </Button>
                                </div>
                            </motion.article>
                        </AnimatePresence>
                    </div>

                    <div className="flex justify-center gap-1" role="group" aria-label="카드 선택">
                        {reviewCards.map((card, index) => (
                            <button
                                key={card.id}
                                type="button"
                                aria-label={`${index + 1}번 카드 보기`}
                                aria-current={activeIndex === index ? 'step' : undefined}
                                disabled={isBusy}
                                onClick={() => moveTo(index)}
                                className="flex h-11 w-11 items-center justify-center rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
                            >
                                <span className={`h-2.5 rounded-full transition-[width,background-color] duration-200 ${activeIndex === index ? 'w-8 bg-primary' : completedPreviews[card.id] ? 'w-2.5 bg-primary/70' : 'w-2.5 bg-muted-foreground/40'}`} />
                            </button>
                        ))}
                    </div>
                    <p role="status" aria-live="polite" className="text-center text-sm text-muted-foreground">
                        {requestError && <TriangleAlert className="mr-1 inline h-4 w-4 align-[-3px]" aria-hidden="true" />}
                        {pending && <LoaderCircle className="mr-1 inline h-4 w-4 animate-spin align-[-3px]" aria-hidden="true" />}
                        {requestError?.message ?? message}
                        {(requestError || pending || activeRequestUncertain) && <Link className="ml-2 font-medium text-primary underline-offset-4 hover:underline" to="/queue">큐 센터 확인</Link>}
                    </p>
                </section>

                {latestPreview && (
                    <section aria-label="가장 최근 생성 결과" className="rounded-panel border border-border bg-card p-4 sm:p-5">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                                <h2 className="text-base font-semibold">가장 최근 프리뷰</h2>
                                <p className="mt-1 text-xs text-muted-foreground">시드 {latestPreview.seed} · 원본은 설정된 저장 폴더에 보관됩니다.</p>
                            </div>
                            <Button asChild variant="outline" size="sm"><Link to="/queue">저장 결과 보기</Link></Button>
                        </div>
                        <img src={latestPreview.url} alt="가장 최근 생성 결과" className="mt-4 max-h-[480px] w-full rounded-control bg-muted object-contain" />
                    </section>
                )}

                {completedCount > 1 && (
                    <section aria-label="완료한 프롬프트 결과" className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                        {reviewCards.filter(card => completedPreviews[card.id]).map(card => (
                            <figure key={card.id} className="overflow-hidden rounded-panel border border-border bg-card p-2">
                                <img src={completedPreviews[card.id].url} alt={`${card.title} 결과`} className="aspect-square w-full rounded-control bg-muted object-contain" />
                                <figcaption className="truncate px-1 pt-2 text-xs text-muted-foreground">{card.title}</figcaption>
                            </figure>
                        ))}
                    </section>
                )}
            </div>
        </main>
    )
}
