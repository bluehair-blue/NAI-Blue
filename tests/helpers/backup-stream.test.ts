import { describe, expect, it } from 'vitest'
import { backupJsonBytes } from '@/lib/backup-stream'

describe('streamed backup JSON', () => {
    it('round trips nested archives and escaped UTF-16 without a full JSON string', () => {
        const value = { archived: ('한글🙂"\\\n\ud800').repeat(100_000), nested: [null, false, { a: 12 }] }
        const chunks = [...backupJsonBytes(value)]
        expect(chunks.length).toBeGreaterThan(20)
        // Worst-case JSON escaping expands 16K input code units sixfold.
        expect(Math.max(...chunks.map(chunk => chunk.length))).toBeLessThanOrEqual(6 * 16_384)
        expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual(value)
    })
    it('fails on corruption rather than exporting a silently truncated value', () => {
        const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
        expect(() => [...backupJsonBytes(cyclic)]).toThrow('circular')
    })
})
