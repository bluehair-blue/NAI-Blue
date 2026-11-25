/** What a human or an agent picks for one Precise Reference. NovelAI's "Outfit" exists on V5 only. */
export const PRECISE_REFERENCE_TYPES = ['character', 'style', 'character&style', 'outfit'] as const
export type PreciseReferenceType = typeof PRECISE_REFERENCE_TYPES[number]

/**
 * NovelAI's director_reference base_caption, which is also how a reference travels through plans and hashes.
 * "Prefer same outfit" is not a separate request key: it switches the caption. The two outfit variants and
 * costume are V5 only.
 */
export const PRECISE_REFERENCE_CAPTIONS = [
    'character', 'character_mainoutfit', 'style', 'character&style', 'character&style_anyoutfit', 'costume',
] as const
export type PreciseReferenceCaption = typeof PRECISE_REFERENCE_CAPTIONS[number]

/** How one model generation treats Precise References; the model catalog assigns these. */
export interface PreciseReferenceRules {
    readonly strengthMax: number
    /** false: the model has no Fidelity control and the secondary strength is sent as 0. */
    readonly fidelity: boolean
    /** Outfit references and "Prefer same outfit". */
    readonly outfit: boolean
    readonly inpainting: boolean
    /** canvas: letterboxed onto one of three fixed sizes. bucket: cover-cropped to the nearest aspect bucket. */
    readonly imageFit: 'canvas' | 'bucket'
}

export const V4_PRECISE_REFERENCE_RULES: PreciseReferenceRules = Object.freeze({
    strengthMax: 1, fidelity: true, outfit: false, inpainting: true, imageFit: 'canvas',
})

export const V5_PRECISE_REFERENCE_RULES: PreciseReferenceRules = Object.freeze({
    strengthMax: 5, fidelity: false, outfit: true, inpainting: false, imageFit: 'bucket',
})

export const MAX_PRECISE_REFERENCE_STRENGTH = V5_PRECISE_REFERENCE_RULES.strengthMax

export function supportsPreferSameOutfit(type: PreciseReferenceType): boolean {
    return type === 'character' || type === 'character&style'
}

/** NovelAI's own defaults, which are also the only V4.5 behaviour: Character ignores the outfit, Character & Style keeps it. */
export function defaultPreferSameOutfit(type: PreciseReferenceType): boolean {
    return type === 'character&style'
}

export function preciseReferenceCaption(type: PreciseReferenceType, preferSameOutfit?: boolean): PreciseReferenceCaption {
    switch (type) {
        case 'outfit': return 'costume'
        case 'style': return 'style'
        case 'character': return preferSameOutfit === true ? 'character_mainoutfit' : 'character'
        case 'character&style': return preferSameOutfit === false ? 'character&style_anyoutfit' : 'character&style'
    }
}

/** A model without the outfit controls knows only the base captions, so the toggle falls back to that model's fixed behaviour. */
export function preciseReferenceWireCaption(caption: string, rules: PreciseReferenceRules): string {
    if (rules.outfit) return caption
    if (caption === 'character_mainoutfit') return 'character'
    return caption === 'character&style_anyoutfit' ? 'character&style' : caption
}
