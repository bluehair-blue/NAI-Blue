import { beforeEach, describe, expect, it, vi } from 'vitest'

import { hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import { hashGenerationSemanticIntent } from '@/application/generation/plan-generation'
import { projectMainGenerationSemantic } from '@/services/generation/main-generation-semantic'
import {
    CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
    queryNaiGenerationCompatibility,
} from '@/services/nai/compatibility'
import { CURRENT_NAI_MODEL_CATALOG_REVISION } from '@/services/nai/model-catalog'
import type { ProviderAttemptEvidence, ProviderExecutionEnvelope, SpoolReceipt } from '@/domain/queue/provider-result'
import type { GenerationAttempt, GenerationJob } from '@/domain/queue/types'
import type { QueueExecutorContext } from '@/services/queue/durable-queue-coordinator'
import { planR2Release } from '@/application/r2/plan-r2-release'
import { createR2ProfileV2 } from '@/domain/r2/types'

const mocks = vi.hoisted(() => ({
    transport: vi.fn(),
    save: vi.fn(),
    commitOutput: vi.fn(),
    bindOutput: vi.fn(),
    updateProgress: vi.fn(),
    requeueSpooledResult: vi.fn(),
    verify: vi.fn(),
    read: vi.fn(),
    spoolCommit: vi.fn(),
    hash: vi.fn(),
    decode: vi.fn(),
    reportDiagnostic: vi.fn(() => ({ eventId: 'diagnostic:scene' })),
    reserveSequence: vi.fn(() => null),
    r2Readiness: vi.fn(),
    r2Profile: vi.fn(),
}))

vi.mock('@/services/generation/novelai-image-transport', () => ({
    executeNovelAIImageTransport: mocks.transport,
}))
vi.mock('@/lib/scene-generation/save-scene-result', () => ({
    saveSceneResult: mocks.save,
}))
vi.mock('@/services/diagnostics/error-registry', () => ({
    reportDiagnostic: mocks.reportDiagnostic,
}))
vi.mock('@/lib/scene-generation/fragment-runtime', () => ({
    reserveSceneFragmentSequenceProposal: mocks.reserveSequence,
}))
vi.mock('@/services/queue/queue-resource-materializer', () => ({
    getRuntimeQueueResourceMaterializer: () => ({}),
    hashQueueResourceBytes: mocks.hash,
    hydrateGenerationParams: vi.fn(async () => providerParams),
}))
vi.mock('@/services/queue/scene-job-snapshot-codec', () => ({
    decodeSceneJobSnapshot: mocks.decode,
}))
vi.mock('@/services/queue/main-queue-runtime-dependencies', () => ({
    getRuntimeMainQueueDependencies: () => ({
        r2Planning: { getProfile: mocks.r2Profile, getReadiness: mocks.r2Readiness },
        providerResultSpool: {
            commit: mocks.spoolCommit,
            verify: mocks.verify,
            read: mocks.read,
        },
    }),
}))
vi.mock('@/services/queue/queue-artifact-lineage', () => ({
    registerQueueArtifact: vi.fn(async () => null),
    rollbackQueueArtifactRegistration: vi.fn(),
}))
vi.mock('@/application/scene/link-scene-artifact', () => ({
    linkSceneArtifact: vi.fn(),
}))
vi.mock('@/lib/scene-migration-startup', () => ({
    getRuntimeSceneRepository: vi.fn(),
}))
vi.mock('@/lib/scene-authority-runtime', () => ({
    applySceneDocumentProjection: vi.fn(),
}))
vi.mock('@/services/queue/serialized-progress-reporter', () => ({
    createSerializedProgressReporter: () => ({ enqueue: vi.fn(), flush: vi.fn(async () => undefined) }),
}))

import { executeSceneQueueJob } from '@/services/queue/scene-queue-executor'

const digest = `sha256:${'a'.repeat(64)}` as const
const receipt: SpoolReceipt = {
    schemaVersion: 1,
    spoolId: 'provider-scene-spool',
    attemptId: 'scene-job:1:1',
    contentType: 'image/png',
    byteLength: 3,
    sha256: digest,
    committedAt: '2026-09-03T00:00:00.000Z',
}
const providerParams = {
    prompt: 'scene prompt',
    negative_prompt: '',
    model: 'nai-diffusion-4-5-full',
    width: 832,
    height: 1216,
    steps: 28,
    cfg_scale: 5,
    cfg_rescale: 0,
    sampler: 'k_euler',
    scheduler: 'native',
    smea: false,
    smea_dyn: false,
    variety: false,
    seed: 1,
    imageFormat: 'png' as const,
}
const compatibility = queryNaiGenerationCompatibility(
    providerParams,
    CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
    false,
)
const providerEnvelope: ProviderExecutionEnvelope = {
    schemaVersion: 1,
    provider: 'novelai',
    compatibilityProfileId: compatibility.compatibilityProfileId,
    payloadBuilderRevision: CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
    modelCatalogRevision: CURRENT_NAI_MODEL_CATALOG_REVISION,
    action: compatibility.action,
    responseMode: 'standard',
    semanticIntentHash: hashGenerationSemanticIntent(
        projectMainGenerationSemantic(providerParams, 'png'),
    ),
    queueResourceBindings: [],
}

const payload = {
    payloadBuilderRevision: CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
    queueExecution: { streaming: false, sourceEdit: false },
    sceneWorkflow: {
        scene: { id: 'scene-a', name: 'Opening' },
        finalPrompt: 'scene prompt',
        mimeType: 'image/png',
        saveContext: { activePresetId: 'preset-a', sceneSavePath: 'NAI_Blue_Scene' },
        outputContext: {
            useAbsoluteScenePath: false,
            metadataMode: 'embedded',
            presetName: 'Preset A',
            sceneName: 'Opening',
        },
        sequenceCommitProposal: null,
        r2Delivery: { requirement: 'disabled', planned: null },
    },
}

function context(initial: ProviderAttemptEvidence | null, executionMode: QueueExecutorContext['executionMode'] = 'provider'): {
    value: QueueExecutorContext
    transitions: ProviderAttemptEvidence[]
} {
    const transitions: ProviderAttemptEvidence[] = []
    let attempt: GenerationAttempt = {
        recordSchemaVersion: 2,
        id: receipt.attemptId,
        jobId: 'scene-job',
        attemptNumber: 1,
        startedAt: '2026-09-03T00:00:00.000Z',
        finishedAt: null,
        outcome: 'running',
        diagnosticEventId: null,
        providerEvidence: initial,
        providerTransitions: [],
        executionEnvelopeHash: initial === null
            ? null
            : `sha256:${hashCanonicalValue(providerEnvelope)}`,
    }
    return {
        transitions,
        value: {
            executionMode,
            tokenSlotId: 'slot-1',
            token: 'token',
            signal: new AbortController().signal,
            providerAttempt: attempt,
            canCommit: () => true,
            updateProgress: mocks.updateProgress,
            bindOutput: mocks.bindOutput,
            commitOutput: mocks.commitOutput,
            requeueSpooledResult: mocks.requeueSpooledResult,
            recordProviderTransition: vi.fn(async (evidence, options) => {
                transitions.push(evidence)
                attempt = {
                    ...attempt,
                    providerEvidence: evidence,
                    diagnosticEventId: options?.diagnosticEventId ?? attempt.diagnosticEventId,
                }
                return attempt
            }),
        },
    }
}

function job(withEnvelope = true): GenerationJob {
    return {
        id: 'scene-job',
        batchId: 'scene-batch',
        attemptCount: 1,
        workflow: 'scene',
        sceneId: 'scene-a',
        snapshot: {
            providerExecutionEnvelope: withEnvelope ? providerEnvelope : undefined,
            resources: [],
        },
    } as unknown as GenerationJob
}

describe('Scene Queue Provider safety', () => {
    it.each(['provider', 'storage-only'] as const)('rechecks required credentials only for fresh %s dispatch', async executionMode => {
        const selected = createR2ProfileV2({
            id: 'r2-profile', name: 'R2', accountId: 'test', jurisdiction: null, endpoint: null,
            bucket: 'release-bucket', prefix: '', credentialRef: 'stronghold:r2-original',
            transport: 'native-s3', conflictPolicy: 'fail', publicMode: 'r2-dev', publicBaseUrl: null,
        }, '2026-09-05T00:00:00.000Z')
        const release = await planR2Release({
            requirement: { mode: 'required', profileId: selected.id }, objectName: 'image.png', planIdentity: digest,
        }, { getProfile: async () => selected, getReadiness: async () => ({ status: 'ready', credentialRef: selected.credentialRef }) })
        if (release.status !== 'ready' || release.internalSnapshot === null) throw new Error('Expected planned delivery')
        mocks.decode.mockReturnValue({ ...payload, sceneWorkflow: {
            ...payload.sceneWorkflow, r2Delivery: { requirement: 'required', planned: release.internalSnapshot },
        } })
        mocks.r2Readiness.mockResolvedValue({ status: 'not-ready', reason: 'credential' })
        const evidence: ProviderAttemptEvidence = executionMode === 'storage-only'
            ? { dispatchState: 'result-spooled', providerOutcome: 'succeeded', billingRisk: 'confirmed', responseDigest: digest, spoolReceipt: receipt }
            : { dispatchState: 'prepared', providerOutcome: 'running', billingRisk: 'none', responseDigest: null, spoolReceipt: null }
        const current = context(evidence, executionMode)
        const execution = executeSceneQueueJob(job(), current.value, { presentation: {} as never })
        if (executionMode === 'storage-only') {
            await execution
            expect(mocks.r2Readiness).not.toHaveBeenCalled()
            expect(mocks.read).toHaveBeenCalledOnce()
            expect(mocks.save).toHaveBeenCalledOnce()
        } else {
            await expect(execution).rejects.toMatchObject({ kind: 'r2-readiness' })
            expect(mocks.r2Readiness).toHaveBeenCalledWith(selected)
            expect(mocks.save).not.toHaveBeenCalled()
            expect(current.transitions).toEqual([])
        }
        expect(mocks.transport).not.toHaveBeenCalled()
        expect(mocks.r2Profile).not.toHaveBeenCalled()
    })
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.decode.mockReturnValue(payload)
        mocks.hash.mockResolvedValue(digest)
        mocks.verify.mockResolvedValue(receipt)
        mocks.read.mockResolvedValue(new Uint8Array([1, 2, 3]))
        mocks.spoolCommit.mockResolvedValue(receipt)
        mocks.save.mockImplementation(async (...args: unknown[]) => {
            const options = args[7] as { commitDurable?: (result: unknown) => Promise<void> }
            await options.commitDurable?.({})
            return true
        })
        mocks.transport.mockImplementation(async request => {
            if (request.executionHooks !== undefined) {
                await request.executionHooks.observer({ stage: 'possibly-dispatched' })
                await request.executionHooks.observer({ stage: 'response-started', status: 200, retryAfter: null })
                await request.executionHooks.observer({ stage: 'response-complete', status: 200, retryAfter: null })
            }
            return { success: true, imageData: 'data:image/png;base64,AQID' }
        })
    })

    it('keeps current durable R2 delivery separate from Scene Provider execution', async () => {
        mocks.decode.mockReturnValue({
            ...payload,
            sceneWorkflow: {
                ...payload.sceneWorkflow,
                r2Delivery: { requirement: 'best-effort', planned: { profile: { publicMode: 'r2-dev' } } },
            },
        })
        await executeSceneQueueJob(
            job(),
            context({
                dispatchState: 'prepared', providerOutcome: 'running', billingRisk: 'none',
                responseDigest: null, spoolReceipt: null,
            }).value,
            { presentation: {} as never },
        )
        expect(mocks.transport).toHaveBeenCalledTimes(1)
        expect(mocks.save).toHaveBeenCalledTimes(1)
    })

    it('dispatches new envelope jobs through evidence and the durable spool', async () => {
        const current = context({
            dispatchState: 'prepared',
            providerOutcome: 'running',
            billingRisk: 'none',
            responseDigest: null,
            spoolReceipt: null,
        })

        await executeSceneQueueJob(job(), current.value, { presentation: {} as never })

        expect(mocks.transport).toHaveBeenCalledTimes(1)
        expect(mocks.spoolCommit).toHaveBeenCalledTimes(1)
        expect(current.transitions.at(-1)).toMatchObject({ dispatchState: 'result-spooled' })
        expect(mocks.save).toHaveBeenCalledTimes(1)
    })

    it('resumes a spooled Scene result with zero Provider calls', async () => {
        const current = context({
            dispatchState: 'result-spooled',
            providerOutcome: 'succeeded',
            billingRisk: 'confirmed',
            responseDigest: digest,
            spoolReceipt: receipt,
        }, 'storage-only')

        await executeSceneQueueJob(job(), current.value, { presentation: {} as never })

        expect(mocks.transport).toHaveBeenCalledTimes(0)
        expect(mocks.spoolCommit).toHaveBeenCalledTimes(0)
        expect(mocks.verify).toHaveBeenCalledTimes(1)
        expect(mocks.save).toHaveBeenCalledTimes(1)
    })

    it('rejects a drifted envelope before any Scene Provider call', async () => {
        const current = context({
            dispatchState: 'prepared',
            providerOutcome: 'running',
            billingRisk: 'none',
            responseDigest: null,
            spoolReceipt: null,
        })
        const drifted = {
            ...providerEnvelope,
            semanticIntentHash: `sha256:${'b'.repeat(64)}`,
        }

        await expect(executeSceneQueueJob({
            ...job(),
            snapshot: { providerExecutionEnvelope: drifted, resources: [] },
        } as unknown as GenerationJob, current.value, { presentation: {} as never })).rejects.toMatchObject({
            name: 'QueueExecutionError',
            kind: 'compatibility',
        })
        expect(mocks.transport).toHaveBeenCalledTimes(0)
        expect(mocks.spoolCommit).toHaveBeenCalledTimes(0)
        expect(mocks.save).toHaveBeenCalledTimes(0)
    })

    it('fails a Phase 6 Scene batch closed when its reservation snapshot is missing', async () => {
        const current = context({
            dispatchState: 'prepared',
            providerOutcome: 'running',
            billingRisk: 'none',
            responseDigest: null,
            spoolReceipt: null,
        })
        mocks.decode.mockReturnValue({
            ...payload,
            sceneWorkflow: {
                ...payload.sceneWorkflow,
                batch: { request: {}, count: 1, estimatedAnlas: 0, planHash: digest },
            },
        })

        await expect(executeSceneQueueJob(job(), current.value, { presentation: {} as never }))
            .rejects.toMatchObject({ name: 'QueueExecutionError', kind: 'fatal' })
        expect(mocks.transport).toHaveBeenCalledTimes(0)
        expect(mocks.spoolCommit).toHaveBeenCalledTimes(0)
    })

    it('keeps legacy Scene snapshots on the existing direct transport path', async () => {
        const current = context(null)

        await executeSceneQueueJob(job(false), current.value, { presentation: {} as never })

        expect(mocks.transport).toHaveBeenCalledTimes(1)
        expect(mocks.spoolCommit).toHaveBeenCalledTimes(0)
        expect(mocks.save).toHaveBeenCalledTimes(1)
    })
})
