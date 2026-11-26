import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router'
import { Button } from '@/components/ui/button'
import { FragmentPromptDialog } from '@/components/fragments/FragmentPromptDialog'
import { SourceImagePanel } from '@/components/layout/SourceImagePanel'
import { CharacterSettingsDialog } from '@/components/character/CharacterSettingsDialog'
import { CharacterPromptPanel } from '@/components/character/CharacterPromptPanel'
import { GenerationFolderPicker } from '@/components/generation-folders/GenerationFolderPicker'
import { PromptGeneratorDialog } from '@/components/prompt/PromptGeneratorDialog'
import { PromptEditorSurface } from '@/components/prompt/PromptEditorSurface'
import { PromptGenerationControls } from '@/components/prompt/PromptGenerationControls'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { SHORTCUT_EVENTS } from '@/hooks/useShortcuts'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { Tip } from '@/components/ui/tooltip'
import { generateRandomSeed } from '@/lib/utils'
import {
    Dice5,
    AlertTriangle,
    Lock,
    Unlock,
    SlidersHorizontal,
    Cpu,
    Users,
} from 'lucide-react'
import { useGenerationDraftStore } from '@/stores/generation-draft-store'
import { useGenerationSessionStore } from '@/stores/generation-session-store'
import { useCharacterPromptStore } from '@/stores/character-prompt-store'
import { useSettingsStore } from '@/stores/settings-store'
import { ResolutionSelector } from '@/components/ui/ResolutionSelector'
import {
    assessGenerationStepQuality,
    LOW_STEP_CAUTION_THRESHOLD,
    RECOMMENDED_GENERATION_STEPS,
} from '@/services/generation/generation-quality'
import {
    NAI_IMAGE_MODELS,
    getNovelAiModelProfile,
    isNovelAiV5Model,
} from '@/services/nai/model-catalog'

const SAMPLERS = [
    'k_euler',
    'k_euler_ancestral',
    'k_dpmpp_2s_ancestral',
    'k_dpmpp_2m',
    'k_dpmpp_2m_sde',
    'k_dpmpp_sde',
    'ddim',
]

const SCHEDULERS = ['native', 'karras', 'exponential', 'polyexponential']
export function PromptPanel() {
    const { t } = useTranslation()
    const location = useLocation()
    const isAdvancedMode = location.pathname === '/advanced'
    const isSceneMode = location.pathname.startsWith('/scenes')

    const additionalPrompt = useGenerationDraftStore(state => state.additionalPrompt)
    const seed = useGenerationDraftStore(state => state.seed)
    const seedLocked = useGenerationDraftStore(state => state.seedLocked)
    const selectedResolution = useGenerationDraftStore(state => state.selectedResolution)
    const isGenerating = useGenerationSessionStore(state => state.isGenerating)
    const model = useGenerationDraftStore(state => state.model)
    const steps = useGenerationDraftStore(state => state.steps)
    const cfgScale = useGenerationDraftStore(state => state.cfgScale)
    const cfgRescale = useGenerationDraftStore(state => state.cfgRescale)
    const sampler = useGenerationDraftStore(state => state.sampler)
    const scheduler = useGenerationDraftStore(state => state.scheduler)
    const variety = useGenerationDraftStore(state => state.variety)
    const qualityToggle = useGenerationDraftStore(state => state.qualityToggle)
    const ucPreset = useGenerationDraftStore(state => state.ucPreset)
    const transparentBackground = useGenerationDraftStore(state => state.transparentBackground)

    // Zustand 선택적 구독 - generationStore (액션)
    const setAdditionalPrompt = useGenerationDraftStore(state => state.setAdditionalPrompt)
    const setSeed = useGenerationDraftStore(state => state.setSeed)
    const setSeedLocked = useGenerationDraftStore(state => state.setSeedLocked)
    const setSelectedResolution = useGenerationDraftStore(state => state.setSelectedResolution)
    const setModel = useGenerationDraftStore(state => state.setModel)
    const setSteps = useGenerationDraftStore(state => state.setSteps)
    const setCfgScale = useGenerationDraftStore(state => state.setCfgScale)
    const setCfgRescale = useGenerationDraftStore(state => state.setCfgRescale)
    const setSampler = useGenerationDraftStore(state => state.setSampler)
    const setScheduler = useGenerationDraftStore(state => state.setScheduler)
    const setVariety = useGenerationDraftStore(state => state.setVariety)
    const setQualityToggle = useGenerationDraftStore(state => state.setQualityToggle)
    const setUcPreset = useGenerationDraftStore(state => state.setUcPreset)
    const setTransparentBackground = useGenerationDraftStore(state => state.setTransparentBackground)

    // Zustand 선택적 구독 - characterPromptStore
    const characterCount = useCharacterPromptStore(state => state.characters.filter(c => c.enabled).length)
    const activeGenerationFolderId = useSettingsStore(state => state.activeGenerationFolderId)
    const setActiveGenerationFolder = useSettingsStore(state => state.setActiveGenerationFolder)

    const [promptGenOpen, setPromptGenOpen] = useState(false)
    const [fragmentDialogOpen, setFragmentDialogOpen] = useState(false)
    const [characterPanelOpen, setCharacterPanelOpen] = useState(false)
    const [imageRefDialogOpen, setImageRefDialogOpen] = useState(false)
    const [parameterDialogOpen, setParameterDialogOpen] = useState(false)
    const stepQuality = assessGenerationStepQuality(steps)
    const guidedSurface = new URLSearchParams(location.search).get('guided')
    const modelProfile = getNovelAiModelProfile(model)
    const selectedModel = NAI_IMAGE_MODELS.find(candidate => candidate.id === model)
    const isV5 = isNovelAiV5Model(model)

    useEffect(() => {
        if (isGenerating) return
        if (guidedSurface === 'fragments') setFragmentDialogOpen(true)
    }, [guidedSurface, isGenerating])

    // 전역 단축키 이벤트 수신
    useEffect(() => {
        const handleOpenPromptGen = () => setPromptGenOpen(true)
        // Sequential proposals hold a runtime lease while the provider runs;
        // keep the editor closed so UI mutations cannot invalidate paid work.
        const handleOpenFragment = () => {
            if (!isGenerating) setFragmentDialogOpen(true)
        }
        const handleOpenParameters = () => setParameterDialogOpen(true)
        const handleOpenCharacterPrompt = () => setCharacterPanelOpen(prev => !prev)
        const handleOpenImageReference = () => setImageRefDialogOpen(true)

        window.addEventListener(SHORTCUT_EVENTS.OPEN_PROMPT_GENERATOR, handleOpenPromptGen)
        window.addEventListener(SHORTCUT_EVENTS.OPEN_FRAGMENT_DIALOG, handleOpenFragment)
        window.addEventListener(SHORTCUT_EVENTS.OPEN_PARAMETER_SETTINGS, handleOpenParameters)
        window.addEventListener(SHORTCUT_EVENTS.OPEN_CHARACTER_PROMPT, handleOpenCharacterPrompt)
        window.addEventListener(SHORTCUT_EVENTS.OPEN_IMAGE_REFERENCE, handleOpenImageReference)

        return () => {
            window.removeEventListener(SHORTCUT_EVENTS.OPEN_PROMPT_GENERATOR, handleOpenPromptGen)
            window.removeEventListener(SHORTCUT_EVENTS.OPEN_FRAGMENT_DIALOG, handleOpenFragment)
            window.removeEventListener(SHORTCUT_EVENTS.OPEN_PARAMETER_SETTINGS, handleOpenParameters)
            window.removeEventListener(SHORTCUT_EVENTS.OPEN_CHARACTER_PROMPT, handleOpenCharacterPrompt)
            window.removeEventListener(SHORTCUT_EVENTS.OPEN_IMAGE_REFERENCE, handleOpenImageReference)
        }
    }, [isGenerating])

    useEffect(() => {
        if (isGenerating) setFragmentDialogOpen(false)
    }, [isGenerating])

    const handleRandomSeed = () => {
        if (!seedLocked) {
            setSeed(generateRandomSeed())
        }
    }

    return (
        <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden p-5">
            {/* Source Image Panel (I2I/Inpaint Mode) */}
            <SourceImagePanel />

            {/* This is the only scrolling region in the prompt sheet, keeping the
                three authoring helpers reachable on short Android viewports. */}
            <div className="relative mb-4 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain pr-1">
                {/* Character Prompt Panel (Accordion Style) - 프롬프트 영역 위에 오버레이 */}
                <CharacterPromptPanel
                    open={characterPanelOpen}
                    onOpenChange={setCharacterPanelOpen}
                    maxCharacters={modelProfile?.capabilities.maxCharacters}
                />

                <PromptEditorSurface
                    onOpenAiAssistant={() => setPromptGenOpen(true)}
                    onOpenFragment={() => setFragmentDialogOpen(true)}
                    toolsDisabled={isGenerating}
                />
            </div>

            {/* Prompt helpers share a quiet tonal rail; dialogs carry their own hierarchy once opened. */}
            <div className="mb-4 grid grid-cols-3 border-y border-border/60 py-1">
                {/* Character Prompt Toggle Button */}
                <Tip content={t('prompt.character', '캐릭터')}>
                    <Button
                        variant="ghost"
                        size="icon"
                        className={cn(
                            "relative h-11 w-full min-w-0 rounded-none border-b-2 border-transparent px-0",
                            characterPanelOpen && "border-primary bg-primary/[0.06] text-primary"
                        )}
                        onClick={() => setCharacterPanelOpen(!characterPanelOpen)}
                        aria-label={t('prompt.character', '캐릭터')}
                    >
                        <Users className="h-4 w-4 shrink-0" />
                        {characterCount > 0 && (
                            <div className={cn(
                                "absolute right-1 top-0 flex h-4 min-w-4 items-center justify-center rounded-md px-1 py-0.5 text-[11px] font-bold leading-none",
                                characterPanelOpen
                                    ? "bg-primary-foreground text-primary"
                                    : "bg-primary text-primary-foreground"
                            )}>
                                {characterCount}
                            </div>
                        )}
                    </Button>
                </Tip>
                <CharacterSettingsDialog open={imageRefDialogOpen} onOpenChange={setImageRefDialogOpen} />
                {/* Parameter Settings Dialog */}
                <Dialog open={parameterDialogOpen} onOpenChange={setParameterDialogOpen}>
                    <DialogTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-11 w-full min-w-0 rounded-none" aria-label={t('parameters.title')}>
                            <SlidersHorizontal className="h-4 w-4" />
                        </Button>
                    </DialogTrigger>
                    <DialogContent
                        className="sm:max-w-[480px] max-h-[85vh] overflow-y-auto"
                        closeLabel={t('common.close')}
                    >
                        <DialogHeader>
                            <DialogTitle>{t('parameters.title')}</DialogTitle>
                            <DialogDescription>
                                {t('parameters.description')}
                            </DialogDescription>
                        </DialogHeader>
                        <div className="grid gap-5 py-4">
                            {/* Model Selection */}
                            <div className="space-y-2">
                                <Label className="flex items-center gap-2">
                                    <Cpu className="h-4 w-4" />
                                    {t('parameters.model')}
                                </Label>
                                <Select value={model} onValueChange={setModel}>
                                    <SelectTrigger className="rounded-control">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {NAI_IMAGE_MODELS.map((candidate) => (
                                            <SelectItem key={candidate.id} value={candidate.id}>
                                                {candidate.name}
                                                {candidate.recommended
                                                    ? ` — ${t('parameters.recommended', '추천')}`
                                                    : candidate.deprecated
                                                        ? ` — ${t('parameters.legacy', '호환용')}`
                                                        : ''}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                {selectedModel && (
                                    <p className="text-xs leading-5 text-muted-foreground">
                                        {t(
                                            `parameters.modelDescriptions.${selectedModel.id}`,
                                            selectedModel.description,
                                        )}
                                    </p>
                                )}
                            </div>

                            {/* Resolution (Moved here) */}
                            <div className="space-y-2">
                                <Label className="text-sm font-medium">
                                    {t('settings.resolution')}
                                </Label>
                                <ResolutionSelector
                                    value={selectedResolution}
                                    onChange={setSelectedResolution}
                                    disabled={isGenerating}
                                />
                            </div>

                            {/* Seed (Moved here) */}
                            <div className="space-y-2">
                                <label className="text-sm font-medium">{t('settings.seed')}</label>
                                <div className="flex gap-2">
                                    <Input
                                        type="number"
                                        value={seed}
                                        onChange={(e) => setSeed(Number(e.target.value))}
                                        disabled={seedLocked}
                                        className="h-11 flex-1 rounded-control text-xs"
                                    />
                                    <Button
                                        variant="outline"
                                        size="icon"
                                        className={cn("h-11 w-11 shrink-0 rounded-control", seedLocked && 'bg-primary/10 text-primary')}
                                        onClick={() => setSeedLocked(!seedLocked)}
                                        aria-label={seedLocked ? t('settings.unlockSeed', '시드 잠금 해제') : t('settings.lockSeed', '시드 잠금')}
                                    >
                                        {seedLocked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="icon"
                                        className="h-11 w-11 shrink-0 rounded-control"
                                        onClick={handleRandomSeed}
                                        disabled={seedLocked}
                                        aria-label={t('settings.randomSeed', '무작위 시드')}
                                    >
                                        <Dice5 className="h-3.5 w-3.5" />
                                    </Button>
                                </div>
                            </div>

                            {/* Steps */}
                            <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                    <Label>{t('parameters.steps')}</Label>
                                    <span className="text-sm text-muted-foreground">{steps}</span>
                                </div>
                                <Slider
                                    value={[steps]}
                                    onValueChange={([v]) => setSteps(v)}
                                    min={1}
                                    max={50}
                                    step={1}
                                    className={cn("w-full", steps > 28 && "[&>.relative>.bg-primary]:bg-destructive")}
                                />
                                {stepQuality !== 'normal' && (
                                    // The draft store supplies the live value and the command guard
                                    // enforces the same threshold; this alert explains why a latent
                                    // preview would look broken and offers a one-tap safe recovery.
                                    <div className="flex flex-col gap-3 rounded-control border border-warning/40 bg-warning/10 p-3 text-left sm:flex-row sm:items-center" role="alert">
                                        <div className="flex min-w-0 flex-1 gap-2">
                                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                                            <div className="min-w-0">
                                                <p className="text-xs font-semibold text-foreground">
                                                    {t('generate.lowStepsTitle', '저품질 Steps 설정')}
                                                </p>
                                                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                                    {t('generate.lowStepsDescription', '{{steps}} steps는 완성 전에 종료되어 흐린 결과가 나올 수 있습니다. 일반 생성은 28 steps를 권장합니다.', { steps })}
                                                    {stepQuality === 'caution' && ` (${t('generate.lowStepsCautionRange', '{{threshold}} 미만은 실험용입니다.', { threshold: LOW_STEP_CAUTION_THRESHOLD })})`}
                                                </p>
                                            </div>
                                        </div>
                                        <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            className="shrink-0"
                                            onClick={() => setSteps(RECOMMENDED_GENERATION_STEPS)}
                                        >
                                            {t('generate.restoreRecommendedSteps', '28 steps로 복원')}
                                        </Button>
                                    </div>
                                )}
                            </div>

                            {/* CFG Scale */}
                            <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                    <Label>{t('parameters.cfgScale')}</Label>
                                    <span className="text-sm text-muted-foreground">{cfgScale.toFixed(1)}</span>
                                </div>
                                <Slider
                                    value={[cfgScale]}
                                    onValueChange={([v]) => setCfgScale(v)}
                                    min={1}
                                    max={10}
                                    step={0.1}
                                    className="w-full"
                                />
                            </div>

                            {/* CFG Rescale */}
                            <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                    <Label>{t('parameters.cfgRescale')}</Label>
                                    <span className="text-sm text-muted-foreground">{cfgRescale.toFixed(2)}</span>
                                </div>
                                <Slider
                                    value={[cfgRescale]}
                                    onValueChange={([v]) => setCfgRescale(v)}
                                    min={0}
                                    max={1}
                                    step={0.01}
                                    className="w-full"
                                />
                            </div>

                            {/* Sampler & Scheduler */}
                            <div className="grid grid-cols-2 gap-3">
                                <div className="space-y-2">
                                    <Label>{t('parameters.sampler')}</Label>
                                    <Select value={sampler} onValueChange={setSampler}>
                                        <SelectTrigger className="rounded-control">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {SAMPLERS.map((s) => (
                                                <SelectItem key={s} value={s}>{s}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="space-y-2">
                                    <Label>{t('parameters.scheduler')}</Label>
                                    <Select value={scheduler} onValueChange={setScheduler} disabled={isV5}>
                                        <SelectTrigger className="rounded-control">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {SCHEDULERS.map((s) => (
                                                <SelectItem key={s} value={s}>{s}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                    {isV5 && (
                                        <p className="text-xs text-muted-foreground">
                                            {t('parameters.v5Karras', 'V5 요청은 Karras로 자동 맞춰져요.')}
                                        </p>
                                    )}
                                </div>
                            </div>

                            {/* Variety+ is a V4/V4.5 CFG Delay control; V5 omits it from the provider request. */}
                            {!isV5 && (
                                <div className="flex items-center justify-between">
                                    <div className="flex flex-col gap-1">
                                        <Label className="cursor-pointer" onClick={() => setVariety(!variety)}>
                                            {t('parameters.variety', 'Variety+')}
                                        </Label>
                                        <span className="text-xs text-muted-foreground">{t('parameters.varietyHelp')}</span>
                                    </div>
                                    <Switch
                                        checked={variety}
                                        onChange={(e) => setVariety(e.target.checked)}
                                        aria-label={t('parameters.variety', 'Variety+')}
                                    />
                                </div>
                            )}

                            {modelProfile?.capabilities.transparentBackground && (
                                <div className="flex items-center justify-between rounded-control border border-border/70 p-3">
                                    <div className="flex flex-col gap-1 pr-4">
                                        <Label
                                            className="cursor-pointer"
                                            onClick={() => setTransparentBackground(!transparentBackground)}
                                        >
                                            {t('parameters.transparentBackground', '투명 배경')}
                                        </Label>
                                        <span className="text-xs leading-5 text-muted-foreground">
                                            {t('parameters.transparentBackgroundHelp', '배경을 제거하기 쉬운 알파 채널 이미지로 생성해요.')}
                                        </span>
                                    </div>
                                    <Switch
                                        checked={transparentBackground}
                                        onChange={(event) => setTransparentBackground(event.target.checked)}
                                        aria-label={t('parameters.transparentBackground', '투명 배경')}
                                    />
                                </div>
                            )}

                            {/* Add Quality Tags */}
                            <div className="flex items-center justify-between">
                                <div className="flex flex-col gap-1">
                                    <Label className="cursor-pointer" onClick={() => setQualityToggle(!qualityToggle)}>
                                        {t('parameters.qualityToggle', 'Add Quality Tags')}
                                    </Label>
                                    <span className="text-xs text-muted-foreground">{t('parameters.qualityToggleHelp')}</span>
                                </div>
                                <Switch
                                    checked={qualityToggle}
                                    onChange={(e) => setQualityToggle(e.target.checked)}
                                    aria-label={t('parameters.qualityToggle', 'Add Quality Tags')}
                                />
                            </div>

                            {/* UC Preset */}
                            <div className="space-y-2">
                                <Label>{t('parameters.ucPreset', 'UC Preset')}</Label>
                                <Select value={String(ucPreset)} onValueChange={(v) => setUcPreset(Number(v))}>
                                    <SelectTrigger className="rounded-control">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="0">{t('parameters.ucHeavy')}</SelectItem>
                                        <SelectItem value="1">{t('parameters.ucLight')}</SelectItem>
                                        <SelectItem value="2">{t('parameters.ucFurry')}</SelectItem>
                                        <SelectItem value="3">{t('parameters.ucHuman')}</SelectItem>
                                        <SelectItem value="4">{t('parameters.ucNone')}</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>

                            {!isSceneMode && (
                                <section className="border-y border-border/60 py-3" aria-label={t('generationFolders.current', '이미지 생성 폴더')}>
                                    <GenerationFolderPicker
                                        value={activeGenerationFolderId}
                                        disabled={isGenerating}
                                        onChange={selection => {
                                            if (selection) setActiveGenerationFolder(selection.folder.id)
                                        }}
                                    />
                                </section>
                            )}

                            {/* End of Parameters Dialog Content */}
                        </div>

                    </DialogContent>
                </Dialog>
            </div>

            {/* AI Prompt Generator Dialog */}
            <PromptGeneratorDialog
                open={promptGenOpen}
                onOpenChange={setPromptGenOpen}
                onApply={(tags) => {
                    // Append to additional prompt
                    const current = additionalPrompt.trim()
                    const newValue = current ? `${current}, ${tags}` : tags
                    setAdditionalPrompt(newValue)
                }}
            />

            {/* MainMode owns the only Advanced generation CTA. Scene and Style Lab
                keep this route-aware control because their cancel/queue semantics differ. */}
            {!isAdvancedMode && <PromptGenerationControls isSceneMode={isSceneMode} />}

            {/* Fragment Prompt Dialog */}
            <FragmentPromptDialog
                open={fragmentDialogOpen}
                onOpenChange={setFragmentDialogOpen}
            />
        </div>
    )
}
