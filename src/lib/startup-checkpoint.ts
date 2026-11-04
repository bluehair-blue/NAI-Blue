import { runtimeCapabilities } from '@/platform/capabilities'
import { BaseDirectory, writeTextFile } from '@tauri-apps/plugin-fs'

const stages: { stage: string; at: string }[] = []
let pendingWrite = Promise.resolve()

/** Small local breadcrumbs survive renderer termination; no store values or credentials. */
export async function startupCheckpoint(stage: string): Promise<void> {
    if (!runtimeCapabilities.nativePluginRuntime.supported) return
    stages.push({ stage, at: new Date().toISOString() })
    if (stages.length > 32) stages.shift()
    const serialized = JSON.stringify({ stages })
    // Stage notifications can overlap; serialize small writes so an older
    // completion cannot replace a newer phase history on disk.
    pendingWrite = pendingWrite.then(() => writeTextFile('startup-checkpoint.json', serialized,
        { baseDir: BaseDirectory.AppData })).catch(() => undefined)
    await pendingWrite
}
