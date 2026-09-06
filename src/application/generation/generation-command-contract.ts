import type { AnlasCostConsentSnapshot } from '@/domain/queue/anlas-cost-consent'
import type {
    GenerationPlan,
    PlanGenerationInput,
    PlanGenerationResult,
    PlanIssue,
} from './generation-plan-contract'

export interface ActorRef {
    readonly kind: 'user' | 'agent' | 'system' | 'service'
    readonly id: string
    readonly displayName?: string
}

export interface EnqueueGenerationInput<TPrepared = unknown> {
    readonly reviewedPlan: GenerationPlan<TPrepared>
    readonly costConsent: AnlasCostConsentSnapshot
    readonly idempotencyKey: string
    readonly actor: ActorRef
    /** Rebuilds the reviewed plan from its bound source while retaining saved seeds. */
    readonly replanInput: Omit<PlanGenerationInput<TPrepared>, 'seedPolicy'>
}

export interface EnqueuedGenerationJobRef {
    readonly id: string
    readonly ordinal: number
}

export type GenerationCommandFailure =
    | { readonly status: 'invalid'; readonly issues: readonly PlanIssue[] }
    | { readonly status: 'conflict'; readonly issues: readonly PlanIssue[] }
    | { readonly status: 'unsupported'; readonly capability: string; readonly issues: readonly PlanIssue[] }

export type EnqueueGenerationResult<TPrepared = unknown> =
    | { readonly status: 'ready'; readonly batchId: string; readonly runId: string; readonly jobIds: readonly string[] }
    | Extract<PlanGenerationResult<TPrepared>, { readonly status: 'conflict' | 'invalid' | 'unsupported' }>
    | GenerationCommandFailure

/** Adapter result is deliberately reduced by the use case before crossing the application boundary. */
export type EnqueueGenerationPortResult<TPrepared = unknown> =
    | { readonly status: 'ready'; readonly batchId: string; readonly jobs: readonly EnqueuedGenerationJobRef[] }
    | Extract<PlanGenerationResult<TPrepared>, { readonly status: 'conflict' | 'invalid' | 'unsupported' }>
    | GenerationCommandFailure

export interface EnqueueGenerationPort<TPrepared = unknown> {
    enqueue(input: {
        readonly plan: GenerationPlan<TPrepared>
        readonly costConsent: AnlasCostConsentSnapshot
        readonly idempotencyKey: string
        readonly actor: ActorRef
    }): Promise<EnqueueGenerationPortResult<TPrepared>>
}

export interface CancelGenerationInput {
    readonly batchId: string
    readonly actor: ActorRef
    /** Exact human-grant digest persisted by Queue for crash reconciliation. */
    readonly operationId?: string
}

export interface RetryGenerationStorageInput {
    readonly jobId: string
    readonly actor: ActorRef
}

export type GenerationCommandResult =
    | { readonly status: 'ready'; readonly targetId: string }
    | GenerationCommandFailure

export interface CancelGenerationPort {
    cancelBatch(input: CancelGenerationInput): Promise<GenerationCommandResult>
}

export interface RetryGenerationStoragePort {
    retryStorage(input: RetryGenerationStorageInput): Promise<GenerationCommandResult>
}
