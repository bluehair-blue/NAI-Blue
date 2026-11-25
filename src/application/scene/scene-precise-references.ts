import {
    MAX_PRECISE_REFERENCE_STRENGTH,
    PRECISE_REFERENCE_TYPES,
    supportsPreferSameOutfit,
    type PreciseReferenceType,
} from '@/domain/generation/precise-reference'
import { isContentChecksum, isSavedArtifactId, isUnitInterval, type SavedArtifactBinding } from './scene-image-source'

export { MAX_PRECISE_REFERENCE_STRENGTH, PRECISE_REFERENCE_TYPES }
export type ScenePreciseReferenceType = PreciseReferenceType
/** Same bound as the character store's MAX_CHARACTER_IMAGES, the most a human can enable in the app. */
export const MAX_SCENE_PRECISE_REFERENCES = 10

export interface ScenePreciseReference extends SavedArtifactBinding {
    readonly referenceType: ScenePreciseReferenceType
    /** 0 up to the widest model range; the Scene's own model is checked when it is planned. */
    readonly strength: number
    /** V4 and V4.5 only (0.6 when absent). V5 has no Fidelity. */
    readonly fidelity?: number
    /** "Prefer same outfit": V5, character and character&style only. Absent means NovelAI's default for the type. */
    readonly preferSameOutfit?: boolean
}

const REQUIRED_KEYS = ['artifactId', 'contentChecksum', 'referenceType', 'strength']
const KEYS = [...REQUIRED_KEYS, 'fidelity', 'preferSameOutfit']

export function isScenePreciseReference(value: unknown): value is ScenePreciseReference {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const reference = value as Record<string, unknown>
    return Object.keys(reference).every(key => KEYS.includes(key))
        && REQUIRED_KEYS.every(key => Object.prototype.hasOwnProperty.call(reference, key))
        && isSavedArtifactId(reference.artifactId)
        && isContentChecksum(reference.contentChecksum)
        && PRECISE_REFERENCE_TYPES.includes(reference.referenceType as ScenePreciseReferenceType)
        && typeof reference.strength === 'number' && Number.isFinite(reference.strength)
        && reference.strength >= 0 && reference.strength <= MAX_PRECISE_REFERENCE_STRENGTH
        && (reference.fidelity === undefined || isUnitInterval(reference.fidelity))
        && (reference.preferSameOutfit === undefined || (typeof reference.preferSameOutfit === 'boolean'
            && supportsPreferSameOutfit(reference.referenceType as ScenePreciseReferenceType)))
}

/** Stored form: null or an empty list both mean "no Precise Reference"; a list never repeats an Artifact. */
export function isScenePreciseReferences(value: unknown): value is readonly ScenePreciseReference[] | null {
    if (value === null) return true
    return Array.isArray(value) && value.length <= MAX_SCENE_PRECISE_REFERENCES
        && value.every(isScenePreciseReference)
        && new Set(value.map(reference => (reference as ScenePreciseReference).artifactId)).size === value.length
}
