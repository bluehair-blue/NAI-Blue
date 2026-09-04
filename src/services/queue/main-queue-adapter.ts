import {
    planMainBatch,
    type MainBatchPlannerPort,
} from '@/application/generation/plan-main-batch'
import type {
    GenerationPlan,
    PlanGenerationInput,
    PlanGenerationResult,
    PlanIssue,
} from '@/application/generation/generation-plan-contract'
import {
    hashGenerationSemanticIntent,
    replayGenerationPlan,
    type PlanGenerationDependencies,
} from '@/application/generation/plan-generation'
import {
    assertAnlasCostConsentAllows,
    type AnlasCostConsentSnapshot,
} from '@/domain/queue/anlas-cost-consent'
import {
    CURRENT_MAIN_QUEUE_POLICY,
    type OutputCommitSetReservation,
    type OutputReservationFolderBinding,
    type QueueFailurePolicy,
    type QueueResourceRecord,
} from '@/domain/queue/types'
import { canonicalSerialize, hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import { calculateAnlasCost } from '@/lib/anlas-calculator'
import type { PreparedMainGeneration } from '@/services/generation/main-generation-plan'
import {
    CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
    queryNaiGenerationCompatibility,
} from '@/services/nai/compatibility'
import {
    assertGenerationAtomicBatchAvailable,
    getRuntimeQueueRepository,
    QueueRepositoryError,
    type CreateBatchAndEnqueueResult,
    type EnqueueGenerationJobInput,
} from './indexeddb-queue-repository'
import { runtimeCapabilities } from '@/platform/capabilities'
import { QueueExecutionError } from './durable-queue-coordinator'
import {
    encodeMainJobSnapshot,
    type MainProviderExecutionReviewContext,
} from './main-job-snapshot-codec'
import { bindOutputReservationSnapshot } from './job-snapshot'
import { ensureImageFileExtension } from '@/services/output/filename-policy'
import {
    assertExactOutputCommitSetAllocation,
    generationOutputClaimKinds,
    outputFilesystemSemantics,
} from '@/services/output/generation-output-commit-set'
import { getRuntimeMainQueueDependencies } from './main-queue-runtime-dependencies'
import {
    dehydrateGenerationParams,
    getRuntimeQueueResourceMaterializer,
    type MaterializedQueueResource,
} from './queue-resource-materializer'
import { generationFolderDocumentMutationKey } from '@/application/workspace/workspace-mutation-gate'
import { runtimeWorkspaceMutationGate } from '@/lib/workspace-mutation-gate'

let mainEnqueueInFlight: Promise<CreateBatchAndEnqueueResult | null> | null = null

export interface EnqueuePlannedMainBatchOptions {
    readonly planner: MainBatchPlannerPort<PreparedMainGeneration>
    readonly submissionPolicy: { readonly kind: 'guided'; readonly costConsent: AnlasCostConsentSnapshot }
    /** Stable draft/revision scope makes a retried Guided submit idempotent. */
    readonly idempotencyScope?: string
    readonly folderBinding?: OutputReservationFolderBinding
}

type ReviewedMainSubmissionPolicy = {
    readonly kind: 'guided' | 'reviewed'
    readonly costConsent: AnlasCostConsentSnapshot
}

export interface EnqueueReviewedMainPlanOptions {
    readonly reviewed: GenerationPlan<PreparedMainGeneration>
    readonly input: Omit<PlanGenerationInput<PreparedMainGeneration>, 'seedPolicy'>
    readonly dependencies: PlanGenerationDependencies<PreparedMainGeneration>
    readonly submissionPolicy: ReviewedMainSubmissionPolicy
    /** Defaults to the stable reviewed plan identity for retry-safe Queue writes. */
    readonly idempotencyScope?: string
}

export type EnqueueReviewedMainPlanResult =
    | { readonly status: 'enqueued'; readonly queue: CreateBatchAndEnqueueResult }
    | { readonly status: 'conflict'; readonly issues: readonly PlanIssue[] }
    | Exclude<PlanGenerationResult<PreparedMainGeneration>, { readonly status: 'ready' }>

interface EnqueueMainBatchOptions {
    readonly planner: MainBatchPlannerPort<PreparedMainGeneration>
    readonly submissionPolicy:
        | { readonly kind: 'advanced' }
        | ReviewedMainSubmissionPolicy
    readonly queuePolicy?: {
        readonly failurePolicy: QueueFailurePolicy
        readonly maxAttempts: number
    }
    readonly providerExecutionContexts?: readonly MainProviderExecutionReviewContext[]
    readonly idempotencyScope?: string
    readonly folderBinding?: OutputReservationFolderBinding
}

function estimatePreparedBatchAnlas(
    prepared: readonly PreparedMainGeneration[],
    pricingBasis: AnlasCostConsentSnapshot['pricingBasis'],
): number {
    return prepared.reduce((total, item) => {
        const params = item.params
        return total + calculateAnlasCost({
            model: params.model,
            width: params.width,
            height: params.height,
            steps: params.steps,
            imageCount: 1,
            pricingBasis,
        })
    }, 0)
}

/**
 * Depends on the configured Main Planner, Snapshot Codec, resource materializer,
 * and Queue repository. It serializes concurrent UI requests into one atomic
 * batch enqueue while provider execution remains owned by main-queue-executor.
 */
export function enqueueCurrentMainBatch(): Promise<CreateBatchAndEnqueueResult | null> {
    const dependencies = getRuntimeMainQueueDependencies()
    mainEnqueueInFlight ??= enqueueMainBatch({
        planner: dependencies.planner,
        submissionPolicy: { kind: 'advanced' },
        folderBinding: dependencies.outputReservations.getCurrentFolderBinding() ?? undefined,
    }).finally(() => {
        mainEnqueueInFlight = null
    })
    return mainEnqueueInFlight
}

/**
 * Shares Main snapshot encoding, resource dehydration, and atomic Queue writes
 * between the expert Zustand planner and detached Guided draft planners.
 */
export async function enqueuePlannedMainBatch(
    options: EnqueuePlannedMainBatchOptions,
): Promise<CreateBatchAndEnqueueResult | null> {
    return enqueueMainBatch(options)
}

/**
 * Revalidates the reviewed plan and its saved seeds before touching presentation,
 * resources, codecs, or Queue storage. The current Queue can select credentials
 * only at execution time, so pinned affinity is rejected until it can be preserved.
 */
export async function enqueueReviewedMainPlan(
    options: EnqueueReviewedMainPlanOptions,
): Promise<EnqueueReviewedMainPlanResult> {
    const replayed = await replayGenerationPlan(
        options.reviewed,
        options.input,
        options.dependencies,
    )
    if (replayed.status !== 'ready') return replayed

    if (replayed.plan.executionPolicy.credentialDispatch.kind === 'pinned') {
        const issue: PlanIssue = Object.freeze({
            code: 'unsupported-pinned-credential-affinity',
            severity: 'blocking',
            fieldPath: 'executionPolicy.credentialDispatch',
            message: 'The current Queue cannot preserve pinned credential affinity.',
        })
        return Object.freeze({
            status: 'unsupported',
            capability: issue.code,
            issues: Object.freeze([issue]),
        })
    }

    const executionPolicy = replayed.plan.executionPolicy
    const folderBindings = replayed.plan.sourceBindings.filter(
        (binding): binding is OutputReservationFolderBinding => (
            binding.resourceType === 'generation-folder-document' && binding.revision !== null
        ),
    )
    if (folderBindings.length > 1) {
        const issue: PlanIssue = Object.freeze({
            code: 'invalid-generation-folder-binding',
            severity: 'blocking',
            fieldPath: 'sourceBindings',
            message: 'The reviewed plan contains more than one generation-folder authority.',
        })
        return Object.freeze({ status: 'invalid', issues: Object.freeze([issue]) })
    }
    const folderBinding = folderBindings[0]
    if (folderBinding !== undefined) {
        const current = getRuntimeMainQueueDependencies().outputReservations.getCurrentFolderBinding()
        if (current === null || canonicalSerialize(current) !== canonicalSerialize(folderBinding)) {
            const issue: PlanIssue = Object.freeze({
                code: 'stale-generation-folder-binding',
                severity: 'blocking',
                fieldPath: 'sourceBindings',
                message: 'The generation folder changed after review. Recapture the batch.',
            })
            return Object.freeze({ status: 'conflict', issues: Object.freeze([issue]) })
        }
    }
    const unsupportedPolicyIssues: PlanIssue[] = []
    if (executionPolicy.retryPolicyId !== CURRENT_MAIN_QUEUE_POLICY.retryPolicyId) {
        unsupportedPolicyIssues.push(Object.freeze({
            code: 'unsupported-retry-policy',
            severity: 'blocking',
            fieldPath: 'executionPolicy.retryPolicyId',
            message: 'The reviewed retry policy is not implemented by the current Queue.',
        }))
    }
    if (executionPolicy.maxConcurrency !== CURRENT_MAIN_QUEUE_POLICY.maxConcurrency) {
        unsupportedPolicyIssues.push(Object.freeze({
            code: 'unsupported-main-queue-concurrency',
            severity: 'blocking',
            fieldPath: 'executionPolicy.maxConcurrency',
            message: 'The reviewed concurrency limit is not implemented by the current Queue.',
        }))
    }
    if (unsupportedPolicyIssues.length > 0) {
        return Object.freeze({
            status: 'unsupported',
            capability: unsupportedPolicyIssues[0].code,
            issues: Object.freeze(unsupportedPolicyIssues),
        })
    }
    if ((executionPolicy.failurePolicy !== 'continue' && executionPolicy.failurePolicy !== 'stop')
        || !Number.isSafeInteger(executionPolicy.maxAttempts)
        || executionPolicy.maxAttempts < 1) {
        const issue: PlanIssue = Object.freeze({
            code: 'invalid-queue-execution-policy',
            severity: 'blocking',
            fieldPath: 'executionPolicy',
            message: 'The reviewed Queue execution policy is invalid.',
        })
        return Object.freeze({ status: 'invalid', issues: Object.freeze([issue]) })
    }

    const consent = options.submissionPolicy.costConsent
    try {
        assertAnlasCostConsentAllows(consent, replayed.plan.estimatedAnlas)
    } catch {
        const issue: PlanIssue = Object.freeze({
            code: 'invalid-anlas-cost-consent',
            severity: 'blocking',
            fieldPath: 'submissionPolicy.costConsent',
            message: 'A current Anlas cost consent matching the reviewed estimate is required.',
        })
        return Object.freeze({ status: 'invalid', issues: Object.freeze([issue]) })
    }
    if (consent.pricingBasis !== executionPolicy.pricingBasis
        || consent.maxAnlas > replayed.plan.budget.maxAnlas) {
        const issue: PlanIssue = Object.freeze({
            code: 'cost-consent-plan-mismatch',
            severity: 'blocking',
            fieldPath: 'submissionPolicy.costConsent',
            message: 'The cost consent does not match the reviewed pricing basis and budget.',
        })
        return Object.freeze({ status: 'invalid', issues: Object.freeze([issue]) })
    }

    if (replayed.plan.jobs.some((job, ordinal) => job.ordinal !== ordinal)) {
        const issue: PlanIssue = Object.freeze({
            code: 'invalid-replayed-job-ordinals',
            severity: 'blocking',
            fieldPath: 'jobs',
            message: 'Replayed job ordinals must be contiguous and ordered before Queue encoding.',
        })
        return Object.freeze({ status: 'invalid', issues: Object.freeze([issue]) })
    }
    const prepared = replayed.plan.jobs.map(job => job.prepared)
    const providerExecutionContexts = replayed.plan.jobs.map(job => ({
        compatibilityProfileId: job.compatibility.compatibilityProfileId,
        semanticIntentHash: hashGenerationSemanticIntent(job.semantic),
    }))
    let queue: CreateBatchAndEnqueueResult | null
    try {
        queue = await enqueueMainBatch({
            planner: {
                getRequestedCount: () => prepared.length,
                prepareBatch: async () => prepared,
            },
            submissionPolicy: options.submissionPolicy,
            queuePolicy: {
                failurePolicy: executionPolicy.failurePolicy === 'stop'
                    ? 'stop-on-first-error'
                    : 'continue',
                maxAttempts: executionPolicy.maxAttempts,
            },
            providerExecutionContexts,
            idempotencyScope: options.idempotencyScope ?? replayed.plan.planId,
            ...(folderBinding === undefined ? {} : { folderBinding }),
        })
    } catch (error) {
        if (error instanceof QueueRepositoryError
            && (error.code === 'GENERATION_ATOMIC_BATCH_UNAVAILABLE'
                || error.code === 'GENERATION_ATOMIC_BATCH_LIMIT_EXCEEDED')) {
            const issue: PlanIssue = Object.freeze({
                code: error.code,
                severity: 'blocking',
                fieldPath: 'jobs',
                message: error.message,
            })
            return Object.freeze({ status: 'invalid', issues: Object.freeze([issue]) })
        }
        if (error instanceof QueueRepositoryError
            && error.code === 'E_QUEUE_IDEMPOTENCY_CONFLICT') {
            const issue: PlanIssue = Object.freeze({
                code: 'generation-idempotency-conflict',
                severity: 'blocking',
                fieldPath: 'idempotencyKey',
                message: error.message,
            })
            return Object.freeze({ status: 'conflict', issues: Object.freeze([issue]) })
        }
        throw error
    }
    if (queue !== null) return { status: 'enqueued', queue }

    return {
        status: 'invalid',
        issues: [{
            code: 'invalid-replayed-job-count',
            severity: 'blocking',
            fieldPath: 'jobs',
            message: 'The replayed plan did not contain a queueable job count.',
        }],
    }
}

async function enqueueMainBatch(
    options: EnqueueMainBatchOptions,
): Promise<CreateBatchAndEnqueueResult | null> {
    const dependencies = getRuntimeMainQueueDependencies()
    const operationId = dependencies.presentation.beginEnqueueOperation()
    const idempotencyScope = options.idempotencyScope ?? operationId
    if (!['advanced', 'guided', 'reviewed'].includes(options.submissionPolicy?.kind)) {
        dependencies.presentation.completeEnqueueOperation(operationId)
        throw new TypeError('Main enqueue submission policy is required')
    }
    if (idempotencyScope.length === 0 || idempotencyScope.length > 200) {
        dependencies.presentation.completeEnqueueOperation(operationId)
        throw new TypeError('Main enqueue idempotency scope must contain 1-200 characters')
    }

    try {
        const folderBinding = options.folderBinding
            ?? dependencies.outputReservations.getCurrentFolderBinding()
        if (folderBinding === null || folderBinding === undefined) {
            throw new QueueExecutionError('fatal', 'Generation folder authority is not ready')
        }
        const materializer = getRuntimeQueueResourceMaterializer()
        const resourceCache = new Map<string, Promise<MaterializedQueueResource>>()
        const resources = new Map<string, QueueResourceRecord>()
        let costConsent: AnlasCostConsentSnapshot | undefined
        const plan = await planMainBatch({
            planner: options.planner,
            preflight: prepared => {
                const current = dependencies.outputReservations.getCurrentFolderBinding()
                if (current === null
                    || canonicalSerialize(current) !== canonicalSerialize(folderBinding)) {
                    throw new QueueExecutionError('fatal', 'Generation folder changed before Queue reservation')
                }
                if (options.providerExecutionContexts !== undefined
                    && options.providerExecutionContexts.length !== prepared.length) {
                    throw new QueueExecutionError(
                        'fatal',
                        'Reviewed Provider execution context count does not match the prepared batch',
                    )
                }
                const incompatible = prepared
                    .map(item => queryNaiGenerationCompatibility(
                        item.params,
                        CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
                        item.streaming,
                    ))
                    .find(result => result.status === 'known-divergence' || result.status === 'unsupported')
                if (incompatible !== undefined) {
                    throw new QueueExecutionError(
                        'compatibility',
                        `NovelAI compatibility profile cannot execute: ${incompatible.compatibilityProfileId}`,
                    )
                }
                if (options.submissionPolicy.kind === 'advanced') return
                const consent = options.submissionPolicy.costConsent
                if (consent === undefined || consent === null) {
                    assertAnlasCostConsentAllows(consent, 0)
                }
                const estimatedAnlas = estimatePreparedBatchAnlas(prepared, consent.pricingBasis)
                assertAnlasCostConsentAllows(consent, estimatedAnlas)
                costConsent = consent
            },
            materialize: async (prepared, ordinal) => {
                const dehydrated = await dehydrateGenerationParams(prepared.params, materializer, resourceCache)
                for (const record of dehydrated.records) resources.set(record.id, record)
                return {
                    dehydrated,
                    prepared,
                    providerExecution: options.providerExecutionContexts?.[ordinal],
                }
            },
        })
        // The durable repository requires the exact requested count before its
        // atomic write; an invalid/incomplete planner result persists nothing.
        if (plan === null) return null

        const generationLimits = runtimeCapabilities.generationPublication.generationLimits
        assertGenerationAtomicBatchAvailable(
            plan.items.length,
            plan.items.reduce((total, item) => total + generationOutputClaimKinds({
                fileName: ensureImageFileExtension(
                    item.prepared.output.fileName ?? `NAI_Blue_${item.prepared.params.seed}`,
                    item.prepared.imageFormat,
                ) ?? `NAI_Blue_${item.prepared.params.seed}.${item.prepared.imageFormat}`,
                imageFormat: item.prepared.imageFormat,
                metadataMode: item.prepared.metadataMode,
                preserveProviderOriginal: item.prepared.metadataMode === 'strip-and-sidecar',
            }).length, 0),
            generationLimits,
        )

        const batchId = `main-batch-${idempotencyScope}`
        const createdAt = new Date().toISOString()
        const jobs: EnqueueGenerationJobInput[] = []
        const reservations: OutputCommitSetReservation[] = []
        const allocationRequests = plan.items.map((item, ordinal) => {
            const requestedFileName = ensureImageFileExtension(
                item.prepared.output.fileName ?? `NAI_Blue_${item.prepared.params.seed}`,
                item.prepared.imageFormat,
            ) ?? `NAI_Blue_${item.prepared.params.seed}.${item.prepared.imageFormat}`
            const preserveProviderOriginal = item.prepared.metadataMode === 'strip-and-sidecar'
            return {
                destination: {
                    ...(item.prepared.output.portableDirectory === undefined
                        ? {}
                        : { portableDirectory: item.prepared.output.portableDirectory }),
                    directory: item.prepared.output.directory,
                    useAbsolutePath: item.prepared.output.useAbsolutePath,
                    capabilityFallbackDirectory: item.prepared.output.capabilityFallbackDirectory,
                    workflowDefaultDirectory: 'NAI_Blue_Output' as const,
                    extension: item.prepared.imageFormat,
                    fileName: requestedFileName,
                    collisionPolicy: 'error' as const,
                },
                claimPlan: {
                    fileName: requestedFileName,
                    imageFormat: item.prepared.imageFormat,
                    metadataMode: item.prepared.metadataMode,
                    preserveProviderOriginal,
                },
                collisionPolicy: item.prepared.output.reservationCollisionPolicy
                    ?? (item.prepared.output.collisionPolicy === 'unique' ? 'suffix' as const : 'fail' as const),
                directoryAuthorityId: folderBinding.resourceId,
                folderBinding,
                reservationIdentity: {
                    reservationId: `output-reservation:main-job-${idempotencyScope}-${ordinal}`,
                    batchId,
                    jobId: `main-job-${idempotencyScope}-${ordinal}`,
                },
            }
        })
        const allocations = await dependencies.outputReservations.planBatch(allocationRequests)
        if (allocations.length !== plan.items.length) {
            throw new QueueExecutionError('fatal', 'Main output allocation did not preserve the requested count')
        }
        for (const [ordinal, item] of plan.items.entries()) {
            const jobId = `main-job-${idempotencyScope}-${ordinal}`
            const allocation = allocations[ordinal]
            const reservationCollisionPolicy = allocationRequests[ordinal].collisionPolicy
            assertExactOutputCommitSetAllocation({
                ...allocationRequests[ordinal].claimPlan,
                collisionPolicy: reservationCollisionPolicy,
                directoryAuthorityId: folderBinding.resourceId,
            }, allocation, outputFilesystemSemantics())
            const { commitSet, commitSetHash } = allocation
            const exactPrepared: PreparedMainGeneration = {
                ...item.prepared,
                output: {
                    ...item.prepared.output,
                    fileName: allocation.fileName,
                    collisionPolicy: 'error',
                    reservationCollisionPolicy,
                },
            }
            const encoded = item.providerExecution === undefined
                ? encodeMainJobSnapshot(exactPrepared, item.dehydrated, costConsent)
                : encodeMainJobSnapshot(exactPrepared, item.dehydrated, costConsent, item.providerExecution)
            const reservationId = `output-reservation:${jobId}`
            const reservation: OutputCommitSetReservation = {
                reservationSchemaVersion: 1,
                reservationId,
                batchId,
                jobId,
                folderBinding,
                directoryIdentity: allocation.directoryIdentity,
                relativePath: allocation.fileName,
                collisionPolicy: reservationCollisionPolicy,
                expectedExistingDigest: null,
                commitSet,
                commitSetHash,
                state: 'reserved',
                version: 1,
                updatedAt: createdAt,
            }
            const {
                batchId: _batchId,
                jobId: _jobId,
                state: _state,
                version: _version,
                updatedAt: _updatedAt,
                ...reservationSnapshot
            } = reservation
            const snapshot = bindOutputReservationSnapshot(encoded.snapshot, reservationSnapshot)
            reservations.push(reservation)
            const destinationBoundPlanHash = `sha256:${hashCanonicalValue({
                compositionPlanHash: encoded.compositionPlanHash,
                outputCommitSetHash: commitSetHash,
            })}`
            jobs.push({
                id: jobId,
                batchId,
                workflow: 'main',
                sceneId: null,
                createdAt,
                priority: 0,
                ordinal,
                snapshot,
                compositionPlanHash: destinationBoundPlanHash,
                maxAttempts: options.queuePolicy?.maxAttempts ?? 3,
                idempotencyKey: `main-enqueue-${idempotencyScope}-${ordinal}`,
            })
        }
        return await runtimeWorkspaceMutationGate.runExclusive(
            generationFolderDocumentMutationKey(folderBinding.resourceId),
            async () => {
                // The final read bypasses Zustand so Queue reservations bind the
                // durable Folder authority that the shared mutation gate protects.
                const current = await dependencies.outputReservations
                    .getAuthoritativeFolderBinding(folderBinding.resourceId)
                if (current === null
                    || canonicalSerialize(current) !== canonicalSerialize(folderBinding)) {
                    throw new QueueExecutionError('fatal', 'Generation folder changed before Queue reservation')
                }
                assertGenerationAtomicBatchAvailable(
                    jobs.length,
                    reservations.reduce((total, reservation) => (
                        total + (reservation.reservationSchemaVersion === 1 ? reservation.commitSet.claims.length : 0)
                    ), 0),
                    generationLimits,
                )
                return getRuntimeQueueRepository().createBatchAndEnqueue({
                    batch: {
                        id: batchId,
                        workflow: 'main',
                        createdAt,
                        failurePolicy: options.queuePolicy?.failurePolicy ?? 'continue',
                        origin: 'fresh',
                        idempotencyKey: `main-enqueue-${idempotencyScope}`,
                    },
                    jobs,
                    resources: [...resources.values()],
                    reservations,
                })
            },
        )
    } finally {
        dependencies.presentation.completeEnqueueOperation(operationId)
    }
}
