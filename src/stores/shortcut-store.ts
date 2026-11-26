import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { indexedDBStorage } from '@/lib/indexed-db'

// 단축키 액션 타입
export type ShortcutAction =
    | 'navigate:folders'
    | 'navigate:main'
    | 'navigate:scenes'
    | 'navigate:queue'
    | 'navigate:tools'
    | 'navigate:library'
    | 'navigate:web'
    | 'navigate:settings'
    | 'navigate:next'
    | 'navigate:prev'
    | 'open:commandPalette'
    | 'open:promptGenerator'
    | 'open:fragmentDialog'
    | 'open:parameterSettings'
    | 'open:imageReference'
    | 'open:characterPrompt'
    | 'open:presetDialog'
    | 'action:generate'
    | 'action:resetFragmentCounters'

// 단축키 바인딩 인터페이스
export interface KeyBinding {
    key: string           // 실제 키 (예: '1', 'g', 'Enter')
    ctrl?: boolean        // Ctrl/Cmd 키
    shift?: boolean       // Shift 키
    alt?: boolean         // Alt 키
    label: string         // 표시 이름
    description: string   // 설명
}

// 기본 단축키 설정 (버전 1: 메뉴 순서에 맞춘 숫자 단축키 + 명령 찾기)
export const DEFAULT_BINDINGS: Record<ShortcutAction, KeyBinding> = {
    'navigate:folders': { key: '1', ctrl: true, label: 'Ctrl+1', description: 'shortcuts.actions.navigateFolders' },
    'navigate:main': { key: '2', ctrl: true, label: 'Ctrl+2', description: 'shortcuts.actions.navigateMain' },
    'navigate:scenes': { key: '3', ctrl: true, label: 'Ctrl+3', description: 'shortcuts.actions.navigateScenes' },
    'navigate:queue': { key: '4', ctrl: true, label: 'Ctrl+4', description: 'shortcuts.actions.navigateQueue' },
    'navigate:tools': { key: '5', ctrl: true, label: 'Ctrl+5', description: 'shortcuts.actions.navigateTools' },
    'navigate:library': { key: '6', ctrl: true, label: 'Ctrl+6', description: 'shortcuts.actions.navigateLibrary' },
    'navigate:web': { key: '7', ctrl: true, label: 'Ctrl+7', description: 'shortcuts.actions.navigateWeb' },
    'navigate:settings': { key: '8', ctrl: true, label: 'Ctrl+8', description: 'shortcuts.actions.navigateSettings' },
    'navigate:next': { key: 'PageDown', ctrl: true, label: 'Ctrl+PageDown', description: 'shortcuts.actions.navigateNext' },
    'navigate:prev': { key: 'PageUp', ctrl: true, label: 'Ctrl+PageUp', description: 'shortcuts.actions.navigatePrev' },
    'open:commandPalette': { key: 'k', ctrl: true, label: 'Ctrl+K', description: 'shortcuts.actions.commandPalette' },
    'open:promptGenerator': { key: 'g', ctrl: true, label: 'Ctrl+G', description: 'shortcuts.actions.promptGenerator' },
    'open:fragmentDialog': { key: 'f', ctrl: true, label: 'Ctrl+F', description: 'shortcuts.actions.fragmentDialog' },
    'open:parameterSettings': { key: 'p', ctrl: true, label: 'Ctrl+P', description: 'shortcuts.actions.parameterSettings' },
    'open:imageReference': { key: 'i', ctrl: true, label: 'Ctrl+I', description: 'shortcuts.actions.imageReference' },
    'open:characterPrompt': { key: 'd', ctrl: true, label: 'Ctrl+D', description: 'shortcuts.actions.characterPrompt' },
    'open:presetDialog': { key: '`', ctrl: true, label: 'Ctrl+`', description: 'shortcuts.actions.presetDialog' },
    'action:generate': { key: 'Enter', ctrl: true, label: 'Ctrl+Enter', description: 'shortcuts.actions.generate' },
    'action:resetFragmentCounters': { key: 'r', ctrl: true, shift: true, label: 'Ctrl+Shift+R', description: 'shortcuts.actions.resetFragmentCounters' },
}

// 버전 0(이전)의 숫자 기본값: 1회 이전 시 변경하지 않은 옛 기본값 판정에만 쓴다.
const LEGACY_V0_DEFAULT_BINDINGS: Partial<Record<ShortcutAction, Pick<KeyBinding, 'key' | 'ctrl' | 'shift' | 'alt'>>> = {
    'navigate:main': { key: '1', ctrl: true },
    'navigate:scenes': { key: '2', ctrl: true },
    'navigate:tools': { key: '3', ctrl: true },
    'navigate:web': { key: '4', ctrl: true },
    'navigate:library': { key: '5', ctrl: true },
    'navigate:settings': { key: '6', ctrl: true },
    'navigate:next': { key: 'Tab', ctrl: false, shift: false, alt: false },
    'navigate:prev': { key: 'Tab', ctrl: false, shift: true, alt: false },
}

export const SHORTCUT_STORE_VERSION = 1

export function getShortcutActionDescription(action: ShortcutAction): string {
    return DEFAULT_BINDINGS[action].description
}

function bindingSignature(binding: Pick<KeyBinding, 'key' | 'ctrl' | 'shift' | 'alt'>): string {
    return `${binding.ctrl ? 'C' : ''}${binding.shift ? 'S' : ''}${binding.alt ? 'A' : ''}:${binding.key.toLowerCase()}`
}

function sameBinding(
    a: Pick<KeyBinding, 'key' | 'ctrl' | 'shift' | 'alt'> | null | undefined,
    b: Pick<KeyBinding, 'key' | 'ctrl' | 'shift' | 'alt'> | null | undefined,
): boolean {
    if (!a || !b) return false
    return bindingSignature(a) === bindingSignature(b)
}

interface ShortcutState {
    bindings: Record<ShortcutAction, KeyBinding | null>
    enabled: boolean  // 전역 단축키 활성화/비활성화

    // Actions
    setBinding: (action: ShortcutAction, binding: KeyBinding | null) => void
    resetBinding: (action: ShortcutAction) => void
    resetAllBindings: () => void
    setEnabled: (enabled: boolean) => void
    getBindingLabel: (action: ShortcutAction) => string
}

// 키 조합을 문자열로 변환
export function formatKeyBinding(binding: KeyBinding | null | undefined): string {
    if (!binding) return ''
    const parts: string[] = []
    if (binding.ctrl) parts.push('Ctrl')
    if (binding.shift) parts.push('Shift')
    if (binding.alt) parts.push('Alt')

    // 특수 키 처리
    let keyDisplay = binding.key
    if (binding.key === 'Enter') keyDisplay = 'Enter'
    else if (binding.key === ' ') keyDisplay = 'Space'
    else if (binding.key === 'Escape') keyDisplay = 'Esc'
    else if (binding.shift && /^[!@#$%^&*()]$/.test(binding.key)) {
        // Shift+숫자 조합
        const shiftMap: Record<string, string> = {
            '!': '1', '@': '2', '#': '3', '$': '4', '%': '5',
            '^': '6', '&': '7', '*': '8', '(': '9', ')': '0'
        }
        keyDisplay = shiftMap[binding.key] || binding.key
    } else {
        keyDisplay = binding.key.toUpperCase()
    }

    parts.push(keyDisplay)
    return parts.join('+')
}

// 키 이벤트가 바인딩과 일치하는지 확인
export function matchesBinding(e: KeyboardEvent, binding: KeyBinding | null | undefined): boolean {
    if (!binding) return false
    const ctrlMatch = binding.ctrl ? (e.ctrlKey || e.metaKey) : !(e.ctrlKey || e.metaKey)
    const shiftMatch = binding.shift ? e.shiftKey : !e.shiftKey
    const altMatch = binding.alt ? e.altKey : !e.altKey
    const keyMatch = e.key === binding.key || e.key.toLowerCase() === binding.key.toLowerCase()

    return ctrlMatch && shiftMatch && altMatch && keyMatch
}

/**
 * One-time versioned migration from v0 to v1.
 * Upgrades untouched legacy defaults to the menu-ordered v1 defaults while
 * preserving every user-customized binding; any new default that collides with
 * a user-customized binding becomes null (unassigned).
 */
export function migrateShortcutState(persistedState: unknown, version: number): Partial<ShortcutState> {
    const persisted = (persistedState && typeof persistedState === 'object')
        ? (persistedState as Partial<ShortcutState>)
        : {}

    if (version >= SHORTCUT_STORE_VERSION) {
        return persisted
    }

    const oldBindings = persisted.bindings ?? ({} as Partial<Record<ShortcutAction, KeyBinding | null>>)
    const customizedActions = new Set<ShortcutAction>()
    const reservedSignatures = new Set<string>()

    for (const action of Object.keys(DEFAULT_BINDINGS) as ShortcutAction[]) {
        if (!Object.prototype.hasOwnProperty.call(oldBindings, action)) continue
        const existing = oldBindings[action]
        if (existing === null) {
            customizedActions.add(action)
            continue
        }
        if (!existing) continue

        // Unmodified Tab/Shift+Tab was an old accessibility bug — always upgrade.
        if ((action === 'navigate:next' || action === 'navigate:prev')
            && existing.key.toLowerCase() === 'tab' && !existing.ctrl && !existing.alt) {
            continue
        }

        const legacyDefault = LEGACY_V0_DEFAULT_BINDINGS[action]
        const currentDefault = DEFAULT_BINDINGS[action]
        const isUntouchedLegacy = legacyDefault ? sameBinding(existing, legacyDefault) : sameBinding(existing, currentDefault)
        if (!isUntouchedLegacy) {
            customizedActions.add(action)
            reservedSignatures.add(bindingSignature(existing))
        }
    }

    const nextBindings = {} as Record<ShortcutAction, KeyBinding | null>
    for (const action of Object.keys(DEFAULT_BINDINGS) as ShortcutAction[]) {
        if (customizedActions.has(action)) {
            nextBindings[action] = oldBindings[action] ?? null
            continue
        }
        const candidate = DEFAULT_BINDINGS[action]
        if (reservedSignatures.has(bindingSignature(candidate))) {
            nextBindings[action] = null
        } else {
            nextBindings[action] = { ...candidate }
        }
    }

    return {
        ...persisted,
        bindings: nextBindings,
    }
}

/**
 * Merges hydrated bindings without overwriting explicit null (unassigned) slots
 * or re-running the one-time v0->v1 default migration.
 */
function mergeAccessibleBindings(
    persistedBindings?: Partial<Record<ShortcutAction, KeyBinding | null>>,
): Record<ShortcutAction, KeyBinding | null> {
    const bindings = { ...DEFAULT_BINDINGS } as Record<ShortcutAction, KeyBinding | null>

    if (persistedBindings) {
        for (const action of Object.keys(DEFAULT_BINDINGS) as ShortcutAction[]) {
            if (Object.prototype.hasOwnProperty.call(persistedBindings, action)) {
                bindings[action] = persistedBindings[action] ?? null
            }
        }
    }

    for (const action of ['navigate:next', 'navigate:prev'] as const) {
        const binding = bindings[action]
        if (binding && binding.key.toLowerCase() === 'tab' && !binding.ctrl && !binding.alt) {
            bindings[action] = { ...DEFAULT_BINDINGS[action] }
        }
    }

    return bindings
}

export const useShortcutStore = create<ShortcutState>()(
    persist(
        (set, get) => ({
            bindings: { ...DEFAULT_BINDINGS },
            enabled: true,

            setBinding: (action, binding) => {
                set((state) => ({
                    bindings: {
                        ...state.bindings,
                        [action]: binding ? { ...binding, label: formatKeyBinding(binding) } : null,
                    }
                }))
            },

            resetBinding: (action) => {
                set((state) => ({
                    bindings: {
                        ...state.bindings,
                        [action]: { ...DEFAULT_BINDINGS[action] },
                    }
                }))
            },

            resetAllBindings: () => {
                set({ bindings: { ...DEFAULT_BINDINGS } })
            },

            setEnabled: (enabled) => {
                set({ enabled })
            },

            getBindingLabel: (action) => {
                return get().bindings[action]?.label || ''
            },
        }),
        {
            name: 'nai-blue-shortcuts',
            version: SHORTCUT_STORE_VERSION,
            storage: createJSONStorage(() => indexedDBStorage),
            migrate: migrateShortcutState,
            merge: (persistedState, currentState) => {
                const persisted = (persistedState ?? {}) as Partial<ShortcutState>
                return {
                    ...currentState,
                    ...persisted,
                    bindings: mergeAccessibleBindings(persisted.bindings),
                }
            },
        }
    )
)

// 액션 목록 (설정 UI용)
export const SHORTCUT_ACTIONS: { action: ShortcutAction; category: string }[] = [
    { action: 'navigate:folders', category: 'navigation' },
    { action: 'navigate:main', category: 'navigation' },
    { action: 'navigate:scenes', category: 'navigation' },
    { action: 'navigate:queue', category: 'navigation' },
    { action: 'navigate:tools', category: 'navigation' },
    { action: 'navigate:library', category: 'navigation' },
    { action: 'navigate:web', category: 'navigation' },
    { action: 'navigate:settings', category: 'navigation' },
    { action: 'navigate:next', category: 'navigation' },
    { action: 'navigate:prev', category: 'navigation' },
    { action: 'open:commandPalette', category: 'dialog' },
    { action: 'open:promptGenerator', category: 'dialog' },
    { action: 'open:fragmentDialog', category: 'dialog' },
    { action: 'open:parameterSettings', category: 'dialog' },
    { action: 'open:imageReference', category: 'dialog' },
    { action: 'open:characterPrompt', category: 'dialog' },
    { action: 'open:presetDialog', category: 'dialog' },
    { action: 'action:generate', category: 'action' },
    { action: 'action:resetFragmentCounters', category: 'action' },
]
