import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn(async () => ({})))
vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri: () => true }))
vi.mock('@/platform/capabilities', () => ({ requireRuntimeCapability: vi.fn() }))

import { createR2ProfileV2 } from '@/domain/r2/types'
import { nativeR2UploadAdapter } from '@/services/r2/native-r2-adapter'

const profile = createR2ProfileV2({
    id: 'fixture', name: 'Fixture', accountId: 'fixture', jurisdiction: null, endpoint: null,
    bucket: 'private', prefix: '', credentialRef: 'fixture', transport: 'native-s3',
    conflictPolicy: 'fail', publicMode: 'private', publicBaseUrl: null,
})
const artifact = {
    localVariant: 'C:/fixture/output.png', remoteKey: 'output.png', size: 16,
    contentSha256: `sha256:${'a'.repeat(64)}`, contentType: 'image/png',
}

describe('native R2 upload integrity boundary', () => {
    beforeEach(() => invoke.mockClear())

    it.each(['putObject', 'createMultipart'] as const)('%s passes the full queued identity to native validation', async operation => {
        await nativeR2UploadAdapter[operation](profile, artifact)
        expect(invoke).toHaveBeenCalledWith(operation === 'putObject' ? 'r2_put_object' : 'r2_create_multipart',
            expect.objectContaining({
                localPath: artifact.localVariant, contentSize: artifact.size,
                contentSha256: artifact.contentSha256,
            }))
    })

    it('passes the full identity again for a resumed multipart range', async () => {
        await nativeR2UploadAdapter.uploadPart(profile, {
            ...artifact, uploadId: 'existing-upload', partNumber: 2, offset: 8, length: 8,
        })
        expect(invoke).toHaveBeenCalledWith('r2_upload_part', expect.objectContaining({
            localPath: artifact.localVariant, contentSize: artifact.size,
            contentSha256: artifact.contentSha256,
            uploadId: 'existing-upload', partNumber: 2, offset: 8, length: 8,
        }))
    })
})
