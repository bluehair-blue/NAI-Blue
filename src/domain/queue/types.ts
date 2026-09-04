import type { JsonValue } from '@/domain/composition/types'
import type {
    ProviderAttemptEvidence,
    ProviderAttemptTransition,
    ProviderExecutionEnvelope,
} from './provider-result'

export const GENERATION_JOB_STATES = [
    'queued',
    'leased',
    'running',
    'succeeded',
    'failed',
    'cancelled',
    'skipped',
    'blocked',
    'recovering',
] as const

export type GenerationJobState = typeof GENERATION_JOB_STATES[number]

export const TERMINAL_JOB_STATES = [
    'succeeded',
    'failed',
    'cancelled',
    'skipped',
] as const satisfies readonly GenerationJobState[]

export type TerminalGenerationJobState = typeof TERMINAL_JOB_STATES[number]
export type GenerationWorkflow = 'main' | 'scene' | 'style-lab'

/** Measured ceiling for one reservation-backed atomic Queue publication. */
export interface GenerationAtomicBatchLimits {
    readonly maxJobsPerAtomicBatch: number
    readonly maxOutputClaimsPerAtomicBatch: number
    readonly measuredAt: string
    readonly evidenceId: string
}
export type SnapshotResourceRole = 'source' | 'mask' | 'character-reference' | 'vibe-reference' | 'other'
export type SnapshotResourcePersistence = 'managed-app-data' | 'portable' | 'volatile'
export type SnapshotResumability = 'resumable' | 'non-resumable'

export interface OutputReservationFolderBinding {
    readonly resourceType: 'generation-folder-document'
    readonly resourceId: string
    readonly revision: number
    readonly contentHash: `sha256:${string}`
}

export type OutputPathClaimKind =
    | 'image'
    | 'metadata-sidecar'
    | 'artifact-sidecar'
    | 'diagnostic-sidecar'
    | 'provider-original'

export interface OutputPathClaim {
    readonly claimId: string
    readonly kind: OutputPathClaimKind
    readonly relativePath: string
    /** Secret-free digest of directory authority, filesystem semantics, and normalized path. */
    readonly collisionKey: string
}

export interface OutputCommitSet {
    readonly schemaVersion: 1
    readonly directoryAuthorityId: string
    readonly directoryAuthorityFingerprint: `sha256:${string}`
    readonly filesystemSemantics: 'windows' | 'macos' | 'linux' | 'android'
    readonly filenamePolicyRevision: string
    readonly pathNormalizationRevision: string
    readonly claims: readonly OutputPathClaim[]
}

interface OutputReservationSnapshotBase {
    readonly reservationId: string
    readonly folderBinding: OutputReservationFolderBinding
    /** Secret-free identity of the resolved physical output directory. */
    readonly directoryIdentity: `sha256:${string}`
    readonly relativePath: string
    readonly collisionPolicy: 'fail' | 'suffix'
    /** Phase 6 is create-only; local overwrite has no approved digest contract. */
    readonly expectedExistingDigest: null
}

/** Compatibility-only single-path snapshot. Missing revision identifies pre-v9 persisted data. */
export interface LegacyOutputReservationSnapshot extends OutputReservationSnapshotBase {
    readonly reservationSchemaVersion?: 0
}

/** Current reservation snapshot. Legacy path fields remain as a narrow executor compatibility projection. */
export interface OutputCommitSetReservationSnapshot extends OutputReservationSnapshotBase {
    readonly reservationSchemaVersion: 1
    readonly commitSet: OutputCommitSet
    readonly commitSetHash: `sha256:${string}`
}

export type OutputReservationSnapshot = LegacyOutputReservationSnapshot | OutputCommitSetReservationSnapshot
export type QueueBlockReason =
    | 'missing-resource'
    | 'digest-mismatch'
    | 'non-resumable-resource'
    | 'provider-outcome-unknown'
    | 'provider-result-lost'
export type QueueFailurePolicy = 'continue' | 'pause-on-fatal' | 'stop-on-first-error'

/** Keeps canonical Main plans aligned with the Queue policy actually enforced at runtime. */
export const CURRENT_MAIN_QUEUE_POLICY = Object.freeze({
    retryPolicyId: 'main-queue-retry-v1',
    maxConcurrency: 2,
})

export type GenerationBatchState = 'active' | 'paused' | 'stopped'
export type QueuePauseReason = 'user' | 'authentication' | 'local-io' | 'compatibility' | 'fatal' | 'first-error'
export type QueueBatchOrigin = 'fresh' | 'legacy-conversion' | 'retry'
export type QueueFailureKind =
    | 'transient'
    | 'rate-limited'
    | 'timeout'
    | 'authentication'
    | 'decode'
    | 'local-io'
    | 'compatibility'
    | 'fatal'

export interface GenerationSnapshotPrompt {
    readonly positive: string
    readonly negative: string
}

export interface GenerationSnapshotResource {
    readonly resourceId: string
    readonly role: SnapshotResourceRole
    readonly persistence: SnapshotResourcePersistence
    readonly digest: string
    /** Stable reference only. Raw bytes, absolute paths, signed URLs, and secrets are prohibited. */
    readonly reference: JsonValue
}

export interface GenerationJobSnapshot {
    readonly schemaVersion: 1
    /** Absent only on legacy snapshots that retain the pre-Phase-3 executor contract. */
    readonly providerExecutionEnvelope?: ProviderExecutionEnvelope
    /** Immutable exact local destination; absent on pre-Phase-6 jobs. */
    readonly outputReservation?: OutputReservationSnapshot
    readonly prompt: GenerationSnapshotPrompt
    readonly parameters: JsonValue
    readonly outputPolicy: JsonValue
    readonly resources: readonly GenerationSnapshotResource[]
    readonly resumability: SnapshotResumability
    readonly nonResumableReason?: 'volatile-resource' | 'runtime-only-capability'
}

export interface GenerationJobProgress {
    readonly stage: string
    readonly current: number
    readonly total: number
}

export interface QueueArtifactReference {
    readonly kind: 'output-writer'
    readonly artifactId: string
    readonly digest: string
    readonly mimeType?: string
}

export interface GenerationJob {
    readonly id: string
    readonly batchId: string
    readonly workflow: GenerationWorkflow
    readonly sceneId: string | null
    readonly state: GenerationJobState
    readonly createdAt: string
    readonly updatedAt: string
    readonly priority: number
    readonly ordinal: number
    readonly snapshotSchemaVersion: number
    readonly snapshot: GenerationJobSnapshot
    readonly snapshotHash: string
    readonly compositionPlanHash: string | null
    readonly attemptCount: number
    readonly maxAttempts: number
    readonly idempotencyKey: string
    readonly leaseOwner: string | null
    readonly leaseToken: string | null
    readonly leaseExpiresAt: string | null
    readonly heartbeatAt: string | null
    readonly progress: GenerationJobProgress
    readonly lastDiagnosticEventId: string | null
    readonly outputTransactionId: string | null
    readonly artifactReference: QueueArtifactReference | null
    readonly blockReason: QueueBlockReason | null
    /** Earliest durable claim time. This is the authority for retry/backoff after restart. */
    readonly readyAt: string
    readonly cancelRequestedAt: string | null
    readonly cancelReason: 'user' | 'batch' | 'shutdown' | null
    /** Terminal jobs remain immutable; manual retries are linked successor jobs. */
    readonly retryOfJobId: string | null
    readonly rootJobId: string
    readonly version: number
}

export interface GenerationBatch {
    readonly id: string
    readonly workflow: GenerationWorkflow
    /** Monotonic enqueue order shared by every job in this immutable batch. */
    readonly queueSequence: number
    readonly createdAt: string
    readonly updatedAt: string
    readonly state: GenerationBatchState
    readonly failurePolicy: QueueFailurePolicy
    readonly pauseReason: QueuePauseReason | null
    readonly origin: QueueBatchOrigin
    readonly idempotencyKey: string
    readonly version: number
    /**
     * Durable read-model revision for Queue Center. Job writers advance this
     * independently of batch controls so a viewport can poll one small record
     * and reload rows only after a projection-visible mutation.
     */
    readonly projectionRevision: number
    /**
     * Transactional aggregate paired with projectionRevision. It connects job
     * state/progress writes to Queue Center totals without loading snapshots or
     * every job projection on each visible-tab refresh.
     */
    readonly projectionSummary: GenerationBatchSummary
}

export type QueueResourceAvailability = 'available' | 'missing' | 'volatile'

export interface QueueResourceRecord {
    readonly id: string
    readonly persistence: SnapshotResourcePersistence
    readonly digest: string
    readonly reference: JsonValue
    readonly availability: QueueResourceAvailability
    readonly createdAt: string
    readonly updatedAt: string
}

export type GenerationAttemptOutcome = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'

export interface GenerationAttempt {
    readonly recordSchemaVersion: 2
    readonly id: string
    readonly jobId: string
    readonly attemptNumber: number
    readonly startedAt: string
    readonly finishedAt: string | null
    readonly outcome: GenerationAttemptOutcome
    readonly diagnosticEventId: string | null
    readonly failureKind?: QueueFailureKind | null
    /** Null marks a legacy attempt whose historical Provider dispatch facts are unknowable. */
    readonly providerEvidence: ProviderAttemptEvidence | null
    readonly providerTransitions: readonly ProviderAttemptTransition[]
    readonly executionEnvelopeHash: `sha256:${string}` | null
}

export type OutputReservationState = 'reserved' | 'storage-pending' | 'writing' | 'committed' | 'conflict' | 'abandoned'

interface OutputReservationOwner {
    readonly batchId: string
    readonly jobId: string
    readonly state: OutputReservationState
}

/** Explicit compatibility row; it never advertises a synthesized full commit set. */
export type LegacyOutputReservation = LegacyOutputReservationSnapshot & OutputReservationOwner

/** Durable enqueue-time ownership of every permanent path in one output transaction. */
export type OutputCommitSetReservation = OutputCommitSetReservationSnapshot & OutputReservationOwner & {
    readonly version: number
    readonly updatedAt: string
}

export type OutputReservation = LegacyOutputReservation | OutputCommitSetReservation

export interface OutputReservationClaim {
    readonly claimId: string
    readonly reservationId: string
    readonly originalCollisionKey: string
    readonly activeCollisionKey: string | null
    readonly kind: OutputPathClaimKind
    readonly relativePath: string
}

export interface GenerationJobProjection {
    readonly id: string
    readonly batchId: string
    readonly workflow: GenerationWorkflow
    readonly sceneId: string | null
    /** Enqueue-time output destination; absent only on legacy/foreign snapshots. */
    readonly outputDirectory?: string | null
    readonly state: GenerationJobState
    readonly createdAt: string
    readonly updatedAt: string
    readonly priority: number
    readonly ordinal: number
    readonly attemptCount: number
    readonly maxAttempts: number
    readonly progress: GenerationJobProgress
    readonly readyAt: string
    readonly cancelRequestedAt: string | null
    readonly retryOfJobId: string | null
    readonly lastDiagnosticEventId: string | null
    readonly outputTransactionId: string | null
    readonly version: number
}

export interface GenerationBatchSummary {
    readonly batchId: string
    readonly total: number
    readonly completed: number
    readonly progressCurrent: number
    readonly progressTotal: number
    readonly states: Readonly<Record<GenerationJobState, number>>
    readonly recentCompletedAt: readonly string[]
}

/** Small batch read used to decide whether a Queue Center viewport is stale. */
export interface GenerationBatchProjectionMeta {
    readonly batchId: string
    readonly revision: number
    readonly summary: GenerationBatchSummary
}

/** Bounded Queue Center row slice. `total` is scoped to `state` when supplied. */
export interface GenerationJobProjectionWindow extends GenerationBatchProjectionMeta {
    readonly state: GenerationJobState | null
    readonly offset: number
    readonly total: number
    readonly items: readonly GenerationJobProjection[]
}

/**
 * Small cross-batch read model for the persistent app-shell Queue entry point.
 * The IndexedDB repository derives these values from state indexes so navigation
 * can signal work without materializing Queue Center job projections or snapshots.
 */
export interface QueueActivitySummary {
    readonly processing: number
    readonly waiting: number
    readonly needsAttention: number
}
