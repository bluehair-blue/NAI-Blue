import { describe, expect, it } from 'vitest'

import { createR2ProfileV2, deterministicR2Suffix, hashR2ProfileV2, type R2ProfileV2 } from '@/domain/r2/types'
import { createRuntimeCapabilities } from '@/platform/capabilities'

describe('R2 platform and conflict contracts', () => {
    it('hashes every semantic profile field but ignores timestamps and object key order', () => {
        const profile = createR2ProfileV2({
            id: 'profile',
            name: 'Profile',
            accountId: 'account',
            jurisdiction: null,
            endpoint: null,
            bucket: 'profile-bucket',
            prefix: 'exports',
            credentialRef: 'credential-a',
            transport: 'native-s3',
            conflictPolicy: 'fail',
            publicMode: 'private',
            publicBaseUrl: null,
        }, '2026-09-04T00:00:00.000Z')
        const expected = hashR2ProfileV2(profile)
        const reversed = Object.fromEntries(Object.entries(profile).reverse()) as unknown as R2ProfileV2
        expect(expected).toMatch(/^sha256:[a-f0-9]{64}$/)
        expect(hashR2ProfileV2({ ...profile, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-06T00:00:00.000Z' })).toBe(expected)
        expect(hashR2ProfileV2(reversed)).toBe(expected)

        const semanticChanges: R2ProfileV2[] = [
            { ...profile, schemaVersion: 3 } as unknown as R2ProfileV2,
            { ...profile, id: 'profile-b' },
            { ...profile, name: 'Other' },
            { ...profile, accountId: 'account-b' },
            { ...profile, jurisdiction: 'eu' },
            { ...profile, endpoint: 'https://example.invalid' },
            { ...profile, bucket: 'other-bucket' },
            { ...profile, prefix: 'other' },
            { ...profile, credentialRef: 'credential-b' },
            { ...profile, transport: 'wrangler' },
            { ...profile, conflictPolicy: 'skip-same' },
            { ...profile, publicMode: 'r2-dev' },
            { ...profile, publicBaseUrl: 'https://cdn.example.invalid' },
        ]
        expect(semanticChanges.every(changed => hashR2ProfileV2(changed) !== expected)).toBe(true)
    })

    it('keeps profiles readable on mobile while foreground and background upload stay explicit', () => {
        const android = createRuntimeCapabilities('android')
        expect(android.r2ProfileRead.supported).toBe(true)
        expect(android.r2ForegroundUpload).toMatchObject({ supported: false })
        expect(android.r2ForegroundUpload.reason).toContain('mobile')
        expect(android.r2BackgroundUpload.supported).toBe(false)

        const desktop = createRuntimeCapabilities('windows')
        expect(desktop.r2ProfileRead.supported).toBe(true)
        expect(desktop.r2ForegroundUpload.supported).toBe(true)
        expect(desktop.r2BackgroundUpload.supported).toBe(false)

        expect(createRuntimeCapabilities('web').r2ForegroundUpload).toMatchObject({ supported: false })
        expect(createRuntimeCapabilities('unknown').r2ForegroundUpload).toMatchObject({ supported: false })
    })

    it('derives a stable suffix without changing the extension', () => {
        const hash = `sha256:${'abcdef0123456789'.repeat(4)}`
        expect(deterministicR2Suffix('nested/image.png', hash)).toBe('nested/image-abcdef012345.png')
        expect(deterministicR2Suffix('nested/image.png', hash)).toBe('nested/image-abcdef012345.png')
    })
})
