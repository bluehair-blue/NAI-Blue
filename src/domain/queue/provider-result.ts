import { sha256Utf8 } from '@/domain/composition/canonical-serialize'

/** One stable identity binds a retained response to the exact Queue attempt. */
export function providerResultSpoolId(attemptId: string): string {
    return `provider-${sha256Utf8(attemptId).slice(0, 48)}`
}

export type ProviderDispatchState = 'prepared'
    | 'connect-failed-before-dispatch'
    | 'possibly-dispatched'
    | 'response-started'
    | 'response-complete'
    | 'result-spooled'
    | 'result-lost'

export type ProviderOutcome = 'running' | 'known-failure' | 'succeeded' | 'unknown'
export type ProviderBillingRisk = 'none' | 'possible' | 'confirmed'
export type ProviderSha256 = `sha256:${string}`

export interface SpoolReceipt {
    readonly schemaVersion: 1
    readonly spoolId: string
    readonly attemptId: string
    readonly contentType: string
    readonly byteLength: number
    readonly sha256: ProviderSha256
    readonly committedAt: string
}

export interface ProviderAttemptEvidence {
    readonly dispatchState: ProviderDispatchState
    readonly providerOutcome: ProviderOutcome
    readonly billingRisk: ProviderBillingRisk
    readonly responseDigest: ProviderSha256 | null
    readonly spoolReceipt: SpoolReceipt | null
}

export interface ProviderAttemptTransition {
    readonly attemptId: string
    readonly jobId: string
    readonly attemptNumber: number
    readonly occurredAt: string
    readonly from: ProviderAttemptEvidence
    readonly to: ProviderAttemptEvidence
    readonly diagnosticEventId: string | null
}

export interface ProviderExecutionEnvelope {
    readonly schemaVersion: 1
    readonly provider: 'novelai'
    readonly compatibilityProfileId: string
    readonly payloadBuilderRevision: string
    readonly modelCatalogRevision: string
    readonly action: 'generate' | 'img2img' | 'infill'
    readonly responseMode: 'standard' | 'streaming'
    readonly semanticIntentHash: ProviderSha256
    readonly queueResourceBindings: readonly {
        readonly resourceId: string
        readonly role: 'source' | 'mask' | 'vibe-reference' | 'character-reference'
        readonly digest: ProviderSha256
    }[]
}
