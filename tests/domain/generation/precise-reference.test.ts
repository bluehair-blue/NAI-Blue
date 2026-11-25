import { describe, expect, it } from 'vitest'

import {
    V4_PRECISE_REFERENCE_RULES,
    V5_PRECISE_REFERENCE_RULES,
    defaultPreferSameOutfit,
    preciseReferenceCaption,
    preciseReferenceWireCaption,
    supportsPreferSameOutfit,
} from '@/domain/generation/precise-reference'

describe('Precise Reference types and captions', () => {
    it('keeps the V4.5 captions when "Prefer same outfit" is left at NovelAI\'s default', () => {
        expect(preciseReferenceCaption('character')).toBe('character')
        expect(preciseReferenceCaption('style')).toBe('style')
        expect(preciseReferenceCaption('character&style')).toBe('character&style')
        expect(preciseReferenceCaption('character', defaultPreferSameOutfit('character'))).toBe('character')
        expect(preciseReferenceCaption('character&style', defaultPreferSameOutfit('character&style'))).toBe('character&style')
    })

    it('encodes the outfit type and the toggle as captions, never as extra fields', () => {
        expect(preciseReferenceCaption('outfit')).toBe('costume')
        expect(preciseReferenceCaption('character', true)).toBe('character_mainoutfit')
        expect(preciseReferenceCaption('character&style', false)).toBe('character&style_anyoutfit')
        // The toggle has no meaning on the other two types.
        expect(preciseReferenceCaption('style', true)).toBe('style')
        expect(preciseReferenceCaption('outfit', false)).toBe('costume')
        expect((['character', 'style', 'character&style', 'outfit'] as const).filter(supportsPreferSameOutfit))
            .toEqual(['character', 'character&style'])
    })

    it('falls back to the base caption on a model without the outfit controls', () => {
        for (const caption of ['character', 'character_mainoutfit', 'style', 'character&style', 'character&style_anyoutfit', 'costume']) {
            expect(preciseReferenceWireCaption(caption, V5_PRECISE_REFERENCE_RULES)).toBe(caption)
        }
        expect(preciseReferenceWireCaption('character_mainoutfit', V4_PRECISE_REFERENCE_RULES)).toBe('character')
        expect(preciseReferenceWireCaption('character&style_anyoutfit', V4_PRECISE_REFERENCE_RULES)).toBe('character&style')
        expect(preciseReferenceWireCaption('style', V4_PRECISE_REFERENCE_RULES)).toBe('style')
    })
})
