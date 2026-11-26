import { useShallow } from 'zustand/react/shallow'
import { ReactNode, useEffect, useRef, useState } from 'react'
import { registerNativeBackButton } from '@/platform/native-app'
import { Link, useLocation } from 'react-router'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { PromptPanel } from './PromptPanel'
import { HistoryPanel } from './HistoryPanel'
import { resolvePromptSurfaceReveal, useMediaQuery, usePromptSurface } from './prompt-surface'
import { isNavigationPathActive, NAVIGATION_ITEMS, type NavigationItem } from './navigation-items'
import { CommandPalette } from '@/components/command/CommandPalette'
import { LiveGenerationMonitor } from '@/components/queue/LiveGenerationMonitor'
import '@/styles/folder-workbench.css'
import '@/styles/workspace.css'
import { CustomTitleBar } from './CustomTitleBar'
import { PresetDropdown } from '@/components/preset/PresetDropdown'
import { PresetDraftControls } from '@/components/preset/PresetDraftControls'
import { DiagnosticDrawer } from '@/components/diagnostics/DiagnosticDrawer'
import { ProductGuidance } from '@/components/guidance/ProductGuidance'
import { openProductGuidance } from '@/services/guidance/diagnostic-guides'
import { useDiagnosticsStore } from '@/stores/diagnostics-store'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAuthStore } from '@/stores/auth-store'
import { useShortcutStore } from '@/stores/shortcut-store'
import { SHORTCUT_EVENTS } from '@/hooks/useShortcuts'
import { Tip } from '@/components/ui/tooltip'
import { toast } from '@/components/ui/use-toast'
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from '@/components/ui/sheet'
import {
    MyWorkActivity,
    MyWorkActivityRefreshOwner,
} from '@/presentation/activity/MyWorkActivity'
import {
    Images,
    PanelLeft,
    PanelRight,
    History,
    ChevronDown,
    Moon,
    Sun,
} from 'lucide-react'

interface ThreeColumnLayoutProps {
    children: ReactNode
}

import { usePresetStore } from '@/stores/preset-store'
import { useLayoutStore } from '@/stores/layout-store'
import { useGenerationStore } from '@/stores/generation-store'
import { useSceneStore } from '@/stores/scene-store'
import { useThemeStore } from '@/stores/theme-store'
import { isAndroidRuntime, isMobileRuntime } from '@/platform/runtime'

// Check if running on Mac (works in browser and Tauri WebView)
const isMac = navigator.platform.toUpperCase().includes('MAC') ||
    navigator.userAgent.toUpperCase().includes('MAC')

function WorkbenchThemeToggle() {
    const { t } = useTranslation()
    const theme = useThemeStore(state => state.theme)
    const setTheme = useThemeStore(state => state.setTheme)
    const systemDark = useMediaQuery('(prefers-color-scheme: dark)')
    // Match the existing theme owner, including live system changes; a click persists an explicit choice there.
    const isDark = theme === 'dark' || (theme === 'system' && systemDark)
    const Icon = isDark ? Sun : Moon

    return (
        <button
            type="button"
            onClick={() => setTheme(isDark ? 'light' : 'dark')}
            aria-label={isDark
                ? t('folderWorkbench.design.toLight', '밝은 화면으로 바꾸기')
                : t('folderWorkbench.design.toDark', '어두운 화면으로 바꾸기')}
            className="fb-theme-toggle ml-auto inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-control px-2 text-base font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-3"
        >
            <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
            <span>{isDark
                ? t('folderWorkbench.design.light', '밝게')
                : t('folderWorkbench.design.dark', '어둡게')}</span>
        </button>
    )
}

export function ThreeColumnLayout({ children }: ThreeColumnLayoutProps) {
    const { t } = useTranslation()
    const location = useLocation()
    const { anlas, isVerified, anlas2, isVerified2, slot2Enabled, refreshAnlas, setSlotEnabled, getActiveTokens, requestTokenEntry } = useAuthStore()
    const {
        leftSidebarVisible,
        supportSheet,
        toggleLeftSidebar,
        setLeftSidebarVisible,
        openSupportSheet,
        closeSupportSheet,
        dismissPromptSheet,
        requestPromptDialog,
    } = useLayoutStore()
    const isAtLeast640 = useMediaQuery('(min-width: 640px)')
    const promptSurface = usePromptSurface()
    const folderWorkbenchOpen = location.pathname === '/folders'
    const workbenchToolsRef = useRef<HTMLButtonElement>(null)
    const workspaceBodyRef = useRef<HTMLDivElement>(null)
    const [workspaceBodyTop, setWorkspaceBodyTop] = useState(0)
    const supportReturnFocusRef = useRef<HTMLElement | null>(null)
    // Menu items unmount before their sheet closes; return to Tools if the
    // original control no longer exists, while direct editor buttons retain focus.
    const rememberSupportFocus = () => {
        supportReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    }
    const restoreSupportFocus = (event: Event) => {
        event.preventDefault()
        const target = supportReturnFocusRef.current
        ;(target?.isConnected ? target : workbenchToolsRef.current)?.focus()
    }
    const isSceneRoute = promptSurface.isSceneRoute
    const promptSurfaceRoute = promptSurface.isAdvancedRoute
    const historyActionRoute = promptSurfaceRoute || isSceneRoute
    const promptPanelIsDocked = promptSurface.isDocked
    const leftSheetOpen = promptSurface.isSheetOpen
    const rightSheetOpen = supportSheet === 'history'
    const activitySheetOpen = supportSheet === 'activity'
    const mainIsGenerating = useGenerationStore(state => state.isGenerating)
    const sceneIsGenerating = useSceneStore(state => state.isGenerating)
    const isGenerating = mainIsGenerating || sceneIsGenerating

    // Measure the live workspace body offset so the tablet non-modal sheet stays below the
    // header regardless of Windows CustomTitleBar presence or 200% text scaling.
    useEffect(() => {
        const body = workspaceBodyRef.current
        if (!body) return
        const syncTop = () => {
            const top = Math.max(0, Math.round(body.getBoundingClientRect().top))
            setWorkspaceBodyTop(top)
        }
        syncTop()
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncTop)
        observer?.observe(body)
        window.addEventListener('resize', syncTop)
        return () => {
            observer?.disconnect()
            window.removeEventListener('resize', syncTop)
        }
    }, [])

    // Get active preset for header display
    const { presets, activePresetId } = usePresetStore(useShallow(state => ({ presets: state.presets, activePresetId: state.activePresetId })))
    const activePreset = presets.find(p => p.id === activePresetId)

    const handleSlotEnabled = async (slot: 1 | 2, enabled: boolean) => {
        try {
            await setSlotEnabled(slot, enabled)
        } catch {
            toast({
                title: t('credentialVault.errors.operation-failed'),
                variant: 'destructive',
            })
        }
    }

    // Preset dialog state (for shortcut support)
    const [presetDialogOpen, setPresetDialogOpen] = useState(false)
    const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)

    // Authoring dialog shortcuts only apply on /advanced and reveal the prompt surface first.
    useEffect(() => {
        const handleOpenPalette = () => setCommandPaletteOpen(true)
        window.addEventListener(SHORTCUT_EVENTS.OPEN_COMMAND_PALETTE, handleOpenPalette)
        return () => window.removeEventListener(SHORTCUT_EVENTS.OPEN_COMMAND_PALETTE, handleOpenPalette)
    }, [])

    useEffect(() => {
        if (!promptSurfaceRoute) return
        // Returns false when no prompt surface can mount, so the caller queues nothing that
        // would fire later on an unrelated sheet open.
        const revealPromptSurface = () => {
            const reveal = resolvePromptSurfaceReveal({ isDocked: promptPanelIsDocked, isSceneRoute, isGenerating })
            if (reveal === 'rail') setLeftSidebarVisible(true)
            else if (reveal === 'sheet') openSupportSheet('prompt')
            return reveal !== 'unavailable'
        }
        const handleOpenPreset = () => {
            if (revealPromptSurface()) setPresetDialogOpen(true)
        }
        const handleOpenPromptGen = () => {
            if (revealPromptSurface()) requestPromptDialog('promptGenerator')
        }
        const handleOpenFragment = () => {
            if (revealPromptSurface()) requestPromptDialog('fragment')
        }
        const handleOpenParameters = () => {
            if (revealPromptSurface()) requestPromptDialog('parameterSettings')
        }
        const handleOpenCharacterPrompt = () => {
            if (revealPromptSurface()) requestPromptDialog('characterPrompt')
        }
        const handleOpenImageReference = () => {
            if (revealPromptSurface()) requestPromptDialog('imageReference')
        }

        window.addEventListener(SHORTCUT_EVENTS.OPEN_PRESET_DIALOG, handleOpenPreset)
        window.addEventListener(SHORTCUT_EVENTS.OPEN_PROMPT_GENERATOR, handleOpenPromptGen)
        window.addEventListener(SHORTCUT_EVENTS.OPEN_FRAGMENT_DIALOG, handleOpenFragment)
        window.addEventListener(SHORTCUT_EVENTS.OPEN_PARAMETER_SETTINGS, handleOpenParameters)
        window.addEventListener(SHORTCUT_EVENTS.OPEN_CHARACTER_PROMPT, handleOpenCharacterPrompt)
        window.addEventListener(SHORTCUT_EVENTS.OPEN_IMAGE_REFERENCE, handleOpenImageReference)
        return () => {
            window.removeEventListener(SHORTCUT_EVENTS.OPEN_PRESET_DIALOG, handleOpenPreset)
            window.removeEventListener(SHORTCUT_EVENTS.OPEN_PROMPT_GENERATOR, handleOpenPromptGen)
            window.removeEventListener(SHORTCUT_EVENTS.OPEN_FRAGMENT_DIALOG, handleOpenFragment)
            window.removeEventListener(SHORTCUT_EVENTS.OPEN_PARAMETER_SETTINGS, handleOpenParameters)
            window.removeEventListener(SHORTCUT_EVENTS.OPEN_CHARACTER_PROMPT, handleOpenCharacterPrompt)
            window.removeEventListener(SHORTCUT_EVENTS.OPEN_IMAGE_REFERENCE, handleOpenImageReference)
        }
    }, [isGenerating, isSceneRoute, openSupportSheet, promptPanelIsDocked, promptSurfaceRoute, requestPromptDialog, setLeftSidebarVisible])

    useEffect(() => {
        if (!promptPanelIsDocked && leftSheetOpen && isGenerating) {
            dismissPromptSheet()
            setPresetDialogOpen(false)
        }
    }, [dismissPromptSheet, promptPanelIsDocked, leftSheetOpen, isGenerating])

    // Clear a stale sheet only when entering a Scene route: a metadata drop on a Scene view
    // requests the sheet before its /advanced navigation commits, and must not be wiped here.
    useEffect(() => {
        if (isSceneRoute && useLayoutStore.getState().supportSheet === 'prompt') {
            closeSupportSheet()
        }
    }, [closeSupportSheet, isSceneRoute])

    useEffect(() => {
        if (!promptPanelIsDocked || supportSheet !== 'prompt') return
        setLeftSidebarVisible(true)
        closeSupportSheet()
    }, [closeSupportSheet, promptPanelIsDocked, setLeftSidebarVisible, supportSheet])

    useEffect(() => {
        if (!isAndroidRuntime || (!leftSheetOpen && !rightSheetOpen && !activitySheetOpen)) return

        let disposed = false
        let unregister: (() => Promise<void>) | undefined

        // Tauri's Android app plugin owns the native Back dispatcher; registering only while a
        // support sheet is open lets Back close that sheet, then restores normal Activity behavior.
        void registerNativeBackButton(() => {
            closeSupportSheet()
        }).then((listener) => {
            if (disposed) void listener.unregister()
            else unregister = () => listener.unregister()
        })

        return () => {
            disposed = true
            if (unregister) void unregister()
        }
    }, [activitySheetOpen, closeSupportSheet, leftSheetOpen, rightSheetOpen])

    const activeTokens = getActiveTokens()
    const activeTokenBalances = activeTokens
        .map((entry) => ({
            ...entry,
            anlas: entry.slot === 2 ? anlas2 : anlas,
        }))
        .filter((entry) => Boolean(entry.anlas))

    // Refresh verified slots independently; slot 1 preserves B's original
    // balance behavior while slot 2 is opt-in for the dual-worker phase.
    useEffect(() => {
        if (isVerified) refreshAnlas(1)
        if (isVerified2) refreshAnlas(2)
    }, [isVerified, isVerified2, refreshAnlas])

    const isWideHeader = useMediaQuery('(min-width: 640px)')
    const shortcutBindings = useShortcutStore(state => state.bindings)
    const primaryNavItems = NAVIGATION_ITEMS.filter(item =>
        item.group === 'primary' && (isWideHeader || item.primaryOnMobile)
    )
    const mobilePrimaryOverflow = isWideHeader
        ? []
        : NAVIGATION_ITEMS.filter(item => item.group === 'primary' && !item.primaryOnMobile)
    const toolsAuthoringItems = NAVIGATION_ITEMS.filter(item => item.group === 'authoring')
    const toolsArchiveItems = NAVIGATION_ITEMS.filter(item => item.group === 'archive')
    const toolsDataItems = NAVIGATION_ITEMS.filter(item => item.group === 'data')
    const toolsSettingsItems = NAVIGATION_ITEMS.filter(item => item.group === 'settings')
    const allToolsMenuItems = [
        ...mobilePrimaryOverflow,
        ...toolsAuthoringItems,
        ...toolsArchiveItems,
        ...toolsDataItems,
        ...toolsSettingsItems,
    ]
    const activeToolsItem = allToolsMenuItems.find(item => isNavigationPathActive(location.pathname, item.path))
    const renderToolsNavItem = (item: NavigationItem) => {
        const shortcutLabel = item.shortcutAction ? shortcutBindings[item.shortcutAction]?.label : ''
        return (
            <DropdownMenuItem key={item.path} asChild className="min-h-11 rounded-[4px]">
                <Link
                    to={item.path}
                    aria-current={isNavigationPathActive(location.pathname, item.path) ? 'page' : undefined}
                    className="flex items-center"
                >
                    <item.icon className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 truncate">{t(item.labelKey, item.fallbackLabel)}</span>
                    {shortcutLabel && (
                        <kbd className="ml-auto pl-4 font-mono text-xs text-muted-foreground">{shortcutLabel}</kbd>
                    )}
                </Link>
            </DropdownMenuItem>
        )
    }

    // Format Anlas number
    const formatAnlas = (value: number) => {
        return value.toLocaleString()
    }

    const handleLeftPanelToggle = () => {
        rememberSupportFocus()
        if (promptPanelIsDocked) {
            toggleLeftSidebar()
        } else {
            openSupportSheet('prompt')
        }
    }

    // "Open" never collapses a visible rail: it reveals the prompt surface and lands in the editor.
    const handleOpenPrompt = () => {
        const reveal = resolvePromptSurfaceReveal({ isDocked: promptPanelIsDocked, isSceneRoute, isGenerating })
        // The compact sheet would close again at once while generating, dropping focus to the body.
        if (reveal === 'unavailable') return false
        rememberSupportFocus()
        if (reveal === 'sheet') {
            openSupportSheet('prompt')
            return true
        }
        setLeftSidebarVisible(true)
        let framesLeft = 10
        const focusPromptEditor = () => {
            const editor = document.querySelector<HTMLElement>('#nai-blue-prompt-dock [data-testid="prompt-editor-surface"] textarea')
            if (editor) editor.focus()
            else if (--framesLeft > 0) window.requestAnimationFrame(focusPromptEditor)
        }
        // A collapsed rail mounts PromptPanel on the next render, so the editor may need a few frames.
        window.requestAnimationFrame(focusPromptEditor)
        return true
    }

    const handleRightPanelToggle = () => {
        rememberSupportFocus()
        openSupportSheet('history')
    }

    const renderPromptPanelContent = (docked: boolean) => (
        <>
            <div className="flex min-h-14 flex-wrap items-center justify-between gap-2 px-3 py-2 sm:px-5">
                <div className="flex min-w-0 max-w-full items-center gap-1.5">
                    <h2
                        className="min-w-0 max-w-36 truncate text-base font-semibold 2xl:max-w-52"
                        title={activePreset?.name || t('preset.default', '기본')}
                    >
                        {activePreset?.name || t('preset.default', '기본')}
                    </h2>
                    <PresetDropdown open={presetDialogOpen} onOpenChange={setPresetDialogOpen} />
                    <PresetDraftControls />
                </div>

                {activeTokenBalances.length > 0 ? (
                    <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                        {activeTokenBalances.map((entry) => {
                            const isSlot2 = entry.slot === 2
                            return (
                                <Tip
                                    key={entry.slot}
                                    content={isSlot2
                                        ? t('settingsPage.api.clickToPause2')
                                        : t('settingsPage.api.clickToPause1')}
                                >
                                    <button
                                        type="button"
                                        onClick={() => void handleSlotEnabled(entry.slot, false)}
                                        className={cn(
                                            'flex min-h-11 min-w-0 items-center gap-2 rounded-control px-2 py-2 transition-colors duration-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card sm:px-3',
                                            isSlot2
                                                ? 'bg-primary/10 text-primary hover:bg-primary/20'
                                                : 'bg-warning/10 text-warning hover:bg-warning/20'
                                        )}
                                    >
                                        <span className="h-2 w-2 shrink-0 rounded-full bg-current" aria-hidden="true" />
                                        <span className="sr-only">{t('settingsPage.api.token')} {entry.slot}</span>
                                        <span className="min-w-0 truncate text-xs font-semibold sm:text-sm">
                                            {formatAnlas(entry.anlas!.total)}
                                        </span>
                                    </button>
                                </Tip>
                            )
                        })}
                        {isVerified2 && anlas2 && !slot2Enabled && (
                            <Tip content={t('settingsPage.api.clickToResume2')}>
                                <button
                                    type="button"
                                    onClick={() => void handleSlotEnabled(2, true)}
                                    className="flex min-h-11 min-w-0 items-center gap-2 rounded-control bg-muted px-2 py-2 text-muted-foreground transition-colors duration-standard hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card sm:px-3"
                                >
                                    <span className="h-2 w-2 shrink-0 rounded-full bg-current opacity-50" aria-hidden="true" />
                                    <span className="sr-only">{t('settingsPage.api.token')} 2</span>
                                    <span className="min-w-0 truncate text-xs font-semibold line-through sm:text-sm">
                                        {formatAnlas(anlas2.total)}
                                    </span>
                                </button>
                            </Tip>
                        )}
                    </div>
                ) : (
                    <button
                        type="button"
                        onClick={requestTokenEntry}
                        className="flex min-h-11 min-w-0 items-center gap-2 rounded-control bg-muted px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <span className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/50" aria-hidden="true" />
                        <span className="min-w-0 truncate text-sm text-muted-foreground">
                            {t('settingsPage.api.token')}
                        </span>
                    </button>
                )}
            </div>

            <PromptPanel docked={docked} />
        </>
    )

    return (
        <div
            className={cn(
                "workspace-shell flex h-screen flex-col overflow-hidden bg-background",
                folderWorkbenchOpen && "folder-workbench-shell",
                isAndroidRuntime && "android-landscape-safe-inline",
            )}
            style={isMobileRuntime ? {
                // Some Android WebViews report zero CSS safe-area insets despite edge-to-edge system bars.
                // Runtime fallbacks keep the shell clear of status/navigation controls while iOS keeps native insets.
                paddingTop: isAndroidRuntime
                    ? 'max(1.5rem, env(safe-area-inset-top))'
                    : 'env(safe-area-inset-top)',
                paddingBottom: isAndroidRuntime
                    ? 'max(3.5rem, env(safe-area-inset-bottom))'
                    : 'env(safe-area-inset-bottom)',
            } : undefined}
        >
            <MyWorkActivityRefreshOwner />
            {/* Custom Title Bar - Only show on Windows (Mac uses native decorations) */}
            {!isMac && !isMobileRuntime && <CustomTitleBar />}

            <header className="fb-app-header z-10 flex min-w-0 shrink-0 items-center gap-1 border-b border-border/45 bg-card px-2 py-2 sm:px-3 lg:pl-0">
                <div className="fb-app-brand hidden shrink-0 items-center text-lg font-semibold tracking-tight lg:flex lg:w-[232px] lg:px-5">
                    NAI <span className="ml-1 text-primary">Blue</span>
                </div>
                <nav
                    aria-label={t('folderWorkbench.navigation.label', '작업대 탐색')}
                    className="fb-app-navigation flex min-w-0 items-center gap-1"
                >
                    {primaryNavItems.map(item => {
                        const active = isNavigationPathActive(location.pathname, item.path)
                        const fullLabel = t(item.labelKey, item.fallbackLabel)
                        const compactLabel = item.compactLabelKey
                            ? t(item.compactLabelKey, item.compactFallbackLabel ?? fullLabel)
                            : fullLabel
                        const MobileIcon = item.path === '/folders' ? Images : item.path === '/queue' ? History : item.icon
                        // From 640px the four links give way with an ellipsis: a wide fallback font or a longer locale label must not push the
                        // last link under Tools. Below that the two compact links keep their width; a 2px shortfall there would cost letters.
                        return (
                            <Link
                                key={item.path}
                                to={item.path}
                                aria-current={active ? 'page' : undefined}
                                aria-label={fullLabel}
                                className="fb-app-nav-link inline-flex min-h-11 min-w-11 shrink-0 items-center sm:shrink justify-center whitespace-nowrap rounded-control px-2 text-base font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:px-3"
                            >
                                <span className="inline-flex min-w-0 items-center gap-2">
                                    <MobileIcon className="h-4 w-4 shrink-0 sm:hidden" aria-hidden="true" />
                                    <span className="truncate sm:hidden">{compactLabel}</span>
                                    <span className="hidden truncate sm:block">{fullLabel}</span>
                                </span>
                            </Link>
                        )
                    })}
                </nav>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button
                            ref={workbenchToolsRef}
                            data-active={activeToolsItem ? '' : undefined}
                            type="button"
                            // Off the Tools routes the button is the plain flex button it always was. On them the active route name sits in a
                            // grid track that may collapse to zero while min-content floors the button, so the name is the first header text
                            // to shorten. The shrink factor is huge on purpose: at 100:1 the links still lost a fraction of a pixel, and any
                            // shortfall turns their labels into ellipses. The grid is an inner span because the button was never a grid container.
                            className={cn(
                                'fb-app-tools inline-flex min-h-11 items-center rounded-control px-2 text-base font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:px-3',
                                activeToolsItem ? 'min-w-min shrink-[1000000]' : 'min-w-11 shrink-0 gap-1 sm:gap-1.5',
                            )}
                        >
                            {activeToolsItem ? (
                                <span className="grid min-w-0 grid-cols-[max-content_minmax(0,auto)_max-content] items-center">
                                    <span>{t('folderWorkbench.navigation.tools', '도구')}</span>
                                    <span className="max-w-[7rem] truncate sm:max-w-[8.5rem]">
                                        <span className="hidden pl-1 min-[440px]:inline">
                                            {'· '}
                                            {t(activeToolsItem.labelKey, activeToolsItem.fallbackLabel)}
                                        </span>
                                    </span>
                                    <ChevronDown className="ml-1 h-4 w-4 shrink-0 sm:ml-1.5" aria-hidden="true" />
                                </span>
                            ) : (
                                <>
                                    <span className="max-w-[9.5rem] truncate sm:max-w-[11rem]">{t('folderWorkbench.navigation.tools', '도구')}</span>
                                    <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
                                </>
                            )}
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                        align="end"
                        className="max-h-[var(--radix-dropdown-menu-content-available-height)] w-64 max-w-[calc(100vw-24px)] overflow-y-auto rounded-[4px]"
                        onCloseAutoFocus={(event) => {
                            // An item that opened a sheet or dialog already moved focus into it; returning
                            // focus to Tools would pull it back out and dismiss the non-modal prompt sheet.
                            const current = document.activeElement
                            if (current instanceof HTMLElement && current !== document.body
                                && !(event.currentTarget as Node | null)?.contains(current)) {
                                event.preventDefault()
                            }
                        }}
                    >
                        {mobilePrimaryOverflow.length > 0 && (
                            <>
                                <DropdownMenuGroup>
                                    <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
                                        {t('folderWorkbench.navigation.groups.primary', '생성')}
                                    </DropdownMenuLabel>
                                    {mobilePrimaryOverflow.map(renderToolsNavItem)}
                                </DropdownMenuGroup>
                                <DropdownMenuSeparator />
                            </>
                        )}
                        <DropdownMenuGroup>
                            <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
                                {t('folderWorkbench.navigation.groups.authoring', '제작 보조')}
                            </DropdownMenuLabel>
                            {toolsAuthoringItems.map(renderToolsNavItem)}
                        </DropdownMenuGroup>
                        <DropdownMenuSeparator />
                        <DropdownMenuGroup>
                            <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
                                {t('folderWorkbench.navigation.groups.archive', '보관')}
                            </DropdownMenuLabel>
                            {toolsArchiveItems.map(renderToolsNavItem)}
                        </DropdownMenuGroup>
                        <DropdownMenuSeparator />
                        <DropdownMenuGroup>
                            <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
                                {t('folderWorkbench.navigation.groups.data', '데이터')}
                            </DropdownMenuLabel>
                            {toolsDataItems.map(renderToolsNavItem)}
                        </DropdownMenuGroup>
                        <DropdownMenuSeparator />
                        <DropdownMenuGroup>
                            <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
                                {t('folderWorkbench.navigation.groups.panels', '패널')}
                            </DropdownMenuLabel>
                            {!isSceneRoute && (
                                <DropdownMenuItem className="min-h-11 rounded-[4px]" aria-controls={promptPanelIsDocked ? 'nai-blue-prompt-dock' : 'nai-blue-prompt-sheet'} onSelect={handleLeftPanelToggle}>
                                    {t('prompt.title', '프롬프트')}
                                </DropdownMenuItem>
                            )}
                            <DropdownMenuItem className="min-h-11 rounded-[4px]" aria-controls="nai-blue-history-sheet" onSelect={handleRightPanelToggle}>
                                {t('history.title', '기록')}
                            </DropdownMenuItem>
                            <DropdownMenuItem className="min-h-11 rounded-[4px]" data-testid="open-my-work-activity" onSelect={() => { rememberSupportFocus(); openSupportSheet('activity') }}>
                                {t('guided.activity.title', '내 작업')}
                            </DropdownMenuItem>
                            <DropdownMenuItem className="min-h-11 rounded-[4px]" onSelect={() => openProductGuidance()}>
                                {t('productGuidance.trigger')}
                            </DropdownMenuItem>
                            <DropdownMenuItem className="min-h-11 rounded-[4px]" onSelect={() => useDiagnosticsStore.getState().openDrawer()}>
                                {t('diagnosticDrawer.open')}
                            </DropdownMenuItem>
                        </DropdownMenuGroup>
                        <DropdownMenuSeparator />
                        {toolsSettingsItems.map(renderToolsNavItem)}
                        <DropdownMenuItem
                            className="flex min-h-11 items-center rounded-[4px]"
                            data-testid="open-command-palette"
                            onSelect={() => setCommandPaletteOpen(true)}
                        >
                            <span className="min-w-0 truncate">{t('folderWorkbench.navigation.commandPalette', '명령 찾기')}</span>
                            {shortcutBindings['open:commandPalette']?.label && (
                                <kbd className="ml-auto pl-4 font-mono text-xs text-muted-foreground">
                                    {shortcutBindings['open:commandPalette'].label}
                                </kbd>
                            )}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
                {historyActionRoute && <div className="workspace-editor-actions">
                    {promptSurfaceRoute && (
                        <button type="button" className="min-w-11 justify-center" onClick={handleLeftPanelToggle} aria-label={t('prompt.title', '프롬프트')}
                            aria-expanded={promptPanelIsDocked ? leftSidebarVisible : leftSheetOpen}
                            aria-controls={promptPanelIsDocked ? 'nai-blue-prompt-dock' : 'nai-blue-prompt-sheet'}>
                            <PanelLeft aria-hidden="true" /><span>{t('prompt.title', '프롬프트')}</span>
                        </button>
                    )}
                    <button type="button" className="min-w-11 justify-center" onClick={handleRightPanelToggle} aria-label={t('history.title', '기록')}
                        aria-expanded={rightSheetOpen} aria-controls="nai-blue-history-sheet">
                        <PanelRight aria-hidden="true" /><span>{t('history.title', '기록')}</span>
                    </button>
                </div>}
                <WorkbenchThemeToggle />
            </header>

            {/* Three opaque surface tones carry the workspace hierarchy; only form controls draw edges. */}
            <div ref={workspaceBodyRef} className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
                <aside
                    id="nai-blue-prompt-dock"
                    className={cn(
                        "hidden min-h-0 w-[360px] flex-shrink-0 flex-col overflow-hidden border-r border-border/60 bg-background min-[1200px]:flex 2xl:w-[420px] min-[1800px]:w-[500px]",
                        (!leftSidebarVisible || !promptPanelIsDocked) && "min-[1200px]:hidden"
                    )}
                >
                    {promptPanelIsDocked && leftSidebarVisible && renderPromptPanelContent(true)}
                </aside>

                <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
                    {/* Dialog owners stay mounted after their menu trigger closes. */}
                    <div className="[&>button]:hidden">
                        <ProductGuidance returnFocusRef={workbenchToolsRef} />
                        <CommandPalette
                open={commandPaletteOpen}
                onOpenChange={setCommandPaletteOpen}
                canOpenPrompt={!isSceneRoute}
                onOpenPrompt={handleOpenPrompt}
                onOpenHistory={handleRightPanelToggle}
                onOpenActivity={() => { rememberSupportFocus(); openSupportSheet('activity') }}
            />
            <DiagnosticDrawer />
                    </div>

                    {/* Page Content */}
                    <LiveGenerationMonitor />
                    <main className={cn(
                        "workspace-content relative min-h-0 min-w-0 flex-1",
                        ['/advanced', '/library', '/folders', '/settings', '/queue', '/data', '/trash'].includes(location.pathname) ? 'p-0 overflow-hidden' : 'workspace-content-inset overflow-y-auto'
                    )}>
                        {children}
                    </main>
                </div>

            </div>

            <Sheet
                modal={false}
                open={leftSheetOpen}
                onOpenChange={(open) => open ? openSupportSheet('prompt') : closeSupportSheet()}
            >
                <SheetContent
                    id="nai-blue-prompt-sheet"
                    data-shortcut-scope="workspace"
                    onCloseAutoFocus={restoreSupportFocus}
                    // Closing menus and dialogs hand focus back to controls outside this non-modal sheet;
                    // only Esc, the close button or a pointer press outside should dismiss it.
                    onFocusOutside={(event) => event.preventDefault()}
                    side="left"
                    showOverlay={false}
                    closeLabel={t('common.close', '닫기')}
                    className="flex !w-full !max-w-none flex-col gap-0 border-r border-border sm:!h-auto sm:!w-[420px] sm:!max-w-[min(70vw,720px)] sm:!min-w-[360px] sm:resize-x sm:overflow-auto"
                    style={isMobileRuntime ? {
                        paddingTop: 'max(1rem, env(safe-area-inset-top))',
                        paddingRight: 'max(1rem, env(safe-area-inset-right))',
                        paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
                        paddingLeft: 'max(1rem, env(safe-area-inset-left))',
                    } : isAtLeast640 && workspaceBodyTop > 0 ? {
                        top: `${workspaceBodyTop}px`,
                    } : undefined}
                >
                    <SheetHeader className="sr-only">
                        <SheetTitle>{t('prompt.title', '프롬프트')}</SheetTitle>
                    </SheetHeader>
                    {/* PromptPanel owns its header, so this reserve keeps that header clear of Sheet's close target. */}
                    <div className="flex min-h-0 flex-1 flex-col overflow-hidden [&>div:first-child]:pr-16">
                        {renderPromptPanelContent(false)}
                    </div>
                </SheetContent>
            </Sheet>

            <Sheet
                open={rightSheetOpen}
                onOpenChange={(open) => open ? openSupportSheet('history') : closeSupportSheet()}
            >
                <SheetContent
                    id="nai-blue-history-sheet"
                    onCloseAutoFocus={restoreSupportFocus}
                    side="right"
                    closeLabel={t('common.close', '닫기')}
                    className="flex !w-full !max-w-none flex-col gap-0 sm:!w-[400px] sm:!max-w-[400px]"
                    style={isMobileRuntime ? {
                        paddingTop: 'max(1rem, env(safe-area-inset-top))',
                        paddingRight: 'max(1rem, env(safe-area-inset-right))',
                        paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
                        paddingLeft: 'max(1rem, env(safe-area-inset-left))',
                    } : undefined}
                >
                    <SheetHeader className="sr-only">
                        <SheetTitle>{t('history.title', '기록')}</SheetTitle>
                    </SheetHeader>
                    <div className="min-h-0 flex-1 overflow-hidden [&>div>div:first-child]:pr-16">
                        {rightSheetOpen && <HistoryPanel />}
                    </div>
                </SheetContent>
            </Sheet>

            <Sheet
                open={activitySheetOpen}
                onOpenChange={(open) => open ? openSupportSheet('activity') : closeSupportSheet()}
            >
                <SheetContent
                    id="nai-blue-activity-sheet"
                    onCloseAutoFocus={restoreSupportFocus}
                    side="right"
                    closeLabel={t('common.close', '닫기')}
                    className="flex !w-full !max-w-none flex-col gap-0 sm:!w-[400px] sm:!max-w-[400px]"
                    style={isMobileRuntime ? {
                        paddingTop: 'max(1rem, env(safe-area-inset-top))',
                        paddingRight: 'max(1rem, env(safe-area-inset-right))',
                        paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
                        paddingLeft: 'max(1rem, env(safe-area-inset-left))',
                    } : undefined}
                >
                    <SheetHeader className="sr-only">
                        <SheetTitle>{t('guided.activity.title', '내 작업')}</SheetTitle>
                        <SheetDescription>
                            {t('guided.activity.description', '실행 중인 작업과 계정 상태')}
                        </SheetDescription>
                    </SheetHeader>
                    <div className="min-h-0 flex-1 overflow-hidden [&>div:first-child]:pr-16">
                        {activitySheetOpen && <MyWorkActivity headingIsDecorative />}
                    </div>
                </SheetContent>
            </Sheet>
        </div>
    )
}
