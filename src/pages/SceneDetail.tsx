import { useParams, useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
    ChevronLeft,
    Check,
    Image as ImageIcon,
    FolderOpen,
    Minus,
    Plus,
    X,
    Pencil,
    Star,
    Trash2,
    CheckSquare,
    Square,
    ScanEye,
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import { CHARACTER_SCENES_DIRECTORY_NAME } from '@/domain/generation-folders'
import { AutocompleteTextarea } from "@/components/ui/AutocompleteTextarea";
import { Tip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { getScenePresetPathSegments, hasSceneCompositionOverrides, resolveSceneGeneration, useSceneStore, SceneImage, type SceneCompositionMode } from '@/stores/scene-store'
import { useAssetModuleStore } from '@/stores/asset-module-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useSceneGeneration } from '@/hooks/useSceneGeneration'
import { openNativePath } from '@/platform/native-shell'
import { MetadataDialog } from '@/components/metadata/MetadataDialog'
import { ImageReferenceDialog } from '@/components/metadata/ImageReferenceDialog'
import { InpaintingDialog } from '@/components/tools/InpaintingDialog'
import { joinNativePath } from '@/platform/native-path'
import { toNativeAssetUrl } from '@/platform/asset-url'
import {
    nativePathExists as exists,
    readNativeBinaryFile as readFile,
    readNativeDirectory as readDir,
} from '@/platform/native-file-system'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { GenerationFolderPicker } from '@/components/generation-folders/GenerationFolderPicker'
import { toast } from '@/components/ui/use-toast'
import { sanitizePathComponent } from '@/lib/scene-output-path'
import { getMediaStorageRoot, shouldUseAbsoluteMediaPath } from '@/platform/storage'
import {
    previewSceneComposition,
} from '@/lib/scene-generation/build-scene-params'
import {
    decodeSceneRecipeSelection,
    SCENE_DIRECT_SELECTION_ID,
    sceneAssetRecipeSelectionId,
    type SceneCompositionResolution,
} from '@/lib/composition/scene-adapter'
import { SceneCompositionWorkspace } from '@/components/scene/SceneCompositionWorkspace'
import { ScenePromptEditor } from '@/components/scene/ScenePromptEditor'
import { CharacterLayoutEditor } from '@/components/composition-workspace'
import { portableIssuesForResolvedPlan } from '@/components/composition-workspace'
import type {
    CharacterLayoutItem,
    CompositionConflictSummary,
    CompositionOverrideDiffItem,
    CompositionValidationSummary,
    ModuleStackItem,
} from '@/components/composition-workspace'
import { getRuntimeCompositionDocument } from '@/lib/composition-authority'
import { calculateAnlasCost, resolveAnlasPricingBasis } from '@/lib/anlas-calculator'
import { selectActiveCredentialsAreOpus, useAuthStore } from '@/stores/auth-store'
import { SHORTCUT_EVENTS } from '@/hooks/useShortcuts'
import { useGenerationStore } from '@/stores/generation-store'
import { useQueueStore } from '@/stores/queue-store'
import {
    enqueueReviewedSceneQueue,
    prepareCurrentSceneQueueReview,
    type PreparedSceneQueueReview,
    type SceneQueueSubmission,
} from '@/services/queue/scene-queue-adapter'
import { SceneQueueReviewDialog } from '@/components/queue/SceneQueueReviewDialog'
import { isSceneQueueReviewConflict } from '@/application/scene/scene-queue-review'
import type { CharacterPosition, CharacterSlotPatch } from '@/domain/composition'
import { runtimeCapabilities } from '@/platform/capabilities'
import { assessPortableCompositionPlan } from '@/platform/portable-resources'
import { ensureActiveGenerationCredential } from '@/services/generation/credential-guard'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useTrashStore } from '@/stores/trash-store'
import { archiveSceneImages } from '@/services/trash/asset-trash-service'

const SCENE_COMPOSITION_MODES: readonly SceneCompositionMode[] = ['legacy', 'shadow', 'v2']

const getParentDirectoryPath = (path: string): string | null => {
    if (!path || path.startsWith('data:')) return null
    const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    return lastSlash > 0 ? path.slice(0, lastSlash) : null
}

const getLatestSceneImageParentPath = (images: SceneImage[]): string | null => {
    const latestImage = [...images]
        .filter(image => image.url && !image.url.startsWith('data:'))
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0]

    return latestImage ? getParentDirectoryPath(latestImage.url) : null
}

async function findSceneFolderUnderPreset(presetPath: string, safeSceneName: string): Promise<string | null> {
    const directPath = await joinNativePath(presetPath, safeSceneName)
    if (await exists(directPath)) return directPath

    if (!(await exists(presetPath))) return null

    try {
        // Rotation outputs now live under one stable parent. Search it first,
        // then retain the former preset/character/scene layout as a fallback.
        const characterSceneRoot = await joinNativePath(presetPath, CHARACTER_SCENES_DIRECTORY_NAME)
        if (await exists(characterSceneRoot)) {
            const characterFolders = await readDir(characterSceneRoot)
            for (const entry of characterFolders) {
                if (!entry.isDirectory) continue
                const rotationScenePath = await joinNativePath(characterSceneRoot, entry.name, safeSceneName)
                if (await exists(rotationScenePath)) return rotationScenePath
            }
        }

        const characterFolders = await readDir(presetPath)
        for (const entry of characterFolders) {
            if (!entry.isDirectory || entry.name === CHARACTER_SCENES_DIRECTORY_NAME) continue
            const rotationScenePath = await joinNativePath(presetPath, entry.name, safeSceneName)
            if (await exists(rotationScenePath)) return rotationScenePath
        }
    } catch (error) {
        console.warn('Failed to scan rotation scene folders:', error)
    }

    return null
}

export default function SceneDetail() {
    const { id: sceneId } = useParams()
    const { t } = useTranslation()
    const activePresetId = useSceneStore(state => state.activePresetId)

    // Use reactive selector for scene - this ensures component re-renders when scene.images changes
    const scene = useSceneStore(state => {
        const preset = state.presets.find(p => p.id === state.activePresetId)
        return preset?.scenes.find(s => s.id === sceneId)
    })

    const {
        renameScene,
        toggleFavorite,
        deleteImage,
        incrementQueue,
        decrementQueue,
        validateSceneImages,
        updateSceneSettings,
        setSceneCompositionRef,
        resetSceneToRecipe,
        startNewGenerationSession,
        cancelSceneGeneration,
    } = useSceneStore()
    const { isGenerating: sceneIsGenerating } = useSceneGeneration()
    const sceneIsCancelling = useSceneStore(state => state.isCancelling)
    const sceneCompositionMode = useSceneStore(state => state.sceneCompositionMode)
    const setSceneCompositionMode = useSceneStore(state => state.setSceneCompositionMode)
    const sceneCompositionRecord = useSceneStore(state => sceneId ? state.sceneCompositionResults[sceneId] : undefined)
    const { promptFontSize } = useSettingsStore()
    const activeCredentialsAreOpus = useAuthStore(selectActiveCredentialsAreOpus)
    const assetProfile = useAssetModuleStore(state => state.profile)
    const assetHasConflict = useAssetModuleStore(state => state.hasConflict)
    const assetConflictMessage = useAssetModuleStore(state => state.conflictMessage)
    const generatingMode = useGenerationStore(state => state.generatingMode)
    const queueExecutionAuthority = useQueueStore(state => state.executionAuthority)
    const selectDurableBatch = useQueueStore(state => state.setSelectedBatchId)
    const addToTrash = useTrashStore(state => state.add)

    // Scene dimensions are shared by the request builder and gallery frames so
    // the saved scene snapshot has one visible resolution authority.
    const currentWidth = scene?.width || 832
    const currentHeight = scene?.height || 1216
    const previewAspectRatio = `${currentWidth} / ${currentHeight}`

    const [editName, setEditName] = useState(scene?.name || '')
    // Dialog states
    const [metadataDialogOpen, setMetadataDialogOpen] = useState(false)
    const [selectedImageForMetadata, setSelectedImageForMetadata] = useState<string | undefined>()
    const [imageRefDialogOpen, setImageRefDialogOpen] = useState(false)
    const [selectedImageForRef, setSelectedImageForRef] = useState<string | null>(null)
    const [inpaintDialogOpen, setInpaintDialogOpen] = useState(false)
    const [selectedImageForInpaint, setSelectedImageForInpaint] = useState<string | null>(null)
    const [isEditingName, setIsEditingName] = useState(false)
    const [showFavoritesOnly, setShowFavoritesOnly] = useState(false)
    const [viewerImageSrc, setViewerImageSrc] = useState<string | null>(null)
    const [viewerImage, setViewerImage] = useState<SceneImage | null>(null)  // Current image object for context menu
    const viewerDialogRef = useRef<HTMLDivElement>(null)
    const viewerReturnFocusRef = useRef<HTMLElement | null>(null)
    const streamingSceneId = useSceneStore(s => s.streamingSceneId)
    const streamingImage = useSceneStore(s => s.streamingSceneId === sceneId ? s.streamingImage : null)
    const streamingProgress = useSceneStore(s => s.streamingSceneId === sceneId ? s.streamingProgress : 0)

    // Edit mode state
    const [isEditMode, setIsEditMode] = useState(false)
    const [selectedImageIds, setSelectedImageIds] = useState<Set<string>>(new Set())
    const [pendingImagesToTrash, setPendingImagesToTrash] = useState<SceneImage[]>([])
    const [compositionPreviewLoading, setCompositionPreviewLoading] = useState(false)
    const [compositionPreview, setCompositionPreview] = useState<SceneCompositionResolution | null>(null)
    const [compositionPreviewError, setCompositionPreviewError] = useState<string | null>(null)
    const [activeModuleId, setActiveModuleId] = useState<string | null>(null)
    const [sceneQueueReview, setSceneQueueReview] = useState<PreparedSceneQueueReview | null>(null)

    // Auto-save prompt logic - hooks must be before conditional return
    const updateScenePrompt = useSceneStore(state => state.updateScenePrompt)
    const [localPrompt, setLocalPrompt] = useState(scene?.scenePrompt || '')

    const nav = useNavigate()

    const closeImageViewer = useCallback(() => {
        setViewerImageSrc(null)
        setViewerImage(null)

        const returnFocusTarget = viewerReturnFocusRef.current
        window.requestAnimationFrame(() => returnFocusTarget?.focus())
    }, [])

    const requestTrashImages = (images: readonly SceneImage[]) => {
        if (images.length > 0) setPendingImagesToTrash([...images])
    }

    /**
     * Depends on the active Scene snapshot and is shared by card, viewer, and
     * bulk controls. Files move into the trash before SceneStore removes their
     * ids, so every image deletion keeps a preview and recoverable metadata.
     */
    const movePendingImagesToTrash = async () => {
        if (!scene || !activePresetId || pendingImagesToTrash.length === 0) return
        const preset = useSceneStore.getState().presets.find(candidate => candidate.id === activePresetId)
        if (!preset) return
        try {
            const currentImages = scene.images.filter(image => pendingImagesToTrash.some(pending => pending.id === image.id))
            const trashItems = await archiveSceneImages(currentImages, {
                presetId: preset.id,
                presetName: preset.name,
                sceneId: scene.id,
                sceneName: scene.name,
            })
            trashItems.forEach(addToTrash)
            currentImages.forEach(image => deleteImage(activePresetId, scene.id, image.id))
            setSelectedImageIds(current => {
                const next = new Set(current)
                currentImages.forEach(image => next.delete(image.id))
                return next
            })
            if (viewerImage && currentImages.some(image => image.id === viewerImage.id)) closeImageViewer()
            toast({ title: t('trash.moved', '휴지통으로 이동했습니다.'), variant: 'success' })
        } catch (error) {
            console.error('Failed to move Scene images to trash:', error)
            toast({ title: t('common.error', '오류'), variant: 'destructive' })
        } finally {
            setPendingImagesToTrash([])
        }
    }

    // ESC key handler for closing viewer or navigating back
    useEffect(() => {
        const handleEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                if (viewerImageSrc) {
                    closeImageViewer()
                } else {
                    // Navigate back to scene list
                    nav('/scenes')
                }
            }
        }
        window.addEventListener('keydown', handleEsc)
        return () => window.removeEventListener('keydown', handleEsc)
    }, [closeImageViewer, viewerImageSrc, nav])

    useEffect(() => {
        if (!viewerImageSrc) return

        const frame = window.requestAnimationFrame(() => viewerDialogRef.current?.focus())
        return () => window.cancelAnimationFrame(frame)
    }, [viewerImageSrc])

    // Memory cleanup on unmount - release streaming data when leaving scene detail
    // This prevents OOM when switching between modes (Issue #6)
    useEffect(() => {
        return () => {
            console.log('[SceneDetail] Unmounting - clearing streaming data')
            useSceneStore.getState().clearRuntimeData()
        }
    }, [])

    useEffect(() => {
        if (scene) {
            setEditName(scene.name)
        }
    }, [scene?.name])

    // Compatibility editor mirrors the canonical Scene prompt module and must
    // never write a stale value over the prompt tabs.
    useEffect(() => {
        if (scene) {
            setLocalPrompt(scene.scenePrompt)
        }
    }, [scene?.id, scene?.scenePrompt])

    // Auto-validate images on mount - MUST be before conditional return to maintain hook order
    useEffect(() => {
        if (!scene || !activePresetId || !validateSceneImages) return

        const validateImages = async () => {
            if (scene.images.length === 0) return

            const validImageIds: string[] = []
            let hasChanges = false

            for (const img of scene.images) {
                try {
                    // Check if url is a file path
                    if (!img.url.startsWith('data:')) {
                        if (await exists(img.url)) {
                            validImageIds.push(img.id)
                        } else {
                            hasChanges = true
                        }
                    } else {
                        // Keep base64 images
                        validImageIds.push(img.id)
                    }
                } catch (e) {
                    // If check fails, assume valid to be safe
                    validImageIds.push(img.id)
                }
            }

            // Only update if changes needed
            if (hasChanges && validImageIds.length !== scene.images.length) {
                validateSceneImages(activePresetId, scene.id, validImageIds)
            }
        }

        validateImages()
    }, [scene?.id, activePresetId, validateSceneImages])

    const handleBack = () => {
        nav('/scenes')
    }

    if (!scene || !activePresetId) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-4">
                <p>{t('scene.notFound', '씬을 찾을 수 없습니다')}</p>
                <Button onClick={handleBack} variant="outline">
                    <ChevronLeft className="mr-2 h-4 w-4" />
                    {t('common.back', '돌아가기')}
                </Button>
            </div>
        )
    }

    const handleSaveName = () => {
        if (editName.trim()) {
            const { sceneSavePath, useAbsoluteScenePath } = useSettingsStore.getState()
            void renameScene(activePresetId, scene.id, editName.trim(), {
                sceneSavePath,
                useAbsoluteScenePath,
            })
        }
        setIsEditingName(false)
    }

    const handleCancelNameEdit = () => {
        setEditName(scene.name)
        setIsEditingName(false)
    }

    const handleSceneRecipeChange = (selectionValue: string) => {
        const selection = decodeSceneRecipeSelection(selectionValue)
        setCompositionPreview(null)
        setCompositionPreviewError(null)
        setSceneCompositionRef(activePresetId, scene.id, {
            ...scene.compositionRef,
            recipeId: selection.recipeId,
            selectionKind: selection.selectionKind,
            recipeRevision: assetProfile.revision,
            migrationMarker: scene.compositionRef?.migrationMarker ?? {
                kind: 'legacy-scene-prompt',
                schemaVersion: 2,
            },
        })
    }

    const handleResetSceneToRecipe = () => {
        // Update the visible editor before the store change can trigger the
        // prompt autosave cleanup with the previous text.
        setLocalPrompt('')
        setCompositionPreview(null)
        setCompositionPreviewError(null)
        resetSceneToRecipe(activePresetId, scene.id)
    }

    const handleLocalPromptChange = (value: string) => {
        setLocalPrompt(value)
        updateScenePrompt(activePresetId, scene.id, value)
        setCompositionPreview(null)
        setCompositionPreviewError(null)
    }

    const handlePreviewSceneComposition = async () => {
        setCompositionPreviewLoading(true)
        setCompositionPreview(null)
        setCompositionPreviewError(null)
        try {
            const resolution = await previewSceneComposition(scene, { scenePrompt: localPrompt })
            setCompositionPreview(resolution)
        } catch (error) {
            setCompositionPreviewError(error instanceof Error ? error.message : String(error))
        } finally {
            setCompositionPreviewLoading(false)
        }
    }

    const startDurableSceneGeneration = async () => {
        if (!ensureActiveGenerationCredential()) {
            toast({
                title: t('credentialVault.unlockRequired', 'API 토큰 잠금 해제 필요'),
                description: t('credentialVault.unlockRequiredForGeneration', '이미지를 생성하려면 NovelAI API 토큰 보관소를 잠금 해제하세요.'),
            })
            return
        }
        try {
            setSceneQueueReview(await prepareCurrentSceneQueueReview())
        } catch (error) {
            toast({
                title: t('common.error', 'Error'),
                description: error instanceof Error ? error.message : t('queue.enqueueFailed', 'Queue enqueue failed'),
                variant: 'destructive',
            })
        }
    }

    const replanSceneQueueReview = async (): Promise<boolean> => {
        try {
            const next = await prepareCurrentSceneQueueReview()
            setSceneQueueReview(next)
            return next !== null
        } catch (error) {
            toast({
                title: t('common.error', 'Error'),
                description: error instanceof Error ? error.message : t('queue.enqueueFailed', 'Queue enqueue failed'),
                variant: 'destructive',
            })
            return false
        }
    }

    const approveSceneQueueReview = async (submission: SceneQueueSubmission): Promise<boolean> => {
        try {
            const result = await enqueueReviewedSceneQueue(submission)
            selectDurableBatch(result.batch.id)
            toast({
                title: t('queue.enqueued', 'Added to durable queue'),
                description: t('queue.enqueuedCount', '{{count}} jobs are ready in Queue Center.', {
                    count: result.jobs.length,
                }),
            })
            return true
        } catch (error) {
            if (isSceneQueueReviewConflict(error)) throw error
            toast({
                title: t('common.error', 'Error'),
                description: error instanceof Error ? error.message : t('queue.enqueueFailed', 'Queue enqueue failed'),
                variant: 'destructive',
            })
            return false
        }
    }

    const handleGenerate = () => {
        if (!activePresetId || !scene) return

        if (queueExecutionAuthority === 'legacy' && (sceneIsGenerating || sceneIsCancelling)) {
            cancelSceneGeneration()
            return
        }

        // If queue count is 0, set it to 1 for single generation
        // Otherwise, use the existing queue count without incrementing
        if (scene.queueCount === 0) {
            incrementQueue(activePresetId, scene.id)
        }

        if (queueExecutionAuthority === 'legacy') {
            startNewGenerationSession()
            return
        }

        void startDurableSceneGeneration()
    }

    const handleOpenFolder = async () => {
        try {
            if (!scene) return

            const latestImageParent = getLatestSceneImageParentPath(scene.images)
            if (latestImageParent && await exists(latestImageParent)) {
                await openNativePath(latestImageParent)
                return
            }

            const currentPreset = useSceneStore.getState().presets.find(p => p.id === activePresetId)
            const safePresetSegments = getScenePresetPathSegments(useSceneStore.getState().presets, currentPreset?.id || activePresetId)
                .map(segment => sanitizePathComponent(segment, 'Default'))
            const safeSceneName = sanitizePathComponent(scene.name || 'Untitled_Scene', 'Untitled_Scene')
            const { sceneSavePath, useAbsoluteScenePath } = useSettingsStore.getState()
            const sceneRootPath = shouldUseAbsoluteMediaPath(useAbsoluteScenePath) && sceneSavePath
                ? sceneSavePath
                : await joinNativePath(await getMediaStorageRoot(), sceneSavePath || 'NAI_Blue_Scene')
            const presetPath = await joinNativePath(sceneRootPath, ...safePresetSegments)
            const folderPath = await findSceneFolderUnderPreset(presetPath, safeSceneName)

            if (folderPath) {
                await openNativePath(folderPath)
                return
            }

            if (await exists(presetPath)) {
                await openNativePath(presetPath)
                return
            }

            if (await exists(sceneRootPath)) {
                await openNativePath(sceneRootPath)
            }
        } catch (error) {
            console.error("Failed to open folder:", error)
        }
    }

    const isStreaming = streamingSceneId === scene.id

    const sortedImages = showFavoritesOnly
        ? scene.images.filter(img => img.isFavorite)
        : scene.images
    const sceneGeneration = resolveSceneGeneration(scene)
    const inheritedRecipeId = assetProfile.recipes.find(recipe => recipe.enabled)?.id
    const displayedRecipeId = scene.compositionRef?.selectionKind === 'direct'
        ? SCENE_DIRECT_SELECTION_ID
        : scene.compositionRef?.recipeId !== undefined
            ? sceneAssetRecipeSelectionId(scene.compositionRef.recipeId)
            : inheritedRecipeId !== undefined
                ? sceneAssetRecipeSelectionId(inheritedRecipeId)
                : SCENE_DIRECT_SELECTION_ID
    const displayedRecipeExists = displayedRecipeId === SCENE_DIRECT_SELECTION_ID
        || assetProfile.recipes.some(recipe => sceneAssetRecipeSelectionId(recipe.id) === displayedRecipeId)
    const hasCompositionOverrides = hasSceneCompositionOverrides(scene)
    const selectedRecipe = decodeSceneRecipeSelection(displayedRecipeId)
    const runtimeDocument = getRuntimeCompositionDocument()
    const runtimeRecipe = selectedRecipe.selectionKind === 'asset'
        ? runtimeDocument?.recipes.find(recipe => recipe.id === selectedRecipe.recipeId)
        : undefined
    const legacyRecipe = selectedRecipe.selectionKind === 'asset'
        ? assetProfile.recipes.find(recipe => recipe.id === selectedRecipe.recipeId)
        : undefined
    const workspaceModules: ModuleStackItem[] = runtimeDocument
        ? (() => {
            const selectedIds = runtimeRecipe
                ? new Set(runtimeRecipe.steps.filter(step => step.enabled).map(step => step.moduleId))
                : null
            return [...runtimeDocument.modules]
                .filter(module => selectedIds === null || selectedIds.has(module.id))
                .sort((left, right) => left.orderKey.localeCompare(right.orderKey) || left.id.localeCompare(right.id))
                .map((module, order) => ({
                    id: module.id,
                    name: module.name,
                    kind: module.kind,
                    enabled: module.enabled,
                    order,
                    summary: module.contributions.map(contribution => contribution.text).filter(Boolean).join(', '),
                }))
        })()
        : (() => {
            const selectedIds = legacyRecipe
                ? new Set(legacyRecipe.steps.filter(step => step.enabled !== false).map(step => step.moduleId))
                : null
            return Object.values(assetProfile.modules)
                .filter(module => selectedIds === null || selectedIds.has(module.id))
                .sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id))
                .map((module, order) => ({
                    id: module.id,
                    name: module.label || module.id,
                    kind: module.kind || 'composite',
                    enabled: module.enabled,
                    order,
                    summary: module.prompt || module.negativePrompt || module.negative || '',
                }))
        })()
    const effectiveActiveModuleId = activeModuleId && workspaceModules.some(module => module.id === activeModuleId)
        ? activeModuleId
        : workspaceModules[0]?.id ?? null
    const characterLayoutItems: CharacterLayoutItem[] = (runtimeDocument?.characters ?? []).map((character, order) => {
        const patch = scene.compositionRef?.characterOverrides?.find(candidate => candidate.characterId === character.id)
        return {
            id: character.id,
            name: character.name,
            enabled: patch?.enabled ?? character.enabled,
            order,
            position: patch?.position ?? character.position,
        }
    })
    const validationErrorCount = sceneCompositionRecord?.errors.length ?? 0
    const validationWarningCount = sceneCompositionRecord?.warnings.length ?? 0
    const validation: CompositionValidationSummary = assetHasConflict
        ? { severity: 'conflict', errorCount: 1, label: t('composition.conflict.label', 'Conflict') }
        : validationErrorCount > 0
            ? { severity: 'error', errorCount: validationErrorCount, warningCount: validationWarningCount }
            : validationWarningCount > 0
                ? { severity: 'warning', warningCount: validationWarningCount }
                : sceneCompositionMode === 'legacy'
                    ? { severity: 'disabled', label: 'legacy' }
                    : { severity: 'valid' }
    const effectiveSceneGenerating = queueExecutionAuthority === 'legacy'
        ? sceneIsGenerating
        : false
    const effectiveSceneCancelling = queueExecutionAuthority === 'legacy'
        ? sceneIsCancelling
        : false
    const generationConflict = Boolean(generatingMode && generatingMode !== 'scene')
    const conflict: CompositionConflictSummary | null = assetHasConflict
        ? {
            severity: 'error',
            title: t('composition.externalConflict', 'External composition edit'),
            message: assetConflictMessage || t('composition.externalConflictDescription', 'Resolve the repository revision conflict before editing.'),
            revision: `asset-profile@${assetProfile.revision}`,
        }
        : generationConflict
            ? {
                severity: 'warning',
                title: t('generate.conflictTitle', 'Another workflow is generating'),
                message: t('generate.conflictDescription', 'Wait for the active generation workflow to finish or cancel it there.'),
                revision: generatingMode || undefined,
            }
            : null
    const overrideDiff: CompositionOverrideDiffItem[] = [
        {
            id: 'prompt',
            label: t('scene.scenePrompt', 'Scene prompt'),
            inheritedValue: t('scene.composition.inherited', 'Recipe'),
            overrideValue: localPrompt || '—',
            changed: localPrompt.trim().length > 0,
        },
        {
            id: 'resolution',
            label: t('settings.resolution', 'Resolution'),
            inheritedValue: '832 × 1216',
            overrideValue: `${currentWidth} × ${currentHeight}`,
            changed: scene.width !== undefined || scene.height !== undefined,
        },
        {
            id: 'characters',
            label: t('character.title', 'Characters'),
            inheritedValue: '0',
            overrideValue: String(scene.compositionRef?.characterOverrides?.length ?? 0),
            changed: (scene.compositionRef?.characterOverrides?.length ?? 0) > 0,
        },
        {
            id: 'params',
            label: t('settings.parameters', 'Parameters'),
            inheritedValue: '—',
            overrideValue: scene.compositionRef?.paramsOverride ? 'custom' : '—',
            changed: scene.compositionRef?.paramsOverride !== undefined,
        },
        {
            id: 'output',
            label: t('composition.output', 'Output'),
            inheritedValue: 'recipe',
            overrideValue: scene.compositionRef?.outputOverride ? 'custom' : 'recipe',
            changed: scene.compositionRef?.outputOverride !== undefined,
        },
    ]
    const resolvedPlan = compositionPreview?.result.success ? compositionPreview.result.plan : null
    const portableResolvedIssues = resolvedPlan === null
        ? []
        : portableIssuesForResolvedPlan(
            assessPortableCompositionPlan(resolvedPlan, runtimeCapabilities).issues,
        )
    const resolvedIssues = compositionPreview
        ? [...compositionPreview.result.errors, ...portableResolvedIssues, ...compositionPreview.result.warnings]
        : portableResolvedIssues
    const pricingBasis = resolveAnlasPricingBasis({
        model: sceneGeneration.model,
        activeCredentialsAreOpus,
    })
    const estimatedCost = calculateAnlasCost({
        model: sceneGeneration.model,
        width: currentWidth,
        height: currentHeight,
        steps: sceneGeneration.steps,
        imageCount: 1,
        pricingBasis,
    }) * Math.max(1, scene.queueCount)

    const handleCharacterPositionChange = (characterId: string, position: CharacterPosition) => {
        setCompositionPreview(null)
        setCompositionPreviewError(null)
        const existing = scene.compositionRef?.characterOverrides ?? []
        const found = existing.some(patch => patch.characterId === characterId)
        const characterOverrides: CharacterSlotPatch[] = found
            ? existing.map(patch => patch.characterId === characterId ? { ...patch, position } : patch)
            : [...existing, { characterId, position }]
        setSceneCompositionRef(activePresetId, scene.id, {
            ...scene.compositionRef,
            recipeId: selectedRecipe.recipeId,
            selectionKind: selectedRecipe.selectionKind,
            recipeRevision: assetProfile.revision,
            characterOverrides,
        })
    }

    return (
        <SceneCompositionWorkspace
            simplified
            mode={{
                value: sceneCompositionMode,
                label: t('scene.composition.mode', 'Mode'),
                options: SCENE_COMPOSITION_MODES.map(mode => ({ value: mode, label: mode })),
                onChange: value => setSceneCompositionMode(value as SceneCompositionMode),
                disabled: effectiveSceneGenerating,
            }}
            recipe={{
                value: displayedRecipeId,
                label: t('scene.composition.recipe', 'Recipe'),
                options: [
                    ...(!displayedRecipeExists
                        ? [{ value: displayedRecipeId, label: t('composition.recipe.unavailable', '{{id}} (unavailable)', { id: displayedRecipeId }), disabled: true }]
                        : []),
                    { value: SCENE_DIRECT_SELECTION_ID, label: t('composition.recipe.direct', 'Direct prompts') },
                    ...assetProfile.recipes.map(recipe => ({
                        value: sceneAssetRecipeSelectionId(recipe.id),
                        label: recipe.label || recipe.id,
                        disabled: !recipe.enabled,
                    })),
                ],
                onChange: handleSceneRecipeChange,
                disabled: effectiveSceneGenerating,
            }}
            validation={validation}
            cost={{ value: String(estimatedCost), label: 'Anlas', severity: estimatedCost > 0 ? 'warning' : 'normal' }}
            generation={{
                generating: effectiveSceneGenerating || effectiveSceneCancelling,
                disabled: effectiveSceneCancelling || (!effectiveSceneGenerating && generationConflict),
                progressLabel: effectiveSceneCancelling ? t('generate.cancelling', 'Cancelling…') : undefined,
                generateLabel: t('generate.button', 'Generate'),
                cancelLabel: t('generate.cancel', 'Cancel'),
                actionTestId: 'scene-detail-generate-action',
                cancelTestId: 'scene-detail-cancel-action',
                onGenerate: handleGenerate,
                onCancel: handleGenerate,
            }}
            modules={workspaceModules}
            activeModuleId={effectiveActiveModuleId}
            recipeName={legacyRecipe?.label || runtimeRecipe?.name || selectedRecipe.recipeId}
            resolvedPlan={resolvedPlan}
            resolvedIssues={resolvedIssues}
            resolvedLoading={compositionPreviewLoading}
            resolvedError={compositionPreviewError}
            conflict={conflict}
            overrideDiff={overrideDiff}
            inspectorChildren={(
                <>
                    {characterLayoutItems.length > 0 && (
                        <CharacterLayoutEditor
                            characters={characterLayoutItems}
                            title={t('scene.characterLayout', 'Character layout')}
                            disabled={effectiveSceneGenerating}
                            className="rounded-none border-x-0 border-b-0 shadow-none"
                            onChangePosition={handleCharacterPositionChange}
                        />
                    )}
                    <details className="border-t border-border" open={hasCompositionOverrides}>
                        <summary className="flex min-h-11 cursor-pointer items-center px-3 py-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                            {t('scene.composition.advancedCompatibility', 'Advanced / compatibility prompt')}
                        </summary>
                        <div className="min-w-0 space-y-3 border-t border-border p-3">
                            <label className="block min-w-0 text-xs font-medium text-muted-foreground">
                                <span className="mb-1 block">{t('scene.scenePrompt')}</span>
                                <AutocompleteTextarea
                                    placeholder=""
                                    className="min-h-32 min-w-0 resize-y rounded-control"
                                    style={{ fontSize: `${promptFontSize}px` }}
                                    value={localPrompt}
                                    onChange={(event: any) => handleLocalPromptChange(event.target.value)}
                                />
                            </label>
                            <div className="grid grid-cols-2 gap-2">
                                <Button
                                    type="button"
                                    variant="outline"
                                    className="min-w-0"
                                    onClick={() => window.dispatchEvent(new Event(SHORTCUT_EVENTS.OPEN_FRAGMENT_DIALOG))}
                                >
                                    <span className="truncate">{t('scene.wildcardPreview', 'Wildcard preview')}</span>
                                </Button>
                                <Button
                                    type="button"
                                    variant="secondary"
                                    className="min-w-0"
                                    onClick={handlePreviewSceneComposition}
                                    disabled={compositionPreviewLoading}
                                    data-testid="scene-resolved-action"
                                >
                                    <ScanEye className="h-4 w-4 shrink-0" />
                                    <span className="truncate">{t('scene.composition.resolved', 'Resolved')}</span>
                                </Button>
                            </div>
                        </div>
                    </details>
                </>
            )}
            onSelectModule={setActiveModuleId}
            onOpenResolved={handlePreviewSceneComposition}
            onResetOverride={handleResetSceneToRecipe}
        >
        <div
            className="custom-scrollbar flex h-full min-h-0 min-w-0 flex-col gap-3 overflow-y-auto overscroll-contain pr-1"
            data-testid="scene-detail-workspace"
        >
            {/* DESIGN.md: mobile keeps identity, generation, and queue controls in three scan-friendly rows. */}
            <header className="flex min-w-0 shrink-0 flex-col gap-2 border-b border-border pb-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex min-w-0 items-center gap-1">
                    <Tip content={t('actions.back', '씬 목록으로 돌아가기')}>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-11 w-11 shrink-0 rounded-control lg:h-9 lg:w-9"
                            aria-label={t('actions.back', '씬 목록으로 돌아가기')}
                            onClick={handleBack}
                        >
                            <ChevronLeft className="h-5 w-5" />
                        </Button>
                    </Tip>
                    <Tip content={t('actions.openFolder', '생성된 이미지 폴더 열기')}>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-11 w-11 shrink-0 rounded-control lg:h-9 lg:w-9"
                            aria-label={t('actions.openFolder', '생성된 이미지 폴더 열기')}
                            onClick={handleOpenFolder}
                        >
                            <FolderOpen className="h-5 w-5 text-muted-foreground" />
                        </Button>
                    </Tip>

                    {isEditingName ? (
                        <div
                            className="flex min-w-0 flex-1 items-center gap-1"
                            onBlur={(event) => {
                                const nextTarget = event.relatedTarget
                                if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
                                    handleSaveName()
                                }
                            }}
                        >
                            <Input
                                value={editName}
                                onChange={(e) => setEditName(e.target.value)}
                                className="h-11 min-w-0 flex-1 rounded-control text-lg font-semibold lg:h-9"
                                aria-label={t('scene.sceneName', '씬 이름')}
                                autoFocus
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleSaveName()
                                    if (e.key === 'Escape') handleCancelNameEdit()
                                }}
                            />
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-11 w-11 shrink-0 rounded-control lg:h-9 lg:w-9"
                                aria-label={t('common.save', '저장')}
                                onClick={handleSaveName}
                            >
                                <Check className="h-4 w-4" />
                            </Button>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-11 w-11 shrink-0 rounded-control lg:h-9 lg:w-9"
                                aria-label={t('common.cancel', '취소')}
                                onClick={handleCancelNameEdit}
                            >
                                <X className="h-4 w-4" />
                            </Button>
                        </div>
                    ) : (
                        <div className="flex min-w-0 flex-1 items-center gap-1">
                            <div className="min-w-0 flex-1">
                                <h1 className="truncate text-lg font-semibold" title={scene.name}>{scene.name}</h1>
                                <p className="hidden truncate text-xs text-muted-foreground xl:block">{t('scene.editPrompt')}</p>
                            </div>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-11 w-11 shrink-0 rounded-control lg:h-9 lg:w-9"
                                aria-label={t('scene.rename', '이름 변경')}
                                onClick={() => setIsEditingName(true)}
                            >
                                <Pencil className="h-4 w-4" />
                            </Button>
                        </div>
                    )}
                </div>

                <div className="flex min-w-0 items-center">
                    <div className="flex min-w-0 items-center justify-between rounded-control border border-border bg-card px-1 lg:gap-1">
                        <span className="px-2 text-xs font-medium text-muted-foreground lg:sr-only">
                            {t('scene.queue', '대기열')}
                        </span>
                        <div className="flex items-center">
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-11 w-11 rounded-control lg:h-9 lg:w-9"
                                aria-label={t('scene.decrementQueue', '대기열 감소')}
                                onClick={() => decrementQueue(activePresetId, scene.id)}
                                disabled={scene.queueCount === 0}
                            >
                                <Minus className="h-4 w-4" />
                            </Button>
                            <span className="w-10 text-center text-sm font-semibold tabular-nums" aria-live="polite">
                                {scene.queueCount}
                            </span>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-11 w-11 rounded-control lg:h-9 lg:w-9"
                                aria-label={t('scene.incrementQueue', '대기열 증가')}
                                onClick={() => incrementQueue(activePresetId, scene.id)}
                            >
                                <Plus className="h-4 w-4" />
                            </Button>
                        </div>
                    </div>
                </div>
            </header>

            <ScenePromptEditor
                scene={scene}
                presetId={activePresetId}
                disabled={effectiveSceneGenerating || effectiveSceneCancelling}
            />

            {/* Two late-stage output decisions stay together and remain compact. */}
            <section className="space-y-4 rounded-panel border border-border bg-card px-4 py-4" aria-label={t('scene.output.title', '씬 출력 설정')}>
                <div>
                    <p className="text-sm font-semibold">{t('scene.output.folder', '이미지 생성 폴더')}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                        {t('scene.output.folderHelp', '이 씬의 로컬 저장 위치와 R2 버킷·프리픽스를 선택합니다.')}
                    </p>
                    <div className="mt-3">
                        <GenerationFolderPicker
                            value={scene.generationFolderId}
                            allowManual
                            disabled={effectiveSceneGenerating || effectiveSceneCancelling}
                            onChange={selection => updateSceneSettings(activePresetId, scene.id, {
                                generationFolderId: selection?.folder.id,
                                ...(selection?.folder.r2.autoUpload && selection.r2Ready ? { metadataMode: 'strip-and-sidecar' } : {}),
                            })}
                        />
                    </div>
                </div>
                <div className="grid gap-3 border-t border-border/55 pt-4 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,0.65fr)] sm:items-end">
                    <div>
                        <p className="text-sm font-semibold">{t('scene.metadataPolicy.title', '이미지 메타데이터')}</p>
                        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                            {scene.metadataMode === 'strip-and-sidecar'
                                ? t('scene.metadataPolicy.cleanDescription', '공유 이미지는 정화하고 private 생성 정보는 sidecar로 분리합니다.')
                                : scene.metadataMode === 'strip-only'
                                    ? t('scene.metadataPolicy.purgeDescription', '메타데이터를 제거하며 복구용 sidecar를 만들지 않습니다.')
                                    : t('scene.metadataPolicy.preserveDescription', '프롬프트와 생성 설정을 이미지 또는 sidecar에 보존합니다.')}
                        </p>
                    </div>
                    <select
                        value={scene.metadataMode ?? 'embedded'}
                        onChange={event => updateSceneSettings(activePresetId, scene.id, {
                            metadataMode: event.target.value as NonNullable<typeof scene.metadataMode>,
                        })}
                        disabled={effectiveSceneGenerating || effectiveSceneCancelling}
                        className="min-h-11 border-x-0 border-y border-input bg-background px-3 text-sm"
                        aria-label={t('scene.metadataPolicy.title', '이미지 메타데이터')}
                    >
                        <option value="embedded">{t('guided.metadata.embedded', '이미지에 포함')}</option>
                        <option value="sidecar-only">{t('guided.metadata.sidecar', '이미지 유지 + sidecar')}</option>
                        <option value="strip-and-sidecar">{t('guided.metadata.clean', '공유용 정화 + sidecar · 권장')}</option>
                        {scene.metadataMode === 'strip-only' && <option value="strip-only">{t('guided.metadata.stripOnly', '정화만 · 비권장')}</option>}
                    </select>
                </div>
            </section>

            <Card className="mt-1 flex min-h-[20rem] min-w-0 flex-1 flex-col overflow-hidden rounded-panel border-border bg-card shadow-none">
                <CardHeader className="min-w-0 shrink-0 gap-2 border-b border-border p-3 sm:p-4">
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                        <CardTitle className="min-w-0 truncate text-sm">{t('scene.generatedImages')}</CardTitle>
                        <span className="shrink-0 text-xs font-normal text-muted-foreground">({scene.images.length})</span>
                        {isEditMode && selectedImageIds.size > 0 && (
                            <span className="text-xs font-medium text-primary">
                                {t('scene.selectedCount', '{{count}}개 선택됨', { count: selectedImageIds.size })}
                            </span>
                        )}
                    </div>
                    {/* DESIGN.md: mobile gallery actions wrap below the title instead of competing for one line. */}
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                        {isEditMode ? (
                            <>
                                {/* Select All / Deselect All */}
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-11 rounded-control px-3 lg:h-9"
                                    onClick={() => {
                                        if (selectedImageIds.size === scene.images.length) {
                                            setSelectedImageIds(new Set())
                                        } else {
                                            setSelectedImageIds(new Set(scene.images.map(img => img.id)))
                                        }
                                    }}
                                >
                                    {selectedImageIds.size === scene.images.length ? (
                                        <Square className="h-4 w-4" />
                                    ) : (
                                        <CheckSquare className="h-4 w-4" />
                                    )}
                                    {selectedImageIds.size === scene.images.length ? t('scene.deselectAll', '선택 해제') : t('scene.selectAll', '전체 선택')}
                                </Button>
                                {/* Delete Selected */}
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-11 rounded-control px-3 text-destructive hover:bg-destructive/10 hover:text-destructive lg:h-9"
                                    onClick={() => requestTrashImages(scene.images.filter(image => selectedImageIds.has(image.id)))}
                                    disabled={selectedImageIds.size === 0}
                                >
                                    <Trash2 className="h-4 w-4" />
                                    {t('scene.deleteSelected', '선택 삭제')}
                                </Button>
                                {/* Exit Edit Mode */}
                                <Button
                                    variant="default"
                                    size="sm"
                                    className="h-11 rounded-control px-3 lg:h-9"
                                    onClick={() => {
                                        setIsEditMode(false)
                                        setSelectedImageIds(new Set())
                                    }}
                                >
                                    <Check className="h-4 w-4" />
                                    {t('scene.exitEditMode', '편집 종료')}
                                </Button>
                            </>
                        ) : (
                            <>
                                {/* Edit Mode Button */}
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-11 rounded-control px-3 lg:h-9"
                                    onClick={() => setIsEditMode(true)}
                                >
                                    <Pencil className="h-4 w-4" />
                                    {t('scene.editMode', '편집 모드')}
                                </Button>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-11 rounded-control px-3 text-destructive hover:bg-destructive/10 hover:text-destructive lg:h-9"
                                    onClick={() => requestTrashImages(scene.images.filter(image => !image.isFavorite))}
                                    disabled={scene.images.filter(img => !img.isFavorite).length === 0}
                                >
                                    <Trash2 className="h-4 w-4" />
                                    {t('scene.deleteNonFavorites', '즐겨찾기 제외 삭제')}
                                </Button>
                                <Button
                                    variant={showFavoritesOnly ? "default" : "outline"}
                                    size="sm"
                                    className="h-11 rounded-control px-3 lg:h-9"
                                    onClick={() => setShowFavoritesOnly(!showFavoritesOnly)}
                                >
                                    <Star className={`h-4 w-4 ${showFavoritesOnly ? 'fill-current' : ''}`} />
                                    {t('scene.favoritesOnly', '즐겨찾기')}
                                </Button>
                            </>
                        )}
                    </div>
                </CardHeader>
                <CardContent className="custom-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto p-3 sm:p-4">
                    {sortedImages.length === 0 && !isStreaming ? (
                        <div className="h-full flex flex-col items-center justify-center text-muted-foreground opacity-50">
                            <ImageIcon className="h-16 w-16 mb-4 stroke-1" />
                            <p>{t('scene.noImages', '생성된 이미지가 없습니다')}</p>
                        </div>
                    ) : (
                        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))]">
                            {/* Streaming Card Slot */}
                            {isStreaming && streamingImage && (
                                <div
                                    className="relative overflow-hidden rounded-panel border border-primary bg-canvas"
                                    style={{ aspectRatio: previewAspectRatio }}
                                    data-scene-preview-resolution={`${currentWidth}x${currentHeight}`}
                                >
                                    <img src={streamingImage} alt="Generating..." className="h-full w-full object-contain animate-pulse opacity-80" />
                                    <div className="absolute inset-x-0 bottom-0 h-1 bg-muted">
                                        <div className="h-full bg-primary transition-[width] duration-300" style={{ width: `${streamingProgress * 100}%` }} />
                                    </div>
                                </div>
                            )}

                            {sortedImages.map((image) => (
                                <SceneImageCard
                                    key={image.id}
                                    image={image}
                                    aspectRatio={previewAspectRatio}
                                    resolutionLabel={`${currentWidth}x${currentHeight}`}
                                    isEditMode={isEditMode}
                                    isSelected={selectedImageIds.has(image.id)}
                                    onSelect={() => {
                                        const newSet = new Set(selectedImageIds)
                                        if (newSet.has(image.id)) {
                                            newSet.delete(image.id)
                                        } else {
                                            newSet.add(image.id)
                                        }
                                        setSelectedImageIds(newSet)
                                    }}
                                    onDelete={() => requestTrashImages([image])}
                                    onToggleFavorite={() => toggleFavorite(activePresetId, scene.id, image.id)}
                                    // Handlers for new context menu items
                                    onAddRef={async () => {
                                        // Reuse image loading logic or read file
                                        try {
                                            let dataUrl = image.url
                                            if (!dataUrl.startsWith('data:')) {
                                                const data = await readFile(image.url)
                                                let binary = ''
                                                const len = data.byteLength
                                                for (let i = 0; i < len; i++) {
                                                    binary += String.fromCharCode(data[i])
                                                }
                                                dataUrl = `data:image/png;base64,${btoa(binary)}`
                                            }
                                            setSelectedImageForRef(dataUrl)
                                            setImageRefDialogOpen(true)
                                        } catch (e) {
                                            console.error("Failed to load reference image", e)
                                        }
                                    }}
                                    onLoadMetadata={async () => {
                                        try {
                                            let dataUrl = image.url
                                            if (!dataUrl.startsWith('data:')) {
                                                const data = await readFile(image.url)
                                                let binary = ''
                                                const len = data.byteLength
                                                for (let i = 0; i < len; i++) {
                                                    binary += String.fromCharCode(data[i])
                                                }
                                                dataUrl = `data:image/png;base64,${btoa(binary)}`
                                            }
                                            setSelectedImageForMetadata(dataUrl)
                                            setMetadataDialogOpen(true)
                                        } catch (e) {
                                            console.error("Failed to load metadata image", e)
                                        }
                                    }}
                                    onInpaint={(base64) => {
                                        setSelectedImageForInpaint(base64)
                                        setInpaintDialogOpen(true)
                                    }}
                                    onImageClick={(imgSrc) => {
                                        viewerReturnFocusRef.current = document.activeElement instanceof HTMLElement
                                            ? document.activeElement
                                            : null
                                        setViewerImageSrc(imgSrc)
                                        setViewerImage(image)
                                    }}
                                />
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>

            <MetadataDialog
                open={metadataDialogOpen}
                onOpenChange={(open) => {
                    setMetadataDialogOpen(open)
                    if (!open) setSelectedImageForMetadata(undefined)
                }}
                initialImage={selectedImageForMetadata}
            />

            <ImageReferenceDialog
                open={imageRefDialogOpen}
                onOpenChange={setImageRefDialogOpen}
                imageBase64={selectedImageForRef}
            />

            <InpaintingDialog
                open={inpaintDialogOpen}
                onOpenChange={(open) => {
                    setInpaintDialogOpen(open)
                    if (!open) setSelectedImageForInpaint(null)
                }}
                sourceImage={selectedImageForInpaint}
            />

            {sceneQueueReview !== null && (
                <SceneQueueReviewDialog
                    open
                    onOpenChange={open => { if (!open) setSceneQueueReview(null) }}
                    prepared={sceneQueueReview}
                    onApprove={approveSceneQueueReview}
                    onReplan={replanSceneQueueReview}
                />
            )}

            <ConfirmDialog
                open={pendingImagesToTrash.length > 0}
                onOpenChange={open => { if (!open) setPendingImagesToTrash([]) }}
                title={t('trash.confirmMoveTitle', '휴지통으로 이동할까요?')}
                description={t('trash.confirmMoveDescription', '항목은 30일 동안 휴지통에 보관됩니다.')}
                confirmText={t('trash.move', '휴지통으로 이동')}
                cancelText={t('common.cancel', '취소')}
                variant="destructive"
                onConfirm={movePendingImagesToTrash}
            />

            {/* DESIGN.md: fixed viewers honor every safe-area edge and keep a 44px escape target. */}
            {viewerImageSrc && viewerImage && (
                <div
                    ref={viewerDialogRef}
                    role="dialog"
                    aria-modal="true"
                    aria-label={t('scene.imageViewer', '이미지 뷰어')}
                    tabIndex={-1}
                    className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-3 outline-none"
                    style={{
                        paddingTop: 'max(0.75rem, env(safe-area-inset-top))',
                        paddingRight: 'max(0.75rem, env(safe-area-inset-right))',
                        paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))',
                        paddingLeft: 'max(0.75rem, env(safe-area-inset-left))',
                    }}
                    onClick={(event) => {
                        if (event.target === event.currentTarget) closeImageViewer()
                    }}
                    onKeyDown={(event) => {
                        if (event.key === 'Tab') {
                            event.preventDefault()
                            event.currentTarget.querySelector<HTMLButtonElement>('[data-viewer-close]')?.focus()
                        }
                    }}
                >
                    <SceneImageContextMenu
                        image={viewerImage}
                        onDelete={() => requestTrashImages([viewerImage])}
                        onAddRef={async () => {
                            try {
                                let dataUrl = viewerImage.url
                                if (!dataUrl.startsWith('data:')) {
                                    const data = await readFile(viewerImage.url)
                                    let binary = ''
                                    for (let i = 0; i < data.byteLength; i++) {
                                        binary += String.fromCharCode(data[i])
                                    }
                                    dataUrl = `data:image/png;base64,${btoa(binary)}`
                                }
                                setSelectedImageForRef(dataUrl)
                                setImageRefDialogOpen(true)
                            } catch (e) {
                                console.error('Failed to load ref image', e)
                            }
                        }}
                        onLoadMetadata={async () => {
                            try {
                                let dataUrl = viewerImage.url
                                if (!dataUrl.startsWith('data:')) {
                                    const data = await readFile(viewerImage.url)
                                    let binary = ''
                                    for (let i = 0; i < data.byteLength; i++) {
                                        binary += String.fromCharCode(data[i])
                                    }
                                    dataUrl = `data:image/png;base64,${btoa(binary)}`
                                }
                                setSelectedImageForMetadata(dataUrl)
                                setMetadataDialogOpen(true)
                            } catch (e) {
                                console.error('Failed to load metadata image', e)
                            }
                        }}
                        onInpaint={async (base64) => {
                            setSelectedImageForInpaint(base64)
                            setInpaintDialogOpen(true)
                        }}
                    >
                        <img
                            src={viewerImageSrc}
                            alt={t('scene.fullImageView', '전체 이미지 보기')}
                            className="max-h-full max-w-full cursor-default object-contain"
                            onClick={(e) => e.stopPropagation()}
                            onContextMenu={(e) => e.stopPropagation()}
                        />
                    </SceneImageContextMenu>
                    <Button
                        variant="ghost"
                        size="icon"
                        data-viewer-close
                        className="absolute h-11 w-11 rounded-control border border-border bg-card text-foreground hover:bg-accent"
                        style={{
                            top: 'max(0.75rem, env(safe-area-inset-top))',
                            right: 'max(0.75rem, env(safe-area-inset-right))',
                        }}
                        aria-label={t('common.close', '닫기')}
                        onClick={closeImageViewer}
                    >
                        <X className="h-6 w-6" />
                    </Button>
                </div>
            )}
        </div>
        </SceneCompositionWorkspace>
    )
}

import { SceneImageContextMenu } from '@/components/scene/SceneImageContextMenu'

function SceneImageCard({
    image,
    aspectRatio,
    resolutionLabel,
    isEditMode,
    isSelected,
    onSelect,
    onToggleFavorite,
    onDelete,
    onAddRef,
    onLoadMetadata,
    onImageClick,
    onInpaint,
}: {
    image: SceneImage
    aspectRatio: string
    resolutionLabel: string
    isEditMode?: boolean
    isSelected?: boolean
    onSelect?: () => void
    onToggleFavorite: () => void
    onDelete: () => void
    onAddRef?: () => void
    onLoadMetadata?: () => void
    onImageClick?: (imgSrc: string) => void
    onInpaint?: (base64: string) => void
}) {
    const { t } = useTranslation()
    const imgSrc = !image.url || image.url.startsWith('data:')
        ? image.url
        : toNativeAssetUrl(image.url)

    const activateImage = () => {
        if (isEditMode) {
            onSelect?.()
        } else if (imgSrc) {
            onImageClick?.(imgSrc)
        }
    }

    return (
        <SceneImageContextMenu
            image={image}
            onDelete={onDelete}
            onAddRef={onAddRef}
            onLoadMetadata={onLoadMetadata}
            onInpaint={onInpaint}
        >
            <div
                className={cn(
                    "group relative cursor-pointer overflow-hidden rounded-panel border bg-canvas outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    isEditMode && isSelected
                        ? "border-primary ring-2 ring-primary/30"
                        : image.isFavorite
                            ? "border-warning ring-1 ring-warning/40"
                            : "border-border hover:border-primary/60"
                )}
                style={{ aspectRatio }}
                data-scene-preview-resolution={resolutionLabel}
                role="button"
                tabIndex={0}
                aria-pressed={isEditMode ? Boolean(isSelected) : undefined}
                aria-label={isEditMode
                    ? t('scene.toggleImageSelection', '이미지 선택 전환')
                    : t('scene.openImage', '이미지 열기')}
                onClick={activateImage}
                onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        activateImage()
                    }
                }}
            >
                {/* Image */}
                {imgSrc && (
                    <img
                        src={imgSrc}
                        alt={t('scene.generatedImage', '생성된 씬 이미지')}
                        className="h-full w-full object-contain"
                        loading="lazy"
                    />
                )}

                {/* Edit mode selection overlay */}
                {isEditMode && (
                    <div className={cn(
                        "absolute left-2 top-2 flex h-7 w-7 items-center justify-center rounded-control border",
                        isSelected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-card/90 text-muted-foreground"
                    )}>
                        {isSelected && <Check className="h-4 w-4" />}
                    </div>
                )}

                {/* Favorite remains directly reachable on touch; desktop may reveal the inactive state on focus/hover. */}
                {!isEditMode && (
                    <Button
                        variant="ghost"
                        size="icon"
                        className={cn(
                            "absolute right-2 top-2 h-11 w-11 rounded-control border border-border bg-card/90 text-foreground shadow-sm transition-opacity hover:bg-accent lg:h-9 lg:w-9",
                            !image.isFavorite && "lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100"
                        )}
                        aria-label={image.isFavorite
                            ? t('scene.removeFavorite', '즐겨찾기 해제')
                            : t('scene.addFavorite', '즐겨찾기 추가')}
                        onClick={(event) => {
                            event.stopPropagation()
                            onToggleFavorite()
                        }}
                    >
                        <Star className={cn("h-4 w-4", image.isFavorite && "fill-current text-warning")} />
                    </Button>
                )}
            </div>
        </SceneImageContextMenu>
    )
}
