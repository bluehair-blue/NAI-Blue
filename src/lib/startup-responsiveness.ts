import { BaseDirectory, writeTextFile } from '@tauri-apps/plugin-fs'
import { runtimeCapabilities } from '@/platform/capabilities'

/** Bounded startup telemetry measures UI timer starvation without reading user
 * content or controlling the window. Hidden-window timer throttling is excluded. */
export function observeStartupResponsiveness(): void {
    if (!runtimeCapabilities.nativePluginRuntime.supported) return
    const startedAt = new Date().toISOString()
    const started = performance.now()
    const windows: { elapsedMs: number; samples: number; p95DelayMs: number; maxDelayMs: number }[] = []
    let samples: number[] = []
    let previous = started
    let lastReport = started
    let wasVisible = document.visibilityState === 'visible'
    const timer = window.setInterval(() => {
        const now = performance.now()
        const visible = document.visibilityState === 'visible'
        if (visible && wasVisible) samples.push(Math.max(0, now - previous - 250))
        previous = now
        wasVisible = visible
        if (now - lastReport < 15_000) return
        samples.sort((a, b) => a - b)
        windows.push({ elapsedMs: Math.round(now - started), samples: samples.length,
            p95DelayMs: Math.round(samples[Math.floor(samples.length * .95)] ?? 0),
            maxDelayMs: Math.round(samples[samples.length - 1] ?? 0) })
        samples = []
        lastReport = now
        void writeTextFile('startup-responsiveness.json', JSON.stringify({ startedAt, windows }),
            { baseDir: BaseDirectory.AppData }).catch(() => undefined)
        if (now - started >= 180_000) window.clearInterval(timer)
    }, 250)
}
