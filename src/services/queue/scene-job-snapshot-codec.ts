import type { CompositionPlanHash } from '@/domain/composition/canonical-serialize'
import type { FragmentSequenceCommitProposal } from '@/domain/composition/fragment-resolver'
import type { DeepReadonly } from '@/domain/composition/provenance'
import type { JsonValue } from '@/domain/composition/types'
import type { GenerationJobSnapshot } from '@/domain/queue/types'
import type { ProviderExecutionEnvelope, ProviderSha256 } from '@/domain/queue/provider-result'
import {
    isAnlasCostConsentSnapshot,
    type AnlasCostConsentSnapshot,
} from '@/domain/queue/anlas-cost-consent'
import {
    isR2BucketName,
    isR2QueueDeliverySnapshot,
    isResolvedR2Prefix,
    type R2QueueDeliverySnapshot,
} from '@/domain/r2/types'
import type {
    SaveSceneResultContext,
    SaveSceneResultOptions,
} from '@/lib/scene-generation/save-scene-result'
import type { GenerationParams } from '@/services/novelai-types'
import { hashGenerationSemanticIntent } from '@/application/generation/plan-generation'
import { projectMainGenerationSemantic } from '@/services/generation/main-generation-semantic'
import {
    CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
    LEGACY_NAI_PAYLOAD_BUILDER_REVISION,
    queryNaiGenerationCompatibility,
} from '@/services/nai/compatibility'
import { CURRENT_NAI_MODEL_CATALOG_REVISION } from '@/services/nai/model-catalog'
import { QueueExecutionError } from './durable-queue-coordinator'
import { createGenerationJobSnapshot } from './job-snapshot'
import type {
    DehydratedGenerationParameters,
    DehydratedGenerationResult,
} from './queue-resource-materializer'
import type {
    SceneBatchRequest,
    SceneGenerationBinding,
} from '@/application/scene/plan-scene-batch'
import { isSceneBatchRequest } from '@/application/scene/plan-scene-batch'

export interface SceneQueueWorkflowSnapshot {
    readonly scene: { readonly id: string; readonly name: string }
    readonly finalPrompt: string
    readonly mimeType: string
    readonly saveContext: SaveSceneResultContext
    readonly outputContext: NonNullable<SaveSceneResultOptions['outputContext']>
    readonly sequenceCommitProposal: FragmentSequenceCommitProposal | null
    /** Absent only on pre-Phase-6 Scene snapshots. */
    readonly sceneBinding?: SceneGenerationBinding
    /** Absent only on pre-Phase-6 Scene snapshots. */
    readonly batch?: {
        readonly request: SceneBatchRequest
        readonly count: number
        readonly estimatedAnlas: number
        readonly planHash: `sha256:${string}`
    }
    /** Absent only on pre-cost-consent Scene snapshots. */
    readonly costConsent?: AnlasCostConsentSnapshot
    readonly r2Delivery: R2QueueDeliverySnapshot
}

export interface SceneQueueSnapshotParameters extends DehydratedGenerationParameters {
    readonly payloadBuilderRevision: string
    readonly queueExecution: { readonly streaming: boolean; readonly sourceEdit: boolean }
    readonly sceneWorkflow: SceneQueueWorkflowSnapshot
}

export interface EncodeSceneJobSnapshotInput {
    readonly scene: { readonly id: string; readonly name: string }
    readonly params: GenerationParams
    readonly finalPrompt: string
    readonly mimeType: string
    readonly saveContext: SaveSceneResultContext
    readonly outputContext: SceneQueueWorkflowSnapshot['outputContext']
    readonly streaming: boolean
    readonly sequenceCommitProposal: DeepReadonly<FragmentSequenceCommitProposal> | null
    readonly planHash: CompositionPlanHash | null
    readonly sceneBinding: SceneGenerationBinding
    readonly batch: NonNullable<SceneQueueWorkflowSnapshot['batch']>
    readonly costConsent: NonNullable<SceneQueueWorkflowSnapshot['costConsent']>
    readonly r2Delivery?: R2QueueDeliverySnapshot
}

export interface EncodedSceneJobSnapshot {
    readonly sceneId: string
    readonly snapshot: GenerationJobSnapshot
    readonly compositionPlanHash: string | null
}

function asJson(value: unknown): JsonValue {
    return JSON.parse(JSON.stringify(value)) as JsonValue
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasLegacyR2Profile(value: unknown): boolean {
    return isRecord(value) && value.autoR2UploadProfileId != null
}

function isR2DeliveryCoherent(delivery: unknown, output: unknown): boolean {
    if (!isRecord(delivery)) return true
    if (delivery.requirement === 'disabled') return !hasLegacyR2Profile(output)
    if (delivery.requirement === 'best-effort' && delivery.planned === null) {
        return hasLegacyR2Profile(output)
    }
    return true
}

function invalidSnapshot(): never {
    throw new QueueExecutionError('fatal', 'Scene queue snapshot parameters are invalid')
}

/**
 * Depends on the resolved Scene generation facts and dehydrated resource refs.
 * It owns the credential-free V1 wire shape, output context, and resumability so
 * Scene enqueue cannot drift from the durable decoder or persist source bytes.
 */
export function encodeSceneJobSnapshot(
    input: EncodeSceneJobSnapshotInput,
    dehydrated: Pick<DehydratedGenerationResult, 'parameters' | 'resources'>,
): EncodedSceneJobSnapshot {
    const imageFormat: 'png' | 'webp' = input.params.imageFormat === 'webp'
        || input.mimeType === 'image/webp'
        ? 'webp'
        : 'png'
    const sourceEdit = Boolean(input.params.sourceImage || input.params.mask)
    const streaming = input.streaming && !sourceEdit
    const compatibility = queryNaiGenerationCompatibility(
        input.params,
        CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
        streaming,
    )
    if (compatibility.status === 'known-divergence' || compatibility.status === 'unsupported') {
        throw new QueueExecutionError(
            'compatibility',
            `NovelAI compatibility profile cannot execute: ${compatibility.compatibilityProfileId}`,
        )
    }
    const providerRoles = new Set(['source', 'mask', 'vibe-reference', 'character-reference'])
    const queueResourceBindings = dehydrated.resources
        .filter(resource => providerRoles.has(resource.role))
        .map(resource => ({
            resourceId: resource.resourceId,
            role: resource.role as ProviderExecutionEnvelope['queueResourceBindings'][number]['role'],
            digest: resource.digest as ProviderSha256,
        }))
    const providerExecutionEnvelope: ProviderExecutionEnvelope = {
        schemaVersion: 1,
        provider: 'novelai',
        compatibilityProfileId: compatibility.compatibilityProfileId,
        payloadBuilderRevision: CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
        modelCatalogRevision: CURRENT_NAI_MODEL_CATALOG_REVISION,
        action: compatibility.action,
        responseMode: streaming ? 'streaming' : 'standard',
        semanticIntentHash: hashGenerationSemanticIntent(
            projectMainGenerationSemantic(input.params, imageFormat),
        ),
        queueResourceBindings,
    }
    const parameters: SceneQueueSnapshotParameters = {
        ...dehydrated.parameters,
        payloadBuilderRevision: CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
        queueExecution: {
            streaming: input.streaming,
            sourceEdit,
        },
        sceneWorkflow: {
            scene: input.scene,
            finalPrompt: input.finalPrompt,
            mimeType: input.mimeType,
            saveContext: input.saveContext,
            outputContext: input.outputContext,
            sequenceCommitProposal: input.sequenceCommitProposal as FragmentSequenceCommitProposal | null,
            sceneBinding: input.sceneBinding,
            batch: input.batch,
            costConsent: input.costConsent,
            r2Delivery: input.r2Delivery ?? (input.outputContext.autoR2UploadProfileId == null
                ? { requirement: 'disabled', planned: null }
                : { requirement: 'best-effort', planned: null }),
        },
    }
    return {
        sceneId: input.scene.id,
        snapshot: createGenerationJobSnapshot({
            prompt: {
                positive: input.finalPrompt,
                negative: input.params.negative_prompt,
            },
            parameters: asJson(parameters),
            outputPolicy: asJson({
                workflow: 'scene',
                saveContext: input.saveContext,
                outputContext: input.outputContext,
            }),
            resources: dehydrated.resources,
            resumability: 'resumable',
            providerExecutionEnvelope,
        }),
        compositionPlanHash: input.planHash === null ? null : `sha256:${input.planHash.digest}`,
    }
}

/**
 * Depends only on the persisted generic Job Snapshot and is consumed before
 * resource hydration. It validates every structural field used by Scene output
 * execution and maps corrupt/foreign payloads to a stable fatal Queue failure.
 */
export function decodeSceneJobSnapshot(snapshot: GenerationJobSnapshot): SceneQueueSnapshotParameters {
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
        || !isRecord(candidate.sceneWorkflow)
        || !isRecord(candidate.sceneWorkflow.scene)
        || typeof candidate.sceneWorkflow.scene.id !== 'string'
        || typeof candidate.sceneWorkflow.scene.name !== 'string'
        || typeof candidate.sceneWorkflow.finalPrompt !== 'string'
        || typeof candidate.sceneWorkflow.mimeType !== 'string'
        || (candidate.sceneWorkflow.sceneBinding !== undefined
            && (!isRecord(candidate.sceneWorkflow.sceneBinding)
                || candidate.sceneWorkflow.sceneBinding.resourceType !== 'scene-document'
                || typeof candidate.sceneWorkflow.sceneBinding.resourceId !== 'string'
                || !Number.isSafeInteger(candidate.sceneWorkflow.sceneBinding.revision)
                || (candidate.sceneWorkflow.sceneBinding.revision as number) < 0
                || typeof candidate.sceneWorkflow.sceneBinding.contentHash !== 'string'
                || !/^sha256:[a-f0-9]{64}$/.test(candidate.sceneWorkflow.sceneBinding.contentHash)))
        || (candidate.sceneWorkflow.batch !== undefined
            && (candidate.sceneWorkflow.sceneBinding === undefined
                || candidate.sceneWorkflow.costConsent === undefined
                || !isRecord(candidate.sceneWorkflow.batch)
                || !isSceneBatchRequest(candidate.sceneWorkflow.batch.request)
                || typeof candidate.sceneWorkflow.batch.count !== 'number'
                || !Number.isSafeInteger(candidate.sceneWorkflow.batch.count)
                || candidate.sceneWorkflow.batch.count < 1
                || typeof candidate.sceneWorkflow.batch.estimatedAnlas !== 'number'
                || !Number.isSafeInteger(candidate.sceneWorkflow.batch.estimatedAnlas)
                || candidate.sceneWorkflow.batch.estimatedAnlas < 0
                || typeof candidate.sceneWorkflow.batch.planHash !== 'string'
                || !/^sha256:[a-f0-9]{64}$/.test(candidate.sceneWorkflow.batch.planHash)))
        || (candidate.sceneWorkflow.costConsent !== undefined
            && !isAnlasCostConsentSnapshot(candidate.sceneWorkflow.costConsent))
        || (candidate.sceneWorkflow.r2Delivery !== undefined
            && !isR2QueueDeliverySnapshot(candidate.sceneWorkflow.r2Delivery))
        || !isR2DeliveryCoherent(candidate.sceneWorkflow.r2Delivery, candidate.sceneWorkflow.outputContext)
        || !isRecord(candidate.sceneWorkflow.saveContext)
        || typeof candidate.sceneWorkflow.saveContext.activePresetId !== 'string'
        || typeof candidate.sceneWorkflow.saveContext.sceneSavePath !== 'string'
        || !isRecord(candidate.sceneWorkflow.outputContext)
        || typeof candidate.sceneWorkflow.outputContext.useAbsoluteScenePath !== 'boolean'
        || typeof candidate.sceneWorkflow.outputContext.metadataMode !== 'string'
        || !['embedded', 'sidecar-only', 'strip-and-sidecar', 'strip-only'].includes(candidate.sceneWorkflow.outputContext.metadataMode)
        || typeof candidate.sceneWorkflow.outputContext.presetName !== 'string'
        || typeof candidate.sceneWorkflow.outputContext.sceneName !== 'string'
        || (candidate.sceneWorkflow.outputContext.sceneSubfoldersEnabled !== undefined
            && typeof candidate.sceneWorkflow.outputContext.sceneSubfoldersEnabled !== 'boolean')
        || (candidate.sceneWorkflow.outputContext.presetPathSegments !== undefined
            && (!Array.isArray(candidate.sceneWorkflow.outputContext.presetPathSegments)
                || !candidate.sceneWorkflow.outputContext.presetPathSegments.every(segment => typeof segment === 'string')))
        || (candidate.sceneWorkflow.outputContext.directory !== undefined
            && typeof candidate.sceneWorkflow.outputContext.directory !== 'string')
        || (candidate.sceneWorkflow.outputContext.capabilityFallbackDirectory !== undefined
            && typeof candidate.sceneWorkflow.outputContext.capabilityFallbackDirectory !== 'string')
        || (candidate.sceneWorkflow.outputContext.autoR2UploadProfileId !== undefined
            && candidate.sceneWorkflow.outputContext.autoR2UploadProfileId !== null
            && typeof candidate.sceneWorkflow.outputContext.autoR2UploadProfileId !== 'string')
        || (candidate.sceneWorkflow.outputContext.r2Bucket !== undefined
            && candidate.sceneWorkflow.outputContext.r2Bucket !== null
            && !isR2BucketName(candidate.sceneWorkflow.outputContext.r2Bucket))
        || (candidate.sceneWorkflow.outputContext.r2Prefix !== undefined
            && candidate.sceneWorkflow.outputContext.r2Prefix !== null
            && !isResolvedR2Prefix(candidate.sceneWorkflow.outputContext.r2Prefix))
        || (candidate.sceneWorkflow.outputContext.filenameTemplate !== undefined
            && (typeof candidate.sceneWorkflow.outputContext.filenameTemplate !== 'string'
                || candidate.sceneWorkflow.outputContext.filenameTemplate.length === 0
                || candidate.sceneWorkflow.outputContext.filenameTemplate.length > 180
                || /[\r\n]/.test(candidate.sceneWorkflow.outputContext.filenameTemplate)))) {
        return invalidSnapshot()
    }
    if (candidate.sceneWorkflow.outputContext.fileName !== undefined
        && (typeof candidate.sceneWorkflow.outputContext.fileName !== 'string'
            || candidate.sceneWorkflow.outputContext.fileName.length === 0
            || candidate.sceneWorkflow.outputContext.fileName.length > 255
            || /[\\/\r\n]/.test(candidate.sceneWorkflow.outputContext.fileName))) {
        return invalidSnapshot()
    }
    return {
        ...candidate,
        sceneWorkflow: {
            ...candidate.sceneWorkflow,
            r2Delivery: candidate.sceneWorkflow.r2Delivery ?? (
                candidate.sceneWorkflow.outputContext.autoR2UploadProfileId == null
                    ? { requirement: 'disabled', planned: null }
                    : { requirement: 'best-effort', planned: null }
            ),
        },
        payloadBuilderRevision: candidate.payloadBuilderRevision
            ?? LEGACY_NAI_PAYLOAD_BUILDER_REVISION,
    } as unknown as SceneQueueSnapshotParameters
}
