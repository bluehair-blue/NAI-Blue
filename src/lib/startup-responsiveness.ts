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
    const longTasks: { startMs: number; durationMs: number }[] = []
    const observer = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask')
        ? new PerformanceObserver(list => {
            if (document.visibilityState !== 'visible') return
            for (const entry of list.getEntries()) {
                if (longTasks.length < 120) longTasks.push({ startMs: Math.round(entry.startTime - started), durationMs: Math.round(entry.duration) })
            }
        }) : null
    observer?.observe({ type: 'longtask' })
    const timer = window.setInterval(() => {
        const now = performance.now()
        const visible = document.visibilityState === 'visible'
        if (visible && wasVisible) samples.push(Math.max(0, now - previous - 50))
        previous = now
        wasVisible = visible
        if (now - lastReport < (now - started < 30_000 ? 5_000 : 15_000)) return
        samples.sort((a, b) => a - b)
        windows.push({ elapsedMs: Math.round(now - started), samples: samples.length,
            p95DelayMs: Math.round(samples[Math.floor(samples.length * .95)] ?? 0),
            maxDelayMs: Math.round(samples[samples.length - 1] ?? 0) })
        samples = []
        lastReport = now
        void writeTextFile('startup-responsiveness.json', JSON.stringify({ startedAt, windows, longTasks }),
            { baseDir: BaseDirectory.AppData }).catch(() => undefined)
        if (now - started >= 180_000) { window.clearInterval(timer); observer?.disconnect() }
    }, 50)
}
