import { writeFile, type WriteFileOptions } from '@tauri-apps/plugin-fs'

const TEXT_CHUNK_CODE_UNITS = 16 * 1024
const encoder = new TextEncoder()

/** At most 48KiB per native call, including Tauri's JSON/postMessage fallback.
 * Keep surrogate pairs together so concatenated chunks match one UTF-8 encoding. */
export function* utf8TextChunks(text: string): Generator<Uint8Array> {
    let offset = 0
    do {
        let end = Math.min(offset + TEXT_CHUNK_CODE_UNITS, text.length)
        if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff
            && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--
        yield encoder.encode(text.slice(offset, end))
        offset = end
    } while (offset < text.length)
}

/** Reuses the caller's filesystem scope and writeFile semantics: truncate once,
 * then append sequentially. Never materialize a backup-sized binary IPC payload. */
export async function writeUtf8TextFile(path: string, text: string, options: Pick<WriteFileOptions, 'baseDir'>): Promise<void> {
    let append = false
    for (const bytes of utf8TextChunks(text)) {
        await writeFile(path, bytes, { ...options, append })
        append = true
    }
}
