import { useEffect, useSyncExternalStore } from 'react'
import { createSavedOutputCatalog } from '@/services/organizer/saved-output-catalog'
import { getRuntimeArtifactRepository } from '@/services/organizer/runtime'
import { createRuntimeOutputPlatformAdapter } from '@/services/output/tauri-output-adapter'
import { childOutputRef, type ResolvedOutputDirectory } from '@/services/output/platform-adapter'
import { useArtifactLifecycleStore } from '@/stores/artifact-lifecycle-store'
import { useSceneStore } from '@/stores/scene-store'

let runtime: ReturnType<typeof createSavedOutputCatalog> | null = null

/** Shared metadata catalog survives route changes; producer subscription is
 * synchronous so two completions in one React frame cannot lose an output.
 */
function getCatalog() {
    if (runtime !== null) return runtime
    const directories = new Map<string, Promise<ResolvedOutputDirectory>>()
    const platform = createRuntimeOutputPlatformAdapter()
    const catalog = createSavedOutputCatalog({
        list: options => getRuntimeArtifactRepository().list(options),
        resolve: async record => {
            const directory = record.original.file.directory
            const key = JSON.stringify(directory)
            let pending = directories.get(key)
            if (!pending) {
                pending = platform.resolveDirectory({ portableDirectory: directory, workflowDefaultDirectory: 'NAI_Blue_Output' })
                directories.set(key, pending)
                void pending.catch(() => directories.delete(key))
            }
            return childOutputRef(await pending, record.original.file.fileName).displayPath
        },
    })
    useArtifactLifecycleStore.subscribe((state, previous) => {
        const notice = state.latestGeneratedArtifact
        if (notice && notice !== previous.latestGeneratedArtifact) catalog.add([{ ...notice, timestamp: Date.now() }])
    })
    // Legacy images have no ArtifactRecord; include their existing UI path only.
    const ingest = (presets: ReturnType<typeof useSceneStore.getState>['presets'], previous = new Map()) => {
        const inputs = presets.filter(preset => previous.get(preset.id) !== preset.scenes)
            .flatMap(preset => preset.scenes.flatMap(scene => scene.images.map(image => ({ path: image.url, timestamp: image.timestamp }))))
        if (inputs.length) catalog.add(inputs)
    }
    ingest(useSceneStore.getState().presets)
    useSceneStore.subscribe((state, previous) => {
        if (state.presets !== previous.presets) ingest(state.presets, new Map(previous.presets.map(preset => [preset.id, preset.scenes])))
    })
    const notice = useArtifactLifecycleStore.getState().latestGeneratedArtifact
    if (notice) catalog.add([{ ...notice, timestamp: Date.now() }])
    runtime = catalog
    return catalog
}

export function useSavedOutputCatalog() {
    const catalog = getCatalog()
    const snapshot = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot, catalog.getSnapshot)
    useEffect(() => { void catalog.load() }, [catalog])
    return { ...snapshot, retry: () => { void catalog.load(true) } }
}
