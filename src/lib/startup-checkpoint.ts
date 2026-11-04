import { runtimeCapabilities } from '@/platform/capabilities'
import { BaseDirectory, writeTextFile } from '@tauri-apps/plugin-fs'

const stages: { stage: string; at: string }[] = []

/** Small local breadcrumbs survive renderer termination; no store values or credentials. */
export async function startupCheckpoint(stage: string): Promise<void> {
    if (!runtimeCapabilities.nativePluginRuntime.supported) return
    stages.push({ stage, at: new Date().toISOString() })
    if (stages.length > 32) stages.shift()
    try {
        await writeTextFile('startup-checkpoint.json', JSON.stringify({ stages }), { baseDir: BaseDirectory.AppData })
    } catch { /* Diagnostics cannot decide startup or backup authority. */ }
}
