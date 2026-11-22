import { isContentChecksum, isSavedArtifactId, isUnitInterval, type SavedArtifactBinding } from './scene-image-source'

export const PRECISE_REFERENCE_TYPES = ['character', 'style', 'character&style'] as const
export type ScenePreciseReferenceType = typeof PRECISE_REFERENCE_TYPES[number]
/** Same bound as the character store's MAX_CHARACTER_IMAGES, the most a human can enable in the app. */
export const MAX_SCENE_PRECISE_REFERENCES = 10

export interface ScenePreciseReference extends SavedArtifactBinding {
    readonly referenceType: ScenePreciseReferenceType
    readonly strength: number
    readonly fidelity: number
}

export function isScenePreciseReference(value: unknown): value is ScenePreciseReference {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const reference = value as Record<string, unknown>
    return Object.keys(reference).length === 5
        && isSavedArtifactId(reference.artifactId)
        && isContentChecksum(reference.contentChecksum)
        && PRECISE_REFERENCE_TYPES.includes(reference.referenceType as ScenePreciseReferenceType)
        && isUnitInterval(reference.strength)
        && isUnitInterval(reference.fidelity)
}

/** Stored form: null or an empty list both mean "no Precise Reference"; a list never repeats an Artifact. */
export function isScenePreciseReferences(value: unknown): value is readonly ScenePreciseReference[] | null {
    if (value === null) return true
    return Array.isArray(value) && value.length <= MAX_SCENE_PRECISE_REFERENCES
        && value.every(isScenePreciseReference)
        && new Set(value.map(reference => (reference as ScenePreciseReference).artifactId)).size === value.length
}
