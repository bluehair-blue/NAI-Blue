import { useShallow } from 'zustand/react/shallow'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Image as ImageIcon, Paintbrush, Minus, Plus, Edit3 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Label } from '@/components/ui/label'
import { useGenerationStore } from '@/stores/generation-store'
import { InpaintingDialog } from '@/components/tools/InpaintingDialog'
import { Tip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export function SourceImagePanel() {
    const { t } = useTranslation()
    const {
        sourceImage,
        mask,
        i2iMode,
        strength, setStrength,
        noise, setNoise,
        resetI2IParams
    } = useGenerationStore(useShallow(state => ({ sourceImage: state.sourceImage, mask: state.mask, i2iMode: state.i2iMode, strength: state.strength, setStrength: state.setStrength, noise: state.noise, setNoise: state.setNoise, resetI2IParams: state.resetI2IParams })))

    const [inpaintDialogOpen, setInpaintDialogOpen] = useState(false)
    const [isAnimating, setIsAnimating] = useState(false)

    // Don't show if no source image or no mode
    if (!sourceImage || !i2iMode) return null

    const isInpaint = i2iMode === 'inpaint'

    const handleCancel = () => {
        setIsAnimating(true)
        setTimeout(() => {
            resetI2IParams()
            setIsAnimating(false)
        }, 200)
    }

    return (
        <>
            <div
                className={cn(
                    "mb-4 bg-primary/10 rounded-panel border border-primary/20 overflow-hidden transition-all duration-300",
                    isAnimating && "opacity-0 scale-95 translate-x-[-20px]"
                )}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-3 py-2 bg-primary/5 border-b border-primary/10">
                    <div className="flex items-center gap-2 text-sm font-medium">
                        {isInpaint ? (
                            <>
                                <Paintbrush className="h-4 w-4 text-primary" />
                                <span>{t('sourcePanel.inpaintMode', '인페인팅 모드')}</span>
                            </>
                        ) : (
                            <>
                                <ImageIcon className="h-4 w-4 text-info" />
                                <span>{t('sourcePanel.i2iMode', 'I2I 모드')}</span>
                            </>
                        )}
                    </div>
                    <div className="flex items-center gap-1">
                        {/* Edit Mask Button (only for Inpaint) */}
                        {isInpaint && (
                            <Tip content={t('sourcePanel.editMask', '마스크 영역 편집')}>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 rounded-full hover:bg-accent hover:text-accent-foreground"
                                    onClick={() => setInpaintDialogOpen(true)}
                                    aria-label={t('sourcePanel.editMask', '마스크 영역 편집')}
                                >
                                    <Edit3 className="h-3.5 w-3.5" />
                                </Button>
                            </Tip>
                        )}
                        <Tip content={t('sourcePanel.cancel', '취소하고 T2I로 돌아가기')}>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 rounded-full hover:bg-destructive/20 hover:text-destructive"
                                onClick={handleCancel}
                                aria-label={t('sourcePanel.cancel', '취소하고 T2I로 돌아가기')}
                            >
                                <X className="h-3.5 w-3.5" />
                            </Button>
                        </Tip>
                    </div>
                </div>

                {/* Image Preview */}
                <div className="p-2">
                    <div className="bg-muted/30 rounded-lg overflow-hidden flex items-center justify-center" style={{ maxHeight: '300px' }}>
                        {/* Inner wrapper that sizes to source image */}
                        <div className="relative inline-block">
                            <img
                                src={sourceImage}
                                alt="Source"
                                className="max-w-full max-h-[300px] object-contain block"
                            />
                            {/* Mask overlay - now positioned relative to source image, not container */}
                            {isInpaint && mask && (
                                <>
                                    <img
                                        src={mask}
                                        alt="Mask"
                                        className="absolute inset-0 w-full h-full opacity-50 pointer-events-none"
                                    />
                                    <div className="absolute top-1 right-1 px-1.5 py-0.5 bg-primary/80 text-primary-foreground text-[10px] rounded-control">
                                        {t('sourcePanel.maskSet', '마스크 설정됨')}
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </div>

                {/* Controls */}
                <div className="px-3 pb-3 space-y-2">
                    {/* Strength Slider */}
                    <div className="flex items-center gap-2">
                        <Label className="text-xs text-muted-foreground w-14">{t('tools.i2i.strength', 'Strength')}</Label>
                        <div className="flex items-center gap-1.5 flex-1">
                            <Minus className="h-3 w-3 text-muted-foreground/50" />
                            <Slider
                                value={[strength]}
                                min={0.01}
                                max={0.99}
                                step={0.01}
                                onValueChange={([v]) => setStrength(v)}
                                aria-label={t('tools.i2i.strength', 'Strength')}
                                className="flex-1"
                            />
                            <Plus className="h-3 w-3 text-muted-foreground/50" />
                            <span className="text-xs text-muted-foreground w-8 text-right font-mono">{strength.toFixed(2)}</span>
                        </div>
                    </div>

                    {/* Noise Slider (only for I2I) */}
                    {!isInpaint && (
                        <div className="flex items-center gap-2">
                            <Label className="text-xs text-muted-foreground w-14">{t('tools.i2i.noise', 'Noise')}</Label>
                            <div className="flex items-center gap-1.5 flex-1">
                                <Minus className="h-3 w-3 text-muted-foreground/50" />
                                <Slider
                                    value={[noise]}
                                    min={0}
                                    max={0.99}
                                    step={0.01}
                                    onValueChange={([v]) => setNoise(v)}
                                    aria-label={t('tools.i2i.noise', 'Noise')}
                                    className="flex-1"
                                />
                                <Plus className="h-3 w-3 text-muted-foreground/50" />
                                <span className="text-xs text-muted-foreground w-8 text-right font-mono">{noise.toFixed(2)}</span>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Inpainting Dialog for mask editing */}
            <InpaintingDialog
                open={inpaintDialogOpen}
                onOpenChange={setInpaintDialogOpen}
                sourceImage={sourceImage}
            />
        </>
    )
}
