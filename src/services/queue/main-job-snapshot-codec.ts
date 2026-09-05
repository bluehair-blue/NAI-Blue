import type { FragmentSequenceCommitProposal } from '@/domain/composition/fragment-resolver'
import type { JsonValue } from '@/domain/composition/types'
import {
    isAnlasCostConsentSnapshot,
    type AnlasCostConsentSnapshot,
} from '@/domain/queue/anlas-cost-consent'
import type { GenerationJobSnapshot } from '@/domain/queue/types'
import type { ProviderExecutionEnvelope, ProviderSha256 } from '@/domain/queue/provider-result'
import {
    isR2BucketName,
    isR2QueueDeliverySnapshot,
    isResolvedR2Prefix,
    type R2QueueDeliverySnapshot,
} from '@/domain/r2/types'
import type { PreparedMainGeneration } from '@/services/generation/main-generation-plan'
import {
    CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
    LEGACY_NAI_PAYLOAD_BUILDER_REVISION,
    queryNaiGenerationCompatibility,
} from '@/services/nai/compatibility'
import { CURRENT_NAI_MODEL_CATALOG_REVISION } from '@/services/nai/model-catalog'
import {
    DEFAULT_RIGHTS_OWNER,
    isRightsEffectiveDate,
    isRightsOwner,
} from '@/domain/workflow/bluehair-rights-policy'
import { ensureImageFileExtension } from '@/services/output/filename-policy'
import { QueueExecutionError } from './durable-queue-coordinator'
import { createGenerationJobSnapshot } from './job-snapshot'
import type {
    DehydratedGenerationParameters,
    DehydratedGenerationResult,
} from './queue-resource-materializer'

export interface MainQueueOutputSnapshot {
    readonly directory: string
    readonly useAbsolutePath: boolean
    readonly capabilityFallbackDirectory: string
    readonly portableDirectory?: PreparedMainGeneration['output']['portableDirectory']
    readonly fileName: string
    readonly collisionPolicy: 'unique' | 'overwrite' | 'error'
    readonly generationFolderId?: string | null
    readonly generationFolderPath?: string | null
    /** Optional on V1 snapshots created before release automation existed. */
    readonly autoR2UploadProfileId?: string | null
    readonly r2Bucket?: string | null
    readonly r2Prefix?: string | null
    readonly deleteOriginalAfterRelease?: boolean
    readonly rightsXmpEnabled?: boolean
    readonly rightsOwner?: string
    readonly rightsEffectiveDate?: string | null
}

export interface MainQueueWorkflowSnapshot {
    readonly finalPrompt: string
    readonly imageFormat: 'png' | 'webp'
    readonly metadataMode: PreparedMainGeneration['metadataMode']
    readonly sequenceCommitProposal: FragmentSequenceCommitProposal | null
    readonly costConsent?: AnlasCostConsentSnapshot
    readonly r2Delivery: R2QueueDeliverySnapshot
    /** Absent only on snapshots written before the Phase 7 application path. */
    readonly r2DeliveryVersion?: 1
    readonly output: MainQueueOutputSnapshot
}

export interface MainQueueSnapshotParameters extends DehydratedGenerationParameters {
    readonly payloadBuilderRevision: string
    readonly queueExecution: { readonly streaming: boolean; readonly sourceEdit: boolean }
    readonly mainWorkflow: MainQueueWorkflowSnapshot
}

export interface EncodedMainJobSnapshot {
    readonly snapshot: GenerationJobSnapshot
    readonly compositionPlanHash: string | null
}

export interface MainProviderExecutionReviewContext {
    readonly compatibilityProfileId: string
    readonly semanticIntentHash: ProviderSha256
}

function asJson(value: unknown): JsonValue {
    return JSON.parse(JSON.stringify(value)) as JsonValue
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasLegacyR2Activation(value: unknown): boolean {
    return isRecord(value) && (
        value.autoR2UploadProfileId != null
        || value.deleteOriginalAfterRelease === true
    )
}

function hasLegacyR2Profile(value: unknown): boolean {
    return isRecord(value) && value.autoR2UploadProfileId != null
}

function isR2DeliveryCoherent(delivery: unknown, output: unknown): boolean {
    if (!isRecord(delivery)) return true
    if (delivery.requirement === 'disabled') return !hasLegacyR2Activation(output)
    if (delivery.requirement === 'best-effort' && delivery.planned === null) {
        return hasLegacyR2Profile(output)
    }
    return true
}

function invalidSnapshot(): never {
    throw new QueueExecutionError('fatal', 'Main queue snapshot parameters are invalid')
}

/**
 * Depends on the credential-free Main plan and materialized resource references.
 * It owns the V1 wire shape and deterministic Queue filename so enqueue callers
 * cannot silently diverge from the decoder or persist raw image material.
 */
export function encodeMainJobSnapshot(
    prepared: PreparedMainGeneration,
    dehydrated: Pick<DehydratedGenerationResult, 'parameters' | 'resources'>,
    costConsent?: AnlasCostConsentSnapshot,
    providerExecution?: MainProviderExecutionReviewContext,
    r2Delivery?: R2QueueDeliverySnapshot,
): EncodedMainJobSnapshot {
    const fileName = prepared.output.fileName ?? ensureImageFileExtension(
        `NAI_Blue_${prepared.params.seed}`,
        prepared.imageFormat,
    ) ?? `NAI_Blue_${prepared.params.seed}.${prepared.imageFormat}`
    const parameters: MainQueueSnapshotParameters = {
        ...dehydrated.parameters,
        payloadBuilderRevision: CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
        queueExecution: {
            streaming: prepared.streaming,
            sourceEdit: prepared.sourceEdit,
        },
        mainWorkflow: {
            finalPrompt: prepared.finalPrompt,
            imageFormat: prepared.imageFormat,
            metadataMode: prepared.metadataMode,
            sequenceCommitProposal: prepared.sequenceCommitProposal as FragmentSequenceCommitProposal | null,
            ...(costConsent === undefined ? {} : { costConsent }),
            ...(r2Delivery === undefined ? {} : { r2DeliveryVersion: 1 as const }),
            r2Delivery: r2Delivery ?? (prepared.output.autoR2UploadProfileId == null
                ? { requirement: 'disabled', planned: null }
                : { requirement: 'best-effort', planned: null }),
            output: {
                directory: prepared.output.directory,
                useAbsolutePath: prepared.output.useAbsolutePath,
                capabilityFallbackDirectory: prepared.output.capabilityFallbackDirectory,
                ...(prepared.output.portableDirectory === undefined
                    ? {}
                    : { portableDirectory: prepared.output.portableDirectory }),
                fileName,
                collisionPolicy: prepared.output.collisionPolicy,
                generationFolderId: prepared.output.generationFolderId,
                generationFolderPath: prepared.output.generationFolderPath,
                autoR2UploadProfileId: prepared.output.autoR2UploadProfileId,
                r2Bucket: prepared.output.r2Bucket,
                r2Prefix: prepared.output.r2Prefix,
                deleteOriginalAfterRelease: prepared.output.deleteOriginalAfterRelease,
                rightsXmpEnabled: prepared.output.rightsXmpEnabled,
                rightsOwner: prepared.output.rightsOwner,
                rightsEffectiveDate: prepared.output.rightsEffectiveDate,
            },
        },
    }
    let providerExecutionEnvelope: ProviderExecutionEnvelope | undefined
    if (providerExecution !== undefined) {
        if (!/^sha256:[a-f0-9]{64}$/.test(providerExecution.semanticIntentHash)) invalidSnapshot()
        const streaming = prepared.streaming && !prepared.sourceEdit
        const compatibility = queryNaiGenerationCompatibility(
            prepared.params,
            CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
            streaming,
        )
        if (compatibility.compatibilityProfileId !== providerExecution.compatibilityProfileId) {
            throw new QueueExecutionError(
                'compatibility',
                'Reviewed Main compatibility profile changed before snapshot encoding',
            )
        }
        const queueResourceBindings = dehydrated.resources.flatMap(resource => {
            if (resource.role !== 'source'
                && resource.role !== 'mask'
                && resource.role !== 'vibe-reference'
                && resource.role !== 'character-reference') return []
            return [{
                resourceId: resource.resourceId,
                role: resource.role,
                digest: resource.digest as ProviderSha256,
            }]
        })
        providerExecutionEnvelope = {
            schemaVersion: 1,
            provider: 'novelai',
            compatibilityProfileId: compatibility.compatibilityProfileId,
            payloadBuilderRevision: CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
            modelCatalogRevision: CURRENT_NAI_MODEL_CATALOG_REVISION,
            action: compatibility.action,
            responseMode: streaming ? 'streaming' : 'standard',
            semanticIntentHash: providerExecution.semanticIntentHash,
            queueResourceBindings,
        }
    }
    return {
        snapshot: createGenerationJobSnapshot({
            prompt: {
                positive: prepared.finalPrompt,
                negative: prepared.params.negative_prompt,
            },
            parameters: asJson(parameters),
            outputPolicy: asJson({
                workflow: 'main',
                imageFormat: prepared.imageFormat,
                metadataMode: prepared.metadataMode,
                output: parameters.mainWorkflow.output,
            }),
            resources: dehydrated.resources,
            resumability: 'resumable',
            ...(providerExecutionEnvelope === undefined ? {} : { providerExecutionEnvelope }),
        }),
        compositionPlanHash: prepared.params.compositionPlanHash === undefined
            ? null
            : `sha256:${prepared.params.compositionPlanHash.digest}`,
    }
}

/**
 * Depends only on the persisted generic Job Snapshot and is consumed by the
 * Main executor before hydration. It validates the fields execution reads and
 * converts corrupt/foreign payloads into a stable fatal Queue classification.
 */
export function decodeMainJobSnapshot(snapshot: GenerationJobSnapshot): MainQueueSnapshotParameters {
    const candidate = snapshot.parameters
    if (!isRecord(candidate)
        || candidate.generationParams === undefined
        || !Array.isArray(candidate.resourceBindings)
        || !isRecord(candidate.resourceArrayLengths)
        || !isRecord(candidate.queueExecution)
        || (candidate.payloadBuilderRevision !== undefined
            && (typeof candidate.payloadBuilderRevision !== 'string'
                || !/^[A-Za-z0-9._-]{1,128}$/.test(candidate.payloadBuilderRevision)))
        || typeof candidate.queueExecution.streaming !== 'boolean'
        || typeof candidate.queueExecution.sourceEdit !== 'boolean'
        || !isRecord(candidate.mainWorkflow)
        || typeof candidate.mainWorkflow.finalPrompt !== 'string'
        || (candidate.mainWorkflow.imageFormat !== 'png' && candidate.mainWorkflow.imageFormat !== 'webp')
        || (candidate.mainWorkflow.costConsent !== undefined
            && !isAnlasCostConsentSnapshot(candidate.mainWorkflow.costConsent))
        || (candidate.mainWorkflow.r2Delivery !== undefined
            && !isR2QueueDeliverySnapshot(candidate.mainWorkflow.r2Delivery))
        || (candidate.mainWorkflow.r2DeliveryVersion !== undefined
            && (candidate.mainWorkflow.r2DeliveryVersion !== 1
                || !isR2QueueDeliverySnapshot(candidate.mainWorkflow.r2Delivery)
                || (candidate.mainWorkflow.r2Delivery.requirement !== 'disabled'
                    && candidate.mainWorkflow.r2Delivery.planned === null)))
        || !isR2DeliveryCoherent(candidate.mainWorkflow.r2Delivery, candidate.mainWorkflow.output)
        || !isRecord(candidate.mainWorkflow.output)
        || typeof candidate.mainWorkflow.output.directory !== 'string'
        || typeof candidate.mainWorkflow.output.useAbsolutePath !== 'boolean'
        || typeof candidate.mainWorkflow.output.capabilityFallbackDirectory !== 'string'
        || typeof candidate.mainWorkflow.output.fileName !== 'string'
        || (candidate.mainWorkflow.output.generationFolderId !== undefined
            && candidate.mainWorkflow.output.generationFolderId !== null
            && typeof candidate.mainWorkflow.output.generationFolderId !== 'string')
        || (candidate.mainWorkflow.output.generationFolderPath !== undefined
            && candidate.mainWorkflow.output.generationFolderPath !== null
            && typeof candidate.mainWorkflow.output.generationFolderPath !== 'string')
        || (candidate.mainWorkflow.output.autoR2UploadProfileId !== undefined
            && candidate.mainWorkflow.output.autoR2UploadProfileId !== null
            && typeof candidate.mainWorkflow.output.autoR2UploadProfileId !== 'string')
        || (candidate.mainWorkflow.output.r2Bucket !== undefined
            && candidate.mainWorkflow.output.r2Bucket !== null
            && !isR2BucketName(candidate.mainWorkflow.output.r2Bucket))
        || (candidate.mainWorkflow.output.r2Prefix !== undefined
            && candidate.mainWorkflow.output.r2Prefix !== null
            && !isResolvedR2Prefix(candidate.mainWorkflow.output.r2Prefix))
        || (candidate.mainWorkflow.output.deleteOriginalAfterRelease !== undefined
            && typeof candidate.mainWorkflow.output.deleteOriginalAfterRelease !== 'boolean')
        || (candidate.mainWorkflow.output.rightsXmpEnabled !== undefined
            && typeof candidate.mainWorkflow.output.rightsXmpEnabled !== 'boolean')
        || (candidate.mainWorkflow.output.rightsOwner !== undefined
            && !isRightsOwner(candidate.mainWorkflow.output.rightsOwner))
        || (candidate.mainWorkflow.output.rightsEffectiveDate !== undefined
            && candidate.mainWorkflow.output.rightsEffectiveDate !== null
            && typeof candidate.mainWorkflow.output.rightsEffectiveDate !== 'string')
        || (candidate.mainWorkflow.output.rightsXmpEnabled === true
            && (candidate.mainWorkflow.metadataMode !== 'strip-and-sidecar'
                || !isRightsOwner(candidate.mainWorkflow.output.rightsOwner ?? DEFAULT_RIGHTS_OWNER)
                || !isRightsEffectiveDate(candidate.mainWorkflow.output.rightsEffectiveDate)))
        || !['unique', 'overwrite', 'error'].includes(
            String(candidate.mainWorkflow.output.collisionPolicy),
        )) {
        return invalidSnapshot()
    }
    return {
        ...candidate,
        mainWorkflow: {
            ...candidate.mainWorkflow,
            r2Delivery: candidate.mainWorkflow.r2Delivery ?? (
                candidate.mainWorkflow.output.autoR2UploadProfileId == null
                    ? { requirement: 'disabled', planned: null }
                    : { requirement: 'best-effort', planned: null }
            ),
        },
        payloadBuilderRevision: candidate.payloadBuilderRevision
            ?? LEGACY_NAI_PAYLOAD_BUILDER_REVISION,
    } as unknown as MainQueueSnapshotParameters
}
