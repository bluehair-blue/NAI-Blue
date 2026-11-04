import { getNovelAiModelProfile, isNovelAiMediumModel } from './model-catalog'
import type { GenerationParams } from '../novelai-types'

export const CURRENT_NAI_PAYLOAD_BUILDER_REVISION = 'nai-blue-payload-v1' as const
export const LEGACY_NAI_PAYLOAD_BUILDER_REVISION = 'legacy-v1' as const

export type NaiCompatibilityStatus =
    | 'captured-pass'
    | 'live-canary-pass'
    | 'synthetic-only'
    | 'known-divergence'
    | 'unsupported'

export type NaiCompatibilityFixtureProvenance =
    | 'local-characterization'
    | 'synthetic-only'
    | 'redacted-web-capture'
    | 'live-canary'

export type NaiGenerationAction = 'generate' | 'img2img' | 'infill'
export type NaiCompatibilityFeature =
    | 'streaming'
    | 'character-prompts'
    | 'precise-reference'
    | 'vibe-transfer'
    | 'transparent-background'
    | 'enhance-max'

export interface NaiCompatibilityQuery {
    readonly model: string
    readonly action: NaiGenerationAction
    readonly features: readonly NaiCompatibilityFeature[]
    readonly payloadBuilderRevision: string
}

export interface NaiCompatibilityProfile {
    readonly compatibilityProfileId: string
    readonly status: NaiCompatibilityStatus
    readonly model: string
    readonly action: NaiGenerationAction
    readonly features: readonly NaiCompatibilityFeature[]
    readonly payloadBuilderRevision: string
    readonly fixture: {
        readonly path: string
        readonly provenance: NaiCompatibilityFixtureProvenance
        readonly sha256: `sha256:${string}`
    } | null
    readonly warnings: readonly ('W_NAI_COMPATIBILITY_SYNTHETIC_ONLY')[]
}

const SYNTHETIC_FIXTURE = Object.freeze({
    path: 'tests/fixtures/payload/supported-online-matrix.json',
    provenance: 'synthetic-only',
    sha256: 'sha256:eb263442cae34dd96c011af6830b7c9a0bd9b2dc974c08bf6cea2b86ae6710dd',
} as const)

const MEDIUM_SYNTHETIC_FIXTURE = Object.freeze({
    path: 'tests/fixtures/payload/v5-medium.json',
    provenance: 'synthetic-only',
    sha256: 'sha256:7004eab537b8c36152464f4640b37287c273ce268bcaf8ead4f5adba78eab2e0',
} as const)

/**
 * The registry binds replayable payload semantics to an audited fixture. Both
 * revisions remain synthetic-only because neither fixture is a redacted Web
 * capture or live canary; changing wire meaning requires a new revision entry.
 */
export const NAI_COMPATIBILITY_REGISTRY = Object.freeze({
    [LEGACY_NAI_PAYLOAD_BUILDER_REVISION]: SYNTHETIC_FIXTURE,
    [CURRENT_NAI_PAYLOAD_BUILDER_REVISION]: SYNTHETIC_FIXTURE,
})

export function isSupportedNaiPayloadBuilderRevision(value: string): boolean {
    return Object.prototype.hasOwnProperty.call(NAI_COMPATIBILITY_REGISTRY, value)
}

function knownDivergence(query: NaiCompatibilityQuery): boolean {
    const profile = getNovelAiModelProfile(query.model)
    if (profile === undefined) return false
    const capabilities = profile.capabilities
    if (query.action === 'img2img' && !capabilities.imageToImage) return true
    if (query.action === 'infill' && !capabilities.inpainting) return true
    return query.features.some(feature => {
        switch (feature) {
            case 'character-prompts': return !capabilities.characterPrompts
            case 'precise-reference': return !capabilities.preciseReference
            case 'vibe-transfer': return !capabilities.vibeTransfer
            case 'transparent-background': return !capabilities.transparentBackground
            case 'enhance-max': return !capabilities.enhanceMax
            case 'streaming': return false
        }
    })
}

/**
 * This query is the single pre-dispatch compatibility decision. It reuses the
 * model catalog, keeps unsupported revisions fail-closed, and never upgrades a
 * local synthetic fixture into captured or live evidence.
 */
export function queryNaiCompatibility(query: NaiCompatibilityQuery): NaiCompatibilityProfile {
    const features = Object.freeze([...new Set(query.features)].sort()) as readonly NaiCompatibilityFeature[]
    const normalized = { ...query, features }
    const supportedRevision = isSupportedNaiPayloadBuilderRevision(query.payloadBuilderRevision)
    const supportedModel = getNovelAiModelProfile(query.model) !== undefined
    const status: NaiCompatibilityStatus = !supportedRevision || !supportedModel
        ? 'unsupported'
        : knownDivergence(normalized)
            ? 'known-divergence'
            : 'synthetic-only'
    const featureKey = features.length === 0 ? 'base' : features.join('+')
    return Object.freeze({
        compatibilityProfileId: [
            'nai', query.payloadBuilderRevision, query.model, query.action, featureKey,
        ].join(':'),
        status,
        model: query.model,
        action: query.action,
        features,
        payloadBuilderRevision: query.payloadBuilderRevision,
        fixture: supportedRevision && supportedModel
            ? isNovelAiMediumModel(query.model) ? MEDIUM_SYNTHETIC_FIXTURE : SYNTHETIC_FIXTURE
            : null,
        warnings: status === 'synthetic-only'
            ? Object.freeze(['W_NAI_COMPATIBILITY_SYNTHETIC_ONLY'] as const)
            : Object.freeze([]),
    })
}

/** Derives only semantic feature flags; credentials and resource bytes stay out. */
export function queryNaiGenerationCompatibility(
    params: GenerationParams,
    payloadBuilderRevision: string,
    streaming: boolean,
): NaiCompatibilityProfile {
    const action: NaiGenerationAction = params.mask
        ? 'infill'
        : params.sourceImage
            ? 'img2img'
            : 'generate'
    const features: NaiCompatibilityFeature[] = []
    if (streaming) features.push('streaming')
    if ((params.characterPrompts?.some(character => character.enabled && character.prompt.trim()) ?? false)) {
        features.push('character-prompts')
    }
    if ((params.charImages?.length ?? 0) > 0) features.push('precise-reference')
    if ((params.vibeImages?.length ?? 0) > 0) features.push('vibe-transfer')
    if (params.transparentBackground === true) features.push('transparent-background')
    if (params.upscaledEnhance === true) features.push('enhance-max')
    return queryNaiCompatibility({ model: params.model, action, features, payloadBuilderRevision })
}
