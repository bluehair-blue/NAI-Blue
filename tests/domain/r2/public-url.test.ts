import { describe, expect, it } from 'vitest'
import { plannedR2PublicUrl } from '@/domain/r2/public-url'

describe('Planned R2 public URL', () => {
    it('encodes each planned key segment once and keeps separators and deterministic collision suffixes', () => {
        expect(plannedR2PublicUrl('custom', 'https://cdn.example.com/', 'blue class/유나/happy-abc123.webp'))
            .toBe('https://cdn.example.com/blue%20class/%EC%9C%A0%EB%82%98/happy-abc123.webp')
        expect(plannedR2PublicUrl('custom', 'https://cdn.example.com/assets/', 'literal%name.webp'))
            .toBe('https://cdn.example.com/assets/literal%25name.webp')
    })
    it('does not expose a public URL for private or invalid public settings', () => {
        expect(plannedR2PublicUrl('private', 'https://cdn.example.com', 'a.png')).toBeNull()
        for (const base of [null, '', 'http://cdn.example.com', 'https://user:secret@cdn.example.com', 'https://cdn.example.com?token=secret']) {
            expect(plannedR2PublicUrl('custom', base, 'a.png')).toBeNull()
        }
    })
})
