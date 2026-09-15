import { ChangeEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { toNativeAssetUrl } from '@/platform/asset-url'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import {
    FlaskConical,
    BarChart3,
    ChevronLeft,
    ChevronRight,
    Copy,
    Dice5,
    Dna,
    Download,
    Equal,
    FileImage,
    FolderHeart,
    ImagePlus,
    ListPlus,
    Lock,
    Play,
    Plus,
    RefreshCw,
    RotateCcw,
    Search,
    SkipForward,
    Sparkles,
    Star,
    Store,
    Swords,
    Trash2,
    Trophy,
    Unlock,
    Upload,
    X,
} from 'lucide-react'
import { ComparisonTray } from '@/components/style-lab/ComparisonTray'
import { MarketplaceGrid } from '@/components/style-lab/MarketplaceGrid'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/use-toast'
import { captureCurrentStyleEvaluationContext } from '@/services/style-lab/capture-evaluation-context'
import { buildMarketShelf } from '@/application/style-lab/build-market-shelf'
import { exposeArenaPair } from '@/application/style-lab/expose-arena-pair'
import {
    createTasteBoard,
    deleteTasteBoard,
    ensureTasteBoards,
    updateTasteBoard,
} from '@/application/style-lab/manage-taste-boards'
import { rebuildPreferenceProjections } from '@/application/style-lab/rebuild-projections'
import {
    loadMarketInteractions,
    recordMarketAction,
    type MarketAction,
} from '@/application/style-lab/record-market-action'
import {
    recordArenaSkip,
    recordArenaTie,
    recordArenaWin,
} from '@/application/style-lab/record-preference'
import { suggestArenaPair } from '@/application/style-lab/suggest-arena-pair'
import {
    requestStyleLabPreviewRenders,
    type RequestStyleLabPreviewOptions,
} from '@/services/style-lab/request-preview-render'
import { evolveStyleBoard } from '@/application/style-lab/evolve-board'
import {
    styleCombinationIdentity,
    type MarketplaceShelfItem,
    type StyleEvolutionArchiveCell,
} from '@/domain/style-lab'
import { buildStyleLabPrompt, compactPrompt, formatWeightedPromptTags, normalizePromptTag } from '@/lib/style-lab'
import { cn } from '@/lib/utils'
import { getStyleLabRepository } from '@/services/style-lab/indexeddb-style-lab-repository'
import {
    commitStyleImportDrafts,
    prepareStyleImportDrafts,
    type StyleImportDraft,
} from '@/services/style-lab/metadata-importer'
import { getStyleLabVault } from '@/services/style-lab/style-lab-vault'
import { useGenerationStore } from '@/stores/generation-store'
import { selectStylePreviewAssets, useStyleLabReadStore } from '@/stores/style-lab-read-store'
import {
    useStyleLabSessionStore,
    type StyleLabTab,
} from '@/stores/style-lab-session-store'
import { StyleCombination, StyleLabLeague, useStyleLabStore } from '@/stores/style-lab-store'

interface AnalysisRow {
    artist: string
    count: number
    avgWeight: number
    maxWeight: number
    sources: string[]
}

const COMBINATIONS_PER_PAGE = 50

interface CombinationCardProps {
    combo: StyleCombination
    rank?: number
    compact?: boolean
    showNote?: boolean
    chooseLabel?: string
    chooseDisabled?: boolean
    promptText: string
    onChoose?: () => void
    onGenerate: () => void
    onApplyToPrompt: () => void
    onRemove: () => void
    onToggleFavorite: () => void
    onToggleLock: () => void
    onUpdateNote: (note: string) => void
}

function getPreviewSource(combo: StyleCombination): string | null {
    if (combo.previewImage) return combo.previewImage
    if (combo.previewPath && !combo.previewPath.startsWith('memory://')) return toNativeAssetUrl(combo.previewPath)
    if (combo.previewThumbnail) return combo.previewThumbnail
    return null
}

function isTemporaryPreview(combo: StyleCombination): boolean {
    return Boolean(combo.previewPath?.startsWith('memory://') || (combo.previewThumbnail && !combo.previewPath))
}

async function copyToClipboard(text: string, label: string) {
    await navigator.clipboard.writeText(text)
    toast({ title: label, variant: 'success' })
}

function downloadText(filename: string, text: string) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
}

function getCombinationSearchText(combo: StyleCombination): string {
    const tagParts = combo.tags.flatMap(rawTag => {
        const tag = normalizePromptTag(rawTag)
        const formatted = formatWeightedPromptTags([tag])
        return [tag.tag, tag.kind, `${tag.kind}:${tag.tag}`, formatted]
    })

    return [
        combo.note,
        combo.previewPrompt,
        combo.previewSeed?.toString(),
        combo.generation.toString(),
        ...tagParts,
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
}

function CombinationCard({
    combo,
    rank,
    compact,
    showNote,
    chooseLabel,
    chooseDisabled,
    promptText,
    onChoose,
    onGenerate,
    onApplyToPrompt,
    onRemove,
    onToggleFavorite,
    onToggleLock,
    onUpdateNote,
}: CombinationCardProps) {
    const { t } = useTranslation()
    const preference = useStyleLabReadStore(state => state.preferenceProjections[combo.id])
    const previewAssets = useStyleLabReadStore(state => selectStylePreviewAssets(state, combo.id))
    const tagText = formatWeightedPromptTags(combo.tags)
    const previewSource = getPreviewSource(combo)
    const temporaryPreview = isTemporaryPreview(combo)

    return (
        <Card className={cn('min-w-0 overflow-hidden border-border/60 bg-card/70', combo.favorite && 'border-warning/50', combo.locked && 'ring-1 ring-primary/30')}>
            <div className={cn('relative bg-muted/30', compact ? 'aspect-[4/3]' : 'aspect-video')}>
                {previewSource ? (
                    <img src={previewSource} alt={t('styleLab.card.previewAlt')} className="h-full w-full object-cover" />
                ) : (
                    <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground">
                        <FlaskConical className="h-8 w-8" />
                        <span className="text-xs">{t('styleLab.card.noPreview')}</span>
                    </div>
                )}
                {combo.isPreviewing && (
                    <div className="absolute inset-x-3 bottom-3 rounded-full bg-scrim/72 p-1">
                        <div className="h-1.5 rounded-full bg-primary transition-all" style={{ width: `${Math.round((combo.previewProgress || 0) * 100)}%` }} />
                    </div>
                )}
                <div className="absolute left-2 top-2 flex gap-1">
                    {rank !== undefined && <Badge variant="secondary">#{rank}</Badge>}
                    <Badge variant="outline" className="bg-popover/95">{t('styleLab.common.generationShort')} {combo.generation}</Badge>
                </div>
                <div className="absolute right-2 top-2 flex gap-1">
                    {previewAssets.length > 0 && <Badge variant="outline" className="bg-popover/95">{t('styleLab.card.assetCount', { count: previewAssets.length })}</Badge>}
                    {temporaryPreview && <Badge variant="secondary" className="bg-popover/95">{t('styleLab.card.temporaryPreview')}</Badge>}
                    {combo.favorite && <Badge className="bg-warning text-scrim">★</Badge>}
                    {combo.locked && <Badge variant="secondary">{t('styleLab.card.locked')}</Badge>}
                </div>
            </div>
            <CardContent className="min-w-0 space-y-3 p-3">
                <div className="grid grid-cols-2 gap-2 text-center text-xs sm:grid-cols-4">
                    <div className="min-w-0 rounded-lg bg-muted/50 p-2">
                        <div className="text-muted-foreground">{t('styleLab.metrics.preference')}</div>
                        <div className="font-semibold text-foreground">{preference?.mu.toFixed(2) ?? '—'}</div>
                    </div>
                    <div className="min-w-0 rounded-lg bg-muted/50 p-2">
                        <div className="text-muted-foreground">{t('styleLab.metrics.uncertainty')}</div>
                        <div className="font-semibold text-foreground">{preference?.sigma.toFixed(2) ?? '—'}</div>
                    </div>
                    <div className="min-w-0 rounded-lg bg-muted/50 p-2">
                        <div className="text-muted-foreground">{t('styleLab.metrics.evidence')}</div>
                        <div className="font-semibold text-foreground">{preference?.evidence.toFixed(1) ?? '0.0'}</div>
                    </div>
                    <div className="min-w-0 rounded-lg bg-muted/50 p-2">
                        <div className="text-muted-foreground">{t('styleLab.metrics.tags')}</div>
                        <div className="font-semibold text-foreground">{combo.tags.length}</div>
                    </div>
                </div>

                <Textarea
                    value={tagText}
                    readOnly
                    className={cn('min-w-0 font-mono text-xs leading-5', compact ? 'h-24' : 'h-28')}
                    data-allow-context-menu
                />

                {combo.previewError && (
                    <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{combo.previewError}</p>
                )}

                {showNote && (
                    <Textarea
                        value={combo.note}
                        onChange={(event) => onUpdateNote(event.target.value)}
                        placeholder={t('styleLab.card.notePlaceholder')}
                        className="h-20 min-w-0 text-xs leading-5"
                    />
                )}

                <div className="grid gap-2 sm:grid-cols-3">
                    <Button size="sm" variant="outline" className="h-auto min-h-8 min-w-0 rounded-xl px-2 py-1 text-xs leading-tight whitespace-normal" onClick={() => copyToClipboard(tagText, t('styleLab.toast.copiedTags'))}>
                        <Copy className="mr-1 h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 truncate">{t('styleLab.actions.copyTags')}</span>
                    </Button>
                    <Button size="sm" variant="outline" className="h-auto min-h-8 min-w-0 rounded-xl px-2 py-1 text-xs leading-tight whitespace-normal" onClick={() => copyToClipboard(promptText, t('styleLab.toast.copiedPrompt'))}>
                        <Copy className="mr-1 h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 truncate">{t('styleLab.actions.copyPrompt')}</span>
                    </Button>
                    <Button size="sm" variant="outline" className="h-auto min-h-8 min-w-0 rounded-xl px-2 py-1 text-xs leading-tight whitespace-normal" onClick={onApplyToPrompt}>
                        <Sparkles className="mr-1 h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 truncate">{t('styleLab.actions.applyToPrompt')}</span>
                    </Button>
                </div>

                <div className="flex flex-wrap gap-2">
                    {onChoose && chooseLabel && (
                        <Button size="sm" className="min-w-[160px] flex-1 rounded-xl whitespace-normal" onClick={onChoose} disabled={chooseDisabled}>
                            <Trophy className="mr-1.5 h-3.5 w-3.5" />
                            {chooseLabel}
                        </Button>
                    )}
                    <Button size="sm" variant="outline" className="rounded-xl" onClick={onGenerate} disabled={combo.isPreviewing}>
                        <ImagePlus className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant={combo.favorite ? 'default' : 'outline'} className="rounded-xl" onClick={onToggleFavorite}>
                        <Star className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant={combo.locked ? 'default' : 'outline'} className="rounded-xl" onClick={onToggleLock}>
                        {combo.locked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
                    </Button>
                    <Button size="sm" variant="outline" className="rounded-xl text-destructive hover:text-destructive" onClick={onRemove} disabled={combo.locked}>
                        <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                </div>
            </CardContent>
        </Card>
    )
}

export default function StyleLab() {
    const { t } = useTranslation()
    const {
        artists,
        combinations,
        evolutionLogs,
        settings,
        activeBattlePair,
        activeEvaluationContext,
        isPreviewQueueRunning,
        previewQueueTotal,
        previewQueueDone,
        addArtists,
        removeArtist,
        resetArtistsToDefault,
        resetLabData,
        updateSettings,
        generateRandomCombinations,
        addCombinationFromTags,
        removeCombination,
        toggleFavorite,
        toggleLock,
        updateNote,
        setArenaRound,
        reserveRandomSeed,
        setBattleLeague,
        recordBattle,
        recordBattleTie,
        clearArenaRound,
        recordEvolutionResult,
        cleanup,
        setCombinationLifecycle,
        setCombinationLineages,
    } = useStyleLabStore(useShallow(state => ({
        artists: state.artists,
        combinations: state.combinations,
        evolutionLogs: state.evolutionLogs,
        settings: state.settings,
        activeBattlePair: state.activeBattlePair,
        activeEvaluationContext: state.activeEvaluationContext,
        isPreviewQueueRunning: state.isPreviewQueueRunning,
        previewQueueTotal: state.previewQueueTotal,
        previewQueueDone: state.previewQueueDone,
        addArtists: state.addArtists,
        removeArtist: state.removeArtist,
        resetArtistsToDefault: state.resetArtistsToDefault,
        resetLabData: state.resetLabData,
        updateSettings: state.updateSettings,
        generateRandomCombinations: state.generateRandomCombinations,
        addCombinationFromTags: state.addCombinationFromTags,
        removeCombination: state.removeCombination,
        toggleFavorite: state.toggleFavorite,
        toggleLock: state.toggleLock,
        updateNote: state.updateNote,
        setArenaRound: state.setArenaRound,
        reserveRandomSeed: state.reserveRandomSeed,
        setBattleLeague: state.setBattleLeague,
        recordBattle: state.recordBattle,
        recordBattleTie: state.recordBattleTie,
        clearArenaRound: state.clearArenaRound,
        recordEvolutionResult: state.recordEvolutionResult,
        cleanup: state.cleanup,
        setCombinationLifecycle: state.setCombinationLifecycle,
        setCombinationLineages: state.setCombinationLineages,
    })))

    const basePrompt = useGenerationStore(state => state.basePrompt)
    const additionalPrompt = useGenerationStore(state => state.additionalPrompt)
    const detailPrompt = useGenerationStore(state => state.detailPrompt)
    const inpaintingPrompt = useGenerationStore(state => state.inpaintingPrompt)
    const i2iMode = useGenerationStore(state => state.i2iMode)
    const setAdditionalPrompt = useGenerationStore(state => state.setAdditionalPrompt)
    const cancelGeneration = useGenerationStore(state => state.cancelGeneration)
    const isStyleLabCancelling = useGenerationStore(state => state.generatingMode === 'styleLab' && state.isCancelled)
    const preferenceProjections = useStyleLabReadStore(state => state.preferenceProjections)
    const projectionsReady = useStyleLabReadStore(state => state.projectionsReady)
    const replacePreferenceProjections = useStyleLabReadStore(state => state.replacePreferenceProjections)
    const tasteBoards = useStyleLabReadStore(state => state.tasteBoards)
    const boardsReady = useStyleLabReadStore(state => state.boardsReady)
    const replaceTasteBoards = useStyleLabReadStore(state => state.replaceTasteBoards)
    const replacePreviewAssets = useStyleLabReadStore(state => state.replacePreviewAssets)
    const activeTab = useStyleLabSessionStore(state => state.activeTab)
    const activeBoardId = useStyleLabSessionStore(state => state.activeBoardId)
    const comparisonTrayIds = useStyleLabSessionStore(state => state.comparisonTrayIds)
    const setActiveTab = useStyleLabSessionStore(state => state.setActiveTab)
    const setActiveBoardId = useStyleLabSessionStore(state => state.setActiveBoardId)
    const toggleComparisonCandidate = useStyleLabSessionStore(state => state.toggleComparisonCandidate)
    const clearComparisonTray = useStyleLabSessionStore(state => state.clearComparisonTray)

    const [artistInput, setArtistInput] = useState('')
    const [randomCount, setRandomCount] = useState(settings.randomBatchCount)
    const [cleanupMinBattles, setCleanupMinBattles] = useState(3)
    const [cleanupEloBelow, setCleanupEloBelow] = useState(1120)
    const [analysisRows, setAnalysisRows] = useState<AnalysisRow[]>([])
    const [importDrafts, setImportDrafts] = useState<StyleImportDraft[]>([])
    const [isAnalyzing, setIsAnalyzing] = useState(false)
    const [combinationSearch, setCombinationSearch] = useState('')
    const [combinationPage, setCombinationPage] = useState(1)
    const [isArenaUpdating, setIsArenaUpdating] = useState(false)
    const [isMarketplaceUpdating, setIsMarketplaceUpdating] = useState(false)
    const [marketShelf, setMarketShelf] = useState<readonly MarketplaceShelfItem[]>([])
    const [marketLikedIds, setMarketLikedIds] = useState<ReadonlySet<string>>(new Set())
    const [marketCollectedIds, setMarketCollectedIds] = useState<ReadonlySet<string>>(new Set())
    const [marketHiddenIds, setMarketHiddenIds] = useState<ReadonlySet<string>>(new Set())
    const [newBoardName, setNewBoardName] = useState('')
    const [evolutionArchive, setEvolutionArchive] = useState<StyleEvolutionArchiveCell[]>([])
    const [isEvolving, setIsEvolving] = useState(false)

    const activeBoard = useMemo(
        () => tasteBoards.find(board => board.id === activeBoardId) ?? null,
        [activeBoardId, tasteBoards],
    )

    const queueStyleLabPreviews = useCallback((
        ids: readonly string[],
        options: RequestStyleLabPreviewOptions = {},
    ): void => {
        void requestStyleLabPreviewRenders(ids, options).then(result => {
            if (result.rejected.length > 0) {
                toast({
                    title: t('styleLab.toast.renderBudgetExhausted'),
                    description: t('styleLab.toast.renderBudgetExhaustedDescription', {
                        count: result.rejected.length,
                    }),
                    variant: 'destructive',
                })
            }
        }).catch(error => {
            console.error('[StyleLab] Failed to enqueue durable previews:', error)
            toast({ title: t('styleLab.toast.previewFailed'), description: String(error), variant: 'destructive' })
        })
    }, [t])

    // Rebuild only when active candidates or frozen legacy priors change. Live Elo
    // counters remain a compatibility projection and must not be counted twice.
    const preferencePriorFingerprint = useMemo(() => combinations.map(combo => [
        combo.id,
        combo.legacyElo ?? combo.elo,
        combo.legacyBattles ?? combo.battles,
        combo.legacyFavorite ?? combo.favorite,
    ].join(':')).join('|'), [combinations])

    useEffect(() => {
        let disposed = false
        const candidates = useStyleLabStore.getState().combinations
        void rebuildPreferenceProjections({
            candidates,
            repository: getStyleLabRepository(),
        }).then(projections => {
            if (!disposed) replacePreferenceProjections(projections)
        }).catch(error => {
            console.error('[StyleLab] Failed to rebuild preference projections:', error)
        })
        return () => { disposed = true }
    }, [preferencePriorFingerprint, replacePreferenceProjections])

    useEffect(() => {
        let disposed = false
        void ensureTasteBoards({
            repository: getStyleLabRepository(),
            defaultName: t('styleLab.boards.defaultName'),
        }).then(boards => {
            if (disposed) return
            replaceTasteBoards(boards)
            const selectedId = useStyleLabSessionStore.getState().activeBoardId
            if (!selectedId || !boards.some(board => board.id === selectedId)) {
                setActiveBoardId(boards[0]?.id ?? null)
            }
        }).catch(error => {
            console.error('[StyleLab] Failed to load TasteBoards:', error)
        })
        return () => { disposed = true }
    }, [replaceTasteBoards, setActiveBoardId, t])

    const previewAssetFingerprint = useMemo(() => combinations.map(combo => (
        `${combo.id}:${combo.previewPath ?? ''}:${combo.previewContextId ?? ''}:${combo.updatedAt}`
    )).join('|'), [combinations])

    useEffect(() => {
        let disposed = false
        void getStyleLabRepository().listPreviewAssets().then(assets => {
            if (!disposed) replacePreviewAssets(assets)
        })
        return () => { disposed = true }
    }, [previewAssetFingerprint, replacePreviewAssets])

    useEffect(() => {
        if (!activeBoard) return
        let disposed = false
        void loadMarketInteractions(getStyleLabRepository(), activeBoard.id).then(interactions => {
            if (disposed) return
            setMarketLikedIds(interactions.likedIds)
            setMarketCollectedIds(interactions.collectedIds)
            setMarketHiddenIds(interactions.hiddenIds)
        }).catch(error => {
            console.error('[StyleLab] Failed to load Marketplace interactions:', error)
        })
        return () => { disposed = true }
    }, [activeBoard])

    useEffect(() => {
        if (!activeBoard) {
            setEvolutionArchive([])
            return
        }
        let disposed = false
        void getStyleLabRepository().listEvolutionArchive(activeBoard.id).then(cells => {
            if (!disposed) setEvolutionArchive(cells)
        })
        return () => { disposed = true }
    }, [activeBoard])

    const sortedCombinations = useMemo(
        () => [...combinations].sort((left, right) => {
            const leftPreference = preferenceProjections[left.id]
            const rightPreference = preferenceProjections[right.id]
            return (rightPreference?.mu ?? Number.NEGATIVE_INFINITY)
                - (leftPreference?.mu ?? Number.NEGATIVE_INFINITY)
                || (leftPreference?.sigma ?? Number.POSITIVE_INFINITY)
                - (rightPreference?.sigma ?? Number.POSITIVE_INFINITY)
                || right.elo - left.elo
                || right.updatedAt - left.updatedAt
        }),
        [combinations, preferenceProjections],
    )

    const normalizedCombinationSearch = combinationSearch.trim().toLowerCase()
    const combinationSearchTerms = useMemo(
        () => normalizedCombinationSearch.split(/\s+/).filter(Boolean),
        [normalizedCombinationSearch],
    )
    const filteredCombinations = useMemo(() => {
        if (combinationSearchTerms.length === 0) return sortedCombinations
        return sortedCombinations.filter(combo => {
            const haystack = getCombinationSearchText(combo)
            return combinationSearchTerms.every(term => haystack.includes(term))
        })
    }, [combinationSearchTerms, sortedCombinations])
    const combinationPageCount = Math.max(1, Math.ceil(filteredCombinations.length / COMBINATIONS_PER_PAGE))
    const visibleCombinationPage = Math.min(Math.max(combinationPage, 1), combinationPageCount)
    const combinationPageStart = (visibleCombinationPage - 1) * COMBINATIONS_PER_PAGE
    const pagedCombinations = useMemo(
        () => filteredCombinations.slice(combinationPageStart, combinationPageStart + COMBINATIONS_PER_PAGE),
        [combinationPageStart, filteredCombinations],
    )

    useEffect(() => {
        setCombinationPage(1)
    }, [normalizedCombinationSearch])

    useEffect(() => {
        setCombinationPage(page => Math.min(Math.max(page, 1), combinationPageCount))
    }, [combinationPageCount])

    const battlePair = useMemo(() => {
        if (!activeBattlePair) return null
        const left = combinations.find(combo => combo.id === activeBattlePair[0])
        const right = combinations.find(combo => combo.id === activeBattlePair[1])
        return left && right ? { left, right } : null
    }, [activeBattlePair, combinations])

    const battlePairVerified = Boolean(
        battlePair
        && activeEvaluationContext
        && battlePair.left.lifecycle === 'eligible'
        && battlePair.right.lifecycle === 'eligible'
        && battlePair.left.previewContextId === activeEvaluationContext.id
        && battlePair.right.previewContextId === activeEvaluationContext.id,
    )

    const battlePoolCount = useMemo(
        () => combinations.filter(combo => combo.lifecycle !== 'archived'
            && (settings.battleLeague === 'all' || combo.favorite)).length,
        [combinations, settings.battleLeague],
    )

    const stats = useMemo(() => {
        const currentProjections = combinations
            .map(combo => preferenceProjections[combo.id])
            .filter(projection => projection !== undefined)
        const evaluated = currentProjections.filter(projection => projection.evidence > 0).length
        const evaluatedRatio = combinations.length ? Math.round(evaluated / combinations.length * 100) : 0
        const averageUncertainty = currentProjections.length
            ? currentProjections.reduce((sum, projection) => sum + projection.sigma, 0) / currentProjections.length
            : 0
        const needsComparison = currentProjections.filter(projection => (
            projection.evidence < 3 || projection.sigma > 0.9
        )).length
        const artistMap = new Map<string, { artist: string; count: number; weightSum: number }>()
        const generationMap = new Map<number, number>()

        for (const combo of combinations) {
            generationMap.set(combo.generation, (generationMap.get(combo.generation) || 0) + 1)
            for (const rawTag of combo.tags) {
                const tag = normalizePromptTag(rawTag)
                if (tag.kind !== 'artist') continue
                const key = tag.tag.toLowerCase()
                const current = artistMap.get(key) || { artist: tag.tag, count: 0, weightSum: 0 }
                current.count += 1
                current.weightSum += tag.weight
                artistMap.set(key, current)
            }
        }

        return {
            evaluatedRatio,
            averageUncertainty,
            needsComparison,
            artists: [...artistMap.values()].sort((a, b) => b.count - a.count).slice(0, 12),
            generations: [...generationMap.entries()].sort((a, b) => a[0] - b[0]),
        }
    }, [combinations, preferenceProjections])

    const templatePreview = useMemo(() => {
        const sampleTags = sortedCombinations[0]
            ? formatWeightedPromptTags(sortedCombinations[0].tags)
            : '1.5::artist:shnva ::, 1.3::artist:necomi ::'
        return buildStyleLabPrompt(settings.promptTemplate, sampleTags, {
            basePrompt,
            additionalPrompt,
            detailPrompt,
            inpaintingPrompt: i2iMode === 'inpaint' ? inpaintingPrompt : '',
        })
    }, [additionalPrompt, basePrompt, detailPrompt, i2iMode, inpaintingPrompt, settings.promptTemplate, sortedCombinations])

    const collectionItems = useMemo(() => combinations
        .filter(combo => marketCollectedIds.has(combo.id))
        .sort((left, right) => (
            (preferenceProjections[right.id]?.mu ?? 0) - (preferenceProjections[left.id]?.mu ?? 0)
            || left.id.localeCompare(right.id)
        ))
        .map(combo => ({
            comboId: combo.id,
            bucket: 'preferred' as const,
            reason: 'board-similar' as const,
            score: preferenceProjections[combo.id]?.mu ?? 0,
        })), [combinations, marketCollectedIds, preferenceProjections])

    const hiddenItems = useMemo(() => combinations
        .filter(combo => marketHiddenIds.has(combo.id) && !marketCollectedIds.has(combo.id))
        .map(combo => ({
            comboId: combo.id,
            bucket: 'explore' as const,
            reason: 'exploring' as const,
            score: preferenceProjections[combo.id]?.mu ?? 0,
        })), [combinations, marketCollectedIds, marketHiddenIds, preferenceProjections])

    const refreshMarketplace = useCallback(async () => {
        const selectedBoardId = useStyleLabSessionStore.getState().activeBoardId
        const selectedBoard = useStyleLabReadStore.getState().tasteBoards
            .find(board => board.id === selectedBoardId)
        if (!selectedBoard) {
            setMarketShelf([])
            return
        }
        setMarketShelf([])
        setIsMarketplaceUpdating(true)
        try {
            const result = await buildMarketShelf({
                candidates: useStyleLabStore.getState().combinations,
                board: selectedBoard,
                randomSeed: reserveRandomSeed('marketplace-shelf'),
                repository: getStyleLabRepository(),
                context: captureCurrentStyleEvaluationContext([useGenerationStore.getState().seed]),
            })
            setMarketShelf(result.shelf)
            setMarketLikedIds(result.likedIds)
            setMarketCollectedIds(result.collectedIds)
            setMarketHiddenIds(result.hiddenIds)
            replacePreferenceProjections(result.projections)
        } catch (error) {
            console.error('[StyleLab] Failed to build Marketplace shelf:', error)
            toast({ title: t('styleLab.toast.preferenceSaveFailed'), variant: 'destructive' })
        } finally {
            setIsMarketplaceUpdating(false)
        }
    }, [replacePreferenceProjections, reserveRandomSeed, t])

    useEffect(() => {
        if (activeTab === 'market' && activeBoard) void refreshMarketplace()
    }, [activeBoard?.exploration, activeBoard?.id, activeBoard?.updatedAt, activeTab, refreshMarketplace])

    const handleAddArtists = () => {
        const added = addArtists(artistInput)
        if (added === 0) {
            toast({ title: t('styleLab.toast.noNewArtists'), variant: 'destructive' })
            return
        }
        setArtistInput('')
        toast({ title: t('styleLab.toast.artistsAdded', { count: added }), variant: 'success' })
    }

    const handleGenerateRandom = () => {
        updateSettings({ randomBatchCount: randomCount })
        const created = generateRandomCombinations(randomCount)
        toast({
            title: created > 0
                ? t('styleLab.toast.randomCreated', { count: created })
                : t('styleLab.toast.randomFailed'),
            description: created === 0 ? t('styleLab.toast.randomFailedDesc') : undefined,
            variant: created > 0 ? 'success' : 'destructive',
        })
    }

    const handleCreateBoard = async () => {
        const name = newBoardName.trim()
        if (!name || isMarketplaceUpdating) return
        setIsMarketplaceUpdating(true)
        try {
            const boards = await createTasteBoard({
                repository: getStyleLabRepository(),
                name,
            })
            replaceTasteBoards(boards)
            const created = [...boards].reverse().find(board => board.name === name)
            setActiveBoardId(created?.id ?? boards[0]?.id ?? null)
            setNewBoardName('')
        } catch (error) {
            console.error('[StyleLab] Failed to create TasteBoard:', error)
            toast({ title: t('styleLab.toast.boardSaveFailed'), variant: 'destructive' })
        } finally {
            setIsMarketplaceUpdating(false)
        }
    }

    const handleUpdateBoardExploration = async (exploration: number) => {
        if (!activeBoard || isMarketplaceUpdating) return
        setIsMarketplaceUpdating(true)
        try {
            const boards = await updateTasteBoard({
                repository: getStyleLabRepository(),
                board: activeBoard,
                exploration,
            })
            replaceTasteBoards(boards)
        } catch (error) {
            console.error('[StyleLab] Failed to update TasteBoard:', error)
            toast({ title: t('styleLab.toast.boardSaveFailed'), variant: 'destructive' })
        } finally {
            setIsMarketplaceUpdating(false)
        }
    }

    const handleToggleBoardAutoEvolution = async (autoEvolution: boolean) => {
        if (!activeBoard || isMarketplaceUpdating) return
        setIsMarketplaceUpdating(true)
        try {
            const boards = await updateTasteBoard({
                repository: getStyleLabRepository(),
                board: activeBoard,
                autoEvolution,
                budgetId: activeBoard.budgetId ?? `style-budget:auto:${activeBoard.id}`,
            })
            replaceTasteBoards(boards)
        } catch (error) {
            console.error('[StyleLab] Failed to update auto evolution:', error)
            toast({ title: t('styleLab.toast.boardSaveFailed'), variant: 'destructive' })
        } finally {
            setIsMarketplaceUpdating(false)
        }
    }

    const handleDeleteActiveBoard = async () => {
        if (!activeBoard || tasteBoards.length <= 1 || isMarketplaceUpdating) return
        setIsMarketplaceUpdating(true)
        try {
            const boards = await deleteTasteBoard({
                repository: getStyleLabRepository(),
                boardId: activeBoard.id,
            })
            replaceTasteBoards(boards)
            setActiveBoardId(boards[0]?.id ?? null)
        } catch (error) {
            console.error('[StyleLab] Failed to delete TasteBoard:', error)
            toast({ title: t('styleLab.toast.boardSaveFailed'), variant: 'destructive' })
        } finally {
            setIsMarketplaceUpdating(false)
        }
    }

    const previewBattlePairIfEnabled = (
        pair: [string, string] | null,
        context = useStyleLabStore.getState().activeEvaluationContext,
    ) => {
        if (pair && settings.autoPreviewBattlePair) {
            queueStyleLabPreviews(pair, {
                ...(context === null ? {} : { evaluationContext: context }),
            })
        }
    }

    const pickAndDisplayArenaPair = async (): Promise<[string, string] | null> => {
        const generation = useGenerationStore.getState()
        const evaluationSeed = generation.seedLocked
            ? generation.seed
            : reserveRandomSeed('evaluation-context')
        const context = captureCurrentStyleEvaluationContext([evaluationSeed])
        const state = useStyleLabStore.getState()
        const suggestion = await suggestArenaPair({
            candidates: state.combinations,
            league: state.settings.battleLeague,
            context,
            randomSeed: reserveRandomSeed('arena-pair'),
            repository: getStyleLabRepository(),
        })
        if (suggestion === null) return null

        replacePreferenceProjections(suggestion.projections)
        setArenaRound(suggestion.pair, suggestion.context)
        previewBattlePairIfEnabled(suggestion.pair, suggestion.context)
        return suggestion.pair
    }

    const handlePickBattle = async () => {
        if (isArenaUpdating) return
        setIsArenaUpdating(true)
        try {
            const pair = await pickAndDisplayArenaPair()
            if (pair !== null) return
            toast({
                title: t('styleLab.toast.notEnoughArenaCandidates'),
                description: t('styleLab.toast.notEnoughArenaCandidatesDesc'),
                variant: 'destructive',
            })
        } catch (error) {
            console.error('[StyleLab] Failed to persist Arena exposure:', error)
            toast({ title: t('styleLab.toast.preferenceSaveFailed'), variant: 'destructive' })
        } finally {
            setIsArenaUpdating(false)
        }
    }

    const handleArenaDecision = async (
        decision: 'win' | 'tie' | 'skip',
        winnerId?: string,
        loserId?: string,
    ) => {
        if (isArenaUpdating) return
        const state = useStyleLabStore.getState()
        const context = state.activeEvaluationContext
        const pair = state.activeBattlePair
        if (context === null || pair === null) {
            await handlePickBattle()
            return
        }
        setIsArenaUpdating(true)
        try {
            const baseInput = {
                candidates: state.combinations,
                context,
                repository: getStyleLabRepository(),
            }
            const result = decision === 'win' && winnerId !== undefined && loserId !== undefined
                ? await recordArenaWin({ ...baseInput, winnerId, loserId })
                : decision === 'tie'
                    ? await recordArenaTie({ ...baseInput, leftId: pair[0], rightId: pair[1] })
                    : await recordArenaSkip({ ...baseInput, leftId: pair[0], rightId: pair[1] })
            replacePreferenceProjections(result.projections)
            if (decision === 'win' && winnerId !== undefined && loserId !== undefined) {
                recordBattle(winnerId, loserId)
            } else if (decision === 'tie') {
                recordBattleTie(pair[0], pair[1])
            } else {
                clearArenaRound()
            }
            const next = await pickAndDisplayArenaPair()
            if (next === null) {
                toast({ title: t('styleLab.toast.notEnoughArenaCandidates'), variant: 'destructive' })
            }
        } catch (error) {
            console.error('[StyleLab] Failed to persist Arena preference:', error)
            toast({ title: t('styleLab.toast.preferenceSaveFailed'), variant: 'destructive' })
        } finally {
            setIsArenaUpdating(false)
        }
    }

    const handleBattleChoice = (winnerId: string, loserId: string) => (
        handleArenaDecision('win', winnerId, loserId)
    )

    const handleCompareTray = async () => {
        if (comparisonTrayIds.length !== 2 || isArenaUpdating) return
        const pair = [comparisonTrayIds[0], comparisonTrayIds[1]] as [string, string]
        const state = useStyleLabStore.getState()
        if (pair.some(id => !state.combinations.some(combo => combo.id === id))) return
        setIsArenaUpdating(true)
        try {
            const generation = useGenerationStore.getState()
            const evaluationSeed = generation.seedLocked
                ? generation.seed
                : reserveRandomSeed('evaluation-context')
            const context = captureCurrentStyleEvaluationContext([evaluationSeed])
            const exposure = await exposeArenaPair({
                candidates: state.combinations,
                pair,
                context,
                repository: getStyleLabRepository(),
            })
            replacePreferenceProjections(exposure.projections)
            setArenaRound(exposure.pair, exposure.context)
            previewBattlePairIfEnabled(exposure.pair, exposure.context)
            clearComparisonTray()
            setActiveTab('battle')
        } catch (error) {
            console.error('[StyleLab] Failed to expose comparison-tray pair:', error)
            toast({ title: t('styleLab.toast.preferenceSaveFailed'), variant: 'destructive' })
        } finally {
            setIsArenaUpdating(false)
        }
    }

    const handleEvolve = async () => {
        if (!activeBoard || isEvolving) return
        setIsEvolving(true)
        try {
            const state = useStyleLabStore.getState()
            const result = await evolveStyleBoard({
                candidates: state.combinations,
                board: activeBoard,
                settings: state.settings,
                artistPool: state.artists,
                randomSeed: state.reserveRandomSeed(`map-elites:${activeBoard.id}`),
                repository: getStyleLabRepository(),
                addCombination: (tags, generation) => (
                    useStyleLabStore.getState().addCombinationFromTags(tags, generation)
                ),
                requestRenders: requestStyleLabPreviewRenders,
            })
            if (result.childIds.length === 0) {
                toast({
                    title: t('styleLab.toast.notEnoughParents'),
                    description: t('styleLab.toast.notEnoughParentsDesc'),
                    variant: 'destructive',
                })
                return
            }
            const parentIds = [...new Set(result.lineages.flatMap(lineage => lineage.parentIds))]
            recordEvolutionResult({
                generation: Math.max(...result.lineages.map(lineage => lineage.generation)),
                parentIds,
                childIds: result.childIds,
                parentCount: parentIds.length,
                childCount: result.childIds.length,
                note: t('styleLab.evolve.mapElitesHistory', {
                    cells: result.archive.length,
                    renders: result.queuedRenderCount,
                }),
            })
            setCombinationLineages(result.lineages)
            setEvolutionArchive(result.archive)
            toast({ title: t('styleLab.toast.childrenCreated', { count: result.childIds.length }), variant: 'success' })
        } catch (error) {
            toast({
                title: t('styleLab.toast.evolutionFailed'),
                description: String(error),
                variant: 'destructive',
            })
        } finally {
            setIsEvolving(false)
        }
    }

    const handleCleanup = () => {
        const removed = cleanup(cleanupMinBattles, cleanupEloBelow)
        toast({
            title: removed > 0
                ? t('styleLab.toast.cleaned', { count: removed })
                : t('styleLab.toast.nothingToClean'),
            variant: removed > 0 ? 'success' : 'default',
        })
    }

    const handleAnalyzePng = async (event: ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files || [])
        if (files.length === 0) return
        setIsAnalyzing(true)

        try {
            const drafts = await prepareStyleImportDrafts({
                files,
                repository: getStyleLabRepository(),
            })
            const aggregate = new Map<string, { artist: string; count: number; weightSum: number; maxWeight: number; sources: Set<string> }>()

            for (const draft of drafts) {
                for (const rawTag of draft.tags) {
                    const tag = normalizePromptTag(rawTag)
                    const key = tag.tag.toLowerCase()
                    const current = aggregate.get(key) || {
                        artist: tag.tag,
                        count: 0,
                        weightSum: 0,
                        maxWeight: 0,
                        sources: new Set<string>(),
                    }
                    current.count += 1
                    current.weightSum += tag.weight
                    current.maxWeight = Math.max(current.maxWeight, tag.weight)
                    current.sources.add(draft.fileName)
                    aggregate.set(key, current)
                }
            }

            const rows: AnalysisRow[] = [...aggregate.values()]
                .map(row => ({
                    artist: row.artist,
                    count: row.count,
                    avgWeight: Math.round((row.weightSum / row.count) * 10) / 10,
                    maxWeight: Math.round(row.maxWeight * 10) / 10,
                    sources: [...row.sources],
                }))
                .sort((a, b) => b.count - a.count || b.avgWeight - a.avgWeight)

            setAnalysisRows(rows)
            setImportDrafts(drafts)
            toast({
                title: rows.length > 0
                    ? t('styleLab.toast.artistTagsFound', { count: rows.length })
                    : t('styleLab.toast.noArtistTagsFound'),
                variant: rows.length > 0 ? 'success' : 'destructive',
            })
        } catch (error) {
            toast({ title: t('styleLab.toast.pngAnalyzeFailed'), description: String(error), variant: 'destructive' })
        } finally {
            setIsAnalyzing(false)
            event.target.value = ''
        }
    }

    const handleAddAnalysisArtists = () => {
        const added = addArtists(analysisRows.map(row => row.artist).join('\n'))
        toast({ title: t('styleLab.toast.analysisArtistsAdded', { count: added }), variant: added > 0 ? 'success' : 'default' })
    }

    const handleAddAnalysisCombination = () => {
        let added = 0
        for (const draft of importDrafts) {
            const tags = draft.tags.filter(tag => (
                draft.includedTagKeys.includes(`${tag.kind}:${tag.tag.toLowerCase()}`)
            )).slice(0, settings.maxTags)
            if (addCombinationFromTags(tags) !== null) added += 1
        }
        toast({
            title: added > 0
                ? t('styleLab.toast.analysisCombinationsAdded', { count: added })
                : t('styleLab.toast.analysisCombinationSkipped'),
            variant: added > 0 ? 'success' : 'destructive',
        })
    }

    const toggleImportTag = (draftId: string, tagKey: string) => {
        setImportDrafts(drafts => drafts.map(draft => {
            if (draft.id !== draftId) return draft
            const included = draft.includedTagKeys.includes(tagKey)
            return {
                ...draft,
                includedTagKeys: included
                    ? draft.includedTagKeys.filter(key => key !== tagKey)
                    : [...draft.includedTagKeys, tagKey],
            }
        }))
    }

    const handleCommitImports = async () => {
        if (importDrafts.length === 0 || isAnalyzing) return
        setIsAnalyzing(true)
        try {
            const result = await commitStyleImportDrafts({
                drafts: importDrafts,
                repository: getStyleLabRepository(),
                vault: getStyleLabVault(),
                resolveCombination: tags => {
                    const addedId = addCombinationFromTags(tags)
                    if (addedId !== null) return addedId
                    const renderHash = styleCombinationIdentity(tags).renderHash
                    return useStyleLabStore.getState().combinations.find(combo => combo.renderHash === renderHash)?.id ?? null
                },
            })
            for (const asset of result.imported) setCombinationLifecycle(asset.comboId, 'previewed')
            const importedIds = new Set(result.imported.map(asset => asset.comboId))
            if (importedIds.size > 0) setImportDrafts([])
            toast({
                title: t('styleLab.toast.assetsImported', { count: result.imported.length }),
                description: result.skipped.length > 0
                    ? t('styleLab.toast.assetsSkipped', { count: result.skipped.length })
                    : undefined,
                variant: result.imported.length > 0 ? 'success' : 'destructive',
            })
        } catch (error) {
            toast({ title: t('styleLab.toast.assetImportFailed'), description: String(error), variant: 'destructive' })
        } finally {
            setIsAnalyzing(false)
        }
    }

    const handleExport = () => {
        const body = sortedCombinations.map((combo, index) => {
            const header = `#${index + 1} | Elo ${combo.elo} | ${combo.wins}-${combo.losses} | Gen ${combo.generation}${combo.favorite ? ' | Favorite' : ''}${combo.locked ? ' | Locked' : ''}`
            const note = combo.note.trim() ? `\n${t('styleLab.card.notePlaceholder')}: ${combo.note.trim()}` : ''
            return `${header}\n${formatWeightedPromptTags(combo.tags)}${note}`
        }).join('\n\n---\n\n')
        downloadText(`NAI_Blue_style_lab_${Date.now()}.txt`, body || t('styleLab.empty.noSavedCombinations'))
    }

    const buildCombinationPrompt = (combo: StyleCombination) => buildStyleLabPrompt(
        settings.promptTemplate,
        formatWeightedPromptTags(combo.tags),
        {
            basePrompt,
            additionalPrompt,
            detailPrompt,
            inpaintingPrompt: i2iMode === 'inpaint' ? inpaintingPrompt : '',
        },
    )

    const applyCombinationToPrompt = (combo: StyleCombination) => {
        const tagText = formatWeightedPromptTags(combo.tags)
        setAdditionalPrompt(compactPrompt(additionalPrompt.trim() ? `${additionalPrompt}, ${tagText}` : tagText))
        toast({ title: t('styleLab.toast.appliedToPrompt'), variant: 'success' })
    }

    const handleMarketAction = async (action: MarketAction, comboId: string) => {
        if (!activeBoard || isMarketplaceUpdating) return
        setIsMarketplaceUpdating(true)
        try {
            const state = useStyleLabStore.getState()
            const result = await recordMarketAction({
                candidates: state.combinations,
                action,
                comboId,
                boardId: activeBoard.id,
                repository: getStyleLabRepository(),
            })
            replacePreferenceProjections(result.projections)
            setMarketLikedIds(result.interactions.likedIds)
            setMarketCollectedIds(result.interactions.collectedIds)
            setMarketHiddenIds(result.interactions.hiddenIds)
            if ((action === 'collect' || action === 'hide') && result.toggledOn) {
                setMarketShelf(shelf => shelf.filter(item => item.comboId !== comboId))
            }
            if (action === 'apply') {
                const combo = state.combinations.find(candidate => candidate.id === comboId)
                if (combo) applyCombinationToPrompt(combo)
            }
        } catch (error) {
            console.error('[StyleLab] Failed to record Marketplace action:', error)
            toast({ title: t('styleLab.toast.preferenceSaveFailed'), variant: 'destructive' })
        } finally {
            setIsMarketplaceUpdating(false)
        }
    }

    const renderCombinationCard = (combo: StyleCombination, rank?: number, compact?: boolean, showNote?: boolean) => (
        <CombinationCard
            key={combo.id}
            combo={combo}
            rank={rank}
            compact={compact}
            showNote={showNote}
            promptText={buildCombinationPrompt(combo)}
            onGenerate={() => queueStyleLabPreviews([combo.id])}
            onApplyToPrompt={() => applyCombinationToPrompt(combo)}
            onRemove={() => removeCombination(combo.id)}
            onToggleFavorite={() => toggleFavorite(combo.id)}
            onToggleLock={() => toggleLock(combo.id)}
            onUpdateNote={(note) => updateNote(combo.id, note)}
        />
    )

    const renderBoardControls = () => (
        <Card className="min-w-0">
            <CardContent className="space-y-4 p-4">
                <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div className="min-w-0">
                        <h3 className="font-semibold">{t('styleLab.boards.title')}</h3>
                        <p className="text-sm text-muted-foreground">{t('styleLab.boards.description')}</p>
                    </div>
                    <div className="flex min-w-0 flex-wrap gap-2">
                        {tasteBoards.map(board => (
                            <Button
                                key={board.id}
                                size="sm"
                                variant={board.id === activeBoard?.id ? 'default' : 'outline'}
                                className="max-w-[220px] rounded-xl"
                                onClick={() => setActiveBoardId(board.id)}
                            >
                                <span className="truncate">{board.name}</span>
                            </Button>
                        ))}
                    </div>
                </div>
                <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(220px,1fr)_minmax(220px,1fr)_minmax(180px,auto)_auto] lg:items-end">
                    <div className="space-y-2">
                        <Label htmlFor="stylelab-new-board">{t('styleLab.boards.newBoard')}</Label>
                        <div className="flex gap-2">
                            <Input
                                id="stylelab-new-board"
                                value={newBoardName}
                                onChange={event => setNewBoardName(event.target.value)}
                                onKeyDown={event => {
                                    if (event.key === 'Enter') void handleCreateBoard()
                                }}
                                placeholder={t('styleLab.boards.namePlaceholder')}
                            />
                            <Button
                                size="icon"
                                variant="outline"
                                className="shrink-0 rounded-xl"
                                onClick={() => void handleCreateBoard()}
                                disabled={!newBoardName.trim() || isMarketplaceUpdating}
                                title={t('styleLab.boards.create')}
                            >
                                <Plus className="h-4 w-4" />
                            </Button>
                        </div>
                    </div>
                    <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                            <Label>{t('styleLab.boards.exploration')}</Label>
                            <span className="text-xs text-muted-foreground">
                                {activeBoard ? Math.round(activeBoard.exploration * 100) : 0}%
                            </span>
                        </div>
                        {activeBoard && (
                            <Slider
                                key={`${activeBoard.id}:${activeBoard.updatedAt}`}
                                defaultValue={[activeBoard.exploration]}
                                min={0}
                                max={1}
                                step={0.05}
                                disabled={isMarketplaceUpdating}
                                onValueCommit={value => void handleUpdateBoardExploration(value[0] ?? 0)}
                            />
                        )}
                    </div>
                    <div className="flex min-h-10 items-center justify-between gap-3 rounded-lg border px-3">
                        <div>
                            <Label>{t('styleLab.boards.autoEvolution')}</Label>
                            <p className="text-[11px] text-muted-foreground">{t('styleLab.boards.autoEvolutionBudget')}</p>
                        </div>
                        <Switch
                            checked={activeBoard?.autoEvolution ?? false}
                            disabled={!activeBoard || isMarketplaceUpdating}
                            onChange={event => void handleToggleBoardAutoEvolution(event.target.checked)}
                        />
                    </div>
                    <Button
                        variant="outline"
                        className="rounded-xl text-destructive hover:text-destructive"
                        onClick={() => void handleDeleteActiveBoard()}
                        disabled={tasteBoards.length <= 1 || isMarketplaceUpdating}
                    >
                        <Trash2 className="mr-1.5 h-4 w-4" />{t('styleLab.boards.delete')}
                    </Button>
                </div>
            </CardContent>
        </Card>
    )

    const latestGeneration = Math.max(0, ...combinations.map(combo => combo.generation))
    const latestGenerationIds = combinations.filter(combo => combo.generation === latestGeneration).map(combo => combo.id)

    return (
        <div className="workspace-page min-w-0 space-y-6 pb-8">
            <header className="workspace-heading">
                <div>
                    <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                        <div className="min-w-0">
                            <h1>
                                <span>{t('styleLab.title')}</span>
                            </h1>
                            <p>
                                {t('workspace.styleHint', '작가 조합을 준비하고, 두 그림을 비교하며 좋아하는 그림체를 찾아보세요.')}
                            </p>
                        </div>
                        <details className="workspace-disclosure shrink-0">
                            <summary>{t('workspace.styleMetrics', '비교 통계')}</summary>
                            <div className="grid grid-cols-3 gap-4 text-center text-sm">
                            <div className="min-w-0 rounded-xl bg-background/60 p-3">
                                <div className="text-muted-foreground">{t('styleLab.metrics.combinations')}</div>
                                <div className="text-xl font-bold">{combinations.length}</div>
                            </div>
                            <div className="min-w-0 rounded-xl bg-background/60 p-3">
                                <div className="text-muted-foreground">{t('styleLab.metrics.evaluatedRatio')}</div>
                                <div className="text-xl font-bold">{projectionsReady ? `${stats.evaluatedRatio}%` : '—'}</div>
                            </div>
                            <div className="min-w-0 rounded-xl bg-background/60 p-3">
                                <div className="text-muted-foreground">{t('styleLab.metrics.averageUncertainty')}</div>
                                <div className="text-xl font-bold">{projectionsReady ? stats.averageUncertainty.toFixed(2) : '—'}</div>
                            </div>
                            </div>
                        </details>
                    </div>
                    {isPreviewQueueRunning && (
                        <div className="mt-4 rounded-xl border border-primary/20 bg-background/60 p-3">
                            <div className="mb-2 flex items-center justify-between text-sm">
                                <span className="flex items-center gap-2"><Play className="h-4 w-4" />{t('styleLab.preview.queueRunning')}</span>
                                <div className="flex items-center gap-2">
                                    <span>{previewQueueDone}/{previewQueueTotal}</span>
                                    <Button size="sm" variant="destructive" className="rounded-xl" onClick={cancelGeneration} disabled={isStyleLabCancelling}>
                                        <X className="mr-1 h-3.5 w-3.5" />
                                        {isStyleLabCancelling ? t('styleLab.preview.cancelling') : t('styleLab.preview.stop')}
                                    </Button>
                                </div>
                            </div>
                            <div className="h-2 rounded-full bg-muted overflow-hidden">
                                <div className="h-full bg-primary transition-all" style={{ width: `${previewQueueTotal ? (previewQueueDone / previewQueueTotal) * 100 : 0}%` }} />
                            </div>
                        </div>
                    )}
                </div>
            </header>

            <Tabs
                value={activeTab}
                onValueChange={value => setActiveTab(value as StyleLabTab)}
                className="min-w-0 space-y-4 @container"
            >
                <label className="block sm:hidden">
                    <span className="sr-only">{t('nav.styleLab')}</span>
                    <select className="min-h-11 w-full rounded-control border border-input bg-background px-3"
                        value={activeTab} onChange={event => setActiveTab(event.target.value as StyleLabTab)}>
                        {(['battle', 'market', 'collection', 'manage', 'evolve', 'analyze', 'stats', 'settings'] as const).map((tab, index) =>
                            <option key={tab} value={tab}>{t(`styleLab.tabs.${['arena', 'market', 'collection', 'manage', 'evolve', 'analyze', 'stats', 'template'][index]}`)}</option>)}
                    </select>
                </label>
                <TabsList className="workspace-tabs hidden w-full gap-0 sm:grid sm:grid-cols-4 @min-[64rem]:grid-cols-8">
                    <TabsTrigger value="battle" className="min-h-11 min-w-0 gap-1 rounded-none border-b-2 border-transparent px-2 text-sm whitespace-normal break-keep data-[state=active]:border-primary data-[state=active]:bg-primary/[0.05]"><Swords className="h-4 w-4 shrink-0" /><span className="min-w-0 text-center leading-snug">{t('styleLab.tabs.arena')}</span></TabsTrigger>
                    <TabsTrigger value="market" className="min-h-11 min-w-0 gap-1 rounded-none border-b-2 border-transparent px-2 text-sm whitespace-normal break-keep data-[state=active]:border-primary data-[state=active]:bg-primary/[0.05]"><Store className="h-4 w-4 shrink-0" /><span className="min-w-0 text-center leading-snug">{t('styleLab.tabs.market')}</span></TabsTrigger>
                    <TabsTrigger value="collection" className="min-h-11 min-w-0 gap-1 rounded-none border-b-2 border-transparent px-2 text-sm whitespace-normal break-keep data-[state=active]:border-primary data-[state=active]:bg-primary/[0.05]"><FolderHeart className="h-4 w-4 shrink-0" /><span className="min-w-0 text-center leading-snug">{t('styleLab.tabs.collection')}</span></TabsTrigger>
                    <TabsTrigger value="manage" className="min-h-11 min-w-0 gap-1 rounded-none border-b-2 border-transparent px-2 text-sm whitespace-normal break-keep data-[state=active]:border-primary data-[state=active]:bg-primary/[0.05]"><ListPlus className="h-4 w-4 shrink-0" /><span className="min-w-0 text-center leading-snug">{t('styleLab.tabs.manage')}</span></TabsTrigger>
                    <TabsTrigger value="evolve" className="min-h-11 min-w-0 gap-1 rounded-none border-b-2 border-transparent px-2 text-sm whitespace-normal break-keep data-[state=active]:border-primary data-[state=active]:bg-primary/[0.05]"><Dna className="h-4 w-4 shrink-0" /><span className="min-w-0 text-center leading-snug">{t('styleLab.tabs.evolve')}</span></TabsTrigger>
                    <TabsTrigger value="analyze" className="min-h-11 min-w-0 gap-1 rounded-none border-b-2 border-transparent px-2 text-sm whitespace-normal break-keep data-[state=active]:border-primary data-[state=active]:bg-primary/[0.05]"><FileImage className="h-4 w-4 shrink-0" /><span className="min-w-0 text-center leading-snug">{t('styleLab.tabs.analyze')}</span></TabsTrigger>
                    <TabsTrigger value="stats" className="min-h-11 min-w-0 gap-1 rounded-none border-b-2 border-transparent px-2 text-sm whitespace-normal break-keep data-[state=active]:border-primary data-[state=active]:bg-primary/[0.05]"><BarChart3 className="h-4 w-4 shrink-0" /><span className="min-w-0 text-center leading-snug">{t('styleLab.tabs.stats')}</span></TabsTrigger>
                    <TabsTrigger value="settings" className="min-h-11 min-w-0 gap-1 rounded-none border-b-2 border-transparent px-2 text-sm whitespace-normal break-keep data-[state=active]:border-primary data-[state=active]:bg-primary/[0.05]"><Sparkles className="h-4 w-4 shrink-0" /><span className="min-w-0 text-center leading-snug">{t('styleLab.tabs.template')}</span></TabsTrigger>
                </TabsList>

                <TabsContent value="battle" className="min-w-0 space-y-4">
                    {combinations.length >= 2 && (
                    <Card className="min-w-0">
                        <CardContent className="flex min-w-0 flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between">
                            <div className="min-w-0 space-y-1">
                                <h3 className="font-semibold">{t('styleLab.arena.title')}</h3>
                                <p className="text-sm text-muted-foreground">{t('styleLab.arena.description', { count: battlePoolCount })}</p>
                            </div>
                            <div className="flex min-w-0 flex-wrap gap-2">
                                {(['all', 'favorites'] as StyleLabLeague[]).map(league => (
                                    <Button
                                        key={league}
                                        variant={settings.battleLeague === league ? 'secondary' : 'ghost'}
                                        className="min-w-[120px] rounded-xl whitespace-normal"
                                        onClick={() => setBattleLeague(league)}
                                    >
                                        {league === 'all' ? t('styleLab.arena.allLeague') : t('styleLab.arena.favoritesLeague')}
                                    </Button>
                                ))}
                                <Button variant={battlePoolCount < 2 ? "secondary" : "default"} className="min-w-[140px] whitespace-normal" onClick={handlePickBattle} disabled={isArenaUpdating || battlePoolCount < 2}>
                                    <Dice5 className="mr-1.5 h-4 w-4" />{t('styleLab.arena.pickBattle')}
                                </Button>
                                {battlePair && (
                                    <Button
                                        variant="outline"
                                        className="min-w-[140px] rounded-xl whitespace-normal"
                                        onClick={() => queueStyleLabPreviews(
                                            [battlePair.left.id, battlePair.right.id],
                                            activeEvaluationContext === null
                                                ? {}
                                                : { evaluationContext: activeEvaluationContext },
                                        )}
                                        disabled={isPreviewQueueRunning || isArenaUpdating}
                                    >
                                        <ImagePlus className="mr-1.5 h-4 w-4" />{t('styleLab.arena.previewPair')}
                                    </Button>
                                )}
                            </div>
                        </CardContent>
                    </Card>
                    )}

                    {battlePair && (
                        <div className="flex flex-wrap items-center justify-center gap-2">
                            {!battlePairVerified && (
                                <Badge variant="secondary">{t('styleLab.arena.renderRequired')}</Badge>
                            )}
                            <Button
                                variant="outline"
                                className="min-w-[140px] rounded-xl"
                                onClick={() => handleArenaDecision('tie')}
                                disabled={isArenaUpdating || !battlePairVerified}
                            >
                                <Equal className="mr-1.5 h-4 w-4" />{t('styleLab.arena.tie')}
                            </Button>
                            <Button
                                variant="ghost"
                                className="min-w-[140px] rounded-xl"
                                onClick={() => handleArenaDecision('skip')}
                                disabled={isArenaUpdating}
                            >
                                <SkipForward className="mr-1.5 h-4 w-4" />{t('styleLab.arena.skip')}
                            </Button>
                        </div>
                    )}

                    {battlePair ? (
                        <div className="grid min-w-0 gap-4 xl:grid-cols-2">
                            <CombinationCard
                                combo={battlePair.left}
                                chooseLabel={t('styleLab.arena.chooseLeft')}
                                chooseDisabled={isArenaUpdating || !battlePairVerified}
                                promptText={buildCombinationPrompt(battlePair.left)}
                                onChoose={() => handleBattleChoice(battlePair.left.id, battlePair.right.id)}
                                onGenerate={() => queueStyleLabPreviews(
                                    [battlePair.left.id],
                                    activeEvaluationContext === null
                                        ? {}
                                        : { evaluationContext: activeEvaluationContext },
                                )}
                                onApplyToPrompt={() => applyCombinationToPrompt(battlePair.left)}
                                onRemove={() => removeCombination(battlePair.left.id)}
                                onToggleFavorite={() => toggleFavorite(battlePair.left.id)}
                                onToggleLock={() => toggleLock(battlePair.left.id)}
                                onUpdateNote={(note) => updateNote(battlePair.left.id, note)}
                            />
                            <CombinationCard
                                combo={battlePair.right}
                                chooseLabel={t('styleLab.arena.chooseRight')}
                                chooseDisabled={isArenaUpdating || !battlePairVerified}
                                promptText={buildCombinationPrompt(battlePair.right)}
                                onChoose={() => handleBattleChoice(battlePair.right.id, battlePair.left.id)}
                                onGenerate={() => queueStyleLabPreviews(
                                    [battlePair.right.id],
                                    activeEvaluationContext === null
                                        ? {}
                                        : { evaluationContext: activeEvaluationContext },
                                )}
                                onApplyToPrompt={() => applyCombinationToPrompt(battlePair.right)}
                                onRemove={() => removeCombination(battlePair.right.id)}
                                onToggleFavorite={() => toggleFavorite(battlePair.right.id)}
                                onToggleLock={() => toggleLock(battlePair.right.id)}
                                onUpdateNote={(note) => updateNote(battlePair.right.id, note)}
                            />
                        </div>
                    ) : (
                        <Card className="border-dashed">
                            <CardContent className="flex flex-col items-center justify-center gap-3 p-12 text-center text-muted-foreground">
                                <Swords className="h-10 w-10" />
                                <div>
                                    <p className="font-medium text-foreground">{t('styleLab.arena.emptyTitle')}</p>
                                    <p className="text-sm">{t('styleLab.arena.emptyDesc')}</p>
                                    {battlePoolCount < 2 && <Button className="mt-4 min-h-11" onClick={() => setActiveTab('manage')}>
                                        {t('workspace.prepareStyles', '작가 조합 준비하기')}
                                    </Button>}
                                </div>
                            </CardContent>
                        </Card>
                    )}
                </TabsContent>

                <TabsContent value="market" className="min-w-0 space-y-4">
                    {renderBoardControls()}
                    <Card className="min-w-0">
                        <CardContent className="flex min-w-0 flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between">
                            <div className="min-w-0 space-y-1">
                                <h3 className="font-semibold">{t('styleLab.market.title')}</h3>
                                <p className="text-sm text-muted-foreground">
                                    {t('styleLab.market.description', { count: marketShelf.length })}
                                </p>
                            </div>
                            <Button
                                variant="outline"
                                className="rounded-xl"
                                onClick={() => void refreshMarketplace()}
                                disabled={!activeBoard || isMarketplaceUpdating || combinations.length === 0}
                            >
                                <RefreshCw className={cn('mr-1.5 h-4 w-4', isMarketplaceUpdating && 'animate-spin')} />
                                {t('styleLab.market.refresh')}
                            </Button>
                        </CardContent>
                    </Card>
                    {!boardsReady || (isMarketplaceUpdating && marketShelf.length === 0) ? (
                        <Card className="border-dashed">
                            <CardContent className="flex items-center justify-center gap-2 p-12 text-muted-foreground">
                                <RefreshCw className="h-5 w-5 animate-spin" />{t('styleLab.market.loading')}
                            </CardContent>
                        </Card>
                    ) : marketShelf.length > 0 ? (
                        <MarketplaceGrid
                            items={marketShelf}
                            combinations={combinations}
                            projections={preferenceProjections}
                            likedIds={marketLikedIds}
                            collectedIds={marketCollectedIds}
                            hiddenIds={marketHiddenIds}
                            comparisonTrayIds={comparisonTrayIds}
                            disabled={isMarketplaceUpdating}
                            onLike={comboId => void handleMarketAction('like', comboId)}
                            onCollect={comboId => void handleMarketAction('collect', comboId)}
                            onHide={comboId => void handleMarketAction('hide', comboId)}
                            onApply={comboId => void handleMarketAction('apply', comboId)}
                            onCompare={toggleComparisonCandidate}
                            onPreview={comboId => queueStyleLabPreviews([comboId])}
                        />
                    ) : (
                        <Card className="border-dashed">
                            <CardContent className="p-12 text-center text-muted-foreground">
                                {t('styleLab.market.empty')}
                            </CardContent>
                        </Card>
                    )}
                    <ComparisonTray
                        comboIds={comparisonTrayIds}
                        combinations={combinations}
                        disabled={isArenaUpdating || isMarketplaceUpdating}
                        onRemove={toggleComparisonCandidate}
                        onClear={clearComparisonTray}
                        onCompare={() => void handleCompareTray()}
                    />
                </TabsContent>

                <TabsContent value="collection" className="min-w-0 space-y-4">
                    {renderBoardControls()}
                    <Card className="min-w-0">
                        <CardHeader>
                            <CardTitle className="text-lg">{t('styleLab.collection.title')}</CardTitle>
                            <CardDescription>
                                {t('styleLab.collection.description', { count: collectionItems.length })}
                            </CardDescription>
                        </CardHeader>
                    </Card>
                    {collectionItems.length > 0 ? (
                        <MarketplaceGrid
                            items={collectionItems}
                            combinations={combinations}
                            projections={preferenceProjections}
                            likedIds={marketLikedIds}
                            collectedIds={marketCollectedIds}
                            hiddenIds={marketHiddenIds}
                            comparisonTrayIds={comparisonTrayIds}
                            disabled={isMarketplaceUpdating}
                            onLike={comboId => void handleMarketAction('like', comboId)}
                            onCollect={comboId => void handleMarketAction('collect', comboId)}
                            onHide={comboId => void handleMarketAction('hide', comboId)}
                            onApply={comboId => void handleMarketAction('apply', comboId)}
                            onCompare={toggleComparisonCandidate}
                            onPreview={comboId => queueStyleLabPreviews([comboId])}
                        />
                    ) : (
                        <Card className="border-dashed">
                            <CardContent className="p-10 text-center text-muted-foreground">
                                {t('styleLab.collection.empty')}
                            </CardContent>
                        </Card>
                    )}
                    {hiddenItems.length > 0 && (
                        <div className="space-y-3">
                            <div>
                                <h3 className="font-semibold">{t('styleLab.collection.hiddenTitle')}</h3>
                                <p className="text-sm text-muted-foreground">{t('styleLab.collection.hiddenDescription')}</p>
                            </div>
                            <MarketplaceGrid
                                items={hiddenItems}
                                combinations={combinations}
                                projections={preferenceProjections}
                                likedIds={marketLikedIds}
                                collectedIds={marketCollectedIds}
                                hiddenIds={marketHiddenIds}
                                comparisonTrayIds={comparisonTrayIds}
                                disabled={isMarketplaceUpdating}
                                onLike={comboId => void handleMarketAction('like', comboId)}
                                onCollect={comboId => void handleMarketAction('collect', comboId)}
                                onHide={comboId => void handleMarketAction('hide', comboId)}
                                onApply={comboId => void handleMarketAction('apply', comboId)}
                                onCompare={toggleComparisonCandidate}
                                onPreview={comboId => queueStyleLabPreviews([comboId])}
                            />
                        </div>
                    )}
                    <ComparisonTray
                        comboIds={comparisonTrayIds}
                        combinations={combinations}
                        disabled={isArenaUpdating || isMarketplaceUpdating}
                        onRemove={toggleComparisonCandidate}
                        onClear={clearComparisonTray}
                        onCompare={() => void handleCompareTray()}
                    />
                </TabsContent>

                <TabsContent value="manage" className="grid min-w-0 gap-4 xl:grid-cols-[minmax(300px,360px)_minmax(0,1fr)]">
                    <div className="min-w-0 space-y-4">
                        <Card className="min-w-0">
                            <CardHeader>
                                <CardTitle className="text-lg">{t('styleLab.manage.artistListTitle')}</CardTitle>
                                <CardDescription>{t('styleLab.manage.artistListDesc')}</CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-3">
                                <Textarea
                                    value={artistInput}
                                    onChange={(event) => setArtistInput(event.target.value)}
                                    placeholder="shnva&#10;necomi&#10;momoko (momopoco)"
                                    className="min-h-36 text-sm leading-5"
                                    data-allow-context-menu
                                />
                                <div className="grid grid-cols-1 gap-2 min-[420px]:flex min-[420px]:flex-wrap">
                                    <Button className="rounded-xl whitespace-normal" onClick={handleAddArtists}><ListPlus className="mr-1.5 h-4 w-4 shrink-0" />{t('styleLab.actions.add')}</Button>
                                    <Button variant="outline" className="rounded-xl whitespace-normal" onClick={resetArtistsToDefault}><RotateCcw className="mr-1.5 h-4 w-4 shrink-0" />{t('styleLab.actions.defaultList')}</Button>
                                    <Button variant="outline" className="rounded-xl text-destructive whitespace-normal hover:text-destructive" onClick={resetLabData}><Trash2 className="mr-1.5 h-4 w-4 shrink-0" />{t('styleLab.actions.resetAll')}</Button>
                                </div>
                                <div className="max-h-64 overflow-y-auto rounded-xl border bg-muted/20 p-2">
                                    <div className="mb-2 text-xs text-muted-foreground">{t('styleLab.manage.registeredArtists', { count: artists.length })}</div>
                                    <div className="flex flex-wrap gap-1.5">
                                        {artists.map(artist => (
                                            <Badge key={artist} variant="secondary" className="gap-1 pr-1">
                                                {artist}
                                                <button className="rounded-full p-0.5 hover:bg-background/70" onClick={() => removeArtist(artist)}>
                                                    ×
                                                </button>
                                            </Badge>
                                        ))}
                                    </div>
                                </div>
                            </CardContent>
                        </Card>

                        <Card className="min-w-0">
                            <CardHeader>
                                <CardTitle className="text-lg">{t('styleLab.manage.randomTitle')}</CardTitle>
                                <CardDescription>{t('styleLab.manage.randomDesc', {
                                    min: settings.minTags,
                                    max: settings.maxTags,
                                    minWeight: settings.minWeight.toFixed(1),
                                    maxWeight: settings.maxWeight.toFixed(1),
                                })}</CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-3">
                                <div className="space-y-2">
                                    <Label>{t('styleLab.manage.randomCount')}</Label>
                                    <Input type="number" min={1} max={100} value={randomCount} onChange={(event) => setRandomCount(Number(event.target.value))} />
                                </div>
                                <Button className="w-full rounded-xl" onClick={handleGenerateRandom}>
                                    <Dice5 className="mr-1.5 h-4 w-4" />{t('styleLab.manage.generateRandom')}
                                </Button>
                            </CardContent>
                        </Card>
                    </div>

                    <Card className="min-w-0">
                        <CardHeader className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                            <div className="min-w-0">
                                <CardTitle className="text-lg">{t('styleLab.manage.combinationsTitle')}</CardTitle>
                                <CardDescription>{t('styleLab.manage.combinationsDesc')}</CardDescription>
                            </div>
                            <div className="grid grid-cols-1 gap-2 min-[420px]:flex min-[420px]:flex-wrap">
                                <Button variant="outline" className="rounded-xl whitespace-normal" onClick={() => queueStyleLabPreviews(filteredCombinations.slice(0, 6).map(combo => combo.id))} disabled={isPreviewQueueRunning || filteredCombinations.length === 0}>
                                    <ImagePlus className="mr-1.5 h-4 w-4 shrink-0" />{t('styleLab.actions.previewTopSix')}
                                </Button>
                                <Button variant="outline" className="rounded-xl whitespace-normal" onClick={handleExport}>
                                    <Download className="mr-1.5 h-4 w-4 shrink-0" />{t('styleLab.actions.exportTxt')}
                                </Button>
                            </div>
                        </CardHeader>
                        <CardContent className="min-w-0 space-y-4">
                            <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                                <div className="min-w-0 space-y-2 lg:max-w-md lg:flex-1">
                                    <Label htmlFor="stylelab-combination-search">{t('styleLab.manage.searchLabel')}</Label>
                                    <div className="relative">
                                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                                        <Input
                                            id="stylelab-combination-search"
                                            value={combinationSearch}
                                            onChange={(event) => setCombinationSearch(event.target.value)}
                                            placeholder={t('styleLab.manage.searchPlaceholder')}
                                            className="min-w-0 pl-9"
                                        />
                                    </div>
                                </div>
                                <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
                                    <span className="min-w-0 break-words">{t('styleLab.manage.searchSummary', {
                                        shown: pagedCombinations.length,
                                        filtered: filteredCombinations.length,
                                        total: sortedCombinations.length,
                                    })}</span>
                                    {combinationSearch.trim() && (
                                        <Button type="button" variant="ghost" size="sm" className="rounded-xl" onClick={() => setCombinationSearch('')}>
                                            <X className="mr-1.5 h-4 w-4" />{t('styleLab.manage.clearSearch')}
                                        </Button>
                                    )}
                                </div>
                            </div>

                            {sortedCombinations.length > 0 ? (
                                filteredCombinations.length > 0 ? (
                                    <>
                                        <div className="grid min-w-0 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
                                            {pagedCombinations.map((combo, index) => renderCombinationCard(combo, combinationPageStart + index + 1, true, true))}
                                        </div>
                                        {combinationPageCount > 1 && (
                                            <div className="flex flex-col gap-3 border-t pt-4 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                                                <span>{t('styleLab.manage.pageSummary', {
                                                    page: visibleCombinationPage,
                                                    pages: combinationPageCount,
                                                    perPage: COMBINATIONS_PER_PAGE,
                                                })}</span>
                                                <div className="flex gap-2">
                                                    <Button
                                                        type="button"
                                                        variant="outline"
                                                        size="sm"
                                                        className="rounded-xl"
                                                        disabled={visibleCombinationPage <= 1}
                                                        onClick={() => setCombinationPage(page => Math.max(1, page - 1))}
                                                    >
                                                        <ChevronLeft className="mr-1.5 h-4 w-4" />{t('styleLab.manage.prevPage')}
                                                    </Button>
                                                    <Button
                                                        type="button"
                                                        variant="outline"
                                                        size="sm"
                                                        className="rounded-xl"
                                                        disabled={visibleCombinationPage >= combinationPageCount}
                                                        onClick={() => setCombinationPage(page => Math.min(combinationPageCount, page + 1))}
                                                    >
                                                        {t('styleLab.manage.nextPage')}<ChevronRight className="ml-1.5 h-4 w-4" />
                                                    </Button>
                                                </div>
                                            </div>
                                        )}
                                    </>
                                ) : (
                                    <div className="rounded-xl border border-dashed p-10 text-center text-muted-foreground">{t('styleLab.manage.noMatchingCombinations')}</div>
                                )
                            ) : (
                                <div className="rounded-xl border border-dashed p-10 text-center text-muted-foreground">{t('styleLab.empty.noCombinations')}</div>
                            )}
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="evolve" className="min-w-0 space-y-4">
                    <Card className="min-w-0">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2 text-lg"><Dna className="h-5 w-5" />{t('styleLab.evolve.title')}</CardTitle>
                            <CardDescription>{t('styleLab.evolve.description')}</CardDescription>
                        </CardHeader>
                        <CardContent className="grid min-w-0 gap-4 lg:grid-cols-4">
                            <div className="space-y-2">
                                <Label>{t('styleLab.evolve.parentCount')}</Label>
                                <Input type="number" min={2} max={50} value={settings.evolutionParentCount} onChange={(event) => updateSettings({ evolutionParentCount: Number(event.target.value) })} />
                            </div>
                            <div className="space-y-2">
                                <Label>{t('styleLab.evolve.childCount')}</Label>
                                <Input type="number" min={1} max={100} value={settings.evolutionChildrenCount} onChange={(event) => updateSettings({ evolutionChildrenCount: Number(event.target.value) })} />
                            </div>
                            <div className="space-y-2">
                                <Label>{t('styleLab.evolve.mutationRate')}</Label>
                                <Input type="number" min={0} max={1} step={0.01} value={settings.mutationRate} onChange={(event) => updateSettings({ mutationRate: Number(event.target.value) })} />
                            </div>
                            <div className="flex min-w-0 items-end gap-2">
                                <Button className="min-w-0 flex-1 rounded-xl whitespace-normal" onClick={() => void handleEvolve()} disabled={isEvolving || !activeBoard}><Dna className="mr-1.5 h-4 w-4 shrink-0" />{t('styleLab.evolve.run')}</Button>
                                <Button variant="outline" className="rounded-xl" onClick={() => queueStyleLabPreviews(latestGenerationIds)} disabled={latestGenerationIds.length === 0 || isPreviewQueueRunning}>
                                    <ImagePlus className="h-4 w-4" />
                                </Button>
                            </div>
                        </CardContent>
                    </Card>

                    {evolutionArchive.length > 0 && (
                        <Card className="min-w-0">
                            <CardHeader>
                                <CardTitle className="text-lg">{t('styleLab.evolve.archiveTitle')}</CardTitle>
                                <CardDescription>{t('styleLab.evolve.archiveDescription', { count: evolutionArchive.length })}</CardDescription>
                            </CardHeader>
                            <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                                {evolutionArchive.map(cell => (
                                    <div key={cell.id} className="space-y-2 rounded-xl border bg-muted/20 p-3 text-xs">
                                        <div className="flex items-center justify-between gap-2">
                                            <span className="font-semibold">{t(`styleLab.evolve.axes.${cell.axes.tagCount}`)}</span>
                                            <Badge variant="outline">{t(`styleLab.evolve.axes.${cell.axes.weightShape}`)}</Badge>
                                        </div>
                                        <div className="grid gap-1 text-muted-foreground">
                                            <span>{t('styleLab.evolve.elite')}: {cell.elite?.comboId.slice(-10) ?? '—'}</span>
                                            <span>{t('styleLab.evolve.challenger')}: {cell.challenger?.comboId.slice(-10) ?? '—'}</span>
                                            <span>{t('styleLab.evolve.novel')}: {cell.novel?.comboId.slice(-10) ?? '—'}</span>
                                        </div>
                                    </div>
                                ))}
                            </CardContent>
                        </Card>
                    )}

                    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
                        <Card className="min-w-0">
                            <CardHeader>
                                <CardTitle className="text-lg">{t('styleLab.evolve.latestGeneration', { generation: latestGeneration })}</CardTitle>
                                <CardDescription>{t('styleLab.common.combinationCount', { count: latestGenerationIds.length })}</CardDescription>
                            </CardHeader>
                            <CardContent>
                                <div className="grid min-w-0 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
                                    {sortedCombinations.filter(combo => combo.generation === latestGeneration).map((combo, index) => renderCombinationCard(combo, index + 1, true, true))}
                                </div>
                            </CardContent>
                        </Card>
                        <Card className="min-w-0">
                            <CardHeader>
                                <CardTitle className="text-lg">{t('styleLab.evolve.history')}</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-3">
                                {evolutionLogs.length > 0 ? evolutionLogs.slice(0, 10).map(log => (
                                    <div key={log.id} className="rounded-xl border bg-muted/20 p-3 text-sm">
                                        <div className="font-semibold">{t('styleLab.common.generationShort')} {log.generation}</div>
                                        <div className="text-muted-foreground">{log.note || t('styleLab.evolve.historyNote', {
                                            parents: log.parentCount ?? log.parentIds.length,
                                            children: log.childCount ?? log.childIds.length,
                                        })}</div>
                                        <div className="mt-1 text-xs text-muted-foreground">{new Date(log.timestamp).toLocaleString()}</div>
                                    </div>
                                )) : <p className="text-sm text-muted-foreground">{t('styleLab.evolve.noHistory')}</p>}
                            </CardContent>
                        </Card>
                    </div>
                </TabsContent>

                <TabsContent value="analyze" className="min-w-0 space-y-4">
                    <Card className="min-w-0">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2 text-lg"><FileImage className="h-5 w-5" />{t('styleLab.analyze.title')}</CardTitle>
                            <CardDescription>{t('styleLab.analyze.description')}</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="grid grid-cols-1 gap-2 min-[420px]:flex min-[420px]:flex-wrap min-[420px]:items-center">
                                <Label className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border px-4 py-2 text-center hover:bg-muted/50">
                                    <Upload className="h-4 w-4" />{t('styleLab.analyze.selectImages')}
                                    <input type="file" accept="image/png,image/webp" multiple className="hidden" onChange={handleAnalyzePng} disabled={isAnalyzing} />
                                </Label>
                                <Button variant="outline" className="rounded-xl whitespace-normal" onClick={handleAddAnalysisArtists} disabled={analysisRows.length === 0}>{t('styleLab.analyze.addToArtists')}</Button>
                                <Button variant="outline" className="rounded-xl whitespace-normal" onClick={handleAddAnalysisCombination} disabled={importDrafts.length === 0}>{t('styleLab.analyze.addAsCombinations')}</Button>
                            </div>

                            {importDrafts.length > 0 && (
                                <div className="space-y-3 rounded-xl border p-4">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div>
                                            <h3 className="font-semibold">{t('styleLab.analyze.importReview')}</h3>
                                            <p className="text-xs text-muted-foreground">{t('styleLab.analyze.importReviewDescription')}</p>
                                        </div>
                                        <Button className="rounded-xl" onClick={() => void handleCommitImports()} disabled={isAnalyzing}>
                                            <FolderHeart className="mr-1.5 h-4 w-4" />{t('styleLab.analyze.preserveOriginals')}
                                        </Button>
                                    </div>
                                    <div className="grid gap-3 lg:grid-cols-2">
                                        {importDrafts.map(draft => (
                                            <div key={draft.id} className="min-w-0 space-y-2 rounded-lg bg-muted/30 p-3">
                                                <div className="flex min-w-0 items-center justify-between gap-2">
                                                    <span className="truncate text-sm font-medium">{draft.fileName}</span>
                                                    {draft.duplicateAssetIds.length > 0 && <Badge variant="secondary">{t('styleLab.analyze.duplicate')}</Badge>}
                                                </div>
                                                <div className="flex flex-wrap gap-1.5">
                                                    {draft.tags.length > 0 ? draft.tags.map(tag => {
                                                        const key = `${tag.kind}:${tag.tag.toLowerCase()}`
                                                        const checked = draft.includedTagKeys.includes(key)
                                                        return (
                                                            <label key={key} className={"choice-row " + (cn(
                                                                'w-full',
                                                                checked ? 'bg-primary/10 text-foreground' : 'text-foreground',
                                                            ))}>
                                                                <input
                                                                    type="checkbox"
                                                                    className="choice-checkbox h-3 w-3"
                                                                    checked={checked}
                                                                    onChange={() => toggleImportTag(draft.id, key)}
                                                                />
                                                                {tag.tag} · {tag.weight.toFixed(1)}
                                                            </label>
                                                        )
                                                    }) : <span className="text-xs text-muted-foreground">{t('styleLab.analyze.noTagsForImage')}</span>}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {analysisRows.length > 0 ? (
                                <div className="overflow-x-auto rounded-xl border">
                                    <table className="min-w-[640px] text-sm">
                                        <thead className="bg-muted/50 text-left">
                                            <tr>
                                                <th className="p-3">{t('styleLab.analyze.artist')}</th>
                                                <th className="p-3">{t('styleLab.analyze.frequency')}</th>
                                                <th className="p-3">{t('styleLab.analyze.avgWeight')}</th>
                                                <th className="p-3">{t('styleLab.analyze.maxWeight')}</th>
                                                <th className="p-3">{t('styleLab.analyze.source')}</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {analysisRows.map(row => (
                                                <tr key={row.artist} className="border-t">
                                                    <td className="p-3 font-medium">{row.artist}</td>
                                                    <td className="p-3">{row.count}</td>
                                                    <td className="p-3">{row.avgWeight.toFixed(1)}</td>
                                                    <td className="p-3">{row.maxWeight.toFixed(1)}</td>
                                                    <td className="p-3 text-xs text-muted-foreground">{row.sources.slice(0, 2).join(', ')}{row.sources.length > 2 ? t('styleLab.analyze.moreSources', { count: row.sources.length - 2 }) : ''}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            ) : (
                                <div className="rounded-xl border border-dashed p-10 text-center text-muted-foreground">{t('styleLab.analyze.empty')}</div>
                            )}
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="stats" className="min-w-0 space-y-4">
                    <div className="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-4">
                        <Card><CardContent className="p-4"><div className="text-sm text-muted-foreground">{t('styleLab.stats.totalCombinations')}</div><div className="text-2xl font-bold">{combinations.length}</div></CardContent></Card>
                        <Card><CardContent className="p-4"><div className="text-sm text-muted-foreground">{t('styleLab.metrics.evaluatedRatio')}</div><div className="text-2xl font-bold">{projectionsReady ? `${stats.evaluatedRatio}%` : '—'}</div></CardContent></Card>
                        <Card><CardContent className="p-4"><div className="text-sm text-muted-foreground">{t('styleLab.metrics.averageUncertainty')}</div><div className="text-2xl font-bold">{projectionsReady ? stats.averageUncertainty.toFixed(2) : '—'}</div></CardContent></Card>
                        <Card><CardContent className="p-4"><div className="text-sm text-muted-foreground">{t('styleLab.stats.needsComparison')}</div><div className="text-2xl font-bold">{projectionsReady ? stats.needsComparison : '—'}</div></CardContent></Card>
                    </div>

                    <div className="grid min-w-0 gap-4 xl:grid-cols-2">
                        <Card className="min-w-0">
                            <CardHeader><CardTitle className="text-lg">{t('styleLab.stats.artistUsage')}</CardTitle></CardHeader>
                            <CardContent className="space-y-2">
                                {stats.artists.map(row => (
                                    <div key={row.artist} className="flex min-w-0 flex-col gap-1 rounded-lg bg-muted/30 px-3 py-2 text-sm min-[420px]:flex-row min-[420px]:items-center min-[420px]:justify-between">
                                        <span className="min-w-0 break-words">{row.artist}</span>
                                        <span className="text-muted-foreground">{t('styleLab.stats.artistUsageStat', { count: row.count, average: (row.weightSum / row.count).toFixed(1) })}</span>
                                    </div>
                                ))}
                            </CardContent>
                        </Card>
                        <Card className="min-w-0">
                            <CardHeader><CardTitle className="text-lg">{t('styleLab.stats.generationDistribution')}</CardTitle></CardHeader>
                            <CardContent className="space-y-2">
                                {stats.generations.map(([generation, count]) => (
                                    <div key={generation} className="flex items-center gap-3 text-sm">
                                        <span className="w-16">{t('styleLab.common.generationShort')} {generation}</span>
                                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                                            <div className="h-full bg-primary" style={{ width: `${combinations.length ? (count / combinations.length) * 100 : 0}%` }} />
                                        </div>
                                        <span className="w-10 text-right text-muted-foreground">{count}</span>
                                    </div>
                                ))}
                            </CardContent>
                        </Card>
                    </div>

                    <Card className="min-w-0">
                        <CardHeader>
                            <CardTitle className="text-lg">{t('styleLab.cleanup.title')}</CardTitle>
                            <CardDescription>{t('styleLab.cleanup.description')}</CardDescription>
                        </CardHeader>
                        <CardContent className="grid min-w-0 gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
                            <div className="space-y-2">
                                <Label>{t('styleLab.cleanup.minBattles')}</Label>
                                <Input type="number" min={0} value={cleanupMinBattles} onChange={(event) => setCleanupMinBattles(Number(event.target.value))} />
                            </div>
                            <div className="space-y-2">
                                <Label>{t('styleLab.cleanup.eloBelow')}</Label>
                                <Input type="number" value={cleanupEloBelow} onChange={(event) => setCleanupEloBelow(Number(event.target.value))} />
                            </div>
                            <Button variant="outline" className="rounded-xl text-destructive whitespace-normal hover:text-destructive" onClick={handleCleanup}><Trash2 className="mr-1.5 h-4 w-4 shrink-0" />{t('styleLab.cleanup.run')}</Button>
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="settings" className="min-w-0 space-y-4">
                    <Card className="min-w-0">
                        <CardHeader>
                            <CardTitle className="text-lg">{t('styleLab.settings.templateTitle')}</CardTitle>
                            <CardDescription>
                                {t('styleLab.settings.templateDesc')}
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <Textarea
                                value={settings.promptTemplate}
                                onChange={(event) => updateSettings({ promptTemplate: event.target.value })}
                                className="min-h-36 font-mono text-xs leading-5 sm:text-sm"
                                data-allow-context-menu
                            />
                            <div className="grid min-w-0 gap-2 text-sm md:grid-cols-2">
                                <div className="min-w-0 break-words rounded-xl bg-muted/30 p-3"><code>{'{{artist_tags}}'}</code> · {t('styleLab.settings.placeholderArtistTags')}</div>
                                <div className="min-w-0 break-words rounded-xl bg-muted/30 p-3"><code>{'{{basePrompt}}'}</code> · {t('styleLab.settings.placeholderBasePrompt')}</div>
                                <div className="min-w-0 break-words rounded-xl bg-muted/30 p-3"><code>{'{{additionalPrompt}}'}</code> · {t('styleLab.settings.placeholderAdditionalPrompt')}</div>
                                <div className="min-w-0 break-words rounded-xl bg-muted/30 p-3"><code>{'{{detailPrompt}}'}</code> · {t('styleLab.settings.placeholderDetailPrompt')}</div>
                            </div>
                            <div>
                                <Label>{t('styleLab.settings.renderPreview')}</Label>
                                <Textarea value={templatePreview} readOnly className="mt-2 min-h-32 font-mono text-xs leading-5" data-allow-context-menu />
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="min-w-0">
                        <CardHeader>
                            <CardTitle className="text-lg">{t('styleLab.settings.generationRangeTitle')}</CardTitle>
                        </CardHeader>
                        <CardContent className="grid min-w-0 gap-4 md:grid-cols-3 xl:grid-cols-5">
                            <div className="space-y-2"><Label>{t('styleLab.settings.minArtists')}</Label><Input type="number" min={1} value={settings.minTags} onChange={(event) => updateSettings({ minTags: Number(event.target.value) })} /></div>
                            <div className="space-y-2"><Label>{t('styleLab.settings.maxArtists')}</Label><Input type="number" min={1} value={settings.maxTags} onChange={(event) => updateSettings({ maxTags: Number(event.target.value) })} /></div>
                            <div className="space-y-2"><Label>{t('styleLab.settings.minWeight')}</Label><Input type="number" min={0.2} max={2} step={0.1} value={settings.minWeight} onChange={(event) => updateSettings({ minWeight: Number(event.target.value) })} /></div>
                            <div className="space-y-2"><Label>{t('styleLab.settings.maxWeight')}</Label><Input type="number" min={0.2} max={2} step={0.1} value={settings.maxWeight} onChange={(event) => updateSettings({ maxWeight: Number(event.target.value) })} /></div>
                            <div className="space-y-2"><Label>{t('styleLab.settings.previewDelay')}</Label><Input type="number" min={250} max={10000} value={settings.previewDelayMs} onChange={(event) => updateSettings({ previewDelayMs: Number(event.target.value) })} /></div>
                            <div className="flex min-w-0 flex-col gap-3 rounded-xl border bg-muted/20 p-3 min-[420px]:flex-row min-[420px]:items-center min-[420px]:justify-between md:col-span-3 xl:col-span-2">
                                <div className="min-w-0 space-y-1">
                                    <Label htmlFor="stylelab-auto-preview-battle">{t('styleLab.settings.autoPreviewBattle')}</Label>
                                    <p className="text-xs text-muted-foreground">{t('styleLab.settings.autoPreviewBattleDesc')}</p>
                                </div>
                                <Switch
                                    id="stylelab-auto-preview-battle"
                                    checked={settings.autoPreviewBattlePair}
                                    onChange={(event) => updateSettings({ autoPreviewBattlePair: event.target.checked })}
                                />
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>
            </Tabs>
        </div>
    )
}
