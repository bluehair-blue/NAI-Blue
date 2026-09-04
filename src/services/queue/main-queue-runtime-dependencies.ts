import type { MainQueuePresentationPort } from '@/application/generation/main-queue-presentation-port'
import type { MainBatchPlannerPort } from '@/application/generation/plan-main-batch'
import type { PreparedMainGeneration } from '@/services/generation/main-generation-plan'
import type { NaiProviderFaultInjector } from '@/services/nai/transport'
import type { ProviderResultSpool } from '@/application/generation/provider-result-spool'
import type { OutputReservationFolderBinding } from '@/domain/queue/types'
import type {
    OutputWriterDestination,
} from '@/services/output/output-writer'
import type {
    ExactOutputCommitSetAllocation,
    GenerationOutputClaimPlan,
} from '@/services/output/generation-output-commit-set'
import type { PlannedOutputCollisionPolicy } from '@/services/output/filename-policy'

export interface OutputCommitSetPlanningRequest {
    readonly destination: OutputWriterDestination
    readonly claimPlan: GenerationOutputClaimPlan
    readonly collisionPolicy: PlannedOutputCollisionPolicy
    readonly directoryAuthorityId: string
    readonly folderBinding: OutputReservationFolderBinding
    readonly reservationIdentity: {
        readonly reservationId: string
        readonly batchId: string
        readonly jobId: string
    }
}

export interface PlannedOutputCommitSet extends ExactOutputCommitSetAllocation {
    readonly directoryIdentity: `sha256:${string}`
}

export interface OutputReservationPlanningPort {
    getCurrentFolderBinding(): OutputReservationFolderBinding | null
    getAuthoritativeFolderBinding(workspaceId: string): Promise<OutputReservationFolderBinding | null>
    planBatch(requests: readonly OutputCommitSetPlanningRequest[]): Promise<readonly PlannedOutputCommitSet[]>
}

export interface RuntimeMainQueueDependencies {
    readonly planner: MainBatchPlannerPort<PreparedMainGeneration>
    readonly presentation: MainQueuePresentationPort
    readonly providerResultSpool: ProviderResultSpool
    readonly outputReservations: OutputReservationPlanningPort
    /** Phase 3 tests inject failures here; production composition leaves it absent. */
    readonly faultInjector?: NaiProviderFaultInjector
}

let runtimeMainQueueDependencies: RuntimeMainQueueDependencies | null = null

/**
 * Composition Root supplies the Main Planner bridge and result projector used
 * by both enqueue and execution modules. Centralizing this registry prevents
 * either infrastructure half from importing Zustand while preserving one
 * application-session dependency set.
 */
export function configureRuntimeMainQueueDependencies(
    dependencies: RuntimeMainQueueDependencies,
): void {
    runtimeMainQueueDependencies = dependencies
}

export function getRuntimeMainQueueDependencies(): RuntimeMainQueueDependencies {
    if (runtimeMainQueueDependencies === null) {
        throw new Error('Main Queue dependencies are not configured')
    }
    return runtimeMainQueueDependencies
}

export function resetRuntimeMainQueueDependenciesForTests(): void {
    runtimeMainQueueDependencies = null
}
