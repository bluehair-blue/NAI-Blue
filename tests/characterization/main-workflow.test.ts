import { readFile } from 'node:fs/promises'
import JSZip from 'jszip'
import { encode } from '@msgpack/msgpack'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerationParams } from '@/services/novelai-types'
import { readNaiBlueParams } from '@/lib/nai-blue-metadata'
import { buildNaiBlueParams, redactSentPayloadForMetadata } from '@/lib/generation-metadata'
import { sha256Utf8 } from '@/domain/composition/canonical-serialize'
import { NaiTransportTimeoutError } from '@/services/nai/transport'
import { useDiagnosticsStore } from '@/stores/diagnostics-store'
import { createDefaultGenerationFolder, type GenerationFolder } from '@/domain/generation-folders'

import { assertDeepEqual, loadFixtureJson } from '../helpers'
import {
    type CapturedRequest,
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
    toasts: [] as Array<Record<string, unknown>>,
    writes: [] as Array<{ location: string; data: Uint8Array; baseDirPresent: boolean }>,
    files: new Map<string, Uint8Array>(),
    directories: new Set<string>(),
    pendingFinalWrites: [] as Array<{ location: string; data: Uint8Array; baseDirPresent: boolean; kind: string }>,
    zipBytes: new Uint8Array(),
    fetchOverride: null as null | ((input: string | URL | Request, init?: RequestInit) => Promise<Response>),
    thumbnailOverride: null as null | (() => Promise<string>),
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
    toast: (value: Record<string, unknown>) => {
        runtimeCapture.toasts.push(value)
    },
}))

vi.mock('@/i18n', () => ({
    default: {
        t: (key: string, fallback?: string) => fallback ?? key,
    },
}))

vi.mock('@/lib/image-utils', () => ({
    createThumbnail: async () => {
        runtimeCapture.calls.push('thumbnail:create')
        if (runtimeCapture.thumbnailOverride) return runtimeCapture.thumbnailOverride()
        return 'data:image/jpeg;base64,VEhVTUI='
    },
    saveReferenceImage: async () => 'synthetic-reference.bin',
    loadReferenceImage: async () => null,
    deleteReferenceImage: async () => undefined,
    saveEncodedVibe: async () => 'synthetic-vibe.bin',
    loadEncodedVibe: async () => null,
}))

vi.mock('@tauri-apps/plugin-fs', () => {
    const BaseDirectory = { Picture: 1, AppData: 2 }
    const key = (location: string, baseDir?: unknown) => `${String(baseDir ?? 'absolute')}::${location}`
    const isJournalPath = (location: string) => location.startsWith('nai-blue/output-journal/')
    const committedKind = (location: string): string | null => {
        const match = location.match(/\.nai-blue-txn-[^.]+\.(image|sidecar|diagnostic)\.tmp$/)
        return match?.[1] ?? null
    }
    const captureCommittedWrite = (
        kind: string,
        location: string,
        data: Uint8Array,
        baseDirPresent: boolean,
    ): void => {
        const write = { location, data: new Uint8Array(data), baseDirPresent, kind }
        if (kind !== 'image') {
            runtimeCapture.pendingFinalWrites.push(write)
            return
        }

        runtimeCapture.calls.push('file:write-image')
        runtimeCapture.writes.push(write)
        for (const pending of runtimeCapture.pendingFinalWrites.splice(0)) {
            runtimeCapture.calls.push('file:write-sidecar')
            runtimeCapture.writes.push(pending)
        }
    }

    return {
        BaseDirectory,
        exists: async (location: string, options?: { baseDir?: unknown }) => {
            const locationKey = key(location, options?.baseDir)
            return runtimeCapture.files.has(locationKey) || runtimeCapture.directories.has(locationKey)
        },
        mkdir: async (location: string, options?: { baseDir?: unknown }) => {
            runtimeCapture.directories.add(key(location, options?.baseDir))
        },
        readDir: async (location: string, options?: { baseDir?: unknown }) => {
            const prefix = `${key(location, options?.baseDir)}/`
            const names = new Set<string>()
            for (const locationKey of [...runtimeCapture.files.keys(), ...runtimeCapture.directories]) {
                if (!locationKey.startsWith(prefix)) continue
                const name = locationKey.slice(prefix.length).split('/')[0]
                if (name) names.add(name)
            }
            return [...names].map(name => ({
                name,
                isFile: runtimeCapture.files.has(`${prefix}${name}`),
                isDirectory: runtimeCapture.directories.has(`${prefix}${name}`),
            }))
        },
        readFile: async (location: string, options?: { baseDir?: unknown }) => {
            const data = runtimeCapture.files.get(key(location, options?.baseDir))
            if (data === undefined) throw new Error(`Synthetic file not found: ${location}`)
            return new Uint8Array(data)
        },
        remove: async (location: string, options?: { baseDir?: unknown }) => {
            const locationKey = key(location, options?.baseDir)
            runtimeCapture.files.delete(locationKey)
            runtimeCapture.directories.delete(locationKey)
        },
        rename: async (
            from: string,
            to: string,
            options?: { oldPathBaseDir?: unknown; newPathBaseDir?: unknown },
        ) => {
            const fromKey = key(from, options?.oldPathBaseDir)
            const data = runtimeCapture.files.get(fromKey)
            if (data === undefined) throw new Error(`Synthetic rename source not found: ${from}`)
            runtimeCapture.files.set(key(to, options?.newPathBaseDir), new Uint8Array(data))
            runtimeCapture.files.delete(fromKey)

            const kind = committedKind(from)
            if (kind !== null && !isJournalPath(to)) {
                captureCommittedWrite(kind, to, data, options?.newPathBaseDir !== undefined)
            }
        },
        writeFile: async (location: string, data: Uint8Array, options?: { baseDir?: unknown }) => {
            runtimeCapture.files.set(key(location, options?.baseDir), new Uint8Array(data))
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

vi.mock('@/lib/asset-modules/resolver', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/asset-modules/resolver')>()
    return {
        ...actual,
        resolveAssetModulePlan: async (...args: Parameters<typeof actual.resolveAssetModulePlan>) => {
            runtimeCapture.calls.push('asset-plan:resolve')
            return actual.resolveAssetModulePlan(...args)
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
const FIXED_SEED = 424242
const SYNTHETIC_SOURCE = 'data:image/png;base64,U1lOVEhFVElDX1NPVVJDRQ=='
const SYNTHETIC_MASK = 'data:image/png;base64,U1lOVEhFVElDX01BU0s='
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+4xVnAAAAAElFTkSuQmCC'

function base64Bytes(value: string): Uint8Array {
    return Uint8Array.from(atob(value.replace(/^data:image\/[^;]+;base64,/, '')), character => character.charCodeAt(0))
}

interface MainFixture {
    workflow: 'main'
    captureDate: string
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
    usePresetStore: typeof import('@/stores/preset-store').usePresetStore
    startPresetSync: typeof import('@/stores/preset-store').startPresetSync
    useSettingsStore: typeof import('@/stores/settings-store').useSettingsStore
}

let stores: RuntimeModules

function frame(event: Record<string, unknown>): Uint8Array {
    const message = encode(event)
    const framed = new Uint8Array(message.length + 4)
    new DataView(framed.buffer).setUint32(0, message.length, false)
    framed.set(message, 4)
    return framed
}

function makeStreamResponse(): Response {
    const partial = frame({
        event_type: 'intermediate',
        step_ix: 7,
        image: new TextEncoder().encode('synthetic-partial'),
    })
    const final = frame({
        event_type: 'final',
        step_ix: 28,
        image: base64Bytes(TINY_PNG_BASE64),
    })

    return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(partial)
            controller.enqueue(final)
            controller.close()
        },
    }), { status: 200 })
}

async function capturedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (runtimeCapture.fetchOverride) return runtimeCapture.fetchOverride(input, init)
    const endpoint = String(input)
    const mode = endpoint.includes('generate-image-stream') ? 'streaming' : 'non-streaming'
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>
    runtimeCapture.calls.push(`transport:${mode}`)
    runtimeCapture.requests.push({ mode, endpoint, payload })

    if (mode === 'streaming') return makeStreamResponse()
    return new Response(runtimeCapture.zipBytes, { status: 200 })
}

class SyntheticImage {
    width = 777
    height = 999
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    private value = ''

    get src(): string {
        return this.value
    }

    set src(value: string) {
        this.value = value
        if (value) queueMicrotask(() => this.onload?.())
    }
}

function createSyntheticCanvas(): Record<string, unknown> {
    const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({
            drawImage: () => undefined,
            fillRect: () => undefined,
            getImageData: (_x: number, _y: number, width: number, height: number) => ({
                data: new Uint8ClampedArray(width * height * 4).fill(255),
            }),
            createImageData: (width: number, height: number) => ({
                data: new Uint8ClampedArray(width * height * 4),
            }),
            putImageData: () => undefined,
        }),
        toDataURL: () => 'data:image/png;base64,U1lOVEhFVElDX0NBTlZBUw==',
    }
    return canvas
}

function installBrowserBoundary(): void {
    const documentBoundary = {
        createElement: (tag: string) => tag === 'canvas'
            ? createSyntheticCanvas()
            : {
                href: '',
                download: '',
                click: () => runtimeCapture.calls.push('download:click'),
            },
        body: {
            appendChild: () => undefined,
            removeChild: () => undefined,
        },
    }
    const windowBoundary = {
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
    }

    vi.stubGlobal('window', windowBoundary)
    vi.stubGlobal('document', documentBoundary)
    vi.stubGlobal('Image', SyntheticImage)
    vi.stubGlobal('CustomEvent', class<T> {
        type: string
        detail: T

        constructor(type: string, init: { detail: T }) {
            this.type = type
            this.detail = init.detail
        }
    })
}

function resetStores(): void {
    runtimeCapture.calls.length = 0
    runtimeCapture.events.length = 0
    runtimeCapture.params.length = 0
    runtimeCapture.requests.length = 0
    runtimeCapture.toasts.length = 0
    runtimeCapture.writes.length = 0
    runtimeCapture.files.clear()
    runtimeCapture.directories.clear()
    runtimeCapture.pendingFinalWrites.length = 0
    runtimeCapture.fetchOverride = null
    runtimeCapture.thumbnailOverride = null
    useDiagnosticsStore.getState().clear()

    stores.useAuthStore.setState({
        token: 'synthetic-token-never-snapshotted',
        isVerified: true,
        slot1Enabled: true,
        token2: '',
        isVerified2: false,
        slot2Enabled: false,
        refreshAnlas: async () => {
            runtimeCapture.calls.push('anlas:refresh-slot-1')
        },
    })
    const defaultGenerationFolder = createDefaultGenerationFolder('NAI_Blue_Output', false, new Date(FIXED_TIME).toISOString())
    stores.useSettingsStore.setState({
        autoSave: false,
        useStreaming: false,
        generationDelay: 0,
        imageFormat: 'png',
        metadataMode: 'embedded',
        savePath: 'NAI_Blue_Output',
        useAbsolutePath: false,
        generationFolders: [defaultGenerationFolder],
        activeGenerationFolderId: defaultGenerationFolder.id,
    })
    stores.useGenerationStore.setState({
        basePrompt: '',
        additionalPrompt: '',
        detailPrompt: '',
        negativePrompt: '',
        inpaintingPrompt: '',
        model: 'nai-diffusion-4-5-full',
        steps: 28,
        cfgScale: 5,
        cfgRescale: 0,
        sampler: 'k_euler_ancestral',
        scheduler: 'karras',
        smea: true,
        smeaDyn: true,
        variety: false,
        seed: FIXED_SEED,
        seedLocked: true,
        selectedResolution: { label: 'Portrait', width: 832, height: 1216 },
        qualityToggle: true,
        ucPreset: 0,
        batchCount: 1,
        currentBatch: 0,
        sourceImage: null,
        strength: 0.7,
        noise: 0,
        mask: null,
        i2iMode: null,
        lastGenerationTime: null,
        estimatedTime: null,
        isGenerating: false,
        generatingMode: null,
        isCancelled: false,
        previewImage: null,
        history: [],
        abortController: null,
        generationSessionId: 0,
        streamProgress: 0,
        compositionMode: 'legacy',
        selectedRecipeId: null,
        compositionWarnings: [],
        compositionErrors: [],
        lastResolvedPlan: null,
        compositionShadowDiff: null,
    })
    stores.useCharacterPromptStore.setState({
        characters: [],
        presets: [],
        groups: [],
        positionEnabled: false,
    })
    stores.useCharacterStore.setState({
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
    stores.usePresetStore.setState({
        activePresetId: 'default',
    })
    stores.useFragmentStore.setState({
        files: [],
        sequentialCounters: {},
    })
    stores.useAssetModuleStore.setState({
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

function summarizeOutput(): Record<string, unknown> {
    const event = runtimeCapture.events.at(-1)
    const location = typeof event?.detail.location === 'string'
        ? event.detail.location
        : event?.detail.path
    const fileName = typeof location === 'string' ? location.split('/').at(-1) : null

    const output: Record<string, unknown> = {
        policy: typeof location === 'string' && location.startsWith('memory://') ? 'memory' : 'filesystem',
        fileName,
        outputTargetPolicy: 'Composition output policy selects the filename, including source-edit prefixes.',
        eventIncludesImageData: Boolean(event?.detail.data),
        historyCount: stores.useGenerationStore.getState().history.length,
    }

    if (output.policy === 'filesystem') {
        const imageWrite = runtimeCapture.writes.find(write => !write.location.endsWith('.nai-blue.json'))
        if (!imageWrite || typeof location !== 'string') throw new Error('Missing Main filesystem output capture')
        const expectedResolvedPath = `C:/Synthetic/Pictures/${imageWrite.location}`
        expect(location).toBe(expectedResolvedPath)
        output.targetSegments = imageWrite.location.split('/').slice(0, -1)
        output.baseDirectoryUsed = imageWrite.baseDirPresent
        output.generatedFileCount = runtimeCapture.writes.filter(write => !write.location.endsWith('.nai-blue.json')).length
        output.sidecarFileCount = runtimeCapture.writes.filter(write => write.location.endsWith('.nai-blue.json')).length
        output.resolvedPathMatchesMockPlatformRoot = location === expectedResolvedPath
    }

    return output
}

async function runScenario(name: string): Promise<Record<string, unknown>> {
    await stores.useGenerationStore.getState().generate()
    expect(runtimeCapture.requests).toHaveLength(1)
    const request = runtimeCapture.requests[0]
    const history = stores.useGenerationStore.getState().history[0]
    const generationParams = runtimeCapture.params[0]
    if (!generationParams) throw new Error(`No GenerationParams captured for ${name}`)
    const capturedTransport = summarizeCapturedRequest(request)
    const expectedPayloadHash = `sha256:${sha256Utf8(redactSentPayloadForMetadata(JSON.stringify(request.payload)))}`
    expect(history?.sentPayloadSummary).toBe(expectedPayloadHash)
    const plannedMetadata = summarizeMetadata(generationParams, history?.sentPayloadSummary)
    expect(buildNaiBlueParams({ ...generationParams, sentPayloadSummary: history?.sentPayloadSummary }).redactedPayloadHash)
        .toBe(expectedPayloadHash)
    const eventData = runtimeCapture.events.at(-1)?.detail.data
    const embeddedParams = typeof eventData === 'string' ? readNaiBlueParams(base64Bytes(eventData)) : null
    const embeddedMetadata = summarizeNaiBlueMetadata(embeddedParams)
    const shouldEmbed = generationParams.metadataMode !== 'sidecar-only'
        && generationParams.metadataMode !== 'strip-and-sidecar'
    if (shouldEmbed) {
        expect(embeddedMetadata).toEqual(plannedMetadata)
        expect(embeddedParams?.redactedPayloadHash).toBe(expectedPayloadHash)
    }
    else expect(embeddedMetadata).toBeNull()
        const sidecarWrite = runtimeCapture.writes.find(write => write.location.endsWith('.nai-blue.json'))
    const sidecarParams = sidecarWrite
        ? JSON.parse(new TextDecoder().decode(sidecarWrite.data))
        : null
    const sidecarMetadata = summarizeNaiBlueMetadata(sidecarParams)
    if (sidecarMetadata) expect(sidecarMetadata).toEqual(plannedMetadata)
    if (sidecarParams) expect(sidecarParams.redactedPayloadHash).toBe(expectedPayloadHash)
    const fixturePromptParts = { ...(plannedMetadata.promptParts as Record<string, unknown>) }
    delete fixturePromptParts.workflow

    return redactedGolden({
        name,
        composition: summarizeGenerationParams(generationParams),
        transport: {
            mode: capturedTransport.mode,
            endpoint: capturedTransport.endpoint,
        },
        payloadRedactedSummary: capturedTransport.payload,
        output: summarizeOutput(),
        metadata: {
            qualityToggle: plannedMetadata.qualityToggle,
            ucPreset: plannedMetadata.ucPreset,
            promptParts: fixturePromptParts,
            assetModulePlan: plannedMetadata.assetModulePlan,
            sentPayloadMatchesTransport: true,
            embeddingExpected: shouldEmbed,
            embeddedInOutput: embeddedMetadata !== null,
            embeddedMatchesExpectedMode: true,
            sidecarWritten: sidecarMetadata !== null,
            sidecarMatchesPlanned: sidecarMetadata ? true : null,
        },
        callOrder: [...runtimeCapture.calls],
    })
}

beforeAll(async () => {
    installBrowserBoundary()

    const zip = new JSZip()
    zip.file('image.png', base64Bytes(TINY_PNG_BASE64))
    runtimeCapture.zipBytes = await zip.generateAsync({ type: 'uint8array' })

    const [assetStore, authStore, characterPromptStore, characterStore, generationStore, fragmentStore, presetStore, settingsStore] = await Promise.all([
        import('@/stores/asset-module-store'),
        import('@/stores/auth-store'),
        import('@/stores/character-prompt-store'),
        import('@/stores/character-store'),
        import('@/stores/generation-store'),
        import('@/stores/fragment-store'),
        import('@/stores/preset-store'),
        import('@/stores/settings-store'),
    ])
    stores = {
        useAssetModuleStore: assetStore.useAssetModuleStore,
        useAuthStore: authStore.useAuthStore,
        useCharacterPromptStore: characterPromptStore.useCharacterPromptStore,
        useCharacterStore: characterStore.useCharacterStore,
        useGenerationStore: generationStore.useGenerationStore,
        useFragmentStore: fragmentStore.useFragmentStore,
        usePresetStore: presetStore.usePresetStore,
        startPresetSync: presetStore.startPresetSync,
        useSettingsStore: settingsStore.useSettingsStore,
    }
})

beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_TIME)
    vi.spyOn(Math, 'random').mockReturnValue(0.75)
    resetStores()
})

describe('Main workflow golden characterization', () => {
    it('tracks preset edits without mutating the saved preset until an explicit command', () => {
        stores.usePresetStore.getState().loadPreset('default')
        const originalPrompt = stores.usePresetStore.getState().getActivePreset()?.basePrompt ?? ''
        const stop = stores.startPresetSync()

        try {
            stores.useGenerationStore.getState().setBasePrompt('unsaved draft')
            expect(stores.usePresetStore.getState()).toMatchObject({ dirty: true })
            expect(stores.usePresetStore.getState().getActivePreset()?.basePrompt).toBe(originalPrompt)

            stores.usePresetStore.getState().saveActivePreset()
            expect(stores.usePresetStore.getState()).toMatchObject({ dirty: false })
            expect(stores.usePresetStore.getState().getActivePreset()?.basePrompt).toBe('unsaved draft')

            stores.useGenerationStore.getState().setBasePrompt('discarded draft')
            stores.usePresetStore.getState().revertActivePreset()
            expect(stores.useGenerationStore.getState().basePrompt).toBe('unsaved draft')
            expect(stores.usePresetStore.getState()).toMatchObject({ dirty: false })
        } finally {
            stop()
        }
    })

    it('captures an immutable durable enqueue plan without credential, transport, or output side effects', async () => {
        stores.useAuthStore.setState({ token: '', isVerified: false, slot1Enabled: false })
        stores.useGenerationStore.setState({
            basePrompt: 'durable capture prompt',
            negativePrompt: 'durable negative',
            compositionMode: 'v2',
            seed: 7,
            seedLocked: false,
            batchCount: 2,
        })
        const stateBefore = JSON.parse(JSON.stringify(stores.useGenerationStore.getState()))
        const referencesBefore = JSON.parse(JSON.stringify(stores.useCharacterStore.getState()))
        const captured = (await stores.useGenerationStore.getState().prepareMainBatch([101, 202]))
            .map(value => structuredClone(value))

        expect(captured).toHaveLength(2)
        expect(captured.map(value => value.finalPrompt)).toEqual([
            'durable capture prompt',
            'durable capture prompt',
        ])
        expect(captured.every(value => value.params.prompt === value.finalPrompt)).toBe(true)
        expect(captured.map(value => value.params.seed)).toEqual([101, 202])
        expect(JSON.parse(JSON.stringify(stores.useGenerationStore.getState()))).toEqual(stateBefore)
        expect(JSON.parse(JSON.stringify(stores.useCharacterStore.getState()))).toEqual(referencesBefore)
        expect(runtimeCapture.requests).toEqual([])
        expect(runtimeCapture.writes).toEqual([])
        expect(runtimeCapture.toasts).toEqual([])
        expect(stores.useGenerationStore.getState()).toMatchObject({
            isGenerating: false,
            generatingMode: null,
            history: [],
        })
        expect(runtimeCapture.calls).not.toContain('payload:adapt-params')
    })

    it('plans distinct sequential fragment values and CAS revisions for a durable batch', async () => {
        stores.useAuthStore.setState({ token: '', isVerified: false, slot1Enabled: false })
        stores.useFragmentStore.setState({
            files: [{
                id: 'fragment:durable-sequence',
                name: 'durable-sequence',
                folder: '',
                lineCount: 3,
                createdAt: FIXED_TIME,
                updatedAt: FIXED_TIME,
            }],
            sequentialCounters: {},
            sequenceState: { schemaVersion: 1, revision: 0, counters: {} },
        })
        const loadFragment = vi.spyOn(stores.useFragmentStore.getState(), 'loadFileContent')
            .mockResolvedValue(['first', 'second', 'third'])
        stores.useGenerationStore.setState({
            basePrompt: '<*durable-sequence>',
            compositionMode: 'v2',
            selectedRecipeId: 'main:direct',
            batchCount: 3,
        })
        let captured: import('@/stores/generation-store').PreparedMainGeneration[] = []

        try {
            captured = (await stores.useGenerationStore.getState().prepareMainBatch())
                .map(value => structuredClone(value))
        } finally {
            loadFragment.mockRestore()
        }

        expect(captured.map(value => value.finalPrompt)).toEqual(['first', 'second', 'third'])
        expect(new Set(captured.map(value => value.sequenceCommitProposal?.expectedRevision)).size).toBe(3)
        expect(captured.map(value => value.sequenceCommitProposal?.changes[0])).toEqual([
            expect.objectContaining({ expectedCounter: 0, nextCounter: 1 }),
            expect.objectContaining({ expectedCounter: 1, nextCounter: 2 }),
            expect.objectContaining({ expectedCounter: 2, nextCounter: 3 }),
        ])
        expect(stores.useFragmentStore.getState().getSequenceSnapshot().counters['fragment:durable-sequence']).toBe(0)
        for (const capture of captured) {
            const proposal = capture.sequenceCommitProposal
            const lease = stores.useFragmentStore.getState().reserveSequenceProposal(proposal === null
                ? null
                : {
                    expectedRevision: proposal.expectedRevision,
                    changes: proposal.changes.map(change => ({ ...change })),
                })
            expect(lease?.commit()).toBe(true)
        }
        expect(stores.useFragmentStore.getState().getSequenceSnapshot().counters['fragment:durable-sequence']).toBe(3)
        expect(runtimeCapture.requests).toEqual([])
        stores.useFragmentStore.setState({
            sequentialCounters: {},
            sequenceState: { schemaVersion: 1, revision: 0, counters: {} },
        })
    })

    it.each(['legacy', 'shadow', 'v2'] as const)(
        'keeps %s preparation read-only with an explicit seed',
        async compositionMode => {
            stores.useAuthStore.setState({ token: '', isVerified: false, slot1Enabled: false })
            stores.useGenerationStore.setState({
                basePrompt: 'mode parity prompt',
                compositionMode,
                seed: 9,
                seedLocked: false,
                batchCount: 1,
            })
            const stateBefore = JSON.parse(JSON.stringify(stores.useGenerationStore.getState()))

            const [captured] = await stores.useGenerationStore.getState().prepareMainBatch([303])

            expect(captured.params.seed).toBe(303)
            expect(captured.params.prompt).toContain('mode parity prompt')
            expect(JSON.parse(JSON.stringify(stores.useGenerationStore.getState()))).toEqual(stateBefore)
            expect(runtimeCapture.requests).toEqual([])
            expect(runtimeCapture.writes).toEqual([])
            expect(runtimeCapture.toasts).toEqual([])
        },
    )

    it('materializes every zero seed even when the visible seed is locked', async () => {
        vi.mocked(Math.random)
            .mockReturnValueOnce(0.1)
            .mockReturnValueOnce(0.2)
        stores.useGenerationStore.setState({
            basePrompt: 'zero seed capture',
            compositionMode: 'legacy',
            seed: 0,
            seedLocked: true,
            batchCount: 2,
        })

        const captured = await stores.useGenerationStore.getState().prepareMainBatch()

        expect(captured.map(value => value.params.seed)).toEqual([
            Math.floor(0.1 * 4294967295),
            Math.floor(0.2 * 4294967295),
        ])
        expect(stores.useGenerationStore.getState().seed).toBe(0)
    })

    it('matches the production store, adapter, payload, output and metadata fixture', async () => {
        const scenarios: Array<Record<string, unknown>> = []

        stores.useGenerationStore.setState({ basePrompt: '1girl, silver hair' })
        scenarios.push(await runScenario('base-only-non-streaming-fixed-seed'))
        resetStores()

        stores.useSettingsStore.setState({ useStreaming: true })
        stores.useGenerationStore.setState({
            basePrompt: '1girl',
            additionalPrompt: 'soft light',
            detailPrompt: 'detailed eyes',
            negativePrompt: 'lowres\n# removed negative note',
        })
        scenarios.push(await runScenario('base-additional-detail-negative-streaming'))
        resetStores()

        stores.useSettingsStore.setState({ useStreaming: true })
        stores.useGenerationStore.setState({
            basePrompt: 'portrait',
            inpaintingPrompt: 'repair hands',
            negativePrompt: 'bad hands',
            sourceImage: SYNTHETIC_SOURCE,
            mask: SYNTHETIC_MASK,
            i2iMode: 'inpaint',
            strength: 0.55,
            noise: 0.12,
        })
        scenarios.push(await runScenario('inpainting-source-forces-non-streaming'))
        resetStores()

        stores.useSettingsStore.setState({ useStreaming: true })
        stores.useGenerationStore.setState({
            basePrompt: '1girl, <red hair|blue hair>',
            negativePrompt: '<bad anatomy|lowres>',
        })
        stores.useCharacterPromptStore.setState({
            positionEnabled: true,
            characters: [{
                id: 'character-1',
                name: 'Hero',
                prompt: '<green eyes|amber eyes>',
                negative: '<hat|glasses>',
                enabled: true,
                position: { x: 0.2, y: 0.8 },
            }],
        })
        scenarios.push(await runScenario('wildcards-character-positive-negative-manual-position'))
        resetStores()

        const preset = {
            id: 'cinematic-preset',
            name: 'Cinematic',
            createdAt: FIXED_TIME,
            basePrompt: 'preset base',
            additionalPrompt: 'preset additional',
            detailPrompt: 'preset detail',
            negativePrompt: 'preset negative',
            model: 'nai-diffusion-4-curated-preview',
            steps: 31,
            cfgScale: 6.2,
            cfgRescale: 0.25,
            sampler: 'k_dpmpp_2m',
            scheduler: 'exponential',
            smea: false,
            smeaDyn: false,
            variety: true,
            qualityToggle: false,
            ucPreset: 2,
            selectedResolution: { label: 'Preset', width: 960, height: 1024 },
        }
        stores.usePresetStore.setState({ presets: [preset], activePresetId: 'default' })
        stores.useGenerationStore.setState({ inpaintingPrompt: 'preserved inpainting prompt' })
        stores.usePresetStore.getState().loadPreset(preset.id)
        scenarios.push(await runScenario('generation-preset-applied'))
        resetStores()

        stores.useGenerationStore.setState({
            basePrompt: 'ignored main prompt',
            negativePrompt: 'ignored main negative',
        })
        stores.useSettingsStore.setState({ autoSave: true })
        stores.useAssetModuleStore.setState({
            profile: {
                revision: 1,
                updatedBy: 'agent',
                updatedAt: new Date(FIXED_TIME).toISOString(),
                settings: { name: 'golden-profile' },
                output: {},
                r2: { enabled: false },
                modules: {
                    subject: {
                        id: 'subject',
                        enabled: true,
                        kind: 'prompt',
                        label: 'Golden Subject',
                        prompts: {
                            'main.base': 'module subject, module lighting',
                            'main.negative': 'module negative',
                            'v4.char.0.positive': 'module character',
                            'v4.char.0.negative': 'module character negative',
                        },
                        settings: {},
                    },
                },
                recipes: [{
                    id: 'golden-recipe',
                    enabled: true,
                    label: 'Golden Recipe',
                    steps: [{ moduleId: 'subject' }],
                    output: {
                        directory: 'Module_Output',
                        filenameTemplate: 'module_{seed}',
                        format: 'png',
                        metadataMode: 'sidecar-only',
                    },
                }],
            },
        })
        scenarios.push(await runScenario('asset-module-recipe-active'))
        resetStores()

        stores.useGenerationStore.setState({
            basePrompt: 'fallback base',
            additionalPrompt: 'fallback additional',
            negativePrompt: 'fallback negative',
            selectedRecipeId: 'main:direct',
        })
        stores.useAssetModuleStore.setState({
            profile: {
                revision: 2,
                updatedBy: 'agent',
                updatedAt: new Date(FIXED_TIME).toISOString(),
                settings: {},
                output: {},
                r2: { enabled: false },
                modules: {},
                recipes: [{
                    id: 'missing-module-recipe',
                    enabled: true,
                    steps: [{ moduleId: 'missing-module' }],
                }],
            },
        })
        scenarios.push(await runScenario('explicit-direct-with-unavailable-asset-recipe'))

        const actual: MainFixture = {
            workflow: 'main',
            captureDate: '2026-07-11',
            guards: [
                'batch-loop entry: isCancelled or generationSessionId mismatch stops before composition/transport',
                'composition, source-dimension and reference awaits are followed by session guards before transport',
                'streaming preview callback ignores stale/cancelled sessions',
                'after transport: stale/cancelled result is discarded before thumbnail/output/history',
                'after thumbnail: stale/cancelled result is discarded before sequence/output/history side effects',
            ],
            nondeterminism: [
                'Date.now controls session, timing, history IDs and default filenames.',
                'Math.random controls initial/unlocked/zero seeds; Composition resolves wildcards from the captured seed.',
                'Fixed generation seed determines wildcard selection; default filenames use the captured time.',
                'Unlocked generation advances the next visible seed before resolving the captured seed.',
            ],
            scenarios,
        }
        const source = await readFile('src/services/generation/generation-runtime-store.ts', 'utf8')
        expect(source.match(/shouldContinue\(\)/g)?.length)
            .toBeGreaterThanOrEqual(6)
        const fixture = await loadFixtureJson<MainFixture>('workflows/main/current-workflow.json')
        assertDeepEqual(actual, fixture, 'Main workflow behavior changed')
        expect(actual.scenarios).toHaveLength(7)
    })

    it('keeps deterministic direct generation payload-equivalent in v2 and exposes the plan hash', async () => {
        const configure = (mode: 'legacy' | 'v2') => {
            stores.useGenerationStore.setState({
                compositionMode: mode,
                selectedRecipeId: 'main:direct',
                basePrompt: '1girl\n# remove this line',
                inpaintingPrompt: 'repair hands',
                additionalPrompt: 'soft light',
                detailPrompt: 'detailed eyes',
                negativePrompt: 'lowres\n# remove negative line',
            })
        }

        configure('legacy')
        await stores.useGenerationStore.getState().generate()
        const legacyPayload = structuredClone(runtimeCapture.requests[0].payload)

        resetStores()
        configure('v2')
        await stores.useGenerationStore.getState().generate()

        expect(runtimeCapture.requests).toHaveLength(1)
        expect(runtimeCapture.requests[0].payload).toEqual(legacyPayload)
        const state = stores.useGenerationStore.getState()
        expect(state.compositionErrors).toEqual([])
        expect(state.lastResolvedPlan?.planHash.digest).toMatch(/^[0-9a-f]{64}$/)
        expect(runtimeCapture.params[0].compositionPlanHash).toEqual(state.lastResolvedPlan?.planHash)
    })

    it('uses slot 2 when it is the only active generation credential', async () => {
        stores.useAuthStore.setState({
            token: '',
            isVerified: false,
            slot1Enabled: false,
            token2: 'synthetic-slot-two-never-snapshotted',
            isVerified2: true,
            slot2Enabled: true,
            refreshAnlas: async (slot) => {
                runtimeCapture.calls.push(`anlas:refresh-slot-${slot}`)
            },
        })
        stores.useGenerationStore.setState({
            compositionMode: 'v2',
            selectedRecipeId: 'main:direct',
            basePrompt: 'slot two generation',
        })

        await stores.useGenerationStore.getState().generate()

        expect(runtimeCapture.requests).toHaveLength(1)
        expect(runtimeCapture.calls).toContain('anlas:refresh-slot-2')
        expect(runtimeCapture.toasts).not.toContainEqual(expect.objectContaining({
            title: expect.stringContaining('token'),
        }))
    })

    it('runs a stale shadow selection as one canonical request without comparison', async () => {
        stores.useGenerationStore.setState({
            compositionMode: 'shadow',
            selectedRecipeId: 'main:direct',
            basePrompt: '1girl, silver hair',
            negativePrompt: 'lowres',
        })

        await stores.useGenerationStore.getState().generate()

        const state = stores.useGenerationStore.getState()
        expect(runtimeCapture.requests).toHaveLength(1)
        expect(state.lastResolvedPlan).not.toBeNull()
        expect(state.compositionShadowDiff).toBeNull()
        expect(runtimeCapture.params[0]).toMatchObject({
            compositionMode: 'v2',
            compositionPlanId: state.lastResolvedPlan?.planId,
        })
    })

    it('honors an explicit direct recipe even with a stale shadow selection', async () => {
        stores.useAssetModuleStore.setState({
            profile: {
                revision: 5,
                updatedBy: 'agent',
                updatedAt: new Date(FIXED_TIME).toISOString(),
                settings: {},
                output: {},
                r2: { enabled: false },
                modules: {
                    subject: {
                        id: 'subject',
                        enabled: true,
                        kind: 'prompt',
                        prompts: { 'main.base': 'legacy asset prompt' },
                        settings: {},
                    },
                },
                recipes: [{
                    id: 'legacy-shadow-recipe',
                    enabled: true,
                    steps: [{ moduleId: 'subject' }],
                    output: { filenameTemplate: 'legacy_shadow_{seed}', format: 'png' },
                }],
            },
        })
        stores.useGenerationStore.setState({
            compositionMode: 'shadow',
            selectedRecipeId: 'main:direct',
            basePrompt: 'v2 direct prompt',
        })

        await stores.useGenerationStore.getState().generate()

        expect(runtimeCapture.requests).toHaveLength(1)
        expect(runtimeCapture.params[0].prompt).toBe('v2 direct prompt')
        expect(runtimeCapture.events[0].detail.path).toBe(`memory://NAI_Blue_${FIXED_TIME}.png`)
        expect(stores.useGenerationStore.getState().compositionShadowDiff).toBeNull()
    })

    it('uses the selected saved recipe output policy even with a stale shadow selection', async () => {
        stores.useAssetModuleStore.setState({
            profile: {
                revision: 9,
                updatedBy: 'agent',
                updatedAt: new Date(FIXED_TIME).toISOString(),
                settings: {},
                output: {},
                r2: { enabled: false },
                modules: {
                    subject: {
                        id: 'subject',
                        enabled: true,
                        kind: 'prompt',
                        prompts: { 'main.base': 'same asset prompt' },
                        settings: {},
                    },
                },
                recipes: [
                    {
                        id: 'shadow:first',
                        enabled: true,
                        steps: [{ moduleId: 'subject' }],
                        output: { filenameTemplate: 'first_{seed}' },
                    },
                    {
                        id: 'shadow:second',
                        enabled: true,
                        steps: [{ moduleId: 'subject' }],
                        output: { filenameTemplate: 'second_{seed}' },
                    },
                ],
            },
        })
        stores.useGenerationStore.setState({
            compositionMode: 'shadow',
            selectedRecipeId: 'shadow:second',
            basePrompt: 'ignored',
        })

        await stores.useGenerationStore.getState().generate()

        expect(runtimeCapture.params[0].prompt).toBe('same asset prompt')
        expect(runtimeCapture.events[0].detail.path).toBe(`memory://second_${FIXED_SEED}.png`)
        expect(runtimeCapture.params[0].compositionRecipeId).toBe('shadow:second')
        expect(stores.useGenerationStore.getState().compositionShadowDiff).toBeNull()
    })

    it('uses the selected Asset recipe prompt, typed params, and output policy in v2', async () => {
        stores.useGenerationStore.setState({
            compositionMode: 'v2',
            selectedRecipeId: 'runtime-asset-recipe',
            basePrompt: 'ignored direct prompt',
            negativePrompt: 'ignored direct negative',
        })
        stores.useAssetModuleStore.setState({
            profile: {
                revision: 4,
                updatedBy: 'agent',
                updatedAt: new Date(FIXED_TIME).toISOString(),
                settings: { steps: 20 },
                output: {},
                r2: { enabled: false },
                modules: {
                    subject: {
                        id: 'subject',
                        enabled: true,
                        kind: 'prompt',
                        prompts: {
                            'main.base': 'asset subject',
                            'main.negative': 'asset negative',
                        },
                        settings: {
                            steps: 30,
                            cfgScale: 6.25,
                            cfgRescale: 0,
                            smea: false,
                        },
                    },
                },
                recipes: [{
                    id: 'runtime-asset-recipe',
                    enabled: true,
                    steps: [{ moduleId: 'subject', settings: { steps: 40 } }],
                    settings: { steps: 44 },
                    output: {
                        filenameTemplate: 'asset_{seed}',
                        format: 'webp',
                        metadataMode: 'sidecar-only',
                    },
                }],
            },
        })

        await stores.useGenerationStore.getState().generate()

        expect(runtimeCapture.requests).toHaveLength(1)
        expect(runtimeCapture.params[0]).toMatchObject({
            prompt: 'asset subject',
            negative_prompt: 'asset negative',
            steps: 44,
            cfg_scale: 6.25,
            cfg_rescale: 0,
            smea: false,
            imageFormat: 'webp',
            metadataMode: 'sidecar-only',
            compositionMode: 'v2',
            compositionRecipeId: 'runtime-asset-recipe',
        })
        expect(runtimeCapture.events).toHaveLength(1)
        expect(runtimeCapture.events[0].detail.path).toBe(`memory://asset_${FIXED_SEED}.webp`)
        expect(stores.useGenerationStore.getState().lastResolvedPlan?.provenanceDetails.params
            .find(item => item.field === 'steps')?.winner.layer).toBe('recipe-override')
    })

    it('keeps the resolved v2 output destination when live settings change during transport', async () => {
        stores.useSettingsStore.setState({ autoSave: false })
        stores.useGenerationStore.setState({
            compositionMode: 'v2',
            selectedRecipeId: 'main:direct',
            basePrompt: 'captured output policy',
        })
        runtimeCapture.fetchOverride = async (input: string | URL | Request, init?: RequestInit) => {
            runtimeCapture.requests.push({
                mode: 'non-streaming',
                endpoint: String(input),
                payload: JSON.parse(String(init?.body)) as Record<string, unknown>,
            })
            stores.useSettingsStore.setState({ autoSave: true })
            return new Response(runtimeCapture.zipBytes, { status: 200 })
        }

        await stores.useGenerationStore.getState().generate()

        expect(runtimeCapture.writes).toEqual([])
        expect(runtimeCapture.events[0].detail.path).toBe(`memory://NAI_Blue_${FIXED_TIME}.png`)
        expect(stores.useGenerationStore.getState().lastResolvedPlan?.outputPolicy.destination)
            .toEqual({ kind: 'memory' })
    })

    it('uses the v2 filesystem policy with the existing image and sidecar writer', async () => {
        stores.useSettingsStore.setState({ autoSave: true, savePath: 'Runtime_Output' })
        stores.useAssetModuleStore.setState({
            profile: {
                revision: 10,
                updatedBy: 'agent',
                updatedAt: new Date(FIXED_TIME).toISOString(),
                settings: {},
                output: {},
                r2: { enabled: false },
                modules: {
                    subject: {
                        id: 'subject',
                        enabled: true,
                        kind: 'prompt',
                        prompts: { 'main.base': 'filesystem subject' },
                        settings: {},
                    },
                },
                recipes: [{
                    id: 'filesystem-recipe',
                    enabled: true,
                    steps: [{ moduleId: 'subject' }],
                    output: {
                        directory: 'V2/../Gallery',
                        filenameTemplate: 'fixed_{seed}',
                        format: 'webp',
                        metadataMode: 'sidecar-only',
                    },
                }],
            },
        })
        stores.useGenerationStore.setState({
            compositionMode: 'v2',
            selectedRecipeId: 'filesystem-recipe',
        })

        await stores.useGenerationStore.getState().generate()

        expect(runtimeCapture.writes.map(write => write.location)).toEqual([
            `V2/Gallery/fixed_${FIXED_SEED}.webp`,
            `V2/Gallery/fixed_${FIXED_SEED}.nai-blue.json`,
        ])
        expect([...runtimeCapture.files.keys()].some(location => location.includes('nai-blue/output-journal')))
            .toBe(false)
        expect(runtimeCapture.events[0].detail.path)
            .toBe(`C:/Synthetic/Pictures/V2/Gallery/fixed_${FIXED_SEED}.webp`)
        expect(stores.useGenerationStore.getState().lastResolvedPlan?.outputPolicy)
            .toMatchObject({ collisionPolicy: 'overwrite' })
    })

    it('uses the final supported v2 model without an obsolete parity-warning gate', async () => {
        const profileForModel = (model: string) => ({
            revision: 6,
            updatedBy: 'agent' as const,
            updatedAt: new Date(FIXED_TIME).toISOString(),
            settings: {},
            output: {},
            r2: { enabled: false },
            modules: {
                model: {
                    id: 'model',
                    enabled: true,
                    kind: 'prompt' as const,
                    prompts: { 'main.base': 'model override' },
                    settings: { model },
                },
            },
            recipes: [{ id: 'model-recipe', enabled: true, steps: [{ moduleId: 'model' }] }],
        })

        stores.useAssetModuleStore.setState({ profile: profileForModel('nai-diffusion-4-5-full') })
        stores.useGenerationStore.setState({
            compositionMode: 'v2',
            selectedRecipeId: 'model-recipe',
            model: 'nai-diffusion-4-curated-preview',
        })
        await stores.useGenerationStore.getState().generate()
        expect(runtimeCapture.params[0].model).toBe('nai-diffusion-4-5-full')
        expect(runtimeCapture.toasts).toEqual([])

        resetStores()
        stores.useAssetModuleStore.setState({ profile: profileForModel('nai-diffusion-4-full') })
        stores.useGenerationStore.setState({
            compositionMode: 'v2',
            selectedRecipeId: 'model-recipe',
            model: 'nai-diffusion-4-5-full',
        })
        await stores.useGenerationStore.getState().generate()
        expect(runtimeCapture.params[0].model).toBe('nai-diffusion-4-full')
        expect(runtimeCapture.toasts).toEqual([])
    })

    it('blocks invalid plans before transport/output even when an old caller requests legacy', async () => {
        const brokenProfile = {
            revision: 3,
            updatedBy: 'agent' as const,
            updatedAt: new Date(FIXED_TIME).toISOString(),
            settings: {},
            output: {},
            r2: { enabled: false },
            modules: {},
            recipes: [{
                id: 'broken-recipe',
                enabled: true,
                steps: [{ moduleId: 'missing-module' }],
            }],
        }
        stores.useAssetModuleStore.setState({ profile: brokenProfile })
        stores.useFragmentStore.setState({
            files: [{
                id: 'fragment:sequence',
                name: 'sequence',
                folder: '',
                lineCount: 2,
                createdAt: FIXED_TIME,
                updatedAt: FIXED_TIME,
            }],
            sequentialCounters: {},
        })
        const loadFragment = vi.spyOn(stores.useFragmentStore.getState(), 'loadFileContent')
            .mockResolvedValue(['first', 'second'])
        stores.useGenerationStore.setState({
            compositionMode: 'v2',
            selectedRecipeId: 'broken-recipe',
            basePrompt: '<*sequence>',
            batchCount: 2,
        })

        try {
            await stores.useGenerationStore.getState().generate()
        } finally {
            loadFragment.mockRestore()
        }

        let state = stores.useGenerationStore.getState()
        expect(runtimeCapture.requests).toEqual([])
        expect(runtimeCapture.writes).toEqual([])
        expect(runtimeCapture.events).toEqual([])
        expect(state.history).toEqual([])
        expect(stores.useFragmentStore.getState().sequentialCounters).toEqual({})
        expect(state.compositionErrors.map(issue => issue.code)).toContain('E_MODULE_REF_MISSING')
        expect(runtimeCapture.toasts.some(toast => toast.variant === 'success')).toBe(false)
        expect(state).toMatchObject({ isGenerating: false, generatingMode: null, currentBatch: 0 })

        stores.useGenerationStore.getState().setCompositionMode('legacy')
        expect(stores.useGenerationStore.getState()).toMatchObject({
            compositionMode: 'legacy',
            compositionWarnings: [],
            compositionErrors: [],
            lastResolvedPlan: null,
            compositionShadowDiff: null,
        })

        resetStores()
        stores.useAssetModuleStore.setState({ profile: brokenProfile })
        stores.useGenerationStore.setState({
            compositionMode: 'legacy',
            selectedRecipeId: 'broken-recipe',
            basePrompt: 'legacy rollback prompt',
        })
        await stores.useGenerationStore.getState().generate()
        state = stores.useGenerationStore.getState()
        expect(runtimeCapture.requests).toEqual([])
        expect(state.history).toEqual([])
        expect(state.compositionErrors.map(issue => issue.code)).toContain('E_MODULE_REF_MISSING')
    })

    it('commits a sequential fragment only after a successful v2 request', async () => {
        stores.useFragmentStore.setState({
            files: [{
                id: 'fragment:sequence-success',
                name: 'sequence-success',
                folder: '',
                lineCount: 2,
                createdAt: FIXED_TIME,
                updatedAt: FIXED_TIME,
            }],
            sequentialCounters: {},
        })
        const loadFragment = vi.spyOn(stores.useFragmentStore.getState(), 'loadFileContent')
            .mockResolvedValue(['first', 'second'])
        stores.useGenerationStore.setState({
            compositionMode: 'v2',
            selectedRecipeId: 'main:direct',
            basePrompt: '<*sequence-success>',
        })

        try {
            await stores.useGenerationStore.getState().generate()
        } finally {
            loadFragment.mockRestore()
        }

        expect(runtimeCapture.requests).toHaveLength(1)
        expect(runtimeCapture.params[0].prompt).toBe('first')
        expect(stores.useFragmentStore.getState().sequentialCounters).toEqual({
            'sequence-success': 1,
        })
        expect(stores.useFragmentStore.getState().sequenceState.counters).toEqual({
            'fragment:sequence-success': 1,
        })
    })

    it('commits basename sequential references against their canonical fragment path', async () => {
        stores.useFragmentStore.setState({
            files: [{
                id: 'fragment:nested-sequence',
                name: 'outfit',
                folder: 'wardrobe',
                lineCount: 2,
                createdAt: FIXED_TIME,
                updatedAt: FIXED_TIME,
            }],
            sequentialCounters: { 'wardrobe/outfit': 1 },
        })
        const loadFragment = vi.spyOn(stores.useFragmentStore.getState(), 'loadFileContent')
            .mockResolvedValue(['first', 'second'])
        stores.useGenerationStore.setState({
            compositionMode: 'v2',
            selectedRecipeId: 'main:direct',
            basePrompt: '<*outfit>',
        })

        try {
            await stores.useGenerationStore.getState().generate()
        } finally {
            loadFragment.mockRestore()
        }

        expect(runtimeCapture.params[0].prompt).toBe('second')
        expect(stores.useFragmentStore.getState().sequentialCounters).toEqual({
            'wardrobe/outfit': 2,
        })
    })

    it('discards a v2 result when fragment metadata changes before sequence CAS', async () => {
        stores.useFragmentStore.setState({
            files: [{
                id: 'fragment:cas',
                name: 'cas',
                folder: '',
                lineCount: 1,
                createdAt: FIXED_TIME,
                updatedAt: FIXED_TIME,
            }],
            sequentialCounters: {},
        })
        const loadFragment = vi.spyOn(stores.useFragmentStore.getState(), 'loadFileContent')
            .mockResolvedValue(['snapshot value'])
        runtimeCapture.thumbnailOverride = async () => {
            stores.useFragmentStore.setState(state => ({
                files: state.files.map(file => ({ ...file, updatedAt: file.updatedAt + 1 })),
            }))
            return 'data:image/jpeg;base64,VEhVTUI='
        }
        stores.useGenerationStore.setState({
            compositionMode: 'v2',
            selectedRecipeId: 'main:direct',
            basePrompt: '<*cas>',
        })

        try {
            await stores.useGenerationStore.getState().generate()
        } finally {
            loadFragment.mockRestore()
        }

        expect(runtimeCapture.requests).toHaveLength(1)
        expect(runtimeCapture.events).toEqual([])
        expect(stores.useFragmentStore.getState().sequentialCounters).toEqual({})
        expect(stores.useGenerationStore.getState()).toMatchObject({
            previewImage: null,
            history: [],
        })
    })

    it('does not commit a sequential proposal when the v2 API request fails', async () => {
        stores.useFragmentStore.setState({
            files: [{
                id: 'fragment:api-failure',
                name: 'api-failure',
                folder: '',
                lineCount: 1,
                createdAt: FIXED_TIME,
                updatedAt: FIXED_TIME,
            }],
            sequentialCounters: {},
        })
        const loadFragment = vi.spyOn(stores.useFragmentStore.getState(), 'loadFileContent')
            .mockResolvedValue(['not committed'])
        runtimeCapture.fetchOverride = async (input: string | URL | Request, init?: RequestInit) => {
            runtimeCapture.requests.push({
                mode: 'non-streaming',
                endpoint: String(input),
                payload: JSON.parse(String(init?.body)) as Record<string, unknown>,
            })
            return new Response(JSON.stringify({ error: 'synthetic failure' }), { status: 500 })
        }
        stores.useGenerationStore.setState({
            compositionMode: 'v2',
            selectedRecipeId: 'main:direct',
            basePrompt: '<*api-failure>',
        })

        try {
            await stores.useGenerationStore.getState().generate()
        } finally {
            loadFragment.mockRestore()
        }

        expect(runtimeCapture.requests).toHaveLength(1)
        expect(runtimeCapture.events).toEqual([])
        expect(stores.useFragmentStore.getState().sequentialCounters).toEqual({})
        expect(stores.useGenerationStore.getState().history).toEqual([])
    })

    it('does not commit a deferred legacy sequential session when the API request fails', async () => {
        stores.useFragmentStore.setState({
            files: [{
                id: 'fragment:legacy-api-failure',
                name: 'legacy-api-failure',
                folder: '',
                lineCount: 1,
                createdAt: FIXED_TIME,
                updatedAt: FIXED_TIME,
            }],
            sequentialCounters: {},
        })
        const loadFragment = vi.spyOn(stores.useFragmentStore.getState(), 'loadFileContent')
            .mockResolvedValue(['legacy not committed'])
        runtimeCapture.fetchOverride = async (input: string | URL | Request, init?: RequestInit) => {
            runtimeCapture.requests.push({
                mode: 'non-streaming',
                endpoint: String(input),
                payload: JSON.parse(String(init?.body)) as Record<string, unknown>,
            })
            return new Response(JSON.stringify({ error: 'synthetic legacy failure' }), { status: 500 })
        }
        stores.useGenerationStore.setState({
            compositionMode: 'legacy',
            selectedRecipeId: 'main:direct',
            basePrompt: '<*legacy-api-failure>',
        })

        try {
            await stores.useGenerationStore.getState().generate()
        } finally {
            loadFragment.mockRestore()
        }

        expect(runtimeCapture.requests).toHaveLength(1)
        expect(runtimeCapture.params[0]?.prompt).toBe('legacy not committed')
        expect(runtimeCapture.events).toEqual([])
        expect(stores.useFragmentStore.getState().getSequenceSnapshot().counters['fragment:legacy-api-failure']).toBe(0)
        expect(stores.useGenerationStore.getState().history).toEqual([])
    })

    it('preserves typed Main transport timeout classification without committing output', async () => {
        runtimeCapture.fetchOverride = async (input: string | URL | Request, init?: RequestInit) => {
            runtimeCapture.requests.push({
                mode: 'non-streaming',
                endpoint: String(input),
                payload: JSON.parse(String(init?.body)) as Record<string, unknown>,
            })
            throw new NaiTransportTimeoutError(120_000)
        }
        stores.useGenerationStore.setState({
            compositionMode: 'legacy',
            basePrompt: 'typed timeout boundary',
        })

        await stores.useGenerationStore.getState().generate()

        const mainEvents = useDiagnosticsStore.getState().events
            .filter(event => event.operation === 'main.generate')
        expect(runtimeCapture.requests).toHaveLength(1)
        expect(mainEvents).toHaveLength(1)
        expect(mainEvents[0]).toMatchObject({
            code: 'OPERATION_TIMEOUT',
            category: 'timeout',
            stage: 'transport-timeout',
            timeout: true,
        })
        expect(useDiagnosticsStore.getState().events.some(event => event.code === 'UNKNOWN_FAILURE')).toBe(false)
        expect(runtimeCapture.events).toEqual([])
        expect(runtimeCapture.writes).toEqual([])
        expect(stores.useGenerationStore.getState()).toMatchObject({
            isGenerating: false,
            generatingMode: null,
            previewImage: null,
            history: [],
            abortController: null,
        })
    })

    it('loads only fragments reachable from the selected recipe, including step-only backslash paths', async () => {
        stores.useFragmentStore.setState({
            files: [
                {
                    id: 'fragment:step-only',
                    name: 'tone',
                    folder: 'folder',
                    lineCount: 1,
                    createdAt: FIXED_TIME,
                    updatedAt: FIXED_TIME,
                },
                {
                    id: 'fragment:unrelated',
                    name: 'unrelated',
                    folder: '',
                    lineCount: 1,
                    createdAt: FIXED_TIME,
                    updatedAt: FIXED_TIME,
                },
            ],
            sequentialCounters: {},
        })
        const loadFragment = vi.spyOn(stores.useFragmentStore.getState(), 'loadFileContent')
            .mockImplementation(async id => {
                if (id === 'fragment:step-only') return ['step fragment']
                throw new Error('unrelated fragments must not be loaded')
            })
        stores.useAssetModuleStore.setState({
            profile: {
                revision: 7,
                updatedBy: 'agent',
                updatedAt: new Date(FIXED_TIME).toISOString(),
                settings: {},
                output: {},
                r2: { enabled: false },
                modules: {
                    subject: { id: 'subject', enabled: true, kind: 'prompt', settings: {} },
                },
                recipes: [{
                    id: 'step-fragment-recipe',
                    enabled: true,
                    steps: [{ moduleId: 'subject', prompts: { 'main.base': '<folder\\tone>' } }],
                }],
            },
        })
        stores.useGenerationStore.setState({
            compositionMode: 'v2',
            selectedRecipeId: 'step-fragment-recipe',
        })

        try {
            await stores.useGenerationStore.getState().generate()
            expect(loadFragment).toHaveBeenCalledTimes(1)
            expect(loadFragment).toHaveBeenCalledWith('fragment:step-only')
        } finally {
            loadFragment.mockRestore()
        }

        expect(runtimeCapture.params[0].prompt).toBe('step fragment')
        const metadata = buildNaiBlueParams(runtimeCapture.params[0])
        expect(metadata.assetModulePlan).toMatchObject({
            recipeId: 'step-fragment-recipe',
            promptGroups: { 'main.base': 'step fragment' },
        })
        expect(JSON.stringify(metadata)).not.toContain('<folder')
    })

    it('keeps a colliding stored Asset recipe reachable through the production caller', async () => {
        stores.useFragmentStore.setState({
            files: [{
                id: 'fragment:collision',
                name: 'collision-fragment',
                folder: '',
                lineCount: 1,
                createdAt: FIXED_TIME,
                updatedAt: FIXED_TIME,
            }],
            sequentialCounters: {},
        })
        const loadFragment = vi.spyOn(stores.useFragmentStore.getState(), 'loadFileContent')
            .mockResolvedValue(['colliding stored recipe'])
        stores.useAssetModuleStore.setState({
            profile: {
                revision: 8,
                updatedBy: 'agent',
                updatedAt: new Date(FIXED_TIME).toISOString(),
                settings: {},
                output: {},
                r2: { enabled: false },
                modules: {
                    subject: {
                        id: 'subject',
                        enabled: true,
                        kind: 'prompt',
                        prompts: { 'main.base': '<collision-fragment>' },
                        settings: {},
                    },
                },
                recipes: [{ id: 'main:direct', enabled: true, steps: [{ moduleId: 'subject' }] }],
            },
        })
        stores.useGenerationStore.setState({
            compositionMode: 'v2',
            selectedRecipeId: null,
            basePrompt: 'ignored direct',
        })

        try {
            await stores.useGenerationStore.getState().generate()
        } finally {
            loadFragment.mockRestore()
        }

        expect(runtimeCapture.params[0]).toMatchObject({
            prompt: 'colliding stored recipe',
            compositionRecipeId: 'main:direct',
        })
        expect(stores.useGenerationStore.getState().lastResolvedPlan?.recipeId).toBe('main:direct')
    })

    it('preserves locked-seed batch generation in v2', async () => {
        stores.useGenerationStore.setState({
            compositionMode: 'v2',
            selectedRecipeId: 'main:direct',
            basePrompt: 'batch prompt',
            batchCount: 2,
            seed: FIXED_SEED,
            seedLocked: true,
        })

        await stores.useGenerationStore.getState().generate()

        expect(runtimeCapture.requests).toHaveLength(2)
        expect(runtimeCapture.params.map(params => params.seed)).toEqual([FIXED_SEED, FIXED_SEED])
        expect(stores.useGenerationStore.getState().history).toHaveLength(2)
    })

    it('keeps one selected generation folder for the entire batch even if live settings change', async () => {
        const now = new Date(FIXED_TIME).toISOString()
        const capturedFolder: GenerationFolder = {
            schemaVersion: 1,
            id: 'generation-folder-prime',
            name: 'Prime',
            parentId: null,
            rootDirectory: 'Prime_Output',
            useAbsolutePath: false,
            commonPrompt: 'folder common',
            r2: { autoUpload: false, bucket: null, prefix: null },
            createdAt: now,
            updatedAt: now,
        }
        const laterFolder: GenerationFolder = {
            ...capturedFolder,
            id: 'generation-folder-later',
            name: 'Later',
            rootDirectory: 'Later_Output',
            commonPrompt: 'later common',
        }
        stores.useSettingsStore.setState({
            autoSave: true,
            generationFolders: [capturedFolder, laterFolder],
            activeGenerationFolderId: capturedFolder.id,
        })
        stores.useGenerationStore.setState({
            compositionMode: 'legacy',
            basePrompt: 'subject',
            batchCount: 2,
        })
        runtimeCapture.fetchOverride = async (input: string | URL | Request, init?: RequestInit) => {
            runtimeCapture.requests.push({
                mode: 'non-streaming',
                endpoint: String(input),
                payload: JSON.parse(String(init?.body)) as Record<string, unknown>,
            })
            stores.useSettingsStore.setState({ activeGenerationFolderId: laterFolder.id })
            return new Response(runtimeCapture.zipBytes, { status: 200 })
        }

        await stores.useGenerationStore.getState().generate()

        expect(runtimeCapture.params.map(item => item.prompt)).toEqual([
            'folder common, subject',
            'folder common, subject',
        ])
        expect(runtimeCapture.writes).toHaveLength(2)
        expect(runtimeCapture.writes.map(write => write.location)).toEqual([
            expect.stringContaining('Prime_Output/'),
            expect.stringContaining('Prime_Output/'),
        ])
        expect(runtimeCapture.writes.some(write => write.location.startsWith('Later_Output/'))).toBe(false)
    })

    it('keeps source-image infill transport-derived and preserves manual character positions in v2', async () => {
        stores.useSettingsStore.setState({ useStreaming: true })
        stores.useCharacterPromptStore.setState({
            positionEnabled: true,
            characters: [{
                id: 'character:hero',
                name: 'Hero',
                prompt: 'green eyes',
                negative: 'glasses',
                enabled: true,
                position: { x: 0.2, y: 0.8 },
            }],
        })
        stores.useGenerationStore.setState({
            compositionMode: 'v2',
            selectedRecipeId: 'main:direct',
            basePrompt: 'portrait',
            sourceImage: SYNTHETIC_SOURCE,
            mask: SYNTHETIC_MASK,
            i2iMode: 'inpaint',
            strength: 0.55,
            noise: 0.12,
        })

        await stores.useGenerationStore.getState().generate()

        expect(runtimeCapture.requests).toHaveLength(1)
        expect(runtimeCapture.requests[0].mode).toBe('non-streaming')
        expect(runtimeCapture.params[0]).toMatchObject({
            width: 768,
            height: 1024,
            strength: 0.55,
            noise: 0.12,
            characterPositionEnabled: true,
            characterPrompts: [{
                prompt: 'green eyes',
                negative: 'glasses',
                enabled: true,
                position: { x: 0.2, y: 0.8 },
            }],
        })
        expect(stores.useGenerationStore.getState().lastResolvedPlan).toMatchObject({
            params: {
                sourceMode: 'inpaint',
                sourceImageResourceId: 'main-resource:source-image',
                maskResourceId: 'main-resource:mask',
            },
            characters: [{
                characterId: 'character:hero',
                position: { mode: 'manual', x: 0.2, y: 0.8 },
            }],
            resources: [
                { id: 'main-resource:source-image', digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) },
                { id: 'main-resource:mask', digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) },
            ],
        })
        expect(runtimeCapture.events[0].detail.path).toBe(`memory://NAI_Blue_INPAINT_${FIXED_TIME}.png`)
    })

    it('materializes character and vibe resources only at the existing v2 transport boundary', async () => {
        const encodedVibe = 'data:application/octet-stream;base64,RU5DT0RFRA=='
        stores.useCharacterStore.setState({
            characterImages: [{
                id: 'reference:hero',
                base64: `data:image/png;base64,${TINY_PNG_BASE64}`,
                thumbnail: 'data:image/jpeg;base64,SEVST19USFVNQg==',
                enabled: true,
                informationExtracted: 1,
                strength: 0.45,
                fidelity: 0.72,
                referenceType: 'style',
                cacheKey: 'synthetic-cache-key-not-for-snapshots',
            }],
            vibeImages: [{
                id: 'reference:vibe',
                base64: `data:image/png;base64,${TINY_PNG_BASE64}`,
                thumbnail: 'data:image/jpeg;base64,VklCRV9USFVNQg==',
                enabled: true,
                encodedVibe,
                informationExtracted: 0.8,
                strength: 0.35,
                fidelity: 0.6,
                referenceType: 'character&style',
            }],
            _imagesLoaded: true,
        })
        stores.useGenerationStore.setState({
            compositionMode: 'v2',
            selectedRecipeId: 'main:direct',
            basePrompt: 'resource boundary',
        })

        await stores.useGenerationStore.getState().generate()

        expect(runtimeCapture.requests).toHaveLength(1)
        expect(runtimeCapture.params[0]).toMatchObject({
            charImages: [`data:image/png;base64,${TINY_PNG_BASE64}`],
            charStrength: [0.45],
            charFidelity: [0.72],
            charReferenceType: ['style'],
            charCacheKeys: ['synthetic-cache-key-not-for-snapshots'],
            vibeImages: [`data:image/png;base64,${TINY_PNG_BASE64}`],
            vibeInfo: [0.8],
            vibeStrength: [0.35],
            preEncodedVibes: [encodedVibe],
        })
        const plan = stores.useGenerationStore.getState().lastResolvedPlan
        expect(plan?.resources.map(resource => resource.id)).toEqual([
            'main-resource:character:reference:hero',
            'main-resource:vibe:reference:vibe',
        ])
        expect(plan?.resources.every(resource => /^sha256:[0-9a-f]{64}$/.test(resource.digest ?? ''))).toBe(true)
        expect(JSON.stringify(plan)).not.toMatch(/iVBOR|synthetic-cache-key|RU5DT0RFRA/)

        const firstPlanHash = plan?.planHash
        stores.useCharacterStore.setState(state => ({
            characterImages: state.characterImages.map(image => ({ ...image, base64: '' })),
            vibeImages: state.vibeImages.map(image => ({ ...image, base64: '', encodedVibe: undefined })),
            _imagesLoaded: false,
            ensureImagesLoaded: async () => {
                stores.useCharacterStore.setState(current => ({
                    characterImages: current.characterImages.map(image => ({
                        ...image,
                        base64: `data:image/png;base64,${TINY_PNG_BASE64}`,
                    })),
                    vibeImages: current.vibeImages.map(image => ({
                        ...image,
                        base64: `data:image/png;base64,${TINY_PNG_BASE64}`,
                        encodedVibe,
                    })),
                    _imagesLoaded: true,
                }))
            },
        }))
        await stores.useGenerationStore.getState().generate()
        expect(stores.useGenerationStore.getState().lastResolvedPlan?.planHash).toEqual(firstPlanHash)
    })

    it('cancels during v2 resource hydration before any API request', async () => {
        let releaseHydration = () => undefined
        let hydrationStarted = () => undefined
        const hydrationGate = new Promise<void>(resolve => { releaseHydration = resolve })
        const started = new Promise<void>(resolve => { hydrationStarted = resolve })
        stores.useCharacterStore.setState({
            ensureImagesLoaded: async () => {
                runtimeCapture.calls.push('images:ensure-loaded')
                hydrationStarted()
                await hydrationGate
            },
        })
        stores.useGenerationStore.setState({
            compositionMode: 'v2',
            selectedRecipeId: 'main:direct',
            basePrompt: 'cancel before transport',
        })

        const generation = stores.useGenerationStore.getState().generate()
        await started
        stores.useGenerationStore.getState().cancelGeneration()
        releaseHydration()
        await generation

        expect(runtimeCapture.requests).toEqual([])
        expect(runtimeCapture.events).toEqual([])
        expect(stores.useGenerationStore.getState()).toMatchObject({
            isGenerating: false,
            generatingMode: null,
            history: [],
        })
    })

    it('cancels an active v2 stream without preview/output/history side effects', async () => {
        stores.useSettingsStore.setState({ useStreaming: true })
        stores.useGenerationStore.setState({
            compositionMode: 'v2',
            selectedRecipeId: 'main:direct',
            basePrompt: 'cancel stream',
        })
        let transportStarted = () => undefined
        const started = new Promise<void>(resolve => { transportStarted = resolve })
        runtimeCapture.fetchOverride = async (input: string | URL | Request, init?: RequestInit) => {
            const endpoint = String(input)
            const payload = JSON.parse(String(init?.body)) as Record<string, unknown>
            runtimeCapture.requests.push({ mode: 'streaming', endpoint, payload })
            transportStarted()
            return await new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    reject(new DOMException('Aborted', 'AbortError'))
                }, { once: true })
            })
        }

        const generation = stores.useGenerationStore.getState().generate()
        await started
        stores.useGenerationStore.getState().cancelGeneration()
        await generation

        expect(runtimeCapture.requests).toHaveLength(1)
        expect(runtimeCapture.events).toEqual([])
        expect(stores.useGenerationStore.getState()).toMatchObject({
            isGenerating: false,
            generatingMode: null,
            previewImage: null,
            history: [],
        })
    })
})
