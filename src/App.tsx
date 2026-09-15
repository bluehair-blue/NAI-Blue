import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Navigate, Outlet, Routes, Route } from 'react-router'
import { Toaster } from '@/components/ui/toaster'
import { DiagnosticsSurface } from '@/components/diagnostics/DiagnosticsSurface'
import { ApiTokenDialog } from '@/components/credentials/ApiTokenDialog'
import { GlobalImageMetadataDrop } from '@/components/metadata/GlobalImageMetadataDrop'
import { TooltipProvider } from '@/components/ui/tooltip'
import { RuntimeProviders } from '@/components/runtime/RuntimeProviders'
import { useTrashStore } from '@/stores/trash-store'
import { pruneExpiredTrashItems } from '@/services/trash/asset-trash-service'

const ThreeColumnLayout = lazy(() => import('@/components/layout/ThreeColumnLayout').then(module => ({ default: module.ThreeColumnLayout })))
const MainMode = lazy(() => import('@/pages/MainMode'))
const FolderWorkbench = lazy(() => import('@/pages/FolderWorkbench'))
const SceneMode = lazy(() => import('@/pages/SceneMode'))
const SceneDetail = lazy(() => import('@/pages/SceneDetail'))
const WebView = lazy(() => import('@/pages/WebView'))
const Library = lazy(() => import('@/pages/Library'))
const Settings = lazy(() => import('@/pages/Settings'))
const ToolsMode = lazy(() => import('@/pages/ToolsMode'))
const StyleLab = lazy(() => import('@/pages/StyleLab'))
const QueueCenter = lazy(() => import('@/pages/QueueCenter'))
const R2Upload = lazy(() => import('@/pages/R2Upload'))
const Trash = lazy(() => import('@/pages/Trash'))
const DataHub = lazy(() => import('@/pages/DataHub'))
const GuidedPreview = lazy(() => import('@/presentation/workflow/GuidedPreview'))
const ManualReviewPreview = lazy(() => import('@/pages/ManualReviewPreview'))

function RouteLoadingFallback() {
    return (
        <div className="flex h-full min-h-[320px] items-center justify-center" role="status" aria-label="Loading">
            <div className="h-6 w-6 rounded-full border-2 border-muted-foreground/30 border-t-foreground animate-spin" />
        </div>
    )
}

/**
 * Depends on the persisted trash journal and runs beside the app router so
 * expiration is enforced at startup, not only when a user visits /trash.
 * Re-running after hydration or a new deletion is harmless and removes only
 * entries whose 30-day deadline has actually elapsed.
 */
function TrashRetentionSweep() {
    const items = useTrashStore(state => state.items)
    const removeMany = useTrashStore(state => state.removeMany)

    useEffect(() => {
        let disposed = false
        void pruneExpiredTrashItems(items).then(expiredIds => {
            if (!disposed && expiredIds.length > 0) removeMany(expiredIds)
        })
        return () => { disposed = true }
    }, [items, removeMany])

    return null
}

function AppContent() {
    return (
        <Suspense fallback={<RouteLoadingFallback />}>
            <Routes>
                <Route path="/" element={<Navigate to="/folders" replace />} />
                <Route path="/guided-preview/*" element={<GuidedPreview />} />
                <Route element={<AdvancedShell />}>
                    <Route path="/folders" element={<FolderWorkbench />} />
                    <Route path="/advanced" element={<MainMode />} />
                    <Route path="/scenes" element={<SceneMode />} />
                    <Route path="/scenes/:id" element={<SceneDetail />} />
                    <Route path="/tools" element={<ToolsMode />} />
                    <Route path="/style-lab" element={<StyleLab />} />
                    <Route path="/queue" element={<QueueCenter />} />
                    <Route path="/review-queue-preview" element={<ManualReviewPreview />} />
                    <Route path="/r2" element={<R2Upload />} />
                    <Route path="/trash" element={<Trash />} />
                    <Route path="/data" element={<DataHub />} />
                    <Route path="/web" element={<WebView />} />
                    <Route path="/library" element={<Library />} />
                    <Route path="/settings" element={<Settings />} />
                    <Route path="*" element={<Navigate to="/guided-preview" replace />} />
                </Route>
            </Routes>
        </Suspense>
    )
}

/** Shared navigation keeps the production workbench and existing specialist editors reachable. */
function AdvancedShell() {
    return (
        <ThreeColumnLayout>
            <Outlet />
        </ThreeColumnLayout>
    )
}

function App() {
    return (
        <TooltipProvider delayDuration={300}>
            <BrowserRouter>
                <RuntimeProviders>
                    <TrashRetentionSweep />
                    <AppContent />
                    <GlobalImageMetadataDrop />
                    <ApiTokenDialog />
                    <Toaster />
                    <DiagnosticsSurface />
                </RuntimeProviders>
            </BrowserRouter>
        </TooltipProvider>
    )
}

export default App
