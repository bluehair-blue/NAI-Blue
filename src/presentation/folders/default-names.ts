import type { TFunction } from 'i18next'
import { DEFAULT_GENERATION_FOLDER_ID, DEFAULT_GENERATION_FOLDER_NAME } from '@/domain/generation-folders'
import { DEFAULT_SCENE_PRESET_ID, type ScenePreset } from '@/stores/scene-store'

// Built-in folders and presets are stored under Korean seed names in every profile, and those names
// also form output paths, so the stored text is never rewritten. Screens translate the seed names when
// they draw them; a name the user typed is shown as typed.

export function generationFolderDisplayName(folder: { id: string; name: string }, t: TFunction): string {
    return folder.id === DEFAULT_GENERATION_FOLDER_ID && folder.name === DEFAULT_GENERATION_FOLDER_NAME
        ? t('generationFolders.defaultName', DEFAULT_GENERATION_FOLDER_NAME)
        : folder.name
}

/**
 * For the " / "-joined display paths of resolveGenerationFolderAuthority, where only the first segment
 * can be the built-in root. A root the user named exactly like the seed is translated too.
 */
export function generationFolderDisplayPath(path: string, t: TFunction): string {
    const [first, ...rest] = path.split(' / ')
    return first === DEFAULT_GENERATION_FOLDER_NAME
        ? [t('generationFolders.defaultName', DEFAULT_GENERATION_FOLDER_NAME), ...rest].join(' / ')
        : path
}

/**
 * The fixed default preset cannot be renamed; presets made from the built-in folder inherit its seed
 * name and carry no link back to it, so the seed name itself is what gets translated.
 */
export function scenePresetDisplayName(preset: { id: string; name: string }, t: TFunction): string {
    if (preset.id === DEFAULT_SCENE_PRESET_ID) return t('preset.default', '기본')
    if (preset.name === DEFAULT_GENERATION_FOLDER_NAME) return t('generationFolders.defaultName', DEFAULT_GENERATION_FOLDER_NAME)
    return preset.name
}

/** Display counterpart of getScenePresetPathSegments, which must keep the stored names for output paths. */
export function scenePresetDisplayPath(presets: readonly ScenePreset[], presetId: string, t: TFunction): string {
    const byId = new Map(presets.map(preset => [preset.id, preset]))
    const visited = new Set<string>()
    const segments: string[] = []
    let current = byId.get(presetId)
    while (current && !visited.has(current.id)) {
        visited.add(current.id)
        segments.unshift(scenePresetDisplayName(current, t) || t('preset.default', '기본'))
        current = current.parentId ? byId.get(current.parentId) : undefined
    }
    return segments.join(' / ')
}
