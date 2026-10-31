import { useTranslation } from 'react-i18next'
import { useEffect, useState, useCallback, useMemo, useRef, memo } from 'react'
import { Clock, Trash2, FolderOpen, RefreshCw, FileSearch, Copy, RotateCcw, Save, Users, Image as ImageIcon, Paintbrush, Maximize2, Film, Zap, PenTool, Pencil, Droplets, Smile, Sparkles, Loader2, Images } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useGenerationStore } from '@/stores/generation-store'
import { useAuthStore, waitForApiTokenReady } from '@/stores/auth-store'
import { useSettingsStore } from '@/stores/settings-store'
import {
    createNativeDirectory as mkdir,
    nativePathExists as exists,
    readNativeBinaryFile as readFile,
    readNativeDirectory as readDir,
    writeNativeBinaryFile as writeFile,
} from '@/platform/native-file-system'
import { runtimeCapabilities } from '@/platform/capabilities'
import { joinNativePath } from '@/platform/native-path'
import { toNativeAssetUrl } from '@/platform/asset-url'
import {
    getMediaStorageRoot,
    MEDIA_STORAGE_BASE_DIRECTORY,
    shouldUseAbsoluteMediaPath,
} from '@/platform/storage'
import { revealNativeItem } from '@/platform/native-shell'
import { saveNativeFileDialog } from '@/platform/native-file-dialog'
import { MetadataDialog } from '@/components/metadata/MetadataDialog'
import { ImageReferenceDialog } from '@/components/metadata/ImageReferenceDialog'
import { parseMetadataFromBase64 } from '@/lib/metadata-parser'
import { generateImage } from '@/services/novelai-api'
import { toast } from '@/components/ui/use-toast'
import { useToolsStore } from '@/stores/tools-store'
import { useLibraryStore } from '@/stores/library-store'
import { useSceneStore } from '@/stores/scene-store'
import { useNavigate } from 'react-router'
import { Wand2 } from 'lucide-react'
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuTrigger,
    ContextMenuSeparator,
} from '@/components/ui/context-menu'
import { InpaintingDialog } from '@/components/tools/InpaintingDialog'
import { buildArtifactHistoryShadow, artifactHistoryPathKey } from '@/services/organizer/artifact-history-shadow'
import { getRuntimeArtifactRepository } from '@/services/organizer/runtime'
import { createRuntimeOutputPlatformAdapter } from '@/services/output/tauri-output-adapter'
import {
    publishGeneratedArtifact,
    type GeneratedArtifactNotice,
    useArtifactLifecycleStore,
} from '@/stores/artifact-lifecycle-store'
import { QueueActivityLink } from './QueueActivityLink'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useTrashStore } from '@/stores/trash-store'
import { archiveSceneImage } from '@/services/trash/asset-trash-service'
import { normalizeNaiImageModelId } from '@/services/nai/model-catalog'

// Convert ArrayBuffer to base64 without stack overflow
const arrayBufferToBase64 = (buffer: Uint8Array): string => {
    let binary = ''
    const len = buffer.byteLength
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(buffer[i])
    }
    return btoa(binary)
}

interface SavedImage {
    name: string
    path: string
    timestamp: number
    type: 'main' | 'i2i' | 'inpaint' | 'upscale' | 'scene' | 'lineart' | 'sketch' | 'colorize' | 'emotion' | 'declutter'
    isTemporary?: boolean
    artifactId?: string
    sourceJobId?: string
    sourceSceneId?: string
}

type SavedImageLineage = Pick<GeneratedArtifactNotice, 'artifactId' | 'sourceJobId' | 'sourceSceneId'>

// Memoized HistoryImageItem - 불필요한 리렌더링 방지
interface HistoryImageItemProps {
    image: SavedImage
    thumbnail?: string
    index: number
    getTypeIcon: (type: SavedImage['type']) => React.ReactNode
    onImageClick: (image: SavedImage) => void
    onDelete: (image: SavedImage, e?: React.MouseEvent) => void
    onSaveAs: (image: SavedImage) => void
    onCopy: (image: SavedImage) => void
    onRegenerate: (image: SavedImage) => void
    onOpenSmartTools: (image: SavedImage) => void
    onAddAsReference: (image: SavedImage) => void
    onInpaint: (image: SavedImage) => void
    onI2I: (image: SavedImage) => void
    onOpenFolder: (image: SavedImage) => void
    onLoadMetadata: (image: SavedImage) => void
    onAddToLibrary: (image: SavedImage) => void
    onLoadComplete: (path: string, data: string) => void
    guided: boolean
}

const HistoryImageItem = memo(function HistoryImageItem({
    image, thumbnail, index, getTypeIcon,
    onImageClick, onDelete, onSaveAs, onCopy, onRegenerate,
    onOpenSmartTools, onAddAsReference, onInpaint, onI2I, onOpenFolder, onLoadMetadata,
    onAddToLibrary,
    onLoadComplete,
    guided,
}: HistoryImageItemProps) {
    const { t } = useTranslation()
    const [localThumbnail, setLocalThumbnail] = useState<string | undefined>(thumbnail)

    useEffect(() => {
        if (thumbnail) setLocalThumbnail(thumbnail)
    }, [thumbnail])

    useEffect(() => {
        if (image.isTemporary) return
        if (!localThumbnail) {
            // The platform adapter keeps native asset loading off the JS heap.
            const assetUrl = toNativeAssetUrl(image.path)
            setLocalThumbnail(assetUrl)
            onLoadComplete(image.path, assetUrl)
        }
    }, [image.path, localThumbnail, onLoadComplete, image.isTemporary])

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>
                <div
                    className="thumb-bare group relative aspect-square cursor-pointer overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                    onClick={() => onImageClick(image)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            onImageClick(image)
                        }
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label={t('history.openImage', { index: index + 1, defaultValue: `이미지 ${index + 1}번` })}
                >
                    {localThumbnail ? (
                        <img
                            draggable="true"
                            onDragStart={(e) => {
                                e.dataTransfer.setData('text/plain', image.name);
                                e.dataTransfer.effectAllowed = 'copy';
                                useLibraryStore.getState().setDraggedSource({
                                    name: image.name,
                                    path: image.path
                                });

                                // Create custom drag preview with rounded corners using DOM element
                                const dragPreview = document.createElement('div');
                                dragPreview.style.cssText = `
                                    width: 80px;
                                    height: 80px;
                                    border-radius: 12px;
                                    overflow: hidden;
                                    box-shadow: 0 16px 48px rgba(0,0,0,0.28);
                                    position: fixed;
                                    top: -200px;
                                    left: -200px;
                                    z-index: 9999;
                                    pointer-events: none;
                                `;

                                const previewImg = document.createElement('img');
                                previewImg.src = localThumbnail || '';
                                previewImg.style.cssText = `
                                    width: 100%;
                                    height: 100%;
                                    object-fit: cover;
                                `;

                                dragPreview.appendChild(previewImg);
                                document.body.appendChild(dragPreview);

                                e.dataTransfer.setDragImage(dragPreview, 40, 40);

                                // Clean up after a short delay
                                setTimeout(() => {
                                    document.body.removeChild(dragPreview);
                                }, 0);
                            }}
                            onDragEnd={() => {
                                useLibraryStore.getState().setDraggedSource(null);
                            }}
                            src={localThumbnail}
                            alt={`Image ${index + 1}`}
                            loading="lazy"
                            decoding="async"
                            className="h-full w-full object-cover transition-transform duration-standard group-hover:scale-[1.02]"
                        />
                    ) : (
                        <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground" role="status">
                            {t('common.loading', '불러오는 중…')}
                        </div>
                    )}
                    <Button
                        variant="destructive"
                        size="icon"
                        className="absolute right-1 top-1 h-11 w-11 opacity-100 transition-opacity duration-fast sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
                        onClick={(e) => onDelete(image, e)}
                        aria-label={t('actions.delete', '삭제')}
                    >
                        <Trash2 className="h-4 w-4" />
                    </Button>
                    <div className="absolute bottom-1 left-1 flex gap-1 opacity-100 transition-opacity duration-fast sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100" aria-hidden="true">
                        <div className="flex h-6 w-6 items-center justify-center rounded-control bg-scrim/70 text-primary-foreground">
                            {getTypeIcon(image.type)}
                        </div>
                        {image.isTemporary && (
                            <div className="flex h-6 w-6 items-center justify-center rounded-control bg-scrim/70">
                                <Zap className="h-3 w-3 text-warning" />
                            </div>
                        )}
                    </div>
                </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
                <ContextMenuItem onClick={() => onSaveAs(image)}>
                    <Save className="h-4 w-4 mr-2" />
                    {t('actions.saveAs', '저장')}
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onCopy(image)}>
                    <Copy className="h-4 w-4 mr-2" />
                    {t('actions.copy', '복사')}
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onAddToLibrary(image)}>
                    <Images className="mr-2 h-4 w-4" />
                    {t('history.addToLibrary', 'Add to library')}
                </ContextMenuItem>
                {!guided && (
                    <>
                        <ContextMenuItem onClick={() => onRegenerate(image)}>
                            <RotateCcw className="h-4 w-4 mr-2" />
                            {t('actions.regenerate', '재생성')}
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => onOpenSmartTools(image)}>
                            <Wand2 className="h-4 w-4 mr-2" />
                            {t('smartTools.title', '스마트 툴')}
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem onClick={() => onInpaint(image)}>
                            <Paintbrush className="h-4 w-4 mr-2" />
                            {t('tools.inpainting.title', '인페인팅')}
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => onI2I(image)}>
                            <ImageIcon className="h-4 w-4 mr-2" />
                            {t('tools.i2i.title', 'Image to Image')}
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem onClick={() => onAddAsReference(image)}>
                            <Users className="h-4 w-4 mr-2" />
                            {t('actions.addAsRef', '이미지 참조')}
                        </ContextMenuItem>
                    </>
                )}
                <ContextMenuItem onClick={() => onOpenFolder(image)} disabled={image.isTemporary}>
                    <FolderOpen className="h-4 w-4 mr-2" />
                    {t('actions.openFolder', '폴더 열기')}
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onLoadMetadata(image)}>
                    <FileSearch className="h-4 w-4 mr-2" />
                    {t('metadata.loadFromImage', '메타데이터 불러오기')}
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    )
})

export function HistoryPanel({ guided = false }: { guided?: boolean } = {}) {
    const { t } = useTranslation()
    const setPreviewImage = useGenerationStore(state => state.setPreviewImage)
    const isGenerating = useGenerationStore(state => state.isGenerating)
    const setIsGenerating = useGenerationStore(state => state.setIsGenerating)
    const setSourceImage = useGenerationStore(state => state.setSourceImage)
    const setI2IMode = useGenerationStore(state => state.setI2IMode)
    const savePath = useSettingsStore(state => state.savePath)
    const useAbsolutePath = useSettingsStore(state => state.useAbsolutePath)
    const sceneSavePath = useSettingsStore(state => state.sceneSavePath)
    const useAbsoluteScenePath = useSettingsStore(state => state.useAbsoluteScenePath)
    const [savedImages, setSavedImages] = useState<SavedImage[]>([])
    const [imageThumbnails, setImageThumbnails] = useState<Record<string, string>>({})
    const [isLoading, setIsLoading] = useState(false)
    const [sourceEditPreparing, setSourceEditPreparing] = useState(false)
    const [metadataDialogOpen, setMetadataDialogOpen] = useState(false)
    const [selectedImageForMetadata, setSelectedImageForMetadata] = useState<string | undefined>()
    const [imageRefDialogOpen, setImageRefDialogOpen] = useState(false)
    const [selectedImageForRef, setSelectedImageForRef] = useState<string | null>(null)
    // Inpainting dialog state
    const [inpaintDialogOpen, setInpaintDialogOpen] = useState(false)
    const [selectedImageForInpaint, setSelectedImageForInpaint] = useState<string | null>(null)
    const [pendingDeleteImage, setPendingDeleteImage] = useState<SavedImage | null>(null)
    const [guidedSelection, setGuidedSelection] = useState<{ image: SavedImage; dataUrl: string } | null>(null)
    const navigate = useNavigate()
    const { setActiveImage } = useToolsStore()
    const addToTrash = useTrashStore(state => state.add)
    const libraryItems = useLibraryStore(state => state.items)
    const addLibraryItem = useLibraryStore(state => state.addItem)
    const historyRefreshTrigger = useSceneStore(state => state.historyRefreshTrigger)
    const isTauriRuntime = runtimeCapabilities.nativePluginRuntime.supported
    const artifactRepository = useMemo(() => getRuntimeArtifactRepository(), [])
    const outputPlatform = useMemo(() => createRuntimeOutputPlatformAdapter(), [])
    const historyRefreshId = useRef(0)



    // LRU cache limit for imageThumbnails to prevent memory bloat
    const MAX_THUMBNAIL_CACHE = 20

    const handleImageLoadComplete = useCallback((path: string, data: string) => {
        setImageThumbnails(prev => {
            // Skip if already cached with same data
            if (prev[path] === data) return prev
            
            const keys = Object.keys(prev)
            // If cache is full, remove oldest entries (first in object)
            if (keys.length >= MAX_THUMBNAIL_CACHE) {
                const keysToRemove = keys.slice(0, keys.length - MAX_THUMBNAIL_CACHE + 1)
                const newCache: Record<string, string> = {}
                // Only keep entries not in keysToRemove
                for (const k of keys) {
                    if (!keysToRemove.includes(k)) {
                        newCache[k] = prev[k]
                    }
                }
                newCache[path] = data
                return newCache
            }
            return { ...prev, [path]: data }
        })
    }, [])

    // Add new image instantly to history
    // Memory optimization: use asset URLs for files and cache Base64 only for temporary images.
    const addNewImage = useCallback((imagePath: string, imageData?: string, lineage?: SavedImageLineage) => {
        const timestamp = Date.now()
        const isTemporary = imagePath.startsWith('memory://')
        const name = imagePath.split(/[/\\]/).pop() || `NAI_Blue_${timestamp}.png`

        const newImage: SavedImage = {
            name,
            path: imagePath,
            timestamp,
            type: imagePath.includes('NAI_Blue_Scene') ? 'scene' :
                name.includes('INPAINT_') ? 'inpaint' :
                    name.includes('I2I_') ? 'i2i' :
                        name.includes('UPSCALE_') ? 'upscale' :
                            name.includes('LINEART_') ? 'lineart' :
                                name.includes('SKETCH_') ? 'sketch' :
                                    name.includes('COLORIZE_') ? 'colorize' :
                                        name.includes('EMOTION_') ? 'emotion' :
                                            name.includes('DECLUTTER_') ? 'declutter' : 'main',
            isTemporary,
            ...lineage,
        }

        // Instantly add to list
        setSavedImages(prev => {
            let next = [newImage, ...prev]

            // Limit temporary images to 10
            if (isTemporary) {
                const tempImages = next.filter(img => img.isTemporary)
                if (tempImages.length > 10) {
                    // Sort temp images by timestamp (oldest first) to find the one to remove
                    const sortedTemp = [...tempImages].sort((a, b) => a.timestamp - b.timestamp)
                    const oldest = sortedTemp[0]
                    next = next.filter(img => img !== oldest)
                }
            }
            return next.slice(0, 50)
        })

        // Memory optimization: cache Base64 only for temporary images and native asset URLs for files.
        const cacheData = isTemporary || !isTauriRuntime
            ? imageData ?? ''
            : toNativeAssetUrl(imagePath)
        
        setImageThumbnails(prev => {
            const keys = Object.keys(prev)
            if (keys.length >= MAX_THUMBNAIL_CACHE) {
                const keysToRemove = keys.slice(0, keys.length - MAX_THUMBNAIL_CACHE + 1)
                const newCache = { ...prev }
                keysToRemove.forEach(k => delete newCache[k])
                return { ...newCache, [imagePath]: cacheData }
            }
            return { ...prev, [imagePath]: cacheData }
        })
    }, [isTauriRuntime])

    const getGenerationType = (name: string): SavedImage['type'] => {
        if (name.includes('INPAINT_')) return 'inpaint'
        if (name.includes('I2I_')) return 'i2i'
        if (name.includes('UPSCALE_')) return 'upscale'
        if (name.includes('SCENE_')) return 'scene'
        if (name.includes('LINEART_')) return 'lineart'
        if (name.includes('SKETCH_')) return 'sketch'
        if (name.includes('COLORIZE_')) return 'colorize'
        if (name.includes('EMOTION_')) return 'emotion'
        if (name.includes('DECLUTTER_')) return 'declutter'
        return 'main'
    }

    // Get icon component for generation type
    const getTypeIcon = (type: SavedImage['type']) => {
        switch (type) {
            case 'i2i': return <ImageIcon className="h-3 w-3 text-info" />
            case 'inpaint': return <Paintbrush className="h-3 w-3 text-destructive" />
            case 'upscale': return <Maximize2 className="h-3 w-3 text-primary" />
            case 'scene': return <Film className="h-3 w-3 text-success" />
            case 'lineart': return <PenTool className="h-3 w-3 text-muted-foreground" />
            case 'sketch': return <Pencil className="h-3 w-3 text-muted-foreground" />
            case 'colorize': return <Droplets className="h-3 w-3 text-info" />
            case 'emotion': return <Smile className="h-3 w-3 text-warning" />
            case 'declutter': return <Sparkles className="h-3 w-3 text-success" />
            default: return <ImageIcon className="h-3 w-3 text-foreground" />
        }
    }

    // Load images from save path
    const loadSavedImages = async () => {
        const requestId = ++historyRefreshId.current
        setIsLoading(true)
        if (!isTauriRuntime) {
            setSavedImages(prev => prev.filter(image => image.isTemporary))
            setIsLoading(false)
            return
        }

        try {
            const images: SavedImage[] = []
            const picturePath = await getMediaStorageRoot()

            // 1. Load Main Output Images from the NAI Blue default folder.
            const defaultOutputDir = 'NAI_Blue_Output'

            try {
                if (await exists(defaultOutputDir, { baseDir: MEDIA_STORAGE_BASE_DIRECTORY })) {
                    const entries = await readDir(defaultOutputDir, { baseDir: MEDIA_STORAGE_BASE_DIRECTORY })

                    for (const entry of entries) {
                        if (entry.name && (entry.name.toLowerCase().endsWith('.png') || entry.name.toLowerCase().endsWith('.jpg') || entry.name.toLowerCase().endsWith('.webp'))) {
                            const fullPath = await joinNativePath(picturePath, defaultOutputDir, entry.name)
                            const match = entry.name.match(/_(\d+)\.[^.]+$/)
                            const timestamp = match ? parseInt(match[1]) : 0
                            images.push({
                                name: entry.name,
                                path: fullPath,
                                timestamp,
                                type: getGenerationType(entry.name)
                            })
                        }
                    }
                }
            } catch (e) {
                console.warn('Failed to load from default Pictures folder:', e)
            }

            // Additionally load from absolute path if set
            if (shouldUseAbsoluteMediaPath(useAbsolutePath) && savePath) {
                try {
                    if (await exists(savePath)) {
                        const entries = await readDir(savePath)

                        for (const entry of entries) {
                            if (entry.name && (entry.name.toLowerCase().endsWith('.png') || entry.name.toLowerCase().endsWith('.jpg') || entry.name.toLowerCase().endsWith('.webp'))) {
                                const fullPath = await joinNativePath(savePath, entry.name)

                                // Skip duplicates
                                if (images.some(img => img.path === fullPath)) continue

                                const match = entry.name.match(/_(\d+)\.[^.]+$/)
                                const timestamp = match ? parseInt(match[1]) : 0
                                images.push({
                                    name: entry.name,
                                    path: fullPath,
                                    timestamp,
                                    type: getGenerationType(entry.name)
                                })
                            }
                        }
                    }
                } catch (e) {
                    console.warn('Failed to load from absolute path:', e)
                }
            }

            // 2. Load Scene Images (Recursive) - use the dedicated Scene folder setting.
            const sceneBaseDir = (sceneSavePath || 'NAI_Blue_Scene').replace(/[<>:"/\\|?*]/g, '_').trim() || 'NAI_Blue_Scene'
            const scenePicturePath = await getMediaStorageRoot()

            // Scene output can contain nested preset paths and the dedicated
            // Character_Scenes parent. A bounded recursive walk supports both
            // current and legacy layouts without encoding another fixed depth.
            const loadSceneImagesFromDir = async (baseDir: string, useBaseDir: boolean = false) => {
                try {
                    const checkExists = useBaseDir
                        ? await exists(sceneBaseDir, { baseDir: MEDIA_STORAGE_BASE_DIRECTORY })
                        : await exists(baseDir)

                    if (!checkExists) return

                    const MAX_SCENE_SCAN_DEPTH = 8
                    const imageExtension = /\.(?:png|jpe?g|webp)$/i
                    const visitDirectory = async (
                        directory: string,
                        scopedSegments: readonly string[],
                        depth: number,
                    ): Promise<void> => {
                        let entries
                        try {
                            entries = useBaseDir
                                ? await readDir(directory, { baseDir: MEDIA_STORAGE_BASE_DIRECTORY })
                                : await readDir(directory)
                        } catch (error) {
                            console.warn(`Failed to read Scene output directory ${directory}:`, error)
                            return
                        }

                        for (const entry of entries) {
                            if (entry.isDirectory) {
                                if (entry.isSymlink || depth >= MAX_SCENE_SCAN_DEPTH) continue
                                const nextDirectory = useBaseDir
                                    ? `${directory}/${entry.name}`
                                    : await joinNativePath(directory, entry.name)
                                await visitDirectory(nextDirectory, [...scopedSegments, entry.name], depth + 1)
                                continue
                            }
                            if (!entry.name || !imageExtension.test(entry.name)) continue

                            const fullPath = useBaseDir
                                ? await joinNativePath(scenePicturePath, ...scopedSegments, entry.name)
                                : await joinNativePath(directory, entry.name)
                            if (images.some(img => img.path === fullPath)) continue

                            const match = entry.name.match(/_(\d+)\.[^.]+$/)
                            images.push({
                                name: entry.name,
                                path: fullPath,
                                timestamp: match ? parseInt(match[1]) : 0,
                                type: 'scene',
                            })
                        }
                    }

                    await visitDirectory(
                        useBaseDir ? sceneBaseDir : baseDir,
                        useBaseDir ? [sceneBaseDir] : [],
                        0,
                    )
                } catch (e) {
                    console.warn('Failed to load scene images from:', baseDir, e)
                }
            }

            if (shouldUseAbsoluteMediaPath(useAbsoluteScenePath) && sceneSavePath) {
                await loadSceneImagesFromDir(sceneSavePath, false)
            } else {
                await loadSceneImagesFromDir(sceneBaseDir, true)
            }

            images.sort((a, b) => b.timestamp - a.timestamp)

            // MEMORY OPTIMIZATION: Limit total file entries to prevent large state
            const MAX_HISTORY_FILES = 200
            const limitedImages = images.slice(0, MAX_HISTORY_FILES)

            // Merge with existing temporary images
            setSavedImages(prev => {
                const tempImages = prev.filter(img => img.isTemporary)
                const sortedTemp = tempImages.sort((a, b) => b.timestamp - a.timestamp).slice(0, 10)

                const combined = [...limitedImages, ...sortedTemp]
                return combined.sort((a, b) => b.timestamp - a.timestamp)
            })

            // Disk scan remains the current History authority. The durable
            // Artifact repository only reattaches Queue identity after an app
            // restart, and runs after the scan is visible so a large Organizer
            // catalog cannot delay the user's local result grid.
            void buildArtifactHistoryShadow(limitedImages, artifactRepository, outputPlatform)
                .then(shadow => {
                    if (requestId !== historyRefreshId.current) return
                    setSavedImages(prev => prev.map(image => {
                        if (image.isTemporary) return image
                        const lineage = shadow.lineageByPath.get(artifactHistoryPathKey(image.path))
                        return lineage === undefined ? image : { ...image, ...lineage }
                    }))
                })
                .catch(error => {
                    console.warn('Artifact History shadow is unavailable:', error)
                })

            // NOTE: Removed pre-loading of thumbnails using readFile to prevent UI lag.
            // Rendering uses platform asset URLs instead of preloading file bytes into memory.
        } catch (error) {
            console.error('Failed to load history:', error)
            setSavedImages([])
        }
        setIsLoading(false)
    }

    useEffect(() => {
        loadSavedImages()
    }, [savePath, useAbsolutePath, sceneSavePath, useAbsoluteScenePath, historyRefreshTrigger])

    const latestGeneratedArtifact = useArtifactLifecycleStore(state => state.latestGeneratedArtifact)

    // Output producers publish through a typed transient store. Queue-backed
    // notices include their durable identity so this transient History item can
    // hand the same artifact to Organizer; legacy and memory-only producers
    // continue without lineage. Directory scans remain limited to initial
    // load/manual refresh for large histories.
    useEffect(() => {
        if (latestGeneratedArtifact === null) return
        addNewImage(latestGeneratedArtifact.path, latestGeneratedArtifact.data, {
            artifactId: latestGeneratedArtifact.artifactId,
            sourceJobId: latestGeneratedArtifact.sourceJobId,
            sourceSceneId: latestGeneratedArtifact.sourceSceneId,
        })
    }, [addNewImage, latestGeneratedArtifact])

    // PERFORMANCE: Removed auto-refresh after every generation.
    // The artifact lifecycle subscription (above) already adds images instantly.
    // Full directory scan (loadSavedImages) is only needed on initial mount + manual refresh.
    // For users generating 1000+ images, scanning the entire directory after EVERY generation
    // was the #1 cause of progressive slowdown.


    const handleImageClick = async (image: SavedImage) => {
        let finalDataUrl = imageThumbnails[image.path]

        // If we have an asset:// URL or missing data, load as base64 for metadata parsing
        if (!finalDataUrl || !finalDataUrl.startsWith('data:')) {
            if (!image.isTemporary) {
                try {
                    const data = await readFile(image.path)
                    const base64 = arrayBufferToBase64(data)
                    finalDataUrl = `data:image/png;base64,${base64}`
                } catch (e) {
                    console.error('Failed to load image:', e)
                    return
                }
            }
        }

        if (guided) {
            if (finalDataUrl) setGuidedSelection({ image, dataUrl: finalDataUrl })
            return
        }

        // Set preview
        setPreviewImage(finalDataUrl)

        // Show seed (Preview only)
        try {
            const metadata = await parseMetadataFromBase64(finalDataUrl)
            if (metadata && metadata.seed) {
                // Determine if this seed is different from current generation seed
                const genStore = useGenerationStore.getState()
                if (genStore.seed !== metadata.seed) {
                    genStore.setPreviewSeed(metadata.seed)
                } else {
                    genStore.setPreviewSeed(null)
                }
            } else {
                useGenerationStore.getState().setPreviewSeed(null)
            }
        } catch (error) {
            console.warn('Failed to parse metadata for seed sync:', error)
            useGenerationStore.getState().setPreviewSeed(null)
        }

        navigate('/advanced') // Navigate to main mode to show the image
    }

    const requestDeleteImage = (image: SavedImage, e?: React.MouseEvent) => {
        e?.stopPropagation()
        setPendingDeleteImage(image)
    }

    /**
     * Depends on the History thumbnail cache for memory-only results and the
     * unified asset trash service for disk files. Archive succeeds before the
     * local grid is updated, avoiding a visual delete that loses recovery data.
     */
    const moveHistoryImageToTrash = async () => {
        const image = pendingDeleteImage
        if (!image) return
        try {
            const dataUrl = image.isTemporary ? imageThumbnails[image.path] : undefined
            const trashItem = await archiveSceneImage({
                id: `history-${image.path}`,
                url: dataUrl || image.path,
                timestamp: image.timestamp,
                isFavorite: false,
            }, 'history', image.name, { historyPath: image.path })
            addToTrash(trashItem)
            setSavedImages(prev => prev.filter(img => img.path !== image.path))
            setGuidedSelection(current => current?.image.path === image.path ? null : current)
            setImageThumbnails(prev => {
                const next = { ...prev }
                delete next[image.path]
                return next
            })
            toast({ title: t('trash.moved', '휴지통으로 이동했습니다.'), variant: 'success' })
        } catch (e) {
            console.error('Failed to move history image to trash:', e)
            toast({ title: t('common.error', '오류'), variant: 'destructive' })
        } finally {
            setPendingDeleteImage(null)
        }
    }

    const handleLoadMetadata = async (image: SavedImage) => {
        let imageData = imageThumbnails[image.path]

        // Always load as base64 for MetadataDialog (asset:// URLs don't work)
        if (!imageData || !imageData.startsWith('data:')) {
            try {
                const data = await readFile(image.path)
                const base64 = arrayBufferToBase64(data)
                imageData = `data:image/png;base64,${base64}`
            } catch {
                return
            }
        }

        setSelectedImageForMetadata(imageData)
        setMetadataDialogOpen(true)
    }

    const handleCopyImage = async (image: SavedImage) => {
        const imageData = imageThumbnails[image.path]
        if (!imageData) return

        try {
            const response = await fetch(imageData)
            const blob = await response.blob()
            await navigator.clipboard.write([
                new ClipboardItem({ [blob.type]: blob })
            ])
        } catch (e) {
            console.error('Copy failed:', e)
        }
    }

    // Regenerate image with its metadata
    const handleRegenerate = async (image: SavedImage) => {
        if (isGenerating) {
            toast({ title: t('toast.generating', '생성 중입니다...'), variant: 'default' })
            return
        }

        // Always load as base64 for metadata parsing (asset:// URLs don't work with parseMetadataFromBase64)
        let finalData: string | undefined
        if (!image.isTemporary) {
            try {
                const data = await readFile(image.path)
                const base64 = arrayBufferToBase64(data)
                finalData = `data:image/png;base64,${base64}`
            } catch (e) {
                console.error('Failed to load image for regenerate:', e)
                return
            }
        } else {
            finalData = imageThumbnails[image.path]
            if (finalData && !finalData.startsWith('data:')) {
                // Can't regenerate from asset:// URL without file path
                return
            }
        }

        if (!finalData) return

        const token = useAuthStore.getState().token
        if (!token) {
            useAuthStore.getState().requestTokenEntry()
            toast({ title: t('toast.tokenRequired.title', '토큰 필요'), variant: 'destructive' })
            return
        }

        try {
            const metadata = await parseMetadataFromBase64(finalData)
            if (!metadata) {
                toast({
                    title: t('toast.noMetadata', '메타데이터 없음'),
                    description: t('toast.noMetadataDesc', '이 이미지에서 메타데이터를 찾을 수 없습니다'),
                    variant: 'destructive',
                })
                return
            }

            setIsGenerating(true)
            const newSeed = Math.floor(Math.random() * 4294967295)

            const result = await generateImage(token, {
                prompt: metadata.prompt || '',
                negative_prompt: metadata.negativePrompt || '',
                model: normalizeNaiImageModelId(metadata.model)
                    ?? useGenerationStore.getState().model,
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
            })

            if (result.success && result.imageData) {
                const { imageFormat } = useSettingsStore.getState()
                const mimeType = imageFormat === 'webp' ? 'image/webp' : 'image/png'
                const fileExt = imageFormat === 'webp' ? 'webp' : 'png'
                setPreviewImage(`data:${mimeType};base64,${result.imageData}`)

                // Save to disk if autoSave is enabled
                const { autoSave, useAbsolutePath } = useSettingsStore.getState()
                if (autoSave) {
                    try {
                        const binaryString = atob(result.imageData)
                        const bytes = new Uint8Array(binaryString.length)
                        for (let j = 0; j < binaryString.length; j++) {
                            bytes[j] = binaryString.charCodeAt(j)
                        }

                        const fileName = `NAI_Blue_${Date.now()}.${fileExt}`
                        const outputDir = savePath || 'NAI_Blue_Output'

                        let fullPath: string

                        if (shouldUseAbsoluteMediaPath(useAbsolutePath)) {
                            // Save to absolute path directly
                            const dirExists = await exists(outputDir)
                            if (!dirExists) {
                                await mkdir(outputDir, { recursive: true })
                            }
                            fullPath = await joinNativePath(outputDir, fileName)
                            await writeFile(fullPath, bytes)
                        } else {
                            // Save relative to Pictures directory
                            const dirExists = await exists(outputDir, { baseDir: MEDIA_STORAGE_BASE_DIRECTORY })
                            if (!dirExists) {
                                await mkdir(outputDir, { baseDir: MEDIA_STORAGE_BASE_DIRECTORY })
                            }
                            await writeFile(`${outputDir}/${fileName}`, bytes, { baseDir: MEDIA_STORAGE_BASE_DIRECTORY })
                            fullPath = await joinNativePath(await getMediaStorageRoot(), outputDir, fileName)
                        }

                        publishGeneratedArtifact({
                            path: fullPath,
                            data: `data:${mimeType};base64,${result.imageData}`,
                        })
                    } catch (e) {
                        console.warn('Failed to save regenerated image:', e)
                    }
                } else {
                    // Auto-save OFF (Regenerate): Dispatch memory-only event
                    const fileName = `NAI_Blue_${Date.now()}.${fileExt}`
                    const memoryPath = `memory://${fileName}`

                    publishGeneratedArtifact({
                        path: memoryPath,
                        data: `data:${mimeType};base64,${result.imageData}`,
                    })
                }

                toast({ title: t('toast.regenerated', '재생성 완료'), variant: 'success' })
            } else {
                toast({ title: t('toast.generateFailed', '생성 실패'), description: result.error, variant: 'destructive' })
            }
        } catch (e) {
            console.error('Regenerate failed:', e)
        } finally {
            setIsGenerating(false)
        }
    }

    // Open folder containing saved images
    const handleOpenFolder = async (image: SavedImage) => {
        if (image.isTemporary) return
        try {
            await revealNativeItem(image.path)
        } catch (e) {
            console.error('Failed to open folder:', e)
        }
    }

    const handleOpenSmartTools = async (image: SavedImage) => {
        if (guided) return
        setIsLoading(true)
        try {
            let base64 = imageThumbnails[image.path]

            if (!base64 && !image.isTemporary) {
                // Read full image file to pass to tools
                const data = await readFile(image.path)
                base64 = `data:image/png;base64,${arrayBufferToBase64(data)}`
            }

            if (base64) {
                setActiveImage(base64)
                navigate('/tools')
            }
        } catch (e) {
            toast({ title: t('smartTools.error', '이미지 로드 실패'), variant: 'destructive' })
        } finally {
            setIsLoading(false)
        }
    }

    const handleSaveAs = async (image: SavedImage) => {
        try {
            let data: Uint8Array

            if (image.isTemporary) {
                const base64 = imageThumbnails[image.path]
                if (!base64) throw new Error("Image data not found")
                // Convert base64 back to Uint8Array
                const binaryString = atob(base64.split(',')[1])
                data = new Uint8Array(binaryString.length)
                for (let i = 0; i < binaryString.length; i++) {
                    data[i] = binaryString.charCodeAt(i)
                }
            } else {
                data = await readFile(image.path)
            }

            const filePath = await saveNativeFileDialog({
                defaultPath: image.name,
                filters: [{ name: 'PNG Image', extensions: ['png'] }],
            })
            if (filePath) {
                await writeFile(filePath, data)
                toast({ title: t('toast.saved', '저장 완료'), variant: 'success' })
            }
        } catch (e) {
            console.error('Save failed:', e)
            toast({ title: t('toast.saveFailed', '저장 실패'), variant: 'destructive' })
        }
    }

    const handleAddAsReference = async (image: SavedImage) => {
        let imageData = imageThumbnails[image.path]
        if (!imageData && !image.isTemporary) {
            try {
                const data = await readFile(image.path)
                const base64 = arrayBufferToBase64(data)
                imageData = `data:image/png;base64,${base64}`
            } catch { return }
        }
        setSelectedImageForRef(imageData)
        setImageRefDialogOpen(true)
    }

    const handleAddToLibrary = (image: SavedImage) => {
        if (libraryItems.some(item => item.path === image.path)) {
            toast({ title: t('history.alreadyInLibrary', 'Already in library') })
            return
        }
        addLibraryItem({
            id: `history-${image.timestamp}-${crypto.randomUUID()}`,
            name: image.name.replace(/\.[^.]+$/, ''),
            path: image.path,
            width: 0,
            height: 0,
            createdAt: image.timestamp,
        })
        toast({ title: t('history.addedToLibrary', 'Added to library'), variant: 'success' })
    }

    // Inpainting: Open dialog directly with image (source/mode set when mask is saved)
    const handleInpaint = async (image: SavedImage) => {
        let imageData = imageThumbnails[image.path]
        if (!imageData && !image.isTemporary) {
            try {
                const data = await readFile(image.path)
                const base64 = arrayBufferToBase64(data)
                imageData = `data:image/png;base64,${base64}`
                // NOT caching full base64 in thumbnails - use directly
            } catch { return }
        }
        if (!imageData) return
        
        // Only open dialog - source/mode will be set when mask is saved
        setSelectedImageForInpaint(imageData)
        setInpaintDialogOpen(true)
    }

    // I2I: Set source and navigate to main mode
    const handleI2I = async (image: SavedImage) => {
        if (guided) return
        setSourceEditPreparing(true)
        try {
            if (!await waitForApiTokenReady()) return
            let imageData = imageThumbnails[image.path]
            if (!imageData && !image.isTemporary) {
                try {
                    const data = await readFile(image.path)
                    const base64 = arrayBufferToBase64(data)
                    imageData = `data:image/png;base64,${base64}`
                    // NOT caching full base64 in thumbnails - use directly
                } catch { return }
            }
            if (!imageData) return

            setSourceImage(imageData)
            setI2IMode('i2i')
            navigate('/advanced')
        } finally {
            setSourceEditPreparing(false)
        }
    }

    return (
        <div className={`relative flex min-h-0 flex-col ${guided ? 'min-h-full' : 'h-full'}`} data-guided-history={guided || undefined}>
            {sourceEditPreparing && (
                <div className="absolute inset-0 z-20 flex items-center justify-center bg-scrim/70" role="status" aria-live="polite">
                    <div className="flex items-center gap-2 rounded-control bg-popover px-4 py-3 text-sm text-popover-foreground shadow-overlay">
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        {t('credentialVault.status.unlocking')}
                    </div>
                </div>
            )}
            {/* Header */}
            <div className="flex min-h-14 shrink-0 items-center justify-between px-5 py-3">
                <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <FolderOpen className="h-4 w-4 text-primary" />
                    {t('history.title')}
                </span>
                <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                        {t('history.count', { count: savedImages.length })}
                    </span>
                    <Button
                        data-testid="history-refresh"
                        variant="ghost"
                        size="icon"
                        className="h-11 w-11 shrink-0"
                        onClick={loadSavedImages}
                        disabled={isLoading}
                        aria-label={t('history.refresh', '기록 새로고침')}
                    >
                        <RefreshCw className={`h-3.5 w-3.5 text-muted-foreground ${isLoading ? 'animate-spin' : ''}`} />
                    </Button>
                </div>
            </div>

            {/* The indexed queue summary stays lightweight; Queue Center remains
                the sole owner of detailed projections, retries, and job controls. */}
            {!guided && <QueueActivityLink />}

            {guidedSelection && (
                <section className="grid gap-5 border-y border-border/60 p-4 sm:p-5 lg:grid-cols-[minmax(16rem,0.9fr)_minmax(18rem,1.1fr)]" aria-label={t('history.preview', '선택한 이미지 미리보기')}>
                    <div className="flex min-h-64 items-center justify-center overflow-hidden bg-muted/30">
                        <img
                            src={guidedSelection.dataUrl}
                            alt={guidedSelection.image.name}
                            className="max-h-[34rem] max-w-full object-contain"
                        />
                    </div>
                    <div className="flex min-w-0 flex-col justify-center">
                        <p className="text-sm font-semibold text-primary">{t('history.selected', '선택한 이미지')}</p>
                        <h2 className="mt-2 break-words text-xl font-semibold">{guidedSelection.image.name}</h2>
                        <p className="mt-2 text-sm leading-6 text-muted-foreground">
                            {t('history.guidedActions', '메타데이터를 확인하거나, 라이브러리에 보관하고, 다른 이름으로 저장할 수 있어요.')}
                        </p>
                        <div className="mt-5 flex flex-wrap gap-2">
                            <Button variant="outline" onClick={() => void handleLoadMetadata(guidedSelection.image)}>
                                <FileSearch className="mr-2 h-4 w-4" />
                                {t('metadata.loadFromImage', '메타데이터 보기')}
                            </Button>
                            <Button variant="outline" onClick={() => handleAddToLibrary(guidedSelection.image)}>
                                <Images className="mr-2 h-4 w-4" />
                                {t('history.addToLibrary', '라이브러리에 추가')}
                            </Button>
                            <Button variant="outline" onClick={() => void handleSaveAs(guidedSelection.image)}>
                                <Save className="mr-2 h-4 w-4" />
                                {t('actions.saveAs', '다른 이름으로 저장')}
                            </Button>
                            <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => requestDeleteImage(guidedSelection.image)}>
                                <Trash2 className="mr-2 h-4 w-4" />
                                {t('trash.move', '휴지통으로 이동')}
                            </Button>
                        </div>
                    </div>
                </section>
            )}

            {/* History Grid */}
            <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 pt-2">
                {savedImages.length === 0 ? (
                    <div className="flex h-full min-h-48 flex-col items-center justify-center px-4 text-center text-muted-foreground" role="status" aria-live="polite">
                        <div className="mb-3 flex h-12 w-12 items-center justify-center text-muted-foreground/70">
                            {isLoading ? <RefreshCw className="h-5 w-5 animate-spin" /> : <Clock className="h-5 w-5" />}
                        </div>
                        <span className="text-sm">{isLoading ? t('common.loading', '불러오는 중…') : t('history.empty')}</span>
                        {!isLoading && (
                            <span className="mt-1 max-w-48 text-xs leading-5 text-muted-foreground/80">
                                {t('history.emptyHint', '프롬프트를 열어 첫 이미지를 만들어 보세요.')}
                            </span>
                        )}
                    </div>
                ) : (
                    <div className={guided
                        ? 'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5'
                        : 'grid grid-cols-2 gap-3 2xl:grid-cols-1'}>
                        {savedImages.map((image, index) => (
                            <HistoryImageItem
                                key={image.path}
                                image={image}
                                thumbnail={imageThumbnails[image.path]}
                                onLoadComplete={handleImageLoadComplete}
                                index={index}
                                getTypeIcon={getTypeIcon}
                                onImageClick={handleImageClick}
                                onDelete={requestDeleteImage}
                                onSaveAs={handleSaveAs}
                                onCopy={handleCopyImage}
                                onRegenerate={handleRegenerate}
                                onOpenSmartTools={handleOpenSmartTools}
                                onAddAsReference={handleAddAsReference}
                                onInpaint={handleInpaint}
                                onI2I={handleI2I}
                                onOpenFolder={handleOpenFolder}
                                onLoadMetadata={handleLoadMetadata}
                                onAddToLibrary={handleAddToLibrary}
                                guided={guided}
                            />
                        ))}
                    </div>
                )}
            </div>

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

            <ConfirmDialog
                open={pendingDeleteImage !== null}
                onOpenChange={open => { if (!open) setPendingDeleteImage(null) }}
                title={t('trash.confirmMoveTitle', '휴지통으로 이동할까요?')}
                description={t('trash.confirmMoveDescription', '항목은 30일 동안 휴지통에 보관됩니다.')}
                confirmText={t('trash.move', '휴지통으로 이동')}
                cancelText={t('common.cancel', '취소')}
                variant="destructive"
                onConfirm={moveHistoryImageToTrash}
            />
        </div>
    )
}
