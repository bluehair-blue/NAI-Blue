import { describe, expect, it } from 'vitest'

import {
    getAdjacentNavigationRoute,
    NAVIGATION_GROUP_ORDER,
    NAVIGATION_ITEMS,
    NAVIGATION_ROUTE_ORDER,
    NAVIGATION_SHORTCUT_ROUTES,
} from '@/components/layout/navigation-items'

describe('Ctrl+PageDown/PageUp navigation cycle', () => {
    it('visits every menu destination exactly once, grouped in menu order', () => {
        expect([...NAVIGATION_ROUTE_ORDER].sort()).toEqual(NAVIGATION_ITEMS.map(item => item.path).sort())
        expect(new Set(NAVIGATION_ROUTE_ORDER).size).toBe(NAVIGATION_ROUTE_ORDER.length)

        const groupIndexes = NAVIGATION_ROUTE_ORDER.map(path => {
            const item = NAVIGATION_ITEMS.find(entry => entry.path === path)
            return NAVIGATION_GROUP_ORDER.indexOf(item!.group)
        })
        expect(groupIndexes).toEqual([...groupIndexes].sort((a, b) => a - b))
    })

    it('follows the tools menu order: data hub, R2, web, then settings', () => {
        const order = [...NAVIGATION_ROUTE_ORDER]
        expect(order.slice(0, 4)).toEqual(['/folders', '/advanced', '/scenes', '/queue'])
        expect(order.indexOf('/data')).toBeLessThan(order.indexOf('/r2'))
        expect(order.indexOf('/r2')).toBeLessThan(order.indexOf('/web'))
        expect(order.at(-1)).toBe('/settings')
    })

    it('moves from routes the old hand-written list missed instead of swallowing the key', () => {
        for (const path of ['/style-lab', '/trash', '/r2', '/guided-preview']) {
            const index = NAVIGATION_ROUTE_ORDER.indexOf(path)
            expect(getAdjacentNavigationRoute(path, 'next')).toBe(NAVIGATION_ROUTE_ORDER[index + 1])
            expect(getAdjacentNavigationRoute(path, 'prev')).toBe(NAVIGATION_ROUTE_ORDER[index - 1])
        }
    })

    it('wraps around and resolves nested and root paths to their menu entry', () => {
        expect(getAdjacentNavigationRoute('/settings', 'next')).toBe('/folders')
        expect(getAdjacentNavigationRoute('/folders', 'prev')).toBe('/settings')
        expect(getAdjacentNavigationRoute('/', 'next')).toBe('/advanced')
        expect(getAdjacentNavigationRoute('/scenes/abc', 'next')).toBe('/queue')
        expect(getAdjacentNavigationRoute('/scenes/abc', 'prev')).toBe('/advanced')
    })

    it('starts the cycle from the menu ends on routes outside the menu', () => {
        expect(getAdjacentNavigationRoute('/unlisted', 'next')).toBe('/folders')
        expect(getAdjacentNavigationRoute('/unlisted', 'prev')).toBe('/settings')
    })

    it('derives direct navigation shortcuts from the same menu definition', () => {
        expect(NAVIGATION_SHORTCUT_ROUTES).toEqual({
            'navigate:folders': '/folders',
            'navigate:main': '/advanced',
            'navigate:scenes': '/scenes',
            'navigate:queue': '/queue',
            'navigate:tools': '/tools',
            'navigate:library': '/library',
            'navigate:web': '/web',
            'navigate:settings': '/settings',
        })
    })
})
