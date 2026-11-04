import { expect, it, vi } from 'vitest'
import { runtimeCapabilities } from '@/platform/capabilities'
import { writeTextFile } from '@tauri-apps/plugin-fs'
import { startupCheckpoint } from '@/lib/startup-checkpoint'

vi.mock('@/platform/capabilities', () => ({ runtimeCapabilities: { nativePluginRuntime: { supported: false } } }))
vi.mock('@tauri-apps/plugin-fs', () => ({ BaseDirectory: { AppData: 14 }, writeTextFile: vi.fn() }))

it('keeps a bounded native-only local stage history and does not fail startup on a diagnostic write error', async () => {
    await startupCheckpoint('browser')
    expect(writeTextFile).not.toHaveBeenCalled()
    ;(runtimeCapabilities.nativePluginRuntime as { supported: boolean }).supported = true
    for (let n = 0; n < 40; n++) await startupCheckpoint(`stage-${n}`)
    const [path, text, options] = vi.mocked(writeTextFile).mock.calls.at(-1)!
    expect(path).toBe('startup-checkpoint.json')
    expect(options).toEqual({ baseDir: 14 })
    const trace = JSON.parse(text)
    expect(trace.stages).toHaveLength(32)
    expect(trace.stages.at(-1).stage).toBe('stage-39')
    vi.mocked(writeTextFile).mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(startupCheckpoint('write-failed')).resolves.toBeUndefined()
})
