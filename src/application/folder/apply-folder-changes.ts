import type { GenerationFolderV2Defaults } from '@/domain/generation-folders'
import {
    generationFolderDocumentMutationKey,
    type WorkspaceMutationGatePort,
} from '@/application/workspace/workspace-mutation-gate'
import type { GenerationFolderRepositoryPort } from './generation-folder-repository'
import {
    planGenerationFolderChanges,
    type GenerationFolderChange,
    type PlanGenerationFolderChangesResult,
} from './plan-folder-changes'

export type FolderOccupancyResult =
    | { readonly status: 'empty' }
    | { readonly status: 'occupied'; readonly folderIds: readonly string[] }
    | { readonly status: 'unknown'; readonly folderIds: readonly string[] }

type PlannedFolderChanges = Extract<PlanGenerationFolderChangesResult, { status: 'PLANNED' }>

export type ApplyGenerationFolderChangesResult =
    | { readonly status: 'COMMITTED'; readonly plan: PlannedFolderChanges }
    | { readonly status: 'NOT_FOUND' }
    | { readonly status: 'REVISION_CONFLICT' }
    | { readonly status: 'PLAN_CONFLICT' }
    | { readonly status: 'COLLISION'; readonly plan: PlannedFolderChanges }
    | { readonly status: 'INVALID'; readonly reason: string }
    | { readonly status: 'STORAGE_CONFLICT' }
    | { readonly status: 'AUTHORIZATION_FAILED'; readonly folderIds: readonly string[] }
    | {
        readonly status: 'UNSUPPORTED'
        readonly reason: 'unsupported-needs-relocation-policy'
        readonly occupancy: Exclude<FolderOccupancyResult, { status: 'empty' }>
    }

export interface ApplyGenerationFolderChangesInput {
    readonly repository: GenerationFolderRepositoryPort
    readonly workspaceId: string
    readonly expectedRevision: number
    readonly expectedPlanHash: `sha256:${string}`
    readonly changes: readonly GenerationFolderChange[]
    readonly defaults: GenerationFolderV2Defaults
    readonly occupancyGuard: (folderIds: readonly string[]) => Promise<FolderOccupancyResult>
    readonly mutationGate: WorkspaceMutationGatePort
    readonly authorizeDirectories: (
        authorizations: readonly { readonly folderId: string; readonly directory: string }[],
    ) => Promise<void>
}

/** Replans and commits one Folder CAS; it never moves files or mutates Artifact authority. */
export async function applyGenerationFolderChanges(
    input: ApplyGenerationFolderChangesInput,
): Promise<ApplyGenerationFolderChangesResult> {
    return input.mutationGate.runExclusive<ApplyGenerationFolderChangesResult>(
        generationFolderDocumentMutationKey(input.workspaceId),
        async () => {
            const validate = async (): Promise<
                | { readonly result: ApplyGenerationFolderChangesResult }
                | { readonly plan: PlannedFolderChanges }
            > => {
                const current = await input.repository.getDocument(input.workspaceId)
                if (current === null) return { result: { status: 'NOT_FOUND' } as const }
                if (current.revision !== input.expectedRevision) {
                    return { result: { status: 'REVISION_CONFLICT' } as const }
                }
                const plan = planGenerationFolderChanges(current, input.changes, input.defaults)
                if (plan.status === 'INVALID') return { result: { status: 'INVALID', reason: plan.reason } as const }
                if (plan.planHash !== input.expectedPlanHash) return { result: { status: 'PLAN_CONFLICT' } as const }
                if (plan.collisions.length > 0) return { result: { status: 'COLLISION', plan } as const }
                return { plan }
            }

            const first = await validate()
            if ('result' in first) return first.result
            let validatedPlan = first.plan
            const deletedIds = input.changes.flatMap(change => (
                'op' in change && change.op === 'delete' ? [change.folderId] : []
            ))
            const guardedIds = [...new Set([...first.plan.pathMoves.map(move => move.folderId), ...deletedIds])].sort()
            const inspectOccupancy = async (): Promise<ApplyGenerationFolderChangesResult | null> => {
                if (guardedIds.length === 0) return null
                const occupancy = await input.occupancyGuard(guardedIds)
                return occupancy.status === 'empty' ? null : {
                    status: 'UNSUPPORTED',
                    reason: 'unsupported-needs-relocation-policy',
                    occupancy,
                }
            }
            const occupied = await inspectOccupancy()
            if (occupied !== null) return occupied

            if (first.plan.requiredAuthorizations.length > 0) {
                try {
                    await input.authorizeDirectories(first.plan.requiredAuthorizations)
                } catch {
                    return {
                        status: 'AUTHORIZATION_FAILED',
                        folderIds: [...new Set(first.plan.requiredAuthorizations.map(item => item.folderId))].sort(),
                    }
                }
                const afterAuthorization = await validate()
                if ('result' in afterAuthorization) return afterAuthorization.result
                validatedPlan = afterAuthorization.plan
                const newlyOccupied = await inspectOccupancy()
                if (newlyOccupied !== null) return newlyOccupied
            }

            const committed = await input.repository.commit(validatedPlan.document, input.expectedRevision)
            if (committed.status === 'REVISION_CONFLICT') return { status: 'REVISION_CONFLICT' }
            if (committed.status === 'STORAGE_CONFLICT') return { status: 'STORAGE_CONFLICT' }
            return { status: 'COMMITTED', plan: { ...validatedPlan, document: committed.document } }
        },
    )
}
