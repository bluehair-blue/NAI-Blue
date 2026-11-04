import { describe, expect, it, vi } from 'vitest'
import { createArtifactRecord } from '@/domain/organizer/types'
import { sha256Bytes } from '@/lib/binary-digest'
import { readSavedArtifactImage, imageDataUrl } from '@/services/agent/saved-artifact-image'

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
