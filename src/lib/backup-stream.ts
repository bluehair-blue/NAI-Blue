import { canonicalSerializeChunks } from '@/domain/composition/canonical-serialize'

/** Bounded JSON/UTF-8 fragments preserve the existing envelope without ever
 * constructing an archive-sized string, including individual migration strings. */
export function* backupJsonBytes(value: unknown): Generator<Uint8Array> {
    const encoder = new TextEncoder()
    let pending = ''
    for (const fragment of canonicalSerializeChunks(value)) {
        if (pending.length + fragment.length > 16_384 && pending.length > 0) {
            yield encoder.encode(pending)
            pending = ''
        }
        pending += fragment
    }
    if (pending.length > 0) yield encoder.encode(pending)
}
