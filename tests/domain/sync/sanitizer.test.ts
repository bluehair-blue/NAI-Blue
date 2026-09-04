import { describe, expect, it } from 'vitest'

import {
    typeFixtureDocument,
    typeFixtureModule,
    typeFixtureProfile,
    typeFixtureRecipe,
} from '@/domain/composition/types.typecheck'
import type { CompositionDocument } from '@/domain/composition/types'
import { createArtifactRecord } from '@/domain/organizer/types'
import { ACTIVE_SYNC_ENTITY_TYPES, type ActiveSyncEntityType } from '@/domain/sync'
import {
    SyncSanitizationError,
    assertSyncPayloadSafe,
    sanitizeSyncPayload,
} from '@/services/sync/sanitizer'
import { NOW, wrappedImageCanary } from './constants'

function serialized(value: unknown): string {
    return JSON.stringify(value)
}

describe('sync payload sanitizer', () => {
    it('projects Composition entities while stripping extensions and volatile path hints', () => {
        const source = structuredClone(typeFixtureDocument) as CompositionDocument
        const originalResource = source.resources[0]
        if (originalResource.kind !== 'managed') throw new Error('Expected managed fixture resource')
        const { resourceId: _resourceId, ...resource } = originalResource
        source.id = 'document:1'
        source.revision = 3
        source.resources[0] = {
            ...resource,
            id: 'resource:1',
            kind: 'path',
            path: {
                kind: 'standard', root: 'app-data', segments: ['resources', 'source.png'], displayPath: 'CANARY-PATH',
            },
            extensions: { token: 'CANARY-TOKEN' },
        }
        source.extensions = { authorization: 'CANARY-AUTH' }
        const payload = sanitizeSyncPayload('composition.document', source)

        expect(payload).toMatchObject({ id: 'document:1', revision: 3, schemaVersion: 2 })
        expect(serialized(payload)).not.toContain('CANARY')
        expect(serialized(payload)).not.toContain('displayPath')
        expect(serialized(payload)).not.toContain('extensions')
        expect(payload.resources).toEqual([expect.objectContaining({
            path: { kind: 'standard', root: 'app-data', segments: ['resources', 'source.png'] },
        })])
    })

    it('keeps scene text, params, composition reference, and order while removing images and worker state', () => {
        const payload = sanitizeSyncPayload('scene.card', {
            id: 'scene:1',
            presetId: 'preset:1',
            name: 'Opening',
            scenePrompt: 'quiet harbor',
            width: 832,
            height: 1216,
            excludePinned: true,
            characterPositionEnabled: true,
            characterCaptions: [{
                id: 'caption:heroine', name: 'Heroine', prompt: 'blue hair', negative: 'bad hands', enabled: true,
                position: { x: 0.25, y: 0.75 }, auth: 'CANARY-SECRET',
            }, {
                id: 'caption:partner', name: 'Partner', prompt: 'male partner', negative: '', enabled: true,
                position: { x: 0.8, y: 0.75 },
            }],
            compositionRef: {
                recipeId: 'recipe:1', recipeRevision: 4, auth: 'CANARY-SECRET',
                extensions: { nativePath: 'CANARY-PATH' },
            },
            createdAt: 7,
            orderKey: '0003',
            queueCount: 12,
            images: [{ url: 'data:image/png;base64,CANARY-BYTES' }],
            generationSessionId: 99,
            activeController: { abort: true },
        })

        expect(payload).toEqual({
            characterCaptions: [{
                enabled: true,
                id: 'caption:heroine',
                name: 'Heroine',
                negative: 'bad hands',
                position: { x: 0.25, y: 0.75 },
                prompt: 'blue hair',
            }, {
                enabled: true,
                id: 'caption:partner',
                name: 'Partner',
                negative: '',
                position: { x: 0.8, y: 0.75 },
                prompt: 'male partner',
            }],
            characterPositionEnabled: true,
            compositionRef: { recipeId: 'recipe:1', recipeRevision: 4 },
            createdAt: 7,
            excludePinned: true,
            height: 1216,
            id: 'scene:1',
            name: 'Opening',
            orderKey: '0003',
            presetId: 'preset:1',
            scenePrompt: 'quiet harbor',
            width: 832,
        })
        expect(serialized(payload)).not.toMatch(/queue|image|session|controller/i)
    })

    it('reconstructs prompt presets and fragments without legacy unknown fields or local content keys', () => {
        const preset = sanitizeSyncPayload('prompt.preset', {
            id: 'preset:1', name: 'Portrait', createdAt: 7, basePrompt: 'portrait', additionalPrompt: '',
            detailPrompt: 'rim light', negativePrompt: 'lowres', model: 'nai-diffusion-4-5-full', steps: 28,
            cfgScale: 5, cfgRescale: 0, sampler: 'k_euler_ancestral', scheduler: 'karras', smea: true,
            smeaDyn: true, variety: false, qualityToggle: true, ucPreset: 0,
            selectedResolution: { label: 'Portrait', width: 832, height: 1216, auth: 'CANARY-SECRET' }, orderKey: '0001',
            apiKey: 'CANARY-SECRET', sourcePath: 'CANARY-PATH',
        })
        const fragment = sanitizeSyncPayload('prompt.fragment', {
            schemaVersion: 2, id: 'fragment:1', name: 'lighting', folder: 'shared',
            content: ['rim light', 'soft light'], createdAt: 1, updatedAt: 2, orderKey: '0002',
            contentKey: 'local-db-key', lineCount: 2, sequentialCounters: { local: 7 },
        })

        expect(preset).toMatchObject({ id: 'preset:1', basePrompt: 'portrait', orderKey: '0001' })
        expect(serialized(preset)).not.toContain('CANARY')
        expect(fragment).toEqual({
            content: ['rim light', 'soft light'],
            createdAt: 1,
            folder: 'shared',
            id: 'fragment:1',
            name: 'lighting',
            orderKey: '0002',
            schemaVersion: 2,
            updatedAt: 2,
        })
    })

    it('documents the only UI settings eligible for LWW and drops platform/runtime settings', () => {
        const payload = sanitizeSyncPayload('ui.preference', {
            theme: 'dark',
            leftSidebarVisible: true,
            rightSidebarVisible: false,
            promptFontSize: 16,
            basePromptCollapsed: false,
            additionalPromptCollapsed: true,
            detailPromptCollapsed: false,
            negativePromptCollapsed: true,
            mosaicPixelSize: 10,
            mosaicBrushSize: 50,
            inpaintingBrushSize: 40,
            savePath: 'CANARY-PATH',
            useAbsolutePath: true,
            geminiApiKey: 'CANARY-SECRET',
            useStreaming: true,
            generationDelay: 500,
        })

        expect(payload).toEqual({
            additionalPromptCollapsed: true,
            basePromptCollapsed: false,
            detailPromptCollapsed: false,
            inpaintingBrushSize: 40,
            leftSidebarVisible: true,
            mosaicBrushSize: 50,
            mosaicPixelSize: 10,
            negativePromptCollapsed: true,
            promptFontSize: 16,
            rightSidebarVisible: false,
            theme: 'dark',
        })
        expect(serialized(payload)).not.toMatch(/path|apikey|streaming|delay|CANARY/i)
    })

    it('projects artifact facts and R2 object identity without thumbnail, file, failure text, or upload runtime', () => {
        const artifactSource = createArtifactRecord({
            artifactId: 'artifact:1',
            sourceJobId: 'job:1',
            sourceSceneId: 'scene:1',
            outputCommitSetHash: `sha256:${'b'.repeat(64)}`,
            file: { directory: { kind: 'standard', root: 'app-data', segments: ['private'] }, fileName: 'source.png' },
            format: 'png', size: 123,
            contentChecksum: `sha256:${'a'.repeat(64)}`,
            createdAt: NOW,
        })
        const artifact = sanitizeSyncPayload('artifact.metadata', artifactSource)
        const remote = sanitizeSyncPayload('artifact.r2-object', {
            profileId: 'profile:1', uploadJobId: 'upload:1', artifactId: 'artifact:1', variantId: 'dist:1',
            remoteKey: 'exports/public.png', state: 'succeeded', updatedAt: NOW,
            signedUrl: 'CANARY-URL', multipart: { uploadId: 'CANARY-UPLOAD' },
            failure: { summary: 'CANARY-LOG' },
        })

        expect(serialized(artifact)).not.toMatch(/thumbnail|"(?:file|absolutePath|nativePath|failure)"|CANARY/i)
        expect(artifact).toMatchObject({
            artifactId: 'artifact:1',
            outputCommitSetHash: `sha256:${'b'.repeat(64)}`,
            original: { format: 'png', size: 123 },
        })
        expect(remote).toEqual({
            artifactId: 'artifact:1',
            profileId: 'profile:1',
            remoteKey: 'exports/public.png',
            state: 'succeeded',
            updatedAt: NOW,
            variantId: 'dist:1',
        })
        expect(() => sanitizeSyncPayload('artifact.metadata', {
            ...artifactSource, contentChecksum: 'secret-canary',
        })).toThrow(SyncSanitizationError)
        expect(() => sanitizeSyncPayload('artifact.metadata', {
            ...artifactSource, outputCommitSetHash: 'sha256:malformed',
        })).toThrow(SyncSanitizationError)
        expect(sanitizeSyncPayload('artifact.metadata', {
            ...artifactSource, outputCommitSetHash: null,
        }).outputCommitSetHash).toBeNull()
        expect(() => sanitizeSyncPayload('artifact.r2-object', {
            profileId: 'profile:1', artifactId: 'artifact:1', variantId: 'original',
            remoteKey: '../private.png', state: 'succeeded', updatedAt: NOW,
        })).toThrow(SyncSanitizationError)
    })

    it('defines a valid secret-free projection for every active Phase 11 entity type', () => {
        const compositionCanary = <T extends object>(value: T) => ({
            ...structuredClone(value),
            extensions: { token: 'CANARY-SECRET' },
        })
        const artifact = createArtifactRecord({
            artifactId: 'artifact:matrix', sourceJobId: 'job:matrix', sourceSceneId: 'scene:matrix',
            file: { directory: { kind: 'standard', root: 'app-data', segments: ['matrix'] }, fileName: 'matrix.png' },
            format: 'png', contentChecksum: `sha256:${'d'.repeat(64)}`, size: 10, createdAt: NOW,
        })
        const fixtures: Record<ActiveSyncEntityType, unknown> = {
            'composition.document': compositionCanary(typeFixtureDocument),
            'composition.profile': compositionCanary(typeFixtureProfile),
            'composition.recipe': compositionCanary(typeFixtureRecipe),
            'composition.module': compositionCanary(typeFixtureModule),
            'scene.preset': {
                id: 'scene-preset:matrix', name: 'Matrix', createdAt: 1, orderKey: '0001',
                scenes: [{ images: ['CANARY-BYTES'] }], platformOnlySetting: 'CANARY-PLATFORM',
            },
            'scene.card': {
                id: 'scene:matrix', name: 'Matrix', scenePrompt: 'safe prompt', createdAt: 1, orderKey: '0001',
                images: ['CANARY-BYTES'], outputWriterJournal: 'CANARY-JOURNAL',
            },
            'prompt.preset': {
                id: 'preset:matrix', name: 'Matrix', createdAt: 1, basePrompt: 'base', additionalPrompt: '',
                detailPrompt: '', negativePrompt: '', model: 'nai-diffusion-4-5-full', steps: 28, cfgScale: 5,
                cfgRescale: 0, sampler: 'k_euler_ancestral', scheduler: 'karras', smea: false, smeaDyn: false,
                variety: false, qualityToggle: true, ucPreset: 0,
                selectedResolution: { label: 'Portrait', width: 832, height: 1216 }, orderKey: '0001',
                credentialRef: { backend: 'CANARY-OPAQUE' },
            },
            'prompt.fragment': {
                schemaVersion: 2, id: 'fragment:matrix', name: 'Matrix', folder: 'shared', content: ['safe'],
                createdAt: 1, updatedAt: 1, orderKey: '0001', rawDiagnosticLog: 'CANARY-LOG',
            },
            'ui.preference': { theme: 'dark', promptFontSize: 16, savePath: 'CANARY-PATH' },
            'artifact.metadata': { ...artifact, platformOnlySetting: 'CANARY-PLATFORM' },
            'artifact.r2-object': {
                profileId: 'profile:matrix', artifactId: 'artifact:matrix', variantId: 'original',
                remoteKey: 'matrix/original.png', state: 'succeeded', updatedAt: NOW,
                signedUrl: 'CANARY-SIGNED-URL',
            },
        }

        expect(Object.keys(fixtures)).toEqual([...ACTIVE_SYNC_ENTITY_TYPES])
        for (const entityType of ACTIVE_SYNC_ENTITY_TYPES) {
            const first = sanitizeSyncPayload(entityType, fixtures[entityType])
            const second = sanitizeSyncPayload(entityType, first)
            expect(second).toEqual(first)
            expect(() => assertSyncPayloadSafe(first)).not.toThrow()
            expect(serialized(first)).not.toContain('CANARY')
        }
        expect(() => sanitizeSyncPayload('generation.job-snapshot', { id: 'job:matrix' }))
            .toThrow(SyncSanitizationError)
        expect(() => sanitizeSyncPayload('composition.module', { token: 'CANARY' }))
            .toThrow(SyncSanitizationError)
    })

    it.each([
        { label: 'bearer-shaped value', value: 'Bearer token-canary' },
        { label: 'signed query', value: 'https://example.invalid/file?X-Amz-Signature=signed-canary' },
        { label: 'short signed query', value: 'https://example.invalid/file?sig=abcdef123456' },
        { label: 'data URL', value: 'data:image/png;base64,aW1hZ2UtYnl0ZXMtY2FuYXJ5' },
        { label: 'blob URL', value: 'blob:https://example.invalid/blob-canary' },
        { label: 'colon-prefixed data URL', value: 'x:data:image/png;base64,AAAA' },
        { label: 'non-base64 image data URL', value: 'x:data:image/svg+xml,%3Csvg%3E%3C/svg%3E' },
        { label: 'raw SVG markup', value: '<svg/>' },
        { label: 'percent-encoded SVG markup', value: '%3Csvg%2F%3E' },
        { label: 'colon-prefixed blob URL', value: 'url:blob:https://example.invalid/blob-canary' },
        { label: 'colon-prefixed file URL', value: 'source:file:/tmp/canary' },
        { label: 'colon-prefixed content URI', value: 'source:content://canary/image' },
        { label: 'Windows absolute path', value: 'C:\\Users\\canary\\image.png' },
        { label: 'multi-segment POSIX absolute path', value: '/home/canary/image.png' },
        { label: 'single-segment POSIX absolute path', value: '/tmp' },
        { label: 'single-file POSIX absolute path', value: '/secret.png' },
        { label: 'POSIX root path', value: '/' },
        { label: 'double-slash absolute path', value: '//server/share' },
        { label: 'embedded Windows absolute path', value: 'prefix C:\\Users\\canary\\image.png' },
        { label: 'hyphen-prefixed POSIX absolute path', value: 'prefix-/home/canary/file.png' },
        { label: 'dot-prefixed POSIX absolute path', value: 'prefix./home/canary/file.png' },
        { label: 'home-relative path', value: '~/canary/file.png' },
        { label: 'HOME variable path', value: '$HOME/private/file.png' },
        { label: 'braced HOME variable path', value: '${HOME}/private/file.png' },
        { label: 'Windows profile variable path', value: '%USERPROFILE%\\private\\file.png' },
        { label: 'embedded known POSIX root', value: 'x/home/canary/file.png' },
        { label: 'root-relative Windows path', value: '\\Users\\canary\\image.png' },
        { label: 'percent-encoded POSIX path', value: 'path%3A%2Fhome%2Fcanary%2Fimage.png' },
        { label: 'percent-encoded Windows path', value: 'C%3A%5CUsers%5Ccanary%5Cimage.png' },
        {
            label: 'triple-encoded POSIX path',
            value: encodeURIComponent(encodeURIComponent(encodeURIComponent('path:/home/canary/image.png'))),
        },
        { label: 'colon-prefixed Windows absolute path', value: 'path:C:\\Users\\canary\\image.png' },
        { label: 'colon-prefixed POSIX absolute path', value: 'path:/home/canary/image.png' },
        { label: 'comma-prefixed POSIX absolute path', value: 'path,/home/canary/image.png' },
        { label: 'embedded data URL', value: 'prefix data:image/png;base64,iVBORw0KGgoAAA' },
        { label: 'embedded raw image base64', value: 'prefix iVBORw0KGgoAAAAAAA suffix' },
        { label: 'cookie-shaped value', value: 'Cookie: session=session-canary' },
        { label: 'set-cookie equals value', value: 'Set-Cookie=session-canary' },
        { label: 'session assignment', value: 'session=session-canary' },
        { label: 'embedded authorization value', value: 'prefix Authorization: Bearer token-canary' },
        { label: 'authorization equals basic value', value: 'Authorization = Basic canary' },
        { label: 'embedded cookie value', value: 'prefix Cookie: session=session-canary' },
        { label: 'percent-encoded bearer URL value', value: 'https://example.invalid/object?q=Bearer%20canary' },
        { label: 'signed material in arbitrary URL value', value: 'https://example.invalid/object?q=X-Amz-Signature%3Dcanary' },
        { label: 'signed URL fragment', value: 'https://example.invalid/object#X-Amz-Signature=canary' },
        { label: 'signed URL matrix path', value: 'https://example.invalid/object;X-Amz-Signature=canary' },
        { label: 'percent-encoded signed URL', value: 'https%3A%2F%2Fexample.invalid%2Fobject%3Fsig%3Dcanary' },
        {
            label: 'triple-encoded signed URL',
            value: encodeURIComponent(encodeURIComponent(encodeURIComponent('https://example.invalid/object?sig=canary'))),
        },
        { label: 'POSIX path in URL value', value: 'https://example.invalid/view?p=%2Fhome%2Fcanary%2Ffile.png' },
        { label: 'Windows path in URL value', value: 'https://example.invalid/view?p=C%3A%5CUsers%5Ccanary%5Cfile.png' },
        { label: 'short auth query', value: 'https://example.invalid/object?auth=canary' },
        { label: 'hmac expiry query', value: 'https://example.invalid/object?expires=1&hmac=canary' },
        { label: 'PEM private key marker', value: '-----BEGIN PRIVATE KEY-----\ncanary' },
        { label: 'access-key-shaped value', value: 'AKIAIOSFODNN7EXAMPLE' },
        { label: 'secret-key-shaped value', value: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
        { label: 'provider secret prefix', value: 'sk-proj-canaryvalue123456' },
        { label: 'JWT-shaped value', value: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJjYW5hcnkifQ.signature' },
        { label: 'JWT-shaped value with empty signature', value: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJjYW5hcnkifQ.' },
        { label: 'hex image signature', value: '89504e470d0a1a0a0000000d49484452' },
        { label: 'offset hex image signature', value: '0089504e470d0a1a0a' },
        { label: 'nibble-offset hex image signature', value: 'f89504e470d0a1a0a' },
        { label: 'hex image signature between incomplete nibbles', value: 'f89504e470d0a1a0af' },
        { label: 'wrapped hex image signature inside prose', value: 'note=8950 4e47 0d0a 1a0a=end' },
        { label: 'wrapped hex image signature between hex-like prose', value: 'note 8950 4e47 0d0a 1a0a end' },
        { label: 'high-entropy hex material', value: '0123456789abcdef0123456789abcdef' },
        { label: 'generic padded base64', value: 'c2VjcmV0LWNhbmFyeQ==' },
        { label: 'embedded generic padded base64', value: 'prefix c2VjcmV0LWNhbmFyeQ== suffix' },
        { label: 'generic unpadded base64', value: 'c2VjcmV0Y2FuYXJ5' },
        { label: 'two-class unpadded base64', value: 'YWJjZGVmZ2hpamts' },
        { label: 'generic unpadded base64url', value: 'c2VjcmV0LWNhbmFyeV8' },
        { label: 'generic binary base64', value: 'AAECAwQFBgcICQoL' },
        { label: 'high-byte binary base64', value: 'oKGio6Slpqeoqaqr' },
        { label: 'zero-byte base64', value: 'AAAAAAAAAAAAAAAA' },
        { label: 'repeated-control base64', value: 'AQEBAQEBAQEBAQEB' },
        { label: 'MIME-whitespace image base64', value: 'iVBO Rw0K GgoA AAAA' },
        { label: 'uneven MIME-whitespace image base64', value: 'iVBOR w0KGg oAAAA A' },
        { label: 'MIME-whitespace zero base64', value: 'AAAA AAAA AAAA AAAA' },
        { label: 'word-shaped zero base64 with surrounding prose', value: 'a AAAA AAAA AAAA AAAA b' },
        { label: 'uneven MIME-whitespace binary base64', value: 'AAECA wQFBg cICQo LDA0O Dw==' },
        { label: 'embedded MIME-whitespace binary base64', value: 'binary:AAECA wQFBg cICQo LDA0O Dw==;end' },
        { label: 'embedded MIME-whitespace image base64', value: 'image:iVBOR w0KGg oAAAA A;end' },
        { label: 'embedded non-breaking-space image base64', value: 'image:iVBO\u00a0Rw0K\u00a0Ggo=' },
        { label: 'greedy-prefix wrapped image base64', value: `image ${wrappedImageCanary()}` },
        { label: 'irregular word-shaped PNG base64 chunks', value: 'a iVBORw 0 KGgoAAAAA b' },
        { label: 'minimal PNG signature chunks with surrounding prose', value: 'a iVBO Rw0K Ggo= b' },
        { label: 'irregular PNG base64 after equals prose', value: 'setting = true a iVBORw 0 KGgoAAAAA b' },
        { label: 'padded wrapped image with trailing prose', value: `image ${wrappedImageCanary(true)} end` },
        { label: 'unpadded wrapped binary with trailing prose', value: 'binary AAECA wQFBg cICQo LDA0O a' },
        { label: 'wrapped binary after a long prose prefix', value: `${'a'.repeat(2_048)} AAECA wQFBg cICQo LDA0O a` },
        { label: 'embedded padded printable base64', value: 'binary c2Vj cmV0 LWNh bmFy eQ== end' },
        { label: 'punctuated embedded padded printable base64', value: 'binary:c2Vj cmV0 LWNh bmFy eQ==;end' },
        { label: 'irregular unpadded printable base64 chunks', value: 'a c 2 VjcmV 0 LWNhbmFyeQ b' },
        { label: 'word-shaped unpadded printable base64 chunks', value: 'a c 2V jcm V0 LWN hbm Fye QB' },
        { label: 'unpadded AVIF base64', value: 'AAAAIGZ0eXBhdmlm' },
        { label: 'GIF image base64', value: 'R0lGODlhAQABAIAAAAUEBA' },
        { label: 'SVG image base64', value: 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==' },
        {
            label: 'raw binary image string',
            value: String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0),
        },
    ])('rejects forbidden material hidden in an allowed text field without echoing it: $label', ({ value: canary }) => {
        let error: unknown
        try {
            sanitizeSyncPayload('scene.card', {
                id: 'scene:1', name: 'Scene', scenePrompt: canary, createdAt: 1, orderKey: '0001',
            })
        } catch (caught) {
            error = caught
        }
        expect(error).toBeInstanceOf(SyncSanitizationError)
        expect((error as Error).message).not.toContain(canary)
    })

    it('rejects every wrapped image and control-binary alignment with surrounding prose', () => {
        const imageBytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
        let state = 123_456_789
        for (let index = 0; index < 240; index += 1) {
            state = ((1_664_525 * state) + 1_013_904_223) >>> 0
            imageBytes.push(0x20 + (state % 95))
        }
        const binaryBytes = Array.from({ length: 15 }, (_entry, index) => index)
        const highBytes = Array.from({ length: 12 }, (_entry, index) => 0xa0 + index)
        const forms = (bytes: number[]) => {
            const padded = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_')
            return [padded.replace(/=+$/, ''), padded]
        }
        let accepted = 0
        const printablePadded = btoa('synthetic-canary').replace(/\+/g, '-').replace(/\//g, '_')
        const payloadForms = [
            ...forms(imageBytes),
            ...forms(binaryBytes),
            ...forms(highBytes),
            printablePadded,
        ]
        for (const encoded of payloadForms) {
            for (const width of [2, 3, 4, 5, 7, 11]) {
                const wrapped = encoded.match(new RegExp(`.{1,${width}}`, 'g'))?.join(' ') ?? encoded
                for (const prefixLength of [0, 1, 2, 3, 5, 6, 9]) {
                    for (const suffixLength of [0, 1, 2, 3, 4, 5, 6, 9]) {
                        const value = [
                            prefixLength > 0 ? 'a'.repeat(prefixLength) : '',
                            wrapped,
                            suffixLength > 0 ? 'b'.repeat(suffixLength) : '',
                        ].filter(Boolean).join(' ')
                        try {
                            sanitizeSyncPayload('scene.card', {
                                id: 'scene:matrix', name: 'Scene', scenePrompt: value,
                                createdAt: 1, orderKey: '0001',
                            })
                            accepted += 1
                        } catch (error) {
                            expect(error).toBeInstanceOf(SyncSanitizationError)
                        }
                    }
                }
            }
        }
        expect(accepted).toBe(0)
    })

    it('rejects every whitespace partition of the minimal PNG signature', () => {
        const encoded = 'iVBORw0KGgo='
        let accepted = 0
        for (let mask = 0; mask < 2 ** (encoded.length - 1); mask += 1) {
            let wrapped = encoded[0]
            for (let index = 1; index < encoded.length; index += 1) {
                wrapped += `${(mask & (1 << (index - 1))) === 0 ? '' : ' '}${encoded[index]}`
            }
            try {
                sanitizeSyncPayload('scene.card', {
                    id: 'scene:partition', name: 'Scene', scenePrompt: `a ${wrapped} b`,
                    createdAt: 1, orderKey: '0001',
                })
                accepted += 1
            } catch (error) {
                expect(error).toBeInstanceOf(SyncSanitizationError)
            }
        }
        expect(accepted).toBe(0)
    })

    it('rejects every whitespace partition of the bounded high-byte binary canary', () => {
        const encoded = 'oKGio6Slpqeoqaqr'
        let accepted = 0
        let rejectedWithWrongError = false
        for (let mask = 0; mask < 2 ** (encoded.length - 1); mask += 1) {
            let wrapped = encoded[0]
            for (let index = 1; index < encoded.length; index += 1) {
                wrapped += `${(mask & (1 << (index - 1))) === 0 ? '' : ' '}${encoded[index]}`
            }
            try {
                sanitizeSyncPayload('scene.card', {
                    id: 'scene:binary-partition', name: 'Scene', scenePrompt: `a ${wrapped} b`,
                    createdAt: 1, orderKey: '0001',
                })
                accepted += 1
            } catch (error) {
                // This exhaustive 2^15 loop verifies the error type once at the boundary;
                // avoiding one Vitest assertion object per partition keeps CI CPU contention bounded.
                if (!(error instanceof SyncSanitizationError)) {
                    rejectedWithWrongError = true
                    break
                }
            }
        }
        expect(rejectedWithWrongError).toBe(false)
        expect(accepted).toBe(0)
    }, 15_000)

    it('rejects forbidden fields in a finalized payload even if a caller bypasses projection', () => {
        expect(() => assertSyncPayloadSafe({ safe: { outputWriterJournal: 'journal-canary' } }))
            .toThrow(SyncSanitizationError)
        expect(() => assertSyncPayloadSafe({ safe: { leaseController: 'controller-canary' } }))
            .toThrow(SyncSanitizationError)
        expect(() => assertSyncPayloadSafe({ safe: { diagnosticRawLog: 'log-canary' } }))
            .toThrow(SyncSanitizationError)
        expect(() => assertSyncPayloadSafe({ safe: { novelAiToken: 'token-canary' } }))
            .toThrow(SyncSanitizationError)
        expect(() => assertSyncPayloadSafe({ safe: { secretAccessKey: 'secret-canary' } }))
            .toThrow(SyncSanitizationError)
        expect(() => assertSyncPayloadSafe({ safe: [137, 80, 78, 71, 13, 10, 26, 10] }))
            .toThrow(SyncSanitizationError)
        for (const bytes of [
            [0, 0, 1, 0, 1, 0],
            [66, 77, 70, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0],
            [56, 66, 80, 83, 0, 1, 0, 0, 0, 0, 0, 0],
            [113, 111, 105, 102, 0, 0, 0, 1, 0, 0, 0, 1, 3, 0],
            [60, 115, 118, 103, 62],
            [0, 137, 80, 78, 71, 13, 10, 26, 10],
        ]) {
            expect(() => assertSyncPayloadSafe({ safe: bytes })).toThrow(SyncSanitizationError)
        }
        for (const key of [
            'auth', 'bearer', 'sig', 'signature', 'hmac', 'imageData', 'thumbnail', 'previewData', 'pixelData',
            'rgba', 'blobData', 'rawBinary',
        ]) {
            expect(() => assertSyncPayloadSafe({ [key]: 'canary' })).toThrow(SyncSanitizationError)
        }
        for (const key of ['to%6ben', 's%65cret', 'image%44ata']) {
            expect(() => assertSyncPayloadSafe({ [key]: 'canary' })).toThrow(SyncSanitizationError)
        }
        expect(() => assertSyncPayloadSafe({ safe: [1, 2, 3] })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ prompt: 'a'.repeat(512) })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ prompt: 'CharacterName123' })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ prompt: 'ultradetailedmasterpiece2026' })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ prompt: 'character_v2_costume' })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ prompt: 'basic portrait lighting' })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ prompt: 'digest composition summary' })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ prompt: 'bearer of a crown' })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ prompt: 'and/or composition' })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ prompt: 'soft blue eyes glow' })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ prompt: 'dark 2026 eyes glow' })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ prompt: 'quiet harbor at blue hour' })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ prompt: 'image prompt with blue hour' })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ prompt: 'image v2 prompt with blue hour' })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ prompt: '4k 2D character art' })).not.toThrow()
        for (const prompt of [
            'masterpiece best quality 1girl solo',
            'cinematic lighting depth of field',
            'red hair blue eyes school uniform',
            'artist style v4 8k wallpaper',
            'highly detailed anime illustration',
            'upper body looking at viewer',
        ]) {
            expect(() => assertSyncPayloadSafe({ prompt })).not.toThrow()
        }
        expect(() => assertSyncPayloadSafe({ prompt: 'CompositionWeight = High' })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ prompt: 'CharacterName portrait style' })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ prompt: 'Image Prompt With Blue Hour' })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ prompt: 'iPhone portrait style' })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ prompt: 'iPhone portrait style v2' })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ prompt: 'iPhone 15 portrait style' })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ prompt: '2D character art' })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ prompt: 'BModel2026 portrait style' })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ prompt: 'BM' })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ prompt: 'IBM portrait style' })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ prompt: 'BModel2026' })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ prompt: 'ambient BMS lighting' })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ model: 'nai-diffusion-4-5-full' })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ prompt: '100% complete' })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ prompt: 'https://example.invalid/view?id=public' })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ prompt: 'reference https://example.invalid/assets/view?id=public' }))
            .not.toThrow()
        expect(() => assertSyncPayloadSafe({ opId: 'c2VjcmV0Y2FuYXJ5' })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ id: 'c2VjcmV0Y2FuYXJ5' })).not.toThrow()
        expect(() => assertSyncPayloadSafe({ grid: 'AAECAwQFBgcICQoL' })).toThrow(SyncSanitizationError)
        expect(() => assertSyncPayloadSafe({ solid: 'AAECAwQFBgcICQoL' })).toThrow(SyncSanitizationError)
        for (const id of ['Qk', 'QkModel2026', 'UklGR-project', 'SUkq-id', 'TU0A-value', 'R0lGOD-task']) {
            expect(() => assertSyncPayloadSafe({ opId: id })).not.toThrow()
        }
    })

    it('scans the full bounded value of nested Composition identifiers for encoded image bytes', () => {
        const source = structuredClone(typeFixtureDocument) as CompositionDocument
        source.createdBy = { ...source.createdBy, id: `${'A'.repeat(1_024)}iVBORw0KGgoAAAAA` }
        expect(() => sanitizeSyncPayload('composition.document', source)).toThrow(SyncSanitizationError)
    })
})
