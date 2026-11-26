import { useId, useState } from 'react'
import { Copy, Dice5, Lock, Unlock } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { AutocompleteTextarea } from '@/components/ui/AutocompleteTextarea'
import { PromptSlotTabs } from '@/components/prompt/PromptSlotTabs'
import {
    appendPromptModuleLine,
    PromptModulePicker,
} from '@/components/fragments/PromptModulePicker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ResolutionSelector, type Resolution } from '@/components/ui/ResolutionSelector'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/use-toast'
import { SceneOutputNamingEditor } from '@/components/scene/SceneOutputNamingEditor'
import { SceneCharacterCaptionsEditor } from '@/components/scene/SceneCharacterCaptionsEditor'
import { cn, generateRandomSeed } from '@/lib/utils'
import { AVAILABLE_MODELS } from '@/stores/generation-store'
import { isNovelAiV5Model } from '@/services/nai/model-catalog'
import { useCharacterPromptStore } from '@/stores/character-prompt-store'
import { useGenerationDraftStore } from '@/stores/generation-draft-store'
import {
    resolveSceneGeneration,
    resolveScenePrompts,
    useSceneStore,
    type SceneCard,
    type SceneGenerationConfig,
    type ScenePromptConfig,
} from '@/stores/scene-store'
import { useSettingsStore } from '@/stores/settings-store'

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

type PromptSlot = Exclude<keyof ScenePromptConfig, 'character' | 'characterNegative'>

interface ScenePromptEditorProps {
    scene: SceneCard
    presetId: string
    disabled?: boolean
}

/**
 * The editor depends on SceneStore for isolated prompt/parameter persistence and
 * reads Main stores only when the explicit copy button is pressed. This one-way
 * boundary keeps Scene edits from mutating the Main prompt panel.
 */
export function ScenePromptEditor({ scene, presetId, disabled = false }: ScenePromptEditorProps) {
    const { t } = useTranslation()
    const [activeSlot, setActiveSlot] = useState<PromptSlot>('base')
    const panelId = `scene-prompt-editor-${useId().replace(/:/g, '')}`
    const fontSize = useSettingsStore(state => state.promptFontSize)
    const prompts = resolveScenePrompts(scene)
    const generation = resolveSceneGeneration(scene)
    const isV5 = isNovelAiV5Model(generation.model)
    const updatePrompts = useSceneStore(state => state.updateScenePrompts)
    const updateCharacterCaptions = useSceneStore(state => state.updateSceneCharacterCaptions)
    const updateGeneration = useSceneStore(state => state.updateSceneGeneration)
    const updateSettings = useSceneStore(state => state.updateSceneSettings)
    const resolution: Resolution = {
        label: `${scene.width ?? 832} × ${scene.height ?? 1216}`,
        width: scene.width ?? 832,
        height: scene.height ?? 1216,
    }

    const basePrompt = useGenerationDraftStore(state => state.basePrompt)
    const additionalPrompt = useGenerationDraftStore(state => state.additionalPrompt)
    const detailPrompt = useGenerationDraftStore(state => state.detailPrompt)
    const negativePrompt = useGenerationDraftStore(state => state.negativePrompt)
    const mainCharacters = useCharacterPromptStore(state => state.characters)
    const mainCharacterPositionEnabled = useCharacterPromptStore(state => state.positionEnabled)

    const promptSlots: Array<{ id: PromptSlot; label: string; placeholder: string; negative?: boolean }> = [
        { id: 'base', label: t('prompt.base', '베이스 프롬프트'), placeholder: t('prompt.basePlaceholder', '베이스 프롬프트') },
        { id: 'additional', label: t('prompt.additional', '추가 프롬프트'), placeholder: t('prompt.additionalPlaceholder', '추가 프롬프트') },
        { id: 'negative', label: t('prompt.negative', '네거티브 프롬프트'), placeholder: t('prompt.negativePlaceholder', '네거티브 프롬프트'), negative: true },
    ]
    const active = promptSlots.find(slot => slot.id === activeSlot) ?? promptSlots[0]

    const patchGeneration = <K extends keyof SceneGenerationConfig>(key: K, value: SceneGenerationConfig[K]) => {
        updateGeneration(presetId, scene.id, { [key]: value })
    }

    // ResolutionSelector supplies provider-safe dimensions and SceneStore owns the
    // scene-local snapshot consumed by both legacy and Composition v2 builders.
    const patchResolution = (nextResolution: Resolution) => {
        updateSettings(presetId, scene.id, {
            width: nextResolution.width,
            height: nextResolution.height,
        })
    }

    const copyMainPrompts = () => {
        const enabledCharacters = mainCharacters.filter(character => character.enabled)
        const combinedAdditional = [additionalPrompt, detailPrompt].filter(value => value.trim()).join(', ')
        updatePrompts(presetId, scene.id, {
            base: basePrompt,
            additional: combinedAdditional,
            negative: negativePrompt,
        })
        updateCharacterCaptions(presetId, scene.id, enabledCharacters.map(character => ({
            id: character.id,
            name: character.name,
            prompt: character.prompt,
            negative: character.negative,
            enabled: true,
            position: { ...character.position },
        })), mainCharacterPositionEnabled)
        toast({ description: t('scene.mainPromptsCopied', '메인 프롬프트를 이 씬에 복사했습니다.') })
    }

    const setNumeric = <K extends keyof SceneGenerationConfig>(
        key: K,
        value: string,
        minimum: number,
        maximum: number,
    ) => {
        const parsed = Number(value)
        if (!Number.isFinite(parsed)) return
        patchGeneration(key, Math.min(maximum, Math.max(minimum, parsed)) as SceneGenerationConfig[K])
    }

    return (
        <section className="@container shrink-0 border-y border-border/70 bg-transparent py-3" data-testid="scene-prompt-editor">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 px-2">
                <div>
                    <h2 className="text-sm font-semibold">{t('scene.promptComposition', '씬 프롬프트 구성')}</h2>
                    <p className="text-xs text-muted-foreground">{t('scene.promptCompositionHelp', '이 씬에서만 사용할 프롬프트와 생성 설정입니다.')}</p>
                </div>
                <Button type="button" variant="ghost" size="sm" className="rounded-none border-b border-border/70 px-1" onClick={copyMainPrompts} disabled={disabled}>
                    <Copy className="h-4 w-4" />
                    {t('scene.copyMainPrompts', '메인 프롬프트 가져오기')}
                </Button>
            </div>

            <PromptSlotTabs
                tabs={promptSlots.map(slot => ({
                    id: slot.id,
                    label: slot.label,
                    filled: prompts[slot.id].trim().length > 0,
                    negative: slot.negative,
                }))}
                activeId={active.id}
                panelId={panelId}
                label={t('scene.promptComposition', '씬 프롬프트 구성')}
                onChange={id => setActiveSlot(id as PromptSlot)}
            />
            <div id={panelId} role="tabpanel" aria-labelledby={`${panelId}-${active.id}-tab`}>
                <div className="flex min-h-11 items-center justify-between gap-3 border-b border-border/45 px-2">
                    <span className="min-w-0 truncate text-sm font-medium text-muted-foreground">{active.label}</span>
                    <PromptModulePicker
                        disabled={disabled}
                        triggerLabel={t('guided.promptModules.triggerShort', '모듈 불러오기')}
                        triggerClassName="shrink-0"
                        onSelectLine={line => updatePrompts(presetId, scene.id, {
                            [active.id]: appendPromptModuleLine(prompts[active.id], line),
                        })}
                    />
                </div>
                <AutocompleteTextarea
                    key={active.id}
                    value={prompts[active.id]}
                    placeholder={active.placeholder}
                    onChange={(event: any) => updatePrompts(presetId, scene.id, { [active.id]: event.target.value })}
                    disabled={disabled}
                    ariaLabel={active.label}
                    className={cn(
                        'h-32 min-h-32 resize-y rounded-none border-0 bg-transparent focus-within:ring-1 focus-within:ring-inset',
                        active.negative && 'focus-within:ring-destructive/50',
                    )}
                    style={{ fontSize: `${fontSize}px` }}
                />
            </div>

            <SceneCharacterCaptionsEditor
                scene={scene}
                presetId={presetId}
                availableCharacters={mainCharacters}
                disabled={disabled}
            />

            <div className="mt-3 grid gap-2 border-t border-border pt-3 sm:grid-cols-2 xl:grid-cols-5">
                <label className="space-y-1">
                    <span className="text-xs font-medium text-muted-foreground">{t('parameters.model', '모델')}</span>
                    <Select value={generation.model} onValueChange={value => patchGeneration('model', value)} disabled={disabled}>
                        <SelectTrigger className="h-10 rounded-control"><SelectValue /></SelectTrigger>
                        <SelectContent>{AVAILABLE_MODELS.map(model => <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>)}</SelectContent>
                    </Select>
                </label>
                <div className="space-y-1">
                    <span className="text-xs font-medium text-muted-foreground">{t('settings.resolution', '해상도')}</span>
                    <div className="[&_button]:h-10 [&_button]:rounded-control" data-testid="scene-resolution-selector">
                        <ResolutionSelector
                            value={resolution}
                            onChange={patchResolution}
                            disabled={disabled}
                        />
                    </div>
                </div>
                <label className="space-y-1">
                    <span className="text-xs font-medium text-muted-foreground">{t('settings.seed', '시드')}</span>
                    <div className="flex gap-1">
                        <Input type="number" value={generation.seed} onChange={event => setNumeric('seed', event.target.value, 0, 4294967295)} disabled={disabled || !generation.seedLocked} className="h-11 rounded-control font-mono" />
                        <Button type="button" variant={generation.seedLocked ? 'secondary' : 'outline'} size="icon" className="h-11 w-11 shrink-0" onClick={() => patchGeneration('seedLocked', !generation.seedLocked)} disabled={disabled} aria-label={generation.seedLocked ? t('settings.unlockSeed', '시드 잠금 해제') : t('settings.lockSeed', '시드 잠금')}>
                            {generation.seedLocked ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
                        </Button>
                        <Button type="button" variant="outline" size="icon" className="h-11 w-11 shrink-0" onClick={() => patchGeneration('seed', generateRandomSeed())} disabled={disabled || generation.seedLocked} aria-label={t('settings.randomSeed', '무작위 시드')}>
                            <Dice5 className="h-4 w-4" />
                        </Button>
                    </div>
                </label>
                <label className="space-y-1">
                    <span className="text-xs font-medium text-muted-foreground">{t('parameters.steps', 'Steps')}</span>
                    <Input type="number" value={generation.steps} min={1} max={50} onChange={event => setNumeric('steps', event.target.value, 1, 50)} disabled={disabled} className="h-10 rounded-control" />
                </label>
                <label className="space-y-1">
                    <span className="text-xs font-medium text-muted-foreground">{t('parameters.cfgScale', 'CFG Scale')}</span>
                    <Input type="number" value={generation.cfgScale} min={1} max={10} step={0.1} onChange={event => setNumeric('cfgScale', event.target.value, 1, 10)} disabled={disabled} className="h-10 rounded-control" />
                </label>
            </div>

            <details className="workspace-disclosure mt-2 px-3">
                <summary className="cursor-pointer text-xs font-medium">{t('scene.moreGenerationSettings', '세부 생성 설정')}</summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <label className="space-y-1">
                        <span className="text-xs text-muted-foreground">{t('parameters.cfgRescale', 'CFG Rescale')}</span>
                        <Input type="number" value={generation.cfgRescale} min={0} max={1} step={0.01} onChange={event => setNumeric('cfgRescale', event.target.value, 0, 1)} disabled={disabled} />
                    </label>
                    <label className="space-y-1">
                        <span className="text-xs text-muted-foreground">{t('parameters.sampler', '샘플러')}</span>
                        <Select value={generation.sampler} onValueChange={value => patchGeneration('sampler', value)} disabled={disabled}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>{SAMPLERS.map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
                        </Select>
                    </label>
                    <label className="space-y-1">
                        <span className="text-xs text-muted-foreground">{t('parameters.scheduler', '스케줄러')}</span>
                        <Select
                            value={isV5 ? 'karras' : generation.scheduler}
                            onValueChange={value => patchGeneration('scheduler', value)}
                            disabled={disabled || isV5}
                        >
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>{SCHEDULERS.map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
                        </Select>
                        {isV5 && (
                            <span className="text-xs text-muted-foreground">
                                {t('parameters.v5Karras', 'V5 요청은 Karras로 자동 맞춰져요.')}
                            </span>
                        )}
                    </label>
                    <label className="space-y-1">
                        <span className="text-xs text-muted-foreground">{t('parameters.ucPreset', 'UC Preset')}</span>
                        <Input type="number" value={generation.ucPreset} min={0} max={4} onChange={event => setNumeric('ucPreset', event.target.value, 0, 4)} disabled={disabled} />
                    </label>
                    {!isV5 && (
                        <div className="flex min-h-10 items-center justify-between rounded-control border border-border px-3">
                            <Label>{t('parameters.variety', 'Variety+')}</Label>
                            <Switch checked={generation.variety} onChange={event => patchGeneration('variety', event.target.checked)} disabled={disabled} />
                        </div>
                    )}
                    <div className="flex min-h-10 items-center justify-between rounded-control border border-border px-3">
                        <Label>{t('parameters.qualityToggle', '품질 태그')}</Label>
                        <Switch checked={generation.qualityToggle} onChange={event => patchGeneration('qualityToggle', event.target.checked)} disabled={disabled} />
                    </div>
                </div>
                <SceneOutputNamingEditor presetId={presetId} scene={scene} disabled={disabled} />
            </details>
        </section>
    )
}
