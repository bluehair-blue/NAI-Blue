import { appDataDir, join } from '@tauri-apps/api/path'
import { BaseDirectory, exists, mkdir, readTextFile, stat, writeTextFile } from '@tauri-apps/plugin-fs'
import { runtimeCapabilities } from '@/platform/capabilities'
import { isDesktopRuntime } from '@/platform/runtime'
import { planGenerationFolderChanges } from '@/application/folder/plan-folder-changes'
import { applyRuntimeGenerationFolderChanges } from '@/services/folder/apply-runtime-folder-changes'
import { patchScenes } from '@/application/scene/patch-scenes'
import { applySceneDocumentProjection } from '@/lib/scene-authority-runtime'
import { getRuntimeSceneRepository } from '@/lib/scene-migration-startup'
import { useAssetModuleStore } from '@/stores/asset-module-store'
import { usePresetStore } from '@/stores/preset-store'
import { useSceneStore } from '@/stores/scene-store'
import {
    applyGenerationFolderDocumentProjection,
    useSettingsStore,
} from '@/stores/settings-store'
import {
    AGENT_GUIDE_FILE,
    AGENT_REQUEST_EXAMPLE_FILE,
    AGENT_REQUEST_FILE,
    AGENT_RESULT_FILE,
    AGENT_SNAPSHOT_FILE,
    AGENT_WORKSPACE_DIRECTORY,
    AGENT_WORKSPACE_SCHEMA_VERSION,
    createAgentRequestExample,
    createAgentWorkspaceSnapshot,
    parseAgentEditRequest,
    patchAgentPreset,
    type AgentEditAction,
    type AgentEditRequest,
    type AgentEditResult,
    type AgentWorkspaceDirectories,
    type AgentWorkspaceSnapshot,
} from './agent-workspace-contract'

const POLL_INTERVAL_MS = 900
const REFRESH_DEBOUNCE_MS = 350

export interface AgentWorkspaceBridgeStatus {
    supported: boolean
    running: boolean
    workspacePath: string | null
    revision: number
    lastSnapshotAt: string | null
    lastRequestId: string | null
    lastResult: AgentEditResult['status'] | null
    lastMessage: string | null
    lastError: string | null
}

const listeners = new Set<() => void>()
let bridgeStatus: AgentWorkspaceBridgeStatus = {
    supported: false,
    running: false,
    workspacePath: null,
    revision: 0,
    lastSnapshotAt: null,
    lastRequestId: null,
    lastResult: null,
    lastMessage: null,
    lastError: null,
}

let stopBridge: (() => void) | null = null
let workspaceRevision = 0
let lastDataFingerprint = ''
let lastRequestId: string | null = null

function updateStatus(patch: Partial<AgentWorkspaceBridgeStatus>): void {
    bridgeStatus = { ...bridgeStatus, ...patch }
    listeners.forEach(listener => listener())
}

export function getAgentWorkspaceBridgeStatus(): AgentWorkspaceBridgeStatus {
    return bridgeStatus
}

export function subscribeAgentWorkspaceBridge(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

class AgentResourceRevisionConflict extends Error {}

function currentDirectories(): AgentWorkspaceDirectories {
    const settings = useSettingsStore.getState()
    return {
        output: { path: settings.savePath, useAbsolutePath: settings.useAbsolutePath },
        scene: { path: settings.sceneSavePath, useAbsolutePath: settings.useAbsoluteScenePath },
        styleLab: { path: settings.styleLabSavePath, useAbsolutePath: settings.useAbsoluteStyleLabPath },
        tools: { path: settings.toolsSavePath, useAbsolutePath: settings.useAbsoluteToolsPath },
        library: { path: settings.libraryPath, useAbsolutePath: settings.useAbsoluteLibraryPath },
    }
}

async function snapshotSource(): Promise<
    Omit<Parameters<typeof createAgentWorkspaceSnapshot>[0], 'revision' | 'generatedAt'>
> {
    const preset = usePresetStore.getState()
    const sceneAuthorityActive = useSceneStore.getState().sceneAuthorityInitialized
    const sceneDocuments = sceneAuthorityActive
        ? await (async () => {
            const repository = getRuntimeSceneRepository()
            const summaries = await repository.listDocuments()
            return (await Promise.all(summaries.map(summary => repository.getDocument(summary.presetId))))
                .filter(document => document !== null)
                .sort((left, right) => left.presetId.localeCompare(right.presetId))
        })()
        : []
    return {
        activePresetId: preset.activePresetId,
        presets: preset.presets,
        directories: currentDirectories(),
        assetProfile: useAssetModuleStore.getState().profile,
        sceneDocuments,
        generationFolderDocument: useSettingsStore.getState().generationFolderDocument,
    }
}

function sourceFingerprint(source: Awaited<ReturnType<typeof snapshotSource>>): string {
    return JSON.stringify(source)
}

async function ensureWorkspaceDirectory(): Promise<void> {
    if (!(await exists(AGENT_WORKSPACE_DIRECTORY, { baseDir: BaseDirectory.AppData }))) {
        await mkdir(AGENT_WORKSPACE_DIRECTORY, { baseDir: BaseDirectory.AppData, recursive: true })
    }
}

async function writeWorkspaceText(path: string, content: string): Promise<void> {
    await writeTextFile(path, content, { baseDir: BaseDirectory.AppData })
}

function workspaceGuide(): string {
    return `# NAI Blue Agent Workspace

This directory is a local desktop-only bridge. It never contains API credentials or image bytes.

1. Read \`snapshot.json\` and note its \`revision\`.
2. Copy \`request.example.json\` to \`request.json\`.
3. Keep \`baseRevision\` equal to the snapshot revision, use a unique \`requestId\`, and edit one action.
4. Set \`status\` to \`ready\` only after the JSON is complete.
5. Read \`result.json\`. If it says \`stale\`, reread the snapshot and create a new request.

Supported actions are \`preset.patch\`, \`paths.patch\`, \`asset-profile.replace\`, \`scene.patch\`, and \`folder.patch\`.
Scene and Folder actions must identify the resource and copy its current \`revision\` into \`expectedRevision\`.
Unknown fields, credentials, base64, image bytes, oversized values, and stale revisions are rejected.
`
}

async function readExistingRevision(): Promise<number> {
    if (!(await exists(AGENT_SNAPSHOT_FILE, { baseDir: BaseDirectory.AppData }))) return 0
    try {
        const raw = JSON.parse(await readTextFile(AGENT_SNAPSHOT_FILE, { baseDir: BaseDirectory.AppData })) as { revision?: unknown }
        return typeof raw.revision === 'number' && Number.isSafeInteger(raw.revision) && raw.revision >= 0
            ? raw.revision
            : 0
    } catch {
        return 0
    }
}

async function readLastResult(): Promise<void> {
    if (!(await exists(AGENT_RESULT_FILE, { baseDir: BaseDirectory.AppData }))) return
    try {
        const result = JSON.parse(await readTextFile(AGENT_RESULT_FILE, { baseDir: BaseDirectory.AppData })) as AgentEditResult
        if (result.schemaVersion === AGENT_WORKSPACE_SCHEMA_VERSION && typeof result.requestId === 'string') {
            lastRequestId = result.requestId
            updateStatus({
                lastRequestId: result.requestId,
                lastResult: result.status,
                lastMessage: result.message,
            })
        }
    } catch {
        // A damaged result is diagnostic-only; a future request can replace it.
    }
}

/**
 * Materializes an allowlisted store projection for external agents. The source
 * stores remain authoritative; snapshot writes are recoverable read models and
 * never include credential, history, diagnostic, or image-byte repositories.
 */
export async function refreshAgentWorkspaceSnapshot(force = false): Promise<AgentWorkspaceSnapshot> {
    if (!isDesktopRuntime || !runtimeCapabilities.externalProfileFileWatch.supported) {
        throw new Error('Agent Workspace requires the desktop Tauri app.')
    }
    await ensureWorkspaceDirectory()
    const source = await snapshotSource()
    const fingerprint = sourceFingerprint(source)
    if (force || fingerprint !== lastDataFingerprint) {
        workspaceRevision += 1
        lastDataFingerprint = fingerprint
    }
    const snapshot = createAgentWorkspaceSnapshot({
        ...source,
        revision: workspaceRevision,
    })
    await Promise.all([
        writeWorkspaceText(AGENT_SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2)),
        writeWorkspaceText(AGENT_REQUEST_EXAMPLE_FILE, JSON.stringify(createAgentRequestExample(snapshot), null, 2)),
        writeWorkspaceText(AGENT_GUIDE_FILE, workspaceGuide()),
    ])
    updateStatus({
        revision: snapshot.revision,
        lastSnapshotAt: snapshot.generatedAt,
        lastError: null,
    })
    return snapshot
}

async function applyPathPatch(patch: Extract<AgentEditAction, { type: 'paths.patch' }>['patch']): Promise<void> {
    const settings = useSettingsStore.getState()
    if (patch.output) await settings.setSavePath(patch.output.path, patch.output.useAbsolutePath)
    if (patch.scene) settings.setSceneSavePath(patch.scene.path, patch.scene.useAbsolutePath)
    if (patch.styleLab) settings.setStyleLabSavePath(patch.styleLab.path, patch.styleLab.useAbsolutePath)
    if (patch.tools) settings.setToolsSavePath(patch.tools.path, patch.tools.useAbsolutePath)
    if (patch.library) settings.setLibraryPath(patch.library.path, patch.library.useAbsolutePath)
}

async function applyRequest(request: AgentEditRequest): Promise<void> {
    switch (request.action.type) {
        case 'preset.patch': {
            const action = request.action
            const store = usePresetStore.getState()
            const current = store.presets.find(preset => preset.id === action.presetId)
            if (!current) throw new Error(`Preset not found: ${action.presetId}`)
            store.replacePresetFromExternal(patchAgentPreset(current, action.patch))
            return
        }
        case 'paths.patch':
            await applyPathPatch(request.action.patch)
            return
        case 'asset-profile.replace': {
            const profileStore = useAssetModuleStore.getState()
            const replacement = { ...request.action.profile, revision: profileStore.profile.revision }
            const result = await profileStore.saveToDisk(replacement, 'agent')
            if (result.status === 'conflict') {
                throw new AgentResourceRevisionConflict('Asset Profile changed while applying the request.')
            }
            return
        }
        case 'scene.patch': {
            const action = request.action
            if (!useSceneStore.getState().sceneAuthorityInitialized) {
                throw new Error('Scene authority V2 is not active; the preserved V1 projection is read-only.')
            }
            const result = await patchScenes({
                repository: getRuntimeSceneRepository(),
                presetId: action.presetId,
                expectedRevision: action.expectedRevision,
                scenePatches: action.scenePatches,
            })
            if (result.status === 'COMMITTED') {
                applySceneDocumentProjection(result.document)
                return
            }
            if (result.status === 'REVISION_CONFLICT') {
                throw new AgentResourceRevisionConflict(
                    `Scene ${action.presetId} changed from revision ${action.expectedRevision}. Read snapshot.json and retry.`,
                )
            }
            if (result.status === 'NOT_FOUND') throw new Error(`Scene document not found: ${action.presetId}`)
            if (result.status === 'INVALID') throw new TypeError(result.message)
            throw new Error(`Scene repository storage conflict for ${action.presetId}.`)
        }
        case 'folder.patch': {
            const action = request.action
            const authorityDocument = useSettingsStore.getState().generationFolderDocument
            if (authorityDocument === null || authorityDocument.workspaceId !== action.workspaceId) {
                throw new Error('Generation Folder authority V2 is not active; the preserved V1 projection is read-only.')
            }
            const { IndexedDbGenerationFolderRepository } = await import(
                '@/adapters/folder/indexeddb-generation-folder-repository'
            )
            const repository = new IndexedDbGenerationFolderRepository()
            const current = await repository.getDocument(action.workspaceId)
            if (current === null) throw new Error(`Generation Folder document not found: ${action.workspaceId}`)
            if (current.revision !== action.expectedRevision) {
                throw new AgentResourceRevisionConflict(
                    `Generation Folder ${action.workspaceId} changed from revision ${action.expectedRevision}. Read snapshot.json and retry.`,
                )
            }
            const settings = useSettingsStore.getState()
            const planned = planGenerationFolderChanges(current, action.patches, {
                directory: settings.savePath,
                useAbsolutePath: settings.useAbsolutePath,
            })
            if (planned.status !== 'PLANNED') throw new TypeError(planned.reason)
            const result = await applyRuntimeGenerationFolderChanges({
                workspaceId: action.workspaceId,
                expectedRevision: action.expectedRevision,
                expectedPlanHash: planned.planHash,
                changes: action.patches,
                defaults: {
                    directory: settings.savePath,
                    useAbsolutePath: settings.useAbsolutePath,
                },
            })
            if (result.status === 'COMMITTED') {
                applyGenerationFolderDocumentProjection(result.plan.document)
                return
            }
            if (result.status === 'REVISION_CONFLICT') {
                throw new AgentResourceRevisionConflict(
                    `Generation Folder ${action.workspaceId} changed from revision ${action.expectedRevision}. Read snapshot.json and retry.`,
                )
            }
            if (result.status === 'AUTHORIZATION_FAILED') {
                throw new Error(`Generation Folder directory authorization failed for: ${result.folderIds.join(', ')}`)
            }
            if (result.status === 'UNSUPPORTED') {
                throw new Error(`Generation Folder mutation is occupied or unavailable: ${result.occupancy.folderIds.join(', ')}`)
            }
            throw new Error(`Generation Folder mutation failed (${result.status}) for ${action.workspaceId}.`)
        }
    }
}

async function writeResult(result: AgentEditResult): Promise<void> {
    await writeWorkspaceText(AGENT_RESULT_FILE, JSON.stringify(result, null, 2))
    lastRequestId = result.requestId
    updateStatus({
        lastRequestId: result.requestId,
        lastResult: result.status,
        lastMessage: result.message,
        lastError: result.status === 'rejected' ? result.message : null,
    })
}

async function processRequestFile(): Promise<void> {
    let raw: unknown
    try {
        raw = JSON.parse(await readTextFile(AGENT_REQUEST_FILE, { baseDir: BaseDirectory.AppData }))
        const request = parseAgentEditRequest(raw)
        if (request === null || request.requestId === lastRequestId) return
        if (request.baseRevision !== workspaceRevision) {
            await writeResult({
                schemaVersion: AGENT_WORKSPACE_SCHEMA_VERSION,
                requestId: request.requestId,
                status: 'stale',
                processedAt: new Date().toISOString(),
                baseRevision: request.baseRevision,
                appliedRevision: null,
                message: `Snapshot revision changed from ${request.baseRevision} to ${workspaceRevision}. Read snapshot.json and retry.`,
            })
            return
        }
        await applyRequest(request)
        const snapshot = await refreshAgentWorkspaceSnapshot(true)
        await writeResult({
            schemaVersion: AGENT_WORKSPACE_SCHEMA_VERSION,
            requestId: request.requestId,
            status: 'applied',
            processedAt: new Date().toISOString(),
            baseRevision: request.baseRevision,
            appliedRevision: snapshot.revision,
            message: 'The requested app data change was validated and applied.',
        })
    } catch (error) {
        const candidate = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
        const status = error instanceof AgentResourceRevisionConflict ? 'stale' : 'rejected'
        await writeResult({
            schemaVersion: AGENT_WORKSPACE_SCHEMA_VERSION,
            requestId: typeof candidate.requestId === 'string' ? candidate.requestId : 'invalid-request',
            status,
            processedAt: new Date().toISOString(),
            baseRevision: typeof candidate.baseRevision === 'number' ? candidate.baseRevision : null,
            appliedRevision: null,
            message: errorMessage(error),
        })
    }
}

async function requestFingerprint(): Promise<string> {
    if (!(await exists(AGENT_REQUEST_FILE, { baseDir: BaseDirectory.AppData }))) return 'missing'
    const info = await stat(AGENT_REQUEST_FILE, { baseDir: BaseDirectory.AppData })
    return `${info.mtime?.getTime() ?? 'no-mtime'}:${info.size}`
}

export async function getAgentWorkspaceAbsolutePath(): Promise<string> {
    return join(await appDataDir(), AGENT_WORKSPACE_DIRECTORY)
}

/**
 * Starts one desktop-only bridge owner. Stable-fingerprint polling avoids
 * parsing a request while an editor is still writing it; store subscriptions
 * keep the read-only snapshot current without turning files into authority.
 */
export async function startAgentWorkspaceBridge(): Promise<() => void> {
    if (stopBridge) return stopBridge
    const supported = isDesktopRuntime && runtimeCapabilities.externalProfileFileWatch.supported
    if (!supported) {
        updateStatus({ supported: false, running: false, lastError: null })
        return () => undefined
    }

    await ensureWorkspaceDirectory()
    workspaceRevision = await readExistingRevision()
    await readLastResult()
    const workspacePath = await getAgentWorkspaceAbsolutePath()
    await refreshAgentWorkspaceSnapshot(true)

    let stopped = false
    let pollTimer: number | null = null
    let refreshTimer: number | null = null
    let observedFingerprint: string | null = null
    let processedFingerprint: string | null = null

    const scheduleRefresh = () => {
        if (refreshTimer !== null) window.clearTimeout(refreshTimer)
        refreshTimer = window.setTimeout(() => {
            refreshTimer = null
            void refreshAgentWorkspaceSnapshot().catch(error => updateStatus({ lastError: errorMessage(error) }))
        }, REFRESH_DEBOUNCE_MS)
    }
    const unsubscribers = [
        usePresetStore.subscribe(scheduleRefresh),
        useSettingsStore.subscribe(scheduleRefresh),
        useAssetModuleStore.subscribe(scheduleRefresh),
        useSceneStore.subscribe(scheduleRefresh),
    ]

    const poll = async () => {
        if (stopped) return
        try {
            const fingerprint = await requestFingerprint()
            if (fingerprint !== observedFingerprint) {
                observedFingerprint = fingerprint
            } else if (fingerprint !== 'missing' && fingerprint !== processedFingerprint) {
                processedFingerprint = fingerprint
                await processRequestFile()
            }
        } catch (error) {
            updateStatus({ lastError: errorMessage(error) })
        } finally {
            if (!stopped) pollTimer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS)
        }
    }

    stopBridge = () => {
        stopped = true
        if (pollTimer !== null) window.clearTimeout(pollTimer)
        if (refreshTimer !== null) window.clearTimeout(refreshTimer)
        unsubscribers.forEach(unsubscribe => unsubscribe())
        stopBridge = null
        updateStatus({ running: false })
    }
    updateStatus({
        supported: true,
        running: true,
        workspacePath,
        revision: workspaceRevision,
        lastError: null,
    })
    void poll()
    return stopBridge
}
