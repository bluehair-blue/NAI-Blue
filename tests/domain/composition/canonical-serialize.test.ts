import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'

import {
    CANONICAL_HASH_ALGORITHM,
    CANONICAL_SERIALIZATION_VERSION,
    COMPOSITION_PLAN_HASH_VERSION,
    canonicalProject,
    canonicalSerialize,
    canonicalSerializeChunks,
    canonicalUtf8ByteLength,
    createCompositionPlanHash,
    fnv1a64Utf8,
    hashCanonicalValue,
    projectForCompositionPlanHash,
    sha256Utf8,
} from '@/domain/composition/canonical-serialize'

describe('composition canonical serialization', () => {
    it('streams the legacy JSON bytes and SHA256 across escaped Unicode value and key boundaries', () => {
        const text = '한글🙂"\\\n\u0000\ud800x\udfff'.repeat(5000)
        const value = { [text]: text, a: [-0, null, true] }
        const expected = `{"a":[0,null,true],${JSON.stringify(text)}:${JSON.stringify(text)}}`
        const pieces = [...canonicalSerializeChunks(value)]
        expect(pieces.join('')).toBe(expected)
        expect(canonicalSerialize(value)).toBe(expected)
        expect(canonicalUtf8ByteLength(value)).toBe(Buffer.byteLength(expected, 'utf8'))
        expect(hashCanonicalValue(value)).toBe(createHash('sha256').update(expected, 'utf8').digest('hex'))
    })
    it.each([
        { value: null, expected: 'null' },
        { value: -0, expected: '0' },
        { value: '한글', expected: '"한글"' },
        {
            value: { z: true, a: { y: 2, x: 1 }, list: [3, 2, 1] },
            expected: '{"a":{"x":1,"y":2},"list":[3,2,1],"z":true}',
        },
    ])('serializes JSON deterministically: $expected', ({ value, expected }) => {
        expect(canonicalSerialize(value)).toBe(expected)
    })

    it('ignores object insertion order at every depth while preserving array order', () => {
        const left = {
            output: { format: 'png', destination: { segments: ['gallery', 'day'], root: 'pictures' } },
            params: { steps: 28, cfg: 5 },
        }
        const right = {
            params: { cfg: 5, steps: 28 },
            output: { destination: { root: 'pictures', segments: ['gallery', 'day'] }, format: 'png' },
        }

        expect(canonicalSerialize(left)).toBe(canonicalSerialize(right))
        expect(hashCanonicalValue(left)).toBe(hashCanonicalValue(right))
        expect(hashCanonicalValue({ values: [1, 2] })).not.toBe(
            hashCanonicalValue({ values: [2, 1] }),
        )
    })

    it.each([
        { value: undefined, message: 'unsupported undefined' },
        { value: Number.NaN, message: 'number must be finite' },
        { value: Number.POSITIVE_INFINITY, message: 'number must be finite' },
        { value: 1n, message: 'unsupported bigint' },
        { value: new Date(0), message: 'plain or null prototype' },
        { value: Array(1), message: 'sparse array entry' },
    ])('rejects non-JSON value $value', ({ value, message }) => {
        expect(() => canonicalSerialize(value)).toThrow(message)
    })

    it('rejects circular values with the failing path', () => {
        const circular: Record<string, unknown> = {}
        circular.self = circular

        expect(() => canonicalSerialize(circular)).toThrow(
            'Value at $.self is not canonical JSON: circular reference',
        )
    })

    it('creates a detached projection with exact key and path exclusions', () => {
        const source = {
            keep: { value: 1, token: 'drop-by-key' },
            list: [{ id: 'first' }, { id: 'second' }],
            output: { format: 'png', debug: 'drop-by-path' },
        }
        const projected = canonicalProject(source, {
            excludeKeys: ['token'],
            excludePaths: [['output', 'debug'], ['list', 0]],
        })

        expect(projected).toEqual({
            keep: { value: 1 },
            list: [{ id: 'second' }],
            output: { format: 'png' },
        })
        expect(source).toEqual({
            keep: { value: 1, token: 'drop-by-key' },
            list: [{ id: 'first' }, { id: 'second' }],
            output: { format: 'png', debug: 'drop-by-path' },
        })
    })

    it('preserves __proto__ as inert JSON data without changing the projection prototype', () => {
        const source = JSON.parse('{"__proto__":{"polluted":"yes"},"safe":true}') as unknown
        const projected = canonicalProject(source) as Record<string, unknown>

        expect(Object.prototype.hasOwnProperty.call(projected, '__proto__')).toBe(true)
        expect((projected as { polluted?: string }).polluted).toBeUndefined()
        expect(JSON.parse(JSON.stringify(projected))).toEqual(JSON.parse(JSON.stringify(source)))
    })
})

describe('composition plan hash', () => {
    it.each([
        { input: '', expected: 'cbf29ce484222325' },
        { input: 'a', expected: 'af63dc4c8601ec8c' },
        { input: 'hello', expected: 'a430d84680aabd0b' },
        { input: '😀', expected: 'feff073875020288' },
        { input: '한글', expected: '5900dac74a762e41' },
    ])('locks the FNV-1a UTF-8 vector for "$input"', ({ input, expected }) => {
        expect(fnv1a64Utf8(input)).toBe(expected)
    })

    it('encodes lone UTF-16 surrogates as the UTF-8 replacement character', () => {
        expect(fnv1a64Utf8('\ud800')).toBe(fnv1a64Utf8('\ufffd'))
        expect(sha256Utf8('\ud800')).toBe(sha256Utf8('\ufffd'))
    })

    it.each([55, 56, 63, 64, 65, 16383, 16384, 16385])('preserves SHA padding and Unicode chunk boundaries at %i', length => {
        const input = `${'x'.repeat(length)}😀한글\ud800`
        expect(sha256Utf8(input)).toBe(createHash('sha256').update(input).digest('hex'))
    })

    it('hashes a large backup string with the same native SHA digest', () => {
        const input = 'backup-한글-😀\n'.repeat(500_000)
        expect(sha256Utf8(input)).toBe(createHash('sha256').update(input).digest('hex'))
    })

    it.each([
        {
            input: '',
            expected: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        },
        {
            input: 'a',
            expected: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
        },
        {
            input: 'hello',
            expected: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        },
        {
            input: '😀',
            expected: 'f0443a342c5ef54783a111b51ba56c938e474c32324d90c3a60c9c8e3a37e2d9',
        },
        {
            input: '한글',
            expected: 'bd87f9bb68b67d2fa1cb82b6751820e946d5b1316d25d5fd96512fb4be44a2a8',
        },
    ])('locks the SHA-256 UTF-8 vector for "$input"', ({ input, expected }) => {
        expect(sha256Utf8(input)).toBe(expected)
    })

    it('exposes every versioned part of the hash contract', () => {
        const result = createCompositionPlanHash({ positivePrompt: 'cat', params: { steps: 28 } })

        expect(result).toMatchObject({
            version: COMPOSITION_PLAN_HASH_VERSION,
            algorithm: CANONICAL_HASH_ALGORITHM,
            canonicalization: CANONICAL_SERIALIZATION_VERSION,
        })
        expect(result.digest).toMatch(/^[0-9a-f]{64}$/)
    })

    it('excludes identity, secrets, image bytes, and volatile native paths', () => {
        const semanticPlan = {
            planId: 'plan:a',
            requestId: 'request:a',
            positivePrompt: 'cat',
            params: { seed: 7 },
            transport: {
                apiToken: 'secret-a',
                imageBytes: new Uint8Array([1, 2, 3]),
                displayPath: 'C:\\Users\\first\\preview.png',
            },
            resource: {
                digest: 'sha256:stable',
                path: { kind: 'standard', root: 'pictures', segments: ['NAI Blue'] },
            },
        }
        const sameSemanticPlan = {
            resource: {
                path: { segments: ['NAI Blue'], root: 'pictures', kind: 'standard' },
                digest: 'sha256:stable',
            },
            transport: {
                displayPath: '/home/second/preview.png',
                imageBytes: new Uint8Array([9, 9, 9]),
                apiToken: 'secret-b',
            },
            params: { seed: 7 },
            positivePrompt: 'cat',
            requestId: 'request:b',
            planId: 'plan:b',
        }

        expect(projectForCompositionPlanHash(semanticPlan)).toEqual({
            params: { seed: 7 },
            positivePrompt: 'cat',
            resource: {
                digest: 'sha256:stable',
                path: { kind: 'standard', root: 'pictures', segments: ['NAI Blue'] },
            },
            transport: {},
        })
        expect(createCompositionPlanHash(semanticPlan)).toEqual(
            createCompositionPlanHash(sameSemanticPlan),
        )
    })

    it('supports caller-defined volatile fields without weakening default exclusions', () => {
        const first = {
            requestId: 'request:first',
            positivePrompt: 'cat',
            runtimeNonce: 'one',
            output: { previewLabel: 'desktop', format: 'png' },
        }
        const second = {
            requestId: 'request:second',
            positivePrompt: 'cat',
            runtimeNonce: 'two',
            output: { previewLabel: 'mobile', format: 'png' },
        }
        const options = {
            additionalExcludedKeys: ['runtimeNonce'],
            additionalExcludedPaths: [['output', 'previewLabel']],
        } as const

        expect(createCompositionPlanHash(first, options)).toEqual(
            createCompositionPlanHash(second, options),
        )
        expect(createCompositionPlanHash(first)).not.toEqual(createCompositionPlanHash(second))
    })

    it('changes the digest when semantic generation content changes', () => {
        const base = { positivePrompt: 'cat', params: { steps: 28, seed: 7 } }

        expect(createCompositionPlanHash(base).digest).not.toBe(
            createCompositionPlanHash({ ...base, params: { ...base.params, steps: 29 } }).digest,
        )
    })
})
