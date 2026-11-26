import React, { useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Upload, X, Zap, Database, Lock, Eye, EyeOff, Image as ImageIcon } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Slider } from '@/components/ui/slider'
import { Label } from '@/components/ui/label'
import { Tip } from '@/components/ui/tooltip'
import { useCharacterStore, ReferenceImage, PreciseReferenceType } from '@/stores/character-store'
import { parseMetadataFromBase64 } from '@/lib/metadata-parser'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useGenerationDraftStore } from '@/stores/generation-draft-store'
import { getNovelAiModelProfile } from '@/services/nai/model-catalog'
import { defaultPreferSameOutfit, supportsPreferSameOutfit } from '@/domain/generation/precise-reference'
import { Switch } from '@/components/ui/switch'

const SafeSlider = ({
    value,
    onValueCommit,
    max = 1,
    step = 0.01,
    label,
}: {
    value: number[]
    onValueCommit: (val: number[]) => void
    max?: number
    step?: number
    label?: string
}) => {
    const [localValue, setLocalValue] = React.useState(value)

    React.useEffect(() => {
        setLocalValue(value)
    }, [value])

    return (
        <div className="space-y-1">
            {label && (
                <div className="flex justify-between">
                    <Label className="text-xs text-muted-foreground">{label}</Label>
                    <span className="text-xs font-mono">{localValue[0].toFixed(2)}</span>
                </div>
            )}
            <Slider
                value={localValue}
                min={0}
                max={max}
                step={step}
                onValueChange={setLocalValue}
                onValueCommit={onValueCommit}
            />
        </div>
    )
}

export function CharacterSettingsDialog({
    open,
    onOpenChange,
    hideTrigger = false,
    triggerLabel,
}: {
    open?: boolean
    onOpenChange?: (open: boolean) => void
    hideTrigger?: boolean
    triggerLabel?: string
} = {}) {
    const { t } = useTranslation()
    const model = useGenerationDraftStore(state => state.model)
    const capabilities = getNovelAiModelProfile(model)?.capabilities
    const preciseReferenceRules = capabilities?.preciseReferenceRules ?? null
    const {
        characterImages,
        vibeImages,
        addCharacterImage,
        removeCharacterImage,
        updateCharacterImage,
        addVibeImage,
        removeVibeImage,
        updateVibeImage
    } = useCharacterStore()

    const charInputRef = useRef<HTMLInputElement>(null)
    const vibeInputRef = useRef<HTMLInputElement>(null)

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>, mode: 'character' | 'vibe') => {
        const files = e.target.files
        if (!files || files.length === 0) return

        for (let i = 0; i < files.length; i++) {
            const file = files[i]
            const base64 = await convertToBase64(file)
            if (mode === 'character') {
                await addCharacterImage(base64)
            } else {
                // Try to extract pre-encoded vibe from PNG metadata
                try {
                    const metadata = await parseMetadataFromBase64(base64)
                    if (metadata?.encodedVibes && metadata.encodedVibes.length > 0) {
                        // Use first encoded vibe and info/strength from metadata
                        const info = metadata.vibeTransferInfo?.[0]
                        await addVibeImage(
                            base64,
                            metadata.encodedVibes[0],
                            info?.informationExtracted ?? 1.0,
                            info?.strength ?? 0.6
                        )
                    } else {
                        await addVibeImage(base64)
                    }
                } catch {
                    await addVibeImage(base64)
                }
            }
        }
        // Reset input
        e.target.value = ''
    }

    const [charDragOver, setCharDragOver] = useState(false)
    const [vibeDragOver, setVibeDragOver] = useState(false)

    const handleDrop = useCallback(async (e: React.DragEvent, mode: 'character' | 'vibe') => {
        e.preventDefault()
        e.stopPropagation()
        if (mode === 'character') setCharDragOver(false)
        else setVibeDragOver(false)

        const files = e.dataTransfer.files
        if (!files || files.length === 0) return

        for (let i = 0; i < files.length; i++) {
            const file = files[i]
            if (!file.type.startsWith('image/')) continue
            const base64 = await convertToBase64(file)
            if (mode === 'character') {
                await addCharacterImage(base64)
            } else {
                try {
                    const metadata = await parseMetadataFromBase64(base64)
                    if (metadata?.encodedVibes && metadata.encodedVibes.length > 0) {
                        const info = metadata.vibeTransferInfo?.[0]
                        await addVibeImage(
                            base64,
                            metadata.encodedVibes[0],
                            info?.informationExtracted ?? 1.0,
                            info?.strength ?? 0.6
                        )
                    } else {
                        await addVibeImage(base64)
                    }
                } catch {
                    await addVibeImage(base64)
                }
            }
        }
    }, [addCharacterImage, addVibeImage])

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
    }, [])

    const convertToBase64 = (file: File): Promise<string> => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader()
            reader.readAsDataURL(file)
            reader.onload = () => {
                resolve(reader.result as string)
            }
            reader.onerror = error => reject(error)
        })
    }

    // Vibe Image List Component
    const VibeImageList = ({
        images,
        onRemove,
        onUpdate
    }: {
        images: ReferenceImage[],
        onRemove: (id: string) => void,
        onUpdate: (id: string, updates: Partial<ReferenceImage>) => void
    }) => (
        <div className="space-y-4 pt-4">
            {images.length === 0 && (
                <div className="text-center py-8 text-muted-foreground bg-muted/30 rounded-lg border border-dashed">
                    {t('characterDialog.noImages')}
                </div>
            )}
            {images.map(img => {
                const isEnabled = img.enabled !== false
                return (
                    <div 
                        key={img.id} 
                        className={cn(
                            "flex gap-4 rounded-lg border bg-card p-3 transition-[background-color,border-color,opacity]",
                            isEnabled ? "bg-muted/10" : "bg-muted/5 opacity-50"
                        )}
                    >
                        <div className="relative shrink-0 w-24 h-24 bg-muted rounded-md overflow-hidden border flex items-center justify-center group/image">
                            {(img.thumbnail || img.base64) ? (
                                <img 
                                    src={img.thumbnail || img.base64} 
                                    alt="Reference" 
                                    className={cn(
                                        "h-full w-full object-cover transition-[filter,opacity]",
                                        !isEnabled && "grayscale"
                                    )} 
                                />
                            ) : (
                                <div className="flex flex-col items-center justify-center text-muted-foreground p-2 text-center">
                                    <Database className="w-8 h-8 opacity-50 mb-1" />
                                    <span className="whitespace-pre-line text-[11px] leading-tight">{t('characterDialog.encodedDataOnly')}</span>
                                </div>
                            )}
                            <Button
                                variant="destructive"
                                size="icon"
                                className="absolute right-1 top-1 h-11 w-11 rounded-control opacity-100 shadow-panel sm:opacity-0 sm:group-hover/image:opacity-100"
                                onClick={() => onRemove(img.id)}
                                aria-label={t('actions.delete', '삭제')}
                            >
                                <X className="w-3 h-3" />
                            </Button>
                            {/* 활성화/비활성화 토글 */}
                            <Tip content={isEnabled ? t('characterDialog.clickToDisable', '클릭하여 비활성화') : t('characterDialog.clickToEnable', '클릭하여 활성화')}>
                                <Button
                                    variant="secondary"
                                    size="icon"
                                    className={cn(
                                        "absolute bottom-1 right-1 h-11 w-11 rounded-control shadow-panel",
                                        isEnabled ? "bg-success text-primary-foreground hover:bg-success/90" : "bg-muted text-muted-foreground hover:bg-accent"
                                    )}
                                    onClick={() => onUpdate(img.id, { enabled: !isEnabled })}
                                    aria-label={isEnabled ? t('characterDialog.clickToDisable', '클릭하여 비활성화') : t('characterDialog.clickToEnable', '클릭하여 활성화')}
                                >
                                    {isEnabled ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                                </Button>
                            </Tip>
                            {/* Pre-encoded indicator */}
                            {img.encodedVibe && (
                                <Tip content={t('characterDialog.preEncodedTooltip')}>
                                    <div className="absolute bottom-1 left-1 flex items-center gap-0.5 rounded-control bg-success px-1 py-0.5 text-[11px] font-bold leading-none text-primary-foreground">
                                        <Zap className="w-2.5 h-2.5" />
                                    </div>
                                </Tip>
                            )}
                        </div>
                        <div className={cn("flex-1 space-y-3 min-w-0", !isEnabled && "pointer-events-none")}>
                            <SafeSlider
                                label={t('characterDialog.vibeInfoExtracted', '정보 추출률 (Information Extracted)')}
                                value={[img.informationExtracted]}
                                onValueCommit={([v]) => onUpdate(img.id, { informationExtracted: v })}
                            />
                            <SafeSlider
                                label={t('characterDialog.vibeStrength', '강도 (Reference Strength)')}
                                value={[img.strength]}
                                onValueCommit={([v]) => onUpdate(img.id, { strength: v })}
                            />
                        </div>
                    </div>
                )
            })}
        </div>
    )

    // Character Reference Image List Component (참조 레퍼런스)
    const CharacterImageList = ({
        images,
        onRemove,
        onUpdate
    }: {
        images: ReferenceImage[],
        onRemove: (id: string) => void,
        onUpdate: (id: string, updates: Partial<ReferenceImage>) => void
    }) => (
        <div className="space-y-4 pt-4">
            {images.length === 0 && (
                <div className="text-center py-8 text-muted-foreground bg-muted/30 rounded-lg border border-dashed">
                    {t('characterDialog.noImages')}
                </div>
            )}
            {images.map(img => {
                const isEnabled = img.enabled !== false // undefined도 true로 취급 (하위 호환)
                const referenceType = img.referenceType || 'character&style'
                return (
                    <div 
                        key={img.id} 
                        className={cn(
                            "flex gap-4 rounded-lg border bg-card p-3 transition-[background-color,border-color,opacity]",
                            isEnabled ? "bg-muted/10" : "bg-muted/5 opacity-50"
                        )}
                    >
                        <div className="relative shrink-0 w-24 h-24 bg-muted rounded-md overflow-hidden border flex items-center justify-center group/image">
                            {(img.thumbnail || img.base64) ? (
                                <img 
                                    src={img.thumbnail || img.base64} 
                                    alt="Reference" 
                                    className={cn(
                                        "h-full w-full object-cover transition-[filter,opacity]",
                                        !isEnabled && "grayscale"
                                    )} 
                                />
                            ) : (
                                <div className="flex flex-col items-center justify-center text-muted-foreground p-2 text-center">
                                    <ImageIcon className="w-8 h-8 opacity-50 mb-1 animate-pulse" />
                                    <span className="text-[11px] leading-tight">{t('common.loading', 'Loading...')}</span>
                                </div>
                            )}
                            {/* 삭제 버튼 */}
                            <Button
                                variant="destructive"
                                size="icon"
                                className="absolute right-1 top-1 h-11 w-11 rounded-control opacity-100 shadow-panel sm:opacity-0 sm:group-hover/image:opacity-100"
                                onClick={() => onRemove(img.id)}
                                aria-label={t('actions.delete', '삭제')}
                            >
                                <X className="w-3 h-3" />
                            </Button>
                            {/* 활성화/비활성화 토글 */}
                            <Tip content={isEnabled ? t('characterDialog.clickToDisable', '클릭하여 비활성화') : t('characterDialog.clickToEnable', '클릭하여 활성화')}>
                                <Button
                                    variant="secondary"
                                    size="icon"
                                    className={cn(
                                        "absolute bottom-1 right-1 h-11 w-11 rounded-control shadow-panel",
                                        isEnabled ? "bg-success text-primary-foreground hover:bg-success/90" : "bg-muted text-muted-foreground hover:bg-accent"
                                    )}
                                    onClick={() => onUpdate(img.id, { enabled: !isEnabled })}
                                    aria-label={isEnabled ? t('characterDialog.clickToDisable', '클릭하여 비활성화') : t('characterDialog.clickToEnable', '클릭하여 활성화')}
                                >
                                    {isEnabled ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                                </Button>
                            </Tip>
                            {/* 캐시된 이미지 표시 */}
                            {img.cacheKey && (
                                <Tip content={t('characterDialog.cachedTooltip', '서버에 캐시됨 (재전송 불필요)')}>
                                    <div className="absolute bottom-1 left-1 flex items-center gap-0.5 rounded-control bg-primary px-1 py-0.5 text-[11px] font-bold leading-none text-primary-foreground">
                                        <Zap className="w-2.5 h-2.5" />
                                    </div>
                                </Tip>
                            )}
                        </div>
                        <div className={cn("flex-1 space-y-3 min-w-0", !isEnabled && "pointer-events-none")}>
                            {/* Reference Type - 참조 타입 선택 */}
                            <div className="space-y-1">
                                <Label className="text-xs text-muted-foreground">
                                    {t('characterDialog.referenceType', '참조 타입')}
                                </Label>
                                <Select
                                    value={referenceType}
                                    // A new type starts from its own "Prefer same outfit" default instead of the previous type's choice.
                                    onValueChange={(v) => onUpdate(img.id, { referenceType: v as PreciseReferenceType, preferSameOutfit: undefined })}
                                    disabled={!isEnabled}
                                >
                                    <SelectTrigger className="h-8 text-xs">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="character&style">
                                            {t('characterDialog.typeCharacterStyle', '캐릭터 & 스타일')}
                                        </SelectItem>
                                        <SelectItem value="character">
                                            {t('characterDialog.typeCharacter', '캐릭터')}
                                        </SelectItem>
                                        <SelectItem value="style">
                                            {t('characterDialog.typeStyle', '스타일')}
                                        </SelectItem>
                                        {/* A stored Outfit reference stays visible on a model that cannot use it. */}
                                        {(preciseReferenceRules?.outfit || referenceType === 'outfit') && (
                                            <SelectItem value="outfit">
                                                {t('characterDialog.typeOutfit', '의상 (V5)')}
                                            </SelectItem>
                                        )}
                                    </SelectContent>
                                </Select>
                            </div>
                            {preciseReferenceRules?.outfit && supportsPreferSameOutfit(referenceType) && (
                                <div className="flex items-center justify-between gap-3">
                                    <Label htmlFor={`prefer-same-outfit-${img.id}`} className="text-xs text-muted-foreground">
                                        {t('characterDialog.preferSameOutfit', '같은 의상 우선 (Prefer same outfit)')}
                                    </Label>
                                    <Switch
                                        id={`prefer-same-outfit-${img.id}`}
                                        checked={img.preferSameOutfit ?? defaultPreferSameOutfit(referenceType)}
                                        onChange={(event) => onUpdate(img.id, { preferSameOutfit: event.target.checked })}
                                        disabled={!isEnabled}
                                    />
                                </div>
                            )}
                            {/* Strength - Slider */}
                            <SafeSlider
                                label={t('characterDialog.strength', '강도 (Strength)')}
                                value={[img.strength]}
                                max={preciseReferenceRules?.strengthMax ?? 1}
                                onValueCommit={([v]) => onUpdate(img.id, { strength: v })}
                            />
                            {/* Fidelity - Slider: V5 has no Fidelity control */}
                            {preciseReferenceRules?.fidelity !== false && (
                                <SafeSlider
                                    label={t('characterDialog.fidelity', '충실도 (Fidelity)')}
                                    value={[img.fidelity ?? 0.6]}
                                    onValueCommit={([v]) => onUpdate(img.id, { fidelity: v })}
                                />
                            )}
                            {/* Values kept from another model that this model would refuse at generation. */}
                            {preciseReferenceRules && img.strength > preciseReferenceRules.strengthMax && (
                                <p className="text-xs text-destructive">
                                    {t('characterDialog.strengthOverModelMax', {
                                        max: preciseReferenceRules.strengthMax,
                                        defaultValue: '이 모델의 강도는 최대 {{max}}이에요. 낮춰야 생성할 수 있어요.',
                                    })}
                                </p>
                            )}
                            {preciseReferenceRules && !preciseReferenceRules.outfit && referenceType === 'outfit' && (
                                <p className="text-xs text-destructive">
                                    {t('characterDialog.outfitNeedsV5', '의상 타입은 V5 Full과 V5 Curated에서만 쓸 수 있어요. 타입을 바꿔야 생성할 수 있어요.')}
                                </p>
                            )}
                        </div>
                    </div>
                )
            })}
        </div>
    )

    // Count only enabled images (enabled !== false or undefined which means enabled)
    const enabledCharCount = characterImages.filter(img => img.enabled !== false).length
    const enabledVibeCount = vibeImages.filter(img => img.enabled !== false).length
    const totalCount = enabledCharCount + enabledVibeCount
    const preciseReferenceSupported = capabilities?.preciseReference ?? false
    const vibeTransferSupported = capabilities?.vibeTransfer ?? false
    const vibeBlockedByCharacterReference = characterImages.some(img => img.enabled !== false)

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            {!hideTrigger && (
                <DialogTrigger asChild>
                    <Button variant="ghost" size={triggerLabel ? 'sm' : 'icon'} className={cn('group relative h-11 w-full min-w-0 rounded-none border-b-2 border-transparent hover:border-primary', triggerLabel ? 'gap-1.5 px-2 text-xs' : 'px-0')} aria-label={t('prompt.imageReference')} title={t('prompt.imageReference')}>
                        <ImageIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                        {triggerLabel ? <span className="truncate">{triggerLabel}</span> : <span className="sr-only">{t('prompt.imageReference')}</span>}
                        {totalCount > 0 && (
                            <div className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-control bg-destructive px-1 py-0.5 text-[11px] font-bold leading-none text-destructive-foreground">
                                {totalCount}
                            </div>
                        )}
                    </Button>
                </DialogTrigger>
            )}
            <DialogContent className="max-w-xl max-h-[85vh] flex flex-col overflow-hidden">
                <DialogHeader>
                    <DialogTitle>{t('characterDialog.title')}</DialogTitle>
                    <DialogDescription>{t('characterDialog.description')}</DialogDescription>
                </DialogHeader>

                <Tabs defaultValue="character" className="flex-1 flex flex-col min-h-0">
                    <TabsList className="grid grid-cols-2 w-full">
                        <TabsTrigger value="character">{t('characterDialog.tabCharacter')}</TabsTrigger>
                        <TabsTrigger value="vibe">{t('characterDialog.tabVibe')}</TabsTrigger>
                    </TabsList>

                    <TabsContent value="character" className="relative flex-1 overflow-y-auto min-h-0 pr-1">
                        {!preciseReferenceSupported && (
                            <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-background/90 p-6 text-center">
                                <Lock className="mb-2 h-8 w-8 text-muted-foreground" aria-hidden="true" />
                                <p className="text-sm font-medium text-foreground">
                                    {t('characterDialog.preciseUnsupported', '이 모델은 Precise Reference를 지원하지 않아요.')}
                                </p>
                                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                                    {t('characterDialog.preciseUnsupportedAlternative', '이 참조 이미지를 유지하고 V5 Full, V5 Curated 또는 V4.5로 바꿔 주세요.')}
                                </p>
                            </div>
                        )}
                        <div className={cn('py-2', !preciseReferenceSupported && 'pointer-events-none opacity-30 grayscale')}>
                            <div
                                data-local-file-drop
                                className={cn(
                                    "mb-4 cursor-pointer rounded-panel border-2 border-dashed p-4 text-center transition-colors",
                                    charDragOver
                                        ? "border-primary bg-primary/10"
                                        : "border-muted-foreground/25 hover:bg-muted/50"
                                )}
                                onClick={() => charInputRef.current?.click()}
                                onDragOver={handleDragOver}
                                onDragEnter={(e) => { e.preventDefault(); setCharDragOver(true) }}
                                onDragLeave={() => setCharDragOver(false)}
                                onDrop={(e) => handleDrop(e, 'character')}
                            >
                                <Upload className={cn("w-6 h-6 mx-auto mb-1", charDragOver ? "text-primary" : "text-muted-foreground")} />
                                <p className={cn("text-sm font-medium", charDragOver ? "text-primary" : "text-muted-foreground")}>
                                    {charDragOver ? t('characterDialog.dropHere', '여기에 놓기') : t('characterDialog.uploadCharacter')}
                                </p>
                            </div>
                            <input
                                type="file"
                                multiple
                                accept="image/*"
                                className="hidden"
                                ref={charInputRef}
                                onChange={(e) => handleFileUpload(e, 'character')}
                            />

                            <CharacterImageList
                                images={characterImages}
                                onRemove={removeCharacterImage}
                                onUpdate={updateCharacterImage}
                            />
                        </div>
                    </TabsContent>

                    <TabsContent value="vibe" className="flex-1 overflow-y-auto min-h-0 pr-1 relative">
                        {(!vibeTransferSupported || vibeBlockedByCharacterReference) && (
                            <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-background/90">
                                <Lock className="w-8 h-8 text-muted-foreground mb-2" />
                                <p className="text-sm font-medium text-muted-foreground text-center px-4">
                                    {!vibeTransferSupported
                                        ? t('characterDialog.v5VibePending', 'V5는 아직 Vibe Transfer를 지원하지 않아요. 이미지는 보존되며 V4.5에서 다시 사용할 수 있어요.')
                                        : t('characterDialog.vibeDisabledMsg')}
                                </p>
                            </div>
                        )}
                        <div className={!vibeTransferSupported || vibeBlockedByCharacterReference ? "pointer-events-none opacity-30 grayscale" : ""}>
                            <div className="py-2">
                                <div
                                    data-local-file-drop
                                    className={cn(
                                        "cursor-pointer rounded-panel border-2 border-dashed p-6 text-center transition-colors",
                                        vibeDragOver
                                            ? "border-primary bg-primary/10"
                                            : "border-muted-foreground/25 hover:bg-muted/50"
                                    )}
                                    onClick={() => vibeInputRef.current?.click()}
                                    onDragOver={handleDragOver}
                                    onDragEnter={(e) => { e.preventDefault(); setVibeDragOver(true) }}
                                    onDragLeave={() => setVibeDragOver(false)}
                                    onDrop={(e) => handleDrop(e, 'vibe')}
                                >
                                    <Upload className={cn("w-8 h-8 mx-auto mb-2", vibeDragOver ? "text-primary" : "text-muted-foreground")} />
                                    <p className={cn("text-sm font-medium", vibeDragOver ? "text-primary" : "text-muted-foreground")}>
                                        {vibeDragOver ? t('characterDialog.dropHere', '여기에 놓기') : t('characterDialog.uploadVibe')}
                                    </p>
                                </div>
                                <input
                                    type="file"
                                    multiple
                                    accept="image/*"
                                    className="hidden"
                                    ref={vibeInputRef}
                                    onChange={(e) => handleFileUpload(e, 'vibe')}
                                />
                                <VibeImageList
                                    images={vibeImages}
                                    onRemove={removeVibeImage}
                                    onUpdate={updateVibeImage}
                                />
                            </div>
                        </div>
                    </TabsContent>
                </Tabs>
            </DialogContent>
        </Dialog>
    )
}
