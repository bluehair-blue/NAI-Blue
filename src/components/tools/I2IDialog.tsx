import { useShallow } from 'zustand/react/shallow'

import { useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Label } from "@/components/ui/label"
import { useGenerationStore } from '@/stores/generation-store'
import { useTranslation } from 'react-i18next'
import { Image as ImageIcon, Wand2, Minus, Plus, Loader2 } from 'lucide-react'
import { useNavigate } from 'react-router'

interface I2IDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    sourceImage: string | null
    navigateOnComplete?: boolean
    onGenerated?: (image: string | null) => void
}

export function I2IDialog({
    open,
    onOpenChange,
    sourceImage: propSourceImage,
    navigateOnComplete = true,
    onGenerated,
}: I2IDialogProps) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const {
        setSourceImage,
        strength, setStrength,
        noise, setNoise,
        resetI2IParams,
        generate,
        isGenerating
    } = useGenerationStore(useShallow(state => ({ setSourceImage: state.setSourceImage, strength: state.strength, setStrength: state.setStrength, noise: state.noise, setNoise: state.setNoise, resetI2IParams: state.resetI2IParams, generate: state.generate, isGenerating: state.isGenerating })))

    // Reset params and set source image when dialog opens
    useEffect(() => {
        if (open) {
            if (propSourceImage) {
                setSourceImage(propSourceImage)
            }
        } else {
            resetI2IParams()
        }
    }, [open, propSourceImage, setSourceImage, resetI2IParams])

    const handleGenerate = async () => {
        if (!propSourceImage) return
        await generate()
        onGenerated?.(useGenerationStore.getState().previewImage)
        onOpenChange(false)
        if (navigateOnComplete) navigate('/advanced')
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex h-[85dvh] max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-4xl flex-col gap-3 overflow-hidden p-3 sm:w-[calc(100vw-2rem)] sm:p-6">
                <DialogHeader className="shrink-0 pr-10">
                    <DialogTitle className="flex min-w-0 items-center gap-2 text-lg sm:text-xl">
                        <ImageIcon className="w-5 h-5" />
                        <span className="min-w-0 truncate">{t('tools.i2i.title', 'Image to Image')}</span>
                    </DialogTitle>
                    <DialogDescription>
                        {t('tools.i2i.description', 'Generate a new image based on an existing image.')}
                    </DialogDescription>
                </DialogHeader>

                {/* Controls */}
                <div className="grid shrink-0 gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-2">
                    <div className="min-w-0 space-y-1">
                        <Label className="text-sm">{t('tools.i2i.strength', 'Strength')}</Label>
                        <div className="flex min-w-0 items-center gap-2">
                            <Minus className="h-3 w-3 text-muted-foreground" />
                            <Slider
                                value={[strength]}
                                min={0.01}
                                max={0.99}
                                step={0.01}
                                onValueChange={([v]) => setStrength(v)}
                                aria-label={t('tools.i2i.strength', 'Strength')}
                                className="min-w-0 flex-1"
                            />
                            <Plus className="h-3 w-3 text-muted-foreground" />
                            <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{strength.toFixed(2)}</span>
                        </div>
                    </div>

                    <div className="min-w-0 space-y-1">
                        <Label className="text-sm">{t('tools.i2i.noise', 'Noise')}</Label>
                        <div className="flex min-w-0 items-center gap-2">
                            <Minus className="h-3 w-3 text-muted-foreground" />
                            <Slider
                                value={[noise]}
                                min={0}
                                max={0.99}
                                step={0.01}
                                onValueChange={([v]) => setNoise(v)}
                                aria-label={t('tools.i2i.noise', 'Noise')}
                                className="min-w-0 flex-1"
                            />
                            <Plus className="h-3 w-3 text-muted-foreground" />
                            <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{noise.toFixed(2)}</span>
                        </div>
                    </div>
                </div>

                {/* Image Preview Container */}
                <div
                    className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-muted/50 p-2 sm:p-4"
                >
                    {propSourceImage ? (
                        <img
                            src={propSourceImage}
                            alt="Source"
                            className="max-w-full max-h-full w-auto h-auto object-contain"
                        />
                    ) : (
                        <div className="text-muted-foreground">
                            No image loaded
                        </div>
                    )}
                </div>

                <DialogFooter className="shrink-0 gap-2 [&>button]:w-full sm:justify-end sm:[&>button]:w-auto">
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        {t('common.cancel', 'Cancel')}
                    </Button>
                    <Button
                        onClick={handleGenerate}
                        disabled={!propSourceImage || isGenerating}
                        className="bg-primary text-primary-foreground hover:bg-primary/90"
                    >
                        {isGenerating ? (
                            <>
                                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                {t('common.generating', 'Generating...')}
                            </>
                        ) : (
                            <>
                                <Wand2 className="w-4 h-4 mr-2" />
                                {t('common.generate', 'Generate')}
                            </>
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
