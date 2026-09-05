import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { LibraryItem as LibraryItemType } from '@/stores/library-store'
import { toNativeAssetUrl } from '@/platform/asset-url'
import { LibraryContextMenu } from './LibraryContextMenu'
import { cn } from '@/lib/utils'
import { Check, Cloud, Square, Layers } from 'lucide-react'

interface LibraryItemProps {
    item: LibraryItemType
    className?: string
    isOverlay?: boolean
    onRename?: (item: LibraryItemType) => void
    onAddRef?: (item: LibraryItemType) => void
    onLoadMetadata?: (item: LibraryItemType) => void
    onEditImage?: (item: LibraryItemType) => void
    onOpenTools?: () => void
    folderLabel?: string
    onImageClick?: (imageUrl: string) => void
    isEditMode?: boolean
    isSelected?: boolean
    onSelectionClick?: (e: React.MouseEvent) => void
}

export function LibraryItem({ item, className, isOverlay, onRename, onAddRef, onLoadMetadata, onEditImage, onOpenTools, folderLabel, onImageClick, isEditMode, isSelected, onSelectionClick }: LibraryItemProps) {
    const { t } = useTranslation()
    const [imageUrl, setImageUrl] = useState<string>('')
    const [isLoading, setIsLoading] = useState(true)

    useEffect(() => {
        // Browser imports are persisted data URLs; native files still use the
        // platform asset protocol without copying their bytes into React state.
        try {
            const assetUrl = /^(data:|blob:|https?:)/i.test(item.path)
                ? item.path
                : toNativeAssetUrl(item.path)
            setImageUrl(assetUrl)
            setIsLoading(false)
        } catch (e) {
            console.error('Failed to create asset URL:', e)
            setIsLoading(false)
        }
    }, [item.path])

    const handleClick = (e: React.MouseEvent) => {
        if (isEditMode && onSelectionClick) {
            e.preventDefault()
            e.stopPropagation()
            onSelectionClick(e)
        } else if (imageUrl && onImageClick) {
            onImageClick(imageUrl)
        }
    }

    const content = (
        <div
            className={cn(
                "relative group aspect-[2/3] rounded-xl overflow-hidden bg-muted/30 border border-border/50 shadow-sm transition-all hover:ring-2 hover:ring-primary/50",
                isOverlay && "ring-2 ring-primary shadow-xl cursor-grabbing z-50",
                isEditMode && isSelected && "ring-2 ring-primary",
                className
            )}
            onClick={handleClick}
        >
            {isLoading ? (
                <div className="w-full h-full flex items-center justify-center animate-pulse bg-muted">
                    <span className="sr-only">Loading...</span>
                </div>
            ) : (
                <img
                    src={imageUrl}
                    alt={item.name}
                    className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                    draggable={false} // Prevent native drag
                />
            )}

            {/* Edit Mode Checkbox - not shown for stacks */}
            {isEditMode && !item.isStack && (
                <div className="absolute top-2 left-2 z-30">
                    <div className={cn(
                        "h-6 w-6 rounded-md flex items-center justify-center transition-all",
                        isSelected ? "bg-primary text-primary-foreground" : "bg-scrim/50 text-primary-foreground/70"
                    )}>
                        {isSelected ? <Check className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                    </div>
                </div>
            )}

            {/* Stack Badge */}
            {item.isStack && (
                <div className="absolute top-2 right-2 z-30 px-2 py-1 bg-primary text-primary-foreground text-xs font-bold rounded-full flex items-center gap-1">
                    <Layers className="h-3 w-3" />
                    {t('library.stackCount', '{{count}}개', { count: item.stackItems?.length || 0 })}
                </div>
            )}

            <div className="absolute bottom-0 left-0 right-0 bg-scrim/70 p-2 opacity-100 transition-opacity lg:opacity-0 lg:group-focus-within:opacity-100 lg:group-hover:opacity-100">
                <p className="truncate px-1 text-xs text-primary-foreground">{item.name}</p>
                {item.r2Status === 'queued' && (
                    <p className="px-1 text-[11px] text-primary-foreground/70" title={item.r2JobIds?.join(', ')}>
                        {t('library.r2Queued', 'R2 delivery queued')}
                    </p>
                )}
                {folderLabel && (
                    <p className="mt-0.5 flex items-center gap-1 truncate px-1 text-[11px] text-primary-foreground/70">
                        {item.r2Status === 'uploaded' && <Cloud className="h-3 w-3 shrink-0" />}
                        <span className="truncate">{folderLabel}</span>
                    </p>
                )}
            </div>
        </div>
    )

    if (isOverlay || isEditMode) return content

    return (
        <LibraryContextMenu
            item={item}
            onRename={onRename ? () => onRename(item) : undefined}
            onAddRef={onAddRef ? () => onAddRef(item) : undefined}
            onLoadMetadata={onLoadMetadata ? () => onLoadMetadata(item) : undefined}
            onEditImage={onEditImage ? () => onEditImage(item) : undefined}
            onOpenTools={onOpenTools}
        >
            {content}
        </LibraryContextMenu>
    )
}
