import { sha256Utf8 } from '@/domain/composition/canonical-serialize'
import type { GenerationJob, QueueArtifactReference } from '@/domain/queue/types'
import { ProviderResultSpoolError } from '@/application/generation/provider-result-spool'
import { reserveWildcardSequenceProposal } from '@/lib/fragment-processor'
import { createThumbnail } from '@/lib/image-utils'
import { executeNovelAIImageTransport } from '@/services/generation/novelai-image-transport'
import {
    CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
    isSupportedNaiPayloadBuilderRevision,
    queryNaiGenerationCompatibility,
} from '@/services/nai/compatibility'
import { CURRENT_NAI_MODEL_CATALOG_REVISION } from '@/services/nai/model-catalog'
import { hashGenerationSemanticIntent } from '@/application/generation/plan-generation'
import { assertAnlasCostConsentAllows } from '@/domain/queue/anlas-cost-consent'
import { calculateAnlasCost, resolveAnlasPricingBasis } from '@/lib/anlas-calculator'
import { projectMainGenerationSemantic } from '@/services/generation/main-generation-semantic'
import { reportDiagnostic } from '@/services/diagnostics/error-registry'
import { getRuntimeOutputWriter, OutputWriterError } from '@/services/output/output-writer'
import type { QueueExecutorContext } from './durable-queue-coordinator'
import { QueueExecutionError } from './durable-queue-coordinator'
import { decodeMainJobSnapshot } from './main-job-snapshot-codec'
import { getRuntimeMainQueueDependencies } from './main-queue-runtime-dependencies'
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
import { createSerializedProgressReporter } from './serialized-progress-reporter'
import {
    DEFAULT_RIGHTS_OWNER,
    isRightsEffectiveDate,
    isRightsOwner,
} from '@/domain/workflow/bluehair-rights-policy'
import {
    assertProviderEnvelopeMatchesExecution,
    dispatchAndSpool,
    providerResourceBindings,
    writeSpooled,
    type SpooledProviderResult,
} from './provider-safe-image-dispatch'
import {
    markReservedQueueOutputConflict,
    preflightReservedQueueOutput,
} from './output-reservation-preflight'

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

function isReservedOutputCollision(error: unknown): error is OutputWriterError {
    return error instanceof OutputWriterError
        && (error.message.includes('already exists')
            || error.message.includes('already being written')
            || error.message.includes('changed before commit')
            || error.message.includes('reservation does not match'))
}

/**
 * Depends on the immutable Main snapshot, Queue lease context, NAI transport,
 * OutputWriter transaction, and presentation port. It owns only durable job
 * execution and projection; planning, snapshot encoding, and enqueue remain in
 * the adapter so retries replay the persisted request without reading UI state.
 */
export async function executeMainQueueJob(job: GenerationJob, context: QueueExecutorContext): Promise<void> {
    const {
        presentation,
        providerResultSpool,
        faultInjector,
        legacyR2Release,
        legacyR2Cleanup,
    } = getRuntimeMainQueueDependencies()
    const payload = decodeMainJobSnapshot(job.snapshot)
    // Phase 7C removes this guard when durable release enqueue consumes the immutable binding.
    if (payload.mainWorkflow.r2Delivery.planned !== null) {
        throw new QueueExecutionError('fatal', 'Current R2 delivery snapshot requires durable release enqueue')
    }
    if (!isSupportedNaiPayloadBuilderRevision(payload.payloadBuilderRevision)) {
        throw new QueueExecutionError(
            'compatibility',
            `Unsupported Main payload builder revision: ${payload.payloadBuilderRevision}`,
        )
    }
    const params = await hydrateGenerationParams(payload, job.snapshot.resources, getRuntimeQueueResourceMaterializer())
    params.sourceJobId = job.id
    const streaming = payload.queueExecution.streaming && !payload.queueExecution.sourceEdit
    const compatibility = queryNaiGenerationCompatibility(
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
            job.snapshot.providerExecutionEnvelope,
            context,
            {
                payloadBuilderRevision: CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
                modelCatalogRevision: CURRENT_NAI_MODEL_CATALOG_REVISION,
                compatibilityProfileId: compatibility.compatibilityProfileId,
                action: compatibility.action,
                responseMode: streaming ? 'streaming' : 'standard',
                semanticIntentHash: hashGenerationSemanticIntent(
                    projectMainGenerationSemantic(params, payload.mainWorkflow.imageFormat),
                ),
                queueResourceBindings: providerResourceBindings(job.snapshot.resources),
            },
        )
    } catch (error) {
        if (context.providerAttempt.providerEvidence?.dispatchState === 'result-spooled') {
            const diagnosticEventId = reportDiagnostic(error, {
                operation: 'queue.main.write-spooled', stage: 'execution-envelope', jobId: job.id,
            }).eventId
            await context.requeueSpooledResult({ diagnosticEventId, pauseReason: 'compatibility' })
        }
        throw error
    }
    if (job.snapshot.outputReservation !== undefined && context.executionMode === 'provider') {
        try {
            if (context.activeCredentialsAreOpus === undefined) {
                throw new Error('Queue credential pricing authority is unavailable')
            }
            const pricingBasis = resolveAnlasPricingBasis({
                model: params.model,
                activeCredentialsAreOpus: context.activeCredentialsAreOpus,
            })
            const costConsent = payload.mainWorkflow.costConsent
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
    const outputReservation = await preflightReservedQueueOutput(job, context, {
        ...(payload.mainWorkflow.output.portableDirectory === undefined
            ? {}
            : { portableDirectory: payload.mainWorkflow.output.portableDirectory }),
        directory: payload.mainWorkflow.output.directory,
        useAbsolutePath: payload.mainWorkflow.output.useAbsolutePath,
        capabilityFallbackDirectory: payload.mainWorkflow.output.capabilityFallbackDirectory,
        workflowDefaultDirectory: 'NAI_Blue_Output',
        fileName: payload.mainWorkflow.output.fileName,
        extension: payload.mainWorkflow.imageFormat,
        collisionPolicy: payload.mainWorkflow.output.collisionPolicy,
    })
    // Reserve before transport so a stale immutable snapshot fails without a
    // provider call. Planned Main jobs run in ordinal order and commit their
    // distinct CAS proposals one at a time through this lease.
    const sequenceLease = reserveWildcardSequenceProposal(payload.mainWorkflow.sequenceCommitProposal)
    if (sequenceLease === null) {
        if (context.providerAttempt.providerEvidence?.dispatchState === 'result-spooled') {
            const diagnosticEventId = reportDiagnostic(new Error('Fragment sequence snapshot is stale'), {
                operation: 'queue.main.write-spooled', stage: 'sequence-reserve', jobId: job.id,
            }).eventId
            await context.requeueSpooledResult({ diagnosticEventId, pauseReason: 'fatal' })
        }
        throw new QueueExecutionError('fatal', 'Fragment sequence snapshot is stale before Main transport')
    }
    presentation.beginExecution()
    try {
        await context.updateProgress('transport', 0, Math.max(1, params.steps))
        const progressReporter = createSerializedProgressReporter(context.updateProgress)
        const onProgress = (progress: number, previewImage?: string): void => {
                presentation.reportStreamProgress(
                    progress,
                    context.canCommit() ? previewImage : undefined,
                )
                progressReporter.enqueue(
                    'stream',
                    Math.min(params.steps, Math.round(params.steps * progress / 100)),
                    params.steps,
                )
            }
        let bytes: Uint8Array
        let sentPayloadSummary: string | undefined
        let encodedVibes: string[] | undefined
        if (job.snapshot.providerExecutionEnvelope !== undefined) {
            const currentEvidence = context.providerAttempt.providerEvidence
            let spooled: SpooledProviderResult
            if (currentEvidence?.dispatchState === 'result-spooled' && currentEvidence.spoolReceipt !== null) {
                spooled = { receipt: currentEvidence.spoolReceipt }
            } else {
                if (context.executionMode === 'storage-only') {
                    throw new QueueExecutionError('fatal', 'Storage-only Main execution has no verified spool receipt')
                }
                spooled = await dispatchAndSpool(
                    context,
                    params,
                    payload.mainWorkflow.imageFormat,
                    streaming,
                    providerResultSpool,
                    faultInjector,
                    onProgress,
                )
            }
            bytes = await writeSpooled(providerResultSpool, spooled.receipt).catch(async error => {
                const diagnosticEventId = reportDiagnostic(error, {
                    operation: 'queue.main.write-spooled',
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
        } else {
            const result = await executeNovelAIImageTransport({
                token: context.token,
                params,
                imageFormat: payload.mainWorkflow.imageFormat,
                streaming,
                signal: context.signal,
                onProgress,
                faultInjector,
            })
            if (!result.success || !result.imageData) {
                if (result.termination === 'cancelled') return
                if (result.termination === 'timeout') {
                    throw new QueueExecutionError('timeout', 'Main generation reached its bounded timeout')
                }
                throw new QueueExecutionError('decode', 'Main generation returned no decodable image')
            }
            bytes = decodeImageBytes(result.imageData)
            sentPayloadSummary = result.sentPayloadSummary
            encodedVibes = result.encodedVibes
        }
        await progressReporter.flush()
        if (!context.canCommit()) return

        const encodedImage = encodeImageBytes(bytes)
        const imageDataUrl = `data:image/${payload.mainWorkflow.imageFormat};base64,${encodedImage}`
        const digest = await hashQueueResourceBytes(bytes)
        const transactionId = `queue-${sha256Utf8(job.id).slice(0, 48)}`
        const artifactReference: QueueArtifactReference = {
            kind: 'output-writer',
            artifactId: `artifact:${job.id}`,
            digest,
            mimeType: `image/${payload.mainWorkflow.imageFormat}`,
        }
        await context.bindOutput(transactionId, artifactReference)
        let historyCommitted = false
        const historyId = `queue-history:${job.id}`
        let sequenceConflict = false
        let artifactRegistration: QueueArtifactRegistration | null = null
        const hasPrivateRelease = payload.mainWorkflow.metadataMode === 'strip-and-sidecar'
        const rightsEffectiveDate = payload.mainWorkflow.output.rightsXmpEnabled === true
            && isRightsEffectiveDate(payload.mainWorkflow.output.rightsEffectiveDate)
            ? payload.mainWorkflow.output.rightsEffectiveDate
            : null
        const rightsOwner = isRightsOwner(payload.mainWorkflow.output.rightsOwner)
            ? payload.mainWorkflow.output.rightsOwner
            : DEFAULT_RIGHTS_OWNER
        const output = await getRuntimeOutputWriter().write({
            transactionId,
            sourceJobId: job.id,
            ...(outputReservation === null ? {} : { outputReservation }),
            includeFinalImageFacts: true,
            destination: {
                ...(payload.mainWorkflow.output.portableDirectory === undefined
                    ? {}
                    : { portableDirectory: payload.mainWorkflow.output.portableDirectory }),
                directory: payload.mainWorkflow.output.directory,
                useAbsolutePath: payload.mainWorkflow.output.useAbsolutePath,
                capabilityFallbackDirectory: payload.mainWorkflow.output.capabilityFallbackDirectory,
                workflowDefaultDirectory: 'NAI_Blue_Output',
                fileName: payload.mainWorkflow.output.fileName,
                extension: payload.mainWorkflow.imageFormat,
                collisionPolicy: payload.mainWorkflow.output.collisionPolicy,
            },
            imageBytes: bytes,
            imageDataUrl,
            preserveProviderOriginal: hasPrivateRelease,
            terminalWorkflowCommit: true,
            metadata: {
                params: { ...params, sentPayloadSummary, sourceJobId: job.id },
                imageFormat: payload.mainWorkflow.imageFormat,
                metadataMode: payload.mainWorkflow.metadataMode,
                includeWebpCompatibilitySidecar: true,
                ...(rightsEffectiveDate === null
                    ? {}
                    : {
                        rightsXmp: {
                            owner: rightsOwner,
                            effectiveDate: rightsEffectiveDate,
                            metadataDate: new Date().toISOString(),
                        },
                    }),
            },
            generateThumbnail: createThumbnail,
            canCommit: context.canCommit,
            commitWorkflow: async outputResult => {
                if (!context.canCommit()) throw new Error('Durable Main job was cancelled before publication')
                if (!sequenceLease.commit()) {
                    sequenceConflict = true
                    throw new Error('Fragment sequence changed before durable Main output commit')
                }
                artifactRegistration = await registerQueueArtifact(job, artifactReference, outputResult)
                presentation.commitHistory({
                    id: historyId,
                    url: outputResult.thumbnailDataUrl ?? imageDataUrl,
                    prompt: payload.mainWorkflow.finalPrompt,
                    seed: params.seed,
                    timestamp: new Date(),
                    sentPayloadSummary,
                    ...(artifactRegistration === null
                        ? {}
                        : {
                            artifactId: artifactRegistration.record.artifactId,
                            sourceJobId: job.id,
                            ...(job.sceneId === null ? {} : { sourceSceneId: job.sceneId }),
                        }),
                }, imageDataUrl)
                historyCommitted = true
                presentation.publishArtifact({
                    path: outputResult.path,
                    ...(artifactRegistration === null
                        ? {}
                        : {
                            artifactId: artifactRegistration.record.artifactId,
                            sourceJobId: job.id,
                            ...(job.sceneId === null ? {} : { sourceSceneId: job.sceneId }),
                        }),
                })
                await context.commitOutput(transactionId, artifactReference)
            },
            rollbackWorkflow: async () => {
                if (historyCommitted) {
                    presentation.rollbackHistory(historyId, imageDataUrl)
                    historyCommitted = false
                }
                await rollbackQueueArtifactRegistration(artifactRegistration)
                artifactRegistration = null
            },
        }).catch(async error => {
            if (sequenceConflict) {
                if (job.snapshot.providerExecutionEnvelope !== undefined && context.canCommit()) {
                    const diagnosticEventId = reportDiagnostic(error, {
                        operation: 'queue.main.write-spooled', stage: 'sequence-commit', jobId: job.id,
                    }).eventId
                    await context.requeueSpooledResult({ diagnosticEventId, pauseReason: 'fatal' })
                }
                throw new QueueExecutionError('fatal', 'Fragment sequence changed before Main commit')
            }
            if (outputReservation !== null && isReservedOutputCollision(error)) {
                await markReservedQueueOutputConflict(job, context)
                throw new QueueExecutionError('fatal', 'Reserved Main output collided before commit')
            }
            if (job.snapshot.providerExecutionEnvelope !== undefined && context.canCommit()) {
                const diagnosticEventId = reportDiagnostic(error, {
                    operation: 'queue.main.write-spooled', stage: 'output-writer', jobId: job.id,
                }).eventId
                await context.requeueSpooledResult({ diagnosticEventId, pauseReason: 'local-io' })
            }
            throw error
        })
        if (output.status === 'cancelled') return
        if (hasPrivateRelease) {
            let releaseVerified = payload.mainWorkflow.output.autoR2UploadProfileId == null
            if (payload.mainWorkflow.output.autoR2UploadProfileId != null) {
                try {
                    const release = await legacyR2Release({
                        profileId: payload.mainWorkflow.output.autoR2UploadProfileId,
                        sourceJobId: job.id,
                        imageFormat: payload.mainWorkflow.imageFormat,
                        output: output.result,
                        bucket: payload.mainWorkflow.output.r2Bucket,
                        prefix: payload.mainWorkflow.output.r2Prefix,
                    })
                    releaseVerified = release.status === 'uploaded'
                    if (!releaseVerified) {
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
            }
            if (payload.mainWorkflow.output.deleteOriginalAfterRelease === true && releaseVerified) {
                try {
                    await legacyR2Cleanup(output.result)
                } catch (error) {
                    reportDiagnostic(error, {
                        operation: 'output.provider-original',
                        stage: 'discard-after-release',
                        jobId: job.id,
                    })
                }
            }
        }
        if (encodedVibes && encodedVibes.length > 0) {
            presentation.updateEncodedVibes(encodedVibes)
        }
        if (context.executionMode === 'provider') {
            const slot = context.tokenSlotId === 'slot-2' ? 2 : 1
            presentation.refreshAnlas(slot)
        }
    } finally {
        sequenceLease.release()
        presentation.finishExecution()
    }
}
