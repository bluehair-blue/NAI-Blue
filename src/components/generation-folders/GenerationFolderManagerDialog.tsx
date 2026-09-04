import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, CloudUpload, FolderOpen, FolderPlus, Save, Trash2 } from 'lucide-react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/use-toast'
import { planGenerationFolderChanges } from '@/application/folder/plan-folder-changes'
import {
    DEFAULT_GENERATION_FOLDER_ID,
    generationFolderDescendantIds,
    type GenerationFolder,
} from '@/domain/generation-folders'
import { DEFAULT_R2_PROFILE_ID } from '@/domain/r2/types'
import { matchR2Readiness, useDefaultR2Readiness } from '@/hooks/useDefaultR2Readiness'
import { cn } from '@/lib/utils'
import { openNativeFileDialog } from '@/platform/native-file-dialog'
import { resolveGenerationFolderAuthority } from '@/lib/generation-folder-authority-runtime'
import { useSettingsStore } from '@/stores/settings-store'

interface FolderRow {
    readonly folder: GenerationFolder
    readonly depth: number
}

const STEPS = ['컴퓨터 저장 위치', '공통 프롬프트', 'R2 업로드'] as const

function folderRows(folders: readonly GenerationFolder[]): FolderRow[] {
    const rows: FolderRow[] = []
    const append = (parentId: string | null, depth: number) => {
        for (const folder of folders.filter(candidate => candidate.parentId === parentId)) {
            rows.push({ folder, depth })
            append(folder.id, depth + 1)
        }
    }
    append(null, 0)
    return rows
}

export function GenerationFolderManagerDialog({
    open,
    onOpenChange,
    onSaved,
}: {
    open: boolean
    onOpenChange(open: boolean): void
    onSaved?(folderId: string): void
}) {
    const { t } = useTranslation()
    const folders = useSettingsStore(state => state.generationFolders)
    const folderDocument = useSettingsStore(state => state.generationFolderDocument)
    const activeId = useSettingsStore(state => state.activeGenerationFolderId)
    const savePath = useSettingsStore(state => state.savePath)
    const useAbsolutePath = useSettingsStore(state => state.useAbsolutePath)
    const addFolder = useSettingsStore(state => state.addGenerationFolder)
    const saveFolder = useSettingsStore(state => state.saveGenerationFolder)
    const deleteFolders = useSettingsStore(state => state.deleteGenerationFolders)
    const copyPrompt = useSettingsStore(state => state.copyGenerationFolderPrompt)
    const setActive = useSettingsStore(state => state.setActiveGenerationFolder)
    const rows = useMemo(() => folderRows(folders), [folders])
    const [selectedId, setSelectedId] = useState(activeId)
    const selected = folders.find(folder => folder.id === selectedId) ?? folders[0]
    const [step, setStep] = useState(0)
    const [newName, setNewName] = useState('')
    const [name, setName] = useState('')
    const [parentId, setParentId] = useState<string | null>(null)
    const [rootDirectory, setRootDirectory] = useState('')
    const [absolute, setAbsolute] = useState(false)
    const [commonPrompt, setCommonPrompt] = useState('')
    const [autoUpload, setAutoUpload] = useState(false)
    const [bucket, setBucket] = useState('')
    const [prefix, setPrefix] = useState('')
    const [transferTargets, setTransferTargets] = useState<string[]>([])
    const [error, setError] = useState<string | null>(null)
    const [deleteOpen, setDeleteOpen] = useState(false)
    const selectedPreliminary = resolveGenerationFolderAuthority(folderDocument, folders, selected?.id, {
        directory: savePath,
        useAbsolutePath,
        r2ProfileId: DEFAULT_R2_PROFILE_ID,
    })
    const selectedProfileId = selectedPreliminary?.r2.profileId ?? null
    const r2State = useDefaultR2Readiness(selectedProfileId, open && selectedProfileId !== null)
    const { profile: selectedR2Profile, ready: r2Ready } = matchR2Readiness(selectedProfileId, r2State)

    useEffect(() => {
        if (!open) return
        setSelectedId(activeId)
        setStep(0)
    }, [activeId, open])

    useEffect(() => {
        if (!open || !selected) return
        setName(selected.name)
        setParentId(selected.parentId)
        setRootDirectory(selected.rootDirectory ?? '')
        setAbsolute(selected.useAbsolutePath)
        setCommonPrompt(selected.commonPrompt)
        setAutoUpload(selected.r2.autoUpload)
        setBucket(selected.r2.bucket ?? '')
        setPrefix(selected.r2.prefix ?? '')
        setTransferTargets([])
        setError(null)
        setStep(0)
    }, [open, selected?.id])

    if (!selected) return null

    const defaultFolder = selected.id === DEFAULT_GENERATION_FOLDER_ID
    const usesSystemDefaultName = defaultFolder && selected.name === '기본 출력'
    const descendants = new Set(generationFolderDescendantIds(folders, selected.id))
    const parentOptions = rows.filter(row => row.folder.id !== selected.id && !descendants.has(row.folder.id))
    const transferOptions = rows.filter(row => descendants.has(row.folder.id))
    let previewDocument = folderDocument
    let resolved: ReturnType<typeof resolveGenerationFolderAuthority> = null
    try {
        if (folderDocument !== null) {
            const authorityFolder = folderDocument.folders.find(folder => folder.id === selected.id)
            if (authorityFolder === undefined) throw new TypeError('Generation folder does not exist')
            const bucketValue = bucket.trim()
            const prefixValue = prefix.trim()
            const planned = planGenerationFolderChanges(folderDocument, [{
                folderId: selected.id,
                displayName: name.trim() || selected.name,
                parentId,
                rootDirectory: parentId === null ? rootDirectory.trim() || selected.pathSegment || selected.name : null,
                useAbsolutePath: parentId === null && absolute,
                commonPrompt,
                autoUpload,
                r2BucketPolicy: bucketValue
                    ? { mode: 'set', value: bucketValue }
                    : authorityFolder.r2BucketPolicy.mode === 'set'
                        ? { mode: 'inherit' }
                        : authorityFolder.r2BucketPolicy,
                r2PrefixPolicy: prefixValue
                    ? { mode: 'set', value: prefixValue }
                    : authorityFolder.r2PrefixPolicy.mode === 'set'
                        ? { mode: 'inherit' }
                        : authorityFolder.r2PrefixPolicy,
            }], {
                directory: savePath,
                useAbsolutePath,
                r2ProfileId: selectedProfileId,
                r2Bucket: selectedR2Profile?.bucket,
                r2Prefix: selectedR2Profile?.prefix,
            })
            previewDocument = planned.status === 'PLANNED' ? planned.document : null
        }
        resolved = resolveGenerationFolderAuthority(previewDocument, folders, selected.id, {
            directory: savePath,
            useAbsolutePath,
            r2ProfileId: selectedProfileId,
            r2Bucket: selectedR2Profile?.bucket,
            r2Prefix: selectedR2Profile?.prefix,
        })
    } catch {
        resolved = null
    }

    const createFolder = async (asRoot: boolean) => {
        try {
            const id = await addFolder({
                name: newName,
                parentId: asRoot ? null : selected.id,
                rootDirectory: asRoot ? newName : null,
            })
            setNewName('')
            setSelectedId(id)
            setActive(id)
        } catch {
            setError(t('generationFolders.manager.createError', '폴더 이름을 확인해 주세요.'))
        }
    }

    const save = async () => {
        try {
            await saveFolder(selected.id, parentId, {
                name,
                rootDirectory,
                useAbsolutePath: absolute,
                commonPrompt,
                r2: {
                    autoUpload: r2Ready ? autoUpload : false,
                    bucket,
                    prefix,
                },
            })
            setActive(selected.id)
            setError(null)
            onSaved?.(selected.id)
            onOpenChange(false)
            toast({ title: t('generationFolders.manager.saved', '폴더 설정을 저장했어요.'), variant: 'success' })
        } catch {
            setError(t('generationFolders.manager.saveError', '입력값을 확인해 주세요. 폴더 설정은 아직 저장되지 않았습니다.'))
        }
    }

    const transferPrompt = async () => {
        try {
            await copyPrompt(selected.id, transferTargets, commonPrompt)
            setError(null)
        } catch {
            setError(t('generationFolders.manager.saveError', '입력값을 확인해 주세요. 폴더 설정은 아직 저장되지 않았습니다.'))
        }
    }

    const browse = async () => {
        const picked = await openNativeFileDialog({
            directory: true,
            multiple: false,
            title: t('generationFolders.manager.browseTitle', '이미지를 저장할 폴더 선택'),
        })
        if (typeof picked === 'string') {
            setRootDirectory(picked)
            setAbsolute(true)
        }
    }

    return (
        <>
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent className="grid max-h-[calc(100dvh-2rem)] max-w-4xl grid-rows-[auto_minmax(0,1fr)] overflow-hidden p-0">
                    <DialogHeader className="border-b border-border/60 px-5 py-4 pr-14">
                        <DialogTitle>{t('generationFolders.manager.title', '이미지 저장 폴더')}</DialogTitle>
                        <DialogDescription>{t('generationFolders.manager.simpleDescription', '왼쪽에서 폴더를 고르고, 오른쪽의 3단계만 따라가면 됩니다.')}</DialogDescription>
                    </DialogHeader>

                    <div className="grid min-h-0 overflow-y-auto md:grid-cols-[minmax(14rem,0.72fr)_minmax(0,1.28fr)] md:overflow-hidden">
                        <aside className="border-b border-border/60 p-4 md:overflow-y-auto md:border-b-0 md:border-r">
                            <p className="mb-2 text-xs font-semibold text-muted-foreground">{t('generationFolders.manager.folderList', '내 폴더')}</p>
                            <div className="space-y-1">
                                {rows.map(row => (
                                    <button
                                        key={row.folder.id}
                                        type="button"
                                        className={cn(
                                            'flex min-h-11 w-full items-center gap-2 rounded-control px-2 text-left text-sm',
                                            row.folder.id === selected.id ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/55',
                                        )}
                                        style={{ paddingLeft: `${0.5 + row.depth * 1.15}rem` }}
                                        onClick={() => setSelectedId(row.folder.id)}
                                    >
                                        <FolderOpen className="h-4 w-4 shrink-0" />
                                        <span className="truncate">{row.folder.id === DEFAULT_GENERATION_FOLDER_ID && row.folder.name === '기본 출력'
                                            ? t('generationFolders.defaultName', '기본 출력')
                                            : row.folder.name}</span>
                                    </button>
                                ))}
                            </div>

                            <div className="mt-4 rounded-panel border border-border/60 p-3">
                                <p className="text-xs font-semibold">{t('generationFolders.manager.addTitle', '새 폴더 만들기')}</p>
                                <Input className="mt-2" value={newName} onChange={event => setNewName(event.target.value)} placeholder={t('generationFolders.manager.newName', '예: 01 오프닝')} maxLength={96} />
                                <Button type="button" size="sm" className="mt-2 w-full" disabled={!newName.trim()} onClick={() => void createFolder(false)}>
                                    <FolderPlus className="mr-1.5 h-4 w-4" />{t('generationFolders.manager.createInside', '선택한 폴더 안에 만들기')}
                                </Button>
                                <Button type="button" variant="ghost" size="sm" className="mt-1 w-full" disabled={!newName.trim()} onClick={() => void createFolder(true)}>
                                    {t('generationFolders.manager.createSeparate', '별도 최상위 폴더로 만들기')}
                                </Button>
                            </div>
                        </aside>

                        <main className="grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] md:overflow-hidden">
                            <div className="border-b border-border/60 px-5 py-4">
                                <p className="truncate text-base font-semibold">{resolved?.path ?? name}</p>
                                <p className="mt-1 truncate text-xs text-muted-foreground" title={resolved?.directory}>{resolved?.directory}</p>
                            </div>

                            <ol className="grid grid-cols-3 gap-1 border-b border-border/60 px-3 py-3 sm:px-5" aria-label={t('generationFolders.manager.steps', '폴더 설정 단계')}>
                                {STEPS.map((label, index) => (
                                    <li key={label} className="min-w-0">
                                        <button
                                            type="button"
                                            disabled={index > step}
                                            onClick={() => setStep(index)}
                                            className={cn(
                                                'flex min-h-11 w-full items-center justify-center gap-1 rounded-control px-2 text-xs font-medium',
                                                index === step ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
                                                index > step && 'opacity-45',
                                            )}
                                        >
                                            {index < step && <Check className="h-3.5 w-3.5 shrink-0" />}
                                            <span className="truncate">{index + 1}. {t(`generationFolders.manager.step${index + 1}`, label)}</span>
                                        </button>
                                    </li>
                                ))}
                            </ol>

                            <div className="min-h-0 overflow-y-auto p-5">
                                {step === 0 && (
                                    <section className="mx-auto max-w-xl space-y-5">
                                        <div>
                                            <h3 className="text-base font-semibold">{t('generationFolders.manager.localTitle', '컴퓨터에서 어디에 저장할까요?')}</h3>
                                            <p className="mt-1 text-sm text-muted-foreground">{t('generationFolders.manager.localHelp', '하위 폴더는 상위 폴더 안에 자동으로 만들어집니다.')}</p>
                                        </div>
                                        <label className="grid gap-1 text-xs font-medium">
                                            <span>{t('generationFolders.manager.name', '폴더 이름')}</span>
                                            <Input value={usesSystemDefaultName ? t('generationFolders.defaultName', '기본 출력') : name} disabled={usesSystemDefaultName} onChange={event => setName(event.target.value)} maxLength={96} />
                                        </label>
                                        <label className="grid gap-1 text-xs font-medium">
                                            <span>{t('generationFolders.manager.parent', '어느 폴더 안에 둘까요?')}</span>
                                            <select className="min-h-11 border-x-0 border-y border-input bg-background px-3 text-sm" value={parentId ?? ''} onChange={event => setParentId(event.target.value || null)} disabled={defaultFolder}>
                                                <option value="">{t('generationFolders.manager.noParent', '별도 최상위 폴더')}</option>
                                                {parentOptions.map(row => <option key={row.folder.id} value={row.folder.id}>{'— '.repeat(row.depth)}{row.folder.name}</option>)}
                                            </select>
                                        </label>
                                        {parentId === null ? (
                                            <label className="grid gap-2 text-xs font-medium">
                                                <span>{t('generationFolders.manager.rootPath', '실제 저장 위치')}</span>
                                                <div className="flex gap-2">
                                                    <Input value={rootDirectory} onChange={event => setRootDirectory(event.target.value)} placeholder="NAI_Blue_Output" />
                                                    <Button type="button" variant="outline" onClick={() => void browse()}><FolderOpen className="mr-2 h-4 w-4" />{t('generationFolders.manager.browse', '찾아보기')}</Button>
                                                </div>
                                                <span className="flex min-h-8 items-center gap-2 font-normal text-muted-foreground">
                                                    <Checkbox checked={absolute} onCheckedChange={checked => setAbsolute(checked === true)} />
                                                    {t('generationFolders.manager.useAbsolute', '입력한 전체 경로를 그대로 사용')}
                                                </span>
                                            </label>
                                        ) : (
                                            <div className="rounded-panel bg-muted/45 p-4 text-sm">
                                                <p className="font-medium">{t('generationFolders.manager.autoPath', '저장 위치는 자동입니다')}</p>
                                                <p className="mt-1 break-all text-xs text-muted-foreground">{resolved?.directory}</p>
                                            </div>
                                        )}
                                    </section>
                                )}

                                {step === 1 && (
                                    <section className="mx-auto max-w-xl space-y-5">
                                        <div>
                                            <h3 className="text-base font-semibold">{t('generationFolders.manager.promptTitle', '이 폴더에서 항상 쓸 프롬프트가 있나요?')}</h3>
                                            <p className="mt-1 text-sm text-muted-foreground">{t('generationFolders.manager.promptHelp', '없으면 비워 두고 다음으로 넘어가도 됩니다.')}</p>
                                        </div>
                                        <label className="grid gap-2 text-xs font-medium">
                                            <span>{t('generationFolders.manager.commonPrompt', '폴더 공통 프롬프트 · 선택')}</span>
                                            <textarea className="min-h-32 resize-y rounded-control border border-input bg-background p-3 text-sm" value={commonPrompt} onChange={event => setCommonPrompt(event.target.value)} maxLength={20_000} placeholder={t('generationFolders.manager.commonPlaceholder', '이 폴더의 작업 앞에만 추가됩니다.')} />
                                            <span className="font-normal text-muted-foreground">{t('generationFolders.manager.noPromptInheritance', '새 하위 폴더에는 자동으로 복사되지 않습니다.')}</span>
                                        </label>
                                        {transferOptions.length > 0 && (
                                            <details className="rounded-panel border border-border/60 p-4">
                                                <summary className="cursor-pointer text-sm font-semibold">{t('generationFolders.manager.transferTitle', '이 프롬프트를 기존 하위 폴더에도 복사')}</summary>
                                                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                                                    {transferOptions.map(row => (
                                                        <label key={row.folder.id} className="flex min-h-9 items-center gap-2 text-xs">
                                                            <Checkbox checked={transferTargets.includes(row.folder.id)} onCheckedChange={checked => setTransferTargets(current => checked === true ? [...current, row.folder.id] : current.filter(id => id !== row.folder.id))} />
                                                            <span className="truncate">{row.folder.name}</span>
                                                        </label>
                                                    ))}
                                                </div>
                                                <p className="mt-2 text-xs text-muted-foreground">{t('generationFolders.manager.transferWarning', '선택한 폴더의 기존 공통 프롬프트를 덮어씁니다.')}</p>
                                                <Button type="button" size="sm" variant="outline" className="mt-3" disabled={transferTargets.length === 0} onClick={() => void transferPrompt()}>{t('generationFolders.manager.transferAction', '선택한 폴더로 복사')}</Button>
                                            </details>
                                        )}
                                    </section>
                                )}

                                {step === 2 && (
                                    <section className="mx-auto max-w-xl space-y-5">
                                        <div>
                                            <h3 className="text-base font-semibold">{t('generationFolders.manager.r2Title', '완료된 이미지를 R2에도 올릴까요?')}</h3>
                                            <p className="mt-1 text-sm text-muted-foreground">{t('generationFolders.manager.r2Help', '폴더마다 켜거나 끌 수 있습니다.')}</p>
                                        </div>
                                        <div className={cn('rounded-panel border border-border p-4', !r2Ready && 'bg-muted/45 opacity-70')}>
                                            <label className="flex min-h-11 items-start gap-3 text-sm font-medium">
                                                <Checkbox checked={r2Ready && autoUpload} disabled={!r2Ready} onCheckedChange={checked => setAutoUpload(checked === true)} />
                                                <span>{t('generationFolders.manager.autoUpload', '이 폴더의 새 이미지를 자동 업로드')}<span className="mt-1 block text-xs font-normal text-muted-foreground">{t('generationFolders.manager.autoUploadHelp', '하위 폴더는 각자 따로 선택합니다.')}</span></span>
                                            </label>
                                            {!r2Ready && selectedProfileId !== null && (
                                                <Button asChild type="button" variant="outline" size="sm" className="mt-3 opacity-100">
                                                    <Link to="/guided-preview/task/library/r2"><CloudUpload className="mr-2 h-4 w-4" />{t('generationFolders.manager.setupR2', 'R2 업로드 설정하기')}</Link>
                                                </Button>
                                            )}
                                        </div>
                                        {resolved && (
                                            <div className="rounded-panel bg-muted/45 p-4 text-sm">
                                                <p className="font-medium">{t('generationFolders.manager.target', '업로드 위치')}</p>
                                                <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{resolved.r2.bucket ?? t('generationFolders.manager.bucketUnset', '버킷 미설정')}/{resolved.r2.prefix}</p>
                                            </div>
                                        )}
                                        <details className="rounded-panel border border-border/60 p-4">
                                            <summary className="cursor-pointer text-sm font-semibold">{t('generationFolders.manager.advancedR2', '버킷 또는 프리픽스 직접 바꾸기 · 고급')}</summary>
                                            <div className="mt-4 grid gap-3 sm:grid-cols-2">
                                                <label className="grid gap-1 text-xs font-medium"><span>{t('generationFolders.manager.bucketOverride', '버킷')}</span><Input value={bucket} onChange={event => setBucket(event.target.value)} placeholder={selectedR2Profile?.bucket || t('generationFolders.manager.useDefaultProfile', '기본 프로필 사용')} /></label>
                                                <label className="grid gap-1 text-xs font-medium"><span>{t('generationFolders.manager.prefixOverride', '프리픽스')}</span><Input value={prefix} onChange={event => setPrefix(event.target.value)} placeholder={selectedR2Profile?.prefix || t('generationFolders.manager.useDefaultProfile', '기본 프로필 사용')} /></label>
                                            </div>
                                            <p className="mt-3 text-xs leading-5 text-muted-foreground">{t('generationFolders.manager.prefixRule', '상위 프리픽스가 있으면 폴더 이름이 뒤에 붙습니다. 이 폴더에서 직접 입력한 값이 있으면 그 값이 우선합니다.')}</p>
                                        </details>
                                    </section>
                                )}

                                {error && <p className="mx-auto mt-4 max-w-xl text-xs text-destructive" role="alert">{error}</p>}
                            </div>

                            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 bg-background px-5 py-4">
                                <Button type="button" variant="ghost" className="text-destructive" disabled={defaultFolder} onClick={() => setDeleteOpen(true)}><Trash2 className="mr-2 h-4 w-4" />{t('generationFolders.manager.delete', '폴더 정의 삭제')}</Button>
                                <div className="ml-auto flex gap-2">
                                    {step > 0 && <Button type="button" variant="outline" onClick={() => setStep(current => current - 1)}><ArrowLeft className="mr-2 h-4 w-4" />{t('common.back', '이전')}</Button>}
                                    {step < 2 ? (
                                        <Button type="button" onClick={() => setStep(current => current + 1)}>{t('common.next', '다음')}<ArrowRight className="ml-2 h-4 w-4" /></Button>
                                    ) : (
                                        <Button type="button" onClick={() => void save()}><Save className="mr-2 h-4 w-4" />{t('generationFolders.manager.save', '설정 저장')}</Button>
                                    )}
                                </div>
                            </div>
                        </main>
                    </div>
                </DialogContent>
            </Dialog>

            <ConfirmDialog
                open={deleteOpen}
                onOpenChange={setDeleteOpen}
                title={t('generationFolders.manager.deleteTitle', '이 생성 폴더를 삭제할까요?')}
                description={t('generationFolders.manager.deleteDescription', '하위 폴더 정의도 함께 삭제됩니다. 디스크의 이미지와 R2 파일은 삭제하지 않습니다.')}
                confirmText={t('generationFolders.manager.delete', '폴더 정의 삭제')}
                variant="destructive"
                onConfirm={async () => {
                    try {
                        await deleteFolders([selected.id])
                        setSelectedId(DEFAULT_GENERATION_FOLDER_ID)
                        setError(null)
                    } catch {
                        setError(t('generationFolders.manager.saveError', '입력값을 확인해 주세요. 폴더 설정은 아직 저장되지 않았습니다.'))
                        throw new Error('Generation folder deletion rejected')
                    }
                }}
            />
        </>
    )
}
