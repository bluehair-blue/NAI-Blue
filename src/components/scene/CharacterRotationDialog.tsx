import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Coffee, Drama, Pin, Play, RotateCcw, Square as StopIcon, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils'
import { useCharacterPromptStore, type CharacterPrompt } from '@/stores/character-prompt-store'
import { useGenerationStore } from '@/stores/generation-store'
import { useSceneStore } from '@/stores/scene-store'
import { useRotationStore } from '@/stores/character-rotation-store'

interface CharacterRotationDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
}

function characterLabel(character: CharacterPrompt): string {
    return character.name?.trim()
        || (character.prompt ? `${character.prompt.slice(0, 42)}${character.prompt.length > 42 ? '...' : ''}` : '')
        || '(빈 캐릭터)'
}

export function CharacterRotationDialog({ open, onOpenChange }: CharacterRotationDialogProps) {
    const characters = useCharacterPromptStore(state => state.characters)
    const active = useRotationStore(state => state.active)
    const paused = useRotationStore(state => state.paused)
    const resting = useRotationStore(state => state.resting)
    const persistedIds = useRotationStore(state => state.characterIds)
    const persistedPinnedIds = useRotationStore(state => state.pinnedCharacterIds)
    const persistedRepeats = useRotationStore(state => state.repeats)
    const persistedRestEnabled = useRotationStore(state => state.restEnabled)
    const persistedWorkMinutes = useRotationStore(state => state.workMinutes)
    const persistedWorkJitterMinutes = useRotationStore(state => state.workJitterMinutes)
    const persistedRestMinutes = useRotationStore(state => state.restMinutes)
    const persistedRestJitterMinutes = useRotationStore(state => state.restJitterMinutes)
    const currentIndex = useRotationStore(state => state.currentIndex)
    const currentRepeat = useRotationStore(state => state.currentRepeat)
    const snapshot = useRotationStore(state => state.snapshot)
    const setCharacterIds = useRotationStore(state => state.setCharacterIds)
    const setPinnedCharacterIds = useRotationStore(state => state.setPinnedCharacterIds)
    const setRepeats = useRotationStore(state => state.setRepeats)
    const setRestConfig = useRotationStore(state => state.setRestConfig)
    const start = useRotationStore(state => state.start)
    const stop = useRotationStore(state => state.stop)
    const cancel = useRotationStore(state => state.cancel)
    const resume = useRotationStore(state => state.resume)
    const endRest = useRotationStore(state => state.endRest)
    const resumeSavedSession = useRotationStore(state => state.resumeSavedSession)
    const discardSavedSession = useRotationStore(state => state.discardSavedSession)
    const sceneGenerating = useSceneStore(state => state.isGenerating)
    const mainGenerating = useGenerationStore(state => state.generatingMode === 'main')

    const [selected, setSelected] = useState<Set<string>>(new Set())
    const [pinned, setPinned] = useState<Set<string>>(new Set())
    const [repeatCount, setRepeatCount] = useState(1)
    const [restOn, setRestOn] = useState(false)
    const [workMinutes, setWorkMinutes] = useState(480)
    const [workJitterMinutes, setWorkJitterMinutes] = useState(30)
    const [restMinutes, setRestMinutes] = useState(300)
    const [restJitterMinutes, setRestJitterMinutes] = useState(30)

    useEffect(() => {
        if (!open) return
        const liveIds = new Set(characters.map(character => character.id))
        setSelected(new Set(persistedIds.filter(id => liveIds.has(id))))
        setPinned(new Set(persistedPinnedIds.filter(id => liveIds.has(id))))
        setRepeatCount(persistedRepeats)
        setRestOn(persistedRestEnabled)
        setWorkMinutes(persistedWorkMinutes)
        setWorkJitterMinutes(persistedWorkJitterMinutes)
        setRestMinutes(persistedRestMinutes)
        setRestJitterMinutes(persistedRestJitterMinutes)
    }, [
        open,
        characters,
        persistedIds,
        persistedPinnedIds,
        persistedRepeats,
        persistedRestEnabled,
        persistedWorkMinutes,
        persistedWorkJitterMinutes,
        persistedRestMinutes,
        persistedRestJitterMinutes,
    ])

    const selectedInOrder = useMemo(
        () => characters.map(character => character.id).filter(id => selected.has(id) && !pinned.has(id)),
        [characters, pinned, selected]
    )
    const pinnedInOrder = useMemo(
        () => characters.map(character => character.id).filter(id => pinned.has(id)),
        [characters, pinned]
    )
    const canResumeSaved = !active && snapshot !== null

    const toggleSelected = (id: string) => {
        setPinned(current => {
            if (!current.has(id)) return current
            const next = new Set(current)
            next.delete(id)
            return next
        })
        setSelected(current => {
            const next = new Set(current)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    const togglePinned = (id: string) => {
        setSelected(current => {
            if (!current.has(id)) return current
            const next = new Set(current)
            next.delete(id)
            return next
        })
        setPinned(current => {
            const next = new Set(current)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    const commitConfig = () => {
        setCharacterIds(selectedInOrder)
        setPinnedCharacterIds(pinnedInOrder)
        setRepeats(repeatCount)
        setRestConfig({
            restEnabled: restOn,
            workMinutes,
            workJitterMinutes,
            restMinutes,
            restJitterMinutes,
        })
    }

    const handleStart = () => {
        if (selectedInOrder.length === 0) {
            toast({ title: '로테이션할 캐릭터를 선택하세요.', variant: 'destructive' })
            return
        }
        commitConfig()
        const error = start()
        if (error) {
            toast({ title: '로테이션 시작 실패', description: error, variant: 'destructive' })
            return
        }
        toast({
            title: '로테이션 시작',
            description: `${selectedInOrder.length}명 x ${repeatCount}회`,
            variant: 'success',
        })
        onOpenChange(false)
    }

    const handleResumeSaved = () => {
        setRestConfig({
            restEnabled: restOn,
            workMinutes,
            workJitterMinutes,
            restMinutes,
            restJitterMinutes,
        })
        const error = resumeSavedSession()
        if (error) {
            toast({ title: '로테이션 재개 실패', description: error, variant: 'destructive' })
            return
        }
        toast({ title: '로테이션 재개', variant: 'success' })
        onOpenChange(false)
    }

    const handleStopKeepingSnapshot = () => {
        stop({ reason: 'user clicked stop', keepSnapshot: true })
        toast({
            title: '로테이션 중단',
            description: '현재 위치를 저장했습니다. 나중에 이어서 생성할 수 있습니다.',
        })
    }

    const handleCancelRotation = () => {
        cancel('user clicked cancel')
        toast({
            title: '로테이션 완전 취소',
            description: '저장된 세션과 진행 상태를 삭제했습니다.',
            variant: 'destructive',
        })
        onOpenChange(false)
    }

    const handleDiscardSavedSession = () => {
        discardSavedSession()
        toast({
            title: '저장된 세션 완전 취소',
            description: '이어가기 상태를 삭제했습니다.',
            variant: 'destructive',
        })
    }

    const currentCharacter = active ? characters.find(character => character.id === persistedIds[currentIndex]) : null

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-xl max-h-[85vh] overflow-hidden flex flex-col">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Drama className="h-5 w-5" />
                        캐릭터 로테이션
                    </DialogTitle>
                    <DialogDescription>
                        현재 씬 큐를 캐릭터별로 반복 실행합니다. 고정 캐릭터는 모든 패스에 함께 포함됩니다.
                    </DialogDescription>
                </DialogHeader>

                {active && (
                    <div className={cn(
                        'rounded-xl border p-3 text-sm',
                        resting ? 'border-info/40 bg-info/5' : paused ? 'border-warning/40 bg-warning/5' : 'border-primary/40 bg-primary/5'
                    )}>
                        <div className="font-medium">
                            {resting ? '휴식 중' : paused ? '일시정지됨' : '진행 중'} - {currentRepeat + 1}/{persistedRepeats}회차
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">
                            현재 캐릭터: {currentCharacter ? characterLabel(currentCharacter) : `#${currentIndex + 1}`}
                        </div>
                    </div>
                )}

                {canResumeSaved && (
                    <div className="rounded-panel border border-warning/40 bg-warning/5 p-3 text-sm">
                        <div className="font-medium">저장된 로테이션 세션이 있습니다.</div>
                        <div className="text-xs text-muted-foreground mt-1">
                            {currentIndex + 1}/{persistedIds.length}번째 캐릭터, {currentRepeat + 1}/{persistedRepeats}회차부터 이어갈 수 있습니다.
                        </div>
                    </div>
                )}

                {characters.length === 0 ? (
                    <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                        캐릭터 프롬프트 패널에서 캐릭터를 먼저 추가하세요.
                    </div>
                ) : (
                    <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-2">
                        {characters.map(character => {
                            const isSelected = selected.has(character.id)
                            const isPinned = pinned.has(character.id)
                            return (
                                <div
                                    key={character.id}
                                    className={cn(
                                        'flex min-h-16 items-center gap-4 border-b border-border/60 px-3 py-3',
                                        isSelected && 'border-primary/50 bg-primary/5',
                                        isPinned && 'border-warning/50 bg-warning/5'
                                    )}
                                >
                                    <Checkbox
                                        id={`rotation-character-${character.id}`}
                                        aria-label={characterLabel(character)}
                                        checked={isSelected}
                                        disabled={active || isPinned}
                                        onCheckedChange={() => toggleSelected(character.id)}
                                    />
                                    <label htmlFor={`rotation-character-${character.id}`} className="flex min-h-11 min-w-0 flex-1 cursor-pointer flex-col justify-center">
                                        <span className="text-sm font-medium break-words">{characterLabel(character)}</span>
                                        {character.name && character.prompt && (
                                            <span className="truncate text-xs text-muted-foreground">
                                                {character.prompt.slice(0, 80)}
                                            </span>
                                        )}
                                    </label>
                                    <Button
                                        type="button"
                                        variant={isPinned ? 'secondary' : 'outline'}
                                        size="sm"
                                        disabled={active}
                                        onClick={() => togglePinned(character.id)}
                                    >
                                        <Pin className="mr-1 h-3.5 w-3.5" />
                                        {isPinned ? '고정' : '고정'}
                                    </Button>
                                </div>
                            )
                        })}
                    </div>
                )}

                <div className="grid gap-3 border-t border-border/60 pt-3 sm:grid-cols-[160px_1fr]">
                    <div>
                        <Label htmlFor="rotation-repeats" className="text-xs">반복 횟수</Label>
                        <Input
                            id="rotation-repeats"
                            type="number"
                            min={1}
                            max={100}
                            value={repeatCount}
                            disabled={active}
                            onChange={(event) => setRepeatCount(Math.max(1, Math.min(100, Number(event.target.value) || 1)))}
                        />
                    </div>
                    <div className="flex items-start gap-2 rounded-xl bg-muted/30 p-3 text-xs text-muted-foreground">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                        <span>
                            시작 시 현재 큐를 저장하고 캐릭터마다 복원합니다. 출력은 프리셋/Character_Scenes/캐릭터/씬 폴더에 저장됩니다.
                        </span>
                    </div>
                </div>

                <div className="rounded-xl border border-border/60 bg-muted/20 p-3 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                        <Label className="flex items-center gap-1.5 text-sm font-medium">
                            <Coffee className="h-4 w-4 text-info" />
                            휴식 스케줄러
                        </Label>
                        <Switch checked={restOn} disabled={active} onChange={(event) => setRestOn(event.target.checked)} />
                    </div>
                    {restOn && (
                        <>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <Label className="text-xs text-muted-foreground">작업 시간 (분)</Label>
                                    <Input
                                        type="number"
                                        min={1}
                                        value={workMinutes}
                                        disabled={active}
                                        onChange={(event) => setWorkMinutes(Math.max(1, Number(event.target.value) || 1))}
                                    />
                                </div>
                                <div>
                                    <Label className="text-xs text-muted-foreground">작업 랜덤 ± (분)</Label>
                                    <Input
                                        type="number"
                                        min={0}
                                        value={workJitterMinutes}
                                        disabled={active}
                                        onChange={(event) => setWorkJitterMinutes(Math.max(0, Number(event.target.value) || 0))}
                                    />
                                </div>
                                <div>
                                    <Label className="text-xs text-muted-foreground">휴식 시간 (분)</Label>
                                    <Input
                                        type="number"
                                        min={1}
                                        value={restMinutes}
                                        disabled={active}
                                        onChange={(event) => setRestMinutes(Math.max(1, Number(event.target.value) || 1))}
                                    />
                                </div>
                                <div>
                                    <Label className="text-xs text-muted-foreground">휴식 랜덤 ± (분)</Label>
                                    <Input
                                        type="number"
                                        min={0}
                                        value={restJitterMinutes}
                                        disabled={active}
                                        onChange={(event) => setRestJitterMinutes(Math.max(0, Number(event.target.value) || 0))}
                                    />
                                </div>
                            </div>
                            <div className="text-xs text-muted-foreground">
                                약 {Math.max(1, workMinutes - workJitterMinutes)}~{workMinutes + workJitterMinutes}분 작업 후 {Math.max(1, restMinutes - restJitterMinutes)}~{restMinutes + restJitterMinutes}분 휴식합니다.
                            </div>
                        </>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        닫기
                    </Button>
                    {active ? (
                        <>
                            {resting && (
                                <Button variant="outline" onClick={endRest}>
                                    <Coffee className="mr-1 h-4 w-4" />
                                    지금 재개
                                </Button>
                            )}
                            {paused && (
                                <Button variant="generate" onClick={resume}>
                                    <RotateCcw className="mr-1 h-4 w-4" />
                                    재개
                                </Button>
                            )}
                            <Button variant="outline" onClick={handleStopKeepingSnapshot}>
                                <StopIcon className="mr-1 h-4 w-4" />
                                중단하고 나중에 이어서
                            </Button>
                            <Button variant="destructive" onClick={handleCancelRotation}>
                                <X className="mr-1 h-4 w-4" />
                                완전 취소
                            </Button>
                        </>
                    ) : canResumeSaved ? (
                        <>
                            <Button variant="ghost" onClick={handleDiscardSavedSession}>
                                완전 취소
                            </Button>
                            <Button variant="outline" disabled={sceneGenerating || mainGenerating} onClick={handleStart}>
                                처음부터
                            </Button>
                            <Button variant="generate" disabled={sceneGenerating || mainGenerating} onClick={handleResumeSaved}>
                                <Play className="mr-1 h-4 w-4" />
                                이어서 시작
                            </Button>
                        </>
                    ) : (
                        <Button disabled={characters.length === 0 || sceneGenerating || mainGenerating} onClick={handleStart}>
                            <Play className="mr-1 h-4 w-4" />
                            로테이션 시작
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
