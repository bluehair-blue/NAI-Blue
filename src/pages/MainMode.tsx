import { useState, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ImageIcon, ImagePlus, Download, Copy, RotateCcw, Save, Users, FolderOpen, Paintbrush, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import Counter from '@/components/ui/counter'
import { useGenerationStore } from '@/stores/generation-store'
import { selectActiveCredentialsAreOpus, useAuthStore } from '@/stores/auth-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useCharacterStore } from '@/stores/character-store'
import { useCharacterPromptStore } from '@/stores/character-prompt-store'
import { useFragmentStore } from '@/stores/fragment-store'
import { usePresetStore } from '@/stores/preset-store'
import { MetadataDialog } from '@/components/metadata/MetadataDialog'
import { ImageReferenceDialog } from '@/components/metadata/ImageReferenceDialog'
import { parseMetadataFromBase64 } from '@/lib/metadata-parser'
import { generateImage } from '@/services/novelai-api'
import { createThumbnail } from '@/lib/image-utils'
import { getRuntimeOutputWriter } from '@/services/output/output-writer'
import {
    cancelMainGenerationCommand,
    startMainGenerationCommand,
} from '@/services/generation/generation-command'
import { toast } from '@/components/ui/use-toast'
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuTrigger,
    ContextMenuSeparator,
} from '@/components/ui/context-menu'
import { openNativePath } from '@/platform/native-shell'
import { saveNativeFileDialog } from '@/platform/native-file-dialog'
import { joinNativePath } from '@/platform/native-path'
import {
    createNativeDirectory,
    nativePathExists,
    writeNativeBinaryFile,
} from '@/platform/native-file-system'
import {
    getMediaStorageRoot,
    shouldUseAbsoluteMediaPath,
} from '@/platform/storage'
import { useNavigate } from 'react-router'
import { useToolsStore } from '@/stores/tools-store'
import { Wand2 } from 'lucide-react'
import { InpaintingDialog } from '@/components/tools/InpaintingDialog'
import { useLayoutStore } from '@/stores/layout-store'
import { usePromptSurface } from '@/components/layout/prompt-surface'
import { publishGeneratedArtifact } from '@/stores/artifact-lifecycle-store'
import { useAssetModuleStore } from '@/stores/asset-module-store'
import { calculateAnlasCost, resolveAnlasPricingBasis } from '@/lib/anlas-calculator'
import { getRuntimeCompositionDocument } from '@/lib/composition-authority'
import {
    MAIN_ASSET_SELECTION_PREFIX,
    MAIN_DIRECT_RECIPE_ID,
    MAIN_DIRECT_SELECTION_ID,
    getMainDirectRecipeId,
    mainAssetRecipeSelectionId,
} from '@/lib/composition/main-adapter'
import type {
    CompositionValidationSummary,
    ModuleStackItem,
    ReadonlyCompositionIssue,
} from '@/components/composition-workspace/types'
import {
    CompositionCommandBar,
    CompositionInspector,
    CompositionWorkspaceLayout,
    CompositionWorkspaceSheet,
    MobileCommandDock,
    ModuleStack,
    portableIssuesForResolvedPlan,
    ResolvedPlanView,
} from '@/components/composition-workspace'
import { RecipeSelector } from '@/components/composition/RecipeSelector'
import { runtimeCapabilities } from '@/platform/capabilities'
import { assessPortableCompositionPlan } from '@/platform/portable-resources'
import { NAI_IMAGE_MODELS, normalizeNaiImageModelId } from '@/services/nai/model-catalog'
import {
    buildMainCompositionProjection,
    buildMainFragmentInput,
    mainPreflightBlocksGeneration,
    preflightMainGeneration,
    type MainGenerationPreflight,
} from '@/services/generation/main-generation-preflight'
import { DEFAULT_GENERATION_FOLDER_ID } from '@/domain/generation-folders'
import { resolveGenerationFolderAuthority } from '@/lib/generation-folder-authority-runtime'
import { useShallow } from 'zustand/react/shallow'

function useMediaQuery(query: string): boolean {
    const [matches, setMatches] = useState(() => window.matchMedia(query).matches)

    useEffect(() => {
        const mediaQuery = window.matchMedia(query)
        const handleChange = () => setMatches(mediaQuery.matches)
        handleChange()
        mediaQuery.addEventListener('change', handleChange)
        return () => mediaQuery.removeEventListener('change', handleChange)
    }, [query])

    return matches
}

function rawRecipeId(selectionId: string | null, directRecipeId: string): string | null {
    if (selectionId === null) return null
    if (selectionId === MAIN_DIRECT_SELECTION_ID
        || selectionId === MAIN_DIRECT_RECIPE_ID
        || selectionId === directRecipeId) return directRecipeId
    if (!selectionId.startsWith(MAIN_ASSET_SELECTION_PREFIX)) return selectionId

    const encoded = selectionId.slice(MAIN_ASSET_SELECTION_PREFIX.length)
    try {
        return decodeURIComponent(encoded)
    } catch {
        return encoded
    }
}

export default function MainMode() {
    const { t } = useTranslation()
    const generationState = useGenerationStore(useShallow(state => ({
        previewImage: state.previewImage,
        isGenerating: state.isGenerating,
        selectedResolution: state.selectedResolution,
        lastGenerationTime: state.lastGenerationTime,
        batchCount: state.batchCount,
        currentBatch: state.currentBatch,
        streamProgress: state.streamProgress,
        model: state.model,
        steps: state.steps,
        basePrompt: state.basePrompt,
        additionalPrompt: state.additionalPrompt,
        detailPrompt: state.detailPrompt,
        negativePrompt: state.negativePrompt,
        inpaintingPrompt: state.inpaintingPrompt,
        cfgScale: state.cfgScale,
        cfgRescale: state.cfgRescale,
        sampler: state.sampler,
        scheduler: state.scheduler,
        smea: state.smea,
        smeaDyn: state.smeaDyn,
        variety: state.variety,
        seed: state.seed,
        qualityToggle: state.qualityToggle,
        ucPreset: state.ucPreset,
        transparentBackground: state.transparentBackground,
        sourceImage: state.sourceImage,
        mask: state.mask,
        strength: state.strength,
        noise: state.noise,
        isCancelled: state.isCancelled,
        generatingMode: state.generatingMode,
        compositionMode: state.compositionMode,
        selectedRecipeId: state.selectedRecipeId,
        setBatchCount: state.setBatchCount,
        setSelectedRecipeId: state.setSelectedRecipeId,
        setSourceImage: state.setSourceImage,
        setI2IMode: state.setI2IMode,
    })))
    const {
        previewImage,
        isGenerating,
        selectedResolution,

        lastGenerationTime,
        batchCount,
        currentBatch,
        streamProgress,
        model,
        steps,
        basePrompt,
        additionalPrompt,
        detailPrompt,
        negativePrompt,
        inpaintingPrompt,
        cfgScale,
        cfgRescale,
        sampler,
        scheduler,
        smea,
        smeaDyn,
        variety,
        seed,
        qualityToggle,
        ucPreset,
        transparentBackground,
        sourceImage,
        mask,
        strength,
        noise,
        isCancelled,
        generatingMode,
        compositionMode,
        selectedRecipeId,
        setBatchCount,
        setSelectedRecipeId,
        setSourceImage,
        setI2IMode,
    } = generationState

    const navigate = useNavigate()
    const setActiveImage = useToolsStore(state => state.setActiveImage)
    const assetProfile = useAssetModuleStore(state => state.profile)
    const profileLoading = useAssetModuleStore(state => state.isLoading)
    const profileConflict = useAssetModuleStore(state => state.hasConflict)
    const profileConflictMessage = useAssetModuleStore(state => state.conflictMessage)
    const settings = useSettingsStore(useShallow(state => ({
        autoSave: state.autoSave,
        savePath: state.savePath,
        useAbsolutePath: state.useAbsolutePath,
        imageFormat: state.imageFormat,
        metadataMode: state.metadataMode,
        useStreaming: state.useStreaming,
        generationFolders: state.generationFolders,
        generationFolderDocument: state.generationFolderDocument,
        activeGenerationFolderId: state.activeGenerationFolderId,
    })))
    const characterPromptState = useCharacterPromptStore(useShallow(state => ({
        characters: state.characters,
        presets: state.presets,
        groups: state.groups,
        positionEnabled: state.positionEnabled,
    })))
    const referenceState = useCharacterStore(useShallow(state => ({
        characterImages: state.characterImages,
        vibeImages: state.vibeImages,
    })))
    const paramsPresetState = usePresetStore(useShallow(state => ({
        presets: state.presets,
        activePresetId: state.activePresetId,
    })))
    const fragmentRevision = useFragmentStore(state => state.sequenceState.revision)
    const activeCredentialsAreOpus = useAuthStore(selectActiveCredentialsAreOpus)
    const isMobileWorkspace = useMediaQuery('(max-width: 767px)')
    const [moduleSheetOpen, setModuleSheetOpen] = useState(false)
    const [inspectorSheetOpen, setInspectorSheetOpen] = useState(false)
    const [resolvedSheetOpen, setResolvedSheetOpen] = useState(false)
    const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null)
    const [preflight, setPreflight] = useState<MainGenerationPreflight | null>(null)
    const moduleSheetTriggerRef = useRef<HTMLElement | null>(null)
    const inspectorSheetTriggerRef = useRef<HTMLElement | null>(null)
    const resolvedSheetTriggerRef = useRef<HTMLElement | null>(null)

    const [metadataDialogOpen, setMetadataDialogOpen] = useState(false)
    const [metadataImage, setMetadataImage] = useState<string | undefined>(undefined)
    const [imageRefDialogOpen, setImageRefDialogOpen] = useState(false)
    // Inpainting dialog state
    const [inpaintDialogOpen, setInpaintDialogOpen] = useState(false)

    const directRecipeId = getMainDirectRecipeId(assetProfile.recipes)
    const firstEnabledRecipe = assetProfile.recipes.find(recipe => recipe.enabled)
    const automaticRecipeSelection = firstEnabledRecipe === undefined
        ? MAIN_DIRECT_SELECTION_ID
        : mainAssetRecipeSelectionId(firstEnabledRecipe.id)
    const displayedRecipeSelection = selectedRecipeId === null
        ? automaticRecipeSelection
        : selectedRecipeId === MAIN_DIRECT_SELECTION_ID
            || selectedRecipeId === MAIN_DIRECT_RECIPE_ID
            || selectedRecipeId === directRecipeId
            ? MAIN_DIRECT_SELECTION_ID
            : selectedRecipeId.startsWith(MAIN_ASSET_SELECTION_PREFIX)
                ? selectedRecipeId
                : mainAssetRecipeSelectionId(selectedRecipeId)
    const effectiveRecipeId = rawRecipeId(displayedRecipeSelection, directRecipeId)
    const runtimeDocument = getRuntimeCompositionDocument()
    const canonicalRecipe = runtimeDocument?.recipes.find(recipe => recipe.id === effectiveRecipeId)
    const legacyRecipe = assetProfile.recipes.find(recipe => recipe.id === effectiveRecipeId)
    const selectedRecipeName = canonicalRecipe?.name
        ?? legacyRecipe?.label
        ?? (effectiveRecipeId === directRecipeId
            ? t('composition.recipe.direct', 'Direct prompts')
            : effectiveRecipeId ?? t('composition.recipe.noneSelected', 'Select a recipe'))

    const activeGenerationFolder = useMemo(() => resolveGenerationFolderAuthority(
        settings.generationFolderDocument,
        settings.generationFolders,
        settings.activeGenerationFolderId,
        {
            directory: settings.savePath,
            useAbsolutePath: settings.useAbsolutePath,
        },
    ), [
        settings.activeGenerationFolderId,
        settings.generationFolderDocument,
        settings.generationFolders,
        settings.savePath,
        settings.useAbsolutePath,
    ])
    const effectiveBasePrompt = [activeGenerationFolder?.commonPrompt.trim(), basePrompt]
        .filter(Boolean)
        .join(', ')

    useEffect(() => {
        let current = true
        setPreflight(null)
        if (compositionMode === 'legacy') return () => { current = false }

        const resolvePreflight = async () => {
            const width = Math.round(selectedResolution.width / 64) * 64
            const height = Math.round(selectedResolution.height / 64) * 64
            const projection = buildMainCompositionProjection({
                generation: generationState,
                effectiveBasePrompt,
                profile: assetProfile,
                characters: characterPromptState.characters,
                characterPresets: characterPromptState.presets,
                characterGroups: characterPromptState.groups,
                positionEnabled: characterPromptState.positionEnabled,
                characterImages: referenceState.characterImages,
                vibeImages: referenceState.vibeImages,
                paramsPresets: paramsPresetState.presets,
                activeParamsPresetId: paramsPresetState.activePresetId,
                output: settings,
                portableRoot: runtimeCapabilities.absoluteOutputPath.supported ? 'pictures' : 'app-data',
                paramsWidth: width,
                paramsHeight: height,
                sourceWidth: width,
                sourceHeight: height,
                seed: seed || 1,
            })
            const fragment = await buildMainFragmentInput('preview', projection.fragmentSourceTexts)
            if (!current) return

            const pricingBasis = resolveAnlasPricingBasis({ model, activeCredentialsAreOpus })
            const next = preflightMainGeneration({
                snapshot: projection.snapshot,
                requestId: 'main-preflight',
                now: new Date().toISOString(),
                seed: seed || 1,
                fragment,
            }, { batchCount, pricingBasis, streaming: settings.useStreaming })
            if (current) setPreflight(next)
        }

        void resolvePreflight().catch(() => {
            if (current) setPreflight(null)
        })
        return () => { current = false }
    }, [
        activeCredentialsAreOpus,
        additionalPrompt,
        assetProfile,
        basePrompt,
        batchCount,
        cfgRescale,
        cfgScale,
        characterPromptState.characters,
        characterPromptState.groups,
        characterPromptState.positionEnabled,
        characterPromptState.presets,
        compositionMode,
        detailPrompt,
        effectiveBasePrompt,
        fragmentRevision,
        inpaintingPrompt,
        mask,
        model,
        negativePrompt,
        noise,
        paramsPresetState.activePresetId,
        paramsPresetState.presets,
        qualityToggle,
        referenceState.characterImages,
        referenceState.vibeImages,
        sampler,
        scheduler,
        seed,
        selectedRecipeId,
        selectedResolution.height,
        selectedResolution.width,
        settings.autoSave,
        settings.imageFormat,
        settings.metadataMode,
        settings.savePath,
        settings.useStreaming,
        settings.useAbsolutePath,
        smea,
        smeaDyn,
        sourceImage,
        steps,
        strength,
        transparentBackground,
        ucPreset,
        variety,
    ])

    const resolvedPlan = preflight?.diagnostics.plan ?? null
    const compatibilityIssue: ReadonlyCompositionIssue | null = preflight === null
        ? null
        : preflight.providerCompatibility.status === 'synthetic-only'
            ? {
                code: 'W_NAI_COMPATIBILITY_SYNTHETIC_ONLY',
                severity: 'warning',
                messageKey: 'composition.issue.payloadParityUnverifiedModel',
                fieldPath: ['providerCompatibility'],
                blocking: false,
            }
            : preflight.providerCompatibility.status === 'known-divergence'
                || preflight.providerCompatibility.status === 'unsupported'
                ? {
                    code: 'E_NAI_COMPATIBILITY_UNSUPPORTED',
                    severity: 'error',
                    messageKey: 'composition.issue.payloadParityUnverifiedModel',
                    fieldPath: ['providerCompatibility'],
                    blocking: true,
                }
                : null
    const resolvedWarnings: readonly ReadonlyCompositionIssue[] = [
        ...(preflight?.diagnostics.warnings ?? []),
        ...(compatibilityIssue?.severity === 'warning' ? [compatibilityIssue] : []),
    ]
    const resolvedErrors: readonly ReadonlyCompositionIssue[] = [
        ...(preflight?.diagnostics.errors ?? []),
        ...(compatibilityIssue?.severity === 'error' ? [compatibilityIssue] : []),
    ]

    const portableResolvedIssues = useMemo(() => resolvedPlan === null
        ? []
        : portableIssuesForResolvedPlan(
            assessPortableCompositionPlan(resolvedPlan, runtimeCapabilities).issues,
        ), [resolvedPlan])

    const validation = useMemo<CompositionValidationSummary>(() => {
        if (profileConflict) {
            return {
                severity: 'conflict',
                warningCount: resolvedWarnings.length,
                errorCount: resolvedErrors.length,
                label: t('composition.validation.conflict', '다른 창에서 변경됨'),
            }
        }
        if (profileLoading) {
            return { severity: 'loading', label: t('common.loading', 'Loading...') }
        }
        if (compositionMode === 'legacy') {
            return { severity: 'disabled', label: t('composition.validation.legacy', 'Legacy') }
        }
        if (resolvedErrors.length + portableResolvedIssues.length > 0) {
            return {
                severity: 'error',
                errorCount: resolvedErrors.length + portableResolvedIssues.length,
                warningCount: resolvedWarnings.length,
            }
        }
        if (resolvedWarnings.length > 0) {
            return { severity: 'warning', warningCount: resolvedWarnings.length }
        }
        return resolvedPlan === null
            ? { severity: 'loading', label: t('composition.plan.loading', 'Resolving…') }
            : { severity: 'valid' }
    }, [
        compositionMode,
        portableResolvedIssues.length,
        profileConflict,
        profileLoading,
        resolvedErrors.length,
        resolvedPlan,
        resolvedWarnings.length,
        t,
    ])

    const moduleStackItems = useMemo<ModuleStackItem[]>(() => {
        const allIssues = [...resolvedErrors, ...resolvedWarnings]
        const canonicalById = new Map(runtimeDocument?.modules.map(module => [module.id, module]) ?? [])
        const recipeModuleIds = canonicalRecipe?.steps.map(step => step.moduleId)
            ?? legacyRecipe?.steps.map(step => step.moduleId)
            ?? []
        const fallbackIds = runtimeDocument?.profiles.find(profile => profile.id === runtimeDocument.activeProfileId)?.moduleIds
            ?? Object.keys(assetProfile.modules)
        const moduleIds = recipeModuleIds.length > 0 ? recipeModuleIds : fallbackIds

        return [...new Set(moduleIds)].map((moduleId, order) => {
            const canonical = canonicalById.get(moduleId)
            const legacy = assetProfile.modules[moduleId]
            const issues = allIssues.filter(issue => issue.entityRef?.kind === 'module' && issue.entityRef.id === moduleId)
            const errorCount = issues.filter(issue => issue.severity === 'error').length
            const warningCount = issues.length - errorCount
            const itemValidation: CompositionValidationSummary = errorCount > 0
                ? { severity: 'error', errorCount, warningCount }
                : warningCount > 0
                    ? { severity: 'warning', warningCount }
                    : { severity: 'valid' }

            if (canonical !== undefined) {
                return {
                    id: canonical.id,
                    name: canonical.name,
                    kind: canonical.kind,
                    enabled: canonical.enabled,
                    order,
                    validation: itemValidation,
                    summary: t('composition.module.summary', '{{count}} prompt parts', {
                        count: canonical.contributions.length,
                    }),
                }
            }

            return {
                id: moduleId,
                name: legacy?.label?.trim() || moduleId,
                kind: legacy?.kind ?? 'composite',
                enabled: legacy?.enabled ?? false,
                order,
                validation: legacy === undefined
                    ? { severity: 'error', errorCount: 1, label: t('composition.module.missing', 'Missing reference') }
                    : itemValidation,
                summary: legacy === undefined
                    ? t('composition.module.repairRequired', 'Repair required')
                    : legacy.target || t('composition.module.compatibility', 'Compatibility module'),
                missing: legacy === undefined,
            }
        })
    }, [
        assetProfile.modules,
        canonicalRecipe,
        legacyRecipe,
        resolvedErrors,
        resolvedWarnings,
        runtimeDocument,
        t,
    ])

    const selectedModule = moduleStackItems.find(module => module.id === selectedModuleId) ?? null
    const blockingResolutionError = resolvedErrors.length + portableResolvedIssues.length > 0
    const preflightAuthoritative = compositionMode === 'v2'
    const ownsActiveGeneration = isGenerating && generatingMode === 'main'
    const generationDisabled = (isGenerating && generatingMode !== 'main')
        || (isGenerating && isCancelled)
        || (!ownsActiveGeneration && mainPreflightBlocksGeneration(compositionMode, {
            profileConflict,
            profileLoading,
            preflightReady: preflight !== null,
            resolutionError: blockingResolutionError,
        }))
    const draftPricingBasis = resolveAnlasPricingBasis({ model, activeCredentialsAreOpus })
    const estimatedCost = preflightAuthoritative
        ? preflight?.estimatedCost ?? null
        : displayedRecipeSelection === MAIN_DIRECT_SELECTION_ID
            ? calculateAnlasCost({
                model,
                width: selectedResolution.width,
                height: selectedResolution.height,
                steps,
                imageCount: 1,
                pricingBasis: draftPricingBasis,
            }) * batchCount
            : null
    const hasRecipeControls = assetProfile.recipes.length > 0
        || displayedRecipeSelection !== MAIN_DIRECT_SELECTION_ID
    const hasModuleTools = moduleStackItems.length > 0
    const hasModuleSheetContent = hasRecipeControls || hasModuleTools
    const resolvedErrorCount = resolvedErrors.length + portableResolvedIssues.length
    const resolvedWarningCount = resolvedWarnings.length
    const hasResolvedContent = resolvedPlan !== null
        || resolvedErrorCount > 0
        || resolvedWarningCount > 0
        || profileConflict
    const resolvedControlLabel = profileConflict
        ? t('composition.validation.conflict', 'External edit conflict')
        : resolvedErrorCount > 0
            ? `${t('assetModuleStudioV2.filters.errors', 'Errors')} (${resolvedErrorCount})`
            : resolvedWarningCount > 0
                ? `${t('assetModuleStudioV2.filters.warnings', 'Warnings')} (${resolvedWarningCount})`
                : t('composition.plan.resolved', 'Resolved')

    // Regenerate with metadata - direct API call without modifying UI
    const handleRegenerateWithMetadata = async () => {
        if (!previewImage || isGenerating) return
        const genStore = useGenerationStore.getState()

        const token = useAuthStore.getState().token
        if (!token) {
            useAuthStore.getState().requestTokenEntry()
            toast({
                title: t('toast.tokenRequired.title', '토큰 필요'),
                variant: 'destructive',
            })
            return
        }

        try {
            // Parse metadata from current image
            const metadata = await parseMetadataFromBase64(previewImage)
            if (!metadata) {
                toast({
                    title: t('toast.noMetadata', '메타데이터 없음'),
                    description: t('toast.noMetadataDesc', '이 이미지에서 메타데이터를 찾을 수 없습니다'),
                    variant: 'destructive',
                })
                return
            }

            // Set generating state
            genStore.setIsGenerating(true)

            // Generate random seed
            const newSeed = Math.floor(Math.random() * 4294967295)

            // Call API directly with metadata (without modifying UI store)
            // Use all settings from metadata, only randomize seed
            const regenerateParams = {
                prompt: metadata.prompt || '',
                negative_prompt: metadata.negativePrompt || '',
                model: normalizeNaiImageModelId(metadata.model) ?? genStore.model,
                width: metadata.width ?? 832,
                height: metadata.height ?? 1216,
                steps: metadata.steps ?? 28,
                cfg_scale: metadata.cfgScale ?? 5,
                cfg_rescale: metadata.cfgRescale ?? 0,
                sampler: metadata.sampler ?? 'k_euler',
                scheduler: metadata.scheduler ?? 'native',
                smea: metadata.smea ?? true,
                smea_dyn: metadata.smeaDyn ?? false,
                variety: metadata.variety ?? false,
                qualityToggle: metadata.qualityToggle ?? false,
                ucPreset: metadata.ucPreset ?? 0,
                transparentBackground: metadata.transparentBackground ?? false,
                seed: newSeed,
                imageFormat: useSettingsStore.getState().imageFormat,
                metadataMode: useSettingsStore.getState().metadataMode,
            } as const
            const result = await generateImage(token, regenerateParams)

            if (result.success && result.imageData) {
                // Update preview with new image
                const { imageFormat } = useSettingsStore.getState()
                const mimeType = imageFormat === 'webp' ? 'image/webp' : 'image/png'
                const fileExt = imageFormat === 'webp' ? 'webp' : 'png'
                genStore.setPreviewImage(`data:${mimeType};base64,${result.imageData}`)

                // Save to disk if autoSave is enabled
                const { savePath, autoSave, useAbsolutePath } = useSettingsStore.getState()
                if (autoSave) {
                    try {
                        const binaryString = atob(result.imageData)
                        const bytes = new Uint8Array(binaryString.length)
                        for (let j = 0; j < binaryString.length; j++) {
                            bytes[j] = binaryString.charCodeAt(j)
                        }

                        const fileName = `NAI_Blue_${Date.now()}.${fileExt}`
                        const outputDir = savePath || 'NAI_Blue_Output'
                        const imageDataUrl = `data:${mimeType};base64,${result.imageData}`
                        const canCommit = (): boolean => {
                            const state = useGenerationStore.getState()
                            return state.isGenerating && state.generatingMode === 'main' && !state.isCancelled
                        }
                        await getRuntimeOutputWriter().write({
                            destination: {
                                directory: outputDir,
                                useAbsolutePath,
                                capabilityFallbackDirectory: 'NAI_Blue_Output',
                                workflowDefaultDirectory: 'NAI_Blue_Output',
                                fileName,
                                extension: fileExt,
                                collisionPolicy: 'unique',
                            },
                            imageBytes: bytes,
                            imageDataUrl,
                            metadata: {
                                params: { ...regenerateParams, sentPayloadSummary: result.sentPayloadSummary },
                                imageFormat,
                                metadataMode: useSettingsStore.getState().metadataMode,
                                includeWebpCompatibilitySidecar: true,
                            },
                            generateThumbnail: createThumbnail,
                            canCommit,
                            commitWorkflow: output => {
                                if (!canCommit()) throw new Error('Main metadata regeneration session changed')
                                publishGeneratedArtifact({ path: output.path })
                            },
                        })
                    } catch (e) {
                        console.warn('Failed to save regenerated image:', e)
                    }
                }

                toast({
                    title: t('toast.regenerated', '재생성 완료'),
                    variant: 'success',
                })
            } else {
                toast({
                    title: t('toast.generateFailed', '생성 실패'),
                    description: result.error,
                    variant: 'destructive',
                })
            }
        } catch (e) {
            console.error('Regenerate failed:', e)
        } finally {
            genStore.setIsGenerating(false)
        }
    }



    const handleCopy = async () => {
        if (!previewImage) return
        try {
            const response = await fetch(previewImage)
            const blob = await response.blob()
            await navigator.clipboard.write([
                new ClipboardItem({ [blob.type]: blob })
            ])
        } catch (e) {
            console.error('Copy failed', e)
        }
    }

    // Save As with native Windows dialog
    const handleSaveAs = async () => {
        if (!previewImage) return
        try {
            const { imageFormat } = useSettingsStore.getState()
            const fileExt = imageFormat === 'webp' ? 'webp' : 'png'
            const filterName = imageFormat === 'webp' ? 'WebP Image' : 'PNG Image'
            const filePath = await saveNativeFileDialog({
                defaultPath: `NAI_Blue_${Date.now()}.${fileExt}`,
                filters: [{ name: filterName, extensions: [fileExt] }],
            })

            if (filePath) {
                const base64Data = previewImage.split(',')[1]
                const binaryString = atob(base64Data)
                const bytes = new Uint8Array(binaryString.length)
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i)
                }

                await writeNativeBinaryFile(filePath, bytes)
                toast({
                    title: t('toast.saved', '저장 완료'),
                    variant: 'success',
                })
            }
        } catch (e) {
            console.error('Save failed:', e)
            toast({
                title: t('toast.saveFailed', '저장 실패'),
                variant: 'destructive',
            })
        }
    }

    // Open folder containing saved images
    const handleOpenFolder = async () => {
        try {
            const { savePath, useAbsolutePath } = useSettingsStore.getState()
            const finalSavePath = savePath || 'NAI_Blue_Output'

            let folderPath: string
            if (shouldUseAbsoluteMediaPath(useAbsolutePath)) {
                folderPath = finalSavePath
            } else {
                folderPath = await joinNativePath(await getMediaStorageRoot(), finalSavePath)
            }

            const dirExists = await nativePathExists(folderPath)
            if (!dirExists) {
                await createNativeDirectory(folderPath, { recursive: true })
            }

            await openNativePath(folderPath)
        } catch (e) {
            console.error('Failed to open folder:', e)
        }
    }

    const handleOpenSmartTools = () => {
        if (previewImage) {
            setActiveImage(previewImage)
            navigate('/tools')
        }
    }

    // Inpainting: Open dialog directly (source/mode set when mask is saved)
    const handleInpaint = () => {
        if (!previewImage) return
        setInpaintDialogOpen(true)
    }

    // I2I: Set source and stay on page (already in main mode)
    const handleI2I = () => {
        if (!previewImage) return
        setSourceImage(previewImage)
        setI2IMode('i2i')
    }

    // Image Reference popup
    const handleAddAsReference = () => {
        if (previewImage) {
            setImageRefDialogOpen(true)
        }
    }

    // Metadata loading from current preview
    const handleLoadMetadata = () => {
        if (previewImage) {
            setMetadataImage(previewImage)
            setMetadataDialogOpen(true)
        }
    }

    const requestPromptFocus = useLayoutStore(state => state.requestPromptFocus)
    const promptSurface = usePromptSurface()
    // layout-store + prompt-surface are the single authority shared by shell and compact command dock.
    const handleOpenPromptSheet = () => promptSurface.ensureVisible()
    const handleOpenSummaryFocus = () => {
        promptSurface.ensureVisible()
        requestPromptFocus('model')
    }

    const handlePrimaryGeneration = () => {
        if (isGenerating && generatingMode === 'main') {
            void cancelMainGenerationCommand()
            return
        }
        if (!isGenerating) {
            void startMainGenerationCommand()
                .then(outcome => {
                    if (outcome !== 'low-quality-steps') return
                    promptSurface.ensureVisible()
                    requestPromptFocus('steps')
                    toast({
                        title: t('generate.lowStepsBlockedTitle', 'Steps를 먼저 확인하세요'),
                        description: t('generate.lowStepsDescription', '{{steps}} steps는 완성 전에 종료되어 흐린 결과가 나올 수 있습니다. 일반 생성은 28 steps를 권장합니다.', { steps }),
                        variant: 'destructive',
                    })
                })
                .catch(error => toast({
                    title: t('common.error', 'Error'),
                    description: error instanceof Error ? error.message : t('queue.enqueueFailed', 'Queue enqueue failed'),
                    variant: 'destructive',
                }))
        }
    }

    const handleRecipeSelection = (recipeId: string) => {
        setSelectedRecipeId(recipeId)
        setSelectedModuleId(null)
    }

    const currentTrigger = (): HTMLElement | null => document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null

    const handleOpenModuleStack = () => {
        moduleSheetTriggerRef.current = currentTrigger()
        setModuleSheetOpen(true)
    }

    const handleOpenPromptFromSettings = () => {
        setModuleSheetOpen(false)
        // Let the settings sheet restore focus before the shell opens its Prompt sheet.
        requestAnimationFrame(handleOpenPromptSheet)
    }

    const handleSelectModule = (moduleId: string) => {
        setSelectedModuleId(moduleId)
        // The Main workspace keeps its desktop rails disabled, so a module chosen
        // from its sheet must hand off to the Inspector sheet at every viewport.
        if (moduleSheetOpen) {
            inspectorSheetTriggerRef.current = currentTrigger()
            setInspectorSheetOpen(true)
        }
    }

    const handleOpenResolvedPlan = () => {
        resolvedSheetTriggerRef.current = currentTrigger()
        setResolvedSheetOpen(true)
    }

    const repairSurface = (issue: ReadonlyCompositionIssue): 'modules' | 'prompt' | 'storage' | null => {
        switch (issue.actionId) {
            case 'select-recipe':
            case 'repair-module-reference':
            case 'enable-module':
            case 'review-extension':
                return 'modules'
            case 'repair-reference':
            case 'adjust-parameter':
            case 'choose-character-position-mode':
            case 'restore-fragment':
            case 'break-fragment-cycle':
            case 'review-fragment-lookup':
            case 'select-verified-model':
            case 'clamp-character-position':
                return 'prompt'
            case 'review-output-path':
                return 'storage'
            default:
                return null
        }
    }
    const canRepairIssue = (issue: ReadonlyCompositionIssue) => repairSurface(issue) !== null
    const handleRepairIssue = (issue: ReadonlyCompositionIssue) => {
        const surface = repairSurface(issue)
        if (surface === null) return
        setResolvedSheetOpen(false)
        // Match the existing sheet handoff: restore focus before opening the repair surface.
        requestAnimationFrame(() => {
            if (surface === 'modules') handleOpenModuleStack()
            else if (surface === 'prompt') handleOpenPromptSheet()
            else navigate('/settings?section=storage')
        })
    }

    // Memory cleanup on unmount - release large Base64 data when leaving main mode
    // This prevents OOM when switching between modes (Issue #6)
    useEffect(() => {
        return () => {
            console.log('[MainMode] Unmounting - clearing runtime data')
            useGenerationStore.getState().clearRuntimeData()
        }
    }, [])

    // Timer Logic
    const [elapsedTime, setElapsedTime] = useState(0)

    useEffect(() => {
        let interval: any
        if (isGenerating) {
            const start = Date.now()
            setElapsedTime(0)
            interval = setInterval(() => {
                setElapsedTime(Date.now() - start)
            }, 100)
        } else {
            setElapsedTime(0)
        }
        return () => clearInterval(interval)
    }, [isGenerating])

    // Format time (s.ms)
    const formatTime = (ms: number) => (ms / 1000).toFixed(1)

    const reviewingBlockedPlan = !isGenerating
        && preflightAuthoritative
        && !profileLoading
        && (profileConflict || blockingResolutionError)
    const generationControl = {
        generating: isGenerating && generatingMode === 'main',
        disabled: generationDisabled && !reviewingBlockedPlan,
        progressLabel: isGenerating && generatingMode === 'main' && batchCount > 1
            ? `${t('generate.cancel', '취소')} (${currentBatch}/${batchCount})`
            : undefined,
        generateLabel: reviewingBlockedPlan
            ? profileConflict
                ? t('composition.conflict.reviewAction', '변경사항 확인')
                : t('composition.plan.reviewIssues', '문제 확인')
            : t('generate.button', '생성'),
        cancelLabel: t('generate.cancel', '취소'),
        onGenerate: reviewingBlockedPlan ? handleOpenResolvedPlan : handlePrimaryGeneration,
        onCancel: () => void cancelMainGenerationCommand(),
        actionTestId: 'main-generate-action',
        cancelTestId: 'main-generate-action',
    }
    const resolvedParams = preflightAuthoritative ? resolvedPlan?.params : undefined
    const resolvedModel = resolvedParams?.model ?? model
    const currentModelName = NAI_IMAGE_MODELS.find(candidate => candidate.id === resolvedModel)?.name ?? resolvedModel
    const resolvedOutput = preflightAuthoritative ? preflight?.resolution.output ?? null : null
    const outputDirectory = activeGenerationFolder?.id !== DEFAULT_GENERATION_FOLDER_ID
        ? activeGenerationFolder?.directory
        : resolvedOutput?.directory ?? settings.savePath
    const outputFormat = (resolvedOutput?.format ?? settings.imageFormat).toUpperCase()
    const generationFolderPath = activeGenerationFolder?.path
        ?? outputDirectory
        ?? t('composition.plan.previewOnly', 'Preview only')
    const r2Status = activeGenerationFolder?.r2.autoUpload
        ? t('composition.plan.r2Configured', 'R2 upload configured')
        : t('composition.plan.uploadOff', 'R2 auto-upload off')
    const generationSummary = `${currentModelName} · ${resolvedParams?.width ?? selectedResolution.width}×${resolvedParams?.height ?? selectedResolution.height} · ${resolvedParams?.steps ?? steps} ${t('parameters.steps', 'Steps')}`
    const batchCounter = (
        <Counter
            value={batchCount}
            onChange={setBatchCount}
            min={1}
            max={9999}
            fontSize={16}
            className="shrink-0"
        />
    )
    const mobileCountButton = (
        <Button
            type="button"
            variant="ghost"
            className="min-w-11 px-2 tabular-nums"
            aria-label={t('generate.editCount', 'Edit image count, current count {{count}}', { count: batchCount })}
            data-testid="main-mobile-count"
            onClick={handleOpenModuleStack}
        >
            {t('generate.countShort', '{{count}} images', { count: batchCount })}
        </Button>
    )
    const workspaceLabels = {
        modules: t('composition.workspace.modules', '프롬프트 묶음'),
        inspector: t('composition.workspace.inspector', '적용 내용'),
        resolvedPlan: t('composition.plan.title', '실제 생성에 쓰일 값'),
        edit: t('common.edit', 'Edit'),
        enable: t('common.enable', 'Enable'),
        disable: t('common.disable', 'Disable'),
        moveUp: t('common.moveUp', 'Move up'),
        moveDown: t('common.moveDown', 'Move down'),
        empty: t('composition.module.noneSelected', 'No module selected'),
    }
    const moduleStack = (
        <ModuleStack
            modules={moduleStackItems}
            activeModuleId={selectedModuleId}
            title={t('composition.workspace.moduleStack', '적용 순서')}
            disabled={isGenerating}
            height="100%"
            emptyLabel={t('composition.module.emptyRecipe', 'This recipe has no modules.')}
            searchLabel={t('composition.module.search', 'Search modules')}
            labels={workspaceLabels}
            onSelectModule={handleSelectModule}
            showHeader={false}
        />
    )
    const inspector = (
        <CompositionInspector
            module={selectedModule}
            recipeName={selectedRecipeName}
            validation={validation}
            resolvedPlan={resolvedPlan}
            conflict={profileConflict ? {
                severity: 'error',
                title: t('composition.conflict.externalEdit', '다른 창에서 변경됨'),
                message: profileConflictMessage || t('composition.conflict.review', '다른 창의 변경사항과 겹쳤어요. 생성 전에 내용을 확인해 주세요.'),
                revision: String(assetProfile.revision),
            } : null}
            disabled={isGenerating}
            showHeader={false}
            labels={{
                title: t('composition.workspace.inspector', '적용 내용'),
                noSelection: t('composition.module.selectToInspect', '확인할 프롬프트 묶음을 선택하세요.'),
                recipe: t('composition.recipe.title', '생성 구성'),
                kind: t('composition.module.kind', '종류'),
                moduleId: t('composition.module.id', '내부 ID'),
                technical: t('composition.plan.technical', '기술 정보'),
                overrideDiff: t('composition.override.diff', '기본값에서 바뀐 항목'),
                inherited: t('composition.override.inherited', '기본값'),
                override: t('composition.override.value', '여기서 바꾼 값'),
                unchanged: t('composition.override.unchanged', '변경 없음'),
                edit: t('composition.module.edit', '프롬프트 묶음 편집'),
                resetOverride: t('composition.override.reset', '변경값 초기화'),
                resolvedPlan: t('composition.plan.open', '실제 생성값 열기'),
            }}
            onOpenResolvedPlan={handleOpenResolvedPlan}
        >
            <div className="p-3 pt-5">
                <Button type="button" variant="outline" className="w-full justify-start" onClick={handleOpenPromptSheet}>
                    <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
                    <span className="min-w-0 truncate">{t('composition.compatibility.rawPrompt', '직접 프롬프트 편집')}</span>
                </Button>
            </div>
        </CompositionInspector>
    )
    const resolvedPlanPanel = (
        <ResolvedPlanView
            plan={resolvedPlan}
            issues={[...resolvedErrors, ...portableResolvedIssues, ...resolvedWarnings]}
            loading={profileLoading || preflight === null}
            error={profileConflict ? profileConflictMessage : null}
            title={t('composition.plan.title', '실제 생성에 쓰일 값')}
            showHeader={false}
            saveContext={activeGenerationFolder && outputDirectory ? {
                generationFolderPath: activeGenerationFolder.path,
                outputDirectory,
                r2AutoUpload: activeGenerationFolder.r2.autoUpload,
            } : undefined}
            labels={{
                loading: t('composition.plan.loading', '생성값을 정리하는 중…'),
                empty: t('composition.plan.empty', '아직 정리된 생성값이 없어요.'),
                positive: t('composition.plan.positive', '프롬프트'),
                negative: t('composition.plan.negative', '피할 내용'),
                promptParts: t('composition.plan.promptParts', '내부 프롬프트 칸'),
                characters: t('composition.plan.characters', '캐릭터'),
                params: t('composition.plan.params', '생성 설정 원본'),
                paramsWinner: t('composition.plan.paramsWinner', '적용된 출처'),
                output: t('composition.plan.output', '저장 설정 원본'),
                warnings: t('composition.plan.warnings', '확인할 내용'),
                errors: t('composition.plan.errors', '먼저 해결할 문제'),
                randomTrace: t('composition.plan.randomTrace', '랜덤 선택 기록'),
                provenance: t('composition.plan.provenance', '값의 출처'),
                technical: t('composition.plan.technical', '기술 정보'),
                issueDiagnostics: t('composition.plan.issueDiagnostics', '문제 진단 정보'),
                generationSummary: t('composition.plan.generationSummary', '생성 방식'),
                saveSummary: t('composition.plan.saveSummary', '저장'),
                generationFolder: t('composition.plan.generationFolder', '생성 폴더'),
                outputDirectory: t('composition.plan.outputDirectory', '실제 로컬 출력 경로'),
                format: t('composition.plan.format', '최종 형식'),
                metadata: t('composition.plan.metadata', '메타데이터'),
                r2AutoUpload: t('composition.plan.r2AutoUpload', 'R2 자동 업로드'),
                r2Configured: t('composition.plan.r2Configured', '설정됨'),
                r2Off: t('composition.plan.r2Off', '꺼짐'),
                revision: t('composition.plan.revision', '수정본'),
                metadataEmbedded: t('composition.plan.metadataEmbedded', '이미지에 생성 정보 포함'),
                metadataSidecar: t('composition.plan.metadataSidecar', '이미지 유지 · 복구 정보 별도 보관'),
                metadataClean: t('composition.plan.metadataClean', '이미지의 생성 정보 제거 · 복구 정보 별도 보관'),
                metadataStripped: t('composition.plan.metadataStripped', '이미지의 생성 정보 제거'),
                repair: t('composition.plan.repair', '문제 해결'),
            }}
            canRepairIssue={canRepairIssue}
            onRepairIssue={handleRepairIssue}
        />
    )
    const commandBar = (
        <div data-testid="main-command-dock">
            <CompositionCommandBar
                summary={generationSummary}
                onOpenSummary={handleOpenSummaryFocus}
                storage={{
                    folder: generationFolderPath,
                    format: outputFormat,
                    r2Status,
                    label: t('composition.plan.openStorage', '저장 설정 열기'),
                    onOpen: () => navigate('/settings?section=storage'),
                }}
                count={batchCounter}
                cost={estimatedCost !== null ? {
                    value: `${estimatedCost} Anlas`,
                    label: t('composition.cost.estimated', 'Estimated cost'),
                } : undefined}
                resolved={hasResolvedContent ? {
                    available: true,
                    label: resolvedControlLabel,
                    open: resolvedSheetOpen,
                    onOpen: handleOpenResolvedPlan,
                } : undefined}
                generation={generationControl}
                labels={{
                    modules: t('composition.workspace.modules', '프롬프트 묶음'),
                    inspector: t('composition.workspace.inspector', '적용 내용'),
                    generate: t('generate.button', 'Generate'),
                    cancel: t('generate.cancel', 'Cancel'),
                }}
                onOpenModules={hasModuleSheetContent ? handleOpenModuleStack : undefined}
                simplified
            />
        </div>
    )
    const mobileDock = isMobileWorkspace ? (
        <MobileCommandDock
            generation={{
                ...generationControl,
                generateLabel: reviewingBlockedPlan
                    ? generationControl.generateLabel
                    : t('generate.imagesButton', 'Generate {{count}} images', { count: batchCount }),
            }}
            testId="main-command-dock"
            labels={{
                settings: t('generate.settings', 'Settings'),
                generate: t('generate.button', 'Generate'),
                cancel: t('generate.cancel', 'Cancel'),
            }}
            onOpenSettings={handleOpenModuleStack}
            count={mobileCountButton}
            simplified
        />
    ) : null

    return (
        <div className="relative h-full min-h-0 w-full overflow-hidden bg-canvas">

            <CompositionWorkspaceLayout
                desktopRails={false}
                commandBar={isMobileWorkspace ? null : commandBar}
                commandBarPlacement="bottom"
                moduleStack={moduleStack}
                inspector={inspector}
                mobileDock={mobileDock}
                workspaceClassName="border-y border-border/60 bg-canvas"
                workspace={(
                    <div className="relative h-full min-h-0 min-w-0 overflow-hidden" data-testid="main-result-canvas">
            {/* Full Screen Image Area */}
            <div className="flex h-full min-h-0 w-full items-center justify-center overflow-hidden">
                {previewImage ? (
                    // Generated Image with Context Menu
                    <ContextMenu>
                        <ContextMenuTrigger asChild>
                            <div className="group relative h-full w-full cursor-context-menu">
                                <img
                                    src={previewImage}
                                    alt="Generated preview"
                                    className="w-full h-full object-contain"
                                />
                                {/* Image Actions Overlay (Visible on hover) */}
                                <div className="absolute right-3 top-3 flex gap-2 opacity-100 transition-opacity duration-standard sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
                                    <Button
                                        size="icon"
                                        variant="secondary"
                                        className="h-11 w-11 rounded-control bg-popover text-popover-foreground shadow-overlay hover:bg-accent"
                                        onClick={handleRegenerateWithMetadata}
                                        disabled={isGenerating}
                                        aria-label={t('actions.regenerate', '재생성')}
                                    >
                                        <RotateCcw className="h-5 w-5" />
                                    </Button>
                                    <Button
                                        size="icon"
                                        variant="secondary"
                                        className="h-11 w-11 rounded-control bg-popover text-popover-foreground shadow-overlay hover:bg-accent"
                                        onClick={handleCopy}
                                        aria-label={t('actions.copy', '복사')}
                                    >
                                        <Copy className="h-5 w-5" />
                                    </Button>
                                    <Button
                                        size="icon"
                                        variant="secondary"
                                        className="h-11 w-11 rounded-control bg-popover text-popover-foreground shadow-overlay hover:bg-accent"
                                        onClick={handleSaveAs}
                                        aria-label={t('actions.saveAs', '저장')}
                                    >
                                        <Download className="h-5 w-5" />
                                    </Button>
                                </div>
                            </div>
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                            <ContextMenuItem onClick={handleSaveAs}>
                                <Save className="h-4 w-4 mr-2" />
                                {t('actions.saveAs', '저장')}
                            </ContextMenuItem>
                            <ContextMenuItem onClick={handleCopy}>
                                <Copy className="h-4 w-4 mr-2" />
                                {t('actions.copy', '복사')}
                            </ContextMenuItem>
                            <ContextMenuItem onClick={handleRegenerateWithMetadata} disabled={isGenerating}>
                                <RotateCcw className="h-4 w-4 mr-2" />
                                {t('actions.regenerate', '재생성')}
                            </ContextMenuItem>
                            <ContextMenuItem onClick={handleOpenSmartTools}>
                                <Wand2 className="h-4 w-4 mr-2" />
                                {t('smartTools.title', '스마트 툴')}
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem onClick={handleInpaint}>
                                <Paintbrush className="h-4 w-4 mr-2" />
                                {t('tools.inpainting.title', '인페인팅')}
                            </ContextMenuItem>
                            <ContextMenuItem onClick={handleI2I}>
                                <ImageIcon className="h-4 w-4 mr-2" />
                                {t('tools.i2i.title', 'Image to Image')}
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem onClick={handleAddAsReference}>
                                <Users className="h-4 w-4 mr-2" />
                                {t('actions.addAsRef', '이미지 참조')}
                            </ContextMenuItem>
                            <ContextMenuItem onClick={handleOpenFolder}>
                                <FolderOpen className="h-4 w-4 mr-2" />
                                {t('actions.openFolder', '폴더 열기')}
                            </ContextMenuItem>
                            <ContextMenuItem onClick={handleLoadMetadata}>
                                <ImageIcon className="h-4 w-4 mr-2" />
                                {t('metadata.loadFromImage', '메타데이터 불러오기')}
                            </ContextMenuItem>
                        </ContextMenuContent>
                    </ContextMenu>
                ) : isGenerating ? (
                    // Loading State (Only shown when no previous image exists)
                    <div className="z-10 flex max-w-sm flex-col items-center justify-center px-6 text-center" role="status" aria-live="polite">
                        <div className="relative mb-4 flex h-16 w-16 items-center justify-center rounded-panel bg-muted/50">
                            <div className="absolute inset-2 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
                            <ImagePlus className="h-6 w-6 text-primary" />
                        </div>
                        <p className="text-base font-semibold text-foreground">
                            {batchCount > 1
                                ? `${t('generate.loadingTitle')} (${currentBatch}/${batchCount})`
                                : t('generate.loadingTitle')
                            }
                        </p>
                        <p className="mt-2 font-mono text-xs tabular-nums text-muted-foreground">
                            {formatTime(elapsedTime)}s
                            {lastGenerationTime && (
                                <span className="mx-1 text-muted-foreground/70">/ ~{formatTime(lastGenerationTime)}s</span>
                            )}
                        </p>
                    </div>
                ) : (
                    // Empty state intentionally keeps one action and one import hint.
                    <div className="flex max-w-md flex-col items-center justify-center px-6 text-center">
                        <div className="mb-4 flex h-16 w-16 items-center justify-center text-muted-foreground/70">
                            <ImageIcon className="h-8 w-8" />
                        </div>
                        <h1 className="text-lg font-semibold text-foreground">{t('generate.emptyState')}</h1>
                        <p className="mt-1 max-w-[17rem] text-sm leading-6 text-muted-foreground sm:max-w-sm">
                            {promptSurface.isVisible
                                ? t('generate.emptyDescriptionRail', '왼쪽 프롬프트 패널에 설명을 입력하고 생성을 눌러 보세요.')
                                : t('generate.emptyDescription')}
                        </p>
                        {!promptSurface.isVisible && (
                            <Button variant="outline" className="mt-4" onClick={handleOpenPromptSheet}>
                                <SlidersHorizontal className="h-4 w-4" />
                                {t('generate.openPrompt', '프롬프트 열기')}
                            </Button>
                        )}
                        <p className="mt-3 hidden text-xs text-muted-foreground sm:block">
                            {t('metadata.dropHint', '이미지를 드래그하여 메타데이터를 불러올 수 있습니다')}
                        </p>
                    </div>
                )}
            </div>

            {/* Generation Progress Bar - Above Info Bar */}
            {isGenerating && (
                <div className="absolute bottom-[calc(4.5rem+env(safe-area-inset-bottom))] left-1/2 z-20 flex w-[min(30rem,calc(100%-1rem))] -translate-x-1/2 items-center gap-3 rounded-panel bg-popover px-3 py-2 text-popover-foreground shadow-overlay md:bottom-3" role="status" aria-live="polite">
                    <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-3">
                            <span className="truncate text-xs font-medium text-foreground">
                            {t('generate.generating')}
                            </span>
                            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                                {formatTime(elapsedTime)}s
                                {lastGenerationTime && <> / {formatTime(lastGenerationTime)}s</>}
                            </span>
                        </div>
                        {streamProgress > 0 && streamProgress < 100 && (
                            <div className="mt-2 flex items-center gap-2">
                                <div
                                    className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
                                    role="progressbar"
                                    aria-label={t('generate.progress', '생성 진행률')}
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-valuenow={streamProgress}
                                >
                                <div
                                        className="h-full bg-primary transition-[width] duration-standard ease-out"
                                    style={{ width: `${streamProgress}%` }}
                                />
                                </div>
                                <span className="w-9 text-right font-mono text-xs tabular-nums text-primary">{streamProgress}%</span>
                            </div>
                        )}
                    </div>
                </div>
            )}

                    </div>
                )}
            />

            <CompositionWorkspaceSheet
                open={moduleSheetOpen}
                onOpenChange={setModuleSheetOpen}
                title={isMobileWorkspace
                    ? t('generate.settings', 'Settings')
                    : t('composition.workspace.moduleStack', '적용 순서')}
                description={isMobileWorkspace
                    ? t('generate.settingsHelp', 'Edit prompts, order, image count, and resolved generation values.')
                    : t('composition.workspace.moduleStackHelp', '생성 구성과 프롬프트 묶음의 적용 순서를 확인하세요.')}
                side={isMobileWorkspace ? 'bottom' : 'left'}
                level="primary"
                testId="main-module-stack-sheet"
                closeLabel={t('common.close', 'Close')}
                returnFocusRef={moduleSheetTriggerRef}
            >
                <div className="flex min-h-0 flex-col gap-3">
                    {isMobileWorkspace && (
                        <div className="grid gap-3" data-testid="main-mobile-settings-hub">
                            <div className="flex min-w-0 items-center justify-between gap-3 rounded-control border border-border/60 p-2">
                                <span className="min-w-0 text-sm font-medium">{t('generate.countLabel', 'Image count')}</span>
                                {batchCounter}
                            </div>
                            <Button type="button" variant="outline" className="w-full justify-start" onClick={handleOpenPromptFromSettings}>
                                <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
                                <span className="min-w-0 truncate">{t('composition.compatibility.rawPrompt', '직접 프롬프트 편집')}</span>
                            </Button>
                            <Button type="button" variant="outline" className="w-full justify-start" onClick={handleOpenResolvedPlan}>
                                {t('composition.plan.open', '실제 생성값 열기')}
                            </Button>
                        </div>
                    )}
                    {hasRecipeControls && <RecipeSelector onChange={handleRecipeSelection} />}
                    {moduleStack}
                </div>
            </CompositionWorkspaceSheet>

            <CompositionWorkspaceSheet
                open={inspectorSheetOpen}
                onOpenChange={setInspectorSheetOpen}
                title={t('composition.workspace.inspector', '적용 내용')}
                description={t('composition.workspace.inspectorHelp', '선택한 프롬프트 묶음이 생성 내용에 어떻게 적용되는지 확인하세요.')}
                side={isMobileWorkspace ? 'bottom' : 'right'}
                level="secondary"
                testId="main-composition-inspector-sheet"
                closeLabel={t('common.close', 'Close')}
                returnFocusRef={inspectorSheetTriggerRef}
            >
                {inspector}
            </CompositionWorkspaceSheet>

            <CompositionWorkspaceSheet
                open={resolvedSheetOpen}
                onOpenChange={setResolvedSheetOpen}
                title={t('composition.plan.title', '실제 생성에 쓰일 값')}
                description={t('composition.plan.help', '먼저 결과에 영향을 주는 내용을 보여주고, 원본 값은 기술 정보에 보관합니다.')}
                side={isMobileWorkspace ? 'bottom' : 'right'}
                level="secondary"
                testId="main-resolved-plan-sheet"
                closeLabel={t('common.close', 'Close')}
                returnFocusRef={resolvedSheetTriggerRef}
            >
                {resolvedPlanPanel}
            </CompositionWorkspaceSheet>

            {/* Metadata Dialog */}
            <MetadataDialog
                open={metadataDialogOpen}
                onOpenChange={(open) => {
                    setMetadataDialogOpen(open)
                    if (!open) setMetadataImage(undefined)
                }}
                initialImage={metadataImage}
            />

            {/* Image Reference Dialog */}
            <ImageReferenceDialog
                open={imageRefDialogOpen}
                onOpenChange={setImageRefDialogOpen}
                imageBase64={previewImage || null}
            />

            {/* Inpainting Dialog */}
            <InpaintingDialog
                open={inpaintDialogOpen}
                onOpenChange={setInpaintDialogOpen}
                sourceImage={previewImage}
            />
        </div>
    )
}
