import { AlertTriangle, Dice5, Lock, Unlock } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ResolutionSelector } from '@/components/ui/ResolutionSelector'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import { cn, generateRandomSeed } from '@/lib/utils'
import {
    assessGenerationStepQuality,
    LOW_STEP_CAUTION_THRESHOLD,
    RECOMMENDED_GENERATION_STEPS,
} from '@/services/generation/generation-quality'
import { NAI_IMAGE_MODELS } from '@/services/nai/model-catalog'
import { useGenerationDraftStore } from '@/stores/generation-draft-store'
import { useGenerationSessionStore } from '@/stores/generation-session-store'

/**
 * Core Main authoring controls (Model, Resolution, Steps, Seed) mounted directly
 * beneath PromptEditorSurface inside the scrollable prompt rail so the user can
 * inspect and adjust them without opening a modal dialog.
 */
export function PromptCoreParameters() {
    const { t } = useTranslation()
    const model = useGenerationDraftStore(state => state.model)
    const selectedResolution = useGenerationDraftStore(state => state.selectedResolution)
    const steps = useGenerationDraftStore(state => state.steps)
    const seed = useGenerationDraftStore(state => state.seed)
    const seedLocked = useGenerationDraftStore(state => state.seedLocked)
    const setModel = useGenerationDraftStore(state => state.setModel)
    const setSelectedResolution = useGenerationDraftStore(state => state.setSelectedResolution)
    const setSteps = useGenerationDraftStore(state => state.setSteps)
    const setSeed = useGenerationDraftStore(state => state.setSeed)
    const setSeedLocked = useGenerationDraftStore(state => state.setSeedLocked)
    const isGenerating = useGenerationSessionStore(state => state.isGenerating)

    const stepQuality = assessGenerationStepQuality(steps)

    const handleRandomSeed = () => {
        if (!seedLocked) {
            setSeed(generateRandomSeed())
        }
    }

    const handleStepsChange = (raw: string) => {
        const parsed = Number.parseInt(raw, 10)
        if (Number.isNaN(parsed)) return
        setSteps(Math.min(50, Math.max(1, parsed)))
    }

    return (
        <section
            className="space-y-3"
            aria-label={t('parameters.coreTitle', '핵심 설정')}
            data-testid="prompt-core-parameters"
        >
            <div className="grid grid-cols-2 gap-2.5">
                {/* Model */}
                <div className="min-w-0 space-y-1">
                    <Label className="block truncate text-xs font-medium text-muted-foreground">
                        {t('parameters.model')}
                    </Label>
                    <Select value={model} onValueChange={setModel} disabled={isGenerating}>
                        <SelectTrigger
                            className="h-11 min-w-0 rounded-control px-2.5 text-xs"
                            aria-label={t('parameters.model')}
                            data-prompt-focus="model"
                        >
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
                </div>

                {/* Resolution */}
                <div className="min-w-0 space-y-1">
                    <Label className="block truncate text-xs font-medium text-muted-foreground">
                        {t('settings.resolution')}
                    </Label>
                    <ResolutionSelector
                        value={selectedResolution}
                        onChange={setSelectedResolution}
                        disabled={isGenerating}
                    />
                </div>
            </div>

            <div className="grid grid-cols-[minmax(5rem,0.62fr)_minmax(0,1.38fr)] gap-2.5">
                {/* Steps */}
                <div className="min-w-0 space-y-1">
                    <Label
                        htmlFor="prompt-core-steps"
                        className="block truncate text-xs font-medium text-muted-foreground"
                    >
                        {t('parameters.steps')}
                    </Label>
                    <Input
                        id="prompt-core-steps"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={50}
                        step={1}
                        value={steps}
                        disabled={isGenerating}
                        onChange={event => handleStepsChange(event.target.value)}
                        data-prompt-focus="steps"
                        className={cn(
                            'h-11 min-w-0 rounded-control px-2.5 font-mono text-xs tabular-nums',
                            steps > 28 && 'border-destructive text-destructive',
                        )}
                    />
                </div>

                {/* Seed */}
                <div className="min-w-0 space-y-1">
                    <Label
                        htmlFor="prompt-core-seed"
                        className="block truncate text-xs font-medium text-muted-foreground"
                    >
                        {t('settings.seed')}
                    </Label>
                    <div className="flex min-w-0 items-center gap-1">
                        <Input
                            id="prompt-core-seed"
                            type="number"
                            inputMode="numeric"
                            value={seed}
                            onChange={event => setSeed(Number(event.target.value))}
                            disabled={seedLocked || isGenerating}
                            className="h-11 min-w-0 flex-1 rounded-control px-2 font-mono text-xs tabular-nums"
                        />
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className={cn(
                                'h-11 w-11 shrink-0 rounded-control',
                                seedLocked && 'bg-primary/10 text-primary',
                            )}
                            onClick={() => setSeedLocked(!seedLocked)}
                            disabled={isGenerating}
                            aria-label={seedLocked ? t('settings.unlockSeed', '시드 잠금 해제') : t('settings.lockSeed', '시드 잠금')}
                            aria-pressed={seedLocked}
                        >
                            {seedLocked ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
                        </Button>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-11 w-11 shrink-0 rounded-control"
                            onClick={handleRandomSeed}
                            disabled={seedLocked || isGenerating}
                            aria-label={t('settings.randomSeed', '무작위 시드')}
                        >
                            <Dice5 className="h-4 w-4" />
                        </Button>
                    </div>
                </div>
            </div>

            {stepQuality !== 'normal' && (
                // The draft store supplies the live value and the command guard enforces
                // the same threshold; offer a one-tap recovery right beside the Steps field.
                <div className="flex flex-col gap-2 rounded-control bg-warning/10 p-3 text-left" role="alert">
                    <div className="flex min-w-0 gap-2">
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
                        variant="secondary"
                        size="sm"
                        className="h-11 self-start"
                        onClick={() => setSteps(RECOMMENDED_GENERATION_STEPS)}
                    >
                        {t('generate.restoreRecommendedSteps', '28 steps로 복원')}
                    </Button>
                </div>
            )}
        </section>
    )
}
