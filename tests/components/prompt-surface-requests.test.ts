import { beforeEach, describe, expect, it, vi } from 'vitest'

// The layout store persists through IndexedDB, which the node test environment lacks.
vi.mock('@/lib/indexed-db', () => ({
    indexedDBStorage: {
        getItem: async () => null,
        setItem: async () => undefined,
        removeItem: async () => undefined,
    },
}))

const { useLayoutStore } = await import('@/stores/layout-store')
const { resolvePromptSurfaceReveal } = await import('@/components/layout/prompt-surface')

describe('prompt surface requests', () => {
    beforeEach(() => {
        useLayoutStore.setState({ supportSheet: null, pendingPromptDialog: null, pendingPromptFocus: null })
    })

    it('refuses the compact sheet while generating but keeps the docked rail available', () => {
        expect(resolvePromptSurfaceReveal({ isDocked: false, isSceneRoute: false, isGenerating: true })).toBe('unavailable')
        expect(resolvePromptSurfaceReveal({ isDocked: false, isSceneRoute: false, isGenerating: false })).toBe('sheet')
        expect(resolvePromptSurfaceReveal({ isDocked: true, isSceneRoute: false, isGenerating: true })).toBe('rail')
        expect(resolvePromptSurfaceReveal({ isDocked: false, isSceneRoute: true, isGenerating: false })).toBe('unavailable')
    })

    it('drops queued dialog and focus requests when the sheet is dismissed for generation', () => {
        const layout = useLayoutStore.getState()
        layout.openSupportSheet('prompt')
        layout.requestPromptDialog('parameterSettings')
        layout.requestPromptFocus('steps')

        useLayoutStore.getState().dismissPromptSheet()

        expect(useLayoutStore.getState()).toMatchObject({
            supportSheet: null,
            pendingPromptDialog: null,
            pendingPromptFocus: null,
        })
    })

    it('keeps queued requests when the sheet only hands off to the docked rail', () => {
        const layout = useLayoutStore.getState()
        layout.openSupportSheet('prompt')
        layout.requestPromptDialog('fragment')

        useLayoutStore.getState().closeSupportSheet()

        expect(useLayoutStore.getState().pendingPromptDialog).toBe('fragment')
    })
})
