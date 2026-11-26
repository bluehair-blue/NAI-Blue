import {
    Eye,
    Layers3,
    Lock,
    PanelRight,
    Play,
    RefreshCw,
    Square,
    Unlock,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { ValidationState } from './ValidationState'
import type {
    CompositionGenerationControl,
    CompositionSeedControl,
    CompositionSelectControl,
    CompositionValidationSummary,
} from './types'

export interface CompositionCostSummary {
    value: string
    label?: string
    severity?: 'normal' | 'warning' | 'error'
}

export interface CompositionResolvedControl {
    available: boolean
    label?: string
    open?: boolean
    onOpen: () => void
}

export interface CompositionStorageControl {
    folder: string
    format: string
    r2Status: string
    label: string
    onOpen: () => void
}

export interface CompositionCommandBarLabels {
    commands: string
    mode: string
    recipe: string
    cost: string
    seed: string
    modules: string
    inspector: string
    resolved: string
    generate: string
    cancel: string
    lockSeed: string
    unlockSeed: string
}

const DEFAULT_LABELS: CompositionCommandBarLabels = {
    commands: 'Generation actions',
    mode: 'Generation mode',
    recipe: 'Generation setup',
    cost: 'Cost',
    seed: 'Seed',
    modules: 'Prompt groups',
    inspector: 'Applied content',
    resolved: 'Generation values',
    generate: 'Generate',
    cancel: 'Cancel',
    lockSeed: 'Lock seed',
    unlockSeed: 'Unlock seed',
}

export interface CompositionCommandBarProps {
    mode?: CompositionSelectControl
    recipe?: CompositionSelectControl
    validation?: CompositionValidationSummary
    cost?: CompositionCostSummary
    seed?: CompositionSeedControl
    resolved?: CompositionResolvedControl
    generation: CompositionGenerationControl
    labels?: Partial<CompositionCommandBarLabels>
    disabled?: boolean
    className?: string
    onOpenModules?: () => void
    onOpenInspector?: () => void
    summary?: string
    onOpenSummary?: () => void
    storage?: CompositionStorageControl
    count?: ReactNode
    /** Omit cost, count, and Generate when the docked Main rail owns them. */
    omitExecutionControls?: boolean
    /** Scene UX: keep internal composition authority out of the user-facing command strip. */
    simplified?: boolean
}

function CommandSelect({
    control,
    label,
    className,
}: {
    control: CompositionSelectControl
    label: string
    className?: string
}) {
    return (
        <label className={cn('grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2', className)}>
            <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">{control.label ?? label}</span>
            <Select
                value={control.value}
                onValueChange={control.onChange}
                disabled={control.disabled}
            >
                <SelectTrigger className="h-11 min-w-11 max-w-full rounded-control" aria-label={control.label ?? label}>
                    <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-w-[min(32rem,calc(100vw-2rem))]">
                    {control.options.map(option => (
                        <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                            <span className="block max-w-[min(28rem,calc(100vw-5rem))] truncate" title={option.label}>{option.label}</span>
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </label>
    )
}

/** Controlled workspace command strip; generation behavior stays in the owning page/store. */
export function CompositionCommandBar({
    mode,
    recipe,
    validation,
    cost,
    seed,
    resolved,
    generation,
    labels: labelsOverride,
    disabled = false,
    className,
    onOpenModules,
    onOpenInspector,
    summary,
    onOpenSummary,
    storage,
    count,
    omitExecutionControls = false,
    simplified = false,
}: CompositionCommandBarProps) {
    const labels = { ...DEFAULT_LABELS, ...labelsOverride }
    const actionDisabled = disabled || generation.disabled
    const moduleAction = onOpenModules ? (
        <Button
            type="button"
            variant="ghost"
            size="icon"
            className="shrink-0"
            disabled={disabled}
            aria-label={labels.modules}
            data-testid="composition-open-modules"
            onClick={onOpenModules}
        >
            <Layers3 className="h-4 w-4" aria-hidden="true" />
        </Button>
    ) : null
    const inspectorAction = onOpenInspector ? (
        <Button
            type="button"
            variant="ghost"
            size="icon"
            className="shrink-0"
            disabled={disabled}
            aria-label={labels.inspector}
            data-testid="composition-open-inspector"
            onClick={onOpenInspector}
        >
            <PanelRight className="h-4 w-4" aria-hidden="true" />
        </Button>
    ) : null
    const resolvedAction = resolved?.available ? (
        <Button
            type="button"
            variant={resolved.open ? 'secondary' : simplified ? 'ghost' : 'outline'}
            className={simplified ? 'min-w-11 shrink-0 px-2' : 'min-w-0 flex-1 px-3'}
            aria-pressed={resolved.open}
            disabled={disabled}
            onClick={resolved.onOpen}
        >
            <Eye className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" />
            <span className={cn('truncate', simplified && 'hidden xl:inline')}>{resolved.label ?? labels.resolved}</span>
        </Button>
    ) : null

    if (simplified) {
        return (
            <header
                className={cn(
                    'grid min-w-0 items-center gap-2 border-y border-border/60 bg-card/80 p-2',
                    omitExecutionControls
                        ? 'grid-cols-1'
                        : 'grid-cols-[minmax(0,1fr)_auto_auto_minmax(10rem,12rem)] xl:grid-cols-[minmax(0,1fr)_auto_auto_minmax(10rem,16rem)]',
                    className,
                )}
                aria-label={labels.commands}
                data-testid="composition-command-bar"
            >
                <div className="flex min-w-0 items-center gap-1">
                    {summary && (onOpenSummary ? (
                        <Button type="button" variant="ghost" className="min-w-0 flex-1 justify-start px-2" onClick={onOpenSummary} title={summary}>
                            <span className="truncate whitespace-nowrap text-sm text-muted-foreground" data-command-label>{summary}</span>
                        </Button>
                    ) : (
                        <span className="min-w-0 flex-1 truncate whitespace-nowrap px-2 text-sm text-muted-foreground" data-command-label title={summary}>{summary}</span>
                    ))}
                    {storage && (
                        <Button
                            type="button"
                            variant="ghost"
                            className="grid min-w-0 flex-1 grid-cols-[minmax(3rem,1fr)_auto] justify-start px-2 text-muted-foreground"
                            aria-label={`${storage.label}: ${storage.folder} · ${storage.format} · ${storage.r2Status}`}
                            title={`${storage.folder} · ${storage.format} · ${storage.r2Status}`}
                            onClick={storage.onOpen}
                            data-testid="composition-open-storage"
                        >
                            <span className="truncate whitespace-nowrap text-left text-sm">{storage.folder}</span>
                            <span className="shrink-0 whitespace-nowrap text-sm"> · {storage.format}<span className="hidden xl:inline"> · {storage.r2Status}</span></span>
                        </Button>
                    )}
                    {mode && (
                        <CommandSelect
                            control={{ ...mode, disabled: disabled || mode.disabled }}
                            label={labels.mode}
                            className="hidden min-w-48 flex-1 xl:grid xl:max-w-xs"
                        />
                    )}
                    {recipe && (
                        <CommandSelect
                            control={{ ...recipe, disabled: disabled || recipe.disabled }}
                            label={labels.recipe}
                            className="hidden min-w-56 flex-1 xl:grid xl:max-w-sm"
                        />
                    )}
                    {validation && <ValidationState validation={validation} />}
                    {seed && (
                        <label className="hidden min-w-48 items-center gap-2 xl:flex xl:max-w-72">
                            <span className="shrink-0 whitespace-nowrap text-xs font-medium text-muted-foreground" data-command-label>{seed.label ?? labels.seed}</span>
                            <Input value={seed.value} onChange={event => seed.onChange?.(event.currentTarget.value)} readOnly={!seed.onChange} disabled={disabled || seed.disabled} inputMode="numeric" className="h-10 min-w-0 font-mono" />
                            {seed.onToggleLock && (
                                <Button type="button" variant="ghost" size="icon" className="shrink-0" disabled={disabled || seed.disabled} aria-label={seed.locked ? labels.unlockSeed : labels.lockSeed} onClick={seed.onToggleLock}>
                                    {seed.locked ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
                                </Button>
                            )}
                        </label>
                    )}
                    {moduleAction}
                    {inspectorAction}
                    {resolvedAction}
                </div>
                {!omitExecutionControls && (
                    <>
                        <span
                            className={cn(
                                'min-w-16 whitespace-nowrap text-right font-mono text-xs tabular-nums',
                                cost?.severity === 'warning' && 'text-warning',
                                cost?.severity === 'error' && 'text-destructive',
                                (!cost?.severity || cost.severity === 'normal') && 'text-muted-foreground',
                            )}
                            aria-label={cost ? `${cost.label ?? labels.cost}: ${cost.value}` : undefined}
                            data-command-label
                        >
                            {cost?.value ?? ''}
                        </span>
                        <div className="shrink-0">{count}</div>
                        <Button
                            type="button"
                            variant={generation.generating ? 'destructive' : 'generate'}
                            className="min-w-0 whitespace-nowrap"
                            disabled={actionDisabled}
                            onClick={generation.generating ? generation.onCancel : generation.onGenerate}
                            data-testid={generation.generating ? generation.cancelTestId ?? generation.actionTestId : generation.actionTestId}
                        >
                            {generation.generating ? <Square className="mr-2 h-4 w-4 shrink-0" /> : <Play className="mr-2 h-4 w-4 shrink-0" />}
                            <span className="truncate whitespace-nowrap">{generation.progressLabel ?? (generation.generating ? generation.cancelLabel ?? labels.cancel : generation.generateLabel ?? labels.generate)}</span>
                            {!generation.generating && generation.shortcutLabel && (
                                <kbd className="ml-2 hidden shrink-0 py-0.5 font-mono text-[11px] font-medium xl:inline">
                                    {generation.shortcutLabel}
                                </kbd>
                            )}
                        </Button>
                    </>
                )}
            </header>
        )
    }

    return (
        <header
            className={cn(
                'grid min-w-0 gap-2 border-y border-border/60 bg-card/80 p-2',
                'md:grid-cols-2 xl:grid-cols-[minmax(10rem,0.7fr)_minmax(14rem,1.25fr)_auto_auto_minmax(9rem,0.6fr)_auto] xl:items-center',
                className,
            )}
            aria-label={labels.commands}
            data-testid="composition-command-bar"
        >
            {mode && <CommandSelect control={{ ...mode, disabled: disabled || mode.disabled }} label={labels.mode} />}
            {recipe && <CommandSelect control={{ ...recipe, disabled: disabled || recipe.disabled }} label={labels.recipe} />}

            {(validation || cost) && <div className="flex min-h-11 min-w-0 items-center justify-between gap-2 px-2">
                {validation && <ValidationState validation={validation} />}
                {cost && (
                    <span
                        className={cn(
                            'shrink-0 font-mono text-xs',
                            cost.severity === 'warning' && 'text-warning',
                            cost.severity === 'error' && 'text-destructive',
                            (!cost.severity || cost.severity === 'normal') && 'text-muted-foreground',
                        )}
                        aria-label={`${cost.label ?? labels.cost}: ${cost.value}`}
                    >
                        {cost.value}
                    </span>
                )}
            </div>}

            {(onOpenModules || onOpenInspector || resolved?.available) && <div className="flex min-h-11 min-w-0 items-center gap-1">
                {/* Main and Scene intentionally omit persistent desktop rails to protect canvas width.
                    Keep these controlled-sheet triggers available at every breakpoint so both panels remain reachable. */}
                {moduleAction}
                {inspectorAction}
                {resolvedAction}
            </div>}

            {seed ? (
                <div className="flex min-h-11 min-w-0 items-center gap-1">
                    <label className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
                        <span className="text-xs font-medium text-muted-foreground">{seed.label ?? labels.seed}</span>
                        <Input
                            value={seed.value}
                            onChange={event => seed.onChange?.(event.currentTarget.value)}
                            readOnly={!seed.onChange}
                            disabled={disabled || seed.disabled}
                            inputMode="numeric"
                            className="h-11 min-w-0 font-mono"
                        />
                    </label>
                    {seed.onToggleLock && (
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="shrink-0"
                            disabled={disabled || seed.disabled}
                            aria-label={seed.locked ? labels.unlockSeed : labels.lockSeed}
                            aria-pressed={seed.locked}
                            onClick={seed.onToggleLock}
                        >
                            {seed.locked
                                ? <Lock className="h-4 w-4" aria-hidden="true" />
                                : <Unlock className="h-4 w-4" aria-hidden="true" />}
                        </Button>
                    )}
                    {seed.onPreviewWildcard && (
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="shrink-0"
                            disabled={disabled || seed.disabled}
                            aria-label={seed.wildcardPreviewLabel ?? 'Preview wildcard'}
                            onClick={seed.onPreviewWildcard}
                        >
                            <RefreshCw className="h-4 w-4" aria-hidden="true" />
                        </Button>
                    )}
                </div>
            ) : (
                <span className="hidden xl:block" />
            )}

            <Button
                type="button"
                variant={generation.generating ? 'destructive' : 'generate'}
                className="min-w-0 md:col-span-2 xl:col-span-1"
                disabled={actionDisabled}
                onClick={generation.generating ? generation.onCancel : generation.onGenerate}
                data-testid={generation.generating
                    ? generation.cancelTestId ?? generation.actionTestId
                    : generation.actionTestId}
            >
                {generation.generating
                    ? <Square className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" />
                    : <Play className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" />}
                <span className="truncate">
                    {generation.progressLabel
                        ?? (generation.generating
                            ? generation.cancelLabel ?? labels.cancel
                            : generation.generateLabel ?? labels.generate)}
                </span>
            </Button>
        </header>
    )
}
