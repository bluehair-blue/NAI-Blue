import { readFile } from 'node:fs/promises'
import 'fake-indexeddb/auto'
import JSZip from 'jszip'
import { encode } from '@msgpack/msgpack'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NovelAIHttpError, type GenerationParams } from '@/services/novelai-types'
import { readNaiBlueParams } from '@/lib/nai-blue-metadata'
import { SCENE_DIRECT_RECIPE_ID } from '@/lib/composition/scene-adapter'

import {
    type CapturedRequest,
    hashCapturedPayload,
    redactedGolden,
    summarizeCapturedRequest,
    summarizeGenerationParams,
    summarizeMetadata,
    summarizeNaiBlueMetadata,
} from './workflow-capture'

type FetchBehavior = 'success' | 'http-400' | 'deferred-success' | 'deferred-stream'

const runtimeCapture = vi.hoisted(() => ({
    behaviors: [] as FetchBehavior[],
    calls: [] as string[],
    deferredResolve: null as ((response: Response) => void) | null,
    events: [] as Array<{ type: string; detail: Record<string, unknown> }>,
    params: [] as GenerationParams[],
    requests: [] as CapturedRequest[],
    requestSignals: [] as Array<AbortSignal | undefined>,
    streamBodyCancelled: 0,
    writeBytes: [] as Uint8Array[],
    writes: [] as string[],
    zipBytes: new Uint8Array(),
    files: new Map<string, Uint8Array>(),
}))

vi.mock('@/stores/artifact-lifecycle-store', () => ({
    publishGeneratedArtifact: (detail: Record<string, unknown>) => {
        runtimeCapture.calls.push('event:new-image')
        runtimeCapture.events.push({ type: 'artifact:generated', detail })
    },
}))

vi.mock('@/lib/indexed-db', () => ({
    indexedDBStorage: {
        getItem: async () => null,
        setItem: async () => undefined,
        removeItem: async () => undefined,
    },
}))

vi.mock('@/lib/toast', () => ({
    toast: () => undefined,
}))

vi.mock('@/i18n', () => ({
    default: {
        t: (key: string, fallback?: string) => fallback ?? key,
    },
}))

vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string, fallback?: string) => fallback ?? key,
    }),
}))

vi.mock('@/lib/image-utils', () => ({
    createThumbnail: async () => {
        runtimeCapture.calls.push('thumbnail:create')
        return 'data:image/jpeg;base64,VEhVTUI='
    },
    saveReferenceImage: async () => 'synthetic-reference.bin',
    loadReferenceImage: async () => null,
    deleteReferenceImage: async () => undefined,
    saveEncodedVibe: async () => 'synthetic-vibe.bin',
    loadEncodedVibe: async () => null,
}))

vi.mock('@tauri-apps/plugin-fs', () => {
    const key = (location: string, baseDir?: unknown) => `${String(baseDir ?? 'absolute')}:${location}`
    const isJournal = (location: string, baseDir?: unknown) => baseDir === 2 && location.startsWith('nai-blue/output-journal')
    return {
        BaseDirectory: { Picture: 1, AppData: 2 },
        exists: async (location: string, options?: { baseDir?: unknown }) => {
            if (!isJournal(location, options?.baseDir) && !/\.(png|webp|json|tmp|bak)$/i.test(location)) {
                runtimeCapture.calls.push('output:exists')
            }
            return runtimeCapture.files.has(key(location, options?.baseDir))
        },
        mkdir: async (location: string, options?: { baseDir?: unknown }) => {
            if (!isJournal(location, options?.baseDir)) runtimeCapture.calls.push('output:mkdir')
        },
        readFile: async (location: string, options?: { baseDir?: unknown }) => (
            new Uint8Array(runtimeCapture.files.get(key(location, options?.baseDir)) ?? [])
        ),
        readDir: async (location: string, options?: { baseDir?: unknown }) => {
            const prefix = `${key(location, options?.baseDir)}/`
            return [...runtimeCapture.files.keys()]
                .filter(file => file.startsWith(prefix))
                .map(file => ({ name: file.slice(prefix.length), isFile: true, isDirectory: false }))
        },
        remove: async (location: string, options?: { baseDir?: unknown }) => {
            runtimeCapture.files.delete(key(location, options?.baseDir))
        },
        rename: async (from: string, to: string, options?: { oldPathBaseDir?: unknown; newPathBaseDir?: unknown }) => {
            const data = runtimeCapture.files.get(key(from, options?.oldPathBaseDir)) ?? new Uint8Array()
            runtimeCapture.files.delete(key(from, options?.oldPathBaseDir))
            runtimeCapture.files.set(key(to, options?.newPathBaseDir), data)
            if (!isJournal(to, options?.newPathBaseDir) && !to.split('/').at(-1)?.startsWith('.')) {
                runtimeCapture.writes.push(to)
                runtimeCapture.writeBytes.push(new Uint8Array(data))
            }
        },
        writeFile: async (location: string, data: Uint8Array, options?: { baseDir?: unknown }) => {
            runtimeCapture.files.set(key(location, options?.baseDir), new Uint8Array(data))
            if (!isJournal(location, options?.baseDir)) runtimeCapture.calls.push('output:write-image')
        },
    }
})

vi.mock('@tauri-apps/api/path', () => ({
    appDataDir: async () => 'C:/Synthetic/AppData',
    pictureDir: async () => 'C:/Synthetic/Pictures',
    join: async (...parts: string[]) => parts.join('/').replace(/\/+/g, '/'),
}))

vi.mock('@tauri-apps/api/core', () => ({
    invoke: async () => ({ success: false }),
    isTauri: () => false,
}))

vi.mock('@/services/asset-profile-file', () => ({
    ASSET_PROFILE_FILE_PATH: 'synthetic/asset-profile.json',
    loadAssetProfileFile: async () => {
        throw new Error('not used by characterization')
    },
    saveAssetProfileFile: async () => {
        throw new Error('not used by characterization')
    },
    watchAssetProfileFile: () => () => undefined,
}))

vi.mock('@/lib/fragment-processor', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/fragment-processor')>()
    return {
        ...actual,
        createWildcardResolutionSession: (...args: Parameters<typeof actual.createWildcardResolutionSession>) => {
            const session = actual.createWildcardResolutionSession(...args)
            return {
                process: async (prompt: string) => {
                    runtimeCapture.calls.push('wildcards:process')
                    return session.process(prompt)
                },
                get status() {
                    return session.status
                },
                get success() {
                    return session.success
                },
                get sequenceCommitProposal() {
                    return session.sequenceCommitProposal
                },
                commitSequence: () => session.commitSequence(),
                discard: () => session.discard(),
            }
        },
        processWildcards: async (prompt: string) => {
            runtimeCapture.calls.push('wildcards:process')
            return actual.processWildcards(prompt)
        },
    }
})

vi.mock('@/services/nai/adapter', async importOriginal => {
    const actual = await importOriginal<typeof import('@/services/nai/adapter')>()
    return {
        ...actual,
        adaptGenerationParams: async (...args: Parameters<typeof actual.adaptGenerationParams>) => {
            runtimeCapture.calls.push('payload:adapt-params')
            runtimeCapture.params.push(args[1])
            return actual.adaptGenerationParams(...args)
        },
    }
})

const FIXED_TIME = Date.parse('2026-07-11T00:00:00.000Z')
const FIXED_SEED = 515151
const PRESET_ID = 'scene-preset'
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+4xVnAAAAAElFTkSuQmCC'

function base64Bytes(value: string): Uint8Array {
    return Uint8Array.from(atob(value), character => character.charCodeAt(0))
}

interface SceneFixture {
    workflow: 'scene'
    captureDate: string
    workerPolicy: Record<string, unknown>
    guards: string[]
    nondeterminism: string[]
    scenarios: Array<Record<string, unknown>>
}

interface RuntimeModules {
    useAssetModuleStore: typeof import('@/stores/asset-module-store').useAssetModuleStore
    useAuthStore: typeof import('@/stores/auth-store').useAuthStore
    useCharacterPromptStore: typeof import('@/stores/character-prompt-store').useCharacterPromptStore
    useCharacterStore: typeof import('@/stores/character-store').useCharacterStore
    useGenerationStore: typeof import('@/stores/generation-store').useGenerationStore
    useFragmentStore: typeof import('@/stores/fragment-store').useFragmentStore
    useRotationStore: typeof import('@/stores/character-rotation-store').useRotationStore
    useSceneStore: typeof import('@/stores/scene-store').useSceneStore
    useSettingsStore: typeof import('@/stores/settings-store').useSettingsStore
    sceneTest: typeof import('@/hooks/useSceneGeneration').__sceneGenerationTest
}

let runtime: RuntimeModules

function frame(event: Record<string, unknown>): Uint8Array {
    const message = encode(event)
    const framed = new Uint8Array(message.length + 4)
    new DataView(framed.buffer).setUint32(0, message.length, false)
    framed.set(message, 4)
    return framed
}

function makeStreamResponse(): Response {
    const final = frame({
        event_type: 'final',
        step_ix: 28,
        image: base64Bytes(TINY_PNG_BASE64),
    })
    return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(final)
            controller.close()
        },
    }), { status: 200 })
}

function makeSuccessResponse(mode: CapturedRequest['mode']): Response {
    return mode === 'streaming'
        ? makeStreamResponse()
        : new Response(runtimeCapture.zipBytes, { status: 200 })
}

async function capturedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const endpoint = String(input)
    const mode = endpoint.includes('generate-image-stream') ? 'streaming' : 'non-streaming'
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>
    const behavior = runtimeCapture.behaviors.shift() ?? 'success'

    runtimeCapture.calls.push(`transport:${mode}`)
    runtimeCapture.requests.push({ mode, endpoint, payload })
    runtimeCapture.requestSignals.push(init?.signal ?? undefined)

    if (behavior === 'http-400') return new Response('synthetic fatal request', { status: 400 })
    if (behavior === 'deferred-stream') {
        return new Response(new ReadableStream<Uint8Array>({
            pull() {
                runtimeCapture.calls.push('transport:stream-body-read')
                return new Promise<void>(() => undefined)
            },
            cancel() {
                runtimeCapture.streamBodyCancelled++
            },
        }), { status: 200 })
    }
    if (behavior === 'deferred-success') {
        return new Promise((resolve, reject) => {
            runtimeCapture.deferredResolve = resolve
            const signal = init?.signal
            const rejectCancelled = () => reject(new DOMException('요청이 취소되었습니다.', 'AbortError'))
            if (signal?.aborted) rejectCancelled()
            else signal?.addEventListener('abort', rejectCancelled, { once: true })
        })
    }
    return makeSuccessResponse(mode)
}

function installBrowserBoundary(): void {
    vi.stubGlobal('window', {
        fetch: capturedFetch,
        dispatchEvent: (event: { type: string; detail?: Record<string, unknown> }) => {
            runtimeCapture.calls.push('event:new-image')
            runtimeCapture.events.push({ type: event.type, detail: event.detail ?? {} })
            return true
        },
        setTimeout,
        clearTimeout,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
    })
    vi.stubGlobal('CustomEvent', class<T> {
        type: string
        detail: T

        constructor(type: string, init: { detail: T }) {
            this.type = type
            this.detail = init.detail
        }
    })
}

function scene(id: string, queueCount: number, overrides: Record<string, unknown> = {}) {
    return {
        id,
        name: overrides.name ?? 'Opening/Shot',
        scenePrompt: overrides.scenePrompt ?? 'rainy rooftop',
        queueCount,
        images: [],
        width: overrides.width ?? 901,
        height: overrides.height ?? 1102,
        excludePinned: overrides.excludePinned ?? false,
        ...(overrides.prompts === undefined ? {} : { prompts: overrides.prompts }),
        ...(overrides.characterCaptions === undefined ? {} : { characterCaptions: overrides.characterCaptions }),
        ...(overrides.characterPositionEnabled === undefined
            ? {}
            : { characterPositionEnabled: overrides.characterPositionEnabled }),
        ...(overrides.generation === undefined ? {} : { generation: overrides.generation }),
        ...(overrides.compositionRef === undefined ? {} : { compositionRef: overrides.compositionRef }),
        ...(overrides.filenameTemplate === undefined ? {} : { filenameTemplate: overrides.filenameTemplate }),
        ...(overrides.queuedFileNames === undefined ? {} : { queuedFileNames: overrides.queuedFileNames }),
        createdAt: FIXED_TIME,
    }
}

function resetRuntime(sessionId: number, scenes = [scene('scene-1', 1)]): void {
    runtimeCapture.behaviors.length = 0
    runtimeCapture.calls.length = 0
    runtimeCapture.deferredResolve = null
    runtimeCapture.events.length = 0
    runtimeCapture.params.length = 0
    runtimeCapture.requests.length = 0
    runtimeCapture.requestSignals.length = 0
    runtimeCapture.streamBodyCancelled = 0
    runtimeCapture.writeBytes.length = 0
    runtimeCapture.writes.length = 0
    runtimeCapture.files.clear()

    runtime.useAuthStore.setState({
        token: 'synthetic-slot-1',
        isVerified: true,
        slot1Enabled: true,
        token2: 'synthetic-slot-2',
        isVerified2: true,
        slot2Enabled: true,
        refreshAnlas: async slot => {
            runtimeCapture.calls.push(`anlas:refresh-slot-${slot ?? 1}`)
        },
    })
    runtime.useSettingsStore.setState({
        useStreaming: true,
        generationDelay: 0,
        imageFormat: 'png',
        metadataMode: 'embedded',
        sceneSavePath: 'NAI_Blue_Scene',
        useAbsoluteScenePath: false,
    })
    runtime.useGenerationStore.setState({
        basePrompt: 'main base\n# remove main note',
        additionalPrompt: 'main additional',
        detailPrompt: 'main detail',
        negativePrompt: 'main negative',
        inpaintingPrompt: 'main inpainting',
        model: 'nai-diffusion-4-5-full',
        steps: 28,
        cfgScale: 5.5,
        cfgRescale: 0.1,
        sampler: 'k_euler_ancestral',
        scheduler: 'karras',
        smea: true,
        smeaDyn: false,
        variety: true,
        seed: FIXED_SEED,
        seedLocked: true,
        selectedResolution: { label: 'Global', width: 832, height: 1216 },
        qualityToggle: true,
        ucPreset: 1,
        sourceImage: null,
        strength: 0.65,
        noise: 0.05,
        mask: null,
        i2iMode: null,
        generatingMode: 'scene',
        history: [],
    })
    runtime.useFragmentStore.setState({
        files: [],
        sequentialCounters: {},
    })
    runtime.useSceneStore.setState({
        presets: [{
            id: PRESET_ID,
            name: 'Golden:Preset',
            scenes,
            createdAt: FIXED_TIME,
        }],
        activePresetId: PRESET_ID,
        isGenerating: true,
        isCancelling: false,
        generationSessionId: sessionId,
        streamingSceneId: null,
        streamingImage: null,
        streamingProgress: 0,
        completedCount: 0,
        totalQueuedCount: scenes.reduce((total, item) => total + item.queueCount, 0),
        sceneCompositionMode: 'legacy',
        sceneCompositionResults: {},
    })
    runtime.useCharacterPromptStore.setState({
        positionEnabled: true,
        characters: [{
            id: 'rotation-character',
            name: 'Hero',
            prompt: 'hero, <red coat|blue coat>',
            negative: 'hero negative',
            enabled: true,
            position: { x: 0.25, y: 0.75 },
        }, {
            id: 'pinned-character',
            name: 'Guide',
            prompt: 'guide',
            negative: 'guide negative',
            enabled: true,
            position: { x: 0.8, y: 0.2 },
        }],
    })
    runtime.useCharacterStore.setState({
        characterImages: [],
        vibeImages: [],
        _imagesLoaded: true,
        ensureImagesLoaded: async () => {
            runtimeCapture.calls.push('images:ensure-loaded')
        },
        releaseImageData: () => {
            runtimeCapture.calls.push('images:release')
        },
    })
    runtime.useRotationStore.setState({
        status: 'idle',
        active: false,
        paused: false,
        awaitingWorker: false,
        resting: false,
        characterIds: [],
        pinnedCharacterIds: [],
        currentIndex: 0,
        snapshot: null,
    })
    runtime.useAssetModuleStore.setState({
        profile: {
            revision: 0,
            updatedBy: 'system',
            updatedAt: new Date(FIXED_TIME).toISOString(),
            settings: {},
            output: {},
            r2: { enabled: false },
            modules: {},
            recipes: [],
        },
    })
}

function context(sessionId: number, streamingView: boolean, rotation = false) {
    return {
        activePresetId: PRESET_ID,
        sessionId,
        sceneSavePath: 'NAI_Blue_Scene',
        streamingView,
        t: (key: string, fallback?: string) => fallback ?? key,
        rotationCharacterId: rotation ? 'rotation-character' : undefined,
        rotationCharacterFolderName: rotation ? 'Hero' : undefined,
    }
}

function summarizeOutput(): Record<string, unknown> {
    return {
        policy: 'platform media root / configured scene root / sanitized preset / optional rotation character / sanitized scene',
        fileNames: runtimeCapture.writes.map(location => location.split('/').at(-1)),
        targetSegments: runtimeCapture.writes.map(location => location.split('/').slice(0, -1)),
        generatedFileCount: runtimeCapture.writes.length,
        eventCount: runtimeCapture.events.length,
    }
}

function summarizeFinalState(sceneId = 'scene-1'): Record<string, unknown> {
    const sceneState = runtime.useSceneStore.getState()
    const currentScene = sceneState.getScene(PRESET_ID, sceneId)
    return {
        queueCount: currentScene?.queueCount ?? null,
        savedImageCount: currentScene?.images.length ?? 0,
        historyCount: runtime.useGenerationStore.getState().history.length,
        completedCount: sceneState.completedCount,
        totalQueuedCount: sceneState.totalQueuedCount,
        isGenerating: sceneState.isGenerating,
        isCancelling: sceneState.isCancelling,
        generatingMode: runtime.useGenerationStore.getState().generatingMode,
    }
}

function summarizeConcurrentCallOrder(): Record<string, unknown> {
    const counts = runtimeCapture.calls.reduce<Record<string, number>>((result, call) => {
        result[call] = (result[call] ?? 0) + 1
        return result
    }, {})

    return {
        crossWorkerCompletionOrder: 'transport-race-dependent',
        eventCounts: Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))),
    }
}

function firstRequestSummary(): Record<string, unknown> | null {
    if (runtimeCapture.requests.length === 0) return null
    return summarizeCapturedRequest(runtimeCapture.requests[0]).payload as Record<string, unknown>
}

function firstComposition(): Record<string, unknown> | null {
    return runtimeCapture.params[0] ? summarizeGenerationParams(runtimeCapture.params[0]) : null
}

function firstMetadata(): Record<string, unknown> | null {
    const history = runtime.useGenerationStore.getState().history[0]
    const params = runtimeCapture.params[0]
    if (!history || !params) return null
    const metadata = summarizeMetadata(params, history.sentPayloadSummary)
    expect(metadata.sentPayloadHash).toBe(hashCapturedPayload(runtimeCapture.requests[0]))
    const embeddedMetadata = summarizeNaiBlueMetadata(readNaiBlueParams(runtimeCapture.writeBytes[0]))
    expect(embeddedMetadata).toEqual(metadata)
    return {
        qualityToggle: metadata.qualityToggle,
        ucPreset: metadata.ucPreset,
        promptParts: metadata.promptParts,
        assetModulePlan: metadata.assetModulePlan,
        sentPayloadMatchesTransport: true,
        embeddedInWrittenImage: true,
        embeddedMatchesPlanned: true,
    }
}

beforeAll(async () => {
    installBrowserBoundary()
    const zip = new JSZip()
    zip.file('image.png', base64Bytes(TINY_PNG_BASE64))
    runtimeCapture.zipBytes = await zip.generateAsync({ type: 'uint8array' })

    const [assetStore, authStore, characterPromptStore, characterStore, generationStore, fragmentStore, rotationStore, sceneStore, settingsStore, sceneHook] = await Promise.all([
        import('@/stores/asset-module-store'),
        import('@/stores/auth-store'),
        import('@/stores/character-prompt-store'),
        import('@/stores/character-store'),
        import('@/stores/generation-store'),
        import('@/stores/fragment-store'),
        import('@/stores/character-rotation-store'),
        import('@/stores/scene-store'),
        import('@/stores/settings-store'),
        import('@/hooks/useSceneGeneration'),
    ])
    runtime = {
        useAssetModuleStore: assetStore.useAssetModuleStore,
        useAuthStore: authStore.useAuthStore,
        useCharacterPromptStore: characterPromptStore.useCharacterPromptStore,
        useCharacterStore: characterStore.useCharacterStore,
        useGenerationStore: generationStore.useGenerationStore,
        useFragmentStore: fragmentStore.useFragmentStore,
        useRotationStore: rotationStore.useRotationStore,
        useSceneStore: sceneStore.useSceneStore,
        useSettingsStore: settingsStore.useSettingsStore,
        sceneTest: sceneHook.__sceneGenerationTest,
    }
})

beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_TIME)
    vi.spyOn(Math, 'random').mockReturnValue(0.75)
})

describe('Scene workflow golden characterization', () => {
    it('replays explicit Queue seeds through real wildcard resolution while unseeded legacy calls remain random', async () => {
        const { buildLegacySceneGenerationParams } = await import('@/lib/scene-generation/legacy-build-scene-params')
        const source = scene('scene-seeded-wildcards', 1, { prompts: {
            base: '<red|blue|green>', additional: '', negative: '',
        } })
        resetRuntime(100, [source])
        vi.mocked(Math.random).mockReturnValue(0.01)
        const reviewed = await buildLegacySceneGenerationParams(source, { presetId: PRESET_ID, seed: 123 })
        vi.mocked(Math.random).mockReturnValue(0.99)
        const replayed = await buildLegacySceneGenerationParams(source, { presetId: PRESET_ID, seed: 123 })
        expect(replayed.finalPrompt).toBe(reviewed.finalPrompt)
        expect(replayed.params.seed).toBe(123)
        vi.mocked(Math.random).mockReturnValue(0.01)
        const unseededFirst = await buildLegacySceneGenerationParams(source)
        vi.mocked(Math.random).mockReturnValue(0.99)
        const unseededSecond = await buildLegacySceneGenerationParams(source)
        expect(unseededFirst.finalPrompt).not.toBe(unseededSecond.finalPrompt)
        expect(runtimeCapture.requests).toHaveLength(0)
    })

    it('matches real builder, worker, payload, queue, cancellation and save behavior', async () => {
        const scenarios: Array<Record<string, unknown>> = []

        resetRuntime(101, [scene('scene-1', 2)])
        runtimeCapture.behaviors.push('success', 'success')
        await runtime.sceneTest.workerLoop(1, 'synthetic-slot-1', context(101, true))
        const firstPayload = firstRequestSummary()
        scenarios.push(redactedGolden({
            name: 'streaming queue-two with scene resolution override',
            composition: firstComposition(),
            transport: {
                mode: runtimeCapture.requests[0]?.mode,
                requestCount: runtimeCapture.requests.length,
                allPayloadsMatchFirst: runtimeCapture.requests.every(request => (
                    JSON.stringify(summarizeCapturedRequest(request).payload) === JSON.stringify(firstPayload)
                )),
            },
            payloadRedactedSummary: firstPayload,
            output: summarizeOutput(),
            metadata: firstMetadata(),
            finalState: summarizeFinalState(),
            callOrder: [...runtimeCapture.calls],
        }))

        resetRuntime(102, [scene('scene-rotation', 1, { excludePinned: true, name: 'Rotation Scene' })])
        runtime.useRotationStore.setState({
            status: 'generating_pass',
            active: true,
            paused: false,
            awaitingWorker: false,
            resting: false,
            characterIds: ['rotation-character'],
            pinnedCharacterIds: ['pinned-character'],
            currentIndex: 0,
            snapshot: {
                presetId: PRESET_ID,
                queueCounts: { 'scene-rotation': 1 },
                enabledStates: { 'rotation-character': true, 'pinned-character': true },
            },
        })
        runtime.useSettingsStore.setState({ useStreaming: false })
        await runtime.sceneTest.workerLoop(1, 'synthetic-slot-1', context(102, false, true))
        scenarios.push(redactedGolden({
            name: 'rotation excludes pinned character',
            composition: firstComposition(),
            transport: { mode: runtimeCapture.requests[0]?.mode, requestCount: runtimeCapture.requests.length },
            payloadRedactedSummary: firstRequestSummary(),
            output: summarizeOutput(),
            metadata: firstMetadata(),
            finalState: summarizeFinalState('scene-rotation'),
            callOrder: [...runtimeCapture.calls],
        }))

        resetRuntime(103, [scene('scene-1', 2)])
        runtime.useSettingsStore.setState({ useStreaming: false })
        await Promise.all([
            runtime.sceneTest.workerLoop(1, 'synthetic-slot-1', context(103, false)),
            runtime.sceneTest.workerLoop(2, 'synthetic-slot-2', context(103, false)),
        ])
        scenarios.push(redactedGolden({
            name: 'non-streaming-multiple-workers-claim-queue-two',
            composition: firstComposition(),
            transport: {
                modes: runtimeCapture.requests.map(request => request.mode),
                requestCount: runtimeCapture.requests.length,
                fixedSeeds: runtimeCapture.params.map(params => params.seed),
            },
            payloadRedactedSummary: firstRequestSummary(),
            output: summarizeOutput(),
            metadata: firstMetadata(),
            finalState: summarizeFinalState(),
            callOrder: summarizeConcurrentCallOrder(),
        }))

        resetRuntime(104, [scene('scene-failure', 1)])
        runtime.useSettingsStore.setState({ useStreaming: false })
        runtimeCapture.behaviors.push('http-400')
        await runtime.sceneTest.workerLoop(1, 'synthetic-slot-1', context(104, false))
        scenarios.push(redactedGolden({
            name: 'api-failure-reinserts-queue-item',
            composition: firstComposition(),
            transport: { mode: runtimeCapture.requests[0]?.mode, requestCount: runtimeCapture.requests.length, status: 400 },
            payloadRedactedSummary: firstRequestSummary(),
            output: summarizeOutput(),
            metadata: { persisted: false },
            finalState: summarizeFinalState('scene-failure'),
            callOrder: [...runtimeCapture.calls],
        }))

        resetRuntime(105, [scene('scene-cancel', 1)])
        runtime.useSettingsStore.setState({ useStreaming: false })
        runtimeCapture.behaviors.push('deferred-success')
        const cancelledWorker = runtime.sceneTest.workerLoop(1, 'synthetic-slot-1', context(105, false))
        await vi.waitFor(() => expect(runtimeCapture.deferredResolve).not.toBeNull())
        runtimeCapture.calls.push('session:cancel-requested')
        runtime.useSceneStore.getState().cancelSceneGeneration()
        runtimeCapture.deferredResolve?.(makeSuccessResponse('non-streaming'))
        await cancelledWorker
        scenarios.push(redactedGolden({
            name: 'session-cancel-after-dequeue-discards-without-reinsert',
            composition: firstComposition(),
            transport: { mode: runtimeCapture.requests[0]?.mode, requestCount: runtimeCapture.requests.length },
            payloadRedactedSummary: firstRequestSummary(),
            output: summarizeOutput(),
            metadata: { persisted: false },
            finalState: summarizeFinalState('scene-cancel'),
            callOrder: [...runtimeCapture.calls],
        }))

        const source = await readFile('src/hooks/useSceneGeneration.ts', 'utf8')
        expect(source).toContain('const workerTokens = streamingView && !sourceEditActive ? tokens.slice(0, 1) : tokens')
        expect(source.match(/isSessionAlive\(ctx\.sessionId\)/g)).toHaveLength(12)
        const saverSource = await readFile('src/lib/scene-generation/save-scene-result.ts', 'utf8')
        expect(saverSource.match(/if \(!canSave\(\)\) return false/g)).toHaveLength(1)
        expect(saverSource).toContain('canCommit: canSave')
        expect(saverSource).toContain('if (!canSave()) {')
        const actual: SceneFixture = {
            workflow: 'scene',
            captureDate: '2026-07-11',
            workerPolicy: {
                streamingWithoutSourceEdit: ['first-active-slot-only'],
                nonStreaming: ['all-active-slots'],
                streamingWithSourceOrMask: ['all-active-slots'],
                sourceContract: 'streamingView && !sourceEditActive ? tokens.slice(0, 1) : tokens',
            },
            guards: [
                'process entry before streaming reset',
                'after builder before transport',
                'inside streaming callback',
                'after transport before result handling',
                'before saver call',
                'saver entry, before output resolution, and after thumbnail',
                'after saver before progress update',
            ],
            nondeterminism: [
                'Unlocked or locked-zero seed uses Math.random for every queued item.',
                'Wildcards, Scene output filename suffixes and history IDs use Math.random independently of generation seed.',
                'Date.now controls sessions, filenames, image IDs and history IDs.',
                'Multiple workers claim in preset order but response/save completion order is transport-race dependent.',
                'Fixed seed can produce duplicate requests when queueCount is greater than one.',
            ],
            scenarios,
        }
        expect(actual.scenarios).toHaveLength(5)
        expect(actual.scenarios.every(item => JSON.stringify(item).includes('main base'))).toBe(false)
    })
})

describe('Scene Composition v2 caller contract', () => {
    it('uses the visible unlocked seed and advances the Scene to its next seed', async () => {
        resetRuntime(197, [scene('scene-seed-advance', 1, {
            generation: { seed: 123, seedLocked: false },
        })])
        runtime.useSceneStore.setState({ sceneCompositionMode: 'v2' })
        vi.spyOn(Math, 'random').mockReturnValue(0.25)
        runtimeCapture.behaviors.push('success')

        await runtime.sceneTest.workerLoop(1, 'synthetic-slot-1', context(197, false))

        expect(runtimeCapture.params[0]?.seed).toBe(123)
        expect(runtime.useSceneStore.getState().getScene(PRESET_ID, 'scene-seed-advance')?.generation)
            .toMatchObject({ seed: 1_073_741_823, seedLocked: false })
    })

    it('materializes a queued image filename before committing the Scene output', async () => {
        resetRuntime(196, [scene('scene-custom-name', 1, {
            generation: { seed: 456, seedLocked: true },
            filenameTemplate: 'scene-default_{seed}',
            queuedFileNames: ['opening_{seed}'],
        })])
        runtime.useSceneStore.setState({ sceneCompositionMode: 'v2' })
        runtimeCapture.behaviors.push('success')

        await runtime.sceneTest.workerLoop(1, 'synthetic-slot-1', context(196, false))

        expect(runtimeCapture.writes.some(path => path.endsWith('/opening_456.png'))).toBe(true)
        expect(runtime.useSceneStore.getState().getScene(PRESET_ID, 'scene-custom-name')).toMatchObject({
            queueCount: 0,
            queuedFileNames: undefined,
        })
    })

    it('keeps repeated Scene filenames as distinct gallery outputs', async () => {
        resetRuntime(195, [scene('scene-duplicate-names', 2, {
            generation: { seed: 789, seedLocked: true },
            queuedFileNames: ['duplicate', 'duplicate'],
        })])
        runtime.useSceneStore.setState({ sceneCompositionMode: 'v2' })
        runtimeCapture.behaviors.push('success', 'success')

        await runtime.sceneTest.workerLoop(1, 'synthetic-slot-1', context(195, false))

        expect(runtimeCapture.writes.some(path => path.endsWith('/duplicate.png'))).toBe(true)
        expect(runtimeCapture.writes.some(path => path.endsWith('/duplicate-2.png'))).toBe(true)
        const images = runtime.useSceneStore.getState()
            .getScene(PRESET_ID, 'scene-duplicate-names')?.images ?? []
        expect(new Set(images.map(image => image.url)).size).toBe(2)
    })

    it.each(['legacy', 'v2'] as const)(
        'uses multiple Scene-owned V4.5 captions and parameters under %s authority',
        async sceneCompositionMode => {
        resetRuntime(198, [scene('scene-owned', 1, {
            width: 1216,
            height: 832,
            prompts: {
                base: 'scene base',
                additional: 'scene additional',
                character: 'legacy alias must not win',
                negative: 'scene negative',
                characterNegative: 'legacy negative alias must not win',
            },
            characterCaptions: [{
                id: 'caption:heroine',
                name: 'Heroine',
                prompt: 'scene heroine',
                negative: 'heroine negative',
                enabled: true,
                position: { x: 0.25, y: 0.7 },
            }, {
                id: 'caption:partner',
                name: 'Partner',
                prompt: 'scene male partner',
                negative: 'partner negative',
                enabled: true,
                position: { x: 0.8, y: 0.7 },
            }],
            characterPositionEnabled: true,
            generation: {
                model: 'nai-diffusion-4-5-full',
                steps: 28,
                cfgScale: 7.2,
                cfgRescale: 0.1,
                sampler: 'k_euler',
                scheduler: 'karras',
                variety: true,
                qualityToggle: false,
                ucPreset: 0,
                seed: 987654,
                seedLocked: true,
            },
        })])
        runtime.useSceneStore.setState({ sceneCompositionMode })
        runtime.useGenerationStore.setState({
            basePrompt: 'must not leak',
            additionalPrompt: 'must not leak',
            negativePrompt: 'must not leak',
            model: 'nai-diffusion-4-5-full',
            steps: 1,
            cfgScale: 1,
        })

        await runtime.sceneTest.workerLoop(1, 'synthetic-slot-1', context(198, true))

        expect(runtimeCapture.params).toHaveLength(1)
        expect(runtimeCapture.params[0]).toMatchObject({
            prompt: 'scene base, scene additional',
            negative_prompt: 'scene negative',
            model: 'nai-diffusion-4-5-full',
            width: 1216,
            height: 832,
            steps: 28,
            cfg_scale: 7.2,
            cfg_rescale: 0.1,
            sampler: 'k_euler',
            scheduler: 'karras',
            smea: false,
            smea_dyn: false,
            seed: 987654,
            qualityToggle: false,
            ucPreset: 0,
            characterPositionEnabled: true,
        })
        expect(runtimeCapture.params[0]?.characterPrompts).toEqual([
            expect.objectContaining({
                stableId: 'caption:heroine',
                prompt: 'scene heroine',
                negative: 'heroine negative',
                position: { x: 0.25, y: 0.7 },
            }),
            expect.objectContaining({
                stableId: 'caption:partner',
                prompt: 'scene male partner',
                negative: 'partner negative',
                position: { x: 0.8, y: 0.7 },
            }),
        ])
        expect(runtimeCapture.params[0]?.prompt).not.toContain('must not leak')
        expect(runtimeCapture.params[0]?.characterPrompts?.[0]?.prompt).not.toContain('legacy alias')

        const payload = runtimeCapture.requests[0]?.payload
        const parameters = payload?.parameters as Record<string, any>
        expect(payload).toMatchObject({ model: 'nai-diffusion-4-5-full' })
        expect(parameters).toMatchObject({
            width: 1216,
            height: 832,
            steps: 28,
            scale: 7.2,
            cfg_rescale: 0.1,
            sampler: 'k_euler',
            noise_schedule: 'karras',
            use_coords: true,
        })
        expect(parameters).not.toHaveProperty('tag_hint_qt')
        expect(parameters.v4_prompt.caption.char_captions).toEqual([
            { char_caption: 'scene heroine', centers: [{ x: 0.25, y: 0.7 }] },
            { char_caption: 'scene male partner', centers: [{ x: 0.8, y: 0.7 }] },
        ])
        expect(parameters.v4_negative_prompt.caption.char_captions).toEqual([
            { char_caption: 'heroine negative', centers: [{ x: 0.25, y: 0.7 }] },
            { char_caption: 'partner negative', centers: [{ x: 0.8, y: 0.7 }] },
        ])
    })

    it('aborts a streaming body and releases the Scene button lock without output', async () => {
        resetRuntime(199, [scene('scene-stream-cancel', 1)])
        runtimeCapture.behaviors.push('deferred-stream')
        const worker = runtime.sceneTest.workerLoop(1, 'synthetic-slot-1', context(199, true))

        await vi.waitFor(() => expect(runtimeCapture.calls).toContain('transport:stream-body-read'))
        const requestSignal = runtimeCapture.requestSignals[0]
        runtime.useSceneStore.getState().cancelSceneGeneration()
        await worker

        expect(requestSignal?.aborted).toBe(true)
        expect(runtimeCapture.streamBodyCancelled).toBeGreaterThan(0)
        expect(runtime.useSceneStore.getState()).toMatchObject({
            isGenerating: false,
            isCancelling: false,
        })
        expect(runtime.useSceneStore.getState().getScene(PRESET_ID, 'scene-stream-cancel')?.images).toHaveLength(0)
        expect(runtimeCapture.calls.some(call => call.startsWith('output:'))).toBe(false)
    })

    it('aborts the active HTTP request and unlocks without queue resurrection or late output', async () => {
        resetRuntime(200, [scene('scene-network-cancel', 1)])
        runtime.useSettingsStore.setState({ useStreaming: false })
        runtimeCapture.behaviors.push('deferred-success')
        const worker = runtime.sceneTest.workerLoop(1, 'synthetic-slot-1', context(200, false))

        await vi.waitFor(() => expect(runtimeCapture.deferredResolve).not.toBeNull())
        const requestSignal = runtimeCapture.requestSignals[0]

        try {
            expect(requestSignal).toBeDefined()
            expect(requestSignal?.aborted).toBe(false)
            runtime.useSceneStore.getState().cancelSceneGeneration()
            await worker

            expect(requestSignal?.aborted).toBe(true)
            expect(runtime.useSceneStore.getState().isGenerating).toBe(false)
            expect(runtime.useSceneStore.getState().isCancelling).toBe(false)
            expect(runtime.useSceneStore.getState().getScene(PRESET_ID, 'scene-network-cancel')?.queueCount).toBe(0)
            expect(runtime.useSceneStore.getState().getScene(PRESET_ID, 'scene-network-cancel')?.images).toHaveLength(0)
            expect(runtime.useGenerationStore.getState().history).toHaveLength(0)
            expect(runtimeCapture.calls.some(call => call.startsWith('output:'))).toBe(false)
            expect(runtimeCapture.writes).toHaveLength(0)
        } finally {
            runtimeCapture.deferredResolve?.(makeSuccessResponse('non-streaming'))
            await worker
        }
    })

    it('releases the shared generation mode when the cancellation effect runs before the last worker finalizes', async () => {
        resetRuntime(201, [scene('scene-cancel-effect-race', 1)])
        runtime.useSettingsStore.setState({ useStreaming: false })
        runtimeCapture.behaviors.push('deferred-success')
        const worker = runtime.sceneTest.workerLoop(1, 'synthetic-slot-1', context(201, false))

        await vi.waitFor(() => expect(runtimeCapture.deferredResolve).not.toBeNull())
        runtime.useSceneStore.getState().cancelSceneGeneration()

        // Model the mounted hook observing isCancelling before the aborted
        // worker's finally block runs. The UI lock remains until that worker
        // owns the final cleanup.
        expect(runtime.sceneTest.handleSceneCancellationState()).toBe(true)
        expect(runtime.useSceneStore.getState()).toMatchObject({
            isGenerating: true,
            isCancelling: true,
        })
        expect(runtime.useGenerationStore.getState().generatingMode).toBe('scene')
        await worker

        expect(runtime.useSceneStore.getState()).toMatchObject({
            isGenerating: false,
            isCancelling: false,
        })
        expect(runtime.useGenerationStore.getState().generatingMode).toBeNull()
        expect(runtime.useSceneStore.getState().getScene(PRESET_ID, 'scene-cancel-effect-race')?.queueCount).toBe(0)
        expect(runtime.useSceneStore.getState().getScene(PRESET_ID, 'scene-cancel-effect-race')?.images).toHaveLength(0)
        expect(runtime.useGenerationStore.getState().history).toHaveLength(0)
        expect(runtimeCapture.writes).toHaveLength(0)
    })

    it('releases an orphaned Scene cancellation when no worker can own final cleanup', () => {
        resetRuntime(202, [scene('scene-cancel-without-worker', 1)])
        runtime.useSceneStore.getState().cancelSceneGeneration()

        expect(runtime.useSceneStore.getState()).toMatchObject({
            isGenerating: true,
            isCancelling: true,
        })
        expect(runtime.sceneTest.handleSceneCancellationState()).toBe(true)
        expect(runtime.useSceneStore.getState()).toMatchObject({
            isGenerating: false,
            isCancelling: false,
        })
        expect(runtime.useGenerationStore.getState().generatingMode).toBeNull()
        expect(runtime.useSceneStore.getState().getScene(PRESET_ID, 'scene-cancel-without-worker')?.queueCount).toBe(1)
        expect(runtime.useSceneStore.getState().getScene(PRESET_ID, 'scene-cancel-without-worker')?.images).toHaveLength(0)
        expect(runtime.useGenerationStore.getState().history).toHaveLength(0)
        expect(runtimeCapture.requests).toHaveLength(0)
        expect(runtimeCapture.writes).toHaveLength(0)
    })

    it('keeps 429 automatically retryable but preserves timed-out work in the queue without an automatic retry', () => {
        expect(runtime.sceneTest.classifyProcessError(new NovelAIHttpError(429, 'synthetic'))).toMatchObject({
            status: 'retryable',
        })
        expect(runtime.sceneTest.classifyProcessError('timed out', 'timeout')).toMatchObject({
            status: 'fatal',
        })
    })

    it('keeps queueCount two on the streaming single-worker path and records a stable plan hash', async () => {
        resetRuntime(201, [scene('scene-v2', 2)])
        runtime.useSceneStore.setState({ sceneCompositionMode: 'v2' })

        await runtime.sceneTest.workerLoop(1, 'synthetic-slot-1', context(201, true))

        expect(runtimeCapture.requests).toHaveLength(2)
        expect(runtimeCapture.requests.map(request => request.mode)).toEqual(['streaming', 'streaming'])
        expect(runtimeCapture.params.map(params => params.promptParts?.additional)).toEqual([
            'rainy rooftop',
            'rainy rooftop',
        ])
        expect(runtimeCapture.params[0]?.prompt).toBe('rainy rooftop')
        expect(runtimeCapture.params.map(params => params.compositionPlanHash?.digest)).toEqual([
            runtimeCapture.params[0]?.compositionPlanHash?.digest,
            runtimeCapture.params[0]?.compositionPlanHash?.digest,
        ])
        expect(runtime.useSceneStore.getState().getScene(PRESET_ID, 'scene-v2')?.queueCount).toBe(0)
        expect(runtime.useSceneStore.getState().sceneCompositionResults['scene-v2']).toMatchObject({
            mode: 'v2',
            warnings: [],
            errors: [],
        })
        expect(runtime.useSceneStore.getState().sceneCompositionResults['scene-v2']?.planHash?.digest).toBeTruthy()
    })

    it('ignores stale recipe references because Scene prompts are direct authority', async () => {
        resetRuntime(202, [
            scene('scene-invalid', 1, {
                compositionRef: {
                    recipeId: 'missing-recipe',
                    migrationMarker: { kind: 'legacy-scene-prompt', schemaVersion: 2 },
                },
            }),
            scene('scene-invalid-target', 1, {
                compositionRef: {
                    recipeId: SCENE_DIRECT_RECIPE_ID,
                    selectionKind: 'direct',
                    sceneContributions: [{
                        id: 'scene:invalid-target:contribution',
                        orderKey: 'scene:invalid-target',
                        revision: 0,
                        createdAt: new Date(FIXED_TIME).toISOString(),
                        createdBy: { kind: 'user', id: 'scene-test:user' },
                        updatedAt: new Date(FIXED_TIME).toISOString(),
                        updatedBy: { kind: 'user', id: 'scene-test:user' },
                        enabled: true,
                        target: { kind: 'not-a-target' },
                        text: 'must not reach prompt composition',
                        merge: 'append',
                    }],
                    migrationMarker: { kind: 'legacy-scene-prompt', schemaVersion: 2 },
                },
            }),
            scene('scene-valid', 1, {
                compositionRef: {
                    recipeId: SCENE_DIRECT_RECIPE_ID,
                    selectionKind: 'direct',
                    migrationMarker: { kind: 'legacy-scene-prompt', schemaVersion: 2 },
                },
            }),
        ])
        runtime.useSceneStore.setState({ sceneCompositionMode: 'v2' })

        await runtime.sceneTest.workerLoop(1, 'synthetic-slot-1', context(202, false))

        expect(runtimeCapture.requests).toHaveLength(3)
        expect(runtime.useSceneStore.getState().getScene(PRESET_ID, 'scene-invalid')?.queueCount).toBe(0)
        expect(runtime.useSceneStore.getState().getScene(PRESET_ID, 'scene-invalid')?.images).toHaveLength(1)
        expect(runtime.useSceneStore.getState().getScene(PRESET_ID, 'scene-invalid-target')?.images).toHaveLength(1)
        expect(runtime.useSceneStore.getState().getScene(PRESET_ID, 'scene-valid')?.images).toHaveLength(1)
        expect(runtime.useSceneStore.getState().sceneCompositionResults['scene-invalid']?.errors).toEqual([])
        expect(runtime.useSceneStore.getState().sceneCompositionResults['scene-invalid-target']?.errors).toEqual([])
    })

    it('checks the session before resolving or sending the API request', async () => {
        resetRuntime(203, [scene('scene-cancel-before-api', 1)])
        runtime.useSceneStore.setState({
            sceneCompositionMode: 'v2',
            generationSessionId: 204,
        })

        const result = await runtime.sceneTest.processSceneWithSlot(
            1,
            'synthetic-slot-1',
            scene('scene-cancel-before-api', 1),
            context(203, false),
        )

        expect(result.status).toBe('cancelled')
        expect(runtimeCapture.requests).toHaveLength(0)
        expect(runtimeCapture.calls).not.toContain('images:ensure-loaded')
    })

    it('runs shadow diagnostics without issuing a second request or changing the legacy payload', async () => {
        resetRuntime(205, [scene('scene-shadow', 1)])
        runtime.useSceneStore.setState({ sceneCompositionMode: 'shadow' })

        await runtime.sceneTest.workerLoop(1, 'synthetic-slot-1', context(205, false))

        expect(runtimeCapture.requests).toHaveLength(1)
        expect(runtimeCapture.params).toHaveLength(1)
        expect(runtimeCapture.params[0]?.compositionMode).toBe('shadow')
        expect(runtime.useSceneStore.getState().sceneCompositionResults['scene-shadow']).toMatchObject({
            mode: 'shadow',
            errors: [],
        })
        expect(runtime.useSceneStore.getState().sceneCompositionResults['scene-shadow']?.planHash?.digest).toBeTruthy()
    })

    it('commits a sequential proposal only after a successful API result', async () => {
        const configureSequentialFragment = () => runtime.useFragmentStore.setState({
            files: [{
                id: 'fragment-sequence',
                name: 'sequence',
                folder: '',
                lineCount: 2,
                createdAt: FIXED_TIME,
                updatedAt: FIXED_TIME,
            }],
            sequentialCounters: { sequence: 0 },
            sequenceState: { schemaVersion: 1, revision: 0, counters: {} },
            loadFileContent: async () => ['first', 'second'],
        })

        resetRuntime(206, [scene('scene-sequence-failure', 1, { prompts: { base: '<*sequence>' } })])
        runtime.useSceneStore.setState({ sceneCompositionMode: 'v2' })
        configureSequentialFragment()
        runtimeCapture.behaviors.push('http-400')

        await runtime.sceneTest.workerLoop(1, 'synthetic-slot-1', context(206, false))

        expect(runtime.useFragmentStore.getState().sequentialCounters.sequence).toBe(0)
        expect(runtime.useSceneStore.getState().getScene(PRESET_ID, 'scene-sequence-failure')?.queueCount).toBe(1)

        resetRuntime(207, [scene('scene-sequence-success', 1, { prompts: { base: '<*sequence>' } })])
        runtime.useSceneStore.setState({ sceneCompositionMode: 'v2' })
        configureSequentialFragment()

        await runtime.sceneTest.workerLoop(1, 'synthetic-slot-1', context(207, false))

        expect(runtimeCapture.requests).toHaveLength(1)
        expect(runtime.useFragmentStore.getState().sequentialCounters.sequence).toBe(1)
        expect(runtime.useFragmentStore.getState().sequenceState.counters['fragment-sequence']).toBe(1)
        expect(runtimeCapture.params[0]?.prompt).toContain('first')

        resetRuntime(209, [scene('scene-legacy-sequence-failure', 1, { prompts: { base: '<*sequence>' } })])
        runtime.useSceneStore.setState({ sceneCompositionMode: 'legacy' })
        configureSequentialFragment()
        runtimeCapture.behaviors.push('http-400')

        await runtime.sceneTest.workerLoop(1, 'synthetic-slot-1', context(209, false))

        expect(runtime.useFragmentStore.getState().getSequenceSnapshot().counters['fragment-sequence']).toBe(0)
        expect(runtime.useSceneStore.getState().getScene(PRESET_ID, 'scene-legacy-sequence-failure')?.queueCount).toBe(1)

        resetRuntime(210, [scene('scene-legacy-sequence-success', 1, { prompts: { base: '<*sequence>' } })])
        runtime.useSceneStore.setState({ sceneCompositionMode: 'legacy' })
        configureSequentialFragment()

        await runtime.sceneTest.workerLoop(1, 'synthetic-slot-1', context(210, false))

        expect(runtimeCapture.requests).toHaveLength(1)
        expect(runtimeCapture.params[0]?.prompt).toContain('first')
        expect(runtime.useFragmentStore.getState().getSequenceSnapshot().counters['fragment-sequence']).toBe(1)

        resetRuntime(211, [scene('scene-legacy-sequence-cancelled', 1, { prompts: { base: '<*sequence>' } })])
        runtime.useSceneStore.setState({ sceneCompositionMode: 'legacy' })
        configureSequentialFragment()
        runtimeCapture.behaviors.push('deferred-success')
        const cancelled = runtime.sceneTest.processSceneWithSlot(
            1,
            'synthetic-slot-1',
            scene('scene-legacy-sequence-cancelled', 1, { prompts: { base: '<*sequence>' } }),
            context(211, false),
        )
        await vi.waitFor(() => expect(runtimeCapture.deferredResolve).not.toBeNull())
        runtime.useSceneStore.getState().cancelSceneGeneration()
        runtimeCapture.deferredResolve?.(makeSuccessResponse('non-streaming'))

        expect((await cancelled).status).toBe('cancelled')
        expect(runtime.useFragmentStore.getState().getSequenceSnapshot().counters['fragment-sequence']).toBe(0)
    })

    it('reserves a sequential proposal before transport so a second worker cannot publish the same choice', async () => {
        const firstScene = scene('scene-sequence-worker-a', 1, { prompts: { base: '<*sequence>' } })
        const secondScene = scene('scene-sequence-worker-b', 1, { prompts: { base: '<*sequence>' } })
        resetRuntime(212, [firstScene, secondScene])
        runtime.useSceneStore.setState({ sceneCompositionMode: 'legacy' })
        runtime.useFragmentStore.setState({
            files: [{
                id: 'fragment-sequence-workers',
                name: 'sequence',
                folder: '',
                lineCount: 2,
                createdAt: FIXED_TIME,
                updatedAt: FIXED_TIME,
            }],
            sequentialCounters: { sequence: 0 },
            sequenceState: { schemaVersion: 1, revision: 0, counters: {} },
            loadFileContent: async () => ['first', 'second'],
        })
        runtimeCapture.behaviors.push('deferred-success')

        const firstWorker = runtime.sceneTest.processSceneWithSlot(
            1,
            'synthetic-slot-1',
            firstScene,
            context(212, false),
        )
        await vi.waitFor(() => expect(runtimeCapture.deferredResolve).not.toBeNull())
        const secondResult = await runtime.sceneTest.processSceneWithSlot(
            2,
            'synthetic-slot-2',
            secondScene,
            context(212, false),
        )

        expect(secondResult.status).toBe('retryable')
        expect(runtimeCapture.requests).toHaveLength(1)
        expect(runtime.useFragmentStore.getState().getSequenceSnapshot().counters['fragment-sequence-workers']).toBe(0)

        runtimeCapture.deferredResolve?.(makeSuccessResponse('non-streaming'))
        expect((await firstWorker).status).toBe('success')
        expect(runtime.useFragmentStore.getState().getSequenceSnapshot().counters['fragment-sequence-workers']).toBe(1)
        expect(runtime.useSceneStore.getState().getScene(PRESET_ID, firstScene.id)?.images).toHaveLength(1)
        expect(runtime.useSceneStore.getState().getScene(PRESET_ID, secondScene.id)?.images).toHaveLength(0)
    })

    it('keeps rotation filtering active when v2 materializes character prompts', async () => {
        resetRuntime(208, [scene('scene-v2-rotation', 1, {
            excludePinned: true,
            generation: { seed: FIXED_SEED, seedLocked: true },
        })])
        runtime.useSceneStore.setState({ sceneCompositionMode: 'v2' })
        runtime.useRotationStore.setState({
            status: 'generating_pass',
            active: true,
            paused: false,
            awaitingWorker: false,
            resting: false,
            characterIds: ['rotation-character'],
            pinnedCharacterIds: ['pinned-character'],
            currentIndex: 0,
            snapshot: {
                presetId: PRESET_ID,
                queueCounts: { 'scene-v2-rotation': 1 },
                enabledStates: { 'rotation-character': true, 'pinned-character': true },
            },
        })

        await runtime.sceneTest.workerLoop(1, 'synthetic-slot-1', context(208, false, true))

        expect(runtimeCapture.params).toHaveLength(1)
        expect(runtimeCapture.params[0]?.characterPrompts).toHaveLength(1)
        expect(runtimeCapture.params[0]?.characterPrompts?.[0]).toMatchObject({
            enabled: true,
            negative: 'hero negative',
            position: { x: 0.25, y: 0.75 },
        })
        expect(runtimeCapture.params[0]?.characterPrompts?.[0]?.prompt).toContain('hero')
        expect(runtimeCapture.params[0]?.characterPrompts?.some(character => character.prompt === 'guide')).toBe(false)
        expect(runtimeCapture.params[0]?.compositionRandomTrace).toContainEqual(expect.objectContaining({
            streamKey: 'rotation-store-sequence',
            drawIndex: 0,
            seed: FIXED_SEED,
            result: 'rotation-character',
            extensions: expect.objectContaining({
                source: 'rotation-store-sequence',
                seedAffectsSelection: false,
            }),
        }))
    })

    it('materializes the source snapshot that produced the plan even if live state changes during hydration', async () => {
        resetRuntime(209, [scene('scene-source-snapshot', 1)])
        runtime.useSceneStore.setState({ sceneCompositionMode: 'v2' })
        let releaseHydration: (() => void) | null = null
        runtime.useCharacterStore.setState({
            ensureImagesLoaded: () => new Promise<void>(resolve => {
                releaseHydration = resolve
            }),
        })

        const worker = runtime.sceneTest.workerLoop(1, 'synthetic-slot-1', context(209, false))
        await vi.waitFor(() => expect(releaseHydration).not.toBeNull())
        runtime.useGenerationStore.setState({ sourceImage: 'data:image/png;base64,CHANGED_AFTER_RESOLVE' })
        releaseHydration?.()
        await worker

        expect(runtimeCapture.params).toHaveLength(1)
        expect(runtimeCapture.params[0]?.sourceImage).toBeUndefined()
        expect(runtimeCapture.params[0]?.compositionPlanHash?.digest).toBeTruthy()
    })
})
