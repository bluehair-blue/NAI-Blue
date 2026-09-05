import type { JsonValue } from '@/domain/composition/types'
import type { PlannedR2Destination } from '@/domain/r2/types'
import type { CredentialDispatchPolicy, WorkflowDraft } from '@/domain/workflow/single-image-draft'

export type Sha256Digest = `sha256:${string}`

export interface VersionedBinding {
    readonly resourceType: 'workflow-draft'
        | 'main-generation-capture'
        | 'composition-document'
        | 'scene-document'
        | 'generation-folder-document'
        | 'r2-profile'
        | 'visual-rubric'
    readonly resourceId: string
    readonly revision: number | null
    readonly contentHash: Sha256Digest
}

export interface GenerationExecutionPolicySnapshot {
    readonly failurePolicy: 'continue' | 'stop'
    readonly retryPolicyId: string
    readonly maxAttempts: number
    readonly maxConcurrency: number
    readonly credentialDispatch: CredentialDispatchPolicy
    readonly pricingBasis: 'paid' | 'all-active-opus'
    readonly metadataMode: string
}

export interface LogicalOutputDestination {
    readonly generationFolderId: string | null
    readonly generationFolderPathHash: Sha256Digest | null
    readonly outputPolicyId: string
    readonly expectedBaseName: string
    readonly extension: 'png' | 'webp'
    readonly collisionPolicy: 'fail'
    readonly deliveryRequired: boolean
    /** Public immutable delivery target; credential/profile internals remain opaque. */
    readonly r2?: PlannedR2Destination
}

/**
 * The application core owns semantic inputs while an injected adapter keeps
 * the existing prepared object opaque. This prevents provider/UI types from
 * crossing into the application layer or leaking through the public view.
 */
export interface PreparedGenerationJobDraft<TPrepared = unknown> {
    readonly semantic: {
        readonly prompt: string
        readonly negativePrompt: string
        readonly model: string
        readonly width: number
        readonly height: number
        readonly steps: number
        readonly seed: number
        readonly generationParameters: JsonValue
        readonly resourceDigest: Sha256Digest
    }
    /** Stable non-provider preparation state, such as a sequential counter proposal. */
    readonly preparationDigest: Sha256Digest
    readonly destination: LogicalOutputDestination
    readonly prepared: TPrepared
}

export type CompatibilityStatus = 'captured-pass'
    | 'live-canary-pass'
    | 'synthetic-only'
    | 'known-divergence'
    | 'unsupported'

export interface CompatibilitySnapshot {
    readonly compatibilityProfileId: string
    readonly status: CompatibilityStatus
}

export interface PlanIssue {
    readonly code: string
    readonly severity: 'warning' | 'blocking'
    readonly fieldPath: string
    readonly message: string
    readonly expectedDigest?: Sha256Digest
    readonly actualDigest?: Sha256Digest
}

export interface ApprovalRequirement {
    readonly kind: 'budget'
    readonly fieldPath: 'budget.maxImages' | 'budget.maxAnlas'
    readonly required: number
    readonly allowed: number
}

export interface PreparedGenerationJob<TPrepared = unknown>
    extends PreparedGenerationJobDraft<TPrepared> {
    readonly ordinal: number
    readonly estimatedAnlas: number
    readonly compatibility: CompatibilitySnapshot
}

export interface GenerationPlan<TPrepared = unknown> {
    readonly schemaVersion: 1
    readonly planId: Sha256Digest
    readonly planHash: Sha256Digest
    readonly semanticPlanHash: Sha256Digest
    readonly sourceBindings: readonly VersionedBinding[]
    readonly materializedSeedTrace: {
        readonly source: 'random' | 'fixed' | 'increment' | 'replay'
        readonly traceId: string | null
        readonly seeds: readonly number[]
    }
    readonly jobs: readonly PreparedGenerationJob<TPrepared>[]
    readonly estimatedAnlas: number
    readonly issues: readonly PlanIssue[]
    readonly requiredApprovals: readonly ApprovalRequirement[]
    readonly executionPolicy: GenerationExecutionPolicySnapshot
    readonly budget: { readonly maxImages: number; readonly maxAnlas: number }
}

export interface GenerationPlanJobView {
    readonly ordinal: number
    readonly promptDigest: Sha256Digest
    readonly resourceDigest: Sha256Digest
    readonly model: string
    readonly seed: number
    readonly estimatedAnlas: number
    readonly destination: LogicalOutputDestination
    readonly compatibilityProfileId: string
    readonly compatibilityStatus: CompatibilityStatus
}

export interface GenerationPlanView {
    readonly schemaVersion: 1
    readonly planId: Sha256Digest
    readonly planHash: Sha256Digest
    readonly semanticPlanHash: Sha256Digest
    readonly sourceBindings: readonly VersionedBinding[]
    readonly materializedSeedTrace: GenerationPlan['materializedSeedTrace']
    readonly jobs: readonly GenerationPlanJobView[]
    readonly estimatedAnlas: number
    readonly issues: readonly PlanIssue[]
    readonly requiredApprovals: readonly ApprovalRequirement[]
    readonly executionPolicy: GenerationExecutionPolicySnapshot
    readonly budget: GenerationPlan['budget']
}

export interface DetachedGenerationCapture<TPrepared = unknown> {
    readonly schemaVersion: 1
    readonly captureId: string
    /** Canonical digest of every other field in this detached capture. */
    readonly contentHash: Sha256Digest
    readonly sourceBindings: readonly VersionedBinding[]
    readonly materializedSeeds: readonly number[]
    readonly jobs: readonly PreparedGenerationJobDraft<TPrepared>[]
    readonly executionPolicy: GenerationExecutionPolicySnapshot
    /** Readiness only; credentials and credential material never enter a plan. */
    readonly credentialReadinessFingerprint: Sha256Digest
}

export type PlanGenerationSource<TPrepared = unknown> =
    | {
        readonly kind: 'workflow-draft'
        readonly draftId: string
        readonly expectedRevision: number
    }
    | {
        readonly kind: 'detached-generation-capture'
        readonly capture: DetachedGenerationCapture<TPrepared>
    }

export type GenerationConflictSource =
    | Extract<PlanGenerationSource, { readonly kind: 'workflow-draft' }>
    | {
        readonly kind: 'detached-generation-capture'
        readonly captureId: string
        readonly contentHash: Sha256Digest
    }

export interface PlanGenerationInput<TPrepared = unknown> {
    readonly source: PlanGenerationSource<TPrepared>
    readonly count: number
    readonly seedPolicy: { readonly kind: 'random' }
        | { readonly kind: 'fixed'; readonly seed: number }
        | { readonly kind: 'increment'; readonly firstSeed: number }
        | { readonly kind: 'replay'; readonly traceId: string }
    readonly budget: { readonly maxImages: number; readonly maxAnlas: number }
}

export interface PreparedJobPlannerPort<TPrepared = unknown> {
    prepare(input: {
        readonly draft: WorkflowDraft
        readonly materializedSeeds: readonly number[]
    }): Promise<readonly PreparedGenerationJobDraft<TPrepared>[]>
}

export type PlanGenerationResult<TPrepared = unknown> =
    | { readonly status: 'ready'; readonly plan: GenerationPlan<TPrepared>; readonly view: GenerationPlanView }
    | { readonly status: 'invalid'; readonly issues: readonly PlanIssue[] }
    | {
        readonly status: 'conflict'
        /** A redacted source identity; detached prepared values never cross this boundary. */
        readonly source: GenerationConflictSource
        readonly currentRevision: number | null
        readonly action: 'reload-workflow-draft' | 'recapture-generation'
        readonly mismatch?: {
            readonly fieldPath: string
            readonly expectedDigest: Sha256Digest
            readonly actualDigest: Sha256Digest
        }
    }
    | {
        readonly status: 'needs_input'
        readonly plan: GenerationPlan<TPrepared>
        readonly view: GenerationPlanView
        readonly requirements: readonly ApprovalRequirement[]
    }
    | { readonly status: 'unsupported'; readonly capability: string; readonly issues: readonly PlanIssue[] }
