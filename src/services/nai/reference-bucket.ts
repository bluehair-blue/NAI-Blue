const BUCKET_PIXELS = 1024 * 1024

// NovelAI's V5 reference sizes: 49 portrait sizes (height 4096 down to 1024 in steps of 64, the widest multiple of 64
// that stays within one megapixel) followed by their 48 landscape mirrors. Order matters: the first of equal matches wins.
const PORTRAIT_BUCKETS = Array.from({ length: 49 }, (_, index) => {
    const height = 4096 - index * 64
    return { width: Math.floor(BUCKET_PIXELS / height / 64) * 64, height }
})
export const V5_REFERENCE_BUCKETS: readonly { readonly width: number; readonly height: number }[] = Object.freeze([
    ...PORTRAIT_BUCKETS,
    ...PORTRAIT_BUCKETS.slice(0, -1).reverse().map(bucket => ({ width: bucket.height, height: bucket.width })),
])

export interface ReferenceBucketFit {
    /** Bucket size, which is the size of the image NovelAI receives. */
    readonly width: number
    readonly height: number
    /** The source is scaled to this size, then the bucket is cut from it at left/top. */
    readonly resizeWidth: number
    readonly resizeHeight: number
    readonly left: number
    readonly top: number
}

/** Nearest bucket by log aspect ratio, scaled to cover it and cropped around the centre (never padded). */
export function fitV5ReferenceBucket(width: number, height: number): ReferenceBucketFit {
    const aspect = Math.log(Math.max(width, 1) / Math.max(height, 1))
    let bucket = V5_REFERENCE_BUCKETS[0]
    let nearest = Infinity
    for (const candidate of V5_REFERENCE_BUCKETS) {
        const distance = Math.abs(aspect - Math.log(candidate.width / candidate.height))
        if (distance < nearest) {
            nearest = distance
            bucket = candidate
        }
    }
    const scale = Math.max(bucket.width / Math.max(width, 1), bucket.height / Math.max(height, 1))
    const resizeWidth = Math.max(Math.floor(width * scale + 0.5), bucket.width)
    const resizeHeight = Math.max(Math.floor(height * scale + 0.5), bucket.height)
    return {
        width: bucket.width,
        height: bucket.height,
        resizeWidth,
        resizeHeight,
        left: Math.floor((resizeWidth - bucket.width) / 2),
        top: Math.floor((resizeHeight - bucket.height) / 2),
    }
}
