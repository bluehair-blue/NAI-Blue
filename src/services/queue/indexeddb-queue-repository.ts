import { canonicalSerialize, hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import { createOutputCollisionKey, hashOutputCommitSet } from '@/domain/output-commit-set'
import { CHARACTER_SCENES_DIRECTORY_NAME } from '@/domain/generation-folders'
import {
    assertJobTransition,
    isGenerationJobState,
    isTerminalJobState,
    QueueStateTransitionError,
} from '@/domain/queue/state-machine'
import {
    applyGenerationJobProjectionDelta,
    createEmptyGenerationBatchSummary,
} from '@/domain/queue/summary'
import { GENERATION_JOB_STATES } from '@/domain/queue/types'
import { runtimeCapabilities } from '@/platform/capabilities'
import type {
    ProviderAttemptEvidence,
    ProviderAttemptTransition,
    ProviderBillingRisk,
    ProviderDispatchState,
    ProviderExecutionEnvelope,
    ProviderOutcome,
    SpoolReceipt,
} from '@/domain/queue/provider-result'
import type {
    GenerationAttempt,
    GenerationAtomicBatchLimits,
    GenerationBatch,
    GenerationBatchProjectionMeta,
    GenerationBatchSummary,
    GenerationJob,
    GenerationJobProjection,
    GenerationJobProjectionWindow,
    GenerationJobProgress,
    GenerationJobSnapshot,
    GenerationJobState,
    GenerationSnapshotResource,
    GenerationWorkflow,
    LegacyOutputReservationSnapshot,
    QueueArtifactReference,
    QueueBatchOrigin,
    QueueBlockReason,
    QueueActivitySummary,
    QueueFailureKind,
    QueueFailurePolicy,
    QueuePauseReason,
    QueueResourceRecord,
    OutputReservation,
    OutputReservationClaim,
    OutputReservationSnapshot,
    OutputCommitSet,
    OutputPathClaimKind,
} from '@/domain/queue/types'
import {
    assertGenerationJobSnapshotSafe,
    createGenerationJobSnapshot,
    hashGenerationJobSnapshot,
} from './job-snapshot'

// Physical database names stay stable so generation jobs survive the rename.
export const QUEUE_DATABASE_NAME = 'nai-blue-durable-generation-queue'
export const QUEUE_DATABASE_VERSION = 9

const STORE_NAMES = [
    'attempts', 'batches', 'jobs', 'leases', 'output-reservation-claims', 'output-reservations', 'resources',
] as const
type QueueStoreName = typeof STORE_NAMES[number]

export type QueueRepositoryErrorCode =
    | 'GENERATION_ATOMIC_BATCH_UNAVAILABLE'
    | 'GENERATION_ATOMIC_BATCH_LIMIT_EXCEEDED'
    | 'E_QUEUE_DB_UNAVAILABLE'
    | 'E_QUEUE_DB_BLOCKED'
    | 'E_QUEUE_SCHEMA_NEWER'
    | 'E_QUEUE_TRANSACTION_ABORTED'
    | 'E_QUEUE_WRITE_VERIFY'
    | 'E_QUEUE_RECORD_INVALID'
    | 'E_QUEUE_NOT_FOUND'
    | 'E_QUEUE_BATCH_NOT_FOUND'
    | 'E_QUEUE_IDEMPOTENCY_CONFLICT'
    | 'E_QUEUE_INVALID_TRANSITION'
    | 'E_QUEUE_TERMINAL_IMMUTABLE'
    | 'E_QUEUE_LEASE_LOST'
    | 'E_QUEUE_CANCEL_REQUESTED'

export class QueueRepositoryError extends Error {
    constructor(
        readonly code: QueueRepositoryErrorCode,
        message: string,
        readonly generationLimits: GenerationAtomicBatchLimits | null = null,
    ) {
        super(message)
        this.name = 'QueueRepositoryError'
    }
}

interface StoredJobRecord {
    recordSchemaVersion: 4
    id: string
    batchId: string
    workflow: GenerationWorkflow
    sceneId: string | null
    state: GenerationJobState
    createdAt: string
    updatedAt: string
    priority: number
    /** Denormalized batch order required by IndexedDB's join-free global index. */
    queueSequence: number
    ordinal: number
    snapshotSchemaVersion: number
    snapshot: GenerationJobSnapshot
    snapshotHash: string
    compositionPlanHash: string | null
    attemptCount: number
    maxAttempts: number
    idempotencyKey: string
    progress: GenerationJobProgress
    lastDiagnosticEventId: string | null
    outputTransactionId: string | null
    artifactReference: QueueArtifactReference | null
    blockReason: QueueBlockReason | null
    readyAt: string
    cancelRequestedAt: string | null
    cancelReason: 'user' | 'batch' | 'shutdown' | null
    retryOfJobId: string | null
    rootJobId: string
    version: number
    globalOrderKey: IDBValidKey
    batchOrderKey: IDBValidKey
    batchStateOrderKey: IDBValidKey
    stateOrderKey: IDBValidKey
}

interface LeaseRecord {
    jobId: string
    owner: string
    token: string
    expiresAt: string
    heartbeatAt: string
}

interface QueuePageCursor {
    index: 'global' | 'batch' | 'state'
    batchId: string | null
    state: GenerationJobState | null
    key: IDBValidKey
}

export interface IndexedDBQueueRepositoryOptions {
    factory?: IDBFactory
    keyRange?: typeof IDBKeyRange
    databaseName?: string
    openTimeoutMs?: number
    generationLimits?: GenerationAtomicBatchLimits | null
}

export interface CreateGenerationBatchInput {
    id: string
    workflow: GenerationWorkflow
    createdAt: string
    failurePolicy?: QueueFailurePolicy
    origin?: QueueBatchOrigin
    idempotencyKey?: string
}

export interface DurableGenerationBatchInput extends CreateGenerationBatchInput {
    failurePolicy: QueueFailurePolicy
    origin: QueueBatchOrigin
    idempotencyKey: string
}

export interface EnqueueGenerationJobInput {
    id: string
    batchId: string
    workflow: GenerationWorkflow
    sceneId: string | null
    createdAt: string
    priority: number
    ordinal: number
    snapshot: GenerationJobSnapshot
    compositionPlanHash: string | null
    maxAttempts: number
    idempotencyKey: string
    readyAt?: string
    retryOfJobId?: string | null
    rootJobId?: string
}

export interface AcquireQueueLeaseInput {
    jobId: string
    owner: string
    now: string
    ttlMs: number
}

export interface HeartbeatQueueLeaseInput extends AcquireQueueLeaseInput {
    token: string
}

export interface TransitionGenerationJobInput {
    jobId: string
    to: GenerationJobState
    now: string
    leaseOwner?: string
    leaseToken?: string
    expectedVersion?: number
    lastDiagnosticEventId?: string | null
    outputTransactionId?: string | null
    artifactReference?: QueueArtifactReference | null
    blockReason?: QueueBlockReason | null
    failureKind?: QueueFailureKind | null
}

export interface ListGenerationJobsInput {
    batchId?: string
    states?: readonly GenerationJobState[]
    cursor?: string | null
    limit?: number
}

export interface GenerationJobPage {
    items: GenerationJob[]
    nextCursor: string | null
}

export interface GenerationJobProjectionPage {
    items: GenerationJobProjection[]
    nextCursor: string | null
}

export interface ListGenerationJobProjectionWindowInput {
    batchId: string
    /** Queue Center has one status filter at a time, enabling an indexed window. */
    state?: GenerationJobState
    offset: number
    limit: number
}

export interface CreateBatchAndEnqueueInput {
    batch: DurableGenerationBatchInput
    jobs: readonly EnqueueGenerationJobInput[]
    resources?: readonly QueueResourceRecord[]
    reservations?: readonly OutputReservation[]
}

/** Shared by planning adapters and the repository trust boundary. */
export function assertGenerationAtomicBatchAvailable(
    jobCount: number,
    outputClaimCount: number,
    limits: GenerationAtomicBatchLimits | null | undefined,
): asserts limits is GenerationAtomicBatchLimits {
    if (limits === null || limits === undefined) {
        throw new QueueRepositoryError(
            'GENERATION_ATOMIC_BATCH_UNAVAILABLE',
            'Reservation-backed generation publication is unavailable on this runtime',
        )
    }
    if (jobCount > limits.maxJobsPerAtomicBatch
        || outputClaimCount > limits.maxOutputClaimsPerAtomicBatch) {
        throw new QueueRepositoryError(
            'GENERATION_ATOMIC_BATCH_LIMIT_EXCEEDED',
            `Atomic generation batch exceeds the measured maximum of ${limits.maxJobsPerAtomicBatch} jobs or ${limits.maxOutputClaimsPerAtomicBatch} output claims`,
            limits,
        )
    }
}

export interface CreateBatchAndEnqueueResult {
    batch: GenerationBatch
    jobs: GenerationJob[]
    reservations: OutputReservation[]
}

export interface QueueRepositorySchemaInspection {
    version: number
    stores: string[]
    indexes: Record<string, string[]>
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const keys = Object.keys(value)
    return keys.length === expected.length
        && expected.every(key => Object.prototype.hasOwnProperty.call(value, key))
}

export interface RecordProviderAttemptTransitionInput {
    jobId: string
    attemptNumber: number
    leaseOwner: string
    leaseToken: string
    now: string
    expectedEvidence: ProviderAttemptEvidence
    nextEvidence: ProviderAttemptEvidence
    diagnosticEventId?: string | null
    blockReason?: Extract<QueueBlockReason, 'provider-outcome-unknown' | 'provider-result-lost'>
}

export interface ReconcileProviderAttemptAfterRestartInput {
    jobId: string
    attemptNumber: number
    now: string
    expectedEvidence: ProviderAttemptEvidence
    nextEvidence: ProviderAttemptEvidence
    disposition: 'blocked' | 'queued-spooled' | 'failed-known'
    diagnosticEventId?: string | null
    blockReason?: Extract<QueueBlockReason, 'provider-outcome-unknown' | 'provider-result-lost'>
}

function projectionOutputDirectory(snapshot: GenerationJobSnapshot): string | null {
    const policy = snapshot.outputPolicy
    if (!isRecord(policy)) return null
    if (policy.workflow === 'main' && isRecord(policy.output) && typeof policy.output.directory === 'string') {
        return policy.output.directory
    }
    if (policy.workflow !== 'scene' || !isRecord(policy.outputContext)) return null
    if (typeof policy.outputContext.directory === 'string') return policy.outputContext.directory
    if (!isRecord(policy.saveContext) || typeof policy.saveContext.sceneSavePath !== 'string') return null
    const segments = Array.isArray(policy.outputContext.presetPathSegments)
        ? policy.outputContext.presetPathSegments.filter((value): value is string => typeof value === 'string')
        : typeof policy.outputContext.presetName === 'string'
            ? [policy.outputContext.presetName]
            : []
    if (typeof policy.saveContext.rotationCharacterFolderName === 'string') {
        segments.push(CHARACTER_SCENES_DIRECTORY_NAME, policy.saveContext.rotationCharacterFolderName)
    }
    if (policy.outputContext.sceneSubfoldersEnabled !== false
        && typeof policy.outputContext.sceneName === 'string') {
        segments.push(policy.outputContext.sceneName)
    }
    return [policy.saveContext.sceneSavePath, ...segments].filter(Boolean).join('/')
}

function assertTimestamp(value: unknown, field: string): asserts value is string {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', `${field} must be an ISO timestamp`)
    }
}

function assertIdentifier(value: unknown, field: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', `${field} must be a bounded identifier`)
    }
}

function assertWorkflow(value: unknown): asserts value is GenerationWorkflow {
    if (value !== 'main' && value !== 'scene' && value !== 'style-lab') {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'workflow is invalid')
    }
}

const PROVIDER_DISPATCH_STATES = new Set<ProviderDispatchState>([
    'prepared',
    'connect-failed-before-dispatch',
    'possibly-dispatched',
    'response-started',
    'response-complete',
    'result-spooled',
    'result-lost',
])
const PROVIDER_OUTCOMES = new Set<ProviderOutcome>(['running', 'known-failure', 'succeeded', 'unknown'])
const PROVIDER_BILLING_RISKS = new Set<ProviderBillingRisk>(['none', 'possible', 'confirmed'])
const PROVIDER_ATTEMPT_OUTCOMES = new Set(['running', 'succeeded', 'failed', 'cancelled', 'interrupted'])
const QUEUE_FAILURE_KINDS = new Set<QueueFailureKind>([
    'transient', 'rate-limited', 'timeout', 'authentication', 'decode', 'local-io', 'compatibility', 'fatal',
])
const PROVIDER_STATE_ORDER: Readonly<Record<ProviderDispatchState, number>> = Object.freeze({
    prepared: 0,
    'connect-failed-before-dispatch': 1,
    'possibly-dispatched': 1,
    'response-started': 2,
    'response-complete': 3,
    'result-spooled': 4,
    'result-lost': 4,
})
const BILLING_RISK_ORDER: Readonly<Record<ProviderBillingRisk, number>> = Object.freeze({
    none: 0,
    possible: 1,
    confirmed: 2,
})

type StoredAttemptRecord = GenerationAttempt & { jobAttemptKey: IDBValidKey }

function assertProviderDigest(value: unknown, field: string): asserts value is `sha256:${string}` {
    if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(value)) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', `${field} is invalid`)
    }
}

function assertProviderExecutionEnvelope(
    value: unknown,
    resources: readonly GenerationSnapshotResource[],
): asserts value is ProviderExecutionEnvelope {
    if (!isRecord(value)
        || !hasExactKeys(value, [
            'schemaVersion', 'provider', 'compatibilityProfileId', 'payloadBuilderRevision',
            'modelCatalogRevision', 'action', 'responseMode', 'semanticIntentHash', 'queueResourceBindings',
        ])
        || value.schemaVersion !== 1
        || value.provider !== 'novelai'
        || typeof value.compatibilityProfileId !== 'string'
        || typeof value.payloadBuilderRevision !== 'string'
        || typeof value.modelCatalogRevision !== 'string'
        || (value.action !== 'generate' && value.action !== 'img2img' && value.action !== 'infill')
        || (value.responseMode !== 'standard' && value.responseMode !== 'streaming')
        || !Array.isArray(value.queueResourceBindings)) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'Provider execution envelope is invalid')
    }
    assertIdentifier(value.compatibilityProfileId, 'compatibility profile id')
    assertIdentifier(value.payloadBuilderRevision, 'payload builder revision')
    assertIdentifier(value.modelCatalogRevision, 'model catalog revision')
    if (/[\\/]/.test(value.compatibilityProfileId)
        || /[\\/]/.test(value.payloadBuilderRevision)
        || /[\\/]/.test(value.modelCatalogRevision)) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'Provider envelope identifiers must not be paths')
    }
    assertProviderDigest(value.semanticIntentHash, 'semantic intent hash')
    const seenBindings = new Set<string>()
    for (const binding of value.queueResourceBindings) {
        if (!isRecord(binding)
            || !hasExactKeys(binding, ['resourceId', 'role', 'digest'])
            || typeof binding.resourceId !== 'string'
            || (binding.role !== 'source'
                && binding.role !== 'mask'
                && binding.role !== 'vibe-reference'
                && binding.role !== 'character-reference')) {
            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'Provider resource binding is invalid')
        }
        assertIdentifier(binding.resourceId, 'Provider resource id')
        if (/[\\/]/.test(binding.resourceId)) {
            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'Provider resource id must not be a path')
        }
        assertProviderDigest(binding.digest, 'Provider resource digest')
        const identity = `${binding.resourceId}\u0000${binding.role}\u0000${binding.digest}`
        if (seenBindings.has(identity)
            || !resources.some(resource => resource.resourceId === binding.resourceId
                && resource.role === binding.role
                && resource.digest === binding.digest)) {
            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'Provider resource binding does not match the snapshot')
        }
        seenBindings.add(identity)
    }
    const providerRoles = new Set(['source', 'mask', 'vibe-reference', 'character-reference'])
    const providerResources = resources.filter(resource => providerRoles.has(resource.role))
    const expectedBindings = new Set(providerResources.map(resource => (
        `${resource.resourceId}\u0000${resource.role}\u0000${resource.digest}`
    )))
    if (expectedBindings.size !== providerResources.length
        || seenBindings.size !== expectedBindings.size
        || [...expectedBindings].some(identity => !seenBindings.has(identity))) {
        throw new QueueRepositoryError(
            'E_QUEUE_RECORD_INVALID',
            'Provider resource bindings must exactly match the snapshot resources',
        )
    }
}

function assertSpoolReceipt(value: unknown, attemptId: string): asserts value is SpoolReceipt {
    if (!isRecord(value)
        || !hasExactKeys(value, [
            'schemaVersion', 'spoolId', 'attemptId', 'contentType', 'byteLength', 'sha256', 'committedAt',
        ])
        || value.schemaVersion !== 1
        || value.attemptId !== attemptId
        || typeof value.spoolId !== 'string'
        || value.spoolId.length === 0
        || value.spoolId.length > 256
        || /[\\/]/.test(value.spoolId)
        || typeof value.contentType !== 'string'
        || value.contentType.length === 0
        || value.contentType.length > 128
        || !Number.isSafeInteger(value.byteLength)
        || (value.byteLength as number) < 0) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'spool receipt is invalid')
    }
    assertProviderDigest(value.sha256, 'spool checksum')
    assertTimestamp(value.committedAt, 'spool commit time')
}

function assertProviderEvidence(value: unknown, attemptId: string): asserts value is ProviderAttemptEvidence {
    if (!isRecord(value)
        || !hasExactKeys(value, [
            'dispatchState', 'providerOutcome', 'billingRisk', 'responseDigest', 'spoolReceipt',
        ])
        || !PROVIDER_DISPATCH_STATES.has(value.dispatchState as ProviderDispatchState)
        || !PROVIDER_OUTCOMES.has(value.providerOutcome as ProviderOutcome)
        || !PROVIDER_BILLING_RISKS.has(value.billingRisk as ProviderBillingRisk)
        || (value.responseDigest !== null && typeof value.responseDigest !== 'string')
        || (value.spoolReceipt !== null && !isRecord(value.spoolReceipt))) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'provider attempt evidence is invalid')
    }
    if (value.responseDigest !== null) assertProviderDigest(value.responseDigest, 'provider response digest')
    if (value.spoolReceipt !== null) assertSpoolReceipt(value.spoolReceipt, attemptId)

    const state = value.dispatchState as ProviderDispatchState
    if (state === 'prepared'
        && (value.providerOutcome !== 'running' || value.billingRisk !== 'none'
            || value.responseDigest !== null || value.spoolReceipt !== null)) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'prepared provider evidence is inconsistent')
    }
    if (state === 'connect-failed-before-dispatch'
        && (value.providerOutcome !== 'known-failure' || value.billingRisk !== 'none'
            || value.responseDigest !== null || value.spoolReceipt !== null)) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'pre-dispatch failure evidence is inconsistent')
    }
    if ((state === 'possibly-dispatched' || state === 'response-started')
        && ((value.providerOutcome !== 'running' && value.providerOutcome !== 'unknown')
            || value.billingRisk !== 'possible'
            || value.spoolReceipt !== null || value.responseDigest !== null)) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'in-flight provider evidence is inconsistent')
    }
    if (state === 'response-complete') {
        const succeeded = value.providerOutcome === 'succeeded'
            && value.billingRisk === 'confirmed'
        const knownHttpFailure = value.providerOutcome === 'known-failure'
            && value.billingRisk === 'possible'
            && value.responseDigest === null
        if ((!succeeded && !knownHttpFailure) || value.spoolReceipt !== null) {
            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'complete response evidence is inconsistent')
        }
    }
    if (state === 'result-spooled'
        && (value.providerOutcome !== 'succeeded' || value.billingRisk !== 'confirmed'
            || value.responseDigest === null || value.spoolReceipt === null
            || value.spoolReceipt.sha256 !== value.responseDigest)) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'spooled provider evidence is inconsistent')
    }
    if (state === 'result-lost'
        && (value.providerOutcome !== 'succeeded' || value.billingRisk !== 'confirmed'
            || value.spoolReceipt !== null)) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'lost provider result evidence is inconsistent')
    }
}

function assertMonotonicProviderEvidence(from: ProviderAttemptEvidence, to: ProviderAttemptEvidence): void {
    const fromState = from.dispatchState
    const toState = to.dispatchState
    const validTerminalCorrection = fromState === 'result-spooled' && toState === 'result-lost'
    const validStateAdvance = (fromState === 'prepared'
            && (toState === 'connect-failed-before-dispatch' || toState === 'possibly-dispatched'))
        || (fromState === 'possibly-dispatched' && toState === 'response-started')
        || (fromState === 'response-started' && toState === 'response-complete')
        || (fromState === 'response-complete' && (toState === 'result-spooled' || toState === 'result-lost'))
        || validTerminalCorrection
        || (fromState === toState && from.providerOutcome === 'running' && to.providerOutcome !== 'running')
    if (!validStateAdvance
        || PROVIDER_STATE_ORDER[toState] < PROVIDER_STATE_ORDER[fromState]
        || BILLING_RISK_ORDER[to.billingRisk] < BILLING_RISK_ORDER[from.billingRisk]
        || (from.providerOutcome !== 'running'
            && fromState !== 'response-complete'
            && !validTerminalCorrection)
        || (fromState === toState && canonicalSerialize(from) === canonicalSerialize(to))) {
        throw new QueueRepositoryError('E_QUEUE_INVALID_TRANSITION', 'Provider attempt evidence must advance monotonically')
    }
}

function providerEvidenceForbidsGenericRetry(evidence: ProviderAttemptEvidence | null): boolean {
    if (evidence === null) return false
    return evidence.providerOutcome === 'unknown'
        || evidence.dispatchState === 'possibly-dispatched'
        || evidence.dispatchState === 'response-started'
        || evidence.dispatchState === 'result-spooled'
        || evidence.dispatchState === 'result-lost'
        || (evidence.dispatchState === 'response-complete' && evidence.providerOutcome === 'succeeded')
}

function parseGenerationAttempt(value: unknown): StoredAttemptRecord {
    if (!isRecord(value)
        || value.recordSchemaVersion !== 2
        || typeof value.id !== 'string'
        || typeof value.jobId !== 'string'
        || !Number.isSafeInteger(value.attemptNumber)
        || (value.attemptNumber as number) < 1
        || !Array.isArray(value.providerTransitions)
        || !PROVIDER_ATTEMPT_OUTCOMES.has(value.outcome as string)
        || (value.diagnosticEventId !== null && typeof value.diagnosticEventId !== 'string')
        || (value.failureKind !== undefined
            && value.failureKind !== null
            && !QUEUE_FAILURE_KINDS.has(value.failureKind as QueueFailureKind))) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'queue attempt record is invalid')
    }
    assertIdentifier(value.jobId, 'attempt job id')
    if (value.id !== `${value.jobId}:${value.attemptNumber}` || value.id.length > 273) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'attempt id is invalid')
    }
    assertTimestamp(value.startedAt, 'attempt start time')
    if (value.finishedAt !== null) assertTimestamp(value.finishedAt, 'attempt finish time')
    if (value.executionEnvelopeHash !== null) {
        assertProviderDigest(value.executionEnvelopeHash, 'execution envelope hash')
    }
    const expectedKey = [value.jobId, value.attemptNumber]
    if (canonicalSerialize(value.jobAttemptKey) !== canonicalSerialize(expectedKey)) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'attempt ordering key is invalid')
    }
    if (value.providerEvidence === null) {
        if (value.providerTransitions.length !== 0 || value.executionEnvelopeHash !== null) {
            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'legacy attempt evidence is inconsistent')
        }
        return value as unknown as StoredAttemptRecord
    }
    assertProviderEvidence(value.providerEvidence, value.id)
    let current: ProviderAttemptEvidence = {
        dispatchState: 'prepared', providerOutcome: 'running', billingRisk: 'none',
        responseDigest: null, spoolReceipt: null,
    }
    let previousTransitionTime = Date.parse(value.startedAt as string)
    for (const transition of value.providerTransitions) {
        if (!isRecord(transition)
            || !hasExactKeys(transition, [
                'attemptId', 'jobId', 'attemptNumber', 'occurredAt', 'from', 'to', 'diagnosticEventId',
            ])
            || transition.attemptId !== value.id
            || transition.jobId !== value.jobId
            || transition.attemptNumber !== value.attemptNumber
            || (transition.diagnosticEventId !== null && typeof transition.diagnosticEventId !== 'string')) {
            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'provider attempt transition is invalid')
        }
        assertTimestamp(transition.occurredAt, 'provider transition time')
        const transitionTime = Date.parse(transition.occurredAt)
        if (transitionTime < previousTransitionTime) {
            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'provider transition journal time moved backwards')
        }
        assertProviderEvidence(transition.from, value.id)
        assertProviderEvidence(transition.to, value.id)
        if (canonicalSerialize(transition.from) !== canonicalSerialize(current)) {
            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'provider transition chain is invalid')
        }
        assertMonotonicProviderEvidence(transition.from, transition.to)
        current = transition.to
        previousTransitionTime = transitionTime
    }
    if (canonicalSerialize(current) !== canonicalSerialize(value.providerEvidence)) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'provider evidence does not match its transition journal')
    }
    return value as unknown as StoredAttemptRecord
}

function assertFailurePolicy(value: unknown): asserts value is QueueFailurePolicy {
    if (value !== 'continue' && value !== 'pause-on-fatal' && value !== 'stop-on-first-error') {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'failure policy is invalid')
    }
}

function assertBatchOrigin(value: unknown): asserts value is QueueBatchOrigin {
    if (value !== 'fresh' && value !== 'legacy-conversion' && value !== 'retry') {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'batch origin is invalid')
    }
}

function parseBatchProjectionSummary(value: unknown, batchId: string): GenerationBatchSummary {
    if (value === undefined) return createEmptyGenerationBatchSummary(batchId)
    if (!isRecord(value)
        || value.batchId !== batchId
        || typeof value.total !== 'number'
        || !Number.isSafeInteger(value.total)
        || typeof value.completed !== 'number'
        || !Number.isSafeInteger(value.completed)
        || typeof value.progressCurrent !== 'number'
        || typeof value.progressTotal !== 'number'
        || !Number.isFinite(value.progressCurrent)
        || !Number.isFinite(value.progressTotal)
        || !isRecord(value.states)
        || !Array.isArray(value.recentCompletedAt)) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'batch projection summary is invalid')
    }
    const states = {} as Record<GenerationJobState, number>
    for (const state of GENERATION_JOB_STATES) {
        const count = value.states[state]
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'batch projection state count is invalid')
        }
        states[state] = count
    }
    const recentCompletedAt = value.recentCompletedAt
    if (recentCompletedAt.length > 20 || recentCompletedAt.some(timestamp => (
        typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))
    ))) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'batch projection completion window is invalid')
    }
    return {
        batchId,
        total: value.total as number,
        completed: value.completed as number,
        progressCurrent: value.progressCurrent as number,
        progressTotal: value.progressTotal as number,
        states,
        recentCompletedAt: [...recentCompletedAt],
    }
}

function parseBatch(value: unknown): GenerationBatch {
    if (!isRecord(value)) throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'batch record is invalid')
    assertIdentifier(value.id, 'batch id')
    assertWorkflow(value.workflow)
    assertTimestamp(value.createdAt, 'batch createdAt')
    assertTimestamp(value.updatedAt, 'batch updatedAt')
    if (value.state !== 'active' && value.state !== 'paused' && value.state !== 'stopped') {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'batch state is invalid')
    }
    assertFailurePolicy(value.failurePolicy)
    if (value.pauseReason !== null
        && value.pauseReason !== 'user'
        && value.pauseReason !== 'authentication'
        && value.pauseReason !== 'local-io'
        && value.pauseReason !== 'compatibility'
        && value.pauseReason !== 'fatal'
        && value.pauseReason !== 'first-error') {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'batch pause reason is invalid')
    }
    assertBatchOrigin(value.origin)
    assertIdentifier(value.idempotencyKey, 'batch idempotency key')
    if (!Number.isSafeInteger(value.queueSequence) || (value.queueSequence as number) < 1) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'batch queue sequence is invalid')
    }
    if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'batch version is invalid')
    }
    const projectionRevision = value.projectionRevision === undefined ? 0 : value.projectionRevision
    if (!Number.isSafeInteger(projectionRevision) || (projectionRevision as number) < 0) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'batch projection revision is invalid')
    }
    return {
        ...value,
        projectionRevision,
        projectionSummary: parseBatchProjectionSummary(value.projectionSummary, value.id as string),
    } as unknown as GenerationBatch
}

function batchFromInput(input: CreateGenerationBatchInput, queueSequence: number): GenerationBatch {
    assertIdentifier(input.id, 'batch id')
    assertWorkflow(input.workflow)
    assertTimestamp(input.createdAt, 'batch createdAt')
    const failurePolicy = input.failurePolicy ?? 'continue'
    const origin = input.origin ?? 'fresh'
    const idempotencyKey = input.idempotencyKey ?? `batch:${input.id}`
    assertFailurePolicy(failurePolicy)
    assertBatchOrigin(origin)
    assertIdentifier(idempotencyKey, 'batch idempotency key')
    if (!Number.isSafeInteger(queueSequence) || queueSequence < 1) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'batch queue sequence is invalid')
    }
    return {
        id: input.id,
        workflow: input.workflow,
        queueSequence,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        state: 'active',
        failurePolicy,
        pauseReason: null,
        origin,
        idempotencyKey,
        version: 1,
        projectionRevision: 0,
        projectionSummary: createEmptyGenerationBatchSummary(input.id),
    }
}

/**
 * Batch controls are intentionally mutable. Replaying an enqueue after pause,
 * resume, or a failure-policy edit must resolve to the original immutable
 * batch identity instead of being mistaken for different work.
 */
function hasSameBatchIdentity(left: GenerationBatch, right: GenerationBatch): boolean {
    return left.id === right.id
        && left.workflow === right.workflow
        && left.origin === right.origin
        && left.idempotencyKey === right.idempotencyKey
}

function hasSameResourceIdentity(left: QueueResourceRecord, right: QueueResourceRecord): boolean {
    return left.id === right.id
        && left.persistence === right.persistence
        && left.digest === right.digest
        && canonicalSerialize(left.reference) === canonicalSerialize(right.reference)
}

function selectResourceRecord(
    existing: QueueResourceRecord,
    candidate: QueueResourceRecord,
): QueueResourceRecord {
    if (!hasSameResourceIdentity(existing, candidate)) {
        throw new QueueRepositoryError(
            'E_QUEUE_IDEMPOTENCY_CONFLICT',
            'Resource identity already represents different content',
        )
    }
    return existing.availability === 'available' || candidate.availability !== 'available'
        ? existing
        : { ...existing, availability: 'available', updatedAt: candidate.updatedAt }
}

type StoredOutputReservation = OutputReservation & {
    /** The resolved physical path is the collision authority; bindings only detect stale plans. */
    normalizedPath?: string
    /** Missing for abandoned history so IndexedDB's unique index releases the physical path. */
    activePath?: string
}

interface StoredOutputReservationClaim extends Omit<OutputReservationClaim, 'activeCollisionKey'> {
    id: string
    /** Missing releases the sparse unique index while originalCollisionKey preserves history. */
    activeCollisionKey?: string
}

function parseOutputReservationSnapshot(value: unknown): OutputReservationSnapshot {
    if (!isRecord(value)) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'reservation snapshot is invalid')
    }
    assertIdentifier(value.reservationId, 'reservation id')
    const binding = value.folderBinding
    if (!isRecord(binding)
        || binding.resourceType !== 'generation-folder-document'
        || !Number.isSafeInteger(binding.revision)
        || (binding.revision as number) < 0
        || typeof binding.contentHash !== 'string'
        || !/^sha256:[0-9a-f]{64}$/.test(binding.contentHash)) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'reservation folder binding is invalid')
    }
    assertIdentifier(binding.resourceId, 'reservation folder resource id')
    if (value.collisionPolicy !== 'fail' && value.collisionPolicy !== 'suffix') {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'reservation collision policy is invalid')
    }
    if (value.expectedExistingDigest !== null) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'reservation existing digest is invalid')
    }
    if (typeof value.directoryIdentity !== 'string'
        || !/^sha256:[0-9a-f]{64}$/.test(value.directoryIdentity)) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'reservation directory identity is invalid')
    }
    const relativePath = typeof value.relativePath === 'string' ? value.relativePath : ''
    normalizeReservationRelativePath(relativePath)
    const legacy: LegacyOutputReservationSnapshot = {
        reservationId: value.reservationId,
        folderBinding: {
            resourceType: binding.resourceType,
            resourceId: binding.resourceId,
            revision: binding.revision as number,
            contentHash: binding.contentHash as `sha256:${string}`,
        },
        directoryIdentity: value.directoryIdentity as `sha256:${string}`,
        relativePath,
        collisionPolicy: value.collisionPolicy,
        expectedExistingDigest: null,
    }
    if (value.reservationSchemaVersion === undefined || value.reservationSchemaVersion === 0) {
        return value.reservationSchemaVersion === 0
            ? { ...legacy, reservationSchemaVersion: 0 }
            : legacy
    }
    if (value.reservationSchemaVersion !== 1 || !isRecord(value.commitSet)) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'reservation schema version is invalid')
    }
    const commitSet = value.commitSet
    if (commitSet.schemaVersion !== 1
        || typeof commitSet.directoryAuthorityId !== 'string'
        || typeof commitSet.directoryAuthorityFingerprint !== 'string'
        || !/^sha256:[0-9a-f]{64}$/.test(commitSet.directoryAuthorityFingerprint)
        || (commitSet.filesystemSemantics !== 'windows'
            && commitSet.filesystemSemantics !== 'macos'
            && commitSet.filesystemSemantics !== 'linux'
            && commitSet.filesystemSemantics !== 'android')
        || typeof commitSet.filenamePolicyRevision !== 'string'
        || typeof commitSet.pathNormalizationRevision !== 'string'
        || !Array.isArray(commitSet.claims)
        || commitSet.claims.length === 0) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'output commit set is invalid')
    }
    assertIdentifier(commitSet.directoryAuthorityId, 'directory authority id')
    assertIdentifier(commitSet.filenamePolicyRevision, 'filename policy revision')
    assertIdentifier(commitSet.pathNormalizationRevision, 'path normalization revision')
    const claimIds = new Set<string>()
    const collisionKeys = new Set<string>()
    const claims = commitSet.claims.map(claim => {
        if (!isRecord(claim)
            || typeof claim.claimId !== 'string'
            || (claim.kind !== 'image'
                && claim.kind !== 'metadata-sidecar'
                && claim.kind !== 'artifact-sidecar'
                && claim.kind !== 'diagnostic-sidecar'
                && claim.kind !== 'provider-original')
            || typeof claim.relativePath !== 'string'
            || typeof claim.collisionKey !== 'string'
            || !/^collision:sha256:[0-9a-f]{64}$/.test(claim.collisionKey)) {
            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'output commit set claim is invalid')
        }
        assertIdentifier(claim.claimId, 'claim id')
        normalizeReservationRelativePath(claim.relativePath)
        if (claimIds.has(claim.claimId) || collisionKeys.has(claim.collisionKey)) {
            throw new QueueRepositoryError('E_QUEUE_IDEMPOTENCY_CONFLICT', 'output commit set claim is duplicated')
        }
        claimIds.add(claim.claimId)
        collisionKeys.add(claim.collisionKey)
        return {
            claimId: claim.claimId,
            kind: claim.kind as OutputPathClaimKind,
            relativePath: claim.relativePath,
            collisionKey: claim.collisionKey,
        }
    })
    const parsedCommitSet: OutputCommitSet = {
        schemaVersion: 1 as const,
        directoryAuthorityId: commitSet.directoryAuthorityId,
        directoryAuthorityFingerprint: commitSet.directoryAuthorityFingerprint as `sha256:${string}`,
        filesystemSemantics: commitSet.filesystemSemantics as 'windows' | 'macos' | 'linux' | 'android',
        filenamePolicyRevision: commitSet.filenamePolicyRevision,
        pathNormalizationRevision: commitSet.pathNormalizationRevision,
        claims,
    }
    if (claims.some(claim => claim.collisionKey !== createOutputCollisionKey({
        directoryAuthorityId: parsedCommitSet.directoryAuthorityId,
        directoryAuthorityFingerprint: parsedCommitSet.directoryAuthorityFingerprint,
        filesystemSemantics: parsedCommitSet.filesystemSemantics,
        pathNormalizationRevision: parsedCommitSet.pathNormalizationRevision,
        relativePath: claim.relativePath,
    }))) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'output commit set collision key is invalid')
    }
    const commitSetHash = hashOutputCommitSet(parsedCommitSet)
    if (value.commitSetHash !== commitSetHash) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'output commit set hash is invalid')
    }
    if (parsedCommitSet.directoryAuthorityId !== binding.resourceId
        || parsedCommitSet.directoryAuthorityFingerprint !== value.directoryIdentity) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'output commit set directory authority is invalid')
    }
    if (!claims.some(claim => claim.kind === 'image' && claim.relativePath === relativePath)) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'reservation image projection is not in its commit set')
    }
    return {
        ...legacy,
        reservationSchemaVersion: 1,
        commitSet: parsedCommitSet,
        commitSetHash,
    }
}

function normalizeReservationRelativePath(relativePath: string): string {
    if (typeof relativePath !== 'string'
        || relativePath.length === 0
        || relativePath.length > 1_024
        || relativePath.includes('\\')
        || relativePath.startsWith('/')
        || /^[A-Za-z]:/.test(relativePath)) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'reservation relative path is invalid')
    }
    const segments = relativePath.split('/')
    if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'reservation relative path is invalid')
    }
    return relativePath.normalize('NFC').replace(/[A-Z]/g, character => character.toLowerCase())
}

function storedReservation(value: OutputReservation): StoredOutputReservation {
    assertIdentifier(value.batchId, 'reservation batch id')
    assertIdentifier(value.jobId, 'reservation job id')
    const snapshot = parseOutputReservationSnapshot(value)
    if (value.state !== 'reserved'
        && value.state !== 'storage-pending'
        && value.state !== 'writing'
        && value.state !== 'committed'
        && value.state !== 'conflict'
        && value.state !== 'abandoned') {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'reservation state is invalid')
    }
    if (snapshot.reservationSchemaVersion === 1) {
        if (!('version' in value) || !Number.isSafeInteger(value.version) || value.version < 1) {
            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'reservation version is invalid')
        }
        if (!('updatedAt' in value)) {
            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'reservation updatedAt is missing')
        }
        assertTimestamp(value.updatedAt, 'reservation updatedAt')
        return {
            ...snapshot,
            batchId: value.batchId,
            jobId: value.jobId,
            state: value.state,
            version: value.version,
            updatedAt: value.updatedAt,
        }
    }
    const normalizedPath = normalizeReservationRelativePath(snapshot.relativePath)
    const activePath = `${snapshot.directoryIdentity}/${normalizedPath}`
    return {
        ...snapshot,
        batchId: value.batchId,
        jobId: value.jobId,
        state: value.state,
        normalizedPath,
        ...(value.state === 'abandoned' || value.state === 'committed' ? {} : { activePath }),
    }
}

function parseOutputReservation(value: unknown): OutputReservation {
    if (!isRecord(value)) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'reservation record is invalid')
    }
    const parsed = storedReservation(value as unknown as OutputReservation)
    if (parsed.reservationSchemaVersion === 1) {
        if (value.normalizedPath !== undefined || value.activePath !== undefined) {
            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'commit-set reservation has a legacy active path')
        }
    } else {
        if (canonicalSerialize(value.normalizedPath) !== canonicalSerialize(parsed.normalizedPath)) {
            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'reservation normalized path is invalid')
        }
        if (value.activePath !== parsed.activePath) {
            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'reservation active path is invalid')
        }
    }
    const { normalizedPath: _normalizedPath, activePath: _activePath, ...reservation } = parsed
    return reservation
}

function hasSameReservationIdentity(left: OutputReservation, right: OutputReservation): boolean {
    return left.reservationId === right.reservationId
        && left.batchId === right.batchId
        && left.jobId === right.jobId
        && canonicalSerialize(left.folderBinding) === canonicalSerialize(right.folderBinding)
        && left.directoryIdentity === right.directoryIdentity
        && left.relativePath === right.relativePath
        && left.collisionPolicy === right.collisionPolicy
        && left.expectedExistingDigest === right.expectedExistingDigest
        && left.reservationSchemaVersion === right.reservationSchemaVersion
        && (left.reservationSchemaVersion !== 1 || (right.reservationSchemaVersion === 1
            && left.commitSetHash === right.commitSetHash))
}

function snapshotForReservation(reservation: OutputReservation): OutputReservationSnapshot {
    const base = {
        reservationId: reservation.reservationId,
        folderBinding: reservation.folderBinding,
        directoryIdentity: reservation.directoryIdentity,
        relativePath: reservation.relativePath,
        collisionPolicy: reservation.collisionPolicy,
        expectedExistingDigest: reservation.expectedExistingDigest,
    }
    if (reservation.reservationSchemaVersion === 1) {
        return {
            ...base,
            reservationSchemaVersion: 1,
            commitSet: reservation.commitSet,
            commitSetHash: reservation.commitSetHash,
        }
    }
    return reservation.reservationSchemaVersion === 0
        ? { ...base, reservationSchemaVersion: 0 }
        : base
}

function storedClaimsForReservation(reservation: OutputReservation): StoredOutputReservationClaim[] {
    if (reservation.reservationSchemaVersion !== 1) return []
    const active = reservation.state !== 'committed' && reservation.state !== 'abandoned'
    return reservation.commitSet.claims.map(claim => ({
        id: `${reservation.reservationId}\u0000${claim.claimId}`,
        claimId: claim.claimId,
        reservationId: reservation.reservationId,
        originalCollisionKey: claim.collisionKey,
        ...(active ? { activeCollisionKey: claim.collisionKey } : {}),
        kind: claim.kind,
        relativePath: claim.relativePath,
    }))
}

function parseOutputReservationClaim(value: unknown): OutputReservationClaim {
    if (!isRecord(value)
        || typeof value.id !== 'string'
        || typeof value.claimId !== 'string'
        || typeof value.reservationId !== 'string'
        || value.id !== `${value.reservationId}\u0000${value.claimId}`
        || typeof value.originalCollisionKey !== 'string'
        || !/^collision:sha256:[0-9a-f]{64}$/.test(value.originalCollisionKey)
        || (value.activeCollisionKey !== undefined && value.activeCollisionKey !== value.originalCollisionKey)
        || (value.kind !== 'image'
            && value.kind !== 'metadata-sidecar'
            && value.kind !== 'artifact-sidecar'
            && value.kind !== 'diagnostic-sidecar'
            && value.kind !== 'provider-original')
        || typeof value.relativePath !== 'string') {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'output reservation claim is invalid')
    }
    assertIdentifier(value.claimId, 'claim id')
    assertIdentifier(value.reservationId, 'reservation id')
    normalizeReservationRelativePath(value.relativePath)
    return {
        claimId: value.claimId,
        reservationId: value.reservationId,
        originalCollisionKey: value.originalCollisionKey,
        activeCollisionKey: value.activeCollisionKey ?? null,
        kind: value.kind,
        relativePath: value.relativePath,
    }
}

function withReservationState(
    reservation: OutputReservation,
    state: OutputReservation['state'],
    updatedAt: string,
): OutputReservation {
    return reservation.reservationSchemaVersion === 1
        ? { ...reservation, state, version: reservation.version + 1, updatedAt }
        : { ...reservation, state }
}

async function releaseReservationClaims(store: IDBObjectStore, reservationId: string): Promise<void> {
    const claims = await requestResult(store.index('by-reservation-id').getAll(reservationId)) as StoredOutputReservationClaim[]
    await Promise.all(claims.map(claim => requestResult(store.put({
        ...claim,
        activeCollisionKey: undefined,
    }))))
}

function assertProgress(value: unknown): asserts value is GenerationJobProgress {
    if (!isRecord(value)
        || typeof value.stage !== 'string'
        || typeof value.current !== 'number'
        || typeof value.total !== 'number'
        || !Number.isFinite(value.current)
        || !Number.isFinite(value.total)
        || value.current < 0
        || value.total < 0
        || value.current > value.total) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'job progress is invalid')
    }
}

function snapshotFromRecord(value: unknown, expectedHash: unknown): GenerationJobSnapshot {
    if (!isRecord(value)
        || value.schemaVersion !== 1
        || !isRecord(value.prompt)
        || typeof value.prompt.positive !== 'string'
        || typeof value.prompt.negative !== 'string'
        || !Array.isArray(value.resources)
        || (value.resumability !== 'resumable' && value.resumability !== 'non-resumable')) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'job snapshot is invalid')
    }
    const legacySnapshot = createGenerationJobSnapshot({
        prompt: {
            positive: value.prompt.positive,
            negative: value.prompt.negative,
        },
        parameters: value.parameters,
        outputPolicy: value.outputPolicy,
        resources: value.resources as unknown as GenerationJobSnapshot['resources'],
        resumability: value.resumability,
        ...(value.nonResumableReason === undefined
            ? {}
            : { nonResumableReason: value.nonResumableReason as 'volatile-resource' | 'runtime-only-capability' }),
    })
    const providerSnapshot: GenerationJobSnapshot = value.providerExecutionEnvelope === undefined
        ? legacySnapshot
        : (() => {
            assertProviderExecutionEnvelope(
                value.providerExecutionEnvelope,
                value.resources as unknown as GenerationSnapshotResource[],
            )
            return {
                ...legacySnapshot,
                providerExecutionEnvelope: structuredClone(value.providerExecutionEnvelope),
            }
        })()
    const snapshot: GenerationJobSnapshot = value.outputReservation === undefined
        ? providerSnapshot
        : {
            ...providerSnapshot,
            outputReservation: parseOutputReservationSnapshot(value.outputReservation),
        }
    assertGenerationJobSnapshotSafe(snapshot)
    if (typeof expectedHash !== 'string' || hashGenerationJobSnapshot(snapshot) !== expectedHash) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'job snapshot hash mismatch')
    }
    return snapshot
}

function orderKeys(input: Pick<
    StoredJobRecord,
    'batchId' | 'state' | 'priority' | 'queueSequence' | 'ordinal' | 'createdAt' | 'id'
>) {
    const globalSuffix: IDBValidKey[] = [
        -input.priority,
        input.queueSequence,
        input.ordinal,
        input.createdAt,
        input.id,
    ]
    const batchSuffix: IDBValidKey[] = [-input.priority, input.ordinal, input.createdAt, input.id]
    return {
        globalOrderKey: globalSuffix,
        batchOrderKey: [input.batchId, ...batchSuffix],
        batchStateOrderKey: [input.batchId, input.state, ...batchSuffix],
        stateOrderKey: [input.state, ...globalSuffix],
    }
}

function parseStoredJob(value: unknown): StoredJobRecord {
    if (!isRecord(value) || value.recordSchemaVersion !== 4) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'job record schema is invalid')
    }
    assertIdentifier(value.id, 'job id')
    assertIdentifier(value.batchId, 'batch id')
    assertWorkflow(value.workflow)
    if (value.sceneId !== null && typeof value.sceneId !== 'string') {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'scene id is invalid')
    }
    if (!isGenerationJobState(value.state)) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'job state is invalid')
    }
    assertTimestamp(value.createdAt, 'createdAt')
    assertTimestamp(value.updatedAt, 'updatedAt')
    const numericFields: Record<string, unknown> = {
        priority: value.priority,
        queueSequence: value.queueSequence,
        ordinal: value.ordinal,
        snapshotSchemaVersion: value.snapshotSchemaVersion,
        attemptCount: value.attemptCount,
        maxAttempts: value.maxAttempts,
        version: value.version,
    }
    for (const [field, numericValue] of Object.entries(numericFields)) {
        if (!Number.isSafeInteger(numericValue) || (numericValue as number) < 0) {
            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', `${field} is invalid`)
        }
    }
    if ((value.queueSequence as number) < 1
        || (value.maxAttempts as number) < 1
        || (value.attemptCount as number) > (value.maxAttempts as number)) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'job queue sequence or attempt budget is invalid')
    }
    assertIdentifier(value.idempotencyKey, 'idempotency key')
    assertProgress(value.progress)
    assertTimestamp(value.readyAt, 'readyAt')
    if (value.cancelRequestedAt !== null) assertTimestamp(value.cancelRequestedAt, 'cancelRequestedAt')
    if (value.cancelReason !== null
        && value.cancelReason !== 'user'
        && value.cancelReason !== 'batch'
        && value.cancelReason !== 'shutdown') {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'cancel reason is invalid')
    }
    if (value.retryOfJobId !== null) assertIdentifier(value.retryOfJobId, 'retry source job id')
    assertIdentifier(value.rootJobId, 'root job id')
    const snapshot = snapshotFromRecord(value.snapshot, value.snapshotHash)
    const parsed = {
        ...value,
        snapshot,
    } as unknown as StoredJobRecord
    const expectedOrder = orderKeys(parsed)
    if (canonicalSerialize(parsed.globalOrderKey) !== canonicalSerialize(expectedOrder.globalOrderKey)
        || canonicalSerialize(parsed.batchOrderKey) !== canonicalSerialize(expectedOrder.batchOrderKey)
        || canonicalSerialize(parsed.batchStateOrderKey) !== canonicalSerialize(expectedOrder.batchStateOrderKey)
        || canonicalSerialize(parsed.stateOrderKey) !== canonicalSerialize(expectedOrder.stateOrderKey)) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'job ordering index is invalid')
    }
    return parsed
}

function parseLease(value: unknown): LeaseRecord | null {
    if (value === undefined || value === null) return null
    if (!isRecord(value)) throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'lease record is invalid')
    assertIdentifier(value.jobId, 'lease job id')
    assertIdentifier(value.owner, 'lease owner')
    assertIdentifier(value.token, 'lease token')
    assertTimestamp(value.expiresAt, 'lease expiry')
    assertTimestamp(value.heartbeatAt, 'lease heartbeat')
    return value as unknown as LeaseRecord
}

function aggregateJob(stored: StoredJobRecord, lease: LeaseRecord | null): GenerationJob {
    return {
        id: stored.id,
        batchId: stored.batchId,
        workflow: stored.workflow,
        sceneId: stored.sceneId,
        state: stored.state,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
        priority: stored.priority,
        ordinal: stored.ordinal,
        snapshotSchemaVersion: stored.snapshotSchemaVersion,
        snapshot: stored.snapshot,
        snapshotHash: stored.snapshotHash,
        compositionPlanHash: stored.compositionPlanHash,
        attemptCount: stored.attemptCount,
        maxAttempts: stored.maxAttempts,
        idempotencyKey: stored.idempotencyKey,
        leaseOwner: lease?.owner ?? null,
        leaseToken: lease?.token ?? null,
        leaseExpiresAt: lease?.expiresAt ?? null,
        heartbeatAt: lease?.heartbeatAt ?? null,
        progress: { ...stored.progress },
        lastDiagnosticEventId: stored.lastDiagnosticEventId,
        outputTransactionId: stored.outputTransactionId,
        artifactReference: stored.artifactReference === null ? null : { ...stored.artifactReference },
        blockReason: stored.blockReason,
        readyAt: stored.readyAt,
        cancelRequestedAt: stored.cancelRequestedAt,
        cancelReason: stored.cancelReason,
        retryOfJobId: stored.retryOfJobId,
        rootJobId: stored.rootJobId,
        version: stored.version,
    }
}

function storedJobFromInput(input: EnqueueGenerationJobInput, queueSequence: number): StoredJobRecord {
    assertIdentifier(input.id, 'job id')
    assertIdentifier(input.batchId, 'batch id')
    assertWorkflow(input.workflow)
    assertTimestamp(input.createdAt, 'createdAt')
    assertTimestamp(input.readyAt ?? input.createdAt, 'readyAt')
    assertIdentifier(input.idempotencyKey, 'idempotency key')
    if (input.retryOfJobId !== undefined && input.retryOfJobId !== null) {
        assertIdentifier(input.retryOfJobId, 'retry source job id')
    }
    if (input.rootJobId !== undefined) assertIdentifier(input.rootJobId, 'root job id')
    if (!Number.isSafeInteger(input.priority)
        || !Number.isSafeInteger(input.ordinal)
        || input.ordinal < 0
        || !Number.isSafeInteger(input.maxAttempts)
        || input.maxAttempts < 1
        || !Number.isSafeInteger(queueSequence)
        || queueSequence < 1) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'job ordering or attempt budget is invalid')
    }
    assertGenerationJobSnapshotSafe(input.snapshot)
    if (input.snapshot.providerExecutionEnvelope !== undefined) {
        assertProviderExecutionEnvelope(input.snapshot.providerExecutionEnvelope, input.snapshot.resources)
    }
    const base = {
        recordSchemaVersion: 4 as const,
        id: input.id,
        batchId: input.batchId,
        workflow: input.workflow,
        sceneId: input.sceneId,
        state: 'queued' as const,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        priority: input.priority,
        queueSequence,
        ordinal: input.ordinal,
        snapshotSchemaVersion: input.snapshot.schemaVersion,
        snapshot: input.snapshot,
        snapshotHash: hashGenerationJobSnapshot(input.snapshot),
        compositionPlanHash: input.compositionPlanHash,
        attemptCount: 0,
        maxAttempts: input.maxAttempts,
        idempotencyKey: input.idempotencyKey,
        progress: { stage: 'queued', current: 0, total: 0 },
        lastDiagnosticEventId: null,
        outputTransactionId: null,
        artifactReference: null,
        blockReason: null,
        readyAt: input.readyAt ?? input.createdAt,
        cancelRequestedAt: null,
        cancelReason: null,
        retryOfJobId: input.retryOfJobId ?? null,
        rootJobId: input.rootJobId ?? input.retryOfJobId ?? input.id,
        version: 1,
    }
    return { ...base, ...orderKeys(base) }
}

function migrateLegacyJob(
    value: unknown,
    queueSequence: number,
): { job: StoredJobRecord; lease: LeaseRecord | null } {
    if (!isRecord(value)
        || (value.recordSchemaVersion !== 1
            && value.recordSchemaVersion !== 2
            && value.recordSchemaVersion !== 3)) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'legacy queue job is invalid')
    }
    const preservesV3RuntimeFields = value.recordSchemaVersion === 3
    const candidate: Record<string, unknown> = {
        ...value,
        recordSchemaVersion: 4,
        queueSequence,
        readyAt: typeof value.readyAt === 'string' ? value.readyAt : value.createdAt,
        cancelRequestedAt: preservesV3RuntimeFields ? value.cancelRequestedAt : null,
        cancelReason: preservesV3RuntimeFields ? value.cancelReason : null,
        retryOfJobId: preservesV3RuntimeFields ? value.retryOfJobId : null,
        rootJobId: preservesV3RuntimeFields ? value.rootJobId : value.id,
    }
    delete candidate.leaseOwner
    delete candidate.leaseToken
    delete candidate.leaseExpiresAt
    delete candidate.heartbeatAt
    const orderingCandidate = candidate as Record<string, unknown>
    if (typeof orderingCandidate.batchId === 'string'
        && typeof orderingCandidate.state === 'string'
        && typeof orderingCandidate.priority === 'number'
        && typeof orderingCandidate.ordinal === 'number'
        && typeof orderingCandidate.createdAt === 'string'
        && typeof orderingCandidate.id === 'string') {
        Object.assign(orderingCandidate, orderKeys(orderingCandidate as unknown as StoredJobRecord))
    }
    const job = parseStoredJob(candidate)
    const hasLease = value.recordSchemaVersion === 1 && (typeof value.leaseOwner === 'string'
        || typeof value.leaseExpiresAt === 'string'
        || typeof value.heartbeatAt === 'string')
    if (!hasLease) return { job, lease: null }
    if (typeof value.leaseOwner !== 'string'
        || typeof value.leaseExpiresAt !== 'string'
        || typeof value.heartbeatAt !== 'string') {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'legacy lease is incomplete')
    }
    return {
        job,
        lease: {
            jobId: job.id,
            owner: value.leaseOwner,
            token: typeof value.leaseToken === 'string' ? value.leaseToken : `migrated:${job.id}`,
            expiresAt: value.leaseExpiresAt,
            heartbeatAt: value.heartbeatAt,
        },
    }
}

function migrateLegacyBatch(value: unknown, queueSequence: number): GenerationBatch {
    if (!isRecord(value)) throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'legacy batch is invalid')
    return parseBatch({
        ...value,
        state: value.state ?? 'active',
        failurePolicy: value.failurePolicy ?? 'continue',
        pauseReason: value.pauseReason ?? null,
        origin: value.origin ?? 'fresh',
        idempotencyKey: value.idempotencyKey ?? `batch:${String(value.id ?? '')}`,
        version: value.version ?? 1,
        queueSequence,
    })
}

function ensureIndex(store: IDBObjectStore, name: string, keyPath: string, options?: IDBIndexParameters): void {
    if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, options)
}

function ensureCurrentIndexes(transaction: IDBTransaction): void {
    const jobs = transaction.objectStore('jobs')
    ensureIndex(jobs, 'by-idempotency-key', 'idempotencyKey', { unique: true })
    ensureIndex(jobs, 'by-global-order', 'globalOrderKey')
    ensureIndex(jobs, 'by-batch-order', 'batchOrderKey')
    ensureIndex(jobs, 'by-batch-state-order', 'batchStateOrderKey')
    ensureIndex(jobs, 'by-state-order', 'stateOrderKey')
    ensureIndex(jobs, 'by-output-transaction', 'outputTransactionId', { unique: true })
    const attempts = transaction.objectStore('attempts')
    ensureIndex(attempts, 'by-job-attempt', 'jobAttemptKey', { unique: true })
    const leases = transaction.objectStore('leases')
    ensureIndex(leases, 'by-expires-at', 'expiresAt')
    const resources = transaction.objectStore('resources')
    ensureIndex(resources, 'by-digest', 'digest')
    const reservations = transaction.objectStore('output-reservations')
    ensureIndex(reservations, 'by-normalized-path', 'activePath', { unique: true })
    ensureIndex(reservations, 'by-job-id', 'jobId')
    const reservationClaims = transaction.objectStore('output-reservation-claims')
    ensureIndex(reservationClaims, 'by-reservation-id', 'reservationId')
    ensureIndex(reservationClaims, 'by-active-collision-key', 'activeCollisionKey', { unique: true })
    const batches = transaction.objectStore('batches')
    ensureIndex(batches, 'by-created-at', 'createdAt')
    ensureIndex(batches, 'by-idempotency-key', 'idempotencyKey', { unique: true })
    ensureIndex(batches, 'by-queue-sequence', 'queueSequence', { unique: true })
}

function upgradeQueueDatabase(database: IDBDatabase, transaction: IDBTransaction, oldVersion: number): void {
    if (oldVersion < 1) {
        database.createObjectStore('batches', { keyPath: 'id' })
        database.createObjectStore('jobs', { keyPath: 'id' })
        database.createObjectStore('attempts', { keyPath: 'id' })
    }
    if (oldVersion < 2) {
        if (!database.objectStoreNames.contains('leases')) {
            database.createObjectStore('leases', { keyPath: 'jobId' })
        }
        if (!database.objectStoreNames.contains('resources')) {
            database.createObjectStore('resources', { keyPath: 'id' })
        }
    }
    if (oldVersion < 7 && !database.objectStoreNames.contains('output-reservations')) {
        database.createObjectStore('output-reservations', { keyPath: 'reservationId' })
    }
    if (oldVersion < 9 && !database.objectStoreNames.contains('output-reservation-claims')) {
        database.createObjectStore('output-reservation-claims', { keyPath: 'id' })
    }
    ensureCurrentIndexes(transaction)

    if (oldVersion < 5) {
        const batches = transaction.objectStore('batches')
        const jobs = transaction.objectStore('jobs')
        const leases = transaction.objectStore('leases')
        const batchSequenceById = new Map<string, number>()
        const summaries = new Map<string, GenerationBatchSummary>()
        const batchRequest = batches.getAll()
        batchRequest.onsuccess = () => {
            try {
                const orderedBatches = (batchRequest.result as unknown[])
                    .map(value => {
                        if (!isRecord(value)) {
                            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'legacy batch is invalid')
                        }
                        assertIdentifier(value.id, 'batch id')
                        assertTimestamp(value.createdAt, 'batch createdAt')
                        return value
                    })
                    .sort((left, right) => (
                        String(left.createdAt).localeCompare(String(right.createdAt))
                        || String(left.id).localeCompare(String(right.id))
                    ))
                orderedBatches.forEach((value, index) => {
                    const batch = migrateLegacyBatch(value, index + 1)
                    batchSequenceById.set(batch.id, batch.queueSequence)
                    batches.put(batch)
                })

                const jobCursorRequest = jobs.openCursor()
                jobCursorRequest.onsuccess = () => {
                    const cursor = jobCursorRequest.result
                    if (cursor === null) {
                        if (oldVersion >= 4) return
                        const summaryCursorRequest = batches.openCursor()
                        summaryCursorRequest.onsuccess = () => {
                            const batchCursor = summaryCursorRequest.result
                            if (batchCursor === null) return
                            try {
                                const batch = parseBatch(batchCursor.value)
                                const summary = summaries.get(batch.id)
                                    ?? createEmptyGenerationBatchSummary(batch.id)
                                batchCursor.update({
                                    ...batch,
                                    projectionRevision: summary.total > 0 ? 1 : 0,
                                    projectionSummary: summary,
                                })
                                batchCursor.continue()
                            } catch {
                                transaction.abort()
                            }
                        }
                        summaryCursorRequest.onerror = () => transaction.abort()
                        return
                    }
                    try {
                        const value = cursor.value as unknown
                        if (!isRecord(value) || typeof value.batchId !== 'string') {
                            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'legacy queue job is invalid')
                        }
                        const queueSequence = batchSequenceById.get(value.batchId)
                        if (queueSequence === undefined) {
                            throw new QueueRepositoryError(
                                'E_QUEUE_BATCH_NOT_FOUND',
                                'Legacy queue job references a missing batch',
                            )
                        }
                        const migrated = migrateLegacyJob(value, queueSequence)
                        const current = summaries.get(migrated.job.batchId)
                            ?? createEmptyGenerationBatchSummary(migrated.job.batchId)
                        summaries.set(
                            migrated.job.batchId,
                            applyGenerationJobProjectionDelta(current, null, projectStoredJob(migrated.job)),
                        )
                        cursor.update(migrated.job)
                        if (migrated.lease !== null) leases.put(migrated.lease)
                        cursor.continue()
                    } catch {
                        transaction.abort()
                    }
                }
                jobCursorRequest.onerror = () => transaction.abort()
            } catch {
                transaction.abort()
            }
        }
        batchRequest.onerror = () => transaction.abort()
    }
    if (oldVersion < 6) {
        const attempts = transaction.objectStore('attempts')
        const cursorRequest = attempts.openCursor()
        cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result
            if (cursor === null) return
            if (!isRecord(cursor.value)) {
                transaction.abort()
                return
            }
            cursor.update({
                ...cursor.value,
                recordSchemaVersion: 2,
                providerEvidence: null,
                providerTransitions: [],
                executionEnvelopeHash: null,
            })
            cursor.continue()
        }
        cursorRequest.onerror = () => transaction.abort()
    }
    if (oldVersion === 7) {
        const reservations = transaction.objectStore('output-reservations')
        const reservationCursor = reservations.openCursor()
        reservationCursor.onsuccess = () => {
            const cursor = reservationCursor.result
            if (cursor === null) return
            try {
                if (!isRecord(cursor.value)
                    || typeof cursor.value.reservationId !== 'string'
                    || typeof cursor.value.relativePath !== 'string') {
                    throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'V7 output reservation is invalid')
                }
                const normalizedPath = normalizeReservationRelativePath(cursor.value.relativePath)
                const directoryIdentity = legacyReservationDirectoryIdentity(
                    cursor.value.reservationId,
                    cursor.value.relativePath,
                )
                cursor.update({
                    ...cursor.value,
                    reservationSchemaVersion: 0,
                    directoryIdentity,
                    normalizedPath,
                    ...(cursor.value.state === 'abandoned'
                        ? { activePath: undefined }
                        : { activePath: `${directoryIdentity}/${normalizedPath}` }),
                })
                cursor.continue()
            } catch {
                transaction.abort()
            }
        }
        reservationCursor.onerror = () => transaction.abort()

        const jobs = transaction.objectStore('jobs')
        const jobCursor = jobs.openCursor()
        jobCursor.onsuccess = () => {
            const cursor = jobCursor.result
            if (cursor === null) return
            try {
                if (!isRecord(cursor.value) || !isRecord(cursor.value.snapshot)) {
                    throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'V7 queue job is invalid')
                }
                const outputReservation = cursor.value.snapshot.outputReservation
                if (isRecord(outputReservation)
                    && typeof outputReservation.reservationId === 'string'
                    && typeof outputReservation.relativePath === 'string'
                    && outputReservation.directoryIdentity === undefined) {
                    const snapshot = {
                        ...cursor.value.snapshot,
                        outputReservation: {
                            ...outputReservation,
                            reservationSchemaVersion: 0,
                            directoryIdentity: legacyReservationDirectoryIdentity(
                                outputReservation.reservationId,
                                outputReservation.relativePath,
                            ),
                        },
                    } as unknown as GenerationJobSnapshot
                    cursor.update({
                        ...cursor.value,
                        snapshot,
                        snapshotHash: hashGenerationJobSnapshot(snapshot),
                    })
                }
                cursor.continue()
            } catch {
                transaction.abort()
            }
        }
        jobCursor.onerror = () => transaction.abort()
    }
    if (oldVersion === 8) {
        const reservations = transaction.objectStore('output-reservations')
        const reservationCursor = reservations.openCursor()
        reservationCursor.onsuccess = () => {
            const cursor = reservationCursor.result
            if (cursor === null) return
            if (!isRecord(cursor.value)) {
                transaction.abort()
                return
            }
            cursor.update({ ...cursor.value, reservationSchemaVersion: 0 })
            cursor.continue()
        }
        reservationCursor.onerror = () => transaction.abort()

        const jobs = transaction.objectStore('jobs')
        const jobCursor = jobs.openCursor()
        jobCursor.onsuccess = () => {
            const cursor = jobCursor.result
            if (cursor === null) return
            if (!isRecord(cursor.value) || !isRecord(cursor.value.snapshot)) {
                transaction.abort()
                return
            }
            const outputReservation = cursor.value.snapshot.outputReservation
            if (isRecord(outputReservation)) {
                const snapshot = {
                    ...cursor.value.snapshot,
                    outputReservation: { ...outputReservation, reservationSchemaVersion: 0 },
                }
                cursor.update({
                    ...cursor.value,
                    snapshot,
                    snapshotHash: hashGenerationJobSnapshot(snapshot as unknown as GenerationJobSnapshot),
                })
            }
            cursor.continue()
        }
        jobCursor.onerror = () => transaction.abort()
    }
}

/** V7 lacked a local directory authority; this stable placeholder preserves data but cannot pass real preflight. */
function legacyReservationDirectoryIdentity(
    reservationId: string,
    relativePath: string,
): `sha256:${string}` {
    return `sha256:${hashCanonicalValue({ legacyOutputReservation: { reservationId, relativePath } })}`
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
    })
}

async function allocateQueueSequence(store: IDBObjectStore): Promise<number> {
    const cursor = await requestResult(store.index('by-queue-sequence').openCursor(null, 'prev'))
    if (cursor === null) return 1
    const next = parseBatch(cursor.value).queueSequence + 1
    if (!Number.isSafeInteger(next)) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'Queue sequence space is exhausted')
    }
    return next
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(transaction.error ?? new DOMException('Transaction aborted', 'AbortError'))
        transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    })
}

function normalizeRepositoryError(error: unknown): QueueRepositoryError {
    if (error instanceof QueueRepositoryError) return error
    if (error instanceof QueueStateTransitionError) {
        return new QueueRepositoryError('E_QUEUE_INVALID_TRANSITION', error.message)
    }
    const name = isRecord(error) && typeof error.name === 'string' ? error.name : ''
    if (name === 'VersionError') {
        return new QueueRepositoryError('E_QUEUE_SCHEMA_NEWER', 'Queue database uses a newer schema')
    }
    if (name === 'AbortError' || name === 'ConstraintError') {
        return new QueueRepositoryError('E_QUEUE_TRANSACTION_ABORTED', 'Queue transaction was aborted')
    }
    return new QueueRepositoryError('E_QUEUE_DB_UNAVAILABLE', 'Queue database operation failed')
}

function encodeCursor(cursor: QueuePageCursor): string {
    return encodeURIComponent(JSON.stringify(cursor))
}

function decodeCursor(value: string): QueuePageCursor {
    let parsed: unknown
    try {
        parsed = JSON.parse(decodeURIComponent(value)) as unknown
    } catch {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'Queue page cursor is invalid')
    }
    if (!isRecord(parsed)
        || (parsed.index !== 'global' && parsed.index !== 'batch' && parsed.index !== 'state')
        || !('key' in parsed)) {
        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'Queue page cursor is invalid')
    }
    return parsed as unknown as QueuePageCursor
}

function updateJobState(stored: StoredJobRecord, state: GenerationJobState, now: string): StoredJobRecord {
    const next = {
        ...stored,
        state,
        updatedAt: now,
        version: stored.version + 1,
    }
    return { ...next, ...orderKeys(next) }
}

export class IndexedDBQueueRepository {
    private readonly factory: IDBFactory
    private readonly keyRange: typeof IDBKeyRange
    private readonly databaseName: string
    private readonly openTimeoutMs: number
    private readonly generationLimits: GenerationAtomicBatchLimits | null
    private databasePromise: Promise<IDBDatabase> | null = null
    private activeDatabase: IDBDatabase | null = null

    constructor(options: IndexedDBQueueRepositoryOptions = {}) {
        const factory = options.factory ?? globalThis.indexedDB
        const keyRange = options.keyRange ?? globalThis.IDBKeyRange
        if (factory === undefined || keyRange === undefined) {
            throw new QueueRepositoryError('E_QUEUE_DB_UNAVAILABLE', 'IndexedDB is unavailable')
        }
        this.factory = factory
        this.keyRange = keyRange
        this.databaseName = options.databaseName ?? QUEUE_DATABASE_NAME
        this.openTimeoutMs = options.openTimeoutMs ?? 10_000
        this.generationLimits = options.generationLimits ?? null
    }

    initialize(): Promise<void> {
        return this.open().then(() => undefined)
    }

    close(): void {
        this.activeDatabase?.close()
        this.activeDatabase = null
        this.databasePromise = null
    }

    private open(): Promise<IDBDatabase> {
        if (this.databasePromise !== null) return this.databasePromise
        this.databasePromise = new Promise((resolve, reject) => {
            let settled = false
            const timeout = setTimeout(() => {
                if (settled) return
                settled = true
                reject(new QueueRepositoryError('E_QUEUE_DB_UNAVAILABLE', 'Queue database open timed out'))
            }, this.openTimeoutMs)
            const finishResolve = (database: IDBDatabase) => {
                if (settled) return
                settled = true
                clearTimeout(timeout)
                this.activeDatabase = database
                database.onversionchange = () => this.close()
                resolve(database)
            }
            const finishReject = (error: unknown) => {
                if (settled) return
                settled = true
                clearTimeout(timeout)
                this.databasePromise = null
                reject(normalizeRepositoryError(error))
            }
            let request: IDBOpenDBRequest
            try {
                request = this.factory.open(this.databaseName, QUEUE_DATABASE_VERSION)
            } catch (error) {
                finishReject(error)
                return
            }
            request.onupgradeneeded = event => {
                try {
                    upgradeQueueDatabase(request.result, request.transaction as IDBTransaction, event.oldVersion)
                } catch {
                    request.transaction?.abort()
                }
            }
            request.onsuccess = () => finishResolve(request.result)
            request.onerror = () => finishReject(request.error)
            request.onblocked = () => finishReject(
                new QueueRepositoryError('E_QUEUE_DB_BLOCKED', 'Queue database upgrade is blocked'),
            )
        })
        return this.databasePromise
    }

    private async runTransaction<T>(
        stores: readonly QueueStoreName[],
        mode: IDBTransactionMode,
        operation: (transaction: IDBTransaction) => Promise<T>,
    ): Promise<T> {
        const database = await this.open()
        const transaction = database.transaction(stores, mode)
        const completed = transactionDone(transaction)
        try {
            const result = await operation(transaction)
            await completed
            return result
        } catch (error) {
            try {
                transaction.abort()
            } catch {
                // The transaction may already be complete or aborted.
            }
            await completed.catch(() => undefined)
            throw normalizeRepositoryError(error)
        }
    }

    async inspectSchema(): Promise<QueueRepositorySchemaInspection> {
        const database = await this.open()
        const transaction = database.transaction(STORE_NAMES, 'readonly')
        const completed = transactionDone(transaction)
        const indexes: Record<string, string[]> = {}
        for (const name of STORE_NAMES) {
            indexes[name] = Array.from(transaction.objectStore(name).indexNames).sort()
        }
        await completed
        return {
            version: database.version,
            stores: Array.from(database.objectStoreNames).sort(),
            indexes,
        }
    }

    async createBatch(input: CreateGenerationBatchInput): Promise<GenerationBatch> {
        const identity = batchFromInput(input, 1)
        const selected = await this.runTransaction(['batches'], 'readwrite', async transaction => {
            const store = transaction.objectStore('batches')
            const existingValue = await requestResult(store.get(identity.id))
            const existing = existingValue === undefined ? undefined : parseBatch(existingValue)
            if (existing !== undefined && !hasSameBatchIdentity(existing, identity)) {
                throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Batch identity already has different content')
            }
            if (existing === undefined) {
                const batch = batchFromInput(input, await allocateQueueSequence(store))
                await requestResult(store.add(batch))
                return batch
            }
            return existing
        })
        const readback = await this.runTransaction(['batches'], 'readonly', transaction => (
            requestResult(transaction.objectStore('batches').get(identity.id))
        ))
        if (readback === undefined
            || canonicalSerialize(parseBatch(readback)) !== canonicalSerialize(selected)) {
            throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Batch readback mismatch')
        }
        return structuredClone(selected)
    }

    async getBatch(id: string): Promise<GenerationBatch | null> {
        const value = await this.runTransaction(['batches'], 'readonly', transaction => (
            requestResult(transaction.objectStore('batches').get(id))
        ))
        return value === undefined ? null : structuredClone(parseBatch(value))
    }

    async listBatches(): Promise<GenerationBatch[]> {
        const values = await this.runTransaction(['batches'], 'readonly', transaction => (
            requestResult(transaction.objectStore('batches').index('by-created-at').getAll())
        )) as unknown[]
        return values.map(value => structuredClone(parseBatch(value))).reverse()
    }

    async setBatchControl(input: {
        batchId: string
        state: GenerationBatch['state']
        now: string
        reason?: QueuePauseReason | null
        failurePolicy?: QueueFailurePolicy
    }): Promise<GenerationBatch> {
        assertTimestamp(input.now, 'batch control time')
        if (input.state !== 'active' && input.state !== 'paused' && input.state !== 'stopped') {
            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'batch state is invalid')
        }
        if (input.failurePolicy !== undefined) assertFailurePolicy(input.failurePolicy)
        const version = await this.runTransaction(['batches'], 'readwrite', async transaction => {
            const store = transaction.objectStore('batches')
            const value = await requestResult(store.get(input.batchId))
            if (value === undefined) {
                throw new QueueRepositoryError('E_QUEUE_BATCH_NOT_FOUND', 'Queue batch does not exist')
            }
            const batch = parseBatch(value)
            const next: GenerationBatch = {
                ...batch,
                state: input.state,
                updatedAt: input.now,
                pauseReason: input.state === 'active' ? null : input.reason ?? batch.pauseReason ?? 'user',
                failurePolicy: input.failurePolicy ?? batch.failurePolicy,
                version: batch.version + 1,
            }
            await requestResult(store.put(next))
            return next.version
        })
        const readback = await this.getBatch(input.batchId)
        if (readback === null || readback.version !== version || readback.state !== input.state) {
            throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Batch control readback mismatch')
        }
        return readback
    }

    async putResource(resource: QueueResourceRecord): Promise<QueueResourceRecord> {
        assertIdentifier(resource.id, 'resource id')
        assertTimestamp(resource.createdAt, 'resource createdAt')
        assertTimestamp(resource.updatedAt, 'resource updatedAt')
        assertGenerationJobSnapshotSafe({ reference: resource.reference })
        await this.runTransaction(['resources'], 'readwrite', async transaction => {
            await requestResult(transaction.objectStore('resources').put(resource))
        })
        const readback = await this.getResource(resource.id)
        if (readback === null || canonicalSerialize(readback) !== canonicalSerialize(resource)) {
            throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Resource readback mismatch')
        }
        return readback
    }

    async ensureResource(resource: QueueResourceRecord): Promise<QueueResourceRecord> {
        assertIdentifier(resource.id, 'resource id')
        assertTimestamp(resource.createdAt, 'resource createdAt')
        assertTimestamp(resource.updatedAt, 'resource updatedAt')
        assertGenerationJobSnapshotSafe({ reference: resource.reference })
        await this.runTransaction(['resources'], 'readwrite', async transaction => {
            const store = transaction.objectStore('resources')
            const existing = await requestResult(store.get(resource.id))
            if (existing === undefined) {
                await requestResult(store.add(resource))
                return
            }
            const selected = selectResourceRecord(existing as QueueResourceRecord, resource)
            if (canonicalSerialize(selected) !== canonicalSerialize(existing)) await requestResult(store.put(selected))
        })
        const readback = await this.getResource(resource.id)
        if (readback === null) throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Resource readback missing')
        return readback
    }

    async getResource(id: string): Promise<QueueResourceRecord | null> {
        const value = await this.runTransaction(['resources'], 'readonly', transaction => (
            requestResult(transaction.objectStore('resources').get(id))
        )) as QueueResourceRecord | undefined
        return value === undefined ? null : structuredClone(value)
    }

    async createBatchAndEnqueue(input: CreateBatchAndEnqueueInput): Promise<CreateBatchAndEnqueueResult> {
        const batchIdentity = batchFromInput(input.batch, 1)
        const validatedCandidates = input.jobs.map(job => storedJobFromInput(job, 1))
        const resources = [...(input.resources ?? [])]
        const reservations = (input.reservations ?? []).map(storedReservation)
        const reservationClaims = reservations.flatMap(storedClaimsForReservation)
        if (reservations.length > 0) {
            assertGenerationAtomicBatchAvailable(
                validatedCandidates.length,
                reservationClaims.length,
                this.generationLimits,
            )
        }
        if (validatedCandidates.length === 0) {
            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'A durable batch must contain at least one job')
        }
        if (new Set(validatedCandidates.map(job => job.id)).size !== validatedCandidates.length
            || new Set(validatedCandidates.map(job => job.idempotencyKey)).size !== validatedCandidates.length) {
            throw new QueueRepositoryError('E_QUEUE_IDEMPOTENCY_CONFLICT', 'Enqueue batch contains duplicate identity')
        }
        if (new Set(resources.map(resource => resource.id)).size !== resources.length) {
            throw new QueueRepositoryError('E_QUEUE_IDEMPOTENCY_CONFLICT', 'Enqueue batch contains duplicate resources')
        }
        if (new Set(reservations.map(reservation => reservation.reservationId)).size !== reservations.length
            || new Set(reservations.map(reservation => reservation.jobId)).size !== reservations.length
            || new Set(reservations.flatMap(reservation => (
                reservation.activePath === undefined ? [] : [reservation.activePath]
            ))).size !== reservations.filter(reservation => reservation.activePath !== undefined).length) {
            throw new QueueRepositoryError('E_QUEUE_IDEMPOTENCY_CONFLICT', 'Enqueue batch contains duplicate reservations')
        }
        if (reservations.some(reservation => reservation.reservationSchemaVersion === 1
            ? reservation.state !== 'reserved'
            : reservation.state !== 'storage-pending')) {
            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'New reservations have an invalid initial state')
        }
        if (new Set(reservationClaims.map(claim => claim.id)).size !== reservationClaims.length
            || new Set(reservationClaims.flatMap(claim => (
                claim.activeCollisionKey === undefined ? [] : [claim.activeCollisionKey]
            ))).size !== reservationClaims.length) {
            throw new QueueRepositoryError('E_QUEUE_IDEMPOTENCY_CONFLICT', 'Enqueue batch contains duplicate claims')
        }
        for (const candidate of validatedCandidates) {
            if (candidate.batchId !== batchIdentity.id || candidate.workflow !== batchIdentity.workflow) {
                throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'Job does not match its atomic batch')
            }
        }
        for (const resource of resources) {
            assertIdentifier(resource.id, 'resource id')
            assertTimestamp(resource.createdAt, 'resource createdAt')
            assertTimestamp(resource.updatedAt, 'resource updatedAt')
            assertGenerationJobSnapshotSafe({ reference: resource.reference })
        }
        if (reservations.some(reservation => reservation.batchId !== batchIdentity.id)) {
            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'Reservation does not match its atomic batch')
        }
        const reservationByJob = new Map(reservations.map(reservation => [reservation.jobId, reservation]))
        for (const candidate of validatedCandidates) {
            const reservation = reservationByJob.get(candidate.id)
            const snapshotReservation = candidate.snapshot.outputReservation
            if (reservation === undefined || snapshotReservation === undefined) {
                if (reservation === undefined && snapshotReservation === undefined) continue
                throw new QueueRepositoryError(
                    'E_QUEUE_RECORD_INVALID',
                    'Reservation does not match the immutable job snapshot',
                )
            }
            if (canonicalSerialize(snapshotReservation) !== canonicalSerialize(snapshotForReservation(reservation))) {
                throw new QueueRepositoryError(
                    'E_QUEUE_RECORD_INVALID',
                    'Reservation does not match the immutable job snapshot',
                )
            }
        }

        const selected = await this.runTransaction(
            ['batches', 'jobs', 'output-reservation-claims', 'output-reservations', 'resources'],
            'readwrite',
            async transaction => {
                const batches = transaction.objectStore('batches')
                const jobs = transaction.objectStore('jobs')
                const reservationStore = transaction.objectStore('output-reservations')
                const reservationClaimStore = transaction.objectStore('output-reservation-claims')
                const resourceStore = transaction.objectStore('resources')
                const existingBatchValue = await requestResult(batches.get(batchIdentity.id))
                const existingByBatchKey = await requestResult(
                    batches.index('by-idempotency-key').get(batchIdentity.idempotencyKey),
                )
                if (existingByBatchKey !== undefined
                    && parseBatch(existingByBatchKey).id !== batchIdentity.id) {
                    throw new QueueRepositoryError(
                        'E_QUEUE_IDEMPOTENCY_CONFLICT',
                        'Batch idempotency key already represents different work',
                    )
                }
                if (existingBatchValue !== undefined
                    && !hasSameBatchIdentity(parseBatch(existingBatchValue), batchIdentity)) {
                    throw new QueueRepositoryError(
                        'E_QUEUE_IDEMPOTENCY_CONFLICT',
                        'Batch identity already represents different work',
                    )
                }
                const existingBatch = existingBatchValue === undefined
                    ? undefined
                    : parseBatch(existingBatchValue)
                const selectedBatch = existingBatch
                    ?? batchFromInput(input.batch, await allocateQueueSequence(batches))
                const candidates = input.jobs.map(job => storedJobFromInput(job, selectedBatch.queueSequence))

                const existingResources = new Map<string, QueueResourceRecord>()
                for (const resource of resources) {
                    const existing = await requestResult(resourceStore.get(resource.id)) as QueueResourceRecord | undefined
                    existingResources.set(
                        resource.id,
                        existing === undefined ? resource : selectResourceRecord(existing, resource),
                    )
                }
                const requiredIds = [...new Set(candidates.flatMap(candidate => (
                    candidate.snapshot.resources.map(resource => resource.resourceId)
                )))]
                for (const id of requiredIds) {
                    if (!existingResources.has(id)) {
                        const existing = await requestResult(resourceStore.get(id)) as QueueResourceRecord | undefined
                        if (existing !== undefined) existingResources.set(id, existing)
                    }
                }
                for (const candidate of candidates) {
                    for (const requirement of candidate.snapshot.resources) {
                        const materialized = existingResources.get(requirement.resourceId)
                        if (materialized === undefined
                            || materialized.digest !== requirement.digest
                            || materialized.persistence !== requirement.persistence
                            || canonicalSerialize(materialized.reference) !== canonicalSerialize(requirement.reference)) {
                            throw new QueueRepositoryError(
                                'E_QUEUE_RECORD_INVALID',
                                'Snapshot resource was not materialized with matching immutable content',
                            )
                        }
                    }
                }

                const idempotency = jobs.index('by-idempotency-key')
                const result: StoredJobRecord[] = []
                const additions: StoredJobRecord[] = []
                for (const candidate of candidates) {
                    const existingValue = await requestResult(idempotency.get(candidate.idempotencyKey))
                    if (existingValue === undefined) {
                        additions.push(candidate)
                        result.push(candidate)
                        continue
                    }
                    const existing = parseStoredJob(existingValue)
                    if (existing.snapshotHash !== candidate.snapshotHash
                        || existing.batchId !== candidate.batchId
                        || existing.workflow !== candidate.workflow
                        || existing.sceneId !== candidate.sceneId
                        || existing.compositionPlanHash !== candidate.compositionPlanHash) {
                        throw new QueueRepositoryError(
                            'E_QUEUE_IDEMPOTENCY_CONFLICT',
                            'Idempotency key already represents different immutable work',
                        )
                    }
                    result.push(existing)
                }
                const selectedJobIds = new Set(result.map(job => job.id))
                const selectedReservations: StoredOutputReservation[] = []
                const reservationAdditions: StoredOutputReservation[] = []
                const claimAdditions: StoredOutputReservationClaim[] = []
                for (const reservation of reservations) {
                    if (!selectedJobIds.has(reservation.jobId)) {
                        throw new QueueRepositoryError(
                            'E_QUEUE_IDEMPOTENCY_CONFLICT',
                            'Reservation job identity does not match its atomic enqueue',
                        )
                    }
                    const [existingById, existingByPath] = await Promise.all([
                        requestResult(reservationStore.get(reservation.reservationId)),
                        reservation.activePath === undefined
                            ? Promise.resolve(undefined)
                            : requestResult(reservationStore.index('by-normalized-path').get(reservation.activePath)),
                    ])
                    if (existingById !== undefined) {
                        const existingReservation = parseOutputReservation(existingById)
                        if (existingReservation.batchId !== reservation.batchId
                            || existingReservation.jobId !== reservation.jobId
                            || !hasSameReservationIdentity(existingReservation, reservation)) {
                            throw new QueueRepositoryError(
                                'E_QUEUE_IDEMPOTENCY_CONFLICT',
                                'Reservation identity or owner already represents different output work',
                            )
                        }
                        if (reservation.reservationSchemaVersion === 1) {
                            const existingClaims = (await requestResult(
                                reservationClaimStore.index('by-reservation-id').getAll(reservation.reservationId),
                            ) as unknown[]).map(parseOutputReservationClaim)
                            const expectedClaims = storedClaimsForReservation(reservation).map(parseOutputReservationClaim)
                            const identity = (claim: OutputReservationClaim) => ({
                                claimId: claim.claimId,
                                reservationId: claim.reservationId,
                                originalCollisionKey: claim.originalCollisionKey,
                                kind: claim.kind,
                                relativePath: claim.relativePath,
                            })
                            if (canonicalSerialize(existingClaims.map(identity))
                                !== canonicalSerialize(expectedClaims.map(identity))) {
                                throw new QueueRepositoryError(
                                    'E_QUEUE_IDEMPOTENCY_CONFLICT',
                                    'Reservation claims already represent different output work',
                                )
                            }
                        }
                        selectedReservations.push(existingById as StoredOutputReservation)
                        continue
                    }
                    if (existingByPath !== undefined) {
                        throw new QueueRepositoryError(
                            'E_QUEUE_IDEMPOTENCY_CONFLICT',
                            'Output path is already reserved by different work',
                        )
                    }
                    reservationAdditions.push(reservation)
                    for (const claim of storedClaimsForReservation(reservation)) {
                        if (claim.activeCollisionKey !== undefined) {
                            const occupied = await requestResult(
                                reservationClaimStore.index('by-active-collision-key').get(claim.activeCollisionKey),
                            )
                            if (occupied !== undefined) {
                                throw new QueueRepositoryError(
                                    'E_QUEUE_IDEMPOTENCY_CONFLICT',
                                    'Output claim is already reserved by different work',
                                )
                            }
                        }
                        claimAdditions.push(claim)
                    }
                    selectedReservations.push(reservation)
                }
                for (const resource of resources) {
                    const existing = await requestResult(resourceStore.get(resource.id)) as QueueResourceRecord | undefined
                    if (existing === undefined) {
                        await requestResult(resourceStore.add(resource))
                    } else {
                        const selectedResource = existingResources.get(resource.id) as QueueResourceRecord
                        if (canonicalSerialize(existing) !== canonicalSerialize(selectedResource)) {
                            await requestResult(resourceStore.put(selectedResource))
                        }
                    }
                }
                await Promise.all(additions.map(candidate => requestResult(jobs.add(candidate))))
                await Promise.all(reservationAdditions.map(reservation => requestResult(reservationStore.add(reservation))))
                await Promise.all(claimAdditions.map(claim => requestResult(reservationClaimStore.add(claim))))
                if (additions.length > 0) {
                    const projected = withBatchProjectionAdditions(selectedBatch, additions)
                    if (existingBatch === undefined) await requestResult(batches.add(projected))
                    else await requestResult(batches.put(projected))
                } else if (existingBatch === undefined) {
                    // A replay cannot normally create an empty batch because this
                    // method requires jobs, but preserving this branch keeps the
                    // immutable batch identity valid if all candidates dedupe.
                    await requestResult(batches.add(selectedBatch))
                }
                return { jobs: result, reservations: selectedReservations }
            },
        )
        const [readbackBatch, readbackJobs, readbackReservations] = await Promise.all([
            this.getBatch(batchIdentity.id),
            this.getJobsByIds(selected.jobs.map(job => job.id)),
            Promise.all(selected.reservations.map(reservation => this.getOutputReservation(reservation.reservationId))),
        ])
        if (readbackBatch === null
            || readbackJobs.some(job => job === null)
            || readbackReservations.some(reservation => reservation === null)) {
            throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Atomic enqueue readback mismatch')
        }
        return {
            batch: readbackBatch,
            jobs: readbackJobs as GenerationJob[],
            reservations: readbackReservations as OutputReservation[],
        }
    }

    async getOutputReservation(reservationId: string): Promise<OutputReservation | null> {
        assertIdentifier(reservationId, 'reservation id')
        const value = await this.runTransaction(['output-reservations'], 'readonly', transaction => (
            requestResult(transaction.objectStore('output-reservations').get(reservationId))
        ))
        return value === undefined ? null : structuredClone(parseOutputReservation(value))
    }

    async getOutputReservationByPath(
        directoryIdentity: OutputReservationSnapshot['directoryIdentity'],
        relativePath: string,
    ): Promise<OutputReservation | null> {
        if (!/^sha256:[0-9a-f]{64}$/.test(directoryIdentity)) {
            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'reservation directory identity is invalid')
        }
        const normalizedPath = normalizeReservationRelativePath(relativePath)
        const activePath = `${directoryIdentity}/${normalizedPath}`
        const value = await this.runTransaction(['output-reservations'], 'readonly', transaction => (
            requestResult(transaction.objectStore('output-reservations').index('by-normalized-path').get(activePath))
        ))
        return value === undefined ? null : structuredClone(parseOutputReservation(value))
    }

    async listOutputReservationsByJob(jobId: string): Promise<OutputReservation[]> {
        assertIdentifier(jobId, 'reservation job id')
        const values = await this.runTransaction(['output-reservations'], 'readonly', transaction => (
            requestResult(transaction.objectStore('output-reservations').index('by-job-id').getAll(jobId))
        )) as unknown[]
        return values.map(value => structuredClone(parseOutputReservation(value)))
    }

    async listOutputReservationClaims(reservationId: string): Promise<OutputReservationClaim[]> {
        assertIdentifier(reservationId, 'reservation id')
        const values = await this.runTransaction(['output-reservation-claims'], 'readonly', transaction => (
            requestResult(transaction.objectStore('output-reservation-claims')
                .index('by-reservation-id').getAll(reservationId))
        )) as unknown[]
        return values.map(value => structuredClone(parseOutputReservationClaim(value)))
    }

    /** Reads replay identities and the sparse active-key set from one IndexedDB snapshot. */
    async getOutputReservationPlanningSnapshot(reservationIds: readonly string[]): Promise<{
        readonly reservations: readonly (OutputReservation | null)[]
        readonly activeCollisionKeys: readonly string[]
    }> {
        for (const reservationId of reservationIds) assertIdentifier(reservationId, 'reservation id')
        return this.runTransaction(
            ['output-reservation-claims', 'output-reservations'],
            'readonly',
            async transaction => {
                const reservationStore = transaction.objectStore('output-reservations')
                const claimIndex = transaction.objectStore('output-reservation-claims')
                    .index('by-active-collision-key')
                const [reservationValues, claimValues] = await Promise.all([
                    Promise.all(reservationIds.map(id => requestResult(reservationStore.get(id)))),
                    requestResult(claimIndex.getAll()) as Promise<unknown[]>,
                ])
                return {
                    reservations: reservationValues.map(value => (
                        value === undefined ? null : structuredClone(parseOutputReservation(value))
                    )),
                    activeCollisionKeys: claimValues.map(value => (
                        parseOutputReservationClaim(value).activeCollisionKey as string
                    )),
                }
            },
        )
    }

    async transitionOutputReservation(input: {
        reservationId: string
        owner: Pick<OutputReservation, 'batchId' | 'jobId' | 'directoryIdentity' | 'relativePath'>
        expectedState: OutputReservation['state']
        expectedVersion?: number
        state: OutputReservation['state']
    }): Promise<OutputReservation> {
        assertIdentifier(input.reservationId, 'reservation id')
        const allowed: Readonly<Record<OutputReservation['state'], readonly OutputReservation['state'][]>> = {
            reserved: ['writing', 'conflict', 'abandoned'],
            'storage-pending': ['writing', 'conflict', 'abandoned'],
            writing: ['storage-pending', 'committed', 'conflict', 'abandoned'],
            committed: [],
            conflict: ['abandoned'],
            abandoned: [],
        }
        const selected = await this.runTransaction(
            ['output-reservation-claims', 'output-reservations'],
            'readwrite',
            async transaction => {
                const store = transaction.objectStore('output-reservations')
                const claimStore = transaction.objectStore('output-reservation-claims')
                const value = await requestResult(store.get(input.reservationId))
                if (value === undefined) {
                    throw new QueueRepositoryError('E_QUEUE_NOT_FOUND', 'Output reservation does not exist')
                }
                const current = parseOutputReservation(value)
                if (current.batchId !== input.owner.batchId
                    || current.jobId !== input.owner.jobId
                    || current.directoryIdentity !== input.owner.directoryIdentity
                    || normalizeReservationRelativePath(current.relativePath)
                        !== normalizeReservationRelativePath(input.owner.relativePath)) {
                    throw new QueueRepositoryError(
                        'E_QUEUE_IDEMPOTENCY_CONFLICT',
                        'Output reservation owner or destination changed',
                    )
                }
                if (current.reservationSchemaVersion === 1
                    && (input.expectedVersion === undefined || input.expectedVersion !== current.version)) {
                    throw new QueueRepositoryError(
                        'E_QUEUE_INVALID_TRANSITION',
                        'Output reservation version changed',
                    )
                }
                if (current.reservationSchemaVersion === 1
                    && current.state !== 'abandoned'
                    && input.state === 'abandoned') {
                    throw new QueueRepositoryError(
                        'E_QUEUE_INVALID_TRANSITION',
                        'Current output reservations require the explicit abandon command',
                    )
                }
                if (current.state === input.state) return current
                if (current.state !== input.expectedState || !allowed[current.state].includes(input.state)) {
                    throw new QueueRepositoryError(
                        'E_QUEUE_INVALID_TRANSITION',
                        `Output reservation cannot transition from ${current.state} to ${input.state}`,
                    )
                }
                const next: OutputReservation = current.reservationSchemaVersion === 1
                    ? {
                            ...current,
                            state: input.state,
                            version: current.version + 1,
                            updatedAt: new Date().toISOString(),
                        }
                    : { ...current, state: input.state }
                await requestResult(store.put(storedReservation(next)))
                if (next.reservationSchemaVersion === 1
                    && (next.state === 'committed' || next.state === 'abandoned')) {
                    const claims = await requestResult(
                        claimStore.index('by-reservation-id').getAll(next.reservationId),
                    ) as StoredOutputReservationClaim[]
                    await Promise.all(claims.map(claim => requestResult(claimStore.put({
                        ...claim,
                        activeCollisionKey: undefined,
                    }))))
                }
                return next
            },
        )
        const readback = await this.getOutputReservation(input.reservationId)
        if (readback === null || readback.state !== selected.state) {
            throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Output reservation readback mismatch')
        }
        return readback
    }

    /**
     * Explicit human/application abandon command. Cancellation never calls this
     * for unknown or spooled Provider outcomes; a spooled result requires proof
     * that the separate discard command removed the exact receipt first.
     */
    async abandonOutputReservation(input: {
        reservationId: string
        owner: Pick<OutputReservation, 'batchId' | 'jobId' | 'directoryIdentity' | 'relativePath'>
        expectedVersion?: number
        now: string
        discardedSpoolReceipt?: SpoolReceipt
    }): Promise<OutputReservation> {
        assertIdentifier(input.reservationId, 'reservation id')
        assertTimestamp(input.now, 'reservation abandon time')
        await this.runTransaction(
            ['attempts', 'jobs', 'output-reservation-claims', 'output-reservations'],
            'readwrite',
            async transaction => {
                const attempts = transaction.objectStore('attempts')
                const jobs = transaction.objectStore('jobs')
                const claims = transaction.objectStore('output-reservation-claims')
                const reservations = transaction.objectStore('output-reservations')
                const value = await requestResult(reservations.get(input.reservationId))
                if (value === undefined) {
                    throw new QueueRepositoryError('E_QUEUE_NOT_FOUND', 'Output reservation does not exist')
                }
                const reservation = parseOutputReservation(value)
                if (reservation.batchId !== input.owner.batchId
                    || reservation.jobId !== input.owner.jobId
                    || reservation.directoryIdentity !== input.owner.directoryIdentity
                    || reservation.relativePath !== input.owner.relativePath) {
                    throw new QueueRepositoryError('E_QUEUE_IDEMPOTENCY_CONFLICT', 'Output reservation owner changed')
                }
                if (reservation.reservationSchemaVersion === 1
                    && input.expectedVersion !== reservation.version) {
                    throw new QueueRepositoryError('E_QUEUE_INVALID_TRANSITION', 'Output reservation version changed')
                }
                if (reservation.state === 'committed') {
                    throw new QueueRepositoryError('E_QUEUE_INVALID_TRANSITION', 'Committed output cannot be abandoned')
                }
                if (reservation.state === 'abandoned') return
                const jobValue = await requestResult(jobs.get(reservation.jobId))
                if (jobValue === undefined) throw new QueueRepositoryError('E_QUEUE_NOT_FOUND', 'Reservation job does not exist')
                const job = parseStoredJob(jobValue)
                if (job.state === 'running' || job.state === 'leased' || job.state === 'recovering'
                    || job.outputTransactionId !== null || job.artifactReference !== null) {
                    throw new QueueRepositoryError('E_QUEUE_INVALID_TRANSITION', 'Active or bound output cannot be abandoned')
                }
                const attempt = job.attemptCount === 0
                    ? null
                    : parseGenerationAttempt(await requestResult(attempts.get(`${job.id}:${job.attemptCount}`)))
                const spooledReceipt = attempt?.providerEvidence?.dispatchState === 'result-spooled'
                    ? attempt.providerEvidence.spoolReceipt
                    : null
                if (spooledReceipt !== null
                    && (input.discardedSpoolReceipt === undefined
                        || canonicalSerialize(spooledReceipt) !== canonicalSerialize(input.discardedSpoolReceipt))) {
                    throw new QueueRepositoryError(
                        'E_QUEUE_INVALID_TRANSITION',
                        'Spooled Provider result must be explicitly discarded before reservation abandon',
                    )
                }
                const abandoned = withReservationState(reservation, 'abandoned', input.now)
                await requestResult(reservations.put(storedReservation(abandoned)))
                await releaseReservationClaims(claims, reservation.reservationId)
            },
        )
        const readback = await this.getOutputReservation(input.reservationId)
        if (readback === null || readback.state !== 'abandoned') {
            throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Output reservation abandon readback mismatch')
        }
        return readback
    }

    enqueue(input: EnqueueGenerationJobInput): Promise<GenerationJob> {
        return this.enqueueMany([input]).then(jobs => jobs[0])
    }

    async enqueueMany(inputs: readonly EnqueueGenerationJobInput[]): Promise<GenerationJob[]> {
        if (inputs.length === 0) return []
        const validatedCandidates = inputs.map(input => storedJobFromInput(input, 1))
        if (new Set(validatedCandidates.map(job => job.id)).size !== validatedCandidates.length
            || new Set(validatedCandidates.map(job => job.idempotencyKey)).size !== validatedCandidates.length) {
            throw new QueueRepositoryError('E_QUEUE_IDEMPOTENCY_CONFLICT', 'Enqueue batch contains duplicate identity')
        }

        const selected = await this.runTransaction(['batches', 'jobs'], 'readwrite', async transaction => {
            const batches = transaction.objectStore('batches')
            const jobs = transaction.objectStore('jobs')
            const idempotency = jobs.index('by-idempotency-key')
            const batchIds = [...new Set(validatedCandidates.map(job => job.batchId))]
            const batchValues = await Promise.all(batchIds.map(id => requestResult(batches.get(id))))
            const batchById = new Map(batchIds.map((id, index) => [
                id,
                batchValues[index] === undefined ? undefined : parseBatch(batchValues[index]),
            ]))
            const candidates = inputs.map((input, index) => {
                const batch = batchById.get(validatedCandidates[index].batchId)
                if (batch === undefined) {
                    throw new QueueRepositoryError('E_QUEUE_BATCH_NOT_FOUND', 'Queue batch does not exist')
                }
                return storedJobFromInput(input, batch.queueSequence)
            })
            for (const candidate of candidates) {
                const batch = batchById.get(candidate.batchId)
                if (batch === undefined) {
                    throw new QueueRepositoryError('E_QUEUE_BATCH_NOT_FOUND', 'Queue batch does not exist')
                }
                if (batch.workflow !== candidate.workflow) {
                    throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'Job workflow does not match its batch')
                }
            }

            const existingValues = await Promise.all(candidates.map(candidate => (
                requestResult(idempotency.get(candidate.idempotencyKey))
            )))
            const result: StoredJobRecord[] = []
            const additions: StoredJobRecord[] = []
            for (let index = 0; index < candidates.length; index += 1) {
                const candidate = candidates[index]
                const existingValue = existingValues[index]
                if (existingValue === undefined) {
                    additions.push(candidate)
                    result.push(candidate)
                    continue
                }
                const existing = parseStoredJob(existingValue)
                if (existing.snapshotHash !== candidate.snapshotHash
                    || existing.batchId !== candidate.batchId
                    || existing.workflow !== candidate.workflow
                    || existing.sceneId !== candidate.sceneId
                    || existing.compositionPlanHash !== candidate.compositionPlanHash) {
                    throw new QueueRepositoryError(
                        'E_QUEUE_IDEMPOTENCY_CONFLICT',
                        'Idempotency key already represents different immutable work',
                    )
                }
                result.push(existing)
            }
            await Promise.all(additions.map(candidate => requestResult(jobs.add(candidate))))
            const additionsByBatch = new Map<string, StoredJobRecord[]>()
            for (const addition of additions) {
                const grouped = additionsByBatch.get(addition.batchId) ?? []
                grouped.push(addition)
                additionsByBatch.set(addition.batchId, grouped)
            }
            for (const [batchId, batchAdditions] of additionsByBatch) {
                const existing = batchById.get(batchId)
                if (existing === undefined) {
                    throw new QueueRepositoryError('E_QUEUE_BATCH_NOT_FOUND', 'Queue batch does not exist')
                }
                const projected = withBatchProjectionAdditions(existing, batchAdditions)
                await requestResult(batches.put(projected))
            }
            return result
        })

        const readback = await this.getJobsByIds(selected.map(job => job.id))
        for (let index = 0; index < selected.length; index += 1) {
            if (readback[index] === null
                || readback[index]?.snapshotHash !== selected[index].snapshotHash
                || readback[index]?.version !== selected[index].version) {
                throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Enqueued job readback mismatch')
            }
        }
        return readback as GenerationJob[]
    }

    private async getJobsByIds(ids: readonly string[]): Promise<(GenerationJob | null)[]> {
        return this.runTransaction(['jobs', 'leases'], 'readonly', async transaction => {
            const jobs = transaction.objectStore('jobs')
            const leases = transaction.objectStore('leases')
            const [jobValues, leaseValues] = await Promise.all([
                Promise.all(ids.map(id => requestResult(jobs.get(id)))),
                Promise.all(ids.map(id => requestResult(leases.get(id)))),
            ])
            return jobValues.map((value, index) => (
                value === undefined ? null : aggregateJob(parseStoredJob(value), parseLease(leaseValues[index]))
            ))
        })
    }

    async getJob(id: string): Promise<GenerationJob | null> {
        return (await this.getJobsByIds([id]))[0]
    }

    async acquireLease(input: AcquireQueueLeaseInput): Promise<GenerationJob | null> {
        assertIdentifier(input.owner, 'lease owner')
        assertTimestamp(input.now, 'lease time')
        if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1) {
            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'Lease ttl is invalid')
        }
        const result = await this.runTransaction(['batches', 'jobs', 'leases'], 'readwrite', async transaction => {
            const batches = transaction.objectStore('batches')
            const jobs = transaction.objectStore('jobs')
            const leases = transaction.objectStore('leases')
            const storedValue = await requestResult(jobs.get(input.jobId))
            if (storedValue === undefined) throw new QueueRepositoryError('E_QUEUE_NOT_FOUND', 'Queue job does not exist')
            const stored = parseStoredJob(storedValue)
            const batchValue = await requestResult(batches.get(stored.batchId))
            if (batchValue === undefined) {
                throw new QueueRepositoryError('E_QUEUE_BATCH_NOT_FOUND', 'Queue batch does not exist')
            }
            const batch = parseBatch(batchValue)
            const existing = parseLease(await requestResult(leases.get(input.jobId)))
            if (existing !== null
                || stored.state !== 'queued'
                || batch.state !== 'active'
                || stored.cancelRequestedAt !== null
                || Date.parse(stored.readyAt) > Date.parse(input.now)) return null
            assertJobTransition(stored.state, 'leased')
            const lease: LeaseRecord = {
                jobId: stored.id,
                owner: input.owner,
                token: `lease:${crypto.randomUUID()}`,
                expiresAt: new Date(Date.parse(input.now) + input.ttlMs).toISOString(),
                heartbeatAt: input.now,
            }
            const next = updateJobState(stored, 'leased', input.now)
            await Promise.all([
                requestResult(jobs.put(next)),
                requestResult(leases.add(lease)),
                requestResult(batches.put(withBatchProjectionDelta(batch, stored, next))),
            ])
            return { next, lease }
        })
        if (result === null) return null
        const readback = await this.getJob(input.jobId)
        if (readback?.version !== result.next.version
            || readback.leaseToken !== result.lease.token
            || readback.leaseOwner !== input.owner) {
            throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Lease readback mismatch')
        }
        return readback
    }

    async claimNext(input: {
        owner: string
        now: string
        ttlMs: number
        workflow?: GenerationWorkflow
    }): Promise<GenerationJob | null> {
        let cursor: string | null = null
        do {
            const page = await this.listJobs({ states: ['queued'], cursor, limit: 250 })
            for (const job of page.items) {
                if (input.workflow !== undefined && job.workflow !== input.workflow) continue
                if (job.cancelRequestedAt !== null || Date.parse(job.readyAt) > Date.parse(input.now)) continue
                const claimed = await this.acquireLease({
                    jobId: job.id,
                    owner: input.owner,
                    now: input.now,
                    ttlMs: input.ttlMs,
                })
                if (claimed !== null) return claimed
            }
            cursor = page.nextCursor
        } while (cursor !== null)
        return null
    }

    async heartbeatLease(input: HeartbeatQueueLeaseInput): Promise<GenerationJob> {
        assertTimestamp(input.now, 'heartbeat time')
        const expectedExpiry = new Date(Date.parse(input.now) + input.ttlMs).toISOString()
        await this.runTransaction(['jobs', 'leases'], 'readwrite', async transaction => {
            const jobs = transaction.objectStore('jobs')
            const leases = transaction.objectStore('leases')
            const [jobValue, leaseValue] = await Promise.all([
                requestResult(jobs.get(input.jobId)),
                requestResult(leases.get(input.jobId)),
            ])
            if (jobValue === undefined) throw new QueueRepositoryError('E_QUEUE_NOT_FOUND', 'Queue job does not exist')
            const job = parseStoredJob(jobValue)
            const lease = parseLease(leaseValue)
            if (lease === null
                || lease.owner !== input.owner
                || lease.token !== input.token
                || (job.state !== 'leased' && job.state !== 'running')) {
                throw new QueueRepositoryError('E_QUEUE_LEASE_LOST', 'Queue lease is no longer owned')
            }
            await requestResult(leases.put({
                ...lease,
                expiresAt: expectedExpiry,
                heartbeatAt: input.now,
            }))
        })
        const readback = await this.getJob(input.jobId)
        if (readback === null || readback.heartbeatAt !== input.now || readback.leaseExpiresAt !== expectedExpiry) {
            throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Heartbeat readback mismatch')
        }
        return readback
    }

    async transitionJob(input: TransitionGenerationJobInput): Promise<GenerationJob> {
        assertTimestamp(input.now, 'transition time')
        const result = await this.runTransaction(
            ['batches', 'jobs', 'leases', 'attempts', 'output-reservation-claims', 'output-reservations'],
            'readwrite',
            async transaction => {
            const batches = transaction.objectStore('batches')
            const jobs = transaction.objectStore('jobs')
            const leases = transaction.objectStore('leases')
            const attempts = transaction.objectStore('attempts')
            const outputReservations = transaction.objectStore('output-reservations')
            const outputReservationClaims = transaction.objectStore('output-reservation-claims')
            const storedValue = await requestResult(jobs.get(input.jobId))
            if (storedValue === undefined) throw new QueueRepositoryError('E_QUEUE_NOT_FOUND', 'Queue job does not exist')
            const stored = parseStoredJob(storedValue)
            const lease = parseLease(await requestResult(leases.get(input.jobId)))
            if (stored.state === input.to) {
                if ((stored.state === 'leased' || stored.state === 'running')
                    && (lease === null
                        || input.leaseOwner === undefined
                        || input.leaseToken === undefined
                        || lease.owner !== input.leaseOwner
                        || lease.token !== input.leaseToken
                        || Date.parse(lease.expiresAt) < Date.parse(input.now))) {
                    throw new QueueRepositoryError('E_QUEUE_LEASE_LOST', 'Queue lease is no longer owned')
                }
                if (input.outputTransactionId !== undefined
                    && stored.outputTransactionId !== input.outputTransactionId) {
                    throw new QueueRepositoryError(
                        'E_QUEUE_IDEMPOTENCY_CONFLICT',
                        'Terminal output transaction does not match the committed job',
                    )
                }
                if (input.artifactReference !== undefined
                    && canonicalSerialize(stored.artifactReference) !== canonicalSerialize(input.artifactReference)) {
                    throw new QueueRepositoryError(
                        'E_QUEUE_IDEMPOTENCY_CONFLICT',
                        'Terminal artifact does not match the committed job',
                    )
                }
                if (stored.state === 'succeeded' && stored.snapshot.outputReservation !== undefined) {
                    const value = await requestResult(
                        outputReservations.get(stored.snapshot.outputReservation.reservationId),
                    )
                    if (value === undefined || parseOutputReservation(value).state !== 'committed') {
                        throw new QueueRepositoryError(
                            'E_QUEUE_WRITE_VERIFY',
                            'Succeeded queue job does not own a committed output reservation',
                        )
                    }
                }
                return { stored, lease, idempotent: true, reservationRetained: false }
            }
            if (isTerminalJobState(stored.state)) {
                throw new QueueRepositoryError('E_QUEUE_TERMINAL_IMMUTABLE', 'Terminal queue jobs are immutable')
            }
            const batchValue = await requestResult(batches.get(stored.batchId))
            if (batchValue === undefined) {
                throw new QueueRepositoryError('E_QUEUE_BATCH_NOT_FOUND', 'Queue batch does not exist')
            }
            const batch = parseBatch(batchValue)
            if (input.expectedVersion !== undefined && stored.version !== input.expectedVersion) {
                throw new QueueRepositoryError('E_QUEUE_INVALID_TRANSITION', 'Queue job version changed')
            }
            try {
                assertJobTransition(stored.state, input.to)
            } catch (error) {
                throw normalizeRepositoryError(error)
            }
            if (input.to === 'leased') {
                throw new QueueRepositoryError('E_QUEUE_INVALID_TRANSITION', 'Leases must be acquired through CAS')
            }
            if (input.to === 'succeeded' && stored.cancelRequestedAt !== null) {
                throw new QueueRepositoryError('E_QUEUE_CANCEL_REQUESTED', 'Queue job was cancelled before output commit')
            }
            if (input.to === 'succeeded'
                && (input.outputTransactionId === undefined
                    || input.outputTransactionId === null
                    || input.artifactReference === undefined
                    || input.artifactReference === null)) {
                throw new QueueRepositoryError(
                    'E_QUEUE_RECORD_INVALID',
                    'Succeeded queue jobs require OutputWriter transaction and artifact linkage',
                )
            }
            if (stored.state === 'leased' || stored.state === 'running') {
                if (lease === null
                    || input.leaseOwner === undefined
                    || input.leaseToken === undefined
                    || lease.owner !== input.leaseOwner
                    || lease.token !== input.leaseToken
                    || Date.parse(lease.expiresAt) < Date.parse(input.now)) {
                    throw new QueueRepositoryError('E_QUEUE_LEASE_LOST', 'Queue lease is no longer owned')
                }
            }

            let committedReservation: OutputReservation | null = null
            if (input.to === 'succeeded' && stored.snapshot.outputReservation !== undefined) {
                const snapshotReservation = stored.snapshot.outputReservation
                const reservationValue = await requestResult(outputReservations.get(snapshotReservation.reservationId))
                if (reservationValue === undefined) {
                    throw new QueueRepositoryError('E_QUEUE_NOT_FOUND', 'Output reservation does not exist')
                }
                const reservation = parseOutputReservation(reservationValue)
                if (reservation.batchId !== stored.batchId
                    || reservation.jobId !== stored.id
                    || canonicalSerialize(snapshotReservation) !== canonicalSerialize(snapshotForReservation(reservation))) {
                    throw new QueueRepositoryError(
                        'E_QUEUE_IDEMPOTENCY_CONFLICT',
                        'Output reservation does not match the succeeded job',
                    )
                }
                if (reservation.state !== 'writing') {
                    throw new QueueRepositoryError(
                        'E_QUEUE_INVALID_TRANSITION',
                        `Output reservation cannot commit from ${reservation.state}`,
                    )
                }
                committedReservation = withReservationState(reservation, 'committed', input.now)
            }
            let abandonedReservation: OutputReservation | null = null
            let reservationRetained = false
            if (input.to === 'cancelled' && stored.snapshot.outputReservation !== undefined) {
                const snapshotReservation = stored.snapshot.outputReservation
                const reservationValue = await requestResult(outputReservations.get(snapshotReservation.reservationId))
                if (reservationValue === undefined) {
                    throw new QueueRepositoryError('E_QUEUE_NOT_FOUND', 'Output reservation does not exist')
                }
                const reservation = parseOutputReservation(reservationValue)
                if (reservation.batchId !== stored.batchId
                    || reservation.jobId !== stored.id
                    || canonicalSerialize(snapshotReservation) !== canonicalSerialize(snapshotForReservation(reservation))) {
                    throw new QueueRepositoryError(
                        'E_QUEUE_IDEMPOTENCY_CONFLICT',
                        'Output reservation does not match the cancelled job',
                    )
                }
                if (reservation.state === 'committed') {
                    throw new QueueRepositoryError(
                        'E_QUEUE_INVALID_TRANSITION',
                        'A committed output reservation cannot be cancelled',
                    )
                }
                const attempt = stored.attemptCount === 0
                    ? null
                    : parseGenerationAttempt(await requestResult(attempts.get(`${stored.id}:${stored.attemptCount}`)))
                reservationRetained = attempt !== null
                    && providerEvidenceForbidsGenericRetry(attempt.providerEvidence)
                if (!reservationRetained && reservation.state !== 'abandoned') {
                    abandonedReservation = withReservationState(reservation, 'abandoned', input.now)
                }
            }

            let next = updateJobState(stored, input.to, input.now)
            if (stored.state === 'leased' && input.to === 'running') {
                if (stored.attemptCount >= stored.maxAttempts) {
                    throw new QueueRepositoryError('E_QUEUE_INVALID_TRANSITION', 'Queue attempt budget is exhausted')
                }
                const attemptNumber = stored.attemptCount + 1
                next = { ...next, attemptCount: attemptNumber }
                const providerEvidence: ProviderAttemptEvidence | null = stored.snapshot.providerExecutionEnvelope === undefined
                    ? null
                    : {
                        dispatchState: 'prepared',
                        providerOutcome: 'running',
                        billingRisk: 'none',
                        responseDigest: null,
                        spoolReceipt: null,
                    }
                const attempt: GenerationAttempt & { jobAttemptKey: IDBValidKey } = {
                    recordSchemaVersion: 2,
                    id: `${stored.id}:${attemptNumber}`,
                    jobId: stored.id,
                    attemptNumber,
                    startedAt: input.now,
                    finishedAt: null,
                    outcome: 'running',
                    diagnosticEventId: null,
                    providerEvidence,
                    providerTransitions: [],
                    executionEnvelopeHash: stored.snapshot.providerExecutionEnvelope === undefined
                        ? null
                        : `sha256:${hashCanonicalValue(stored.snapshot.providerExecutionEnvelope)}`,
                    jobAttemptKey: [stored.id, attemptNumber],
                }
                await requestResult(attempts.add(attempt))
            }

            const finishesAttempt = stored.state === 'running'
                && (input.to === 'succeeded'
                    || input.to === 'failed'
                    || input.to === 'cancelled'
                    || input.to === 'recovering'
                    || input.to === 'blocked')
            if (finishesAttempt) {
                const attemptId = `${stored.id}:${stored.attemptCount}`
                const attemptValue = await requestResult(attempts.get(attemptId))
                if (!isRecord(attemptValue)) {
                    throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'Active queue attempt is missing')
                }
                const outcome = input.to === 'recovering' || input.to === 'blocked'
                    ? 'interrupted'
                    : input.to
                await requestResult(attempts.put({
                    ...attemptValue,
                    finishedAt: input.now,
                    outcome,
                    diagnosticEventId: input.lastDiagnosticEventId ?? null,
                    failureKind: input.failureKind ?? null,
                }))
            }

            next = {
                ...next,
                ...(input.lastDiagnosticEventId === undefined
                    ? {}
                    : { lastDiagnosticEventId: input.lastDiagnosticEventId }),
                ...(input.outputTransactionId === undefined
                    ? {}
                    : { outputTransactionId: input.outputTransactionId }),
                ...(input.artifactReference === undefined
                    ? {}
                    : { artifactReference: input.artifactReference }),
                blockReason: input.to === 'blocked' ? input.blockReason ?? 'missing-resource' : null,
            }
            await requestResult(jobs.put(next))
            if (committedReservation !== null) {
                await requestResult(outputReservations.put(storedReservation(committedReservation)))
                await releaseReservationClaims(outputReservationClaims, committedReservation.reservationId)
            }
            if (abandonedReservation !== null) {
                await requestResult(outputReservations.put(storedReservation(abandonedReservation)))
                await releaseReservationClaims(outputReservationClaims, abandonedReservation.reservationId)
            }
            if (input.to !== 'running' && lease !== null) await requestResult(leases.delete(stored.id))
            await requestResult(batches.put(withBatchProjectionDelta(batch, stored, next)))
            return {
                stored: next,
                lease: input.to === 'running' ? lease : null,
                idempotent: false,
                reservationRetained,
            }
        })
        if (result.idempotent) return aggregateJob(result.stored, result.lease)
        const readback = await this.getJob(input.jobId)
        if (readback === null || readback.version !== result.stored.version || readback.state !== input.to) {
            throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Queue transition readback mismatch')
        }
        if (input.to === 'succeeded' && readback.snapshot.outputReservation !== undefined) {
            const reservation = await this.getOutputReservation(readback.snapshot.outputReservation.reservationId)
            if (reservation?.state !== 'committed') {
                throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Output reservation commit readback mismatch')
            }
        }
        if (input.to === 'cancelled' && readback.snapshot.outputReservation !== undefined) {
            const reservation = await this.getOutputReservation(readback.snapshot.outputReservation.reservationId)
            if (reservation === null
                || (result.reservationRetained && reservation.state === 'abandoned')
                || (!result.reservationRetained && reservation.state !== 'abandoned')) {
                throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Cancelled reservation readback mismatch')
            }
        }
        return readback
    }

    async updateProgress(input: {
        jobId: string
        leaseOwner: string
        leaseToken: string
        now: string
        progress: GenerationJobProgress
        expectedVersion?: number
        lastDiagnosticEventId?: string | null
    }): Promise<GenerationJob> {
        assertTimestamp(input.now, 'progress time')
        assertProgress(input.progress)
        const nextVersion = await this.runTransaction(['batches', 'jobs', 'leases'], 'readwrite', async transaction => {
            const batches = transaction.objectStore('batches')
            const jobs = transaction.objectStore('jobs')
            const leases = transaction.objectStore('leases')
            const [jobValue, leaseValue] = await Promise.all([
                requestResult(jobs.get(input.jobId)),
                requestResult(leases.get(input.jobId)),
            ])
            if (jobValue === undefined) throw new QueueRepositoryError('E_QUEUE_NOT_FOUND', 'Queue job does not exist')
            const stored = parseStoredJob(jobValue)
            const batchValue = await requestResult(batches.get(stored.batchId))
            if (batchValue === undefined) {
                throw new QueueRepositoryError('E_QUEUE_BATCH_NOT_FOUND', 'Queue batch does not exist')
            }
            const batch = parseBatch(batchValue)
            const lease = parseLease(leaseValue)
            if (isTerminalJobState(stored.state)) {
                throw new QueueRepositoryError('E_QUEUE_TERMINAL_IMMUTABLE', 'Terminal queue jobs are immutable')
            }
            if (input.expectedVersion !== undefined && stored.version !== input.expectedVersion) {
                throw new QueueRepositoryError('E_QUEUE_INVALID_TRANSITION', 'Queue job version changed')
            }
            if (lease === null
                || lease.owner !== input.leaseOwner
                || lease.token !== input.leaseToken
                || Date.parse(lease.expiresAt) < Date.parse(input.now)
                || stored.state !== 'running') {
                throw new QueueRepositoryError('E_QUEUE_LEASE_LOST', 'Queue lease is no longer owned')
            }
            const next = {
                ...stored,
                updatedAt: input.now,
                progress: { ...input.progress },
                version: stored.version + 1,
                ...(input.lastDiagnosticEventId === undefined
                    ? {}
                    : { lastDiagnosticEventId: input.lastDiagnosticEventId }),
            }
            await requestResult(jobs.put(next))
            await requestResult(batches.put(withBatchProjectionDelta(batch, stored, next)))
            return next.version
        })
        const readback = await this.getJob(input.jobId)
        if (readback === null || readback.version !== nextVersion) {
            throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Progress readback mismatch')
        }
        return readback
    }

    async bindOutputTransaction(input: {
        jobId: string
        leaseOwner: string
        leaseToken: string
        now: string
        outputTransactionId: string
        artifactReference: QueueArtifactReference
    }): Promise<GenerationJob> {
        assertTimestamp(input.now, 'output bind time')
        assertIdentifier(input.outputTransactionId, 'output transaction id')
        const version = await this.runTransaction(['batches', 'jobs', 'leases'], 'readwrite', async transaction => {
            const batches = transaction.objectStore('batches')
            const jobs = transaction.objectStore('jobs')
            const [jobValue, leaseValue] = await Promise.all([
                requestResult(jobs.get(input.jobId)),
                requestResult(transaction.objectStore('leases').get(input.jobId)),
            ])
            if (jobValue === undefined) throw new QueueRepositoryError('E_QUEUE_NOT_FOUND', 'Queue job does not exist')
            const stored = parseStoredJob(jobValue)
            const batchValue = await requestResult(batches.get(stored.batchId))
            if (batchValue === undefined) {
                throw new QueueRepositoryError('E_QUEUE_BATCH_NOT_FOUND', 'Queue batch does not exist')
            }
            const batch = parseBatch(batchValue)
            const lease = parseLease(leaseValue)
            if (stored.cancelRequestedAt !== null) {
                throw new QueueRepositoryError('E_QUEUE_CANCEL_REQUESTED', 'Queue job was cancelled before output bind')
            }
            if (stored.state !== 'running'
                || lease === null
                || lease.owner !== input.leaseOwner
                || lease.token !== input.leaseToken
                || Date.parse(lease.expiresAt) < Date.parse(input.now)) {
                throw new QueueRepositoryError('E_QUEUE_LEASE_LOST', 'Queue lease is no longer owned')
            }
            if (stored.outputTransactionId !== null) {
                if (stored.outputTransactionId !== input.outputTransactionId) {
                    throw new QueueRepositoryError(
                        'E_QUEUE_IDEMPOTENCY_CONFLICT',
                        'Queue job is already bound to another output transaction',
                    )
                }
                if (canonicalSerialize(stored.artifactReference) !== canonicalSerialize(input.artifactReference)) {
                    throw new QueueRepositoryError(
                        'E_QUEUE_IDEMPOTENCY_CONFLICT',
                        'Queue job is already bound to another output artifact',
                    )
                }
                return stored.version
            }
            const next: StoredJobRecord = {
                ...stored,
                outputTransactionId: input.outputTransactionId,
                artifactReference: { ...input.artifactReference },
                updatedAt: input.now,
                version: stored.version + 1,
            }
            await requestResult(jobs.put(next))
            await requestResult(batches.put(withBatchProjectionDelta(batch, stored, next)))
            return next.version
        })
        const readback = await this.getJob(input.jobId)
        if (readback === null || readback.version !== version
            || readback.outputTransactionId !== input.outputTransactionId
            || canonicalSerialize(readback.artifactReference) !== canonicalSerialize(input.artifactReference)) {
            throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Output bind readback mismatch')
        }
        return readback
    }

    async recoverFilesCommittedSuccess(input: {
        jobId: string
        now: string
        outputTransactionId: string
        artifactReference: QueueArtifactReference
    }): Promise<GenerationJob> {
        assertTimestamp(input.now, 'output recovery time')
        const version = await this.runTransaction(
            ['batches', 'jobs', 'leases', 'attempts', 'output-reservation-claims', 'output-reservations'],
            'readwrite',
            async transaction => {
            const batches = transaction.objectStore('batches')
            const jobs = transaction.objectStore('jobs')
            const outputReservations = transaction.objectStore('output-reservations')
            const outputReservationClaims = transaction.objectStore('output-reservation-claims')
            const value = await requestResult(jobs.get(input.jobId))
            if (value === undefined) throw new QueueRepositoryError('E_QUEUE_NOT_FOUND', 'Queue job does not exist')
            const stored = parseStoredJob(value)
            if (stored.state === 'succeeded') {
                if (stored.outputTransactionId !== input.outputTransactionId
                    || canonicalSerialize(stored.artifactReference) !== canonicalSerialize(input.artifactReference)) {
                    throw new QueueRepositoryError(
                        'E_QUEUE_IDEMPOTENCY_CONFLICT',
                        'Recovered output linkage differs from terminal queue state',
                    )
                }
                if (stored.snapshot.outputReservation !== undefined) {
                    const reservationValue = await requestResult(
                        outputReservations.get(stored.snapshot.outputReservation.reservationId),
                    )
                    if (reservationValue === undefined || parseOutputReservation(reservationValue).state !== 'committed') {
                        throw new QueueRepositoryError(
                            'E_QUEUE_WRITE_VERIFY',
                            'Recovered queue job does not own a committed output reservation',
                        )
                    }
                }
                return stored.version
            }
            if (isTerminalJobState(stored.state)) {
                throw new QueueRepositoryError('E_QUEUE_TERMINAL_IMMUTABLE', 'Terminal queue jobs are immutable')
            }
            const batchValue = await requestResult(batches.get(stored.batchId))
            if (batchValue === undefined) {
                throw new QueueRepositoryError('E_QUEUE_BATCH_NOT_FOUND', 'Queue batch does not exist')
            }
            const batch = parseBatch(batchValue)
            if (stored.cancelRequestedAt !== null) {
                throw new QueueRepositoryError('E_QUEUE_CANCEL_REQUESTED', 'Queue job was cancelled before recovery')
            }
            if (stored.outputTransactionId !== input.outputTransactionId
                || canonicalSerialize(stored.artifactReference) !== canonicalSerialize(input.artifactReference)) {
                throw new QueueRepositoryError(
                    'E_QUEUE_IDEMPOTENCY_CONFLICT',
                    'Files-committed journal is not pre-bound to this queue job',
                )
            }
            let committedReservation: OutputReservation | null = null
            if (stored.snapshot.outputReservation !== undefined) {
                const snapshotReservation = stored.snapshot.outputReservation
                const reservationValue = await requestResult(outputReservations.get(snapshotReservation.reservationId))
                if (reservationValue === undefined) {
                    throw new QueueRepositoryError('E_QUEUE_NOT_FOUND', 'Output reservation does not exist')
                }
                const reservation = parseOutputReservation(reservationValue)
                if (reservation.batchId !== stored.batchId
                    || reservation.jobId !== stored.id
                    || canonicalSerialize(snapshotReservation) !== canonicalSerialize(snapshotForReservation(reservation))) {
                    throw new QueueRepositoryError(
                        'E_QUEUE_IDEMPOTENCY_CONFLICT',
                        'Recovered output reservation does not match the queue job',
                    )
                }
                if (reservation.state !== 'writing' && reservation.state !== 'committed') {
                    throw new QueueRepositoryError(
                        'E_QUEUE_INVALID_TRANSITION',
                        `Recovered output reservation cannot commit from ${reservation.state}`,
                    )
                }
                if (reservation.state === 'writing') {
                    committedReservation = withReservationState(reservation, 'committed', input.now)
                }
            }
            let next = updateJobState(stored, 'succeeded', input.now)
            next = {
                ...next,
                outputTransactionId: input.outputTransactionId,
                artifactReference: { ...input.artifactReference },
            }
            if (stored.attemptCount > 0) {
                const attemptId = `${stored.id}:${stored.attemptCount}`
                const attempt = await requestResult(transaction.objectStore('attempts').get(attemptId))
                if (isRecord(attempt) && attempt.outcome === 'running') {
                    await requestResult(transaction.objectStore('attempts').put({
                        ...attempt,
                        finishedAt: input.now,
                        outcome: 'succeeded',
                    }))
                }
            }
            await Promise.all([
                requestResult(jobs.put(next)),
                requestResult(transaction.objectStore('leases').delete(stored.id)),
                requestResult(batches.put(withBatchProjectionDelta(batch, stored, next))),
                ...(committedReservation === null
                    ? []
                    : [requestResult(outputReservations.put(storedReservation(committedReservation)))]),
            ])
            if (committedReservation !== null) {
                await releaseReservationClaims(outputReservationClaims, committedReservation.reservationId)
            }
            return next.version
        })
        const readback = await this.getJob(input.jobId)
        if (readback === null || readback.version !== version || readback.state !== 'succeeded') {
            throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Output recovery readback mismatch')
        }
        if (readback.snapshot.outputReservation !== undefined) {
            const reservation = await this.getOutputReservation(readback.snapshot.outputReservation.reservationId)
            if (reservation?.state !== 'committed') {
                throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Recovered reservation readback mismatch')
            }
        }
        return readback
    }

    completeSucceeded(input: {
        jobId: string
        leaseOwner: string
        leaseToken: string
        now: string
        outputTransactionId: string
        artifactReference: QueueArtifactReference
        lastDiagnosticEventId?: string | null
    }): Promise<GenerationJob> {
        return this.transitionJob({ ...input, to: 'succeeded' })
    }

    async requestCancel(input: {
        jobId: string
        now: string
        reason?: 'user' | 'batch' | 'shutdown'
    }): Promise<GenerationJob> {
        assertTimestamp(input.now, 'cancel request time')
        const result = await this.runTransaction(
            ['attempts', 'batches', 'jobs', 'leases', 'output-reservation-claims', 'output-reservations'],
            'readwrite',
            async transaction => {
            const batches = transaction.objectStore('batches')
            const jobs = transaction.objectStore('jobs')
            const leases = transaction.objectStore('leases')
            const attempts = transaction.objectStore('attempts')
            const outputReservations = transaction.objectStore('output-reservations')
            const outputReservationClaims = transaction.objectStore('output-reservation-claims')
            const value = await requestResult(jobs.get(input.jobId))
            if (value === undefined) throw new QueueRepositoryError('E_QUEUE_NOT_FOUND', 'Queue job does not exist')
            const stored = parseStoredJob(value)
            if (isTerminalJobState(stored.state)) {
                const snapshotReservation = stored.state === 'cancelled'
                    ? stored.snapshot.outputReservation
                    : undefined
                const reservationValue = snapshotReservation === undefined
                    ? undefined
                    : await requestResult(outputReservations.get(snapshotReservation.reservationId))
                const reservationRetained = reservationValue === undefined
                    ? false
                    : parseOutputReservation(reservationValue).state !== 'abandoned'
                return { stored, reservationRetained }
            }
            if (stored.cancelRequestedAt !== null) return { stored, reservationRetained: false }
            const batchValue = await requestResult(batches.get(stored.batchId))
            if (batchValue === undefined) {
                throw new QueueRepositoryError('E_QUEUE_BATCH_NOT_FOUND', 'Queue batch does not exist')
            }
            const batch = parseBatch(batchValue)
            const reason = input.reason ?? 'user'
            if (stored.state === 'running') {
                const next: StoredJobRecord = {
                    ...stored,
                    cancelRequestedAt: input.now,
                    cancelReason: reason,
                    updatedAt: input.now,
                    version: stored.version + 1,
                }
                await requestResult(jobs.put(next))
                await requestResult(batches.put(withBatchProjectionDelta(batch, stored, next)))
                return { stored: next, reservationRetained: false }
            }
            const next = {
                ...updateJobState(stored, 'cancelled', input.now),
                cancelRequestedAt: input.now,
                cancelReason: reason,
            }
            let abandonedReservation: OutputReservation | null = null
            let reservationRetained = false
            if (stored.snapshot.outputReservation !== undefined) {
                const snapshotReservation = stored.snapshot.outputReservation
                const reservationValue = await requestResult(outputReservations.get(snapshotReservation.reservationId))
                if (reservationValue === undefined) {
                    throw new QueueRepositoryError('E_QUEUE_NOT_FOUND', 'Output reservation does not exist')
                }
                const reservation = parseOutputReservation(reservationValue)
                if (reservation.batchId !== stored.batchId
                    || reservation.jobId !== stored.id
                    || canonicalSerialize(snapshotReservation) !== canonicalSerialize(snapshotForReservation(reservation))) {
                    throw new QueueRepositoryError(
                        'E_QUEUE_IDEMPOTENCY_CONFLICT',
                        'Output reservation does not match the cancelled job',
                    )
                }
                if (reservation.state === 'committed') {
                    throw new QueueRepositoryError(
                        'E_QUEUE_INVALID_TRANSITION',
                        'A committed output reservation cannot be cancelled',
                    )
                }
                const attempt = stored.attemptCount === 0
                    ? null
                    : parseGenerationAttempt(await requestResult(attempts.get(`${stored.id}:${stored.attemptCount}`)))
                reservationRetained = attempt !== null
                    && providerEvidenceForbidsGenericRetry(attempt.providerEvidence)
                if (!reservationRetained && reservation.state !== 'abandoned') {
                    abandonedReservation = withReservationState(reservation, 'abandoned', input.now)
                }
            }
            if (stored.state === 'leased') await requestResult(leases.delete(stored.id))
            await requestResult(jobs.put(next))
            if (abandonedReservation !== null) {
                await requestResult(outputReservations.put(storedReservation(abandonedReservation)))
                await releaseReservationClaims(outputReservationClaims, abandonedReservation.reservationId)
            }
            await requestResult(batches.put(withBatchProjectionDelta(batch, stored, next)))
            return { stored: next, reservationRetained }
        })
        const readback = await this.getJob(input.jobId)
        if (readback === null || readback.version !== result.stored.version) {
            throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Cancel request readback mismatch')
        }
        if (readback.state === 'cancelled' && readback.snapshot.outputReservation !== undefined) {
            const reservation = await this.getOutputReservation(readback.snapshot.outputReservation.reservationId)
            if (reservation === null
                || (result.reservationRetained && reservation.state === 'abandoned')
                || (!result.reservationRetained && reservation.state !== 'abandoned')) {
                throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Cancelled reservation readback mismatch')
            }
        }
        return readback
    }

    async requestCancelBatch(input: {
        batchId?: string
        now: string
        reason?: 'user' | 'batch' | 'shutdown'
    }): Promise<number> {
        let cursor: string | null = null
        let changed = 0
        do {
            const page = await this.listJobs({ batchId: input.batchId, cursor, limit: 250 })
            for (const job of page.items) {
                if (isTerminalJobState(job.state)) continue
                const cancelled = await this.requestCancel({
                    jobId: job.id,
                    now: input.now,
                    reason: input.reason ?? 'batch',
                })
                if (cancelled.cancelRequestedAt !== null) changed += 1
            }
            cursor = page.nextCursor
        } while (cursor !== null)
        return changed
    }

    async skipJob(input: { jobId: string; now: string; expectedVersion?: number }): Promise<GenerationJob> {
        const job = await this.getJob(input.jobId)
        if (job === null) throw new QueueRepositoryError('E_QUEUE_NOT_FOUND', 'Queue job does not exist')
        if (job.state === 'running' || job.state === 'leased') {
            return this.requestCancel({ jobId: job.id, now: input.now, reason: 'user' })
        }
        return this.transitionJob({
            jobId: input.jobId,
            to: 'skipped',
            now: input.now,
            expectedVersion: input.expectedVersion,
        })
    }

    async requeueAfterFailure(input: {
        jobId: string
        leaseOwner: string
        leaseToken: string
        now: string
        readyAt: string
        failureKind: QueueFailureKind
        lastDiagnosticEventId?: string | null
    }): Promise<GenerationJob> {
        assertTimestamp(input.now, 'retry transition time')
        assertTimestamp(input.readyAt, 'retry readyAt')
        const version = await this.runTransaction(['batches', 'jobs', 'leases', 'attempts'], 'readwrite', async transaction => {
            const batches = transaction.objectStore('batches')
            const jobs = transaction.objectStore('jobs')
            const leases = transaction.objectStore('leases')
            const attempts = transaction.objectStore('attempts')
            const [jobValue, leaseValue] = await Promise.all([
                requestResult(jobs.get(input.jobId)),
                requestResult(leases.get(input.jobId)),
            ])
            if (jobValue === undefined) throw new QueueRepositoryError('E_QUEUE_NOT_FOUND', 'Queue job does not exist')
            const stored = parseStoredJob(jobValue)
            const batchValue = await requestResult(batches.get(stored.batchId))
            if (batchValue === undefined) {
                throw new QueueRepositoryError('E_QUEUE_BATCH_NOT_FOUND', 'Queue batch does not exist')
            }
            const batch = parseBatch(batchValue)
            const lease = parseLease(leaseValue)
            if (stored.cancelRequestedAt !== null) {
                throw new QueueRepositoryError('E_QUEUE_CANCEL_REQUESTED', 'Queue job was cancelled before retry')
            }
            if (stored.state !== 'running'
                || lease === null
                || lease.owner !== input.leaseOwner
                || lease.token !== input.leaseToken
                || Date.parse(lease.expiresAt) < Date.parse(input.now)) {
                throw new QueueRepositoryError('E_QUEUE_LEASE_LOST', 'Queue lease is no longer owned')
            }
            const attemptId = `${stored.id}:${stored.attemptCount}`
            const attemptValue = await requestResult(attempts.get(attemptId))
            if (!isRecord(attemptValue)) {
                throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'Active queue attempt is missing')
            }
            const attempt = parseGenerationAttempt(attemptValue)
            if (providerEvidenceForbidsGenericRetry(attempt.providerEvidence)) {
                throw new QueueRepositoryError(
                    'E_QUEUE_INVALID_TRANSITION',
                    'Provider-dispatched attempts cannot use generic retry',
                )
            }
            await requestResult(attempts.put({
                ...attempt,
                finishedAt: input.now,
                outcome: 'interrupted',
                diagnosticEventId: input.lastDiagnosticEventId ?? null,
                failureKind: input.failureKind,
            }))
            const terminal = stored.attemptCount >= stored.maxAttempts
            let next = updateJobState(stored, terminal ? 'failed' : 'recovering', input.now)
            if (!terminal) next = updateJobState(next, 'queued', input.now)
            next = {
                ...next,
                readyAt: input.readyAt,
                lastDiagnosticEventId: input.lastDiagnosticEventId ?? stored.lastDiagnosticEventId,
            }
            await Promise.all([
                requestResult(jobs.put(next)),
                requestResult(leases.delete(stored.id)),
                requestResult(batches.put(withBatchProjectionDelta(batch, stored, next))),
            ])
            return next.version
        })
        const readback = await this.getJob(input.jobId)
        if (readback === null || readback.version !== version) {
            throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Retry transition readback mismatch')
        }
        return readback
    }

    async retryFailedJobs(input: {
        sourceBatchId: string
        targetBatch: DurableGenerationBatchInput
    }): Promise<CreateBatchAndEnqueueResult> {
        const sourceJobs: GenerationJob[] = []
        let cursor: string | null = null
        do {
            const page = await this.listJobs({ batchId: input.sourceBatchId, states: ['failed'], cursor, limit: 250 })
            sourceJobs.push(...page.items)
            cursor = page.nextCursor
        } while (cursor !== null)
        if (sourceJobs.length === 0) {
            const existing = await this.getBatch(input.targetBatch.id)
            if (existing === null) {
                throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'There are no failed jobs to retry')
            }
            return { batch: existing, jobs: [], reservations: [] }
        }
        const jobs = sourceJobs.map((source, index): EnqueueGenerationJobInput => {
            const retryDigest = hashCanonicalValue({ targetBatchId: input.targetBatch.id, sourceJobId: source.id })
            return {
                id: `retry-job-${retryDigest}`,
                batchId: input.targetBatch.id,
                workflow: source.workflow,
                sceneId: source.sceneId,
                createdAt: input.targetBatch.createdAt,
                priority: source.priority,
                ordinal: index,
                snapshot: source.snapshot,
                compositionPlanHash: source.compositionPlanHash,
                maxAttempts: source.maxAttempts,
                idempotencyKey: `retry-enqueue-${retryDigest}`,
                retryOfJobId: source.id,
                rootJobId: source.rootJobId,
            }
        })
        if (sourceJobs.every(source => source.snapshot.outputReservation === undefined)) {
            return this.createBatchAndEnqueue({ batch: input.targetBatch, jobs })
        }
        if (sourceJobs.some(source => source.snapshot.outputReservation?.reservationSchemaVersion !== 1)) {
            throw new QueueRepositoryError(
                'E_QUEUE_IDEMPOTENCY_CONFLICT',
                'Legacy or mixed failed jobs require a newly planned output reservation before retry',
            )
        }
        assertGenerationAtomicBatchAvailable(
            sourceJobs.length,
            sourceJobs.reduce((total, source) => (
                total + (source.snapshot.outputReservation?.reservationSchemaVersion === 1
                    ? source.snapshot.outputReservation.commitSet.claims.length
                    : 0)
            ), 0),
            this.generationLimits,
        )

        const targetIdentity = batchFromInput(input.targetBatch, 1)
        const selected = await this.runTransaction(
            ['attempts', 'batches', 'jobs', 'output-reservations', 'resources'],
            'readwrite',
            async transaction => {
                const attempts = transaction.objectStore('attempts')
                const batches = transaction.objectStore('batches')
                const jobStore = transaction.objectStore('jobs')
                const reservations = transaction.objectStore('output-reservations')
                const resources = transaction.objectStore('resources')
                const [existingBatchValue, existingByBatchKey] = await Promise.all([
                    requestResult(batches.get(targetIdentity.id)),
                    requestResult(batches.index('by-idempotency-key').get(targetIdentity.idempotencyKey)),
                ])
                if (existingByBatchKey !== undefined
                    && parseBatch(existingByBatchKey).id !== targetIdentity.id) {
                    throw new QueueRepositoryError(
                        'E_QUEUE_IDEMPOTENCY_CONFLICT',
                        'Retry batch idempotency key already represents different work',
                    )
                }
                if (existingBatchValue !== undefined
                    && !hasSameBatchIdentity(parseBatch(existingBatchValue), targetIdentity)) {
                    throw new QueueRepositoryError(
                        'E_QUEUE_IDEMPOTENCY_CONFLICT',
                        'Retry batch identity already represents different work',
                    )
                }
                const existingBatch = existingBatchValue === undefined ? null : parseBatch(existingBatchValue)
                const batch = existingBatch
                    ?? batchFromInput(input.targetBatch, await allocateQueueSequence(batches))
                const candidates = jobs.map(job => storedJobFromInput(job, batch.queueSequence))
                const existingCandidates: StoredJobRecord[] = []
                for (const candidate of candidates) {
                    const existing = await requestResult(
                        jobStore.index('by-idempotency-key').get(candidate.idempotencyKey),
                    )
                    if (existing === undefined) continue
                    const parsed = parseStoredJob(existing)
                    if (parsed.id !== candidate.id
                        || parsed.batchId !== candidate.batchId
                        || parsed.snapshotHash !== candidate.snapshotHash
                        || parsed.compositionPlanHash !== candidate.compositionPlanHash) {
                        throw new QueueRepositoryError(
                            'E_QUEUE_IDEMPOTENCY_CONFLICT',
                            'Retry job idempotency key already represents different work',
                        )
                    }
                    existingCandidates.push(parsed)
                }
                if (existingCandidates.length !== 0 && existingCandidates.length !== candidates.length) {
                    throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Retry batch is only partially persisted')
                }

                const transferred: StoredOutputReservation[] = []
                for (const [index, source] of sourceJobs.entries()) {
                    const sourceValue = await requestResult(jobStore.get(source.id))
                    if (sourceValue === undefined) throw new QueueRepositoryError('E_QUEUE_NOT_FOUND', 'Retry source job is missing')
                    const currentSource = parseStoredJob(sourceValue)
                    if (currentSource.state !== 'failed' || currentSource.snapshotHash !== source.snapshotHash) {
                        throw new QueueRepositoryError('E_QUEUE_INVALID_TRANSITION', 'Retry source job changed')
                    }
                    for (const requirement of candidates[index].snapshot.resources) {
                        const resource = await requestResult(resources.get(requirement.resourceId)) as QueueResourceRecord | undefined
                        if (resource === undefined
                            || resource.digest !== requirement.digest
                            || resource.persistence !== requirement.persistence
                            || canonicalSerialize(resource.reference) !== canonicalSerialize(requirement.reference)) {
                            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'Retry snapshot resource is unavailable')
                        }
                    }
                    if (currentSource.attemptCount > 0) {
                        const attempt = parseGenerationAttempt(await requestResult(
                            attempts.get(`${currentSource.id}:${currentSource.attemptCount}`),
                        ))
                        if (providerEvidenceForbidsGenericRetry(attempt.providerEvidence)) {
                            throw new QueueRepositoryError(
                                'E_QUEUE_INVALID_TRANSITION',
                                'Provider-dispatched attempts cannot transfer reservations to a generic retry',
                            )
                        }
                    }
                    const snapshot = currentSource.snapshot.outputReservation
                    if (snapshot?.reservationSchemaVersion !== 1) {
                        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'Retry reservation snapshot is not current')
                    }
                    const reservationValue = await requestResult(reservations.get(snapshot.reservationId))
                    if (reservationValue === undefined) {
                        throw new QueueRepositoryError('E_QUEUE_NOT_FOUND', 'Retry output reservation is missing')
                    }
                    const reservation = parseOutputReservation(reservationValue)
                    const targetJob = candidates[index]
                    if (reservation.reservationSchemaVersion !== 1
                        || canonicalSerialize(snapshotForReservation(reservation)) !== canonicalSerialize(snapshot)) {
                        throw new QueueRepositoryError('E_QUEUE_IDEMPOTENCY_CONFLICT', 'Retry output reservation changed')
                    }
                    if (existingCandidates.length === candidates.length) {
                        if (reservation.batchId !== targetJob.batchId || reservation.jobId !== targetJob.id) {
                            throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Retry reservation transfer is incomplete')
                        }
                        transferred.push(storedReservation(reservation))
                        continue
                    }
                    if (reservation.batchId !== currentSource.batchId
                        || reservation.jobId !== currentSource.id
                        || (reservation.state !== 'reserved' && reservation.state !== 'writing')) {
                        throw new QueueRepositoryError(
                            'E_QUEUE_INVALID_TRANSITION',
                            'Retry output reservation is not transferable',
                        )
                    }
                    const next: OutputReservation = {
                        ...reservation,
                        batchId: targetJob.batchId,
                        jobId: targetJob.id,
                        state: 'reserved',
                        version: reservation.version + 1,
                        updatedAt: input.targetBatch.createdAt,
                    }
                    transferred.push(storedReservation(next))
                }

                if (existingCandidates.length === 0) {
                    await Promise.all(candidates.map(candidate => requestResult(jobStore.add(candidate))))
                    await Promise.all(transferred.map(reservation => requestResult(reservations.put(reservation))))
                    const projected = withBatchProjectionAdditions(batch, candidates)
                    if (existingBatch === null) await requestResult(batches.add(projected))
                    else await requestResult(batches.put(projected))
                }
                return { batchId: batch.id, jobIds: candidates.map(candidate => candidate.id), reservations: transferred }
            },
        )
        const [batch, readbackJobs, readbackReservations] = await Promise.all([
            this.getBatch(selected.batchId),
            this.getJobsByIds(selected.jobIds),
            Promise.all(selected.reservations.map(reservation => this.getOutputReservation(reservation.reservationId))),
        ])
        if (batch === null
            || readbackJobs.some(job => job === null)
            || readbackReservations.some(reservation => reservation === null)) {
            throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Retry reservation transfer readback mismatch')
        }
        return {
            batch,
            jobs: readbackJobs as GenerationJob[],
            reservations: readbackReservations as OutputReservation[],
        }
    }

    async recoverExpiredLeases(
        now: string,
        options: { includeUnexpired?: boolean } = {},
    ): Promise<string[]> {
        assertTimestamp(now, 'recovery time')
        const recoveredIds = await this.runTransaction(['batches', 'jobs', 'leases', 'attempts'], 'readwrite', async transaction => {
            const batches = transaction.objectStore('batches')
            const jobs = transaction.objectStore('jobs')
            const leases = transaction.objectStore('leases')
            const attempts = transaction.objectStore('attempts')
            const expired = await requestResult(options.includeUnexpired === true
                ? leases.getAll()
                : leases.index('by-expires-at').getAll(this.keyRange.upperBound(now))) as LeaseRecord[]
            const values = await Promise.all(expired.map(lease => requestResult(jobs.get(lease.jobId))))
            const ids: string[] = []
            for (let index = 0; index < expired.length; index += 1) {
                const value = values[index]
                if (value === undefined) {
                    await requestResult(leases.delete(expired[index].jobId))
                    continue
                }
                const stored = parseStoredJob(value)
                if (stored.state !== 'leased' && stored.state !== 'running') {
                    await requestResult(leases.delete(stored.id))
                    continue
                }
                if (stored.state === 'running') {
                    const attemptId = `${stored.id}:${stored.attemptCount}`
                    const attemptValue = await requestResult(attempts.get(attemptId))
                    if (!isRecord(attemptValue)) {
                        throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'Expired running attempt is missing')
                    }
                    const attempt = parseGenerationAttempt(attemptValue)
                    if (providerEvidenceForbidsGenericRetry(attempt.providerEvidence)) continue
                    await requestResult(attempts.put({
                        ...attempt,
                        finishedAt: now,
                        outcome: 'interrupted',
                    }))
                }
                const next = updateJobState(stored, 'recovering', now)
                const batchValue = await requestResult(batches.get(stored.batchId))
                if (batchValue === undefined) {
                    throw new QueueRepositoryError('E_QUEUE_BATCH_NOT_FOUND', 'Queue batch does not exist')
                }
                const batch = parseBatch(batchValue)
                await Promise.all([
                    requestResult(jobs.put(next)),
                    requestResult(leases.delete(stored.id)),
                    requestResult(batches.put(withBatchProjectionDelta(batch, stored, next))),
                ])
                ids.push(stored.id)
            }
            return ids.sort()
        })
        const readback = await this.getJobsByIds(recoveredIds)
        if (readback.some(job => job?.state !== 'recovering' || job.leaseOwner !== null)) {
            throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Lease recovery readback mismatch')
        }
        return recoveredIds
    }

    /** Requeues downstream storage without closing the already-succeeded Provider attempt. */
    async requeueSpooledResult(input: {
        jobId: string
        attemptNumber: number
        leaseOwner: string
        leaseToken: string
        now: string
        readyAt: string
        lastDiagnosticEventId?: string | null
    }): Promise<GenerationJob> {
        assertTimestamp(input.now, 'spooled retry transition time')
        assertTimestamp(input.readyAt, 'spooled retry readyAt')
        const version = await this.runTransaction(['batches', 'jobs', 'leases', 'attempts'], 'readwrite', async transaction => {
            const batches = transaction.objectStore('batches')
            const jobs = transaction.objectStore('jobs')
            const leases = transaction.objectStore('leases')
            const attempts = transaction.objectStore('attempts')
            const [jobValue, leaseValue, attemptValue] = await Promise.all([
                requestResult(jobs.get(input.jobId)),
                requestResult(leases.get(input.jobId)),
                requestResult(attempts.get(`${input.jobId}:${input.attemptNumber}`)),
            ])
            if (jobValue === undefined || attemptValue === undefined) {
                throw new QueueRepositoryError('E_QUEUE_NOT_FOUND', 'Spooled queue job or attempt does not exist')
            }
            const stored = parseStoredJob(jobValue)
            const lease = parseLease(leaseValue)
            const attempt = parseGenerationAttempt(attemptValue)
            if (stored.state !== 'running'
                || stored.attemptCount !== input.attemptNumber
                || attempt.outcome !== 'running'
                || attempt.providerEvidence?.dispatchState !== 'result-spooled'
                || lease === null
                || lease.owner !== input.leaseOwner
                || lease.token !== input.leaseToken
                || Date.parse(lease.expiresAt) < Date.parse(input.now)) {
                throw new QueueRepositoryError('E_QUEUE_LEASE_LOST', 'Spooled result lease is no longer owned')
            }
            const batchValue = await requestResult(batches.get(stored.batchId))
            if (batchValue === undefined) throw new QueueRepositoryError('E_QUEUE_BATCH_NOT_FOUND', 'Queue batch does not exist')
            const batch = parseBatch(batchValue)
            let next = updateJobState(stored, 'recovering', input.now)
            next = updateJobState(next, 'queued', input.now)
            next = {
                ...next,
                readyAt: input.readyAt,
                lastDiagnosticEventId: input.lastDiagnosticEventId ?? stored.lastDiagnosticEventId,
            }
            await Promise.all([
                requestResult(jobs.put(next)),
                requestResult(leases.delete(stored.id)),
                requestResult(batches.put(withBatchProjectionDelta(batch, stored, next))),
            ])
            return next.version
        })
        const readback = await this.getJob(input.jobId)
        if (readback === null || readback.version !== version || readback.state !== 'queued') {
            throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Spooled retry readback mismatch')
        }
        return readback
    }

    /** Resumes a queued spool under a fresh lease while preserving attempt identity and budget. */
    async resumeSpooledAttempt(input: {
        jobId: string
        attemptNumber: number
        leaseOwner: string
        leaseToken: string
        now: string
    }): Promise<GenerationJob> {
        assertTimestamp(input.now, 'spooled resume time')
        const version = await this.runTransaction(['batches', 'jobs', 'leases', 'attempts'], 'readwrite', async transaction => {
            const batches = transaction.objectStore('batches')
            const jobs = transaction.objectStore('jobs')
            const leases = transaction.objectStore('leases')
            const attempts = transaction.objectStore('attempts')
            const [jobValue, leaseValue, attemptValue] = await Promise.all([
                requestResult(jobs.get(input.jobId)),
                requestResult(leases.get(input.jobId)),
                requestResult(attempts.get(`${input.jobId}:${input.attemptNumber}`)),
            ])
            if (jobValue === undefined || attemptValue === undefined) {
                throw new QueueRepositoryError('E_QUEUE_NOT_FOUND', 'Spooled queue job or attempt does not exist')
            }
            const stored = parseStoredJob(jobValue)
            const lease = parseLease(leaseValue)
            const attempt = parseGenerationAttempt(attemptValue)
            if (stored.state !== 'leased'
                || stored.attemptCount !== input.attemptNumber
                || attempt.outcome !== 'running'
                || attempt.providerEvidence?.dispatchState !== 'result-spooled'
                || lease === null
                || lease.owner !== input.leaseOwner
                || lease.token !== input.leaseToken
                || Date.parse(lease.expiresAt) < Date.parse(input.now)) {
                throw new QueueRepositoryError('E_QUEUE_LEASE_LOST', 'Spooled result lease is no longer owned')
            }
            const batchValue = await requestResult(batches.get(stored.batchId))
            if (batchValue === undefined) throw new QueueRepositoryError('E_QUEUE_BATCH_NOT_FOUND', 'Queue batch does not exist')
            const batch = parseBatch(batchValue)
            const next = updateJobState(stored, 'running', input.now)
            await Promise.all([
                requestResult(jobs.put(next)),
                requestResult(batches.put(withBatchProjectionDelta(batch, stored, next))),
            ])
            return next.version
        })
        const readback = await this.getJob(input.jobId)
        if (readback === null || readback.version !== version || readback.attemptCount !== input.attemptNumber) {
            throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Spooled resume readback mismatch')
        }
        return readback
    }

    /** Reconciles previous-process Provider evidence before generic lease recovery can erase it. */
    async reconcileProviderAttemptAfterRestart(
        input: ReconcileProviderAttemptAfterRestartInput,
    ): Promise<GenerationJob> {
        assertTimestamp(input.now, 'provider startup reconcile time')
        const requiredBlockReason = input.nextEvidence.dispatchState === 'result-lost'
            ? 'provider-result-lost'
            : input.nextEvidence.providerOutcome === 'unknown'
                ? 'provider-outcome-unknown'
                : undefined
        if ((input.disposition === 'blocked' && input.blockReason !== requiredBlockReason)
            || (input.disposition === 'queued-spooled'
                && (input.blockReason !== undefined || input.nextEvidence.dispatchState !== 'result-spooled'))
            || (input.disposition === 'failed-known'
                && (input.blockReason !== undefined || input.nextEvidence.providerOutcome !== 'known-failure'))) {
            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'Provider startup disposition is inconsistent')
        }
        const attemptId = `${input.jobId}:${input.attemptNumber}`
        assertProviderEvidence(input.expectedEvidence, attemptId)
        assertProviderEvidence(input.nextEvidence, attemptId)
        const evidenceChanged = canonicalSerialize(input.expectedEvidence) !== canonicalSerialize(input.nextEvidence)
        if (evidenceChanged) assertMonotonicProviderEvidence(input.expectedEvidence, input.nextEvidence)
        const version = await this.runTransaction(['attempts', 'batches', 'jobs', 'leases'], 'readwrite', async transaction => {
            const attempts = transaction.objectStore('attempts')
            const batches = transaction.objectStore('batches')
            const jobs = transaction.objectStore('jobs')
            const leases = transaction.objectStore('leases')
            const [attemptValue, jobValue] = await Promise.all([
                requestResult(attempts.get(attemptId)),
                requestResult(jobs.get(input.jobId)),
            ])
            if (attemptValue === undefined || jobValue === undefined) {
                throw new QueueRepositoryError('E_QUEUE_NOT_FOUND', 'Provider recovery candidate does not exist')
            }
            const attempt = parseGenerationAttempt(attemptValue)
            const job = parseStoredJob(jobValue)
            if (job.state !== 'running' || job.attemptCount !== input.attemptNumber || attempt.outcome !== 'running'
                || canonicalSerialize(attempt.providerEvidence) !== canonicalSerialize(input.expectedEvidence)) {
                throw new QueueRepositoryError('E_QUEUE_INVALID_TRANSITION', 'Provider recovery candidate changed')
            }
            const previousTime = attempt.providerTransitions.length === 0
                ? attempt.startedAt
                : attempt.providerTransitions[attempt.providerTransitions.length - 1].occurredAt
            if (Date.parse(input.now) < Date.parse(previousTime)) {
                throw new QueueRepositoryError('E_QUEUE_INVALID_TRANSITION', 'Provider recovery time moved backwards')
            }
            const nextAttempt: StoredAttemptRecord = {
                ...attempt,
                providerEvidence: structuredClone(input.nextEvidence),
                providerTransitions: evidenceChanged
                    ? [...attempt.providerTransitions, {
                        attemptId,
                        jobId: job.id,
                        attemptNumber: input.attemptNumber,
                        occurredAt: input.now,
                        from: structuredClone(input.expectedEvidence),
                        to: structuredClone(input.nextEvidence),
                        diagnosticEventId: input.diagnosticEventId ?? null,
                    } satisfies ProviderAttemptTransition]
                    : attempt.providerTransitions,
                diagnosticEventId: input.diagnosticEventId ?? attempt.diagnosticEventId,
                ...(input.disposition === 'blocked' || input.disposition === 'failed-known'
                    ? {
                        finishedAt: input.now,
                        outcome: input.disposition === 'failed-known' ? 'failed' as const : 'interrupted' as const,
                    }
                    : {}),
            }
            const batchValue = await requestResult(batches.get(job.batchId))
            if (batchValue === undefined) throw new QueueRepositoryError('E_QUEUE_BATCH_NOT_FOUND', 'Queue batch does not exist')
            const batch = parseBatch(batchValue)
            let next = input.disposition === 'blocked'
                ? updateJobState(job, 'blocked', input.now)
                : input.disposition === 'failed-known'
                    ? updateJobState(job, 'failed', input.now)
                    : updateJobState(updateJobState(job, 'recovering', input.now), 'queued', input.now)
            next = input.disposition === 'blocked'
                ? { ...next, blockReason: input.blockReason ?? null, lastDiagnosticEventId: input.diagnosticEventId ?? job.lastDiagnosticEventId }
                : { ...next, readyAt: input.now, lastDiagnosticEventId: input.diagnosticEventId ?? job.lastDiagnosticEventId }
            await Promise.all([
                requestResult(attempts.put(nextAttempt)),
                requestResult(jobs.put(next)),
                requestResult(leases.delete(job.id)),
                requestResult(batches.put(withBatchProjectionDelta(batch, job, next))),
            ])
            return next.version
        })
        const readback = await this.getJob(input.jobId)
        if (readback === null || readback.version !== version) {
            throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Provider startup reconcile readback mismatch')
        }
        return readback
    }

    /** Appends one lease-owned Provider fact and can atomically fail closed without creating another store. */
    async recordProviderAttemptTransition(
        input: RecordProviderAttemptTransitionInput,
    ): Promise<GenerationAttempt> {
        assertIdentifier(input.jobId, 'provider transition job id')
        assertIdentifier(input.leaseOwner, 'provider transition lease owner')
        assertIdentifier(input.leaseToken, 'provider transition lease token')
        assertTimestamp(input.now, 'provider transition time')
        if (!Number.isSafeInteger(input.attemptNumber) || input.attemptNumber < 1) {
            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'provider transition attempt number is invalid')
        }
        const attemptId = `${input.jobId}:${input.attemptNumber}`
        assertProviderEvidence(input.expectedEvidence, attemptId)
        assertProviderEvidence(input.nextEvidence, attemptId)
        assertMonotonicProviderEvidence(input.expectedEvidence, input.nextEvidence)
        if (input.diagnosticEventId !== undefined && input.diagnosticEventId !== null) {
            assertIdentifier(input.diagnosticEventId, 'provider transition diagnostic id')
            if (/[\\/]/.test(input.diagnosticEventId)) {
                throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'provider diagnostic must be an opaque event id')
            }
        }
        const requiredBlockReason = input.nextEvidence.dispatchState === 'result-lost'
            ? 'provider-result-lost'
            : input.nextEvidence.providerOutcome === 'unknown'
                ? 'provider-outcome-unknown'
                : undefined
        if (input.blockReason !== requiredBlockReason) {
            throw new QueueRepositoryError(
                'E_QUEUE_RECORD_INVALID',
                'Provider unknown/lost evidence and its fail-closed Queue block must be recorded together',
            )
        }

        const written = await this.runTransaction(
            ['attempts', 'batches', 'jobs', 'leases'],
            'readwrite',
            async transaction => {
                const attempts = transaction.objectStore('attempts')
                const batches = transaction.objectStore('batches')
                const jobs = transaction.objectStore('jobs')
                const leases = transaction.objectStore('leases')
                const [attemptValue, jobValue, leaseValue] = await Promise.all([
                    requestResult(attempts.get(attemptId)),
                    requestResult(jobs.get(input.jobId)),
                    requestResult(leases.get(input.jobId)),
                ])
                if (attemptValue === undefined) {
                    throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'active Provider attempt is missing')
                }
                if (jobValue === undefined) throw new QueueRepositoryError('E_QUEUE_NOT_FOUND', 'Queue job does not exist')
                const attempt = parseGenerationAttempt(attemptValue)
                const job = parseStoredJob(jobValue)
                const lease = parseLease(leaseValue)
                if (job.state !== 'running'
                    || job.attemptCount !== input.attemptNumber
                    || attempt.jobId !== job.id
                    || attempt.outcome !== 'running'
                    || lease === null
                    || lease.owner !== input.leaseOwner
                    || lease.token !== input.leaseToken
                    || Date.parse(lease.expiresAt) < Date.parse(input.now)) {
                    throw new QueueRepositoryError('E_QUEUE_LEASE_LOST', 'Provider attempt lease is no longer owned')
                }
                if (attempt.providerEvidence === null) {
                    throw new QueueRepositoryError('E_QUEUE_INVALID_TRANSITION', 'Legacy attempts cannot acquire invented Provider evidence')
                }
                if (canonicalSerialize(attempt.providerEvidence) !== canonicalSerialize(input.expectedEvidence)) {
                    throw new QueueRepositoryError('E_QUEUE_INVALID_TRANSITION', 'Provider attempt evidence changed')
                }
                const previousTime = attempt.providerTransitions.length === 0
                    ? attempt.startedAt
                    : attempt.providerTransitions[attempt.providerTransitions.length - 1].occurredAt
                if (Date.parse(input.now) < Date.parse(previousTime)) {
                    throw new QueueRepositoryError('E_QUEUE_INVALID_TRANSITION', 'Provider transition time moved backwards')
                }
                const transition: ProviderAttemptTransition = {
                    attemptId,
                    jobId: job.id,
                    attemptNumber: input.attemptNumber,
                    occurredAt: input.now,
                    from: structuredClone(input.expectedEvidence),
                    to: structuredClone(input.nextEvidence),
                    diagnosticEventId: input.diagnosticEventId ?? null,
                }
                const nextAttempt: StoredAttemptRecord = {
                    ...attempt,
                    providerEvidence: structuredClone(input.nextEvidence),
                    providerTransitions: [...attempt.providerTransitions, transition],
                    diagnosticEventId: input.diagnosticEventId ?? attempt.diagnosticEventId,
                    ...(input.blockReason === undefined
                        ? {}
                        : { finishedAt: input.now, outcome: 'interrupted' as const }),
                }
                await requestResult(attempts.put(nextAttempt))

                let blockedVersion: number | null = null
                if (input.blockReason !== undefined) {
                    const batchValue = await requestResult(batches.get(job.batchId))
                    if (batchValue === undefined) {
                        throw new QueueRepositoryError('E_QUEUE_BATCH_NOT_FOUND', 'Queue batch does not exist')
                    }
                    const batch = parseBatch(batchValue)
                    try {
                        assertJobTransition(job.state, 'blocked')
                    } catch (error) {
                        throw normalizeRepositoryError(error)
                    }
                    const blocked = {
                        ...updateJobState(job, 'blocked', input.now),
                        blockReason: input.blockReason,
                        lastDiagnosticEventId: input.diagnosticEventId ?? job.lastDiagnosticEventId,
                    }
                    await Promise.all([
                        requestResult(jobs.put(blocked)),
                        requestResult(leases.delete(job.id)),
                        requestResult(batches.put(withBatchProjectionDelta(batch, job, blocked))),
                    ])
                    blockedVersion = blocked.version
                }
                return { attempt: nextAttempt, blockedVersion }
            },
        )

        const attempts = await this.listAttempts(input.jobId)
        const readback = attempts.find(attempt => attempt.attemptNumber === input.attemptNumber)
        if (readback === undefined
            || canonicalSerialize(readback.providerEvidence) !== canonicalSerialize(input.nextEvidence)
            || readback.providerTransitions.length !== written.attempt.providerTransitions.length) {
            throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Provider attempt transition readback mismatch')
        }
        if (written.blockedVersion !== null) {
            const job = await this.getJob(input.jobId)
            if (job === null
                || job.version !== written.blockedVersion
                || job.state !== 'blocked'
                || job.blockReason !== input.blockReason
                || job.leaseOwner !== null) {
                throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Provider block transition readback mismatch')
            }
        }
        return readback
    }

    async listAttempts(jobId: string): Promise<GenerationAttempt[]> {
        assertIdentifier(jobId, 'attempt job id')
        return this.runTransaction(['attempts'], 'readonly', async transaction => {
            const index = transaction.objectStore('attempts').index('by-job-attempt')
            const range = this.keyRange.bound([jobId], [jobId, []])
            const values = await requestResult(index.getAll(range)) as unknown[]
            return values
                .map(parseGenerationAttempt)
                .sort((left, right) => left.attemptNumber - right.attemptNumber)
                .map(({ jobAttemptKey: _jobAttemptKey, ...attempt }) => structuredClone(attempt))
        })
    }

    async listJobs(input: ListGenerationJobsInput = {}): Promise<GenerationJobPage> {
        const limit = input.limit ?? 100
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'Queue page limit is invalid')
        }
        const states = input.states === undefined ? null : new Set(input.states)
        const decoded = input.cursor ? decodeCursor(input.cursor) : null
        const indexKind = input.batchId !== undefined
            ? 'batch'
            : states !== null && states.size === 1
                ? 'state'
                : 'global'
        const singleState = indexKind === 'state' ? [...states as Set<GenerationJobState>][0] : null
        if (decoded !== null
            && (decoded.index !== indexKind
                || decoded.batchId !== (input.batchId ?? null)
                || decoded.state !== singleState)) {
            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'Queue page cursor scope changed')
        }

        const selected = await this.runTransaction(['jobs'], 'readonly', transaction => new Promise<{
            records: StoredJobRecord[]
            hasMore: boolean
            lastKey: IDBValidKey | null
        }>((resolve, reject) => {
            const store = transaction.objectStore('jobs')
            const index = indexKind === 'batch'
                ? store.index('by-batch-order')
                : indexKind === 'state'
                    ? store.index('by-state-order')
                    : store.index('by-global-order')
            let range: IDBKeyRange | undefined
            if (indexKind === 'batch') {
                const upper = [input.batchId as string, []]
                range = decoded === null
                    ? this.keyRange.bound([input.batchId as string], upper)
                    : this.keyRange.bound(decoded.key, upper, true, false)
            } else if (indexKind === 'state') {
                const upper = [singleState as string, []]
                range = decoded === null
                    ? this.keyRange.bound([singleState as string], upper)
                    : this.keyRange.bound(decoded.key, upper, true, false)
            } else if (decoded !== null) {
                range = this.keyRange.lowerBound(decoded.key, true)
            }
            const records: StoredJobRecord[] = []
            let lastKey: IDBValidKey | null = null
            const request = index.openCursor(range)
            request.onerror = () => reject(request.error ?? new Error('Queue cursor failed'))
            request.onsuccess = () => {
                const cursor = request.result
                if (cursor === null) {
                    resolve({ records, hasMore: false, lastKey })
                    return
                }
                const record = parseStoredJob(cursor.value)
                if (states !== null && !states.has(record.state)) {
                    cursor.continue()
                    return
                }
                if (records.length === limit) {
                    resolve({ records, hasMore: true, lastKey })
                    return
                }
                records.push(record)
                lastKey = cursor.key
                cursor.continue()
            }
        }))

        const jobs = await this.getJobsByIds(selected.records.map(record => record.id)) as GenerationJob[]
        return {
            items: jobs,
            nextCursor: selected.hasMore && selected.lastKey !== null
                ? encodeCursor({
                    index: indexKind,
                    batchId: input.batchId ?? null,
                    state: singleState,
                    key: selected.lastKey,
                })
                : null,
        }
    }

    async listJobProjections(input: ListGenerationJobsInput = {}): Promise<GenerationJobProjectionPage> {
        const page = await this.listJobs(input)
        return {
            items: page.items.map(job => ({
                id: job.id,
                batchId: job.batchId,
                workflow: job.workflow,
                sceneId: job.sceneId,
                outputDirectory: projectionOutputDirectory(job.snapshot),
                state: job.state,
                createdAt: job.createdAt,
                updatedAt: job.updatedAt,
                priority: job.priority,
                ordinal: job.ordinal,
                attemptCount: job.attemptCount,
                maxAttempts: job.maxAttempts,
                progress: { ...job.progress },
                readyAt: job.readyAt,
                cancelRequestedAt: job.cancelRequestedAt,
                retryOfJobId: job.retryOfJobId,
                lastDiagnosticEventId: job.lastDiagnosticEventId,
                outputTransactionId: job.outputTransactionId,
                version: job.version,
            })),
            nextCursor: page.nextCursor,
        }
    }

    async getBatchProjectionMeta(batchId: string): Promise<GenerationBatchProjectionMeta> {
        assertIdentifier(batchId, 'batch id')
        const batch = await this.getBatch(batchId)
        if (batch === null) {
            throw new QueueRepositoryError('E_QUEUE_BATCH_NOT_FOUND', 'Queue batch does not exist')
        }
        return {
            batchId,
            revision: batch.projectionRevision,
            summary: structuredClone(batch.projectionSummary),
        }
    }

    /**
     * Reads only the rows surrounding Queue Center's virtual range. The batch
     * aggregate and jobs share one readonly transaction, so a returned revision
     * always describes the same durable projection as its items and total.
     */
    async listJobProjectionWindow(
        input: ListGenerationJobProjectionWindowInput,
    ): Promise<GenerationJobProjectionWindow> {
        assertIdentifier(input.batchId, 'batch id')
        if (input.state !== undefined && !isGenerationJobState(input.state)) {
            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'Queue projection state is invalid')
        }
        if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'Queue projection offset is invalid')
        }
        if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
            throw new QueueRepositoryError('E_QUEUE_RECORD_INVALID', 'Queue projection window limit is invalid')
        }

        return this.runTransaction(['batches', 'jobs'], 'readonly', async transaction => {
            const batchValue = await requestResult(transaction.objectStore('batches').get(input.batchId))
            if (batchValue === undefined) {
                throw new QueueRepositoryError('E_QUEUE_BATCH_NOT_FOUND', 'Queue batch does not exist')
            }
            const batch = parseBatch(batchValue)
            const state = input.state ?? null
            const total = state === null
                ? batch.projectionSummary.total
                : batch.projectionSummary.states[state]
            const jobs = transaction.objectStore('jobs')
            const index = state === null
                ? jobs.index('by-batch-order')
                : jobs.index('by-batch-state-order')
            const range = state === null
                ? this.keyRange.bound([input.batchId], [input.batchId, []])
                : this.keyRange.bound([input.batchId, state], [input.batchId, state, []])
            const items = await new Promise<GenerationJobProjection[]>((resolve, reject) => {
                const selected: GenerationJobProjection[] = []
                let advanced = false
                const request = index.openCursor(range)
                request.onerror = () => reject(request.error ?? new Error('Queue projection cursor failed'))
                request.onsuccess = () => {
                    const cursor = request.result
                    if (cursor === null || selected.length >= input.limit) {
                        resolve(selected)
                        return
                    }
                    if (!advanced && input.offset > 0) {
                        advanced = true
                        cursor.advance(input.offset)
                        return
                    }
                    advanced = true
                    selected.push(projectStoredJob(parseStoredJob(cursor.value)))
                    cursor.continue()
                }
            })
            return {
                batchId: input.batchId,
                revision: batch.projectionRevision,
                summary: structuredClone(batch.projectionSummary),
                state,
                offset: input.offset,
                total,
                items,
            }
        })
    }

    async getBatchSummary(batchId: string): Promise<GenerationBatchSummary> {
        return (await this.getBatchProjectionMeta(batchId)).summary
    }

    async getActivitySummary(): Promise<QueueActivitySummary> {
        return this.runTransaction(['jobs'], 'readonly', async transaction => {
            const stateOrder = transaction.objectStore('jobs').index('by-state-order')
            const countState = (state: GenerationJobState) => (
                requestResult(stateOrder.count(this.keyRange.bound([state], [state, []])))
            )
            // The app shell and Queue Center have different read budgets: this shared
            // indicator counts indexed states only, while Queue Center owns detailed
            // job projections, progress, and retry controls.
            const [queued, leased, running, recovering, failed, blocked] = await Promise.all([
                countState('queued'),
                countState('leased'),
                countState('running'),
                countState('recovering'),
                countState('failed'),
                countState('blocked'),
            ])
            return {
                processing: leased + running + recovering,
                waiting: queued,
                needsAttention: failed + blocked,
            }
        })
    }
}

/**
 * Queue Center never needs snapshots or leases. This shared projection keeps
 * pagination and the new viewport query aligned while avoiding those payloads.
 */
function projectStoredJob(stored: StoredJobRecord): GenerationJobProjection {
    return {
        id: stored.id,
        batchId: stored.batchId,
        workflow: stored.workflow,
        sceneId: stored.sceneId,
        outputDirectory: projectionOutputDirectory(stored.snapshot),
        state: stored.state,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
        priority: stored.priority,
        ordinal: stored.ordinal,
        attemptCount: stored.attemptCount,
        maxAttempts: stored.maxAttempts,
        progress: { ...stored.progress },
        readyAt: stored.readyAt,
        cancelRequestedAt: stored.cancelRequestedAt,
        retryOfJobId: stored.retryOfJobId,
        lastDiagnosticEventId: stored.lastDiagnosticEventId,
        outputTransactionId: stored.outputTransactionId,
        version: stored.version,
    }
}

function withBatchProjectionDelta(
    batch: GenerationBatch,
    previous: StoredJobRecord | null,
    next: StoredJobRecord | null,
): GenerationBatch {
    return {
        ...batch,
        projectionRevision: batch.projectionRevision + 1,
        projectionSummary: applyGenerationJobProjectionDelta(
            batch.projectionSummary,
            previous === null ? null : projectStoredJob(previous),
            next === null ? null : projectStoredJob(next),
        ),
    }
}

function withBatchProjectionAdditions(
    batch: GenerationBatch,
    additions: readonly StoredJobRecord[],
): GenerationBatch {
    if (additions.length === 0) return batch
    const projectionSummary = additions.reduce(
        (summary, candidate) => applyGenerationJobProjectionDelta(
            summary,
            null,
            projectStoredJob(candidate),
        ),
        batch.projectionSummary,
    )
    return {
        ...batch,
        // A bulk enqueue is one atomic projection change. Consumers only need
        // to know that their viewport is stale, not how many rows were added.
        projectionRevision: batch.projectionRevision + 1,
        projectionSummary,
    }
}

let runtimeQueueRepository: IndexedDBQueueRepository | null = null

export function getRuntimeQueueRepository(): IndexedDBQueueRepository {
    runtimeQueueRepository ??= new IndexedDBQueueRepository({
        generationLimits: runtimeCapabilities.generationPublication.generationLimits,
    })
    return runtimeQueueRepository
}

export function resetRuntimeQueueRepositoryForTests(): void {
    runtimeQueueRepository?.close()
    runtimeQueueRepository = null
}
