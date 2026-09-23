import { describe, expect, it, vi } from 'vitest'

const persistence = vi.hoisted(() => ({
    value: null as string | null,
    writes: [] as string[],
}))

vi.mock('@/lib/indexed-db', () => ({
    indexedDBStorage: {
        getItem: async (name: string) => name === 'nai-blue-generation' ? persistence.value : null,
        setItem: async (_name: string, value: string) => { persistence.writes.push(value) },
        removeItem: async () => undefined,
    },
}))

vi.mock('@/i18n', () => ({
    default: { t: (key: string) => key },
}))

vi.mock('@/lib/toast', () => ({
    toast: () => undefined,
}))

describe('Main composition mode persistence', () => {
    it.each(['legacy', 'shadow', 'v2', 'unknown', undefined] as const)(
        'normalizes a persisted %s request and excludes the rollout mode from future writes',
        async persistedMode => {
            persistence.value = JSON.stringify({
                state: {
                    compositionMode: persistedMode, selectedRecipeId: 'saved-recipe',
                    basePrompt: 'saved base', negativePrompt: 'saved negative',
                    seed: 12345, batchCount: 3, model: 'nai-diffusion-4-5-full',
                },
                version: 0,
            })
            persistence.writes = []

            vi.resetModules()
            const { useGenerationStore } = await import('@/stores/generation-store')
            await useGenerationStore.persist.rehydrate()

            expect(useGenerationStore.getState().compositionMode).toBe('v2')
            expect(useGenerationStore.getState()).toMatchObject({
                selectedRecipeId: 'saved-recipe', basePrompt: 'saved base', negativePrompt: 'saved negative',
                seed: 12345, batchCount: 3, model: 'nai-diffusion-4-5-full',
            })

            useGenerationStore.getState().setSelectedRecipeId(null)
            const persisted = persistence.writes.at(-1)
            expect(persisted).toBeDefined()
            expect(JSON.parse(persisted ?? '{}').state).not.toHaveProperty('compositionMode')
        },
    )

    it('invalidates resolved diagnostics when Main generation inputs change', async () => {
        persistence.value = null
        persistence.writes = []

        vi.resetModules()
        const { useGenerationStore } = await import('@/stores/generation-store')

        const seedResolvedState = () => useGenerationStore.setState({
            lastResolvedPlan: {} as never,
            compositionWarnings: [{} as never],
            compositionErrors: [{} as never],
            compositionShadowDiff: {} as never,
        })
        const expectUnresolved = () => expect(useGenerationStore.getState()).toMatchObject({
            lastResolvedPlan: null,
            compositionWarnings: [],
            compositionErrors: [],
            compositionShadowDiff: null,
        })
        const actions = [
            () => useGenerationStore.getState().setBasePrompt('updated prompt'),
            () => useGenerationStore.getState().setSteps(32),
            () => useGenerationStore.getState().setSelectedResolution({ label: 'Square', width: 1024, height: 1024 }),
            () => useGenerationStore.getState().setSourceImage('data:image/png;base64,synthetic'),
        ]

        for (const action of actions) {
            seedResolvedState()
            action()
            expectUnresolved()
        }
    })

    it('preserves a V4.5 Variety+ choice while switching through V5', async () => {
        persistence.value = null
        persistence.writes = []

        vi.resetModules()
        const { useGenerationStore } = await import('@/stores/generation-store')
        useGenerationStore.setState({
            model: 'nai-diffusion-4-5-full',
            variety: true,
        })

        useGenerationStore.getState().setModel('nai-diffusion-5-full')
        expect(useGenerationStore.getState()).toMatchObject({
            model: 'nai-diffusion-5-full',
            variety: true,
        })

        useGenerationStore.getState().setModel('nai-diffusion-4-5-full')
        expect(useGenerationStore.getState().variety).toBe(true)
    })

    it('keeps a latent Variety+ choice when a V5 draft is rehydrated', async () => {
        persistence.value = JSON.stringify({
            state: {
                model: 'nai-diffusion-5-full',
                variety: true,
                scheduler: 'karras',
            },
            version: 0,
        })
        persistence.writes = []

        vi.resetModules()
        const { useGenerationStore } = await import('@/stores/generation-store')
        await useGenerationStore.persist.rehydrate()

        expect(useGenerationStore.getState()).toMatchObject({
            model: 'nai-diffusion-5-full',
            variety: true,
        })
    })
})
