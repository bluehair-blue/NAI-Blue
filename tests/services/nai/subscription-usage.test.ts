import { beforeEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => tauri)

import { getAnlasBalance, getUserInfo } from '@/services/nai/client'

describe('NovelAI subscription usage adapter', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('returns the complete Opus V5 allowance beside the existing Anlas balance', async () => {
        tauri.invoke.mockResolvedValue({
            success: true,
            fixed: 120,
            purchased: 30,
            usage: {
                percent: 87.5,
                isNegative: false,
                timeUntilNextPercent: 142.25,
            },
        })

        await expect(getUserInfo('  fixture-token  ')).resolves.toEqual({
            anlas: { fixed: 120, purchased: 30, total: 150 },
            usage: {
                percent: 87.5,
                isNegative: false,
                timeUntilNextPercent: 142.25,
            },
        })
        expect(tauri.invoke).toHaveBeenCalledWith('get_anlas_balance', { token: 'fixture-token' })
    })

    it.each([[75, 75], [450, 400], [-2, 0]])('retains purchased Extra Usage independently (%s)', async (extra, expected) => {
        tauri.invoke.mockResolvedValue({
            success: true, fixed: 4, purchased: 5,
            usage: { percent: 0, isNegative: true, timeUntilNextPercent: 1, purchasedPercent: extra },
        })
        await expect(getUserInfo('fixture-token')).resolves.toMatchObject({
            anlas: { total: 9 },
            usage: { percent: 0, isNegative: true, timeUntilNextPercent: 1, purchasedPercent: expected },
        })
    })

    it('ignores an invalid optional Extra Usage value while retaining valid regular usage', async () => {
        tauri.invoke.mockResolvedValue({
            success: true, fixed: 4, purchased: 5,
            usage: { percent: 20, isNegative: false, timeUntilNextPercent: 1, purchasedPercent: 'invalid' },
        })
        await expect(getUserInfo('fixture-token')).resolves.toEqual({
            anlas: { fixed: 4, purchased: 5, total: 9 },
            usage: { percent: 20, isNegative: false, timeUntilNextPercent: 1 },
        })
    })

    it('preserves older successful responses that do not include usage', async () => {
        tauri.invoke.mockResolvedValue({ success: true, fixed: 4, purchased: 5 })

        await expect(getUserInfo('fixture-token')).resolves.toEqual({
            anlas: { fixed: 4, purchased: 5, total: 9 },
        })
        await expect(getAnlasBalance('fixture-token')).resolves.toEqual({
            success: true,
            fixedTrainingStepsLeft: 4,
            purchasedTrainingSteps: 5,
            error: undefined,
        })
    })

    it.each([
        ['signed', -1, true, 0],
        ['overfull', 101, false, 100],
    ])('clamps %s percentages without losing the quota state', async (_label, percent, isNegative, expected) => {
        tauri.invoke.mockResolvedValue({
            success: true,
            fixed: 4,
            purchased: 5,
            usage: { percent, isNegative, timeUntilNextPercent: 1 },
        })

        await expect(getUserInfo('fixture-token')).resolves.toEqual({
            anlas: { fixed: 4, purchased: 5, total: 9 },
            usage: { percent: expected, isNegative, timeUntilNextPercent: 1 },
        })
    })

    it.each([
        ['missing timer', { percent: 50, isNegative: false }],
        ['non-boolean sign', { percent: 50, isNegative: 'false', timeUntilNextPercent: 1 }],
        ['negative timer', { percent: 50, isNegative: false, timeUntilNextPercent: -1 }],
        ['non-finite percent', { percent: Number.NaN, isNegative: false, timeUntilNextPercent: 1 }],
    ])('fails closed for %s without losing Anlas data', async (_label, usage) => {
        tauri.invoke.mockResolvedValue({ success: true, fixed: 4, purchased: 5, usage })

        await expect(getUserInfo('fixture-token')).resolves.toEqual({
            anlas: { fixed: 4, purchased: 5, total: 9 },
        })
    })
})
