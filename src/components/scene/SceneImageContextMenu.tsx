import { useShallow } from 'zustand/react/shallow'
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuTrigger,
    ContextMenuSeparator,
} from '@/components/ui/context-menu'
import { Copy, FolderOpen, Save, Trash2, Wand2, Users, FileSearch, Paintbrush, Image as ImageIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from '@/components/ui/use-toast'
import { saveNativeFileDialog } from '@/platform/native-file-dialog'
import { readNativeBinaryFile, writeNativeBinaryFile } from '@/platform/native-file-system'
import { revealNativeItem } from '@/platform/native-shell'
import { useNavigate } from 'react-router'
import { useToolsStore } from '@/stores/tools-store'
import { useGenerationStore } from '@/stores/generation-store'
import { useSettingsStore } from '@/stores/settings-store'
import { SceneImage } from '@/stores/scene-store'

interface SceneContextMenuProps {
    image: SceneImage
    children: React.ReactNode
    onDelete: () => void
    onAddRef?: () => void
    onLoadMetadata?: () => void
    onInpaint?: (base64: string) => void
}

export function SceneImageContextMenu({ image, children, onDelete, onAddRef, onLoadMetadata, onInpaint }: SceneContextMenuProps) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { setActiveImage } = useToolsStore()
    const { setSourceImage, setI2IMode } = useGenerationStore(useShallow(state => ({ setSourceImage: state.setSourceImage, setI2IMode: state.setI2IMode })))

    // Determine file path. 
    // image.url is expected to be the full file path for saved images.
    // If it's data: URI, some features like Open Folder won't work well, but logic below handles standard paths.
    const isFile = !image.url.startsWith('data:')

    const handleCopy = async () => {
        try {
            let blob: Blob
            if (isFile) {
                const data = await readNativeBinaryFile(image.url)
                blob = new Blob([data], { type: 'image/png' })
            } else {
                // Handle Base64 (Streaming/Preview)
                const res = await fetch(image.url)
                blob = await res.blob()
            }

            await navigator.clipboard.write([
                new ClipboardItem({ [blob.type]: blob })
            ])
            toast({ title: t('actions.copied', '복사 완료'), variant: 'success' })
        } catch (e) {
            console.error('Copy failed:', e)
            toast({ title: t('actions.copyFailed', '복사 실패'), variant: 'destructive' })
        }
    }

    const handleSaveAs = async () => {
        try {
            let data: Uint8Array
            if (isFile) {
                data = await readNativeBinaryFile(image.url)
            } else {
                const res = await fetch(image.url)
                const buffer = await res.arrayBuffer()
                data = new Uint8Array(buffer)
            }

            const { imageFormat } = useSettingsStore.getState()
            const fileExt = imageFormat === 'webp' ? 'webp' : 'png'
            const filePath = await saveNativeFileDialog({
                defaultPath: `NAI_Blue_${image.timestamp}.${fileExt}`,
                filters: [{ name: 'Image', extensions: ['png', 'jpg', 'webp'] }],
            })
            if (filePath) {
                await writeNativeBinaryFile(filePath, data)
                toast({ title: t('toast.saved', '저장 완료'), variant: 'success' })
            }
        } catch (e) {
            console.error('Save failed:', e)
            toast({ title: t('toast.saveFailed', '저장 실패'), variant: 'destructive' })
        }
    }

    const handleSmartTools = async () => {
        try {
            let base64 = ''
            if (isFile) {
                const data = await readNativeBinaryFile(image.url)
                // Convert to base64
                let binary = ''
                const len = data.byteLength
                for (let i = 0; i < len; i++) {
                    binary += String.fromCharCode(data[i])
                }
                base64 = btoa(binary)
            } else {
                base64 = image.url.split(',')[1]
            }

            setActiveImage(`data:image/png;base64,${base64}`)
            navigate('/tools')
        } catch (e) {
            console.error('Failed to load for tools:', e)
            toast({ title: t('smartTools.error', '이미지 로드 실패'), variant: 'destructive' })
        }
    }

    const handleOpenFolder = async () => {
        if (!isFile) return
        try {
            await revealNativeItem(image.url)
        } catch (e) {
            console.error('Failed to open folder:', e)
        }
    }

    // Helper to get base64 data
    const getImageBase64 = async (): Promise<string | null> => {
        try {
            if (isFile) {
                const data = await readNativeBinaryFile(image.url)
                let binary = ''
                const len = data.byteLength
                for (let i = 0; i < len; i++) {
                    binary += String.fromCharCode(data[i])
                }
                return `data:image/png;base64,${btoa(binary)}`
            } else {
                return image.url
            }
        } catch (e) {
            console.error('Failed to get image data:', e)
            return null
        }
    }

    // Inpainting: Call parent callback with base64 data
    const handleInpaint = async () => {
        if (!onInpaint) return
        const base64 = await getImageBase64()
        if (!base64) return
        onInpaint(base64)
    }

    const handleI2I = async () => {
        const base64 = await getImageBase64()
        if (!base64) return
        
        setSourceImage(base64)
        setI2IMode('i2i')
        navigate('/advanced')
    }

    const handleDelete = () => {
        // The owner opens the shared confirmation and archives the file before
        // changing SceneStore. This menu deliberately never removes disk data.
        onDelete()
    }

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>
                {children}
            </ContextMenuTrigger>
            <ContextMenuContent className="w-64">
                <ContextMenuItem onClick={handleSaveAs}>
                    <Save className="h-4 w-4 mr-2" />
                    {t('actions.saveAs', '다른 이름으로 저장')}
                </ContextMenuItem>
                <ContextMenuItem onClick={handleCopy}>
                    <Copy className="h-4 w-4 mr-2" />
                    {t('actions.copy', '복사')}
                </ContextMenuItem>
                <ContextMenuItem onClick={handleSmartTools}>
                    <Wand2 className="h-4 w-4 mr-2" />
                    {t('smartTools.title', '스마트 툴')}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={handleInpaint} disabled={!onInpaint}>
                    <Paintbrush className="h-4 w-4 mr-2" />
                    {t('tools.inpainting.title', '인페인팅')}
                </ContextMenuItem>
                <ContextMenuItem onClick={handleI2I}>
                    <ImageIcon className="h-4 w-4 mr-2" />
                    {t('tools.i2i.title', 'Image to Image')}
                </ContextMenuItem>
                <ContextMenuSeparator />

                {onAddRef && (
                    <ContextMenuItem onClick={onAddRef}>
                        <Users className="h-4 w-4 mr-2" />
                        {t('actions.addAsRef', '이미지 참조')}
                    </ContextMenuItem>
                )}

                {onLoadMetadata && (
                    <ContextMenuItem onClick={onLoadMetadata}>
                        <FileSearch className="h-4 w-4 mr-2" />
                        {t('metadata.loadFromImage', '메타데이터 불러오기')}
                    </ContextMenuItem>
                )}

                {isFile && (
                    <ContextMenuItem onClick={handleOpenFolder}>
                        <FolderOpen className="h-4 w-4 mr-2" />
                        {t('actions.openFolder', '탐색기에서 열기')}
                    </ContextMenuItem>
                )}

                <ContextMenuItem onClick={handleDelete} className="text-destructive focus:text-destructive">
                    <Trash2 className="h-4 w-4 mr-2" />
                    {t('actions.delete', '삭제')}
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    )
}
