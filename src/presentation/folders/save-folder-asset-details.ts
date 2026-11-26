import { flushSceneAuthorityRuntime } from '@/lib/scene-authority-runtime'
import { getRuntimeSceneRepository } from '@/lib/scene-migration-startup'
import { resolveScenePrompts, type ScenePreset, useSceneStore } from '@/stores/scene-store'

export interface SaveFolderAssetDetailsInput {
    presetId: string
    sceneId: string
    description: string
    quantity?: number
    unconfirmedMessage?: string
    /** When the authority write itself fails, put back the description the store held just before this save. */
    restoreOnFlushFailure?: boolean
}

export interface SaveFolderAssetDetailsDeps {
    updateScenePrompts: (presetId: string, sceneId: string, prompts: { additional: string }) => void
    setSceneProductionCounts: (targets: Array<{ presetId: string; sceneId: string }>, count: number) => void
    flush: () => Promise<void>
    getDocument: (presetId: string) => Promise<Pick<ScenePreset, 'scenes'> | null | undefined>
    readDescription: (presetId: string, sceneId: string) => string | undefined
}

const DEFAULT_UNCONFIRMED_MESSAGE = '저장을 확인하지 못했습니다. 입력한 내용은 이 창에 남아 있습니다.'

/** The write reached the authority but its readback could not prove it; the store keeps the new text. */
export class FolderAssetSaveUnconfirmedError extends Error {
    readonly readbackError: unknown

    constructor(message: string, readbackError?: unknown) {
        super(message)
        this.name = 'FolderAssetSaveUnconfirmedError'
        this.readbackError = readbackError
    }
}

function readLiveDescription(presetId: string, sceneId: string): string | undefined {
    const scene = useSceneStore.getState().presets
        .find(preset => preset.id === presetId)?.scenes
        .find(candidate => candidate.id === sceneId)
    return scene === undefined ? undefined : resolveScenePrompts(scene).additional
}

/** Persists a folder asset edit through SceneStore and verifies authority readback before claiming success. */
export async function saveFolderAssetDetails(
    input: SaveFolderAssetDetailsInput,
    deps?: Partial<SaveFolderAssetDetailsDeps>,
): Promise<void> {
    if (input.description.length > 20_000) {
        throw new Error('Description exceeds 20,000 characters.')
    }
    if (input.quantity !== undefined && (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 999)) {
        throw new Error('Quantity must be an integer between 1 and 999.')
    }

    const store = useSceneStore.getState()
    const updateScenePrompts = deps?.updateScenePrompts ?? store.updateScenePrompts
    const setSceneProductionCounts = deps?.setSceneProductionCounts ?? store.setSceneProductionCounts
    const flush = deps?.flush ?? flushSceneAuthorityRuntime
    const getDocument = deps?.getDocument ?? (presetId => getRuntimeSceneRepository().getDocument(presetId))
    const readDescription = deps?.readDescription ?? readLiveDescription

    const previousDescription = input.restoreOnFlushFailure
        ? readDescription(input.presetId, input.sceneId)
        : undefined
    updateScenePrompts(input.presetId, input.sceneId, { additional: input.description })
    if (input.quantity !== undefined) {
        setSceneProductionCounts([{ presetId: input.presetId, sceneId: input.sceneId }], input.quantity)
    }

    try {
        await flush()
    } catch (cause) {
        // A revision conflict already re-applied the authority's text; only our own optimistic text is withdrawn.
        if (previousDescription !== undefined && readDescription(input.presetId, input.sceneId) === input.description) {
            updateScenePrompts(input.presetId, input.sceneId, { additional: previousDescription })
        }
        throw cause
    }

    // After a successful flush the new text may already be on disk, so restoring here could overwrite it.
    const unconfirmedMessage = input.unconfirmedMessage ?? DEFAULT_UNCONFIRMED_MESSAGE
    let document: Awaited<ReturnType<typeof getDocument>>
    try {
        document = await getDocument(input.presetId)
    } catch (cause) {
        throw new FolderAssetSaveUnconfirmedError(unconfirmedMessage, cause)
    }
    const saved = document?.scenes.find(scene => scene.id === input.sceneId)
    const descriptionMatches = saved?.prompts?.additional === input.description
    const quantityMatches = input.quantity === undefined || saved?.productionCount === input.quantity
    if (!descriptionMatches || !quantityMatches) {
        throw new FolderAssetSaveUnconfirmedError(unconfirmedMessage)
    }
}
