import { Edit3, RotateCcw, ScanSearch, ShieldAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ValidationState } from './ValidationState'
import type {
    CompositionConflictSummary,
    CompositionOverrideDiffItem,
    CompositionValidationSummary,
    ModuleStackItem,
    ReadonlyCompositionPlan,
} from './types'

export interface CompositionInspectorLabels {
    title: string
    noSelection: string
    recipe: string
    kind: string
    moduleId: string
    technical: string
    overrideDiff: string
    inherited: string
    override: string
    unchanged: string
    edit: string
    resetOverride: string
    resolvedPlan: string
}

const DEFAULT_LABELS: CompositionInspectorLabels = {
    title: 'Applied content',
    noSelection: 'Select a prompt group to see how it is applied.',
    recipe: 'Generation setup',
    kind: 'Type',
    moduleId: 'Internal ID',
    technical: 'Technical details',
    overrideDiff: 'Changed defaults',
    inherited: 'Default',
    override: 'Changed here',
    unchanged: 'Unchanged',
    edit: 'Edit prompt group',
    resetOverride: 'Reset changes',
    resolvedPlan: 'Open actual generation values',
}

export interface CompositionInspectorProps {
    title?: string
    module?: ModuleStackItem | null
    recipeName?: string
    validation: CompositionValidationSummary
    resolvedPlan?: ReadonlyCompositionPlan | null
    conflict?: CompositionConflictSummary | null
    overrideDiff?: readonly CompositionOverrideDiffItem[]
    disabled?: boolean
    labels?: Partial<CompositionInspectorLabels>
    className?: string
    showHeader?: boolean
    children?: ReactNode
    onEditModule?: (moduleId: string) => void
    onResetOverride?: () => void
    onOpenResolvedPlan?: () => void
}

function printable(value: ReactNode): ReactNode {
    if (value === undefined || value === null || value === '') return '—'
    if (typeof value === 'object' && !Array.isArray(value)) return String(value)
    return value
}

/**
 * Read-only context shell with callback-based actions. Pages inject typed forms
 * as children, keeping repository commands outside this presentation component.
 */
export function CompositionInspector({
    title,
    module,
    recipeName,
    validation,
    resolvedPlan,
    conflict,
    overrideDiff = [],
    disabled = false,
    labels: labelsOverride,
    className,
    showHeader = true,
    children,
    onEditModule,
    onResetOverride,
    onOpenResolvedPlan,
}: CompositionInspectorProps) {
    const labels = { ...DEFAULT_LABELS, ...labelsOverride }
    const changedOverrides = overrideDiff.filter(item => item.changed)

    return (
        <aside
            className={cn('flex min-h-0 min-w-0 flex-col overflow-hidden bg-card', className)}
            aria-labelledby={showHeader ? 'composition-inspector-title' : undefined}
            aria-label={showHeader ? undefined : title ?? labels.title}
            data-testid="composition-inspector"
        >
            {showHeader && <header className="flex min-h-11 min-w-0 items-center justify-between gap-2 bg-muted/20 px-3">
                <h2 id="composition-inspector-title" className="min-w-0 truncate text-sm font-semibold" title={title ?? labels.title}>
                    {title ?? labels.title}
                </h2>
                <ValidationState validation={validation} className="shrink-0" />
            </header>}

            <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
                {conflict && (
                    <section
                        className={cn(
                            'border-b border-border border-l-2 p-3',
                            conflict.severity === 'error' ? 'border-l-destructive bg-destructive/10' : 'border-l-warning bg-warning/10',
                        )}
                        role={conflict.severity === 'error' ? 'alert' : 'status'}
                        data-conflict-severity={conflict.severity}
                    >
                        <div className="flex min-w-0 items-start gap-2">
                            <ShieldAlert className={cn('mt-0.5 h-4 w-4 shrink-0', conflict.severity === 'error' ? 'text-destructive' : 'text-warning')} aria-hidden="true" />
                            <span className="min-w-0">
                                <strong className="block break-words text-sm">{conflict.title}</strong>
                                <span className="mt-1 block break-words text-xs text-muted-foreground">{conflict.message}</span>
                                {conflict.revision && (
                                    <details className="mt-2">
                                        <summary className="min-h-11 cursor-pointer py-2.5 text-xs text-muted-foreground">{labels.technical}</summary>
                                        <span className="mt-1 block break-all font-mono text-[11px]">{conflict.revision}</span>
                                    </details>
                                )}
                            </span>
                        </div>
                    </section>
                )}

                {!module && !children ? (
                    <p className="p-4 text-sm text-muted-foreground">{labels.noSelection}</p>
                ) : (
                    <>
                        {module && (
                            <section className="p-3">
                                <h3 className="break-words text-base font-semibold" title={module.name}>{module.name}</h3>
                                {module.summary && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">{module.summary}</p>}
                                <dl className="mt-3 grid grid-cols-[minmax(5rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                                    {recipeName && (
                                        <>
                                            <dt className="text-muted-foreground">{labels.recipe}</dt>
                                            <dd className="min-w-0 break-words">{recipeName}</dd>
                                        </>
                                    )}
                                </dl>
                                <details className="mt-3 border-t border-border pt-2">
                                    <summary className="min-h-11 cursor-pointer py-2.5 text-xs font-medium text-muted-foreground">{labels.technical}</summary>
                                    <dl className="mt-2 grid grid-cols-[minmax(5rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                                        <dt className="text-muted-foreground">{labels.kind}</dt>
                                        <dd className="min-w-0 break-words font-mono">{module.kind}</dd>
                                        <dt className="text-muted-foreground">{labels.moduleId}</dt>
                                        <dd className="min-w-0 break-all font-mono">{module.id}</dd>
                                    </dl>
                                </details>
                            </section>
                        )}

                        {children && <div className="min-w-0 p-3 pt-5">{children}</div>}

                        {overrideDiff.length > 0 && (
                            <section className="min-w-0 p-3 pt-5" aria-labelledby="composition-override-diff-title">
                                <div className="flex min-w-0 items-center justify-between gap-2">
                                    <h3 id="composition-override-diff-title" className="text-sm font-semibold">{labels.overrideDiff}</h3>
                                    <span className="font-mono text-xs text-muted-foreground">{changedOverrides.length}</span>
                                </div>
                                <div className="mt-2 divide-y divide-border border-y border-border">
                                    {overrideDiff.map(item => (
                                        <div key={item.id} className={cn('min-w-0 py-2 text-xs', !item.changed && 'text-muted-foreground')}>
                                            <div className="break-words font-medium">{item.label}</div>
                                            {item.changed ? (
                                                <dl className="mt-1 grid grid-cols-[minmax(4rem,auto)_minmax(0,1fr)] gap-x-2 gap-y-1">
                                                    <dt className="text-muted-foreground">{labels.inherited}</dt>
                                                    <dd className="min-w-0 whitespace-pre-wrap break-all font-mono">{printable(item.inheritedValue)}</dd>
                                                    <dt className="text-primary">{labels.override}</dt>
                                                    <dd className="min-w-0 whitespace-pre-wrap break-all font-mono text-primary">{printable(item.overrideValue)}</dd>
                                                </dl>
                                            ) : (
                                                <span className="mt-1 block">{labels.unchanged}</span>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </section>
                        )}

                        {resolvedPlan && (
                            <section className="min-w-0 p-3 pt-5">
                                <h3 className="text-sm font-semibold">{labels.resolvedPlan}</h3>
                                <p className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-xs">{resolvedPlan.positivePrompt || '—'}</p>
                            </section>
                        )}
                    </>
                )}
            </div>

            {(onEditModule && module || onResetOverride || onOpenResolvedPlan) && (
                <footer className="grid min-w-0 gap-2 bg-muted/20 p-2 sm:grid-cols-2">
                    {onEditModule && module && (
                        <Button type="button" variant="outline" disabled={disabled || module.missing} onClick={() => onEditModule(module.id)}>
                            <Edit3 className="mr-2 h-4 w-4" aria-hidden="true" />
                            <span className="truncate">{labels.edit}</span>
                        </Button>
                    )}
                    {onResetOverride && (
                        <Button type="button" variant="outline" disabled={disabled || changedOverrides.length === 0} onClick={onResetOverride}>
                            <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
                            <span className="truncate">{labels.resetOverride}</span>
                        </Button>
                    )}
                    {onOpenResolvedPlan && (
                        <Button type="button" variant="outline" disabled={disabled} onClick={onOpenResolvedPlan} className="sm:col-span-2">
                            <ScanSearch className="mr-2 h-4 w-4" aria-hidden="true" />
                            <span className="truncate">{labels.resolvedPlan}</span>
                        </Button>
                    )}
                </footer>
            )}
        </aside>
    )
}
