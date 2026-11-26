import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveNumericDraft } from '@/components/prompt/numeric-draft'

const source = (path: string) => readFile(resolve(process.cwd(), path), 'utf8')
const STEPS = { min: 1, max: 50, integer: true }

describe('numeric draft commit', () => {
    it('keeps the typed value instead of appending to the previous one', () => {
        // 28 -> Backspace x2 -> "30" used to become 230 and clamp to 50.
        expect(resolveNumericDraft('30', 28, STEPS)).toBe(30)
    })

    it('restores the previous value when the field is left empty or unreadable', () => {
        expect(resolveNumericDraft('', 28, STEPS)).toBe(28)
        expect(resolveNumericDraft('   ', 28, STEPS)).toBe(28)
        expect(resolveNumericDraft('abc', 28, STEPS)).toBe(28)
    })

    it('clamps to the allowed range only when committing', () => {
        expect(resolveNumericDraft('0', 28, STEPS)).toBe(1)
        expect(resolveNumericDraft('99', 28, STEPS)).toBe(50)
        expect(resolveNumericDraft('-5', 28, STEPS)).toBe(1)
    })

    it('rounds integer fields and keeps decimals for fractional fields', () => {
        expect(resolveNumericDraft('12.6', 28, STEPS)).toBe(13)
        expect(resolveNumericDraft('5.55', 5, { min: 1, max: 10 })).toBe(5.55)
        expect(resolveNumericDraft('0.7', 0, { min: 0, max: 1 })).toBe(0.7)
        expect(resolveNumericDraft('0', 1234, { min: 0, max: 4294967295, integer: true })).toBe(0)
    })

    it('wires every free-typed generation number through the draft commit', async () => {
        const [core, sceneEditor] = await Promise.all([
            source('src/components/prompt/PromptCoreParameters.tsx'),
            source('src/components/scene/ScenePromptEditor.tsx'),
        ])

        expect(core).toContain('useNumericDraft(steps, STEPS_RANGE, setSteps, isGenerating)')
        expect(core).toContain('useNumericDraft(seed, SEED_RANGE, setSeed, seedLocked || isGenerating)')
        expect(core).toContain('data-prompt-focus="steps"')
        expect(core).toContain("t('generate.restoreRecommendedSteps'")
        expect(core).not.toMatch(/onChange=\{event => set(Steps|Seed)/)
        for (const field of ['seed', 'steps', 'cfgScale', 'cfgRescale', 'ucPreset']) {
            expect(sceneEditor).toContain(`useNumericDraft(generation.${field},`)
        }
        expect(sceneEditor).not.toContain('setNumeric(')
    })
})
