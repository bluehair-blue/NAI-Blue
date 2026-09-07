import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Folder, ImageIcon, LayoutGrid, List, Plus, Search } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FolderAssetComposer } from '@/components/folders/FolderAssetComposer'
import { GenerationFolderManagerDialog } from '@/components/generation-folders/GenerationFolderManagerDialog'
import { SceneQueueReviewDialog } from '@/components/queue/SceneQueueReviewDialog'
import { isSceneQueueReviewConflict } from '@/application/scene/scene-queue-review'
import { DEFAULT_R2_PROFILE_ID } from '@/domain/r2/types'
import { useDefaultR2Readiness } from '@/hooks/useDefaultR2Readiness'
import { resolveGenerationFolderAuthority } from '@/lib/generation-folder-authority-runtime'
import { flushSceneAuthorityRuntime } from '@/lib/scene-authority-runtime'
import { getRuntimeSceneRepository } from '@/lib/scene-migration-startup'
import { collectFolderAssets, createFolderAssetPreset, folderAssetProductionCount, type FolderAssetInput, UNASSIGNED_FOLDER_ID } from '@/presentation/folders/folder-workbench'
import { enqueueReviewedSceneQueue, prepareSceneQueueReview, type PreparedSceneQueueReview, type SceneQueueSubmission } from '@/services/queue/scene-queue-adapter'
import { resolveScenePrompts, type SceneFolderTemplate, useSceneStore } from '@/stores/scene-store'
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
    const [composerOpen, setComposerOpen] = useState(false)
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
        setSuccess(null)
        setQueued(false)
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
            updateView({ query: '', selected: preset.scenes.map(scene => JSON.stringify([importedId, scene.id])), page: 0 })
            setSuccess(t('folderWorkbench.start.saved', '{{count}}개 에셋을 추가하고 선택했습니다.', { count: inputs.length }))
            setQueued(false)
            setComposerOpen(false)
            contentRef.current?.scrollTo({ top: 0 })
            return true
        } catch (cause) { reportError(cause); return false }
        finally { unlock() }
    }

    const currentStep = queued ? 3 : rows.length > 0 ? 2 : 1
    const steps = [
        t('folderWorkbench.start.stepPrompt', '프롬프트 입력'),
        t('folderWorkbench.start.stepReview', '수량·저장 확인'),
        t('folderWorkbench.start.stepGenerate', '생성'),
    ]
    const composer = <FolderAssetComposer busy={busy} disabled={!sceneAuthorityReady || !concreteFolder}
        error={error} templates={templates} onSubmit={addAssets} />

    return (
        <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background [overflow-wrap:anywhere]" data-testid="folder-workbench">
            <header className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3 border-b border-border px-4 py-4 sm:px-6">
                <div className={rows.length > 0 ? 'sr-only' : 'min-w-0'}>
                    <h1 className="text-xl font-semibold">{t('folderWorkbench.start.title', '에셋 만들기')}</h1>
                    <p className="mt-1 text-sm text-muted-foreground">{t('folderWorkbench.start.description', '서로 다른 프롬프트도, 원하는 수량만큼 한 번에.')}</p>
                </div>
                <ol className="flex flex-wrap gap-x-5 gap-y-2 text-xs sm:text-sm" aria-label={t('folderWorkbench.start.steps', '에셋 제작 순서')}>
                    {steps.map((step, index) => <li key={step} aria-current={currentStep === index + 1 ? 'step' : undefined}
                        className={`flex items-center gap-2 ${currentStep === index + 1 ? 'font-semibold text-primary' : 'text-muted-foreground'}`}>
                        <span className={`flex size-6 items-center justify-center rounded-full border ${currentStep === index + 1 ? 'border-primary bg-primary/10' : 'border-border'}`}>{index + 1}</span>{step}
                    </li>)}
                </ol>
            </header>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row">
                <aside className="shrink-0 border-b border-border bg-muted/10 lg:w-52 lg:overflow-y-auto lg:border-b-0 lg:border-r" aria-label={t('folderWorkbench.folderList', '폴더 목록')}>
                    <div className="flex items-center gap-2 px-4 py-2 lg:hidden">
                        <label htmlFor="workbench-folder" className="shrink-0 text-sm text-muted-foreground">{t('folderWorkbench.start.folder', '작업 폴더')}</label>
                        <select id="workbench-folder" aria-label={t('folderWorkbench.start.chooseFolder', '작업 폴더 선택')}
                            className={`${control} min-w-0 flex-1 border border-input bg-background px-2 text-sm`}
                            value={scopeKey} onChange={event => selectFolder(event.target.value === '__all__' ? null : event.target.value)}>
                            {folderRows.map(({ folder, path }) => <option key={folder.id} value={folder.id}>{path}</option>)}
                            <option value="__all__">{t('folderWorkbench.allFolders', '모든 폴더')}</option>
                            <option value={UNASSIGNED_FOLDER_ID}>{t('folderWorkbench.unassigned', '폴더 미지정')}</option>
                        </select>
                        <Button variant="ghost" className={control} onClick={() => setManagerOpen(true)}>{t('folderWorkbench.start.manage', '관리')}</Button>
                    </div>
                    <div className="hidden lg:block">
                        <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-4">
                            <h2 className="text-sm font-medium text-muted-foreground">{t('folderWorkbench.start.folder', '작업 폴더')}</h2>
                            <Button variant="ghost" className={`${control} px-2 text-xs`} onClick={() => setManagerOpen(true)}>{t('folderWorkbench.start.manage', '관리')}</Button>
                        </div>
                        {folderRows.length > 6 && <div className="px-3 pb-3"><Input className={control} value={folderQuery} onChange={event => setFolderQuery(event.target.value)} placeholder={t('folderWorkbench.searchFolders', '폴더 검색')} aria-label={t('folderWorkbench.searchFolders', '폴더 검색')} /></div>}
                        <ul className="pb-4">
                            {folderRows.filter(row => row.path.toLocaleLowerCase().includes(folderQuery.trim().toLocaleLowerCase())).map(({ folder, depth, path }) => (
                                <li key={folder.id}><button type="button" title={path} aria-label={path} aria-current={folderId === folder.id ? 'true' : undefined} onClick={() => selectFolder(folder.id)} style={{ paddingLeft: `${16 + Math.min(depth, 6) * 12}px` }} className={`flex min-h-11 w-full min-w-0 items-center gap-2 pr-3 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${folderId === folder.id ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-muted'}`}><Folder className="size-4 shrink-0" aria-hidden="true" /><span className="truncate">{folder.name}</span></button></li>
                            ))}
                        </ul>
                        <ul className="border-t border-border/60 py-2">
                            {[{ id: null, name: t('folderWorkbench.allFolders', '모든 폴더') }, { id: UNASSIGNED_FOLDER_ID, name: t('folderWorkbench.unassigned', '폴더 미지정') }].map(row => (
                                <li key={row.id ?? '__all__'}><button type="button" aria-current={folderId === row.id ? 'true' : undefined} onClick={() => selectFolder(row.id)} className={`flex min-h-11 w-full items-center px-4 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${folderId === row.id ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-muted'}`}>{row.name}</button></li>
                            ))}
                        </ul>
                    </div>
                </aside>
                <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t('folderWorkbench.assets', '폴더 항목')}>
                    <div ref={contentRef} onScroll={event => { scrollPositions.current[scrollKey] = event.currentTarget.scrollTop }} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
                        {rows.length === 0 ? <div className="mx-auto max-w-3xl px-4 py-6 sm:px-8 sm:py-10">
                            <div className="mb-6">
                                <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">{t('folderWorkbench.start.emptyTitle', '어떤 이미지를 만들까요?')}</h2>
                                <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">{t('folderWorkbench.start.emptyDescription', '프롬프트 하나가 에셋 하나가 됩니다. 다른 이미지도 아래에 이어서 추가하세요.')}</p>
                            </div>
                            {concreteFolder ? composer : <p className="border-l-2 border-primary py-3 pl-4 text-sm">{t('folderWorkbench.start.noFolderMobile', '작업 폴더를 선택하면 프롬프트를 추가할 수 있습니다.')}</p>}
                        </div> : <>
                            <div className="space-y-4 px-4 pb-4 pt-6 sm:px-6">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <h2 className="text-xl font-semibold">{t('folderWorkbench.start.reviewTitle', '생성할 에셋')}</h2>
                                        <p className="mt-1 text-sm text-muted-foreground">{scopeName} · {t('folderWorkbench.start.ready', '선택 {{items}}개 · 총 {{images}}장', { items: selected.length, images: imageCount })}</p>
                                    </div>
                                    {concreteFolder && <Button variant="outline" className={control} disabled={busy || !sceneAuthorityReady} onClick={() => { setError(null); setComposerOpen(true) }}><Plus className="mr-2 size-4" aria-hidden="true" />{t('folderWorkbench.start.addMore', '에셋 추가')}</Button>}
                                </div>
                                {error && !composerOpen && <p role="alert" className="text-sm text-destructive">{error}</p>}
                                {success && <p role="status" className={queued ? 'text-sm text-primary' : 'sr-only'}>{success} {queued && <Link className="underline" to="/queue">{t('folderWorkbench.openQueue', '대기열에서 확인')}</Link>}</p>}
                                <details className="border-y border-border text-sm">
                                    <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 py-2">
                                        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                                        <span className="font-medium">{t('folderWorkbench.start.storage', '저장 위치')}</span>
                                        <span className="min-w-0 break-all text-muted-foreground">{resolved?.directory ?? scopeName}</span>
                                        {resolved?.r2.autoUpload && <span className="text-xs text-muted-foreground">{t('folderWorkbench.start.uploadAfter', '생성 후 자동 업로드')}</span>}
                                    </summary>
                                    {resolved ? <div className="space-y-3 pb-2">
                                        <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
                                            <div className="min-w-0"><dt className="text-muted-foreground">{t('folderWorkbench.commonPrompt', '적용되는 공통 프롬프트')}</dt><dd className="whitespace-pre-wrap break-words">{resolved.commonPrompt || t('folderWorkbench.none', '없음')}</dd></div>
                                            <div className="min-w-0"><dt className="text-muted-foreground">{t('folderWorkbench.r2Destination', 'R2 버킷 / 프리픽스')}</dt><dd className="break-all">{resolved.r2.bucket ?? t('folderWorkbench.notConfigured', '설정되지 않음')} / {resolved.r2.prefix}</dd></div>
                                            <div><dt className="text-muted-foreground">{t('folderWorkbench.autoUpload', '생성 후 자동 업로드')}</dt><dd>{resolved.r2.autoUpload ? t('folderWorkbench.enabled', '사용') : t('folderWorkbench.disabled', '사용 안 함')}{resolved.r2.autoUpload && (r2.status !== 'ready' || !profile) && ` · ${t('folderWorkbench.r2NeedsCheck', 'R2 연결 확인 필요')}`}</dd></div>
                                        </dl>
                                        <p className="text-xs text-muted-foreground">{t('folderWorkbench.start.storageHint', '파일별 이름과 최종 경로는 생성 전에 한 번 더 확인합니다.')}</p>
                                        <Button variant="outline" className={control} onClick={() => setManagerOpen(true)}>{t('folderWorkbench.editRules', '폴더 규칙 편집')}</Button>
                                    </div> : <p className="pb-3 text-muted-foreground">{t('folderWorkbench.chooseFolderForRules', '폴더를 선택하면 적용되는 규칙을 확인할 수 있습니다.')}</p>}
                                </details>
                                <details>
                                    <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-muted-foreground"><ChevronDown className="size-4" aria-hidden="true" />{t('folderWorkbench.start.searchTools', '검색과 일괄 편집')}</summary>
                                    <div className="space-y-3 pb-2">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <div className="relative min-w-0 flex-1 basis-48"><Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted-foreground" aria-hidden="true" /><Input className={`${control} pl-9`} value={view.query} onChange={event => updateView({ query: event.target.value, page: 0 })} placeholder={t('folderWorkbench.searchAssets', '항목 이름 · 프롬프트 검색')} aria-label={t('folderWorkbench.searchAssets', '항목 이름 · 프롬프트 검색')} /></div>
                                            <div className="flex shrink-0 gap-1" role="group" aria-label={t('folderWorkbench.viewMode', '보기 방식')}>
                                                <Button variant={view.view === 'list' ? 'secondary' : 'ghost'} size="icon" className={control} aria-pressed={view.view === 'list'} aria-label={t('folderWorkbench.listView', '목록 보기')} onClick={() => updateView({ view: 'list' })}><List className="size-4" aria-hidden="true" /></Button>
                                                <Button variant={view.view === 'grid' ? 'secondary' : 'ghost'} size="icon" className={control} aria-pressed={view.view === 'grid'} aria-label={t('folderWorkbench.gridView', '썸네일 보기')} onClick={() => updateView({ view: 'grid' })}><LayoutGrid className="size-4" aria-hidden="true" /></Button>
                                            </div>
                                            {concreteFolder && folders.some(folder => folder.parentId === concreteFolder.id) && <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm"><input type="checkbox" checked={view.includeChildren} onChange={event => updateView({ includeChildren: event.target.checked, page: 0 })} className="size-4 accent-primary" />{t('folderWorkbench.includeChildren', '하위 폴더 포함')}</label>}
                                        </div>
                                        <div className="flex flex-wrap items-center gap-2" aria-label={t('folderWorkbench.selectionActions', '선택 항목 일괄 작업')}>
                                            <Button variant="outline" className={control} disabled={filtered.length === 0 || busy} onClick={() => updateView({ selected: filtered.map(row => row.key) })}>{t('folderWorkbench.selectResults', '검색 결과 전체 {{count}}개 선택', { count: filtered.length })}</Button>
                                            {selected.length > 0 && <Button variant="ghost" className={control} disabled={busy} onClick={() => updateView({ selected: [] })}>{t('folderWorkbench.clearSelection', '선택 해제')}</Button>}
                                            {selected.length > 1 && <details className="basis-full border-l-2 border-border pl-3">
                                                <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-muted-foreground"><ChevronDown className="size-4" aria-hidden="true" />{t('folderWorkbench.start.batchEdit', '수량 한꺼번에 바꾸기')}</summary>
                                                <div className="flex flex-wrap items-center gap-2 pb-2">
                                                    <label className="flex min-h-11 items-center gap-2 text-sm">{t('folderWorkbench.eachCount', '항목당 수량')}<Input type="number" min={1} max={999} value={batchCount} onChange={event => setBatchCount(event.target.value)} className={`${control} w-20`} /></label>
                                                    <Button variant="outline" className={control} disabled={busy || !Number.isInteger(Number(batchCount)) || Number(batchCount) < 1 || Number(batchCount) > 999} onClick={() => setSceneProductionCounts(selected.map(row => ({ presetId: row.presetId, sceneId: row.scene.id })), Number(batchCount))}>{t('folderWorkbench.applyCount', '선택에 적용')}</Button>
                                                </div>
                                            </details>}
                                        </div>
                                    </div>
                                </details>
                            </div>
                            {pageRows.length === 0 ? <div className="space-y-3 px-4 py-12 text-center"><p className="font-medium">{t('folderWorkbench.noResults', '검색 결과가 없습니다')}</p><p className="text-sm text-muted-foreground">{t('folderWorkbench.searchHint', '다른 이름이나 프롬프트로 검색하세요.')}</p></div> : <ul className={view.view === 'grid' ? 'grid grid-cols-1 gap-px bg-border sm:grid-cols-2 xl:grid-cols-3' : 'divide-y divide-border border-t border-border'}>
                                {pageRows.map(row => {
                                    const prompt = resolveScenePrompts(row.scene).additional
                                    const lastImage = row.scene.images[row.scene.images.length - 1]
                                    const imageUrl = !lastImage || lastImage.url.startsWith('data:') ? lastImage?.url : toNativeAssetUrl(lastImage.url)
                                    return <li key={row.key} data-preset-id={row.presetId} data-scene-id={row.scene.id} className={`min-w-0 bg-background p-4 sm:px-6 ${view.view === 'list' ? 'flex flex-wrap items-center gap-3' : 'space-y-2'} ${selectedKeys.has(row.key) ? '!bg-primary/5' : ''}`}>
                                        <label className="flex size-11 shrink-0 cursor-pointer items-center justify-center"><input type="checkbox" aria-label={t('folderWorkbench.selectAsset', '{{name}} 선택', { name: row.scene.name })} checked={selectedKeys.has(row.key)} disabled={busy} onChange={event => updateView({ selected: event.target.checked ? [...view.selected, row.key] : view.selected.filter(key => key !== row.key) })} className="size-4 accent-primary" /></label>
                                        {(imageUrl || view.view === 'grid') && <div className={`flex shrink-0 items-center justify-center overflow-hidden bg-muted text-xs text-muted-foreground ${view.view === 'grid' ? 'aspect-square w-full' : 'size-14'}`}>
                                            {imageUrl ? <img src={imageUrl} alt={t('folderWorkbench.latestImage', '{{name}} 최근 생성 이미지', { name: row.scene.name })} loading="lazy" className="h-full w-full object-contain" /> : <ImageIcon className="size-5" aria-label={t('folderWorkbench.noImage', '이미지 없음')} />}
                                        </div>}
                                        <div className="min-w-0 flex-1 basis-32"><p className="break-words font-medium">{row.scene.name}</p><p className="mt-1 line-clamp-2 break-words text-sm text-muted-foreground" title={prompt}>{prompt || t('folderWorkbench.emptyPrompt', '추가 프롬프트 없음')}</p>{row.scene.images.length > 0 && <p className="mt-1 text-xs text-muted-foreground">{t('folderWorkbench.generatedCount', '생성 {{count}}장', { count: row.scene.images.length })}</p>}</div>
                                        <div className="flex flex-wrap items-center gap-2">
                                            <label className="flex min-h-11 items-center gap-2 text-sm"><span>{t('folderWorkbench.count', '수량')}</span><Input className={`${control} w-20`} type="number" min={1} max={999} value={folderAssetProductionCount(row.scene)} disabled={busy} aria-label={t('folderWorkbench.assetCount', '{{name}} 생성 수량', { name: row.scene.name })} onChange={event => { const count = Number(event.target.value); if (Number.isInteger(count) && count >= 1 && count <= 999) setSceneProductionCounts([{ presetId: row.presetId, sceneId: row.scene.id }], count) }} /></label>
                                            <Button asChild variant="ghost" className={control}><Link to={`/scenes/${row.scene.id}`} aria-label={t('folderWorkbench.editAsset', '{{name}} 프롬프트 편집', { name: row.scene.name })} onClick={() => setActivePreset(row.presetId)}>{t('folderWorkbench.edit', '편집')}</Link></Button>
                                        </div>
                                    </li>
                                })}
                            </ul>}
                            {pageCount > 1 && <nav className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3" aria-label={t('folderWorkbench.pagination', '항목 페이지')}>
                                <p className="text-sm text-muted-foreground">{t('folderWorkbench.pageSummary', '{{page}} / {{pages}} 페이지 · 페이지당 {{size}}개', { page: page + 1, pages: pageCount, size: PAGE_SIZE })}</p>
                                <div className="flex gap-2"><Button variant="outline" className={control} disabled={page === 0} onClick={() => updateView({ page: page - 1 })}>{t('folderWorkbench.previous', '이전')}</Button><Button variant="outline" className={control} disabled={page + 1 >= pageCount} onClick={() => updateView({ page: page + 1 })}>{t('folderWorkbench.next', '다음')}</Button></div>
                            </nav>}
                        </>}
                        {!sceneAuthorityReady && <p role="status" className="px-4 py-3 text-sm text-muted-foreground">{t('folderWorkbench.loadingAuthority', '저장된 항목을 불러오는 중입니다. 준비되면 추가와 생성을 사용할 수 있습니다.')}</p>}
                    </div>
                    {rows.length > 0 && <footer className="shrink-0 space-y-2 border-t border-border bg-card px-4 py-3 sm:px-6" aria-live="polite">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <p className="text-sm font-medium">{selected.length === 0 ? t('folderWorkbench.start.selectHint', '생성할 에셋을 선택하세요.') : t('folderWorkbench.start.ready', '선택 {{items}}개 · 총 {{images}}장', { items: selected.length, images: imageCount })}</p>
                            <Button className={`${control} w-full sm:w-auto`} disabled={busy || !sceneAuthorityReady || selected.length === 0 || invalidCount || overImageLimit || executionUnavailable} onClick={() => { void reviewSelection() }}>{busy ? t('folderWorkbench.preparing', '처리 중…') : t('folderWorkbench.start.generate', '{{count}}장 생성 전 확인', { count: imageCount })}</Button>
                        </div>
                        <p className="sr-only">{t('folderWorkbench.scopeSummary', '검색 결과 {{results}}개 중 선택 {{selected}}개 · 총 {{images}}장', { results: filtered.length, selected: selected.length, images: imageCount })}</p>
                        {view.selected.length > selected.length && <p className="text-xs text-muted-foreground">{t('folderWorkbench.hiddenSelection', '현재 검색 밖의 선택 항목은 생성 대상에서 제외됩니다.')}</p>}
                        {invalidCount && <p className="text-xs text-destructive">{t('folderWorkbench.positiveCount', '선택한 모든 항목의 수량을 1~999로 설정하세요.')}</p>}
                        {overImageLimit && <p className="text-xs text-destructive">{t('folderWorkbench.imageLimit', '현재 한 번에 {{count}}장까지 실행할 수 있습니다. 선택 항목이나 수량을 줄여 주세요.', { count: imageLimit })}</p>}
                        {executionUnavailable && <p className="text-xs text-muted-foreground">{t('folderWorkbench.desktopExecution', '생성 실행은 Windows 데스크톱 앱에서 지원합니다. 여기서는 항목과 폴더를 정리할 수 있습니다.')}</p>}
                    </footer>}
                </section>
            </div>
            <GenerationFolderManagerDialog open={managerOpen} onOpenChange={setManagerOpen} initialFolderId={concreteFolder?.id} onSaved={selectFolder} />
            <Dialog open={composerOpen} onOpenChange={open => { if (!busyRef.current) setComposerOpen(open) }}>
                <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto rounded-none">
                    <DialogHeader><DialogTitle>{t('folderWorkbench.start.addMore', '에셋 추가')}</DialogTitle><DialogDescription>{t('folderWorkbench.addDestination', '추가할 폴더')}: {scopeName}</DialogDescription></DialogHeader>
                    {composer}
                </DialogContent>
            </Dialog>
            {prepared && <SceneQueueReviewDialog open={true} onOpenChange={open => { if (!open) setPrepared(null) }} prepared={prepared} busy={busy} error={error} onApprove={approve} onReplan={reviewSelection} />}
        </div>
    )
}
