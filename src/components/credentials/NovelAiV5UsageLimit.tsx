import { RotateCw } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { OPUS_FREE_PIXEL_LIMIT, OPUS_FREE_STEPS_LIMIT } from '@/lib/anlas-calculator'
import { cn } from '@/lib/utils'
import { isNovelAiV5Model } from '@/services/nai/model-catalog'
import type { OpusGenerationUsage } from '@/services/novelai-api'
import { type ApiSlot, useAuthStore } from '@/stores/auth-store'
import { useLayoutStore } from '@/stores/layout-store'

type IneligibleReason = 'resolution' | 'steps' | 'character'

interface OpusSlotView {
    slot: ApiSlot
    usage: OpusGenerationUsage | null
}

export interface NovelAiV5UsageLimitProps {
    model: string | null
    width: number
    height: number
    steps: number
    maxAnlas: number
    hasCharacterReference?: boolean
    className?: string
}

export function normalizeOpusV5UsagePercent(usage: OpusGenerationUsage | null): number | null {
    if (usage === null) return null
    if (usage.isNegative) return 0
    return Math.min(100, Math.max(0, usage.percent))
}

export function resolveOpusV5UsagePanelPolicy(input: {
    usage: OpusGenerationUsage | null
    width: number
    height: number
    steps: number
    hasCharacterReference?: boolean
    alwaysShow: boolean
}): {
    displayPercent: number | null
    eligible: boolean
    ineligibleReason: IneligibleReason | null
    forcedOpen: boolean
    open: boolean
    refillPercentPerHour: number | null
} {
    const pixels = input.width * input.height
    const ineligibleReason: IneligibleReason | null = pixels > OPUS_FREE_PIXEL_LIMIT
        ? 'resolution'
        : input.steps > OPUS_FREE_STEPS_LIMIT
            ? 'steps'
            : input.hasCharacterReference
                ? 'character'
                : null
    const displayPercent = normalizeOpusV5UsagePercent(input.usage)
    const forcedOpen = ineligibleReason !== null || displayPercent === null || displayPercent < 5
    const timer = input.usage?.timeUntilNextPercent ?? 0

    return {
        displayPercent,
        eligible: ineligibleReason === null,
        ineligibleReason,
        forcedOpen,
        open: input.alwaysShow || forcedOpen,
        refillPercentPerHour: timer > 0 ? 3600 / timer : null,
    }
}

function useActiveOpusSlots(): OpusSlotView[] {
    const token = useAuthStore(state => state.token)
    const token2 = useAuthStore(state => state.token2)
    const isVerified = useAuthStore(state => state.isVerified)
    const isVerified2 = useAuthStore(state => state.isVerified2)
    const slot1Enabled = useAuthStore(state => state.slot1Enabled)
    const slot2Enabled = useAuthStore(state => state.slot2Enabled)
    const tier = useAuthStore(state => state.tier)
    const tier2 = useAuthStore(state => state.tier2)
    const opusUsage = useAuthStore(state => state.opusUsage)
    const opusUsage2 = useAuthStore(state => state.opusUsage2)
    const slots: OpusSlotView[] = []

    if (token && isVerified && slot1Enabled && tier === 'opus') {
        slots.push({ slot: 1, usage: opusUsage })
    }
    if (token2 && isVerified2 && slot2Enabled && tier2 === 'opus') {
        slots.push({ slot: 2, usage: opusUsage2 })
    }
    return slots
}

export function NovelAiV5UsageLimit({
    model,
    width,
    height,
    steps,
    maxAnlas,
    hasCharacterReference = false,
    className,
}: NovelAiV5UsageLimitProps) {
    const { t } = useTranslation()
    const isV5 = model !== null && isNovelAiV5Model(model)
    const slots = useActiveOpusSlots()
    const refreshAnlas = useAuthStore(state => state.refreshAnlas)
    const alwaysShow = useLayoutStore(state => state.alwaysShowV5UsageLimit)
    const setAlwaysShow = useLayoutStore(state => state.setAlwaysShowV5UsageLimit)
    const missingUsageSlots = slots
        .filter(({ usage }) => usage === null)
        .map(({ slot }) => slot)
    const missingUsageSlotKey = missingUsageSlots.join(',')

    useEffect(() => {
        if (!isV5) return
        for (const slot of missingUsageSlots) {
            void refreshAnlas(slot)
        }
    }, [isV5, missingUsageSlotKey, refreshAnlas])

    if (!isV5 || slots.length === 0) return null

    const policies = slots.map(({ slot, usage }) => ({
        slot,
        usage,
        policy: resolveOpusV5UsagePanelPolicy({
            usage,
            width,
            height,
            steps,
            hasCharacterReference,
            alwaysShow,
        }),
    }))
    const open = policies.some(entry => entry.policy.open)

    return (
        <details
            className={cn('rounded-panel border border-amber-300/40 bg-amber-50/70 p-3 text-sm text-amber-950 dark:border-amber-200/20 dark:bg-amber-950/25 dark:text-amber-50', className)}
            open={open}
        >
            <summary className="cursor-pointer select-none font-medium">
                {t('credentials.v5UsageLimit.title', 'Opus V5 usage limit')}
            </summary>
            <div className="mt-3 space-y-3">
                <p className="text-xs leading-relaxed text-amber-900/80 dark:text-amber-50/75">
                    {t('credentials.v5UsageLimit.description', 'Your Opus plan includes limited NovelAI Diffusion V5 generations at normal resolutions and up to 28 steps. When this allowance runs out, generation can continue with paid Anlas.')}
                </p>
                <p className="text-xs font-medium">
                    {t('credentials.v5UsageLimit.paidCeiling', 'Safe paid ceiling: up to {{maxAnlas}} Anlas.', { maxAnlas })}
                </p>
                <div className="space-y-2">
                    {policies.map(({ slot, usage, policy }) => (
                        <div key={slot} className="rounded-control bg-background/60 p-2">
                            <div className="flex items-center justify-between gap-3">
                                <span className="font-medium">
                                    {t('credentials.v5UsageLimit.slot', 'Opus slot {{slot}}', { slot })}
                                </span>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => void refreshAnlas(slot)}
                                    aria-label={t('credentials.v5UsageLimit.refresh', 'Refresh V5 usage for Opus slot {{slot}}', { slot })}
                                >
                                    <RotateCw className="h-4 w-4" aria-hidden="true" />
                                </Button>
                            </div>
                            {policy.displayPercent === null ? (
                                <p className="mt-1 text-xs text-muted-foreground">
                                    {t('credentials.v5UsageLimit.unknown', 'Usage is not loaded yet. Refresh to check the current allowance.')}
                                </p>
                            ) : (
                                <>
                                    <div className="mt-1 flex items-center justify-between gap-2 text-xs">
                                        <span>
                                            {policy.displayPercent <= 0
                                                ? t('credentials.v5UsageLimit.depleted', 'Included V5 allowance depleted')
                                                : t('credentials.v5UsageLimit.remaining', '{{percent}}% remaining', { percent: Math.round(policy.displayPercent) })}
                                        </span>
                                    </div>
                                    <progress
                                        className="mt-1 h-2 w-full"
                                        max={100}
                                        value={policy.displayPercent}
                                        aria-label={t('credentials.v5UsageLimit.progress', 'Opus slot {{slot}} V5 usage remaining', { slot })}
                                    >
                                        {policy.displayPercent}
                                    </progress>
                                </>
                            )}
                            <p className="mt-2 text-xs text-muted-foreground">
                                {policy.eligible
                                    ? t('credentials.v5UsageLimit.eligible', 'Current settings can use the included V5 allowance when it is available.')
                                    : t(`credentials.v5UsageLimit.ineligible.${policy.ineligibleReason}`, 'Current settings are outside the included V5 allowance.')}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                                {policy.refillPercentPerHour === null
                                    ? t('credentials.v5UsageLimit.refillUnknown', 'Refill speed is unavailable.')
                                    : t('credentials.v5UsageLimit.refilling', 'Currently refilling at about {{rate}}% per hour.', { rate: policy.refillPercentPerHour.toFixed(1) })}
                            </p>
                            {usage?.isNegative ? (
                                <p className="mt-1 text-xs font-medium text-destructive">
                                    {t('credentials.v5UsageLimit.negative', 'Allowance is below zero, so paid Anlas fallback is expected.')}
                                </p>
                            ) : null}
                        </div>
                    ))}
                </div>
                <label className="choice-row flex items-center gap-2 text-xs">
                    <input className="choice-checkbox"
                        type="checkbox"
                        checked={alwaysShow}
                        onChange={event => setAlwaysShow(event.currentTarget.checked)}
                    />
                    {t('credentials.v5UsageLimit.alwaysShow', 'Always show usage limit bar')}
                </label>
            </div>
        </details>
    )
}
