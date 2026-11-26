import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Image as ImageIcon, SlidersHorizontal } from 'lucide-react'

import { CharacterSettingsDialog } from '@/components/character/CharacterSettingsDialog'
import { SourceImagePanel } from '@/components/layout/SourceImagePanel'
import { Button } from '@/components/ui/button'
import { useCharacterStore } from '@/stores/character-store'
import { useGenerationStore } from '@/stores/generation-store'

interface SceneInheritedSettingsProps {
    disabled?: boolean
}

/**
 * Exposes the Main reference/source-image settings that Scene generation
 * inherits (`build-scene-params.ts`) directly inside Scene surfaces so
 * detaching PromptPanel from `/scenes*` never strands reference or I2I controls.
 */
export function SceneInheritedSettings({ disabled = false }: SceneInheritedSettingsProps) {
    const { t } = useTranslation()
    const [referenceDialogOpen, setReferenceDialogOpen] = useState(false)
    const characterCount = useCharacterStore(state => (
        state.characterImages.filter(image => image.enabled !== false).length
    ))
    const vibeCount = useCharacterStore(state => (
        state.vibeImages.filter(image => image.enabled !== false).length
    ))
    const sourceImage = useGenerationStore(state => state.sourceImage)
    const i2iMode = useGenerationStore(state => state.i2iMode)

    const totalReferences = characterCount + vibeCount
    const hasSourceImage = Boolean(sourceImage && i2iMode)
    const sourceLabel = hasSourceImage
        ? i2iMode === 'inpaint'
            ? t('scene.inherited.inpaintActive', '인페인팅 원본 사용 중')
            : t('scene.inherited.i2iActive', '원본 이미지(I2I) 사용 중')
        : t('scene.inherited.sourceNone', '원본 이미지 없음')

    return (
        <section
            className="space-y-3 rounded-panel bg-card px-4 py-3"
            aria-label={t('scene.inherited.title', '공통 참조 · 원본 이미지')}
            data-testid="scene-inherited-settings"
        >
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                        <ImageIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        {t('scene.inherited.title', '공통 참조 · 원본 이미지')}
                    </span>
                    <span className="text-muted-foreground">
                        {t('scene.inherited.summary', '참조 {{count}}개 · {{source}}', {
                            count: totalReferences,
                            source: sourceLabel,
                        })}
                    </span>
                </div>
                <Button
                    type="button"
                    variant="secondary"
                    className="h-11 shrink-0 px-3"
                    disabled={disabled}
                    onClick={() => setReferenceDialogOpen(true)}
                    data-testid="scene-inherited-reference-button"
                >
                    <SlidersHorizontal className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" />
                    {t('scene.inherited.openReferences', '참조 설정')}
                </Button>
            </div>
            {hasSourceImage && (
                <div className="[&>div]:mb-0">
                    <SourceImagePanel />
                </div>
            )}
            <CharacterSettingsDialog
                open={referenceDialogOpen}
                onOpenChange={setReferenceDialogOpen}
                hideTrigger
            />
        </section>
    )
}
