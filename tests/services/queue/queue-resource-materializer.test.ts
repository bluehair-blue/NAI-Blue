import { describe, expect, it } from 'vitest'

import type { GenerationParams } from '@/services/novelai-types'
import {
    QueueResourceMaterializer,
    dehydrateGenerationParams,
    hydrateGenerationParams,
    type QueueResourceStorage,
} from '@/services/queue/queue-resource-materializer'

class MemoryResourceStorage implements QueueResourceStorage {
    readonly files = new Map<string, Uint8Array>()
    reads = 0

    async ensureDirectory(): Promise<void> {}
    async exists(relativePath: string): Promise<boolean> { return this.files.has(relativePath) }
    async read(relativePath: string): Promise<Uint8Array> {
        this.reads += 1
        const bytes = this.files.get(relativePath)
        if (bytes === undefined) throw new Error('missing fixture resource')
        return new Uint8Array(bytes)
    }
    async write(relativePath: string, bytes: Uint8Array): Promise<void> {
        this.files.set(relativePath, new Uint8Array(bytes))
    }
}

function params(): GenerationParams {
    return {
        prompt: 'fixed prompt', negative_prompt: '', model: 'nai-diffusion-4-5-full',
        width: 832, height: 1216, steps: 28, cfg_scale: 5, cfg_rescale: 0,
        sampler: 'k_euler_ancestral', scheduler: 'karras', smea: true,
        smea_dyn: false, variety: false, seed: 9,
        sourceImage: 'data:image/png;base64,AQIDBA==',
        mask: 'data:image/png;base64,BQYHCA==',
        charImages: ['data:image/webp;base64,CQoLDA=='],
        vibeImages: ['data:image/png;base64,DQ4PEA=='],
        preEncodedVibes: ['fixture-encoded-vibe-payload'],
        charCacheKeys: ['must-not-persist'],
    }
}

describe('managed AppData queue resource materialization', () => {
    it('removes raw image/vibe/cache material from the immutable snapshot and restores it by digest', async () => {
        const storage = new MemoryResourceStorage()
        const materializer = new QueueResourceMaterializer(storage, () => '2026-07-14T10:00:00.000Z')

        const rawNegative = 'nsfw, lowres, lowres,  logo,\n'
        const dehydrated = await dehydrateGenerationParams({ ...params(), promptTextMode: 'verbatim',
            ucPreset: 4, qualityToggle: false, negative_prompt: rawNegative }, materializer)
        const serialized = JSON.stringify(dehydrated)
        expect(serialized).not.toContain(';base64,')
        expect(serialized).not.toContain('fixture-encoded-vibe-payload')
        expect(serialized).not.toContain('must-not-persist')
        expect(dehydrated.resources).toHaveLength(5)
        expect(storage.files.size).toBe(5)

        const restored = await hydrateGenerationParams(
            dehydrated.parameters,
            dehydrated.resources,
            materializer,
        )
        expect(restored).toMatchObject({
            promptTextMode: 'verbatim', ucPreset: 4, qualityToggle: false, negative_prompt: rawNegative,
            sourceImage: params().sourceImage,
            mask: params().mask,
            charImages: params().charImages,
            vibeImages: params().vibeImages,
            preEncodedVibes: params().preEncodedVibes,
        })
        expect(restored.charCacheKeys).toBeUndefined()
    })

    it('uses content-addressed idempotency and verifies bytes instead of trusting a path', async () => {
        const storage = new MemoryResourceStorage()
        const materializer = new QueueResourceMaterializer(storage, () => '2026-07-14T10:00:00.000Z')

        const first = await materializer.materializeDataUrl('data:image/png;base64,AQIDBA==', 'source')
        const second = await materializer.materializeDataUrl('data:image/png;base64,AQIDBA==', 'source')
        expect(second).toEqual(first)
        expect(storage.files.size).toBe(1)

        storage.files.set(
            (first.record.reference as { relativePath: string }).relativePath,
            new Uint8Array([9, 9, 9]),
        )
        await expect(materializer.read(first.snapshotResource)).rejects.toMatchObject({
            code: 'E_QUEUE_RESOURCE_DIGEST_MISMATCH',
        })
    })

    it('shares verified materialization work across a large enqueue planning pass', async () => {
        const storage = new MemoryResourceStorage()
        const materializer = new QueueResourceMaterializer(storage, () => '2026-07-14T10:00:00.000Z')
        const cache = new Map()

        const first = await dehydrateGenerationParams(params(), materializer, cache)
        const readsAfterFirst = storage.reads
        const second = await dehydrateGenerationParams(params(), materializer, cache)

        expect(second).toEqual(first)
        expect(storage.reads).toBe(readsAfterFirst)
        expect(cache.size).toBe(5)
    })
})
