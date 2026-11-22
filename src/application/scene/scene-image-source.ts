export interface SceneImageSource {
    readonly mode: 'img2img'
    readonly artifactId: string
    readonly contentChecksum: `sha256:${string}`
    readonly strength: number
    readonly noise: number
}

/** The opaque identity of a committed saved original; every Scene image binding is made of these two facts. */
export type SavedArtifactBinding = Pick<SceneImageSource, 'artifactId' | 'contentChecksum'>

export const isSavedArtifactId = (value: unknown): value is string =>
    typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value)
export const isContentChecksum = (value: unknown): value is `sha256:${string}` =>
    typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
export const isUnitInterval = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

/** Public bindings contain only a committed opaque Artifact ID and immutable content facts. */
export function isSceneImageSource(value: unknown): value is SceneImageSource | null {
    if (value === null) return true
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const source = value as Record<string, unknown>
    return Object.keys(source).length === 5
        && source.mode === 'img2img'
        && isSavedArtifactId(source.artifactId)
        && isContentChecksum(source.contentChecksum)
        && [source.strength, source.noise].every(isUnitInterval)
}
