import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'react-router'
import { BriefcaseBusiness, Wrench } from 'lucide-react'

import { CustomTitleBar } from '@/components/layout/CustomTitleBar'
import { Button } from '@/components/ui/button'
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { isAndroidRuntime, isMobileRuntime } from '@/platform/runtime'
import { useLayoutStore } from '@/stores/layout-store'
import {
    MyWorkActivity,
    MyWorkActivityRefreshOwner,
} from '@/presentation/activity/MyWorkActivity'

interface GuidedShellProps {
    children: ReactNode
}

const isMac = navigator.platform.toUpperCase().includes('MAC')
    || navigator.userAgent.toUpperCase().includes('MAC')

function useDockedActivityRail() {
    const ref = useRef<HTMLDivElement>(null)
    const [docked, setDocked] = useState(false)

    useEffect(() => {
        const node = ref.current
        if (node === null) return
        const update = () => setDocked(node.clientWidth >= 1280)
        update()
        if (typeof ResizeObserver === 'undefined') return
        const observer = new ResizeObserver(update)
        observer.observe(node)
        return () => observer.disconnect()
    }, [])

    return { ref, docked }
}

export function GuidedShell({ children }: GuidedShellProps) {
    const { t } = useTranslation()
    const location = useLocation()
    const supportSheet = useLayoutStore(state => state.supportSheet)
    const openSupportSheet = useLayoutStore(state => state.openSupportSheet)
    const closeSupportSheet = useLayoutStore(state => state.closeSupportSheet)
    const activityOpen = supportSheet === 'activity'
    const { ref, docked } = useDockedActivityRail()
    const home = location.pathname === '/guided-preview' || location.pathname === '/guided-preview/'

    return (
        <div
            ref={ref}
            className={cn(
                'flex h-full min-w-0 flex-col bg-background',
                isAndroidRuntime && 'android-landscape-safe-inline',
            )}
            style={isMobileRuntime ? {
                // Match the shared app shell when Android WebView safe-area values are zero.
                paddingTop: isAndroidRuntime
                    ? 'max(1.5rem, env(safe-area-inset-top))'
                    : 'env(safe-area-inset-top)',
                paddingBottom: isAndroidRuntime
                    ? 'max(3.5rem, env(safe-area-inset-bottom))'
                    : 'env(safe-area-inset-bottom)',
            } : undefined}
        >
            <MyWorkActivityRefreshOwner />
            {!isMac && !isMobileRuntime && <CustomTitleBar showWorkspaceToggles={false} />}
            <header className="flex min-h-14 shrink-0 items-center gap-3 px-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
                <Link to="/guided-preview" className="hidden min-w-0 text-sm font-semibold tracking-[-0.02em] focus-ring min-[360px]:block">
                    NAI Blue
                </Link>
                <div className="ml-auto flex items-center gap-1">
                    {!docked && (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="min-h-11 min-w-11"
                            onClick={() => openSupportSheet('activity')}
                            aria-label={t('guided.activity.title', '내 작업')}
                            aria-expanded={activityOpen}
                            aria-controls="guided-activity-sheet"
                        >
                            <BriefcaseBusiness className="h-4 w-4 min-[440px]:mr-2" aria-hidden="true" />
                            <span className="hidden min-[440px]:inline">{t('guided.activity.title', '내 작업')}</span>
                        </Button>
                    )}
                    <Button asChild variant="ghost" size="sm" className="min-h-11 min-w-11">
                        <Link
                            to="/advanced"
                            aria-label={t('guided.advanced', '고급 생성 모드')}
                        >
                            <Wrench className="h-4 w-4 min-[440px]:mr-2" aria-hidden="true" />
                            <span className="hidden min-[440px]:inline">{t('guided.advanced', '고급 생성 모드')}</span>
                        </Link>
                    </Button>
                </div>
            </header>

            <div className="flex min-h-0 flex-1">
                <main className={cn('relative min-w-0 flex-1 overflow-y-auto surface-canvas', home && 'guided-welcome-ambient')}>
                    {children}
                </main>
                {docked && (
                    <aside className="w-[var(--activity-rail-width)] shrink-0 border-l border-border/45 bg-card/65" aria-label={t('guided.activity.title', '내 작업')}>
                        <MyWorkActivity queueTarget="/guided-preview/task/batch/queue" />
                    </aside>
                )}
            </div>

            {!docked && (
                <Sheet
                    open={activityOpen}
                    onOpenChange={(open) => open ? openSupportSheet('activity') : closeSupportSheet()}
                >
                    <SheetContent
                        id="guided-activity-sheet"
                        side="right"
                        className="w-full sm:max-w-[400px]"
                        closeLabel={t('common.close', '닫기')}
                    >
                        <SheetHeader className="sr-only">
                            <SheetTitle>{t('guided.activity.title', '내 작업')}</SheetTitle>
                            <SheetDescription>{t('guided.activity.description', '실행 중인 작업과 계정 상태')}</SheetDescription>
                        </SheetHeader>
                        <MyWorkActivity headingIsDecorative queueTarget="/guided-preview/task/batch/queue" />
                    </SheetContent>
                </Sheet>
            )}
        </div>
    )
}
