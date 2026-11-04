import type { AssetModulePlan } from '@/lib/asset-modules/resolver'
import type { MetadataMode } from '@/domain/composition/types'
import type { CompositionPlanHash } from '@/domain/composition/canonical-serialize'
import type { PortablePathRef, RandomTraceEntry } from '@/domain/composition/types'
import type { NaiBlueOutputPolicySummary } from '@/lib/nai-blue-metadata'

export class NovelAIHttpError extends Error {
    readonly status: number
    readonly responseBody: string
    readonly retryable: boolean
    readonly retryAfter: string | null

    constructor(status: number, responseBody: string, retryAfter: string | null = null) {
        // The raw provider body stays available only for the diagnostic
        // redactor. Error.message is safe for existing retry/UI callers.
        super(`NovelAI request failed (${status})`)
        this.name = 'NovelAIHttpError'
        this.status = status
        this.responseBody = responseBody
        this.retryable = status === 429 || (status >= 500 && status < 600)
        this.retryAfter = retryAfter
    }
}

export interface AnlasInfo {
    fixed: number
    purchased: number
    total: number
}

/** Runtime subscription allowance for NovelAI Diffusion V5 on Opus. */
export interface OpusGenerationUsage {
    percent: number
    isNegative: boolean
    timeUntilNextPercent: number
    /** Purchased Extra Usage is separate from the regular recharging allowance. */
    purchasedPercent?: number
}

export interface NovelAIUserInfo {
    anlas: AnlasInfo
    /** Absent for older provider responses and subscriptions without this allowance. */
    usage?: OpusGenerationUsage
}

export interface GenerationParams {
    promptTextMode?: 'verbatim'
    prompt: string
    negative_prompt: string
    model: string
    width: number
    height: number
    steps: number
    cfg_scale: number
    cfg_rescale: number
    sampler: string
    scheduler: string
    smea: boolean
    smea_dyn: boolean
    variety: boolean
    seed: number
    charImages?: string[]
    charStrength?: number[]
    charFidelity?: number[]
    charReferenceType?: ('character' | 'style' | 'character&style' | 'costume' | 'delta')[]
    charCacheKeys?: (string | null)[]
    charInfo?: number[]
    vibeImages?: string[]
    vibeInfo?: number[]
    vibeStrength?: number[]
    preEncodedVibes?: (string | null)[]
    characterPrompts?: {
        /** Stable composition character ID when the v2 resolver supplied one. */
        stableId?: string
        prompt: string
        negative: string
        enabled: boolean
        position: { x: number, y: number }
    }[]
    characterPositionEnabled?: boolean
    sourceImage?: string
    strength?: number
    noise?: number
    /** Provider-side Enhance MAX uses img2img with the original source and an upscaled_enhance flag. */
    upscaledEnhance?: boolean
    mask?: string
    imageFormat?: 'png' | 'webp'
    metadataMode?: MetadataMode
    assetModulePlan?: AssetModulePlan
    compositionMode?: 'legacy' | 'shadow' | 'v2'
    compositionPlanHash?: CompositionPlanHash
    compositionPlanId?: string
    compositionRecipeId?: string
    compositionProvenanceSummary?: {
        sourceCount: number
        promptContributionCount: number
        randomSelectionCount: number
    }
    /** Serializable resolver trace only; resource bytes and cache keys never belong here. */
    compositionRandomTrace?: RandomTraceEntry[]
    /** Metadata provenance fields; optional for legacy adapters. */
    engineVersion?: string
    sourceRevision?: number | null
    /** Durable queue provenance. Never sent as a provider request field. */
    sourceJobId?: string
    /** Closed, credential-free summary. Never pass an OutputPolicy object here. */
    outputPolicySummary?: NaiBlueOutputPolicySummary
    /** Local platform materialization hint; the NAI request adapter never serializes it. */
    portableOutputDirectory?: PortablePathRef
    qualityToggle?: boolean
    ucPreset?: number
    /** V5 alpha-background request; false/undefined preserves opaque generation. */
    transparentBackground?: boolean
    sentPayloadSummary?: string
    promptParts?: {
        base?: string
        additional?: string
        detail?: string
        negative?: string
        inpainting?: string
        workflow?: string
    }
}

export interface GenerateImageResult {
    success: boolean
    imageData?: string
    error?: string
    encodedVibes?: string[]
    /** SHA-256 of the redacted transport payload; never the payload itself. */
    sentPayloadSummary?: string
    /** Finite transport termination reason for cancellation and hard timeout. */
    termination?: 'cancelled' | 'timeout'
}
