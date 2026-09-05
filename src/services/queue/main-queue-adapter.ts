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
import { planR2Release, revalidateR2Release, type PlanR2ReleaseInput, type PlanR2ReleaseResult } from '@/application/r2/plan-r2-release'
import { isR2QueueDeliverySnapshot, type R2DeliveryRequirement, type R2QueueDeliverySnapshot } from '@/domain/r2/types'

let mainEnqueueInFlight: Promise<CreateBatchAndEnqueueResult | null> | null = null

export interface EnqueuePlannedMainBatchOptions {
    readonly planner: MainBatchPlannerPort<PreparedMainGeneration>
    readonly submissionPolicy: { readonly kind: 'guided'; readonly costConsent: AnlasCostConsentSnapshot }
    /** Stable draft/revision scope makes a retried Guided submit idempotent. */
    readonly idempotencyScope?: string
    readonly folderBinding?: OutputReservationFolderBinding
    /** Optional reviewed policy; absent callers retain the generation-folder best-effort contract. */
    readonly r2Requirements?: readonly R2DeliveryRequirement[]
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
    readonly r2Requirements?: readonly R2DeliveryRequirement[]
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
        if (options.r2Requirements !== undefined && options.r2Requirements.length !== plan.items.length) {
            throw new QueueExecutionError('fatal', 'Reviewed R2 requirement count does not match the prepared batch')
        }

        // Private delivery determines persistent local claims before allocation.
        // Application-reviewed jobs already contain that exact immutable plan.
        const items = await Promise.all(plan.items.map(async (item, ordinal) => {
            const output = item.prepared.output
            const reviewedDelivery = output.r2Delivery
            const requirement = options.r2Requirements?.[ordinal] ?? output.r2Requirement
                ?? (output.autoR2UploadProfileId == null ? { mode: 'disabled' as const }
                    : { mode: 'best-effort' as const, profileId: output.autoR2UploadProfileId })
            const releaseInput: PlanR2ReleaseInput = {
                requirement,
                objectName: ensureImageFileExtension(output.fileName ?? `NAI_Blue_${item.prepared.params.seed}`, item.prepared.imageFormat)!,
                planIdentity: `sha256:${hashCanonicalValue({ idempotencyScope, ordinal })}`,
                deleteOriginal: output.deleteOriginalAfterRelease,
                ...(output.r2Provenance === undefined && output.r2Bucket === null && output.r2Prefix === null
                    ? {} : { resolvedDestination: {
                        ...(output.r2Bucket === null && output.r2Provenance === undefined ? {} : { bucket: output.r2Bucket }),
                        ...(output.r2Prefix === null && output.r2Provenance === undefined ? {} : { prefix: output.r2Prefix ?? '' }),
                        provenance: output.r2Provenance ?? {
                            profileId: 'legacy-output', bucket: 'legacy-output', prefix: 'legacy-output', key: 'planned-output',
                        },
                    } }),
                profileIdProvenance: output.generationFolderId == null ? 'legacy-output' : 'generation-folder',
            }
            let release: Extract<PlanR2ReleaseResult, { status: 'ready' }>
            if (reviewedDelivery !== undefined) {
                if (!isR2QueueDeliverySnapshot(reviewedDelivery)
                    || reviewedDelivery.requirement !== requirement.mode
                    || (requirement.mode !== 'disabled' && reviewedDelivery.planned?.destination.profileId !== requirement.profileId)
                    || output.deleteOriginalAfterRelease) {
                    throw new QueueExecutionError('fatal', 'Reviewed Main R2 delivery changed before allocation')
                }
                release = reviewedDelivery.planned === null
                    ? await planR2Release({ ...releaseInput, requirement: { mode: 'disabled' } }, dependencies.r2Planning) as typeof release
                    : { status: 'ready', destination: reviewedDelivery.planned.destination,
                        internalSnapshot: reviewedDelivery.planned, readiness: 'ready' }
            } else {
                const planned = await planR2Release(releaseInput, dependencies.r2Planning)
                if (planned.status !== 'ready') throw new QueueExecutionError('fatal', planned.message)
                release = planned
            }
            const metadataMode = release.internalSnapshot?.profile.publicMode === 'private'
                ? 'strip-and-sidecar' as const : item.prepared.metadataMode
            if (reviewedDelivery !== undefined && metadataMode !== item.prepared.metadataMode) {
                throw new QueueExecutionError('fatal', 'Reviewed private R2 output is missing its sidecar policy')
            }
            return { ...item, releaseInput, release, reviewedDelivery,
                prepared: { ...item.prepared, metadataMode, params: { ...item.prepared.params, metadataMode } } }
        }))

        const generationLimits = runtimeCapabilities.generationPublication.generationLimits
        assertGenerationAtomicBatchAvailable(
            items.length,
            items.reduce((total, item) => total + generationOutputClaimKinds({
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
        const r2Deliveries: R2QueueDeliverySnapshot[] = []
        const allocationRequests = items.map((item, ordinal) => {
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
        if (allocations.length !== items.length) {
            throw new QueueExecutionError('fatal', 'Main output allocation did not preserve the requested count')
        }
        for (const [ordinal, item] of items.entries()) {
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
            const compositionPlanHash = exactPrepared.params.compositionPlanHash === undefined
                ? null
                : `sha256:${exactPrepared.params.compositionPlanHash.digest}`
            const destinationBoundPlanHash = `sha256:${hashCanonicalValue({
                compositionPlanHash,
                outputCommitSetHash: commitSetHash,
            })}` as const
            let release = item.release
            if (item.reviewedDelivery !== undefined && allocation.fileName !== item.prepared.output.fileName) {
                throw new QueueExecutionError('fatal', 'Reviewed Main filename changed before R2 delivery enqueue')
            }
            if (item.reviewedDelivery === undefined && allocation.fileName !== item.releaseInput.objectName && release.internalSnapshot !== null) {
                const original = release.internalSnapshot
                const renamed = await planR2Release({ ...item.releaseInput, objectName: allocation.fileName }, {
                    ...dependencies.r2Planning, getProfile: async () => original.profile,
                })
                if (renamed.status !== 'ready' || renamed.internalSnapshot === null) throw new QueueExecutionError('fatal', 'Allocated R2 destination is invalid')
                release = { ...renamed, internalSnapshot: { ...renamed.internalSnapshot,
                    sourceProfileHash: original.sourceProfileHash ?? original.destination.profileHash } }
            }
            const r2Delivery: R2QueueDeliverySnapshot = release.internalSnapshot === null
                ? { requirement: 'disabled', planned: null }
                : release.internalSnapshot.destination.requirement === 'required'
                    ? { requirement: 'required', planned: release.internalSnapshot }
                    : { requirement: 'best-effort', planned: release.internalSnapshot }
            r2Deliveries.push(r2Delivery)
            const deliveryPrepared = r2Delivery.requirement === 'disabled'
                ? { ...exactPrepared, output: { ...exactPrepared.output, autoR2UploadProfileId: null } }
                : exactPrepared
            const encoded = encodeMainJobSnapshot(deliveryPrepared, item.dehydrated, costConsent, item.providerExecution, r2Delivery)
            const snapshot = bindOutputReservationSnapshot(encoded.snapshot, reservationSnapshot)
            reservations.push(reservation)
            jobs.push({
                id: jobId,
                batchId,
                workflow: 'main',
                sceneId: null,
                createdAt,
                priority: 0,
                ordinal,
                snapshot,
                compositionPlanHash: `sha256:${hashCanonicalValue({ localPlanHash: destinationBoundPlanHash, r2Delivery })}`,
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
                for (const delivery of r2Deliveries) {
                    if (delivery.planned === null) continue
                    const checked = await revalidateR2Release(delivery.planned, dependencies.r2Planning)
                    if (checked.status === 'blocked') {
                        throw new QueueExecutionError('fatal', checked.reason)
                    }
                }
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
