import { ReactNode, useEffect, useRef, useState } from 'react'
import { registerNativeBackButton } from '@/platform/native-app'
import { Link, useLocation } from 'react-router'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { PromptPanel } from './PromptPanel'
import { HistoryPanel } from './HistoryPanel'
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
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAuthStore } from '@/stores/auth-store'
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
    Home,
    Film,
    Globe,
    Images,
    Settings,
    Wand2,
    FlaskConical,
    Zap,
    PanelLeft,
    PanelRight,
    ListTodo,
    CloudUpload,
    Trash2,
    DatabaseZap,
    FolderTree,
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

function useMediaQuery(query: string) {
    const [matches, setMatches] = useState(() => window.matchMedia(query).matches)

    useEffect(() => {
        const mediaQuery = window.matchMedia(query)
        const syncMatches = () => setMatches(mediaQuery.matches)

        syncMatches()
        mediaQuery.addEventListener('change', syncMatches)
        return () => mediaQuery.removeEventListener('change', syncMatches)
    }, [query])

    return matches
}

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
    } = useLayoutStore()
    const isDesktopShell = useMediaQuery('(min-width: 1536px)')
    const folderWorkbenchOpen = location.pathname === '/folders'
    const workbenchToolsRef = useRef<HTMLButtonElement>(null)
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
    const editorOpen = location.pathname === '/advanced' || location.pathname === '/scenes' || location.pathname.startsWith('/scenes/')
    const promptPanelIsDocked = isDesktopShell && editorOpen
    const leftSheetOpen = supportSheet === 'prompt' && !promptPanelIsDocked
    const rightSheetOpen = supportSheet === 'history'
    const activitySheetOpen = supportSheet === 'activity'
    const mainIsGenerating = useGenerationStore(state => state.isGenerating)
    const sceneIsGenerating = useSceneStore(state => state.isGenerating)

    // Get active preset for header display
    const { presets, activePresetId } = usePresetStore()
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

    // 프리셋 다이얼로그 단축키 이벤트 수신
    useEffect(() => {
        const handleOpenPreset = () => setPresetDialogOpen(prev => !prev)

        window.addEventListener(SHORTCUT_EVENTS.OPEN_PRESET_DIALOG, handleOpenPreset)
        return () => {
            window.removeEventListener(SHORTCUT_EVENTS.OPEN_PRESET_DIALOG, handleOpenPreset)
        }
    }, [])

    useEffect(() => {
        if (!promptPanelIsDocked && leftSheetOpen && (mainIsGenerating || sceneIsGenerating)) {
            closeSupportSheet()
        }
    }, [closeSupportSheet, promptPanelIsDocked, leftSheetOpen, mainIsGenerating, sceneIsGenerating])

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

    const navItems = [
        { path: '/folders', icon: FolderTree, labelKey: 'folderWorkbench.title', fallbackLabel: '에셋 작업대' },
        { path: '/advanced', icon: Home, labelKey: 'nav.main' },
        { path: '/guided-preview', icon: Zap, labelKey: 'guided.home.choices', fallbackLabel: '작업 선택' },
        { path: '/scenes', icon: Film, labelKey: 'nav.scenes' },
        { path: '/tools', icon: Wand2, labelKey: 'smartTools.title' },
        { path: '/style-lab', icon: FlaskConical, labelKey: 'nav.styleLab' },
        { path: '/queue', icon: ListTodo, labelKey: 'nav.queue', fallbackLabel: 'Queue Center' },
        { path: '/r2', icon: CloudUpload, labelKey: 'nav.r2Upload', fallbackLabel: 'R2 Upload' },
        { path: '/trash', icon: Trash2, labelKey: 'nav.trash', fallbackLabel: '휴지통' },
        { path: '/data', icon: DatabaseZap, labelKey: 'nav.dataHub', fallbackLabel: '데이터 허브' },
        { path: '/web', icon: Globe, labelKey: 'nav.web' },
        { path: '/library', icon: Images, labelKey: 'nav.library' },
        { path: '/settings', icon: Settings, labelKey: 'nav.settings' },
    ]

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

    const handleRightPanelToggle = () => {
        rememberSupportFocus()
        openSupportSheet('history')
    }

    const promptPanelContent = (
        <>
            <div className="flex min-h-14 flex-wrap items-center justify-between gap-2 px-3 py-2 sm:px-5">
                <div className="flex min-w-0 items-center gap-2">
                    <h2 className="min-w-0 max-w-40 truncate text-base font-semibold">
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

            <PromptPanel />
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
                <div className="fb-app-brand hidden shrink-0 items-center px-5 text-lg font-semibold tracking-tight sm:flex lg:w-[232px]">
                    NAI <span className="ml-1 text-primary">Blue</span>
                </div>
                <nav
                    aria-label={t('folderWorkbench.navigation.label', '작업대 탐색')}
                    className="fb-app-navigation flex min-w-0 items-center gap-1"
                >
                <Link
                    to="/folders"
                    aria-current={folderWorkbenchOpen ? 'page' : undefined}
                    aria-label={t('folderWorkbench.design.navCreate', '이미지 만들기')}
                    className="fb-app-nav-link inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center whitespace-nowrap rounded-control px-2 text-base font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-3"
                >
                    <span className="inline-flex items-center gap-2">
                        <Images className="h-4 w-4 shrink-0 sm:hidden" aria-hidden="true" />
                        <span className="sm:hidden">{t('folderWorkbench.design.navCreateCompact', 'Create')}</span>
                        <span className="hidden sm:inline">{t('folderWorkbench.design.navCreate', '이미지 만들기')}</span>
                    </span>
                </Link>
                <Link
                    to="/queue"
                    aria-current={location.pathname === '/queue' ? 'page' : undefined}
                    aria-label={t('folderWorkbench.design.navHistory', '작업 기록')}
                    className="fb-app-nav-link inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center whitespace-nowrap rounded-control px-2 text-base font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-3"
                >
                    <span className="inline-flex items-center gap-2">
                        <History className="h-4 w-4 shrink-0 sm:hidden" aria-hidden="true" />
                        <span className="sm:hidden">{t('folderWorkbench.design.navHistoryCompact', 'History')}</span>
                        <span className="hidden sm:inline">{t('folderWorkbench.design.navHistory', '작업 기록')}</span>
                    </span>
                </Link>
                </nav>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button
                            ref={workbenchToolsRef}
                            data-active={!folderWorkbenchOpen && location.pathname !== '/queue' || undefined}
                            type="button"
                            className="fb-app-tools inline-flex min-h-11 shrink-0 items-center gap-1 rounded-control px-2 text-base font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:gap-2 sm:px-3"
                        >
                            {t('folderWorkbench.navigation.tools', '도구')}
                            <ChevronDown className="h-4 w-4" aria-hidden="true" />
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="max-h-[var(--radix-dropdown-menu-content-available-height)] w-60 max-w-[calc(100vw-24px)] overflow-y-auto rounded-[4px]">
                        {navItems.filter(item => item.path !== '/folders' && item.path !== '/queue').map(item => (
                            <DropdownMenuItem key={item.path} asChild className="min-h-11 rounded-[4px]">
                                <Link to={item.path} aria-current={location.pathname === item.path || location.pathname.startsWith(item.path + '/') ? 'page' : undefined}>
                                    <item.icon className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" />
                                    {t(item.labelKey, item.fallbackLabel ?? item.labelKey)}
                                </Link>
                            </DropdownMenuItem>
                        ))}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="min-h-11 rounded-[4px]" aria-controls={promptPanelIsDocked ? 'nai-blue-prompt-dock' : 'nai-blue-prompt-sheet'} onSelect={handleLeftPanelToggle}>
                            {t('prompt.title', '프롬프트')}
                        </DropdownMenuItem>
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
                    </DropdownMenuContent>
                </DropdownMenu>
                {editorOpen && <div className="workspace-editor-actions">
                    <button type="button" onClick={handleLeftPanelToggle} aria-label={t('prompt.title', '프롬프트')}
                        aria-expanded={promptPanelIsDocked ? leftSidebarVisible : leftSheetOpen}
                        aria-controls={promptPanelIsDocked ? 'nai-blue-prompt-dock' : 'nai-blue-prompt-sheet'}>
                        <PanelLeft aria-hidden="true" /><span>{t('prompt.title', '프롬프트')}</span>
                    </button>
                    <button type="button" onClick={handleRightPanelToggle} aria-label={t('history.title', '기록')}
                        aria-expanded={rightSheetOpen} aria-controls="nai-blue-history-sheet">
                        <PanelRight aria-hidden="true" /><span>{t('history.title', '기록')}</span>
                    </button>
                </div>}
                <WorkbenchThemeToggle />
            </header>

            {/* Three opaque surface tones carry the workspace hierarchy; only form controls draw edges. */}
            <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
                <aside
                    id="nai-blue-prompt-dock"
                    className={cn(
                        "hidden min-h-0 w-[420px] flex-shrink-0 flex-col overflow-hidden border-r border-border/60 bg-background 2xl:flex min-[1800px]:w-[500px]",
                        (!leftSidebarVisible || !promptPanelIsDocked) && "2xl:hidden"
                    )}
                >
                    {promptPanelIsDocked && leftSidebarVisible && promptPanelContent}
                </aside>

                <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
                    {/* Dialog owners stay mounted after their menu trigger closes. */}
                    <div className="[&>button]:hidden">
                        <ProductGuidance returnFocusRef={workbenchToolsRef} />
                        <DiagnosticDrawer />
                    </div>

                    {/* Page Content */}
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
                    onCloseAutoFocus={restoreSupportFocus}
                    side="left"
                    showOverlay={false}
                    closeLabel={t('common.close', '닫기')}
                    className="flex !w-full !max-w-none flex-col gap-0 border-r border-border sm:!w-[420px] sm:!max-w-[min(70vw,720px)] sm:!min-w-[360px] sm:resize-x sm:overflow-auto"
                    style={isMobileRuntime ? {
                        paddingTop: 'max(1rem, env(safe-area-inset-top))',
                        paddingRight: 'max(1rem, env(safe-area-inset-right))',
                        paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
                        paddingLeft: 'max(1rem, env(safe-area-inset-left))',
                    } : undefined}
                >
                    <SheetHeader className="sr-only">
                        <SheetTitle>{t('prompt.title', '프롬프트')}</SheetTitle>
                    </SheetHeader>
                    {/* PromptPanel owns its header, so this reserve keeps that header clear of Sheet's close target. */}
                    <div className="flex min-h-0 flex-1 flex-col overflow-hidden [&>div:first-child]:pr-16">
                        {promptPanelContent}
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
