import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { indexedDBStorage } from '@/lib/indexed-db'
import { saveReferenceImage, loadReferenceImage, deleteReferenceImage, saveEncodedVibe, loadEncodedVibe } from '@/lib/image-utils'
import {
    characterStoreResourceId,
    type CharacterResourceRepository,
} from '@/lib/composition/character-resource-repository'
export {
    characterStoreResourceId,
} from '@/lib/composition/character-resource-repository'
export type {
    CharacterResourceKind,
    CharacterResourceRepository,
} from '@/lib/composition/character-resource-repository'

import { preciseReferenceCaption, type PreciseReferenceType } from '@/domain/generation/precise-reference'
export type { PreciseReferenceType } from '@/domain/generation/precise-reference'

export interface ReferenceImage {
    id: string
    base64: string              // Runtime only - NOT persisted (loaded from filePath on demand)
    filePath?: string           // Persisted file path (AppData/NAI Blue/references/xxx.bin)
    thumbnail?: string          // Small JPEG preview for UI (~10-30KB) - persisted
    enabled: boolean
    encodedVibe?: string        // Runtime only - loaded from encodedVibePath
    encodedVibePath?: string    // Persisted file path for encoded vibe data
    informationExtracted: number
    strength: number
    fidelity: number
    referenceType: PreciseReferenceType
    /** "Prefer same outfit" (V5). Absent means NovelAI's default for the reference type. */
    preferSameOutfit?: boolean
    cacheKey?: string
}

interface CharacterState {
    characterImages: ReferenceImage[]
    vibeImages: ReferenceImage[]
    _imagesLoaded: boolean      // Runtime flag: are base64 loaded from files?

    // Actions
    addCharacterImage: (base64: string) => Promise<void>
    updateCharacterImage: (id: string, updates: Partial<ReferenceImage>) => void
    removeCharacterImage: (id: string) => void

    addVibeImage: (base64: string, encodedVibe?: string, informationExtracted?: number, strength?: number) => Promise<void>
    updateVibeImage: (id: string, updates: Partial<ReferenceImage>) => void
    removeVibeImage: (id: string) => void

    clearAll: () => void

    /** Load base64 data from files for all images (call before generation) */
    ensureImagesLoaded: () => Promise<void>

    /** Release base64 data from memory (call after generation to free ~30-60MB) */
    releaseImageData: () => void
}

const MAX_CHARACTER_IMAGES = 10
const MAX_VIBE_IMAGES = 10

/** Create a tiny thumbnail for UI display (~10-30KB instead of 2-5MB) */
async function makeThumbnail(base64: string, maxSize = 128): Promise<string> {
    return new Promise((resolve) => {
        const img = new Image()
        img.onload = () => {
            let canvas: HTMLCanvasElement | null = null
            try {
                canvas = document.createElement('canvas')
                const ctx = canvas.getContext('2d')
                if (!ctx) { resolve(''); return }
                let w = img.width, h = img.height
                if (w > h) { if (w > maxSize) { h = Math.round(h * maxSize / w); w = maxSize } }
                else { if (h > maxSize) { w = Math.round(w * maxSize / h); h = maxSize } }
                canvas.width = w; canvas.height = h
                ctx.drawImage(img, 0, 0, w, h)
                resolve(canvas.toDataURL('image/jpeg', 0.6))
            } catch { resolve('') }
            finally {
                if (canvas) { canvas.width = 0; canvas.height = 0 }
                img.src = ''
            }
        }
        img.onerror = () => { img.src = ''; resolve('') }
        img.src = base64
    })
}

/** Save image to file async, then update store with filePath */
async function persistImageToFile(id: string, base64: string, store: typeof useCharacterStore, field: 'characterImages' | 'vibeImages') {
    try {
        const filePath = await saveReferenceImage(id, base64)
        const thumbnail = await makeThumbnail(base64)
        store.getState()[field === 'characterImages' ? 'updateCharacterImage' : 'updateVibeImage'](id, { filePath, thumbnail })
        console.log('[CharacterStore] Saved ' + field + ' ' + id + ' to file')
    } catch (e) {
        console.error('[CharacterStore] Failed to save ' + id + ' to file:', e)
    }
}

/** Save encoded vibe to file async */
async function persistVibeToFile(id: string, encodedVibe: string, store: typeof useCharacterStore) {
    try {
        const encodedVibePath = await saveEncodedVibe(id, encodedVibe)
        store.getState().updateVibeImage(id, { encodedVibePath })
        console.log('[CharacterStore] Saved encoded vibe ' + id + ' to file')
    } catch (e) {
        console.error('[CharacterStore] Failed to save encoded vibe ' + id + ':', e)
    }
}

export const useCharacterStore = create<CharacterState>()(
    persist(
        (set, get) => ({
            characterImages: [],
            vibeImages: [],
            _imagesLoaded: false,

            addCharacterImage: async (base64) => {
                const id = Date.now().toString()
                set((state) => {
                    const newImages = [
                        ...state.characterImages,
                        {
                            id, base64, enabled: true,
                            informationExtracted: 1.0, strength: 0.6, fidelity: 0.6,
                            referenceType: 'character&style' as PreciseReferenceType
                        }
                    ]
                    if (newImages.length > MAX_CHARACTER_IMAGES) {
                        const removed = newImages[0]
                        if (removed.filePath) deleteReferenceImage(removed.filePath)
                        return { characterImages: newImages.slice(-MAX_CHARACTER_IMAGES) }
                    }
                    return { characterImages: newImages }
                })
                // Async: save to file
                await persistImageToFile(id, base64, useCharacterStore, 'characterImages')
            },

            updateCharacterImage: (id, updates) => set((state) => ({
                characterImages: state.characterImages.map(img =>
                    img.id === id ? { ...img, ...updates } : img
                )
            })),

            removeCharacterImage: (id) => {
                const img = get().characterImages.find(i => i.id === id)
                if (img?.filePath) deleteReferenceImage(img.filePath)
                set((state) => ({
                    characterImages: state.characterImages.filter(i => i.id !== id)
                }))
            },

            addVibeImage: async (base64, encodedVibe, informationExtracted, strength) => {
                const id = Date.now().toString()
                set((state) => {
                    const newImages = [
                        ...state.vibeImages,
                        {
                            id, base64, enabled: true, encodedVibe,
                            informationExtracted: informationExtracted ?? 1.0,
                            strength: strength ?? 0.6, fidelity: 0.6,
                            referenceType: 'character&style' as PreciseReferenceType
                        }
                    ]
                    if (newImages.length > MAX_VIBE_IMAGES) {
                        const removed = newImages[0]
                        if (removed.filePath) deleteReferenceImage(removed.filePath)
                        if (removed.encodedVibePath) deleteReferenceImage(removed.encodedVibePath)
                        return { vibeImages: newImages.slice(-MAX_VIBE_IMAGES) }
                    }
                    return { vibeImages: newImages }
                })
                // Async: save to files
                await persistImageToFile(id, base64, useCharacterStore, 'vibeImages')
                if (encodedVibe) {
                    await persistVibeToFile(id, encodedVibe, useCharacterStore)
                }
            },

            updateVibeImage: (id, updates) => {
                set((state) => ({
                    vibeImages: state.vibeImages.map(img =>
                        img.id === id ? { ...img, ...updates } : img
                    )
                }))
                // If encodedVibe was updated and no path yet, save to file
                if (updates.encodedVibe && !get().vibeImages.find(v => v.id === id)?.encodedVibePath) {
                    persistVibeToFile(id, updates.encodedVibe, useCharacterStore)
                }
            },

            removeVibeImage: (id) => {
                const img = get().vibeImages.find(i => i.id === id)
                if (img?.filePath) deleteReferenceImage(img.filePath)
                if (img?.encodedVibePath) deleteReferenceImage(img.encodedVibePath)
                set((state) => ({
                    vibeImages: state.vibeImages.filter(i => i.id !== id)
                }))
            },

            clearAll: () => {
                const state = get()
                for (const img of [...state.characterImages, ...state.vibeImages]) {
                    if (img.filePath) deleteReferenceImage(img.filePath)
                    if (img.encodedVibePath) deleteReferenceImage(img.encodedVibePath)
                }
                set({ characterImages: [], vibeImages: [], _imagesLoaded: false })
            },

            ensureImagesLoaded: async () => {
                if (get()._imagesLoaded) return
                console.log('[CharacterStore] Loading images from files...')
                const state = get()

                const loadImage = async (img: ReferenceImage): Promise<ReferenceImage> => {
                    const updates: Partial<ReferenceImage> = {}
                    // Load base64 from file if missing
                    if (!img.base64 && img.filePath) {
                        const data = await loadReferenceImage(img.filePath)
                        if (data) updates.base64 = data
                    }
                    // Load encodedVibe from file if missing
                    if (!img.encodedVibe && img.encodedVibePath) {
                        const data = await loadEncodedVibe(img.encodedVibePath)
                        if (data) updates.encodedVibe = data
                    }
                    return Object.keys(updates).length > 0 ? { ...img, ...updates } : img
                }

                const [charImages, vibeImgs] = await Promise.all([
                    Promise.all(state.characterImages.map(loadImage)),
                    Promise.all(state.vibeImages.map(loadImage)),
                ])

                set({
                    characterImages: charImages,
                    vibeImages: vibeImgs,
                    _imagesLoaded: true,
                })
                console.log('[CharacterStore] Loaded ' + charImages.length + ' char + ' + vibeImgs.length + ' vibe images')
            },

            releaseImageData: () => {
                const state = get()
                // Only release if images have file paths (can be reloaded)
                const hasFilePaths = [...state.characterImages, ...state.vibeImages].every(img => img.filePath || !img.base64)
                if (!hasFilePaths) {
                    console.log('[CharacterStore] Skipping release - some images have no file path')
                    return
                }
                set({
                    characterImages: state.characterImages.map(img =>
                        img.filePath ? { ...img, base64: '', encodedVibe: undefined } : img
                    ),
                    vibeImages: state.vibeImages.map(img =>
                        img.filePath ? { ...img, base64: '', encodedVibe: undefined } : img
                    ),
                    _imagesLoaded: false,
                })
                console.log('[CharacterStore] Released base64 data from memory')
            },
        }),
        {
            name: 'nai-blue-character-store',
            storage: createJSONStorage(() => indexedDBStorage),
            // MEMORY OPTIMIZATION: Only persist filePath + thumbnail + settings, NOT base64
            partialize: (state) => ({
                characterImages: state.characterImages.map(img => ({
                    id: img.id,
                    base64: '',
                    filePath: img.filePath,
                    thumbnail: img.thumbnail,
                    enabled: img.enabled,
                    encodedVibePath: img.encodedVibePath,
                    informationExtracted: img.informationExtracted,
                    strength: img.strength,
                    fidelity: img.fidelity,
                    referenceType: img.referenceType,
                    preferSameOutfit: img.preferSameOutfit,
                    cacheKey: img.cacheKey,
                })),
                vibeImages: state.vibeImages.map(img => ({
                    id: img.id,
                    base64: '',
                    filePath: img.filePath,
                    thumbnail: img.thumbnail,
                    enabled: img.enabled,
                    encodedVibePath: img.encodedVibePath,
                    informationExtracted: img.informationExtracted,
                    strength: img.strength,
                    fidelity: img.fidelity,
                    referenceType: img.referenceType,
                    cacheKey: img.cacheKey,
                })),
            }),
        }
    )
)

/**
 * Compatibility repository over the existing character/image store. It loads
 * existing files and encoded-vibe caches on demand; it never moves or rebuilds
 * their persisted content.
 */
export function createCharacterStoreResourceRepository(): CharacterResourceRepository {
    return {
        ensureAvailable: () => useCharacterStore.getState().ensureImagesLoaded(),
        getByResourceId: (resourceId) => {
            const state = useCharacterStore.getState()
            const image = state.characterImages.find(candidate => (
                characterStoreResourceId('character', candidate.id) === resourceId
            )) ?? state.vibeImages.find(candidate => (
                characterStoreResourceId('vibe', candidate.id) === resourceId
            ))
            return image && { ...image, referenceType: preciseReferenceCaption(image.referenceType, image.preferSameOutfit) }
        },
    }
}
