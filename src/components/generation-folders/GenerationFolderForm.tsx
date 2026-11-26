import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Check, CloudUpload, FolderOpen, Save, Trash2 } from 'lucide-react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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

export interface FolderRow {
    readonly folder: GenerationFolder
    readonly depth: number
}

const STEPS = ['저장 위치', '그림 설명', '인터넷에 올리기'] as const

export function buildGenerationFolderRows(folders: readonly GenerationFolder[]): FolderRow[] {
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

export interface GenerationFolderFormProps {
    folder: GenerationFolder & { readonly pathSegment?: string }
    open: boolean
    mode: 'stepped' | 'stacked'
    onSaved?: (folderId: string) => void
    onRequestDelete?: () => void
    extraContent?: ReactNode
}

/** Edits one generation folder's storage, common prompt, and R2 upload policy through the atomic store action. */
export function GenerationFolderForm({
    folder: selected,
    open,
    mode,
    onSaved,
    onRequestDelete,
    extraContent,
}: GenerationFolderFormProps) {
    const { t } = useTranslation()
    const folders = useSettingsStore(state => state.generationFolders)
    const folderDocument = useSettingsStore(state => state.generationFolderDocument)
    const savePath = useSettingsStore(state => state.savePath)
    const useAbsolutePath = useSettingsStore(state => state.useAbsolutePath)
    const saveFolder = useSettingsStore(state => state.saveGenerationFolder)
    const copyPrompt = useSettingsStore(state => state.copyGenerationFolderPrompt)
    const setActive = useSettingsStore(state => state.setActiveGenerationFolder)
    const rows = useMemo(() => buildGenerationFolderRows(folders), [folders])

    const [step, setStep] = useState(0)
    const [name, setName] = useState(selected.name)
    const [parentId, setParentId] = useState<string | null>(selected.parentId)
    const [rootDirectory, setRootDirectory] = useState(selected.rootDirectory ?? '')
    const [absolute, setAbsolute] = useState(selected.useAbsolutePath)
    const [commonPrompt, setCommonPrompt] = useState(selected.commonPrompt)
    const [autoUpload, setAutoUpload] = useState(selected.r2.autoUpload)
    const [bucket, setBucket] = useState(selected.r2.bucket ?? '')
    const [prefix, setPrefix] = useState(selected.r2.prefix ?? '')
    const [transferTargets, setTransferTargets] = useState<string[]>([])
    const [error, setError] = useState<string | null>(null)

    const selectedPreliminary = resolveGenerationFolderAuthority(folderDocument, folders, selected.id, {
        directory: savePath,
        useAbsolutePath,
        r2ProfileId: DEFAULT_R2_PROFILE_ID,
    })
    const selectedProfileId = selectedPreliminary?.r2.profileId ?? null
    const r2State = useDefaultR2Readiness(selectedProfileId, open && selectedProfileId !== null)
    const { profile: selectedR2Profile, ready: r2Ready } = matchR2Readiness(selectedProfileId, r2State)

    useEffect(() => {
        if (!open) return
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
    }, [open, selected.id, selected.name, selected.parentId, selected.rootDirectory, selected.useAbsolutePath, selected.commonPrompt, selected.r2.autoUpload, selected.r2.bucket, selected.r2.prefix])

    const defaultFolder = selected.id === DEFAULT_GENERATION_FOLDER_ID
    const usesSystemDefaultName = defaultFolder && selected.name === '기본 출력'
    const descendants = new Set(generationFolderDescendantIds(folders, selected.id))
    const parentOptions = rows.filter(row => row.folder.id !== selected.id && !descendants.has(row.folder.id))
    const transferOptions = rows.filter(row => descendants.has(row.folder.id))

    let previewDocument = folderDocument
    let resolved: ReturnType<typeof resolveGenerationFolderAuthority> = null
    try {
        if (folderDocument !== null) {
            const authorityFolder = folderDocument.folders.find(candidate => candidate.id === selected.id)
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

    const save = async () => {
        try {
            await saveFolder(selected.id, parentId, {
                name,
                rootDirectory,
                useAbsolutePath: absolute,
                commonPrompt,
                r2: {
                    // Readiness gates execution; a transient connection state must not erase the saved preference.
                    autoUpload,
                    bucket,
                    prefix,
                },
            })
            setActive(selected.id)
            setError(null)
            onSaved?.(selected.id)
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

    const localSection = (
        <section className={cn('space-y-4', mode === 'stepped' && 'mx-auto max-w-xl space-y-5')}>
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
                <label className="choice-row grid gap-2 text-xs font-medium">
                    <span>{t('generationFolders.manager.rootPath', '실제 저장 위치')}</span>
                    <div className="flex gap-2">
                        <Input value={rootDirectory} onChange={event => setRootDirectory(event.target.value)} placeholder="NAI_Blue_Output" />
                        <Button type="button" variant="outline" className="min-h-11 shrink-0" onClick={() => void browse()}><FolderOpen className="mr-2 h-4 w-4" />{t('generationFolders.manager.browse', '찾아보기')}</Button>
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
            {mode === 'stacked' && resolved?.directory && parentId === null && (
                <p className="fb-path">{resolved.directory}</p>
            )}
        </section>
    )

    const promptSection = (
        <section className={cn('space-y-4', mode === 'stepped' && 'mx-auto max-w-xl space-y-5')}>
            <div>
                <h3 className="text-base font-semibold">{t('generationFolders.manager.promptTitle', '이 폴더의 모든 이미지에 넣을 설명이 있나요?')}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{t('generationFolders.manager.promptHelp', '없으면 비워 두고 다음으로 넘어가도 됩니다.')}</p>
            </div>
            <label className="grid gap-2 text-xs font-medium">
                <span>{t('generationFolders.manager.commonPrompt', '모든 이미지에 넣을 그림 설명 · 선택')}</span>
                <textarea className="min-h-28 resize-y rounded-control border border-input bg-background p-3 text-sm" value={commonPrompt} onChange={event => setCommonPrompt(event.target.value)} maxLength={20_000} placeholder={t('generationFolders.manager.commonPlaceholder', '이 폴더에서 만들 이미지의 설명 앞에 넣어요.')} />
                <span className="font-normal text-muted-foreground">{t('generationFolders.manager.noPromptInheritance', '안쪽에 새로 만든 폴더에는 자동으로 복사되지 않아요.')}</span>
            </label>
            {transferOptions.length > 0 && (
                <details className="workspace-disclosure rounded-panel border border-border/60 px-4 py-1">
                    <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold">{t('generationFolders.manager.transferTitle', '이 설명을 안쪽 폴더에도 복사하기')}</summary>
                    <div className="pb-3">
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                            {transferOptions.map(row => (
                                <label key={row.folder.id} className="choice-row flex min-h-9 items-center gap-2 text-xs">
                                    <Checkbox checked={transferTargets.includes(row.folder.id)} onCheckedChange={checked => setTransferTargets(current => checked === true ? [...current, row.folder.id] : current.filter(id => id !== row.folder.id))} />
                                    <span className="truncate">{row.folder.name}</span>
                                </label>
                            ))}
                        </div>
                        <p className="mt-2 text-xs text-muted-foreground">{t('generationFolders.manager.transferWarning', '선택한 폴더에 있던 그림 설명을 이 설명으로 바꿔요.')}</p>
                        <Button type="button" size="sm" variant="outline" className="mt-3" disabled={transferTargets.length === 0} onClick={() => void transferPrompt()}>{t('generationFolders.manager.transferAction', '선택한 폴더로 복사')}</Button>
                    </div>
                </details>
            )}
        </section>
    )

    const uploadSection = (
        <section className={cn('space-y-4', mode === 'stepped' && 'mx-auto max-w-xl space-y-5')}>
            <div>
                <h3 className="text-base font-semibold">{t('generationFolders.manager.r2Title', '완성된 이미지를 인터넷에도 올릴까요?')}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{t('generationFolders.manager.r2Help', '폴더마다 켜거나 끌 수 있습니다.')}</p>
            </div>
            <div className={cn('rounded-panel border border-border p-4', !r2Ready && 'bg-muted/45 opacity-70')}>
                <label className="choice-row flex min-h-11 items-start gap-3 text-sm font-medium">
                    <Checkbox checked={autoUpload} disabled={!r2Ready} onCheckedChange={checked => setAutoUpload(checked === true)} />
                    <span>{t('generationFolders.manager.autoUpload', '이 폴더에서 만든 이미지를 자동으로 올리기')}<span className="mt-1 block text-xs font-normal text-muted-foreground">{t('generationFolders.manager.autoUploadHelp', '하위 폴더는 각자 따로 선택합니다.')}</span></span>
                </label>
                {!r2Ready && selectedProfileId !== null && (
                    <Button asChild type="button" variant="outline" size="sm" className="mt-3 opacity-100">
                        <Link to={mode === 'stacked' ? '/r2' : '/guided-preview/task/library/r2'}><CloudUpload className="mr-2 h-4 w-4" />{t('generationFolders.manager.setupR2', '인터넷에 올리기 설정')}</Link>
                    </Button>
                )}
            </div>
            {resolved && (
                <div className="rounded-panel bg-muted/45 p-4 text-sm">
                    <p className="font-medium">{t('generationFolders.manager.target', '인터넷 저장 위치')}</p>
                    <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{resolved.r2.bucket ?? t('generationFolders.manager.bucketUnset', '저장 공간을 아직 정하지 않았어요')}/{resolved.r2.prefix}</p>
                </div>
            )}
            <details className="workspace-disclosure rounded-panel border border-border/60 px-4 py-1">
                <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold">{t('generationFolders.manager.advancedR2', '인터넷 저장 위치 직접 바꾸기')}</summary>
                <div className="pb-3">
                    <div className="mt-2 grid gap-3 sm:grid-cols-2">
                        <label className="grid gap-1 text-xs font-medium"><span>{t('generationFolders.manager.bucketOverride', '저장 공간 이름 (버킷)')}</span><Input value={bucket} onChange={event => setBucket(event.target.value)} placeholder={selectedR2Profile?.bucket || t('generationFolders.manager.useDefaultProfile', '기존 연결 설정 사용')} /></label>
                        <label className="grid gap-1 text-xs font-medium"><span>{t('generationFolders.manager.prefixOverride', '저장할 폴더 이름')}</span><Input value={prefix} onChange={event => setPrefix(event.target.value)} placeholder={selectedR2Profile?.prefix || t('generationFolders.manager.useDefaultProfile', '기존 연결 설정 사용')} /></label>
                    </div>
                    <p className="mt-3 text-xs leading-5 text-muted-foreground">{t('generationFolders.manager.prefixRule', '바깥 폴더의 저장 위치 뒤에 이 폴더 이름이 붙어요. 여기에 직접 적으면 적은 위치를 사용해요.')}</p>
                </div>
            </details>
        </section>
    )

    if (mode === 'stacked') {
        return (
            <form className="fb-settings-sections" onSubmit={event => { event.preventDefault(); void save() }}>
                {localSection}
                {promptSection}
                {uploadSection}
                {extraContent}
                {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
                <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-4">
                    <Button type="submit" className="fb-button fb-primary w-full sm:w-auto">
                        <Save className="h-4 w-4" aria-hidden="true" />
                        {t('generationFolders.manager.save', '설정 저장')}
                    </Button>
                </div>
            </form>
        )
    }

    return (
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
                {step === 0 && localSection}
                {step === 1 && promptSection}
                {step === 2 && uploadSection}
                {error && <p className="mx-auto mt-4 max-w-xl text-xs text-destructive" role="alert">{error}</p>}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 bg-background px-5 py-4">
                {onRequestDelete && (
                    <Button type="button" variant="ghost" className="text-destructive" disabled={defaultFolder} onClick={onRequestDelete}>
                        <Trash2 className="mr-2 h-4 w-4" />{t('generationFolders.manager.delete', '폴더 정의 삭제')}
                    </Button>
                )}
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
    )
}
