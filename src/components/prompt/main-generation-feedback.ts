import i18n from '@/i18n'
import { toast } from '@/components/ui/use-toast'
import { PROMPT_RAIL_MEDIA_QUERY } from '@/components/layout/prompt-surface'
import type { PromptGenerationCommandOutcome } from '@/services/generation/prompt-generation-command'
import { useGenerationStore } from '@/stores/generation-store'
import { useLayoutStore } from '@/stores/layout-store'

/**
 * Non-hook twin of usePromptSurface().ensureVisible for callers outside the
 * route tree (global shortcuts, command finder): rail at >=1200px on
 * /advanced, otherwise the prompt sheet; Scene routes have no Main prompt.
 */
export function revealMainPromptSurface(pathname: string): void {
    if (pathname === '/scenes' || pathname.startsWith('/scenes/')) return
    const layout = useLayoutStore.getState()
    const docked = pathname === '/advanced'
        && typeof window.matchMedia === 'function'
        && window.matchMedia(PROMPT_RAIL_MEDIA_QUERY).matches
    if (docked) layout.setLeftSidebarVisible(true)
    else layout.openSupportSheet('prompt')
}

/**
 * One response to a Main generation outcome for every entry point (rail
 * button, prompt panel button, Ctrl/Cmd+Enter, command finder), so a low-Steps
 * block always shows the Steps field and says why instead of doing nothing.
 */
export function guideMainGenerationOutcome(
    outcome: PromptGenerationCommandOutcome,
    revealPrompt: () => void,
): void {
    if (outcome !== 'low-quality-steps') return
    revealPrompt()
    useLayoutStore.getState().requestPromptFocus('steps')
    toast({
        title: i18n.t('generate.lowStepsBlockedTitle', 'Steps를 먼저 확인하세요'),
        description: i18n.t('generate.lowStepsDescription', '{{steps}} steps는 완성 전에 종료되어 흐린 결과가 나올 수 있습니다. 일반 생성은 28 steps를 권장합니다.', {
            steps: useGenerationStore.getState().steps,
        }),
        variant: 'destructive',
    })
}

export function reportMainGenerationFailure(error: unknown): void {
    toast({
        title: i18n.t('common.error', 'Error'),
        description: error instanceof Error ? error.message : i18n.t('queue.enqueueFailed', 'Queue enqueue failed'),
        variant: 'destructive',
    })
}

/** Runs a Main generation command from a keyboard or command-finder entry and guides its outcome. */
export function runGuidedMainGeneration(
    command: () => Promise<PromptGenerationCommandOutcome>,
    pathname: string,
): void {
    void command()
        .then(outcome => guideMainGenerationOutcome(outcome, () => revealMainPromptSurface(pathname)))
        .catch(reportMainGenerationFailure)
}
