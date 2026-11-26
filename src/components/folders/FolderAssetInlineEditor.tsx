import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/use-toast'
import {
    inlineEditBlurIntent,
    inlineEditKeyIntent,
    inlineEditNeedsSave,
    nextInlineEditPendingSave,
    type InlineEditPendingSaveEvent,
} from '@/presentation/folders/folder-inline-edit'
import { FolderAssetSaveUnconfirmedError, saveFolderAssetDetails } from '@/presentation/folders/save-folder-asset-details'

interface FolderAssetInlineEditorProps {
    presetId: string
    sceneId: string
    assetName: string
    initialDescription: string
    ready: boolean
    onAcquireLock: () => boolean
    onReleaseLock: () => void
    onSaved: () => void
    onCancel: () => void
}

/** Edits a single card's additional description in place while sharing the workbench execution lock. */
export function FolderAssetInlineEditor({
    presetId,
    sceneId,
    assetName,
    initialDescription,
    ready,
    onAcquireLock,
    onReleaseLock,
    onSaved,
    onCancel,
}: FolderAssetInlineEditorProps) {
    const { t } = useTranslation()
    const fieldId = useId()
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    // The prop follows the optimistic store, so dirtiness is measured against the text seen when editing began.
    const [baseline] = useState(initialDescription)
    const savingRef = useRef(false)
    const cancelledRef = useRef(false)
    const failedRef = useRef(false)
    const pendingSaveRef = useRef(false)
    // Text left in the store by a save whose readback failed; until a save confirms, the editor is not clean.
    const unconfirmedRef = useRef<string | null>(null)
    const [value, setValue] = useState(initialDescription)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [blocked, setBlocked] = useState(false)

    useEffect(() => {
        const el = textareaRef.current
        if (!el) return
        el.focus()
        const end = el.value.length
        el.setSelectionRange(end, end)
    }, [])

    // A disabled textarea drops focus while saving; return it so Ctrl/Cmd+Enter can retry at once.
    useEffect(() => {
        if (!saving && error !== null) textareaRef.current?.focus()
    }, [saving, error])

    const readDraft = () => textareaRef.current?.value ?? value
    const needsSave = (draft: string) => inlineEditNeedsSave({ draft, baseline, unconfirmed: unconfirmedRef.current })

    const stepPendingSave = (event: InlineEditPendingSaveEvent): boolean => {
        const step = nextInlineEditPendingSave(pendingSaveRef.current, event)
        pendingSaveRef.current = step.pending
        return step.commit
    }

    const commit = async () => {
        if (savingRef.current || cancelledRef.current) return
        const draft = readDraft()
        if (!needsSave(draft)) {
            onCancel()
            return
        }
        if (!ready || !onAcquireLock()) {
            setBlocked(true)
            return
        }
        savingRef.current = true
        setSaving(true)
        setBlocked(false)
        setError(null)
        try {
            await saveFolderAssetDetails({
                presetId,
                sceneId,
                description: draft,
                restoreOnFlushFailure: true,
                unconfirmedMessage: t('folderWorkbench.design.saveUnconfirmed', '저장을 확인하지 못했어요. 입력한 내용은 이 창에 남아 있어요.'),
            })
            failedRef.current = false
            unconfirmedRef.current = null
            toast({ title: t('folderWorkbench.design.descriptionSaved', '설명을 저장했어요.'), variant: 'success' })
            onSaved()
        } catch (cause) {
            failedRef.current = true
            // A failed flush put the previous text back, so only a failed readback leaves this draft in the store.
            if (cause instanceof FolderAssetSaveUnconfirmedError) unconfirmedRef.current = draft
            setError(cause instanceof Error ? cause.message : t('folderWorkbench.design.detailSaveFailed', '저장하지 못했어요. 입력한 내용을 확인하고 다시 시도해 주세요.'))
        } finally {
            savingRef.current = false
            setSaving(false)
            onReleaseLock()
        }
    }

    const cancel = () => {
        if (savingRef.current) return
        stepPendingSave({ type: 'cancel' })
        cancelledRef.current = true
        onCancel()
    }

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const intent = inlineEditKeyIntent({
            key: event.key,
            code: event.code,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            isComposing: event.nativeEvent.isComposing,
            keyCode: event.keyCode,
        })
        stepPendingSave({ type: 'keydown', intent, key: event.key })
        if (intent === null) return
        event.stopPropagation()
        if (intent === 'defer-save') return
        if (intent === 'swallow') return
        event.preventDefault()
        if (intent === 'save') void commit()
        else cancel()
    }

    const handleCompositionEnd = () => {
        if (stepPendingSave({ type: 'composition-end' })) void commit()
    }

    const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
        const next = event.relatedTarget as Node | null
        if (next && event.currentTarget.contains(next)) return
        const intent = inlineEditBlurIntent({
            dirty: needsSave(readDraft()),
            saving: savingRef.current,
            cancelled: cancelledRef.current,
            failed: failedRef.current,
        })
        if (intent === 'commit') void commit()
        else if (intent === 'close') onCancel()
    }

    return (
        <div className="fb-inline-editor" onBlur={handleBlur} onKeyDown={handleKeyDown} onCompositionEnd={handleCompositionEnd} aria-busy={saving}>
            <label htmlFor={fieldId} className="sr-only">
                {t('folderWorkbench.design.editDescriptionOf', '{{name}} 설명 편집', { name: assetName })}
            </label>
            <Textarea
                ref={textareaRef}
                id={fieldId}
                value={value}
                onChange={event => {
                    stepPendingSave({ type: 'input', composing: (event.nativeEvent as InputEvent).isComposing === true })
                    setValue(event.target.value)
                    setError(null)
                    setBlocked(false)
                }}
                maxLength={20_000}
                rows={4}
                disabled={saving || !ready}
                className="min-h-24 resize-y bg-canvas text-sm leading-relaxed"
                placeholder={t('folderWorkbench.design.addDescription', '그림 설명을 적어 주세요.')}
            />
            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
            {blocked && !error && <p role="status" className="text-xs text-muted-foreground">{t('folderWorkbench.design.editBlocked', '다른 저장이 끝난 뒤 다시 시도해 주세요.')}</p>}
            <div className="fb-inline-editor-actions">
                <Button type="button" size="sm" className="min-h-11 px-3" disabled={saving || !ready} onClick={() => void commit()}>
                    {saving ? t('folderWorkbench.design.saving', '저장하고 있어요…') : t('folderWorkbench.design.saveDescription', '저장')}
                </Button>
                <Button type="button" variant="ghost" size="sm" className="min-h-11 px-3" disabled={saving} onMouseDown={event => event.preventDefault()} onClick={cancel}>
                    {t('folderWorkbench.design.cancelEdit', '취소')}
                </Button>
            </div>
        </div>
    )
}
