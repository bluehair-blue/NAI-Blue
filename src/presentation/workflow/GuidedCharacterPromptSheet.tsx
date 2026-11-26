import { useRef, useState, type DragEvent } from 'react'
import { Eye, EyeOff, ImagePlus, MapPin, Plus, RotateCcw, Trash2, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { AutocompleteTextarea } from '@/components/ui/AutocompleteTextarea'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
    SheetTrigger,
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import type {
    WorkflowCharacterPrompt,
    WorkflowCharacterPrompts,
} from '@/domain/workflow/single-image-draft'
import { cn } from '@/lib/utils'
import { readGuidedPromptImportFile } from './GuidedPromptFileImport'

interface GuidedCharacterPromptSheetProps {
    value: WorkflowCharacterPrompts
    disabled: boolean
    maxCharacters?: number
    onChange(value: WorkflowCharacterPrompts): void
}

function hasPrompt(value: string): boolean {
    return value.split(/\r?\n/).some(line => {
        const trimmed = line.trim()
        return trimmed.length > 0 && !trimmed.startsWith('#')
    })
}

export function GuidedCharacterPromptSheet({
    value,
    disabled,
    maxCharacters,
    onChange,
}: GuidedCharacterPromptSheetProps) {
    const { t } = useTranslation()
    const enabledCount = value.items.filter(character => character.enabled).length
    const characterLimitReached = maxCharacters !== undefined && value.items.length >= maxCharacters
    const importInputRef = useRef<HTMLInputElement>(null)
    const [importing, setImporting] = useState(false)
    const [dragging, setDragging] = useState(false)
    const [importMessage, setImportMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

    const addCharacter = () => {
        if (importing) return
        if (characterLimitReached) {
            setImportMessage({
                kind: 'error',
                text: t('guided.characters.limitReached', '현재 모델은 캐릭터를 최대 {{max}}명까지 사용할 수 있어요.', { max: maxCharacters }),
            })
            return
        }
        setImportMessage(null)
        onChange({
            ...value,
            positionEnabled: true,
            items: [...value.items, {
                id: `guided-character-${crypto.randomUUID()}`,
                prompt: '',
                negative: '',
                enabled: true,
                position: { x: 0.5, y: 0.5 },
            }],
        })
    }
    const updateCharacter = (id: string, patch: Partial<WorkflowCharacterPrompt>) => onChange({
        ...value,
        ...(patch.position === undefined ? {} : { positionEnabled: true }),
        items: value.items.map(character => (
            character.id === id ? { ...character, ...patch } : character
        )),
    })
    const removeCharacter = (id: string) => onChange({
        ...value,
        items: value.items.filter(character => character.id !== id),
    })

    const importCharacters = async (file: File | undefined) => {
        if (!file || importing || disabled) return
        setImporting(true)
        setImportMessage(null)
        try {
            const imported = await readGuidedPromptImportFile(file)
            if (!imported.characters?.length) throw new TypeError('No character prompts')
            // Only incoming slots are clipped. Previously saved over-limit data
            // remains available for editing and deletion instead of being lost.
            const availableSlots = maxCharacters === undefined
                ? imported.characters.length
                : Math.max(0, maxCharacters - value.items.length)
            const acceptedCharacters = imported.characters.slice(0, availableSlots)
            if (acceptedCharacters.length === 0) {
                setImportMessage({
                    kind: 'error',
                    text: t('guided.characters.limitReached', '현재 모델은 캐릭터를 최대 {{max}}명까지 사용할 수 있어요.', { max: maxCharacters }),
                })
                return
            }
            const additions = acceptedCharacters.map((character, index): WorkflowCharacterPrompt => ({
                id: `guided-character-${crypto.randomUUID()}`,
                name: t('guided.characters.importedName', '가져온 캐릭터 {{index}}', { index: index + 1 }),
                prompt: character.prompt,
                negative: character.negative,
                enabled: character.prompt.trim().length > 0,
                position: { ...character.position },
            }))
            onChange({ positionEnabled: true, items: [...value.items, ...additions] })
            setImportMessage({
                kind: 'success',
                text: additions.length < imported.characters.length
                    ? t('guided.characters.importedLimited', '남은 슬롯에 맞춰 {{count}}개만 추가했어요. 현재 모델의 최대값은 {{max}}명이에요.', {
                        count: additions.length,
                        max: maxCharacters,
                    })
                    : t('guided.characters.imported', '캐릭터 프롬프트 {{count}}개를 추가했어요.', { count: additions.length }),
            })
        } catch {
            setImportMessage({
                kind: 'error',
                text: t('guided.characters.importError', '이 파일에서 캐릭터 프롬프트를 찾지 못했어요.'),
            })
        } finally {
            setImporting(false)
        }
    }

    return (
        <Sheet>
            <div className="flex min-w-0 items-center justify-between gap-3 border-y border-border/70 py-3">
                <span className="min-w-0">
                    <span className="flex items-center gap-2 text-sm font-semibold">
                        <Users className="h-4 w-4 text-primary" aria-hidden="true" />
                        {t('guided.characters.title', '캐릭터 프롬프트')}
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                        {enabledCount > 0
                            ? t('guided.characters.activeCount', '활성 캐릭터 {{count}}명', { count: enabledCount })
                            : t('guided.characters.emptyHelp', '인물이 여러 명일 때 외형을 따로 지정할 수 있어요.')}
                        {maxCharacters !== undefined && (
                            <span className={cn(characterLimitReached && 'text-destructive')}>
                                {' · '}{t('guided.characters.limitCount', '{{count}}/{{max}}명 사용 중', {
                                    count: value.items.length,
                                    max: maxCharacters,
                                })}
                            </span>
                        )}
                    </span>
                </span>
                <SheetTrigger asChild>
                    <Button type="button" variant="ghost" size="sm" disabled={disabled} className="shrink-0">
                        {value.items.length > 0
                            ? t('guided.characters.edit', '편집')
                            : t('guided.characters.add', '추가')}
                    </Button>
                </SheetTrigger>
            </div>

            <SheetContent
                side="right"
                className="flex w-full flex-col overflow-hidden sm:max-w-xl"
                closeLabel={t('common.close', '닫기')}
                data-testid="guided-character-prompt-sheet"
            >
                <SheetHeader className="shrink-0 border-b border-border/70 pb-4">
                    <SheetTitle className="text-xl">{t('guided.characters.title', '캐릭터 프롬프트')}</SheetTitle>
                    <SheetDescription className="leading-6">
                        {t('guided.characters.description', '현재 작업에만 적용할 캐릭터의 외형과 제외 요소를 정하세요.')}
                    </SheetDescription>
                    {characterLimitReached && (
                        <p className="text-xs leading-5 text-destructive" role="status">
                            {t('guided.characters.limitReached', '현재 모델은 캐릭터를 최대 {{max}}명까지 사용할 수 있어요.', { max: maxCharacters })}
                        </p>
                    )}
                </SheetHeader>

                <div className="shrink-0 border-b border-border/70 py-3">
                    <input
                        ref={importInputRef}
                        type="file"
                        className="sr-only"
                        tabIndex={-1}
                        accept="image/png,image/webp,image/jpeg,.json,application/json"
                        disabled={disabled || importing || characterLimitReached}
                        onChange={event => {
                            void importCharacters(event.target.files?.[0])
                            event.target.value = ''
                        }}
                    />
                    <button
                        data-local-file-drop
                        type="button"
                        disabled={disabled || importing || characterLimitReached}
                        onClick={() => importInputRef.current?.click()}
                        onDragEnter={event => { event.preventDefault(); if (!disabled && !characterLimitReached) setDragging(true) }}
                        onDragOver={event => event.preventDefault()}
                        onDragLeave={event => {
                            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
                        }}
                        onDrop={(event: DragEvent<HTMLButtonElement>) => {
                            event.preventDefault()
                            setDragging(false)
                            void importCharacters(event.dataTransfer.files[0])
                        }}
                        className={cn(
                            'flex min-h-16 w-full items-center gap-3 border border-dashed px-3 py-2 text-left transition-colors focus-ring',
                            dragging ? 'border-primary bg-primary/[0.055]' : 'border-border/80 hover:border-primary/60',
                            (disabled || importing || characterLimitReached) && 'cursor-not-allowed opacity-55',
                        )}
                    >
                        <ImagePlus className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
                        <span className="min-w-0">
                            <span className="block text-sm font-semibold">
                                {importing
                                    ? t('guided.characters.importing', '캐릭터 메타데이터를 읽는 중…')
                                    : t('guided.characters.import', '이미지·JSON에서 캐릭터만 추가')}
                            </span>
                            <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                                {t('guided.characters.importHelp', '파일을 놓아도 메인 프롬프트는 바꾸지 않아요.')}
                            </span>
                        </span>
                    </button>
                    {importMessage && (
                        <p
                            className={cn('mt-2 text-xs', importMessage.kind === 'error' ? 'text-destructive' : 'text-success')}
                            role={importMessage.kind === 'error' ? 'alert' : 'status'}
                        >
                            {importMessage.text}
                        </p>
                    )}
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                    {value.items.length === 0 ? (
                        <div className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
                            <Users className="h-8 w-8 text-muted-foreground/45" aria-hidden="true" />
                            <p className="mt-3 text-sm leading-6 text-muted-foreground">
                                {t('guided.characters.empty', '아직 캐릭터 프롬프트가 없어요.')}
                            </p>
                            <Button type="button" variant="outline" className="mt-4" onClick={addCharacter} disabled={disabled || importing || characterLimitReached}>
                                <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
                                {t('guided.characters.addFirst', '첫 캐릭터 추가')}
                            </Button>
                        </div>
                    ) : (
                        <div className="divide-y divide-border/70 border-b border-border/70">
                            {value.items.map((character, index) => {
                                const invalid = character.enabled && !hasPrompt(character.prompt)
                                return (
                                    <section key={character.id} className="py-5" aria-label={character.name || t('guided.characters.unnamed', '캐릭터 {{index}}', { index: index + 1 })}>
                                        <div className="flex items-center gap-2">
                                            <label className="min-w-0 flex-1 text-xs font-medium text-muted-foreground">
                                                <span className="sr-only">{t('guided.characters.name', '캐릭터 이름')}</span>
                                                <Input
                                                    value={character.name ?? ''}
                                                    onChange={event => updateCharacter(character.id, {
                                                        name: event.target.value || undefined,
                                                    })}
                                                    disabled={disabled}
                                                    placeholder={t('guided.characters.namePlaceholder', '캐릭터 이름 · 선택')}
                                                    className="h-11 text-base"
                                                />
                                            </label>
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                disabled={disabled}
                                                onClick={() => updateCharacter(character.id, { enabled: !character.enabled })}
                                                aria-label={character.enabled
                                                    ? t('guided.characters.disable', '캐릭터 비활성화')
                                                    : t('guided.characters.enable', '캐릭터 활성화')}
                                            >
                                                {character.enabled
                                                    ? <Eye className="h-4 w-4 text-primary" aria-hidden="true" />
                                                    : <EyeOff className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
                                            </Button>
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                disabled={disabled}
                                                onClick={() => removeCharacter(character.id)}
                                                aria-label={t('guided.characters.remove', '캐릭터 삭제')}
                                                className="text-muted-foreground hover:text-destructive"
                                            >
                                                <Trash2 className="h-4 w-4" aria-hidden="true" />
                                            </Button>
                                        </div>

                                        <label className="mt-4 block text-sm font-semibold">
                                            {t('guided.characters.positive', '외형 프롬프트')}
                                            <span className="mt-2 block h-40">
                                                <AutocompleteTextarea
                                                    value={character.prompt}
                                                    onChange={event => updateCharacter(character.id, { prompt: event.target.value })}
                                                    disabled={disabled}
                                                    placeholder={t('guided.characters.positivePlaceholder', '예: 1girl, silver hair, blue eyes')}
                                                    ariaLabel={t('guided.characters.positive', '외형 프롬프트')}
                                                    maxSuggestions={8}
                                                    className="bg-card text-base"
                                                />
                                            </span>
                                        </label>
                                        {invalid && (
                                            <p className="mt-2 text-xs leading-5 text-destructive" role="alert">
                                                {t('guided.characters.promptRequired', '활성 캐릭터에는 외형 프롬프트가 필요해요.')}
                                            </p>
                                        )}

                                        <details className="mt-4 border-t border-border/55 pt-3">
                                            <summary className="min-h-11 cursor-pointer py-2.5 text-sm font-medium">
                                                {t('guided.characters.negative', '제외할 요소 · 선택')}
                                            </summary>
                                            <Textarea
                                                value={character.negative}
                                                onChange={event => updateCharacter(character.id, { negative: event.target.value })}
                                                disabled={disabled}
                                                className="mt-3 min-h-28 bg-card text-base"
                                                placeholder={t('guided.characters.negativePlaceholder', '예: alternate costume, different hairstyle')}
                                            />
                                        </details>

                                        <details className="mt-4 border-t border-border/55 pt-3">
                                            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 text-sm font-medium">
                                                <span className="flex items-center gap-2">
                                                    <MapPin className="h-4 w-4 text-primary" aria-hidden="true" />
                                                    {t('guided.characters.position', '화면 위치')}
                                                </span>
                                                <span className="font-mono text-xs text-muted-foreground">
                                                    X {character.position.x.toFixed(1)} · Y {character.position.y.toFixed(1)}
                                                </span>
                                            </summary>
                                            <div className="mt-3 space-y-3">
                                                {(['x', 'y'] as const).map(axis => (
                                                    <label key={axis} className="grid grid-cols-[1rem_minmax(0,1fr)_3rem] items-center gap-2 text-xs">
                                                        <span className="font-mono uppercase">{axis}</span>
                                                        <input
                                                            type="range"
                                                            min={0.1}
                                                            max={0.9}
                                                            step={0.1}
                                                            value={Math.max(0.1, Math.min(0.9, character.position[axis]))}
                                                            disabled={disabled}
                                                            onChange={event => updateCharacter(character.id, {
                                                                position: {
                                                                    ...character.position,
                                                                    [axis]: Number(event.target.value),
                                                                },
                                                            })}
                                                            className="w-full accent-primary"
                                                            aria-label={t('guided.characters.positionAxis', '{{axis}} 위치', { axis: axis.toUpperCase() })}
                                                        />
                                                        <span className="text-right font-mono">{character.position[axis].toFixed(1)}</span>
                                                    </label>
                                                ))}
                                                <div className="flex items-start justify-between gap-3">
                                                    <p className="text-xs leading-5 text-muted-foreground">
                                                        {t('guided.characters.positionHelp', '0.5는 중앙이에요. 여러 인물이라면 겹치지 않도록 좌우 위치를 직접 확인해 주세요.')}
                                                    </p>
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="sm"
                                                        className="shrink-0"
                                                        disabled={disabled || (character.position.x === 0.5 && character.position.y === 0.5)}
                                                        onClick={() => updateCharacter(character.id, { position: { x: 0.5, y: 0.5 } })}
                                                    >
                                                        <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                                                        {t('guided.characters.positionReset', '중앙')}
                                                    </Button>
                                                </div>
                                            </div>
                                        </details>
                                    </section>
                                )
                            })}
                        </div>
                    )}
                </div>

                {value.items.length > 0 && (
                    <div className="shrink-0 border-t border-border/70 pt-4">
                        <Button type="button" variant="outline" className="w-full" onClick={addCharacter} disabled={disabled || importing || characterLimitReached}>
                            <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
                            {t('guided.characters.addAnother', '캐릭터 추가')}
                        </Button>
                    </div>
                )}
            </SheetContent>
        </Sheet>
    )
}
