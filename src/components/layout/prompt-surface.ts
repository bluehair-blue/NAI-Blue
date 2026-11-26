import { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'react-router'

import { useLayoutStore } from '@/stores/layout-store'

export const PROMPT_RAIL_MEDIA_QUERY = '(min-width: 1200px)'

export function useMediaQuery(query: string): boolean {
    const [matches, setMatches] = useState(() => (
        typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            ? window.matchMedia(query).matches
            : false
    ))

    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
        const mediaQuery = window.matchMedia(query)
        const syncMatches = () => setMatches(mediaQuery.matches)

        syncMatches()
        mediaQuery.addEventListener('change', syncMatches)
        return () => mediaQuery.removeEventListener('change', syncMatches)
    }, [query])

    return matches
}

export interface PromptSurfaceState {
    isAdvancedRoute: boolean
    isSceneRoute: boolean
    isDocked: boolean
    isSheetOpen: boolean
    isVisible: boolean
    ensureVisible: () => void
}

/**
 * Single authority for whether the Main prompt surface is docked (>=1200px on
 * /advanced), open as a non-modal sheet, or currently visible to the user.
 */
export function usePromptSurface(): PromptSurfaceState {
    const location = useLocation()
    const isDesktopRail = useMediaQuery(PROMPT_RAIL_MEDIA_QUERY)
    const leftSidebarVisible = useLayoutStore(state => state.leftSidebarVisible)
    const supportSheet = useLayoutStore(state => state.supportSheet)
    const setLeftSidebarVisible = useLayoutStore(state => state.setLeftSidebarVisible)
    const openSupportSheet = useLayoutStore(state => state.openSupportSheet)

    const isAdvancedRoute = location.pathname === '/advanced'
    const isSceneRoute = location.pathname === '/scenes' || location.pathname.startsWith('/scenes/')
    const isDocked = isDesktopRail && isAdvancedRoute
    const isSheetOpen = supportSheet === 'prompt' && !isDocked && !isSceneRoute
    const isVisible = (isDocked && leftSidebarVisible) || isSheetOpen

    const ensureVisible = useCallback(() => {
        if (isSceneRoute) return
        if (isDocked) {
            setLeftSidebarVisible(true)
            return
        }
        openSupportSheet('prompt')
    }, [isDocked, isSceneRoute, openSupportSheet, setLeftSidebarVisible])

    return {
        isAdvancedRoute,
        isSceneRoute,
        isDocked,
        isSheetOpen,
        isVisible,
        ensureVisible,
    }
}
