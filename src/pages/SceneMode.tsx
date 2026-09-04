import { useState, useEffect, useMemo, useRef, memo } from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import {
    DndContext,
    pointerWithin,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    DragEndEvent,
    DragStartEvent,
    DragOverlay,
    defaultDropAnimationSideEffects,
    MeasuringStrategy,
} from '@dnd-kit/core'
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    useSortable,
    rectSortingStrategy,
} from '@dnd-kit/sortable'
import { snapCenterToCursor, restrictToVerticalAxis, restrictToParentElement } from '@dnd-kit/modifiers'
import { verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
    Plus,
    Check,
    MoreVertical,
    Trash2,
    Copy,
    ImageIcon,
    Pencil,
    Minus,
    ListPlus,
    ListX,
    Download,
    Edit3,
    X,
    CheckSquare,
    Square,
    FolderInput,
    FolderTree,
    ArrowRight,
    Grid3x3,
    Upload,
    LayoutGrid,
    LayoutList,
    Star,
    ImageOff,
    GripVertical,
    ArrowUpDown,
    Drama,
    UserMinus,
    UserCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tip } from '@/components/ui/tooltip'
import {
    hasSceneCompositionOverrides,
    resolveSceneGeneration,
    useSceneStore,
    type SceneCompositionMode,
    getScenePresetPathSegments,
} from '@/stores/scene-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useGenerationStore } from '@/stores/generation-store'
import { useAssetModuleStore } from '@/stores/asset-module-store'
import { toast } from '@/components/ui/use-toast'
import { toNativeAssetUrl } from '@/platform/asset-url'
import { writeNativeBinaryFile } from '@/platform/native-file-system'
import { saveNativeFileDialog } from '@/platform/native-file-dialog'
import { ExportDialog } from '@/components/scene/ExportDialog'
import { CharacterRotationDialog } from '@/components/scene/CharacterRotationDialog'
import { RotationStatusBar } from '@/components/scene/RotationStatusBar'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog'
import { ResolutionSelector, Resolution } from '@/components/ui/ResolutionSelector'
import { useRotationStore } from '@/stores/character-rotation-store'
import {
    decodeSceneRecipeSelection,
    SCENE_DIRECT_SELECTION_ID,
    sceneAssetRecipeSelectionId,
    type SceneCompositionResolution,
} from '@/lib/composition/scene-adapter'
import { SceneCompositionCardMeta } from '@/components/scene/SceneCompositionControls'
import { SceneCompositionWorkspace } from '@/components/scene/SceneCompositionWorkspace'
import {
    calculateSceneGridVirtualRange,
    SCENE_GRID_VIRTUALIZATION_THRESHOLD,
} from '@/components/scene/scene-grid-virtualization'
import { previewSceneComposition } from '@/lib/scene-generation/build-scene-params'
import { getRuntimeCompositionDocument } from '@/lib/composition-authority'
import { calculateAnlasCost, resolveAnlasPricingBasis } from '@/lib/anlas-calculator'
import { selectActiveCredentialsAreOpus, useAuthStore } from '@/stores/auth-store'
import { useQueueStore } from '@/stores/queue-store'
import {
    enqueueReviewedSceneQueue,
    prepareCurrentSceneQueueReview,
    type PreparedSceneQueueReview,
    type SceneQueueSubmission,
} from '@/services/queue/scene-queue-adapter'
import { SceneQueueReviewDialog } from '@/components/queue/SceneQueueReviewDialog'
import { isSceneQueueReviewConflict } from '@/application/scene/scene-queue-review'
import type {
    CompositionConflictSummary,
    CompositionOverrideDiffItem,
    CompositionValidationSummary,
    ModuleStackItem,
} from '@/components/composition-workspace'
import { portableIssuesForResolvedPlan } from '@/components/composition-workspace'
import { runtimeCapabilities } from '@/platform/capabilities'
import { assessPortableCompositionPlan } from '@/platform/portable-resources'
import { ensureActiveGenerationCredential } from '@/services/generation/credential-guard'
import { SceneFolderManagerDialog } from '@/components/scene/SceneFolderManagerDialog'
import { useTrashStore } from '@/stores/trash-store'
import {
    archiveScene,
    archiveSceneFolder,
    archiveSceneImages,
    archiveScenesIndividually,
} from '@/services/trash/asset-trash-service'

const SCENE_COMPOSITION_MODES: readonly SceneCompositionMode[] = ['legacy', 'shadow', 'v2']

// Persisted mode values remain stable rollout IDs; the workspace presents the
// user-facing purpose of each path so normal Scene authoring does not expose internals.
const SCENE_COMPOSITION_MODE_LABEL_KEYS: Record<SceneCompositionMode, { key: string; fallback: string }> = {
    legacy: { key: 'composition.mode.previous', fallback: 'Previous generation engine' },
    shadow: { key: 'composition.mode.compatibility', fallback: 'Compatibility comparison' },
    v2: { key: 'composition.mode.current', fallback: 'Current generation engine' },
}

const dropAnimation = {
    sideEffects: defaultDropAnimationSideEffects({
        styles: {
            active: {
                opacity: '0.4',
            },
        },
    }),
}

// --- Scene Preset Reorder Dialog ---
function SortablePresetRow({ preset, isActive, listeners, attributes, setNodeRef, style, isDragging, t }: any) {
    return (
        <div
            ref={setNodeRef}
            style={style}
            className={cn(
                "flex min-h-11 items-center gap-2 rounded-control px-2 py-1 transition-colors duration-standard",
                isActive ? "bg-accent text-accent-foreground" : "bg-muted/30 hover:bg-muted/60",
                isDragging && "opacity-50"
            )}
        >
            <div
                {...attributes}
                {...listeners}
                aria-label={t('scene.movePreset', '프리셋 순서 이동')}
                className="flex h-11 w-11 shrink-0 cursor-grab items-center justify-center rounded-control text-muted-foreground hover:bg-accent hover:text-accent-foreground active:cursor-grabbing"
            >
                <GripVertical className="h-4 w-4" />
            </div>
            <span className="flex-1 text-sm font-medium truncate">
                {preset.id === 'scene-default' ? t('scene.presetDefault', '기본') : preset.name}
            </span>
            <span className="text-xs text-muted-foreground">{preset.scenes.length}</span>
            {isActive && (
                <span className="text-xs font-medium text-primary">
                    {t('preset.active', '활성')}
                </span>
            )}
        </div>
    )
}

function SortablePresetWrapper({ preset, isActive, t }: any) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: preset.id })
    const style = { transform: CSS.Transform.toString(transform), transition }
    return <SortablePresetRow preset={preset} isActive={isActive} listeners={listeners} attributes={attributes} setNodeRef={setNodeRef} style={style} isDragging={isDragging} t={t} />
}

function ScenePresetReorderDialog({ presets, activePresetId, onReorder, t }: {
    presets: any[], activePresetId: string | null, onReorder: (oldIndex: number, newIndex: number) => void, t: any
}) {
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    )

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event
        if (over && active.id !== over.id) {
            const oldIndex = presets.findIndex(p => p.id === active.id)
            const newIndex = presets.findIndex(p => p.id === over.id)
            onReorder(oldIndex, newIndex)
        }
    }

    return (
        <Dialog>
            <DialogTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11 shrink-0 text-muted-foreground"
                    aria-label={t('scene.reorderPresets', '프리셋 순서 편집')}
                >
                    <ArrowUpDown className="h-4 w-4" />
                </Button>
            </DialogTrigger>
            <DialogContent className="max-w-sm rounded-panel">
                <DialogHeader>
                    <DialogTitle>{t('scene.reorderPresets', '프리셋 순서 편집')}</DialogTitle>
                </DialogHeader>
                <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={handleDragEnd} modifiers={[restrictToVerticalAxis, restrictToParentElement]}>
                    <SortableContext items={presets.map(p => p.id)} strategy={verticalListSortingStrategy}>
                        <div className="max-h-[60vh] space-y-1 overflow-y-auto">
                            {presets.map(preset => (
                                <SortablePresetWrapper key={preset.id} preset={preset} isActive={activePresetId === preset.id} t={t} />
                            ))}
                        </div>
                    </SortableContext>
                </DndContext>
            </DialogContent>
        </Dialog>
    )
}

export default function SceneMode() {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const activeCredentialsAreOpus = useAuthStore(selectActiveCredentialsAreOpus)
    // const { token } = useAuthStore()
    // const { savePath } = useSettingsStore()

    // Granular selectors to prevent re-renders on unrelated store changes (like streaming progress)
    const presets = useSceneStore(s => s.presets)
    const activePresetId = useSceneStore(s => s.activePresetId)
    const setActivePreset = useSceneStore(s => s.setActivePreset)
    const addPreset = useSceneStore(s => s.addPreset)
    const deletePreset = useSceneStore(s => s.deletePreset)
    const activePreset = useSceneStore(s => s.presets.find(p => p.id === s.activePresetId))
    const scenes = activePreset?.scenes || []
    const scrollPosition = useSceneStore(s => s.scrollPosition)
    
    // Scroll container ref
    const scrollContainerRef = useRef<HTMLDivElement>(null)
    const [sceneGridScrollTop, setSceneGridScrollTop] = useState(0)
    const [sceneGridViewport, setSceneGridViewport] = useState({ width: 960, height: 720 })
    const gridColumns = useSceneStore(s => s.gridColumns)
    const setGridColumns = useSceneStore(s => s.setGridColumns)
    const thumbnailLayout = useSceneStore(s => s.thumbnailLayout)
    const setThumbnailLayout = useSceneStore(s => s.setThumbnailLayout)

    // Actions needed for SceneMode local logic
    const addScene = useSceneStore(s => s.addScene)
    const renamePreset = useSceneStore(s => s.renamePreset)
    const reorderScenes = useSceneStore(s => s.reorderScenes)
    const reorderPresets = useSceneStore(s => s.reorderPresets)
    const isGenerating = useSceneStore(s => s.isGenerating)
    const isCancelling = useSceneStore(s => s.isCancelling)
    const startNewGenerationSession = useSceneStore(s => s.startNewGenerationSession)
    const queueExecutionAuthority = useQueueStore(s => s.executionAuthority)
    const selectDurableBatch = useQueueStore(s => s.setSelectedBatchId)
    const [sceneQueueReview, setSceneQueueReview] = useState<PreparedSceneQueueReview | null>(null)
    const cancelSceneGeneration = useSceneStore(s => s.cancelSceneGeneration)
    const importPreset = useSceneStore(s => s.importPreset)
    const rotationActive = useRotationStore(s => s.active)

    const addAllToQueue = useSceneStore(s => s.addAllToQueue)
    const clearAllQueue = useSceneStore(s => s.clearAllQueue)
    const getTotalQueueCount = useSceneStore(s => s.getTotalQueueCount)
    const batchCount = useGenerationStore(s => s.batchCount)

    const totalQueue = activePresetId ? getTotalQueueCount(activePresetId) : 0

    // Edit Mode (Multi-Select)
    const isEditMode = useSceneStore(s => s.isEditMode)
    const setEditMode = useSceneStore(s => s.setEditMode)
    const selectedSceneIds = useSceneStore(s => s.selectedSceneIds)
    const selectAllScenes = useSceneStore(s => s.selectAllScenes)
    const clearSelection = useSceneStore(s => s.clearSelection)
    const deleteScene = useSceneStore(s => s.deleteScene)
    const moveSelectedScenesToPreset = useSceneStore(s => s.moveSelectedScenesToPreset)
    const updateSelectedScenesResolution = useSceneStore(s => s.updateSelectedScenesResolution)
    const clearAllFavorites = useSceneStore(s => s.clearAllFavorites)
    const deleteAllImages = useSceneStore(s => s.deleteAllImages)
    const addToTrash = useTrashStore(state => state.add)
    const sceneCompositionMode = useSceneStore(s => s.sceneCompositionMode)
    const setSceneCompositionMode = useSceneStore(s => s.setSceneCompositionMode)
    const sceneCompositionResults = useSceneStore(s => s.sceneCompositionResults)
    const setSceneCompositionRef = useSceneStore(s => s.setSceneCompositionRef)
    const assetRecipes = useAssetModuleStore(s => s.profile.recipes)
    const assetModules = useAssetModuleStore(s => s.profile.modules)
    const assetProfileRevision = useAssetModuleStore(s => s.profile.revision)
    const assetHasConflict = useAssetModuleStore(s => s.hasConflict)
    const assetConflictMessage = useAssetModuleStore(s => s.conflictMessage)
    const generatingMode = useGenerationStore(s => s.generatingMode)

    // Resolution state for selected scenes
    const [editModeResolution, setEditModeResolution] = useState<Resolution>({
        label: '인물 (세로)',
        width: 832,
        height: 1216
    })
    const [bulkRecipeId, setBulkRecipeId] = useState<string>(SCENE_DIRECT_SELECTION_ID)
    const [activeModuleId, setActiveModuleId] = useState<string | null>(null)
    const [compositionPreviewLoading, setCompositionPreviewLoading] = useState(false)
    const [compositionPreview, setCompositionPreview] = useState<SceneCompositionResolution | null>(null)
    const [compositionPreviewError, setCompositionPreviewError] = useState<string | null>(null)

    useEffect(() => {
        const viewport = scrollContainerRef.current
        if (!viewport) return
        const measure = () => setSceneGridViewport({
            width: viewport.clientWidth || 960,
            height: viewport.clientHeight || 720,
        })
        measure()
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
        observer?.observe(viewport)
        return () => observer?.disconnect()
    }, [])

    const sceneGridColumnCount = sceneGridViewport.width < 640
        ? 1
        : sceneGridViewport.width < 1024
            ? 2
            : gridColumns
    const sceneGridCardWidth = Math.max(
        240,
        (sceneGridViewport.width - ((sceneGridColumnCount - 1) * 12) - 8) / sceneGridColumnCount,
    )
    const sceneGridEstimatedRowHeight = Math.ceil(
        (thumbnailLayout === 'vertical' ? sceneGridCardWidth * 1.5 : sceneGridCardWidth * (2 / 3)) + 220,
    )
    const sceneGridVirtualized = scenes.length >= SCENE_GRID_VIRTUALIZATION_THRESHOLD
    const sceneGridVirtualRange = useMemo(() => sceneGridVirtualized
        ? calculateSceneGridVirtualRange({
            itemCount: scenes.length,
            columnCount: sceneGridColumnCount,
            scrollTop: sceneGridScrollTop,
            viewportHeight: sceneGridViewport.height,
            rowHeight: sceneGridEstimatedRowHeight,
        })
        : {
            startRow: 0,
            endRow: Math.ceil(scenes.length / sceneGridColumnCount),
            startIndex: 0,
            endIndex: scenes.length,
            paddingTop: 0,
            paddingBottom: 0,
        }, [
        sceneGridColumnCount,
        sceneGridEstimatedRowHeight,
        sceneGridScrollTop,
        sceneGridViewport.height,
        sceneGridVirtualized,
        scenes.length,
    ])
    const visibleScenes = sceneGridVirtualized
        ? scenes.slice(sceneGridVirtualRange.startIndex, sceneGridVirtualRange.endIndex)
        : scenes

    const handleApplyResolutionToSelected = () => {
        updateSelectedScenesResolution(editModeResolution.width, editModeResolution.height)
        toast({ description: t('scene.resolutionApplied', { count: selectedSceneIds.length, width: editModeResolution.width, height: editModeResolution.height }) })
    }

    const runtimeDocument = useMemo(
        () => getRuntimeCompositionDocument(),
        [assetProfileRevision],
    )
    const selectedRecipe = decodeSceneRecipeSelection(bulkRecipeId)
    const selectedRuntimeRecipe = selectedRecipe.selectionKind === 'asset'
        ? runtimeDocument?.recipes.find(recipe => recipe.id === selectedRecipe.recipeId)
        : undefined
    const selectedLegacyRecipe = selectedRecipe.selectionKind === 'asset'
        ? assetRecipes.find(recipe => recipe.id === selectedRecipe.recipeId)
        : undefined
    const workspaceModules = useMemo<ModuleStackItem[]>(() => {
        if (runtimeDocument) {
            const selectedIds = selectedRuntimeRecipe
                ? new Set(selectedRuntimeRecipe.steps.filter(step => step.enabled).map(step => step.moduleId))
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
        }

        const selectedIds = selectedLegacyRecipe
            ? new Set(selectedLegacyRecipe.steps.filter(step => step.enabled !== false).map(step => step.moduleId))
            : null
        return Object.values(assetModules)
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
    }, [assetModules, runtimeDocument, selectedLegacyRecipe, selectedRuntimeRecipe])

    useEffect(() => {
        if (activeModuleId && workspaceModules.some(module => module.id === activeModuleId)) return
        setActiveModuleId(workspaceModules[0]?.id ?? null)
    }, [activeModuleId, workspaceModules])

    const compositionRecords = scenes
        .map(scene => sceneCompositionResults[scene.id])
        .filter((record): record is NonNullable<typeof record> => Boolean(record))
    const compositionErrorCount = compositionRecords.reduce((count, record) => count + record.errors.length, 0)
    const compositionWarningCount = compositionRecords.reduce((count, record) => count + record.warnings.length, 0)
    const validation: CompositionValidationSummary = assetHasConflict
        ? { severity: 'conflict', errorCount: 1, label: t('composition.conflict.label', 'Conflict') }
        : compositionErrorCount > 0
            ? { severity: 'error', errorCount: compositionErrorCount, warningCount: compositionWarningCount }
            : compositionWarningCount > 0
                ? { severity: 'warning', warningCount: compositionWarningCount }
                : sceneCompositionMode === 'legacy'
                    ? { severity: 'disabled', label: t('composition.validation.legacy', 'Previous generation mode') }
                    : { severity: 'valid' }
    const estimatedCost = scenes.reduce((sum, scene) => {
        if (scene.queueCount <= 0) return sum
        const generation = resolveSceneGeneration(scene)
        const pricingBasis = resolveAnlasPricingBasis({
            model: generation.model,
            activeCredentialsAreOpus,
        })
        return sum + calculateAnlasCost({
            model: generation.model,
            width: scene.width ?? 832,
            height: scene.height ?? 1216,
            steps: generation.steps,
            imageCount: 1,
            pricingBasis,
        }) * scene.queueCount
    }, 0)
    const generationConflict = Boolean(generatingMode && generatingMode !== 'scene')
    const conflict: CompositionConflictSummary | null = assetHasConflict
        ? {
            severity: 'error',
            title: t('composition.externalConflict', 'External composition edit'),
            message: assetConflictMessage || t('composition.externalConflictDescription', 'Resolve the repository revision conflict before editing.'),
            revision: `asset-profile@${assetProfileRevision}`,
        }
        : generationConflict
            ? {
                severity: 'warning',
                title: t('generate.conflictTitle', 'Another workflow is generating'),
                message: t('generate.conflictDescription', 'Wait for the active generation workflow to finish or cancel it there.'),
                revision: generatingMode || undefined,
            }
            : null
    const overrideSceneCount = scenes.filter(scene => hasSceneCompositionOverrides(scene)).length
    const overrideDiff: CompositionOverrideDiffItem[] = [
        {
            id: 'recipe',
            label: t('scene.composition.recipe', 'Recipe'),
            inheritedValue: t('scene.composition.inherited', 'Default'),
            overrideValue: selectedLegacyRecipe?.label || selectedRuntimeRecipe?.name || selectedRecipe.recipeId,
            changed: selectedRecipe.selectionKind !== 'direct',
        },
        {
            id: 'scene-overrides',
            label: t('scene.composition.override', 'Override'),
            inheritedValue: '0',
            overrideValue: String(overrideSceneCount),
            changed: overrideSceneCount > 0,
        },
        {
            id: 'queue',
            label: t('scene.queue', 'Queue'),
            inheritedValue: '0',
            overrideValue: String(totalQueue),
            changed: totalQueue > 0,
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

    const handleWorkspaceRecipeChange = (selectionValue: string) => {
        setBulkRecipeId(selectionValue)
        setCompositionPreview(null)
        setCompositionPreviewError(null)
        if (!activePresetId || isGenerating) return

        const selection = decodeSceneRecipeSelection(selectionValue)
        const targetIds = isEditMode && selectedSceneIds.length > 0
            ? selectedSceneIds
            : scenes.map(scene => scene.id)
        for (const sceneId of targetIds) {
            const currentScene = scenes.find(scene => scene.id === sceneId)
            setSceneCompositionRef(activePresetId, sceneId, {
                ...currentScene?.compositionRef,
                recipeId: selection.recipeId,
                selectionKind: selection.selectionKind,
                recipeRevision: assetProfileRevision,
            })
        }
        toast({
            description: t('scene.composition.bulkApplied', 'Recipe applied to {{count}} scenes', {
                count: targetIds.length,
            }),
        })
    }

    const handleOpenResolvedPlan = async () => {
        const targetScene = scenes.find(scene => selectedSceneIds.includes(scene.id))
            ?? scenes.find(scene => scene.queueCount > 0)
            ?? scenes[0]
        setCompositionPreviewLoading(true)
        setCompositionPreview(null)
        setCompositionPreviewError(null)
        if (!targetScene) {
            setCompositionPreviewError(t('scene.noScenes', 'No scenes'))
            setCompositionPreviewLoading(false)
            return
        }
        try {
            setCompositionPreview(await previewSceneComposition(targetScene))
        } catch (error) {
            setCompositionPreviewError(error instanceof Error ? error.message : String(error))
        } finally {
            setCompositionPreviewLoading(false)
        }
    }

    const handleSceneGenerate = () => {
        if (rotationActive) {
            useRotationStore.getState().stop({ reason: 'scene workspace stop', keepSnapshot: true })
            return
        }
        if (isGenerating || isCancelling) {
            cancelSceneGeneration()
            return
        }
        if (totalQueue <= 0) return
        if (!ensureActiveGenerationCredential()) {
            toast({
                title: t('credentialVault.unlockRequired', 'API 토큰 잠금 해제 필요'),
                description: t('credentialVault.unlockRequiredForGeneration', '이미지를 생성하려면 NovelAI API 토큰 보관소를 잠금 해제하세요.'),
            })
            return
        }
        if (queueExecutionAuthority === 'legacy') {
            startNewGenerationSession()
            return
        }
        void prepareCurrentSceneQueueReview().then(setSceneQueueReview).catch(error => {
            toast({
                title: t('common.error', 'Error'),
                description: error instanceof Error ? error.message : t('queue.enqueueFailed', 'Queue enqueue failed'),
                variant: 'destructive',
            })
        })
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

    const [newPresetName, setNewPresetName] = useState('')
    // const [isExporting, setIsExporting] = useState(false) // Removed unused state
    const [activeId, setActiveId] = useState<string | null>(null)
    const [isRenamingPreset, setIsRenamingPreset] = useState(false)
    const [showFolderManager, setShowFolderManager] = useState(false)

    // Generation Store values - used by export logic or future features?
    // Left empty for now as logic moved to hook

    // Note: useSceneGeneration() is now called at App level for persistence across navigation

    // Restore scroll position when returning from detail page
    useEffect(() => {
        if (scrollContainerRef.current && scrollPosition > 0) {
            scrollContainerRef.current.scrollTop = scrollPosition
            setSceneGridScrollTop(scrollPosition)
        }
    }, []) // Only on mount

    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: { distance: 8 },
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    )

    const handleDragStart = (event: DragStartEvent) => {
        setActiveId(event.active.id as string)
    }

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event
        if (over && active.id !== over.id && activePresetId) {
            const oldIndex = scenes.findIndex((item) => item.id === active.id)
            const newIndex = scenes.findIndex((item) => item.id === over.id)
            reorderScenes(activePresetId, arrayMove(scenes, oldIndex, newIndex))
        }
        setActiveId(null)
    }

    const handleAddScene = () => {
        if (activePresetId) {
            const sceneCount = scenes.length + 1
            // addScene materializes the folder template before navigation so the editor opens prefilled.
            const sceneId = addScene(activePresetId, t('scene.defaultName', '씬 {{num}}', { num: sceneCount }))
            navigate(`/scenes/${sceneId}`)
        }
    }

    const handleAddPreset = () => {
        if (newPresetName.trim()) {
            addPreset(newPresetName.trim())
            setNewPresetName('')
        }
    }

    const [isDragOver, setIsDragOver] = useState(false)
    const dragCounter = useRef(0)
    const fileInputRef = useRef<HTMLInputElement>(null)

    // JSON Import via file picker
    const handleImportClick = () => {
        fileInputRef.current?.click()
    }

    const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files
        if (!files || files.length === 0) return

        let importedCount = 0
        for (const file of Array.from(files)) {
            if (file.name.toLowerCase().endsWith('.json')) {
                try {
                    const text = await file.text()
                    const json = JSON.parse(text)
                    importPreset(json)
                    importedCount++
                } catch (err) {
                    console.error("Failed to parse preset JSON", err)
                }
            }
        }

        if (importedCount > 0) {
            toast({ description: t('scene.imported', { count: importedCount }) })
        }

        // Reset input value to allow re-selecting same file
        e.target.value = ''
    }

    // --- Import Logic (DnD) ---
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
    }

    const handleDrop = async (e: React.DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
        setIsDragOver(false)
        dragCounter.current = 0

        const files = Array.from(e.dataTransfer.files)
        if (files.length === 0) return

        let importedCount = 0
        for (const file of files) {
            // Check file extension .json
            if (file.name.toLowerCase().endsWith('.json')) {
                try {
                    const text = await file.text()
                    const json = JSON.parse(text)

                    // importPreset handles all formats:
                    // - Case A: Array format (scene_preset_export.json)
                    // - Case B: Scenes object format (NAI 에셋봇)
                    // - Case C: SDImageGenEasy presets
                    // - Case D: Standard NAI Blue ScenePreset format
                    importPreset(json)
                    importedCount++
                } catch (err) {
                    console.error("Failed to parse preset JSON", err)
                }
            }
        }

        if (importedCount > 0) {
            toast({ description: t('scene.imported', { count: importedCount }) })
        }
    }

    const handleToggleGrid = () => {
        // Cycle: 4 -> 5 -> 2 -> 3 -> 4
        // Default sequence requested: 2 -> 3 -> 4 -> 5 -> 2
        // Assuming current logic cycle
        const next = gridColumns >= 5 ? 2 : gridColumns + 1
        setGridColumns(next)
    }

    const [showExportDialog, setShowExportDialog] = useState(false)
    const [exportScenesFilter, setExportScenesFilter] = useState<'all' | 'selected'>('all')
    const [showDeletePresetDialog, setShowDeletePresetDialog] = useState(false)
    const [showDeleteSelectedScenesDialog, setShowDeleteSelectedScenesDialog] = useState(false)
    const [showDeleteSelectedImagesDialog, setShowDeleteSelectedImagesDialog] = useState(false)
    const [showRotationDialog, setShowRotationDialog] = useState(false)

    // Scenes to export based on filter
    const scenesToExport = exportScenesFilter === 'selected'
        ? scenes.filter(s => selectedSceneIds.includes(s.id))
        : scenes

    const handleExportSelectedZip = () => {
        if (selectedSceneIds.length === 0) {
            toast({ title: t('scene.noImagesToExport', '내보낼 이미지가 없습니다'), variant: 'destructive' })
            return
        }
        setExportScenesFilter('selected')
        setShowExportDialog(true)
    }

    // --- Export Logic ---
    const handleExportJson = async () => {
        if (!activePreset) return
        try {
            const fileName = `NAI_Blue_Preset_${activePreset.name}_${Date.now()}.json`
            const filePath = await saveNativeFileDialog({
                defaultPath: fileName,
                filters: [{ name: 'JSON File', extensions: ['json'] }]
            })

            if (filePath) {
                // 이미지 데이터 제외하고 씬 정보만 내보내기 (공유용)
                const exportData = {
                    ...activePreset,
                    scenes: activePreset.scenes.map(scene => ({
                        ...scene,
                        images: [],  // 이미지 제거
                        queueCount: 0  // 대기열도 초기화
                    }))
                }
                const content = JSON.stringify(exportData, null, 2)
                const encoder = new TextEncoder()
                await writeNativeBinaryFile(filePath, encoder.encode(content))
                toast({ title: t('common.saved', '저장됨'), variant: 'success' })
            }
        } catch (e) {
            console.error('Export JSON failed', e)
            toast({ title: t('common.error'), variant: 'destructive' })
        }
    }

    const handleExportZip = () => {
        if (!activePresetId || scenes.length === 0) {
            toast({ title: t('scene.noImagesToExport', '내보낼 이미지가 없습니다'), variant: 'destructive' })
            return
        }
        setShowExportDialog(true)
    }

    const handleClearSelectedFavorites = () => {
        if (!activePresetId) return

        let totalCount = 0
        for (const sceneId of selectedSceneIds) {
            totalCount += clearAllFavorites(activePresetId, sceneId)
        }
        if (totalCount > 0) {
            toast({ description: t('scene.clearedFavorites', '{{count}}개 즐겨찾기 해제됨', { count: totalCount }) })
        }
    }

    /**
     * Depends on the selected Scene ids and defers the existing store removal
     * until each file has a trash snapshot. This keeps multi-scene image
     * deletion on the same 30-day retention path as single-image deletion.
     */
    const moveSelectedImagesToTrash = async () => {
        if (!activePresetId || !activePreset) return
        try {
            let totalCount = 0
            for (const sceneId of selectedSceneIds) {
                const scene = activePreset.scenes.find(candidate => candidate.id === sceneId)
                if (!scene) continue
                const trashItems = await archiveSceneImages(scene.images, {
                    presetId: activePreset.id,
                    presetName: activePreset.name,
                    sceneId: scene.id,
                    sceneName: scene.name,
                })
                trashItems.forEach(addToTrash)
                totalCount += deleteAllImages(activePresetId, sceneId).count
            }
            if (totalCount > 0) {
                toast({ title: t('trash.moved', '휴지통으로 이동했습니다.'), variant: 'success' })
            }
        } catch (error) {
            console.error('Failed to move selected scene images to trash:', error)
            toast({ title: t('common.error', '오류'), variant: 'destructive' })
        }
    }

    const moveSelectedScenesToTrash = async () => {
        if (!activePresetId || !activePreset) return
        const selectedScenes = activePreset.scenes.filter(scene => selectedSceneIds.includes(scene.id))
        const { archivedSceneIds, failedSceneIds } = await archiveScenesIndividually(
            selectedScenes,
            activePreset,
            addToTrash,
            sceneId => deleteScene(activePresetId, sceneId),
        )
        // The per-scene archive commit above means the remaining selection is
        // always retryable: successfully archived cards disappear, failed cards
        // stay selected without pointing at files that were already moved.
        useSceneStore.setState({
            selectedSceneIds: failedSceneIds,
            lastSelectedSceneId: failedSceneIds.length > 0 ? failedSceneIds[failedSceneIds.length - 1] : null,
        })
        if (archivedSceneIds.length > 0) {
            toast({ title: t('trash.moved', '휴지통으로 이동했습니다.'), variant: 'success' })
        }
        if (failedSceneIds.length > 0) {
            toast({ title: t('common.error', '오류'), variant: 'destructive' })
        }
    }

    const moveActivePresetToTrash = async () => {
        if (!activePreset || activePreset.id === 'scene-default') return
        try {
            const trashItem = await archiveSceneFolder(activePreset.id, presets)
            if (!trashItem) return
            addToTrash(trashItem)
            deletePreset(activePreset.id)
            toast({ title: t('trash.moved', '휴지통으로 이동했습니다.'), variant: 'success' })
        } catch (error) {
            console.error('Failed to move Scene folder to trash:', error)
            toast({ title: t('common.error', '오류'), variant: 'destructive' })
        }
    }

    const activeItem = activeId ? scenes.find(s => s.id === activeId) : null

    return (
        <SceneCompositionWorkspace
            simplified
            mode={{
                value: sceneCompositionMode,
                label: t('scene.composition.mode', 'Mode'),
                options: SCENE_COMPOSITION_MODES.map(mode => ({
                    value: mode,
                    label: t(
                        SCENE_COMPOSITION_MODE_LABEL_KEYS[mode].key,
                        SCENE_COMPOSITION_MODE_LABEL_KEYS[mode].fallback,
                    ),
                })),
                onChange: value => setSceneCompositionMode(value as SceneCompositionMode),
                disabled: isGenerating,
            }}
            recipe={{
                value: bulkRecipeId,
                label: t('scene.composition.recipe', 'Recipe'),
                options: [
                    { value: SCENE_DIRECT_SELECTION_ID, label: t('composition.recipe.direct', 'Direct prompts') },
                    ...assetRecipes.map(recipe => ({
                        value: sceneAssetRecipeSelectionId(recipe.id),
                        label: recipe.label || recipe.id,
                        disabled: !recipe.enabled,
                    })),
                ],
                onChange: handleWorkspaceRecipeChange,
                disabled: isGenerating,
            }}
            validation={validation}
            cost={{ value: `${estimatedCost}`, label: 'Anlas', severity: estimatedCost > 0 ? 'warning' : 'normal' }}
            generation={{
                generating: isGenerating || isCancelling || rotationActive,
                disabled: isCancelling || (!isGenerating && !rotationActive && (totalQueue === 0 || generationConflict)),
                progressLabel: isCancelling ? t('generate.cancelling', 'Cancelling…') : undefined,
                generateLabel: t('scene.generateAll', 'Generate scenes'),
                cancelLabel: t('generate.cancel', 'Cancel'),
                actionTestId: 'scene-generate-action',
                cancelTestId: 'scene-cancel-action',
                onGenerate: handleSceneGenerate,
                onCancel: handleSceneGenerate,
            }}
            modules={workspaceModules}
            activeModuleId={activeModuleId}
            recipeName={selectedLegacyRecipe?.label || selectedRuntimeRecipe?.name || selectedRecipe.recipeId}
            resolvedPlan={resolvedPlan}
            resolvedIssues={resolvedIssues}
            resolvedLoading={compositionPreviewLoading}
            resolvedError={compositionPreviewError}
            resolvedAvailable={scenes.length > 0}
            conflict={conflict}
            overrideDiff={overrideDiff}
            inspectorChildren={(
                <section className="p-3 pt-5" aria-label={t('scene.queueStatus', 'Queue status')}>
                    <dl className="grid grid-cols-2 gap-3 text-xs">
                        <div className="min-w-0">
                            <dt className="text-muted-foreground">{t('scene.sceneCount', 'Scenes')}</dt>
                            <dd className="mt-1 font-mono font-semibold tabular-nums">{scenes.length}</dd>
                        </div>
                        <div className="min-w-0">
                            <dt className="text-muted-foreground">{t('scene.queue', 'Queue')}</dt>
                            <dd className="mt-1 font-mono font-semibold tabular-nums">{totalQueue}</dd>
                        </div>
                    </dl>
                </section>
            )}
            onSelectModule={setActiveModuleId}
            onOpenResolved={handleOpenResolvedPlan}
        >
            <div
                className="relative flex h-full min-h-0 min-w-0 flex-col gap-2 overflow-hidden p-1 sm:gap-3"
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                data-testid="scene-grid-workspace"
            >
            {/* DESIGN.md responsive contract: compact groups wrap as rows so every existing command stays reachable without page-level horizontal scroll. */}
            {isEditMode ? (
                <div className="grid min-w-0 gap-2 rounded-panel bg-accent/40 p-2 lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center lg:p-3">
                    <div className="flex min-w-0 items-center gap-2">
                        <Tip content={t('scene.exitEditMode', '편집 종료')} shortcut="Esc">
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-11 w-11 shrink-0 text-primary"
                                aria-label={t('scene.exitEditMode', '편집 종료')}
                                onClick={() => { setEditMode(false); clearSelection() }}
                            >
                                <X className="h-4 w-4" />
                            </Button>
                        </Tip>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary" aria-live="polite">
                            {t('scene.selectedCount', { count: selectedSceneIds.length })}
                        </span>
                        <Tip content={t('scene.selectAll', '전체 선택')} shortcut="Ctrl+A">
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-11 w-11 shrink-0"
                                aria-label={t('scene.selectAll', '전체 선택')}
                                onClick={selectAllScenes}
                                disabled={scenes.length === 0}
                            >
                                <CheckSquare className="h-4 w-4" />
                            </Button>
                        </Tip>
                        <Tip content={t('scene.deselectAll', '선택 해제')}>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-11 w-11 shrink-0"
                                aria-label={t('scene.deselectAll', '선택 해제')}
                                onClick={clearSelection}
                                disabled={selectedSceneIds.length === 0}
                            >
                                <Square className="h-4 w-4" />
                            </Button>
                        </Tip>
                    </div>

                    <div className="grid min-w-0 gap-2 xl:grid-cols-2">
                        <div className="flex min-w-0 items-center gap-2">
                            <div className="min-w-0 flex-1">
                                <ResolutionSelector
                                    value={editModeResolution}
                                    onChange={setEditModeResolution}
                                    disabled={selectedSceneIds.length === 0}
                                />
                            </div>
                            <Tip content={t('scene.applyResolution', '선택한 씬에 해상도 적용')}>
                                <Button
                                    variant="secondary"
                                    size="icon"
                                    className="h-11 w-11 shrink-0"
                                    aria-label={t('scene.applyResolution', '선택한 씬에 해상도 적용')}
                                    onClick={handleApplyResolutionToSelected}
                                    disabled={selectedSceneIds.length === 0}
                                >
                                    <Check className="h-4 w-4" />
                                </Button>
                            </Tip>
                        </div>

                        <div className="flex min-h-11 items-center rounded-control bg-canvas px-3 text-xs text-muted-foreground">
                            {t('scene.editSceneSettingsIndividually', '프롬프트와 생성 설정은 각 씬에 들어가서 편집합니다.')}
                        </div>
                    </div>

                    <div className="grid grid-cols-5 gap-2 lg:flex lg:justify-end">
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    variant="outline"
                                    size="icon"
                                    className="h-11 w-full min-w-0 lg:w-11"
                                    aria-label={t('scene.moveToPreset', '프리셋으로 이동')}
                                    disabled={selectedSceneIds.length === 0 || presets.length < 2}
                                >
                                    <FolderInput className="h-4 w-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent className="max-h-[60vh] overflow-y-auto">
                                {presets.filter(p => p.id !== activePresetId).map(p => (
                                    <DropdownMenuItem key={p.id} className="min-h-11" onClick={() => moveSelectedScenesToPreset(p.id)}>
                                        <ArrowRight className="mr-2 h-4 w-4" />
                                        {p.name}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <Tip content={t('scene.deleteSelected', '선택 삭제')} shortcut="Del">
                            <Button
                                variant="destructive"
                                size="icon"
                                className="h-11 w-full min-w-0 lg:w-11"
                                aria-label={t('scene.deleteSelected', '선택 삭제')}
                                onClick={() => setShowDeleteSelectedScenesDialog(true)}
                                disabled={selectedSceneIds.length === 0}
                            >
                                <Trash2 className="h-4 w-4" />
                            </Button>
                        </Tip>
                        <Tip content={t('scene.clearAllFavoritesInSelected', '선택된 씬들의 즐겨찾기 전체 해제')}>
                            <Button
                                variant="outline"
                                size="icon"
                                className="h-11 w-full min-w-0 lg:w-11"
                                aria-label={t('scene.clearAllFavoritesInSelected', '선택된 씬들의 즐겨찾기 전체 해제')}
                                onClick={handleClearSelectedFavorites}
                                disabled={selectedSceneIds.length === 0}
                            >
                                <Star className="h-4 w-4" />
                            </Button>
                        </Tip>
                        <Tip content={t('scene.deleteAllImagesInSelected', '선택된 씬들의 이미지 전체 삭제')}>
                            <Button
                                variant="outline"
                                size="icon"
                                className="h-11 w-full min-w-0 text-destructive hover:bg-destructive/10 hover:text-destructive lg:w-11"
                                aria-label={t('scene.deleteAllImagesInSelected', '선택된 씬들의 이미지 전체 삭제')}
                                onClick={() => setShowDeleteSelectedImagesDialog(true)}
                                disabled={selectedSceneIds.length === 0}
                            >
                                <ImageOff className="h-4 w-4" />
                            </Button>
                        </Tip>
                        <Tip content={t('scene.exportSelectedZip', '선택한 씬 이미지 ZIP 내보내기')}>
                            <Button
                                variant="outline"
                                size="icon"
                                className="h-11 w-full min-w-0 lg:w-11"
                                aria-label={t('scene.exportSelectedZip', '선택한 씬 이미지 ZIP 내보내기')}
                                onClick={handleExportSelectedZip}
                                disabled={selectedSceneIds.length === 0}
                            >
                                <Download className="h-4 w-4" />
                            </Button>
                        </Tip>
                    </div>
                </div>
            ) : (
                <div className="flex min-w-0 items-center gap-2">
                    <h1 className="min-w-0 flex-1 truncate text-xl font-semibold sm:text-2xl">{t('scene.title')}</h1>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".json"
                        multiple
                        className="hidden"
                        onChange={handleFileInputChange}
                    />
                    <Button
                        variant="outline"
                        className="h-11 shrink-0 px-3"
                        aria-label={t('scene.folderManager.title', '씬 폴더 관리')}
                        onClick={() => setShowFolderManager(true)}
                        disabled={isGenerating || rotationActive}
                    >
                        <FolderTree className="h-4 w-4 sm:mr-2" />
                        <span className="hidden sm:inline">{t('scene.folderManager.title', '씬 폴더 관리')}</span>
                    </Button>
                    <Button
                        size="icon"
                        className="h-11 w-11 shrink-0 sm:w-auto sm:px-3"
                        aria-label={t('scene.addScene')}
                        onClick={handleAddScene}
                        disabled={!activePresetId || isGenerating}
                    >
                        <Plus className="h-4 w-4 sm:mr-2" />
                        <span className="hidden sm:inline">{t('scene.addScene')}</span>
                    </Button>
                    <Button
                        variant="outline"
                        className="h-11 shrink-0 px-3"
                        aria-label={t('scene.editMode', '여러 씬을 선택하여 일괄 편집')}
                        onClick={() => setEditMode(true)}
                        disabled={scenes.length === 0 || isGenerating}
                    >
                        <Edit3 className="mr-2 h-4 w-4" />
                        {t('common.edit', '편집')}
                    </Button>
                    {/* Compact grouping keeps import, rotation, queue, export, and sharing one tap away instead of hiding commands for the mobile audit. */}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="outline"
                                size="icon"
                                className="h-11 w-11 shrink-0"
                                aria-label={t('common.moreActions', '더보기 메뉴')}
                            >
                                <MoreVertical className="h-4 w-4" />
                                <span className="sr-only">{t('common.moreActions', '더보기 메뉴')}</span>
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-64">
                            <DropdownMenuItem className="min-h-11" onClick={handleImportClick} disabled={isGenerating}>
                                <Upload className="mr-3 h-4 w-4" />
                                {t('scene.importJson', 'JSON 불러오기')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                className="min-h-11"
                                onClick={() => setShowRotationDialog(true)}
                                disabled={(scenes.length === 0 && !rotationActive) || (isGenerating && !rotationActive)}
                            >
                                <Drama className="mr-3 h-4 w-4" />
                                {rotationActive ? '캐릭터 로테이션 상태 보기' : '캐릭터 로테이션 시작'}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                                className="min-h-11"
                                onClick={() => activePresetId && addAllToQueue(activePresetId, batchCount)}
                                disabled={scenes.length === 0 || isGenerating}
                            >
                                <ListPlus className="mr-3 h-4 w-4" />
                                {t('scene.addAllQueue', '모든 씬 생성 대기열에 추가')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                className="min-h-11 text-destructive focus:text-destructive"
                                onClick={() => activePresetId && clearAllQueue(activePresetId)}
                                disabled={totalQueue === 0 || isGenerating}
                            >
                                <ListX className="mr-3 h-4 w-4" />
                                {t('scene.clearAllQueue', '모든 대기열 초기화')}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem className="min-h-11" onClick={handleExportJson} disabled={!activePreset || isGenerating}>
                                <Copy className="mr-3 h-4 w-4" />
                                {t('scene.exportJson', '씬 데이터를 JSON으로 내보내기')}
                            </DropdownMenuItem>
                            <DropdownMenuItem className="min-h-11" onClick={handleExportZip} disabled={scenes.length === 0}>
                                <Download className="mr-3 h-4 w-4" />
                                {t('scene.exportZip', '모든 씬 이미지 ZIP 내보내기')}
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            )}

            <div className="min-w-0 [&>div]:min-w-0 [&>div]:flex-wrap [&>div]:!rounded-panel [&>div]:!shadow-none [&>div>div:last-child]:flex-wrap">
                <RotationStatusBar />
            </div>

            {isDragOver && (
                <div
                    className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-scrim/70 p-4"
                    role="status"
                    aria-live="polite"
                >
                    <div className="flex max-w-md items-center gap-4 rounded-panel bg-popover p-6 text-popover-foreground shadow-overlay">
                        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-control bg-primary text-primary-foreground">
                            <Download className="h-6 w-6" />
                        </div>
                        <div className="min-w-0">
                            <p className="text-base font-semibold">{t('scene.dropImport', '프리셋 파일 놓기')}</p>
                            <p className="mt-1 text-sm text-muted-foreground">
                                {t('scene.dropImportDesc', 'JSON 파일을 드롭하여 프리셋을 불러오세요')}
                            </p>
                        </div>
                    </div>
                </div>
            )}

            <div className="grid min-w-0 gap-2 rounded-panel bg-card p-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="flex min-w-0 items-center gap-2">
                    {isRenamingPreset ? (
                        <div className="min-w-0 flex-1">
                            <PresetRenameInput
                                initialValue={activePreset?.name || ''}
                                onSave={(val) => {
                                    if (activePresetId && val) {
                                        renamePreset(activePresetId, val)
                                    }
                                    setIsRenamingPreset(false)
                                }}
                                onCancel={() => setIsRenamingPreset(false)}
                            />
                        </div>
                    ) : (
                        <div className="min-w-0 flex-1">
                            <Select value={activePresetId || ''} onValueChange={setActivePreset} disabled={isGenerating || rotationActive}>
                                <SelectTrigger className="h-11 min-w-0 rounded-control border-border bg-canvas transition-colors duration-standard hover:bg-accent">
                                    <SelectValue placeholder={t('scene.preset')} />
                                </SelectTrigger>
                                <SelectContent className="max-h-[60vh]">
                                    {presets.map((preset) => (
                                        <SelectItem key={preset.id} value={preset.id}>
                                            {getScenePresetPathSegments(presets, preset.id).join(' / ')} ({preset.scenes.length})
                                        </SelectItem>
                                    ))}
                                    <DropdownMenuSeparator />
                                    <div className="p-1">
                                        <div className="flex items-center gap-2">
                                            <Input
                                                placeholder={t('scene.newPresetName')}
                                                value={newPresetName}
                                                onChange={(e) => setNewPresetName(e.target.value)}
                                                className="h-11 min-w-0 text-xs"
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter') {
                                                        e.stopPropagation()
                                                        handleAddPreset()
                                                    }
                                                }}
                                                onClick={(e) => e.stopPropagation()}
                                            />
                                            <Button
                                                size="icon"
                                                variant="secondary"
                                                className="h-11 w-11 shrink-0"
                                                aria-label={t('scene.addPreset', '프리셋 추가')}
                                                onClick={(e) => { e.stopPropagation(); handleAddPreset() }}
                                                disabled={!newPresetName.trim() || isGenerating || rotationActive}
                                            >
                                                <Plus className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    </div>
                                </SelectContent>
                            </Select>
                        </div>
                    )}
                    <div className="flex shrink-0 items-center gap-1">
                        {activePreset && activePreset.id !== 'scene-default' && (
                            <>
                            {!isRenamingPreset && (
                                <Tip content={t('actions.rename', '이름 변경')}>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-11 w-11 shrink-0"
                                        aria-label={t('actions.rename', '이름 변경')}
                                        onClick={() => setIsRenamingPreset(true)}
                                        disabled={isGenerating || rotationActive}
                                    >
                                        <Pencil className="h-4 w-4" />
                                    </Button>
                                </Tip>
                            )}
                            <Tip content={t('scene.deletePreset', '프리셋 삭제')}>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-11 w-11 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                                    aria-label={t('scene.deletePreset', '프리셋 삭제')}
                                    onClick={() => setShowDeletePresetDialog(true)}
                                    disabled={isGenerating || rotationActive}
                                >
                                    <Trash2 className="h-4 w-4" />
                                </Button>
                            </Tip>
                            </>
                        )}
                        {presets.length > 1 && (
                            <ScenePresetReorderDialog
                                presets={presets}
                                activePresetId={activePresetId}
                                onReorder={reorderPresets}
                                t={t}
                            />
                        )}
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-2 pt-2 sm:flex sm:pl-2 sm:pt-0">
                    <Tip content={t('scene.thumbnailLayout', '세로/가로 썸네일 전환')}>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-11 w-full text-muted-foreground sm:w-11"
                            aria-label={t('scene.thumbnailLayout', '세로/가로 썸네일 전환')}
                            onClick={() => setThumbnailLayout(thumbnailLayout === 'vertical' ? 'horizontal' : 'vertical')}
                        >
                            {thumbnailLayout === 'vertical' ? <LayoutGrid className="h-4 w-4" /> : <LayoutList className="h-4 w-4" />}
                        </Button>
                    </Tip>
                    <Tip content={t('scene.gridColumnsDesc', '그리드 열 개수 변경')}>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-11 w-full text-muted-foreground sm:w-auto"
                            aria-label={t('scene.gridColumnsValue', '{{count}}열, 열 개수 변경', { count: gridColumns })}
                            onClick={handleToggleGrid}
                        >
                            <Grid3x3 className="h-4 w-4 mr-1.5" />
                            <span className="font-medium text-sm">{gridColumns}</span>
                        </Button>
                    </Tip>
                </div>
            </div>

            <div
                ref={scrollContainerRef}
                className="custom-scrollbar min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-1"
                data-scene-grid-virtualized={sceneGridVirtualized ? 'true' : 'false'}
                onScroll={event => setSceneGridScrollTop(event.currentTarget.scrollTop)}
            >
                {scenes.length === 0 ? (
                    <div className="grid gap-4 rounded-panel bg-muted/20 p-4 text-muted-foreground sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
                        <ImageIcon className="h-10 w-10 text-muted-foreground" />
                        <div className="min-w-0">
                            <h3 className="text-base font-semibold text-foreground">{t('scene.noScenes')}</h3>
                            <p className="mt-1 text-sm leading-relaxed">{t('scene.noScenesDesc')}</p>
                        </div>
                        <Button className="h-11 px-4" variant="outline" onClick={handleAddScene} disabled={isGenerating}>
                            <Plus className="mr-2 h-5 w-5" />
                            {t('scene.addScene')}
                        </Button>
                    </div>
                ) : (
                    <DndContext
                        sensors={sensors}
                        collisionDetection={pointerWithin}
                        measuring={{
                            droppable: {
                                strategy: MeasuringStrategy.WhileDragging,
                            },
                        }}
                        onDragStart={handleDragStart}
                        onDragEnd={handleDragEnd}
                    >
                        <SortableContext items={scenes.map(s => s.id)} strategy={rectSortingStrategy}>
                            {sceneGridVirtualRange.paddingTop > 0 && (
                                <div
                                    aria-hidden="true"
                                    style={{ height: sceneGridVirtualRange.paddingTop }}
                                    data-testid="scene-grid-virtual-spacer-top"
                                />
                            )}
                            {/* DESIGN.md stores 2-5 columns as a desktop preference; effective columns are capped at 1/2 below lg without mutating that preference. */}
                            <div className={cn(
                                "grid min-w-0 grid-cols-1 gap-2 pb-16 sm:grid-cols-2 sm:gap-3",
                                gridColumns === 2 && "lg:grid-cols-2",
                                gridColumns === 3 && "lg:grid-cols-3",
                                gridColumns === 4 && "lg:grid-cols-4",
                                gridColumns === 5 && "lg:grid-cols-5"
                            )}>
                                {visibleScenes.map((scene, index) => (
                                    <div key={scene.id} className="min-w-0" data-scene-virtual-index={sceneGridVirtualRange.startIndex + index}>
                                        <SortableSceneCard
                                            scene={scene}
                                            disabled={isGenerating}
                                        />
                                    </div>
                                ))}
                                {sceneGridVirtualRange.endIndex === scenes.length && <button
                                    type="button"
                                    aria-label={t('scene.addScene')}
                                    onClick={!isGenerating ? handleAddScene : undefined}
                                    disabled={isGenerating}
                                    className={cn(
                                        "group flex min-w-0 flex-col items-center justify-center rounded-panel bg-card p-4 text-muted-foreground transition-colors duration-standard hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45",
                                        thumbnailLayout === 'vertical' ? "aspect-[2/3]" : "aspect-[3/2]"
                                    )}
                                >
                                    <Plus className="mb-2 h-6 w-6 transition-transform duration-standard motion-safe:group-hover:scale-105" />
                                    <span className="text-sm font-medium">{t('scene.addScene')}</span>
                                </button>}
                            </div>
                            {sceneGridVirtualRange.paddingBottom > 0 && (
                                <div
                                    aria-hidden="true"
                                    style={{ height: sceneGridVirtualRange.paddingBottom }}
                                    data-testid="scene-grid-virtual-spacer-bottom"
                                />
                            )}
                        </SortableContext>
                        <DragOverlay dropAnimation={dropAnimation} modifiers={[snapCenterToCursor]}>
                            {activeItem ? <SceneCardItem scene={activeItem} isOverlay /> : null}
                        </DragOverlay>
                    </DndContext>
                )}
            </div>

            {
                activePreset && (
                    <ExportDialog
                        open={showExportDialog}
                        onOpenChange={(open) => {
                            setShowExportDialog(open)
                            if (!open) setExportScenesFilter('all') // Reset filter when closing
                        }}
                        activePresetName={activePreset.name}
                        scenes={scenesToExport}
                    />
                )
            }

            <CharacterRotationDialog
                open={showRotationDialog}
                onOpenChange={setShowRotationDialog}
            />

            <SceneFolderManagerDialog
                open={showFolderManager}
                onOpenChange={setShowFolderManager}
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
                open={showDeletePresetDialog}
                onOpenChange={setShowDeletePresetDialog}
                title={t('scene.deletePreset', '프리셋 삭제')}
                description={t('trash.confirmMoveDescription', '항목은 30일 동안 휴지통에 보관됩니다.')}
                confirmText={t('trash.move', '휴지통으로 이동')}
                cancelText={t('common.cancel', '취소')}
                variant="destructive"
                onConfirm={moveActivePresetToTrash}
            />
            <ConfirmDialog
                open={showDeleteSelectedScenesDialog}
                onOpenChange={setShowDeleteSelectedScenesDialog}
                title={t('trash.confirmMoveTitle', '휴지통으로 이동할까요?')}
                description={t('trash.confirmMoveDescription', '항목은 30일 동안 휴지통에 보관됩니다.')}
                confirmText={t('trash.move', '휴지통으로 이동')}
                cancelText={t('common.cancel', '취소')}
                variant="destructive"
                onConfirm={moveSelectedScenesToTrash}
            />
            <ConfirmDialog
                open={showDeleteSelectedImagesDialog}
                onOpenChange={setShowDeleteSelectedImagesDialog}
                title={t('trash.confirmMoveTitle', '휴지통으로 이동할까요?')}
                description={t('trash.confirmMoveDescription', '항목은 30일 동안 휴지통에 보관됩니다.')}
                confirmText={t('trash.move', '휴지통으로 이동')}
                cancelText={t('common.cancel', '취소')}
                variant="destructive"
                onConfirm={moveSelectedImagesToTrash}
            />
            </div>
        </SceneCompositionWorkspace>
    )
}

// Memoized SceneCard to prevent unnecessary re-renders
const SceneCardItem = memo(function SceneCardItem({ scene, onClick, disabled = false, isOverlay = false, style, dragAttributes, dragListeners }: any) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const [isEditing, setIsEditing] = useState(false)
    const [editName, setEditName] = useState(scene.name)
    const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)

    // Essential reactive state - only subscribe to what MUST trigger re-renders
    const activePresetId = useSceneStore(s => s.activePresetId)
    const isEditMode = useSceneStore(s => s.isEditMode)
    const isSelected = useSceneStore(s => s.selectedSceneIds.includes(scene.id))
    const thumbnailLayout = useSceneStore(s => s.thumbnailLayout)
    
    // Subscribe to queueCount directly for fast updates (bypasses memo)
    const queueCount = useSceneStore(s => {
        const preset = s.presets.find(p => p.id === s.activePresetId)
        return preset?.scenes.find(sc => sc.id === scene.id)?.queueCount ?? 0
    })
    const excludePinned = useSceneStore(s => {
        const preset = s.presets.find(p => p.id === s.activePresetId)
        return preset?.scenes.find(sc => sc.id === scene.id)?.excludePinned ?? false
    })

    // Streaming State - only this card's streaming state
    const isStreaming = useSceneStore(s => s.streamingSceneId === scene.id)
    const streamingImage = useSceneStore(s => s.streamingSceneId === scene.id ? s.streamingImage : null)
    const streamingProgress = useSceneStore(s => s.streamingSceneId === scene.id ? s.streamingProgress : 0)

    // Actions - use getState() for stable references that don't trigger re-renders
    const getSceneThumbnail = useSceneStore.getState().getSceneThumbnail
    const renameScene = useSceneStore.getState().renameScene
    const duplicateScene = useSceneStore.getState().duplicateScene
    const deleteScene = useSceneStore.getState().deleteScene
    const incrementQueue = useSceneStore.getState().incrementQueue
    const decrementQueue = useSceneStore.getState().decrementQueue
    const updateSceneSettings = useSceneStore.getState().updateSceneSettings
    const toggleSceneSelection = useSceneStore.getState().toggleSceneSelection
    const selectSceneRange = useSceneStore.getState().selectSceneRange
    const lastSelectedSceneId = useSceneStore.getState().lastSelectedSceneId
    const addToTrash = useTrashStore(state => state.add)

    const thumbnail = getSceneThumbnail(scene)
    // Native path projection is synchronous derived data; keeping a second
    // state copy made recycled/memoized cards briefly retain another Scene's image.
    const imageUrl = !thumbnail || thumbnail.startsWith('data:')
        ? thumbnail ?? ''
        : toNativeAssetUrl(thumbnail)


    const handleSaveName = () => {
        if (editName.trim() && activePresetId) {
            const { sceneSavePath, useAbsoluteScenePath } = useSettingsStore.getState()
            void renameScene(activePresetId, scene.id, editName.trim(), {
                sceneSavePath,
                useAbsoluteScenePath,
            })
        }
        setIsEditing(false)
    }

    /**
     * Depends on the SceneStore record captured by this card and only deletes
     * after the disk-backed snapshot is in the common trash. Keeping this
     * locally avoids threading a destructive callback through virtualized cards.
     */
    const moveSceneToTrash = async () => {
        if (!activePresetId) return
        const preset = useSceneStore.getState().presets.find(candidate => candidate.id === activePresetId)
        const currentScene = preset?.scenes.find(candidate => candidate.id === scene.id)
        if (!preset || !currentScene) return
        try {
            addToTrash(await archiveScene(currentScene, preset))
            deleteScene(activePresetId, scene.id)
            toast({ title: t('trash.moved', '휴지통으로 이동했습니다.'), variant: 'success' })
        } catch (error) {
            console.error('Failed to move Scene to trash:', error)
            toast({ title: t('common.error', '오류'), variant: 'destructive' })
        }
    }
    const onDelete = () => setConfirmDeleteOpen(true)
    const onDuplicate = () => { if (activePresetId) duplicateScene(activePresetId, scene.id) }
    const onIncrement = () => { if (activePresetId) incrementQueue(activePresetId, scene.id, useGenerationStore.getState().batchCount) }
    const onDecrement = () => { if (activePresetId) decrementQueue(activePresetId, scene.id) }
    const onToggleExcludePinned = () => { if (activePresetId) updateSceneSettings(activePresetId, scene.id, { excludePinned: !excludePinned }) }

    const handleSceneClick = (e: React.MouseEvent) => {
        if (isEditMode) {
            // Edit Mode: handle selection
            if (e.shiftKey && lastSelectedSceneId) {
                selectSceneRange(lastSelectedSceneId, scene.id)
            } else if (e.ctrlKey || e.metaKey) {
                toggleSceneSelection(scene.id, false) // Multi-select
            } else {
                toggleSceneSelection(scene.id, true) // Single select
            }
        } else {
            // Normal Mode: navigate to detail
            // Save scroll position before navigating
            const scrollContainer = document.querySelector('.custom-scrollbar')
            if (scrollContainer) {
                useSceneStore.getState().setScrollPosition(scrollContainer.scrollTop)
            }
            if (onClick) onClick()
            else navigate(`/scenes/${scene.id}`)
        }
    }

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild disabled={isOverlay || disabled}>
                <div
                    style={style}
                    className={cn(
                        "group relative flex min-w-0 flex-col overflow-hidden rounded-panel bg-card transition-colors duration-standard",
                        !isOverlay && "hover:bg-accent/40",
                        isOverlay && "z-50 cursor-grabbing shadow-overlay ring-2 ring-primary",
                        disabled && "pointer-events-none opacity-80",
                        isEditMode && isSelected && "ring-2 ring-primary/60"
                    )}
                    onClick={(e) => { if (!isOverlay && !isEditing && !disabled) handleSceneClick(e) }}
                    {...(!isEditing && !isEditMode ? dragAttributes : {})}
                    {...(!isEditing && !isEditMode ? dragListeners : {})}
                >
                    <div className={cn(
                        "relative w-full overflow-hidden bg-canvas",
                        thumbnailLayout === 'vertical' ? "aspect-[2/3]" : "aspect-[3/2]"
                    )}>
                        <div className="absolute left-2 right-16 top-2 z-30 flex flex-wrap gap-1">
                            {queueCount > 0 && (
                                <span className="rounded-control bg-primary px-2 py-1 text-xs font-semibold text-primary-foreground">
                                    {queueCount}
                                </span>
                            )}
                            {excludePinned && (
                                <span className="flex items-center gap-1 rounded-control bg-warning px-2 py-1 text-xs font-semibold text-background">
                                    <UserMinus className="h-3 w-3" />
                                    고정 제외
                                </span>
                            )}
                        </div>

                        {isEditMode && (
                            <div className="absolute right-2 top-2 z-40">
                                <div className={cn(
                                    "flex h-8 w-8 items-center justify-center rounded-control transition-colors duration-standard",
                                    isSelected
                                        ? "bg-primary text-primary-foreground"
                                        : "bg-popover/90 text-muted-foreground"
                                )}>
                                    {isSelected ? <Check className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                                </div>
                            </div>
                        )}

                        {!disabled && !isOverlay && !isEditMode && (
                            <div
                                className="absolute right-2 top-2 z-30"
                                onClick={(event) => event.stopPropagation()}
                                onPointerDown={(event) => event.stopPropagation()}
                            >
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        variant="outline"
                                        size="icon"
                                        className="h-11 w-11 bg-card/90"
                                        aria-label={t('scene.sceneActions', '{{name}} 작업 메뉴', { name: scene.name })}
                                    >
                                        <MoreVertical className="h-4 w-4" />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-40">
                                    <DropdownMenuItem className="min-h-11" onClick={(e) => { e.stopPropagation(); setIsEditing(true); setEditName(scene.name) }}>
                                        <Pencil className="mr-2 h-4 w-4" />
                                        {t('scene.rename')}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem className="min-h-11" onClick={(e) => { e.stopPropagation(); onDuplicate() }}>
                                        <Copy className="mr-2 h-4 w-4" />
                                        {t('scene.duplicate')}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem className="min-h-11" onClick={(e) => { e.stopPropagation(); onToggleExcludePinned() }}>
                                        {excludePinned ? <UserCheck className="mr-2 h-4 w-4" /> : <UserMinus className="mr-2 h-4 w-4" />}
                                        {excludePinned ? '고정 캐릭터 포함' : '고정 캐릭터 제외'}
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem className="min-h-11 text-destructive focus:text-destructive" onClick={(e) => { e.stopPropagation(); onDelete() }}>
                                        <Trash2 className="mr-2 h-4 w-4" />
                                        {t('actions.delete')}
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                            </div>
                        )}

                        {isStreaming && streamingImage ? (
                            <img src={streamingImage} alt={scene.name} className="h-full w-full object-cover motion-safe:animate-pulse" />
                        ) : imageUrl ? (
                            <img src={imageUrl} alt={scene.name} className="h-full w-full object-cover" draggable={false} />
                        ) : (
                            <div className="flex h-full w-full flex-col items-center justify-center text-muted-foreground">
                                <ImageIcon className="mb-2 h-10 w-10" />
                                <span className="text-xs">{t('scene.noImage', '이미지 없음')}</span>
                            </div>
                        )}
                        {isStreaming && streamingProgress > 0 && (
                            <div className="absolute inset-x-0 bottom-0 z-20 h-1 bg-muted">
                                <div
                                    className="h-full bg-primary transition-[width] duration-standard"
                                    style={{ width: `${streamingProgress * 100}%` }}
                                />
                            </div>
                        )}
                    </div>

                    <div className="bg-muted/20 p-2">
                        {isEditing ? (
                            <div onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
                                <Input
                                    value={editName}
                                    onChange={(e) => setEditName(e.target.value)}
                                    className="h-11 min-w-0 text-sm"
                                    aria-label={t('scene.rename')}
                                    autoFocus
                                    onBlur={handleSaveName}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') handleSaveName()
                                        if (e.key === 'Escape') setIsEditing(false)
                                    }}
                                />
                            </div>
                        ) : (
                            <>
                                <h3 className="truncate px-1 text-sm font-semibold text-card-foreground">{scene.name}</h3>
                                <SceneCompositionCardMeta
                                    scene={scene}
                                    hasOverrides={hasSceneCompositionOverrides(scene)}
                                />
                            </>
                        )}

                        <div className="mt-2 flex items-center gap-2" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
                            <Button
                                variant="outline"
                                size="icon"
                                className="h-11 w-11 shrink-0"
                                aria-label={t('scene.decreaseQueue', '{{name}} 대기열 줄이기', { name: scene.name })}
                                onClick={onDecrement}
                                disabled={queueCount === 0 || disabled}
                            >
                                <Minus className="h-4 w-4" />
                            </Button>
                            <span className="min-w-0 flex-1 truncate text-center text-xs text-muted-foreground" aria-live="polite">
                                {t('scene.queueCountLabel', '대기열 {{count}}', { count: queueCount })}
                            </span>
                            <Button
                                variant="outline"
                                size="icon"
                                className="h-11 w-11 shrink-0"
                                aria-label={t('scene.increaseQueue', '{{name}} 대기열 늘리기', { name: scene.name })}
                                onClick={onIncrement}
                                disabled={disabled}
                            >
                                <Plus className="h-4 w-4" />
                            </Button>
                        </div>
                    </div>
                </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-40">
                <ContextMenuItem className="min-h-11" onClick={() => { setIsEditing(true); setEditName(scene.name) }}> <Pencil className="mr-2 h-4 w-4" /> {t('scene.rename')} </ContextMenuItem>
                <ContextMenuItem className="min-h-11" onClick={() => onDuplicate()}> <Copy className="mr-2 h-4 w-4" /> {t('scene.duplicate')} </ContextMenuItem>
                <ContextMenuItem className="min-h-11" onClick={() => onToggleExcludePinned()}>
                    {excludePinned ? <UserCheck className="mr-2 h-4 w-4" /> : <UserMinus className="mr-2 h-4 w-4" />}
                    {excludePinned ? '고정 캐릭터 포함' : '고정 캐릭터 제외'}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem className="min-h-11 text-destructive focus:text-destructive" onClick={() => onDelete()}> <Trash2 className="mr-2 h-4 w-4" /> {t('actions.delete')} </ContextMenuItem>
            </ContextMenuContent>
            <ConfirmDialog
                open={confirmDeleteOpen}
                onOpenChange={setConfirmDeleteOpen}
                title={t('trash.confirmMoveTitle', '휴지통으로 이동할까요?')}
                description={t('trash.confirmMoveDescription', '항목은 30일 동안 휴지통에 보관됩니다.')}
                confirmText={t('trash.move', '휴지통으로 이동')}
                cancelText={t('common.cancel', '취소')}
                variant="destructive"
                onConfirm={moveSceneToTrash}
            />
        </ContextMenu>
    )
})

// Isolated PresetRenameInput to prevent SceneMode re-renders on every keystroke
const PresetRenameInput = memo(({
    initialValue,
    onSave,
    onCancel
}: {
    initialValue: string,
    onSave: (val: string) => void,
    onCancel: () => void
}) => {
    const [value, setValue] = useState(initialValue)

    const handleSave = () => {
        if (value.trim()) onSave(value.trim())
        else onCancel()
    }

    return (
        <div className="flex min-w-0 flex-1 items-center gap-1">
            <Input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="h-11 min-w-0"
                aria-label="프리셋 이름"
                autoFocus
                onBlur={handleSave}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSave()
                    if (e.key === 'Escape') onCancel()
                }}
            />
            <Button variant="ghost" size="icon" className="h-11 w-11 shrink-0" aria-label="프리셋 이름 저장" onClick={handleSave}>
                <Check className="h-4 w-4" />
            </Button>
        </div>
    )
})

// Memoized SortableSceneCard with custom comparator to prevent re-renders during drag
const SortableSceneCard = memo(function SortableSceneCard(props: any) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.scene.id, disabled: props.disabled })
    const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.0 : 1 }
    return <div ref={setNodeRef} style={style} className="min-w-0"> <SceneCardItem {...props} dragAttributes={attributes} dragListeners={listeners} /> </div>
})
