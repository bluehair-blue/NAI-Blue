import type { ReactNode } from 'react'
import type {
    CharacterPosition,
    CompositionEnginePlan,
    CompositionModuleKind,
    DeepReadonly,
    EntityId,
} from '@/domain/composition'

export type CompositionValidationSeverity =
    | 'valid'
    | 'warning'
    | 'error'
    | 'loading'
    | 'conflict'
    | 'disabled'

export interface CompositionValidationSummary {
    severity: CompositionValidationSeverity
    warningCount?: number
    errorCount?: number
    label?: string
}

export interface CompositionSelectOption {
    value: string
    label: string
    disabled?: boolean
}

export interface CompositionSelectControl {
    value: string
    options: readonly CompositionSelectOption[]
    onChange: (value: string) => void
    label?: string
    disabled?: boolean
}

export interface ModuleStackItem {
    id: EntityId
    name: string
    kind: CompositionModuleKind | string
    enabled: boolean
    order: number
    validation?: CompositionValidationSummary
    summary?: string
    missing?: boolean
}

export interface CharacterLayoutItem {
    id: EntityId
    name: string
    enabled: boolean
    order: number
    position: CharacterPosition
    validation?: CompositionValidationSummary
}

export interface CompositionOverrideDiffItem {
    id: string
    label: string
    inheritedValue?: ReactNode
    overrideValue?: ReactNode
    changed: boolean
}

export interface CompositionConflictSummary {
    severity: 'warning' | 'error'
    title: string
    message: string
    revision?: string
}

export type ReadonlyCompositionPlan = DeepReadonly<CompositionEnginePlan>
/** Presentation contract also accepts platform preflight issues without widening the domain engine. */
export interface ReadonlyCompositionIssue {
    readonly code: string
    readonly severity: 'warning' | 'error'
    readonly messageKey: string
    readonly repairHintKey?: string
    readonly fieldPath: readonly (string | number)[]
    readonly actionId?: string
    readonly blocking: boolean
    readonly entityRef?: {
        readonly kind?: string
        readonly id: string
    }
}

export interface CompositionGenerationControl {
    generating: boolean
    disabled?: boolean
    progressLabel?: string
    generateLabel?: string
    cancelLabel?: string
    shortcutLabel?: string
    actionTestId?: string
    cancelTestId?: string
    onGenerate: () => void
    onCancel: () => void
}

export interface CompositionSeedControl {
    value: string | number
    locked?: boolean
    disabled?: boolean
    label?: string
    onChange?: (value: string) => void
    onToggleLock?: () => void
    onPreviewWildcard?: () => void
    wildcardPreviewLabel?: string
}

export interface CompositionWorkspaceLabels {
    modules: string
    inspector: string
    resolvedPlan: string
    edit: string
    enable: string
    disable: string
    moveUp: string
    moveDown: string
    empty: string
}

export const DEFAULT_COMPOSITION_WORKSPACE_LABELS: CompositionWorkspaceLabels = {
    modules: 'Prompt groups',
    inspector: 'Applied content',
    resolvedPlan: 'Actual generation values',
    edit: 'Edit',
    enable: 'Enable',
    disable: 'Disable',
    moveUp: 'Move up',
    moveDown: 'Move down',
    empty: 'No prompt groups',
}
