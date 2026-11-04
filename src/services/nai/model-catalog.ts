import { DEFAULT_NAI_IMAGE_MODEL } from '@/domain/generation/model-default'

export { DEFAULT_NAI_IMAGE_MODEL } from '@/domain/generation/model-default'

/** Immutable revision of the model IDs and capability semantics below. */
export const CURRENT_NAI_MODEL_CATALOG_REVISION = 'nai-blue-model-catalog-v2' as const

export interface NaiImageModelCapabilities {
    readonly imageToImage: boolean
    readonly inpainting: boolean
    readonly characterPrompts: boolean
    readonly animeFurryMode: boolean
    readonly transparentBackground: boolean
    readonly vibeTransfer: boolean
    readonly preciseReference: boolean
    readonly enhanceMax: boolean
    readonly maxCharacters?: number
}

export interface NaiSelectableImageModel {
    readonly id: string
    readonly inpaintId: string
    readonly name: string
    readonly description: string
    readonly recommended: boolean
    readonly deprecated: boolean
    readonly capabilities: NaiImageModelCapabilities
}

export interface NovelAiModelProfile {
    readonly modelId: string
    readonly inpaintModelId: string
    readonly capabilities: NaiImageModelCapabilities
}

const V5_CAPABILITIES: NaiImageModelCapabilities = {
    imageToImage: true,
    inpainting: true,
    characterPrompts: true,
    animeFurryMode: true,
    transparentBackground: true,
    vibeTransfer: false,
    preciseReference: false,
    enhanceMax: true,
    // Oct 14 production frontend exposes 32; the public guide still says 22.
    maxCharacters: 32,
}

const LEGACY_CAPABILITIES: NaiImageModelCapabilities = {
    imageToImage: true,
    inpainting: true,
    characterPrompts: true,
    animeFurryMode: false,
    transparentBackground: false,
    vibeTransfer: true,
    preciseReference: true,
    enhanceMax: true,
}

const legacy = (
    id: string,
    inpaintId: string,
    name: string,
    description: string,
): NaiSelectableImageModel => ({
    id,
    inpaintId,
    name,
    description,
    recommended: false,
    deprecated: true,
    capabilities: LEGACY_CAPABILITIES,
})

export const NAI_IMAGE_MODELS = [
    {
        id: 'nai-diffusion-5-full',
        inpaintId: 'nai-diffusion-5-full-inpainting',
        name: 'NAI Diffusion V5 Full',
        description: 'V5 Full은 표현 범위와 자연어 이해가 가장 넓은 기본 추천 모델이에요.',
        recommended: true,
        deprecated: false,
        capabilities: V5_CAPABILITIES,
    },
    {
        id: 'nai-diffusion-5-curated',
        inpaintId: 'nai-diffusion-5-curated-inpainting',
        name: 'NAI Diffusion V5 Curated',
        description: 'V5 Curated는 엄선된 범위 안에서 안정적인 결과와 스트리밍 작업에 잘 맞아요.',
        recommended: false,
        deprecated: false,
        capabilities: V5_CAPABILITIES,
    },
    {
        id: 'nai-diffusion-5-full-medium',
        inpaintId: 'nai-diffusion-5-full-medium-inpainting',
        name: 'NAI Diffusion V5 Full Medium',
        description: '절약 모드: 14 Steps, Euler Ancestral, CFG Rescale 0, Heavy UC를 사용하며 커스텀 네거티브는 지원하지 않아요.',
        recommended: false,
        deprecated: false,
        capabilities: V5_CAPABILITIES,
    },
    legacy(
        'nai-diffusion-4-5-full',
        'nai-diffusion-4-5-full-inpainting',
        'NAI Diffusion V4.5 Full',
        'V4.5 Full은 기존 워크플로우 호환이 필요할 때 선택하세요.',
    ),
    legacy(
        'nai-diffusion-4-5-curated',
        'nai-diffusion-4-5-curated-inpainting',
        'NAI Diffusion V4.5 Curated',
        'V4.5 Curated는 기존 큐레이티드 결과를 재현해야 할 때 적합해요.',
    ),
    legacy(
        'nai-diffusion-4-full',
        'nai-diffusion-4-full-inpainting',
        'NAI Diffusion V4 Full',
        'V4 Full은 오래된 V4 설정을 그대로 이어갈 때만 사용하세요.',
    ),
    legacy(
        'nai-diffusion-4-curated-preview',
        'nai-diffusion-4-curated-inpainting',
        'NAI Diffusion V4 Curated',
        'V4 Curated는 오래된 V4 큐레이티드 작업과의 호환용이에요.',
    ),
] as const satisfies readonly NaiSelectableImageModel[]

const MODEL_IDS = new Set(NAI_IMAGE_MODELS.map(model => model.id))
const INPAINT_MODEL_TO_BASE = new Map(NAI_IMAGE_MODELS.map(model => [model.inpaintId, model.id]))

export function isSelectableNaiImageModel(id: string): boolean {
    return MODEL_IDS.has(id)
}

export function getNaiImageModelName(id: string | null | undefined): string {
    return NAI_IMAGE_MODELS.find(model => model.id === id)?.name ?? id ?? '—'
}

export function isNovelAiV5Model(model: string): boolean {
    return model === 'nai-diffusion-5-full'
        || model === 'nai-diffusion-5-full-inpainting'
        || model === 'nai-diffusion-5-curated'
        || model === 'nai-diffusion-5-curated-inpainting'
        || isNovelAiMediumModel(model)
}

export function isNovelAiMediumModel(model: string): boolean {
    return model === 'nai-diffusion-5-full-medium'
        || model === 'nai-diffusion-5-full-medium-inpainting'
}

/** A deliberate model selection applies its fixed numeric settings; prompt text
 * stays intact so unsupported negatives still require an explicit user edit. */
export function naiModelSelectionDefaults(model: string): {
    steps?: number; sampler?: string; cfgRescale?: number; ucPreset?: number
} {
    return isNovelAiMediumModel(model)
        ? { steps: 14, sampler: 'k_euler_ancestral', cfgRescale: 0, ucPreset: 0 }
        : {}
}

/** Shared adapter/payload guard: never discard reviewed settings for the distilled model. */
export function mediumSettingsIssue(settings: {
    model: string
    steps: number
    sampler: string
    cfgRescale: number
    ucPreset: number
    negativePrompt: string
    characterNegatives: readonly string[]
}): string | null {
    if (!isNovelAiMediumModel(settings.model)) return null
    if (settings.steps !== 14 || settings.sampler !== 'k_euler_ancestral'
        || settings.cfgRescale !== 0 || settings.ucPreset !== 0) {
        return 'V5 Full Medium은 14 Steps, Euler Ancestral, CFG Rescale 0, Heavy UC만 지원합니다.'
    }
    if (settings.negativePrompt.trim() || settings.characterNegatives.some(value => value.trim())) {
        return 'V5 Full Medium은 커스텀 네거티브 프롬프트를 지원하지 않습니다. 네거티브를 비우거나 High 모델을 선택하세요.'
    }
    return null
}

export function getNovelAiModelProfile(model: string): NovelAiModelProfile | undefined {
    const baseId = MODEL_IDS.has(model)
        ? model
        : INPAINT_MODEL_TO_BASE.get(model)
    if (baseId === undefined) return undefined
    const baseModel = NAI_IMAGE_MODELS.find(candidate => candidate.id === baseId)
    if (baseModel === undefined) return undefined
    return {
        modelId: baseModel.id,
        inpaintModelId: baseModel.inpaintId,
        capabilities: baseModel.capabilities,
    }
}

/** Exact final text cannot also request provider preset/quality text injection. */
export function novelAiVerbatimSettingsIssue(settings: { promptTextMode?: string; model: string; ucPreset: number;
    qualityToggle?: boolean; transparentBackground?: boolean }): string | null {
    if (settings.promptTextMode === undefined || settings.promptTextMode === 'standard') return null
    return settings.promptTextMode !== 'verbatim' || !getNovelAiModelProfile(settings.model)?.modelId.startsWith('nai-diffusion-4-5-')
        || settings.ucPreset !== 4 || settings.qualityToggle || settings.transparentBackground
        ? '원문 보존은 V4.5, UC None(4), 품질 태그 끄기가 필요합니다.' : null
}

export function normalizeNaiImageModelId(model: string | undefined): string | undefined {
    if (model === undefined) return undefined
    const raw = model.trim()
    if (raw.length === 0) return undefined
    if (MODEL_IDS.has(raw)) return raw
    const baseId = INPAINT_MODEL_TO_BASE.get(raw)
    if (baseId !== undefined) return baseId

    const normalized = raw.toLowerCase()
    if (normalized.includes('4.5') || normalized.includes('4-5')) {
        return normalized.includes('curated') ? 'nai-diffusion-4-5-curated' : 'nai-diffusion-4-5-full'
    }
    if (normalized.includes('v5') || /\b5\b/.test(normalized)) {
        if (normalized.includes('medium') && !normalized.includes('curated')) return 'nai-diffusion-5-full-medium'
        return normalized.includes('curated') ? 'nai-diffusion-5-curated' : DEFAULT_NAI_IMAGE_MODEL
    }
    if (normalized.includes('v4') || /\b4\b/.test(normalized)) {
        return normalized.includes('curated') ? 'nai-diffusion-4-curated-preview' : 'nai-diffusion-4-full'
    }
    if (normalized.includes('furry')) return 'nai-diffusion-furry-3'
    if (normalized.includes('v3') || /\b3\b/.test(normalized)) return 'nai-diffusion-3'
    return undefined
}
