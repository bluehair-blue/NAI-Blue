import { describe, expect, it } from 'vitest'
import {
    mainPromptHasText,
    openInSingleNeedsConfirmation,
    runSavedOutputStage,
    SavedOutputActionError,
    savedOutputActionMessage,
    savedOutputValidationError,
} from '@/presentation/folders/saved-output-actions'

const t = (key: string, fallback: string, options?: Record<string, unknown>) =>
    `${key}|${fallback.replace('{{reason}}', String(options?.reason ?? ''))}`

describe('saved output open-in-single confirmation', () => {
    it('asks only when one of the four main prompt slots has text', () => {
        const empty = { basePrompt: '', additionalPrompt: '  ', detailPrompt: '', negativePrompt: '' }
        expect(mainPromptHasText(empty)).toBe(false)
        expect(mainPromptHasText({ ...empty, basePrompt: '1girl' })).toBe(true)
        expect(mainPromptHasText({ ...empty, additionalPrompt: 'cafe' })).toBe(true)
        expect(mainPromptHasText({ ...empty, detailPrompt: 'soft light' })).toBe(true)
        expect(mainPromptHasText({ ...empty, negativePrompt: 'lowres' })).toBe(true)
    })

    it('also asks when only character prompts exist, because opening adds this image\'s characters to them', () => {
        const empty = { basePrompt: '', additionalPrompt: '', detailPrompt: '', negativePrompt: '' }
        expect(openInSingleNeedsConfirmation({ generation: empty, characterIds: [] })).toBe(false)
        expect(openInSingleNeedsConfirmation({ generation: empty, characterIds: ['char-1'] })).toBe(true)
        expect(openInSingleNeedsConfirmation({ generation: { ...empty, basePrompt: '1girl' }, characterIds: [] })).toBe(true)
    })
})

describe('saved output action errors', () => {
    it('tags a failure with the stage it happened in and keeps an inner stage', async () => {
        await expect(runSavedOutputStage('read', () => Promise.reject(new Error('ENOENT')))).rejects.toMatchObject({ stage: 'read' })
        await expect(runSavedOutputStage('apply', () => Promise.reject(new SavedOutputActionError('metadata', 'No prompt'))))
            .rejects.toMatchObject({ stage: 'metadata' })
    })

    it('names the cause: unreadable file, missing metadata, character conflict, other apply failure', () => {
        expect(savedOutputActionMessage(new SavedOutputActionError('read', new Error('ENOENT')), t)).toMatch(/^savedOutputs\.readFailed\|/)
        expect(savedOutputActionMessage(new SavedOutputActionError('metadata', 'No metadata'), t)).toMatch(/^metadata\.globalNoPrompt\|/)
        const conflict = savedOutputValidationError([{ code: 'character-id-conflict', message: 'Character c1 was already imported.' }])
        expect(conflict.stage).toBe('apply')
        expect(savedOutputActionMessage(conflict, t)).toMatch(/^savedOutputs\.characterConflict\|/)
        expect(savedOutputActionMessage(new SavedOutputActionError('apply', new Error('quota exceeded')), t))
            .toBe('savedOutputs.applyFailedReason|프롬프트를 불러오지 못했어요. (quota exceeded)')
        expect(savedOutputActionMessage(new SavedOutputActionError('apply', new Error('')), t)).toMatch(/^savedOutputs\.applyFailed\|/)
    })
})
