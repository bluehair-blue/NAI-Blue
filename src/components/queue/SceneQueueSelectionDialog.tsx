import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { SceneQueueReviewDialog } from '@/components/queue/SceneQueueReviewDialog'
import type { ScenePreset } from '@/stores/scene-store'
import type {
    PreparedSceneQueueReview,
    SceneQueueSubmission,
    SceneQueueTarget,
} from '@/services/queue/scene-queue-adapter'

interface SceneQueueSelectionDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    presets: readonly ScenePreset[]
    busy?: boolean
    onPrepare: (targets: readonly SceneQueueTarget[]) => Promise<PreparedSceneQueueReview | null>
    onApprove: (submission: SceneQueueSubmission) => Promise<boolean>
}

interface SelectedScene extends SceneQueueTarget {
    key: string
}

function selectionKey(presetId: string, sceneId: string): string {
    return `${presetId}::${sceneId}`
}

// Selection stays local until review; approval is the only path that may commit Queue state.
export function SceneQueueSelectionDialog({
    open,
    onOpenChange,
    presets,
    busy = false,
    onPrepare,
    onApprove,
}: SceneQueueSelectionDialogProps) {
    const { t } = useTranslation()
    const [selected, setSelected] = useState<Record<string, SelectedScene>>({})
    const [submitting, setSubmitting] = useState(false)
    const [prepared, setPrepared] = useState<PreparedSceneQueueReview | null>(null)

    useEffect(() => {
        if (open) {
            setSelected({})
            setPrepared(null)
        }
    }, [open])

    const selectedTargets = useMemo(
        () => Object.values(selected).map(({ key: _key, ...target }) => target),
        [selected],
    )
    const totalImages = useMemo(
        () => selectedTargets.reduce((total, target) => total + target.count, 0),
        [selectedTargets],
    )

    const toggleScene = (presetId: string, sceneId: string, checked: boolean) => {
        setPrepared(null)
        const key = selectionKey(presetId, sceneId)
        setSelected(current => {
            if (!checked) {
                const next = { ...current }
                delete next[key]
                return next
            }
            return {
                ...current,
                [key]: { key, presetId, sceneId, count: 1 },
            }
        })
    }

    const setPresetSelection = (preset: ScenePreset, checked: boolean) => {
        setPrepared(null)
        setSelected(current => {
            const next = { ...current }
            for (const scene of preset.scenes) {
                const key = selectionKey(preset.id, scene.id)
                if (checked) next[key] = current[key] ?? { key, presetId: preset.id, sceneId: scene.id, count: 1 }
                else delete next[key]
            }
            return next
        })
    }

    const setSceneCount = (key: string, value: string) => {
        setPrepared(null)
        const count = Math.max(1, Math.min(999, Math.floor(Number(value) || 1)))
        setSelected(current => {
            const target = current[key]
            return target === undefined ? current : { ...current, [key]: { ...target, count } }
        })
    }

    const prepare = async () => {
        if (selectedTargets.length === 0 || submitting || busy) return false
        setSubmitting(true)
        try {
            const next = await onPrepare(selectedTargets)
            setPrepared(next)
            return next !== null
        } finally {
            setSubmitting(false)
        }
    }

    if (prepared !== null) return (
        <SceneQueueReviewDialog
            open={open}
            onOpenChange={onOpenChange}
            prepared={prepared}
            busy={busy}
            onApprove={onApprove}
            onReplan={prepare}
            onBack={() => setPrepared(null)}
        />
    )

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex max-h-[85dvh] max-w-2xl flex-col overflow-hidden">
                <DialogHeader>
                    <DialogTitle>{t('queue.selectScenesTitle', 'Select scenes for the queue')}</DialogTitle>
                    <DialogDescription>
                        {t('queue.selectScenesDescription', 'Choose scenes from any folder. Each selected scene becomes one or more durable jobs.')}
                    </DialogDescription>
                </DialogHeader>

                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
                    {presets.length === 0 ? (
                        <p className="py-8 text-center text-sm text-muted-foreground">
                            {t('queue.noSceneFolders', 'No scene folders are available.')}
                        </p>
                    ) : presets.map(preset => {
                        const selectedInPreset = preset.scenes.filter(scene => selected[selectionKey(preset.id, scene.id)] !== undefined).length
                        const allSelected = preset.scenes.length > 0 && selectedInPreset === preset.scenes.length
                        return (
                            <section key={preset.id} className="rounded-panel border border-border p-3">
                                <div className="flex items-center justify-between gap-3">
                                    <div className="min-w-0">
                                        <h3 className="truncate text-sm font-semibold">{preset.name}</h3>
                                        <p className="text-xs text-muted-foreground">
                                            {t('queue.folderSceneCount', '{{selected}}/{{total}} scenes selected', {
                                                selected: selectedInPreset,
                                                total: preset.scenes.length,
                                            })}
                                        </p>
                                    </div>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        disabled={preset.scenes.length === 0 || busy || submitting}
                                        onClick={() => setPresetSelection(preset, !allSelected)}
                                    >
                                        {allSelected
                                            ? t('queue.clearFolderSelection', 'Clear folder')
                                            : t('queue.selectFolderScenes', 'Select folder')}
                                    </Button>
                                </div>

                                {preset.scenes.length === 0 ? (
                                    <p className="mt-3 text-xs text-muted-foreground">
                                        {t('queue.emptySceneFolder', 'This folder has no scenes.')}
                                    </p>
                                ) : (
                                    <div className="mt-3 space-y-2">
                                        {preset.scenes.map(scene => {
                                            const key = selectionKey(preset.id, scene.id)
                                            const target = selected[key]
                                            return (
                                                <div key={key} className="flex items-center gap-3 rounded-control bg-muted/30 px-2 py-2">
                                                    <Checkbox
                                                        id={`queue-scene-${key}`}
                                                        checked={target !== undefined}
                                                        disabled={busy || submitting}
                                                        onCheckedChange={value => toggleScene(preset.id, scene.id, value === true)}
                                                        aria-label={scene.name}
                                                    />
                                                    <label htmlFor={`queue-scene-${key}`} className="min-w-0 flex-1 cursor-pointer truncate text-sm">
                                                        {scene.name}
                                                    </label>
                                                    {target !== undefined && (
                                                        <Input
                                                            className="h-9 w-20"
                                                            type="number"
                                                            min={1}
                                                            max={999}
                                                            step={1}
                                                            value={target.count}
                                                            disabled={busy || submitting}
                                                            onChange={event => setSceneCount(key, event.target.value)}
                                                            aria-label={t('queue.sceneJobCount', '{{scene}} job count', { scene: scene.name })}
                                                        />
                                                    )}
                                                </div>
                                            )
                                        })}
                                    </div>
                                )}
                            </section>
                        )
                    })}
                </div>

                {selectedTargets.length > 0 && (
                    <div className="space-y-1 rounded-panel border border-border bg-muted/30 px-3 py-2 text-sm" aria-live="polite">
                        <p className="font-medium">
                            {t('queue.selectionSummary', '{{scenes}} scenes · {{images}} images', {
                                scenes: selectedTargets.length,
                                images: totalImages,
                            })}
                        </p>
                        <p className="text-xs text-muted-foreground">
                            {t(
                                'queue.reservationSummary',
                                'The complete output file set is reserved before work starts. Existing files are never overwritten.',
                            )}
                        </p>
                        <p className="text-xs text-muted-foreground">
                            {t(
                                'queue.appOpenProcessing',
                                'Jobs run while NAI Blue is open. Interrupted work resumes after the app reopens.',
                            )}
                        </p>
                    </div>
                )}

                <DialogFooter>
                    <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
                        {t('common.cancel', 'Cancel')}
                    </Button>
                    <Button type="button" disabled={selectedTargets.length === 0 || busy || submitting} onClick={() => void prepare()}>
                        {t('queue.reviewSelectedImages', 'Review {{count}} images', { count: totalImages })}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
