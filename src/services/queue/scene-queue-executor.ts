import type { SceneResultPresentationPort } from '@/application/scene/scene-result-presentation-port'
import { linkSceneArtifact } from '@/application/scene/link-scene-artifact'
import { sha256Utf8 } from '@/domain/composition/canonical-serialize'
import type { GenerationJob, QueueArtifactReference } from '@/domain/queue/types'
import { ProviderResultSpoolError } from '@/application/generation/provider-result-spool'
import { hashGenerationSemanticIntent } from '@/application/generation/plan-generation'
import { reserveSceneFragmentSequenceProposal } from '@/lib/scene-generation/fragment-runtime'
import { saveSceneResult } from '@/lib/scene-generation/save-scene-result'
import { executeNovelAIImageTransport } from '@/services/generation/novelai-image-transport'
import { reportDiagnostic } from '@/services/diagnostics/error-registry'
import {
    CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
    isSupportedNaiPayloadBuilderRevision,
    queryNaiGenerationCompatibility,
} from '@/services/nai/compatibility'
import { CURRENT_NAI_MODEL_CATALOG_REVISION } from '@/services/nai/model-catalog'
import { projectMainGenerationSemantic } from '@/services/generation/main-generation-semantic'
import { assertAnlasCostConsentAllows } from '@/domain/queue/anlas-cost-consent'
import { calculateAnlasCost, resolveAnlasPricingBasis } from '@/lib/anlas-calculator'
import type { QueueExecutorContext } from './durable-queue-coordinator'
import { QueueExecutionError } from './durable-queue-coordinator'
import {
    registerQueueArtifact,
    rollbackQueueArtifactRegistration,
    type QueueArtifactRegistration,
} from './queue-artifact-lineage'
import {
    getRuntimeQueueResourceMaterializer,
    hashQueueResourceBytes,
    hydrateGenerationParams,
} from './queue-resource-materializer'
import { decodeSceneJobSnapshot } from './scene-job-snapshot-codec'
import {
    assertProviderEnvelopeMatchesExecution,
    dispatchAndSpool,
    providerResourceBindings,
    writeSpooled,
} from './provider-safe-image-dispatch'
import { getRuntimeMainQueueDependencies } from './main-queue-runtime-dependencies'
import { createSerializedProgressReporter } from './serialized-progress-reporter'
import { getRuntimeSceneRepository } from '@/lib/scene-migration-startup'
import { applySceneDocumentProjection } from '@/lib/scene-authority-runtime'
import {
    markReservedQueueOutputConflict,
    preflightReservedQueueOutput,
} from './output-reservation-preflight'
import { OutputWriterError, type OutputWriterDestination } from '@/services/output/output-writer'
import { enqueueR2Release } from '@/application/r2/enqueue-r2-release'
import { assertRequiredR2DispatchReady } from './required-r2-dispatch-readiness'

function decodeImageBytes(imageData: string): Uint8Array {
    const encoded = imageData.replace(/^data:image\/[^;]+;base64,/, '')
    const binary = atob(encoded)
    return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function encodeImageBytes(bytes: Uint8Array): string {
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
}

function reservedSceneDestination(
    payload: ReturnType<typeof decodeSceneJobSnapshot>,
    imageFormat: 'png' | 'webp',
): OutputWriterDestination {
    const outputContext = payload.sceneWorkflow.outputContext
    return {
        directory: outputContext.directory ?? payload.sceneWorkflow.saveContext.sceneSavePath,
        useAbsolutePath: outputContext.useAbsoluteScenePath,
        capabilityFallbackDirectory: outputContext.capabilityFallbackDirectory,
        workflowDefaultDirectory: 'NAI_Blue_Scene',
        fileName: outputContext.fileName,
        extension: imageFormat,
        collisionPolicy: 'error',
    }
}

function isLateReservedOutputCollision(error: unknown): boolean {
    return error instanceof OutputWriterError
        && (error.message.includes('already exists')
            || error.message.includes('already being written')
            || error.message.includes('changed before commit')
            || error.message.includes('reservation does not match'))
}

/**
 * Depends on the immutable Scene snapshot, Queue lease context, shared NAI
 * transport, output transaction, and injected result Presentation port. It owns
 * replayable job execution while target selection, composition planning, and
 * enqueue remain in scene-queue-adapter.
 */
export async function executeSceneQueueJob(
    job: GenerationJob,
    context: QueueExecutorContext,
    dependencies: { readonly presentation: SceneResultPresentationPort },
): Promise<void> {
    const { legacyR2Release } = getRuntimeMainQueueDependencies()
    const payload = decodeSceneJobSnapshot(job.snapshot)
    const params = await hydrateGenerationParams(payload, job.snapshot.resources, getRuntimeQueueResourceMaterializer())
    params.sourceJobId = job.id
    const imageFormat = payload.sceneWorkflow.mimeType === 'image/webp' ? 'webp' : 'png'
    const streaming = payload.queueExecution.streaming && !payload.queueExecution.sourceEdit
    const envelope = job.snapshot.providerExecutionEnvelope
    let compatibility: ReturnType<typeof queryNaiGenerationCompatibility> | undefined
    if (envelope !== undefined) {
        if (!isSupportedNaiPayloadBuilderRevision(payload.payloadBuilderRevision)) {
            throw new QueueExecutionError(
                'compatibility',
                `Unsupported Scene payload builder revision: ${payload.payloadBuilderRevision}`,
            )
        }
        compatibility = queryNaiGenerationCompatibility(
            params,
            payload.payloadBuilderRevision,
            streaming,
        )
        if (compatibility.status === 'known-divergence' || compatibility.status === 'unsupported') {
            throw new QueueExecutionError(
                'compatibility',
                `NovelAI compatibility profile cannot execute: ${compatibility.compatibilityProfileId}`,
            )
        }
        try {
            assertProviderEnvelopeMatchesExecution(
                envelope,
                context,
                {
                    payloadBuilderRevision: CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
                    modelCatalogRevision: CURRENT_NAI_MODEL_CATALOG_REVISION,
                    compatibilityProfileId: compatibility.compatibilityProfileId,
                    action: compatibility.action,
                    responseMode: streaming ? 'streaming' : 'standard',
                    semanticIntentHash: hashGenerationSemanticIntent(
                        projectMainGenerationSemantic(params, imageFormat),
                    ),
                    queueResourceBindings: providerResourceBindings(job.snapshot.resources),
                },
            )
        } catch (error) {
            if (context.providerAttempt.providerEvidence?.dispatchState === 'result-spooled') {
                const diagnosticEventId = reportDiagnostic(error, {
                    operation: 'queue.scene.write-spooled', stage: 'execution-envelope', jobId: job.id,
                }).eventId
                await context.requeueSpooledResult({ diagnosticEventId, pauseReason: 'compatibility' })
            }
            throw error
        }
    }
    const reservedSnapshot = job.snapshot.outputReservation
    if (payload.sceneWorkflow.batch !== undefined && reservedSnapshot === undefined) {
        throw new QueueExecutionError('fatal', 'Scene batch is missing its output reservation')
    }
    if (reservedSnapshot !== undefined
        && payload.sceneWorkflow.outputContext.fileName !== reservedSnapshot.relativePath) {
        await markReservedQueueOutputConflict(job, context)
        throw new QueueExecutionError('fatal', 'Scene snapshot filename does not match its reservation')
    }
    if (reservedSnapshot !== undefined && context.executionMode === 'provider') {
        try {
            if (context.activeCredentialsAreOpus === undefined) {
                throw new Error('Queue credential pricing authority is unavailable')
            }
            const pricingBasis = resolveAnlasPricingBasis({
                model: params.model,
                activeCredentialsAreOpus: context.activeCredentialsAreOpus,
            })
            const costConsent = payload.sceneWorkflow.costConsent
            if (costConsent?.pricingBasis !== pricingBasis) {
                throw new Error('Queue credential pricing changed after approval')
            }
            assertAnlasCostConsentAllows(costConsent, calculateAnlasCost({
                model: params.model,
                width: params.width,
                height: params.height,
                steps: params.steps,
                imageCount: 1,
                pricingBasis,
            }))
        } catch {
            throw new QueueExecutionError('fatal', 'Anlas cost consent is no longer valid before Provider dispatch')
        }
    }
    const outputReservation = await preflightReservedQueueOutput(
        job,
        context,
        reservedSceneDestination(payload, imageFormat),
    )
    const sequenceLease = payload.sceneWorkflow.sequenceCommitProposal === null
        ? null
        : reserveSceneFragmentSequenceProposal(payload.sceneWorkflow.sequenceCommitProposal)
    if (payload.sceneWorkflow.sequenceCommitProposal !== null && sequenceLease === null) {
        throw new QueueExecutionError('transient', 'Fragment sequence changed before durable reservation')
    }
    try {
        await context.updateProgress('transport', 0, Math.max(1, params.steps))
        const progressReporter = createSerializedProgressReporter(context.updateProgress)
        const onProgress = (progress: number): void => {
            progressReporter.enqueue(
                'stream',
                Math.min(params.steps, Math.round(params.steps * progress / 100)),
                params.steps,
            )
        }
        let imageData: string
        let bytes: Uint8Array
        let sentPayloadSummary: string | undefined
        let encodedVibes: string[] | undefined
        if (envelope !== undefined) {
            const { providerResultSpool, faultInjector } = getRuntimeMainQueueDependencies()
            const currentEvidence = context.providerAttempt.providerEvidence
            let spooled: import('./provider-safe-image-dispatch').SpooledProviderResult
            if (currentEvidence?.dispatchState === 'result-spooled' && currentEvidence.spoolReceipt !== null) {
                spooled = { receipt: currentEvidence.spoolReceipt }
            } else {
                if (context.executionMode === 'storage-only') {
                    throw new QueueExecutionError('fatal', 'Storage-only Scene execution has no verified spool receipt')
                }
                await assertRequiredR2DispatchReady(payload.sceneWorkflow.r2Delivery)
                spooled = await dispatchAndSpool(
                    context,
                    params,
                    imageFormat,
                    streaming,
                    providerResultSpool,
                    faultInjector,
                    onProgress,
                )
            }
            bytes = await writeSpooled(providerResultSpool, spooled.receipt).catch(async error => {
                const diagnosticEventId = reportDiagnostic(error, {
                    operation: 'queue.scene.write-spooled',
                    stage: 'storage',
                    jobId: job.id,
                }).eventId
                if (error instanceof ProviderResultSpoolError) {
                    await context.recordProviderTransition({
                        dispatchState: 'result-lost',
                        providerOutcome: 'succeeded',
                        billingRisk: 'confirmed',
                        responseDigest: spooled.receipt.sha256,
                        spoolReceipt: null,
                    }, { diagnosticEventId, blockReason: 'provider-result-lost' })
                    throw error
                }
                await context.requeueSpooledResult({ diagnosticEventId, pauseReason: 'local-io' })
                throw error
            })
            sentPayloadSummary = spooled.sentPayloadSummary
            encodedVibes = spooled.encodedVibes
            imageData = `data:image/${imageFormat};base64,${encodeImageBytes(bytes)}`
        } else {
            await assertRequiredR2DispatchReady(payload.sceneWorkflow.r2Delivery)
            const result = await executeNovelAIImageTransport({
                token: context.token,
                params,
                imageFormat,
                streaming,
                signal: context.signal,
                onProgress,
            })
            if (!result.success || !result.imageData) {
                if (result.termination === 'cancelled') return
                if (result.termination === 'timeout') {
                    throw new QueueExecutionError('timeout', 'Scene generation reached its bounded timeout')
                }
                throw new QueueExecutionError('decode', 'Scene generation returned no decodable image')
            }
            imageData = result.imageData
            bytes = decodeImageBytes(result.imageData)
            sentPayloadSummary = result.sentPayloadSummary
            encodedVibes = result.encodedVibes
        }
        await progressReporter.flush()
        if (!context.canCommit()) return

        const digest = await hashQueueResourceBytes(bytes)
        const transactionId = `queue-${sha256Utf8(job.id).slice(0, 48)}`
        const artifactReference: QueueArtifactReference = {
            kind: 'output-writer',
            artifactId: `artifact:${job.id}`,
            digest,
            mimeType: payload.sceneWorkflow.mimeType,
        }
        await context.bindOutput(transactionId, artifactReference)
        let artifactRegistration: QueueArtifactRegistration | null = null
        const autoR2UploadProfileId = payload.sceneWorkflow.outputContext.autoR2UploadProfileId
        const currentR2 = payload.sceneWorkflow.r2Delivery.planned
        try {
            const saved = await saveSceneResult(
                payload.sceneWorkflow.scene,
                payload.sceneWorkflow.saveContext,
                payload.sceneWorkflow.finalPrompt,
                params,
                imageData,
                payload.sceneWorkflow.mimeType,
                encodedVibes,
                {
                    presentation: dependencies.presentation,
                    canSave: context.canCommit,
                    sentPayloadSummary,
                    sourceJobId: job.id,
                    outputTransactionId: transactionId,
                    outputContext: payload.sceneWorkflow.outputContext,
                    ...(outputReservation === null ? {} : { outputReservation }),
                    ...(currentR2 !== null
                        ? {
                            afterSave: async output => {
                                if (artifactRegistration === null) throw new Error('R2 release requires a committed ArtifactRecord')
                                let sidecar: Parameters<typeof enqueueR2Release>[0]['sidecar']
                                if (currentR2.profile.publicMode === 'private') {
                                    if (!output.sidecarFile || artifactRegistration.record.sidecar === null) {
                                        throw new Error('Private R2 release output is missing committed sidecar authority')
                                    }
                                    sidecar = {
                                        file: artifactRegistration.record.sidecar.file,
                                        localPath: output.sidecarFile.displayPath,
                                        digest: artifactRegistration.record.sidecar.digest as `sha256:${string}`,
                                        size: artifactRegistration.record.sidecar.size!,
                                    }
                                }
                                await enqueueR2Release({
                                    snapshot: currentR2,
                                    readiness: 'ready',
                                    artifact: artifactRegistration.record,
                                    originalLocalPath: output.file.displayPath,
                                    ...(sidecar === undefined ? {} : { sidecar }),
                                }, getRuntimeMainQueueDependencies().r2Release)
                            },
                        }
                        : autoR2UploadProfileId == null
                        ? {}
                        : {
                            afterSave: async output => {
                                try {
                                    const release = await legacyR2Release({
                                        profileId: autoR2UploadProfileId,
                                        sourceJobId: job.id,
                                        imageFormat: payload.sceneWorkflow.mimeType === 'image/webp' ? 'webp' : 'png',
                                        output,
                                        bucket: payload.sceneWorkflow.outputContext.r2Bucket,
                                        prefix: payload.sceneWorkflow.outputContext.r2Prefix,
                                    })
                                    if (release.status !== 'uploaded' && release.status !== 'queued') {
                                        reportDiagnostic(new Error(`Generated R2 release did not complete: ${release.status}`), {
                                            operation: 'r2.generated-release',
                                            stage: release.status,
                                            jobId: job.id,
                                        })
                                    }
                                } catch (error) {
                                    reportDiagnostic(error, {
                                        operation: 'r2.generated-release',
                                        stage: 'upload',
                                        jobId: job.id,
                                    })
                                }
                            },
                        }),
                    ...(sequenceLease === null ? {} : { beforeFinalize: () => sequenceLease.commit() }),
                    registerArtifact: async output => {
                        artifactRegistration = await registerQueueArtifact(
                            job,
                            artifactReference,
                            output,
                            undefined,
                            currentR2?.profile.publicMode === 'private',
                        )
                        return artifactRegistration === null
                            ? null
                            : {
                                artifactId: artifactRegistration.record.artifactId,
                                sourceJobId: job.id,
                                sourceSceneId: job.sceneId,
                            }
                    },
                    linkArtifact: async lineage => {
                        const linked = await linkSceneArtifact(getRuntimeSceneRepository(), {
                            presetId: payload.sceneWorkflow.saveContext.activePresetId,
                            sceneId: payload.sceneWorkflow.scene.id,
                            artifactId: lineage.artifactId,
                            createdAt: artifactRegistration?.record.createdAt ?? new Date().toISOString(),
                            favorite: false,
                        })
                        if ('document' in linked) {
                            applySceneDocumentProjection(linked.document)
                            return
                        }
                        throw new Error(`Scene artifact link remains pending: ${linked.status}`)
                    },
                    rollbackArtifact: async () => {
                        await rollbackQueueArtifactRegistration(artifactRegistration)
                        artifactRegistration = null
                    },
                    commitDurable: () => context.commitOutput(transactionId, artifactReference),
                },
            )
            if (!saved && !context.signal.aborted) {
                throw new QueueExecutionError('transient', 'Scene output was not committed')
            }
        } catch (error) {
            if (outputReservation !== null && isLateReservedOutputCollision(error)) {
                await markReservedQueueOutputConflict(job, context)
                throw new QueueExecutionError('fatal', 'Reserved Scene output collided during final commit')
            }
            throw error
        }
    } finally {
        sequenceLease?.release()
    }
}
