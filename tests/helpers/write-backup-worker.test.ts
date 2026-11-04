import { beforeEach, describe, expect, it, vi } from 'vitest'
import { exists, remove, rename, writeFile } from '@tauri-apps/plugin-fs'
import { configureBackupWorker, writeBackupWithWorker } from '@/lib/write-backup-worker'
import type { BackupWorkerOutput } from '@/lib/backup-worker-protocol'

vi.mock('@tauri-apps/plugin-fs', () => ({ exists: vi.fn(), remove: vi.fn(), rename: vi.fn(), writeFile: vi.fn() }))
const input = { kind: 'store' as const, storeKey: 'nai-blue-scenes' as const, createdAt: '2026-11-04T08:00:00.000Z' }
const options = { baseDir: 17 }

function fakeWorker() {
    let chunk = 0
    const worker = { onmessage: null as ((event: { data: BackupWorkerOutput }) => void) | null,
        onerror: null, onmessageerror: null, terminate: vi.fn(),
        postMessage: vi.fn(() => queueMicrotask(() => {
            worker.onmessage?.({ data: chunk++ < 2
                ? { kind: 'chunk', bytes: new Uint8Array([chunk]) }
                : { kind: 'complete', storeCount: 1, createdAt: input.createdAt } })
        })) }
    return worker
}
beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(writeFile).mockResolvedValue()
    vi.mocked(rename).mockResolvedValue()
    vi.mocked(remove).mockResolvedValue()
})

describe('backup worker commit boundary', () => {
    it('acknowledges only written chunks and renames only the completed temporary file', async () => {
        const worker = fakeWorker()
        configureBackupWorker(() => worker as unknown as Worker)
        let release: (() => void) | undefined
        vi.mocked(writeFile).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
        const writing = writeBackupWithWorker('full/test.json', input, options)
        await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1))
        expect(worker.postMessage).toHaveBeenCalledTimes(1)
        expect(rename).not.toHaveBeenCalled()
        release!()
        await expect(writing).resolves.toEqual(expect.objectContaining({ storeCount: 1 }))
        expect(vi.mocked(writeFile).mock.calls.map(call => call[2]?.append)).toEqual([false, true])
        expect(rename).toHaveBeenCalledWith('full/test.json.partial', 'full/test.json', { oldPathBaseDir: 17, newPathBaseDir: 17 })
        expect(worker.terminate).toHaveBeenCalledOnce()
    })
    it('does not publish a failed backup and leaves the worker queue usable', async () => {
        const worker = fakeWorker()
        configureBackupWorker(() => worker as unknown as Worker)
        vi.mocked(writeFile).mockRejectedValueOnce(new Error('disk full'))
        vi.mocked(exists).mockResolvedValue(true)
        await expect(writeBackupWithWorker('full/test.json', input, options)).rejects.toThrow('disk full')
        expect(rename).not.toHaveBeenCalled()
        expect(remove).toHaveBeenCalledWith('full/test.json.partial', options)
        expect(worker.terminate).toHaveBeenCalledOnce()
        configureBackupWorker(() => fakeWorker() as unknown as Worker)
        await expect(writeBackupWithWorker('full/next.json', input, options)).resolves.toHaveProperty('storeCount', 1)
    })
})
