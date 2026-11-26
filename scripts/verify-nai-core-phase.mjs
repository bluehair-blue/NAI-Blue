import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { transformSync } from '@babel/core'

const root = process.cwd()
const read = path => readFileSync(join(root, path), 'utf8')
const count = (text, re) => (text.match(re) ?? []).length

const checks = []
function check(name, pass) {
  checks.push({ name, pass: Boolean(pass) })
}

const files = [
  'src/lib/nai-preset-text.ts',
  'src/services/nai/endpoints.ts',
  'src/services/nai/presets.ts',
  'src/services/nai/model-catalog.ts',
  'src/services/nai/text-assembly.ts',
  'src/services/nai/payload.ts',
  'src/services/nai/stream.ts',
  'src/services/nai/refs.ts',
  'src/services/nai/adapter.ts',
  'src/services/nai/client.ts',
  'src/services/nai/transport.ts',
  'src/services/novelai-types.ts',
  'src/services/novelai-api.ts',
  'src/lib/generation-metadata.ts',
  'src-tauri/src/lib.rs',
  'src-tauri/src/nai_transport.rs',
]

for (const file of files) {
  check(`${file} exists`, existsSync(join(root, file)))
}

const presetText = read('src/lib/nai-preset-text.ts')
const endpoints = read('src/services/nai/endpoints.ts')
const payload = read('src/services/nai/payload.ts')
const stream = read('src/services/nai/stream.ts')
const refs = read('src/services/nai/refs.ts')
const modelCatalog = read('src/services/nai/model-catalog.ts')
const adapter = read('src/services/nai/adapter.ts')
const client = read('src/services/nai/client.ts')
const transport = read('src/services/nai/transport.ts')
const facade = read('src/services/novelai-api.ts')
const metadata = read('src/lib/generation-metadata.ts')
const rust = read('src-tauri/src/lib.rs')
const rustTransport = read('src-tauri/src/nai_transport.rs')
const sceneBuilder = read('src/lib/scene-generation/build-scene-params.ts')
const legacySceneBuilder = read('src/lib/scene-generation/legacy-build-scene-params.ts')
const sceneGeneration = read('src/hooks/useSceneGeneration.ts')
const sceneStore = read('src/stores/scene-store.ts')
const sceneCancellation = read('src/lib/scene-generation/request-cancellation.ts')
const sceneSave = read('src/lib/scene-generation/save-scene-result.ts')
const generationStore = read('src/services/generation/generation-runtime-store.ts')
const mainGenerationPlan = read('src/services/generation/main-generation-plan.ts')
const styleLab = read('src/services/style-lab-generation.ts')
const outputMetadataWriter = read('src/services/output/metadata-writer.ts')
const types = read('src/services/novelai-types.ts')

function loadTsCommonJs(path, deps = {}) {
  const source = read(path)
  // Babel transpiles these isolated fixtures because TypeScript 7 exposes the
  // compiler as a CLI and no longer exports the legacy transpileModule API.
  const transformed = transformSync(source, {
    filename: path,
    babelrc: false,
    configFile: false,
    presets: ['@babel/preset-typescript'],
    plugins: ['@babel/plugin-transform-modules-commonjs'],
  })
  const outputText = transformed?.code
  assert.equal(typeof outputText, 'string', `Failed to transpile verifier fixture: ${path}`)
  const module = { exports: {} }
  const require = specifier => {
    if (specifier in deps) return deps[specifier]
    throw new Error(`Unexpected verifier require from ${path}: ${specifier}`)
  }
  vm.runInNewContext(outputText, {
    exports: module.exports,
    module,
    require,
    console,
  }, { filename: path })
  return module.exports
}

function fixtureCheck(name, fn) {
  try {
    fn()
    check(name, true)
  } catch (error) {
    check(name, false)
    console.error(`Fixture failure (${name}): ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assertPlainObject(actual, expected) {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected)
}

function runPayloadFixtureChecks() {
  // The payload fixture mirrors the runtime dependency graph: preset assembly
  // consumes the shared quality/UC table also used by metadata import.
  const presetTextModule = loadTsCommonJs('src/lib/nai-preset-text.ts')
  const textAssemblyModule = loadTsCommonJs('src/services/nai/text-assembly.ts')
  const presetsModule = loadTsCommonJs('src/services/nai/presets.ts', {
    '@/lib/nai-preset-text': presetTextModule,
    '@/services/nai/text-assembly': textAssemblyModule,
  })
  const modelDefaultModule = loadTsCommonJs('src/domain/generation/model-default.ts')
  const preciseReferenceModule = loadTsCommonJs('src/domain/generation/precise-reference.ts')
  const modelCatalogModule = loadTsCommonJs('src/services/nai/model-catalog.ts', {
    '@/domain/generation/model-default': modelDefaultModule,
    '@/domain/generation/precise-reference': preciseReferenceModule,
  })
  const payloadModule = loadTsCommonJs('src/services/nai/payload.ts', {
    '@/domain/generation/precise-reference': preciseReferenceModule,
    '@/services/nai/model-catalog': modelCatalogModule,
    '@/services/nai/presets': presetsModule,
    '@/services/nai/text-assembly': textAssemblyModule,
  })
  const { buildGenerateImagePayload } = payloadModule
  const baseRequest = (overrides = {}) => ({
    prompt: '1girl, silver hair',
    negativePrompt: 'lowres',
    model: 'nai-diffusion-4-5-full',
    width: 832,
    height: 1216,
    steps: 28,
    cfgScale: 5,
    cfgRescale: 0,
    sampler: 'k_euler_ancestral',
    noiseSchedule: 'karras',
    seed: 1234567890,
    variety: false,
    qualityToggle: false,
    ucPreset: 4,
    characterPrompts: [],
    useCoords: false,
    ...overrides,
  })

  fixtureCheck('payload snapshot keeps input and v4 positive caption in sync', () => {
    const built = buildGenerateImagePayload(baseRequest())
    assert.equal(built.input, built.parameters.v4_prompt.caption.base_caption)
  })

  fixtureCheck('payload snapshot keeps negative prompt and v4 negative caption in sync', () => {
    const built = buildGenerateImagePayload(baseRequest({ qualityToggle: true, ucPreset: 0 }))
    assert.equal(built.parameters.negative_prompt, built.parameters.v4_negative_prompt.caption.base_caption)
    assert.equal(built.parameters.qualityToggle, true)
    assert.equal(built.parameters.ucPreset, 0)
  })

  fixtureCheck('payload snapshot omits top-level legacy_uc', () => {
    const built = buildGenerateImagePayload(baseRequest())
    assert.equal(Object.hasOwn(built.parameters, 'legacy_uc'), false)
  })

  fixtureCheck('payload snapshot centers disabled coords at midpoint', () => {
    const built = buildGenerateImagePayload(baseRequest({
      characterPrompts: [
        { prompt: 'girl A', negativePrompt: 'bad A', enabled: true, center: { x: 0.1, y: 0.9 } },
      ],
      useCoords: false,
    }))
    assertPlainObject(built.parameters.v4_prompt.caption.char_captions[0].centers[0], { x: 0.5, y: 0.5 })
    assertPlainObject(built.parameters.characterPrompts[0].center, { x: 0.5, y: 0.5 })
  })

  fixtureCheck('payload snapshot preserves enabled character coords', () => {
    const built = buildGenerateImagePayload(baseRequest({
      characterPrompts: [
        { prompt: 'girl A', negativePrompt: 'bad A', enabled: true, center: { x: 0.1, y: 0.9 } },
      ],
      useCoords: true,
    }))
    assertPlainObject(built.parameters.v4_prompt.caption.char_captions[0].centers[0], { x: 0.1, y: 0.9 })
    assertPlainObject(built.parameters.v4_negative_prompt.caption.char_captions[0].centers[0], { x: 0.1, y: 0.9 })
    assertPlainObject(built.parameters.characterPrompts[0].center, { x: 0.1, y: 0.9 })
  })

  fixtureCheck('payload snapshot emits vibe transfer fields', () => {
    const built = buildGenerateImagePayload(baseRequest(), {
      vibes: [{ strength: 0.6, encodedVibeBase64: 'encoded-vibe' }],
    })
    assert.deepEqual(built.parameters.reference_image_multiple, ['encoded-vibe'])
    assert.deepEqual(built.parameters.reference_strength_multiple, [0.6])
  })

  fixtureCheck('payload snapshot emits nested character reference legacy_uc false', () => {
    const built = buildGenerateImagePayload(baseRequest(), {
      characterReferences: [
        { referenceType: 'character&style', strength: 1, fidelity: 1, imageBase64: 'character-image' },
      ],
    })
    assert.equal(built.parameters.director_reference_descriptions[0].legacy_uc, false)
    assert.equal(Object.hasOwn(built.parameters, 'legacy_uc'), false)
  })

  fixtureCheck('payload snapshot emits img2img edit fields', () => {
    const built = buildGenerateImagePayload(baseRequest(), {
      i2i: {
        strength: 0.7,
        noise: 0.1,
        extraNoiseSeed: 123,
        colorCorrect: true,
        imageBase64: 'source-image',
      },
    })
    assert.equal(built.action, 'img2img')
    assert.equal(built.parameters.image, 'source-image')
    assert.equal(built.parameters.strength, 0.7)
    assert.equal(built.parameters.color_correct, true)
  })

  fixtureCheck('payload snapshot emits inpaint fields', () => {
    const built = buildGenerateImagePayload(baseRequest(), {
      i2i: {
        strength: 0.7,
        noise: 0.1,
        extraNoiseSeed: 123,
        colorCorrect: true,
        imageBase64: 'source-image',
        maskBase64: 'mask-image',
      },
    })
    assert.equal(built.action, 'infill')
    assert.equal(built.parameters.request_type, 'NativeInfillingRequest')
    assert.equal(built.parameters.image, 'source-image')
    assert.equal(built.parameters.mask, 'mask-image')
    assert.equal(built.parameters.inpaintImg2ImgStrength, 0.7)
  })

  fixtureCheck('payload snapshot emits V5 tag hints and V5 UC without Variety coefficient', () => {
    const built = buildGenerateImagePayload(baseRequest({
      model: 'nai-diffusion-5-full',
      variety: true,
      qualityToggle: true,
      ucPreset: 0,
    }))
    assert.equal(built.input, '1girl, silver hair, very aesthetic, masterpiece, no text')
    assert.equal(built.parameters.negative_prompt.startsWith('lowres, artistic error'), true)
    assert.equal(built.parameters.negative_prompt.includes('nsfw'), false)
    assert.equal(built.parameters.skip_cfg_above_sigma, undefined)
    assert.equal(built.parameters.tag_hint_qt, 1)
    assert.equal(built.parameters.tag_hint_uc_preset, 2)
    assert.equal(built.parameters.tag_hint_transparent_background, false)
  })
}

check('image host is primary NAI host', /https:\/\/image\.novelai\.net/.test(endpoints))
check('upscale uses image host multipart endpoint', /upscale:\s*`\$\{NAI_IMAGE_HOST\}\/ai\/upscale`/.test(endpoints))
check('payload builder exists exactly once', count(payload, /export function buildGenerateImagePayload/g) === 1)
check('payload computes Variety+ from model and resolution', /varietySigma/.test(payload) && /832 \* 1216/.test(payload) && /Math\.sqrt/.test(payload))
check('payload emits v4 prompt and negative prompt', /v4_prompt/.test(payload) && /v4_negative_prompt/.test(payload))
check(
  'quality tag table records official V4 and V4.5 model suffixes',
  /'nai-diffusion-4-5-full': 'location, very aesthetic, masterpiece, no text'/.test(presetText) &&
  /'nai-diffusion-4-5-curated': 'location, masterpiece, no text, -0\.8::feet::, rating:general'/.test(presetText) &&
  /'nai-diffusion-4-full': 'no text, best quality, very aesthetic, absurdres'/.test(presetText) &&
  /'nai-diffusion-4-curated-preview': 'rating:general, amazing quality, very aesthetic, absurdres'/.test(presetText)
)
check('payload source includes nested character reference legacy_uc false', /director_reference_descriptions/.test(payload) && /legacy_uc:\s*false/.test(payload))
check('stream parser reads msgpack frames', /getReader\(\)/.test(stream) && /msgpackDecode/.test(stream) && /readNaiImageStream/.test(stream))
check('stream parser cleans up reader and handles abort', /releaseLock/.test(stream) && /AbortSignal/.test(stream) && /reader\.cancel/.test(stream))
check('refs normalize source dimensions and mask format', /normalizeSourceForNai/.test(refs) && /width/.test(refs) && /height/.test(refs) && /normalizeInpaintMask/.test(refs))
check('refs normalize character references to NAI canvases', /1024/.test(refs) && /1536/.test(refs) && /1472/.test(refs))
check('adapter maps old GenerationParams through split type boundary', /GenerationParams/.test(adapter) && /..\/novelai-types/.test(adapter) && /export async function adaptGenerationParams/.test(adapter))
check('client uses shared payload builder', /buildGenerateImagePayload/.test(client))
check(
  'generation transport keeps browser fetch and desktop scoped HTTP plugin adapters',
  /export interface NaiTransport/.test(transport) &&
  /createFetchNaiTransport\('browser-fetch'/.test(transport) &&
  /createFetchNaiTransport\('tauri-http-plugin', tauriFetch\)/.test(transport)
)
check(
  'Android generation selects the fixed-endpoint Rust reqwest adapter',
  /isAndroidRuntime\s*\?\s*androidRustTransport\s*:\s*tauriHttpTransport/.test(transport) &&
  /STANDARD_ENDPOINT:\s*&str\s*=\s*"https:\/\/image\.novelai\.net\/ai\/generate-image"/.test(rustTransport) &&
  /STREAM_ENDPOINT:\s*&str\s*=\s*"https:\/\/image\.novelai\.net\/ai\/generate-image-stream"/.test(rustTransport) &&
  /NaiTransportEvent::BodyChunk/.test(rustTransport) &&
  /BASE64_STANDARD\.encode\(part\)/.test(rustTransport) &&
  !/Channel<Response>/.test(rustTransport) &&
  /cancel_nai_request/.test(rustTransport)
)
check(
  'standard and streaming requests have explicit finite transport deadlines',
  /NAI_STANDARD_TIMEOUT_MS\s*=\s*120_000/.test(client) &&
  /NAI_STREAM_TIMEOUT_MS\s*=\s*120_000/.test(client) &&
  /NaiTransportTimeoutError/.test(transport) &&
  /\.timeout\(total_timeout\)/.test(rustTransport)
)
check(
  'transport lifecycle reports monitor stages without payload logging',
  ['dns-connect', 'request-sent', 'response-headers', 'body-first-byte', 'stream-heartbeat']
    .every(stage => transport.includes(`'${stage}'`)) &&
  /operation\.stageStart\('decode'\)/.test(client) &&
  !/console\.(?:log|error|warn)\([^\n]*(?:token|payload|body)/i.test(transport)
)
check('account endpoints stay Rust invoke primary', /invoke<.*verify_token/s.test(client) && /invoke<.*get_anlas_balance/s.test(client))
check(
  'upscale uses auxiliary multipart V5 path without obsolete native command',
  /getNaiAuxiliaryFetch\(\)\(NAI_ENDPOINTS\.upscale/.test(client) &&
  /model:\s*'nai-diffusion-5-curated'/.test(client) &&
  /declared_blur_sigma:\s*0/.test(client) &&
  /width \* height > 3_145_728/.test(client) &&
  !/upscale_image/.test(rust)
)
check('facade delegates to nai client', /from '@\/services\/nai\/client'/.test(facade))
check('metadata exposes sentPayload redaction', /export function redactSentPayloadForMetadata/.test(metadata))
check('client redacts sentPayload before returning metadata summary', /redactSentPayloadForMetadata/.test(client))
check('Rust no longer calls old subscription host', !/https:\/\/api\.novelai\.net\/user\/subscription/.test(rust))
check(
  'scene generation passes quality and UC to GenerationParams',
  /qualityToggle:\s*plan\.params\.qualityToggle/.test(sceneBuilder) &&
  /ucPreset:\s*plan\.params\.ucPreset/.test(sceneBuilder) &&
  // Both builders now resolve these fields from the per-scene generation snapshot.
  /qualityToggle:\s*sceneGeneration\.qualityToggle/.test(legacySceneBuilder) &&
  /ucPreset:\s*sceneGeneration\.ucPreset/.test(legacySceneBuilder)
)
check(
  'main scene and stylelab force source edit requests through zip',
  /const sourceEdit = Boolean\(options\.params\.sourceImage \|\| options\.params\.mask\)/.test(mainGenerationPlan) &&
  /streaming: options\.streamingRequested && !sourceEdit/.test(mainGenerationPlan) &&
  /const hasSourceEdit = Boolean\(params\.sourceImage \|\| params\.mask\)/.test(sceneGeneration) &&
  /const canUseStreaming = ctx\.streamingView && !hasSourceEdit/.test(sceneGeneration) &&
  /const hasSourceEdit = Boolean\(params\.sourceImage \|\| params\.mask\)/.test(styleLab) &&
  /const canUseStreaming = useStreaming && !hasSourceEdit/.test(styleLab)
)
check(
  'sent payload summaries reach history and sidecar metadata',
  /sentPayloadSummary\?: string/.test(types) &&
  /sentPayloadSummary: result\.sentPayloadSummary/.test(generationStore) &&
  /sentPayloadSummary: result\.sentPayloadSummary/.test(sceneGeneration) &&
  /const redactedPayloadHash = params\.sentPayloadSummary/.test(metadata) &&
  /sentPayloadSummary: options\.sentPayloadSummary/.test(sceneSave)
)
check(
  'Scene cancellation owns and aborts session-slot-request controllers',
  /acquireSceneRequestController/.test(sceneGeneration) &&
  /generateImageStream\([\s\S]*requestLease\.signal\)/.test(sceneGeneration) &&
  /generateImage\(token, params, requestLease\.signal\)/.test(sceneGeneration) &&
  /abortSceneSessionRequests\(cancelledSessionId\)/.test(sceneStore) &&
  /sessionId:\s*number/.test(sceneCancellation) &&
  /slot:\s*ApiSlot/.test(sceneCancellation) &&
  /requestId:\s*string/.test(sceneCancellation)
)
check(
  'main webp writes compatibility sidecar',
  /includeWebpCompatibilitySidecar:\s*true/.test(generationStore) &&
  /shouldWriteNaiBlueSidecar\(/.test(outputMetadataWriter) &&
  /request\.includeWebpCompatibilitySidecar \?\? true/.test(outputMetadataWriter)
)
check(
  'selectable model authority is the verified V5-first release matrix',
  /nai-diffusion-5-full/.test(modelCatalog) &&
  /nai-diffusion-5-curated/.test(modelCatalog) &&
  /nai-diffusion-4-5-curated/.test(modelCatalog) &&
  /nai-diffusion-4-5-full/.test(modelCatalog) &&
  /nai-diffusion-4-curated-preview/.test(modelCatalog) &&
  /nai-diffusion-4-full/.test(modelCatalog) &&
  /DEFAULT_NAI_IMAGE_MODEL/.test(modelCatalog) &&
  /normalizeSelectableGenerationModel/.test(generationStore)
)
check('payload authority records V4/V4.5/V5 release support', /Release-supported builder authority is V4\/V4\.5\/V5/.test(payload))

runPayloadFixtureChecks()

const failed = checks.filter(item => !item.pass)
for (const item of checks) {
  console.log(`${item.pass ? 'PASS' : 'FAIL'} ${item.name}`)
}

if (failed.length > 0) {
  console.error(`\nNAI core phase verifier failed: ${failed.length}/${checks.length}`)
  process.exit(1)
}

console.log(`\nNAI core phase verifier passed: ${checks.length}/${checks.length}`)
