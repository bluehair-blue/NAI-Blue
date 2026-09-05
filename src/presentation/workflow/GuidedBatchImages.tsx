import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import { HumanAssessmentSetup } from '@/components/assessment/HumanAssessmentSetup'
import type { GenerationAssessmentRequirement } from '@/domain/assessment/visual-rubric'
import { Link, useNavigate, useParams } from 'react-router'
import {
    ArrowLeft,
    Check,
    ChevronRight,
    CircleAlert,
    CircleCheck,
    Images,
    LoaderCircle,
    Pause,
    Play,
    Plus,
    RotateCcw,
    Sparkles,
    Trash2,
    XCircle,
} from 'lucide-react'

import { getWorkflowDraftRepository } from '@/adapters/workflow/indexeddb-workflow-draft-repository'
import { NovelAiV5UsageLimit } from '@/components/credentials/NovelAiV5UsageLimit'
import { PromptModuleCreator } from '@/components/fragments/PromptModuleCreator'
import { PromptModulePicker, appendPromptModuleLine } from '@/components/fragments/PromptModulePicker'
import Counter from '@/components/ui/counter'
import { AutocompleteTextarea } from '@/components/ui/AutocompleteTextarea'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/use-toast'
import type { GenerationBatch, GenerationBatchSummary, GenerationJob } from '@/domain/queue/types'
import {
    BATCH_IMAGE_NODE_IDS,
    createBatchImageDraft,
    isBatchImageDraft,
    isBatchImageDraftReady,
    listBatchImageDraftIssues,
    reviseBatchImageDraft,
    type BatchImageDraft,
    type BatchImageMode,
    type BatchImageNodeId,
    type BatchImageScene,
    type ReviseBatchImageDraftInput,
    type SingleImageGenerationSettings,
    type SingleImageOutputSettings,
    type WorkflowCharacterPrompts,
} from '@/domain/workflow/single-image-draft'
import { calculateAnlasCost, resolveAnlasPricingBasis } from '@/lib/anlas-calculator'
import { cn } from '@/lib/utils'
import {
    DEFAULT_NAI_IMAGE_MODEL,
    NAI_IMAGE_MODELS,
    getNaiImageModelName,
    getNovelAiModelProfile,
    isNovelAiV5Model,
} from '@/services/nai/model-catalog'
import { childOutputRef } from '@/services/output/platform-adapter'
import { createRuntimeOutputPlatformAdapter } from '@/services/output/tauri-output-adapter'
import { getRuntimeArtifactRepository } from '@/services/organizer/runtime'
import { getRuntimeQueueRepository } from '@/services/queue/indexeddb-queue-repository'
import { getRuntimeDurableQueueCoordinator } from '@/services/queue/runtime'
import { selectActiveCredentialsAreOpus, useAuthStore } from '@/stores/auth-store'
import { getFragmentCanonicalPath, useFragmentStore } from '@/stores/fragment-store'
import { usePresetStore, type PresetWorkingCopy } from '@/stores/preset-store'
import {
    WorkflowDraftCharacterPromptValidationError,
    WorkflowDraftPromptModuleResolutionError,
} from '@/presentation/generation/workflow-draft-main-batch-planner'
import { enqueueWorkflowDraftGenerationCommand } from '@/presentation/generation/workflow-draft-generation-command'
import { listGuidedBatchResultJobs } from './guided-batch-results'
import {
    GUIDED_GLOBAL_PROMPT_IMPORT_EVENT,
    GUIDED_QUEUE_ACTIVITY_REFRESH_EVENT,
    announceGuidedDraftChange,
    type GuidedGlobalPromptImportDetail,
} from './guided-draft-events'
import { GuidedPromptFileImport } from './GuidedPromptFileImport'
import { applyGuidedPromptImport } from './guided-prompt-import-application'
import type { GuidedPromptImportValue } from './guided-prompt-import'
import { GuidedResolutionDetails } from './GuidedResolutionDetails'
import { GuidedCharacterPromptSheet } from './GuidedCharacterPromptSheet'
import {
    GuidedDeliveryStep,
    GuidedMetadataStep,
    GuidedRightsStep,
} from './GuidedMetadataPolicy'
import { GuidedOutputDestinationStep } from './GuidedOutputDestinationStep'
import { StructuredPromptModuleLibrary } from '@/components/prompt-modules/StructuredPromptModuleLibrary'
import { insertStructuredPartsIntoWorkflow } from './structured-prompt-insertion'

export type GuidedBatchOptionId = 'sameSettings' | 'variations' | 'scenes' | 'queue'

type BatchRouteNodeId = BatchImageNodeId | 'result'
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'
type DraftPatch = Omit<ReviseBatchImageDraftInput, 'updatedAt'>

const BATCH_ROUTE_NODE_IDS = [...BATCH_IMAGE_NODE_IDS, 'result'] as const

function isBatchRouteNodeId(value: string | undefined): value is BatchRouteNodeId {
    return value !== undefined && BATCH_ROUTE_NODE_IDS.includes(value as BatchRouteNodeId)
}

const MODEL_OPTIONS = NAI_IMAGE_MODELS

const RESOLUTION_OPTIONS = [
    { id: 'portrait', width: 832, height: 1216 },
    { id: 'square', width: 1024, height: 1024 },
    { id: 'landscape', width: 1216, height: 832 },
] as const

const SAMPLER_OPTIONS = [
    { id: 'k_euler_ancestral', label: 'Euler Ancestral' },
    { id: 'k_dpmpp_2m_sde', label: 'DPM++ 2M SDE' },
    { id: 'k_dpmpp_2m', label: 'DPM++ 2M' },
    { id: 'k_euler', label: 'Euler' },
] as const

const MODE_BY_OPTION: Readonly<Partial<Record<GuidedBatchOptionId, BatchImageMode>>> = {
    sameSettings: 'same-settings',
    variations: 'variations',
    scenes: 'scenes',
}

function randomSeed(): number {
    const values = new Uint32Array(1)
    crypto.getRandomValues(values)
    return values[0] ?? 0
}

function nextTimestamp(draft: BatchImageDraft): string {
    return new Date(Math.max(Date.now(), Date.parse(draft.updatedAt) + 1)).toISOString()
}

function activeNodes(
    draft: BatchImageDraft,
    focusedNode: BatchRouteNodeId | null,
): readonly BatchRouteNodeId[] {
    const nodes: BatchRouteNodeId[] = []
    if (draft.payload.model === null) nodes.push('model')
    nodes.push('prompt', draft.payload.batchMode === 'scenes' ? 'scenes' : 'count')
    if (draft.payload.resolution === null) nodes.push('resolution')

    const detailNode = focusedNode ?? draft.currentNodeId
    const releaseOnly = detailNode === 'rights' || detailNode === 'delivery'
    if (!nodes.includes(detailNode)
        && detailNode !== 'review'
        && detailNode !== 'result'
        && (!releaseOnly || draft.payload.output.metadataMode === 'strip-and-sidecar')) {
        nodes.push(detailNode)
    }
    nodes.push('review', 'result')
    return nodes
}

function requestedCount(draft: BatchImageDraft): number {
    return draft.payload.batchMode === 'scenes'
        ? draft.payload.scenes.reduce((sum, scene) => sum + scene.count, 0)
        : draft.payload.count
}

function SaveIndicator({ status }: { status: SaveStatus }) {
    const { t } = useTranslation()
    return (
        <span className={cn(
            'inline-flex min-h-8 shrink-0 items-center gap-1.5 text-sm text-muted-foreground',
            status === 'error' && 'text-destructive',
        )} aria-live="polite">
            {status === 'saving' && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {status === 'saved' && <CircleCheck className="h-3.5 w-3.5 text-success" aria-hidden="true" />}
            {status === 'error' && <CircleAlert className="h-3.5 w-3.5" aria-hidden="true" />}
            {status === 'saving'
                ? t('guided.batch.save.saving', '저장 중…')
                : status === 'error'
                    ? t('guided.batch.save.error', '저장을 확인해 주세요')
                    : t('guided.batch.save.saved', '자동 저장됨')}
        </span>
    )
}

function BatchStepFrame({
    nodes,
    nodeId,
    saveStatus,
    title,
    description,
    canVisit,
    onVisit,
    onBack,
    footer,
    children,
}: {
    nodes: readonly BatchRouteNodeId[]
    nodeId: BatchRouteNodeId
    saveStatus: SaveStatus
    title: string
    description: string
    canVisit(nodeId: BatchRouteNodeId): boolean
    onVisit(nodeId: BatchRouteNodeId): void
    onBack(): void
    footer: ReactNode
    children: ReactNode
}) {
    const { t } = useTranslation()
    const titleRef = useRef<HTMLHeadingElement>(null)
    const index = nodes.indexOf(nodeId)

    useEffect(() => titleRef.current?.focus(), [nodeId])

    return (
        <div className={cn(
            'mx-auto flex min-h-full w-full flex-col px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-5 sm:px-6 sm:pt-8',
            nodeId === 'review' || nodeId === 'result'
                ? 'max-w-[var(--guided-review-max)]'
                : 'max-w-[var(--guided-question-max)]',
        )}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <Button type="button" variant="ghost" size="icon" onClick={onBack} aria-label={t('guided.batch.back', '이전으로')}>
                    <ArrowLeft className="h-5 w-5" aria-hidden="true" />
                </Button>
                <nav className="flex min-w-[16rem] flex-1 flex-wrap items-center gap-y-1 text-base leading-6 text-muted-foreground" aria-label={t('guided.batch.breadcrumb', '현재 작업 경로')}>
                    <Link to="/guided-preview" className="focus-ring hover:text-foreground">{t('guided.batch.home', '작업 홈')}</Link>
                    <ChevronRight className="mx-1 h-3.5 w-3.5" aria-hidden="true" />
                    <Link to="/guided-preview/guide/batch" className="focus-ring hover:text-foreground">
                        {t('guided.batch.title', '이미지 여러 장 만들기')}
                    </Link>
                    <ChevronRight className="mx-1 h-3.5 w-3.5" aria-hidden="true" />
                    <span className="font-medium text-foreground">{t(`guided.batch.steps.${nodeId}.short`, nodeId)}</span>
                </nav>
                <SaveIndicator status={saveStatus} />
            </div>

            <div className="mt-7">
                <div className="flex items-center justify-between gap-4 text-sm font-medium">
                    <span className="text-primary">{t('guided.batch.stepLabel', '단계 {{current}} · {{label}}', {
                        current: index + 1,
                        label: t(`guided.batch.steps.${nodeId}.short`, nodeId),
                    })}</span>
                    <span className="font-mono text-muted-foreground">{index + 1} / {nodes.length}</span>
                </div>
                <div className="mt-3 h-px bg-border">
                    <div className="h-full bg-primary transition-[width] duration-slow" style={{ width: `${((index + 1) / nodes.length) * 100}%` }} />
                </div>
                <ol className="mt-3 flex gap-5 overflow-x-auto pb-1 text-sm font-medium [scrollbar-width:none]" aria-label={t('guided.batch.stepNavigation', '세부 단계 이동')}>
                    {nodes.map((step, stepIndex) => (
                        <li key={step} className="shrink-0">
                            <button
                                type="button"
                                onClick={() => onVisit(step)}
                                disabled={!canVisit(step)}
                                aria-current={step === nodeId ? 'step' : undefined}
                                className={cn(
                                    'border-b py-1.5 transition-colors focus-ring',
                                    step === nodeId
                                        ? 'border-primary text-foreground'
                                        : canVisit(step)
                                            ? 'border-transparent text-muted-foreground hover:border-foreground/45 hover:text-foreground'
                                            : 'cursor-not-allowed border-transparent text-muted-foreground/40',
                                )}
                            >
                                <span className="mr-1 font-mono">{stepIndex + 1}</span>
                                {t(`guided.batch.steps.${step}.short`, step)}
                            </button>
                        </li>
                    ))}
                </ol>
            </div>

            <section className="flex-1 py-9 sm:py-12">
                <h1 ref={titleRef} tabIndex={-1} className="max-w-[24ch] text-3xl font-semibold tracking-[-0.03em] outline-none sm:text-4xl">{title}</h1>
                <p className="mt-3 max-w-[62ch] text-base leading-7 text-muted-foreground">{description}</p>
                <div className="mt-8">{children}</div>
            </section>

            <footer className="sticky bottom-0 z-10 -mx-4 flex min-h-[72px] flex-wrap items-center justify-end gap-2 border-t border-border/70 bg-background/95 px-4 py-3 text-base sm:-mx-6 sm:px-6">
                {footer}
            </footer>
        </div>
    )
}

function ModelStep({ draft, disabled, onSelect }: {
    draft: BatchImageDraft
    disabled: boolean
    onSelect(model: string): void
}) {
    const { t } = useTranslation()
    return (
        <fieldset className="divide-y divide-border/70 border-y border-border/70" disabled={disabled}>
            <legend className="sr-only">{t('guided.batch.model.legend', '생성 모델')}</legend>
            {MODEL_OPTIONS.map(option => {
                const checked = draft.payload.model === option.id
                return (
                    <label key={option.id} className={cn(
                        'relative flex min-h-[76px] cursor-pointer items-start gap-4 px-2 py-4 transition-colors hover:bg-accent/60 focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring',
                        checked && 'bg-primary/[0.055]',
                    )}>
                        <input type="radio" name="guided-batch-model" checked={checked} onChange={() => onSelect(option.id)} className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0" />
                        <span className={cn(
                            'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-input',
                            checked && 'border-primary bg-primary text-primary-foreground',
                        )} aria-hidden="true">{checked && <Check className="h-3 w-3" />}</span>
                        <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                                {option.name}
                                {option.recommended && <span className="bg-primary px-1.5 py-0.5 text-[11px] text-primary-foreground">{t('guided.batch.recommended', '추천')}</span>}
                            </span>
                            <span className="mt-1.5 block text-xs leading-5 text-muted-foreground">
                                {t(`guided.single.model.${option.id}`, option.description)}
                            </span>
                        </span>
                    </label>
                )
            })}
        </fieldset>
    )
}

function ModuleReferencePicker({ order, disabled, onSelect }: {
    order: 'random' | 'sequential'
    disabled: boolean
    onSelect(reference: string): void
}) {
    const { t } = useTranslation()
    const files = useFragmentStore(state => state.files)
    const [selectedId, setSelectedId] = useState('')
    const selected = files.find(file => file.id === selectedId) ?? null
    return (
        <div className="border-y border-border/60 py-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <label className="min-w-0 flex-1 text-sm font-medium">
                    {t('guided.batch.modules.file', '폴더별 프롬프트 모듈')}
                    <select
                        value={selectedId}
                        onChange={event => setSelectedId(event.target.value)}
                        disabled={disabled || files.length === 0}
                        className="mt-2 min-h-11 w-full border-x-0 border-y border-input bg-background px-3 text-base focus:border-primary focus:outline-none"
                    >
                        <option value="">{files.length === 0
                            ? t('guided.batch.modules.empty', '저장된 모듈이 없어요')
                            : t('guided.batch.modules.choose', '모듈을 선택하세요')}</option>
                        {files.map(file => <option key={file.id} value={file.id}>{getFragmentCanonicalPath(file)} · {file.lineCount}</option>)}
                    </select>
                </label>
                <Button
                    type="button"
                    variant="outline"
                    disabled={disabled || selected === null}
                    onClick={() => {
                        if (selected === null) return
                        const path = getFragmentCanonicalPath(selected)
                        onSelect(`<${order === 'sequential' ? '*' : ''}${path}>`)
                    }}
                >
                    <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
                    {t('guided.batch.modules.addReference', '프롬프트에 연결')}
                </Button>
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
                {order === 'sequential'
                    ? t('guided.batch.modules.sequentialHelp', '생성 순서대로 다음 줄을 사용해요. 성공한 작업만 모듈 순서를 넘깁니다.')
                    : t('guided.batch.modules.randomHelp', '각 이미지의 Seed에 따라 모듈 안의 한 줄을 안정적으로 골라요.')}
            </p>
        </div>
    )
}

function PromptStep({
    draft,
    positive,
    negative,
    characterPrompts,
    incomingImport,
    disabled,
    onPositive,
    onNegative,
    onTransparentBackground,
    onCharacterPrompts,
    onOrder,
    onIncomingImportHandled,
}: {
    draft: BatchImageDraft
    positive: string
    negative: string
    characterPrompts: WorkflowCharacterPrompts
    incomingImport: GuidedPromptImportValue | null
    disabled: boolean
    onPositive(value: string): void
    onNegative(value: string): void
    onTransparentBackground(value: boolean): void
    onCharacterPrompts(value: WorkflowCharacterPrompts): void
    onOrder(value: 'random' | 'sequential'): void
    onIncomingImportHandled(): void
}) {
    const { t } = useTranslation()
    const modelProfile = draft.payload.model === null ? undefined : getNovelAiModelProfile(draft.payload.model)
    const supportsTransparentBackground = modelProfile?.capabilities.transparentBackground === true
    const maxCharacters = modelProfile?.capabilities.maxCharacters
    const applyImport = (mode: 'replace' | 'append', imported: Parameters<typeof applyGuidedPromptImport>[1]) => {
        const importedCharacterCount = imported.characters?.length ?? 0
        const availableSlots = maxCharacters === undefined
            ? importedCharacterCount
            : Math.max(0, maxCharacters - (mode === 'append' ? characterPrompts.items.length : 0))
        const acceptedCharacterCount = Math.min(importedCharacterCount, availableSlots)
        const limitedImport = acceptedCharacterCount < importedCharacterCount
            ? { ...imported, characters: imported.characters?.slice(0, acceptedCharacterCount) }
            : imported
        if (acceptedCharacterCount < importedCharacterCount) {
            toast({
                title: t('guided.characters.importLimitedTitle', '일부 캐릭터만 불러왔어요'),
                description: acceptedCharacterCount === 0
                    ? t('guided.characters.limitReached', '현재 모델은 캐릭터를 최대 {{max}}명까지 사용할 수 있어요.', { max: maxCharacters })
                    : t('guided.characters.importedLimited', '남은 슬롯에 맞춰 {{count}}개만 추가했어요. 현재 모델의 최대값은 {{max}}명이에요.', {
                        count: acceptedCharacterCount,
                        max: maxCharacters,
                    }),
            })
        }
        const next = applyGuidedPromptImport({ positive, negative, characterPrompts }, limitedImport, {
            mode,
            createCharacterId: () => `guided-character-${crypto.randomUUID()}`,
            characterName: index => t('guided.characters.importedName', '가져온 캐릭터 {{index}}', { index: index + 1 }),
        })
        if (next.positive !== positive) onPositive(next.positive)
        if (next.negative !== negative) onNegative(next.negative)
        if (next.characterPrompts !== characterPrompts) onCharacterPrompts(next.characterPrompts)
    }
    const appendReference = (path: string) => onPositive(appendPromptModuleLine(
        positive,
        `<${draft.payload.variationOrder === 'sequential' ? '*' : ''}${path}>`,
    ))
    return (
        <div className="space-y-4">
            <GuidedPromptFileImport
                positive={positive}
                disabled={disabled}
                incomingImport={incomingImport}
                onIncomingImportHandled={onIncomingImportHandled}
                onReplace={value => applyImport('replace', value)}
                onAppend={value => applyImport('append', value)}
                onModuleCreated={draft.payload.batchMode === 'variations' ? appendReference : undefined}
            />
            <section className="border-y border-border/70 py-5">
                <h2 className="text-lg font-semibold">{draft.payload.batchMode === 'variations'
                    ? t('guided.batch.variation.fixedTitle', '1. 모든 이미지에 공통으로 넣을 내용')
                    : t('guided.batch.prompt.commonTitle', '모든 이미지에 공통으로 넣을 내용')}</h2>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{draft.payload.batchMode === 'variations'
                    ? t('guided.batch.variation.fixedDescription', '여기에 직접 적거나 “고정 문구 한 줄 불러오기”를 누른 내용은 모든 이미지에 그대로 반복됩니다.')
                    : t('guided.batch.prompt.commonDescription', '직접 적거나 저장한 모듈의 한 줄을 불러와 공통 프롬프트를 만드세요.')}</p>
                <div className="mt-3 flex flex-wrap justify-end gap-3">
                    <StructuredPromptModuleLibrary
                        disabled={disabled}
                        currentParts={{
                            base: positive,
                            negative,
                            character: characterPrompts.items[0]?.prompt,
                            'character-negative': characterPrompts.items[0]?.negative,
                        }}
                        onInsert={(parts, module) => {
                            const next = insertStructuredPartsIntoWorkflow({
                                positive,
                                negative,
                                characters: characterPrompts,
                                parts,
                                moduleName: module.name,
                            })
                            if (next.positive !== positive) onPositive(next.positive)
                            if (next.negative !== negative) onNegative(next.negative)
                            if (next.characters !== characterPrompts) onCharacterPrompts(next.characters)
                        }}
                    />
                    <PromptModulePicker
                        disabled={disabled}
                        showManageAction={false}
                        allowInlineManage
                        createSourceText={positive}
                        triggerLabel={t('guided.batch.prompt.fixedModule', '고정 문구 한 줄 불러오기')}
                        onSelectLine={line => onPositive(appendPromptModuleLine(positive, line))}
                    />
                </div>
                <div className="mt-3 h-64 sm:h-72">
                    <AutocompleteTextarea
                        value={positive}
                        onChange={event => onPositive(event.target.value)}
                        disabled={disabled}
                        placeholder={draft.payload.batchMode === 'scenes'
                            ? t('guided.batch.prompt.basePlaceholder', '모든 씬에 공통으로 적용할 표현 · 선택')
                            : t('guided.batch.prompt.placeholder', '예: 1girl, blue hair, quiet library, warm afternoon light')}
                        ariaLabel={t('guided.batch.prompt.label', '공통 프롬프트')}
                        maxSuggestions={8}
                        className="bg-card text-base"
                    />
                </div>
            </section>
            {draft.payload.batchMode === 'variations' && (
                <section className="border-y border-primary/35 py-5">
                    <h2 className="text-lg font-semibold">{t('guided.batch.variation.dynamicTitle', '2. 이미지마다 바꿀 내용을 모듈로 연결')}</h2>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('guided.batch.variation.dynamicDescription', '모듈은 한 줄이 하나의 후보입니다. 아래에서 무작위 또는 순서를 고른 뒤 모듈 파일을 연결하면, 생성할 때마다 해당 한 줄만 바뀝니다.')}</p>
                    <fieldset className="mt-4 grid divide-y divide-border/60 border-y border-border/60 sm:grid-cols-2 sm:divide-x sm:divide-y-0" disabled={disabled}>
                        <legend className="sr-only">{t('guided.batch.variation.order', '모듈 선택 순서')}</legend>
                        {(['random', 'sequential'] as const).map(order => (
                            <label key={order} className={cn(
                                'relative cursor-pointer px-4 py-4 text-sm transition-colors hover:bg-accent/55 focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring',
                                draft.payload.variationOrder === order && 'bg-primary/[0.055] text-primary',
                            )}>
                                <input type="radio" name="guided-batch-order" checked={draft.payload.variationOrder === order} onChange={() => onOrder(order)} className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0" />
                                <span className="font-semibold">{order === 'random'
                                    ? t('guided.batch.variation.random', '각 이미지마다 무작위 한 줄')
                                    : t('guided.batch.variation.sequential', '1번 줄부터 차례대로')}</span>
                            </label>
                        ))}
                    </fieldset>
                    <ModuleReferencePicker
                        order={draft.payload.variationOrder}
                        disabled={disabled}
                        onSelect={reference => onPositive(appendPromptModuleLine(positive, reference))}
                    />
                    <div className="mt-3 flex justify-end">
                        <PromptModuleCreator
                            disabled={disabled}
                            triggerLabel={t('guided.batch.modules.create', '새 변형 모듈 만들기')}
                            onCreated={appendReference}
                        />
                    </div>
                </section>
            )}
            <div className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
                <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                <p>{t('guided.batch.prompt.help', '영문 태그나 영문 문장을 쓸 수 있어요. 모듈 연결 표시는 실행 직전에 엄격하게 확인합니다.')}</p>
            </div>
            {supportsTransparentBackground && (
                <label className="guided-choice-row flex cursor-pointer items-start gap-3 border-y border-border/70 px-2 py-4 sm:px-4">
                    <input
                        type="checkbox"
                        checked={draft.payload.generation.transparentBackground ?? false}
                        disabled={disabled}
                        onChange={event => onTransparentBackground(event.target.checked)}
                        className="mt-0.5 h-4 w-4 accent-[oklch(var(--primary))]"
                    />
                    <span>
                        <span className="block text-sm font-semibold">
                            {t('guided.single.prompt.transparentBackground', '배경을 투명하게 만들기')}
                        </span>
                        <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                            {t('guided.single.prompt.transparentBackgroundHelp', '스티커나 캐릭터 소재처럼 배경 없이 쓰고 싶을 때 켜세요.')}
                        </span>
                    </span>
                </label>
            )}
            <GuidedCharacterPromptSheet
                value={characterPrompts}
                disabled={disabled}
                maxCharacters={maxCharacters}
                onChange={onCharacterPrompts}
            />
            <details className="border-y border-border/70 py-3">
                <summary className="cursor-pointer text-sm font-medium">{t('guided.batch.prompt.negativeTitle', '공통으로 피할 내용 · 선택')}</summary>
                <div className="mt-3 flex justify-end">
                    <PromptModulePicker disabled={disabled} showManageAction={false} allowInlineManage createSourceText={negative} triggerLabel={t('guided.batch.prompt.negativeModule', '제외 모듈 불러오기')} onSelectLine={line => onNegative(appendPromptModuleLine(negative, line))} />
                </div>
                <Textarea value={negative} onChange={event => onNegative(event.target.value)} disabled={disabled} className="mt-3 min-h-28 bg-card text-base" />
            </details>
        </div>
    )
}

function CountStep({ count, disabled, onChange }: { count: number; disabled: boolean; onChange(value: number): void }) {
    const { t } = useTranslation()
    return (
        <div className="border-y border-border/70 py-8 text-center">
            <p className="text-sm font-medium text-muted-foreground">{t('guided.batch.count.label', '생성할 이미지 수')}</p>
            <div className={cn('mt-5 inline-flex', disabled && 'pointer-events-none opacity-55')}>
                <Counter value={count} onChange={onChange} min={1} max={9999} fontSize={34} />
            </div>
            <p className="mx-auto mt-5 max-w-md text-sm leading-6 text-muted-foreground">
                {t('guided.batch.count.help', '대기열에 한 번에 추가되며, API 토큰이 두 개라면 가능한 작업은 나누어 진행해요.')}
            </p>
        </div>
    )
}

function ScenesStep({ scenes, disabled, onChange }: {
    scenes: readonly BatchImageScene[]
    disabled: boolean
    onChange(scenes: readonly BatchImageScene[]): void
}) {
    const { t } = useTranslation()
    const [importTargetId, setImportTargetId] = useState('')
    const importTarget = scenes.find(scene => scene.id === importTargetId) ?? scenes[0] ?? null
    const addScene = () => onChange([...scenes, {
        id: `scene-${crypto.randomUUID()}`,
        name: t('guided.batch.scenes.defaultName', '새 씬 {{number}}', { number: scenes.length + 1 }),
        positive: '',
        negative: '',
        count: 1,
    }])
    const patchScene = (id: string, patch: Partial<BatchImageScene>) => onChange(
        scenes.map(scene => scene.id === id ? { ...scene, ...patch } : scene),
    )
    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between gap-4">
                <p className="text-sm text-muted-foreground">{t('guided.batch.scenes.total', '총 {{count}}장', { count: scenes.reduce((sum, scene) => sum + scene.count, 0) })}</p>
                <Button type="button" variant="outline" onClick={addScene} disabled={disabled || scenes.length >= 100}>
                    <Plus className="mr-2 h-4 w-4" aria-hidden="true" />{t('guided.batch.scenes.add', '씬 추가')}
                </Button>
            </div>
            {importTarget && (
                <div className="space-y-3">
                    <label className="block text-sm font-semibold">
                        {t('guided.batch.scenes.importTarget', '메타데이터를 넣을 씬')}
                        <select
                            value={importTarget.id}
                            onChange={event => setImportTargetId(event.target.value)}
                            disabled={disabled}
                            className="mt-2 min-h-11 w-full border-x-0 border-y border-input bg-background px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            {scenes.map((scene, index) => (
                                <option key={scene.id} value={scene.id}>{index + 1}. {scene.name}</option>
                            ))}
                        </select>
                    </label>
                    <GuidedPromptFileImport
                        positive={importTarget.positive}
                        disabled={disabled}
                        onReplace={value => patchScene(importTarget.id, {
                            ...(value.positive ? { positive: value.positive } : {}),
                            ...(value.negative ? { negative: value.negative } : {}),
                        })}
                        onAppend={value => patchScene(importTarget.id, {
                            ...(value.positive ? { positive: appendPromptModuleLine(importTarget.positive, value.positive) } : {}),
                            ...(value.negative ? { negative: appendPromptModuleLine(importTarget.negative, value.negative) } : {}),
                        })}
                    />
                </div>
            )}
            <div className="divide-y divide-border/70 border-y border-border/70">
                {scenes.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">{t('guided.batch.scenes.empty', '먼저 씬을 하나 추가해 주세요.')}</p>}
                {scenes.map((scene, index) => (
                    <fieldset key={scene.id} className="py-5" disabled={disabled}>
                        <legend className="sr-only">{t('guided.batch.scenes.legend', '씬 {{number}}', { number: index + 1 })}</legend>
                        <div className="flex items-center gap-3">
                            <span className="font-mono text-sm text-primary">{String(index + 1).padStart(2, '0')}</span>
                            <Input value={scene.name} onChange={event => patchScene(scene.id, { name: event.target.value })} className="h-10 flex-1 border-x-0 border-t-0 bg-transparent text-base" aria-label={t('guided.batch.scenes.name', '씬 이름')} />
                            <Button type="button" variant="ghost" size="icon" onClick={() => onChange(scenes.filter(item => item.id !== scene.id))} aria-label={t('guided.batch.scenes.remove', '씬 삭제')}>
                                <Trash2 className="h-4 w-4" aria-hidden="true" />
                            </Button>
                        </div>
                        <Textarea value={scene.positive} onChange={event => patchScene(scene.id, { positive: event.target.value })} className="mt-4 min-h-28 bg-card text-base" placeholder={t('guided.batch.scenes.positive', '이 씬에서 보여줄 장면을 적어 주세요')} />
                        <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                            <Textarea value={scene.negative} onChange={event => patchScene(scene.id, { negative: event.target.value })} className="min-h-20 bg-card" placeholder={t('guided.batch.scenes.negative', '이 씬에서 피할 내용 · 선택')} />
                            <div className="pb-1 text-center">
                                <span className="mb-2 block text-xs text-muted-foreground">{t('guided.batch.scenes.count', '장수')}</span>
                                <Counter value={scene.count} onChange={count => patchScene(scene.id, { count })} min={1} max={999} />
                            </div>
                        </div>
                    </fieldset>
                ))}
            </div>
        </div>
    )
}

function ResolutionStep({ draft, disabled, imageCount, estimatedAnlas, pricingBasis, onResolution }: {
    draft: BatchImageDraft
    disabled: boolean
    imageCount: number
    estimatedAnlas: number
    pricingBasis: 'all-active-opus' | 'paid'
    onResolution(width: number, height: number): void
}) {
    const { t } = useTranslation()
    const generation = draft.payload.generation
    const resolution = draft.payload.resolution ?? RESOLUTION_OPTIONS[0]

    return (
        <div className="space-y-8">
            <fieldset className="grid divide-y divide-border/55 border-y border-border/55 sm:grid-cols-3 sm:divide-x sm:divide-y-0" disabled={disabled}>
                <legend className="sr-only">{t('guided.batch.settings.resolution', '해상도')}</legend>
                {RESOLUTION_OPTIONS.map(option => {
                    const checked = draft.payload.resolution?.width === option.width && draft.payload.resolution.height === option.height
                    return (
                        <label key={option.id} className={cn('relative cursor-pointer px-3 py-5 text-center transition-colors hover:bg-accent/55 focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring', checked && 'bg-primary/[0.055] text-primary')}>
                            <input type="radio" name="guided-batch-resolution" checked={checked} onChange={() => onResolution(option.width, option.height)} className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0" />
                            <span className="block text-sm font-semibold">{t(`guided.batch.resolution.${option.id}`, option.id)}</span>
                            <span className="mt-1 block font-mono text-xs text-muted-foreground">{option.width} × {option.height}</span>
                        </label>
                    )
                })}
            </fieldset>

            <GuidedResolutionDetails
                width={resolution.width}
                height={resolution.height}
                steps={generation.steps}
                imageCount={imageCount}
                estimatedAnlas={draft.payload.resolution === null ? null : estimatedAnlas}
                pricingBasis={pricingBasis}
                disabled={disabled}
                onChange={onResolution}
            />
        </div>
    )
}

function SettingsStep({ draft, disabled, onGeneration }: {
    draft: BatchImageDraft
    disabled: boolean
    onGeneration(patch: Partial<SingleImageGenerationSettings>): void
}) {
    const { t } = useTranslation()
    const generation = draft.payload.generation
    return (
        <div className="divide-y divide-border/70 border-y border-border/70">
            <label className="grid gap-2 py-4 sm:grid-cols-[minmax(12rem,1fr)_9rem] sm:items-center">
                <span>
                    <span className="block text-sm font-semibold">Steps</span>
                    <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                        {t('guided.batch.settings.stepsHelp', '28까지는 기본 범위예요. 더 높이면 지시 이행이 늘 수 있지만 항상 더 좋은 결과를 뜻하지는 않아요.')}
                    </span>
                </span>
                <Input type="number" min={1} max={50} value={generation.steps} disabled={disabled} onChange={event => onGeneration({ steps: Math.max(1, Math.min(50, Number(event.target.value) || 1)) })} className="text-base" />
            </label>
            <label className="grid gap-2 py-4 sm:grid-cols-[minmax(12rem,1fr)_13rem] sm:items-center">
                <span>
                    <span className="block text-sm font-semibold">Sampler</span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                        {t('guided.batch.settings.samplerHelp', '추천값을 그대로 사용해도 충분해요.')}
                    </span>
                </span>
                <select value={generation.sampler} disabled={disabled} onChange={event => onGeneration({ sampler: event.target.value })} className="min-h-11 border-x-0 border-y border-input bg-background px-3 text-sm focus:border-primary focus:outline-none">
                    {SAMPLER_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
            </label>
            <details className="py-4">
                <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-semibold marker:text-primary">
                    {t('guided.batch.settings.advanced', '세부 조정 · 선택')}
                </summary>
                <label className="mt-3 grid gap-2 border-t border-border/55 pt-4 sm:grid-cols-[minmax(12rem,1fr)_9rem] sm:items-center">
                    <span>
                        <span className="block text-sm font-semibold">Prompt Guidance</span>
                        <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                            {t('guided.batch.settings.cfgHelp', '높일수록 프롬프트를 강하게 따르지만 화면이 거칠어질 수 있어요.')}
                        </span>
                    </span>
                    <Input type="number" min={0} max={10} step={0.1} value={generation.cfgScale} disabled={disabled} onChange={event => onGeneration({ cfgScale: Math.max(0, Math.min(10, Number(event.target.value) || 0)) })} className="text-base" />
                </label>
            </details>
        </div>
    )
}

function ReviewStep({ draft, activeTokenCount, estimatedAnlas, consented, submitting, submitError, onConsent, onEdit, onSubmit, assessmentValid = true }: {
    assessmentValid?: boolean
    draft: BatchImageDraft
    activeTokenCount: number
    estimatedAnlas: number
    consented: boolean
    submitting: boolean
    submitError: string | null
    onConsent(value: boolean): void
    onEdit(node: BatchImageNodeId): void
    onSubmit(): void
}) {
    const { t } = useTranslation()
    const metadataLabel = draft.payload.output.metadataMode === 'embedded'
        ? t('guided.metadata.embedded', '이미지에 포함')
        : draft.payload.output.metadataMode === 'sidecar-only'
            ? t('guided.metadata.sidecar', '이미지 유지 + sidecar')
            : draft.payload.output.metadataMode === 'strip-and-sidecar'
                ? t('guided.metadata.clean', '공유용 정화 + sidecar · 권장')
                : t('guided.metadata.stripOnly', '정화만 · 비권장')
    const rows = [
        { label: t('guided.batch.review.mode', '방식'), value: draft.payload.batchMode, node: 'model' as const },
        { label: t('guided.batch.review.model', '모델'), value: getNaiImageModelName(draft.payload.model), node: 'model' as const },
        { label: t('guided.batch.review.prompt', '프롬프트'), value: draft.payload.prompt.positive || t('guided.batch.review.scenePrompts', '씬별 프롬프트'), node: 'prompt' as const },
        ...(draft.payload.characterPrompts.items.some(character => character.enabled) ? [{
            label: t('guided.batch.review.characters', '캐릭터'),
            value: t('guided.batch.review.characterCount', '{{count}}명 활성', {
                count: draft.payload.characterPrompts.items.filter(character => character.enabled).length,
            }),
            node: 'prompt' as const,
        }] : []),
        { label: t('guided.batch.review.count', '생성 수'), value: t('guided.batch.review.countValue', '{{count}}장', { count: requestedCount(draft) }), node: draft.payload.batchMode === 'scenes' ? 'scenes' as const : 'count' as const },
        { label: t('guided.batch.review.resolution', '해상도'), value: `${draft.payload.resolution?.width ?? '—'} × ${draft.payload.resolution?.height ?? '—'}`, node: 'resolution' as const },
        {
            label: t('guided.batch.review.settings', '생성 설정'),
            value: `${draft.payload.generation.steps} Steps · ${SAMPLER_OPTIONS.find(item => item.id === draft.payload.generation.sampler)?.label ?? draft.payload.generation.sampler} · CFG ${draft.payload.generation.cfgScale}${draft.payload.generation.transparentBackground === true ? ` · ${t('guided.single.review.transparentBackground', '투명 배경 사용')}` : ''}`,
            node: 'settings' as const,
        },
        {
            label: t('guided.batch.review.output', '저장'),
            value: `${draft.payload.output.generationFolderPath ? `${draft.payload.output.generationFolderPath} · ` : ''}${draft.payload.output.directory} · ${draft.payload.output.imageFormat.toUpperCase()}`,
            node: 'output' as const,
        },
        {
            label: t('guided.batch.review.metadata', '메타데이터'),
            value: draft.payload.output.metadataMode === 'strip-and-sidecar'
                ? `${metadataLabel} · ${draft.payload.output.autoR2UploadProfileId
                    ? t('guided.batch.review.r2On', 'R2 자동 업로드')
                    : t('guided.batch.review.r2Off', '로컬에만 저장')}`
                : metadataLabel,
            node: 'metadata' as const,
        },
    ]
    return (
        <div className="space-y-6">
            <dl className="divide-y divide-border/70 border-y border-border/70">
                {rows.map(row => (
                    <div key={row.label} className="grid gap-2 py-4 sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:items-center">
                        <dt className="text-sm font-medium text-muted-foreground">{row.label}</dt>
                        <dd className="line-clamp-2 break-words text-sm font-medium">{row.value}</dd>
                        <Button type="button" variant="ghost" size="sm" onClick={() => onEdit(row.node)}>{t('guided.batch.review.edit', '수정')}</Button>
                    </div>
                ))}
            </dl>
            {draft.payload.resolution !== null && (
                <NovelAiV5UsageLimit
                    model={draft.payload.model}
                    width={draft.payload.resolution.width}
                    height={draft.payload.resolution.height}
                    steps={draft.payload.generation.steps}
                    maxAnlas={estimatedAnlas}
                />
            )}
            <div className="border-y border-border/70 py-4 text-sm">
                <span className="text-muted-foreground">
                    {estimatedAnlas === 0
                        ? t('guided.batch.review.estimatedCost', '예상 비용')
                        : t('guided.batch.review.maximumEstimatedCost', '예상 최대 비용')}
                </span>
                <span className="ml-3 font-semibold">
                    {estimatedAnlas === 0
                        ? t('guided.batch.review.free', '0 Anlas · 무료 조건')
                        : t('guided.batch.review.maxAnlas', '최대 {{cost}} Anlas', { cost: estimatedAnlas.toLocaleString() })}
                </span>
            </div>
            {estimatedAnlas > 0 && (
                <label className="flex cursor-pointer items-start gap-3 border-y border-primary/35 py-5">
                    <input type="checkbox" checked={consented} onChange={event => onConsent(event.target.checked)} className="mt-1 h-4 w-4 accent-primary" />
                    <span className="min-w-0 text-sm leading-6">
                        <span className="block font-semibold">{t('guided.batch.review.costConsent', '최대 {{cost}} Anlas 사용에 동의해요.', { cost: estimatedAnlas.toLocaleString() })}</span>
                    </span>
                </label>
            )}
            <p className="text-sm leading-6 text-muted-foreground">{t('guided.batch.review.queueHelp', '다른 작업이 실행 중이면 다음 순서에서 자동으로 시작합니다.')}</p>
            {activeTokenCount === 0 && <p className="text-sm text-destructive" role="alert">{t('guided.batch.review.tokenRequired', '먼저 사용할 NovelAI API 토큰을 등록해 주세요.')}</p>}
            {submitError !== null && <p className="text-sm text-destructive" role="alert">{submitError}</p>}
            <Button type="button" className="w-full" onClick={onSubmit} disabled={!assessmentValid || (estimatedAnlas > 0 && !consented) || submitting || activeTokenCount === 0 || !isBatchImageDraftReady(draft)}>
                {submitting ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Images className="mr-2 h-4 w-4" aria-hidden="true" />}
                {t('guided.batch.review.enqueue', '{{count}}장 만들기', { count: requestedCount(draft) })}
            </Button>
        </div>
    )
}

async function readJobArtifact(jobId: string, artifactId: string | null): Promise<Uint8Array> {
    const durableArtifactId = artifactId ?? `artifact:${jobId}`
    const artifact = await getRuntimeArtifactRepository().get(durableArtifactId)
    if (artifact === null) throw new Error('The completed result artifact is unavailable')
    const platform = createRuntimeOutputPlatformAdapter()
    const directory = await platform.resolveDirectory({
        portableDirectory: artifact.original.file.directory,
        workflowDefaultDirectory: 'NAI_Blue_Output',
    })
    return platform.readFile(childOutputRef(directory, artifact.original.file.fileName))
}

function ResultCard({ job, format }: { job: GenerationJob; format: 'png' | 'webp' }) {
    const { t } = useTranslation()
    const [url, setUrl] = useState<string | null>(null)
    const [failed, setFailed] = useState(false)
    const artifactId = job.artifactReference?.artifactId ?? null
    useEffect(() => {
        let active = true
        let objectUrl: string | null = null
        setFailed(false)
        void readJobArtifact(job.id, artifactId).then(bytes => {
            if (!active) return
            const owned = Uint8Array.from(bytes)
            objectUrl = URL.createObjectURL(new Blob([owned.buffer], { type: `image/${format}` }))
            setUrl(objectUrl)
        }).catch(() => { if (active) setFailed(true) })
        return () => {
            active = false
            if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
        }
    }, [artifactId, format, job.id])
    return (
        <figure className="border-b border-border/70 pb-4">
            <div className="flex aspect-square items-center justify-center bg-muted/35">
                {url !== null
                    ? <img src={url} alt={t('guided.batch.result.imageAlt', '완성된 이미지 {{number}}', { number: job.ordinal + 1 })} className="h-full w-full object-contain" />
                    : failed
                        ? <CircleAlert className="h-5 w-5 text-destructive" aria-label={t('guided.batch.result.previewFailed', '미리보기를 불러오지 못함')} />
                        : <LoaderCircle className="h-5 w-5 animate-spin text-primary" aria-label={t('guided.batch.result.previewLoading', '미리보기 불러오는 중')} />}
            </div>
            <figcaption className="mt-3 min-w-0 text-xs leading-5 text-muted-foreground">
                <span className="block font-mono text-foreground">#{job.ordinal + 1}</span>
                <span className="mt-1 block line-clamp-2 break-words">{job.snapshot.prompt.positive}</span>
            </figcaption>
        </figure>
    )
}

function ResultGallery({
    draft,
    summary,
    jobs,
    hasMore,
    loadingMore,
    onLoadMore,
    onEdit,
    onRetry,
}: {
    draft: BatchImageDraft
    summary: GenerationBatchSummary | null
    jobs: readonly GenerationJob[]
    hasMore: boolean
    loadingMore: boolean
    onLoadMore(): void
    onEdit(): void
    onRetry(): void
}) {
    const { t } = useTranslation()
    const saveSnapshot = usePresetStore(state => state.saveSnapshot)
    const succeeded = summary?.states.succeeded ?? jobs.length
    const total = summary?.total ?? requestedCount(draft)
    const attention = (summary?.states.failed ?? 0) + (summary?.states.blocked ?? 0)
    const stopped = (summary?.states.cancelled ?? 0) + (summary?.states.skipped ?? 0)
    const settled = succeeded + attention + stopped
    const active = (summary?.states.queued ?? 0)
        + (summary?.states.leased ?? 0)
        + (summary?.states.running ?? 0)
        + (summary?.states.recovering ?? 0)
    const finishedWithIssues = summary !== null && total > 0 && active === 0 && succeeded !== total
    const savePreset = () => {
        if (draft.payload.resolution === null) return
        const generation = draft.payload.generation
        const resolution = draft.payload.resolution
        const workingCopy: PresetWorkingCopy = {
            basePrompt: draft.payload.prompt.positive,
            additionalPrompt: '',
            detailPrompt: '',
            negativePrompt: draft.payload.prompt.negative,
            model: draft.payload.model ?? DEFAULT_NAI_IMAGE_MODEL,
            steps: generation.steps,
            cfgScale: generation.cfgScale,
            cfgRescale: generation.cfgRescale,
            sampler: generation.sampler,
            scheduler: generation.scheduler,
            smea: generation.smea,
            smeaDyn: generation.smeaDyn,
            variety: generation.variety,
            qualityToggle: generation.qualityToggle,
            ucPreset: generation.ucPreset,
            transparentBackground: generation.transparentBackground ?? false,
            selectedResolution: {
                label: `${resolution.width} × ${resolution.height}`,
                width: resolution.width,
                height: resolution.height,
            },
        }
        const timestamp = new Intl.DateTimeFormat(undefined, {
            dateStyle: 'short',
            timeStyle: 'short',
        }).format(new Date())
        saveSnapshot(`Guided · ${timestamp}`, workingCopy)
        toast({
            title: t('guided.batch.result.presetSaved', '프롬프트와 생성 설정을 프리셋에 저장했어요.'),
            variant: 'success',
        })
    }
    return (
        <div className="space-y-8">
            <div className="border-y border-border/70 py-5" aria-live="polite">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-base font-semibold">{succeeded === total
                        ? t('guided.batch.result.complete', '모든 이미지가 완성됐어요.')
                        : finishedWithIssues
                            ? t('guided.batch.result.finishedWithIssues', '작업이 멈췄어요. 완성된 결과와 대기열 상태를 확인해 주세요.')
                            : t('guided.batch.result.progress', '이미지를 만들고 있어요.')}</span>
                    <span className="font-mono text-sm text-primary">{succeeded} / {total}</span>
                </div>
                <div className="mt-3 h-px bg-border"><div className="h-full bg-primary transition-[width]" style={{ width: `${total === 0 ? 0 : (settled / total) * 100}%` }} /></div>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">{t('guided.batch.result.background', '다른 작업으로 이동해도 대기열은 계속 실행되며, 완성된 결과부터 여기에 나타나요.')}</p>
                {attention > 0 && <p className="mt-2 text-sm text-destructive" role="alert">{t('guided.batch.result.failedCount', '{{count}}개 작업은 확인이 필요해요. 아래 큐 관리에서 다시 시도할 수 있어요.', { count: attention })}</p>}
                {stopped > 0 && <p className="mt-2 text-sm text-muted-foreground">{t('guided.batch.result.stoppedCount', '{{count}}개 작업은 취소되었거나 앞 작업 중단으로 건너뛰었어요.', { count: stopped })}</p>}
            </div>
            {jobs.length > 0 ? (
                <>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-7 md:grid-cols-3 xl:grid-cols-4">
                        {jobs.map(job => <ResultCard key={`${job.id}:${job.version}`} job={job} format={draft.payload.output.imageFormat} />)}
                    </div>
                    {(hasMore || succeeded > jobs.length) && (
                        <div className="flex justify-center border-b border-border/70 pb-5">
                            <Button type="button" variant="outline" onClick={onLoadMore} disabled={loadingMore}>
                                {loadingMore && <LoaderCircle className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                                {t('guided.batch.result.loadMore', '다음 결과 {{count}}개 보기', { count: Math.min(48, succeeded - jobs.length) })}
                            </Button>
                        </div>
                    )}
                </>
            ) : (
                <div className="flex min-h-56 flex-col items-center justify-center border-y border-border/70 px-4 text-center">
                    {finishedWithIssues
                        ? <CircleAlert className="h-6 w-6 text-destructive" aria-hidden="true" />
                        : <LoaderCircle className="h-6 w-6 animate-spin text-primary" aria-hidden="true" />}
                    <p className="mt-4 text-sm text-muted-foreground">{finishedWithIssues
                        ? t('guided.batch.result.noSuccessfulResults', '완성된 결과가 없어요. 대기열 관리에서 실패·취소 상태를 확인해 주세요.')
                        : t('guided.batch.result.waiting', '첫 번째 결과를 기다리고 있어요.')}</p>
                </div>
            )}
            <section className="border-y border-primary/30 py-6">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">{t('guided.batch.result.next', '다음 작업')}</p>
                <h2 className="mt-2 text-2xl font-semibold tracking-[-0.025em]">{t('guided.batch.result.keepTitle', '이 설정이 마음에 든다면?')}</h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{t('guided.batch.result.keepHelp', '초안은 이미 보존되어 있어요. 같은 설정으로 다시 만들거나 프롬프트를 조금 바꿔 이어갈 수 있어요.')}</p>
                <div className="mt-5 flex flex-wrap gap-2">
                    <Button type="button" onClick={onRetry}><RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />{t('guided.batch.result.regenerate', '같은 설정으로 다시 만들기')}</Button>
                    <Button type="button" variant="outline" onClick={onEdit}>{t('guided.batch.result.edit', '프롬프트 수정하기')}</Button>
                    <Button type="button" variant="outline" onClick={savePreset}>{t('guided.batch.result.savePreset', '이 설정을 프리셋으로 저장')}</Button>
                    <Button asChild variant="ghost"><Link to="/guided-preview/task/batch/queue">{t('guided.batch.result.queue', '대기열 관리')}</Link></Button>
                </div>
            </section>
        </div>
    )
}

function GuidedBatchStarter({ mode }: { mode: BatchImageMode }) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const [drafts, setDrafts] = useState<readonly BatchImageDraft[]>([])
    const [loading, setLoading] = useState(true)
    const [creating, setCreating] = useState(false)
    const [error, setError] = useState(false)
    const createInFlightRef = useRef(false)

    useEffect(() => {
        let active = true
        void getWorkflowDraftRepository().list().then(items => {
            if (!active) return
            setDrafts(items.filter((draft): draft is BatchImageDraft => (
                isBatchImageDraft(draft) && draft.payload.batchMode === mode
            )))
            setLoading(false)
        }).catch(() => {
            if (!active) return
            setError(true)
            setLoading(false)
        })
        return () => { active = false }
    }, [mode])

    const resume = (draft: BatchImageDraft) => {
        const node = draft.status === 'queued' || draft.status === 'completed'
            ? 'result'
            : draft.currentNodeId
        navigate(`/guided-preview/batch/${draft.id}/${node}`)
    }

    const createNew = async () => {
        if (createInFlightRef.current) return
        createInFlightRef.current = true
        setCreating(true)
        setError(false)
        try {
            const repository = getWorkflowDraftRepository()
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const now = new Date().toISOString()
                const draft = createBatchImageDraft({
                    id: `guided-batch-${crypto.randomUUID()}`,
                    now,
                    seed: randomSeed(),
                    batchMode: mode,
                })
                const result = await repository.commit({ expectedRevision: null, draft })
                if (result.status === 'conflict') continue
                announceGuidedDraftChange()
                navigate(`/guided-preview/batch/${draft.id}/prompt`)
                return
            }
            throw new Error('Draft identity remained contended')
        } catch {
            setError(true)
        } finally {
            createInFlightRef.current = false
            setCreating(false)
        }
    }

    const recent = drafts[0] ?? null
    const modeLabel = mode === 'same-settings'
        ? t('guided.batch.starter.sameSettings', '같은 설정으로 여러 장')
        : mode === 'variations'
            ? t('guided.batch.starter.variations', '프롬프트를 바꾸며 여러 장')
            : t('guided.batch.starter.scenes', '씬을 나눠 여러 장')

    if (loading) {
        return (
            <div className="flex min-h-full items-center justify-center" role="status">
                <LoaderCircle className="h-5 w-5 animate-spin text-primary" aria-hidden="true" />
                <span className="ml-3 text-sm text-muted-foreground">{t('guided.batch.starting', '이전 작업을 확인하는 중…')}</span>
            </div>
        )
    }
    return (
        <div className="mx-auto flex min-h-full w-full max-w-[var(--guided-question-max)] flex-col justify-center px-4 py-10 sm:px-6">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">{t('guided.batch.starter.eyebrow', '여러 장 만들기')}</p>
            <h1 className="mt-3 max-w-[22ch] text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">{modeLabel}</h1>
            <p className="mt-3 max-w-[58ch] text-base leading-7 text-muted-foreground">
                {recent === null
                    ? t('guided.batch.starter.first', '새 작업을 시작하면 선택한 내용이 자동으로 저장돼요.')
                    : t('guided.batch.starter.savedCount', '이 방식으로 저장한 초안이 {{count}}개 있어요. 최근 작업을 이어가거나 새로 시작할 수 있어요.', { count: drafts.length })}
            </p>

            {recent !== null && (
                <section className="mt-8 border-y border-border/70 py-5" aria-labelledby="guided-batch-recent-heading">
                    <p id="guided-batch-recent-heading" className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{t('guided.batch.starter.recent', '최근 초안')}</p>
                    <p className="mt-2 line-clamp-2 break-words text-base font-semibold">
                        {recent.payload.prompt.positive.trim() || modeLabel}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                        {t('guided.batch.starter.recentMeta', '{{status}} · {{count}}장 · {{time}}', {
                            status: t(`guided.activity.status.${recent.status}`, recent.status),
                            count: requestedCount(recent),
                            time: new Date(recent.updatedAt).toLocaleString(),
                        })}
                    </p>
                    <Button type="button" className="mt-5" onClick={() => resume(recent)}>
                        {t('guided.batch.starter.resume', '최근 작업 이어하기')}
                    </Button>
                </section>
            )}

            <div className="mt-6 border-b border-border/70 pb-6">
                <Button type="button" variant={recent === null ? 'default' : 'outline'} onClick={() => void createNew()} disabled={creating}>
                    {creating ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Plus className="mr-2 h-4 w-4" aria-hidden="true" />}
                    {t('guided.batch.starter.new', '새 작업 시작')}
                </Button>
                {error && (
                    <div className="mt-4 flex items-start gap-2 text-sm text-destructive" role="alert">
                        <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                        <p>{t('guided.batch.startError', '배치 초안을 시작하지 못했어요.')}</p>
                    </div>
                )}
            </div>
            <Button asChild variant="ghost" className="mt-3 self-start px-0">
                <Link to="/guided-preview/guide/batch"><ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />{t('guided.batch.starter.other', '다른 방식 고르기')}</Link>
            </Button>
        </div>
    )
}

function retryIdentity(batchId: string): string {
    return `retry-${batchId.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 96)}`
}

export function GuidedBatchQueueSurface() {
    const { t } = useTranslation()
    const repository = useMemo(() => getRuntimeQueueRepository(), [])
    const coordinator = useMemo(() => getRuntimeDurableQueueCoordinator(), [])
    const [batches, setBatches] = useState<readonly GenerationBatch[]>([])
    const [busyId, setBusyId] = useState<string | null>(null)
    const [failed, setFailed] = useState(false)
    const refresh = useCallback(() => {
        void repository.listBatches().then(items => {
            setBatches(items.slice(0, 20))
            setFailed(false)
        }).catch(() => setFailed(true))
    }, [repository])
    useEffect(() => {
        refresh()
        window.addEventListener(GUIDED_QUEUE_ACTIVITY_REFRESH_EVENT, refresh)
        return () => window.removeEventListener(GUIDED_QUEUE_ACTIVITY_REFRESH_EVENT, refresh)
    }, [refresh])
    const run = async (batchId: string, action: () => Promise<unknown>) => {
        setBusyId(batchId)
        try {
            await action()
            refresh()
        } catch {
            setFailed(true)
        } finally {
            setBusyId(null)
        }
    }
    const retryFailed = (batch: GenerationBatch) => {
        const id = retryIdentity(batch.id)
        return repository.retryFailedJobs({
            sourceBatchId: batch.id,
            targetBatch: {
                id,
                workflow: batch.workflow,
                createdAt: new Date().toISOString(),
                failurePolicy: batch.failurePolicy,
                origin: 'retry',
                idempotencyKey: id,
            },
        })
    }
    return (
        <div className="mx-auto min-h-full w-full max-w-[var(--guided-review-max)] px-4 py-8 sm:px-6">
            <div className="flex flex-wrap items-center gap-3">
                <Button asChild variant="ghost" size="icon"><Link to="/guided-preview/guide/batch" aria-label={t('guided.batch.queue.back', '여러 장 만들기 방식 선택으로')}><ArrowLeft className="h-5 w-5" /></Link></Button>
                <div className="min-w-0 flex-1">
                    <h1 className="text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">{t('guided.batch.queue.title', '진행 중인 작업을 살펴볼까요?')}</h1>
                    <p className="mt-2 text-base leading-7 text-muted-foreground">{t('guided.batch.queue.description', '여기서 대기열을 잠시 멈추거나, 실패한 항목만 다시 시도할 수 있어요.')}</p>
                </div>
            </div>
            <div className="mt-8 divide-y divide-border/70 border-y border-border/70">
                {failed && <p className="py-6 text-sm text-destructive" role="alert">{t('guided.batch.queue.loadError', '대기열을 불러오지 못했어요.')}</p>}
                {!failed && batches.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">{t('guided.batch.queue.empty', '아직 실행 중인 작업이 없어요.')}</p>}
                {batches.map(batch => {
                    const summary = batch.projectionSummary
                    const retryable = summary.states.failed > 0
                    const busy = busyId === batch.id
                    return (
                        <section key={batch.id} className="py-5">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <p className="break-all text-sm font-semibold">{batch.workflow} · {new Date(batch.createdAt).toLocaleString()}</p>
                                    <p className="mt-1 text-sm text-muted-foreground">{t('guided.batch.queue.summary', '{{completed}} / {{total}} 완료 · 대기 {{waiting}} · 실행 {{running}} · 확인 {{attention}}', {
                                        completed: summary.completed,
                                        total: summary.total,
                                        waiting: summary.states.queued,
                                        running: summary.states.leased + summary.states.running + summary.states.recovering,
                                        attention: summary.states.failed + summary.states.blocked,
                                    })}</p>
                                </div>
                                <span className="font-mono text-xs uppercase tracking-wide text-primary">{batch.state}</span>
                            </div>
                            <div className="mt-4 flex flex-wrap gap-2">
                                {batch.state === 'active' ? (
                                    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void run(batch.id, () => coordinator.pauseBatch(batch.id))}><Pause className="mr-2 h-4 w-4" />{t('guided.batch.queue.pause', '잠시 멈춤')}</Button>
                                ) : (
                                    <Button type="button" variant="outline" size="sm" disabled={busy || batch.state === 'stopped'} onClick={() => void run(batch.id, () => coordinator.resumeBatch(batch.id))}><Play className="mr-2 h-4 w-4" />{t('guided.batch.queue.resume', '계속 실행')}</Button>
                                )}
                                <Button type="button" variant="outline" size="sm" disabled={busy || !retryable} onClick={() => void run(batch.id, () => retryFailed(batch))}><RotateCcw className="mr-2 h-4 w-4" />{t('guided.batch.queue.retry', '실패만 다시 시도')}</Button>
                                <Button type="button" variant="ghost" size="sm" disabled={busy || summary.completed === summary.total} onClick={() => void run(batch.id, () => coordinator.cancelBatch(batch.id))}><XCircle className="mr-2 h-4 w-4" />{t('guided.batch.queue.cancel', '남은 작업 취소')}</Button>
                            </div>
                        </section>
                    )
                })}
            </div>
        </div>
    )
}

export function GuidedBatchTask({ optionId }: { optionId?: GuidedBatchOptionId }) {
    const params = useParams<{ optionId: string }>()
    const selected = optionId ?? params.optionId
    if (selected === 'queue') return <GuidedBatchQueueSurface />
    const mode = MODE_BY_OPTION[selected as GuidedBatchOptionId]
    if (mode === undefined) return <GuidedBatchQueueSurface />
    return <GuidedBatchStarter mode={mode} />
}

export function GuidedBatchImages() {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const params = useParams<{ draftId: string; nodeId: string }>()
    const draftId = params.draftId ?? ''
    const [draft, setDraft] = useState<BatchImageDraft | null>(null)
    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState(false)
    const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
    const [positive, setPositive] = useState('')
    const [negative, setNegative] = useState('')
    const [characterPrompts, setCharacterPrompts] = useState<WorkflowCharacterPrompts>({
        positionEnabled: false,
        items: [],
    })
    const [incomingImport, setIncomingImport] = useState<GuidedPromptImportValue | null>(null)
    const [scenes, setScenes] = useState<readonly BatchImageScene[]>([])
    const [consented, setConsented] = useState(false)
    const [assessment, setAssessment] = useState<GenerationAssessmentRequirement | null>(null)
    const [assessmentValid, setAssessmentValid] = useState(true)
    useEffect(() => {
        setAssessment(null)
        setAssessmentValid(true)
    }, [params.draftId])
    const [submitting, setSubmitting] = useState(false)
    const [submitError, setSubmitError] = useState<string | null>(null)
    const [summary, setSummary] = useState<GenerationBatchSummary | null>(null)
    const [resultJobs, setResultJobs] = useState<readonly GenerationJob[]>([])
    const [resultLimit, setResultLimit] = useState(48)
    const [resultHasMore, setResultHasMore] = useState(false)
    const [resultLoading, setResultLoading] = useState(false)
    const draftRef = useRef<BatchImageDraft | null>(null)
    const saveChainRef = useRef<Promise<void>>(Promise.resolve())
    const editableTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const editableRef = useRef<{
        positive: string
        negative: string
        scenes: readonly BatchImageScene[]
        characterPrompts: WorkflowCharacterPrompts
    }>({
        positive: '',
        negative: '',
        scenes: [],
        characterPrompts: { positionEnabled: false, items: [] },
    })
    const completingRef = useRef(false)

    const activeCredentialsAreOpus = useAuthStore(selectActiveCredentialsAreOpus)
    const token1 = useAuthStore(state => state.token)
    const token2 = useAuthStore(state => state.token2)
    const verified1 = useAuthStore(state => state.isVerified)
    const verified2 = useAuthStore(state => state.isVerified2)
    const enabled1 = useAuthStore(state => state.slot1Enabled)
    const enabled2 = useAuthStore(state => state.slot2Enabled)
    const activeTokenCount = Number(Boolean(token1 && verified1 && enabled1)) + Number(Boolean(token2 && verified2 && enabled2))
    const resultTerminal = summary !== null
        && (
            summary.states.queued
            + summary.states.leased
            + summary.states.running
            + summary.states.recovering
        ) === 0

    const commitMutation = useCallback((mutation: (current: BatchImageDraft) => DraftPatch): Promise<BatchImageDraft> => {
        setSaveStatus('saving')
        const operation = saveChainRef.current.then(async () => {
            const current = draftRef.current
            if (current === null) throw new Error('Workflow draft is not loaded')
            const next = reviseBatchImageDraft(current, { ...mutation(current), updatedAt: nextTimestamp(current) })
            const result = await getWorkflowDraftRepository().commit({ expectedRevision: current.revision, draft: next })
            if (result.status === 'conflict') {
                if (result.current !== null && isBatchImageDraft(result.current)) {
                    draftRef.current = result.current
                    setDraft(result.current)
                }
                throw new Error('Workflow draft changed in another window')
            }
            if (!isBatchImageDraft(result.draft)) throw new Error('Workflow draft kind changed')
            draftRef.current = result.draft
            setDraft(result.draft)
            setSaveStatus('saved')
            announceGuidedDraftChange()
            return result.draft
        }).catch(error => { setSaveStatus('error'); throw error })
        saveChainRef.current = operation.then(() => undefined, () => undefined)
        return operation
    }, [])

    const saveEditable = useCallback(async (): Promise<BatchImageDraft | null> => {
        const current = draftRef.current
        if (current === null) return null
        const values = editableRef.current
        if (current.payload.prompt.positive === values.positive
            && current.payload.prompt.negative === values.negative
            && JSON.stringify(current.payload.scenes) === JSON.stringify(values.scenes)
            && JSON.stringify(current.payload.characterPrompts) === JSON.stringify(values.characterPrompts)) return current
        return commitMutation(latest => ({
            payload: {
                ...latest.payload,
                prompt: { positive: values.positive, negative: values.negative },
                scenes: values.scenes,
                characterPrompts: values.characterPrompts,
            },
        }))
    }, [commitMutation])

    const scheduleEditableSave = useCallback(() => {
        setConsented(false)
        if (editableTimerRef.current !== null) clearTimeout(editableTimerRef.current)
        editableTimerRef.current = setTimeout(() => {
            editableTimerRef.current = null
            void saveEditable().catch(() => undefined)
        }, 400)
    }, [saveEditable])

    useEffect(() => {
        const handleGlobalImport = (event: Event) => {
            if (!(event instanceof CustomEvent)) return
            const detail = event.detail as GuidedGlobalPromptImportDetail
            if (detail.kind !== 'batch' || detail.draftId !== draftId) return
            event.preventDefault()

            const current = draftRef.current
            if (current === null) return
            const returningFromResult = current.status === 'queued' || current.status === 'completed'

            const editable = editableRef.current
            if (editableTimerRef.current !== null) {
                clearTimeout(editableTimerRef.current)
                editableTimerRef.current = null
            }

            void commitMutation(latest => ({
                ...(returningFromResult ? { status: 'review' as const, lastSnapshotId: null } : {}),
                currentNodeId: 'prompt',
                payload: {
                    ...latest.payload,
                    prompt: { positive: editable.positive, negative: editable.negative },
                    scenes: editable.scenes,
                    characterPrompts: editable.characterPrompts,
                },
            })).then(saved => {
                if (returningFromResult) {
                    setSummary(null)
                    setResultJobs([])
                    setResultLimit(48)
                    setConsented(false)
                }
                setIncomingImport(detail.value)
                navigate(`/guided-preview/batch/${saved.id}/prompt`)
                toast({
                    title: t('metadata.globalApplied', '프롬프트를 불러왔어요.'),
                    description: t('metadata.globalGuided', '현재 초안을 유지한 채 프롬프트 단계로 돌아왔어요. 교체하거나 뒤에 추가할 내용을 골라 주세요.'),
                    variant: 'success',
                })
            }).catch(() => {
                toast({
                    title: t('guided.batch.save.error', '저장을 확인해 주세요'),
                    variant: 'destructive',
                })
            })
        }
        window.addEventListener(GUIDED_GLOBAL_PROMPT_IMPORT_EVENT, handleGlobalImport)
        return () => window.removeEventListener(GUIDED_GLOBAL_PROMPT_IMPORT_EVENT, handleGlobalImport)
    }, [commitMutation, draftId, navigate, t])

    useEffect(() => {
        let active = true
        void getWorkflowDraftRepository().get(draftId).then(found => {
            if (!active) return
            if (!isBatchImageDraft(found)) { navigate('/guided-preview', { replace: true }); return }
            draftRef.current = found
            setDraft(found)
            editableRef.current = {
                positive: found.payload.prompt.positive,
                negative: found.payload.prompt.negative,
                scenes: found.payload.scenes,
                characterPrompts: found.payload.characterPrompts,
            }
            setPositive(found.payload.prompt.positive)
            setNegative(found.payload.prompt.negative)
            setScenes(found.payload.scenes)
            setCharacterPrompts(found.payload.characterPrompts)
            setLoading(false)
        }).catch(() => { if (active) { setLoadError(true); setLoading(false) } })
        return () => { active = false }
    }, [draftId, navigate])

    useEffect(() => () => {
        if (editableTimerRef.current !== null) clearTimeout(editableTimerRef.current)
        void saveEditable().catch(() => undefined)
    }, [saveEditable])

    useEffect(() => {
        const batchId = draft?.lastSnapshotId
        if (batchId === null || batchId === undefined) {
            setSummary(null)
            setResultJobs([])
            setResultHasMore(false)
            return
        }
        let active = true
        const refresh = () => {
            setResultLoading(true)
            void Promise.all([
                getRuntimeQueueRepository().getBatchSummary(batchId),
                listGuidedBatchResultJobs(batchId, resultLimit),
            ]).then(([nextSummary, window]) => {
                if (!active) return
                setSummary(nextSummary)
                setResultJobs(window.items)
                setResultHasMore(window.hasMore)
            }).catch(() => undefined).finally(() => {
                if (active) setResultLoading(false)
            })
        }
        refresh()
        if (resultTerminal) return () => { active = false }
        window.addEventListener(GUIDED_QUEUE_ACTIVITY_REFRESH_EVENT, refresh)
        return () => { active = false; window.removeEventListener(GUIDED_QUEUE_ACTIVITY_REFRESH_EVENT, refresh) }
    }, [draft?.lastSnapshotId, resultLimit, resultTerminal])

    useEffect(() => {
        setResultLimit(48)
    }, [draft?.lastSnapshotId])

    useEffect(() => {
        if (draft === null || summary === null || completingRef.current
            || draft.status !== 'queued' || summary.total === 0
            || summary.states.succeeded !== summary.total) return
        completingRef.current = true
        void commitMutation(current => current.status === 'queued' ? { status: 'completed' } : {}).finally(() => { completingRef.current = false })
    }, [commitMutation, draft, summary])

    useEffect(() => {
        if (draft === null) return
        const requested = isBatchRouteNodeId(params.nodeId) ? params.nodeId : null
        const availableNodes = activeNodes(draft, requested)
        if (requested !== null && availableNodes.includes(requested)) return
        const fallback = availableNodes.includes(draft.currentNodeId)
            ? draft.currentNodeId
            : availableNodes[0] ?? 'prompt'
        navigate(`/guided-preview/batch/${draft.id}/${fallback}`, { replace: true })
    }, [draft, navigate, params.nodeId])

    if (loading) return <div className="flex min-h-full items-center justify-center" role="status"><LoaderCircle className="h-5 w-5 animate-spin text-primary" /><span className="ml-3 text-sm text-muted-foreground">{t('guided.batch.loading', '초안을 불러오는 중…')}</span></div>
    if (loadError || draft === null) return <div className="mx-auto flex min-h-full max-w-lg items-center px-4"><div className="w-full border-y border-destructive/40 py-8 text-center" role="alert"><CircleAlert className="mx-auto h-6 w-6 text-destructive" /><p className="mt-3 text-sm font-semibold">{t('guided.batch.loadError', '배치 초안을 불러오지 못했어요.')}</p></div></div>

    const requestedNode = isBatchRouteNodeId(params.nodeId) ? params.nodeId : null
    const nodes = activeNodes(draft, requestedNode)
    const fallbackNode = nodes.includes(draft.currentNodeId)
        ? draft.currentNodeId
        : nodes[0] ?? 'prompt'
    const nodeId = requestedNode !== null && nodes.includes(requestedNode) ? requestedNode : fallbackNode
    const locked = draft.status === 'queued' || draft.status === 'completed'
    const total = draft.payload.batchMode === 'scenes'
        ? scenes.reduce((sum, scene) => sum + scene.count, 0)
        : draft.payload.count
    const costModel = draft.payload.model ?? DEFAULT_NAI_IMAGE_MODEL
    const pricingBasis = resolveAnlasPricingBasis({
        model: costModel,
        activeCredentialsAreOpus,
    })
    const perImageAnlas = draft.payload.resolution === null ? 0 : calculateAnlasCost({
        model: costModel,
        width: draft.payload.resolution.width,
        height: draft.payload.resolution.height,
        steps: draft.payload.generation.steps,
        imageCount: 1,
        pricingBasis,
    })
    const estimatedAnlas = perImageAnlas * total
    const sceneReady = scenes.length > 0 && scenes.every(scene => scene.name.trim() && scene.positive.trim() && scene.count > 0)
    const canVisit = (target: BatchRouteNodeId): boolean => {
        if (target === 'model') return true
        if (target === 'prompt') return draft.payload.model !== null
        if (target === 'count') return draft.payload.model !== null && positive.trim().length > 0
        if (target === 'scenes') return draft.payload.model !== null
        const contentReady = draft.payload.model !== null && (draft.payload.batchMode === 'scenes'
            ? sceneReady
            : positive.trim().length > 0 && total > 0)
        if (target === 'resolution') return contentReady
        if (target === 'settings' || target === 'output' || target === 'metadata') {
            return contentReady && draft.payload.resolution !== null
        }
        if (target === 'rights') {
            return contentReady
                && draft.payload.resolution !== null
                && draft.payload.output.metadataMode === 'strip-and-sidecar'
        }
        if (target === 'delivery') {
            const issues = listBatchImageDraftIssues({
                ...draft,
                payload: { ...draft.payload, prompt: { positive, negative }, scenes, characterPrompts },
            })
            return contentReady
                && draft.payload.resolution !== null
                && draft.payload.output.metadataMode === 'strip-and-sidecar'
                && !issues.includes('rights-owner-invalid')
                && !issues.includes('rights-effective-date-required')
        }
        if (target === 'review') return isBatchImageDraftReady({
            ...draft,
            payload: { ...draft.payload, prompt: { positive, negative }, scenes, characterPrompts },
        })
        return draft.lastSnapshotId !== null
    }
    const goTo = async (target: BatchRouteNodeId) => {
        if (target === nodeId) return
        if (!canVisit(target)) {
            if (target === 'review') {
                const reviewDraft = {
                    ...draft,
                    payload: { ...draft.payload, prompt: { positive, negative }, scenes, characterPrompts },
                }
                const issue = listBatchImageDraftIssues(reviewDraft)[0]
                toast({
                    title: t('guided.batch.review.blockedTitle', '검토 전에 한 가지만 확인해 주세요.'),
                    description: issue === 'character-prompt-invalid'
                        ? t('guided.batch.review.blockedCharacter', '활성 캐릭터의 외형 프롬프트를 입력하거나 해당 캐릭터를 비활성화해 주세요.')
                        : issue === 'rights-owner-invalid'
                            ? t('guided.batch.review.blockedRightsOwner', '설정에서 XMP 소유자명을 올바르게 입력해 주세요.')
                        : issue === 'rights-effective-date-required'
                            ? t('guided.batch.review.blockedRightsDate', '권리 XMP를 사용하려면 설정에서 효력 시작일을 직접 입력해 주세요.')
                        : t('guided.batch.review.blockedGeneral', '비어 있거나 올바르지 않은 항목이 있어 해당 단계로 돌아갑니다.'),
                    variant: 'destructive',
                })
                const blockingNode: BatchImageNodeId = issue === 'model-required'
                    ? 'model'
                    : issue === 'prompt-required' || issue === 'character-prompt-invalid'
                        ? 'prompt'
                        : issue === 'count-invalid'
                            ? 'count'
                        : issue === 'scenes-required' || issue === 'scene-invalid'
                                ? 'scenes'
                                : issue === 'resolution-required' || issue === 'resolution-invalid'
                                    ? 'resolution'
                                    : issue === 'rights-owner-invalid' || issue === 'rights-effective-date-required'
                                        ? 'rights'
                                        : issue === 'output-invalid'
                                            ? 'output'
                                            : 'settings'
                if (blockingNode !== nodeId) await goTo(blockingNode)
            }
            return
        }
        try {
            if (editableTimerRef.current !== null) { clearTimeout(editableTimerRef.current); editableTimerRef.current = null }
            await saveEditable()
            if (target !== 'result' && !locked) {
                await commitMutation(() => ({ currentNodeId: target, ...(target === 'review' ? { status: 'review' as const } : {}) }))
            }
            navigate(`/guided-preview/batch/${draft.id}/${target}`)
        } catch { setSaveStatus('error') }
    }
    const patchPayload = (patch: Partial<BatchImageDraft['payload']>) => {
        setConsented(false)
        return commitMutation(current => ({ payload: { ...current.payload, ...patch } }))
    }
    const patchOutput = (patch: Partial<SingleImageOutputSettings>) => {
        setConsented(false)
        return commitMutation(current => ({
            payload: {
                ...current.payload,
                output: { ...current.payload.output, ...patch },
            },
        }))
    }
    const previous = nodes[nodes.indexOf(nodeId) - 1]
    const back = () => previous === undefined ? navigate('/guided-preview/guide/batch') : void goTo(previous)
    const submit = async () => {
        if (!assessmentValid || submitting) return
        setSubmitting(true)
        setSubmitError(null)
        try {
            if (editableTimerRef.current !== null) { clearTimeout(editableTimerRef.current); editableTimerRef.current = null }
            const ready = await saveEditable() ?? draft
            const result = await enqueueWorkflowDraftGenerationCommand({
                draft: ready,
                ...(assessment === null ? {} : { assessment }),
                maxImages: total,
                maxAnlas: estimatedAnlas,
                pricingBasis,
                approvedAt: new Date().toISOString(),
                drafts: getWorkflowDraftRepository(),
                fragmentRepository: useFragmentStore.getState().getLookupRepository(),
            })
            if (result.status !== 'ready') {
                const issueCodes = 'issues' in result ? result.issues.map(issue => issue.code) : []
                if (issueCodes.includes('prompt-module-unavailable')) {
                    throw new WorkflowDraftPromptModuleResolutionError()
                }
                if (issueCodes.includes('character-prompt-invalid')) {
                    throw new WorkflowDraftCharacterPromptValidationError()
                }
                throw new Error('The batch could not be enqueued')
            }
            await commitMutation(() => ({ status: 'queued', currentNodeId: 'review', lastSnapshotId: result.batchId }))
            setSummary(await getRuntimeQueueRepository().getBatchSummary(result.batchId))
            setResultJobs([])
            navigate(`/guided-preview/batch/${draft.id}/result`)
        } catch (error) {
            setSubmitError(error instanceof WorkflowDraftPromptModuleResolutionError
                ? t('guided.batch.review.promptModuleError', '연결한 프롬프트 모듈을 찾지 못했어요. 프롬프트 단계에서 다시 확인해 주세요.')
                : error instanceof WorkflowDraftCharacterPromptValidationError
                    ? t('guided.batch.review.characterPromptError', '활성 캐릭터의 외형 프롬프트를 확인해 주세요.')
                    : t('guided.batch.review.submitError', '대기열에 추가하지 못했어요. 계정과 비용 설정을 확인해 주세요.'))
        } finally { setSubmitting(false) }
    }
    const reviseResult = async (target: BatchImageNodeId, newSeed: boolean) => {
        const revised = await commitMutation(current => ({
            status: 'review', currentNodeId: target, lastSnapshotId: null,
            payload: newSeed ? { ...current.payload, generation: { ...current.payload.generation, seed: randomSeed() } } : current.payload,
        }))
            setSummary(null); setResultJobs([]); setResultLimit(48); setConsented(false)
        navigate(`/guided-preview/batch/${revised.id}/${target}`)
    }

    const nextNode = nodes[nodes.indexOf(nodeId) + 1]
    const footer = nodeId === 'result'
        ? <span className="text-sm text-muted-foreground">{t('guided.batch.result.footer', '완성된 결과부터 자동으로 표시해요.')}</span>
        : nodeId === 'review'
            ? <span className="text-sm text-muted-foreground">{t('guided.batch.review.footer', '실행 전 설정과 비용을 한 번 더 확인해 주세요.')}</span>
            : <Button
                type="button"
                onClick={() => { if (nextNode) void goTo(nextNode) }}
                disabled={saveStatus === 'saving' || nextNode === undefined || (nextNode !== 'review' && !canVisit(nextNode))}
            >
                {nextNode === 'review'
                    ? t('guided.batch.reviewSettings', '설정 검토')
                    : t('guided.batch.continue', '계속')}
            </Button>
    const copy = {
        model: [t('guided.batch.steps.model.title', '어떤 모델로 여러 장을 만들까요?'), t('guided.batch.steps.model.description', '표현 범위와 결과의 안정성을 보고 골라 주세요.')],
        prompt: [t('guided.batch.steps.prompt.title', '공통 프롬프트와 모듈을 정해 볼까요?'), t('guided.batch.steps.prompt.description', '폴더에 저장한 모듈을 그대로 불러오거나, 무작위·순차 참조로 연결할 수 있어요.')],
        count: [t('guided.batch.steps.count.title', '몇 장을 만들까요?'), t('guided.batch.steps.count.description', '모든 항목은 독립된 대기열 작업으로 저장돼 앱을 이동해도 이어집니다.')],
        scenes: [t('guided.batch.steps.scenes.title', '어떤 씬들을 만들까요?'), t('guided.batch.steps.scenes.description', '씬마다 프롬프트와 생성 장수를 정해 한 번에 대기열로 보낼 수 있어요.')],
        resolution: [t('guided.batch.steps.resolution.title', '어떤 크기로 만들까요?'), t('guided.batch.steps.resolution.description', '공통 해상도를 고르면 전체 장수의 최대 예상 비용을 바로 계산합니다.')],
        settings: [t('guided.batch.steps.settings.title', '결과를 얼마나 세밀하게 다듬을까요?'), t('guided.batch.steps.settings.description', '28 Steps와 추천 샘플러로 시작해도 충분해요. 필요한 경우에만 세부 조정을 펼치세요.')],
        output: [t('guided.batch.steps.output.title', '완성된 이미지들을 어디에 둘까요?'), t('guided.batch.steps.output.description', '이번 묶음의 저장 폴더와 파일 형식을 정하세요. 폴더별 R2 대상도 함께 불러옵니다.')],
        metadata: [t('guided.batch.steps.metadata.title', '생성 정보를 어떻게 보관할까요?'), t('guided.batch.steps.metadata.description', '개인 보관, sidecar 분리, 공유용 정화 중 이번 묶음에 맞는 한 가지를 고르세요.')],
        rights: [t('guided.batch.steps.rights.title', '공유 이미지에 권리 표시를 넣을까요?'), t('guided.batch.steps.rights.description', '선택 사항입니다. 사용한다면 소유자명과 효력 시작일을 이 묶음에 기록합니다.')],
        delivery: [t('guided.batch.steps.delivery.title', '정화가 끝난 뒤 어디까지 처리할까요?'), t('guided.batch.steps.delivery.description', '자동 업로드와 정화 전 원본 보관 여부를 각각 선택하세요.')],
        review: [t('guided.batch.steps.review.title', '대기열에 넣기 전에 확인할까요?'), t('guided.batch.steps.review.description', '설정은 스냅샷으로 고정되고, 비용 동의와 같은 초안 재전송은 중복 실행되지 않아요.')],
        result: [t('guided.batch.steps.result.title', '완성된 이미지들을 확인해 볼까요?'), t('guided.batch.steps.result.description', '결과는 완성되는 순서대로 나타나며, 다른 워크플로우로 이동해도 작업은 계속됩니다.')],
    }[nodeId]

    return (
        <BatchStepFrame nodes={nodes} nodeId={nodeId} saveStatus={saveStatus} title={copy[0]} description={copy[1]} canVisit={canVisit} onVisit={target => void goTo(target)} onBack={back} footer={footer}>
            {nodeId === 'model' && (
                <ModelStep
                    draft={draft}
                    disabled={locked}
                    onSelect={model => {
                        setConsented(false)
                        void commitMutation(current => ({
                            payload: {
                                ...current.payload,
                                model,
                                generation: {
                                    ...current.payload.generation,
                                    scheduler: isNovelAiV5Model(model)
                                        ? 'karras'
                                        : current.payload.generation.scheduler,
                                    transparentBackground: isNovelAiV5Model(model)
                                        ? current.payload.generation.transparentBackground ?? false
                                        : false,
                                },
                            },
                        })).catch(() => undefined)
                    }}
                />
            )}
            {nodeId === 'prompt' && (
                <PromptStep
                    draft={draft}
                    positive={positive}
                    negative={negative}
                    characterPrompts={characterPrompts}
                    incomingImport={incomingImport}
                    disabled={locked}
                    onIncomingImportHandled={() => setIncomingImport(null)}
                    onPositive={value => {
                        editableRef.current = { ...editableRef.current, positive: value }
                        setPositive(value)
                        scheduleEditableSave()
                    }}
                    onNegative={value => {
                        editableRef.current = { ...editableRef.current, negative: value }
                        setNegative(value)
                        scheduleEditableSave()
                    }}
                    onTransparentBackground={value => {
                        setConsented(false)
                        void commitMutation(current => ({
                            payload: {
                                ...current.payload,
                                generation: {
                                    ...current.payload.generation,
                                    transparentBackground: value,
                                },
                            },
                        })).catch(() => undefined)
                    }}
                    onCharacterPrompts={value => {
                        editableRef.current = { ...editableRef.current, characterPrompts: value }
                        setCharacterPrompts(value)
                        scheduleEditableSave()
                    }}
                    onOrder={variationOrder => {
                        void patchPayload({ variationOrder }).catch(() => undefined)
                    }}
                />
            )}
            {nodeId === 'count' && <CountStep count={draft.payload.count} disabled={locked} onChange={count => { void patchPayload({ count }).catch(() => undefined) }} />}
            {nodeId === 'scenes' && <ScenesStep scenes={scenes} disabled={locked} onChange={value => { editableRef.current = { ...editableRef.current, scenes: value }; setScenes(value); scheduleEditableSave() }} />}
            {nodeId === 'resolution' && (
                <ResolutionStep
                    draft={draft}
                    disabled={locked}
                    imageCount={total}
                    estimatedAnlas={estimatedAnlas}
                    pricingBasis={pricingBasis}
                    onResolution={(width, height) => {
                        setConsented(false)
                        void patchPayload({ resolution: { width, height } }).catch(() => undefined)
                    }}
                />
            )}
            {nodeId === 'settings' && (
                <SettingsStep
                    draft={draft}
                    disabled={locked}
                    onGeneration={patch => {
                        setConsented(false)
                        void commitMutation(current => ({
                            payload: {
                                ...current.payload,
                                generation: { ...current.payload.generation, ...patch },
                            },
                        })).catch(() => undefined)
                    }}
                />
            )}
            {nodeId === 'output' && (
                <GuidedOutputDestinationStep
                    value={draft.payload.output}
                    disabled={locked}
                    onChange={patch => { void patchOutput(patch).catch(() => undefined) }}
                />
            )}
            {nodeId === 'metadata' && (
                <GuidedMetadataStep
                    value={draft.payload.output}
                    disabled={locked}
                    onChange={patch => { void patchOutput(patch).catch(() => undefined) }}
                />
            )}
            {nodeId === 'rights' && (
                <GuidedRightsStep
                    value={draft.payload.output}
                    disabled={locked}
                    onChange={patch => { void patchOutput(patch).catch(() => undefined) }}
                />
            )}
            {nodeId === 'delivery' && (
                <GuidedDeliveryStep
                    value={draft.payload.output}
                    disabled={locked}
                    onChange={patch => { void patchOutput(patch).catch(() => undefined) }}
                />
            )}
            {nodeId === 'review' && !locked && <HumanAssessmentSetup count={total} value={assessment} onChange={setAssessment} onValidityChange={setAssessmentValid} />}
            {nodeId === 'review' && <ReviewStep assessmentValid={assessmentValid} draft={{ ...draft, payload: { ...draft.payload, prompt: { positive, negative }, scenes, characterPrompts } }} activeTokenCount={activeTokenCount} estimatedAnlas={estimatedAnlas} consented={consented} submitting={submitting} submitError={submitError} onConsent={setConsented} onEdit={target => void goTo(target)} onSubmit={() => void submit()} />}
            {nodeId === 'result' && <ResultGallery draft={draft} summary={summary} jobs={resultJobs} hasMore={resultHasMore} loadingMore={resultLoading} onLoadMore={() => setResultLimit(current => current + 48)} onEdit={() => void reviseResult('prompt', false)} onRetry={() => void reviseResult('review', true)} />}
        </BatchStepFrame>
    )
}
