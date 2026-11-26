import { useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router'
import { useShortcutStore, matchesBinding, SHORTCUT_ACTIONS, type ShortcutAction } from '@/stores/shortcut-store'
import { useFragmentStore } from '@/stores/fragment-store'
import { useGenerationStore } from '@/stores/generation-store'
import { supportsKeyboardShortcuts } from '@/platform/runtime'
import { executePromptGenerationCommand } from '@/services/generation/prompt-generation-command'
import { hasBlockingLayer, resolveGlobalShortcutDisposition } from '@/lib/keyboard/shortcut-scope'
import { getAdjacentNavigationRoute, NAVIGATION_SHORTCUT_ROUTES } from '@/components/layout/navigation-items'
import { runGuidedMainGeneration } from '@/components/prompt/main-generation-feedback'

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

const AUTHORING_DIALOG_EVENTS: Partial<Record<ShortcutAction, string>> = {
    'open:promptGenerator': SHORTCUT_EVENTS.OPEN_PROMPT_GENERATOR,
    'open:fragmentDialog': SHORTCUT_EVENTS.OPEN_FRAGMENT_DIALOG,
    'open:parameterSettings': SHORTCUT_EVENTS.OPEN_PARAMETER_SETTINGS,
    'open:imageReference': SHORTCUT_EVENTS.OPEN_IMAGE_REFERENCE,
    'open:characterPrompt': SHORTCUT_EVENTS.OPEN_CHARACTER_PROMPT,
    'open:presetDialog': SHORTCUT_EVENTS.OPEN_PRESET_DIALOG,
}

const PROMPT_SHEET_SELECTOR = '#nai-blue-prompt-sheet'
const SCENE_DETAIL_PATH = /^\/scenes\/[^/]+$/

/**
 * Depends on the browser's native focus model and runs before persisted app
 * shortcuts. Unmodified Tab/Shift+Tab always remain available to forms and
 * dialogs, including profiles saved before the accessible default migration.
 */
export function shouldPreserveNativeTabNavigation(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
    return event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey
}

/** Authoring dialog event a route listens for, or null when no listener is mounted there. */
function resolveAuthoringDialogEvent(action: ShortcutAction, pathname: string): string | null {
    const eventName = AUTHORING_DIALOG_EVENTS[action]
    if (!eventName) return null
    // ThreeColumnLayout listens on /advanced only; SceneDetail owns the fragment preview.
    if (pathname === '/advanced') return eventName
    if (action === 'open:fragmentDialog' && SCENE_DETAIL_PATH.test(pathname)) return eventName
    return null
}

function isInsidePromptSheet(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest(PROMPT_SHEET_SELECTOR) !== null
}

export function useShortcuts() {
    const navigate = useNavigate()
    const location = useLocation()
    const { bindings, enabled } = useShortcutStore()
    const resetSequentialCounter = useFragmentStore(state => state.resetSequentialCounter)

    useEffect(() => {
        if (!supportsKeyboardShortcuts || !enabled) return

        const findMatchedAction = (e: KeyboardEvent) =>
            SHORTCUT_ACTIONS.find(({ action }) => matchesBinding(e, bindings[action]))?.action

        // Radix Select/Menu items treat Ctrl+Enter as Enter and close before the event
        // bubbles to window, so the layer state is sampled at capture time as well.
        const layerOpenAtKeyDown = new WeakSet<KeyboardEvent>()
        const recordLayerAtKeyDown = (e: KeyboardEvent) => {
            if (findMatchedAction(e) && hasBlockingLayer(document)) layerOpenAtKeyDown.add(e)
        }

        const handleKeyDown = (e: KeyboardEvent) => {
            if (shouldPreserveNativeTabNavigation(e)) return

            const action = findMatchedAction(e)
            if (!action) return

            const blockingLayerOpen = layerOpenAtKeyDown.has(e) || hasBlockingLayer(document)
            const disposition = resolveGlobalShortcutDisposition(e, blockingLayerOpen)
            if (disposition === 'pass-through') return
            // App-owned keys never fall back to WebView defaults (find bar, print, reload),
            // even when the action itself does not run here.
            e.preventDefault()
            if (disposition === 'suppress') return

            if (action === 'navigate:next' || action === 'navigate:prev') {
                navigate(getAdjacentNavigationRoute(location.pathname, action === 'navigate:next' ? 'next' : 'prev'))
                return
            }

            const directRoute = NAVIGATION_SHORTCUT_ROUTES[action]
            if (directRoute) {
                navigate(directRoute)
                return
            }

            if (action === 'open:commandPalette') {
                window.dispatchEvent(new CustomEvent(SHORTCUT_EVENTS.OPEN_COMMAND_PALETTE))
                return
            }

            if (action in AUTHORING_DIALOG_EVENTS) {
                const eventName = resolveAuthoringDialogEvent(action, location.pathname)
                if (eventName) window.dispatchEvent(new CustomEvent(eventName))
                return
            }

            if (action === 'action:generate') {
                // The prompt sheet carries its own main-generation button off /advanced,
                // so a key typed inside it runs that command instead of the route action.
                if (location.pathname === '/advanced' || isInsidePromptSheet(e.target)) {
                    // Keyboard invocation shares the same conflict and
                    // cancellation policy and the same blocked-start guidance as the buttons.
                    runGuidedMainGeneration(() => executePromptGenerationCommand('main'), location.pathname)
                    return
                }
                window.dispatchEvent(new CustomEvent(SHORTCUT_EVENTS.GENERATE))
                return
            }

            if (action === 'action:resetFragmentCounters') {
                // A running job may own a sequential-fragment lease; the
                // shortcut must not invalidate its captured CAS revision.
                if (useGenerationStore.getState().isGenerating) return
                resetSequentialCounter()
                window.dispatchEvent(new CustomEvent(SHORTCUT_EVENTS.RESET_FRAGMENT_COUNTERS))
            }
        }

        window.addEventListener('keydown', recordLayerAtKeyDown, true)
        window.addEventListener('keydown', handleKeyDown)
        return () => {
            window.removeEventListener('keydown', recordLayerAtKeyDown, true)
            window.removeEventListener('keydown', handleKeyDown)
        }
    }, [bindings, enabled, navigate, location.pathname, resetSequentialCounter])
}
