import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProviderAttemptEvidence, ProviderExecutionEnvelope, SpoolReceipt } from '@/domain/queue/provider-result'
import type { GenerationAttempt, GenerationJob } from '@/domain/queue/types'
import { QueueExecutionError, type QueueExecutorContext } from '@/services/queue/durable-queue-coordinator'
import { hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import { hashGenerationSemanticIntent } from '@/application/generation/plan-generation'
import { projectMainGenerationSemantic } from '@/services/generation/main-generation-semantic'
import { NovelAIHttpError } from '@/services/novelai-types'
import { createR2ProfileV2, hashR2ProfileV2 } from '@/domain/r2/types'
import { createAnlasCostConsentSnapshot } from '@/domain/queue/anlas-cost-consent'

const mocks = vi.hoisted(() => ({
    transport: vi.fn(),
    write: vi.fn(),
    preflight: vi.fn(),
    commit: vi.fn(),
    verify: vi.fn(),
    read: vi.fn(),
    hash: vi.fn(),
    refreshAnlas: vi.fn(),
    r2Readiness: vi.fn(),
    r2Profile: vi.fn(),
}))

vi.mock('@/services/generation/novelai-image-transport', () => ({
    executeNovelAIImageTransport: mocks.transport,
}))
vi.mock('@/services/nai/compatibility', () => ({
    isSupportedNaiPayloadBuilderRevision: () => true,
    CURRENT_NAI_PAYLOAD_BUILDER_REVISION: 'nai-blue-payload-v1',
    queryNaiGenerationCompatibility: () => ({
        status: 'supported', compatibilityProfileId: 'profile', action: 'generate',
    }),
}))
vi.mock('@/lib/fragment-processor', () => ({
    reserveWildcardSequenceProposal: () => ({ commit: () => true, release: vi.fn() }),
}))
vi.mock('@/lib/image-utils', () => ({ createThumbnail: vi.fn() }))
vi.mock('@/services/diagnostics/error-registry', () => ({
    reportDiagnostic: () => ({ eventId: 'diagnostic:test' }),
}))
vi.mock('@/services/output/output-writer', () => ({
    OutputWriterError: class OutputWriterError extends Error {
        constructor(readonly phase: string, message: string) {
            super(message)
            this.name = 'OutputWriterError'
        }
    },
    getRuntimeOutputWriter: () => ({
        write: mocks.write,
        preflightExactDestination: mocks.preflight,
    }),
}))
vi.mock('@/services/r2/generated-release', () => ({
    discardGeneratedProviderOriginal: vi.fn(), releaseGeneratedOutputToR2: vi.fn(),
}))
vi.mock('@/services/queue/queue-artifact-lineage', () => ({
    registerQueueArtifact: vi.fn(async () => null), rollbackQueueArtifactRegistration: vi.fn(),
}))
vi.mock('@/services/queue/queue-resource-materializer', () => ({
    getRuntimeQueueResourceMaterializer: () => ({}),
    hashQueueResourceBytes: mocks.hash,
    hydrateGenerationParams: vi.fn(async () => providerParams),
}))
vi.mock('@/services/queue/main-job-snapshot-codec', () => ({
    decodeMainJobSnapshot: (snapshot: GenerationJob['snapshot']) => ({
        payloadBuilderRevision: 'nai-blue-payload-v1',
        queueExecution: { streaming: false, sourceEdit: false },
        mainWorkflow: {
            imageFormat: 'png', metadataMode: (snapshot.parameters as Record<string, unknown>)?.metadataMode ?? 'embedded', finalPrompt: 'prompt',
            sequenceCommitProposal: { changes: [] },
            r2Delivery: (snapshot.parameters as unknown as { r2Delivery?: unknown })?.r2Delivery
                ?? { requirement: 'disabled', planned: null },
            ...(snapshot.outputReservation === undefined
                ? {}
                : {
                    costConsent: (snapshot.parameters as Record<string, unknown>)?.costConsent ?? {
                        schemaVersion: 1,
                        unit: 'anlas',
                        estimatorVersion: 'nai-blue-anlas-v3',
                        pricingBasis: 'all-active-opus',
                        estimatedAnlas: 0,
                        maxAnlas: 0,
                        estimatedAt: '2026-09-03T00:00:00.000Z',
                        approvedAt: '2026-09-03T00:00:00.000Z',
                    },
                }),
            output: {
                directory: 'output', useAbsolutePath: false, capabilityFallbackDirectory: 'output',
                fileName: 'image', collisionPolicy: 'unique', rightsXmpEnabled: false,
            },
        },
    }),
}))
vi.mock('@/domain/workflow/bluehair-rights-policy', () => ({
    DEFAULT_RIGHTS_OWNER: 'bluehair.blue', isRightsEffectiveDate: () => false, isRightsOwner: () => false,
}))
vi.mock('@/services/nai/model-catalog', () => ({
    CURRENT_NAI_MODEL_CATALOG_REVISION: 'nai-blue-model-catalog-v1',
}))

vi.mock('@/services/queue/main-queue-runtime-dependencies', () => {
    const providerResultSpool = {
        commit: mocks.commit, verify: mocks.verify, read: mocks.read,
        removeIfEligible: vi.fn(), list: vi.fn(), reconcile: vi.fn(),
    }
    const presentation = {
        beginExecution: vi.fn(), finishExecution: vi.fn(), reportStreamProgress: vi.fn(),
        commitHistory: vi.fn(), rollbackHistory: vi.fn(), publishArtifact: vi.fn(),
        updateEncodedVibes: vi.fn(), refreshAnlas: mocks.refreshAnlas,
    }
    return {
        getRuntimeMainQueueDependencies: () => ({
            r2Planning: { getProfile: mocks.r2Profile, getReadiness: mocks.r2Readiness },
            presentation,
            providerResultSpool,
            outputReservations: {
                getCurrentFolderBinding: () => ({
                    resourceType: 'generation-folder-document',
                    resourceId: 'generation-folder-document',
                    revision: 7,
                    contentHash: `sha256:${'b'.repeat(64)}`,
                }),
                preflight: mocks.preflight,
            },
        }),
    }
})

import { executeMainQueueJob } from '@/services/queue/main-queue-executor'
import { OutputWriterError } from '@/services/output/output-writer'

const prepared: ProviderAttemptEvidence = {
    dispatchState: 'prepared', providerOutcome: 'running', billingRisk: 'none',
    responseDigest: null, spoolReceipt: null,
}
const receipt: SpoolReceipt = {
    schemaVersion: 1, spoolId: 'provider-spool', attemptId: 'job:1:1', contentType: 'image/png',
    byteLength: 3, sha256: `sha256:${'a'.repeat(64)}`, committedAt: '2026-09-03T00:00:00.000Z',
}
const providerParams = {
    prompt: 'prompt', negative_prompt: '', model: 'nai-diffusion-4-5-full',
    width: 832, height: 1216, steps: 28, cfg_scale: 5, cfg_rescale: 0,
    sampler: 'k_euler', scheduler: 'native', smea: false, smea_dyn: false,
    variety: false, seed: 1, imageFormat: 'png' as const,
}
const providerEnvelope: ProviderExecutionEnvelope = {
    schemaVersion: 1 as const,
    provider: 'novelai' as const,
    compatibilityProfileId: 'profile',
    payloadBuilderRevision: 'nai-blue-payload-v1',
    modelCatalogRevision: 'nai-blue-model-catalog-v1',
    action: 'generate' as const,
    responseMode: 'standard' as const,
    semanticIntentHash: hashGenerationSemanticIntent(projectMainGenerationSemantic(providerParams, 'png')),
    queueResourceBindings: [],
}

const r2Profile = createR2ProfileV2({
    id: 'r2-profile', name: 'R2', accountId: 'test', jurisdiction: null, endpoint: null,
    bucket: 'release-bucket', prefix: '', credentialRef: 'stronghold:r2-original',
    transport: 'native-s3', conflictPolicy: 'fail', publicMode: 'r2-dev', publicBaseUrl: null,
}, '2026-09-05T00:00:00.000Z')
const requiredDelivery = { requirement: 'required', planned: {
    destination: {
        requirement: 'required', profileId: r2Profile.id, profileHash: hashR2ProfileV2(r2Profile),
        bucket: r2Profile.bucket, key: 'image.png', conflictPolicy: 'fail', verification: 'head-metadata-sha256',
        provenance: { profileId: 'explicit-request', bucket: 'profile-snapshot', prefix: 'profile-snapshot', key: 'planned-output' },
    }, profile: r2Profile, credentialBinding: { credentialRef: r2Profile.credentialRef },
} }

function job(options: {
    envelope?: Partial<typeof providerEnvelope>
    withReservation?: boolean
    currentR2Delivery?: boolean
    metadataMode?: string
} = {}): GenerationJob {
    const folderBinding = {
        resourceType: 'generation-folder-document' as const,
        resourceId: 'generation-folder-document',
        revision: 7,
        contentHash: `sha256:${'b'.repeat(64)}` as const,
    }
    return {
        id: 'job:1', batchId: 'batch:1', attemptCount: 1, workflow: 'main', sceneId: null,
        snapshot: {
            providerExecutionEnvelope: { ...providerEnvelope, ...options.envelope },
            resources: [],
            parameters: options.currentR2Delivery === true
                ? { r2Delivery: requiredDelivery, ...(options.metadataMode === undefined ? {} : { metadataMode: options.metadataMode }) }
                : {},
            ...(options.withReservation === true
                ? {
                    outputReservation: {
                        reservationId: 'reservation:job:1',
                        folderBinding,
                        directoryIdentity: `sha256:${'c'.repeat(64)}` as const,
                        relativePath: 'image.png',
                        collisionPolicy: 'fail' as const,
                        expectedExistingDigest: null,
                    },
                }
                : {}),
        },
    } as unknown as GenerationJob
}

function context(initial: ProviderAttemptEvidence, options: {
    executionEnvelopeHash?: string
    activeCredentialsAreOpus?: boolean
    executionMode?: QueueExecutorContext['executionMode']
} = {}): {
    value: QueueExecutorContext
    transitions: Array<{ evidence: ProviderAttemptEvidence; blockReason?: string }>
} {
    const transitions: Array<{ evidence: ProviderAttemptEvidence; blockReason?: string }> = []
    let attempt: GenerationAttempt = {
        recordSchemaVersion: 2, id: 'job:1:1', jobId: 'job:1', attemptNumber: 1,
        startedAt: '2026-09-03T00:00:00.000Z', finishedAt: null, outcome: 'running',
        diagnosticEventId: null, providerEvidence: initial, providerTransitions: [],
        executionEnvelopeHash: options.executionEnvelopeHash ?? `sha256:${hashCanonicalValue(providerEnvelope)}`,
    }
    return {
        transitions,
        value: {
            executionMode: options.executionMode ?? 'provider',
            tokenSlotId: 'slot-1', token: 'token', signal: new AbortController().signal,
            activeCredentialsAreOpus: options.activeCredentialsAreOpus ?? true,
            get providerAttempt() { return attempt }, canCommit: () => true, updateProgress: vi.fn(), bindOutput: vi.fn(),
            commitOutput: vi.fn(), requeueSpooledResult: vi.fn(),
            getOutputReservation: vi.fn(async () => ({
                reservationId: 'reservation:job:1',
                batchId: 'batch:1',
                jobId: 'job:1',
                folderBinding: {
                    resourceType: 'generation-folder-document',
                    resourceId: 'generation-folder-document',
                    revision: 7,
                    contentHash: `sha256:${'b'.repeat(64)}`,
                },
                directoryIdentity: `sha256:${'c'.repeat(64)}`,
                relativePath: 'image.png',
                collisionPolicy: 'fail',
                expectedExistingDigest: null,
                state: 'storage-pending',
            })),
            transitionOutputReservation: vi.fn(async () => undefined),
            recordProviderTransition: vi.fn(async (evidence, options) => {
                transitions.push({ evidence, blockReason: options?.blockReason })
                attempt = { ...attempt, providerEvidence: evidence }
                return attempt
            }),
        },
    }
}

describe('Main Queue Provider result safety', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.verify.mockResolvedValue(receipt)
        mocks.read.mockResolvedValue(new Uint8Array([1, 2, 3]))
        mocks.commit.mockResolvedValue(receipt)
        mocks.preflight.mockResolvedValue({
            fileName: 'image.png',
            directoryIdentity: `sha256:${'c'.repeat(64)}`,
            availableSpaceCheck: 'unavailable',
            foregroundSingleWriterOnly: true,
            crossProcessReservation: false,
        })
        mocks.hash.mockResolvedValue(`sha256:${'a'.repeat(64)}`)
        mocks.write.mockImplementation(async request => {
            await request.commitWorkflow({ path: 'output/image.png' })
            return { status: 'committed', result: { path: 'output/image.png' } }
        })
    })

    it('dispatches two paid one-image jobs with narrowed consent and rejects a batch estimate on one job', async () => {
        const consent = createAnlasCostConsentSnapshot({ pricingBasis: 'paid', estimatedAnlas: 20, maxAnlas: 20,
            estimatedAt: '2026-09-05T00:00:00.000Z', approvedAt: '2026-09-05T00:00:00.000Z' })
        mocks.transport.mockImplementation(async request => {
            await request.executionHooks.observer({ stage: 'possibly-dispatched' })
            await request.executionHooks.observer({ stage: 'response-started', status: 200, retryAfter: null })
            await request.executionHooks.observer({ stage: 'response-complete', status: 200, retryAfter: null })
            return { success: true, imageData: 'data:image/png;base64,AQID' }
        })
        for (let ordinal = 0; ordinal < 2; ordinal++) {
            const queued = job({ withReservation: true })
            await executeMainQueueJob({ ...queued, snapshot: { ...queued.snapshot,
                parameters: { costConsent: consent } } }, context(prepared, { activeCredentialsAreOpus: false }).value)
        }
        expect(mocks.transport).toHaveBeenCalledTimes(2)
        const queued = job({ withReservation: true })
        await expect(executeMainQueueJob({ ...queued, snapshot: { ...queued.snapshot,
            parameters: { costConsent: { ...consent, estimatedAnlas: 40, maxAnlas: 40 } } } },
        context(prepared, { activeCredentialsAreOpus: false }).value)).rejects.toThrow('Anlas cost consent')
        expect(mocks.transport).toHaveBeenCalledTimes(2)
    })

    it('keeps current durable R2 delivery separate from Provider execution', async () => {
        mocks.r2Readiness.mockRejectedValue(new Error('R2 vault locked'))
        await executeMainQueueJob(
            job({ currentR2Delivery: true, metadataMode: 'strip-and-sidecar' }),
            context({
                dispatchState: 'result-spooled', providerOutcome: 'succeeded', billingRisk: 'confirmed',
                responseDigest: receipt.sha256, spoolReceipt: receipt,
            }, { executionMode: 'storage-only' }).value,
        )
        expect(mocks.transport).not.toHaveBeenCalled()
        expect(mocks.read).toHaveBeenCalledTimes(1)
        expect(mocks.write).toHaveBeenCalledTimes(1)
        expect(mocks.r2Readiness).not.toHaveBeenCalled()
        expect(mocks.write.mock.calls[0][0].preserveProviderOriginal).toBe(true)
    })

    it('blocks required R2 with revoked credentials immediately before fresh Provider dispatch', async () => {
        mocks.r2Readiness.mockResolvedValue({ status: 'not-ready', reason: 'credential' })
        const current = context(prepared)
        await expect(executeMainQueueJob(job({ currentR2Delivery: true }), current.value))
            .rejects.toMatchObject({ kind: 'r2-readiness' })
        expect(mocks.r2Readiness).toHaveBeenCalledWith(r2Profile)
        expect(mocks.r2Profile).not.toHaveBeenCalled()
        expect(mocks.transport).not.toHaveBeenCalled()
        expect(mocks.write).not.toHaveBeenCalled()
        expect(current.transitions).toEqual([])
    })

    it('dispatches with the immutable ready credential even when the current profile is unavailable', async () => {
        mocks.r2Profile.mockRejectedValue(new Error('Current profile was removed'))
        mocks.r2Readiness.mockResolvedValue({ status: 'ready', credentialRef: r2Profile.credentialRef })
        mocks.transport.mockRejectedValue(new Error('after-readiness transport sentinel'))
        await expect(executeMainQueueJob(job({ currentR2Delivery: true }), context(prepared).value))
            .rejects.toMatchObject({ kind: 'transient' })
        expect(mocks.r2Readiness.mock.invocationCallOrder[0]).toBeLessThan(mocks.transport.mock.invocationCallOrder[0])
        expect(mocks.transport).toHaveBeenCalledOnce()
        expect(mocks.r2Profile).not.toHaveBeenCalled()
    })

    it('resumes result-spooled storage with zero Provider calls', async () => {
        const current = context({
            dispatchState: 'result-spooled', providerOutcome: 'succeeded', billingRisk: 'confirmed',
            responseDigest: receipt.sha256, spoolReceipt: receipt,
        }, { activeCredentialsAreOpus: false, executionMode: 'storage-only' })
        await executeMainQueueJob(job(), current.value)
        expect(mocks.transport).toHaveBeenCalledTimes(0)
        expect(mocks.read).toHaveBeenCalledTimes(1)
        expect(mocks.write).toHaveBeenCalledTimes(1)
        expect(mocks.refreshAnlas).not.toHaveBeenCalled()
    })

    it('blocks a verify/read checksum race before OutputWriter receives changed bytes', async () => {
        const current = context({
            dispatchState: 'result-spooled', providerOutcome: 'succeeded', billingRisk: 'confirmed',
            responseDigest: receipt.sha256, spoolReceipt: receipt,
        })
        mocks.hash.mockResolvedValueOnce(`sha256:${'f'.repeat(64)}`)

        await expect(executeMainQueueJob(job(), current.value)).rejects.toThrow('changed after receipt verification')
        expect(mocks.transport).toHaveBeenCalledTimes(0)
        expect(mocks.write).toHaveBeenCalledTimes(0)
        expect(current.transitions[current.transitions.length - 1]).toMatchObject({
            evidence: { dispatchState: 'result-lost' }, blockReason: 'provider-result-lost',
        })
    })

    it('retries the same response bytes when the first spool commit fails', async () => {
        const current = context(prepared)
        mocks.transport.mockImplementation(async request => {
            await request.executionHooks.observer({ stage: 'possibly-dispatched' })
            await request.executionHooks.observer({ stage: 'response-started', status: 200, retryAfter: null })
            await request.executionHooks.observer({ stage: 'response-complete', status: 200, retryAfter: null })
            return { success: true, imageData: 'data:image/png;base64,AQID' }
        })
        mocks.commit.mockRejectedValueOnce(new Error('temporary spool failure')).mockResolvedValueOnce(receipt)
        await executeMainQueueJob(job(), current.value)
        expect(mocks.transport).toHaveBeenCalledTimes(1)
        expect(mocks.commit).toHaveBeenCalledTimes(2)
        expect(current.transitions[current.transitions.length - 1]?.evidence.dispatchState).toBe('result-spooled')
    })

    it('classifies a transport-proven pre-dispatch failure as safely retryable', async () => {
        const current = context(prepared)
        mocks.transport.mockRejectedValue(new Error('connection failed before dispatch'))

        await expect(executeMainQueueJob(job(), current.value)).rejects.toMatchObject({
            name: 'QueueExecutionError', kind: 'transient',
        } satisfies Partial<QueueExecutionError>)
        expect(current.transitions.at(-1)?.evidence).toMatchObject({
            dispatchState: 'connect-failed-before-dispatch',
            providerOutcome: 'known-failure',
            billingRisk: 'none',
        })
        expect(mocks.write).toHaveBeenCalledTimes(0)
    })

    it('atomically blocks an uncertain dispatched request without a second Provider call', async () => {
        const current = context(prepared)
        mocks.transport.mockImplementation(async request => {
            await request.executionHooks.observer({ stage: 'possibly-dispatched' })
            throw new Error('network lost after dispatch')
        })
        await expect(executeMainQueueJob(job(), current.value)).rejects.toThrow()
        expect(mocks.transport).toHaveBeenCalledTimes(1)
        expect(mocks.write).toHaveBeenCalledTimes(0)
        expect(current.transitions[current.transitions.length - 1]).toMatchObject({
            evidence: { dispatchState: 'possibly-dispatched', providerOutcome: 'unknown' },
            blockReason: 'provider-outcome-unknown',
        })
    })

    it('blocks a partial response as unknown without writing or retrying it', async () => {
        const current = context(prepared)
        mocks.transport.mockImplementation(async request => {
            await request.executionHooks.observer({ stage: 'possibly-dispatched' })
            await request.executionHooks.observer({ stage: 'response-started', status: 200, retryAfter: null })
            throw new Error('stream ended after the first chunk')
        })

        await expect(executeMainQueueJob(job(), current.value)).rejects.toThrow('first chunk')
        expect(mocks.transport).toHaveBeenCalledTimes(1)
        expect(mocks.write).toHaveBeenCalledTimes(0)
        expect(current.transitions.at(-1)).toMatchObject({
            evidence: { dispatchState: 'response-started', providerOutcome: 'unknown' },
            blockReason: 'provider-outcome-unknown',
        })
    })

    it('maps a valid seconds-based 429 Retry-After through the Main executor', async () => {
        const retryAfter = '12'
        const retryAfterMs = 12_000
        const current = context(prepared)
        mocks.transport.mockImplementation(async request => {
            await request.executionHooks.observer({ stage: 'possibly-dispatched' })
            await request.executionHooks.observer({ stage: 'response-started', status: 429, retryAfter })
            await request.executionHooks.observer({ stage: 'response-complete', status: 429, retryAfter })
            throw new NovelAIHttpError(429, 'rate limited', retryAfter)
        })

        await expect(executeMainQueueJob(job(), current.value)).rejects.toMatchObject({
            name: 'QueueExecutionError',
            kind: 'rate-limited',
            options: { retryAfterMs },
        } satisfies Partial<QueueExecutionError>)
        expect(mocks.transport).toHaveBeenCalledTimes(1)
        expect(mocks.write).toHaveBeenCalledTimes(0)
    })

    it('maps a valid HTTP-date 429 Retry-After through the Main executor', async () => {
        const current = context(prepared)
        const retryAfter = new Date(Date.now() + 12_000).toUTCString()
        mocks.transport.mockImplementation(async request => {
            await request.executionHooks.observer({ stage: 'possibly-dispatched' })
            await request.executionHooks.observer({ stage: 'response-started', status: 429, retryAfter })
            await request.executionHooks.observer({ stage: 'response-complete', status: 429, retryAfter })
            throw new NovelAIHttpError(429, 'rate limited', retryAfter)
        })

        const failure = await executeMainQueueJob(job(), current.value).catch(error => error)
        expect(failure).toMatchObject({
            name: 'QueueExecutionError', kind: 'rate-limited',
            options: { retryAfterMs: expect.any(Number) },
        } satisfies Partial<QueueExecutionError>)
        expect((failure as QueueExecutionError).options.retryAfterMs).toBeGreaterThan(0)
        expect(mocks.transport).toHaveBeenCalledTimes(1)
        expect(mocks.write).toHaveBeenCalledTimes(0)
    })

    it('fails closed for an invalid 429 Retry-After instead of creating a generic retry', async () => {
        const current = context(prepared)
        const retryAfter = 'not-a-retry-delay'
        mocks.transport.mockImplementation(async request => {
            await request.executionHooks.observer({ stage: 'possibly-dispatched' })
            await request.executionHooks.observer({ stage: 'response-started', status: 429, retryAfter })
            await request.executionHooks.observer({ stage: 'response-complete', status: 429, retryAfter })
            throw new NovelAIHttpError(429, 'rate limited', retryAfter)
        })

        await expect(executeMainQueueJob(job(), current.value)).rejects.toMatchObject({
            name: 'QueueExecutionError', kind: 'fatal',
        })
        expect(mocks.transport).toHaveBeenCalledTimes(1)
        expect(mocks.write).toHaveBeenCalledTimes(0)
    })

    it.each([
        '',
        ' ',
        '1.5',
        '+1',
        '999999999999999999999999999999999999',
        'Wed, 02 Sep 2026 08:00:00 GMT',
        'Wednesday, 03-Sep-36 08:00:12 GMT',
        'Thu, 3 Sep 2036 08:00:12 GMT',
    ])('rejects a non-strict 429 Retry-After value (%j)', async retryAfter => {
        const current = context(prepared)
        mocks.transport.mockImplementation(async request => {
            await request.executionHooks.observer({ stage: 'possibly-dispatched' })
            await request.executionHooks.observer({ stage: 'response-started', status: 429, retryAfter })
            await request.executionHooks.observer({ stage: 'response-complete', status: 429, retryAfter })
            throw new NovelAIHttpError(429, 'rate limited', retryAfter)
        })

        await expect(executeMainQueueJob(job(), current.value)).rejects.toMatchObject({
            name: 'QueueExecutionError', kind: 'fatal',
        } satisfies Partial<QueueExecutionError>)
        expect(mocks.transport).toHaveBeenCalledTimes(1)
        expect(mocks.write).toHaveBeenCalledTimes(0)
    })

    it('marks a 2xx EOF after response-complete as result-lost without writing output', async () => {
        const current = context(prepared)
        mocks.transport.mockImplementation(async request => {
            await request.executionHooks.observer({ stage: 'possibly-dispatched' })
            await request.executionHooks.observer({ stage: 'response-started', status: 200, retryAfter: null })
            await request.executionHooks.observer({ stage: 'response-complete', status: 200, retryAfter: null })
            throw new Error('unexpected EOF after complete response')
        })

        await expect(executeMainQueueJob(job(), current.value)).rejects.toThrow('unexpected EOF')
        expect(mocks.transport).toHaveBeenCalledTimes(1)
        expect(mocks.write).toHaveBeenCalledTimes(0)
        expect(current.transitions[current.transitions.length - 1]).toMatchObject({
            evidence: {
                dispatchState: 'result-lost', providerOutcome: 'succeeded',
                billingRisk: 'confirmed', responseDigest: null, spoolReceipt: null,
            },
            blockReason: 'provider-result-lost',
        })
    })

    it.each([
        ['payload builder revision', { payloadBuilderRevision: 'stale-builder' }],
        ['model catalog revision', { modelCatalogRevision: 'stale-catalog' }],
        ['compatibility profile', { compatibilityProfileId: 'stale-profile' }],
        ['action', { action: 'img2img' as const }],
        ['response mode', { responseMode: 'streaming' as const }],
        ['semantic intent hash', { semanticIntentHash: `sha256:${'c'.repeat(64)}` }],
        ['resource bindings', {
            queueResourceBindings: [{
                resourceId: 'resource:unexpected', role: 'source' as const,
                digest: `sha256:${'e'.repeat(64)}` as const,
            }],
        }],
    ])('does not call Provider when the reviewed envelope has a mismatched %s', async (_label, envelope) => {
        const candidate = job({ envelope })
        const current = context(prepared, {
            executionEnvelopeHash: `sha256:${hashCanonicalValue(candidate.snapshot.providerExecutionEnvelope)}`,
        })

        await expect(executeMainQueueJob(candidate, current.value)).rejects.toMatchObject({
            name: 'QueueExecutionError', kind: 'compatibility',
        } satisfies Partial<QueueExecutionError>)
        expect(mocks.transport).toHaveBeenCalledTimes(0)
        expect(mocks.write).toHaveBeenCalledTimes(0)
    })

    it('does not call Provider when the attempt envelope hash no longer matches', async () => {
        const current = context(prepared, { executionEnvelopeHash: `sha256:${'d'.repeat(64)}` })

        await expect(executeMainQueueJob(job(), current.value)).rejects.toMatchObject({
            name: 'QueueExecutionError', kind: 'compatibility',
        } satisfies Partial<QueueExecutionError>)
        expect(mocks.transport).toHaveBeenCalledTimes(0)
        expect(mocks.write).toHaveBeenCalledTimes(0)
    })

    it('does not call Provider when the exact reservation preflight fails', async () => {
        const current = context(prepared)
        mocks.preflight.mockRejectedValueOnce(new Error('directory probe failed'))

        await expect(executeMainQueueJob(job({ withReservation: true }), current.value)).rejects.toMatchObject({
            name: 'QueueExecutionError', kind: 'local-io',
        } satisfies Partial<QueueExecutionError>)
        expect(mocks.transport).toHaveBeenCalledTimes(0)
        expect(mocks.commit).toHaveBeenCalledTimes(0)
        expect(mocks.write).toHaveBeenCalledTimes(0)
    })

    it('does not call Provider when credential pricing no longer matches consent', async () => {
        const current = context(prepared, { activeCredentialsAreOpus: false })

        await expect(executeMainQueueJob(job({ withReservation: true }), current.value)).rejects.toMatchObject({
            name: 'QueueExecutionError', kind: 'fatal',
        } satisfies Partial<QueueExecutionError>)
        expect(mocks.preflight).toHaveBeenCalledTimes(0)
        expect(mocks.transport).toHaveBeenCalledTimes(0)
        expect(mocks.write).toHaveBeenCalledTimes(0)
    })

    it('requeues and pauses an already-spooled result when its execution envelope no longer matches', async () => {
        const current = context({
            dispatchState: 'result-spooled', providerOutcome: 'succeeded', billingRisk: 'confirmed',
            responseDigest: receipt.sha256, spoolReceipt: receipt,
        }, { executionEnvelopeHash: `sha256:${'d'.repeat(64)}` })

        await expect(executeMainQueueJob(job(), current.value)).rejects.toMatchObject({
            name: 'QueueExecutionError', kind: 'compatibility',
        } satisfies Partial<QueueExecutionError>)
        expect(current.value.requeueSpooledResult).toHaveBeenCalledWith({
            diagnosticEventId: 'diagnostic:test', pauseReason: 'compatibility',
        })
        expect(mocks.transport).toHaveBeenCalledTimes(0)
        expect(mocks.write).toHaveBeenCalledTimes(0)
    })

    it('requeues OutputWriter storage from the spool and resumes with zero additional Provider calls', async () => {
        const current = context(prepared)
        mocks.transport.mockImplementation(async request => {
            await request.executionHooks.observer({ stage: 'possibly-dispatched' })
            await request.executionHooks.observer({ stage: 'response-started', status: 200, retryAfter: null })
            await request.executionHooks.observer({ stage: 'response-complete', status: 200, retryAfter: null })
            return { success: true, imageData: 'data:image/png;base64,AQID' }
        })
        mocks.write
            .mockRejectedValueOnce(new Error('OutputWriter storage unavailable'))
            .mockImplementationOnce(async request => {
                await request.commitWorkflow({ path: 'output/image.png' })
                return { status: 'committed', result: { path: 'output/image.png' } }
            })

        await expect(executeMainQueueJob(job(), current.value)).rejects.toThrow('OutputWriter storage unavailable')
        expect(current.value.requeueSpooledResult).toHaveBeenCalledTimes(1)
        expect(current.transitions.at(-1)?.evidence.dispatchState).toBe('result-spooled')

        await executeMainQueueJob(job(), current.value)
        expect(mocks.transport).toHaveBeenCalledTimes(1)
        expect(mocks.read).toHaveBeenCalledTimes(2)
        expect(mocks.write).toHaveBeenCalledTimes(2)
    })

    it('marks only an exact late destination collision as conflict', async () => {
        const current = context(prepared)
        mocks.transport.mockImplementation(async request => {
            await request.executionHooks.observer({ stage: 'possibly-dispatched' })
            await request.executionHooks.observer({ stage: 'response-started', status: 200, retryAfter: null })
            await request.executionHooks.observer({ stage: 'response-complete', status: 200, retryAfter: null })
            return { success: true, imageData: 'data:image/png;base64,AQID' }
        })
        mocks.write.mockRejectedValueOnce(new OutputWriterError(
            'atomic-commit',
            'Output destination changed before commit: output/image.png',
        ))

        await expect(executeMainQueueJob(job({ withReservation: true }), current.value)).rejects.toMatchObject({
            name: 'QueueExecutionError', kind: 'fatal',
        } satisfies Partial<QueueExecutionError>)
        expect(current.value.transitionOutputReservation).toHaveBeenLastCalledWith(expect.objectContaining({
            state: 'conflict',
        }))
        expect(current.value.requeueSpooledResult).not.toHaveBeenCalled()
    })

    it('keeps a non-collision atomic write failure retryable from the spool', async () => {
        const current = context(prepared)
        mocks.transport.mockImplementation(async request => {
            await request.executionHooks.observer({ stage: 'possibly-dispatched' })
            await request.executionHooks.observer({ stage: 'response-started', status: 200, retryAfter: null })
            await request.executionHooks.observer({ stage: 'response-complete', status: 200, retryAfter: null })
            return { success: true, imageData: 'data:image/png;base64,AQID' }
        })
        mocks.write.mockRejectedValueOnce(new OutputWriterError(
            'atomic-commit',
            'Output transaction failed during atomic-commit',
        ))

        await expect(executeMainQueueJob(job({ withReservation: true }), current.value))
            .rejects.toThrow('Output transaction failed during atomic-commit')
        expect(current.value.requeueSpooledResult).toHaveBeenCalledWith({
            diagnosticEventId: 'diagnostic:test', pauseReason: 'local-io',
        })
        expect(current.value.transitionOutputReservation).not.toHaveBeenCalledWith(expect.objectContaining({
            state: 'conflict',
        }))
    })
})
