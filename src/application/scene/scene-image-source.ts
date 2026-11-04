export interface SceneImageSource {
    readonly mode: 'img2img'
    readonly artifactId: string
    readonly contentChecksum: `sha256:${string}`
    readonly strength: number
    readonly noise: number
}

/** Public bindings contain only a committed opaque Artifact ID and immutable content facts. */
export function isSceneImageSource(value: unknown): value is SceneImageSource | null {
    if (value === null) return true
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const source = value as Record<string, unknown>
    return Object.keys(source).length === 5
        && source.mode === 'img2img'
        && typeof source.artifactId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(source.artifactId)
        && typeof source.contentChecksum === 'string' && /^sha256:[a-f0-9]{64}$/.test(source.contentChecksum)
        && [source.strength, source.noise].every(number => typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= 1)
}
