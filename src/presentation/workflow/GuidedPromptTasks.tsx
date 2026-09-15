import {
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
    type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useSearchParams } from 'react-router'
import {
    ArrowLeft,
    ArrowRight,
    Check,
    CircleAlert,
    CircleCheck,
    FileJson,
    FlaskConical,
    FolderOpen,
    ImagePlus,
    LoaderCircle,
    RefreshCw,
    Save,
    ShieldCheck,
    Sparkles,
} from 'lucide-react'

import {
    recordGuidedStyleDecision,
    startGuidedStyleComparison,
    type GuidedStyleDecision,
} from '@/application/style-lab/guided-style-comparison'
import { getWorkflowDraftRepository } from '@/adapters/workflow/indexeddb-workflow-draft-repository'
import { NovelAiV5UsageLimit } from '@/components/credentials/NovelAiV5UsageLimit'
import { PromptModulePicker, appendPromptModuleLine } from '@/components/fragments/PromptModulePicker'
import { PromptSlotTabs } from '@/components/prompt/PromptSlotTabs'
import { AutocompleteTextarea } from '@/components/ui/AutocompleteTextarea'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Slider } from '@/components/ui/slider'
import { createAnlasCostConsentSnapshot } from '@/domain/queue/anlas-cost-consent'
import {
    createSingleImageDraft,
    reviseSingleImageDraft,
} from '@/domain/workflow/single-image-draft'
import { compactPrompt, formatWeightedPromptTags } from '@/lib/style-lab'
import { calculateAnlasCost, resolveAnlasPricingBasis } from '@/lib/anlas-calculator'
import { cn, generateRandomSeed } from '@/lib/utils'
import { toNativeAssetUrl } from '@/platform/asset-url'
import { openNativePath } from '@/platform/native-shell'
import { NAI_IMAGE_MODELS } from '@/services/nai/model-catalog'
import {
    getAgentWorkspaceAbsolutePath,
    getAgentWorkspaceBridgeStatus,
    refreshAgentWorkspaceSnapshot,
    subscribeAgentWorkspaceBridge,
} from '@/services/agent/agent-workspace-runtime'
import {
    verifyPromptTagsWithDanbooru,
    type DanbooruTagResult,
} from '@/services/danbooru-tag-verifier'
import { captureCurrentStyleEvaluationContext } from '@/services/style-lab/capture-evaluation-context'
import { getStyleLabRepository } from '@/services/style-lab/indexeddb-style-lab-repository'
import { requestStyleLabPreviewRenders } from '@/services/style-lab/request-preview-render'
import { selectActiveCredentialsAreOpus, useAuthStore } from '@/stores/auth-store'
import { useGenerationDraftStore } from '@/stores/generation-draft-store'
import { useGenerationStore } from '@/stores/generation-store'
import { usePresetStore } from '@/stores/preset-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useStyleLabReadStore } from '@/stores/style-lab-read-store'
import { type StyleCombination, useStyleLabStore } from '@/stores/style-lab-store'
import { GuidedAgentPromptComposer } from './GuidedAgentPromptComposer'
import { announceGuidedDraftChange } from './guided-draft-events'
import { GuidedPromptFileImport } from './GuidedPromptFileImport'
import { GuidedResolutionDetails } from './GuidedResolutionDetails'

export type GuidedPromptTaskId = 'direct' | 'styleLab' | 'localAgent'

export function isGuidedPromptTaskId(value: string | undefined): value is GuidedPromptTaskId {
    return value === 'direct' || value === 'styleLab' || value === 'localAgent'
}

export const GUIDED_PROMPT_TASK_STEP_IDS = Object.freeze({
    direct: ['edit', 'verify', 'review'],
    styleLab: ['base', 'pool', 'preview', 'compare'],
    localAgent: ['preset', 'workspace', 'result'],
} as const)

const GUIDED_STYLE_MODELS = NAI_IMAGE_MODELS

const GUIDED_STYLE_RESOLUTIONS = [
    { id: 'portrait', label: 'Portrait', width: 832, height: 1216 },
    { id: 'square', label: 'Square', width: 1024, height: 1024 },
    { id: 'landscape', label: 'Landscape', width: 1216, height: 832 },
] as const

const GUIDED_STYLE_SAMPLERS = [
    { id: 'k_euler_ancestral', label: 'Euler Ancestral' },
    { id: 'k_dpmpp_2m_sde', label: 'DPM++ 2M SDE' },
    { id: 'k_dpmpp_2m', label: 'DPM++ 2M' },
    { id: 'k_euler', label: 'Euler' },
] as const

type PromptSlot = 'base' | 'additional' | 'detail' | 'negative'
type PromptValues = Record<PromptSlot, string>
type SaveState = 'idle' | 'saving' | 'saved' | 'error'

interface TaskStep<Id extends string> {
    readonly id: Id
    readonly label: string
}

function useGuidedTaskStep<Id extends string>(steps: readonly TaskStep<Id>[]) {
    const [searchParams, setSearchParams] = useSearchParams()
    const requested = searchParams.get('step')
    const current = steps.some(step => step.id === requested)
        ? requested as Id
        : steps[0].id

    const visit = (step: Id) => {
        const next = new URLSearchParams(searchParams)
        next.set('step', step)
        setSearchParams(next)
    }
    return { current, visit }
}

function SaveMessage({ state }: { state: SaveState }) {
    const { t } = useTranslation()
    if (state === 'idle') return null
    return (
        <span className={cn(
            'inline-flex min-h-8 items-center gap-2 text-sm text-muted-foreground',
            state === 'error' && 'text-destructive',
        )} role="status">
            {state === 'saving' && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {state === 'saved' && <CircleCheck className="h-4 w-4 text-success" aria-hidden="true" />}
            {state === 'error' && <CircleAlert className="h-4 w-4" aria-hidden="true" />}
            {state === 'saving'
                ? t('guided.promptTasks.saving', '저장 중…')
                : state === 'saved'
                    ? t('guided.promptTasks.saved', '저장했어요')
                    : t('guided.promptTasks.saveFailed', '저장하지 못했어요')}
        </span>
    )
}

function PromptTaskFrame<Id extends string>({
    title,
    description,
    steps,
    current,
    visit,
    canVisit = () => true,
    status,
    children,
    footer,
}: {
    title: string
    description: string
    steps: readonly TaskStep<Id>[]
    current: Id
    visit(step: Id): void
    canVisit?(step: Id): boolean
    status?: ReactNode
    children: ReactNode
    footer: ReactNode
}) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const index = Math.max(0, steps.findIndex(step => step.id === current))
    const previous = steps[index - 1]

    return (
        <div className="mx-auto flex min-h-full w-full max-w-[var(--guided-review-max)] flex-col px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-5 sm:px-6 sm:pt-8">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => previous ? visit(previous.id) : navigate('/guided-preview/guide/prompt')}
                    aria-label={t('guided.promptTasks.back', '이전으로')}
                >
                    <ArrowLeft className="h-5 w-5" aria-hidden="true" />
                </Button>
                <nav className="flex min-w-[16rem] flex-1 flex-wrap items-center gap-2 text-base leading-6 text-muted-foreground" aria-label={t('guided.promptTasks.breadcrumb', '현재 작업 경로')}>
                    <Link to="/guided-preview" className="hover:text-foreground focus-ring">
                        {t('guided.workflows.home', '작업 홈')}
                    </Link>
                    <span aria-hidden="true">›</span>
                    <Link to="/guided-preview/guide/prompt" className="hover:text-foreground focus-ring">
                        {t('guided.workflows.prompt.title', '프롬프트 다듬기')}
                    </Link>
                    <span aria-hidden="true">›</span>
                    <span className="font-medium text-foreground">{steps[index].label}</span>
                </nav>
                {status}
            </div>

            <div className="mt-7">
                <div className="flex items-center justify-between gap-4 text-sm font-medium">
                    <span className="text-primary">
                        {t('guided.promptTasks.stepLabel', '단계 {{current}} · {{label}}', {
                            current: index + 1,
                            label: steps[index].label,
                        })}
                    </span>
                    <span className="font-mono text-muted-foreground">{index + 1} / {steps.length}</span>
                </div>
                <div className="mt-3 h-px overflow-hidden bg-border">
                    <div
                        className="h-full bg-primary transition-[width] duration-slow"
                        style={{ width: `${((index + 1) / steps.length) * 100}%` }}
                    />
                </div>
                <ol className="mt-3 flex gap-5 overflow-x-auto pb-1 text-sm font-medium [scrollbar-width:none]">
                    {steps.map((step, stepIndex) => {
                        const enabled = canVisit(step.id)
                        const active = step.id === current
                        return (
                            <li key={step.id} className="shrink-0">
                                <button
                                    type="button"
                                    disabled={!enabled}
                                    onClick={() => visit(step.id)}
                                    aria-current={active ? 'step' : undefined}
                                    className={cn(
                                        'border-b py-1.5 transition-colors focus-ring',
                                        active
                                            ? 'border-primary text-foreground'
                                            : enabled
                                                ? 'border-transparent text-muted-foreground hover:border-foreground/45 hover:text-foreground'
                                                : 'cursor-not-allowed border-transparent text-muted-foreground/40',
                                    )}
                                >
                                    <span className="mr-1 font-mono">{stepIndex + 1}</span>{step.label}
                                </button>
                            </li>
                        )
                    })}
                </ol>
            </div>

            <main className="flex-1 py-9 sm:py-12">
                <h1 className="max-w-[24ch] text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">{title}</h1>
                <p className="mt-3 max-w-[62ch] text-base leading-7 text-muted-foreground">{description}</p>
                <div className="mt-8">{children}</div>
            </main>

            <footer className="sticky bottom-0 z-10 -mx-4 flex min-h-[72px] flex-wrap items-center justify-end gap-2 border-t border-border/70 bg-background/95 px-4 py-3 text-base sm:-mx-6 sm:px-6">
                {footer}
            </footer>
        </div>
    )
}

export function composeGuidedPrompt(values: PromptValues): string {
    return compactPrompt([values.base, values.additional, values.detail].filter(value => value.trim()).join(', '))
}

export function replaceGuidedPromptTag(source: string, raw: string, replacement: string): string {
    let replaced = false
    return source.split(',').map(part => {
        if (!replaced && part.trim() === raw.trim()) {
            replaced = true
            return replacement.trim()
        }
        return part.trim()
    }).filter(Boolean).join(', ')
}

function FourSlotPromptEditor({ values, onChange }: {
    values: PromptValues
    onChange(slot: PromptSlot, value: string): void
}) {
    const { t } = useTranslation()
    const [active, setActive] = useState<PromptSlot>('base')
    const fontSize = useSettingsStore(state => state.promptFontSize)
    const labels: Record<PromptSlot, string> = {
        base: t('prompt.base', '메인 프롬프트'),
        additional: t('prompt.additional', '보조 설명'),
        detail: t('prompt.detail', '세부 묘사'),
        negative: t('prompt.negative', '제외할 요소'),
    }
    const placeholders: Record<PromptSlot, string> = {
        base: t('prompt.basePlaceholder', '인물, 장면, 구도의 핵심부터 적어주세요.'),
        additional: t('prompt.additionalPlaceholder', '분위기와 스타일을 더해보세요.'),
        detail: t('prompt.detailPlaceholder', '조명, 재질, 작은 디테일을 적어보세요.'),
        negative: t('prompt.negativePlaceholder', '피하고 싶은 요소를 적어주세요.'),
    }

    return (
        <section className="border-y border-border/70" data-testid="guided-direct-editor">
            <PromptSlotTabs
                tabs={(Object.keys(labels) as PromptSlot[]).map(id => ({
                    id,
                    label: labels[id],
                    filled: values[id].trim().length > 0,
                    negative: id === 'negative',
                }))}
                activeId={active}
                panelId="guided-direct-prompt-panel"
                label={t('guided.promptTasks.direct.editorLabel', '다듬을 프롬프트 영역')}
                onChange={id => setActive(id as PromptSlot)}
            />
            <div className="flex min-h-12 items-center justify-end border-b border-border/45 px-2">
                <PromptModulePicker
                    showManageAction={false}
                    allowInlineManage
                    createSourceText={values[active]}
                    onSelectLine={line => onChange(active, appendPromptModuleLine(values[active], line))}
                />
            </div>
            <AutocompleteTextarea
                key={active}
                value={values[active]}
                onChange={event => onChange(active, event.target.value)}
                placeholder={placeholders[active]}
                ariaLabel={labels[active]}
                className="h-72 min-h-72 resize-none rounded-none border-0 bg-transparent text-base focus-within:ring-1 focus-within:ring-inset"
                style={{ fontSize: `${fontSize}px` }}
            />
        </section>
    )
}

interface SlotVerification {
    readonly slot: PromptSlot
    readonly results: readonly DanbooruTagResult[]
}

function GuidedDirectPromptTask() {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const steps = useMemo<readonly TaskStep<typeof GUIDED_PROMPT_TASK_STEP_IDS.direct[number]>[]>(() => [
        { id: 'edit', label: t('guided.promptTasks.direct.steps.edit', '직접 편집') },
        { id: 'verify', label: t('guided.promptTasks.direct.steps.verify', '태그 확인') },
        { id: 'review', label: t('guided.promptTasks.direct.steps.review', '저장과 연결') },
    ], [t])
    const { current, visit } = useGuidedTaskStep(steps)
    const [values, setValues] = useState<PromptValues>(() => {
        const generation = useGenerationStore.getState()
        return {
            base: generation.basePrompt,
            additional: generation.additionalPrompt,
            detail: generation.detailPrompt,
            negative: generation.negativePrompt,
        }
    })
    const [verification, setVerification] = useState<readonly SlotVerification[]>([])
    const [verifying, setVerifying] = useState(false)
    const [verificationError, setVerificationError] = useState<string | null>(null)
    const [presetName, setPresetName] = useState('')
    const [saveState, setSaveState] = useState<SaveState>('idle')
    const [draftError, setDraftError] = useState<string | null>(null)

    const update = (slot: PromptSlot, value: string) => {
        setValues(currentValues => ({ ...currentValues, [slot]: value }))
        setSaveState('idle')
    }

    const verify = async () => {
        const entries = (Object.keys(values) as PromptSlot[])
            .filter(slot => values[slot].trim().length > 0)
        setVerifying(true)
        setVerificationError(null)
        try {
            const checked = await Promise.all(entries.map(async slot => ({
                slot,
                results: (await verifyPromptTagsWithDanbooru(values[slot])).results,
            })))
            setVerification(checked)
        } catch (error) {
            setVerification([])
            setVerificationError(error instanceof Error ? error.message : String(error))
        } finally {
            setVerifying(false)
        }
    }

    const applyPrompt = () => {
        const generation = useGenerationStore.getState()
        generation.setBasePrompt(values.base)
        generation.setAdditionalPrompt(values.additional)
        generation.setDetailPrompt(values.detail)
        generation.setNegativePrompt(values.negative)
    }

    const savePreset = () => {
        const name = presetName.trim()
        if (!name) return
        setSaveState('saving')
        try {
            applyPrompt()
            usePresetStore.getState().saveWorkingCopyAs(name)
            setSaveState('saved')
        } catch {
            setSaveState('error')
        }
    }

    const createImageDraft = async () => {
        setSaveState('saving')
        setDraftError(null)
        try {
            applyPrompt()
            const generation = useGenerationStore.getState()
            const settings = useSettingsStore.getState()
            const now = new Date().toISOString()
            const initial = createSingleImageDraft({
                id: `guided-single-${crypto.randomUUID()}`,
                now,
                seed: generation.seedLocked ? generation.seed : generateRandomSeed(),
                model: generation.model,
                output: {
                    autoSave: settings.autoSave,
                    directory: settings.savePath,
                    useAbsolutePath: settings.useAbsolutePath,
                    capabilityFallbackDirectory: 'NAI_Blue_Output',
                    imageFormat: settings.imageFormat,
                    metadataMode: settings.metadataMode,
                    collisionPolicy: 'unique',
                },
            })
            const created = await getWorkflowDraftRepository().commit({
                expectedRevision: null,
                draft: initial,
            })
            if (created.status !== 'committed') throw new Error('Draft ID already exists')
            const updatedAt = new Date(Date.parse(now) + 1).toISOString()
            const prepared = reviseSingleImageDraft(initial, {
                updatedAt,
                status: 'review',
                currentNodeId: 'review',
                payload: {
                    ...initial.payload,
                    model: generation.model,
                    prompt: {
                        positive: composeGuidedPrompt(values),
                        negative: values.negative,
                    },
                    resolution: {
                        width: generation.selectedResolution.width,
                        height: generation.selectedResolution.height,
                    },
                    generation: {
                        steps: generation.steps,
                        cfgScale: generation.cfgScale,
                        cfgRescale: generation.cfgRescale,
                        sampler: generation.sampler,
                        scheduler: generation.scheduler,
                        smea: generation.smea,
                        smeaDyn: generation.smeaDyn,
                        variety: generation.variety,
                        seed: initial.payload.generation.seed,
                        qualityToggle: generation.qualityToggle,
                        ucPreset: generation.ucPreset,
                        transparentBackground: generation.transparentBackground,
                    },
                },
            })
            const committed = await getWorkflowDraftRepository().commit({
                expectedRevision: initial.revision,
                draft: prepared,
            })
            if (committed.status !== 'committed') throw new Error('Draft changed while it was prepared')
            announceGuidedDraftChange()
            setSaveState('saved')
            navigate(`/guided-preview/work/${prepared.id}/review`)
        } catch (error) {
            setSaveState('error')
            setDraftError(error instanceof Error ? error.message : String(error))
        }
    }

    const common = {
        steps,
        current,
        visit,
        canVisit: (step: typeof steps[number]['id']) => step !== 'review' || values.base.trim().length > 0,
        status: <SaveMessage state={saveState} />,
    }

    if (current === 'edit') {
        return (
            <PromptTaskFrame
                {...common}
                title={t('guided.promptTasks.direct.edit.title', '원하는 내용을 네 영역으로 나눠볼까요?')}
                description={t('guided.promptTasks.direct.edit.description', '핵심 장면부터 적고, 분위기·세부 묘사·제외 요소를 필요한 만큼만 더해 주세요. 입력 내용은 아직 생성 설정을 덮어쓰지 않아요.')}
                footer={<Button onClick={() => visit('verify')} disabled={!values.base.trim()}>{t('guided.promptTasks.next', '다음')}<ArrowRight className="ml-2 h-4 w-4" /></Button>}
            >
                <GuidedPromptFileImport
                    positive={composeGuidedPrompt(values)}
                    onReplace={value => {
                        if (value.positive) {
                            update('base', value.positive)
                            update('additional', '')
                            update('detail', '')
                        }
                        if (value.negative) update('negative', value.negative)
                    }}
                    onAppend={value => {
                        if (value.positive) update('base', appendPromptModuleLine(values.base, value.positive))
                        if (value.negative) update('negative', appendPromptModuleLine(values.negative, value.negative))
                    }}
                />
                <div className="mt-5">
                    <FourSlotPromptEditor values={values} onChange={update} />
                </div>
                <p className="mt-4 flex items-start gap-2 text-sm leading-6 text-muted-foreground">
                    <Sparkles className="mt-1 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                    {t('guided.promptTasks.direct.edit.help', '영문 태그와 영문 자연어를 모두 쓸 수 있어요. 자동완성 숫자는 참고용 태그 데이터의 게시물 수입니다.')}
                </p>
            </PromptTaskFrame>
        )
    }

    if (current === 'verify') {
        return (
            <PromptTaskFrame
                {...common}
                title={t('guided.promptTasks.direct.verify.title', '태그가 실제로 쓰이는지 확인해볼까요?')}
                description={t('guided.promptTasks.direct.verify.description', '로컬 태거가 각 영역의 Danbooru 게시물 수를 확인합니다. 자연어 문장은 건너뛰어도 괜찮아요.')}
                footer={<>
                    <Button variant="ghost" onClick={() => visit('edit')}>{t('guided.promptTasks.back', '이전')}</Button>
                    <Button onClick={() => visit('review')} disabled={!values.base.trim()}>{t('guided.promptTasks.next', '다음')}<ArrowRight className="ml-2 h-4 w-4" /></Button>
                </>}
            >
                <Button onClick={() => void verify()} disabled={verifying || !Object.values(values).some(value => value.trim())}>
                    {verifying ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
                    {t('guided.promptTasks.direct.verify.action', '태그 검증 시작')}
                </Button>
                {verificationError && <p className="mt-5 border-y border-destructive/45 py-3 text-sm text-destructive">{verificationError}</p>}
                <div className="mt-6 divide-y divide-border/55 border-y border-border/70">
                    {verification.map(group => (
                        <section key={group.slot} className="py-5">
                            <h2 className="text-base font-semibold">{t(`prompt.${group.slot}`, group.slot)}</h2>
                            <div className="mt-3 space-y-2">
                                {group.results.filter(result => result.status !== 'SKIPPED').map(result => {
                                    const replacement = result.recommended ?? result.suggestions[0]?.name ?? null
                                    return (
                                        <div key={`${result.raw}:${result.normalized}`} className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 py-2 text-sm">
                                            <span className="min-w-0 flex-1 break-words font-medium">{result.raw}</span>
                                            <span className="font-mono text-muted-foreground">{result.postCount?.toLocaleString() ?? '—'}</span>
                                            <span className={cn('font-semibold', result.status === 'OK' ? 'text-success' : 'text-warning')}>{result.status}</span>
                                            {replacement && replacement !== result.raw && (
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    onClick={() => update(group.slot, replaceGuidedPromptTag(values[group.slot], result.raw, replacement))}
                                                >
                                                    {replacement} {t('guided.promptTasks.direct.verify.replace', '로 바꾸기')}
                                                </Button>
                                            )}
                                        </div>
                                    )
                                })}
                            </div>
                        </section>
                    ))}
                    {!verifying && verification.length === 0 && !verificationError && (
                        <p className="py-8 text-center text-base text-muted-foreground">{t('guided.promptTasks.direct.verify.empty', '검증을 실행하거나 그대로 다음 단계로 넘어가세요.')}</p>
                    )}
                </div>
            </PromptTaskFrame>
        )
    }

    return (
        <PromptTaskFrame
            {...common}
            title={t('guided.promptTasks.direct.review.title', '다듬은 프롬프트를 어디에 둘까요?')}
            description={t('guided.promptTasks.direct.review.description', '현재 생성 설정에 적용하거나 이름 있는 프리셋으로 저장하고, 바로 이미지 한 장 만들기 흐름으로 이어갈 수 있어요.')}
            footer={<Button variant="ghost" onClick={() => visit('verify')}>{t('guided.promptTasks.back', '이전')}</Button>}
        >
            <section className="border-y border-border/70 py-5">
                <h2 className="text-sm font-semibold text-muted-foreground">{t('guided.promptTasks.direct.review.positive', '최종 긍정 프롬프트')}</h2>
                <p className="mt-2 whitespace-pre-wrap break-words text-base leading-7">{composeGuidedPrompt(values) || '—'}</p>
                <h2 className="mt-5 text-sm font-semibold text-muted-foreground">{t('guided.promptTasks.direct.review.negative', '제외할 요소')}</h2>
                <p className="mt-2 whitespace-pre-wrap break-words text-base leading-7">{values.negative || '—'}</p>
            </section>
            <div className="mt-7 grid gap-5 lg:grid-cols-2">
                <section className="border-y border-border/70 py-5">
                    <h2 className="text-lg font-semibold">{t('guided.promptTasks.direct.review.saveTitle', '다시 쓸 수 있게 저장')}</h2>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('guided.promptTasks.direct.review.saveDescription', '네 영역과 현재 생성 파라미터를 하나의 프리셋으로 보존합니다.')}</p>
                    <Input className="mt-4 text-base" value={presetName} onChange={event => setPresetName(event.target.value)} placeholder={t('guided.promptTasks.direct.review.presetName', '프리셋 이름')} />
                    <Button className="mt-3" variant="outline" onClick={savePreset} disabled={!presetName.trim() || saveState === 'saving'}>
                        <Save className="mr-2 h-4 w-4" />{t('guided.promptTasks.direct.review.save', '프리셋으로 저장')}
                    </Button>
                </section>
                <section className="border-y border-primary/45 py-5">
                    <h2 className="text-lg font-semibold">{t('guided.promptTasks.direct.review.createTitle', '이 프롬프트로 한 장 만들기')}</h2>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('guided.promptTasks.direct.review.createDescription', '현재 모델·해상도·세팅을 담은 A 초안을 만들고 Guided 최종 확인으로 이어집니다.')}</p>
                    <div className="mt-4 flex flex-wrap gap-2">
                        <Button variant="outline" onClick={applyPrompt}>{t('guided.promptTasks.direct.review.apply', '현재 설정에 적용')}</Button>
                        <Button onClick={() => void createImageDraft()} disabled={saveState === 'saving' || !composeGuidedPrompt(values)}>
                            <ImagePlus className="mr-2 h-4 w-4" />{t('guided.promptTasks.direct.review.create', 'A 초안 만들기')}
                        </Button>
                    </div>
                    {draftError && <p className="mt-3 text-sm text-destructive">{draftError}</p>}
                </section>
            </div>
        </PromptTaskFrame>
    )
}

function previewSource(combo: StyleCombination): string | null {
    if (combo.previewImage) return combo.previewImage
    if (combo.previewPath && !combo.previewPath.startsWith('memory://')) return toNativeAssetUrl(combo.previewPath)
    return combo.previewThumbnail ?? null
}

function GuidedStyleCandidate({ combo, selected, onSelect, disabled }: {
    combo: StyleCombination
    selected?: boolean
    onSelect?(): void
    disabled?: boolean
}) {
    const { t } = useTranslation()
    const source = previewSource(combo)
    return (
        <figure className={cn('min-w-0 border-y border-border/70 py-4', selected && 'border-primary')}>
            <div className="relative aspect-[4/3] overflow-hidden bg-muted/25">
                {source ? (
                    <img src={source} alt={t('styleLab.card.previewAlt', '스타일 후보 미리보기')} className="h-full w-full object-cover" />
                ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
                        {combo.isPreviewing ? <LoaderCircle className="h-8 w-8 animate-spin" /> : <FlaskConical className="h-8 w-8" />}
                        <span className="text-sm">{combo.isPreviewing ? t('guided.promptTasks.style.previewing', '미리보기 생성 중…') : t('styleLab.card.noPreview', '미리보기 없음')}</span>
                    </div>
                )}
                {combo.isPreviewing && <div className="absolute inset-x-0 bottom-0 h-1 bg-primary/20"><div className="h-full bg-primary" style={{ width: `${Math.max(8, (combo.previewProgress ?? 0) * 100)}%` }} /></div>}
            </div>
            <figcaption className="mt-3 break-words font-mono text-sm leading-6 text-muted-foreground">{formatWeightedPromptTags(combo.tags)}</figcaption>
            {combo.previewError && <p className="mt-2 text-sm text-destructive">{combo.previewError}</p>}
            {onSelect && (
                <Button className="mt-4 w-full rounded-none" variant={selected ? 'default' : 'outline'} disabled={disabled} onClick={onSelect}>
                    {selected ? <Check className="mr-2 h-4 w-4" /> : null}{t('guided.promptTasks.style.choose', '이 결과 선택')}
                </Button>
            )}
        </figure>
    )
}

function GuidedStyleLabTask() {
    const { t } = useTranslation()
    const steps = useMemo<readonly TaskStep<typeof GUIDED_PROMPT_TASK_STEP_IDS.styleLab[number]>[]>(() => [
        { id: 'base', label: t('guided.promptTasks.style.steps.base', '비교 기준') },
        { id: 'pool', label: t('guided.promptTasks.style.steps.pool', '작가와 조합') },
        { id: 'preview', label: t('guided.promptTasks.style.steps.preview', '같은 조건 미리보기') },
        { id: 'compare', label: t('guided.promptTasks.style.steps.compare', '선택과 적용') },
    ], [t])
    const { current, visit } = useGuidedTaskStep(steps)
    const basePrompt = useGenerationDraftStore(state => state.basePrompt)
    const setBasePrompt = useGenerationDraftStore(state => state.setBasePrompt)
    const model = useGenerationDraftStore(state => state.model)
    const setModel = useGenerationDraftStore(state => state.setModel)
    const resolution = useGenerationDraftStore(state => state.selectedResolution)
    const setResolution = useGenerationDraftStore(state => state.setSelectedResolution)
    const generationSteps = useGenerationDraftStore(state => state.steps)
    const setGenerationSteps = useGenerationDraftStore(state => state.setSteps)
    const sampler = useGenerationDraftStore(state => state.sampler)
    const setSampler = useGenerationDraftStore(state => state.setSampler)
    const activeCredentialsAreOpus = useAuthStore(selectActiveCredentialsAreOpus)
    const token1 = useAuthStore(state => state.token)
    const token2 = useAuthStore(state => state.token2)
    const verified1 = useAuthStore(state => state.isVerified)
    const verified2 = useAuthStore(state => state.isVerified2)
    const enabled1 = useAuthStore(state => state.slot1Enabled)
    const enabled2 = useAuthStore(state => state.slot2Enabled)
    const artists = useStyleLabStore(state => state.artists)
    const combinations = useStyleLabStore(state => state.combinations)
    const settings = useStyleLabStore(state => state.settings)
    const [artistInput, setArtistInput] = useState('')
    const [combinationCount, setCombinationCount] = useState(4)
    const [candidateIds, setCandidateIds] = useState<readonly string[]>([])
    const [pairIds, setPairIds] = useState<readonly [string, string] | null>(null)
    const [context, setContext] = useState<ReturnType<typeof captureCurrentStyleEvaluationContext> | null>(null)
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const [decision, setDecision] = useState<GuidedStyleDecision['kind'] | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [applied, setApplied] = useState(false)
    const [costConsented, setCostConsented] = useState(false)
    const previewInFlightRef = useRef(false)

    const activeTokenCount = Number(Boolean(token1 && verified1 && enabled1))
        + Number(Boolean(token2 && verified2 && enabled2))
    const pricingBasis = resolveAnlasPricingBasis({ model, activeCredentialsAreOpus })
    const estimatedAnlas = calculateAnlasCost({
        model,
        width: resolution.width,
        height: resolution.height,
        steps: generationSteps,
        imageCount: 1,
        pricingBasis,
    }) * 2

    const pair = useMemo(() => {
        if (!pairIds) return null
        const left = combinations.find(combo => combo.id === pairIds[0])
        const right = combinations.find(combo => combo.id === pairIds[1])
        return left && right ? { left, right } : null
    }, [combinations, pairIds])
    const verified = Boolean(pair && context
        && pair.left.lifecycle === 'eligible'
        && pair.right.lifecycle === 'eligible'
        && pair.left.previewContextId === context.id
        && pair.right.previewContextId === context.id)

    const invalidatePreview = () => {
        setCostConsented(false)
        setPairIds(null)
        setContext(null)
        setSelectedId(null)
        setDecision(null)
        setApplied(false)
    }

    const changeStyleSetting = (change: () => void) => {
        invalidatePreview()
        setError(null)
        change()
    }

    const generateCandidates = () => {
        setError(null)
        const state = useStyleLabStore.getState()
        if (artistInput.trim()) state.addArtists(artistInput)
        const count = Math.max(2, Math.min(8, Math.floor(combinationCount || 2)))
        const before = new Set(state.combinations.map(combo => combo.id))
        state.updateSettings({ randomBatchCount: count })
        state.generateRandomCombinations(count)
        const next = useStyleLabStore.getState().combinations
        const created = next.filter(combo => !before.has(combo.id)).map(combo => combo.id)
        const pool = (created.length >= 2 ? created : next.map(combo => combo.id)).slice(0, Math.max(2, count))
        if (pool.length < 2) {
            setError(t('guided.promptTasks.style.notEnoughCandidates', '비교할 조합을 두 개 이상 만들지 못했어요. 작가 태그를 더 추가해 주세요.'))
            return
        }
        setArtistInput('')
        setCombinationCount(count)
        setCandidateIds(pool)
        setPairIds(null)
        setContext(null)
        setSelectedId(null)
        setDecision(null)
        setApplied(false)
        setCostConsented(false)
        visit('preview')
    }

    const startPreview = async () => {
        if (previewInFlightRef.current || busy || !costConsented || activeTokenCount === 0) return
        previewInFlightRef.current = true
        setBusy(true)
        setError(null)
        try {
            const style = useStyleLabStore.getState()
            const candidates = candidateIds
                .map(id => style.combinations.find(combo => combo.id === id))
                .filter((combo): combo is StyleCombination => combo !== undefined)
            if (candidates.length < 2) throw new Error(t('guided.promptTasks.style.notEnoughCandidates', '비교할 조합이 두 개 이상 필요해요.'))
            const generation = useGenerationStore.getState()
            const evaluationSeed = generation.seedLocked
                ? generation.seed
                : style.reserveRandomSeed('guided-evaluation-context')
            const nextContext = captureCurrentStyleEvaluationContext([evaluationSeed])
            const approvedAt = new Date().toISOString()
            const costConsent = createAnlasCostConsentSnapshot({
                pricingBasis,
                estimatedAnlas,
                maxAnlas: estimatedAnlas,
                estimatedAt: approvedAt,
                approvedAt,
            })
            const result = await startGuidedStyleComparison({
                candidates,
                league: style.settings.battleLeague,
                context: nextContext,
                randomSeed: style.reserveRandomSeed('guided-arena-pair'),
                repository: getStyleLabRepository(),
                requestPreviews: requestStyleLabPreviewRenders,
                costConsent,
            })
            if (result === null) throw new Error(t('guided.promptTasks.style.noPair', '공정하게 비교할 두 후보를 고르지 못했어요. 조합을 다시 만들어 주세요.'))
            useStyleLabReadStore.getState().replacePreferenceProjections(result.projections)
            style.setArenaRound(result.pair, result.context)
            setPairIds(result.pair)
            setContext(result.context)
            setSelectedId(null)
            setDecision(null)
            setCostConsented(false)
            if (result.rejectedPreviewIds.length > 0) {
                setError(t('guided.promptTasks.style.previewRejected', '일부 미리보기를 대기열에 넣지 못했어요. 잠시 후 다시 시도해 주세요.'))
            }
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
            previewInFlightRef.current = false
            setBusy(false)
        }
    }

    const decide = async (nextDecision: GuidedStyleDecision) => {
        if (busy || context === null || pairIds === null) return
        setBusy(true)
        setError(null)
        try {
            const style = useStyleLabStore.getState()
            const result = await recordGuidedStyleDecision({
                candidates: style.combinations,
                context,
                repository: getStyleLabRepository(),
                decision: nextDecision,
            })
            useStyleLabReadStore.getState().replacePreferenceProjections(result.projections)
            if (nextDecision.kind === 'win') {
                style.recordBattle(nextDecision.winnerId, nextDecision.loserId)
                setSelectedId(nextDecision.winnerId)
            } else if (nextDecision.kind === 'tie') {
                style.recordBattleTie(nextDecision.leftId, nextDecision.rightId)
                setSelectedId(null)
            } else {
                style.clearArenaRound()
                setSelectedId(null)
            }
            setDecision(nextDecision.kind)
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
            setBusy(false)
        }
    }

    const applySelected = () => {
        const combo = useStyleLabStore.getState().combinations.find(candidate => candidate.id === selectedId)
        if (!combo) return
        const generation = useGenerationStore.getState()
        const tagText = formatWeightedPromptTags(combo.tags)
        generation.setAdditionalPrompt(compactPrompt(
            generation.additionalPrompt.trim() ? `${generation.additionalPrompt}, ${tagText}` : tagText,
        ))
        setApplied(true)
    }

    const common = {
        steps,
        current,
        visit,
        canVisit: (step: typeof steps[number]['id']) => {
            if (step === 'pool') return basePrompt.trim().length > 0
            if (step === 'preview') return candidateIds.length >= 2
            if (step === 'compare') return verified || decision !== null
            return true
        },
    }

    if (current === 'base') {
        return (
            <PromptTaskFrame
                {...common}
                title={t('guided.promptTasks.style.base.title', '스타일만 공정하게 비교할 기준을 정해요')}
                description={t('guided.promptTasks.style.base.description', '두 후보 모두 같은 프롬프트·모델·해상도·시드로 생성됩니다. 먼저 바뀌지 않을 장면 내용을 적어 주세요.')}
                footer={<Button onClick={() => visit('pool')} disabled={!basePrompt.trim()}>{t('guided.promptTasks.next', '다음')}<ArrowRight className="ml-2 h-4 w-4" /></Button>}
            >
                <GuidedPromptFileImport
                    positive={basePrompt}
                    disabled={busy}
                    onReplace={value => {
                        if (value.positive) changeStyleSetting(() => setBasePrompt(value.positive))
                    }}
                    onAppend={value => {
                        if (value.positive) changeStyleSetting(() => setBasePrompt(appendPromptModuleLine(basePrompt, value.positive)))
                    }}
                />
                <div className="h-72 border-y border-border/70">
                    <AutocompleteTextarea
                        value={basePrompt}
                        onChange={event => changeStyleSetting(() => setBasePrompt(event.target.value))}
                        ariaLabel={t('prompt.base', '메인 프롬프트')}
                        placeholder={t('guided.promptTasks.style.base.placeholder', '예: 1girl, portrait, quiet library, warm afternoon light')}
                        className="h-full min-h-full resize-none rounded-none border-0 bg-transparent text-base"
                    />
                </div>
                <section className="mt-7 space-y-7 border-y border-border/70 py-6" aria-labelledby="guided-style-settings-title">
                    <div>
                        <h2 id="guided-style-settings-title" className="text-lg font-semibold">
                            {t('guided.promptTasks.style.base.settingsTitle', '미리보기 생성 설정')}
                        </h2>
                        <p className="mt-1 text-sm leading-6 text-muted-foreground">
                            {t('guided.promptTasks.style.base.settingsDescription', '두 후보에 똑같이 적용할 모델, 해상도와 Steps를 여기서 확인하고 바꿀 수 있어요.')}
                        </p>
                    </div>

                    <fieldset className="divide-y divide-border/55 border-y border-border/55">
                        <legend className="mb-2 text-sm font-semibold">{t('guided.single.model.legend', '생성 모델')}</legend>
                        {GUIDED_STYLE_MODELS.map(option => (
                            <label key={option.id} className="flex min-h-20 cursor-pointer items-start gap-3 px-2 py-4 transition-colors hover:bg-accent/45">
                                <input
                                    type="radio"
                                    name="guided-style-model"
                                    value={option.id}
                                    checked={model === option.id}
                                    onChange={() => changeStyleSetting(() => setModel(option.id))}
                                    className="mt-1 h-4 w-4 accent-primary"
                                />
                                <span className="min-w-0">
                                    <span className="block text-sm font-semibold">{option.name}</span>
                                    <span className="mt-1 block text-sm leading-6 text-muted-foreground">
                                        {t(`guided.single.model.${option.id}`, option.description)}
                                    </span>
                                </span>
                            </label>
                        ))}
                    </fieldset>

                    <fieldset className="grid divide-y divide-border/55 border-y border-border/55 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                        <legend className="mb-2 text-sm font-semibold">{t('guided.single.resolution.legend', '이미지 비율과 해상도')}</legend>
                        {GUIDED_STYLE_RESOLUTIONS.map(option => (
                            <label key={option.id} className="relative flex min-h-24 cursor-pointer flex-col justify-center px-4 py-4 text-center transition-colors hover:bg-accent/45 focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring">
                                <input
                                    type="radio"
                                    name="guided-style-resolution"
                                    checked={resolution.width === option.width && resolution.height === option.height}
                                    onChange={() => changeStyleSetting(() => setResolution(option))}
                                    className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
                                />
                                <span className="text-sm font-semibold">{t(`guided.single.resolution.${option.id}`, option.id)}</span>
                                <span className="mt-1 font-mono text-sm text-muted-foreground">{option.width} × {option.height}</span>
                            </label>
                        ))}
                    </fieldset>

                    <GuidedResolutionDetails
                        width={resolution.width}
                        height={resolution.height}
                        steps={generationSteps}
                        imageCount={2}
                        estimatedAnlas={estimatedAnlas}
                        pricingBasis={pricingBasis}
                        onChange={(width, height) => changeStyleSetting(() => setResolution({
                            label: 'Custom',
                            width,
                            height,
                        }))}
                    />

                    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
                        <section aria-labelledby="guided-style-steps-label">
                            <div className="flex items-end justify-between gap-4">
                                <div>
                                    <h3 id="guided-style-steps-label" className="text-sm font-semibold">Steps</h3>
                                    <p className="mt-1 text-sm text-muted-foreground">{t('guided.single.settings.stepsShort', '이미지를 얼마나 세밀하게 다듬을지 정해요.')}</p>
                                </div>
                                <span className={cn('font-mono text-2xl font-semibold', generationSteps > 28 && 'text-warning')}>{generationSteps}</span>
                            </div>
                            <Slider
                                className="mt-4"
                                value={[generationSteps]}
                                min={1}
                                max={50}
                                step={1}
                                onValueChange={values => {
                                    const next = values[0]
                                    if (next !== undefined) changeStyleSetting(() => setGenerationSteps(next))
                                }}
                                aria-label="Steps"
                            />
                            <p className="mt-2 text-sm leading-6 text-muted-foreground">
                                {generationSteps <= 28
                                    ? t('guided.single.settings.stepsFree', '28은 안정적인 기본값이에요. Opus 포함 사용량이 적용될 수 있고, 실제 최대 Anlas는 검토 화면에서 확인해요.')
                                    : t('guided.single.settings.stepsPaid', '28을 넘으면 Anlas가 필요할 수 있어요. 높다고 항상 더 좋은 결과가 되는 건 아니에요.')}
                            </p>
                        </section>
                        <section>
                            <label htmlFor="guided-style-sampler" className="text-sm font-semibold">{t('guided.single.settings.sampler', '샘플러')}</label>
                            <p className="mt-1 text-sm text-muted-foreground">{t('guided.single.settings.samplerHelp', '노이즈를 이미지로 다듬는 방식이에요.')}</p>
                            <select
                                id="guided-style-sampler"
                                value={sampler}
                                onChange={event => changeStyleSetting(() => setSampler(event.target.value))}
                                className="mt-4 min-h-11 w-full border-x-0 border-y border-input bg-background px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                                {GUIDED_STYLE_SAMPLERS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                            </select>
                        </section>
                    </div>

                    <p className="border-y border-primary/35 py-4 text-base font-semibold text-primary">
                        {t('guided.promptTasks.style.preview.costSummary', '두 후보 · 최대 {{cost}} Anlas', { cost: estimatedAnlas.toLocaleString() })}
                    </p>
                </section>
            </PromptTaskFrame>
        )
    }

    if (current === 'pool') {
        return (
            <PromptTaskFrame
                {...common}
                title={t('guided.promptTasks.style.pool.title', '어떤 작가 태그를 섞어볼까요?')}
                description={t('guided.promptTasks.style.pool.description', '줄이나 쉼표로 작가 이름을 더하고, 한 번에 비교할 조합 수를 정해 주세요. 기본 목록은 그대로 사용해도 됩니다.')}
                footer={<>
                    <Button variant="ghost" onClick={() => visit('base')}>{t('guided.promptTasks.back', '이전')}</Button>
                    <Button onClick={generateCandidates}>{t('guided.promptTasks.style.pool.generate', '조합 만들기')}<ArrowRight className="ml-2 h-4 w-4" /></Button>
                </>}
            >
                <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_13rem]">
                    <section className="border-y border-border/70 py-4">
                        <Textarea value={artistInput} onChange={event => setArtistInput(event.target.value)} className="min-h-40 rounded-none border-x-0 text-base" placeholder="shnva&#10;necomi&#10;momoko (momopoco)" />
                        <div className="mt-4 flex flex-wrap gap-2 text-sm text-muted-foreground">
                            {artists.slice(0, 24).map(artist => <span key={artist} className="border-b border-border/70 px-1 py-1">{artist}</span>)}
                            {artists.length > 24 && <span className="px-1 py-1">+{artists.length - 24}</span>}
                        </div>
                    </section>
                    <section className="border-y border-border/70 py-4">
                        <label className="text-sm font-semibold" htmlFor="guided-style-count">{t('guided.promptTasks.style.pool.count', '조합 수')}</label>
                        <Input id="guided-style-count" type="number" min={2} max={8} value={combinationCount} onChange={event => setCombinationCount(Number(event.target.value))} className="mt-3 text-base" />
                        <p className="mt-3 text-sm leading-6 text-muted-foreground">{t('guided.promptTasks.style.pool.countHelp', '처음에는 4개가 비교하기 편해요. 실제 미리보기는 두 후보만 생성합니다.')}</p>
                        <p className="mt-3 text-sm text-muted-foreground">{t('guided.promptTasks.style.pool.range', '{{min}}~{{max}}개 태그 · 가중치 {{minWeight}}~{{maxWeight}}', {
                            min: settings.minTags,
                            max: settings.maxTags,
                            minWeight: settings.minWeight.toFixed(1),
                            maxWeight: settings.maxWeight.toFixed(1),
                        })}</p>
                    </section>
                </div>
                {error && <p className="mt-5 border-y border-destructive/45 py-3 text-sm text-destructive">{error}</p>}
            </PromptTaskFrame>
        )
    }

    if (current === 'preview') {
        return (
            <PromptTaskFrame
                {...common}
                title={t('guided.promptTasks.style.preview.title', '같은 조건으로 두 후보를 확인해요')}
                description={t('guided.promptTasks.style.preview.description', '한 번 누르면 공정한 두 후보를 고르고 durable 대기열에 넣습니다. 다른 작업으로 이동해도 생성은 이어집니다.')}
                footer={<>
                    <Button variant="ghost" onClick={() => visit('pool')}>{t('guided.promptTasks.back', '이전')}</Button>
                    <Button onClick={() => visit('compare')} disabled={!verified}>{t('guided.promptTasks.style.preview.compare', '결과 비교하기')}<ArrowRight className="ml-2 h-4 w-4" /></Button>
                </>}
            >
                <section className="mb-6 border-y border-primary/40 py-5" aria-labelledby="guided-style-cost-title">
                    <h2 id="guided-style-cost-title" className="text-sm font-semibold">
                        {t('guided.promptTasks.style.preview.costTitle', '두 이미지의 예상 비용')}
                    </h2>
                    <p className="mt-2 text-xl font-semibold text-primary">
                        {t('guided.promptTasks.style.preview.costSummary', '두 후보 · 최대 {{cost}} Anlas', { cost: estimatedAnlas.toLocaleString() })}
                    </p>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                        {pricingBasis === 'all-active-opus'
                            ? t('guided.promptTasks.style.preview.opusBasis', '활성 계정이 모두 Opus라서 1024² 이하·28 Steps까지는 0 Anlas로 계산해요.')
                            : t('guided.promptTasks.style.preview.paidBasis', '활성 계정의 무료 조건을 확정할 수 없어 안전하게 유료 기준으로 계산해요.')}
                    </p>
                    <NovelAiV5UsageLimit
                        model={model}
                        width={resolution.width}
                        height={resolution.height}
                        steps={generationSteps}
                        maxAnlas={estimatedAnlas}
                        className="mt-4"
                    />
                    <label className="choice-row mt-4 flex min-h-11 cursor-pointer items-start gap-3 text-sm leading-6">
                        <input
                            type="checkbox"
                            checked={costConsented}
                            onChange={event => setCostConsented(event.target.checked)}
                            className="choice-checkbox mt-1 h-4 w-4 accent-primary"
                        />
                        <span>{t('guided.promptTasks.style.preview.consent', '두 후보 생성에 최대 {{cost}} Anlas가 사용될 수 있음을 확인했어요.', { cost: estimatedAnlas.toLocaleString() })}</span>
                    </label>
                    {activeTokenCount === 0 && (
                        <p className="mt-3 text-sm text-destructive" role="alert">
                            {t('guided.promptTasks.style.preview.tokenRequired', '먼저 사용할 NovelAI API 토큰을 등록해 주세요.')}
                        </p>
                    )}
                </section>
                <Button onClick={() => void startPreview()} disabled={!costConsented || activeTokenCount === 0 || busy || pair?.left.isPreviewing || pair?.right.isPreviewing}>
                    {busy ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <ImagePlus className="mr-2 h-4 w-4" />}
                    {pair ? t('guided.promptTasks.style.preview.retry', '새 비교 미리보기') : t('guided.promptTasks.style.preview.start', '두 후보 미리보기 시작')}
                </Button>
                {pair && <div className="mt-7 grid gap-5 md:grid-cols-2"><GuidedStyleCandidate combo={pair.left} /><GuidedStyleCandidate combo={pair.right} /></div>}
                {pair && <p className={cn('mt-5 flex items-center gap-2 text-sm', verified ? 'text-success' : 'text-muted-foreground')} role="status">
                    {verified ? <CircleCheck className="h-4 w-4" /> : <LoaderCircle className="h-4 w-4 animate-spin" />}
                    {verified ? t('guided.promptTasks.style.preview.ready', '두 이미지가 같은 조건으로 준비됐어요.') : t('guided.promptTasks.style.preview.waiting', '대기열에서 두 이미지를 준비하고 있어요.')}
                </p>}
                {error && <p className="mt-5 border-y border-destructive/45 py-3 text-sm text-destructive">{error}</p>}
            </PromptTaskFrame>
        )
    }

    return (
        <PromptTaskFrame
            {...common}
            title={t('guided.promptTasks.style.compare.title', '어느 쪽 스타일이 더 마음에 드나요?')}
            description={t('guided.promptTasks.style.compare.description', '선택은 취향 기록에 안전하게 저장됩니다. 마음에 든 조합은 현재 보조 프롬프트에 바로 더할 수 있어요.')}
            footer={<Button variant="ghost" onClick={() => visit('preview')}>{t('guided.promptTasks.style.compare.another', '다른 후보 비교')}</Button>}
        >
            {pair ? (
                <>
                    <div className="grid gap-5 md:grid-cols-2">
                        <GuidedStyleCandidate
                            combo={pair.left}
                            selected={selectedId === pair.left.id}
                            disabled={busy || !verified || decision !== null}
                            onSelect={() => void decide({ kind: 'win', winnerId: pair.left.id, loserId: pair.right.id })}
                        />
                        <GuidedStyleCandidate
                            combo={pair.right}
                            selected={selectedId === pair.right.id}
                            disabled={busy || !verified || decision !== null}
                            onSelect={() => void decide({ kind: 'win', winnerId: pair.right.id, loserId: pair.left.id })}
                        />
                    </div>
                    <div className="mt-5 flex flex-wrap justify-center gap-2 border-y border-border/55 py-4">
                        <Button variant="outline" disabled={busy || !verified || decision !== null} onClick={() => void decide({ kind: 'tie', leftId: pair.left.id, rightId: pair.right.id })}>{t('styleLab.arena.tie', '비슷해요')}</Button>
                        <Button variant="ghost" disabled={busy || decision !== null} onClick={() => void decide({ kind: 'skip', leftId: pair.left.id, rightId: pair.right.id })}>{t('styleLab.arena.skip', '건너뛰기')}</Button>
                    </div>
                    {selectedId && (
                        <section className="mt-7 border-y border-primary/45 py-5 text-center">
                            <h2 className="text-xl font-semibold">{t('guided.promptTasks.style.compare.selected', '이 조합이 마음에 드나요?')}</h2>
                            <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('guided.promptTasks.style.compare.applyHelp', '현재 보조 프롬프트 뒤에 작가 조합을 추가합니다.')}</p>
                            <Button className="mt-4" onClick={applySelected} disabled={applied}>
                                {applied ? <CircleCheck className="mr-2 h-4 w-4" /> : <Sparkles className="mr-2 h-4 w-4" />}
                                {applied ? t('guided.promptTasks.style.compare.applied', '프롬프트에 적용했어요') : t('guided.promptTasks.style.compare.apply', '선택 조합 적용')}
                            </Button>
                        </section>
                    )}
                    {decision && !selectedId && <p className="mt-6 text-center text-base text-muted-foreground">{t('guided.promptTasks.style.compare.recorded', '선택을 기록했어요. 다른 후보를 비교해 보세요.')}</p>}
                </>
            ) : <p className="border-y border-border/70 py-10 text-center text-base text-muted-foreground">{t('guided.promptTasks.style.compare.missing', '먼저 같은 조건 미리보기를 준비해 주세요.')}</p>}
            {error && <p className="mt-5 text-sm text-destructive">{error}</p>}
        </PromptTaskFrame>
    )
}

function GuidedLocalAgentTask() {
    const { t } = useTranslation()
    const steps = useMemo<readonly TaskStep<typeof GUIDED_PROMPT_TASK_STEP_IDS.localAgent[number]>[]>(() => [
        { id: 'preset', label: t('guided.promptTasks.agent.steps.preset', '수정 대상') },
        { id: 'workspace', label: t('guided.promptTasks.agent.steps.workspace', '작업 폴더') },
        { id: 'result', label: t('guided.promptTasks.agent.steps.result', '반영 결과') },
    ], [t])
    const { current, visit } = useGuidedTaskStep(steps)
    const status = useSyncExternalStore(
        subscribeAgentWorkspaceBridge,
        getAgentWorkspaceBridgeStatus,
        getAgentWorkspaceBridgeStatus,
    )
    const presets = usePresetStore(state => state.presets)
    const activePresetId = usePresetStore(state => state.activePresetId)
    const loadPreset = usePresetStore(state => state.loadPreset)
    const saveActivePreset = usePresetStore(state => state.saveActivePreset)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const activePreset = presets.find(preset => preset.id === activePresetId) ?? presets[0] ?? null

    const refresh = async () => {
        setBusy(true)
        setError(null)
        try {
            saveActivePreset()
            await refreshAgentWorkspaceSnapshot(true)
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
            setBusy(false)
        }
    }
    const openWorkspace = async () => {
        setError(null)
        try {
            await openNativePath(status.workspacePath ?? await getAgentWorkspaceAbsolutePath())
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
        }
    }
    const common = { steps, current, visit }

    if (current === 'preset') {
        return (
            <PromptTaskFrame
                {...common}
                title={t('guided.promptTasks.agent.preset.title', 'AI가 다듬을 프리셋을 먼저 골라요')}
                description={t('guided.promptTasks.agent.preset.description', '에이전트는 선택한 프리셋의 네 프롬프트 영역과 생성 파라미터를 수정할 수 있어요. 현재 작업 내용을 먼저 저장하면 snapshot.json에 반영됩니다.')}
                footer={<Button onClick={() => visit('workspace')} disabled={!activePresetId}>{t('guided.promptTasks.next', '다음')}<ArrowRight className="ml-2 h-4 w-4" /></Button>}
            >
                <section className="border-y border-border/70 py-5">
                    <label htmlFor="guided-agent-preset" className="text-sm font-semibold">{t('guided.promptTasks.agent.preset.label', '수정할 프리셋')}</label>
                    <select
                        id="guided-agent-preset"
                        value={activePresetId}
                        onChange={event => loadPreset(event.target.value)}
                        className="mt-3 min-h-12 w-full border-x-0 border-y border-input bg-background px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        {presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
                    </select>
                    <Button className="mt-4" variant="outline" onClick={saveActivePreset}><Save className="mr-2 h-4 w-4" />{t('guided.promptTasks.agent.preset.saveCurrent', '현재 작업을 이 프리셋에 저장')}</Button>
                </section>
                <p className="mt-5 flex items-start gap-2 text-sm leading-6 text-muted-foreground"><ShieldCheck className="mt-1 h-4 w-4 shrink-0 text-success" />{t('guided.promptTasks.agent.privacy', 'NovelAI/R2 토큰, 이미지 원본, 썸네일과 생성 기록은 AI 작업 폴더에 들어가지 않아요.')}</p>
            </PromptTaskFrame>
        )
    }

    if (current === 'workspace') {
        return (
            <PromptTaskFrame
                {...common}
                title={t('guided.promptTasks.agent.workspace.title', 'AI에게 붙여넣을 프롬프트를 준비해요')}
                description={t('guided.promptTasks.agent.workspace.description', '원하는 템플릿을 고르면 프리셋 ID, snapshot revision과 작업 폴더가 자동으로 채워집니다. 필요한 경우 참조 파일도 직접 지정할 수 있어요.')}
                footer={<>
                    <Button variant="ghost" onClick={() => visit('preset')}>{t('guided.promptTasks.back', '이전')}</Button>
                    <Button onClick={() => visit('result')}>{t('guided.promptTasks.next', '결과 보기')}<ArrowRight className="ml-2 h-4 w-4" /></Button>
                </>}
            >
                {!status.supported ? (
                    <p className="border-y border-warning/50 py-5 text-base text-warning">{t('dataHub.agent.desktopRequired', '이 기능은 Tauri 데스크톱 앱에서 사용할 수 있어요.')}</p>
                ) : (
                    <>
                        <GuidedAgentPromptComposer
                            presetName={activePreset?.name ?? t('guided.promptTasks.agent.composer.unknownPreset', '선택한 프리셋')}
                            presetId={activePreset?.id ?? activePresetId}
                            revision={status.revision}
                            workspacePath={status.workspacePath ?? ''}
                        />
                        <section className="mt-6 border-y border-border/70 py-5">
                            <h2 className="text-base font-semibold">{t('guided.promptTasks.agent.workspace.syncTitle', '작업 폴더를 최신 상태로 준비')}</h2>
                            <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('guided.promptTasks.agent.workspace.syncDescription', 'AI가 파일을 다루기 전에 snapshot을 갱신하세요. request.json이 준비되면 앱이 검증하고 자동 반영합니다.')}</p>
                            <div className="mt-4 flex flex-wrap gap-2">
                            <Button onClick={() => void refresh()} disabled={busy}>{busy ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}{t('dataHub.agent.refresh', '현재 데이터 새로고침')}</Button>
                            <Button variant="outline" onClick={() => void openWorkspace()}><FolderOpen className="mr-2 h-4 w-4" />{t('dataHub.agent.openFolder', '작업 폴더 열기')}</Button>
                            </div>
                            <p className="mt-4 break-all font-mono text-sm text-muted-foreground">{status.workspacePath}</p>
                        </section>
                    </>
                )}
                {error && <p className="mt-5 text-sm text-destructive">{error}</p>}
            </PromptTaskFrame>
        )
    }

    return (
        <PromptTaskFrame
            {...common}
            title={t('guided.promptTasks.agent.result.title', 'AI의 요청이 안전하게 반영됐는지 확인해요')}
            description={t('guided.promptTasks.agent.result.description', 'result.json의 결과와 앱이 감시 중인 최신 리비전을 한 화면에서 확인할 수 있어요.')}
            footer={<Button variant="ghost" onClick={() => visit('workspace')}>{t('guided.promptTasks.back', '이전')}</Button>}
        >
            <section className="divide-y divide-border/55 border-y border-border/70" data-testid="guided-agent-status">
                {[
                    [t('dataHub.agent.status', '브리지 상태'), status.running ? t('dataHub.agent.watching', '변경 요청 감시 중') : t('dataHub.agent.stopped', '중지됨')],
                    [t('dataHub.agent.revision', '현재 리비전'), String(status.revision)],
                    [t('dataHub.agent.lastSnapshot', '마지막 데이터 갱신'), status.lastSnapshotAt ? new Date(status.lastSnapshotAt).toLocaleString() : '—'],
                    [t('dataHub.agent.lastRequest', '마지막 요청 ID'), status.lastRequestId ?? '—'],
                    [t('dataHub.agent.lastResult', '마지막 결과'), status.lastResult ?? '—'],
                ].map(([label, value]) => <div key={label} className="grid grid-cols-[minmax(9rem,0.4fr)_minmax(0,1fr)] gap-4 py-4 text-base"><span className="text-muted-foreground">{label}</span><span className="min-w-0 break-words font-medium">{value}</span></div>)}
            </section>
            {status.lastMessage && <p className={cn('mt-5 border-y py-4 text-base leading-7', status.lastResult === 'rejected' ? 'border-destructive/45 text-destructive' : 'border-success/35')}>{status.lastMessage}</p>}
            {status.lastError && <p className="mt-4 text-sm text-destructive">{status.lastError}</p>}
            <div className="mt-6 flex flex-wrap gap-2">
                <Button onClick={() => void refresh()} disabled={busy}>{busy ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}{t('dataHub.agent.refresh', '현재 데이터 새로고침')}</Button>
                <Button variant="outline" onClick={() => void openWorkspace()}><FileJson className="mr-2 h-4 w-4" />{t('guided.promptTasks.agent.result.open', '결과 파일 열기')}</Button>
            </div>
            {error && <p className="mt-5 text-sm text-destructive">{error}</p>}
        </PromptTaskFrame>
    )
}

export function GuidedPromptTasks({ taskId }: { taskId: GuidedPromptTaskId }) {
    if (taskId === 'styleLab') return <div data-testid="guided-prompt-task-styleLab"><GuidedStyleLabTask /></div>
    if (taskId === 'localAgent') return <div data-testid="guided-prompt-task-localAgent"><GuidedLocalAgentTask /></div>
    return <div data-testid="guided-prompt-task-direct"><GuidedDirectPromptTask /></div>
}
