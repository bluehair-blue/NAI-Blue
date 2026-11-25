import type { PreciseReferenceCaption } from '@/domain/generation/precise-reference'

export type CharacterResourceKind = 'character' | 'vibe'
export type CharacterResourceReferenceType = PreciseReferenceCaption

export interface CharacterResourceContent {
    id: string
    base64: string
    enabled: boolean
    encodedVibe?: string
    informationExtracted: number
    strength: number
    fidelity: number
    referenceType: CharacterResourceReferenceType
    cacheKey?: string
}

export interface CharacterResourceRepository {
    ensureAvailable: () => Promise<void>
    getByResourceId: (resourceId: string) => Readonly<CharacterResourceContent> | undefined
}

export function characterStoreResourceId(kind: CharacterResourceKind, id: string): string {
    return `main-runtime-reference:${kind}:${id}`
}
