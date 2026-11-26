import { Copy, Save, Undo2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import { usePresetStore } from '@/stores/preset-store'

/**
 * The controls depend on preset-store's working-copy projection and sit beside
 * PresetDropdown. They make persistence explicit: Save commits, Undo restores
 * the saved snapshot, and Copy preserves the current experiment as a new preset.
 */
export function PresetDraftControls() {
    const { t } = useTranslation()
    const dirty = usePresetStore(state => state.dirty)
    const presets = usePresetStore(state => state.presets)
    const activePresetId = usePresetStore(state => state.activePresetId)
    const saveActivePreset = usePresetStore(state => state.saveActivePreset)
    const revertActivePreset = usePresetStore(state => state.revertActivePreset)
    const saveWorkingCopyAs = usePresetStore(state => state.saveWorkingCopyAs)
    const activePreset = presets.find(preset => preset.id === activePresetId)
    const saveLabel = t('preset.save', 'Save preset')
    const unsavedLabel = t('preset.unsaved', 'Unsaved')

    return (
        <div className="flex items-center gap-1" data-testid="preset-draft-controls">
            <Tip content={t('preset.revert', 'Revert unsaved changes')}>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11"
                    disabled={!dirty}
                    onClick={revertActivePreset}
                    aria-label={t('preset.revert', 'Revert unsaved changes')}
                >
                    <Undo2 className="h-4 w-4" />
                </Button>
            </Tip>
            <Tip content={dirty ? `${saveLabel} · ${unsavedLabel}` : saveLabel}>
                <Button
                    type="button"
                    variant={dirty ? 'default' : 'ghost'}
                    size="icon"
                    className="relative h-11 w-11"
                    disabled={!dirty}
                    onClick={saveActivePreset}
                    aria-label={dirty ? `${saveLabel} (${unsavedLabel})` : saveLabel}
                >
                    <Save className="h-4 w-4" />
                    {dirty && (
                        <>
                            <span
                                className="absolute right-2 top-2 h-2 w-2 rounded-full bg-warning"
                                aria-hidden="true"
                                data-testid="preset-unsaved-dot"
                            />
                            <span className="sr-only">{unsavedLabel}</span>
                        </>
                    )}
                </Button>
            </Tip>
            <Tip content={t('preset.saveCopy', 'Save as copy')}>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11"
                    onClick={() => saveWorkingCopyAs(t('preset.copyName', '{{name}} copy', {
                        name: activePreset?.isDefault
                            ? t('preset.default', 'Default')
                            : activePreset?.name ?? t('preset.default', 'Default'),
                    }))}
                    aria-label={t('preset.saveCopy', 'Save as copy')}
                >
                    <Copy className="h-4 w-4" />
                </Button>
            </Tip>
        </div>
    )
}
