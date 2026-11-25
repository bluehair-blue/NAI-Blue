import { describe, expect, it } from 'vitest'

import { V5_REFERENCE_BUCKETS, fitV5ReferenceBucket } from '@/services/nai/reference-bucket'

describe('V5 Precise Reference buckets', () => {
    it('lists 97 sizes of at most one megapixel in steps of 64, portrait first', () => {
        expect(V5_REFERENCE_BUCKETS).toHaveLength(97)
        expect(new Set(V5_REFERENCE_BUCKETS.map(bucket => `${bucket.width}x${bucket.height}`)).size).toBe(97)
        for (const bucket of V5_REFERENCE_BUCKETS) {
            expect(bucket.width % 64).toBe(0)
            expect(bucket.height % 64).toBe(0)
            expect(bucket.width * bucket.height).toBeLessThanOrEqual(1024 * 1024)
        }
        const size = (index: number) => `${V5_REFERENCE_BUCKETS[index].width}x${V5_REFERENCE_BUCKETS[index].height}`
        expect([0, 12, 13, 45, 48, 49, 51, 96].map(size))
            .toEqual(['256x4096', '256x3328', '320x3264', '832x1216', '1024x1024', '1088x960', '1216x832', '4096x256'])
    })

    it('picks the nearest aspect ratio, scales to cover and crops around the centre', () => {
        expect(fitV5ReferenceBucket(300, 200)).toEqual({ width: 1216, height: 832, resizeWidth: 1248, resizeHeight: 832, left: 16, top: 0 })
        expect(fitV5ReferenceBucket(100, 5000)).toEqual({ width: 256, height: 4096, resizeWidth: 256, resizeHeight: 12800, left: 0, top: 4352 })
        expect(fitV5ReferenceBucket(2000, 1000)).toMatchObject({ width: 1408, height: 704, left: 0, top: 0 })
        expect(fitV5ReferenceBucket(1024, 1024)).toMatchObject({ width: 1024, height: 1024, resizeWidth: 1024, resizeHeight: 1024 })
    })

    it('leaves an image that already has a bucket size untouched', () => {
        expect(fitV5ReferenceBucket(832, 1216)).toEqual({ width: 832, height: 1216, resizeWidth: 832, resizeHeight: 1216, left: 0, top: 0 })
    })
})
