import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/use-toast'
import { saveFolderAssetDetails } from '@/presentation/folders/save-folder-asset-details'

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
    const savingRef = useRef(false)
    const cancelledRef = useRef(false)
    const [value, setValue] = useState(initialDescription)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const dirty = value !== initialDescription

    useEffect(() => {
        const el = textareaRef.current
        if (!el) return
        el.focus()
        const end = el.value.length
        el.setSelectionRange(end, end)
    }, [])

    const commit = async () => {
        if (savingRef.current || cancelledRef.current) return
        if (!dirty) {
            onCancel()
            return
        }
        if (!ready) return
        if (!onAcquireLock()) return
        savingRef.current = true
        setSaving(true)
        setError(null)
        try {
            await saveFolderAssetDetails({
                presetId,
                sceneId,
                description: value,
                unconfirmedMessage: t('folderWorkbench.design.saveUnconfirmed', '저장을 확인하지 못했어요. 입력한 내용은 이 창에 남아 있어요.'),
            })
            toast({ title: t('folderWorkbench.design.descriptionSaved', '설명을 저장했어요.'), variant: 'success' })
            onSaved()
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : t('folderWorkbench.design.detailSaveFailed', '저장하지 못했어요. 입력한 내용을 확인하고 다시 시도해 주세요.'))
        } finally {
            savingRef.current = false
            setSaving(false)
            onReleaseLock()
        }
    }

    const cancel = () => {
        if (savingRef.current) return
        cancelledRef.current = true
        onCancel()
    }

    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            event.stopPropagation()
            void commit()
            return
        }
        if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            cancel()
        }
    }

    const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
        const next = event.relatedTarget as Node | null
        if (next && event.currentTarget.contains(next)) return
        if (cancelledRef.current || savingRef.current) return
        if (dirty) {
            void commit()
        } else {
            onCancel()
        }
    }

    return (
        <div className="fb-inline-editor" onBlur={handleBlur} aria-busy={saving}>
            <label htmlFor={fieldId} className="sr-only">
                {t('folderWorkbench.design.editDescriptionOf', '{{name}} 설명 편집', { name: assetName })}
            </label>
            <Textarea
                ref={textareaRef}
                id={fieldId}
                value={value}
                onChange={event => { setValue(event.target.value); setError(null) }}
                onKeyDown={handleKeyDown}
                maxLength={20_000}
                rows={4}
                disabled={saving || !ready}
                className="min-h-24 resize-y bg-canvas text-sm leading-relaxed"
                placeholder={t('folderWorkbench.design.addDescription', '그림 설명을 적어 주세요.')}
            />
            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
            <div className="fb-inline-editor-actions">
                <Button type="button" size="sm" className="min-h-11 px-3" disabled={saving || !ready} onClick={() => void commit()}>
                    {saving ? t('folderWorkbench.design.saving', '저장하고 있어요…') : t('folderWorkbench.design.saveDescription', '저장')}
                </Button>
                <Button type="button" variant="ghost" size="sm" className="min-h-11 px-3" disabled={saving} onClick={cancel}>
                    {t('folderWorkbench.design.cancelEdit', '취소')}
                </Button>
            </div>
        </div>
    )
}
