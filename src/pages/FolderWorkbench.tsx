import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Folder, ImageIcon, LayoutGrid, List, Plus, Search } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { GenerationFolderManagerDialog } from '@/components/generation-folders/GenerationFolderManagerDialog'
import { SceneQueueReviewDialog } from '@/components/queue/SceneQueueReviewDialog'
import { isSceneQueueReviewConflict } from '@/application/scene/scene-queue-review'
import { DEFAULT_R2_PROFILE_ID } from '@/domain/r2/types'
import { useDefaultR2Readiness } from '@/hooks/useDefaultR2Readiness'
import { resolveGenerationFolderAuthority } from '@/lib/generation-folder-authority-runtime'
import { flushSceneAuthorityRuntime } from '@/lib/scene-authority-runtime'
import { getRuntimeSceneRepository } from '@/lib/scene-migration-startup'
import { collectFolderAssets, createFolderAssetPreset, folderAssetProductionCount, parseFolderAssetTable, UNASSIGNED_FOLDER_ID } from '@/presentation/folders/folder-workbench'
import { enqueueReviewedSceneQueue, prepareSceneQueueReview, type PreparedSceneQueueReview, type SceneQueueSubmission } from '@/services/queue/scene-queue-adapter'
import { resolveScenePrompts, useSceneStore } from '@/stores/scene-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useQueueStore } from '@/stores/queue-store'
import { runtimeCapabilities } from '@/platform/capabilities'
import { toNativeAssetUrl } from '@/platform/asset-url'

interface FolderView {
    query: string
    selected: string[]
    view: 'list' | 'grid'
    includeChildren: boolean
    page: number
}

const emptyView = (): FolderView => ({ query: '', selected: [], view: 'list', includeChildren: false, page: 0 })
const PAGE_SIZE = 60
const control = 'min-h-11 !rounded-[4px]'

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
    const setActivePreset = useSceneStore(state => state.setActivePreset)
    const selectBatch = useQueueStore(state => state.setSelectedBatchId)
    const [folderId, setFolderId] = useState<string | null>(activeFolderId || null)
    const [views, setViews] = useState<Record<string, FolderView>>({})
    const scopeKey = folderId ?? '__all__'
    const view = views[scopeKey] ?? emptyView()
    const [folderQuery, setFolderQuery] = useState('')
    const [managerOpen, setManagerOpen] = useState(false)
    const [pasteOpen, setPasteOpen] = useState(false)
    const [paste, setPaste] = useState('')
    const [templateId, setTemplateId] = useState('')
    const [batchCount, setBatchCount] = useState('1')
    const [busy, setBusy] = useState(false)
    const busyRef = useRef(false)
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState<string | null>(null)
    const [queued, setQueued] = useState(false)
    const [prepared, setPrepared] = useState<PreparedSceneQueueReview | null>(null)
    const contentRef = useRef<HTMLDivElement>(null)
    const scrollPositions = useRef<Record<string, number>>({})
    const scrollKey = `${scopeKey}:${view.view}:${view.page}`

    // Session-only position restores are independent of durable folder/prompt data.
    useLayoutEffect(() => {
        if (contentRef.current) contentRef.current.scrollTop = scrollPositions.current[scrollKey] ?? 0
    }, [scrollKey])

    const updateView = (patch: Partial<FolderView>) => setViews(previous => ({
        ...previous,
        [scopeKey]: { ...(previous[scopeKey] ?? emptyView()), ...patch },
    }))
    const selectFolder = (id: string | null) => {
        setFolderId(id)
        if (id !== null && id !== UNASSIGNED_FOLDER_ID) setActiveFolder(id)
        setError(null)
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
    const rows = useMemo(() => collectFolderAssets(presets, folders, folderId, view.includeChildren), [presets, folders, folderId, view.includeChildren])
    const filtered = useMemo(() => {
        const query = view.query.trim().toLocaleLowerCase()
        return rows.filter(row => !query || [row.scene.name, row.presetName, ...Object.values(resolveScenePrompts(row.scene))]
            .join(' ').toLocaleLowerCase().includes(query))
    }, [rows, view.query])
    // Search never broadens execution: only explicitly selected IDs in the current result can run.
    const selectedKeys = new Set(view.selected)
    const selected = filtered.filter(row => selectedKeys.has(row.key))
    const imageCount = selected.reduce((sum, row) => sum + folderAssetProductionCount(row.scene), 0)
    const invalidCount = selected.some(row => !Number.isInteger(folderAssetProductionCount(row.scene)) || folderAssetProductionCount(row.scene) < 1 || folderAssetProductionCount(row.scene) > 999)
    const imageLimit = runtimeCapabilities.generationPublication.generationLimits?.maxJobsPerAtomicBatch ?? null
    const overImageLimit = imageLimit !== null && imageCount > imageLimit
    const executionUnavailable = !runtimeCapabilities.generationPublication.supported
    const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
    const page = Math.min(view.page, pageCount - 1)
    // ponytail: 60 rendered assets per page bounds the 2400-item workbench without a virtualizer dependency.
    const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
    const parsed = useMemo(() => parseFolderAssetTable(paste), [paste])
    const templates = presets.filter(preset => preset.defaultTemplate !== undefined)
    const selectedTemplate = templates.find(preset => preset.id === templateId)?.defaultTemplate
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
    const addAssets = async () => {
        if (busyRef.current || !sceneAuthorityReady || !concreteFolder || parsed.rows.length === 0 || parsed.errors.length > 0 || (templateId && !selectedTemplate)) return
        lock()
        try {
            const preset = createFolderAssetPreset({ name: concreteFolder.name, folderId: concreteFolder.id, rows: parsed.rows, template: selectedTemplate })
            useSceneStore.getState().importPreset(preset)
            // Import assigns a new preset ID; verify that the authority bridge committed this exact set before claiming success.
            const importedId = useSceneStore.getState().activePresetId
            await flushSceneAuthorityRuntime()
            const saved = importedId === null ? null : await getRuntimeSceneRepository().getDocument(importedId)
            const savedIds = new Set(saved?.scenes.map(scene => scene.id))
            if (!saved || preset.scenes.some(scene => !savedIds.has(scene.id))) {
                throw new Error(t('folderWorkbench.saveUnconfirmed', '항목 저장을 확인하지 못했습니다. 현재 폴더와 오류를 확인하세요. 자동으로 다시 추가하지 않습니다.'))
            }
            updateView({ query: '', selected: [], page: 0 })
            setSuccess(t('folderWorkbench.added', '{{count}}개 항목을 추가했습니다. 생성할 항목을 선택하세요.', { count: parsed.rows.length }))
            setQueued(false)
            setPaste('')
            setPasteOpen(false)
        } catch (cause) { reportError(cause) }
        finally { unlock() }
    }

    return (
        <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background [overflow-wrap:anywhere]" data-testid="folder-workbench">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
                <div className="min-w-0">
                    <h1 className="text-xl font-semibold">{t('folderWorkbench.title', '폴더 작업대')}</h1>
                    <p className="text-sm text-muted-foreground">{t('folderWorkbench.description', '폴더에 서로 다른 프롬프트를 모으고, 수량과 저장 위치를 확인해 생성하세요.')}</p>
                </div>
                <nav aria-label={t('folderWorkbench.relatedPages', '작업 페이지')} className="flex flex-wrap gap-2">
                    <Button asChild variant="outline" className={control}><Link to="/queue">{t('folderWorkbench.queue', '대기열')}</Link></Button>
                    <Button asChild variant="outline" className={control}><Link to="/r2">{t('folderWorkbench.r2', 'R2 배포')}</Link></Button>
                </nav>
            </header>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
                <aside className="shrink-0 border-b border-border lg:w-56 lg:overflow-y-auto lg:border-b-0 lg:border-r" aria-label={t('folderWorkbench.folderList', '폴더 목록')}>
                    <div className="space-y-2 p-3">
                        <Input className={control} value={folderQuery} onChange={event => setFolderQuery(event.target.value)} placeholder={t('folderWorkbench.searchFolders', '폴더 검색')} aria-label={t('folderWorkbench.searchFolders', '폴더 검색')} />
                        <Button variant="outline" className={`${control} w-full`} onClick={() => setManagerOpen(true)}><Plus className="mr-2 size-4" aria-hidden="true" />{t('folderWorkbench.manageFolders', '폴더 만들기 · 관리')}</Button>
                    </div>
                    <ul className="max-h-56 overflow-y-auto pb-3 lg:max-h-none">
                        {[{ id: null, name: t('folderWorkbench.allFolders', '모든 폴더') }, { id: UNASSIGNED_FOLDER_ID, name: t('folderWorkbench.unassigned', '폴더 미지정') }].map(row => (
                            <li key={row.id ?? '__all__'}><button type="button" aria-current={folderId === row.id ? 'true' : undefined} onClick={() => selectFolder(row.id)} className={`flex min-h-11 w-full items-center px-4 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${folderId === row.id ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-muted'}`}>{row.name}</button></li>
                        ))}
                        {folderRows.filter(row => row.path.toLocaleLowerCase().includes(folderQuery.trim().toLocaleLowerCase())).map(({ folder, depth, path }) => (
                            <li key={folder.id}><button type="button" title={path} aria-label={path} aria-current={folderId === folder.id ? 'true' : undefined} onClick={() => selectFolder(folder.id)} style={{ paddingLeft: `${16 + Math.min(depth, 6) * 12}px` }} className={`flex min-h-11 w-full min-w-0 items-center gap-2 pr-3 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${folderId === folder.id ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-muted'}`}><Folder className="size-4 shrink-0" aria-hidden="true" /><span className="truncate">{folder.name}</span></button></li>
                        ))}
                    </ul>
                </aside>
                <section className="flex min-h-0 min-w-0 flex-1 flex-col lg:overflow-hidden" aria-label={t('folderWorkbench.assets', '폴더 항목')}>
                    <div className="space-y-3 border-b border-border px-4 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <h2 className="min-w-0 break-words text-lg font-semibold">{scopeName}</h2>
                            <Button className={control} disabled={!concreteFolder || busy || !sceneAuthorityReady} onClick={() => { setError(null); setPasteOpen(true) }}><Plus className="mr-2 size-4" aria-hidden="true" />{t('folderWorkbench.pastePrompts', '여러 프롬프트 붙여넣기')}</Button>
                        </div>
                        {!concreteFolder && <p className="text-sm text-muted-foreground">{t('folderWorkbench.chooseFolderToAdd', '항목을 추가하려면 왼쪽에서 저장할 폴더를 선택하거나 새 폴더를 만드세요.')}</p>}
                        <details className="border-y border-border py-1">
                            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">{t('folderWorkbench.rules', '폴더 규칙 · 저장 및 배포 위치')}</summary>
                            {resolved ? <div className="space-y-3 pb-3 text-sm">
                                <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
                                    <div className="min-w-0"><dt className="text-muted-foreground">{t('folderWorkbench.commonPrompt', '적용되는 공통 프롬프트')}</dt><dd className="whitespace-pre-wrap break-words">{resolved.commonPrompt || t('folderWorkbench.none', '없음')}</dd></div>
                                    <div className="min-w-0"><dt className="text-muted-foreground">{t('folderWorkbench.localPath', '로컬 저장 위치')}</dt><dd className="break-all">{resolved.directory}</dd></div>
                                    <div className="min-w-0"><dt className="text-muted-foreground">{t('folderWorkbench.r2Destination', 'R2 버킷 / 프리픽스')}</dt><dd className="break-all">{resolved.r2.bucket ?? t('folderWorkbench.notConfigured', '설정되지 않음')} / {resolved.r2.prefix}</dd></div>
                                    <div><dt className="text-muted-foreground">{t('folderWorkbench.autoUpload', '생성 후 자동 업로드')}</dt><dd>{resolved.r2.autoUpload ? t('folderWorkbench.enabled', '사용') : t('folderWorkbench.disabled', '사용 안 함')}{resolved.r2.autoUpload && (r2.status !== 'ready' || !profile) && ` · ${t('folderWorkbench.r2NeedsCheck', 'R2 연결 확인 필요')}`}</dd></div>
                                </dl>
                                {profile?.publicBaseUrl && <p className="break-all text-muted-foreground">{t('folderWorkbench.publicBase', '공개 기본 주소')}: {profile.publicBaseUrl}</p>}
                                <p className="text-xs text-muted-foreground">{t('folderWorkbench.exactReview', '하위 폴더와 항목별 규칙은 실행 검토에서 각각 확인합니다. 최종 파일 경로와 URL은 생성 계획에 표시됩니다.')}</p>
                                <Button variant="outline" className={control} onClick={() => setManagerOpen(true)}>{t('folderWorkbench.editRules', '폴더 규칙 편집')}</Button>
                            </div> : <p className="pb-3 text-sm text-muted-foreground">{t('folderWorkbench.chooseFolderForRules', '폴더를 선택하면 적용되는 규칙을 확인할 수 있습니다.')}</p>}
                        </details>
                        <div className="flex flex-wrap items-center gap-2">
                            <div className="relative min-w-0 flex-1 basis-48"><Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted-foreground" aria-hidden="true" /><Input className={`${control} pl-9`} value={view.query} onChange={event => updateView({ query: event.target.value, page: 0 })} aria-label={t('folderWorkbench.searchAssets', '항목 이름 · 프롬프트 검색')} placeholder={t('folderWorkbench.searchAssets', '항목 이름 · 프롬프트 검색')} /></div>
                            <div className="flex" aria-label={t('folderWorkbench.view', '보기 방식')}>
                                <Button variant={view.view === 'list' ? 'secondary' : 'ghost'} size="icon" className={control} aria-pressed={view.view === 'list'} aria-label={t('folderWorkbench.listView', '목록 보기')} onClick={() => updateView({ view: 'list' })}><List className="size-4" aria-hidden="true" /></Button>
                                <Button variant={view.view === 'grid' ? 'secondary' : 'ghost'} size="icon" className={control} aria-pressed={view.view === 'grid'} aria-label={t('folderWorkbench.gridView', '썸네일 보기')} onClick={() => updateView({ view: 'grid' })}><LayoutGrid className="size-4" aria-hidden="true" /></Button>
                            </div>
                            {concreteFolder && <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm"><input type="checkbox" checked={view.includeChildren} onChange={event => updateView({ includeChildren: event.target.checked, page: 0 })} className="size-4 accent-primary" />{t('folderWorkbench.includeChildren', '하위 폴더 포함')}</label>}
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/25 px-4 py-2" aria-label={t('folderWorkbench.selectionActions', '선택 항목 일괄 작업')}>
                        <Button variant="outline" className={control} disabled={filtered.length === 0 || busy} onClick={() => updateView({ selected: filtered.map(row => row.key) })}>{t('folderWorkbench.selectResults', '검색 결과 전체 {{count}}개 선택', { count: filtered.length })}</Button>
                        <Button variant="ghost" className={control} disabled={view.selected.length === 0 || busy} onClick={() => updateView({ selected: [] })}>{t('folderWorkbench.clearSelection', '선택 해제')}</Button>
                        <label className="flex min-h-11 items-center gap-2 text-sm">{t('folderWorkbench.eachCount', '항목당 수량')}<Input type="number" min={1} max={999} value={batchCount} onChange={event => setBatchCount(event.target.value)} className={`${control} w-20`} /></label>
                        <Button variant="outline" className={control} disabled={busy || selected.length === 0 || !Number.isInteger(Number(batchCount)) || Number(batchCount) < 1 || Number(batchCount) > 999} onClick={() => setSceneProductionCounts(selected.map(row => ({ presetId: row.presetId, sceneId: row.scene.id })), Number(batchCount))}>{t('folderWorkbench.applyCount', '선택에 적용')}</Button>
                        <Button className={`${control} sm:ml-auto`} disabled={busy || !sceneAuthorityReady || selected.length === 0 || invalidCount || overImageLimit || executionUnavailable} onClick={() => { void reviewSelection() }}>{busy ? t('folderWorkbench.preparing', '처리 중…') : t('folderWorkbench.reviewGenerate', '선택 {{count}}장 생성 검토', { count: imageCount })}</Button>
                    </div>
                    <div className="space-y-1 border-b border-border px-4 py-2 text-sm" aria-live="polite">
                        <p>{scopeName} · {concreteFolder ? (view.includeChildren ? t('folderWorkbench.scopeDescendants', '하위 폴더 포함') : t('folderWorkbench.scopeFolder', '이 폴더')) : t('folderWorkbench.scopeAll', '현재 범위')} · {t('folderWorkbench.scopeSummary', '검색 결과 {{results}}개 중 선택 {{selected}}개 · 총 {{images}}장', { results: filtered.length, selected: selected.length, images: imageCount })}</p>
                        {view.selected.length > selected.length && <p className="text-muted-foreground">{t('folderWorkbench.hiddenSelection', '현재 검색 밖의 선택 항목은 생성 대상에서 제외됩니다.')}</p>}
                        {invalidCount && <p className="text-destructive">{t('folderWorkbench.positiveCount', '선택한 모든 항목의 수량을 1~999로 설정하세요.')}</p>}
                        {overImageLimit && <p className="text-destructive">{t('folderWorkbench.imageLimit', '현재 한 번에 {{count}}장까지 실행할 수 있습니다. 선택 항목이나 수량을 줄여 주세요.', { count: imageLimit })}</p>}
                        {executionUnavailable && <p className="text-muted-foreground">{t('folderWorkbench.desktopExecution', '생성 실행은 Windows 데스크톱 앱에서 지원합니다. 여기서는 항목과 폴더를 정리할 수 있습니다.')}</p>}
                        {!sceneAuthorityReady && <p className="text-muted-foreground">{t('folderWorkbench.loadingAuthority', '저장된 항목을 불러오는 중입니다. 준비되면 추가와 생성을 사용할 수 있습니다.')}</p>}
                        {error && <p role="alert" className="break-words text-destructive">{error}</p>}
                        {success && <p className="break-words">{success} {queued && <Link className="inline-flex min-h-11 items-center text-primary underline" to="/queue">{t('folderWorkbench.openQueue', '대기열에서 확인')}</Link>}</p>}
                    </div>
                    <div ref={contentRef} onScroll={event => { scrollPositions.current[scrollKey] = event.currentTarget.scrollTop }} className="min-h-48 min-w-0 flex-1 overflow-y-auto" aria-label={t('folderWorkbench.assets', '폴더 항목')}>
                        {pageRows.length === 0 ? <div className="space-y-3 px-4 py-12 text-center"><p className="font-medium">{rows.length === 0 ? t('folderWorkbench.emptyFolder', '아직 항목이 없습니다') : t('folderWorkbench.noResults', '검색 결과가 없습니다')}</p><p className="text-sm text-muted-foreground">{rows.length === 0 ? t('folderWorkbench.emptyHint', '이름과 서로 다른 프롬프트를 표에서 복사해 한 번에 추가하세요.') : t('folderWorkbench.searchHint', '다른 이름이나 프롬프트로 검색하세요.')}</p></div> : <ul className={view.view === 'grid' ? 'grid grid-cols-1 gap-px bg-border sm:grid-cols-2 xl:grid-cols-3' : 'divide-y divide-border'}>
                            {pageRows.map(row => {
                                const prompt = resolveScenePrompts(row.scene).additional
                                const lastImage = row.scene.images[row.scene.images.length - 1]
                                // Scene result projections contain native paths; use the same adapter as the existing Scene editor.
                                const imageUrl = !lastImage || lastImage.url.startsWith('data:') ? lastImage?.url : toNativeAssetUrl(lastImage.url)
                                return <li key={row.key} data-preset-id={row.presetId} data-scene-id={row.scene.id} className={`min-w-0 bg-background p-3 ${view.view === 'list' ? 'flex flex-wrap items-center gap-3' : 'space-y-2'} ${selectedKeys.has(row.key) ? '!bg-primary/5' : ''}`}>
                                    <div className={`flex items-center gap-2 ${view.view === 'grid' ? 'justify-between' : ''}`}>
                                        <label className="flex size-11 shrink-0 cursor-pointer items-center justify-center"><input type="checkbox" aria-label={t('folderWorkbench.selectAsset', '{{name}} 선택', { name: row.scene.name })} checked={selectedKeys.has(row.key)} disabled={busy} onChange={event => updateView({ selected: event.target.checked ? [...view.selected, row.key] : view.selected.filter(key => key !== row.key) })} className="size-4 accent-primary" /></label>
                                        {view.view === 'grid' && <span className="min-w-0 truncate text-xs text-muted-foreground">{row.presetName}</span>}
                                    </div>
                                    <div className={`flex shrink-0 items-center justify-center overflow-hidden bg-muted text-xs text-muted-foreground ${view.view === 'grid' ? 'aspect-square w-full' : 'size-14'}`}>
                                        {imageUrl ? <img src={imageUrl} alt={t('folderWorkbench.latestImage', '{{name}} 최근 생성 이미지', { name: row.scene.name })} loading="lazy" className="h-full w-full object-contain" /> : <ImageIcon className="size-5" aria-label={t('folderWorkbench.noImage', '이미지 없음')} />}
                                    </div>
                                    <div className="min-w-0 flex-1 basis-32"><p className="break-words font-medium">{row.scene.name}</p><p className="line-clamp-2 break-words text-sm text-muted-foreground" title={prompt}>{prompt || t('folderWorkbench.emptyPrompt', '추가 프롬프트 없음')}</p><p className="truncate text-xs text-muted-foreground">{row.presetName} · {t('folderWorkbench.generatedCount', '생성 {{count}}장', { count: row.scene.images.length })}</p></div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <label className="flex min-h-11 items-center gap-2 text-sm"><span>{t('folderWorkbench.count', '수량')}</span><Input className={`${control} w-20`} type="number" min={1} max={999} value={folderAssetProductionCount(row.scene)} disabled={busy} aria-label={t('folderWorkbench.assetCount', '{{name}} 생성 수량', { name: row.scene.name })} onChange={event => { const count = Number(event.target.value); if (Number.isInteger(count) && count >= 1 && count <= 999) setSceneProductionCounts([{ presetId: row.presetId, sceneId: row.scene.id }], count) }} /></label>
                                        <Button asChild variant="ghost" className={control}><Link to={`/scenes/${row.scene.id}`} aria-label={t('folderWorkbench.editAsset', '{{name}} 프롬프트 편집', { name: row.scene.name })} onClick={() => setActivePreset(row.presetId)}>{t('folderWorkbench.edit', '편집')}</Link></Button>
                                    </div>
                                </li>
                            })}
                        </ul>}
                    </div>
                    <nav className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2" aria-label={t('folderWorkbench.pagination', '항목 페이지')}>
                        <p className="text-sm text-muted-foreground">{t('folderWorkbench.pageSummary', '{{page}} / {{pages}} 페이지 · 페이지당 {{size}}개', { page: page + 1, pages: pageCount, size: PAGE_SIZE })}</p>
                        <div className="flex gap-2"><Button variant="outline" className={control} disabled={page === 0} onClick={() => updateView({ page: page - 1 })}>{t('folderWorkbench.previous', '이전')}</Button><Button variant="outline" className={control} disabled={page + 1 >= pageCount} onClick={() => updateView({ page: page + 1 })}>{t('folderWorkbench.next', '다음')}</Button></div>
                    </nav>
                </section>
            </div>
            <GenerationFolderManagerDialog open={managerOpen} onOpenChange={setManagerOpen} initialFolderId={concreteFolder?.id} onSaved={selectFolder} />
            <Dialog open={pasteOpen} onOpenChange={open => { if (!busyRef.current) setPasteOpen(open) }}>
                <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto rounded-none">
                    <DialogHeader><DialogTitle>{t('folderWorkbench.pastePrompts', '여러 프롬프트 붙여넣기')}</DialogTitle><DialogDescription>{t('folderWorkbench.pasteDescription', '엑셀에서 이름 · 프롬프트 · 수량 열을 복사하세요. 각 행이 서로 다른 항목이 됩니다. 수량을 생략하면 1장입니다. 최대 2,400개.')}</DialogDescription></DialogHeader>
                    <p className="break-words text-sm">{t('folderWorkbench.addDestination', '추가할 폴더')}: <strong>{scopeName}</strong></p>
                    <label className="space-y-1 text-sm"><span>{t('folderWorkbench.generationTemplate', '기존 생성 프리셋')}</span><select className={`${control} w-full min-w-0 border border-input bg-background px-3`} value={templateId} onChange={event => setTemplateId(event.target.value)}><option value="">{t('folderWorkbench.defaultTemplate', '기본 생성 설정')}</option>{templates.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label>
                    <p className="text-xs text-muted-foreground">{t('folderWorkbench.templateCopy', '저장된 폴더 기본 설정을 한 번 복사하고, 각 행의 프롬프트를 항목별 추가 프롬프트로 사용합니다.')}</p>
                    <p className="text-xs text-muted-foreground">{t('folderWorkbench.filenameHelp', '파일명 예: {scene.name}_{seed}. {scene.name}, {scene.id}, {preset.name}, {seed}를 쓸 수 있습니다. 확장자는 출력 형식에 맞춰 붙습니다.')}</p>
                    <label className="space-y-1 text-sm"><span>{t('folderWorkbench.tableInput', '이름 ↹ 프롬프트 ↹ 수량 ↹ 파일명 템플릿(선택)')}</span><textarea className="min-h-44 w-full min-w-0 rounded-[4px] border border-input bg-background p-3 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={paste} onChange={event => setPaste(event.target.value)} placeholder={'happy\tsmile, looking at viewer\t3\nsad\ttears, looking down\t2\nsurprised\twide eyes, open mouth\t1'} spellCheck={false} /></label>
                    <div aria-live="polite" className="space-y-2 text-sm">
                        <p>{t('folderWorkbench.pasteSummary', '{{items}}개 항목 · 총 {{images}}장', { items: parsed.rows.length, images: parsed.rows.reduce((sum, row) => sum + row.count, 0) })}</p>
                        {parsed.errors.length > 0 && <div role="alert" className="text-destructive"><p>{t('folderWorkbench.pasteErrors', '{{count}}개 오류를 수정한 뒤 추가하세요.', { count: parsed.errors.length })}</p><ul>{parsed.errors.slice(0, 5).map((issue, index) => <li key={`${issue.line}:${index}`}>{t('folderWorkbench.errorLine', '{{line}}행', { line: issue.line })}: {t(`folderWorkbench.pasteError.${issue.code}`, { columns: '탭으로 구분된 이름과 프롬프트가 필요합니다.', name: '이름을 입력하세요.', prompt: '프롬프트를 입력하세요.', count: '수량은 1~999 정수로 입력하세요.', limit: '한 번에 2,400개까지 추가할 수 있습니다.' }[issue.code])}</li>)}</ul></div>}
                        {parsed.rows.length > 0 && <div className="border-y border-border py-2"><p className="mb-2 font-medium">{t('folderWorkbench.pastePreview', '추가 전 확인 · 처음 5개')}</p><ol className="space-y-2">{parsed.rows.slice(0, 5).map((row, index) => <li key={index} className="min-w-0"><p className="break-words font-medium">{row.name} · {row.count}{t('folderWorkbench.imageUnit', '장')}</p><p className="line-clamp-2 break-words text-muted-foreground">{row.prompt}</p>{row.filenameTemplate && <p className="break-all text-xs text-muted-foreground">{row.filenameTemplate}</p>}</li>)}</ol></div>}
                        {error && <p role="alert" className="break-words text-destructive">{error}</p>}
                    </div>
                    <DialogFooter><Button variant="outline" className={control} disabled={busy} onClick={() => setPasteOpen(false)}>{t('folderWorkbench.cancel', '취소')}</Button><Button className={control} disabled={busy || !sceneAuthorityReady || !concreteFolder || parsed.rows.length === 0 || parsed.errors.length > 0 || (!!templateId && !selectedTemplate)} onClick={() => { void addAssets() }}>{t('folderWorkbench.addItems', '항목 {{count}}개 추가', { count: parsed.rows.length })}</Button></DialogFooter>
                </DialogContent>
            </Dialog>
            {prepared && <SceneQueueReviewDialog open={true} onOpenChange={open => { if (!open) setPrepared(null) }} prepared={prepared} busy={busy} error={error} onApprove={approve} onReplan={reviewSelection} />}
        </div>
    )
}
