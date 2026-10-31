import { useShallow } from 'zustand/react/shallow'

import { useState, useRef, useEffect, PointerEvent } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Label } from "@/components/ui/label"
import { useGenerationStore } from '@/stores/generation-store'
import { useToolsStore } from '@/stores/tools-store'
import { useTranslation } from 'react-i18next'
import { Paintbrush, Eraser, Undo, Trash2, Save, Loader2 } from 'lucide-react'

interface InpaintingDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    sourceImage: string | null
    generateOnSave?: boolean
    onGenerated?: (image: string | null) => void
}

export function InpaintingDialog({
    open,
    onOpenChange,
    sourceImage: propSourceImage,
    generateOnSave = false,
    onGenerated,
}: InpaintingDialogProps) {
    const { t } = useTranslation()
    const {
        setSourceImage,
        setMask,
        setI2IMode,
        resetI2IParams,
        mask: existingMask,
        generate,
        isGenerating,
    } = useGenerationStore(useShallow(state => ({ setSourceImage: state.setSourceImage, setMask: state.setMask, setI2IMode: state.setI2IMode, resetI2IParams: state.resetI2IParams, mask: state.mask, generate: state.generate, isGenerating: state.isGenerating })))

    const {
        inpaintingBrushSize,
        setInpaintingBrushSize
    } = useToolsStore()

    // Derived state for slider (it expects array)
    const brushSize = [inpaintingBrushSize]
    const setBrushSize = (val: number[]) => setInpaintingBrushSize(val[0])
    const [isErasing, setIsErasing] = useState(false)

    // Canvas & State
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)
    const activePointerIdRef = useRef<number | null>(null)
    const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null)


    // History
    const [history, setHistory] = useState<ImageData[]>([])
    const [historyStep, setHistoryStep] = useState(-1)

    // Reset when dialog closes - but only if we're NOT in the new sidebar workflow
    // (i.e., only reset if i2iMode is null, meaning dialog was opened for standalone generation)
    useEffect(() => {
        if (!open) {
            activePointerIdRef.current = null
            lastGridPosRef.current = null
            // Check if we're in sidebar workflow mode - if so, don't reset
            const currentI2IMode = useGenerationStore.getState().i2iMode
            if (!currentI2IMode) {
                resetI2IParams()
            }
            setHistory([])
            setHistoryStep(-1)
            setImageSize(null)
        }
    }, [open, propSourceImage, resetI2IParams, setSourceImage])

    // Initial Canvas Setup - Now also restores existing mask
    useEffect(() => {
        if (!open || !propSourceImage) return

        const timer = setTimeout(() => {
            const canvas = canvasRef.current
            if (!canvas) return
            const ctx = canvas.getContext('2d')
            if (!ctx) return

            const img = new Image()
            img.crossOrigin = 'anonymous'
            img.onload = () => {
                canvas.width = img.width
                canvas.height = img.height

                // Restore existing mask if present
                if (existingMask) {
                    const maskImg = new Image()
                    maskImg.crossOrigin = 'anonymous'
                    maskImg.onload = () => {
                        ctx.drawImage(maskImg, 0, 0, canvas.width, canvas.height)
                    }
                    maskImg.src = existingMask
                }
            }
            img.src = propSourceImage
        }, 100)
        return () => clearTimeout(timer)
    }, [open, propSourceImage, existingMask])

    // Grid cell size (NovelAI uses 8x8 pixel blocks)
    const GRID_SIZE = 8

    // Track which grid cells are painted (for display overlay)
    const gridDataRef = useRef<Set<string>>(new Set())

    // Last grid position for continuous drawing
    const lastGridPosRef = useRef<{ gx: number; gy: number } | null>(null)

    // Convert pixel coordinates to grid coordinates
    const pixelToGrid = (pixelX: number, pixelY: number, canvasWidth: number, canvasHeight: number) => {
        const gx = Math.floor(pixelX / GRID_SIZE)
        const gy = Math.floor(pixelY / GRID_SIZE)
        // Clamp to grid boundaries
        const maxGx = Math.floor(canvasWidth / GRID_SIZE) - 1
        const maxGy = Math.floor(canvasHeight / GRID_SIZE) - 1
        return {
            gx: Math.max(0, Math.min(gx, maxGx)),
            gy: Math.max(0, Math.min(gy, maxGy))
        }
    }

    // Fill a single grid cell (8x8 block)
    const fillGridCell = (ctx: CanvasRenderingContext2D, gx: number, gy: number, erase: boolean) => {
        const cellKey = `${gx},${gy}`

        if (erase) {
            // Erase: clear the cell
            ctx.clearRect(gx * GRID_SIZE, gy * GRID_SIZE, GRID_SIZE, GRID_SIZE)
            gridDataRef.current.delete(cellKey)
        } else {
            // Paint: fill with semi-transparent sky blue for visibility
            // Skip if already painted
            if (gridDataRef.current.has(cellKey)) return

            ctx.fillStyle = 'rgba(99, 102, 241, 0.7)'  // Vibrant indigo (better visibility)
            ctx.fillRect(gx * GRID_SIZE, gy * GRID_SIZE, GRID_SIZE, GRID_SIZE)
            gridDataRef.current.add(cellKey)
        }
    }

    // Fill brush area (multiple grid cells based on brush size)
    const fillBrushArea = (ctx: CanvasRenderingContext2D, gx: number, gy: number, erase: boolean) => {
        const brushGridSize = Math.max(1, Math.floor(brushSize[0] / GRID_SIZE))
        const halfBrush = Math.floor(brushGridSize / 2)

        for (let offsetY = -halfBrush; offsetY <= halfBrush; offsetY++) {
            for (let offsetX = -halfBrush; offsetX <= halfBrush; offsetX++) {
                const targetGx = gx + offsetX
                const targetGy = gy + offsetY

                // Check bounds
                if (targetGx >= 0 && targetGy >= 0) {
                    fillGridCell(ctx, targetGx, targetGy, erase)
                }
            }
        }
    }

    // Draw line between two grid positions (Bresenham's algorithm)
    const drawGridLine = (ctx: CanvasRenderingContext2D, startGx: number, startGy: number, endGx: number, endGy: number, erase: boolean) => {
        const dx = Math.abs(endGx - startGx)
        const dy = Math.abs(endGy - startGy)
        const sx = startGx < endGx ? 1 : -1
        const sy = startGy < endGy ? 1 : -1
        let err = dx - dy

        let gx = startGx
        let gy = startGy

        while (true) {
            fillBrushArea(ctx, gx, gy, erase)

            if (gx === endGx && gy === endGy) break

            const e2 = 2 * err
            if (e2 > -dy) {
                err -= dy
                gx += sx
            }
            if (e2 < dx) {
                err += dx
                gy += sy
            }
        }
    }

    const startDrawing = (e: PointerEvent<HTMLCanvasElement>) => {
        if (activePointerIdRef.current !== null || (e.pointerType === 'mouse' && e.button !== 0)) return

        const canvas = canvasRef.current
        const ctx = canvas?.getContext('2d')
        if (!canvas || !ctx) return

        e.preventDefault()
        activePointerIdRef.current = e.pointerId
        e.currentTarget.setPointerCapture(e.pointerId)

        const rect = canvas.getBoundingClientRect()
        const scaleX = canvas.width / rect.width
        const scaleY = canvas.height / rect.height
        const x = (e.clientX - rect.left) * scaleX
        const y = (e.clientY - rect.top) * scaleY

        const { gx, gy } = pixelToGrid(x, y, canvas.width, canvas.height)
        lastGridPosRef.current = { gx, gy }
        fillBrushArea(ctx, gx, gy, isErasing)
    }

    const stopDrawing = (e: PointerEvent<HTMLCanvasElement>) => {
        if (activePointerIdRef.current !== e.pointerId) return

        activePointerIdRef.current = null
        lastGridPosRef.current = null
        saveHistory()
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId)
        }
    }

    const draw = (e: PointerEvent<HTMLCanvasElement>) => {
        if (activePointerIdRef.current !== e.pointerId || !lastGridPosRef.current) return

        const canvas = canvasRef.current
        const ctx = canvas?.getContext('2d')
        if (!canvas || !ctx) return

        e.preventDefault()
        const rect = canvas.getBoundingClientRect()
        const scaleX = canvas.width / rect.width
        const scaleY = canvas.height / rect.height

        const x = (e.clientX - rect.left) * scaleX
        const y = (e.clientY - rect.top) * scaleY

        const { gx, gy } = pixelToGrid(x, y, canvas.width, canvas.height)

        // Only draw if moved to a different grid cell
        if (gx !== lastGridPosRef.current.gx || gy !== lastGridPosRef.current.gy) {
            drawGridLine(ctx, lastGridPosRef.current.gx, lastGridPosRef.current.gy, gx, gy, isErasing)
            lastGridPosRef.current = { gx, gy }
        }
    }

    // Save current canvas state to history
    const saveHistory = () => {
        const canvas = canvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const newHistory = history.slice(0, historyStep + 1)
        setHistory([...newHistory, imageData])
        setHistoryStep(newHistory.length)
    }

    // Undo last action
    const undo = () => {
        if (historyStep > 0) {
            const canvas = canvasRef.current
            if (!canvas) return
            const ctx = canvas.getContext('2d')
            if (!ctx) return

            const prevImageData = history[historyStep - 1]
            ctx.putImageData(prevImageData, 0, 0)
            setHistoryStep(historyStep - 1)
        }
    }

    // Clear canvas
    const clearCanvas = () => {
        const canvas = canvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return

        ctx.clearRect(0, 0, canvas.width, canvas.height)
        gridDataRef.current.clear()  // Clear grid data tracking
        saveHistory() // Save empty canvas to history
    }

    // Handle save mask button click - saves mask and sets up inpaint mode
    const handleSaveMask = async () => {
        const canvas = canvasRef.current
        if (!canvas || !propSourceImage) return

        // Get mask data and save to store
        const maskDataUrl = canvas.toDataURL('image/png')
        
        // Set source image, mask, and mode together (triggers sidebar display)
        setSourceImage(propSourceImage)
        setMask(maskDataUrl)
        setI2IMode('inpaint')

        if (generateOnSave) {
            // A missing token or failed request returns without a new preview.
            // Clearing first prevents an older result from being reported as this run.
            useGenerationStore.getState().setPreviewImage(null)
            await generate()
            const image = useGenerationStore.getState().previewImage
            if (!image) return
            onGenerated?.(image)
            resetI2IParams()
        }

        onOpenChange(false)
    }

    return (
        <Dialog open={open} onOpenChange={(open) => !open && onOpenChange(false)}>
            <DialogContent className="flex h-[85dvh] max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-5xl flex-col gap-3 overflow-hidden p-3 sm:w-[calc(100vw-2rem)] sm:p-6">
                <DialogHeader className="shrink-0 pr-10">
                    <DialogTitle className="flex min-w-0 items-center gap-2 text-lg sm:text-xl">
                        <Paintbrush className="w-5 h-5" />
                        <span className="min-w-0 truncate">{t('tools.inpainting.title', 'Inpainting')}</span>
                    </DialogTitle>
                    <DialogDescription>
                        {t('tools.inpainting.description', 'Mask areas to regenerate.')}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex min-h-0 flex-1 overflow-hidden">
                    {/* Canvas Area - now takes full width */}
                    <div className="flex-1 flex flex-col gap-2 min-w-0">
                        {/* Toolbar */}
                        <div className="grid shrink-0 gap-3 rounded-lg border bg-muted/20 p-2 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
                            <div className="grid grid-cols-2 gap-2">
                                <Button
                                    variant={!isErasing ? "secondary" : "ghost"}
                                    size="sm"
                                    onClick={() => setIsErasing(false)}
                                    className={!isErasing ? "w-full bg-primary text-primary-foreground hover:bg-primary/90" : "w-full"}
                                >
                                    <Paintbrush className="w-4 h-4 mr-2" />
                                    {t('common.brush', 'Brush')}
                                </Button>
                                <Button
                                    variant={isErasing ? "secondary" : "ghost"}
                                    size="sm"
                                    onClick={() => setIsErasing(true)}
                                    className={isErasing ? "w-full bg-destructive text-destructive-foreground hover:bg-destructive/90" : "w-full"}
                                >
                                    <Eraser className="w-4 h-4 mr-2" />
                                    {t('common.eraser', 'Eraser')}
                                </Button>
                            </div>

                            <div className="min-w-0 space-y-1 sm:px-2">
                                <Label className="text-sm">{t('common.size', 'Size')}</Label>
                                <div className="flex min-w-0 items-center gap-2">
                                    <Slider
                                        value={brushSize}
                                        min={5}
                                        max={100}
                                        step={5}
                                        onValueChange={setBrushSize}
                                        aria-label={t('common.size', 'Size')}
                                        className="min-w-0 flex-1"
                                    />
                                    <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">{brushSize[0]}</span>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-2">
                                <Button variant="ghost" size="icon" className="w-full sm:w-11" onClick={undo} disabled={historyStep < 0} aria-label={t('common.undo', '실행 취소')}>
                                    <Undo className="w-4 h-4" />
                                </Button>
                                <Button variant="ghost" size="icon" className="w-full sm:w-11" onClick={clearCanvas} aria-label={t('actions.clear', '초기화')}>
                                    <Trash2 className="w-4 h-4" />
                                </Button>
                            </div>
                        </div>

                        {/* Canvas Container */}
                        <div
                            ref={containerRef}
                            className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-muted/50 p-2 sm:p-4"
                        >
                            {propSourceImage && (
                                <div
                                    className="relative flex justify-center items-center"
                                    style={{
                                        maxWidth: '100%',
                                        maxHeight: '100%',
                                        aspectRatio: imageSize ? `${imageSize.width} / ${imageSize.height}` : 'auto'
                                    }}
                                >
                                    <img
                                        src={propSourceImage}
                                        alt="Source"
                                        className="block w-full h-full object-contain"
                                        onLoad={(e) => {
                                            const img = e.currentTarget
                                            setImageSize({ width: img.naturalWidth, height: img.naturalHeight })

                                            if (canvasRef.current) {
                                                // Set canvas internal resolution to image natural size
                                                canvasRef.current.width = img.naturalWidth
                                                canvasRef.current.height = img.naturalHeight

                                                // Restore existing mask
                                                if (existingMask) {
                                                    const ctx = canvasRef.current.getContext('2d')
                                                    if (ctx) {
                                                        const maskImg = new Image()
                                                        maskImg.crossOrigin = 'anonymous'
                                                        maskImg.onload = () => {
                                                            ctx.drawImage(maskImg, 0, 0, canvasRef.current!.width, canvasRef.current!.height)
                                                        }
                                                        maskImg.src = existingMask
                                                    }
                                                }
                                            }
                                        }}
                                    />
                                    <canvas
                                        ref={canvasRef}
                                        className="absolute top-0 left-0 w-full h-full touch-none cursor-crosshair opacity-50"
                                        onPointerDown={startDrawing}
                                        onPointerMove={draw}
                                        onPointerUp={stopDrawing}
                                        onPointerCancel={stopDrawing}
                                        onLostPointerCapture={stopDrawing}
                                    />
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                <DialogFooter className="shrink-0 gap-2 [&>button]:w-full sm:justify-end sm:[&>button]:w-auto">
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        {t('common.cancel', 'Cancel')}
                    </Button>
                    <Button
                        className="bg-primary text-primary-foreground hover:bg-primary/90"
                        onClick={() => void handleSaveMask()}
                        disabled={!propSourceImage || isGenerating}
                    >
                        {isGenerating
                            ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            : <Save className="mr-2 h-4 w-4" />}
                        {generateOnSave
                            ? t('tools.inpainting.generate', '인페인팅 생성')
                            : t('sourcePanel.saveMask', '마스크 저장')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
