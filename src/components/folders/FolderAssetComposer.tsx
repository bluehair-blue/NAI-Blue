import { useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight, ChevronDown, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { MAX_FOLDER_ASSET_ROWS, parseFolderAssetTable, type FolderAssetInput } from '@/presentation/folders/folder-workbench'
import type { SceneFolderTemplate } from '@/stores/scene-store'
import { completeFolderDraft, emptyComposerDraft, hasFolderDraftInput, loadFolderDraft, saveFolderDraft, type FolderComposerDraft } from '@/presentation/folders/folder-workbench-draft'

interface FolderAssetComposerProps {
    folderId: string
    busy: boolean
    disabled: boolean
    error: string | null
    templates: Array<{ id: string; name: string; template: SceneFolderTemplate }>
    onSubmit: (rows: FolderAssetInput[], template?: SceneFolderTemplate) => Promise<boolean>
}

const emptyRow = () => ({ id: crypto.randomUUID(), name: '', prompt: '', count: '1' })
const control = 'min-h-11 !rounded-[4px]'

/** Restores folder-scoped inputs; the parent alone commits assets and owns the review step. */
export function FolderAssetComposer({ folderId, busy, disabled, error, templates, onSubmit }: FolderAssetComposerProps) {
    const { t } = useTranslation()
    const formId = useId()
    const [restored] = useState(() => loadFolderDraft(folderId))
    const [inputs, setInputs] = useState<FolderComposerDraft>(() => restored.draft ?? emptyComposerDraft())
    const inputRef = useRef(inputs)
    const [draftSaved, setDraftSaved] = useState(restored.saved)
    const { mode, rows: draft, table, templateId } = inputs
    const updateInputs = (patch: Partial<FolderComposerDraft>) => {
        const next = { ...inputRef.current, ...patch }
        inputRef.current = next
        setInputs(next)
        setDraftSaved(saveFolderDraft(folderId, next))
    }
    const setDraft = (update: (rows: FolderComposerDraft['rows']) => FolderComposerDraft['rows']) => updateInputs({ rows: update(inputRef.current.rows) })
    const setMode = (mode: FolderComposerDraft['mode']) => updateInputs({ mode })
    const setTable = (table: string) => updateInputs({ table })
    const setTemplateId = (templateId: string) => updateInputs({ templateId })
    const [submitting, setSubmitting] = useState(false)
    const [validationError, setValidationError] = useState<string | null>(null)
    const parsed = useMemo(() => parseFolderAssetTable(table), [table])
    const locked = busy || submitting || disabled
    const hasInput = mode === 'form' ? draft.some(row => row.prompt.trim()) : parsed.rows.length > 0
    const updateRow = (id: string, patch: Partial<Pick<typeof draft[number], 'name' | 'prompt' | 'count'>>) => {
        setDraft(rows => rows.map(row => row.id === id ? { ...row, ...patch } : row))
        setValidationError(null)
    }

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault()
        if (locked || !hasInput || (mode === 'table' && parsed.errors.length > 0)) return
        if (templateId && !templates.some(template => template.id === templateId)) {
            setValidationError(t('folderWorkbench.composer.missingTemplate', '저장한 생성 설정을 찾지 못했어요. 기본 설정이나 다른 설정을 골라 주세요.'))
            return
        }
        const submitted = inputRef.current
        const rows = mode === 'table' ? parsed.rows : draft.map((row, index) => ({
            name: row.name.trim() || `asset_${String(index + 1).padStart(3, '0')}`,
            prompt: row.prompt.trim(),
            count: Number(row.count),
        }))
        if (rows.some(row => !row.prompt || row.prompt.length > 20_000)) {
            setValidationError(t('folderWorkbench.pasteError.prompt'))
            return
        }
        if (rows.some(row => !Number.isSafeInteger(row.count) || row.count < 1 || row.count > 999)) {
            setValidationError(t('folderWorkbench.pasteError.count'))
            return
        }
        setSubmitting(true)
        setValidationError(null)
        try {
            if (await onSubmit(rows, templates.find(template => template.id === templateId)?.template)) {
                const completed = completeFolderDraft(folderId, submitted)
                if (inputRef.current === submitted && completed) {
                    inputRef.current = completed.draft
                    setInputs(completed.draft)
                    setDraftSaved(completed.saved)
                }
            }
        } catch {
            setValidationError(t('folderWorkbench.actionFailed'))
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <form onSubmit={submit} className="fb-composer min-w-0 space-y-5" aria-busy={busy || submitting}>
            <fieldset disabled={locked} className="min-w-0 space-y-4">
                {mode === 'form' ? <>
                    {draft.map((row, index) => <div key={row.id} className="min-w-0 space-y-3 rounded-[4px] border border-border/70 bg-card p-3 sm:p-4">
                        {draft.length > 1 && <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-medium">{t('folderWorkbench.composer.asset', { number: index + 1 })}</span>
                            {draft.length > 1 && <Button type="button" variant="ghost" size="icon" className={control}
                                aria-label={t('folderWorkbench.composer.remove', { number: index + 1 })}
                                onClick={() => setDraft(rows => rows.filter(item => item.id !== row.id))}>
                                <Trash2 className="h-4 w-4" aria-hidden="true" />
                            </Button>}
                        </div>}
                        <div className="space-y-2">
                            <label htmlFor={`${formId}-${row.id}-prompt`} className="block text-sm font-medium">{t('folderWorkbench.composer.prompt')}</label>
                            <Textarea id={`${formId}-${row.id}-prompt`} required maxLength={20_000} rows={3}
                                className={`${control} resize-y`} value={row.prompt}
                                placeholder={t('folderWorkbench.composer.promptPlaceholder')}
                                onChange={event => updateRow(row.id, { prompt: event.target.value })} />
                        </div>
                        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_5.5rem] gap-3">
                            <div className="min-w-0 space-y-2">
                                <label htmlFor={`${formId}-${row.id}-name`} className="block text-sm">{t('folderWorkbench.composer.name')}</label>
                                <Input id={`${formId}-${row.id}-name`} className={control} maxLength={96} value={row.name}
                                    placeholder={t('folderWorkbench.composer.namePlaceholder')}
                                    onChange={event => updateRow(row.id, { name: event.target.value })} />
                            </div>
                            <div className="space-y-2">
                                <label htmlFor={`${formId}-${row.id}-count`} className="block text-sm">{t('folderWorkbench.composer.count')}</label>
                                <Input id={`${formId}-${row.id}-count`} className={control} type="number" required min={1} max={999} step={1}
                                    value={row.count} onChange={event => updateRow(row.id, { count: event.target.value })} />
                            </div>
                        </div>
                    </div>)}
                </> : <div className="min-w-0 space-y-3">
                    <label htmlFor={`${formId}-table`} className="block text-sm font-medium">{t('folderWorkbench.composer.tableLabel')}</label>
                    <p id={`${formId}-table-help`} className="text-sm leading-relaxed text-muted-foreground">{t('folderWorkbench.composer.tableHelp')}</p>
                    <Textarea id={`${formId}-table`} rows={7} className={`${control} resize-y`} value={table}
                        aria-describedby={`${formId}-table-help`} placeholder={t('folderWorkbench.composer.tablePlaceholder')}
                        onChange={event => { setTable(event.target.value); setValidationError(null) }} />
                    {table.trim() && <div className="space-y-2 text-sm" aria-live="polite">
                        <p>{t('folderWorkbench.pasteSummary', { items: parsed.rows.length, images: parsed.rows.reduce((sum, row) => sum + row.count, 0) })}</p>
                        {parsed.errors.length > 0 && <div role="alert" className="space-y-1 text-destructive">
                            <p>{t('folderWorkbench.pasteErrors', { count: parsed.errors.length })}</p>
                            {parsed.errors.slice(0, 5).map(issue => <p key={`${issue.line}-${issue.code}`}>
                                {t('folderWorkbench.errorLine', { line: issue.line })}: {t(`folderWorkbench.pasteError.${issue.code}`)}
                            </p>)}
                        </div>}
                        {parsed.rows.length > 0 && <div className="space-y-2 rounded-[4px] border border-border/70 p-3">
                            <p className="font-medium">{t('folderWorkbench.composer.preview')}</p>
                            {parsed.rows.slice(0, 3).map((row, index) => <div key={index} className="min-w-0">
                                <p className="break-words font-medium">{row.name} · {t('folderWorkbench.composer.images', { count: row.count })}</p>
                                <p className="line-clamp-2 break-words text-muted-foreground">{row.prompt}</p>
                            </div>)}
                        </div>}
                    </div>}
                </div>}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    {mode === 'form' && <Button type="button" variant="outline" className={control}
                        disabled={draft.length >= MAX_FOLDER_ASSET_ROWS} onClick={() => setDraft(rows => [...rows, emptyRow()])}>
                        <Plus className="mr-2 h-4 w-4" aria-hidden="true" />{t('folderWorkbench.composer.addPrompt')}
                    </Button>}
                    <Button type="button" variant="link" className={`${control} h-auto max-w-full whitespace-normal px-0 text-left`}
                        onClick={() => { setMode(mode === 'form' ? 'table' : 'form'); setValidationError(null) }}>
                        {t(mode === 'form' ? 'folderWorkbench.composer.tableMode' : 'folderWorkbench.composer.formMode')}
                    </Button>
                </div>
                {(templates.length > 0 || templateId) && <details className="group rounded-[4px] border border-border/70 px-3">
                    <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 text-sm font-medium">
                        {t('folderWorkbench.composer.settings')}
                        <ChevronDown className="h-4 w-4 group-open:rotate-180" aria-hidden="true" />
                    </summary>
                    <div className="space-y-2 pb-3">
                        <label htmlFor={`${formId}-template`} className="block text-sm">{t('folderWorkbench.generationTemplate')}</label>
                        <select id={`${formId}-template`} value={templateId} onChange={event => setTemplateId(event.target.value)}
                            className={`${control} w-full min-w-0 border border-input bg-canvas px-3 text-sm`}>
                            <option value="">{t('folderWorkbench.defaultTemplate')}</option>
                            {templateId && !templates.some(template => template.id === templateId) && <option value={templateId} disabled>{t('folderWorkbench.composer.unavailableTemplate', '찾을 수 없는 설정')}</option>}
                            {templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
                        </select>
                    </div>
                </details>}
            </fieldset>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <p role="status" className={draftSaved ? 'text-muted-foreground' : 'text-destructive'}>{draftSaved
                    ? hasFolderDraftInput(inputs) ? t('folderWorkbench.composer.draftSaved', '이 폴더의 초안을 저장했어요. 닫아도 이어서 쓸 수 있어요.') : t('folderWorkbench.composer.draftAutoSave', '작성 중인 내용은 이 기기에 자동으로 저장돼요.')
                    : t('folderWorkbench.composer.draftFailed', '초안을 저장하지 못했어요. 화면을 닫기 전에 입력을 복사해 주세요.')}</p>
                <Button type="button" variant="ghost" className={control} disabled={locked || !hasFolderDraftInput(inputs)} onClick={() => {
                    if (!saveFolderDraft(folderId, null)) { setDraftSaved(false); return }
                    const next = emptyComposerDraft()
                    inputRef.current = next
                    setInputs(next)
                    setDraftSaved(true)
                    setValidationError(null)
                }}>{t('folderWorkbench.composer.discardDraft', '초안 버리기')}</Button>
            </div>
            {(error || validationError) && <p role="alert" className="text-sm text-destructive">{error || validationError}</p>}
            <div className="space-y-3 border-t border-border/70 pt-4">
                <p className="text-sm leading-relaxed text-muted-foreground">{t('folderWorkbench.composer.reviewHint')}</p>
                <Button type="submit" className={`${control} h-auto w-full whitespace-normal py-3 sm:w-auto`} disabled={locked || !hasInput || (mode === 'table' && parsed.errors.length > 0)}>
                    {t(busy || submitting ? 'folderWorkbench.preparing' : 'folderWorkbench.composer.next')}
                    <ArrowRight className="ml-2 h-4 w-4 shrink-0" aria-hidden="true" />
                </Button>
            </div>
        </form>
    )
}
