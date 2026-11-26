import { describe, expect, it } from 'vitest'
import {
    DEFAULT_BINDINGS,
    formatKeyBinding,
    matchesBinding,
    migrateShortcutState,
    SHORTCUT_STORE_VERSION,
    type KeyBinding,
    type ShortcutAction,
} from '@/stores/shortcut-store'

describe('shortcut store v0 -> v1 migration', () => {
    it('migrates untouched v0 default bindings to the menu-ordered v1 defaults', () => {
        const legacyPersisted = {
            enabled: true,
            bindings: {
                'navigate:main': { key: '1', ctrl: true, label: 'Ctrl+1', description: 'shortcuts.actions.navigateMain' },
                'navigate:scenes': { key: '2', ctrl: true, label: 'Ctrl+2', description: 'shortcuts.actions.navigateScenes' },
                'navigate:tools': { key: '3', ctrl: true, label: 'Ctrl+3', description: 'shortcuts.actions.navigateTools' },
                'navigate:web': { key: '4', ctrl: true, label: 'Ctrl+4', description: 'shortcuts.actions.navigateWeb' },
                'navigate:library': { key: '5', ctrl: true, label: 'Ctrl+5', description: 'shortcuts.actions.navigateLibrary' },
                'navigate:settings': { key: '6', ctrl: true, label: 'Ctrl+6', description: 'shortcuts.actions.navigateSettings' },
                'action:generate': { key: 'Enter', ctrl: true, label: 'Ctrl+Enter', description: 'shortcuts.actions.generate' },
            },
        }

        const migrated = migrateShortcutState(legacyPersisted, 0)
        expect(migrated.bindings?.['navigate:folders']?.label).toBe('Ctrl+1')
        expect(migrated.bindings?.['navigate:main']?.label).toBe('Ctrl+2')
        expect(migrated.bindings?.['navigate:scenes']?.label).toBe('Ctrl+3')
        expect(migrated.bindings?.['navigate:queue']?.label).toBe('Ctrl+4')
        expect(migrated.bindings?.['navigate:tools']?.label).toBe('Ctrl+5')
        expect(migrated.bindings?.['navigate:library']?.label).toBe('Ctrl+6')
        expect(migrated.bindings?.['navigate:web']?.label).toBe('Ctrl+7')
        expect(migrated.bindings?.['navigate:settings']?.label).toBe('Ctrl+8')
        expect(migrated.bindings?.['open:commandPalette']?.label).toBe('Ctrl+K')
    })

    it('preserves user-customized bindings and leaves colliding new defaults unassigned (null)', () => {
        const customPromptGen: KeyBinding = {
            key: 'k',
            ctrl: true,
            label: 'Ctrl+K',
            description: 'shortcuts.actions.promptGenerator',
        }
        const customMain: KeyBinding = {
            key: 'm',
            ctrl: true,
            alt: true,
            label: 'Ctrl+Alt+M',
            description: 'shortcuts.actions.navigateMain',
        }
        const customSettings: KeyBinding = {
            key: '1',
            ctrl: true,
            label: 'Ctrl+1',
            description: 'shortcuts.actions.navigateSettings',
        }

        const migrated = migrateShortcutState({
            enabled: true,
            bindings: {
                'navigate:main': customMain,
                'navigate:settings': customSettings,
                'open:promptGenerator': customPromptGen,
                'navigate:scenes': { key: '2', ctrl: true, label: 'Ctrl+2', description: 'shortcuts.actions.navigateScenes' },
            },
        }, 0)

        // Custom values remain intact
        expect(migrated.bindings?.['open:promptGenerator']).toEqual(customPromptGen)
        expect(migrated.bindings?.['navigate:main']).toEqual(customMain)
        expect(migrated.bindings?.['navigate:settings']).toEqual(customSettings)

        // New defaults that collide with custom bindings become null
        expect(migrated.bindings?.['open:commandPalette']).toBeNull()
        expect(migrated.bindings?.['navigate:folders']).toBeNull()

        // Non-colliding legacy defaults still migrate
        expect(migrated.bindings?.['navigate:scenes']?.label).toBe('Ctrl+3')
        expect(migrated.bindings?.['navigate:queue']?.label).toBe('Ctrl+4')
    })

    it('does not re-run migration when persisted version is already v1', () => {
        const revertedToOldKey: Partial<Record<ShortcutAction, KeyBinding | null>> = {
            ...DEFAULT_BINDINGS,
            'navigate:main': { key: '1', ctrl: true, label: 'Ctrl+1', description: 'shortcuts.actions.navigateMain' },
            'navigate:folders': null,
        }

        const secondRun = migrateShortcutState({ enabled: true, bindings: revertedToOldKey }, SHORTCUT_STORE_VERSION)
        expect(secondRun.bindings?.['navigate:main']?.label).toBe('Ctrl+1')
        expect(secondRun.bindings?.['navigate:folders']).toBeNull()
    })

    it('handles null bindings safely in formatKeyBinding and matchesBinding', () => {
        expect(formatKeyBinding(null)).toBe('')
        const fakeEvent = { key: 'k', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false } as KeyboardEvent
        expect(matchesBinding(fakeEvent, null)).toBe(false)
        expect(matchesBinding(fakeEvent, DEFAULT_BINDINGS['open:commandPalette'])).toBe(true)
    })
})
