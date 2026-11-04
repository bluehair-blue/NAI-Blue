import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
    CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
    LEGACY_NAI_PAYLOAD_BUILDER_REVISION,
    NAI_COMPATIBILITY_REGISTRY,
    queryNaiCompatibility,
} from '@/services/nai/compatibility'

describe('NovelAI compatibility registry', () => {
    it('binds Medium to its own synthetic fixture without claiming live acceptance', async () => {
        const result = queryNaiCompatibility({ model: 'nai-diffusion-5-full-medium-inpainting',
            action: 'infill', features: [], payloadBuilderRevision: CURRENT_NAI_PAYLOAD_BUILDER_REVISION })
        const fixture = await readFile(resolve(process.cwd(), result.fixture!.path), 'utf8')
        expect(result.fixture!.sha256).toBe(`sha256:${createHash('sha256').update(fixture.replace(/\r\n/g, '\n')).digest('hex')}`)
        expect(result.status).toBe('synthetic-only')
        expect(result.fixture!.path).toBe('tests/fixtures/payload/v5-medium.json')
    })
    it.each([
        LEGACY_NAI_PAYLOAD_BUILDER_REVISION,
        CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
    ])('binds %s to the real synthetic fixture hash without claiming a pass', async payloadBuilderRevision => {
        const entry = NAI_COMPATIBILITY_REGISTRY[payloadBuilderRevision]
        const fixture = await readFile(resolve(process.cwd(), entry.path), 'utf8')
        // JSON fixture identity must survive Git's Windows CRLF checkout conversion.
        const normalizedFixture = fixture.replace(/\r\n/g, '\n')
        const sha256 = `sha256:${createHash('sha256').update(normalizedFixture).digest('hex')}`
        const result = queryNaiCompatibility({
            model: 'nai-diffusion-4-5-full',
            action: 'generate',
            features: [],
            payloadBuilderRevision,
        })

        expect(entry.sha256).toBe(sha256)
        expect(entry.provenance).toBe('synthetic-only')
        expect(result.status).toBe('synthetic-only')
        expect(result.warnings).toEqual(['W_NAI_COMPATIBILITY_SYNTHETIC_ONLY'])
        expect(['captured-pass', 'live-canary-pass']).not.toContain(result.status)
    })

    it('fails closed for unknown revisions and known model-feature divergence', () => {
        expect(queryNaiCompatibility({
            model: 'nai-diffusion-4-5-full',
            action: 'generate',
            features: [],
            payloadBuilderRevision: 'future-wire-v99',
        }).status).toBe('unsupported')

        expect(queryNaiCompatibility({
            model: 'nai-diffusion-5-full',
            action: 'generate',
            features: ['vibe-transfer'],
            payloadBuilderRevision: CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
        }).status).toBe('known-divergence')
    })
})
