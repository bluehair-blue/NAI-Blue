import { generationFolderDescendantIds, type GenerationFolder } from '@/domain/generation-folders'
import {
    DEFAULT_SCENE_GENERATION,
    DEFAULT_SCENE_PROMPTS,
    type SceneCard,
    type SceneFolderTemplate,
    type ScenePreset,
} from '@/stores/scene-store'

export const UNASSIGNED_FOLDER_ID = '__unassigned__'
export const MAX_FOLDER_ASSET_ROWS = 2_400

export interface FolderAssetRow {
    readonly key: string
    readonly presetId: string
    readonly presetName: string
    readonly scene: SceneCard
}

/** Legacy pending counts can seed the first edit; new workbench quantities survive Queue consumption/restarts. */
export function folderAssetProductionCount(scene: SceneCard): number {
    return scene.productionCount ?? (scene.queueCount > 0 ? scene.queueCount : 1)
}

/** Read projection only: folder membership stays on Scene, including legacy manual destinations. */
export function collectFolderAssets(
    presets: readonly ScenePreset[],
    folders: readonly GenerationFolder[],
    folderId: string | null,
    includeChildren: boolean,
): FolderAssetRow[] {
    const ids = folderId === null ? null : new Set([
        folderId,
        ...(includeChildren ? generationFolderDescendantIds(folders, folderId) : []),
    ])
    return presets.flatMap(preset => preset.scenes
        .filter(scene => folderId === null
            || (folderId === UNASSIGNED_FOLDER_ID
                ? !scene.generationFolderId
                : scene.generationFolderId !== undefined && ids!.has(scene.generationFolderId)))
        .map(scene => ({ key: JSON.stringify([preset.id, scene.id]), presetId: preset.id, presetName: preset.name, scene })))
}

export interface FolderAssetInput {
    name: string
    prompt: string
    count: number
    filenameTemplate?: string
}

type TableError = { line: number; code: 'columns' | 'name' | 'prompt' | 'count' | 'limit' }

/** Plain TSV is intentionally explicit: prompt commas are content, never column separators. */
export function parseFolderAssetTable(text: string): { rows: FolderAssetInput[]; errors: TableError[] } {
    const rows: FolderAssetInput[] = []
    const errors: TableError[] = []
    const lines = text.replace(/^\uFEFF/u, '').split(/\r?\n/u)
    let firstContent = true
    let rowCount = 0
    for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].trim()) continue
        const cells = lines[index].split('\t').map(cell => cell.trim())
        const header = firstContent && ['name', '이름'].includes(cells[0].toLowerCase())
            && ['prompt', '프롬프트'].includes(cells[1]?.toLowerCase())
        firstContent = false
        if (header) continue
        rowCount += 1
        const line = index + 1
        if (rowCount > MAX_FOLDER_ASSET_ROWS) {
            errors.push({ line, code: 'limit' })
            break
        }
        if (cells.length < 2 || cells.length > 4) { errors.push({ line, code: 'columns' }); continue }
        const [name, prompt, rawCount = '', filenameTemplate = ''] = cells
        if (!name || name.length > 96) { errors.push({ line, code: 'name' }); continue }
        if (!prompt || prompt.length > 20_000) { errors.push({ line, code: 'prompt' }); continue }
        const count = rawCount === '' ? 1 : Number(rawCount)
        if ((rawCount !== '' && !/^\d+$/u.test(rawCount)) || !Number.isSafeInteger(count) || count < 1 || count > 999) {
            errors.push({ line, code: 'count' }); continue
        }
        rows.push({ name, prompt, count, ...(filenameTemplate ? { filenameTemplate } : {}) })
    }
    return { rows, errors }
}

/** One detached standard import reuses the Scene store and its durable-authority bridge. */
export function createFolderAssetPreset(input: {
    name: string
    folderId: string
    rows: readonly FolderAssetInput[]
    template?: SceneFolderTemplate
}): ScenePreset {
    const template = input.template
    const createdAt = Date.now()
    return {
        id: crypto.randomUUID(),
        name: input.name,
        createdAt,
        scenes: input.rows.map(row => {
            const additional = [template?.prompts.additional ?? template?.scenePrompt, row.prompt].filter(Boolean).join(', ')
            return {
                id: crypto.randomUUID(), name: row.name, createdAt,
                generationFolderId: input.folderId,
                scenePrompt: additional,
                prompts: { ...DEFAULT_SCENE_PROMPTS, ...template?.prompts, additional },
                generation: { ...DEFAULT_SCENE_GENERATION, ...template?.generation },
                productionCount: row.count, queueCount: 0, images: [],
                // Locked seeds repeat within a batch; retain the planner's ordinal fallback unless a name was explicitly chosen.
                filenameTemplate: row.filenameTemplate ?? template?.filenameTemplate ?? (template?.generation.seedLocked ? undefined : '{scene.name}_{seed}'),
                ...(template?.characterCaptions === undefined ? {} : { characterCaptions: structuredClone(template.characterCaptions) }),
                ...(template?.characterPositionEnabled === undefined ? {} : { characterPositionEnabled: template.characterPositionEnabled }),
                ...(template?.width === undefined ? {} : { width: template.width }),
                ...(template?.height === undefined ? {} : { height: template.height }),
                ...(template?.excludePinned === undefined ? {} : { excludePinned: template.excludePinned }),
                ...(template?.metadataMode === undefined ? {} : { metadataMode: template.metadataMode }),
                ...(template?.compositionRef === undefined ? {} : { compositionRef: structuredClone(template.compositionRef) }),
            }
        }),
    }
}
