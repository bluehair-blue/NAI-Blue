import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BaseDirectory, writeFile } from '@tauri-apps/plugin-fs'
import { utf8TextChunks, writeUtf8TextFile } from '@/lib/write-utf8-text-file'

vi.mock('@tauri-apps/plugin-fs', () => ({ BaseDirectory: { Picture: 17 }, writeFile: vi.fn() }))

beforeEach(() => { vi.mocked(writeFile).mockReset() })

describe('bounded backup text writes', () => {
    it.each(['', '한글🙂\ud800x\udfff', 'a'.repeat(16383) + '🙂' + '한'.repeat(16384) + '🙂',
        '한'.repeat(180000)])('preserves exact UTF-8 including chunk boundaries', text => {
        const chunks = [...utf8TextChunks(text)]
        const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
        expect(bytes.equals(Buffer.from(text, 'utf8'))).toBe(true)
        expect(chunks.every(chunk => chunk.length <= 48 * 1024)).toBe(true)
    })
    it('waits for each scoped write, truncates once and appends the remaining exact bytes', async () => {
        const text = '한글🙂'.repeat(12000)
        let writing = false
        const received: Buffer[] = []
        vi.mocked(writeFile).mockImplementation(async (path, data, options) => {
            expect(writing).toBe(false)
            writing = true
            expect(path).toBe('backups/large.json')
            expect(options).toEqual({ baseDir: BaseDirectory.Picture, append: received.length > 0 })
            await Promise.resolve()
            received.push(Buffer.from(data as Uint8Array))
            writing = false
        })
        await writeUtf8TextFile('backups/large.json', text, { baseDir: BaseDirectory.Picture })
        expect(received.length).toBeGreaterThan(1)
        expect(Buffer.concat(received).equals(Buffer.from(text, 'utf8'))).toBe(true)
    })
    it('creates an empty file with the same truncate semantics', async () => {
        await writeUtf8TextFile('backups/empty.json', '', { baseDir: BaseDirectory.Picture })
        expect(writeFile).toHaveBeenCalledExactlyOnceWith('backups/empty.json', new Uint8Array(),
            { baseDir: BaseDirectory.Picture, append: false })
    })
    it('propagates a failed chunk without issuing later writes', async () => {
        vi.mocked(writeFile).mockResolvedValueOnce().mockRejectedValueOnce(new Error('disk failure'))
        await expect(writeUtf8TextFile('backups/large.json', 'x'.repeat(70000), { baseDir: BaseDirectory.Picture }))
            .rejects.toThrow('disk failure')
        expect(writeFile).toHaveBeenCalledTimes(2)
    })
})
