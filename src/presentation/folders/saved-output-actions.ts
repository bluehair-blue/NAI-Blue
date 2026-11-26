import type { MetadataApplyValidationIssue } from '@/services/output/metadata-apply'

/** Where a saved-original action stopped: the file, its prompt metadata, or applying it to the main prompt. */
export type SavedOutputActionStage = 'read' | 'metadata' | 'apply'

export class SavedOutputActionError extends Error {
    readonly stage: SavedOutputActionStage
    readonly codes: readonly string[]

    constructor(stage: SavedOutputActionStage, cause?: unknown, codes: readonly string[] = []) {
        super(cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : stage)
        this.name = 'SavedOutputActionError'
        this.stage = stage
        this.codes = codes
    }
}

/** Runs one step and tags any failure with its stage, keeping a stage already assigned by an inner step. */
export async function runSavedOutputStage<T>(stage: SavedOutputActionStage, run: () => Promise<T>): Promise<T> {
    try {
        return await run()
    } catch (cause) {
        if (cause instanceof SavedOutputActionError) throw cause
        throw new SavedOutputActionError(stage, cause)
    }
}

export function savedOutputValidationError(errors: readonly MetadataApplyValidationIssue[]): SavedOutputActionError {
    return new SavedOutputActionError('apply', errors.map(issue => issue.message).join(' '), errors.map(issue => issue.code))
}

export interface MainPromptSlots {
    basePrompt: string
    additionalPrompt: string
    detailPrompt: string
    negativePrompt: string
}

/** Opening a saved original overwrites these four slots, so any text in them needs an explicit confirmation. */
export function mainPromptHasText(slots: MainPromptSlots): boolean {
    return [slots.basePrompt, slots.additionalPrompt, slots.detailPrompt, slots.negativePrompt]
        .some(text => typeof text === 'string' && text.trim().length > 0)
}

export interface SingleOpenTarget {
    generation: MainPromptSlots
    /** IDs in the character prompt list; opening appends this image's characters to them. */
    characterIds: readonly string[]
}

/** Opening replaces the four slots and adds character prompts, so either kind of existing work needs a confirmation. */
export function openInSingleNeedsConfirmation(target: SingleOpenTarget): boolean {
    return mainPromptHasText(target.generation) || target.characterIds.length > 0
}

type Translate = (key: string, fallback: string, options?: Record<string, unknown>) => string

export function savedOutputActionMessage(error: unknown, t: Translate): string {
    const stage = error instanceof SavedOutputActionError ? error.stage : 'apply'
    if (stage === 'read') {
        return t('savedOutputs.readFailed', '저장된 이미지 파일을 읽지 못했어요. 파일이 옮겨졌거나 지워졌는지 확인해 주세요.')
    }
    if (stage === 'metadata') {
        return t('metadata.globalNoPrompt', '이 이미지에서 불러올 프롬프트 메타데이터를 찾지 못했어요.')
    }
    if (error instanceof SavedOutputActionError && error.codes.includes('character-id-conflict')) {
        return t('savedOutputs.characterConflict', '이 이미지의 캐릭터 프롬프트가 이미 들어 있어 불러오지 못했어요. 캐릭터 프롬프트를 정리한 뒤 다시 시도해 주세요.')
    }
    const reason = error instanceof Error && error.message.trim() ? error.message.trim() : ''
    return reason
        ? t('savedOutputs.applyFailedReason', '프롬프트를 불러오지 못했어요. ({{reason}})', { reason })
        : t('savedOutputs.applyFailed', '프롬프트를 불러오지 못했어요.')
}
