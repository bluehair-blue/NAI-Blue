import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router'
import { openNativePath } from '@/platform/native-shell'
import QRCode from 'qrcode'
import jsQR from 'jsqr'
import {
    ArrowRight,
    Bot,
    Cable,
    Camera,
    Check,
    CircleAlert,
    CircleCheck,
    ClipboardCopy,
    DatabaseZap,
    FileJson,
    FileSpreadsheet,
    FolderOpen,
    ImageIcon,
    KeyRound,
    LoaderCircle,
    Link2,
    Monitor,
    RefreshCw,
    ScanSearch,
    ShieldCheck,
    Smartphone,
    Unplug,
    Upload,
    Wifi,
    WifiOff,
    X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils'
import { exportTextFile } from '@/platform/export-text-file'
import { runtimeCapabilities } from '@/platform/capabilities'
import { AgentCommandPanel } from '@/presentation/agent/AgentCommandPanel'
import { getRuntimePlatform, isAndroidRuntime, isDesktopRuntime } from '@/platform/runtime'
import {
    getAgentWorkspaceAbsolutePath,
    getAgentWorkspaceBridgeStatus,
    refreshAgentWorkspaceSnapshot,
    subscribeAgentWorkspaceBridge,
} from '@/services/agent/agent-workspace-runtime'
import {
    MAX_METADATA_BATCH_FILES,
    metadataBatchSummary,
    readMetadataBatch,
    serializeMetadataBatchCsv,
    serializeMetadataBatchJson,
    type MetadataBatchItem,
    type MetadataBatchProgress,
    type MetadataBatchStatus,
} from '@/services/metadata/batch-metadata-reader'
import { getLanSessionRuntime } from '@/services/sync/lan-session-runtime'

function formatBytes(bytes: number): string {
    if (bytes < 1_024) return `${bytes} B`
    if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`
    return `${(bytes / 1_048_576).toFixed(1)} MB`
}

function StatusMark({ status }: { status: MetadataBatchStatus }) {
    if (status === 'found') return <CircleCheck className="h-4 w-4 text-success" aria-hidden="true" />
    if (status === 'empty') return <CircleAlert className="h-4 w-4 text-warning" aria-hidden="true" />
    return <CircleAlert className="h-4 w-4 text-destructive" aria-hidden="true" />
}

function DetailValue({ label, value, mono = false }: { label: string; value: unknown; mono?: boolean }) {
    if (value === undefined || value === null || value === '') return null
    return (
        <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className={cn('mt-0.5 break-words text-sm', mono && 'font-mono text-xs')}>{String(value)}</dd>
        </div>
    )
}

function MetadataDetail({ item }: { item: MetadataBatchItem | null }) {
    const { t } = useTranslation()
    if (item === null) {
        return (
            <div className="flex min-h-64 items-center justify-center rounded-panel border border-dashed px-6 text-center text-sm text-muted-foreground">
                {t('dataHub.metadata.chooseResult', '왼쪽 목록에서 이미지를 선택하면 프롬프트와 생성 설정이 여기에 표시됩니다.')}
            </div>
        )
    }
    if (item.metadata === null) {
        return (
            <div className="rounded-panel border p-5">
                <div className="flex items-center gap-2">
                    <StatusMark status={item.status} />
                    <h3 className="min-w-0 truncate font-semibold">{item.fileName}</h3>
                </div>
                <p className="mt-3 text-sm text-muted-foreground">
                    {item.error ?? t('dataHub.metadata.noMetadataDetail', '읽을 수 있는 NAI/NAI Blue 메타데이터가 없습니다.')}
                </p>
            </div>
        )
    }

    const metadata = item.metadata
    return (
        <article className="min-w-0 space-y-5 rounded-panel border bg-card p-4 sm:p-5" aria-label={item.fileName}>
            <header className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                    <h3 className="truncate font-semibold">{item.fileName}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">{formatBytes(item.sizeBytes)} · {item.mimeType}</p>
                </div>
                <Badge variant="secondary" className="shrink-0">{t('dataHub.metadata.readComplete', '읽기 완료')}</Badge>
            </header>

            <section className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t('dataHub.metadata.prompt', '프롬프트')}
                </h4>
                <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-control bg-muted/50 p-3 text-sm leading-6">
                    {metadata.prompt || t('dataHub.metadata.emptyPrompt', '프롬프트 없음')}
                </p>
            </section>

            {metadata.negativePrompt && (
                <section className="space-y-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {t('dataHub.metadata.negativePrompt', '네거티브 프롬프트')}
                    </h4>
                    <p className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words rounded-control bg-muted/50 p-3 text-sm leading-6">
                        {metadata.negativePrompt}
                    </p>
                </section>
            )}

            <dl className="grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-3">
                <DetailValue label={t('dataHub.metadata.model', '모델')} value={metadata.model} />
                <DetailValue label={t('dataHub.metadata.seed', '시드')} value={metadata.seed} mono />
                <DetailValue label={t('dataHub.metadata.resolution', '해상도')} value={metadata.width && metadata.height ? `${metadata.width} × ${metadata.height}` : null} />
                <DetailValue label={t('dataHub.metadata.steps', '스텝')} value={metadata.steps} />
                <DetailValue label="CFG" value={metadata.cfgScale} />
                <DetailValue label="CFG Rescale" value={metadata.cfgRescale} />
                <DetailValue label={t('dataHub.metadata.sampler', '샘플러')} value={metadata.sampler} />
                <DetailValue label={t('dataHub.metadata.scheduler', '스케줄러')} value={metadata.scheduler} />
                <DetailValue label={t('dataHub.metadata.source', '메타데이터 위치')} value={metadata.source} />
            </dl>

            {(metadata.characterPrompts.length > 0 || metadata.hasVibeTransfer || metadata.hasCharacterReference) && (
                <div className="flex flex-wrap gap-2 border-t pt-4">
                    {metadata.characterPrompts.length > 0 && (
                        <Badge variant="outline">{t('dataHub.metadata.characters', '{{count}}개 캐릭터', { count: metadata.characterPrompts.length })}</Badge>
                    )}
                    {metadata.hasVibeTransfer && <Badge variant="outline">Vibe Transfer</Badge>}
                    {metadata.hasCharacterReference && <Badge variant="outline">Character Reference</Badge>}
                </div>
            )}
        </article>
    )
}

export function MetadataWorkspace() {
    const { t } = useTranslation()
    const inputRef = useRef<HTMLInputElement>(null)
    const abortRef = useRef<AbortController | null>(null)
    const [dragging, setDragging] = useState(false)
    const [reading, setReading] = useState(false)
    const [progress, setProgress] = useState<MetadataBatchProgress | null>(null)
    const [items, setItems] = useState<MetadataBatchItem[]>([])
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const summary = useMemo(() => metadataBatchSummary(items), [items])
    const selected = items.find(item => item.id === selectedId) ?? null

    const processFiles = async (files: File[]) => {
        if (files.length === 0) return
        if (files.length > MAX_METADATA_BATCH_FILES) {
            toast({
                title: t('dataHub.metadata.tooMany', '한 번에 선택할 파일이 너무 많습니다.'),
                description: t('dataHub.metadata.tooManyDescription', '한 번에 최대 {{count}}개까지 읽을 수 있습니다.', { count: MAX_METADATA_BATCH_FILES }),
                variant: 'destructive',
            })
            return
        }
        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller
        setReading(true)
        setItems([])
        setSelectedId(null)
        setProgress({ completed: 0, total: files.length, currentFileName: files[0]?.name ?? '' })
        try {
            const next = await readMetadataBatch(files, {
                signal: controller.signal,
                onProgress: setProgress,
            })
            setItems(next)
            setSelectedId(next.find(item => item.status === 'found')?.id ?? next[0]?.id ?? null)
            const nextSummary = metadataBatchSummary(next)
            toast({
                title: t('dataHub.metadata.completed', '이미지 정보 읽기 완료'),
                description: t('dataHub.metadata.completedDescription', '메타데이터 {{found}}개 · 없음 {{empty}}개 · 오류 {{failed}}개', nextSummary),
                variant: nextSummary.failed > 0 ? 'default' : 'success',
            })
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') return
            toast({
                title: t('dataHub.metadata.failed', '메타데이터를 읽지 못했습니다.'),
                description: error instanceof Error ? error.message : String(error),
                variant: 'destructive',
            })
        } finally {
            if (abortRef.current === controller) abortRef.current = null
            setReading(false)
        }
    }

    const exportResults = async (format: 'json' | 'csv') => {
        if (items.length === 0) return
        try {
            await exportTextFile({
                suggestedName: `nai-blue-metadata-${new Date().toISOString().slice(0, 10)}.${format}`,
                content: format === 'json' ? serializeMetadataBatchJson(items) : serializeMetadataBatchCsv(items),
                mimeType: format === 'json' ? 'application/json' : 'text/csv',
                dialogTitle: t('dataHub.metadata.exportTitle', '메타데이터 결과 내보내기'),
            })
        } catch (error) {
            toast({
                title: t('dataHub.metadata.exportFailed', '결과를 내보내지 못했습니다.'),
                description: error instanceof Error ? error.message : String(error),
                variant: 'destructive',
            })
        }
    }

    const clear = () => {
        abortRef.current?.abort()
        setItems([])
        setSelectedId(null)
        setProgress(null)
        setReading(false)
    }

    const progressPercent = progress && progress.total > 0
        ? Math.round((progress.completed / progress.total) * 100)
        : 0

    return (
        <div className="space-y-4" data-testid="metadata-batch-workspace">
            <section
                data-local-file-drop
                className={cn(
                    'group flex min-h-48 cursor-pointer flex-col items-center justify-center rounded-panel border border-dashed px-5 py-8 text-center transition-colors focus-within:ring-2 focus-within:ring-ring',
                    dragging ? 'border-primary bg-primary/5' : 'border-border bg-card hover:border-primary/50 hover:bg-muted/20',
                )}
                onClick={() => !reading && inputRef.current?.click()}
                onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
                }}
                onDrop={(event: DragEvent<HTMLElement>) => {
                    event.preventDefault()
                    setDragging(false)
                    if (!reading) void processFiles(Array.from(event.dataTransfer.files))
                }}
            >
                <input
                    ref={inputRef}
                    type="file"
                    className="sr-only"
                    aria-label={t('dataHub.metadata.dropTitle', '이미지를 선택하거나 이곳에 놓으세요')}
                    accept="image/png,image/webp,image/jpeg,.nai-blue.json,.nais2.json,application/json"
                    multiple
                    disabled={reading}
                    onChange={(event) => {
                        void processFiles(Array.from(event.target.files ?? []))
                        event.target.value = ''
                    }}
                />
                <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                    {reading ? <LoaderCircle className="h-5 w-5 animate-spin" /> : <Upload className="h-5 w-5" />}
                </span>
                <h2 className="font-semibold">
                    {reading
                        ? t('dataHub.metadata.reading', '{{current}} / {{total}} 읽는 중', { current: progress?.completed ?? 0, total: progress?.total ?? 0 })
                        : t('dataHub.metadata.dropTitle', '이미지를 선택하거나 이곳에 놓으세요')}
                </h2>
                <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                    {t('dataHub.metadata.dropDescription', 'PNG, WebP, JPEG와 외부 sidecar JSON을 한 번에 최대 500개까지 읽습니다. 원본 이미지와 Base64 데이터는 결과에 저장하지 않습니다.')}
                </p>
                {reading && progress && (
                    <div className="mt-5 w-full max-w-md" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent}>
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                            <div className="h-full bg-primary transition-[width]" style={{ width: `${progressPercent}%` }} />
                        </div>
                        <p className="mt-2 truncate text-xs text-muted-foreground">{progress.currentFileName}</p>
                    </div>
                )}
            </section>

            {(reading || items.length > 0) && (
                <section className="rounded-panel border bg-card p-3 sm:p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <dl className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
                            <div><dt className="text-xs text-muted-foreground">{t('dataHub.metadata.total', '전체')}</dt><dd className="font-semibold">{progress?.total ?? items.length}</dd></div>
                            <div><dt className="text-xs text-muted-foreground">{t('dataHub.metadata.found', '메타데이터')}</dt><dd className="font-semibold text-success">{summary.found}</dd></div>
                            <div><dt className="text-xs text-muted-foreground">{t('dataHub.metadata.empty', '없음')}</dt><dd className="font-semibold text-warning">{summary.empty}</dd></div>
                            <div><dt className="text-xs text-muted-foreground">{t('dataHub.metadata.errors', '오류')}</dt><dd className="font-semibold text-destructive">{summary.failed}</dd></div>
                        </dl>
                        <div className="flex flex-wrap gap-2">
                            {reading ? (
                                <Button variant="outline" onClick={() => abortRef.current?.abort()}>
                                    <X className="mr-2 h-4 w-4" />{t('common.cancel', '취소')}
                                </Button>
                            ) : (
                                <>
                                    <Button variant="outline" onClick={() => void exportResults('json')} disabled={items.length === 0}>
                                        <FileJson className="mr-2 h-4 w-4" />JSON
                                    </Button>
                                    <Button variant="outline" onClick={() => void exportResults('csv')} disabled={items.length === 0}>
                                        <FileSpreadsheet className="mr-2 h-4 w-4" />CSV
                                    </Button>
                                    <Button variant="ghost" onClick={clear}>{t('dataHub.metadata.clear', '비우기')}</Button>
                                </>
                            )}
                        </div>
                    </div>
                </section>
            )}

            {items.length > 0 && (
                <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(260px,0.72fr)_minmax(0,1.28fr)]">
                    <div className="max-h-[34rem] space-y-1 overflow-y-auto rounded-panel border bg-card p-2" role="listbox" aria-label={t('dataHub.metadata.results', '메타데이터 결과')}>
                        {items.map(item => (
                            <button
                                key={item.id}
                                type="button"
                                role="option"
                                aria-selected={selectedId === item.id}
                                onClick={() => setSelectedId(item.id)}
                                className={cn(
                                    'flex min-h-14 w-full min-w-0 items-center gap-3 rounded-control px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                    selectedId === item.id ? 'bg-primary/10 text-foreground' : 'hover:bg-muted/60',
                                )}
                            >
                                <StatusMark status={item.status} />
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm font-medium">{item.fileName}</span>
                                    <span className="block truncate text-xs text-muted-foreground">
                                        {item.status === 'found'
                                            ? [item.metadata?.model, item.metadata?.width && item.metadata?.height ? `${item.metadata.width}×${item.metadata.height}` : null].filter(Boolean).join(' · ') || t('dataHub.metadata.metadataFound', '메타데이터 확인됨')
                                            : item.error ?? t('dataHub.metadata.notFound', '메타데이터 없음')}
                                    </span>
                                </span>
                                <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                            </button>
                        ))}
                    </div>
                    <MetadataDetail item={selected} />
                </div>
            )}
        </div>
    )
}

function AgentWorkspacePanel() {
    const { t } = useTranslation()
    const status = useSyncExternalStore(
        subscribeAgentWorkspaceBridge,
        getAgentWorkspaceBridgeStatus,
        getAgentWorkspaceBridgeStatus,
    )
    const [busy, setBusy] = useState(false)

    const refresh = async () => {
        setBusy(true)
        try {
            await refreshAgentWorkspaceSnapshot(true)
            toast({ title: t('dataHub.agent.refreshed', 'AI 작업공간을 최신 상태로 갱신했습니다.'), variant: 'success' })
        } catch (error) {
            toast({
                title: t('dataHub.agent.refreshFailed', '작업공간을 갱신하지 못했습니다.'),
                description: error instanceof Error ? error.message : String(error),
                variant: 'destructive',
            })
        } finally {
            setBusy(false)
        }
    }

    const openWorkspace = async () => {
        try {
            await openNativePath(status.workspacePath ?? await getAgentWorkspaceAbsolutePath())
        } catch (error) {
            toast({
                title: t('dataHub.agent.openFailed', '작업 폴더를 열지 못했습니다.'),
                description: error instanceof Error ? error.message : String(error),
                variant: 'destructive',
            })
        }
    }

    if (!status.supported) {
        return (
            <Card className="border-0 shadow-none">
                <CardHeader>
                    <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-control bg-muted text-muted-foreground">
                        <Bot className="h-5 w-5" />
                    </div>
                    <CardTitle>{t('dataHub.agent.desktopRequired', '데스크톱 앱에서 사용할 수 있습니다')}</CardTitle>
                    <CardDescription>
                        {t('dataHub.agent.desktopRequiredDescription', '모바일 앱은 외부 파일 감시를 허용하지 않습니다. Windows, macOS 또는 Linux 데스크톱 앱에서 AI 작업공간을 열어 주세요.')}
                    </CardDescription>
                </CardHeader>
            </Card>
        )
    }

    return (
        <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(280px,0.9fr)]" data-testid="agent-workspace-panel">
            <Card className="border-0 shadow-none">
                <CardHeader>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                            <CardTitle>{t('dataHub.agent.title', 'AI 편집 작업공간')}</CardTitle>
                            <CardDescription className="mt-1 max-w-2xl">
                                {t('dataHub.agent.description', 'AI 에이전트가 프롬프트, 생성 파라미터와 저장 경로를 읽고 한 번에 하나의 검증된 변경 요청을 보낼 수 있습니다.')}
                            </CardDescription>
                        </div>
                        <Badge variant={status.lastResult === 'rejected' ? 'destructive' : 'secondary'}>
                            {status.running ? t('dataHub.agent.watching', '변경 요청 감시 중') : t('dataHub.agent.stopped', '중지됨')}
                        </Badge>
                    </div>
                </CardHeader>
                <CardContent className="space-y-5">
                    <ol className="grid gap-3 sm:grid-cols-3">
                        {[
                            [t('dataHub.agent.stepRead', '현재 데이터 읽기'), 'snapshot.json'],
                            [t('dataHub.agent.stepRequest', '변경 요청 작성'), 'request.json'],
                            [t('dataHub.agent.stepResult', '검증 결과 확인'), 'result.json'],
                        ].map(([label, file], index) => (
                            <li key={file} className="rounded-panel border bg-muted/20 p-4">
                                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">{index + 1}</span>
                                <p className="mt-3 text-sm font-medium">{label}</p>
                                <code className="mt-1 block break-all text-xs text-muted-foreground">{file}</code>
                            </li>
                        ))}
                    </ol>

                    <div className="rounded-panel border border-success/25 bg-success/5 p-4">
                        <div className="flex items-start gap-3">
                            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-success" />
                            <div>
                                <p className="text-sm font-semibold">{t('dataHub.agent.privateTitle', '민감한 데이터는 작업공간 밖에 유지됩니다')}</p>
                                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                    {t('dataHub.agent.privateDescription', 'NovelAI/R2 자격 증명, 이미지 원본, 썸네일, 생성 기록과 진단 로그는 snapshot.json에 포함하지 않습니다.')}
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                        <Button onClick={() => void openWorkspace()}>
                            <FolderOpen className="mr-2 h-4 w-4" />{t('dataHub.agent.openFolder', '작업 폴더 열기')}
                        </Button>
                        <Button variant="outline" disabled={busy} onClick={() => void refresh()}>
                            <RefreshCw className={cn('mr-2 h-4 w-4', busy && 'animate-spin')} />
                            {t('dataHub.agent.refresh', '현재 데이터 새로고침')}
                        </Button>
                    </div>
                </CardContent>
            </Card>

            <Card className="border-0 bg-muted/30 shadow-none">
                <CardHeader>
                    <CardTitle className="text-base">{t('dataHub.agent.activity', '최근 작업 상태')}</CardTitle>
                </CardHeader>
                <CardContent>
                    <dl className="space-y-4">
                        <DetailValue label={t('dataHub.agent.revision', '현재 리비전')} value={status.revision} mono />
                        <DetailValue label={t('dataHub.agent.lastSnapshot', '마지막 데이터 갱신')} value={status.lastSnapshotAt ? new Date(status.lastSnapshotAt).toLocaleString() : null} />
                        <DetailValue label={t('dataHub.agent.lastRequest', '마지막 요청 ID')} value={status.lastRequestId} mono />
                        <DetailValue label={t('dataHub.agent.lastResult', '마지막 결과')} value={status.lastResult} />
                    </dl>
                    {status.lastMessage && (
                        <p className={cn(
                            'mt-5 rounded-control p-3 text-xs leading-5',
                            status.lastResult === 'rejected' ? 'bg-destructive/10 text-destructive' : 'bg-background text-muted-foreground',
                        )}>
                            {status.lastMessage}
                        </p>
                    )}
                </CardContent>
            </Card>
        </div>
    )
}

function PairingQrCode({ value }: { value: string }) {
    const [dataUrl, setDataUrl] = useState<string | null>(null)

    useEffect(() => {
        let active = true
        const rootStyle = getComputedStyle(document.documentElement)
        const foreground = rootStyle.getPropertyValue('--foreground').trim()
        const card = rootStyle.getPropertyValue('--card').trim()
        void QRCode.toDataURL(value, {
            errorCorrectionLevel: 'M',
            margin: 2,
            width: 280,
            // QR pixels depend on the same high-contrast design tokens as the
            // surrounding pairing card, while the generated data remains local.
            color: { dark: `oklch(${foreground})`, light: `oklch(${card})` },
        }).then(url => {
            if (active) setDataUrl(url)
        }).catch(() => {
            if (active) setDataUrl(null)
        })
        return () => { active = false }
    }, [value])

    return dataUrl === null ? (
        <div className="flex aspect-square w-full max-w-[280px] items-center justify-center rounded-panel bg-muted text-xs text-muted-foreground">
            QR…
        </div>
    ) : (
        <img
            src={dataUrl}
            alt="NAI Blue secure pairing QR"
            className="aspect-square w-full max-w-[280px] rounded-panel border bg-card p-2"
        />
    )
}

/** Decodes only the selected camera/photo frame; the image is never persisted. */
async function decodePairingQr(file: File): Promise<string> {
    const bitmap = await createImageBitmap(file)
    try {
        const maximum = 1_920
        const scale = Math.min(1, maximum / Math.max(bitmap.width, bitmap.height))
        const width = Math.max(1, Math.round(bitmap.width * scale))
        const height = Math.max(1, Math.round(bitmap.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (context === null) throw new Error('QR canvas is unavailable.')
        context.drawImage(bitmap, 0, 0, width, height)
        const image = context.getImageData(0, 0, width, height)
        const result = jsQR(image.data, width, height, { inversionAttempts: 'attemptBoth' })
        if (result === null || result.data.length < 4 || result.data.length > 16_384) {
            throw new Error('Pairing QR was not found.')
        }
        return result.data
    } finally {
        bitmap.close()
    }
}

export function DeviceConnectionPanel({ onOpenBackup }: { onOpenBackup?: () => void } = {}) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const capability = runtimeCapabilities.secureLanSyncTransport
    const platform = getRuntimePlatform()
    const session = useMemo(() => getLanSessionRuntime(), [])
    const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
    const cameraInput = useRef<HTMLInputElement>(null)
    const [invitation, setInvitation] = useState('')
    const [confirmationCode, setConfirmationCode] = useState('')
    const [busy, setBusy] = useState(false)
    const [manualBindIp, setManualBindIp] = useState('')
    const [manualCidr, setManualCidr] = useState('')
    const [manualPort, setManualPort] = useState('41921')

    const run = async (operation: () => Promise<void>, success?: string) => {
        setBusy(true)
        try {
            await operation()
            if (success) toast({ title: success })
        } catch {
            toast({
                variant: 'destructive',
                title: t('dataHub.sync.failed', '연결을 완료하지 못했습니다'),
                description: t('dataHub.sync.failedDescription', '같은 Wi-Fi인지 확인한 뒤 새 연결 코드를 만들어 다시 시도하세요.'),
            })
        } finally {
            setBusy(false)
        }
    }

    const copyInvitation = async () => {
        if (snapshot.invitation === null) return
        try {
            await navigator.clipboard.writeText(snapshot.invitation)
            toast({ title: t('dataHub.sync.invitationCopied', '연결 정보가 복사되었습니다') })
        } catch {
            toast({ variant: 'destructive', title: t('dataHub.sync.copyFailed', '복사할 수 없습니다') })
        }
    }

    const readQr = async (file: File | undefined) => {
        if (file === undefined) return
        setBusy(true)
        try {
            setInvitation(await decodePairingQr(file))
            toast({ title: t('dataHub.sync.qrRead', '연결 QR을 읽었습니다') })
        } catch {
            toast({
                variant: 'destructive',
                title: t('dataHub.sync.qrFailed', 'QR을 읽지 못했습니다'),
                description: t('dataHub.sync.qrFailedDescription', 'QR이 화면 안에 선명하게 보이도록 다시 촬영하세요.'),
            })
        } finally {
            setBusy(false)
        }
    }

    const connected = snapshot.phase === 'connected' || snapshot.phase === 'syncing'
    const statusBadge = !capability.supported
        ? <><WifiOff className="mr-1.5 h-3.5 w-3.5" />{t('dataHub.sync.unsupported', '지원 안 함')}</>
        : connected
            ? <><Wifi className="mr-1.5 h-3.5 w-3.5" />{t('dataHub.sync.connected', '연결됨')}</>
            : snapshot.phase === 'error'
                ? <><CircleAlert className="mr-1.5 h-3.5 w-3.5" />{t('dataHub.sync.needsAttention', '확인 필요')}</>
                : <><Link2 className="mr-1.5 h-3.5 w-3.5" />{t('dataHub.sync.ready', '연결 준비')}</>

    return (
        <div className="space-y-4" data-testid="device-connection-panel">
            <Card className="border-0 shadow-none">
                <CardHeader>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                            <CardTitle>{t('dataHub.sync.title', '모바일 · 데스크톱 연결')}</CardTitle>
                            <CardDescription className="mt-1 max-w-2xl">
                                {t('dataHub.sync.description', '같은 Wi-Fi에서 프롬프트 프리셋과 생성 파라미터를 기기끼리 직접 이어 씁니다.')}
                            </CardDescription>
                        </div>
                        <Badge variant="outline" className={cn(
                            connected && 'border-success/40 text-success',
                            snapshot.phase === 'error' && 'border-destructive/40 text-destructive',
                        )}>
                            {statusBadge}
                        </Badge>
                    </div>
                </CardHeader>
                <CardContent className="space-y-5">
                    <div className="grid items-center gap-3 sm:grid-cols-[1fr_auto_1fr]">
                        <div className="flex items-center gap-3 rounded-panel border bg-muted/20 p-4">
                            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-background"><Monitor className="h-5 w-5" /></span>
                            <div>
                                <p className="text-sm font-semibold">{t('dataHub.sync.desktop', '데스크톱')}</p>
                                <p className="text-xs text-muted-foreground">
                                    {capability.supported
                                        ? t('dataHub.sync.desktopReady', '사용자가 열 때만 보안 수신')
                                        : t('dataHub.sync.transportOff', '직접 연결 비활성')}
                                </p>
                            </div>
                        </div>
                        <Cable className="mx-auto h-5 w-5 rotate-90 text-muted-foreground sm:rotate-0" />
                        <div className="flex items-center gap-3 rounded-panel border bg-muted/20 p-4">
                            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-background"><Smartphone className="h-5 w-5" /></span>
                            <div>
                                <p className="text-sm font-semibold">{t('dataHub.sync.mobile', '모바일')}</p>
                                <p className="text-xs text-muted-foreground">
                                    {capability.supported && platform === 'android'
                                        ? t('dataHub.sync.androidReady', 'QR로 outbound 연결')
                                        : capability.supported
                                            ? t('dataHub.sync.clientReady', 'Android 클라이언트 대기')
                                            : t('dataHub.sync.clientQaPending', '클라이언트 지원 안 함')}
                                </p>
                            </div>
                        </div>
                    </div>

                    {capability.supported && isDesktopRuntime && snapshot.phase === 'idle' && (
                        <div className="rounded-panel border bg-gradient-to-br from-primary/8 via-background to-background p-5">
                            <div className="flex items-start gap-3">
                                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-primary/10 text-primary"><Wifi className="h-5 w-5" /></span>
                                <div className="min-w-0 flex-1">
                                    <p className="font-semibold">{t('dataHub.sync.openDesktop', '이 데스크톱에서 연결 열기')}</p>
                                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                                        {t('dataHub.sync.openDesktopDescription', '같은 Wi-Fi의 Android 한 대만 2분 동안 페어링할 수 있습니다. 인터넷 중계 서버는 사용하지 않습니다.')}
                                    </p>
                                    {platform === 'windows' && (
                                        <div className="mt-3 flex items-start gap-2 rounded-control border border-warning/25 bg-warning/5 p-3 text-xs leading-5 text-muted-foreground">
                                            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                                            <div>
                                                <p className="font-semibold text-foreground">{t('dataHub.sync.windowsFirewallTitle', 'Windows 첫 연결 안내')}</p>
                                                <p>{t('dataHub.sync.windowsFirewallDescription', '방화벽 알림이 뜨면 개인 네트워크만 허용하세요. 공용 네트워크에서는 직접 연결 대신 백업 이동을 권장합니다.')}</p>
                                            </div>
                                        </div>
                                    )}
                                    <Button className="mt-4 min-h-11" disabled={busy} onClick={() => void run(
                                        () => session.startHost(),
                                    )}>
                                        {busy ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Link2 className="mr-2 h-4 w-4" />}
                                        {t('dataHub.sync.createCode', '연결 코드 만들기')}
                                    </Button>
                                </div>
                            </div>
                            <details className="mt-4 border-t pt-3 text-xs text-muted-foreground">
                                <summary className="cursor-pointer font-medium text-foreground">{t('dataHub.sync.manualNetwork', '네트워크를 직접 지정해야 하나요?')}</summary>
                                <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_7rem_auto]">
                                    <Input value={manualBindIp} onChange={event => setManualBindIp(event.target.value)} placeholder="192.168.0.10" aria-label="Bind IP" />
                                    <Input value={manualCidr} onChange={event => setManualCidr(event.target.value)} placeholder="192.168.0.0/24" aria-label="Allowed CIDR" />
                                    <Input value={manualPort} onChange={event => setManualPort(event.target.value)} inputMode="numeric" aria-label="Port" />
                                    <Button variant="outline" disabled={busy || !manualBindIp || !manualCidr} onClick={() => void run(() => session.startHost({
                                        bindIp: manualBindIp.trim(),
                                        allowCidr: manualCidr.trim(),
                                        port: Number(manualPort),
                                    }))}>{t('dataHub.sync.open', '열기')}</Button>
                                </div>
                            </details>
                        </div>
                    )}

                    {capability.supported && isDesktopRuntime && snapshot.phase === 'awaiting-peer' && snapshot.invitation !== null && (
                        <div className="grid gap-5 rounded-panel border p-4 sm:grid-cols-[minmax(0,280px)_1fr] sm:p-5">
                            <PairingQrCode value={snapshot.invitation} />
                            <div className="min-w-0">
                                <Badge variant="secondary">{t('dataHub.sync.stepDesktop', 'Android에서 QR 스캔')}</Badge>
                                <p className="mt-4 text-sm font-medium text-muted-foreground">{t('dataHub.sync.confirmationCode', '확인 코드')}</p>
                                <p className="mt-1 font-mono text-4xl font-semibold tracking-[0.2em] text-foreground">{snapshot.confirmationCode}</p>
                                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                                    {t('dataHub.sync.codeDescription', 'Android 화면에 이 6자리를 입력하세요. 코드는 QR과 분리되어 있으며 2분 뒤 만료됩니다.')}
                                </p>
                                <div className="mt-4 flex flex-wrap gap-2">
                                    <Button variant="outline" onClick={() => void copyInvitation()}><ClipboardCopy className="mr-2 h-4 w-4" />{t('dataHub.sync.copyInstead', 'QR 대신 복사')}</Button>
                                    <Button variant="ghost" disabled={busy} onClick={() => void run(() => session.refreshInvitation())}><RefreshCw className="mr-2 h-4 w-4" />{t('dataHub.sync.newCode', '새 코드')}</Button>
                                    <Button variant="ghost" disabled={busy} onClick={() => void run(() => session.stop())}><Unplug className="mr-2 h-4 w-4" />{t('dataHub.sync.cancel', '취소')}</Button>
                                </div>
                            </div>
                        </div>
                    )}

                    {capability.supported && isAndroidRuntime && snapshot.phase === 'idle' && (
                        <div className="space-y-4 rounded-panel border bg-gradient-to-br from-primary/8 via-background to-background p-4">
                            <div>
                                <p className="font-semibold">{t('dataHub.sync.scanDesktop', '데스크톱의 연결 QR 스캔')}</p>
                                <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('dataHub.sync.scanDesktopDescription', '데스크톱 앱에서 데이터 허브 → 기기 연결 → 연결 코드 만들기를 먼저 누르세요.')}</p>
                            </div>
                            <input
                                ref={cameraInput}
                                type="file"
                                accept="image/*"
                                capture="environment"
                                className="hidden"
                                onChange={event => {
                                    const file = event.currentTarget.files?.[0]
                                    event.currentTarget.value = ''
                                    void readQr(file)
                                }}
                            />
                            <Button className="min-h-12 w-full" disabled={busy} onClick={() => cameraInput.current?.click()}>
                                {busy ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Camera className="mr-2 h-4 w-4" />}
                                {t('dataHub.sync.scanQr', 'QR 촬영 또는 사진 선택')}
                            </Button>
                            <details>
                                <summary className="cursor-pointer text-xs font-medium text-muted-foreground">{t('dataHub.sync.pasteInvitation', '연결 정보를 직접 붙여넣기')}</summary>
                                <Textarea className="mt-2 min-h-24 font-mono text-[11px]" value={invitation} onChange={event => setInvitation(event.target.value)} placeholder="{ … }" />
                            </details>
                            {invitation && (
                                <div className="rounded-control bg-muted/40 p-3">
                                    <label className="text-xs font-medium" htmlFor="lan-confirmation-code">{t('dataHub.sync.enterCode', '데스크톱의 6자리 확인 코드')}</label>
                                    <Input
                                        id="lan-confirmation-code"
                                        className="mt-2 h-12 text-center font-mono text-xl tracking-[0.3em]"
                                        value={confirmationCode}
                                        onChange={event => setConfirmationCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                                        inputMode="numeric"
                                        autoComplete="one-time-code"
                                        maxLength={6}
                                    />
                                    <Button className="mt-3 min-h-11 w-full" disabled={busy || confirmationCode.length !== 6} onClick={() => void run(
                                        () => session.connectClient({ invitation, confirmationCode }),
                                        t('dataHub.sync.syncComplete', '프리셋 동기화가 완료되었습니다'),
                                    )}>
                                        {busy ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Cable className="mr-2 h-4 w-4" />}
                                        {t('dataHub.sync.connectAndSync', '연결하고 동기화')}
                                    </Button>
                                </div>
                            )}
                        </div>
                    )}

                    {capability.supported && connected && (
                        <div className="rounded-panel border border-success/30 bg-success/5 p-4 sm:p-5">
                            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                                <div className="flex min-w-0 items-start gap-3">
                                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-success/15 text-success"><Check className="h-5 w-5" /></span>
                                    <div className="min-w-0">
                                        <p className="font-semibold">{snapshot.peerName ?? t('dataHub.sync.pairedDevice', '페어링된 기기')}</p>
                                        <p className="mt-1 text-sm text-muted-foreground">
                                            {snapshot.phase === 'syncing'
                                                ? t('dataHub.sync.syncing', '프리셋을 안전하게 맞추는 중…')
                                                : snapshot.lastSyncAt
                                                    ? t('dataHub.sync.lastSync', '마지막 동기화 {{time}} · {{count}}개 처리', { time: new Date(snapshot.lastSyncAt).toLocaleTimeString(), count: snapshot.transferred })
                                                    : t('dataHub.sync.connectedDescription', '연결되었습니다. 프리셋 변경 사항을 직접 동기화할 수 있습니다.')}
                                        </p>
                                    </div>
                                </div>
                                <div className="flex shrink-0 gap-2">
                                    <Button disabled={busy || snapshot.phase === 'syncing'} onClick={() => void run(
                                        () => session.synchronizeNow(),
                                        t('dataHub.sync.syncComplete', '프리셋 동기화가 완료되었습니다'),
                                    )}><RefreshCw className={cn('mr-2 h-4 w-4', snapshot.phase === 'syncing' && 'animate-spin')} />{t('dataHub.sync.syncNow', '지금 동기화')}</Button>
                                    <Button variant="outline" className="whitespace-nowrap" disabled={busy} onClick={() => void run(() => session.stop())}><Unplug className="mr-2 h-4 w-4" />{t('dataHub.sync.disconnect', '연결 종료')}</Button>
                                </div>
                            </div>
                        </div>
                    )}

                    {capability.supported && snapshot.phase === 'error' && (
                        <div className="rounded-panel border border-destructive/30 bg-destructive/5 p-4">
                            <div className="flex items-start gap-3">
                                <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
                                <div className="min-w-0 flex-1">
                                    <p className="font-semibold">{t('dataHub.sync.failed', '연결을 완료하지 못했습니다')}</p>
                                    <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('dataHub.sync.errorCode', '오류 코드: {{code}}', { code: snapshot.errorCode ?? 'E_SYNC_SESSION' })}</p>
                                    {snapshot.errorCode === 'E_SYNC_TRANSPORT' && (
                                        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                                            {t('dataHub.sync.transportHelp', '두 기기가 같은 Wi-Fi인지 확인하세요. Windows에서는 방화벽 알림의 개인 네트워크를 허용하고, 네트워크가 공용으로 설정되어 있다면 백업 이동을 사용하세요.')}
                                        </p>
                                    )}
                                    <Button className="mt-3" variant="outline" disabled={busy} onClick={() => void run(() => session.stop())}>{t('dataHub.sync.backToStart', '처음부터 다시')}</Button>
                                </div>
                            </div>
                        </div>
                    )}

                    {capability.supported && <div className="grid gap-3 md:grid-cols-3">
                        <div className="rounded-panel border p-4"><ShieldCheck className="h-4 w-4 text-success" /><p className="mt-3 text-sm font-semibold">{t('dataHub.sync.safeData', '민감 데이터 제외')}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{t('dataHub.sync.safeDataDescription', '토큰·이미지·절대 경로를 전송하지 않습니다.')}</p></div>
                        <div className="rounded-panel border p-4"><KeyRound className="h-4 w-4 text-success" /><p className="mt-3 text-sm font-semibold">{t('dataHub.sync.pairing', 'TLS 1.3 기기 인증')}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{t('dataHub.sync.pairingDescription', '2분짜리 QR과 별도 6자리 코드로 한 대만 페어링합니다.')}</p></div>
                        <div className="rounded-panel border p-4"><RefreshCw className="h-4 w-4 text-warning" /><p className="mt-3 text-sm font-semibold">{t('dataHub.sync.sessionOnly', '실행 중인 세션에만 연결')}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{t('dataHub.sync.sessionOnlyDescription', '앱을 다시 열면 재페어링합니다. 장기 기기 키 저장은 다음 보안 단계에서 제공합니다.')}</p></div>
                    </div>}

                    <div className="flex flex-col gap-3 rounded-panel bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                            <p className="text-sm font-semibold">{t('dataHub.sync.safeAlternative', '지금 데이터를 옮겨야 하나요?')}</p>
                            <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                {t('dataHub.sync.safeAlternativeDescription', '설정의 데이터 백업으로 내보낸 뒤 다른 기기에서 복원할 수 있습니다. 자격 증명 원문은 포함되지 않습니다.')}
                            </p>
                        </div>
                        <Button
                            variant="outline"
                            className="shrink-0"
                            onClick={onOpenBackup ?? (() => navigate('/settings?section=backup'))}
                        >
                            {t('dataHub.sync.openBackup', '백업 열기')}<ArrowRight className="ml-2 h-4 w-4" />
                        </Button>
                    </div>

                    {!capability.supported && capability.reason && (
                        <details className="rounded-panel border px-4 py-3 text-xs text-muted-foreground">
                            <summary className="cursor-pointer font-medium text-foreground">{t('dataHub.sync.technicalStatus', '기술 상태 보기')}</summary>
                            <p className="mt-2 leading-5">{capability.reason} {capability.alternative}</p>
                        </details>
                    )}
                </CardContent>
            </Card>
        </div>
    )
}

/**
 * Combines runtime capabilities, the safe batch reader, and the desktop agent
 * bridge in one task-oriented surface. Unsupported transports remain visible
 * as status/fallback guidance and are never enabled by this presentation layer.
 */
export default function DataHub() {
    const { t } = useTranslation()
    const [searchParams, setSearchParams] = useSearchParams()
    const requestedTab = searchParams.get('tab')
    const activeTab = requestedTab === 'agent' || requestedTab === 'sync' ? requestedTab : 'metadata'

    const selectTab = (tab: string) => {
        const next = new URLSearchParams(searchParams)
        next.set('tab', tab)
        setSearchParams(next, { replace: true })
    }

    return (
        <div className="h-full min-h-0 overflow-y-auto bg-canvas">
            <div className="mx-auto w-full max-w-7xl space-y-5 p-3 sm:p-5 lg:p-7" data-testid="data-hub-page">
                <header className="flex items-start gap-3">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-control bg-primary/10 text-primary">
                        <DatabaseZap className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                        <h1 className="text-xl font-semibold">{t('dataHub.title', '데이터 허브')}</h1>
                        <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
                            {t('dataHub.description', '기기 간 데이터 이동, 여러 이미지의 생성 정보 확인, AI 에이전트 편집을 한곳에서 관리합니다.')}
                        </p>
                    </div>
                </header>

                <div className="grid gap-2 sm:grid-cols-3" aria-label={t('dataHub.overview', '기능 상태')}>
                    {[
                        [Cable, t('dataHub.overviewSync', '기기 연결'), runtimeCapabilities.secureLanSyncTransport.supported ? t('dataHub.statusReady', '사용 가능') : t('dataHub.statusBackup', '백업으로 이동')],
                        [ScanSearch, t('dataHub.overviewMetadata', '이미지 정보'), t('dataHub.statusReady', '사용 가능')],
                        [Bot, t('dataHub.overviewAgent', 'AI 편집'), isDesktopRuntime ? t('dataHub.statusReady', '사용 가능') : t('dataHub.statusDesktop', '데스크톱 전용')],
                    ].map(([Icon, label, status]) => {
                        const ItemIcon = Icon as typeof Cable
                        return (
                            <div key={String(label)} className="flex min-w-0 items-start gap-3 rounded-panel border bg-card px-4 py-3">
                                <ItemIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                                <span className="min-w-0 flex-1">
                                    <span className="block text-sm font-medium leading-5">{String(label)}</span>
                                    <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{String(status)}</span>
                                </span>
                            </div>
                        )
                    })}
                </div>

                <Tabs value={activeTab} onValueChange={selectTab} className="min-w-0 space-y-4">
                    <TabsList className="grid h-auto w-full grid-cols-3 rounded-panel bg-muted/60 p-1">
                        <TabsTrigger value="metadata" className="min-h-11 gap-2 rounded-control px-2">
                            <ImageIcon className="hidden h-4 w-4 shrink-0 sm:block" /><span className="truncate">{t('dataHub.tabs.metadata', '이미지 정보')}</span>
                        </TabsTrigger>
                        <TabsTrigger value="agent" className="min-h-11 gap-2 rounded-control px-2">
                            <Bot className="hidden h-4 w-4 shrink-0 sm:block" /><span className="truncate">{t('dataHub.tabs.agent', 'AI 편집')}</span>
                        </TabsTrigger>
                        <TabsTrigger value="sync" className="min-h-11 gap-2 rounded-control px-2">
                            <Cable className="hidden h-4 w-4 shrink-0 sm:block" /><span className="truncate">{t('dataHub.tabs.sync', '기기 연결')}</span>
                        </TabsTrigger>
                    </TabsList>
                    <TabsContent value="metadata"><MetadataWorkspace /></TabsContent>
                    <TabsContent value="agent"><AgentCommandPanel /><AgentWorkspacePanel /></TabsContent>
                    <TabsContent value="sync"><DeviceConnectionPanel /></TabsContent>
                </Tabs>

                <footer className="flex items-center gap-2 pb-2 text-xs text-muted-foreground">
                    <KeyRound className="h-3.5 w-3.5" />
                    {t('dataHub.footer', '이 화면은 API 토큰이나 이미지 원본을 표시하지 않습니다.')}
                </footer>
            </div>
        </div>
    )
}
