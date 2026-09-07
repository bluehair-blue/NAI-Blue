import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import {
    ArrowLeft,
    ArrowRight,
    Clock3,
    FolderTree,
    Images,
    Image as ImageIcon,
    Library,
    Settings2,
    TextCursorInput,
    type LucideIcon,
} from 'lucide-react'

import { getWorkflowDraftRepository } from '@/adapters/workflow/indexeddb-workflow-draft-repository'
import { Button } from '@/components/ui/button'
import { createSingleImageDraft, type WorkflowDraft } from '@/domain/workflow/single-image-draft'
import { cn } from '@/lib/utils'
import { generateRandomSeed } from '@/lib/utils'
import { resolveGuidedActivityTargetNode } from '@/presentation/activity/activity-status'
import {
    GUIDED_DRAFTS_CHANGED_EVENT,
    announceGuidedDraftChange,
} from './guided-draft-events'
import {
    GuidedWorkflowChoices,
    type GuidedWorkflowId,
} from './GuidedWorkflowHub'

interface GuidedChoice {
    id: 'single' | 'batch' | 'prompt' | 'library' | 'environment'
    icon: LucideIcon
    title: string
    description: string
    direct?: boolean
}

function ChoiceRow({ choice, busy, openLabel, onSelect }: { choice: GuidedChoice; busy: boolean; openLabel: string; onSelect(): void }) {
    const Icon = choice.icon
    return (
        <button
            type="button"
            data-guided-choice={choice.id}
            onClick={onSelect}
            disabled={busy}
            className={cn(
                'guided-choice-row group flex min-h-24 w-full items-center gap-4 border-b border-border/45 px-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4',
                busy && 'cursor-progress opacity-65',
            )}
        >
            <Icon className="h-5 w-5 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" aria-hidden="true" />
            <span className="min-w-0 flex-1 py-4">
                <span className="block break-words text-base font-semibold leading-snug text-foreground">{choice.title}</span>
                <span className="mt-1.5 block break-words text-sm leading-relaxed text-muted-foreground">{choice.description}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2 text-sm font-semibold text-primary opacity-70 transition-opacity duration-standard group-hover:opacity-100 group-focus-visible:opacity-100 sm:opacity-0">
                <span className="hidden sm:inline">{openLabel}</span>
                <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-fast group-hover:translate-x-1" aria-hidden="true" />
            </span>
        </button>
    )
}

export function GuidedHome() {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const [drafts, setDrafts] = useState<readonly WorkflowDraft[]>([])
    const [creating, setCreating] = useState(false)
    const [createError, setCreateError] = useState(false)
    const [selectedWorkflow, setSelectedWorkflow] = useState<GuidedWorkflowId | null>(null)
    const resumeDraft = drafts[0]
    const resumeNode = resumeDraft === undefined
        ? null
        : resolveGuidedActivityTargetNode(resumeDraft.currentNodeId, resumeDraft.status)
    const resumeHref = resumeDraft === undefined
        ? null
        : resumeDraft.kind === 'batch-image'
            ? `/guided-preview/batch/${resumeDraft.id}/${resumeNode}`
            : `/guided-preview/work/${resumeDraft.id}/${resumeNode}`

    useEffect(() => {
        let active = true
        const refresh = () => {
            void getWorkflowDraftRepository().list().then(items => {
                if (active) setDrafts(items)
            }).catch(() => {
                if (active) setDrafts([])
            })
        }
        refresh()
        window.addEventListener(GUIDED_DRAFTS_CHANGED_EVENT, refresh)
        return () => {
            active = false
            window.removeEventListener(GUIDED_DRAFTS_CHANGED_EVENT, refresh)
        }
    }, [])

    const startSingleImageDraft = async () => {
        setCreating(true)
        setCreateError(false)
        try {
            const now = new Date().toISOString()
            const draft = createSingleImageDraft({
                id: `guided-single-${crypto.randomUUID()}`,
                now,
                seed: generateRandomSeed(),
            })
            const result = await getWorkflowDraftRepository().commit({
                expectedRevision: null,
                draft,
            })
            if (result.status !== 'committed') throw new Error('Draft ID already exists')
            announceGuidedDraftChange()
            navigate(`/guided-preview/work/${draft.id}/prompt`)
        } catch {
            setCreateError(true)
        } finally {
            setCreating(false)
        }
    }
    const choices: GuidedChoice[] = [
        {
            id: 'single',
            icon: ImageIcon,
            title: t('guided.home.single.title', '한 장 만들기'),
            description: t('guided.home.single.description', '모델부터 최종 설정까지 차근차근 정해요.'),
        },
        {
            id: 'batch',
            icon: Images,
            title: t('guided.home.batch.title', '여러 장 만들기'),
            description: t('guided.home.batch.description', '같은 설정, 랜덤 프롬프트, 씬 작업 중에서 골라요.'),
        },
        {
            id: 'prompt',
            icon: TextCursorInput,
            title: t('guided.home.prompt.title', '프롬프트 다듬기'),
            description: t('guided.home.prompt.description', '로컬 AI 에이전트와 안전하게 수정하고 비교해요.'),
        },
        {
            id: 'library',
            icon: Library,
            title: t('guided.home.library.title', '이미지 정리하기'),
            description: t('guided.home.library.description', '정리, 편집, 메타데이터, R2 업로드를 안내해요.'),
            direct: true,
        },
        {
            id: 'environment',
            icon: Settings2,
            title: t('guided.home.environment.title', '앱 설정하기'),
            description: t('guided.home.environment.description', '계정, 저장 위치, 화면과 백업을 설정해요.'),
            direct: true,
        },
    ]

    return (
        <div className="mx-auto flex min-h-full w-full max-w-[var(--guided-content-max)] items-center px-4 py-7 sm:px-6 lg:px-10">
            <div className="grid w-full items-center gap-8 min-[900px]:grid-cols-[minmax(19rem,0.74fr)_minmax(30rem,1fr)] min-[900px]:gap-10">
                <section aria-labelledby="guided-welcome-title">
                    <p className="mb-2 text-sm font-semibold text-primary">NAI Blue · Guided</p>
                    <h1 id="guided-welcome-title" className="guided-display max-w-[12ch] text-foreground">
                        {selectedWorkflow === null
                            ? t('guided.home.welcome', '어서오세요!')
                            : t(`guided.workflows.${selectedWorkflow}.title`)}
                    </h1>
                    <p className="mt-3 max-w-[34ch] text-base leading-snug text-muted-foreground">
                        {selectedWorkflow === null
                            ? t('guided.home.question', '어떤 작업을 하고 싶은지부터 함께 정해볼게요.')
                            : t(`guided.workflows.${selectedWorkflow}.description`)}
                    </p>
                    {selectedWorkflow === null ? (
                        <p className="mt-2 text-sm leading-snug text-muted-foreground">
                            {t('guided.home.autosave', '선택한 내용은 자동으로 저장됩니다.')}
                        </p>
                    ) : (
                        <Button
                            type="button"
                            variant="ghost"
                            className="mt-4 -ml-3"
                            onClick={() => setSelectedWorkflow(null)}
                        >
                            <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
                            {t('guided.home.chooseAgain', '다른 작업 고르기')}
                        </Button>
                    )}
                </section>

                {selectedWorkflow === null ? <nav aria-label={t('guided.home.choices', '작업 선택')} className="border-y border-border/40">
                    <button type="button" className="guided-choice-row flex min-h-24 w-full items-center gap-4 border-b border-border/45 px-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4" onClick={() => navigate('/folders')}>
                        <FolderTree className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
                        <span className="min-w-0 flex-1 py-4"><span className="block text-base font-semibold">{t('folderWorkbench.title', '에셋 작업대')}</span><span className="mt-1.5 block text-sm text-muted-foreground">{t('folderWorkbench.entryDescription', '서로 다른 프롬프트를 폴더별로 모아 한 번에 생산합니다.')}</span></span>
                        <ArrowRight className="h-4 w-4 shrink-0" aria-hidden="true" />
                    </button>
                    {resumeHref !== null && (
                        <button
                            type="button"
                            className="guided-choice-row group flex min-h-20 w-full items-center gap-4 border-b border-primary/35 bg-primary/[0.04] px-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4"
                            onClick={() => navigate(resumeHref)}
                        >
                            <Clock3 className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
                            <span className="min-w-0 flex-1 py-4">
                                <span className="block text-base font-semibold text-foreground">
                                    {t('guided.home.resume', '이어서 작업하기')}
                                </span>
                                <span className="mt-1 block text-sm text-muted-foreground">
                                    {t('guided.home.draftCount', '저장된 초안 {{count}}개', { count: drafts.length })}
                                </span>
                            </span>
                            <ArrowRight className="h-4 w-4 text-primary transition-transform duration-fast group-hover:translate-x-1" aria-hidden="true" />
                        </button>
                    )}
                    {choices.map(choice => (
                        <div key={choice.id}>
                            {choice.id === 'prompt' && (
                                <p className="border-b border-border/45 px-3 py-3 text-xs font-semibold text-muted-foreground sm:px-4">
                                    {t('guided.home.tools', '다른 작업')}
                                </p>
                            )}
                            <ChoiceRow
                                choice={choice}
                                busy={creating}
                                openLabel={choice.direct
                                    ? t('guided.home.openDirectly', '바로 열기')
                                    : t('guided.home.open', '시작')}
                                onSelect={() => {
                                    if (choice.id === 'single') void startSingleImageDraft()
                                    else setSelectedWorkflow(choice.id)
                                }}
                            />
                        </div>
                    ))}
                    {createError && (
                        <p className="px-2 py-3 text-xs text-destructive" role="alert">
                            {t('guided.home.createError', '새 초안을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.')}
                        </p>
                    )}
                </nav> : (
                    <GuidedWorkflowChoices workflowId={selectedWorkflow} />
                )}
            </div>
        </div>
    )
}
