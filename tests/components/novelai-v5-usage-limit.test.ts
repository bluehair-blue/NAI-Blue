import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpusGenerationUsage } from '@/services/novelai-types'

const stores = vi.hoisted(() => {
    const defaults = {
        auth: {
            token: '',
            token2: '',
            isVerified: false,
            isVerified2: false,
            slot1Enabled: true,
            slot2Enabled: true,
            tier: null as string | null,
            tier2: null as string | null,
            opusUsage: null as OpusGenerationUsage | null,
            opusUsage2: null as OpusGenerationUsage | null,
            refreshAnlas: vi.fn(),
        },
        layout: {
            alwaysShowV5UsageLimit: true,
            setAlwaysShowV5UsageLimit: vi.fn(),
        },
    }
    let auth = { ...defaults.auth }
    let layout = { ...defaults.layout }

    return {
        reset: () => {
            auth = { ...defaults.auth, refreshAnlas: vi.fn() }
            layout = { ...defaults.layout, setAlwaysShowV5UsageLimit: vi.fn() }
        },
        setAuth: (patch: Partial<typeof auth>) => {
            auth = { ...auth, ...patch }
        },
        setLayout: (patch: Partial<typeof layout>) => {
            layout = { ...layout, ...patch }
        },
        useAuthStore: (selector: (state: typeof auth) => unknown) => selector(auth),
        useLayoutStore: (selector: (state: typeof layout) => unknown) => selector(layout),
    }
})

vi.mock('@/stores/auth-store', () => ({
    useAuthStore: stores.useAuthStore,
}))

vi.mock('@/stores/layout-store', () => ({
    useLayoutStore: stores.useLayoutStore,
}))

vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (_key: string, fallback: string, values?: Record<string, unknown>) => fallback.replace(
            /\{\{(\w+)\}\}/g,
            (_match, key: string) => String(values?.[key] ?? ''),
        ),
    }),
}))

import {
    NovelAiV5UsageLimit,
    normalizeOpusV5UsagePercent,
    normalizeOpusV5PurchasedUsagePercent,
    resolveOpusV5UsagePanelPolicy,
} from '@/components/credentials/NovelAiV5UsageLimit'

function renderPanel(model = 'nai-diffusion-5-full'): string {
    return renderToStaticMarkup(createElement(NovelAiV5UsageLimit, {
        model,
        width: 1024,
        height: 1024,
        steps: 28,
        maxAnlas: 23,
    }))
}

describe('NovelAiV5UsageLimit', () => {
    beforeEach(() => {
        stores.reset()
    })

    it('shows Extra Usage separately and does not claim paid fallback while it remains', () => {
        const usage = { percent: 0, isNegative: true, timeUntilNextPercent: 7200, purchasedPercent: 75 }
        stores.setAuth({ token: 'secret-slot-one', isVerified: true, tier: 'opus', opusUsage: usage })
        expect(normalizeOpusV5PurchasedUsagePercent(usage)).toBe(75)
        expect(normalizeOpusV5PurchasedUsagePercent({ ...usage, purchasedPercent: 500 })).toBe(400)
        expect(resolveOpusV5UsagePanelPolicy({ usage, width: 1024, height: 1024, steps: 28, alwaysShow: false }))
            .toMatchObject({ displayPercent: 0, displayPurchasedPercent: 75, forcedOpen: false })
        const html = renderPanel()
        expect(html).toContain('Extra Usage: 75%')
        expect(html).toContain('max="400"')
        expect(html).not.toContain('paid Anlas fallback is expected')
        expect(html).not.toContain('secret-slot-one')
    })

    it('renders nothing outside V5 or without an active verified Opus slot', () => {
        stores.setAuth({ token: 'secret-slot-one', isVerified: true, tier: 'opus' })

        expect(renderPanel('nai-diffusion-4-5-full')).toBe('')

        stores.setAuth({ tier: 'tablet' })
        expect(renderPanel()).toBe('')
    })

    it('shows active Opus slots separately without leaking token text', () => {
        stores.setAuth({
            token: 'secret-slot-one',
            token2: 'secret-slot-two',
            isVerified: true,
            isVerified2: true,
            tier: 'opus',
            tier2: 'opus',
            opusUsage: { percent: 150, isNegative: false, timeUntilNextPercent: 7200 },
            opusUsage2: { percent: 34, isNegative: true, timeUntilNextPercent: 0 },
        })

        const html = renderPanel()

        expect(html).toContain('Opus slot 1')
        expect(html).toContain('Opus slot 2')
        expect(html).toContain('aria-label="Opus slot 1 V5 usage remaining"')
        expect(html).toContain('aria-label="Refresh V5 usage for Opus slot 2"')
        expect(html).toContain('value="100"')
        expect(html).toContain('value="0"')
        expect(html).toContain('Safe paid ceiling: up to 23 Anlas.')
        expect(html).not.toContain('secret-slot-one')
        expect(html).not.toContain('secret-slot-two')
    })

    it('keeps the open-state and refill policy deterministic', () => {
        expect(normalizeOpusV5UsagePercent({ percent: -3, isNegative: false, timeUntilNextPercent: 0 })).toBe(0)
        expect(normalizeOpusV5UsagePercent({ percent: 200, isNegative: false, timeUntilNextPercent: 0 })).toBe(100)
        expect(normalizeOpusV5UsagePercent({ percent: 60, isNegative: true, timeUntilNextPercent: 0 })).toBe(0)

        expect(resolveOpusV5UsagePanelPolicy({
            usage: { percent: 88, isNegative: false, timeUntilNextPercent: 7200 },
            width: 1024,
            height: 1024,
            steps: 28,
            alwaysShow: false,
        })).toMatchObject({
            displayPercent: 88,
            eligible: true,
            forcedOpen: false,
            open: false,
            refillPercentPerHour: 0.5,
        })

        expect(resolveOpusV5UsagePanelPolicy({
            usage: null,
            width: 1024,
            height: 1024,
            steps: 28,
            alwaysShow: false,
        }).open).toBe(true)

        expect(resolveOpusV5UsagePanelPolicy({
            usage: { percent: 90, isNegative: false, timeUntilNextPercent: 0 },
            width: 1024,
            height: 1024,
            steps: 29,
            alwaysShow: false,
        })).toMatchObject({
            eligible: false,
            ineligibleReason: 'steps',
            open: true,
        })
    })

    it('surfaces unknown usage and the always-show checkbox', () => {
        stores.setAuth({
            token: 'secret-slot-one',
            isVerified: true,
            tier: 'opus',
            opusUsage: null,
        })

        const html = renderPanel()

        expect(html).toContain('open=""')
        expect(html).toContain('Usage is not loaded yet.')
        expect(html).toContain('Always show usage limit bar')
        expect(html).toContain('checked=""')
    })
})
