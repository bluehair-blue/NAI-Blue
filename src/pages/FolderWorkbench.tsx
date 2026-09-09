import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { ArrowRight, Check, ChevronDown, ChevronLeft, ChevronRight, Folder, ImageIcon, LayoutGrid, List, Plus, Search, Settings2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FolderAssetComposer } from '@/components/folders/FolderAssetComposer'
import { FolderTreePanel } from '@/components/folders/FolderTreePanel'
import { FolderAssetDetailDialog } from '@/components/folders/FolderAssetDetailDialog'
import { FolderProductionRequests } from '@/components/folders/FolderProductionRequests'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { GenerationFolderManagerDialog } from '@/components/generation-folders/GenerationFolderManagerDialog'
import { SceneQueueReviewDialog } from '@/components/queue/SceneQueueReviewDialog'
import { isSceneQueueReviewConflict } from '@/application/scene/scene-queue-review'
import { DEFAULT_R2_PROFILE_ID } from '@/domain/r2/types'
import { useDefaultR2Readiness } from '@/hooks/useDefaultR2Readiness'
import { resolveGenerationFolderAuthority } from '@/lib/generation-folder-authority-runtime'
import { flushSceneAuthorityRuntime } from '@/lib/scene-authority-runtime'
import { getRuntimeSceneRepository } from '@/lib/scene-migration-startup'
import { collectFolderAssets, createFolderAssetPreset, folderAssetLatestImage, folderAssetProductionCount, type FolderAssetInput, UNASSIGNED_FOLDER_ID } from '@/presentation/folders/folder-workbench'
import { useFolderQueueActivity } from '@/presentation/folders/folder-queue-activity'
import { emptyFolderView, loadFolderWorkbenchView, saveFolderWorkbenchView, type FolderView } from '@/presentation/folders/folder-workbench-draft'
import { enqueueReviewedSceneQueue, prepareSceneQueueReview, type PreparedSceneQueueReview, type SceneQueueSubmission, type SceneQueueTarget } from '@/services/queue/scene-queue-adapter'
import { resolveScenePrompts, type SceneFolderTemplate, useSceneStore } from '@/stores/scene-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useQueueStore } from '@/stores/queue-store'
import { runtimeCapabilities } from '@/platform/capabilities'
import { toNativeAssetUrl } from '@/platform/asset-url'
import '@/styles/folder-workbench.css'

const PAGE_SIZE = 60

/** A folder is the viewing scope; SceneStore still owns all editable assets and Queue owns execution. */
export default function FolderWorkbench() {
    const { t } = useTranslation()
    const folders = useSettingsStore(state => state.generationFolders)
    const folderDocument = useSettingsStore(state => state.generationFolderDocument)
    const activeFolderId = useSettingsStore(state => state.activeGenerationFolderId)
    const setActiveFolder = useSettingsStore(state => state.setActiveGenerationFolder)
    const savePath = useSettingsStore(state => state.savePath)
    const useAbsolutePath = useSettingsStore(state => state.useAbsolutePath)
    const presets = useSceneStore(state => state.presets)
    const sceneAuthorityReady = useSceneStore(state => state.sceneAuthorityInitialized)
    const setSceneProductionCounts = useSceneStore(state => state.setSceneProductionCounts)
    const selectBatch = useQueueStore(state => state.setSelectedBatchId)
    const { activity: queueActivity, unavailable: queueActivityUnavailable } = useFolderQueueActivity()
    const [restoredView] = useState(() => loadFolderWorkbenchView())
    const [folderId, setFolderId] = useState<string | null>(restoredView ? restoredView.folderId : activeFolderId || null)
    const [views, setViews] = useState<Record<string, FolderView>>(restoredView?.views ?? {})
    const viewStateRef = useRef({ folderId, views })
    const [viewSaved, setViewSaved] = useState(true)
    const scopeKey = folderId ?? '__all__'
    const view = Object.prototype.hasOwnProperty.call(views, scopeKey) ? views[scopeKey] : emptyFolderView()
    const [folderSheetOpen, setFolderSheetOpen] = useState(false)
    const [settingsOpen, setSettingsOpen] = useState(false)
    const [detailKey, setDetailKey] = useState<string | null>(null)
    const [managerOpen, setManagerOpen] = useState(false)
    const [composerOpen, setComposerOpen] = useState(false)
    const [batchCount, setBatchCount] = useState('1')
    const [busy, setBusy] = useState(false)
    const busyRef = useRef(false)
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState<string | null>(null)
    const [queued, setQueued] = useState(false)
    const [prepared, setPrepared] = useState<PreparedSceneQueueReview | null>(null)
    const [productionTargets, setProductionTargets] = useState<SceneQueueTarget[] | null>(null)
    const contentRef = useRef<HTMLDivElement>(null)
    const scrollSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    // Scroll writes are coalesced; navigation/pagehide flush the latest position before this view disappears.
    useEffect(() => {
        const flush = () => {
            if (scrollSaveTimer.current !== null) clearTimeout(scrollSaveTimer.current)
            saveFolderWorkbenchView(viewStateRef.current)
        }
        window.addEventListener('pagehide', flush)
        return () => { window.removeEventListener('pagehide', flush); flush() }
    }, [])
    const updateView = (patch: Partial<FolderView>) => {
        const previous = viewStateRef.current.views
        const current = Object.prototype.hasOwnProperty.call(previous, scopeKey) ? previous[scopeKey] : emptyFolderView()
        const resetsScroll = 'query' in patch || 'filter' in patch || 'page' in patch || 'includeChildren' in patch
        // Reinsert the current scope last so bounded persistence retains recently visited folders.
        const next = { ...previous }
        delete next[scopeKey]
        next[scopeKey] = { ...current, ...(resetsScroll ? { scrollTop: 0 } : {}), ...patch }
        const bounded = Object.fromEntries(Object.entries(next).slice(-32))
        viewStateRef.current = { folderId, views: bounded }
        setViews(bounded)
        setViewSaved(saveFolderWorkbenchView(viewStateRef.current))
    }
    const selectFolder = (id: string | null) => {
        if (busyRef.current) return
        viewStateRef.current = { ...viewStateRef.current, folderId: id }
        setViewSaved(saveFolderWorkbenchView(viewStateRef.current))
        setFolderId(id)
        if (id !== null && id !== UNASSIGNED_FOLDER_ID) setActiveFolder(id)
        setError(null)
        setSuccess(null)
        setQueued(false)
        setFolderSheetOpen(false)
        setDetailKey(null)
        setComposerOpen(false)
    }
    const concreteFolder = folders.find(folder => folder.id === folderId)
    const folderRows = useMemo(() => {
        const byId = new Map(folders.map(folder => [folder.id, folder]))
        return folders.map(folder => {
            const names = [folder.name]
            const visited = new Set([folder.id])
            let parent = folder.parentId === null ? undefined : byId.get(folder.parentId)
            while (parent && !visited.has(parent.id)) {
                visited.add(parent.id)
                names.unshift(parent.name)
                parent = parent.parentId === null ? undefined : byId.get(parent.parentId)
            }
            return { folder, path: names.join(' / '), depth: names.length - 1 }
        }).sort((a, b) => a.path.localeCompare(b.path))
    }, [folders])
    const scopeName = folderId === null ? t('folderWorkbench.allFolders', '모든 폴더')
        : folderId === UNASSIGNED_FOLDER_ID ? t('folderWorkbench.unassigned', '폴더 미지정')
            : folderRows.find(row => row.folder.id === folderId)?.path ?? t('folderWorkbench.missingFolder', '폴더를 선택하세요')
    // Show the newest import first, so the assets just added are visible in the next step.
    const rows = useMemo(() => collectFolderAssets([...presets].reverse(), folders, folderId, view.includeChildren), [presets, folders, folderId, view.includeChildren])
    const searched = useMemo(() => {
        const query = view.query.trim().toLocaleLowerCase()
        return rows.filter(row => !query || [row.scene.name, row.presetName, ...Object.values(resolveScenePrompts(row.scene))]
            .join(' ').toLocaleLowerCase().includes(query))
    }, [rows, view.query])
    const filtered = useMemo(() => searched.filter(row => view.filter === 'all'
        || (view.filter === 'images' ? row.scene.images.length > 0 : row.scene.images.length === 0)), [searched, view.filter])
    const folderCounts = useMemo(() => {
        const counts: Record<string, number> = {}
        for (const preset of presets) for (const scene of preset.scenes) {
            const key = scene.generationFolderId ?? UNASSIGNED_FOLDER_ID
            counts[key] = (counts[key] ?? 0) + 1
        }
        return counts
    }, [presets])
    const previewCount = searched.filter(row => row.scene.images.length > 0).length
    const detailRow = rows.find(row => row.key === detailKey) ?? null
    // Search never broadens execution: only explicitly selected IDs in the current result can run.
    const selectedKeys = new Set(view.selected)
    const selected = filtered.filter(row => selectedKeys.has(row.key))
    const imageCount = selected.reduce((sum, row) => sum + folderAssetProductionCount(row.scene), 0)
    const invalidCount = selected.some(row => !Number.isInteger(folderAssetProductionCount(row.scene)) || folderAssetProductionCount(row.scene) < 1 || folderAssetProductionCount(row.scene) > 999)
    const imageLimit = runtimeCapabilities.generationPublication.generationLimits?.maxJobsPerAtomicBatch ?? 100
    const overImageLimit = imageCount > imageLimit
    const overProductionLimit = imageCount > 2400
    const executionUnavailable = !runtimeCapabilities.generationPublication.supported
    const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
    const page = Math.min(view.page, pageCount - 1)
    // ponytail: 60 rendered assets per page bounds the 2400-item workbench without a virtualizer dependency.
    const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
    useLayoutEffect(() => {
        if (sceneAuthorityReady && contentRef.current) contentRef.current.scrollTop = viewStateRef.current.views[scopeKey]?.scrollTop ?? 0
    }, [scopeKey, view.view, view.page, view.query, view.filter, view.includeChildren, sceneAuthorityReady, rows.length])
    const templates = presets.flatMap(preset => preset.defaultTemplate
        ? [{ id: preset.id, name: preset.name, template: preset.defaultTemplate }] : [])
    const preliminary = concreteFolder ? resolveGenerationFolderAuthority(folderDocument, folders, concreteFolder.id, {
        directory: savePath, useAbsolutePath, r2ProfileId: DEFAULT_R2_PROFILE_ID,
    }) : null
    const profileId = preliminary?.r2.profileId ?? null
    const r2 = useDefaultR2Readiness(profileId, profileId !== null)
    const profile = r2.profile?.id === profileId ? r2.profile : null
    const resolved = concreteFolder ? resolveGenerationFolderAuthority(folderDocument, folders, concreteFolder.id, {
        directory: savePath, useAbsolutePath, r2ProfileId: profileId,
        r2Bucket: profile?.bucket, r2Prefix: profile?.prefix,
    }) : null

    const reportError = (cause: unknown) => setError(cause instanceof Error ? cause.message : t('folderWorkbench.actionFailed', '작업을 완료하지 못했습니다.'))
    const lock = () => { busyRef.current = true; setBusy(true); setError(null) }
    const unlock = () => { busyRef.current = false; setBusy(false) }
    const reviewSelection = async (): Promise<boolean> => {
        if (busyRef.current || !sceneAuthorityReady || selected.length === 0 || invalidCount || overImageLimit || executionUnavailable) return false
        lock()
        try {
            await flushSceneAuthorityRuntime()
            const next = await prepareSceneQueueReview(selected.map(row => ({
                presetId: row.presetId, sceneId: row.scene.id, count: folderAssetProductionCount(row.scene),
                ...(row.scene.queuedFileNames === undefined ? {} : { fileNames: row.scene.queuedFileNames.slice(0, folderAssetProductionCount(row.scene)) }),
            })), { consumePendingEntries: true })
            if (!next) throw new Error(t('folderWorkbench.emptySelection', '생성할 항목을 선택하세요.'))
            setPrepared(next)
            return true
        } catch (cause) { reportError(cause); return false }
        finally { unlock() }
    }
    const approve = async (submission: SceneQueueSubmission): Promise<boolean> => {
        if (busyRef.current) return false
        lock()
        try {
            const result = await enqueueReviewedSceneQueue(submission)
            selectBatch(result.batch.id)
            setSuccess(t('folderWorkbench.queued', '{{count}}개 작업을 대기열에 추가했습니다.', { count: result.jobs.length }))
            setQueued(true)
            return true
        } catch (cause) {
            if (isSceneQueueReviewConflict(cause)) throw cause
            reportError(cause)
            return false
        } finally { unlock() }
    }
    const addAssets = async (inputs: FolderAssetInput[], template?: SceneFolderTemplate): Promise<boolean> => {
        if (busyRef.current || !sceneAuthorityReady || !concreteFolder || inputs.length === 0) return false
        lock()
        try {
            const preset = createFolderAssetPreset({ name: concreteFolder.name, folderId: concreteFolder.id, rows: inputs, template })
            useSceneStore.getState().importPreset(preset)
            // Import assigns a new preset ID; verify that the authority bridge committed this exact set before claiming success.
            const importedId = useSceneStore.getState().activePresetId
            await flushSceneAuthorityRuntime()
            const saved = importedId === null ? null : await getRuntimeSceneRepository().getDocument(importedId)
            const savedIds = new Set(saved?.scenes.map(scene => scene.id))
            if (!saved || preset.scenes.some(scene => !savedIds.has(scene.id))) {
                throw new Error(t('folderWorkbench.saveUnconfirmed', '항목 저장을 확인하지 못했습니다. 현재 폴더와 오류를 확인하세요. 자동으로 다시 추가하지 않습니다.'))
            }
            // The explicit import selects only its verified IDs, so the next step never widens to older assets.
            updateView({ query: '', filter: 'all', selected: preset.scenes.map(scene => JSON.stringify([importedId, scene.id])), page: 0 })
            setSuccess(t('folderWorkbench.start.saved', '{{count}}개 이미지를 추가하고 선택했어요.', { count: inputs.length }))
            setQueued(false)
            setComposerOpen(false)
            contentRef.current?.scrollTo({ top: 0 })
            return true
        } catch (cause) { reportError(cause); return false }
        finally { unlock() }
    }

    const folderTitle = concreteFolder?.name ?? (folderId === null
        ? t('folderWorkbench.design.allImages', '모든 이미지')
        : t('folderWorkbench.design.unfiled', '폴더 없는 이미지'))
    const pageSelected = pageRows.length > 0 && pageRows.every(row => selectedKeys.has(row.key))
    const selectPage = (checked: boolean) => {
        const keys = new Set(view.selected)
        for (const row of pageRows) checked ? keys.add(row.key) : keys.delete(row.key)
        updateView({ selected: [...keys] })
    }
    const folderPanel = <FolderTreePanel folders={folders} activeFolderId={folderId} counts={folderCounts}
        onSelect={selectFolder} onManage={() => { setFolderSheetOpen(false); setManagerOpen(true) }} />
    const composer = <FolderAssetComposer key={scopeKey} folderId={scopeKey} busy={busy} disabled={!sceneAuthorityReady || !concreteFolder}
        error={error} templates={templates} onSubmit={addAssets} />
    const canReview = !busy && sceneAuthorityReady && selected.length > 0 && !invalidCount && !overImageLimit && !executionUnavailable
    const canSaveProduction = !busy && sceneAuthorityReady && selected.length > 0 && !invalidCount && !overProductionLimit
    // Snapshot the explicit filtered selection at dialog entry, independent of later workbench draft changes.
    const openProduction = () => setProductionTargets(selected.map(row => ({
        presetId: row.presetId, sceneId: row.scene.id, count: folderAssetProductionCount(row.scene),
        ...(row.scene.queuedFileNames === undefined ? {} : { fileNames: row.scene.queuedFileNames.slice(0, folderAssetProductionCount(row.scene)) }),
    })))

    return (
        <div className="fb-workspace" data-testid="folder-workbench">
            <aside className="fb-sidebar">{folderPanel}</aside>
            <section className="fb-main" aria-label={t('folderWorkbench.design.imageWorkspace', '이미지 작업 공간')}>
                <div ref={contentRef} onScroll={event => {
                    const current = viewStateRef.current.views[scopeKey] ?? emptyFolderView()
                    viewStateRef.current.views[scopeKey] = { ...current, scrollTop: event.currentTarget.scrollTop }
                    if (scrollSaveTimer.current !== null) clearTimeout(scrollSaveTimer.current)
                    scrollSaveTimer.current = setTimeout(() => setViewSaved(saveFolderWorkbenchView(viewStateRef.current)), 200)
                }} className="fb-content-scroll">
                    <header className="fb-workspace-header">
                        {!viewSaved && <p role="status" className="fb-notice">{t('folderWorkbench.design.viewSaveFailed', '현재 보기와 선택을 저장하지 못했어요. 다시 열면 복구되지 않을 수 있어요.')}</p>}
                        <div className="fb-location-row">
                            <Button variant="ghost" className="fb-button fb-mobile-folders" onClick={() => setFolderSheetOpen(true)}><Folder aria-hidden="true" />{t('folderWorkbench.design.folders', '폴더')}</Button>
                            <p className="fb-breadcrumb" title={scopeName}><span className="fb-breadcrumb-label">{t('folderWorkbench.design.currentFolder', '지금 보고 있는 폴더')}</span><ChevronRight aria-hidden="true" /><span className="fb-folder-trail">{scopeName}</span></p>
                        </div>
                        <div className="fb-title-row">
                            <div>
                                <h1>{folderTitle}</h1>
                                <p className="fb-folder-summary">{rows.length > 0
                                    ? t('folderWorkbench.design.folderSummary', '이미지 {{count}}개 · 각 이미지의 설명과 장수를 정해 보세요.', { count: rows.length })
                                    : t('folderWorkbench.design.emptyIntro', '다른 설명을 가진 이미지도 한 번에 만들 수 있어요.')}</p>
                            </div>
                        </div>
                        {rows.length > 0 ? <div className="fb-action-row">
                            <Button className="fb-button fb-primary" disabled={overImageLimit ? !canSaveProduction : !canReview} onClick={() => { if (overImageLimit) openProduction(); else void reviewSelection() }}>
                                {busy ? t('folderWorkbench.design.preparing', '준비하고 있어요…') : overImageLimit ? t('productionRequests.save') : imageCount > 0 ? t('folderWorkbench.design.makeImages', '{{count}}장 만들기', { count: imageCount }) : t('folderWorkbench.design.navCreate', '이미지 만들기')}<ArrowRight aria-hidden="true" />
                            </Button>
                            {!overImageLimit && selected.length > 0 && <Button variant="outline" className="fb-button fb-secondary" disabled={!canSaveProduction} onClick={openProduction}>{t('productionRequests.save')}</Button>}
                            {concreteFolder && <Button variant="outline" className="fb-button fb-secondary" disabled={busy || !sceneAuthorityReady} onClick={() => { setError(null); setComposerOpen(true) }}><Plus aria-hidden="true" />{t('folderWorkbench.design.addImages', '이미지 추가')}</Button>}
                            <Button variant="ghost" className="fb-button fb-quiet" onClick={() => setSettingsOpen(true)}><Settings2 aria-hidden="true" />{t('folderWorkbench.design.folderSettings', '폴더 설정')}</Button>
                            <p className="fb-action-hint">{selected.length > 0
                                ? t('folderWorkbench.design.selectionSummary', '{{count}}개 선택 · 총 {{images}}장', { count: selected.length, images: imageCount })
                                : t('folderWorkbench.design.selectToMake', '만들 이미지를 골라 주세요.')}</p>
                        </div> : <ol className="fb-start-steps" aria-label={t('folderWorkbench.design.workflow', '이미지 만드는 순서')}>
                            <li aria-current="step"><span>1</span>{t('folderWorkbench.design.writeDescription', '설명 쓰기')}</li>
                            <li><span>2</span>{t('folderWorkbench.design.checkQuantity', '장수 확인')}</li>
                            <li><span>3</span>{t('folderWorkbench.design.make', '만들기')}</li>
                        </ol>}
                        {selected.length > 0 && executionUnavailable && <p className="fb-notice">{t('folderWorkbench.design.desktopHint', '이미지를 만들려면 Windows 앱에서 열어 주세요. 여기서는 설명과 장수를 저장할 수 있어요.')}</p>}
                        {overImageLimit && !overProductionLimit && <p className="fb-notice">{t('productionRequests.splitHint', { count: imageLimit })}</p>}
                        {overProductionLimit && <p className="fb-error" role="alert">{t('productionRequests.limit')}</p>}
                        {invalidCount && <p className="fb-error" role="alert">{t('folderWorkbench.design.countHint', '장수는 1부터 999까지 적어 주세요.')}</p>}
                        {error && rows.length > 0 && !composerOpen && <p className="fb-error" role="alert">{error}</p>}
                        {success && <p role="status" className={queued ? 'fb-notice' : 'sr-only'}>{success} {queued && <Link className="underline" to="/queue">{t('folderWorkbench.design.openHistory', '작업 기록 보기')}</Link>}</p>}
                        {queueActivityUnavailable && <p role="status" className="fb-notice">{t('folderWorkbench.design.statusUnavailable', '작업 상태를 확인하지 못했어요.')} <Link className="underline" to="/queue">{t('folderWorkbench.design.openHistory', '작업 기록 보기')}</Link></p>}
                    </header>
                    <FolderProductionRequests targets={productionTargets} defaultTitle={scopeName} onClose={() => setProductionTargets(null)} disabled={busy || !sceneAuthorityReady} canExecute={!executionUnavailable} />
                    {rows.length === 0 ? <div className="fb-empty-workspace">
                        {concreteFolder ? <>
                            <div className="fb-composer-heading"><h2>{t('folderWorkbench.design.whatToMake', '어떤 이미지를 만들까요?')}</h2><p>{t('folderWorkbench.design.descriptionHint', '이미지마다 설명을 하나씩 적어 주세요. 이름은 나중에 정해도 돼요.')}</p></div>
                            {composer}
                        </> : <div className="fb-empty-message"><Folder aria-hidden="true" /><h2>{t('folderWorkbench.design.chooseFolder', '이미지를 담을 폴더를 골라 주세요.')}</h2><Button className="fb-button fb-secondary" onClick={() => setFolderSheetOpen(true)}>{t('folderWorkbench.design.showFolders', '폴더 보기')}</Button></div>}
                    </div> : <>
                        <div className="fb-gallery-tools">
                            <div className="fb-filter-row">
                                <div className="fb-filter-tabs" role="group" aria-label={t('folderWorkbench.design.imageFilter', '이미지 분류')}>
                                    {([
                                        ['all', t('folderWorkbench.design.all', '전체'), searched.length],
                                        ['images', t('folderWorkbench.design.withImages', '이미지 있음'), previewCount],
                                        ['planned', t('folderWorkbench.design.withoutImages', '만들기 전'), searched.length - previewCount],
                                    ] as const).map(([filter, label, count]) => <button key={filter} type="button" aria-pressed={view.filter === filter}
                                        className={`fb-filter-tab ${view.filter === filter ? 'is-active' : ''}`} onClick={() => updateView({ filter, page: 0 })}>{label}<span>{count}</span></button>)}
                                </div>
                                <label className="fb-image-search"><Search aria-hidden="true" /><Input type="search" value={view.query} onChange={event => updateView({ query: event.target.value, page: 0 })}
                                    placeholder={t('folderWorkbench.design.findImage', '이미지 찾기')} aria-label={t('folderWorkbench.design.findImage', '이미지 찾기')} /></label>
                                <div className="fb-view-switch" role="group" aria-label={t('folderWorkbench.viewMode', '보기 방식')}>
                                    <button type="button" className={view.view === 'grid' ? 'is-active' : ''} aria-pressed={view.view === 'grid'} onClick={() => updateView({ view: 'grid' })}><LayoutGrid aria-hidden="true" /><span>{t('folderWorkbench.design.imageView', '이미지 보기')}</span></button>
                                    <button type="button" className={view.view === 'list' ? 'is-active' : ''} aria-pressed={view.view === 'list'} onClick={() => updateView({ view: 'list' })}><List aria-hidden="true" /><span>{t('folderWorkbench.listView', '목록 보기')}</span></button>
                                </div>
                            </div>
                            <div className="fb-selection-row">
                                <label className="fb-check-label"><input type="checkbox" checked={pageSelected} disabled={busy || pageRows.length === 0} onChange={event => selectPage(event.target.checked)} />{t('folderWorkbench.design.selectPage', '이 페이지 선택')}</label>
                                {filtered.length > PAGE_SIZE && <Button variant="ghost" className="fb-button fb-text-button" disabled={busy} onClick={() => updateView({ selected: filtered.map(row => row.key) })}>{t('folderWorkbench.design.selectAll', '찾은 {{count}}개 모두 선택', { count: filtered.length })}</Button>}
                                {selected.length > 0 && <Button variant="ghost" className="fb-button fb-text-button" disabled={busy} onClick={() => updateView({ selected: [] })}>{t('folderWorkbench.clearSelection', '선택 해제')}</Button>}
                                {selected.length > 1 && <details className="fb-bulk-count">
                                    <summary>{t('folderWorkbench.design.changeCounts', '장수 한 번에 바꾸기')}<ChevronDown aria-hidden="true" /></summary>
                                    <div className="fb-bulk-popover"><label>{t('folderWorkbench.design.eachQuantity', '각각 몇 장?')}<Input type="number" min={1} max={999} value={batchCount} onChange={event => setBatchCount(event.target.value)} /></label>
                                        <Button variant="outline" className="fb-button fb-secondary" disabled={busy || !Number.isInteger(Number(batchCount)) || Number(batchCount) < 1 || Number(batchCount) > 999}
                                            onClick={() => setSceneProductionCounts(selected.map(row => ({ presetId: row.presetId, sceneId: row.scene.id })), Number(batchCount))}>{t('folderWorkbench.design.applyQuantity', '선택한 이미지에 적용')}</Button></div>
                                </details>}
                                <span className="fb-result-count">{t('folderWorkbench.design.resultCount', '{{count}}개 보이는 중', { count: filtered.length })}</span>
                            </div>
                        </div>
                        <div className="fb-gallery-region" aria-label={t('folderWorkbench.design.imagePreview', '이미지 미리보기')}>
                            {pageRows.length === 0 ? <div className="fb-empty-message"><Search aria-hidden="true" /><h2>{t('folderWorkbench.design.noResults', '찾는 이미지가 없어요.')}</h2><p>{t('folderWorkbench.design.trySearch', '다른 이름이나 설명으로 찾아보세요.')}</p><Button variant="outline" className="fb-button fb-secondary" onClick={() => updateView({ query: '', filter: 'all', page: 0 })}>{t('folderWorkbench.design.showAll', '전체 이미지 보기')}</Button></div>
                                : <ul className={`fb-gallery ${view.view === 'list' ? 'is-list' : ''}`}>
                                    {pageRows.map(row => {
                                        const prompt = resolveScenePrompts(row.scene).additional
                                        const lastImage = folderAssetLatestImage(row.scene)
                                        const activity = queueActivity.get(row.key)
                                        const activityLabel = activity ? ({
                                            queued: t('folderWorkbench.design.jobQueued', '대기 중'),
                                            leased: t('folderWorkbench.design.jobRunning', '만드는 중'),
                                            running: t('folderWorkbench.design.jobRunning', '만드는 중'),
                                            recovering: t('folderWorkbench.design.jobRecovering', '확인 중'),
                                            blocked: t('folderWorkbench.design.jobBlocked', '확인 필요'),
                                            failed: t('folderWorkbench.design.jobFailed', '만들지 못했어요'),
                                            succeeded: t('folderWorkbench.design.jobSucceeded', '완료'),
                                            cancelled: t('folderWorkbench.design.jobCancelled', '취소됨'),
                                            skipped: t('folderWorkbench.design.jobSkipped', '건너뜀'),
                                        })[activity.state] : null
                                        const imageUrl = !lastImage || lastImage.url.startsWith('data:') ? lastImage?.url : toNativeAssetUrl(lastImage.url)
                                        return <li key={row.key} data-preset-id={row.presetId} data-scene-id={row.scene.id} className={`fb-asset-card ${selectedKeys.has(row.key) ? 'is-selected' : ''}`}>
                                            <div className="fb-card-media">
                                                <label className="fb-card-select"><input type="checkbox" checked={selectedKeys.has(row.key)} disabled={busy}
                                                    aria-label={t('folderWorkbench.selectAsset', '{{name}} 선택', { name: row.scene.name })}
                                                    onChange={event => updateView({ selected: event.target.checked ? [...view.selected, row.key] : view.selected.filter(key => key !== row.key) })} /><span className="sr-only">{row.scene.name}</span></label>
                                                <button type="button" className="fb-open-preview" onClick={() => setDetailKey(row.key)} aria-label={t('folderWorkbench.design.openImage', '{{name}} 이미지와 설명 보기', { name: row.scene.name })}>
                                                    {imageUrl ? <img src={imageUrl} alt={row.scene.name} loading="lazy" /> : <span className="fb-prompt-preview"><ImageIcon aria-hidden="true" /><span>{prompt || t('folderWorkbench.design.addDescription', '그림 설명을 적어 주세요.')}</span><small>{t('folderWorkbench.design.withoutImages', '만들기 전')}</small></span>}
                                                </button>
                                            </div>
                                            <div className="fb-card-info"><h3 title={row.scene.name}>{row.scene.name}</h3><p className="fb-card-status">{activity ? <>{queueActivityUnavailable && <>{t('folderWorkbench.design.lastKnownStatus', '마지막 확인')} · </>}{activityLabel}{activity.unfinished > 0 && <> · {t('folderWorkbench.design.jobRemaining', '남은 {{count}}장', { count: activity.unfinished })}</>}</> : imageUrl ? <><Check aria-hidden="true" />{t('folderWorkbench.design.imageAvailable', '이미지 {{count}}장 있음', { count: row.scene.images.length })}</> : t('folderWorkbench.design.readyDescription', '설명 준비됨')}</p>
                                                {view.view === 'list' && <p className="fb-list-description">{prompt}</p>}
                                                <div className="fb-card-actions"><label>{t('folderWorkbench.design.quantity', '장수')}<Input type="number" min={1} max={999} value={folderAssetProductionCount(row.scene)} disabled={busy}
                                                    aria-label={t('folderWorkbench.assetCount', '{{name}} 생성 수량', { name: row.scene.name })}
                                                    onChange={event => { const count = Number(event.target.value); if (Number.isInteger(count) && count >= 1 && count <= 999) setSceneProductionCounts([{ presetId: row.presetId, sceneId: row.scene.id }], count) }} /></label>
                                                    <button type="button" onClick={() => setDetailKey(row.key)} aria-label={t('folderWorkbench.design.editDescriptionOf', '{{name}} 설명 편집', { name: row.scene.name })}>{t('folderWorkbench.design.editDescription', '설명 편집')}</button></div>
                                            </div>
                                        </li>
                                    })}
                                </ul>}
                        </div>
                    </>}
                    {!sceneAuthorityReady && <p role="status" className="fb-loading">{t('folderWorkbench.design.loading', '저장한 이미지를 불러오고 있어요…')}</p>}
                </div>
                {rows.length > 0 && <footer className="fb-workspace-footer" aria-live="polite">
                    <div><p>{t('folderWorkbench.design.selectionSummary', '{{count}}개 선택 · 총 {{images}}장', { count: selected.length, images: imageCount })}</p>
                        {view.selected.length > selected.length && <p className="fb-footer-note">{t('folderWorkbench.design.excludedSelection', '다른 검색 결과와 다른 분류의 선택은 제외돼요.')}</p>}
                        <span className="sr-only">{t('folderWorkbench.scopeSummary', '검색 결과 {{results}}개 중 선택 {{selected}}개 · 총 {{images}}장', { results: filtered.length, selected: selected.length, images: imageCount })}</span></div>
                    {pageCount > 1 && <nav className="fb-pagination" aria-label={t('folderWorkbench.pagination', '항목 페이지')}><button type="button" disabled={page === 0} onClick={() => updateView({ page: page - 1 })} aria-label={t('folderWorkbench.previous', '이전')}><ChevronLeft aria-hidden="true" /></button><span>{page + 1} / {pageCount}</span><button type="button" disabled={page + 1 >= pageCount} onClick={() => updateView({ page: page + 1 })} aria-label={t('folderWorkbench.next', '다음')}><ChevronRight aria-hidden="true" /></button></nav>}
                </footer>}
            </section>
            <Sheet open={folderSheetOpen} onOpenChange={setFolderSheetOpen}><SheetContent side="left" closeLabel={t('folderWorkbench.design.close', '닫기')} className="folder-workbench-surface fb-folder-sheet"><SheetHeader className="sr-only"><SheetTitle>{t('folderWorkbench.design.folders', '폴더')}</SheetTitle><SheetDescription>{t('folderWorkbench.design.chooseFolder', '이미지를 담을 폴더를 골라 주세요.')}</SheetDescription></SheetHeader>{folderPanel}</SheetContent></Sheet>
            <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}><SheetContent side="right" closeLabel={t('folderWorkbench.design.close', '닫기')} className="folder-workbench-surface fb-settings-sheet">
                <SheetHeader className="fb-settings-heading"><SheetTitle>{t('folderWorkbench.design.folderSettings', '폴더 설정')}</SheetTitle><SheetDescription>{scopeName}</SheetDescription></SheetHeader>
                <div className="fb-settings-sections">
                    <section><h3>{t('folderWorkbench.design.saveWhere', '어디에 저장할까요?')}</h3><p className="fb-setting-label">{t('folderWorkbench.design.onComputer', '내 컴퓨터')}</p><p className="fb-path">{resolved?.directory ?? t('folderWorkbench.design.variesByImage', '이미지마다 정한 위치에 저장해요.')}</p><p className="fb-settings-note">{t('folderWorkbench.design.pathHint', '정확한 파일 이름과 위치는 만들기 전에 확인할 수 있어요.')}</p></section>
                    <section><h3>{t('folderWorkbench.design.sharedDescription', '모든 이미지에 넣을 설명')}</h3><p className="fb-shared-description">{resolved?.commonPrompt || t('folderWorkbench.design.noSharedDescription', '따로 넣은 설명이 없어요.')}</p></section>
                    <section><h3>{t('folderWorkbench.design.uploadInternet', '인터넷에 올리기')}</h3><p>{resolved?.r2.autoUpload ? t('folderWorkbench.design.uploadOn', '만든 뒤 자동으로 올려요.') : t('folderWorkbench.design.uploadOff', '지금은 컴퓨터에만 저장해요.')}</p>
                        {resolved?.r2.autoUpload && <p className="fb-settings-note">{r2.status === 'ready' && profile ? t('folderWorkbench.design.connectionReady', '저장된 연결을 사용해요.') : t('folderWorkbench.design.connectionNeeded', '먼저 연결을 확인해 주세요.')}</p>}
                        <Button asChild variant="outline" className="fb-button fb-secondary"><Link to="/r2">{t('folderWorkbench.design.uploadSettings', '올리기 설정')}</Link></Button>
                        {profile?.publicBaseUrl && <p className="fb-path">{profile.publicBaseUrl}</p>}
                    </section>
                    {concreteFolder && folders.some(folder => folder.parentId === concreteFolder.id) && <label className="fb-check-label"><input type="checkbox" checked={view.includeChildren} onChange={event => updateView({ includeChildren: event.target.checked, page: 0 })} />{t('folderWorkbench.design.includeChildren', '안쪽 폴더 이미지도 보기')}</label>}
                    <Button variant="outline" className="fb-button fb-secondary" onClick={() => { setSettingsOpen(false); setManagerOpen(true) }}>{t('folderWorkbench.design.changeFolderSettings', '저장 위치와 설명 바꾸기')}</Button>
                </div>
            </SheetContent></Sheet>
            <GenerationFolderManagerDialog open={managerOpen} onOpenChange={setManagerOpen} initialFolderId={concreteFolder?.id} onSaved={selectFolder} />
            <Dialog open={composerOpen} onOpenChange={open => { if (!busyRef.current) setComposerOpen(open) }}><DialogContent closeLabel={t('folderWorkbench.design.close', '닫기')} className="folder-workbench-surface fb-composer-dialog">
                <DialogHeader className="pr-10 text-left"><DialogTitle>{t('folderWorkbench.design.addImages', '이미지 추가')}</DialogTitle><DialogDescription>{t('folderWorkbench.design.addToFolder', '{{name}} 폴더에 담아요.', { name: scopeName })}</DialogDescription></DialogHeader>{composer}
            </DialogContent></Dialog>
            <FolderAssetDetailDialog row={detailRow} ready={sceneAuthorityReady && !busy} onClose={() => setDetailKey(null)} />
            {prepared && <SceneQueueReviewDialog open={true} onOpenChange={open => { if (!open) setPrepared(null) }} prepared={prepared} busy={busy} error={error} onApprove={approve} onReplan={reviewSelection} />}
        </div>
    )
}
