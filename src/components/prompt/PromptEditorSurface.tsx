import { useId, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDownWideNarrow, ChevronDown, PackageOpen, Puzzle, Sparkles, Undo2 } from 'lucide-react'

import { AutocompleteTextarea } from '@/components/ui/AutocompleteTextarea'
import { Button } from '@/components/ui/button'
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover'
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import { PromptSlotTabs } from '@/components/prompt/PromptSlotTabs'
import { PromptFrequencySortDialog } from '@/components/prompt/PromptFrequencySortDialog'
import {
    appendPromptModuleLine,
    PromptModulePicker,
} from '@/components/fragments/PromptModulePicker'
import { useGenerationDraftStore } from '@/stores/generation-draft-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useCharacterPromptStore } from '@/stores/character-prompt-store'
import { StructuredPromptModuleLibrary } from '@/components/prompt-modules/StructuredPromptModuleLibrary'
import { appendStructuredPromptText } from '@/presentation/workflow/structured-prompt-insertion'

type PromptSlot = 'base' | 'additional' | 'detail' | 'negative'

interface PromptContextSnapshot {
    slot: PromptSlot
    fullValue: string
    selectionStart: number
    selectionEnd: number
}

interface PromptSortRequest {
    slot: PromptSlot
    source: string
    fullValue: string
    range: readonly [start: number, end: number] | null
}

interface PromptSortUndo {
    before: string
    after: string
}

/**
 * Store-backed prompt editor shared by future Dock and Sheet containers. It
 * depends only on GenerationDraft and the font preference, deliberately
 * excluding queue, route, cancellation, and provider command ownership.
 */
export function PromptEditorSurface({
    onOpenAiAssistant,
    onOpenFragment,
    toolsDisabled = false,
}: {
    onOpenAiAssistant?: () => void
    onOpenFragment?: () => void
    toolsDisabled?: boolean
} = {}) {
    const { t } = useTranslation()
    const [activePromptSlot, setActivePromptSlot] = useState<PromptSlot>('base')
    const surfaceRef = useRef<HTMLDivElement>(null)
    const restoreFocusOnSlotChangeRef = useRef(false)
    useLayoutEffect(() => {
        if (!restoreFocusOnSlotChangeRef.current) return
        restoreFocusOnSlotChangeRef.current = false
        surfaceRef.current?.querySelector('textarea')?.focus()
    }, [activePromptSlot])
    const [contextSnapshot, setContextSnapshot] = useState<PromptContextSnapshot | null>(null)
    const [sortRequest, setSortRequest] = useState<PromptSortRequest | null>(null)
    const [sortUndoBySlot, setSortUndoBySlot] = useState<Partial<Record<PromptSlot, PromptSortUndo>>>({})
    const editorPanelId = `prompt-command-editor-${useId().replace(/:/g, '')}`
    const promptFontSize = useSettingsStore(state => state.promptFontSize)
    const basePrompt = useGenerationDraftStore(state => state.basePrompt)
    const additionalPrompt = useGenerationDraftStore(state => state.additionalPrompt)
    const detailPrompt = useGenerationDraftStore(state => state.detailPrompt)
    const negativePrompt = useGenerationDraftStore(state => state.negativePrompt)
    const setBasePrompt = useGenerationDraftStore(state => state.setBasePrompt)
    const setAdditionalPrompt = useGenerationDraftStore(state => state.setAdditionalPrompt)
    const setDetailPrompt = useGenerationDraftStore(state => state.setDetailPrompt)
    const setNegativePrompt = useGenerationDraftStore(state => state.setNegativePrompt)
    const characters = useCharacterPromptStore(state => state.characters)
    const addCharacter = useCharacterPromptStore(state => state.addCharacter)
    const setPositionEnabled = useCharacterPromptStore(state => state.setPositionEnabled)

    const promptSlots = [
        {
            id: 'base' as const,
            label: t('prompt.base'),
            placeholder: t('prompt.basePlaceholder'),
            value: basePrompt,
            setValue: setBasePrompt,
        },
        {
            id: 'additional' as const,
            label: t('prompt.additional'),
            placeholder: t('prompt.additionalPlaceholder'),
            value: additionalPrompt,
            setValue: setAdditionalPrompt,
        },
        {
            id: 'detail' as const,
            label: t('prompt.detail'),
            placeholder: t('prompt.detailPlaceholder'),
            value: detailPrompt,
            setValue: setDetailPrompt,
        },
        {
            id: 'negative' as const,
            label: t('prompt.negative'),
            placeholder: t('prompt.negativePlaceholder'),
            value: negativePrompt,
            setValue: setNegativePrompt,
        },
    ]
    const activePrompt = promptSlots.find(slot => slot.id === activePromptSlot) ?? promptSlots[0]
    const activeSortUndo = sortUndoBySlot[activePrompt.id]
    const canUndoSort = activeSortUndo?.after === activePrompt.value
    const canSortSelection = contextSnapshot?.slot === activePrompt.id
        && contextSnapshot.selectionEnd > contextSnapshot.selectionStart
        && contextSnapshot.fullValue
            .slice(contextSnapshot.selectionStart, contextSnapshot.selectionEnd)
            .trim().length > 0

    const openFullSort = (fullValue: string) => {
        setSortRequest({
            slot: activePrompt.id,
            source: fullValue,
            fullValue,
            range: null,
        })
    }

    const openSelectionSort = () => {
        if (!contextSnapshot || !canSortSelection) return
        // The full snapshot plus UTF-16 selection offsets form one edit
        // transaction, so the async lookup can never rewrite outside the drag.
        setSortRequest({
            slot: contextSnapshot.slot,
            source: contextSnapshot.fullValue.slice(
                contextSnapshot.selectionStart,
                contextSnapshot.selectionEnd,
            ),
            fullValue: contextSnapshot.fullValue,
            range: [contextSnapshot.selectionStart, contextSnapshot.selectionEnd],
        })
    }

    const applySortedPrompt = (sorted: string) => {
        if (!sortRequest) return
        const nextValue = sortRequest.range
            ? `${sortRequest.fullValue.slice(0, sortRequest.range[0])}${sorted}${sortRequest.fullValue.slice(sortRequest.range[1])}`
            : sorted
        promptSlots.find(slot => slot.id === sortRequest.slot)?.setValue(nextValue)
        setSortUndoBySlot(current => ({
            ...current,
            [sortRequest.slot]: { before: sortRequest.fullValue, after: nextValue },
        }))
    }

    const undoLastSort = () => {
        if (!activeSortUndo || !canUndoSort) return
        activePrompt.setValue(activeSortUndo.before)
        setSortUndoBySlot(current => ({ ...current, [activePrompt.id]: undefined }))
    }

    return (
        <div
            ref={surfaceRef}
            className="@container flex flex-none flex-col border-y border-border/60 bg-transparent"
            // A dock-level test boundary keeps responsive smoke checks coupled to
            // this shared editor surface, not react-simple-code-editor internals.
            data-testid="prompt-editor-surface"
            onKeyDown={event => {
                if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
                const match = /^Digit([1-4])$/.exec(event.code)
                if (!match) return
                const slot = promptSlots[Number(match[1]) - 1]
                if (!slot) return
                event.preventDefault()
                event.stopPropagation()
                if (slot.id === activePrompt.id) return
                restoreFocusOnSlotChangeRef.current = true
                setActivePromptSlot(slot.id)
            }}
        >
            <PromptSlotTabs
                tabs={promptSlots.map((slot, index) => ({
                    id: slot.id,
                    label: slot.label,
                    filled: slot.value.trim().length > 0,
                    negative: slot.id === 'negative',
                    shortcut: `Alt+${index + 1}`,
                }))}
                activeId={activePrompt.id}
                panelId={editorPanelId}
                label={t('prompt.title', '프롬프트')}
                onChange={id => setActivePromptSlot(id as PromptSlot)}
            />
            <div
                id={editorPanelId}
                role="tabpanel"
                aria-labelledby={`${editorPanelId}-${activePrompt.id}-tab`}
                className="flex min-h-0 flex-col"
            >
                <div className="grid min-h-11 grid-cols-2 border-b border-border/45 px-2 py-1">
                    <Popover>
                        <PopoverTrigger asChild>
                            <Button type="button" variant="ghost" size="sm" className="min-w-0 justify-center whitespace-nowrap px-2 text-xs">
                                <PackageOpen className="mr-1 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                <span className="truncate">{t('prompt.import', '가져오기')}</span>
                                <ChevronDown className="ml-1 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            </Button>
                        </PopoverTrigger>
                        <PopoverContent align="start" className="w-64 space-y-1 p-2">
                            <StructuredPromptModuleLibrary
                                currentParts={{
                                    base: basePrompt,
                                    detail: detailPrompt,
                                    additional: additionalPrompt,
                                    negative: negativePrompt,
                                    character: characters.find(character => character.enabled)?.prompt,
                                    'character-negative': characters.find(character => character.enabled)?.negative,
                                }}
                                triggerLabel={t('promptModuleLibrary.triggerShort', '프롬프트 묶음')}
                                triggerClassName="w-full justify-start rounded-control border-0 px-2"
                                onInsert={(parts, module) => {
                                    let character = ''
                                    let characterNegative = ''
                                    for (const part of parts) {
                                        if (part.kind === 'base') setBasePrompt(appendStructuredPromptText(basePrompt, part.content))
                                        else if (part.kind === 'detail') setDetailPrompt(appendStructuredPromptText(detailPrompt, part.content))
                                        else if (part.kind === 'additional') setAdditionalPrompt(appendStructuredPromptText(additionalPrompt, part.content))
                                        else if (part.kind === 'negative') setNegativePrompt(appendStructuredPromptText(negativePrompt, part.content))
                                        else if (part.kind === 'character') character = appendStructuredPromptText(character, part.content)
                                        else characterNegative = appendStructuredPromptText(characterNegative, part.content)
                                    }
                                    if (parts.some(part => part.kind === 'character' || part.kind === 'character-negative')) {
                                        addCharacter({
                                            name: module.name,
                                            prompt: character,
                                            negative: characterNegative,
                                            enabled: true,
                                            position: { x: 0.5, y: 0.5 },
                                        })
                                        setPositionEnabled(true)
                                    }
                                }}
                            />
                            <PromptModulePicker
                                triggerLabel={t('guided.promptModules.legacyTriggerShort', '한 줄 묶음')}
                                triggerClassName="w-full justify-start rounded-control border-0 px-2"
                                onSelectLine={line => activePrompt.setValue(
                                    appendPromptModuleLine(activePrompt.value, line),
                                )}
                            />
                        </PopoverContent>
                    </Popover>

                    <Popover>
                        <PopoverTrigger asChild>
                            <Button type="button" variant="ghost" size="sm" className="min-w-0 justify-center whitespace-nowrap px-2 text-xs">
                                <Sparkles className="mr-1 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                <span className="truncate">{t('prompt.tools', '프롬프트 도구')}</span>
                                <ChevronDown className="ml-1 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            </Button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="w-64 space-y-1 p-2">
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="w-full justify-start px-2 text-xs"
                                disabled={!activePrompt.value.trim()}
                                onClick={() => openFullSort(activePrompt.value)}
                                data-testid="prompt-frequency-sort-all"
                            >
                                <ArrowDownWideNarrow className="mr-2 h-3.5 w-3.5" />
                                {t('promptFrequencySort.sortAll', '전체 빈도 정렬')}
                            </Button>
                            {onOpenAiAssistant && (
                                <Button type="button" variant="ghost" size="sm" className="w-full justify-start px-2 text-xs" disabled={toolsDisabled} onClick={onOpenAiAssistant}>
                                    <Sparkles className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                                    {t('promptGenerator.title', 'AI 도움받아 쓰기')}
                                </Button>
                            )}
                            {onOpenFragment && (
                                <Button type="button" variant="ghost" size="sm" className="w-full justify-start px-2 text-xs" disabled={toolsDisabled} onClick={onOpenFragment}>
                                    <Puzzle className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                                    {t('prompt.fragment', '조각')}
                                </Button>
                            )}
                        </PopoverContent>
                    </Popover>
                </div>
                <ContextMenu>
                    <ContextMenuTrigger asChild>
                        <div>
                            <AutocompleteTextarea
                                key={activePrompt.id}
                                placeholder={activePrompt.placeholder}
                                value={activePrompt.value}
                                onChange={event => activePrompt.setValue(event.target.value)}
                                onPromptContextMenu={context => {
                                    setContextSnapshot({
                                        slot: activePrompt.id,
                                        fullValue: context.value,
                                        selectionStart: context.selectionStart,
                                        selectionEnd: context.selectionEnd,
                                    })
                                }}
                                ariaLabel={activePrompt.label}
                                className={cn(
                                    'h-40 min-h-40 resize-none rounded-none border-0 bg-transparent focus-within:ring-1 focus-within:ring-inset',
                                    activePrompt.id === 'negative' && 'focus-within:ring-destructive/50',
                                )}
                                style={{ fontSize: `${promptFontSize}px` }}
                            />
                        </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent className="w-60">
                        <ContextMenuLabel>
                            {t('promptFrequencySort.contextTitle', '프롬프트 정렬')}
                        </ContextMenuLabel>
                        <ContextMenuItem disabled={!canSortSelection} onSelect={openSelectionSort}>
                            <ArrowDownWideNarrow className="mr-2 h-4 w-4" />
                            {t('promptFrequencySort.sortSelection', '선택 영역 빈도 정렬')}
                        </ContextMenuItem>
                        <ContextMenuItem
                            disabled={!contextSnapshot?.fullValue.trim()}
                            onSelect={() => contextSnapshot && openFullSort(contextSnapshot.fullValue)}
                        >
                            <ArrowDownWideNarrow className="mr-2 h-4 w-4" />
                            {t('promptFrequencySort.sortAll', '전체 빈도 정렬')}
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem disabled={!canUndoSort} onSelect={undoLastSort}>
                            <Undo2 className="mr-2 h-4 w-4" />
                            {t('promptFrequencySort.undo', '정렬 되돌리기')}
                        </ContextMenuItem>
                    </ContextMenuContent>
                </ContextMenu>
                {canUndoSort && (
                    <div className="flex min-h-10 items-center justify-between gap-2 border-t border-border/45 px-3 py-1 text-xs text-muted-foreground" role="status">
                        <span className="min-w-0 truncate">{t('promptFrequencySort.applied', '빈도순으로 정렬했어요.')}</span>
                        <Button type="button" variant="ghost" size="sm" className="shrink-0 whitespace-nowrap" onClick={undoLastSort} data-testid="prompt-frequency-sort-undo">
                            <Undo2 className="mr-1 h-3.5 w-3.5" />
                            {t('promptFrequencySort.undo', '되돌리기')}
                        </Button>
                    </div>
                )}
            </div>

            <PromptFrequencySortDialog
                open={sortRequest !== null}
                source={sortRequest?.source ?? ''}
                onOpenChange={open => {
                    if (!open) setSortRequest(null)
                }}
                onApply={applySortedPrompt}
            />
        </div>
    )
}
