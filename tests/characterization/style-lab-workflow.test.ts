import { readFile } from 'node:fs/promises'
import JSZip from 'jszip'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerationParams } from '@/services/novelai-types'
import { readNaiBlueParams, readNaiBlueSidecar } from '@/lib/nai-blue-metadata'
import type { StyleLabGenerationBuildResult } from '@/lib/style-lab/build-style-lab-params'
import type { StyleCombination } from '@/stores/style-lab-store'

import { assertDeepEqual, loadFixtureJson } from '../helpers'
import {
    type CapturedRequest,
    hashCapturedPayload,
    redactedGolden,
    summarizeCapturedRequest,
    summarizeGenerationParams,
    summarizeMetadata,
    summarizeNaiBlueMetadata,
} from './workflow-capture'

const runtimeCapture = vi.hoisted(() => ({
    calls: [] as string[],
    events: [] as Array<{ type: string; detail: Record<string, unknown> }>,
    params: [] as GenerationParams[],
    requests: [] as CapturedRequest[],
    styleBuilds: [] as StyleLabGenerationBuildResult[],
    writes: [] as Array<{ location: string; data: Uint8Array; baseDirPresent: boolean }>,
    zipBytes: new Uint8Array(),
    fetchOverride: null as null | ((input: string | URL | Request, init?: RequestInit) => Promise<Response>),
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
                runtimeCapture.writes.push({
                    location: to,
                    data: new Uint8Array(data),
                    baseDirPresent: options?.newPathBaseDir !== undefined,
                })
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

vi.mock('@/lib/style-lab/build-style-lab-params', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/style-lab/build-style-lab-params')>()
    return {
        ...actual,
        buildStyleLabGenerationParams: async (...args: Parameters<typeof actual.buildStyleLabGenerationParams>) => {
            const result = await actual.buildStyleLabGenerationParams(...args)
            runtimeCapture.styleBuilds.push(result)
            return result
        },
    }
})

const FIXED_TIME = Date.parse('2026-07-11T00:00:00.000Z')
const FIXED_SEED = 616161
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function base64Bytes(value: string): Uint8Array {
    return Uint8Array.from(atob(value.replace(/^data:image\/[^;]+;base64,/, '')), character => character.charCodeAt(0))
}

function readRawNaiBlueParams(bytes: Uint8Array): unknown {
    let offset = 8
    while (offset + 12 <= bytes.length) {
        const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false)
        const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
        if (type === 'tEXt') {
            const data = bytes.subarray(offset + 8, offset + 8 + length)
            const separator = data.indexOf(0)
            if (separator > 0 && new TextDecoder('latin1').decode(data.subarray(0, separator)) === 'nai-blue-params') {
                const encoded = new TextDecoder('latin1').decode(data.subarray(separator + 1))
                return JSON.parse(new TextDecoder().decode(base64Bytes(encoded)))
            }
        }
        offset += length + 12
    }
    return null
}

interface StyleLabFixture {
    workflow: 'style-lab'
    captureDate: string
    guards: string[]
    nondeterminism: string[]
    outputPolicy: Record<string, unknown>
    previews: Array<Record<string, unknown>>
    filesystemOutput: Record<string, unknown>
    finalQueueState: Record<string, unknown>
    callOrder: string[]
}

interface RuntimeModules {
    useAuthStore: typeof import('@/stores/auth-store').useAuthStore
    useCharacterPromptStore: typeof import('@/stores/character-prompt-store').useCharacterPromptStore
    useCharacterStore: typeof import('@/stores/character-store').useCharacterStore
    useGenerationStore: typeof import('@/stores/generation-store').useGenerationStore
    useSettingsStore: typeof import('@/stores/settings-store').useSettingsStore
    useStyleLabStore: typeof import('@/stores/style-lab-store').useStyleLabStore
    generateStyleLabPreviews: typeof import('@/services/style-lab-generation').generateStyleLabPreviews
}

interface StyleMethods {
    clearPreviewRuntime: RuntimeModules['useStyleLabStore']['getState'] extends () => infer State
        ? State extends { clearPreviewRuntime: infer Method } ? Method : never
        : never
    setPreviewQueueState: (running: boolean, total?: number, done?: number) => void
    updateCombinationPreview: (id: string, patch: Record<string, unknown>) => void
}

let runtime: RuntimeModules
let styleMethods: StyleMethods

async function capturedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const endpoint = String(input)
    const mode = endpoint.includes('generate-image-stream') ? 'streaming' : 'non-streaming'
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>
    runtimeCapture.calls.push(`transport:${mode}`)
    runtimeCapture.requests.push({ mode, endpoint, payload })
    if (runtimeCapture.fetchOverride) return runtimeCapture.fetchOverride(input, init)
    return new Response(runtimeCapture.zipBytes, { status: 200 })
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

function combo(id: string, tags: Array<Record<string, unknown>>) {
    return {
        id,
        tags,
        elo: 1200,
        legacyElo: 1200,
        wins: 0,
        losses: 0,
        ties: 0,
        battles: 0,
        legacyBattles: 0,
        favorite: false,
        legacyFavorite: false,
        locked: false,
        note: '',
        generation: 0,
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
    }
}

function resetRuntime(): void {
    runtimeCapture.calls.length = 0
    runtimeCapture.events.length = 0
    runtimeCapture.params.length = 0
    runtimeCapture.requests.length = 0
    runtimeCapture.styleBuilds.length = 0
    runtimeCapture.writes.length = 0
    runtimeCapture.files.clear()
    runtimeCapture.fetchOverride = null

    runtime.useAuthStore.setState({
        token: 'synthetic-style-token',
        isVerified: true,
        slot1Enabled: true,
        refreshAnlas: async () => {
            runtimeCapture.calls.push('anlas:refresh-slot-1')
        },
    })
    runtime.useSettingsStore.setState({
        autoSave: false,
        useStreaming: false,
        generationDelay: 0,
        imageFormat: 'png',
        metadataMode: 'strip-and-sidecar',
        styleLabSavePath: 'nai-blue-style',
        useAbsoluteStyleLabPath: false,
    })
    runtime.useGenerationStore.setState({
        basePrompt: 'portrait, <day|night>',
        additionalPrompt: 'soft light',
        detailPrompt: 'detailed eyes',
        negativePrompt: '<bad anatomy|lowres>',
        inpaintingPrompt: 'unused inpainting',
        model: 'nai-diffusion-4-5-full',
        steps: 30,
        cfgScale: 6,
        cfgRescale: 0.2,
        sampler: 'k_dpmpp_2m',
        scheduler: 'exponential',
        smea: false,
        smeaDyn: true,
        variety: true,
        seed: FIXED_SEED,
        seedLocked: true,
        selectedResolution: { label: 'Style', width: 913, height: 1001 },
        qualityToggle: true,
        ucPreset: 3,
        sourceImage: null,
        strength: 0.72,
        noise: 0.08,
        mask: null,
        i2iMode: null,
        generatingMode: null,
        isGenerating: false,
        isCancelled: false,
        styleLabCompositionMode: 'legacy',
        history: [],
    })
    runtime.useCharacterPromptStore.setState({
        positionEnabled: true,
        characters: [{
            id: 'style-character',
            name: 'Muse',
            prompt: '<smile|serious>, silver hair',
            negative: '<hat|glasses>',
            enabled: true,
            position: { x: 0.35, y: 0.65 },
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

    const combinations = [
        combo('single-artist', [{
            tag: 'Synthetic One',
            kind: 'artist',
            weight: 1,
            artist: 'Synthetic One',
        }]),
        combo('multi-artist', [{
            tag: 'Synthetic One',
            kind: 'artist',
            weight: 1.2,
            artist: 'Synthetic One',
        }, {
            tag: 'Synthetic Two',
            kind: 'artist',
            weight: 0.8,
            artist: 'Synthetic Two',
        }]),
    ]
    runtime.useStyleLabStore.setState({
        combinations,
        settings: {
            ...runtime.useStyleLabStore.getState().settings,
            promptTemplate: '{{basePrompt}}, {{artist_tags}}, {{additionalPrompt}}, {{detailPrompt}}',
            previewDelayMs: 250,
        },
        activeBattlePair: null,
        isPreviewQueueRunning: false,
        previewQueueTotal: 0,
        previewQueueDone: 0,
        setPreviewQueueState: (running, total, done) => {
            runtimeCapture.calls.push(`preview-queue:${running ? 'running' : 'stopped'}:${total ?? '-'}:${done ?? '-'}`)
            styleMethods.setPreviewQueueState(running, total, done)
        },
        updateCombinationPreview: (id, patch) => {
            runtimeCapture.calls.push(`preview-update:${id}:${Object.keys(patch).sort().join('+')}`)
            styleMethods.updateCombinationPreview(id, patch)
        },
        clearPreviewRuntime: () => {
            runtimeCapture.calls.push('preview-runtime:clear')
            styleMethods.clearPreviewRuntime()
        },
    })
}

function competitiveSnapshot(combinations: readonly StyleCombination[]): Array<Record<string, unknown>> {
    return combinations.map(combination => ({
        id: combination.id,
        tags: structuredClone(combination.tags),
        elo: combination.elo,
        wins: combination.wins,
        losses: combination.losses,
        battles: combination.battles,
        favorite: combination.favorite,
        locked: combination.locked,
        note: combination.note,
        generation: combination.generation,
        createdAt: combination.createdAt,
        updatedAt: combination.updatedAt,
    }))
}

function rankingIds(combinations: readonly StyleCombination[]): string[] {
    return [...combinations]
        .sort((left, right) => right.elo - left.elo || right.battles - left.battles || right.updatedAt - left.updatedAt)
        .map(combination => combination.id)
}

function summarizePreview(index: number, label: string): Record<string, unknown> {
    const params = runtimeCapture.params[index]
    const request = runtimeCapture.requests[index]
    if (!params || !request) throw new Error(`Missing Style Lab capture for ${label}`)
    const payload = summarizeCapturedRequest(request).payload as Record<string, unknown>
    const payloadHash = hashCapturedPayload(request)
    const metadata = summarizeMetadata(params, payloadHash)
    expect(metadata.sentPayloadHash).toBe(payloadHash)

    const combination = runtime.useStyleLabStore.getState().combinations.find(item => item.id === (
        index === 0 ? 'single-artist' : 'multi-artist'
    ))
    const event = runtimeCapture.events[index]
    const location = typeof event?.detail.path === 'string' ? event.detail.path : ''
    const eventData = event?.detail.data
    const embeddedMetadata = typeof eventData === 'string'
        ? summarizeNaiBlueMetadata(readNaiBlueParams(base64Bytes(eventData)))
        : null
    // Memory previews retain provider bytes and never pass through the output writer.
    expect(location).toMatch(/^memory:\/\//)
    expect(typeof eventData).toBe('string')
    expect(base64Bytes(eventData as string)).toEqual(base64Bytes(TINY_PNG_BASE64))
    expect(embeddedMetadata).toBeNull()

    return redactedGolden({
        name: label,
        artistTags: combination?.tags,
        composition: summarizeGenerationParams(params),
        transport: {
            mode: request.mode,
            endpoint: request.endpoint,
        },
        payloadRedactedSummary: payload,
        output: {
            policy: location.startsWith('memory://') ? 'memory' : 'filesystem',
            fileName: location.split('/').at(-1) || null,
            eventIncludesImageData: Boolean(event?.detail.data),
        },
        metadata: {
            qualityToggle: metadata.qualityToggle,
            ucPreset: metadata.ucPreset,
            promptParts: metadata.promptParts,
            assetModulePlan: metadata.assetModulePlan,
            sentPayloadMatchesTransport: true,
            configuredMetadataModeIgnoredByStyleParams: params.metadataMode === undefined,
            embeddedInOutput: embeddedMetadata !== null,
            embeddedMatchesPlanned: false,
        },
        finalPreviewState: {
            previewLocation: combination?.previewPath,
            previewImagePresent: Boolean(combination?.previewImage),
            previewThumbnailPresent: Boolean(combination?.previewThumbnail),
            previewSeed: combination?.previewSeed,
            previewPrompt: combination?.previewPrompt,
            previewProgress: combination?.previewProgress ?? 0,
            isPreviewing: combination?.isPreviewing ?? false,
            previewError: combination?.previewError ?? null,
        },
    })
}

function summarizeFilesystemOutput(): Record<string, unknown> {
    const params = runtimeCapture.params[0]
    const request = runtimeCapture.requests[0]
    const event = runtimeCapture.events[0]
    const write = runtimeCapture.writes.find(item => /\.(png|webp)$/i.test(item.location))
    const sidecarWrite = runtimeCapture.writes.find(item => item.location.endsWith('.nai-blue.json'))
    const history = runtime.useGenerationStore.getState().history[0]
    if (!params || !request || !event || !write || !history) {
        throw new Error('Missing Style Lab filesystem capture')
    }

    const payload = summarizeCapturedRequest(request).payload as Record<string, unknown>
    const sentPayloadSummary = typeof history.sentPayloadSummary === 'string'
        ? history.sentPayloadSummary
        : undefined
    const metadata = summarizeMetadata(params, sentPayloadSummary)
    const persistedMetadata = summarizeNaiBlueMetadata(sidecarWrite ? readNaiBlueSidecar(sidecarWrite.data) : null)
    // The mocked browser runtime uses the portable app-data output root.
    const expectedResolvedPath = `C:/Synthetic/AppData/${write.location}`

    expect(metadata.sentPayloadHash).toBe(hashCapturedPayload(request))
    expect(persistedMetadata).toEqual(metadata)
    expect(event.detail.path).toBe(expectedResolvedPath)
    expect(history.url).toBe(expectedResolvedPath)

    return redactedGolden({
        policy: 'platform media root / configured style root',
        fileName: write.location.split('/').at(-1) || null,
        targetSegments: write.location.split('/').slice(0, -1),
        baseDirectoryUsed: write.baseDirPresent,
        generatedFileCount: runtimeCapture.writes.filter(item => /\.(png|webp)$/i.test(item.location)).length,
        sidecarFileCount: runtimeCapture.writes.filter(item => item.location.endsWith('.nai-blue.json')).length,
        eventIncludesImageData: Boolean(event.detail.data),
        resolvedPathMatchesMockPlatformRoot: event.detail.path === expectedResolvedPath,
        historyUrlMatchesEvent: history.url === event.detail.path,
        historyCount: runtime.useGenerationStore.getState().history.length,
        metadata: {
            qualityToggle: metadata.qualityToggle,
            ucPreset: metadata.ucPreset,
            promptParts: metadata.promptParts,
            sentPayloadMatchesTransport: true,
            configuredMetadataModeIgnoredByStyleParams: params.metadataMode === undefined,
            embeddedInWrittenImage: readNaiBlueParams(write.data) !== null,
            embeddedMatchesPlanned: persistedMetadata !== null,
        },
        callOrder: [...runtimeCapture.calls],
    })
}

beforeAll(async () => {
    installBrowserBoundary()
    const zip = new JSZip()
    zip.file('image.png', base64Bytes(TINY_PNG_BASE64))
    runtimeCapture.zipBytes = await zip.generateAsync({ type: 'uint8array' })

    const [authStore, characterPromptStore, characterStore, generationStore, settingsStore, styleStore, styleGeneration] = await Promise.all([
        import('@/stores/auth-store'),
        import('@/stores/character-prompt-store'),
        import('@/stores/character-store'),
        import('@/stores/generation-store'),
        import('@/stores/settings-store'),
        import('@/stores/style-lab-store'),
        import('@/services/style-lab-generation'),
    ])
    runtime = {
        useAuthStore: authStore.useAuthStore,
        useCharacterPromptStore: characterPromptStore.useCharacterPromptStore,
        useCharacterStore: characterStore.useCharacterStore,
        useGenerationStore: generationStore.useGenerationStore,
        useSettingsStore: settingsStore.useSettingsStore,
        useStyleLabStore: styleStore.useStyleLabStore,
        generateStyleLabPreviews: styleGeneration.generateStyleLabPreviews,
    }
    const initialStyleState = runtime.useStyleLabStore.getState()
    styleMethods = {
        clearPreviewRuntime: initialStyleState.clearPreviewRuntime,
        setPreviewQueueState: initialStyleState.setPreviewQueueState,
        updateCombinationPreview: initialStyleState.updateCombinationPreview as StyleMethods['updateCombinationPreview'],
    }
})

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(FIXED_TIME)
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_TIME)
    vi.spyOn(Math, 'random').mockReturnValue(0.75)
    resetRuntime()
})

describe('Style Lab workflow golden characterization', () => {
    it('matches sequential single/multi-artist preview composition and payload behavior', async () => {
        await runtime.generateStyleLabPreviews(['single-artist', 'multi-artist', 'single-artist'])

        expect(runtimeCapture.requests).toHaveLength(2)
        const styleState = runtime.useStyleLabStore.getState()
        const memoryOutputPolicy = {
            autoSaveOff: 'memory://NAI_Blue_STYLELAB_<seed>.<format>',
            autoSaveOn: 'configured style root or nai-blue-style / NAI_Blue_STYLELAB_<seed>.<format>',
            memoryEventsIncludeImageData: true,
            memoryOutputAddsHistory: false,
            capturedEventCount: runtimeCapture.events.length,
            sharedSeedFilenameCollisionObserved: new Set(runtimeCapture.events.map(event => event.detail.path)).size === 1,
        }
        const memoryPreviews = [
            summarizePreview(0, 'single artist combination'),
            summarizePreview(1, 'multiple artist combination'),
        ]
        const memoryFinalQueueState = {
            isPreviewQueueRunning: styleState.isPreviewQueueRunning,
            previewQueueTotal: styleState.previewQueueTotal,
            previewQueueDone: styleState.previewQueueDone,
            generatingMode: runtime.useGenerationStore.getState().generatingMode,
            isGenerating: runtime.useGenerationStore.getState().isGenerating,
            historyCount: runtime.useGenerationStore.getState().history.length,
        }
        const memoryCallOrder = [...runtimeCapture.calls]

        resetRuntime()
        runtime.useSettingsStore.setState({ autoSave: true, useStreaming: false })
        await runtime.generateStyleLabPreviews(['single-artist'])

        expect(runtimeCapture.requests).toHaveLength(1)
        expect(runtimeCapture.writes).toHaveLength(2)
        expect(runtimeCapture.events).toHaveLength(1)
        expect(runtime.useGenerationStore.getState().history).toHaveLength(1)
        const filesystemOutput = summarizeFilesystemOutput()

        const source = await readFile('src/services/style-lab-generation.ts', 'utf8')
        expect(source.match(/isStyleLabSessionCancelled\(abortController\.signal\)/g)).toHaveLength(7)
        expect(source.match(/generationSessionId/g)).toHaveLength(2)
        expect(source).toContain(
            "return signal.aborted || generationState.isCancelled || generationState.generatingMode !== 'styleLab'",
        )

        const actual: StyleLabFixture = {
            workflow: 'style-lab',
            captureDate: '2026-07-11',
            guards: [
                'loop entry before combination lookup',
                'after builder before transport',
                'inside streaming callback when streaming is enabled',
                'after transport before result validation',
                'catch path before preview error update',
                'after inter-preview delay before the next loop iteration',
                'no session-id guard and no guard between thumbnail/save awaits',
            ],
            nondeterminism: [
                'Date.now and Math.random create combination IDs; injected fixture IDs avoid that path.',
                'Random combination selection, tag ordering, weights, evolution and generation seed use Math.random.',
                'Composition wildcard selection uses the generation seed and combination scope.',
                'Locked seed is reused for every preview, including deterministic zero.',
                'A shared seed gives multiple previews the same default memory filename.',
                'Date.now supplies generationSessionId, saved history id, and combination update timestamps; new Date supplies the history timestamp.',
                'Each preview rereads live Main/character/settings stores, so mid-queue edits affect later requests.',
            ],
            outputPolicy: memoryOutputPolicy,
            previews: memoryPreviews,
            filesystemOutput,
            finalQueueState: memoryFinalQueueState,
            callOrder: memoryCallOrder,
        }
        const fixture = await loadFixtureJson<StyleLabFixture>('workflows/stylelab/current-workflow.json')
        assertDeepEqual(actual, fixture, 'Style Lab workflow behavior changed')
        expect(actual.previews).toHaveLength(2)
    })
})

describe('Style Lab Composition v2 production caller contract', () => {
    it('accepts legacy mode inputs with the same V2 payload and evaluation context', async () => {
        const { buildStyleLabGenerationParams } = await import('@/lib/style-lab/build-style-lab-params')
        const { captureCurrentStyleEvaluationContext } = await import(
            '@/services/style-lab/capture-evaluation-context'
        )
        const combination = runtime.useStyleLabStore.getState().combinations[0]
        const options = { seed: FIXED_SEED, now: new Date(FIXED_TIME), requestId: 'mode-compatibility' }
        const legacyContext = captureCurrentStyleEvaluationContext([FIXED_SEED], FIXED_TIME)
        const legacyInput = await buildStyleLabGenerationParams(combination, { ...options, mode: 'legacy' })
        expect(runtime.useGenerationStore.getState().styleLabCompositionMode).toBe('legacy')

        runtime.useGenerationStore.setState({ styleLabCompositionMode: 'v2' })
        const canonicalInput = await buildStyleLabGenerationParams(combination, { ...options, mode: 'v2' })
        expect(legacyInput).toMatchObject({ success: true, mode: 'v2', plan: expect.any(Object) })
        expect(legacyInput).toEqual(canonicalInput)
        expect(legacyContext).toEqual(captureCurrentStyleEvaluationContext([FIXED_SEED], FIXED_TIME))
    })

    it('renders an Arena pair with one immutable context and shared seed', async () => {
        runtime.useGenerationStore.setState({
            styleLabCompositionMode: 'v2',
            seedLocked: false,
        })
        const { captureCurrentStyleEvaluationContext } = await import(
            '@/services/style-lab/capture-evaluation-context'
        )
        const context = captureCurrentStyleEvaluationContext([987654321], FIXED_TIME)

        await runtime.generateStyleLabPreviews(
            ['single-artist', 'multi-artist'],
            { evaluationContext: context },
        )

        expect(runtimeCapture.styleBuilds).toHaveLength(2)
        expect(runtimeCapture.styleBuilds.every(build => build.success && build.seed === 987654321)).toBe(true)
        expect(runtimeCapture.params.map(params => params.seed)).toEqual([987654321, 987654321])
        expect(runtime.useStyleLabStore.getState().combinations.map(combination => (
            combination.previewContextId
        ))).toEqual([context.id, context.id])
    })

    it('records deterministic batch plans without changing artist competition state or ranking', async () => {
        runtime.useGenerationStore.setState({ styleLabCompositionMode: 'v2' })
        runtime.useStyleLabStore.setState(state => ({
            combinations: state.combinations.map((combination, index) => ({
                ...combination,
                elo: index === 0 ? 1325 : 1180,
                wins: index === 0 ? 4 : 1,
                losses: index === 0 ? 1 : 3,
                battles: index === 0 ? 5 : 4,
                favorite: index === 0,
                locked: index === 1,
                note: index === 0 ? 'front-runner' : 'challenger',
                generation: index + 2,
            })),
        }))
        const initialCombinations = runtime.useStyleLabStore.getState().combinations
        const competitionBefore = competitiveSnapshot(initialCombinations)
        const rankingBefore = rankingIds(initialCombinations)

        await runtime.generateStyleLabPreviews(['single-artist', 'multi-artist'])

        expect(runtimeCapture.requests).toHaveLength(2)
        expect(runtimeCapture.styleBuilds).toHaveLength(2)
        for (const [index, combinationId] of ['single-artist', 'multi-artist'].entries()) {
            const build = runtimeCapture.styleBuilds[index]
            expect(build?.success).toBe(true)
            if (!build?.success || build.plan === null || build.combinationProvenance === null) {
                throw new Error(`Missing production v2 plan for ${combinationId}`)
            }

            const { plan } = build
            const provenance = build.combinationProvenance
            const params = runtimeCapture.params[index]
            expect(build.mode).toBe('v2')
            expect(build.sourceRevision).toBe(plan.documentRevision)
            expect(plan.planHash.digest).toMatch(/^[0-9a-f]{64}$/)
            expect(provenance).toMatchObject({
                combinationId,
                recipeId: plan.recipeId,
            })
            expect(provenance.orderedTagDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
            expect(plan.provenance).toContainEqual(expect.objectContaining({
                kind: 'entity',
                entityKind: 'recipe',
                entityId: provenance.recipeId,
                revision: build.sourceRevision,
            }))
            expect(plan.randomTrace).toContainEqual(expect.objectContaining({
                result: combinationId,
                provenance: expect.objectContaining({
                    kind: 'external',
                    source: `style-lab:artist-combination:${combinationId}`,
                    digest: provenance.orderedTagDigest,
                }),
            }))
            expect(plan.randomTrace.length).toBeGreaterThan(1)
            expect(params).toMatchObject({
                prompt: plan.positivePrompt,
                negative_prompt: plan.negativePrompt,
                model: plan.params.model,
                width: plan.params.width,
                height: plan.params.height,
                steps: plan.params.steps,
                cfg_scale: plan.params.cfgScale,
                cfg_rescale: plan.params.cfgRescale,
                sampler: plan.params.sampler,
                scheduler: plan.params.scheduler,
                smea: plan.params.smea,
                smea_dyn: plan.params.smeaDyn,
                variety: plan.params.variety,
                seed: plan.params.seed,
                qualityToggle: plan.params.qualityToggle,
                ucPreset: plan.params.ucPreset,
                compositionMode: 'v2',
                compositionPlanHash: plan.planHash,
                compositionPlanId: plan.planId,
                compositionRecipeId: plan.recipeId,
                compositionRandomTrace: plan.randomTrace,
            })

            const eventData = runtimeCapture.events[index]?.detail.data
            expect(typeof eventData).toBe('string')
            const embeddedBytes = typeof eventData === 'string' ? base64Bytes(eventData) : null
            const rawEmbedded = embeddedBytes === null ? null : readRawNaiBlueParams(embeddedBytes)
            expect(params.metadataMode).toBe('strip-and-sidecar')
            expect(rawEmbedded).toBeNull()
        }

        const firstBuild = runtimeCapture.styleBuilds[0]
        if (!firstBuild?.success || firstBuild.plan === null) {
            throw new Error('Missing first fixed-seed Style Lab plan')
        }
        await runtime.generateStyleLabPreviews(['single-artist'])
        const replayBuild = runtimeCapture.styleBuilds[2]
        expect(replayBuild?.success).toBe(true)
        if (!replayBuild?.success || replayBuild.plan === null) {
            throw new Error('Missing replayed fixed-seed Style Lab plan')
        }
        expect(replayBuild.plan.planHash).toEqual(firstBuild.plan.planHash)
        expect(replayBuild.plan.planId).toBe(firstBuild.plan.planId)
        expect(replayBuild.plan.params).toEqual(firstBuild.plan.params)
        expect(replayBuild.plan.randomTrace).toEqual(firstBuild.plan.randomTrace)

        const finalCombinations = runtime.useStyleLabStore.getState().combinations
        expect(competitiveSnapshot(finalCombinations)).toEqual(competitionBefore)
        expect(rankingIds(finalCombinations)).toEqual(rankingBefore)
    })

    it('aborts a pending production request without starting the next preview or saving output', async () => {
        runtime.useGenerationStore.setState({ styleLabCompositionMode: 'v2' })
        let notifyTransportStarted = () => undefined
        const transportStarted = new Promise<void>(resolve => {
            notifyTransportStarted = resolve
        })
        runtimeCapture.fetchOverride = async (_input, init) => {
            notifyTransportStarted()
            return await new Promise<Response>((_resolve, reject) => {
                const signal = init?.signal
                const rejectAbort = () => reject(new DOMException('Aborted', 'AbortError'))
                if (signal?.aborted) {
                    rejectAbort()
                    return
                }
                signal?.addEventListener('abort', rejectAbort, { once: true })
            })
        }

        const generation = runtime.generateStyleLabPreviews(['single-artist', 'multi-artist'])
        await transportStarted
        runtime.useGenerationStore.getState().cancelGeneration()
        await generation

        expect(runtimeCapture.styleBuilds).toHaveLength(1)
        expect(runtimeCapture.params).toHaveLength(1)
        expect(runtimeCapture.requests).toHaveLength(1)
        expect(runtimeCapture.events).toEqual([])
        expect(runtimeCapture.writes).toEqual([])
        expect(runtimeCapture.calls).not.toContain('thumbnail:create')
        expect(runtime.useGenerationStore.getState()).toMatchObject({
            isGenerating: false,
            generatingMode: null,
            history: [],
        })
        expect(runtime.useStyleLabStore.getState()).toMatchObject({
            isPreviewQueueRunning: false,
            previewQueueTotal: 0,
            previewQueueDone: 0,
        })
        expect(runtime.useStyleLabStore.getState().combinations).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'single-artist',
                isPreviewing: false,
                previewProgress: 0,
            }),
            expect.objectContaining({
                id: 'multi-artist',
            }),
        ]))
        expect(runtime.useStyleLabStore.getState().combinations.every(combination => (
            combination.previewPath === undefined
        ))).toBe(true)
    })
})
