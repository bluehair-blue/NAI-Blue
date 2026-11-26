import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
    liveNumericDraftValue,
    numericDraftInput,
    numericDraftLeave,
    numericDraftText,
    resolveNumericDraft,
    type NumericDraftRange,
    type NumericDraftState,
} from '@/components/prompt/numeric-draft'

const source = (path: string) => readFile(resolve(process.cwd(), path), 'utf8')
const STEPS = { min: 1, max: 50, integer: true }
const CFG_SCALE = { min: 1, max: 10 }

/** Replays typing into a field the way useNumericDraft does, returning the stored value and the visible text. */
function typeInto(initial: number, range: NumericDraftRange, texts: string[]) {
    let stored = initial
    let draft: NumericDraftState | null = null
    const shown: string[] = []
    for (const text of texts) {
        const step = numericDraftInput(text, stored, range)
        draft = step.draft
        if (step.commit !== null) stored = step.commit
        shown.push(numericDraftText(draft, stored))
    }
    const leave = () => numericDraftLeave(draft, stored, initial, range) ?? stored
    return { stored, shown, leave }
}

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

    it('stores a valid draft while typing so cost and warnings follow before focus leaves', () => {
        expect(liveNumericDraftValue('40', STEPS)).toBe(40)
        expect(liveNumericDraftValue('', STEPS)).toBeNull()
        expect(liveNumericDraftValue('0', STEPS)).toBeNull()
        expect(liveNumericDraftValue('99', STEPS)).toBeNull()
        expect(liveNumericDraftValue('12.5', STEPS)).toBeNull()
        expect(liveNumericDraftValue('abc', STEPS)).toBeNull()
        const typed = typeInto(28, STEPS, ['4', '40'])
        expect(typed.stored).toBe(40)
        // A spin-button step arrives as one input event with the new number.
        expect(typeInto(28, STEPS, ['29']).stored).toBe(29)
    })

    it('keeps a decimal being typed on screen after its own commit', () => {
        const typed = typeInto(7, CFG_SCALE, ['5', '5.', '5.5', '5.50'])
        expect(typed.shown).toEqual(['5', '5.', '5.5', '5.50'])
        expect(typed.stored).toBe(5.5)
        expect(typed.leave()).toBe(5.5)
        // An outside change (restore button, scene switch) replaces the draft text.
        expect(numericDraftText({ text: '5.', value: 5 }, 6)).toBe('6')
    })

    it('settles the field on leave: empty goes back to the focus value, out of range is clamped', () => {
        // 28 -> Backspace x2 -> "30" -> blur.
        expect(typeInto(28, STEPS, ['2', '', '3', '30']).leave()).toBe(30)
        // Clearing commits "2" on the way; leaving (blur or unmount) must not keep it.
        const cleared = typeInto(28, STEPS, ['2', ''])
        expect(cleared.stored).toBe(2)
        expect(cleared.leave()).toBe(28)
        expect(typeInto(28, STEPS, ['0']).leave()).toBe(1)
        expect(typeInto(28, STEPS, ['9', '99']).leave()).toBe(50)
        expect(typeInto(28, STEPS, ['abc']).leave()).toBe(28)
        expect(numericDraftLeave(null, 28, 28, STEPS)).toBeNull()
        // A draft overtaken by an outside change is dropped, not committed over it.
        expect(numericDraftLeave({ text: '', value: 28 }, 12, 28, STEPS)).toBeNull()
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
