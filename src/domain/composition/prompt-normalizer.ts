import type {
    EntityId,
    PositivePromptSlot,
    PromptContribution,
} from './types'

export const CANONICAL_MAIN_PROMPT_SLOT_ORDER = [
    'base',
    'inpainting',
    'additional',
    'workflow',
    'detail',
] as const

export type CanonicalMainPromptSlot = typeof CANONICAL_MAIN_PROMPT_SLOT_ORDER[number]
export type PromptDedupePolicy = 'exact-token' | 'none' | 'verbatim'

export interface MainPromptText {
    base: string
    inpainting: string
    additional: string
    workflow: string
    detail: string
}

export interface CharacterPromptText {
    characterId: EntityId
    positive: string
    negative: string
}

/**
 * Intermediate prompt text after contribution ordering and merge operations.
 * A caller may resolve wildcard syntax in this serializable value before calling
 * `finalizePromptComposition`; wildcard resolution intentionally does not live in
 * this module.
 */
export interface PromptCompositionDraft {
    main: MainPromptText
    negative: string
    characters: CharacterPromptText[]
}

/** Optional target-local text that exists before ordered contribution operations. */
export interface InitialPromptComposition {
    main?: Partial<MainPromptText>
    negative?: string
    characters?: readonly CharacterPromptText[]
}

export interface FinalizedPromptComposition extends PromptCompositionDraft {
    positive: string
    dedupePolicy: PromptDedupePolicy
}

export type PromptDraftTarget =
    | { kind: 'positive'; slot: CanonicalMainPromptSlot }
    | { kind: 'negative' }
    | { kind: 'character'; characterId: EntityId; polarity: 'positive' | 'negative' }

export interface FinalizePromptOptions {
    dedupe?: PromptDedupePolicy
}

export interface ComposePromptOptions {
    /** Preserve text when the caller already ran the pipeline's comment stage. */
    comments?: 'remove-full-line' | 'preserve'
    whitespace?: 'trim' | 'preserve'
}

const SEPARATORS = {
    'comma-space': ', ',
    space: ' ',
    newline: '\n',
    none: '',
} as const

interface CharacterContributionGroup {
    characterId: EntityId
    positive: PromptContribution[]
    negative: PromptContribution[]
}

function emptyMainPromptText(): MainPromptText {
    return {
        base: '',
        inpainting: '',
        additional: '',
        workflow: '',
        detail: '',
    }
}

function emptyMainContributionGroups(): Record<CanonicalMainPromptSlot, PromptContribution[]> {
    return {
        base: [],
        inpainting: [],
        additional: [],
        workflow: [],
        detail: [],
    }
}

function compareStableText(left: string, right: string): number {
    if (left < right) return -1
    if (left > right) return 1
    return 0
}

function compareContributions(left: PromptContribution, right: PromptContribution): number {
    return compareStableText(left.orderKey, right.orderKey) || compareStableText(left.id, right.id)
}

function toCanonicalMainSlot(slot: PositivePromptSlot): CanonicalMainPromptSlot {
    switch (slot) {
        case 'base':
        case 'inpainting':
        case 'additional':
        case 'workflow':
        case 'detail':
            return slot
        // These v2 compatibility targets are workflow-owned positive prompt text.
        case 'scene':
        case 'style':
        case 'quality':
            return 'workflow'
    }
}

function separatorFor(contribution: PromptContribution): string {
    return SEPARATORS[contribution.separator ?? 'comma-space']
}

function joinOperationText(left: string, right: string, separator: string): string {
    if (left.length === 0) return right
    if (right.length === 0) return left
    return `${left}${separator}${right}`
}

function applyContribution(
    current: string,
    contribution: PromptContribution,
    options: ComposePromptOptions,
): string {
    const cleaned = (options.comments === 'preserve'
        ? contribution.text
        : removePromptCommentLines(contribution.text))
    const text = options.whitespace === 'preserve' ? cleaned : cleaned.trim()

    switch (contribution.merge) {
        case 'append':
            return joinOperationText(current, text, separatorFor(contribution))
        case 'prepend':
            return joinOperationText(text, current, separatorFor(contribution))
        case 'replace':
            return text
    }
}

function mergeContributionGroup(
    contributions: readonly PromptContribution[],
    initialText = '',
    options: ComposePromptOptions = {},
): string {
    let result = initialText
    for (const contribution of [...contributions].sort(compareContributions)) {
        result = applyContribution(result, contribution, options)
    }
    return result
}

function finalizeText(text: string, policy: PromptDedupePolicy, seen?: Set<string>): string {
    if (policy === 'verbatim') return text
    const knownTokens = seen ?? new Set<string>()
    const result: string[] = []

    for (const rawToken of text.split(',')) {
        const token = rawToken.trim()
        if (token.length === 0) continue
        if (policy === 'exact-token' && knownTokens.has(token)) continue
        if (policy === 'exact-token') knownTokens.add(token)
        result.push(token)
    }

    return result.join(', ')
}

function joinMainPrompt(main: MainPromptText): string {
    return CANONICAL_MAIN_PROMPT_SLOT_ORDER
        .map(slot => main[slot])
        .filter(text => text.length > 0)
        .join(', ')
}

/** Remove only lines whose first non-whitespace character is `#`. */
export function removePromptCommentLines(text: string): string {
    return text
        .split(/\r\n|\n|\r/)
        .filter(line => !/^\s*#/.test(line))
        .join('\n')
}

/**
 * Sort and merge contribution text without resolving wildcards or deduplicating
 * comma tokens. Tombstoned and disabled contributions do not participate.
 */
export function composePromptContributions(
    contributions: readonly PromptContribution[],
    initial: InitialPromptComposition = {},
    options: ComposePromptOptions = {},
): PromptCompositionDraft {
    const mainGroups = emptyMainContributionGroups()
    const negativeGroup: PromptContribution[] = []
    const characterGroups = new Map<EntityId, CharacterContributionGroup>()
    const initialCharacters = new Map(
        (initial.characters ?? []).map(character => [character.characterId, character]),
    )

    for (const contribution of contributions) {
        if (!contribution.enabled || contribution.deletedAt !== undefined) continue

        switch (contribution.target.kind) {
            case 'positive':
                mainGroups[toCanonicalMainSlot(contribution.target.slot)].push(contribution)
                break
            case 'negative':
                negativeGroup.push(contribution)
                break
            case 'character': {
                const characterId = contribution.target.characterId
                const group = characterGroups.get(characterId) ?? {
                    characterId,
                    positive: [],
                    negative: [],
                }
                group[contribution.target.polarity].push(contribution)
                characterGroups.set(characterId, group)
                break
            }
        }
    }

    const main = emptyMainPromptText()
    for (const slot of CANONICAL_MAIN_PROMPT_SLOT_ORDER) {
        main[slot] = mergeContributionGroup(mainGroups[slot], initial.main?.[slot] ?? '', options)
    }

    const characterIds = new Set([...initialCharacters.keys(), ...characterGroups.keys()])
    const characters = [...characterIds]
        .sort(compareStableText)
        .map(characterId => {
            const group = characterGroups.get(characterId)
            const initialCharacter = initialCharacters.get(characterId)
            return {
                characterId,
                positive: mergeContributionGroup(
                    group?.positive ?? [],
                    initialCharacter?.positive ?? '',
                    options,
                ),
                negative: mergeContributionGroup(
                    group?.negative ?? [],
                    initialCharacter?.negative ?? '',
                    options,
                ),
            }
        })

    return {
        main,
        negative: mergeContributionGroup(negativeGroup, initial.negative ?? '', options),
        characters,
    }
}

/**
 * Immutable text mapping boundary intended for a caller-owned wildcard resolver
 * or another text-only expansion step.
 */
export function mapPromptCompositionDraft(
    draft: PromptCompositionDraft,
    transform: (text: string, target: PromptDraftTarget) => string,
): PromptCompositionDraft {
    const main = emptyMainPromptText()
    for (const slot of CANONICAL_MAIN_PROMPT_SLOT_ORDER) {
        main[slot] = transform(draft.main[slot], { kind: 'positive', slot })
    }

    return {
        main,
        negative: transform(draft.negative, { kind: 'negative' }),
        characters: draft.characters.map(character => ({
            characterId: character.characterId,
            positive: transform(character.positive, {
                kind: 'character',
                characterId: character.characterId,
                polarity: 'positive',
            }),
            negative: transform(character.negative, {
                kind: 'character',
                characterId: character.characterId,
                polarity: 'negative',
            }),
        })),
    }
}

/** Async counterpart for caller-owned wildcard processors. */
export async function mapPromptCompositionDraftAsync(
    draft: PromptCompositionDraft,
    transform: (text: string, target: PromptDraftTarget) => string | Promise<string>,
): Promise<PromptCompositionDraft> {
    const main = emptyMainPromptText()
    for (const slot of CANONICAL_MAIN_PROMPT_SLOT_ORDER) {
        main[slot] = await transform(draft.main[slot], { kind: 'positive', slot })
    }

    const negative = await transform(draft.negative, { kind: 'negative' })
    const characters: CharacterPromptText[] = []
    for (const character of draft.characters) {
        characters.push({
            characterId: character.characterId,
            positive: await transform(character.positive, {
                kind: 'character',
                characterId: character.characterId,
                polarity: 'positive',
            }),
            negative: await transform(character.negative, {
                kind: 'character',
                characterId: character.characterId,
                polarity: 'negative',
            }),
        })
    }

    return { main, negative, characters }
}

/** Apply token dedupe after any caller-owned wildcard expansion. */
export function finalizePromptComposition(
    draft: PromptCompositionDraft,
    options: FinalizePromptOptions = {},
): FinalizedPromptComposition {
    const dedupePolicy = options.dedupe ?? 'exact-token'
    const positiveTokens = new Set<string>()
    const main = emptyMainPromptText()

    for (const slot of CANONICAL_MAIN_PROMPT_SLOT_ORDER) {
        main[slot] = finalizeText(draft.main[slot], dedupePolicy, positiveTokens)
    }

    const characters = [...draft.characters]
        .sort((left, right) => compareStableText(left.characterId, right.characterId))
        .map(character => ({
            characterId: character.characterId,
            // Each character and polarity owns an independent dedupe scope.
            positive: finalizeText(character.positive, dedupePolicy),
            negative: finalizeText(character.negative, dedupePolicy),
        }))

    return {
        main,
        positive: joinMainPrompt(main),
        negative: finalizeText(draft.negative, dedupePolicy),
        characters,
        dedupePolicy,
    }
}

export function normalizePromptContributions(
    contributions: readonly PromptContribution[],
    options: FinalizePromptOptions = {},
): FinalizedPromptComposition {
    return finalizePromptComposition(composePromptContributions(contributions), options)
}
