import { afterEach, describe, expect, it, vi } from 'vitest'
import { createArtifactRecord } from '@/domain/organizer/types'
import { sha256Bytes } from '@/lib/binary-digest'
import { readSavedArtifactImage, imageDataUrl, agentPreviewGeometry, makeAgentImagePreview, MAX_AGENT_PREVIEW_BYTES } from '@/services/agent/saved-artifact-image'

afterEach(() => { vi.unstubAllGlobals() })

/** Canvas stand-in: records drawing and returns JPEG blobs of the sizes given per quality step. */
function fakeCanvas(source: { width: number; height: number }, sizeAt: (quality: number) => number) {
    const calls: { fill?: string; draw?: number[]; encodings: [string, number][] } = { encodings: [] }
    const canvas = { width: 0, height: 0,
        getContext: () => ({ set fillStyle(value: string) { calls.fill = value }, fillRect: () => undefined,
            drawImage: (_bitmap: unknown, ...args: number[]) => { calls.draw = args } }),
        toBlob: (done: (blob: Blob) => void, type: string, quality: number) => {
            calls.encodings.push([type, quality])
            const bytes = new Uint8Array(sizeAt(quality)); bytes.set([0xff, 0xd8, 0xff])
            done(new Blob([bytes], { type }))
        } }
    vi.stubGlobal('createImageBitmap', async () => ({ ...source, close: vi.fn() }))
    vi.stubGlobal('document', { createElement: () => canvas })
    return { canvas, calls }
}
const image = { bytes: new Uint8Array([1]), mimeType: 'image/png' as const, checksum: `sha256:${'a'.repeat(64)}` }

describe('agent image previews', () => {
    it('scales the long side to maxSide, defaults to 480 and never upscales', () => {
        expect(agentPreviewGeometry(1024, 1536)).toEqual({ sx: 0, sy: 0, sw: 1024, sh: 1536, width: 320, height: 480 })
        expect(agentPreviewGeometry(1024, 1536, { maxSide: 1536 })).toEqual({ sx: 0, sy: 0, sw: 1024, sh: 1536, width: 1024, height: 1536 })
        expect(agentPreviewGeometry(512, 768, { maxSide: 1536 })).toMatchObject({ width: 512, height: 768 })
    })
    it('crops the requested normalized rectangle of the original before scaling', () => {
        expect(agentPreviewGeometry(1024, 1536, { region: { x: 0.25, y: 0.5, width: 0.5, height: 0.25 } }))
            .toEqual({ sx: 256, sy: 768, sw: 512, sh: 384, width: 480, height: 360 })
        // A small crop stays at its own resolution rather than being enlarged to maxSide.
        expect(agentPreviewGeometry(1024, 1536, { maxSide: 1536, region: { x: 0.5, y: 0.5, width: 0.125, height: 0.125 } }))
            .toEqual({ sx: 512, sy: 768, sw: 128, sh: 192, width: 128, height: 192 })
        // Float sums just above 1 and sliver regions stay inside the image with at least one pixel.
        expect(agentPreviewGeometry(1000, 1000, { region: { x: 0.7, y: 0.9999999, width: 0.3000000001, height: 0.0000001 } }))
            .toEqual({ sx: 700, sy: 999, sw: 300, sh: 1, width: 300, height: 1 })
    })
    it('encodes JPEG on white with the crop, preview and source sizes', async () => {
        const { calls } = fakeCanvas({ width: 1024, height: 1536 }, () => 200_000)
        const preview = await makeAgentImagePreview(image, { maxSide: 768, region: { x: 0, y: 0.5, width: 1, height: 0.5 } })
        expect(preview).toMatchObject({ mimeType: 'image/jpeg', width: 768, height: 576, sourceWidth: 1024, sourceHeight: 1536 })
        expect(preview.bytes.length).toBe(200_000)
        expect(calls.fill).toBe('#ffffff')
        expect(calls.draw).toEqual([0, 768, 1024, 768, 0, 0, 768, 576])
        expect(calls.encodings).toEqual([['image/jpeg', 0.9]])
    })
    it('lowers JPEG quality to stay under the byte limit and still refuses a preview that never fits', async () => {
        const fitted = fakeCanvas({ width: 1536, height: 1536 }, quality => quality > 0.75 ? MAX_AGENT_PREVIEW_BYTES + 1 : MAX_AGENT_PREVIEW_BYTES)
        expect((await makeAgentImagePreview(image, { maxSide: 1536 })).bytes.length).toBe(MAX_AGENT_PREVIEW_BYTES)
        expect(fitted.calls.encodings.map(([, quality]) => quality)).toEqual([0.9, 0.8, 0.7])
        fakeCanvas({ width: 1536, height: 1536 }, () => MAX_AGENT_PREVIEW_BYTES + 1)
        await expect(makeAgentImagePreview(image, { maxSide: 1536 })).rejects.toThrow('byte limit')
        fakeCanvas({ width: 8192, height: 4096 }, () => 1)
        await expect(makeAgentImagePreview(image)).rejects.toThrow('dimensions')
    })
})

async function fixture() {
    const bytes = new Uint8Array([137,80,78,71,13,10,26,10])
    const checksum = await sha256Bytes(bytes)
    const artifact = createArtifactRecord({ artifactId:'artifact:job', sourceJobId:'job', sourceSceneId:null,
        file:{directory:{kind:'standard',root:'pictures',segments:['output']},fileName:'image.png'},
        format:'png',contentChecksum:checksum,size:bytes.length,createdAt:'2026-10-15T00:00:00.000Z' })
    const deps = { artifacts:{get:vi.fn(async()=>artifact)}, platform:{
        resolveDirectory:vi.fn(async()=>({path:'output',displayPath:'output',capabilityFallbackUsed:false})),
        readFile:vi.fn(async()=>bytes) } }
    return {bytes,checksum,artifact,deps}
}
describe('saved Artifact image access',()=>{
    it('resolves only the committed portable file and verifies size/hash',async()=>{
        const f=await fixture()
        expect(await readSavedArtifactImage('artifact:job',f.checksum,f.deps)).toMatchObject({bytes:f.bytes,mimeType:'image/png',checksum:f.checksum})
        expect(f.deps.platform.readFile).toHaveBeenCalledWith(expect.objectContaining({path:'output/image.png'}))
        expect(imageDataUrl(f.bytes,'image/png')).toBe('data:image/png;base64,iVBORw0KGgo=')
    })
    it('rejects a changed binding before reading the filesystem',async()=>{
        const f=await fixture()
        await expect(readSavedArtifactImage('artifact:job',`sha256:${'b'.repeat(64)}`,f.deps)).rejects.toThrow('binding')
        expect(f.deps.platform.readFile).not.toHaveBeenCalled()
    })
    it('rejects changed bytes and mismatched Artifact identity',async()=>{
        const f=await fixture()
        f.deps.platform.readFile.mockResolvedValue(new Uint8Array([1,2]))
        await expect(readSavedArtifactImage('artifact:job',f.checksum,f.deps)).rejects.toThrow('differs')
        await expect(readSavedArtifactImage('artifact:other',undefined,f.deps)).rejects.toThrow('binding')
    })
})
