
import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useToolsStore } from '@/stores/tools-store'
import { useAuthStore } from '@/stores/auth-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useGenerationStore } from '@/stores/generation-store'
import { publishGeneratedArtifact } from '@/stores/artifact-lifecycle-store'
import {
    calculateEnhanceMaxScale,
    canUseEnhanceMaxForPixels,
    smartTools,
} from '@/services/smart-tools'
import { getNovelAiModelProfile } from '@/services/nai/model-catalog'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/use-toast'
import { Eraser, Palette, Grid3X3, Wand2, Upload, RefreshCw, Download, X, Maximize2, Image as ImageIcon, Paintbrush, ImagePlus, PenTool, Pencil, Droplets, Smile, Sparkles } from 'lucide-react'
import {
    createNativeDirectory,
    nativePathExists,
    writeNativeBinaryFile,
} from '@/platform/native-file-system'
import { joinNativePath } from '@/platform/native-path'
import { TagAnalysisDialog } from '@/components/tools/TagAnalysisDialog'
import { BackgroundRemovalDialog } from '@/components/tools/BackgroundRemovalDialog'
import { RemoteImageProcessingConsent } from '@/components/privacy/RemoteImageProcessingConsent'
import { REMOTE_IMAGE_PROCESSING_POLICY_VERSION } from '@/services/privacy/remote-image-processing'
import { MosaicDialog } from '@/components/tools/MosaicDialog'
import { InpaintingDialog } from '@/components/tools/InpaintingDialog'
import { I2IDialog } from '@/components/tools/I2IDialog'
import {
    getMediaStorageRoot,
    MEDIA_STORAGE_BASE_DIRECTORY,
    shouldUseAbsoluteMediaPath,
} from '@/platform/storage'


export default function ToolsMode({ guided = false }: { guided?: boolean } = {}) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { activeImage, setActiveImage } = useToolsStore()
    const token = useAuthStore(state => state.getActiveTokens()[0]?.token ?? '')
    const selectedModel = useGenerationStore(state => state.model)

    const [processedImage, setProcessedImage] = useState<string | null>(activeImage)
    const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null)
    const [isLoading, setIsLoading] = useState(false)
    const remoteImageConsentVersion = useSettingsStore(state => state.remoteImageProcessingConsentVersion)
    const remoteImageConsentAccepted = remoteImageConsentVersion >= REMOTE_IMAGE_PROCESSING_POLICY_VERSION

    // Style Analysis State
    const [isAnalysisOpen, setIsAnalysisOpen] = useState(false)

    // Background Removal State
    const [isRembgOpen, setIsRembgOpen] = useState(false)
    const [rembgOriginal, setRembgOriginal] = useState<string | null>(null)
    const [rembgResult, setRembgResult] = useState<string | null>(null)


    // Mosaic State
    const [isMosaicOpen, setIsMosaicOpen] = useState(false)
    const [isInpaintingOpen, setIsInpaintingOpen] = useState(false)  // For mask editing only
    const [isI2IOpen, setIsI2IOpen] = useState(false)
    const containerRef = useRef<HTMLDivElement>(null)
    const fileInputRef = useRef<HTMLInputElement>(null)
    const [isDragOver, setIsDragOver] = useState(false)
    const dragCounter = useRef(0)

    // Sync store to local state
    useEffect(() => {
        setProcessedImage(activeImage)
    }, [activeImage])

    useEffect(() => {
        if (!processedImage) {
            setImageDimensions(null)
            return
        }
        let cancelled = false
        const image = new Image()
        image.onload = () => {
            if (!cancelled) setImageDimensions({ width: image.width, height: image.height })
            image.src = ''
        }
        image.onerror = () => {
            if (!cancelled) setImageDimensions(null)
            image.src = ''
        }
        image.src = processedImage
        return () => {
            cancelled = true
            image.src = ''
        }
    }, [processedImage])

    const selectedModelProfile = getNovelAiModelProfile(selectedModel)
    const enhanceMaxSupported = selectedModelProfile?.capabilities.enhanceMax === true
    const enhanceMaxWithinSize = imageDimensions !== null
        && canUseEnhanceMaxForPixels(imageDimensions.width, imageDimensions.height)
    const enhanceMaxScale = imageDimensions === null
        ? null
        : calculateEnhanceMaxScale(imageDimensions.width, imageDimensions.height)
    const enhanceMaxReason = !processedImage
        ? t('smartTools.enhanceMaxNeedImage', '이미지를 먼저 열어주세요.')
        : !enhanceMaxSupported
            ? t('smartTools.enhanceMaxV5Disabled', '현재 선택한 V5 모델은 Enhance MAX를 지원하지 않아요. V4 또는 V4.5 모델을 선택하면 사용할 수 있습니다.')
            : imageDimensions === null
                ? t('smartTools.enhanceMaxReadingSize', '이미지 크기를 읽는 중입니다.')
                : !enhanceMaxWithinSize
                    ? t('smartTools.enhanceMaxTooLarge', 'Enhance MAX는 3MP 목표 해상도의 80% 미만 이미지에서만 사용할 수 있습니다.')
                    : t('smartTools.enhanceMaxScale', '예상 배율 약 {{scale}}배', { scale: enhanceMaxScale?.toFixed(2) ?? '1.00' })
    const canRunEnhanceMax = Boolean(processedImage && !isLoading && enhanceMaxSupported && enhanceMaxWithinSize)

    const saveToolsImage = async (fileName: string, binaryData: Uint8Array): Promise<string> => {
        const { toolsSavePath, useAbsoluteToolsPath } = useSettingsStore.getState()
        const outputDir = toolsSavePath || 'nai-blue-tools'

        if (shouldUseAbsoluteMediaPath(useAbsoluteToolsPath)) {
            const dirExists = await nativePathExists(outputDir)
            if (!dirExists) {
                await createNativeDirectory(outputDir, { recursive: true })
            }
            const fullPath = await joinNativePath(outputDir, fileName)
            await writeNativeBinaryFile(fullPath, binaryData)
            return fullPath
        }

        const dirExists = await nativePathExists(outputDir, { baseDir: MEDIA_STORAGE_BASE_DIRECTORY })
        if (!dirExists) {
            await createNativeDirectory(outputDir, { baseDir: MEDIA_STORAGE_BASE_DIRECTORY })
        }
        await writeNativeBinaryFile(`${outputDir}/${fileName}`, binaryData, {
            baseDir: MEDIA_STORAGE_BASE_DIRECTORY,
        })
        return joinNativePath(await getMediaStorageRoot(), outputDir, fileName)
    }

    // Handle File Upload
    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (file) {
            const reader = new FileReader()
            reader.onload = (e) => {
                const result = e.target?.result as string
                setActiveImage(result)
            }
            reader.readAsDataURL(file)
        }
    }

    // Drag & Drop Handlers
    const handleDragEnter = (e: React.DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
        dragCounter.current++
        if (e.dataTransfer.types.includes('Files')) {
            setIsDragOver(true)
        }
    }

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
        dragCounter.current--
        if (dragCounter.current === 0) {
            setIsDragOver(false)
        }
    }

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
        dragCounter.current = 0
    }

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
        dragCounter.current = 0
        setIsDragOver(false)

        const file = e.dataTransfer.files?.[0]
        if (file && file.type.startsWith('image/')) {
            const reader = new FileReader()
            reader.onload = (ev) => {
                const result = ev.target?.result as string
                setActiveImage(result)
            }
            reader.readAsDataURL(file)
        }
    }

    const handleRemoveBackground = async () => {
        if (!processedImage) return
        setIsLoading(true)
        try {
            const result = await smartTools.removeBackground(processedImage, undefined, remoteImageConsentVersion)
            // Open comparison dialog instead of directly replacing
            setRembgOriginal(processedImage)
            setRembgResult(result)
            setIsRembgOpen(true)
        } catch (e) {
            console.error(e)
            toast({ title: t('smartTools.error', '작업 실패'), description: String(e), variant: 'destructive' })
        } finally {
            setIsLoading(false)
        }
    }



    const handleUpscale = async () => {
        if (!processedImage) return
        if (!token) {
            useAuthStore.getState().requestTokenEntry()
            toast({ title: t('toast.tokenRequired.title', 'API 토큰 필요'), description: t('toast.tokenRequired.desc', '설정에서 토큰을 입력해주세요.'), variant: 'destructive' })
            return
        }

        setIsLoading(true)
        try {
            const result = await smartTools.upscale(processedImage, token)

            const fileName = `NAI_Blue_UPSCALE_${Date.now()}.png`

            try {
                const base64Data = result.replace(/^data:image\/png;base64,/, '')
                const binaryData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0))
                const fullPath = await saveToolsImage(fileName, binaryData)

                publishGeneratedArtifact({ path: fullPath, data: result })
            } catch (e) {
                console.warn('Failed to save upscaled image:', e)
            }

            // Set as preview image
            const { setPreviewImage } = useGenerationStore.getState()
            setPreviewImage(result)
            setActiveImage(result)
            setProcessedImage(result)

            toast({ title: t('smartTools.upscaleComplete', '업스케일 완료'), description: t('smartTools.upscaleCompleteDesc', 'NovelAI가 현재 이미지에 맞춰 업스케일했습니다.'), variant: 'success' })

            if (!guided) navigate('/advanced')
        } catch (e) {
            console.error(e)
            toast({ title: t('smartTools.error', '작업 실패'), description: String(e), variant: 'destructive' })
        } finally {
            setIsLoading(false)
        }
    }

    const handleEnhanceMax = async () => {
        if (!processedImage || !canRunEnhanceMax) return
        if (!token) {
            useAuthStore.getState().requestTokenEntry()
            toast({ title: t('toast.tokenRequired.title', 'API 토큰 필요'), description: t('toast.tokenRequired.desc', '설정에서 토큰을 입력해주세요.'), variant: 'destructive' })
            return
        }

        setIsLoading(true)
        try {
            const generation = useGenerationStore.getState()
            const result = await smartTools.enhanceMax(processedImage, token, {
                prompt: [generation.basePrompt, generation.additionalPrompt, generation.detailPrompt]
                    .filter(part => part.trim().length > 0)
                    .join(', '),
                negative_prompt: generation.negativePrompt,
                model: selectedModel,
                steps: generation.steps,
                cfg_scale: generation.cfgScale,
                cfg_rescale: generation.cfgRescale,
                sampler: generation.sampler,
                scheduler: generation.scheduler,
                smea: generation.smea,
                smea_dyn: generation.smeaDyn,
                variety: generation.variety,
                strength: generation.strength,
                noise: generation.noise,
                qualityToggle: generation.qualityToggle,
                ucPreset: generation.ucPreset,
            })

            const fileName = `NAI_Blue_ENHANCE_MAX_${Date.now()}.png`

            try {
                const base64Data = result.replace(/^data:image\/png;base64,/, '')
                const binaryData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0))
                const fullPath = await saveToolsImage(fileName, binaryData)

                publishGeneratedArtifact({ path: fullPath, data: result })
            } catch (e) {
                console.warn('Failed to save Enhance MAX image:', e)
            }

            const { setPreviewImage } = useGenerationStore.getState()
            setPreviewImage(result)
            setActiveImage(result)
            setProcessedImage(result)

            toast({ title: t('smartTools.enhanceMaxComplete', 'Enhance MAX 완료'), description: t('smartTools.enhanceMaxCompleteDesc', 'NovelAI가 3MP 목표로 인핸스했습니다.'), variant: 'success' })

            if (!guided) navigate('/advanced')
        } catch (e) {
            console.error(e)
            toast({ title: t('smartTools.error', '작업 실패'), description: String(e), variant: 'destructive' })
        } finally {
            setIsLoading(false)
        }
    }

    // Director Tools handler
    const handleDirectorTool = async (reqType: 'lineart' | 'sketch' | 'colorize' | 'emotion' | 'declutter', options?: { defry?: number; prompt?: string; emotion?: string }) => {
        if (!processedImage) return
        if (!token) {
            useAuthStore.getState().requestTokenEntry()
            toast({ title: t('toast.tokenRequired.title', 'API 토큰 필요'), description: t('toast.tokenRequired.desc', '설정에서 토큰을 입력해주세요.'), variant: 'destructive' })
            return
        }

        setIsLoading(true)
        try {
            const result = await smartTools.directorTool(processedImage, token, reqType, options)

            const label = reqType.toUpperCase().replace('-', '_')
            const fileName = `NAI_Blue_${label}_${Date.now()}.png`

            try {
                const base64Data = result.replace(/^data:image\/\w+;base64,/, '')
                const binaryData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0))
                const fullPath = await saveToolsImage(fileName, binaryData)

                publishGeneratedArtifact({ path: fullPath, data: result })
            } catch (e) {
                console.warn('Failed to save director tool image:', e)
            }

            setActiveImage(result)
            toast({ title: t('smartTools.directorComplete', '처리 완료'), variant: 'success' })
        } catch (e) {
            console.error(e)
            toast({ title: t('smartTools.error', '작업 실패'), description: String(e), variant: 'destructive' })
        } finally {
            setIsLoading(false)
        }
    }

    // Save to Disk (New functionality for Tools Page)
    const handleSaveFile = async () => {
        if (!processedImage) return
        try {
            // Remove header
            const base64Data = processedImage.replace(/^data:image\/\w+;base64,/, "")
            // Decode
            const binary = atob(base64Data)
            const array = new Uint8Array(binary.length)
            for (let i = 0; i < binary.length; i++) array[i] = binary.charCodeAt(i)

            const filename = `NAI_Blue_Edit_${Date.now()}.png`
            await saveToolsImage(filename, array)

            toast({ title: t('common.saved', '저장됨'), description: filename, variant: 'success' })
        } catch (e) {
            console.error(e)
            toast({ title: t('common.saveFailed', '저장 실패'), variant: 'destructive' })
        }
    }

    return (
        <div
            data-local-file-drop
            className="relative flex h-full min-h-0 flex-col gap-6"
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
        >
            {!guided && <header className="workspace-heading !mb-0 shrink-0">
                <h1>{t('smartTools.title', '스마트 툴')}</h1>
                <p>{t('workspace.toolsHint', '이미지를 열고, 배경 제거·보정 등 필요한 작업을 선택하세요.')}</p>
            </header>}
            <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
            {/* Drag overlay */}
            {isDragOver && (
                <div className="absolute inset-0 z-50 bg-scrim/72 flex items-center justify-center rounded-panel">
                    <div className="relative">
                        <div className="relative rounded-panel bg-popover p-12 shadow-overlay">
                            <div className="text-center space-y-4">
                                <div className="relative mx-auto w-20 h-20">
                                    <div className="absolute inset-0 rounded-full bg-primary/20 animate-ping" />
                                    <div className="relative w-full h-full rounded-full bg-primary flex items-center justify-center">
                                        <ImagePlus className="h-10 w-10 text-primary-foreground" />
                                    </div>
                                </div>
                                <div>
                                    <p className="text-xl font-semibold text-foreground">
                                        {t('smartTools.dropToLoad', '이미지를 드롭하여 열기')}
                                    </p>
                                    <p className="text-sm text-muted-foreground mt-1">
                                        {t('smartTools.supportedFormats', 'PNG, JPG, WEBP 지원')}
                                    </p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
            {/* Left: Image Workspace */}
            <div className="relative flex min-h-[18rem] flex-[0_0_42%] flex-col overflow-hidden bg-canvas md:min-h-0 md:flex-1" ref={containerRef}>
                {processedImage ? (
                    <div className="flex-1 flex items-center justify-center p-4 overflow-hidden relative">
                        <img
                            src={processedImage}
                            className="max-w-full max-h-full object-contain shadow-lg"
                            alt="Workspace"
                        />

                        {isLoading && (
                            <div className="absolute inset-0 bg-scrim/72 flex flex-col items-center justify-center text-primary-foreground z-10">
                                <div className="relative">
                                    <div className="absolute inset-0 w-20 h-20 rounded-full bg-primary/30 animate-ping" />
                                    <div className="relative w-20 h-20 rounded-full bg-gradient-to-br from-primary to-primary/50 flex items-center justify-center shadow-xl">
                                        <RefreshCw className="h-8 w-8 animate-spin" />
                                    </div>
                                </div>
                                <div className="mt-6 text-lg font-semibold tracking-wide">
                                    {t('smartTools.processing', '처리 중...')}
                                </div>
                                <div className="mt-2 text-sm text-primary-foreground/60">
                                    {t('smartTools.pleaseWait', '잠시만 기다려주세요')}
                                </div>
                            </div>
                        )}
                    </div>
                ) : (
                    <div
                        className="m-3 flex flex-1 flex-col items-center justify-center rounded-lg border-2 border-dashed border-border p-4 text-center text-muted-foreground transition-colors hover:border-primary/50 sm:m-4 sm:p-8"
                    >
                        <Upload className="mb-3 h-12 w-12 opacity-20 sm:mb-4 sm:h-16 sm:w-16" />
                        <h3 className="mb-2 text-base font-medium sm:text-xl">{t('smartTools.dropHint', '이미지를 열거나 드래그하세요')}</h3>
                        <p className="mb-4 text-xs opacity-60 sm:mb-6 sm:text-sm">{t('smartTools.supportedFormats', 'PNG, JPG, WEBP 지원')}</p>
                        <Button
                            type="button"
                            variant="default"
                            className="min-h-11"
                            onClick={() => fileInputRef.current?.click()}
                        >
                            {t('smartTools.openImage', '이미지 열기')}
                        </Button>
                        <input
                            ref={fileInputRef}
                            type="file"
                            className="sr-only"
                            accept="image/*"
                            tabIndex={-1}
                            aria-hidden="true"
                            onChange={handleFileChange}
                        />
                    </div>
                )}

                {/* Image Actions (Bottom Overlay) */}
                {processedImage && (
                    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-2 rounded-control bg-popover p-2 shadow-overlay z-20">
                        <Button size="icon" variant="ghost" className="rounded-full" onClick={() => setActiveImage(null)} aria-label={t('common.remove', '이미지 제거')}>
                            <X className="h-4 w-4" />
                        </Button>
                        <div className="w-px h-6 bg-border mx-1 my-auto" />
                        <Button size="icon" variant="ghost" className="rounded-full" onClick={handleSaveFile} aria-label={t('common.save', '저장')}>
                            <Download className="h-4 w-4" />
                        </Button>
                    </div>
                )}
            </div>

            {/* Right: Tools Options */}
            <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-card md:w-[320px] md:flex-none">
                <div className="p-4 border-b border-border bg-muted/30">
                    <h2 className="font-semibold flex items-center gap-2">
                        <Wand2 className="h-4 w-4 text-primary" />
                        {t('smartTools.title', '스마트 툴')}
                    </h2>
                </div>

                <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
                    {processedImage ? <>
                    <RemoteImageProcessingConsent />

                    {/* Background Removal */}
                    <ToolCard
                        icon={Eraser}
                        color="text-destructive"
                        title={t('smartTools.rembg', '배경 제거')}
                        disabled={!processedImage || isLoading || !remoteImageConsentAccepted}
                    >
                        <Button
                            className="w-full"
                            variant="secondary"
                            onClick={handleRemoveBackground}
                            disabled={!processedImage || isLoading || !remoteImageConsentAccepted}
                        >
                            {t('smartTools.runRembg', '배경 제거 실행')}
                        </Button>
                    </ToolCard>

                    {/* Style Analysis (Kaloscope) */}
                    <ToolCard
                        icon={Palette}
                        color="text-primary"
                        title={t('smartTools.kaloscopeStyle', '스타일 분석')}
                        disabled={!processedImage || isLoading || !remoteImageConsentAccepted}
                    >
                        <Button
                            className="w-full"
                            variant="secondary"
                            onClick={() => setIsAnalysisOpen(true)}
                            disabled={!processedImage || isLoading || !remoteImageConsentAccepted}
                        >
                            {t('smartTools.runStyle', '스타일 분석 실행')}
                        </Button>
                    </ToolCard>

                    {/* Image to Image */}
                    <ToolCard
                        icon={ImageIcon}
                        color="text-info"
                        title={t('tools.i2i.title', 'Image to Image')}
                        disabled={!processedImage || isLoading}
                    >
                        <Button
                            className="w-full"
                            variant="secondary"
                            onClick={() => {
                                if (!processedImage) return
                                if (guided) {
                                    setIsI2IOpen(true)
                                    return
                                }
                                const { setSourceImage, setI2IMode } = useGenerationStore.getState()
                                setSourceImage(processedImage)
                                setI2IMode('i2i')
                                navigate('/advanced')
                            }}
                            disabled={!processedImage || isLoading}
                        >
                            {t('tools.i2i.open', 'I2I 모드로 이동')}
                        </Button>
                    </ToolCard>

                    {/* Inpainting */}
                    <ToolCard
                        icon={Paintbrush}
                        color="text-primary"
                        title={t('tools.inpainting.title', 'Inpainting')}
                        disabled={!processedImage || isLoading}
                    >
                        <Button
                            className="w-full"
                            variant="secondary"
                            onClick={() => {
                                if (!processedImage) return
                                if (guided) {
                                    setIsInpaintingOpen(true)
                                    return
                                }
                                const { setSourceImage, setI2IMode } = useGenerationStore.getState()
                                setSourceImage(processedImage)
                                setI2IMode('inpaint')
                                navigate('/advanced')  // Navigate directly, mask editing done from sidebar
                            }}
                            disabled={!processedImage || isLoading}
                        >
                            {t('tools.inpainting.open', '인페인팅 모드로 이동')}
                        </Button>
                    </ToolCard>

                    {/* Mosaic */}
                    <ToolCard
                        icon={Grid3X3}
                        color="text-warning"
                        title={t('smartTools.mosaic', '모자이크')}
                        disabled={!processedImage || isLoading}
                    >
                        <Button
                            className="w-full"
                            variant="secondary"
                            onClick={() => setIsMosaicOpen(true)}
                            disabled={!processedImage || isLoading}
                        >
                            {t('smartTools.startMosaic', '모자이크 편집기 열기')}
                        </Button>
                    </ToolCard>

                    {/* Upscale */}
                    <ToolCard
                        icon={Maximize2}
                        color="text-primary"
                        title={
                            <span className="flex items-center gap-2">
                                {t('smartTools.upscale', '업스케일')}
                                <span className="text-warning text-xs font-medium">{t('smartTools.providerCost', '비용 자동 계산')}</span>
                            </span>
                        }
                        disabled={!processedImage || isLoading}
                    >
                        <p className="text-muted-foreground mb-3 text-xs leading-relaxed">
                            {t('smartTools.upscaleDesc', 'PNG 입력은 3MP 이하만 지원되며, Anlas 비용은 NovelAI가 요청 시점에 계산합니다.')}
                        </p>
                        <Button
                            className="w-full"
                            variant="secondary"
                            onClick={handleUpscale}
                            disabled={!processedImage || isLoading}
                        >
                            {t('smartTools.startUpscale', '업스케일 시작')}
                        </Button>
                    </ToolCard>

                    {/* Enhance MAX */}
                    <ToolCard
                        icon={Sparkles}
                        color="text-success"
                        title={
                            <span className="flex items-center gap-2">
                                {t('smartTools.enhanceMax', 'Enhance MAX')}
                                <span className="text-warning text-xs font-medium">{t('smartTools.providerCost', '비용 자동 계산')}</span>
                            </span>
                        }
                        disabled={!canRunEnhanceMax}
                    >
                        <p className="text-muted-foreground mb-3 text-xs leading-relaxed">
                            {t('smartTools.enhanceMaxDesc', 'V4/V4.5 모델에서 원본 이미지를 3MP 목표로 자동 인핸스합니다.')}
                        </p>
                        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
                            {t('smartTools.enhanceMaxUsesCurrentSettings', '현재 메인 화면의 프롬프트·강도·노이즈 설정을 그대로 사용합니다.')}
                        </p>
                        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
                            {enhanceMaxReason}
                        </p>
                        <Button
                            className="w-full"
                            variant="secondary"
                            onClick={handleEnhanceMax}
                            disabled={!canRunEnhanceMax}
                        >
                            {t('smartTools.startEnhanceMax', 'Enhance MAX 시작')}
                        </Button>
                    </ToolCard>

                    {/* Line Art */}
                    <ToolCard
                        icon={PenTool}
                        color="text-muted-foreground"
                        title={t('smartTools.lineart', '라인아트 추출')}
                        disabled={!processedImage || isLoading}
                    >
                        <Button className="w-full" variant="secondary" onClick={() => handleDirectorTool('lineart')} disabled={!processedImage || isLoading}>
                            {t('smartTools.runLineart', '라인아트 추출')}
                        </Button>
                    </ToolCard>

                    {/* Sketch */}
                    <ToolCard
                        icon={Pencil}
                        color="text-muted-foreground"
                        title={t('smartTools.sketch', '스케치 변환')}
                        disabled={!processedImage || isLoading}
                    >
                        <Button className="w-full" variant="secondary" onClick={() => handleDirectorTool('sketch')} disabled={!processedImage || isLoading}>
                            {t('smartTools.runSketch', '스케치 변환')}
                        </Button>
                    </ToolCard>

                    {/* Colorize */}
                    <ToolCard
                        icon={Droplets}
                        color="text-info"
                        title={t('smartTools.colorize', '색칠하기')}
                        disabled={!processedImage || isLoading}
                    >
                        <DirectorToolWithOptions
                            onRun={(defry, prompt) => handleDirectorTool('colorize', { defry, prompt })}
                            disabled={!processedImage || isLoading}
                            showPrompt
                            promptPlaceholder={t('smartTools.colorizePrompt', '색상 힌트 (예: red hair, blue eyes)')}
                            buttonLabel={t('smartTools.runColorize', '색칠 실행')}
                            t={t}
                        />
                    </ToolCard>

                    {/* Emotion */}
                    <ToolCard
                        icon={Smile}
                        color="text-warning"
                        title={t('smartTools.emotion', '표정 변경')}
                        disabled={!processedImage || isLoading}
                    >
                        <DirectorToolWithOptions
                            onRun={(defry, prompt, emotion) => handleDirectorTool('emotion', { defry, prompt, emotion })}
                            disabled={!processedImage || isLoading}
                            showEmotion
                            showPrompt
                            promptPlaceholder={t('smartTools.emotionPrompt', '추가 프롬프트 (선택)')}
                            buttonLabel={t('smartTools.runEmotion', '표정 변경')}
                            t={t}
                        />
                    </ToolCard>

                    {/* Declutter */}
                    <ToolCard
                        icon={Sparkles}
                        color="text-success"
                        title={t('smartTools.declutter', '이미지 정리')}
                        disabled={!processedImage || isLoading}
                    >
                        <Button className="w-full" variant="secondary" onClick={() => handleDirectorTool('declutter')} disabled={!processedImage || isLoading}>
                            {t('smartTools.runDeclutter', '정리 실행')}
                        </Button>
                    </ToolCard>
                    </> : <div className="space-y-4 text-muted-foreground">
                        <p>{t('workspace.toolsStartHint', '이미지를 열면 사용할 수 있는 도구가 표시돼요.')}</p>
                        <ul className="space-y-3 text-sm">
                            <li>{t('smartTools.rembg', '배경 제거')}</li>
                            <li>{t('smartTools.kaloscopeStyle', '스타일 분석')}</li>
                            <li>{t('smartTools.declutter', '이미지 정리')}</li>
                        </ul>
                    </div>}
                </div>
            </div>

            </div>

            <TagAnalysisDialog
                imageUrl={processedImage}
                isOpen={isAnalysisOpen}
                onClose={() => setIsAnalysisOpen(false)}
            />

            <BackgroundRemovalDialog
                originalImage={rembgOriginal}
                processedImage={rembgResult}
                isOpen={isRembgOpen}
                onClose={() => setIsRembgOpen(false)}
            />

            <MosaicDialog
                sourceImage={processedImage}
                isOpen={isMosaicOpen}
                onClose={() => setIsMosaicOpen(false)}
            />

            <InpaintingDialog
                open={isInpaintingOpen}
                onOpenChange={(open) => {
                    setIsInpaintingOpen(open)
                    // Navigate to main mode after mask editing is done
                    if (!guided && !open && useGenerationStore.getState().i2iMode === 'inpaint') {
                        navigate('/advanced')
                    }
                }}
                sourceImage={processedImage}
                generateOnSave={guided}
                onGenerated={image => {
                    if (!image) return
                    setActiveImage(image)
                    setProcessedImage(image)
                }}
            />
            <I2IDialog
                open={isI2IOpen}
                onOpenChange={setIsI2IOpen}
                sourceImage={processedImage}
                navigateOnComplete={!guided}
                onGenerated={image => {
                    if (!image) return
                    setActiveImage(image)
                    setProcessedImage(image)
                }}
            />
        </div>
    )
}

function ToolCard({ children, icon: Icon, color, title, disabled }: any) {
    return (
        <div className={cn("py-4 border-b border-border/60 bg-transparent", disabled && "opacity-50 pointer-events-none")}>
            <div className="flex items-center gap-3 mb-3">
                <Icon className={cn("h-5 w-5", color)} />
                <span className="font-medium">{title}</span>
            </div>
            {children}
        </div>
    )
}

import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Label } from '@/components/ui/label'

const EMOTIONS = [
    'neutral', 'happy', 'sad', 'angry', 'scared', 'surprised',
    'tired', 'excited', 'nervous', 'thinking', 'confused',
    'shy', 'disgusted', 'smug', 'bored', 'laughing',
    'crying', 'tsundere', 'yandere', 'kuudere', 'blushing',
] as const

function DirectorToolWithOptions({ onRun, disabled, showPrompt, showEmotion, promptPlaceholder, buttonLabel, t }: {
    onRun: (defry: number, prompt: string, emotion?: string) => void
    disabled: boolean
    showPrompt?: boolean
    showEmotion?: boolean
    promptPlaceholder?: string
    buttonLabel: string
    t: any
}) {
    const [defry, setDefry] = useState(0)
    const [prompt, setPrompt] = useState('')
    const [emotion, setEmotion] = useState('happy')

    return (
        <div className="space-y-3">
            {showEmotion && (
                <div>
                    <Label className="text-xs text-muted-foreground mb-1 block">{t('smartTools.emotionType', '표정')}</Label>
                    <Select value={emotion} onValueChange={setEmotion}>
                        <SelectTrigger className="h-8 text-sm">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="max-h-[200px]">
                            {EMOTIONS.map(e => (
                                <SelectItem key={e} value={e}>{e}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            )}
            {showPrompt && (
                <Input
                    value={prompt}
                    onChange={e => setPrompt(e.target.value)}
                    placeholder={promptPlaceholder}
                    className="h-8 text-sm"
                />
            )}
            <div>
                <Label className="text-xs text-muted-foreground mb-1 block">
                    {t('smartTools.defry', '원본 유지도')}: {defry}
                </Label>
                <Slider
                    value={[defry]}
                    onValueChange={([v]) => setDefry(v)}
                    min={0}
                    max={5}
                    step={1}
                    className="w-full"
                />
            </div>
            <Button className="w-full" variant="secondary" onClick={() => onRun(defry, prompt, emotion)} disabled={disabled}>
                {buttonLabel}
            </Button>
        </div>
    )
}
