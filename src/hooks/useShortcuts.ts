import { useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router'
import { useShortcutStore, matchesBinding, SHORTCUT_ACTIONS } from '@/stores/shortcut-store'
import { useFragmentStore } from '@/stores/fragment-store'
import { useGenerationStore } from '@/stores/generation-store'
import { supportsKeyboardShortcuts } from '@/platform/runtime'
import { executePromptGenerationCommand } from '@/services/generation/prompt-generation-command'
import { hasBlockingLayer, shouldSkipGlobalShortcut } from '@/lib/keyboard/shortcut-scope'
import { NAVIGATION_ROUTE_ORDER } from '@/components/layout/navigation-items'

// 커스텀 이벤트 (다이얼로그 및 화면별 주 동작용)
export const SHORTCUT_EVENTS = {
    OPEN_COMMAND_PALETTE: 'shortcut:openCommandPalette',
    OPEN_PROMPT_GENERATOR: 'shortcut:openPromptGenerator',
    OPEN_FRAGMENT_DIALOG: 'shortcut:openFragmentDialog',
    OPEN_PARAMETER_SETTINGS: 'shortcut:openParameterSettings',
    OPEN_IMAGE_REFERENCE: 'shortcut:openImageReference',
    OPEN_CHARACTER_PROMPT: 'shortcut:openCharacterPrompt',
    OPEN_PRESET_DIALOG: 'shortcut:openPresetDialog',
    GENERATE: 'shortcut:generate',
    RESET_FRAGMENT_COUNTERS: 'shortcut:resetFragmentCounters',
}

// 메뉴 순서 정의는 navigation-items.ts의 단일 원본을 따른다.
const MENU_ROUTES = NAVIGATION_ROUTE_ORDER

const DIRECT_NAVIGATION_ROUTES: Record<string, string> = {
    'navigate:folders': '/folders',
    'navigate:main': '/advanced',
    'navigate:scenes': '/scenes',
    'navigate:queue': '/queue',
    'navigate:tools': '/tools',
    'navigate:library': '/library',
    'navigate:web': '/web',
    'navigate:settings': '/settings',
}

/**
 * Depends on the browser's native focus model and runs before persisted app
 * shortcuts. Unmodified Tab/Shift+Tab always remain available to forms and
 * dialogs, including profiles saved before the accessible default migration.
 */
export function shouldPreserveNativeTabNavigation(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
    return event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey
}

export function useShortcuts() {
    const navigate = useNavigate()
    const location = useLocation()
    const { bindings, enabled } = useShortcutStore()
    const resetSequentialCounter = useFragmentStore(state => state.resetSequentialCounter)

    useEffect(() => {
        if (!supportsKeyboardShortcuts || !enabled) return

        const handleKeyDown = (e: KeyboardEvent) => {
            if (shouldPreserveNativeTabNavigation(e)) return

            for (const { action } of SHORTCUT_ACTIONS) {
                const binding = bindings[action]
                if (!binding) continue

                if (matchesBinding(e, binding)) {
                    if (shouldSkipGlobalShortcut(e, hasBlockingLayer(document))) return

                    if (action.startsWith('navigate:')) {
                        e.preventDefault()

                        if (action === 'navigate:next' || action === 'navigate:prev') {
                            const currentPath = location.pathname.startsWith('/scenes/')
                                ? '/scenes'
                                : location.pathname === '/'
                                    ? '/folders'
                                    : location.pathname
                            const currentIndex = MENU_ROUTES.indexOf(currentPath)
                            if (currentIndex === -1) return

                            const nextIndex = action === 'navigate:next'
                                ? (currentIndex + 1) % MENU_ROUTES.length
                                : (currentIndex - 1 + MENU_ROUTES.length) % MENU_ROUTES.length
                            navigate(MENU_ROUTES[nextIndex])
                            return
                        }

                        const targetRoute = DIRECT_NAVIGATION_ROUTES[action]
                        if (targetRoute) {
                            navigate(targetRoute)
                        }
                        return
                    }

                    if (action === 'open:commandPalette') {
                        e.preventDefault()
                        window.dispatchEvent(new CustomEvent(SHORTCUT_EVENTS.OPEN_COMMAND_PALETTE))
                        return
                    }

                    if (action === 'open:promptGenerator') {
                        e.preventDefault()
                        window.dispatchEvent(new CustomEvent(SHORTCUT_EVENTS.OPEN_PROMPT_GENERATOR))
                        return
                    }

                    if (action === 'open:fragmentDialog') {
                        e.preventDefault()
                        window.dispatchEvent(new CustomEvent(SHORTCUT_EVENTS.OPEN_FRAGMENT_DIALOG))
                        return
                    }

                    if (action === 'open:parameterSettings') {
                        e.preventDefault()
                        window.dispatchEvent(new CustomEvent(SHORTCUT_EVENTS.OPEN_PARAMETER_SETTINGS))
                        return
                    }

                    if (action === 'open:imageReference') {
                        e.preventDefault()
                        window.dispatchEvent(new CustomEvent(SHORTCUT_EVENTS.OPEN_IMAGE_REFERENCE))
                        return
                    }

                    if (action === 'open:characterPrompt') {
                        e.preventDefault()
                        window.dispatchEvent(new CustomEvent(SHORTCUT_EVENTS.OPEN_CHARACTER_PROMPT))
                        return
                    }

                    if (action === 'open:presetDialog') {
                        e.preventDefault()
                        window.dispatchEvent(new CustomEvent(SHORTCUT_EVENTS.OPEN_PRESET_DIALOG))
                        return
                    }

                    if (action === 'action:generate') {
                        if (location.pathname === '/advanced') {
                            e.preventDefault()
                            // Keyboard invocation shares the same conflict and
                            // cancellation policy as the Dock/Sheet action.
                            void executePromptGenerationCommand('main')
                            return
                        }
                        e.preventDefault()
                        window.dispatchEvent(new CustomEvent(SHORTCUT_EVENTS.GENERATE))
                        return
                    }

                    if (action === 'action:resetFragmentCounters') {
                        e.preventDefault()
                        // A running job may own a sequential-fragment lease; the
                        // shortcut must not invalidate its captured CAS revision.
                        if (useGenerationStore.getState().isGenerating) return
                        resetSequentialCounter()
                        window.dispatchEvent(new CustomEvent(SHORTCUT_EVENTS.RESET_FRAGMENT_COUNTERS))
                        return
                    }
                }
            }
        }

        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [bindings, enabled, navigate, location.pathname, resetSequentialCounter])
}
