import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, FileImage, FolderOpen, ShieldCheck, UploadCloud } from 'lucide-react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'

import { GenerationFolderPicker } from '@/components/generation-folders/GenerationFolderPicker'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import type { ResolvedGenerationFolder } from '@/domain/generation-folders'
import { DEFAULT_R2_PROFILE_ID } from '@/domain/r2/types'
import { resolveGenerationFolderAuthority } from '@/lib/generation-folder-authority-runtime'
import { useDefaultR2Readiness } from '@/hooks/useDefaultR2Readiness'
import type { LibraryImageFormatChoice } from '@/services/library/library-image-workflow'
import { useSettingsStore } from '@/stores/settings-store'
import { cn } from '@/lib/utils'

export interface LibraryImageWorkflowOptions {
    readonly folder: ResolvedGenerationFolder
    readonly format: LibraryImageFormatChoice
    readonly stripMetadata: boolean
    readonly autoUpload: boolean
}

const STEPS = [
    { icon: FolderOpen, label: '저장 폴더' },
    { icon: FileImage, label: '이미지 편집' },
    { icon: UploadCloud, label: '저장 확인' },
] as const

export function LibraryImageWorkflowDialog({
    open,
    sourceNames,
    busyProgress,
    onOpenChange,
    onConfirm,
}: {
    open: boolean
    sourceNames: readonly string[]
    busyProgress: { readonly current: number; readonly total: number } | null
    onOpenChange(open: boolean): void
    onConfirm(options: LibraryImageWorkflowOptions): void | Promise<void>
}) {
    const { t } = useTranslation()
    const folders = useSettingsStore(state => state.generationFolders)
    const folderDocument = useSettingsStore(state => state.generationFolderDocument)
    const activeFolderId = useSettingsStore(state => state.activeGenerationFolderId)
    const savePath = useSettingsStore(state => state.savePath)
    const useAbsolutePath = useSettingsStore(state => state.useAbsolutePath)
    const [step, setStep] = useState(0)
    const [folderId, setFolderId] = useState(activeFolderId)
    const [format, setFormat] = useState<LibraryImageFormatChoice>('keep')
    const [stripMetadata, setStripMetadata] = useState(false)
    const [autoUpload, setAutoUpload] = useState(false)
    const initializedForOpen = useRef(false)
    const autoUploadTouched = useRef(false)

    const preliminaryFolder = useMemo(() => resolveGenerationFolderAuthority(folderDocument, folders, folderId, {
        directory: savePath,
        useAbsolutePath,
        r2ProfileId: DEFAULT_R2_PROFILE_ID,
    }), [folderDocument, folderId, folders, savePath, useAbsolutePath])
    const requestedProfileId = preliminaryFolder?.r2.profileId ?? null
    const r2State = useDefaultR2Readiness(requestedProfileId, open && requestedProfileId !== null)
    const readinessMatches = r2State.profile?.id === requestedProfileId
    const r2Ready = readinessMatches && r2State.status === 'ready'
    const folder = useMemo(() => resolveGenerationFolderAuthority(folderDocument, folders, folderId, {
        directory: savePath,
        useAbsolutePath,
        r2ProfileId: requestedProfileId,
        r2Bucket: readinessMatches ? r2State.profile?.bucket : null,
        r2Prefix: readinessMatches ? r2State.profile?.prefix : null,
    }), [folderDocument, folderId, folders, readinessMatches, requestedProfileId, r2State.profile, savePath, useAbsolutePath])
    const publicUploadRequiresStrip = autoUpload
        && r2Ready
        && r2State.profile.publicMode !== 'private'

    useEffect(() => {
        if (!open) {
            initializedForOpen.current = false
            return
        }
        if (initializedForOpen.current) return
        initializedForOpen.current = true
        autoUploadTouched.current = false
        const selected = resolveGenerationFolderAuthority(folderDocument, folders, activeFolderId, {
            directory: savePath,
            useAbsolutePath,
            r2ProfileId: requestedProfileId,
            r2Bucket: readinessMatches ? r2State.profile?.bucket : null,
            r2Prefix: readinessMatches ? r2State.profile?.prefix : null,
        })
        setStep(0)
        setFolderId(activeFolderId)
        setFormat('keep')
        setStripMetadata(false)
        setAutoUpload(r2Ready && selected?.r2.autoUpload === true)
    }, [activeFolderId, folderDocument, folders, open, r2Ready, r2State.profile, readinessMatches, requestedProfileId, savePath, useAbsolutePath])

    useEffect(() => {
        if (open && !autoUploadTouched.current && r2Ready && folder?.r2.autoUpload) {
            setAutoUpload(true)
        }
    }, [folder?.r2.autoUpload, open, r2Ready])

    useEffect(() => {
        if (publicUploadRequiresStrip) setStripMetadata(true)
    }, [publicUploadRequiresStrip])

    const busy = busyProgress !== null
    const hasJpeg = sourceNames.some(name => /\.jpe?g$/iu.test(name))
    const selectedLabel = sourceNames.length === 1
        ? sourceNames[0]
        : t('library.workflow.imageCount', '{{count}}개 이미지', { count: sourceNames.length })

    return (
        <Dialog open={open} onOpenChange={busy ? () => undefined : onOpenChange}>
            <DialogContent className="grid max-h-[calc(100dvh-2rem)] max-w-2xl grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden p-0">
                <DialogHeader className="border-b border-border/60 px-5 py-4 pr-14">
                    <DialogTitle>{t('library.workflow.title', '이미지 가져오기 · 편집')}</DialogTitle>
                    <DialogDescription className="truncate" title={selectedLabel}>{selectedLabel}</DialogDescription>
                </DialogHeader>

                <ol className="grid grid-cols-3 border-b border-border/60 px-3 py-3 sm:px-5" aria-label={t('library.workflow.steps', '이미지 처리 단계')}>
                    {STEPS.map((item, index) => {
                        const Icon = item.icon
                        return (
                            <li key={item.label} className="min-w-0">
                                <button
                                    type="button"
                                    disabled={busy || index > step}
                                    onClick={() => setStep(index)}
                                    className={cn(
                                        'flex min-h-11 w-full items-center justify-center gap-1.5 rounded-control px-2 text-xs font-medium',
                                        index === step ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
                                        index > step && 'opacity-45',
                                    )}
                                >
                                    {index < step ? <Check className="h-4 w-4 shrink-0" /> : <Icon className="h-4 w-4 shrink-0" />}
                                    <span className="truncate">{index + 1}. {t(`library.workflow.step${index + 1}`, item.label)}</span>
                                </button>
                            </li>
                        )
                    })}
                </ol>

                <div className="min-h-0 overflow-y-auto p-5">
                    {step === 0 && (
                        <section className="mx-auto max-w-xl space-y-5">
                            <div>
                                <h3 className="text-base font-semibold">{t('library.workflow.whereTitle', '어디에 저장할까요?')}</h3>
                                <p className="mt-1 text-sm text-muted-foreground">{t('library.workflow.whereHelp', '폴더 하나만 고르면 로컬 경로와 R2 프리픽스가 함께 정해집니다.')}</p>
                            </div>
                            <GenerationFolderPicker
                                value={folderId}
                                disabled={busy}
                                onChange={selection => {
                                    if (!selection) return
                                    setFolderId(selection.folder.id)
                                    autoUploadTouched.current = false
                                    setAutoUpload(selection.r2Ready && selection.folder.r2.autoUpload)
                                }}
                            />
                            {folder && (
                                <div className="rounded-panel bg-muted/45 p-4 text-sm">
                                    <span className="font-medium">{t('library.workflow.destinationPreview', '선택한 위치')}</span>
                                    <p className="mt-1 break-all text-muted-foreground">{folder.path}</p>
                                </div>
                            )}
                        </section>
                    )}

                    {step === 1 && (
                        <section className="mx-auto max-w-xl space-y-5">
                            <div>
                                <h3 className="text-base font-semibold">{t('library.workflow.editTitle', '이미지를 어떻게 저장할까요?')}</h3>
                                <p className="mt-1 text-sm text-muted-foreground">{t('library.workflow.editHelp', '원본은 건드리지 않고 새 파일을 만듭니다.')}</p>
                            </div>
                            <div className="grid gap-2 sm:grid-cols-3" role="group" aria-label={t('library.workflow.format', '저장 형식')}>
                                {([
                                    ['keep', t('library.workflow.keepFormat', '현재 형식 유지')],
                                    ['png', 'PNG'],
                                    ['webp', 'WebP'],
                                ] as const).map(([value, label]) => (
                                    <button
                                        key={value}
                                        type="button"
                                        aria-pressed={format === value}
                                        onClick={() => setFormat(value)}
                                        className={cn(
                                            'min-h-16 rounded-panel border p-3 text-left text-sm font-medium transition-colors',
                                            format === value ? 'border-primary bg-primary/10 text-foreground' : 'border-border hover:bg-accent',
                                        )}
                                    >
                                        {label}
                                        {format === value && <Check className="ml-2 inline h-4 w-4 text-primary" />}
                                    </button>
                                ))}
                            </div>
                            {hasJpeg && format === 'keep' && (
                                <p className="text-xs text-muted-foreground">{t('library.workflow.jpegToPng', 'JPEG는 편집 가능한 PNG 복사본으로 저장됩니다.')}</p>
                            )}
                            <label className={cn(
                                'flex min-h-16 items-start gap-3 rounded-panel border border-border p-4',
                                publicUploadRequiresStrip && 'bg-muted/45',
                            )}>
                                <Checkbox
                                    checked={stripMetadata}
                                    disabled={publicUploadRequiresStrip}
                                    onCheckedChange={checked => setStripMetadata(checked === true)}
                                />
                                <span className="text-sm font-medium">
                                    {t('library.workflow.stripMetadata', '공유용 메타데이터 제거')}
                                    <span className="mt-1 block text-xs font-normal leading-5 text-muted-foreground">
                                        {publicUploadRequiresStrip
                                            ? t('library.workflow.publicR2Strip', '공개 R2 업로드를 위해 자동으로 적용됩니다.')
                                            : t('library.workflow.stripHelp', '컨테이너와 픽셀 은닉 정보를 정화하고, 복구 정보는 로컬 JSON sidecar에 보존합니다.')}
                                    </span>
                                </span>
                            </label>
                        </section>
                    )}

                    {step === 2 && (
                        <section className="mx-auto max-w-xl space-y-5">
                            <div>
                                <h3 className="text-base font-semibold">{t('library.workflow.reviewTitle', '마지막으로 확인해 주세요')}</h3>
                                <p className="mt-1 text-sm text-muted-foreground">{t('library.workflow.reviewHelp', '완료하면 새 파일이 라이브러리에 추가됩니다.')}</p>
                            </div>
                            <div className="divide-y divide-border/60 rounded-panel border border-border text-sm">
                                <div className="flex justify-between gap-4 p-3"><span className="text-muted-foreground">{t('library.workflow.folder', '폴더')}</span><span className="truncate font-medium">{folder?.path}</span></div>
                                <div className="flex justify-between gap-4 p-3"><span className="text-muted-foreground">{t('library.workflow.outputFormat', '형식')}</span><span className="font-medium">{format === 'keep' ? t('library.workflow.keepFormat', '현재 형식 유지') : format.toUpperCase()}</span></div>
                                <div className="flex justify-between gap-4 p-3"><span className="text-muted-foreground">{t('library.workflow.metadata', '메타데이터')}</span><span className="font-medium">{stripMetadata
                                    ? t('library.workflow.willStrip', '제거 + sidecar 보존')
                                    : format === 'keep'
                                        ? t('library.workflow.willKeep', '유지')
                                        : t('library.workflow.convertMetadata', '같은 형식은 유지 · 변환 시 sidecar 보존')}</span></div>
                            </div>
                            <div className={cn('rounded-panel border border-border p-4', !r2Ready && 'bg-muted/45 opacity-70')}>
                                <label className="choice-row flex min-h-11 items-start gap-3">
                                    <Checkbox
                                        checked={r2Ready && autoUpload}
                                        disabled={!r2Ready}
                                        onCheckedChange={checked => {
                                            autoUploadTouched.current = true
                                            setAutoUpload(checked === true)
                                        }}
                                    />
                                    <span className="text-sm font-medium">
                                        {t('library.workflow.uploadR2', '완료 후 R2에도 업로드')}
                                        <span className="mt-1 block text-xs font-normal text-muted-foreground">
                                            {folder ? `${folder.r2.bucket ?? '-'} / ${folder.r2.prefix || '-'}` : '-'}
                                        </span>
                                    </span>
                                </label>
                                {!r2Ready && requestedProfileId !== null && (
                                    <Button asChild type="button" variant="outline" size="sm" className="mt-3 opacity-100">
                                        <Link to="/guided-preview/task/library/r2"><UploadCloud className="mr-2 h-4 w-4" />{t('library.workflow.setupR2', 'R2 업로드 설정하기')}</Link>
                                    </Button>
                                )}
                            </div>
                            <div className="flex items-start gap-2 rounded-panel bg-success/10 p-3 text-xs leading-5 text-foreground">
                                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                                {t('library.workflow.originalSafe', '원본 파일은 그대로 남습니다. 새 파일과 필요한 sidecar만 선택한 폴더에 추가합니다.')}
                            </div>
                        </section>
                    )}
                </div>

                <div className="flex items-center justify-between gap-3 border-t border-border/60 bg-background px-5 py-4">
                    <Button type="button" variant="ghost" disabled={busy || step === 0} onClick={() => setStep(current => Math.max(0, current - 1))}>
                        <ArrowLeft className="mr-2 h-4 w-4" />{t('common.back', '이전')}
                    </Button>
                    {busyProgress ? (
                        <div className="min-w-0 flex-1 text-right text-sm font-medium" role="status">
                            {t('library.workflow.processing', '처리 중 {{current}} / {{total}}', busyProgress)}
                        </div>
                    ) : step < 2 ? (
                        <Button type="button" disabled={folder === null} onClick={() => setStep(current => Math.min(2, current + 1))}>
                            {t('common.next', '다음')}<ArrowRight className="ml-2 h-4 w-4" />
                        </Button>
                    ) : (
                        <Button
                            type="button"
                            disabled={folder === null}
                            onClick={() => folder && void onConfirm({
                                folder,
                                format,
                                stripMetadata,
                                autoUpload: r2Ready && autoUpload,
                            })}
                        >
                            <Check className="mr-2 h-4 w-4" />{t('library.workflow.createCopies', '새 파일 만들기')}
                        </Button>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    )
}
