import { canonicalSerialize, hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import { providerResultSpoolId } from '@/domain/queue/provider-result'
import type { GenerationSnapshotResource } from '@/domain/queue/types'
import type {
    ProviderAttemptEvidence,
    ProviderExecutionEnvelope,
    ProviderSha256,
    SpoolReceipt,
} from '@/domain/queue/provider-result'
import { ProviderResultSpoolError, type ProviderResultSpool } from '@/application/generation/provider-result-spool'
import type { GenerationParams } from '@/services/novelai-types'
import { NovelAiModelCapabilityError } from '@/services/nai/adapter'
import { NovelAIHttpError as NovelAIHttpErrorClass } from '@/services/novelai-types'
import type { NaiProviderObservation, NaiProviderFaultInjector } from '@/services/nai/transport'
import { executeNovelAIImageTransport } from '@/services/generation/novelai-image-transport'
import type { QueueExecutorContext } from './durable-queue-coordinator'
import { QueueExecutionError } from './durable-queue-coordinator'
import { hashQueueResourceBytes } from './queue-resource-materializer'

export interface SpooledProviderResult {
    readonly receipt: SpoolReceipt
    readonly sentPayloadSummary?: string
    readonly encodedVibes?: string[]
}

export interface ProviderEnvelopeExecutionFacts {
    readonly payloadBuilderRevision: string
    readonly modelCatalogRevision: string
    readonly compatibilityProfileId: string
    readonly action: ProviderExecutionEnvelope['action']
    readonly responseMode: ProviderExecutionEnvelope['responseMode']
    readonly semanticIntentHash: ProviderSha256
    readonly queueResourceBindings: readonly ProviderExecutionEnvelope['queueResourceBindings'][number][]
}

type ProviderResourceRole = ProviderEnvelopeExecutionFacts['queueResourceBindings'][number]['role']

/** Provider resources are the immutable inputs whose digests must match review. */
export function providerResourceBindings(
    resources: readonly GenerationSnapshotResource[],
): ProviderEnvelopeExecutionFacts['queueResourceBindings'] {
    const providerRoles = new Set(['source', 'mask', 'vibe-reference', 'character-reference'])
    return resources
        .filter(resource => providerRoles.has(resource.role))
        .map(resource => ({
            resourceId: resource.resourceId,
            role: resource.role as ProviderResourceRole,
            digest: resource.digest as ProviderSha256,
        }))
}

/** Rebuilds current Provider meaning and fails before dispatch when review-time facts drift. */
export function assertProviderEnvelopeMatchesExecution(
    envelope: ProviderExecutionEnvelope | undefined,
    context: QueueExecutorContext,
    facts: ProviderEnvelopeExecutionFacts,
): void {
    if (envelope === undefined) return
    const envelopeHash = `sha256:${hashCanonicalValue(envelope)}`
    if (envelope.payloadBuilderRevision !== facts.payloadBuilderRevision
        || envelope.modelCatalogRevision !== facts.modelCatalogRevision
        || envelope.compatibilityProfileId !== facts.compatibilityProfileId
        || envelope.action !== facts.action
        || envelope.responseMode !== facts.responseMode
        || envelope.semanticIntentHash !== facts.semanticIntentHash
        || context.providerAttempt.executionEnvelopeHash !== envelopeHash
        || canonicalSerialize(envelope.queueResourceBindings) !== canonicalSerialize(facts.queueResourceBindings)) {
        throw new QueueExecutionError('compatibility', 'Reviewed Provider execution envelope no longer matches execution')
    }
}

/** Accepts only exact Provider delay evidence that can safely authorize a 429 retry. */
function retryAfterMilliseconds(value: string | null, now: number): number | undefined {
    if (value === null) return undefined
    if (/^(?:0|[1-9][0-9]*)$/.test(value)) {
        const seconds = Number(value)
        const milliseconds = seconds * 1_000
        const target = now + milliseconds
        return Number.isSafeInteger(seconds)
            && Number.isSafeInteger(milliseconds)
            && Number.isFinite(new Date(target).getTime())
            ? milliseconds
            : undefined
    }
    if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/.test(value)) {
        return undefined
    }
    const date = Date.parse(value)
    return Number.isFinite(date)
        && new Date(date).toUTCString() === value
        && date > now
        && Number.isSafeInteger(date - now)
        ? date - now
        : undefined
}

/** Persists each Provider boundary before transport advances, then spools bytes. */
export async function dispatchAndSpool(
    context: QueueExecutorContext,
    params: GenerationParams,
    imageFormat: NonNullable<GenerationParams['imageFormat']>,
    streaming: boolean,
    spool: ProviderResultSpool,
    faultInjector: NaiProviderFaultInjector | undefined,
    onProgress: (progress: number, previewImage?: string) => void,
): Promise<SpooledProviderResult> {
    let evidence = context.providerAttempt.providerEvidence
    if (evidence === null) throw new QueueExecutionError('fatal', 'Provider-safe execution requires attempt evidence')
    const advance = async (next: ProviderAttemptEvidence): Promise<void> => {
        evidence = (await context.recordProviderTransition(next)).providerEvidence
        if (evidence === null) throw new QueueExecutionError('fatal', 'Provider evidence disappeared during execution')
    }
    const observe = async (observation: NaiProviderObservation): Promise<void> => {
        if (observation.stage === 'possibly-dispatched' && evidence?.dispatchState === 'prepared') {
            await advance({ ...evidence, dispatchState: 'possibly-dispatched', billingRisk: 'possible' })
        } else if (observation.stage === 'response-started'
            && evidence?.dispatchState === 'possibly-dispatched') {
            await advance({ ...evidence, dispatchState: 'response-started' })
        } else if (observation.stage === 'response-complete'
            && evidence?.dispatchState === 'response-started') {
            const succeeded = observation.status >= 200 && observation.status < 300
            await advance({
                ...evidence,
                dispatchState: 'response-complete',
                providerOutcome: succeeded ? 'succeeded' : 'known-failure',
                billingRisk: succeeded ? 'confirmed' : 'possible',
            })
        }
    }

    let result
    try {
        result = await executeNovelAIImageTransport({
            token: context.token,
            params,
            imageFormat,
            streaming,
            signal: context.signal,
            onProgress,
            faultInjector,
            executionHooks: { observer: observe, errorMode: 'throw' },
        })
    } catch (error) {
        if (error instanceof NovelAIHttpErrorClass && evidence.dispatchState === 'response-complete') {
            if (error.status === 401) throw new QueueExecutionError('authentication', 'Provider authentication failed')
            const retryAfterMs = error.status === 429
                ? retryAfterMilliseconds(error.retryAfter, Date.now())
                : undefined
            if (error.status === 429 && retryAfterMs !== undefined) {
                throw new QueueExecutionError('rate-limited', 'Provider rate limit reached', { retryAfterMs })
            }
            throw new QueueExecutionError('fatal', `Provider HTTP ${error.status} is not automatically retryable`)
        }
        if (evidence.dispatchState === 'response-complete' && evidence.providerOutcome === 'succeeded') {
            await context.recordProviderTransition(
                { ...evidence, dispatchState: 'result-lost' },
                { blockReason: 'provider-result-lost' },
            )
            throw error
        }
        if (evidence.dispatchState === 'prepared') {
            await advance({ ...evidence, dispatchState: 'connect-failed-before-dispatch', providerOutcome: 'known-failure' })
            // A deterministic local settings error cannot become a network retry.
            if (error instanceof NovelAiModelCapabilityError) throw new QueueExecutionError('fatal', error.message)
            throw new QueueExecutionError('transient', 'Provider connection failed before dispatch')
        }
        if (evidence.dispatchState === 'possibly-dispatched' || evidence.dispatchState === 'response-started') {
            await context.recordProviderTransition(
                { ...evidence, providerOutcome: 'unknown' },
                { blockReason: 'provider-outcome-unknown' },
            )
        }
        throw error
    }
    if (!result.success || !result.imageData) {
        if (evidence.dispatchState === 'response-complete' && evidence.providerOutcome === 'succeeded') {
            await context.recordProviderTransition(
                { ...evidence, dispatchState: 'result-lost' },
                { blockReason: 'provider-result-lost' },
            )
        }
        throw new QueueExecutionError('decode', 'Provider generation returned no decodable image')
    }
    let bytes: Uint8Array
    let digest: string
    try {
        const encoded = result.imageData.replace(/^data:image\/[^;]+;base64,/, '')
        const binary = atob(encoded)
        bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
        digest = await hashQueueResourceBytes(bytes)
    } catch (error) {
        if (evidence.dispatchState === 'response-complete' && evidence.providerOutcome === 'succeeded') {
            await context.recordProviderTransition(
                { ...evidence, dispatchState: 'result-lost' },
                { blockReason: 'provider-result-lost' },
            )
        }
        throw error
    }
    if (evidence.dispatchState !== 'response-complete' || evidence.providerOutcome !== 'succeeded') {
        throw new QueueExecutionError('fatal', 'Provider response completed without durable EOF evidence')
    }
    const attemptId = context.providerAttempt.id
    const commitInput = {
        spoolId: providerResultSpoolId(attemptId),
        attemptId,
        contentType: `image/${imageFormat}`,
        bytes,
        committedAt: new Date().toISOString(),
    }
    let receipt: SpoolReceipt | null = null
    let failures = 0
    let injected = false
    while (receipt === null) {
        try {
            receipt = await spool.commit(commitInput)
            if (!injected && faultInjector !== undefined) {
                injected = true
                await faultInjector('after-spool-commit')
            }
        } catch (error) {
            failures += 1
            receipt = null
            if (failures >= 3 || context.signal.aborted) {
                await context.recordProviderTransition(
                    { ...evidence, dispatchState: 'result-lost' },
                    { blockReason: 'provider-result-lost' },
                )
                throw error
            }
            await new Promise(resolve => setTimeout(resolve, failures * 25))
        }
    }
    await advance({
        ...evidence,
        dispatchState: 'result-spooled',
        responseDigest: digest as ProviderSha256,
        spoolReceipt: receipt,
    })
    return { receipt, sentPayloadSummary: result.sentPayloadSummary, encodedVibes: result.encodedVibes }
}

/** Revalidates the durable receipt and bytes immediately before OutputWriter. */
export async function writeSpooled(
    spool: ProviderResultSpool,
    receipt: SpoolReceipt,
): Promise<Uint8Array> {
    const verified = await spool.verify(receipt.spoolId)
    if (verified.attemptId !== receipt.attemptId || verified.sha256 !== receipt.sha256) {
        throw new ProviderResultSpoolError('conflict', 'Provider spool receipt changed before storage')
    }
    const bytes = await spool.read(receipt.spoolId)
    if (await hashQueueResourceBytes(bytes) !== receipt.sha256) {
        throw new ProviderResultSpoolError('checksum-mismatch', 'Provider spool bytes changed after receipt verification')
    }
    return bytes
}
