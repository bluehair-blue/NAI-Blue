import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import en from '../../src/i18n/locales/en.json'
import ja from '../../src/i18n/locales/ja.json'
import ko from '../../src/i18n/locales/ko.json'

function leafKeys(value: unknown, prefix = ''): string[] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix]
    return Object.entries(value as Record<string, unknown>)
        .flatMap(([key, child]) => leafKeys(child, prefix ? `${prefix}.${key}` : key))
        .sort()
}

describe('Phase 13 product guidance UI contract', () => {
    it('keeps guidance and token assessment keys identical in ko/en/ja', () => {
        expect(leafKeys(ko.productGuidance)).toEqual(leafKeys(en.productGuidance))
        expect(leafKeys(ja.productGuidance)).toEqual(leafKeys(en.productGuidance))
        expect(leafKeys(ko.tokenAssessment)).toEqual(leafKeys(en.tokenAssessment))
        expect(leafKeys(ja.tokenAssessment)).toEqual(leafKeys(en.tokenAssessment))
    })

    it('provides keyboard, touch, focus restore, reduced motion, and responsive sheet contracts', async () => {
        const source = await readFile(resolve(process.cwd(), 'src/components/guidance/ProductGuidance.tsx'), 'utf8')
        expect(source).toContain('type="button"')
        expect(source).toContain('h-11 w-11')
        expect(source).toContain('focus-visible:ring-2')
        expect(source).toContain('aria-controls="product-guidance-sheet"')
        expect(source).toContain("side={isMobileRuntime ? 'bottom' : 'right'}")
        expect(source).toContain('returnFocusRef={returnFocusRef ?? triggerRef}')
        expect(source).toContain('motion-reduce:transition-none')
        expect(source).toContain('<details')
        expect(source).toContain('id="advanced"')
        expect(source).not.toMatch(/[가-힣]/)
    })

    it('exposes token confidence and section details without a hover-only affordance', async () => {
        const source = await readFile(resolve(process.cwd(), 'src/components/guidance/PromptLengthAssessment.tsx'), 'utf8')
        expect(source).toContain('classifications.${assessment.classification}')
        expect(source).toContain('aria-describedby={descriptionId}')
        expect(source).toContain('min-h-11')
        expect(source).toContain('<details')
        expect(source).not.toContain('group-hover')
        expect(source).not.toMatch(/[가-힣]/)
    })

    it('links DiagnosticCode to guidance without translating the identifier', async () => {
        const source = await readFile(resolve(process.cwd(), 'src/components/diagnostics/DiagnosticDrawer.tsx'), 'utf8')
        expect(source).toContain('openProductGuidance(selectedEvent.code)')
        expect(source).toContain('aria-describedby={`diagnostic-code-${selectedEvent.eventId}`}')
    })
})
