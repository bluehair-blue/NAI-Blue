import { useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router'
import { useShortcutStore, matchesBinding, ShortcutAction } from '@/stores/shortcut-store'
import { useFragmentStore } from '@/stores/fragment-store'
import { useGenerationStore } from '@/stores/generation-store'
import { supportsKeyboardShortcuts } from '@/platform/runtime'
import { executePromptGenerationCommand } from '@/services/generation/prompt-generation-command'
import { hasBlockingLayer, shouldSkipGlobalShortcut } from '@/lib/keyboard/shortcut-scope'

// 커스텀 이벤트 (다이얼로그 열기용)
export const SHORTCUT_EVENTS = {
    OPEN_PROMPT_GENERATOR: 'shortcut:openPromptGenerator',
    OPEN_FRAGMENT_DIALOG: 'shortcut:openFragmentDialog',
    OPEN_PARAMETER_SETTINGS: 'shortcut:openParameterSettings',
    OPEN_IMAGE_REFERENCE: 'shortcut:openImageReference',
    OPEN_CHARACTER_PROMPT: 'shortcut:openCharacterPrompt',
    OPEN_PRESET_DIALOG: 'shortcut:openPresetDialog',
    RESET_FRAGMENT_COUNTERS: 'shortcut:resetFragmentCounters',
}

// 메뉴 순서 정의
// Keep keyboard navigation aligned with the primary rail so the Data Hub is
// reachable without pointer input while preserving the existing route order.
const MENU_ROUTES = ['/advanced', '/scenes', '/tools', '/queue', '/web', '/library', '/data', '/settings']

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

            // 각 바인딩 체크
            const actions: ShortcutAction[] = [
                'navigate:main',
                'navigate:scenes',
                'navigate:tools',
                'navigate:web',
                'navigate:library',
                'navigate:settings',
                'navigate:next',
                'navigate:prev',
                'open:promptGenerator',
                'open:fragmentDialog',
                'open:parameterSettings',
                'open:imageReference',
                'open:characterPrompt',
                'open:presetDialog',
                'action:generate',
                'action:resetFragmentCounters',
            ]

            for (const action of actions) {
                const binding = bindings[action]
                if (!binding) continue

                if (matchesBinding(e, binding)) {
                    if (shouldSkipGlobalShortcut(e, hasBlockingLayer(document))) return
                    // Modifier-based navigation remains available in inputs;
                    // unmodified Tab was already reserved above for focus traversal.
                    if (action.startsWith('navigate:')) {
                        e.preventDefault()

                        // 다음/이전 메뉴 이동
                        if (action === 'navigate:next' || action === 'navigate:prev') {
                            const currentPath = location.pathname.startsWith('/scenes/') ? '/scenes' : location.pathname
                            const currentIndex = MENU_ROUTES.indexOf(currentPath)
                            if (currentIndex === -1) return
                            
                            let nextIndex: number
                            if (action === 'navigate:next') {
                                nextIndex = (currentIndex + 1) % MENU_ROUTES.length
                            } else {
                                nextIndex = (currentIndex - 1 + MENU_ROUTES.length) % MENU_ROUTES.length
                            }
                            navigate(MENU_ROUTES[nextIndex])
                            return
                        }
                        
                        const routes: Record<string, string> = {
                            'navigate:main': '/advanced',
                            'navigate:scenes': '/scenes',
                            'navigate:tools': '/tools',
                            'navigate:web': '/web',
                            'navigate:library': '/library',
                            'navigate:settings': '/settings',
                        }
                        navigate(routes[action])
                        return
                    }

                    // 다이얼로그 열기
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

                    // 이미지 생성 (메인 모드에서만)
                    if (action === 'action:generate') {
                        if (location.pathname === '/advanced') {
                            e.preventDefault()
                            // Keyboard invocation shares the same conflict and
                            // cancellation policy as the Dock/Sheet action.
                            void executePromptGenerationCommand('main')
                            return
                        }
                    }

                    // 순차 카운터 리셋
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
