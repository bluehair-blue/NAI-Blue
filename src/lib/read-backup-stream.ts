import { JSONParser } from '@streamparser/json'
import { open, type OpenOptions } from '@tauri-apps/plugin-fs'

/** Large v3 envelopes may exceed V8's single-string limit. Parse bounded UTF-8
 * reads, retaining the same object consumed by existing restore validation. */
export async function parseBackupStream(chunks: AsyncIterable<Uint8Array>): Promise<unknown> {
    const parser = new JSONParser({ paths: ['$'], stringBufferSize: 64 * 1024 })
    let result: unknown
    let complete = false
    parser.onValue = ({ value }) => { result = value; complete = true }
    for await (const chunk of chunks) parser.write(chunk)
    if (!parser.isEnded) parser.end()
    if (!complete) throw new Error('Backup JSON is incomplete')
    return result
}

export async function readBackupJson(path: string, options: Pick<OpenOptions, 'baseDir'>): Promise<unknown> {
    const file = await open(path, { ...options, read: true })
    try {
        async function* chunks() {
            const buffer = new Uint8Array(64 * 1024)
            for (;;) {
                const count = await file.read(buffer)
                if (count === null || count === 0) break
                yield buffer.subarray(0, count)
            }
        }
        return await parseBackupStream(chunks())
    } finally { await file.close() }
}
