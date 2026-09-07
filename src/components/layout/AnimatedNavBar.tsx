import { NavLink, useLocation } from 'react-router'
import { motion, useReducedMotion } from 'framer-motion'
import { useTranslation } from 'react-i18next'
import { Ellipsis, LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface NavItem {
    path: string
    icon: LucideIcon
    labelKey: string
    fallbackLabel?: string
}

interface AnimatedNavBarProps {
    items: NavItem[]
    forceCondensed?: boolean
}

const MOBILE_PRIMARY_PATHS = new Set(['/folders', '/advanced', '/scenes', '/queue'])

function isRouteActive(pathname: string, itemPath: string) {
    return itemPath === '/advanced'
        ? pathname === '/advanced'
        : pathname === itemPath || pathname.startsWith(`${itemPath}/`)
}

export function AnimatedNavBar({ items, forceCondensed = false }: AnimatedNavBarProps) {
    const { t } = useTranslation()
    const location = useLocation()
    const reduceMotion = useReducedMotion()

    // Compact shells retain the four daily destinations while routing every
    // remaining page through one overflow control; large desktops expose all labels.
    const primaryItems = items.filter(item => MOBILE_PRIMARY_PATHS.has(item.path))
    const overflowItems = items.filter(item => !MOBILE_PRIMARY_PATHS.has(item.path))
    const moreLabel = t('nav.more', 'More')
    const overflowIsActive = overflowItems.some(item => isRouteActive(location.pathname, item.path))

    const renderItem = (item: NavItem, layoutId: string, showLabel: boolean) => {
        const isActive = isRouteActive(location.pathname, item.path)
        const label = t(item.labelKey, item.fallbackLabel ?? item.labelKey)

        return (
            <NavLink
                key={item.path}
                to={item.path}
                title={!showLabel ? label : undefined}
                aria-label={label}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                    'relative z-0 inline-flex h-11 min-h-11 min-w-11 shrink-0 items-center justify-center rounded-control text-sm font-medium transition-colors duration-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card',
                    showLabel ? 'w-auto px-2' : 'w-11',
                    isActive
                        ? 'text-primary'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
            >
                {isActive && (
                    <motion.span
                        layoutId={layoutId}
                        className="absolute inset-0 -z-10 rounded-control bg-accent"
                        transition={reduceMotion
                            ? { duration: 0 }
                            : { type: 'tween', duration: 0.18, ease: [0.2, 0, 0, 1] }}
                    />
                )}
                <span className={cn('relative z-10 flex min-w-0 items-center', showLabel ? 'gap-1.5' : 'gap-2')}>
                    <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    {showLabel && <span className="truncate">{label}</span>}
                </span>
            </NavLink>
        )
    }

    return (
        <nav
            aria-label={t('nav.navigation', 'Primary navigation')}
            className="flex w-full min-w-0 items-center justify-center"
        >
            {/* Full labels depend on the center workspace width shared with both
                side docks. The 2200px threshold keeps enlarged labels away from
                sidebar toggles; ordinary desktops retain clear icons and tooltips. */}
            <div className={cn(
                'hidden min-w-0 items-center justify-center gap-0 min-[2200px]:flex',
                forceCondensed && '!hidden',
            )}>
                {items.map(item => renderItem(item, 'activeTab-desktop', true))}
            </div>

            <div className={cn(
                'hidden min-w-0 items-center justify-center gap-1 lg:flex min-[2200px]:!hidden',
                forceCondensed && '!hidden',
            )}>
                {items.map(item => renderItem(item, 'activeTab-compact', false))}
            </div>

            <div className={cn(
                'w-full max-w-[15rem] min-w-0 items-center justify-between gap-1',
                forceCondensed ? 'flex' : 'flex lg:hidden',
            )}>
                {primaryItems.map(item => renderItem(item, 'activeTab-condensed', false))}
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button
                            type="button"
                            aria-label={moreLabel}
                            title={moreLabel}
                            className={cn(
                                'inline-flex h-11 min-h-11 w-11 min-w-11 shrink-0 items-center justify-center rounded-control text-sm transition-colors duration-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card',
                                overflowIsActive
                                    ? 'bg-accent text-primary'
                                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                            )}
                        >
                            <Ellipsis className="h-4 w-4" aria-hidden="true" />
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                        align="end"
                        sideOffset={8}
                        className="w-56 rounded-panel border-0 bg-popover p-1 text-popover-foreground shadow-overlay"
                    >
                        {overflowItems.map(item => {
                            const isActive = isRouteActive(location.pathname, item.path)
                            const label = t(item.labelKey, item.fallbackLabel ?? item.labelKey)

                            return (
                                <DropdownMenuItem
                                    key={item.path}
                                    asChild
                                    className={cn(
                                        'h-11 rounded-control px-3 focus:bg-accent focus:text-accent-foreground',
                                        isActive && 'bg-accent text-primary'
                                    )}
                                >
                                    <NavLink
                                        to={item.path}
                                        aria-current={isActive ? 'page' : undefined}
                                        className="flex w-full items-center gap-3"
                                    >
                                        <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                                        <span className="truncate">{label}</span>
                                    </NavLink>
                                </DropdownMenuItem>
                            )
                        })}
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        </nav>
    )
}
