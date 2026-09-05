import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'

import { createSingleImageDraft } from '@/domain/workflow/single-image-draft'

vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (_key: string, fallback: string) => fallback,
    }),
}))

vi.mock('@/hooks/useDefaultR2Readiness', () => ({
    useDefaultR2Readiness: () => ({
        status: 'unavailable',
        reason: 'profile',
        profile: null,
    }),
}))

vi.mock('@/components/generation-folders/GenerationFolderPicker', () => ({
    GenerationFolderPicker: () => null,
}))

import { GuidedDeliveryStep } from '@/presentation/workflow/GuidedMetadataPolicy'
import { GuidedOutputDestinationStep } from '@/presentation/workflow/GuidedOutputDestinationStep'

describe('Guided output workflow steps', () => {
    it.each(['unique', 'error', 'overwrite'] as const)('shows the saved %s collision policy without enabling overwrite', collisionPolicy => {
        const draft = createSingleImageDraft({
            id: 'draft:collision', now: '2026-09-05T00:00:00.000Z', seed: 42,
            output: { collisionPolicy },
        })
        const html = renderToStaticMarkup(createElement(GuidedOutputDestinationStep, {
            value: draft.payload.output, disabled: false, onChange: vi.fn(),
        }))
        expect(html).toMatch(new RegExp(`<option value="${collisionPolicy}"[^>]*selected=""`))
        expect(html).toContain('value="error"')
        if (collisionPolicy === 'overwrite') expect(html).toMatch(/<option value="overwrite"[^>]*disabled=""/)
        else expect(html).not.toContain('value="overwrite"')
    })

    it('disables automatic R2 upload and offers setup when no profile is ready', () => {
        const draft = createSingleImageDraft({
            id: 'draft:r2-unavailable',
            now: '2026-08-13T00:00:00.000Z',
            seed: 42,
            output: { metadataMode: 'strip-and-sidecar' },
        })
        const html = renderToStaticMarkup(createElement(
            MemoryRouter,
            null,
            createElement(GuidedDeliveryStep, {
                value: draft.payload.output,
                disabled: false,
                onChange: vi.fn(),
            }),
        ))

        expect(html).toContain('R2 설정과 API 키가 준비되어야 선택할 수 있어요.')
        expect(html).toContain('href="/guided-preview/task/library/r2"')
        expect(html).toMatch(/role="checkbox"[^>]*disabled=""/)
    })
})
