import type { ArtifactRecord } from '@/domain/organizer/types'
import { artifactHistoryPathKey } from './artifact-history-shadow'

export interface SavedOutputImage {
    readonly path: string
    readonly name: string
    readonly directory: string
    readonly directoryKey: string
    readonly timestamp: number
    readonly artifactId?: string
    readonly sourceJobId?: string
}
export interface SavedOutputDirectory {
    readonly key: string
    readonly path: string
    readonly count: number
}
export interface SavedOutputCatalogSnapshot {
    readonly images: readonly SavedOutputImage[]
    readonly directories: readonly SavedOutputDirectory[]
    readonly loading: boolean
    readonly unavailable: number
}

/** Pure path projection: virtual navigation never creates a configured output
 * folder, grants filesystem authority, moves an original or changes Scene edits.
 */
export function savedOutputImage(input: {
    path: string; timestamp?: number; artifactId?: string; sourceJobId?: string
}): SavedOutputImage | null {
    const path = input.path.trim().replace(/\\/gu, '/')
    if (!path || /^(?:data|blob|memory|https?|asset):/iu.test(path)) return null
    const separator = path.lastIndexOf('/')
    if (separator < 0 || separator === path.length - 1) return null
    const directory = path.slice(0, separator) || '/'
    return { ...input, path, name: path.slice(separator + 1), directory,
        directoryKey: artifactHistoryPathKey(directory), timestamp: input.timestamp ?? 0 }
}

/** One paginated metadata read per app session, then incremental publications.
 * At most eight platform resolutions run together; images are decoded only by
 * visible UI. Failed grants remain a visible count and can be retried explicitly.
 */
export function createSavedOutputCatalog(dependencies: {
    list(options: { cursor: string | null; limit: number }): Promise<{ items: readonly ArtifactRecord[]; nextCursor: string | null }>
    resolve(record: ArtifactRecord): Promise<string>
}) {
    const byPath = new Map<string, SavedOutputImage>()
    const listeners = new Set<() => void>()
    let snapshot: SavedOutputCatalogSnapshot = { images: [], directories: [], loading: false, unavailable: 0 }
    let loading: Promise<void> | null = null
    let loaded = false
    const insert = (image: SavedOutputImage | null) => {
        if (image === null) return
        const key = artifactHistoryPathKey(image.path)
        const previous = byPath.get(key)
        byPath.set(key, { ...previous, ...image,
            timestamp: Math.max(previous?.timestamp ?? 0, image.timestamp),
            artifactId: image.artifactId ?? previous?.artifactId,
            sourceJobId: image.sourceJobId ?? previous?.sourceJobId })
    }
    const publish = () => {
        const directories = new Map<string, SavedOutputDirectory>()
        const images = [...byPath.values()].sort((a, b) => b.timestamp - a.timestamp || a.path.localeCompare(b.path))
        for (const image of images) {
            const current = directories.get(image.directoryKey)
            directories.set(image.directoryKey, { key: image.directoryKey, path: image.directory, count: (current?.count ?? 0) + 1 })
        }
        snapshot = { ...snapshot, images, directories: [...directories.values()] }
        listeners.forEach(listener => listener())
    }
    return {
        getSnapshot: () => snapshot,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
        add(inputs: readonly Parameters<typeof savedOutputImage>[0][]) {
            for (const input of inputs) insert(savedOutputImage(input))
            publish()
        },
        load(retry = false): Promise<void> {
            if (loading !== null) return loading
            if (loaded && !retry) return Promise.resolve()
            snapshot = { ...snapshot, loading: true, unavailable: 0 }
            publish()
            loading = (async () => {
                const seen = new Set<string>()
                let cursor: string | null = null
                try {
                    do {
                        const page = await dependencies.list({ cursor, limit: 128 })
                        for (let start = 0; start < page.items.length; start += 8) {
                            await Promise.all(page.items.slice(start, start + 8).map(async record => {
                                try {
                                    insert(savedOutputImage({ path: await dependencies.resolve(record),
                                        timestamp: Date.parse(record.createdAt), artifactId: record.artifactId,
                                        sourceJobId: record.sourceJobId ?? undefined }))
                                } catch { snapshot = { ...snapshot, unavailable: snapshot.unavailable + 1 } }
                            }))
                        }
                        publish()
                        cursor = page.nextCursor
                        if (cursor !== null && seen.has(cursor)) throw new Error('Repeated artifact cursor')
                        if (cursor !== null) seen.add(cursor)
                        // Let route changes and user input run between catalog pages.
                        await new Promise(resolve => setTimeout(resolve, 0))
                    } while (cursor !== null)
                    loaded = true
                } catch { snapshot = { ...snapshot, unavailable: snapshot.unavailable + 1 } }
                finally { snapshot = { ...snapshot, loading: false }; loading = null; publish() }
            })()
            return loading
        },
    }
}
