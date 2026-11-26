import { flushSceneAuthorityRuntime } from '@/lib/scene-authority-runtime'
import { getRuntimeSceneRepository } from '@/lib/scene-migration-startup'
import { type ScenePreset, useSceneStore } from '@/stores/scene-store'

export interface SaveFolderAssetDetailsInput {
    presetId: string
    sceneId: string
    description: string
    quantity?: number
    unconfirmedMessage?: string
}

export interface SaveFolderAssetDetailsDeps {
    updateScenePrompts: (presetId: string, sceneId: string, prompts: { additional: string }) => void
    setSceneProductionCounts: (targets: Array<{ presetId: string; sceneId: string }>, count: number) => void
    flush: () => Promise<void>
    getDocument: (presetId: string) => Promise<Pick<ScenePreset, 'scenes'> | null | undefined>
}

const DEFAULT_UNCONFIRMED_MESSAGE = '저장을 확인하지 못했습니다. 입력한 내용은 이 창에 남아 있습니다.'

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

    updateScenePrompts(input.presetId, input.sceneId, { additional: input.description })
    if (input.quantity !== undefined) {
        setSceneProductionCounts([{ presetId: input.presetId, sceneId: input.sceneId }], input.quantity)
    }

    // The store is optimistic: only the existing authority's exact readback proves persistence.
    await flush()
    const document = await getDocument(input.presetId)
    const saved = document?.scenes.find(scene => scene.id === input.sceneId)
    const descriptionMatches = saved?.prompts?.additional === input.description
    const quantityMatches = input.quantity === undefined || saved?.productionCount === input.quantity
    if (!descriptionMatches || !quantityMatches) {
        throw new Error(input.unconfirmedMessage ?? DEFAULT_UNCONFIRMED_MESSAGE)
    }
}
