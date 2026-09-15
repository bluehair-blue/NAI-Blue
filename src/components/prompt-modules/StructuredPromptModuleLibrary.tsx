import { useEffect, useMemo, useState } from 'react'
import {
    BookOpen,
    ChevronDown,
    ChevronUp,
    Copy,
    FilePlus2,
    FolderPlus,
    Pencil,
    Plus,
    Search,
    Trash2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import {
    PROMPT_MODULE_PART_KINDS,
    movePromptModulePart,
    normalizePromptModuleFolder,
    usePromptModuleLibraryStore,
    type PromptModulePartKind,
    type PromptModulePartValues,
    type StructuredPromptModule,
    type StructuredPromptModulePart,
} from '@/stores/prompt-module-library-store'

const ROOT_FOLDER = '__root__'
const MAX_VISIBLE_MODULES = 200
const MAX_VISIBLE_COPY_TARGETS = 200

function partLabel(kind: PromptModulePartKind, t: ReturnType<typeof useTranslation>['t']): string {
    return {
        base: t('promptModuleLibrary.parts.base', '베이스 프롬프트'),
        detail: t('promptModuleLibrary.parts.detail', '세부 프롬프트'),
        additional: t('promptModuleLibrary.parts.additional', '추가 프롬프트'),
        negative: t('promptModuleLibrary.parts.negative', '네거티브 프롬프트'),
        character: t('promptModuleLibrary.parts.character', '캐릭터 프롬프트'),
        'character-negative': t('promptModuleLibrary.parts.characterNegative', '캐릭터 네거티브 프롬프트'),
    }[kind]
}

function moduleSummary(module: StructuredPromptModule): string {
    const filled = module.parts.filter(part => part.content.trim()).length
    return `${filled}/${PROMPT_MODULE_PART_KINDS.length}`
}

function ModuleEditor({
    module,
    open,
    onOpenChange,
}: {
    module: StructuredPromptModule | null
    open: boolean
    onOpenChange(open: boolean): void
}) {
    const { t } = useTranslation()
    const modules = usePromptModuleLibraryStore(state => state.modules)
    const replaceModule = usePromptModuleLibraryStore(state => state.replaceModule)
    const copyPart = usePromptModuleLibraryStore(state => state.copyPart)
    const [draft, setDraft] = useState<StructuredPromptModule | null>(null)
    const [addKind, setAddKind] = useState<PromptModulePartKind>('base')
    const [deleteKind, setDeleteKind] = useState<PromptModulePartKind | null>(null)
    const [copyKind, setCopyKind] = useState<PromptModulePartKind | null>(null)
    const [copyTargetId, setCopyTargetId] = useState('')
    const [copyQuery, setCopyQuery] = useState('')
    const [error, setError] = useState('')

    useEffect(() => {
        if (!open || !module) return
        setDraft(structuredClone(module))
        setError('')
        setDeleteKind(null)
        setCopyKind(null)
        setCopyTargetId('')
        setCopyQuery('')
    }, [module, open])

    if (!draft) return null
    const missingKinds = PROMPT_MODULE_PART_KINDS.filter(kind => !draft.parts.some(part => part.kind === kind))
    const targets = modules.filter(candidate => candidate.id !== draft.id)
    const normalizedCopyQuery = copyQuery.trim().toLocaleLowerCase()
    const matchingTargets = normalizedCopyQuery
        ? targets.filter(target => `${target.folder}/${target.name}`.toLocaleLowerCase().includes(normalizedCopyQuery))
        : targets
    const visibleTargets = matchingTargets.slice(0, MAX_VISIBLE_COPY_TARGETS)

    const setPartContent = (kind: PromptModulePartKind, content: string) => {
        setDraft(current => current === null ? null : ({
            ...current,
            parts: current.parts.map(part => part.kind === kind ? { ...part, content } : part),
        }))
    }

    const save = () => {
        const folder = normalizePromptModuleFolder(draft.folder)
        if (!draft.name.trim() || folder === null) {
            setError(t('promptModuleLibrary.editor.invalid', '이름과 폴더 경로를 확인해 주세요.'))
            return
        }
        replaceModule({ ...draft, name: draft.name.trim(), folder })
        onOpenChange(false)
    }

    return (
        <>
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent className="flex max-h-[calc(100dvh-1rem)] max-w-3xl flex-col overflow-hidden p-4 sm:p-6">
                    <DialogHeader>
                        <DialogTitle>{t('promptModuleLibrary.editor.title', '모듈 편집')}</DialogTitle>
                        <DialogDescription>
                            {t('promptModuleLibrary.editor.description', '파트의 내용과 순서를 정하세요. 위치 좌표는 모듈에 저장되지 않습니다.')}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Input
                            value={draft.name}
                            onChange={event => setDraft(current => current && ({ ...current, name: event.target.value }))}
                            placeholder={t('promptModuleLibrary.name', '모듈 이름')}
                            aria-label={t('promptModuleLibrary.name', '모듈 이름')}
                        />
                        <Input
                            value={draft.folder}
                            onChange={event => setDraft(current => current && ({ ...current, folder: event.target.value }))}
                            placeholder={t('promptModuleLibrary.folderPath', '폴더/하위 폴더')}
                            aria-label={t('promptModuleLibrary.folderPath', '폴더/하위 폴더')}
                        />
                    </div>

                    <div className="custom-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
                        {draft.parts.map((part, index) => (
                            <section key={part.kind} className="border-y border-border/60 py-3">
                                <div className="flex min-w-0 items-center gap-1">
                                    <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{partLabel(part.kind, t)}</h3>
                                    <Button type="button" variant="ghost" size="icon" className="h-9 w-9" disabled={index === 0} onClick={() => setDraft(current => current && ({ ...current, parts: movePromptModulePart(current.parts, part.kind, 'up') }))} aria-label={t('promptModuleLibrary.moveUp', '위로 이동')}>
                                        <ChevronUp className="h-4 w-4" />
                                    </Button>
                                    <Button type="button" variant="ghost" size="icon" className="h-9 w-9" disabled={index === draft.parts.length - 1} onClick={() => setDraft(current => current && ({ ...current, parts: movePromptModulePart(current.parts, part.kind, 'down') }))} aria-label={t('promptModuleLibrary.moveDown', '아래로 이동')}>
                                        <ChevronDown className="h-4 w-4" />
                                    </Button>
                                    <Button type="button" variant="ghost" size="icon" className="h-9 w-9" disabled={targets.length === 0} onClick={() => setCopyKind(part.kind)} aria-label={t('promptModuleLibrary.copyPart', '다른 모듈로 복사')}>
                                        <Copy className="h-4 w-4" />
                                    </Button>
                                    <Button type="button" variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground hover:text-destructive" onClick={() => setDeleteKind(part.kind)} aria-label={t('promptModuleLibrary.deletePart', '파트 삭제')}>
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                </div>
                                <Textarea
                                    value={part.content}
                                    onChange={event => setPartContent(part.kind, event.target.value)}
                                    className="mt-2 min-h-24 resize-y"
                                    placeholder={t('promptModuleLibrary.partPlaceholder', '{{part}} 내용을 입력', { part: partLabel(part.kind, t) })}
                                />
                            </section>
                        ))}
                        {missingKinds.length > 0 && (
                            <div className="flex flex-col gap-2 border-y border-border/60 py-3 sm:flex-row">
                                <select value={missingKinds.includes(addKind) ? addKind : missingKinds[0]} onChange={event => setAddKind(event.target.value as PromptModulePartKind)} className="min-h-11 min-w-0 flex-1 border-x-0 border-y border-input bg-background px-3 text-sm">
                                    {missingKinds.map(kind => <option key={kind} value={kind}>{partLabel(kind, t)}</option>)}
                                </select>
                                <Button type="button" variant="outline" onClick={() => {
                                    const kind = missingKinds.includes(addKind) ? addKind : missingKinds[0]
                                    setDraft(current => current && ({ ...current, parts: [...current.parts, { kind, content: '' }] }))
                                }}>
                                    <Plus className="mr-2 h-4 w-4" />{t('promptModuleLibrary.addPart', '파트 추가')}
                                </Button>
                            </div>
                        )}
                    </div>
                    {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t('common.cancel', '취소')}</Button>
                        <Button type="button" onClick={save}>{t('common.save', '저장')}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <ConfirmDialog
                open={deleteKind !== null}
                onOpenChange={next => { if (!next) setDeleteKind(null) }}
                title={t('promptModuleLibrary.confirmPartDelete', '이 파트만 삭제할까요?')}
                description={t('promptModuleLibrary.confirmPartDeleteHelp', '다른 파트와 다른 모듈은 그대로 유지됩니다.')}
                confirmText={t('promptModuleLibrary.deletePart', '파트 삭제')}
                cancelText={t('common.cancel', '취소')}
                variant="destructive"
                onConfirm={() => {
                    if (deleteKind) setDraft(current => current && ({ ...current, parts: current.parts.filter(part => part.kind !== deleteKind) }))
                    setDeleteKind(null)
                }}
            />

            <Dialog open={copyKind !== null} onOpenChange={next => { if (!next) { setCopyKind(null); setCopyTargetId(''); setCopyQuery('') } }}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>{t('promptModuleLibrary.copyTitle', '파트를 다른 모듈로 복사')}</DialogTitle>
                        <DialogDescription>{t('promptModuleLibrary.copyHelp', '대상에 같은 파트가 있으면 기존 내용 뒤에 안전하게 추가합니다.')}</DialogDescription>
                    </DialogHeader>
                    <Input value={copyQuery} onChange={event => { setCopyQuery(event.target.value); setCopyTargetId('') }} placeholder={t('promptModuleLibrary.searchCopyTarget', '대상 모듈 검색')} />
                    <select value={copyTargetId} onChange={event => setCopyTargetId(event.target.value)} className="min-h-11 w-full border-x-0 border-y border-input bg-background px-3 text-sm" aria-label={t('promptModuleLibrary.copyTarget', '복사할 대상 모듈')}>
                        <option value="">{t('promptModuleLibrary.chooseTarget', '대상 모듈 선택')}</option>
                        {visibleTargets.map(target => <option key={target.id} value={target.id}>{target.folder ? `${target.folder}/` : ''}{target.name}</option>)}
                    </select>
                    {matchingTargets.length > visibleTargets.length && <p className="text-xs text-muted-foreground">{t('promptModuleLibrary.narrowCopyResults', '{{shown}} / {{total}}개 표시 · 검색어로 범위를 좁혀 주세요.', { shown: visibleTargets.length, total: matchingTargets.length })}</p>}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => setCopyKind(null)}>{t('common.cancel', '취소')}</Button>
                        <Button type="button" disabled={!copyTargetId} onClick={() => {
                            if (!copyKind || !copyTargetId) return
                            replaceModule(draft)
                            copyPart(draft.id, copyKind, copyTargetId)
                            setCopyKind(null)
                            setCopyTargetId('')
                        }}>{t('promptModuleLibrary.copy', '복사')}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    )
}

export function StructuredPromptModuleLibrary({
    disabled = false,
    currentParts = {},
    onInsert,
    triggerLabel,
    triggerClassName,
}: {
    disabled?: boolean
    currentParts?: PromptModulePartValues
    onInsert(parts: readonly StructuredPromptModulePart[], module: StructuredPromptModule): void
    triggerLabel?: string
    triggerClassName?: string
}) {
    const { t } = useTranslation()
    const folders = usePromptModuleLibraryStore(state => state.folders)
    const modules = usePromptModuleLibraryStore(state => state.modules)
    const addFolder = usePromptModuleLibraryStore(state => state.addFolder)
    const createModule = usePromptModuleLibraryStore(state => state.createModule)
    const deleteModule = usePromptModuleLibraryStore(state => state.deleteModule)
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null)
    const [selectedKinds, setSelectedKinds] = useState<Set<PromptModulePartKind>>(new Set())
    const [editingModuleId, setEditingModuleId] = useState<string | null>(null)
    const [deleteModuleId, setDeleteModuleId] = useState<string | null>(null)
    const [createOpen, setCreateOpen] = useState(false)
    const [createName, setCreateName] = useState('')
    const [createFolder, setCreateFolder] = useState('')
    const [useCurrent, setUseCurrent] = useState(true)
    const [createError, setCreateError] = useState('')
    const [folderOpen, setFolderOpen] = useState(false)
    const [folderPath, setFolderPath] = useState('')
    const [folderError, setFolderError] = useState('')

    const selectedModule = modules.find(module => module.id === selectedModuleId) ?? null
    const editingModule = modules.find(module => module.id === editingModuleId) ?? null
    const moduleResults = useMemo(() => {
        const normalized = query.trim().toLocaleLowerCase()
        const matched = normalized
            ? modules.filter(module => `${module.folder}/${module.name}`.toLocaleLowerCase().includes(normalized))
            : modules
        const visible = matched.slice(0, MAX_VISIBLE_MODULES)
        const byFolder = new Map<string, StructuredPromptModule[]>()
        for (const module of visible) {
            const group = byFolder.get(module.folder)
            if (group) group.push(module)
            else byFolder.set(module.folder, [module])
        }
        if (!normalized) for (const folder of folders) if (!byFolder.has(folder)) byFolder.set(folder, [])
        const grouped = [...byFolder]
            .map(([folder, folderModules]) => ({ folder, modules: folderModules }))
            .filter(group => group.modules.length > 0 || (!normalized && group.folder !== ''))
            .sort((left, right) => left.folder.localeCompare(right.folder))
        return { grouped, matchedCount: matched.length, visibleCount: visible.length }
    }, [folders, modules, query])

    const chooseModule = (module: StructuredPromptModule) => {
        setSelectedModuleId(module.id)
        setSelectedKinds(new Set(module.parts.filter(part => part.content.trim()).map(part => part.kind)))
    }

    const insert = () => {
        if (!selectedModule) return
        const parts = selectedModule.parts.filter(part => selectedKinds.has(part.kind) && part.content.trim())
        if (parts.length === 0) return
        onInsert(parts, selectedModule)
        setOpen(false)
    }

    return (
        <>
            <Dialog open={open} onOpenChange={next => {
                setOpen(next)
                if (!next) { setQuery(''); setSelectedModuleId(null); setSelectedKinds(new Set()) }
            }}>
                <DialogTrigger asChild>
                    <Button type="button" variant="ghost" size="sm" disabled={disabled} className={cn('rounded-none border-b border-border/70 px-1 text-muted-foreground', triggerClassName)}>
                        <BookOpen className="mr-2 h-4 w-4" />
                        {triggerLabel ?? t('promptModuleLibrary.trigger', '구조화 모듈 불러오기')}
                    </Button>
                </DialogTrigger>
                <DialogContent className="flex h-[min(44rem,calc(100dvh-1rem))] max-h-[calc(100dvh-1rem)] max-w-5xl flex-col overflow-hidden p-4 sm:p-6">
                    <DialogHeader>
                        <DialogTitle>{t('promptModuleLibrary.title', '프롬프트 관리 폴더')}</DialogTitle>
                        <DialogDescription>{t('promptModuleLibrary.description', '모듈을 고르고 이번 작업에 넣을 파트만 체크하세요.')}</DialogDescription>
                    </DialogHeader>
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="relative min-w-48 flex-1">
                            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('promptModuleLibrary.search', '폴더 또는 모듈 검색')} className="pl-10" />
                        </div>
                        <Button type="button" variant="outline" size="sm" onClick={() => setFolderOpen(true)}><FolderPlus className="mr-2 h-4 w-4" />{t('promptModuleLibrary.newFolder', '폴더 추가')}</Button>
                        <Button type="button" variant="outline" size="sm" onClick={() => setCreateOpen(true)}><FilePlus2 className="mr-2 h-4 w-4" />{t('promptModuleLibrary.newModule', '모듈 추가')}</Button>
                    </div>
                    <div className="grid min-h-0 flex-1 grid-rows-[minmax(11rem,40%)_minmax(0,1fr)] gap-4 md:grid-cols-[minmax(15rem,0.8fr)_minmax(0,1.2fr)] md:grid-rows-1">
                        <section className="custom-scrollbar min-h-0 overflow-y-auto border-y border-border/70 py-2" aria-label={t('promptModuleLibrary.modules', '저장된 모듈')}>
                            {modules.length === 0 ? (
                                <p className="px-4 py-8 text-center text-sm leading-6 text-muted-foreground">{t('promptModuleLibrary.empty', '아직 모듈이 없어요. 현재 프롬프트로 첫 모듈을 만들어 보세요.')}</p>
                            ) : moduleResults.matchedCount === 0 ? (
                                <p className="px-4 py-8 text-center text-sm leading-6 text-muted-foreground">{t('promptModuleLibrary.noSearchResults', '일치하는 모듈이 없어요.')}</p>
                            ) : (
                                <div>
                                    {moduleResults.matchedCount > moduleResults.visibleCount && (
                                        <p className="border-b border-border/50 px-3 py-2 text-xs text-muted-foreground">{t('promptModuleLibrary.narrowResults', '{{shown}} / {{total}}개 표시 · 검색어로 범위를 좁혀 주세요.', { shown: moduleResults.visibleCount, total: moduleResults.matchedCount })}</p>
                                    )}
                                    {moduleResults.grouped.map(group => (
                                        <div key={group.folder || ROOT_FOLDER} className="pb-3 last:pb-0">
                                            <h3 className="px-3 py-1 text-xs font-semibold text-muted-foreground">{group.folder || t('promptModuleLibrary.root', '관리 폴더 루트')}</h3>
                                            {group.modules.length === 0
                                                ? <p className="px-3 py-2 text-xs text-muted-foreground">{t('promptModuleLibrary.emptyFolder', '빈 폴더')}</p>
                                                : group.modules.map(module => (
                                                    <button key={module.id} type="button" onClick={() => chooseModule(module)} className={cn('flex min-h-11 w-full items-center gap-2 border-l-2 px-3 py-2 text-left', selectedModuleId === module.id ? 'border-primary bg-primary/[0.08]' : 'border-transparent hover:bg-accent/50')}>
                                                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{module.name}</span>
                                                        <span className="shrink-0 font-mono text-xs text-muted-foreground">{moduleSummary(module)}</span>
                                                    </button>
                                                ))}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </section>
                        <section className="custom-scrollbar min-h-0 overflow-y-auto border-y border-border/70" aria-live="polite">
                            {!selectedModule ? (
                                <p className="px-4 py-10 text-center text-sm leading-6 text-muted-foreground">{t('promptModuleLibrary.chooseModule', '왼쪽에서 모듈을 선택하세요.')}</p>
                            ) : (
                                <div>
                                    <div className="flex items-start gap-2 border-b border-border/60 px-3 py-3">
                                        <div className="min-w-0 flex-1">
                                            <h3 className="break-words text-base font-semibold">{selectedModule.name}</h3>
                                            <p className="mt-1 text-xs text-muted-foreground">{selectedModule.folder || t('promptModuleLibrary.root', '관리 폴더 루트')}</p>
                                        </div>
                                        <Button type="button" variant="ghost" size="sm" onClick={() => setEditingModuleId(selectedModule.id)}><Pencil className="mr-2 h-4 w-4" />{t('common.edit', '편집')}</Button>
                                        <Button type="button" variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground hover:text-destructive" onClick={() => setDeleteModuleId(selectedModule.id)} aria-label={t('promptModuleLibrary.deleteModule', '모듈 삭제')}><Trash2 className="h-4 w-4" /></Button>
                                    </div>
                                    {selectedModule.parts.length === 0 ? <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('promptModuleLibrary.noParts', '편집에서 파트를 추가해 주세요.')}</p> : selectedModule.parts.map(part => {
                                        const usable = part.content.trim().length > 0
                                        return (
                                            <label key={part.kind} className={cn('flex min-h-16 items-start gap-3 border-b border-border/45 px-3 py-3 last:border-0', !usable && 'opacity-45')}>
                                                <Checkbox checked={selectedKinds.has(part.kind)} disabled={!usable} onCheckedChange={checked => setSelectedKinds(current => {
                                                    const next = new Set(current)
                                                    if (checked === true) next.add(part.kind); else next.delete(part.kind)
                                                    return next
                                                })} />
                                                <span className="min-w-0 flex-1">
                                                    <span className="block text-sm font-semibold">{partLabel(part.kind, t)}</span>
                                                    <span className="mt-1 block line-clamp-2 whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">{part.content || t('promptModuleLibrary.emptyPart', '내용 없음')}</span>
                                                </span>
                                            </label>
                                        )
                                    })}
                                </div>
                            )}
                        </section>
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>{t('common.cancel', '취소')}</Button>
                        <Button type="button" disabled={!selectedModule || selectedKinds.size === 0} onClick={insert}>{t('promptModuleLibrary.insertSelected', '선택한 파트 삽입')}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={createOpen} onOpenChange={next => { setCreateOpen(next); if (!next) { setCreateName(''); setCreateFolder(''); setCreateError('') } }}>
                <DialogContent className="max-w-md">
                    <DialogHeader><DialogTitle>{t('promptModuleLibrary.newModule', '모듈 추가')}</DialogTitle><DialogDescription>{t('promptModuleLibrary.newModuleHelp', '현재 작업을 가져오거나 빈 모듈로 시작할 수 있어요.')}</DialogDescription></DialogHeader>
                    <Input value={createName} onChange={event => setCreateName(event.target.value)} placeholder={t('promptModuleLibrary.name', '모듈 이름')} autoFocus />
                    <Input value={createFolder} onChange={event => setCreateFolder(event.target.value)} placeholder={t('promptModuleLibrary.folderPath', '폴더/하위 폴더')} />
                    <label className="choice-row flex min-h-11 items-center gap-3 text-sm"><Checkbox checked={useCurrent} onCheckedChange={checked => setUseCurrent(checked === true)} />{t('promptModuleLibrary.useCurrent', '현재 작업의 프롬프트를 파트로 가져오기')}</label>
                    {createError && <p className="text-sm text-destructive" role="alert">{createError}</p>}
                    <DialogFooter><Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>{t('common.cancel', '취소')}</Button><Button type="button" onClick={() => {
                        try {
                            const id = createModule({ name: createName, folder: createFolder, parts: useCurrent ? currentParts : { base: '' } })
                            setCreateOpen(false)
                            setSelectedModuleId(id)
                            setSelectedKinds(new Set(PROMPT_MODULE_PART_KINDS.filter(kind => Boolean(useCurrent && currentParts[kind]?.trim()))))
                            setEditingModuleId(id)
                        } catch { setCreateError(t('promptModuleLibrary.editor.invalid', '이름과 폴더 경로를 확인해 주세요.')) }
                    }}>{t('promptModuleLibrary.create', '만들기')}</Button></DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={folderOpen} onOpenChange={next => { setFolderOpen(next); if (!next) { setFolderPath(''); setFolderError('') } }}>
                <DialogContent className="max-w-md">
                    <DialogHeader><DialogTitle>{t('promptModuleLibrary.newFolder', '폴더 추가')}</DialogTitle><DialogDescription>{t('promptModuleLibrary.newFolderHelp', '슬래시(/)를 사용하면 하위 폴더를 한 번에 만들 수 있어요.')}</DialogDescription></DialogHeader>
                    <Input value={folderPath} onChange={event => setFolderPath(event.target.value)} placeholder={t('promptModuleLibrary.folderExample', '예: 캐릭터/판타지')} autoFocus />
                    {folderError && <p className="text-sm text-destructive" role="alert">{folderError}</p>}
                    <DialogFooter><Button type="button" variant="ghost" onClick={() => setFolderOpen(false)}>{t('common.cancel', '취소')}</Button><Button type="button" onClick={() => {
                        const folder = addFolder(folderPath)
                        if (!folder) { setFolderError(t('promptModuleLibrary.invalidFolder', '폴더 경로를 확인해 주세요.')); return }
                        setCreateFolder(folder)
                        setFolderOpen(false)
                    }}>{t('promptModuleLibrary.create', '만들기')}</Button></DialogFooter>
                </DialogContent>
            </Dialog>

            <ModuleEditor module={editingModule} open={editingModuleId !== null && editingModule !== null} onOpenChange={next => { if (!next) setEditingModuleId(null) }} />

            <ConfirmDialog open={deleteModuleId !== null} onOpenChange={next => { if (!next) setDeleteModuleId(null) }} title={t('promptModuleLibrary.confirmModuleDelete', '이 모듈을 삭제할까요?')} description={t('promptModuleLibrary.confirmModuleDeleteHelp', '현재 작업에 이미 삽입한 프롬프트는 바뀌지 않습니다.')} confirmText={t('promptModuleLibrary.deleteModule', '모듈 삭제')} cancelText={t('common.cancel', '취소')} variant="destructive" onConfirm={() => {
                if (deleteModuleId) deleteModule(deleteModuleId)
                setDeleteModuleId(null)
                setSelectedModuleId(null)
                setSelectedKinds(new Set())
            }} />
        </>
    )
}
