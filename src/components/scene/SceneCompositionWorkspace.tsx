import { useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
    CompositionCommandBar,
    CompositionInspector,
    CompositionWorkspaceLayout,
    CompositionWorkspaceSheet,
    MobileCommandDock,
    ModuleStack,
    ResolvedPlanView,
    type CompositionConflictSummary,
    type CompositionCostSummary,
    type CompositionGenerationControl,
    type CompositionOverrideDiffItem,
    type CompositionSeedControl,
    type CompositionSelectControl,
    type CompositionValidationSummary,
    type ModuleStackItem,
    type ReadonlyCompositionIssue,
    type ReadonlyCompositionPlan,
} from '@/components/composition-workspace'

export interface SceneCompositionWorkspaceProps {
    children: ReactNode
    mode?: CompositionSelectControl
    recipe: CompositionSelectControl
    validation: CompositionValidationSummary
    generation: CompositionGenerationControl
    modules: readonly ModuleStackItem[]
    activeModuleId?: string | null
    recipeName?: string
    cost?: CompositionCostSummary
    seed?: CompositionSeedControl
    resolvedPlan?: ReadonlyCompositionPlan | null
    resolvedIssues?: readonly ReadonlyCompositionIssue[]
    resolvedLoading?: boolean
    resolvedError?: string | null
    resolvedAvailable?: boolean
    conflict?: CompositionConflictSummary | null
    overrideDiff?: readonly CompositionOverrideDiffItem[]
    inspectorChildren?: ReactNode
    disabled?: boolean
    onSelectModule: (moduleId: string) => void
    onEditModule?: (moduleId: string) => void
    onOpenResolved: () => void
    onResetOverride?: () => void
    onRepairIssue?: (issue: ReadonlyCompositionIssue) => void
    simplified?: boolean
}

/**
 * Scene-owned composition shell. It keeps worker and repository decisions in
 * the page while sharing Main's prompt-first anatomy. The outer shell owns the
 * persistent Prompt rail, so module and inspector stay behind explicit actions
 * instead of narrowing the Scene canvas with nested desktop rails.
 */
export function SceneCompositionWorkspace({
    children,
    mode,
    recipe,
    validation,
    generation,
    modules,
    activeModuleId,
    recipeName,
    cost,
    seed,
    resolvedPlan,
    resolvedIssues = [],
    resolvedLoading = false,
    resolvedError = null,
    resolvedAvailable = true,
    conflict,
    overrideDiff = [],
    inspectorChildren,
    disabled = false,
    onSelectModule,
    onEditModule,
    onOpenResolved,
    onResetOverride,
    onRepairIssue,
    simplified = false,
}: SceneCompositionWorkspaceProps) {
    const { t } = useTranslation()
    const [modulesOpen, setModulesOpen] = useState(false)
    const [inspectorOpen, setInspectorOpen] = useState(false)
    const [resolvedOpen, setResolvedOpen] = useState(false)
    const modulesReturnFocusRef = useRef<HTMLElement>(null)
    const inspectorReturnFocusRef = useRef<HTMLElement>(null)
    const resolvedReturnFocusRef = useRef<HTMLElement>(null)
    const activeModule = modules.find(module => module.id === activeModuleId) ?? null

    const captureFocus = (target: { current: HTMLElement | null }) => {
        target.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    }

    const openModules = () => {
        captureFocus(modulesReturnFocusRef)
        setModulesOpen(true)
    }

    const openInspector = () => {
        captureFocus(inspectorReturnFocusRef)
        setInspectorOpen(true)
    }

    const openResolved = () => {
        captureFocus(resolvedReturnFocusRef)
        onOpenResolved()
        setResolvedOpen(true)
    }

    const selectModule = (moduleId: string) => {
        onSelectModule(moduleId)
        if (modulesOpen) openInspector()
    }

    const moduleStack = (
        <ModuleStack
            modules={modules}
            activeModuleId={activeModuleId}
            disabled={disabled}
            height="100%"
            className="h-full rounded-none shadow-none"
            title={t('composition.modules', 'Modules')}
            searchLabel={t('composition.searchModules', 'Search modules')}
            emptyLabel={t('composition.noModules', 'No modules')}
            labels={{
                modules: t('composition.workspace.moduleStack', 'Module Stack'),
                edit: t('composition.module.edit', 'Edit module'),
                enable: t('assetModuleStudioV2.actions.enable', 'Enable'),
                disable: t('assetModuleStudioV2.actions.disable', 'Disable'),
                moveUp: t('common.moveUp', 'Move up'),
                moveDown: t('common.moveDown', 'Move down'),
                empty: t('composition.module.emptyRecipe', 'This recipe has no modules.'),
            }}
            onSelectModule={selectModule}
            onEditModule={onEditModule}
        />
    )

    const inspector = (
        <CompositionInspector
            title={t('scene.composition.inspector', 'Scene inspector')}
            module={activeModule}
            recipeName={recipeName}
            validation={validation}
            resolvedPlan={resolvedPlan}
            conflict={conflict}
            overrideDiff={overrideDiff}
            disabled={disabled}
            className="h-full rounded-none shadow-none"
            labels={{
                title: t('scene.composition.inspector', 'Scene inspector'),
                noSelection: t('composition.module.selectToInspect', 'Select a module to inspect its resolved state.'),
                recipe: t('scene.composition.recipe', 'Recipe'),
                kind: t('composition.module.kind', 'Kind'),
                moduleId: t('composition.module.id', 'Module ID'),
                overrideDiff: t('composition.override.diff', 'Override diff'),
                inherited: t('composition.override.inherited', 'Inherited'),
                override: t('composition.override.value', 'Override'),
                unchanged: t('composition.override.unchanged', 'Unchanged'),
                edit: t('composition.module.edit', 'Edit module'),
                resetOverride: t('composition.override.reset', 'Reset override'),
                resolvedPlan: t('composition.plan.open', 'Open resolved plan'),
            }}
            onEditModule={onEditModule}
            onResetOverride={onResetOverride}
            onOpenResolvedPlan={openResolved}
        >
            {inspectorChildren}
        </CompositionInspector>
    )

    const commandBar = (
        <CompositionCommandBar
            mode={simplified ? undefined : mode}
            recipe={simplified ? undefined : recipe}
            validation={simplified ? undefined : validation}
            cost={cost}
            seed={seed}
            resolved={simplified ? undefined : {
                available: resolvedAvailable,
                open: resolvedOpen,
                onOpen: openResolved,
            }}
            generation={generation}
            labels={{
                commands: t('composition.commandBar', 'Composition commands'),
                mode: t('scene.composition.mode', 'Mode'),
                recipe: t('scene.composition.recipe', 'Recipe'),
                cost: t('composition.cost.estimated', 'Estimated cost'),
                seed: t('settings.seed', 'Seed'),
                modules: t('composition.modules', 'Modules'),
                inspector: t('scene.composition.inspector', 'Scene inspector'),
                resolved: t('scene.composition.resolved', 'Resolved'),
                generate: t('generate.button', 'Generate'),
                cancel: t('generate.cancel', 'Cancel'),
                lockSeed: t('composition.random.lockSeed', 'Lock seed'),
                unlockSeed: t('composition.random.unlockSeed', 'Unlock seed'),
            }}
            disabled={disabled}
            onOpenModules={simplified ? undefined : openModules}
            onOpenInspector={simplified ? undefined : openInspector}
            simplified={simplified}
        />
    )

    return (
        <div className="h-full min-h-0 min-w-0">
            <CompositionWorkspaceLayout
                desktopRails={false}
                commandBar={commandBar}
                moduleStack={moduleStack}
                workspace={children}
                inspector={inspector}
                mobileDock={(
                    <MobileCommandDock
                        generation={generation}
                        disabled={disabled}
                        resolvedAvailable={resolvedAvailable}
                        labels={{
                            modules: t('composition.modules', 'Modules'),
                            inspector: t('scene.composition.inspector', 'Scene inspector'),
                            resolved: t('scene.composition.resolved', 'Resolved'),
                            generate: t('generate.button', 'Generate'),
                            cancel: t('generate.cancel', 'Cancel'),
                        }}
                        onOpenModules={simplified ? undefined : openModules}
                        onOpenInspector={simplified ? undefined : openInspector}
                        onOpenResolved={simplified ? undefined : openResolved}
                        simplified={simplified}
                    />
                )}
            />

            {!simplified && <>
            <CompositionWorkspaceSheet
                open={modulesOpen}
                onOpenChange={setModulesOpen}
                title={t('composition.modules', 'Modules')}
                description={t('composition.workspace.moduleStackHelp', 'Choose a recipe module to review its applied content and validation state.')}
                closeLabel={t('common.close', 'Close')}
                side="left"
                testId="scene-modules-sheet"
                returnFocusRef={modulesReturnFocusRef}
                contentClassName="overflow-hidden pt-0"
            >
                {moduleStack}
            </CompositionWorkspaceSheet>
            <CompositionWorkspaceSheet
                open={inspectorOpen}
                onOpenChange={setInspectorOpen}
                title={t('scene.composition.inspector', 'Scene inspector')}
                description={t('composition.workspace.inspectorHelp', 'Review how the selected module affects prompts and parameters.')}
                closeLabel={t('common.close', 'Close')}
                side="right"
                level="secondary"
                testId="scene-inspector-sheet"
                returnFocusRef={inspectorReturnFocusRef}
                contentClassName="overflow-hidden pt-0"
            >
                {inspector}
            </CompositionWorkspaceSheet>
            <CompositionWorkspaceSheet
                open={resolvedOpen}
                onOpenChange={setResolvedOpen}
                title={t('scene.composition.resolvedPlan', 'Resolved plan')}
                description={t('composition.plan.help', 'Review prompts, parameters, random trace, and provenance.')}
                closeLabel={t('common.close', 'Close')}
                side="bottom"
                level="secondary"
                testId="scene-resolved-plan-sheet"
                returnFocusRef={resolvedReturnFocusRef}
                contentClassName="pt-0"
            >
                <ResolvedPlanView
                    plan={resolvedPlan}
                    issues={resolvedIssues}
                    onRepairIssue={onRepairIssue}
                    loading={resolvedLoading}
                    error={resolvedError}
                    className="rounded-none border-0 shadow-none"
                    labels={{
                        title: t('scene.composition.resolvedPlan', 'Resolved plan'),
                        loading: t('common.loading', 'Loading…'),
                        empty: t('assetModuleStudioV2.preview.unavailable', 'No resolved plan yet.'),
                        positive: t('assetModuleStudioV2.preview.positive', 'Positive prompt'),
                        negative: t('assetModuleStudioV2.preview.negative', 'Negative prompt'),
                        promptParts: t('assetModuleStudioV2.preview.slotBreakdown', 'Prompt slots'),
                        characters: t('assetModuleStudioV2.preview.characters', 'Characters'),
                        params: t('parameters.title', 'Parameters'),
                        paramsWinner: t('assetModuleStudioV2.preview.paramsWinner', 'Winning source'),
                        output: t('assetModuleStudioV2.preview.output', 'Output policy'),
                        warnings: t('assetModuleStudioV2.filters.warnings', 'Warnings'),
                        errors: t('assetModuleStudioV2.filters.errors', 'Errors'),
                        randomTrace: t('assetModuleStudioV2.preview.randomTrace', 'Random trace'),
                        provenance: t('assetModuleStudioV2.preview.provenance', 'Provenance'),
                        repair: t('composition.module.repairRequired', 'Repair'),
                    }}
                />
            </CompositionWorkspaceSheet>
            </>}
        </div>
    )
}
