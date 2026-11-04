export type UcPresetIndex = 0 | 1 | 2 | 3 | 4

export const QUALITY_TAGS_SUFFIX = ', very aesthetic, masterpiece, no text'

export const QUALITY_TAGS_BY_SELECTABLE_MODEL: Readonly<Record<string, string>> = Object.freeze({
    'nai-diffusion-5-full': 'very aesthetic, masterpiece, no text',
    'nai-diffusion-5-full-medium': 'very aesthetic, masterpiece, no text',
    'nai-diffusion-5-curated': 'very aesthetic, masterpiece, no text',
    'nai-diffusion-4-5-full': 'location, very aesthetic, masterpiece, no text',
    'nai-diffusion-4-5-curated': 'location, masterpiece, no text, -0.8::feet::, rating:general',
    'nai-diffusion-4-full': 'no text, best quality, very aesthetic, absurdres',
    'nai-diffusion-4-curated-preview': 'rating:general, amazing quality, very aesthetic, absurdres',
})

export type UcPresetTable = Readonly<Record<UcPresetIndex, string>>

const UC_V45_FULL_HEAVY =
    'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page'
const UC_FURRY_FOCUS =
    '{worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, upscale, {sequence}, {{grandfathered content}}, blurred foreground, chromatic aberration, sketch, everyone, [sketch background], simple, [flat colors], ych (character), outline, multiple scenes, [[horror (theme)]], comic'

/**
 * This table is the shared V4.5 Full wire contract for payload assembly and
 * metadata import. Keeping both directions on one dependency prevents preset
 * indices or text from drifting during a generation/import round trip.
 */
export const UC_PRESETS_V45_FULL: UcPresetTable = Object.freeze({
    0: UC_V45_FULL_HEAVY,
    1: 'lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page',
    2: UC_FURRY_FOCUS,
    3: `${UC_V45_FULL_HEAVY}, @_@, mismatched pupils, glowing eyes, bad anatomy`,
    4: '',
})

export const UC_PRESETS_V45_CURATED: UcPresetTable = Object.freeze({
    0: 'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page',
    1: 'blurry, lowres, upscaled, artistic error, scan artifacts, jpeg artifacts, logo, too many watermarks, negative space, blank page',
    2: '',
    3: 'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, bad anatomy, bad hands, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, @_@, mismatched pupils, glowing eyes, negative space, blank page',
    4: '',
})

export const UC_PRESETS_V4_FULL: UcPresetTable = Object.freeze({
    0: 'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, too many watermarks',
    1: 'blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing',
    2: '',
    3: '',
    4: '',
})

export const UC_PRESETS_V4_CURATED: UcPresetTable = Object.freeze({
    0: 'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, logo, dated, signature, multiple views, gigantic breasts',
    1: 'blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing, logo, dated, signature',
    2: '',
    3: '',
    4: '',
})

/** Current V5 preset text captured from NovelAI's production image frontend. */
export const UC_PRESETS_V5: UcPresetTable = Object.freeze({
    0: UC_V45_FULL_HEAVY,
    1: 'lowres, bad hands, bad anatomy, artistic error, sepia, white haze, worst quality, very displeasing, jpeg artifacts, 0::ai-generated::',
    2: UC_FURRY_FOCUS,
    3: `${UC_V45_FULL_HEAVY}, @_@, mismatched pupils, glowing eyes, bad anatomy`,
    4: '',
})

/** Official model-scoped UC wire text; missing preset families fail closed to no injected text. */
export const UC_PRESETS_BY_SELECTABLE_MODEL: Readonly<Record<string, UcPresetTable>> = Object.freeze({
    'nai-diffusion-5-full': UC_PRESETS_V5,
    'nai-diffusion-5-full-medium': UC_PRESETS_V5,
    'nai-diffusion-5-curated': UC_PRESETS_V5,
    'nai-diffusion-4-5-full': UC_PRESETS_V45_FULL,
    'nai-diffusion-4-5-curated': UC_PRESETS_V45_CURATED,
    'nai-diffusion-4-full': UC_PRESETS_V4_FULL,
    'nai-diffusion-4-curated-preview': UC_PRESETS_V4_CURATED,
})
