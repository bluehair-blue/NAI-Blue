import { describe, expect, it } from 'vitest'
import { parseBackupStream } from '@/lib/read-backup-stream'
import { backupJsonBytes } from '@/lib/backup-stream'

async function* bytes(text: string) {
    const raw = new TextEncoder().encode(text)
    // Deliberately split both UTF-8 and JSON escape sequences.
    for (let offset = 0; offset < raw.length; offset += 3) yield raw.subarray(offset, offset + 3)
}
describe('backup streaming restore input', () => {
    it('reads streamed and legacy formatted JSON with identical values', async () => {
        const value = { schema: 3, text: '한글🙂\\\n\ud800', records: [false, null, 42.5] }
        expect(await parseBackupStream(bytes(JSON.stringify(value, null, 2)))).toEqual(value)
        async function* streamed() { yield* backupJsonBytes(value) }
        expect(await parseBackupStream(streamed())).toEqual(value)
    })
    it.each(['{"a":', '{"a":1}garbage', '{"a":1}{"a":2}', ''])('rejects incomplete or appended JSON: %s', async text => {
        await expect(parseBackupStream(bytes(text))).rejects.toThrow()
    })
})
