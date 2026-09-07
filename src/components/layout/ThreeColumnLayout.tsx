import { ReactNode, useEffect, useRef, useState } from 'react'
import { registerNativeBackButton } from '@/platform/native-app'
import { Link, useLocation } from 'react-router'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { PromptPanel } from './PromptPanel'
import { HistoryPanel } from './HistoryPanel'
import { AnimatedNavBar } from './AnimatedNavBar'
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
    BriefcaseBusiness,
    FolderTree,
    ChevronDown,
} from 'lucide-react'

interface ThreeColumnLayoutProps {
    children: ReactNode
}

import { usePresetStore } from '@/stores/preset-store'
import { useLayoutStore } from '@/stores/layout-store'
import { useGenerationStore } from '@/stores/generation-store'
import { useSceneStore } from '@/stores/scene-store'
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

export function ThreeColumnLayout({ children }: ThreeColumnLayoutProps) {
    const { t } = useTranslation()
    const location = useLocation()
    const { anlas, isVerified, anlas2, isVerified2, slot2Enabled, refreshAnlas, setSlotEnabled, getActiveTokens, requestTokenEntry } = useAuthStore()
    const {
        leftSidebarVisible,
        rightSidebarVisible,
        supportSheet,
        toggleLeftSidebar,
        toggleRightSidebar,
        setLeftSidebarVisible,
        openSupportSheet,
        closeSupportSheet,
    } = useLayoutStore()
    const isDesktopShell = useMediaQuery('(min-width: 1536px)')
    const folderWorkbenchOpen = location.pathname === '/folders'
    const workbenchToolsRef = useRef<HTMLButtonElement>(null)
    const leftSheetOpen = supportSheet === 'prompt' && (!isDesktopShell || folderWorkbenchOpen)
    const rightSheetOpen = supportSheet === 'history'
    const activitySheetOpen = supportSheet === 'activity'
    const compositionWorkspaceOwnsRails = location.pathname === '/advanced'
        || location.pathname === '/folders'
        || location.pathname === '/scenes'
        || location.pathname.startsWith('/scenes/')
    const promptPanelIsDocked = isDesktopShell && !folderWorkbenchOpen
    const historyPanelIsDocked = isDesktopShell && !compositionWorkspaceOwnsRails
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
        if (promptPanelIsDocked) {
            toggleLeftSidebar()
        } else {
            openSupportSheet('prompt')
        }
    }

    const handleRightPanelToggle = () => {
        if (historyPanelIsDocked) {
            toggleRightSidebar()
        } else {
            openSupportSheet('history')
        }
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
                "flex h-screen flex-col overflow-hidden bg-background",
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

            {/* Three opaque surface tones carry the workspace hierarchy; only form controls draw edges. */}
            <div className={cn('flex min-w-0 flex-1 overflow-hidden', folderWorkbenchOpen ? 'gap-0' : 'gap-3 p-3')}>
                <aside
                    id="nai-blue-prompt-dock"
                    className={cn(
                        "hidden min-h-0 w-[420px] flex-shrink-0 flex-col overflow-hidden border-y border-border/45 bg-card/80 2xl:flex min-[1800px]:w-[500px]",
                        (!leftSidebarVisible || folderWorkbenchOpen) && "2xl:hidden"
                    )}
                >
                    {!folderWorkbenchOpen && promptPanelContent}
                </aside>

                <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-y border-border/45 bg-canvas">
                    {/* The workbench names the two primary tasks; secondary routes reuse the existing navigation and support-sheet authorities. */}
                    {folderWorkbenchOpen ? (
                        <nav
                            aria-label={t('folderWorkbench.navigation.label', '작업대 탐색')}
                            className="z-10 flex min-w-0 shrink-0 flex-wrap items-center gap-1 border-b border-border/45 bg-card px-3 py-2"
                        >
                            <Link
                                to="/folders"
                                aria-current="page"
                                className="inline-flex min-h-11 items-center rounded-[4px] bg-primary/10 px-3 text-sm font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                                {t('folderWorkbench.navigation.create', '에셋 만들기')}
                            </Link>
                            <Link
                                to="/queue"
                                className="inline-flex min-h-11 items-center rounded-[4px] px-3 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                                {t('folderWorkbench.navigation.progress', '진행 상황')}
                            </Link>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <button
                                        ref={workbenchToolsRef}
                                        type="button"
                                        className="inline-flex min-h-11 items-center gap-2 rounded-[4px] px-3 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    >
                                        {t('folderWorkbench.navigation.tools', '도구')}
                                        <ChevronDown className="h-4 w-4" aria-hidden="true" />
                                    </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="max-h-[var(--radix-dropdown-menu-content-available-height)] w-60 max-w-[calc(100vw-24px)] overflow-y-auto rounded-[4px]">
                                    {navItems.filter(item => item.path !== '/folders' && item.path !== '/queue').map(item => (
                                        <DropdownMenuItem key={item.path} asChild className="min-h-11 rounded-[4px]">
                                            <Link to={item.path}>
                                                <item.icon className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" />
                                                {t(item.labelKey, item.fallbackLabel ?? item.labelKey)}
                                            </Link>
                                        </DropdownMenuItem>
                                    ))}
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem className="min-h-11 rounded-[4px]" onSelect={handleLeftPanelToggle}>
                                        {t('prompt.title', '프롬프트')}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem className="min-h-11 rounded-[4px]" onSelect={handleRightPanelToggle}>
                                        {t('history.title', '기록')}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem className="min-h-11 rounded-[4px]" data-testid="open-my-work-activity" onSelect={() => openSupportSheet('activity')}>
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
                        </nav>
                    ) : (
                    /* Utility dialogs wrap below the legacy navigation on other routes. */
                    <div className="z-10 flex shrink-0 flex-wrap items-center gap-2 bg-card px-3 py-2 sm:flex-nowrap">
                        <Tip content={t('layout.toggleLeftSidebar', 'Toggle Left Sidebar')}>
                            <button
                                type="button"
                                onClick={handleLeftPanelToggle}
                                className={cn(
                                    "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-control transition-colors duration-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
                                    "text-muted-foreground hover:bg-accent hover:text-foreground",
                                    promptPanelIsDocked && !leftSidebarVisible && "opacity-50"
                                )}
                                aria-label={t('layout.toggleLeftSidebar', 'Toggle Left Sidebar')}
                                aria-expanded={promptPanelIsDocked ? leftSidebarVisible : leftSheetOpen}
                                aria-controls={promptPanelIsDocked ? 'nai-blue-prompt-dock' : 'nai-blue-prompt-sheet'}
                            >
                                <PanelLeft className="h-4 w-4" aria-hidden="true" />
                            </button>
                        </Tip>
                        <div className="flex min-w-0 flex-1 items-center">
                            {/* Both 2xl docks reduce the center header below the icon-row
                                width. The nav depends on those dock projections and moves
                                secondary routes into More so neither panel toggle overlaps. */}
                            <AnimatedNavBar
                                items={navItems}
                                forceCondensed={isDesktopShell
                                    && leftSidebarVisible
                                    && historyPanelIsDocked
                                    && rightSidebarVisible}
                            />
                        </div>
                        <Tip content={t('layout.toggleRightSidebar', 'Toggle Right Sidebar')}>
                            <button
                                type="button"
                                onClick={handleRightPanelToggle}
                                className={cn(
                                    "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-control transition-colors duration-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
                                    "text-muted-foreground hover:bg-accent hover:text-foreground",
                                    historyPanelIsDocked && !rightSidebarVisible && "opacity-50"
                                )}
                                aria-label={t('layout.toggleRightSidebar', 'Toggle Right Sidebar')}
                                aria-expanded={historyPanelIsDocked ? rightSidebarVisible : rightSheetOpen}
                                aria-controls={historyPanelIsDocked ? 'nai-blue-history-dock' : 'nai-blue-history-sheet'}
                            >
                                <PanelRight className="h-4 w-4" aria-hidden="true" />
                            </button>
                        </Tip>
                        <div className="ml-auto flex basis-full shrink-0 items-center justify-end gap-2 sm:basis-auto">
                            <Tip content={t('guided.activity.title', '내 작업')}>
                                <button
                                    type="button"
                                    onClick={() => openSupportSheet('activity')}
                                    data-testid="open-my-work-activity"
                                    className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-control text-muted-foreground transition-colors duration-standard hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card min-[1180px]:w-auto min-[1180px]:gap-2 min-[1180px]:px-3"
                                    aria-label={t('guided.activity.title', '내 작업')}
                                    aria-expanded={activitySheetOpen}
                                    aria-controls="nai-blue-activity-sheet"
                                >
                                    <BriefcaseBusiness className="h-4 w-4" aria-hidden="true" />
                                    <span className="hidden text-sm font-medium min-[1180px]:inline">
                                        {t('guided.activity.title', '내 작업')}
                                    </span>
                                </button>
                            </Tip>
                            <ProductGuidance />
                            <DiagnosticDrawer />
                        </div>
                    </div>
                    )}
                    {/* Keep dialog owners mounted when the menu closes; only their legacy triggers are hidden on the workbench. */}
                    {folderWorkbenchOpen && (
                        <div className="[&>button]:hidden">
                            <ProductGuidance returnFocusRef={workbenchToolsRef} />
                            <DiagnosticDrawer />
                        </div>
                    )}

                    {/* Page Content */}
                    <main className={cn(
                        "relative min-h-0 min-w-0 flex-1",
                        (location.pathname === '/advanced' || location.pathname === '/library' || location.pathname === '/folders') ? "p-0 overflow-hidden" : "overflow-y-auto p-2 sm:p-4"
                    )}>
                        {children}
                    </main>
                </div>

                <aside
                    id="nai-blue-history-dock"
                    className={cn(
                        "hidden min-h-0 w-[280px] flex-shrink-0 overflow-hidden border-y border-border/45 bg-card/80 2xl:block",
                        (!rightSidebarVisible || compositionWorkspaceOwnsRails) && "2xl:hidden"
                    )}
                >
                    {/* Only the visible History surface mounts its disk scan and
                        queue-summary poller; the responsive Sheet owns the other case. */}
                    {historyPanelIsDocked && rightSidebarVisible && <HistoryPanel />}
                </aside>
            </div>

            <Sheet
                modal={false}
                open={leftSheetOpen}
                onOpenChange={(open) => open ? openSupportSheet('prompt') : closeSupportSheet()}
            >
                <SheetContent
                    id="nai-blue-prompt-sheet"
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
