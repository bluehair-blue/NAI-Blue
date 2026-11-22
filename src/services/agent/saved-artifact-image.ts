import type { SceneImageSource } from '@/application/scene/scene-image-source'
import type { ArtifactRecord } from '@/domain/organizer/types'
import { sha256Bytes } from '@/lib/binary-digest'
import { getRuntimeArtifactRepository } from '@/services/organizer/runtime'
import { childOutputRef, type OutputPlatformAdapter } from '@/services/output/platform-adapter'

export const MAX_AGENT_ORIGINAL_IMAGE_BYTES = 25 * 1024 * 1024
export const MAX_AGENT_PREVIEW_BYTES = 1024 * 1024

/** Typed verification failures let recovery reads distinguish changed evidence from unavailable I/O. */
export class SavedArtifactImageError extends Error {
    constructor(readonly code: 'binding-mismatch' | 'content-mismatch', message: string) {
        super(message)
        this.name = 'SavedArtifactImageError'
    }
}

export interface SavedImageDependencies {
    readonly artifacts: { get(id: string): Promise<ArtifactRecord | null> }
    readonly platform: Pick<OutputPlatformAdapter, 'resolveDirectory' | 'readFile'>
}

/** Reads only a repository-owned committed original, then verifies its exact bytes.
 * Neither a caller's path nor an uncommitted Queue/Provider response is accepted. */
export async function readSavedArtifactImage(artifactId: string, expectedChecksum?: string,
    dependencies?: SavedImageDependencies,
): Promise<{ bytes: Uint8Array; mimeType: 'image/png' | 'image/webp'; checksum: string }> {
    const ports = dependencies ?? { artifacts: getRuntimeArtifactRepository(),
        platform: (await import('@/services/output/tauri-output-adapter')).createRuntimeOutputPlatformAdapter() }
    const artifact = await ports.artifacts.get(artifactId)
    if (!artifact || artifact.artifactId !== artifactId || !['png', 'webp'].includes(artifact.original.format)
        || artifact.original.size === null || artifact.original.size > MAX_AGENT_ORIGINAL_IMAGE_BYTES
        || (expectedChecksum !== undefined && expectedChecksum !== artifact.original.contentChecksum)) {
        throw new SavedArtifactImageError('binding-mismatch', 'Saved image binding is unavailable or changed')
    }
    const directory = await ports.platform.resolveDirectory({ portableDirectory: artifact.original.file.directory,
        workflowDefaultDirectory: 'NAI_Blue_Output' })
    const bytes = await ports.platform.readFile(childOutputRef(directory, artifact.original.file.fileName))
    const checksum = await sha256Bytes(bytes)
    if (bytes.length !== artifact.original.size || bytes.length > MAX_AGENT_ORIGINAL_IMAGE_BYTES || checksum !== artifact.original.contentChecksum) {
        throw new SavedArtifactImageError('content-mismatch', 'Saved image content differs from its committed Artifact')
    }
    return { bytes, checksum, mimeType: artifact.original.format === 'png' ? 'image/png' : 'image/webp' }
}

export function imageDataUrl(bytes: Uint8Array, mimeType: string): string {
    let binary = ''
    for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192))
    return `data:${mimeType};base64,${btoa(binary)}`
}

export async function materializeSceneImageSource(source: SceneImageSource): Promise<string> {
    const image = await readSavedArtifactImage(source.artifactId, source.contentChecksum)
    return imageDataUrl(image.bytes, image.mimeType)
}

export const DEFAULT_AGENT_PREVIEW_SIDE = 480
/** Decoded originals above this pixel count are refused by previews and imports alike. */
export const MAX_AGENT_IMAGE_PIXELS = 16_777_216
// Quality steps keep a detailed 1536 px preview under the byte limit instead of failing the read.
const PREVIEW_JPEG_QUALITIES = [0.9, 0.8, 0.7, 0.6]

export interface AgentImageRegion { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface AgentPreviewOptions { readonly maxSide?: number; readonly region?: AgentImageRegion }

/** Source crop in pixels and output size: the region (or whole image) scaled to maxSide on its long side, never upscaled. */
export function agentPreviewGeometry(sourceWidth: number, sourceHeight: number, options: AgentPreviewOptions = {}) {
    const region = options.region ?? { x: 0, y: 0, width: 1, height: 1 }
    const span = (start: number, length: number, size: number) => {
        const from = Math.min(size - 1, Math.max(0, Math.round(start * size)))
        return [from, Math.max(1, Math.min(size, Math.round((start + length) * size)) - from)]
    }
    const [sx, sw] = span(region.x, region.width, sourceWidth)
    const [sy, sh] = span(region.y, region.height, sourceHeight)
    const scale = Math.min(1, (options.maxSide ?? DEFAULT_AGENT_PREVIEW_SIDE) / Math.max(sw, sh))
    return { sx, sy, sw, sh, width: Math.max(1, Math.round(sw * scale)), height: Math.max(1, Math.round(sh * scale)) }
}

/** Re-encoding strips private metadata; previews are bounded independently of original resources. */
export async function makeAgentImagePreview(image: Awaited<ReturnType<typeof readSavedArtifactImage>>, options: AgentPreviewOptions = {}) {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }))
    try {
        if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > MAX_AGENT_IMAGE_PIXELS) throw new Error('Saved image dimensions exceed preview limits')
        const geometry = agentPreviewGeometry(bitmap.width, bitmap.height, options)
        const canvas = document.createElement('canvas')
        canvas.width = geometry.width
        canvas.height = geometry.height
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Image preview renderer is unavailable')
        // JPEG has no alpha; flatten onto white rather than the encoder's black.
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, canvas.width, canvas.height)
        context.drawImage(bitmap, geometry.sx, geometry.sy, geometry.sw, geometry.sh, 0, 0, canvas.width, canvas.height)
        for (const quality of PREVIEW_JPEG_QUALITIES) {
            const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Image preview encoding failed')), 'image/jpeg', quality))
            if (blob.type !== 'image/jpeg') throw new Error('Image preview encoding failed')
            if (blob.size <= MAX_AGENT_PREVIEW_BYTES) return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: 'image/jpeg' as const,
                width: canvas.width, height: canvas.height, sourceWidth: bitmap.width, sourceHeight: bitmap.height }
        }
        throw new Error('Image preview exceeds its byte limit')
    } finally { bitmap.close() }
}
