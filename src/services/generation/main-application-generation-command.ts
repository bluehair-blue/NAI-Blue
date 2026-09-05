import { enqueueGeneration } from '@/application/generation/enqueue-generation-plan'
import type {
    EnqueueGenerationPort,
    EnqueueGenerationResult,
} from '@/application/generation/generation-command-contract'
import type {
    PlanGenerationInput,
    PlanGenerationResult,
    PlanIssue,
    Sha256Digest,
} from '@/application/generation/generation-plan-contract'
import {
    planGeneration,
    type PlanGenerationDependencies,
} from '@/application/generation/plan-generation'
import {
    createAnlasCostConsentSnapshot,
    type AnlasPricingBasis,
} from '@/domain/queue/anlas-cost-consent'
import { CURRENT_MAIN_QUEUE_POLICY } from '@/domain/queue/types'
import { hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import type { R2QueueDeliverySnapshot } from '@/domain/r2/types'
import { planR2Release } from '@/application/r2/plan-r2-release'
import { calculateAnlasCost } from '@/lib/anlas-calculator'
import {
    createDetachedMainGenerationCapture,
} from '@/services/generation/main-generation-capture'
import type { PreparedMainGeneration } from '@/services/generation/main-generation-plan'
import {
    CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
    queryNaiGenerationCompatibility,
} from '@/services/nai/compatibility'
import { enqueueReviewedMainPlan } from '@/services/queue/main-queue-adapter'
import type { OutputReservationFolderBinding } from '@/domain/queue/types'
import { getRuntimeMainQueueDependencies } from '@/services/queue/main-queue-runtime-dependencies'
import { ensureImageFileExtension } from '@/services/output/filename-policy'

export type MainApplicationGenerationCommandResult =
    | EnqueueGenerationResult<PreparedMainGeneration>
    | Extract<PlanGenerationResult<PreparedMainGeneration>, { readonly status: 'needs_input' }>

export interface EnqueuePreparedMainGenerationInput {
    readonly prepared: readonly PreparedMainGeneration[]
    readonly captureId: string
    readonly idempotencyKey: string
    readonly pricingBasis: AnlasPricingBasis
    readonly approvedAt: string
    readonly credentialReadinessFingerprint: Sha256Digest
    readonly folderBinding: OutputReservationFolderBinding
}

function issue(code: string, fieldPath: string, message: string): PlanIssue {
    return Object.freeze({ code, severity: 'blocking', fieldPath, message })
}

function unsupportedLocalOutput(prepared: readonly PreparedMainGeneration[]): PlanIssue | null {
    if (prepared.some(job => job.output.collisionPolicy === 'overwrite')) {
        return issue('unsupported-collision-policy', 'jobs.output.collisionPolicy', 'Overwrite plans are not supported.')
    }
    if (prepared.some(job => job.output.deleteOriginalAfterRelease)) {
        return issue('r2-delete-original-unsupported', 'jobs.output.deleteOriginalAfterRelease', 'Deleting the local original is not supported.')
    }
    return null
}

function dependencies(pricingBasis: AnlasPricingBasis): PlanGenerationDependencies<PreparedMainGeneration> {
    const value: PlanGenerationDependencies<PreparedMainGeneration> = {
        // Detached planning never calls these legacy source ports. Keeping them
        // explicit makes an accidental regression fail closed.
        drafts: { get: async () => { throw new Error('Detached Main planning read a Workflow Draft.') } },
        planner: { prepare: async () => { throw new Error('Detached Main planning invoked a live planner.') } },
        executionPolicy: {
            failurePolicy: 'continue',
            retryPolicyId: CURRENT_MAIN_QUEUE_POLICY.retryPolicyId,
            maxAttempts: 3,
            maxConcurrency: CURRENT_MAIN_QUEUE_POLICY.maxConcurrency,
            pricingBasis,
        },
        estimateAnlas: job => calculateAnlasCost({
            model: job.semantic.model,
            width: job.semantic.width,
            height: job.semantic.height,
            steps: job.semantic.steps,
            imageCount: 1,
            pricingBasis,
        }),
        resolveCompatibility: job => {
            const profile = queryNaiGenerationCompatibility(
                job.prepared.params,
                CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
                job.prepared.streaming,
            )
            return {
                compatibilityProfileId: profile.compatibilityProfileId,
                status: profile.status,
            }
        },
    }
    return Object.freeze(value)
}

/** Executes the reviewed Main vertical slice without reading live UI state. */
export async function enqueuePreparedMainGeneration(
    input: EnqueuePreparedMainGenerationInput,
): Promise<MainApplicationGenerationCommandResult> {
    if (input.prepared.length === 0) {
        return Object.freeze({
            status: 'invalid',
            issues: Object.freeze([issue('empty-main-capture', 'prepared', 'At least one prepared Main job is required.')]),
        })
    }
    const unsupported = unsupportedLocalOutput(input.prepared)
    if (unsupported !== null) {
        return Object.freeze({ status: 'unsupported', capability: unsupported.code, issues: Object.freeze([unsupported]) })
    }
    // Fix remote identity before capture so review/hash/replay all describe the
    // same delivery. Runtime profile and credential readiness stay injected.
    const preparedJobs: PreparedMainGeneration[] = []
    for (const [ordinal, prepared] of input.prepared.entries()) {
        const output = prepared.output
        const requirement = output.r2Requirement ?? (output.autoR2UploadProfileId === null
            ? { mode: 'disabled' as const }
            : { mode: 'best-effort' as const, profileId: output.autoR2UploadProfileId })
        const fileName = ensureImageFileExtension(output.fileName, prepared.imageFormat)
            ?? `NAI_Blue_${prepared.params.seed}.${prepared.imageFormat}`
        const release = await planR2Release({
            requirement, objectName: fileName,
            planIdentity: `sha256:${hashCanonicalValue({ captureId: input.captureId, ordinal, fileName, folderBinding: input.folderBinding })}`,
            ...(output.r2Provenance === undefined && output.r2Bucket === null && output.r2Prefix === null
                ? {}
                : { resolvedDestination: {
                    ...(output.r2Bucket === null && output.r2Provenance === undefined ? {} : { bucket: output.r2Bucket }),
                    ...(output.r2Prefix === null && output.r2Provenance === undefined ? {} : { prefix: output.r2Prefix ?? '' }),
                    provenance: output.r2Provenance ?? {
                        profileId: 'legacy-output' as const, bucket: 'legacy-output' as const,
                        prefix: 'legacy-output' as const, key: 'planned-output' as const,
                    },
                } }),
            profileIdProvenance: output.r2Requirement?.mode !== undefined
                ? 'explicit-request'
                : output.generationFolderId === null ? 'legacy-output' : 'generation-folder',
        }, {
            getProfile: profileId => getRuntimeMainQueueDependencies().r2Planning.getProfile(profileId),
            getReadiness: profile => getRuntimeMainQueueDependencies().r2Planning.getReadiness(profile),
        })
        if (release.status !== 'ready') {
            const issues = Object.freeze([issue(release.code, `jobs[${ordinal}].output.r2Delivery`, release.message)])
            return release.status === 'unsupported'
                ? Object.freeze({ status: 'unsupported', capability: release.code, issues })
                : Object.freeze({ status: 'invalid', issues })
        }
        const r2Delivery: R2QueueDeliverySnapshot = release.internalSnapshot === null
            ? { requirement: 'disabled', planned: null }
            : release.internalSnapshot.destination.requirement === 'required'
                ? { requirement: 'required', planned: release.internalSnapshot }
                : { requirement: 'best-effort', planned: release.internalSnapshot }
        const metadataMode = release.internalSnapshot?.profile.publicMode === 'private'
            ? 'strip-and-sidecar' as const : prepared.metadataMode
        preparedJobs.push({
            ...prepared, metadataMode, params: { ...prepared.params, metadataMode },
            output: {
                ...output, fileName, r2Requirement: requirement, r2Delivery,
                autoR2UploadProfileId: requirement.mode === 'disabled' ? null : requirement.profileId,
            },
        })
    }
    const firstPrepared = preparedJobs[0]
    const metadataModes = new Set(preparedJobs.map(job => job.metadataMode))
    if (metadataModes.size !== 1) {
        return Object.freeze({
            status: 'invalid',
            issues: Object.freeze([issue('mixed-metadata-mode', 'prepared', 'One Main batch must use one metadata mode.')]),
        })
    }

    const replan = dependencies(input.pricingBasis)
    const estimatedAnlas = preparedJobs.reduce((sum, prepared) => sum + calculateAnlasCost({
        model: prepared.params.model,
        width: prepared.params.width,
        height: prepared.params.height,
        steps: prepared.params.steps,
        imageCount: 1,
        pricingBasis: input.pricingBasis,
    }), 0)
    const capture = createDetachedMainGenerationCapture({
        captureId: input.captureId,
        prepared: preparedJobs,
        materializedSeeds: preparedJobs.map(job => job.params.seed),
        sourceBindings: [input.folderBinding],
        executionPolicy: {
            failurePolicy: 'continue',
            retryPolicyId: CURRENT_MAIN_QUEUE_POLICY.retryPolicyId,
            maxAttempts: 3,
            maxConcurrency: CURRENT_MAIN_QUEUE_POLICY.maxConcurrency,
            credentialDispatch: { kind: 'auto' },
            pricingBasis: input.pricingBasis,
            metadataMode: firstPrepared.metadataMode,
        },
        credentialReadinessFingerprint: input.credentialReadinessFingerprint,
    })
    const planInput: PlanGenerationInput<PreparedMainGeneration> = {
        source: { kind: 'detached-generation-capture', capture },
        count: capture.jobs.length,
        seedPolicy: { kind: 'replay', traceId: capture.captureId },
        budget: { maxImages: capture.jobs.length, maxAnlas: estimatedAnlas },
    }
    const planned = await planGeneration(planInput, replan)
    if (planned.status !== 'ready') return planned

    const costConsent = createAnlasCostConsentSnapshot({
        pricingBasis: input.pricingBasis,
        estimatedAnlas: planned.plan.estimatedAnlas,
        maxAnlas: estimatedAnlas,
        estimatedAt: input.approvedAt,
        approvedAt: input.approvedAt,
    })
    const enqueuePort: EnqueueGenerationPort<PreparedMainGeneration> = {
        enqueue: async request => {
            const result = await enqueueReviewedMainPlan({
                reviewed: request.plan,
                input: {
                    source: planInput.source,
                    count: planInput.count,
                    budget: planInput.budget,
                },
                dependencies: replan,
                submissionPolicy: { kind: 'reviewed', costConsent: request.costConsent },
                idempotencyScope: request.idempotencyKey,
            })
            if (result.status === 'needs_input') {
                return Object.freeze({
                    status: 'invalid' as const,
                    issues: Object.freeze([issue(
                        'generation-plan-needs-input',
                        'reviewedPlan.requiredApprovals',
                        'The reviewed plan still requires approval input.',
                    )]),
                })
            }
            if (result.status !== 'enqueued') return result
            return Object.freeze({
                status: 'ready' as const,
                batchId: result.queue.batch.id,
                jobs: Object.freeze(result.queue.jobs.map(job => ({ id: job.id, ordinal: job.ordinal }))),
            })
        },
    }
    return enqueueGeneration<PreparedMainGeneration>({
        reviewedPlan: planned.plan,
        costConsent,
        idempotencyKey: input.idempotencyKey,
        actor: { kind: 'user', id: 'main-ui:user' },
        replanInput: {
            source: planInput.source,
            count: planInput.count,
            budget: planInput.budget,
        },
    }, { replan, enqueue: enqueuePort })
}
