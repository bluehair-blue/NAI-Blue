import {
    closestCenter,
    DndContext,
    KeyboardSensor,
    PointerSensor,
    useDraggable,
    useDroppable,
    useSensor,
    useSensors,
    type DragEndEvent,
} from '@dnd-kit/core'
import {
    sortableKeyboardCoordinates,
    SortableContext,
    useSortable,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Plus, Trash2, UserMinus, UserPlus } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { AutocompleteTextarea } from '@/components/ui/AutocompleteTextarea'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { CharacterPrompt } from '@/stores/character-prompt-store'
import {
    resolveSceneCharacterCaptions,
    useSceneStore,
    type SceneCard,
    type SceneCharacterCaption,
} from '@/stores/scene-store'
import { useSettingsStore } from '@/stores/settings-store'

interface SceneCharacterCaptionsEditorProps {
    scene: SceneCard
    presetId: string
    availableCharacters: readonly CharacterPrompt[]
    disabled?: boolean
}

const INCLUDED_ZONE_ID = 'scene-character-included-zone'
const EXCLUDED_ZONE_ID = 'scene-character-excluded-zone'
const MAIN_DRAG_PREFIX = 'scene-main-character:'
const CAPTION_DRAG_PREFIX = 'scene-caption:'

const clampCoordinate = (value: number): number => Math.min(1, Math.max(0, value))
const mainDragId = (id: string): string => `${MAIN_DRAG_PREFIX}${id}`
const captionDragId = (id: string): string => `${CAPTION_DRAG_PREFIX}${id}`

/**
 * Moves one persisted caption between the included/excluded partitions. The
 * over-caption index follows dnd-kit's arrayMove behavior while caption fields
 * remain untouched, so excluding a character never destroys local edits.
 */
export function placeSceneCharacterCaption(
    captions: readonly SceneCharacterCaption[],
    captionId: string,
    targetEnabled: boolean,
    overCaptionId?: string,
): SceneCharacterCaption[] {
    const moving = captions.find(caption => caption.id === captionId)
    if (!moving) return [...captions]
    if (moving.enabled === targetEnabled && overCaptionId === captionId) return [...captions]

    const originalTarget = captions.filter(caption => caption.enabled === targetEnabled)
    const requestedIndex = overCaptionId === undefined
        ? originalTarget.length
        : originalTarget.findIndex(caption => caption.id === overCaptionId)
    const remaining = captions.filter(caption => caption.id !== captionId)
    const target = remaining.filter(caption => caption.enabled === targetEnabled)
    const other = remaining.filter(caption => caption.enabled !== targetEnabled)
    const insertIndex = requestedIndex < 0
        ? target.length
        : Math.min(requestedIndex, target.length)
    target.splice(insertIndex, 0, {
        ...moving,
        enabled: targetEnabled,
        position: { ...moving.position },
    })
    return targetEnabled ? [...target, ...other] : [...other, ...target]
}

/** Main characters are copied once; later Scene-local edits stay isolated. */
export function addMainCharacterToScene(
    captions: readonly SceneCharacterCaption[],
    character: Pick<CharacterPrompt, 'id' | 'name' | 'prompt' | 'negative' | 'position'>,
    targetEnabled = true,
    overCaptionId?: string,
): SceneCharacterCaption[] {
    if (captions.some(caption => caption.id === character.id)) {
        return placeSceneCharacterCaption(captions, character.id, targetEnabled, overCaptionId)
    }
    const next = [...captions, {
        id: character.id,
        name: character.name,
        prompt: character.prompt,
        negative: character.negative,
        enabled: targetEnabled,
        position: { ...character.position },
    }]
    return placeSceneCharacterCaption(next, character.id, targetEnabled, overCaptionId)
}

function AvailableCharacterCard({
    character,
    disabled,
    onAdd,
}: {
    character: CharacterPrompt
    disabled: boolean
    onAdd: () => void
}) {
    const { t } = useTranslation()
    const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
        id: mainDragId(character.id),
        disabled,
    })
    const style: CSSProperties = {
        transform: CSS.Transform.toString(transform),
        opacity: isDragging ? 0.55 : 1,
        zIndex: isDragging ? 20 : undefined,
        position: isDragging ? 'relative' : undefined,
    }
    const name = character.name?.trim()
        || character.prompt.split(',')[0]?.trim()
        || t('scene.unnamedCharacter', '이름 없는 캐릭터')

    return (
        <div
            ref={setNodeRef}
            style={style}
            className="flex items-center gap-2 rounded-control bg-card px-2 py-2"
            data-testid="scene-available-character"
        >
            <button
                type="button"
                className="flex h-11 w-11 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground hover:text-foreground disabled:cursor-not-allowed"
                disabled={disabled}
                aria-label={t('scene.dragCharacterToScene', '{{name}} 드래그하여 씬에 추가', { name })}
                {...attributes}
                {...listeners}
            >
                <GripVertical className="h-4 w-4" />
            </button>
            <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium">{name}</div>
                <div className="truncate text-[11px] text-muted-foreground" title={character.prompt}>
                    {character.prompt || t('scene.emptyCharacterPrompt', '빈 프롬프트')}
                </div>
            </div>
            <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-11 w-11 shrink-0"
                onClick={onAdd}
                disabled={disabled}
                aria-label={t('scene.addNamedCharacter', '{{name}} 포함', { name })}
            >
                <UserPlus className="h-4 w-4" />
            </Button>
        </div>
    )
}

function CaptionDropZone({
    id,
    testId,
    title,
    description,
    emptyLabel,
    itemIds,
    disabled,
    children,
}: {
    id: string
    testId: string
    title: string
    description: string
    emptyLabel: string
    itemIds: readonly string[]
    disabled: boolean
    children: ReactNode
}) {
    const { setNodeRef, isOver } = useDroppable({ id, disabled })
    return (
        <section
            ref={setNodeRef}
            className={cn(
                'min-h-28 rounded-control bg-canvas/70 p-2 transition-colors',
                isOver && 'bg-primary/10 ring-1 ring-primary/40',
            )}
            data-testid={testId}
        >
            <div className="mb-2">
                <h4 className="text-xs font-semibold">{title}</h4>
                <p className="text-[11px] text-muted-foreground">{description}</p>
            </div>
            <SortableContext items={[...itemIds]} strategy={verticalListSortingStrategy}>
                <div className="grid min-h-14 gap-2">
                    {itemIds.length === 0
                        ? <div className="grid min-h-14 place-items-center px-2 text-center text-[11px] text-muted-foreground">{emptyLabel}</div>
                        : children}
                </div>
            </SortableContext>
        </section>
    )
}

interface SortableCaptionCardProps {
    caption: SceneCharacterCaption
    index: number
    positionEnabled: boolean
    disabled: boolean
    fontSize: number
    onPatch: (patch: Partial<SceneCharacterCaption>) => void
    onEnabledChange: (enabled: boolean) => void
    onRemove: () => void
    onCoordinateChange: (axis: 'x' | 'y', raw: string) => void
}

function SortableCaptionCard({
    caption,
    index,
    positionEnabled,
    disabled,
    fontSize,
    onPatch,
    onEnabledChange,
    onRemove,
    onCoordinateChange,
}: SortableCaptionCardProps) {
    const { t } = useTranslation()
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: captionDragId(caption.id),
        disabled,
    })
    const style: CSSProperties = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.45 : 1,
        zIndex: isDragging ? 20 : undefined,
        position: isDragging ? 'relative' : undefined,
    }
    const name = caption.name?.trim() || t('scene.unnamedCharacter', '이름 없는 캐릭터')

    if (!caption.enabled) {
        return (
            <article
                ref={setNodeRef}
                style={style}
                className="flex items-center gap-2 rounded-control bg-card px-2 py-2"
                data-testid="scene-character-caption"
                data-caption-state="excluded"
            >
                <button
                    type="button"
                    className="flex h-11 w-11 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground hover:text-foreground disabled:cursor-not-allowed"
                    disabled={disabled}
                    aria-label={t('scene.reorderCharacter', '{{name}} 순서 이동', { name })}
                    {...attributes}
                    {...listeners}
                >
                    <GripVertical className="h-4 w-4" />
                </button>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium">{name}</div>
                    <div className="truncate text-[11px] text-muted-foreground">
                        {caption.prompt || caption.negative || t('scene.emptyCharacterPrompt', '빈 프롬프트')}
                    </div>
                </div>
                <Button type="button" variant="secondary" size="sm" className="h-11" onClick={() => onEnabledChange(true)} disabled={disabled}>
                    <UserPlus className="h-3.5 w-3.5" />
                    {t('scene.includeCharacter', '포함')}
                </Button>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11 shrink-0"
                    onClick={onRemove}
                    disabled={disabled}
                    aria-label={t('scene.removeCharacterCaption', '캐릭터 캡션 삭제')}
                >
                    <Trash2 className="h-4 w-4" />
                </Button>
            </article>
        )
    }

    return (
        <article
            ref={setNodeRef}
            style={style}
            className="rounded-control bg-card p-3"
            data-testid="scene-character-caption"
            data-caption-state="included"
        >
            <div className="flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    className="flex h-11 w-11 shrink-0 cursor-grab touch-none items-center justify-center rounded-control bg-muted text-muted-foreground hover:text-foreground disabled:cursor-not-allowed"
                    disabled={disabled}
                    aria-label={t('scene.reorderCharacter', '{{name}} 순서 이동', { name })}
                    {...attributes}
                    {...listeners}
                >
                    <GripVertical className="h-4 w-4" />
                </button>
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control bg-muted text-xs font-semibold">
                    {index + 1}
                </span>
                <Input
                    value={caption.name ?? ''}
                    onChange={event => onPatch({ name: event.target.value })}
                    placeholder={t('scene.characterName', '캐릭터 이름')}
                    aria-label={t('scene.characterName', '캐릭터 이름')}
                    disabled={disabled}
                    className="h-10 min-w-40 flex-1"
                />
                <Button type="button" variant="secondary" size="sm" className="h-11" onClick={() => onEnabledChange(false)} disabled={disabled}>
                    <UserMinus className="h-3.5 w-3.5" />
                    {t('scene.excludeCharacter', '제외')}
                </Button>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={onRemove}
                    disabled={disabled}
                    aria-label={t('scene.removeCharacterCaption', '캐릭터 캡션 삭제')}
                >
                    <Trash2 className="h-4 w-4" />
                </Button>
            </div>

            <div className="mt-3 grid gap-3 lg:grid-cols-2">
                <label className="space-y-1">
                    <span className="text-xs font-medium text-muted-foreground">
                        {t('characterPanel.prompt', '프롬프트')}
                    </span>
                    <AutocompleteTextarea
                        key={`${caption.id}:positive`}
                        value={caption.prompt}
                        onChange={event => onPatch({ prompt: event.target.value })}
                        placeholder={t('scene.characterPromptPlaceholder', '캐릭터 프롬프트')}
                        ariaLabel={`${name} ${t('characterPanel.prompt', '프롬프트')}`}
                        disabled={disabled}
                        className="h-28 min-h-28 resize-y"
                        style={{ fontSize: `${fontSize}px` }}
                    />
                </label>
                <label className="space-y-1">
                    <span className="text-xs font-medium text-muted-foreground">
                        {t('scene.characterNegativePrompt', '캐릭터 네거티브')}
                    </span>
                    <AutocompleteTextarea
                        key={`${caption.id}:negative`}
                        value={caption.negative}
                        onChange={event => onPatch({ negative: event.target.value })}
                        placeholder={t('scene.characterNegativePromptPlaceholder', '캐릭터 네거티브 프롬프트')}
                        ariaLabel={`${name} ${t('scene.characterNegativePrompt', '캐릭터 네거티브')}`}
                        disabled={disabled}
                        className="h-28 min-h-28 resize-y focus-within:ring-destructive/50"
                        style={{ fontSize: `${fontSize}px` }}
                    />
                </label>
            </div>

            {positionEnabled && (
                <div className="mt-3 grid max-w-xs grid-cols-2 gap-2">
                    {(['x', 'y'] as const).map(axis => (
                        <label key={axis} className="space-y-1">
                            <span className="text-xs font-medium uppercase text-muted-foreground">{axis}</span>
                            <Input
                                type="number"
                                min={0}
                                max={1}
                                step={0.01}
                                value={caption.position[axis]}
                                onChange={event => onCoordinateChange(axis, event.target.value)}
                                disabled={disabled}
                            />
                        </label>
                    ))}
                </div>
            )}
        </article>
    )
}

/**
 * This controlled editor writes the complete Scene-owned caption array. The
 * generation builders consume that same array, so UI order, enable state,
 * negatives, and coordinates survive persistence without touching Main mode.
 */
export function SceneCharacterCaptionsEditor({
    scene,
    presetId,
    availableCharacters,
    disabled = false,
}: SceneCharacterCaptionsEditorProps) {
    const { t } = useTranslation()
    const fontSize = useSettingsStore(state => state.promptFontSize)
    const captions = resolveSceneCharacterCaptions(scene)
    const updateCaptions = useSceneStore(state => state.updateSceneCharacterCaptions)
    const positionEnabled = scene.characterPositionEnabled === true
    const included = captions.filter(caption => caption.enabled)
    const excluded = captions.filter(caption => !caption.enabled)
    const assignedIds = new Set(captions.map(caption => caption.id))
    const available = availableCharacters.filter(character => !assignedIds.has(character.id))
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    )

    const commit = (next: readonly SceneCharacterCaption[], nextPositionEnabled?: boolean) => {
        updateCaptions(presetId, scene.id, next, nextPositionEnabled)
    }

    const addCaption = () => {
        const id = `${Date.now()}-${crypto.randomUUID()}`
        commit(placeSceneCharacterCaption([...captions, {
            id,
            name: '',
            prompt: '',
            negative: '',
            enabled: true,
            position: { x: 0.5, y: 0.5 },
        }], id, true))
    }

    const addAvailableCharacter = (character: CharacterPrompt) => {
        commit(addMainCharacterToScene(captions, character))
    }

    const patchCaption = (id: string, patch: Partial<SceneCharacterCaption>) => {
        commit(captions.map(caption => caption.id === id
            ? {
                ...caption,
                ...patch,
                position: patch.position ? { ...patch.position } : caption.position,
            }
            : caption))
    }

    const patchCoordinate = (caption: SceneCharacterCaption, axis: 'x' | 'y', raw: string) => {
        const value = Number(raw)
        if (!Number.isFinite(value)) return
        patchCaption(caption.id, {
            position: { ...caption.position, [axis]: clampCoordinate(value) },
        })
    }

    const handleDragEnd = (event: DragEndEvent) => {
        if (disabled || event.over === null) return
        const activeId = String(event.active.id)
        const overId = String(event.over.id)
        const overCaptionId = overId.startsWith(CAPTION_DRAG_PREFIX)
            ? overId.slice(CAPTION_DRAG_PREFIX.length)
            : undefined
        const targetEnabled = overId === INCLUDED_ZONE_ID
            ? true
            : overId === EXCLUDED_ZONE_ID
                ? false
                : overCaptionId === undefined
                    ? undefined
                    : captions.find(caption => caption.id === overCaptionId)?.enabled
        if (targetEnabled === undefined) return

        if (activeId.startsWith(MAIN_DRAG_PREFIX)) {
            const characterId = activeId.slice(MAIN_DRAG_PREFIX.length)
            const character = availableCharacters.find(item => item.id === characterId)
            if (character) {
                commit(addMainCharacterToScene(captions, character, targetEnabled, overCaptionId))
            }
            return
        }
        if (activeId.startsWith(CAPTION_DRAG_PREFIX)) {
            const captionId = activeId.slice(CAPTION_DRAG_PREFIX.length)
            commit(placeSceneCharacterCaption(captions, captionId, targetEnabled, overCaptionId))
        }
    }

    const renderCaption = (caption: SceneCharacterCaption, index: number) => (
        <SortableCaptionCard
            key={caption.id}
            caption={caption}
            index={index}
            positionEnabled={positionEnabled}
            disabled={disabled}
            fontSize={fontSize}
            onPatch={patch => patchCaption(caption.id, patch)}
            onEnabledChange={enabled => commit(placeSceneCharacterCaption(captions, caption.id, enabled))}
            onRemove={() => commit(captions.filter(item => item.id !== caption.id))}
            onCoordinateChange={(axis, raw) => patchCoordinate(caption, axis, raw)}
        />
    )

    return (
        <section className="mt-3 border-t border-border/70 pt-3" data-testid="scene-character-captions-editor">
            <div className="flex flex-wrap items-center justify-between gap-2 px-2">
                <div>
                    <h3 className="text-sm font-semibold">{t('scene.characterCaptions', '캐릭터 캡션')}</h3>
                    <p className="text-xs text-muted-foreground">
                        {t('scene.characterCaptionsHelp', '메인 캐릭터를 드래그해 포함하고, 제외 영역으로 옮겨 프롬프트를 보존한 채 잠시 뺄 수 있습니다.')}
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <Label htmlFor={`scene-character-position-${scene.id}`} className="text-xs">
                        {t('scene.characterPosition', '위치 지정')}
                    </Label>
                    <Switch
                        id={`scene-character-position-${scene.id}`}
                        checked={positionEnabled}
                        onChange={event => commit(captions, event.target.checked)}
                        disabled={disabled}
                    />
                    <Button type="button" variant="secondary" size="sm" className="h-11" onClick={addCaption} disabled={disabled}>
                        <Plus className="h-4 w-4" />
                        {t('scene.addCharacterCaption', '직접 추가')}
                    </Button>
                </div>
            </div>

            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <div className="mt-3 grid gap-3 px-2 lg:grid-cols-[minmax(12rem,0.65fr)_minmax(0,2fr)]">
                    <section className="rounded-control bg-canvas/70 p-2" data-testid="scene-available-characters">
                        <div className="mb-2">
                            <h4 className="text-xs font-semibold">{t('scene.availableMainCharacters', '메인 캐릭터')}</h4>
                            <p className="text-[11px] text-muted-foreground">
                                {t('scene.availableMainCharactersHelp', '오른쪽 포함 영역으로 드래그하세요.')}
                            </p>
                        </div>
                        <div className="grid max-h-72 gap-2 overflow-y-auto pr-1">
                            {available.length === 0 ? (
                                <div className="grid min-h-16 place-items-center px-2 text-center text-[11px] text-muted-foreground">
                                    {availableCharacters.length === 0
                                        ? t('scene.noMainCharacters', '메인 모드에 등록된 캐릭터가 없습니다.')
                                        : t('scene.allMainCharactersAssigned', '모든 메인 캐릭터가 이 씬에 배치되었습니다.')}
                                </div>
                            ) : available.map(character => (
                                <AvailableCharacterCard
                                    key={character.id}
                                    character={character}
                                    disabled={disabled}
                                    onAdd={() => addAvailableCharacter(character)}
                                />
                            ))}
                        </div>
                    </section>

                    <div className="grid gap-3">
                        <CaptionDropZone
                            id={INCLUDED_ZONE_ID}
                            testId="scene-character-included-zone"
                            title={t('scene.includedCharacters', '이 씬에 포함')}
                            description={t('scene.includedCharactersHelp', '위에서 아래 순서대로 NovelAI에 전달됩니다.')}
                            emptyLabel={t('scene.dropCharactersHere', '메인 캐릭터를 여기에 놓으세요.')}
                            itemIds={included.map(caption => captionDragId(caption.id))}
                            disabled={disabled}
                        >
                            {included.map(renderCaption)}
                        </CaptionDropZone>

                        <CaptionDropZone
                            id={EXCLUDED_ZONE_ID}
                            testId="scene-character-excluded-zone"
                            title={t('scene.excludedCharacters', '제외')}
                            description={t('scene.excludedCharactersHelp', '프롬프트는 보존되며 생성 요청에는 포함되지 않습니다.')}
                            emptyLabel={t('scene.dropExcludedCharactersHere', '잠시 뺄 캐릭터를 여기에 놓으세요.')}
                            itemIds={excluded.map(caption => captionDragId(caption.id))}
                            disabled={disabled}
                        >
                            {excluded.map(renderCaption)}
                        </CaptionDropZone>
                    </div>
                </div>
            </DndContext>
        </section>
    )
}
