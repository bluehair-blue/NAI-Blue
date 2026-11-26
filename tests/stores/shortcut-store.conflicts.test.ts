import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/indexed-db', () => {
    const memory = new Map<string, string>()
    return {
        indexedDBStorage: {
            getItem: async (name: string) => memory.get(name) ?? null,
            setItem: async (name: string, value: string) => { memory.set(name, value) },
            removeItem: async (name: string) => { memory.delete(name) },
        },
    }
})

import {
    assignBindingExclusively,
    DEFAULT_BINDINGS,
    findConflictingActions,
    useShortcutStore,
    type KeyBinding,
    type ShortcutAction,
} from '@/stores/shortcut-store'

const chord = (key: string, ctrl = true): KeyBinding => ({ key, ctrl, label: '', description: '' })

function boundActions(bindings: Record<ShortcutAction, KeyBinding | null>, binding: KeyBinding): ShortcutAction[] {
    return (Object.keys(bindings) as ShortcutAction[]).filter(action => {
        const current = bindings[action]
        return current !== null
            && current.key.toLowerCase() === binding.key.toLowerCase()
            && !!current.ctrl === !!binding.ctrl
            && !!current.shift === !!binding.shift
            && !!current.alt === !!binding.alt
    })
}

describe('shortcut binding conflicts', () => {
    beforeEach(() => {
        useShortcutStore.getState().resetAllBindings()
    })

    it('finds other actions on the same chord, ignoring key case and the action itself', () => {
        const bindings = { ...DEFAULT_BINDINGS }
        expect(findConflictingActions(bindings, 'navigate:main', chord('K'))).toEqual(['open:commandPalette'])
        expect(findConflictingActions(bindings, 'open:commandPalette', chord('k'))).toEqual([])
        expect(findConflictingActions(bindings, 'navigate:main', chord('k', false))).toEqual([])
        expect(findConflictingActions(bindings, 'navigate:main', null)).toEqual([])
    })

    it('assignBindingExclusively leaves exactly one owner and unassigns the other', () => {
        const next = assignBindingExclusively({ ...DEFAULT_BINDINGS }, 'navigate:main', chord('k'))
        expect(next['navigate:main']?.key).toBe('k')
        expect(next['open:commandPalette']).toBeNull()
        expect(boundActions(next, chord('k'))).toEqual(['navigate:main'])
    })

    it('override (setBinding onto a taken chord) unassigns the previous owner', () => {
        useShortcutStore.getState().setBinding('navigate:main', chord('k'))
        const { bindings } = useShortcutStore.getState()
        expect(bindings['navigate:main']?.label).toBe('Ctrl+K')
        expect(bindings['open:commandPalette']).toBeNull()
        expect(boundActions(bindings, chord('k'))).toEqual(['navigate:main'])
    })

    it('row reset keeps the reset action and unassigns whoever took its default chord', () => {
        const store = useShortcutStore.getState()
        store.setBinding('navigate:main', chord('k'))
        // Command palette is now unassigned; another action takes Ctrl+2 (navigate:main's default).
        store.setBinding('navigate:settings', chord('2'))
        store.resetBinding('navigate:main')

        const { bindings } = useShortcutStore.getState()
        expect(bindings['navigate:main']?.label).toBe('Ctrl+2')
        expect(bindings['navigate:settings']).toBeNull()
        expect(boundActions(bindings, chord('2'))).toEqual(['navigate:main'])
    })

    it('row reset without a collision changes nothing else', () => {
        const store = useShortcutStore.getState()
        store.setBinding('navigate:main', chord('m'))
        store.resetBinding('navigate:main')
        expect(useShortcutStore.getState().bindings).toEqual({ ...DEFAULT_BINDINGS })
    })

    it('clearing a binding (null) never unassigns other actions', () => {
        useShortcutStore.getState().setBinding('navigate:main', null)
        const { bindings } = useShortcutStore.getState()
        expect(bindings['navigate:main']).toBeNull()
        expect(bindings['open:commandPalette']?.label).toBe('Ctrl+K')
    })
})
