import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFile(resolve(process.cwd(), path), 'utf8')

describe('Composition workspace shell routing', () => {
    it('gives Main and Scene the desktop rails while preserving store-owned Prompt and History sheets', async () => {
        const [layout, layoutStore] = await Promise.all([
            source('src/components/layout/ThreeColumnLayout.tsx'),
            source('src/stores/layout-store.ts'),
        ])

        expect(layout).toContain("location.pathname === '/advanced'")
        expect(layout).toContain("location.pathname === '/scenes'")
        expect(layout).toContain("location.pathname.startsWith('/scenes/')")
        expect(layout).toContain('const promptPanelIsDocked = isDesktopShell && !folderWorkbenchOpen')
        expect(layout).toContain('const historyPanelIsDocked = isDesktopShell && !compositionWorkspaceOwnsRails')
        expect(layout).toContain("id=\"nai-blue-prompt-sheet\"")
        expect(layout).toContain("id=\"nai-blue-history-sheet\"")
        expect(layout).toContain('promptPanelIsDocked ? leftSidebarVisible : leftSheetOpen')
        expect(layout).toContain('historyPanelIsDocked ? rightSidebarVisible : rightSheetOpen')
        expect(layout).toMatch(/<Sheet[\s\S]*?modal=\{false\}/)
        expect(layout).toContain('showOverlay={false}')
        expect(layout).not.toContain('LAYOUT_SHEET_EVENTS')
        expect(layoutStore).toContain("supportSheet: 'prompt' | 'history' | 'activity' | null")
        expect(layoutStore).toContain('openSupportSheet:')
        expect(layoutStore).toContain('closeSupportSheet:')
        expect(layoutStore).toContain('partialize: ({ leftSidebarVisible, rightSidebarVisible, alwaysShowV5UsageLimit })')
        expect(layout).toContain("const activitySheetOpen = supportSheet === 'activity'")
        expect(layout).toContain('data-testid="open-my-work-activity"')
        expect(layout).toContain('id="nai-blue-activity-sheet"')
        expect(layout).toContain('<MyWorkActivity headingIsDecorative />')
    })

    it('keeps core listeners app-scoped while Scene and R2 runtimes stay lazy', async () => {
        const [app, runtimeProviders, coreRuntime, featureRuntime, sceneRuntime, r2Runtime] = await Promise.all([
            source('src/App.tsx'),
            source('src/components/runtime/RuntimeProviders.tsx'),
            source('src/components/runtime/CoreRuntimeProviders.tsx'),
            source('src/components/runtime/FeatureRuntimeProviders.tsx'),
            source('src/components/runtime/LegacySceneRuntime.tsx'),
            source('src/components/runtime/R2FeatureRuntime.tsx'),
        ])

        expect(app).toContain('<RuntimeProviders>')
        expect(app).not.toContain('useSceneGeneration()')
        expect(runtimeProviders).toContain('<CoreRuntimeProviders>')
        expect(runtimeProviders).toContain('<FeatureRuntimeProviders />')
        expect(runtimeProviders).not.toContain('useSceneGeneration')
        expect(runtimeProviders).not.toContain('useR2UploadRuntime')
        expect(coreRuntime).toContain('useDurableQueueRuntime()')
        expect(coreRuntime).toContain('useUpdateChecker()')
        expect(coreRuntime).toContain('useShortcuts()')
        expect(coreRuntime).toContain('useWindowResizePerformanceMode()')
        expect(coreRuntime).not.toContain('useSceneGeneration')
        expect(coreRuntime).not.toContain('useR2UploadRuntime')
        expect(featureRuntime).toContain("lazy(() => import('./LegacySceneRuntime'))")
        expect(featureRuntime).toContain("lazy(() => import('./R2FeatureRuntime'))")
        expect(featureRuntime).toContain("executionAuthority === 'legacy'")
        expect(featureRuntime).toContain('setSceneActivated(true)')
        expect(featureRuntime).toContain('setR2Activated(true)')
        expect(featureRuntime.match(/<Suspense fallback=\{null\}>/g)).toHaveLength(2)
        expect(sceneRuntime).toContain('useSceneGeneration()')
        expect(r2Runtime).toContain('useR2UploadRuntime()')
        expect(runtimeProviders).not.toContain("document.addEventListener('contextmenu'")
        expect(runtimeProviders).not.toContain('preventDefault()')
    })

    it('keeps focus trapping and focus return delegated to the Radix sheet primitive', async () => {
        const sheet = await source('src/components/ui/sheet.tsx')

        expect(sheet).toContain('SheetPrimitive.Content')
        expect(sheet).toContain('SheetPrimitive.Overlay')
        expect(sheet).toContain('SheetPrimitive.Close')
    })
})
