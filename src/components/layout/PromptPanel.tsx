import { useCallback, useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router'
import { isMobileRuntime } from '@/platform/runtime'
import { Button } from '@/components/ui/button'
import { FragmentPromptDialog } from '@/components/fragments/FragmentPromptDialog'
import { SourceImagePanel } from '@/components/layout/SourceImagePanel'
import { CharacterSettingsDialog } from '@/components/character/CharacterSettingsDialog'
import { CharacterPromptPanel } from '@/components/character/CharacterPromptPanel'
import { GenerationFolderPicker } from '@/components/generation-folders/GenerationFolderPicker'
import { PromptGeneratorDialog } from '@/components/prompt/PromptGeneratorDialog'
import { PromptEditorSurface } from '@/components/prompt/PromptEditorSurface'
import { PromptCoreParameters } from '@/components/prompt/PromptCoreParameters'
import { PromptGenerationControls } from '@/components/prompt/PromptGenerationControls'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
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
import {
    SlidersHorizontal,
    Users,
} from 'lucide-react'
import { useGenerationDraftStore } from '@/stores/generation-draft-store'
import { useGenerationSessionStore } from '@/stores/generation-session-store'
import { useCharacterPromptStore } from '@/stores/character-prompt-store'
import { useLayoutStore } from '@/stores/layout-store'
import { useSettingsStore } from '@/stores/settings-store'
import {
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

export function PromptPanel({ docked = false }: { docked?: boolean } = {}) {
    const { t } = useTranslation()
    const location = useLocation()
    const isAdvancedMode = location.pathname === '/advanced'
    const isSceneMode = location.pathname.startsWith('/scenes')
    const setRailActionsHost = useLayoutStore(state => state.setRailActionsHost)
    const railHostCallback = useCallback((node: HTMLDivElement | null) => {
        setRailActionsHost(node)
    }, [setRailActionsHost])

    const additionalPrompt = useGenerationDraftStore(state => state.additionalPrompt)
    const isGenerating = useGenerationSessionStore(state => state.isGenerating)
    const model = useGenerationDraftStore(state => state.model)
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
    const pendingPromptDialog = useLayoutStore(state => state.pendingPromptDialog)
    const clearPendingPromptDialog = useLayoutStore(state => state.clearPendingPromptDialog)
    const pendingPromptFocus = useLayoutStore(state => state.pendingPromptFocus)
    const clearPendingPromptFocus = useLayoutStore(state => state.clearPendingPromptFocus)

    const [promptGenOpen, setPromptGenOpen] = useState(false)
    const [fragmentDialogOpen, setFragmentDialogOpen] = useState(false)
    const [characterPanelOpen, setCharacterPanelOpen] = useState(false)
    const [imageRefDialogOpen, setImageRefDialogOpen] = useState(false)
    const [parameterDialogOpen, setParameterDialogOpen] = useState(false)
    const guidedSurface = new URLSearchParams(location.search).get('guided')
    const modelProfile = getNovelAiModelProfile(model)
    const isV5 = isNovelAiV5Model(model)

    useEffect(() => {
        if (isGenerating) return
        if (guidedSurface === 'fragments') setFragmentDialogOpen(true)
    }, [guidedSurface, isGenerating])

    // Consume shortcut-driven dialog requests queued by ThreeColumnLayout so
    // shortcuts work even when PromptPanel was previously closed or unmounted.
    useEffect(() => {
        if (!pendingPromptDialog) return
        clearPendingPromptDialog()
        if (pendingPromptDialog === 'promptGenerator') {
            setPromptGenOpen(true)
        } else if (pendingPromptDialog === 'fragment') {
            // Sequential proposals hold a runtime lease while the provider runs;
            // keep the editor closed so UI mutations cannot invalidate paid work.
            if (!isGenerating) setFragmentDialogOpen(true)
        } else if (pendingPromptDialog === 'parameterSettings') {
            setParameterDialogOpen(true)
        } else if (pendingPromptDialog === 'characterPrompt') {
            setCharacterPanelOpen(prev => !prev)
        } else if (pendingPromptDialog === 'imageReference') {
            setImageRefDialogOpen(true)
        }
    }, [clearPendingPromptDialog, isGenerating, pendingPromptDialog])

    // Focus the requested core control (model or steps) directly inside the rail.
    useEffect(() => {
        if (!pendingPromptFocus) return
        clearPendingPromptFocus()
        const selector = `[data-prompt-focus="${pendingPromptFocus}"]`
        const focusTarget = () => {
            const element = document.querySelector<HTMLElement>(selector)
            if (element) {
                element.focus()
                return true
            }
            return false
        }
        if (focusTarget()) return
        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
                focusTarget()
            })
        })
    }, [clearPendingPromptFocus, pendingPromptFocus])

    useEffect(() => {
        if (isGenerating) setFragmentDialogOpen(false)
    }, [isGenerating])

    return (
        <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden p-5">
            {/* Source Image Panel (I2I/Inpaint Mode) */}
            <SourceImagePanel />

            {/* This is the only scrolling region in the prompt rail/sheet, keeping
                core parameters beside the prompt editor and helpers reachable on short viewports. */}
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

                <PromptCoreParameters />
            </div>

            {/* Prompt helpers share a quiet tonal rail; dialogs carry their own hierarchy once opened. */}
            <div className="mb-3 grid grid-cols-3 border-y border-border/60 py-1">
                {/* Character Prompt Toggle Button */}
                <Tip content={t('prompt.character', '캐릭터')}>
                    <Button
                        variant="ghost"
                        size="sm"
                        className={cn(
                            'relative h-11 w-full min-w-0 gap-1.5 rounded-none border-b-2 border-transparent px-1.5 text-[12px] font-medium',
                            characterPanelOpen && 'border-primary bg-primary/[0.06] text-primary',
                        )}
                        onClick={() => setCharacterPanelOpen(!characterPanelOpen)}
                        aria-label={t('prompt.character', '캐릭터')}
                    >
                        <Users className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span className="truncate">{t('prompt.character', '캐릭터')}</span>
                        {characterCount > 0 && (
                            <div className={cn(
                                'absolute right-1 top-0 flex h-4 min-w-4 items-center justify-center rounded-md px-1 py-0.5 text-[11px] font-bold leading-none',
                                characterPanelOpen
                                    ? 'bg-primary-foreground text-primary'
                                    : 'bg-primary text-primary-foreground',
                            )}>
                                {characterCount}
                            </div>
                        )}
                    </Button>
                </Tip>
                <CharacterSettingsDialog
                    open={imageRefDialogOpen}
                    onOpenChange={setImageRefDialogOpen}
                    triggerLabel={t('prompt.imageReference', '이미지 참조')}
                />
                {/* Detailed Parameter Settings Dialog */}
                <Dialog open={parameterDialogOpen} onOpenChange={setParameterDialogOpen}>
                    <DialogTrigger asChild>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-11 w-full min-w-0 gap-1.5 rounded-none px-1.5 text-[12px] font-medium"
                            aria-label={t('parameters.detailedTitle', '세부 설정')}
                        >
                            <SlidersHorizontal className="h-4 w-4 shrink-0" aria-hidden="true" />
                            <span className="truncate">{t('parameters.detailedTitle', '세부 설정')}</span>
                        </Button>
                    </DialogTrigger>
                    <DialogContent
                        className="sm:max-w-[480px] max-h-[85vh] overflow-y-auto"
                        closeLabel={t('common.close')}
                    >
                        <DialogHeader>
                            <DialogTitle>{t('parameters.detailedTitle', '세부 설정')}</DialogTitle>
                            <DialogDescription>
                                {t('parameters.detailedDescription', 'CFG Scale, Sampler, Scheduler 등 세부 생성 옵션을 설정합니다.')}
                            </DialogDescription>
                        </DialogHeader>
                        <div className="grid gap-5 py-4">
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

            {/* Docked Main rail owns the primary Generate action slot; sheets never mount it. */}
            {docked && isAdvancedMode && !isMobileRuntime && (
                <div id="nai-blue-rail-actions" ref={railHostCallback} className="shrink-0" />
            )}

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
