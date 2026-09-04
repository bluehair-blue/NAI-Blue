import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createR2ProfileV2, hashR2ProfileV2 } from '@/domain/r2/types'
import { reconcileR2ProfileSaveDraft } from '@/components/r2/NativeR2SetupPanel'
import { R2UploadRepositoryError } from '@/services/r2/indexeddb-r2-upload-repository'

const releaseMocks = vi.hoisted(() => ({
    repository: {
        getProfile: vi.fn(),
        putProfile: vi.fn(),
        getJob: vi.fn(),
    },
    coordinator: {
        plan: vi.fn(),
        enqueuePlan: vi.fn(),
        runUntilIdle: vi.fn(),
    },
}))

vi.mock('@/platform/capabilities', async importOriginal => {
    const actual = await importOriginal<typeof import('@/platform/capabilities')>()
    return { ...actual, runtimeCapabilities: actual.createRuntimeCapabilities('windows') }
})
vi.mock('@/services/r2/native-r2-adapter', () => ({
    nativeR2CredentialStatus: vi.fn(async () => ({ available: true })),
    filterNativeR2ArtifactsForProfile: vi.fn(),
    scanNativeR2Artifacts: vi.fn(),
    storeNativeR2Credential: vi.fn(),
    testNativeR2Connection: vi.fn(),
    testNativeR2TemporaryObject: vi.fn(),
}))
vi.mock('@/services/r2/runtime', () => ({
    getRuntimeR2UploadRepository: () => releaseMocks.repository,
    getRuntimeR2UploadCoordinator: () => releaseMocks.coordinator,
}))
vi.mock('@/services/output/tauri-output-adapter', () => ({
    createRuntimeOutputPlatformAdapter: vi.fn(),
}))

import { deriveGeneratedReleaseProfile, releaseLocalImageToR2 } from '@/services/r2/generated-release'

const base = createR2ProfileV2({
    id: 'default',
    name: 'Default R2',
    accountId: 'account',
    jurisdiction: null,
    endpoint: null,
    bucket: 'default-bucket',
    prefix: 'default',
    credentialRef: 'credential',
    transport: 'native-s3',
    conflictPolicy: 'skip-same',
    publicMode: 'private',
    publicBaseUrl: null,
}, '2026-08-12T00:00:00.000Z')

describe('generated R2 release profile', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('creates a stable immutable identity for each captured bucket and prefix', () => {
        const first = deriveGeneratedReleaseProfile(base, {
            bucket: 'scene-bucket',
            prefix: 'prime/bluehair/01',
        }, '2026-08-12T01:00:00.000Z')
        const sameTargetLater = deriveGeneratedReleaseProfile(base, {
            bucket: 'scene-bucket',
            prefix: 'prime/bluehair/01',
        }, '2026-08-13T01:00:00.000Z')
        const otherPrefix = deriveGeneratedReleaseProfile(base, {
            bucket: 'scene-bucket',
            prefix: 'prime/bluehair/02',
        })

        expect(first).toMatchObject({ bucket: 'scene-bucket', prefix: 'prime/bluehair/01' })
        expect(first.id).toBe('generated-release-9a7823dbec13e1d212c6838d75ba5a168805b3cf')
        expect(first.id).toBe(sameTargetLater.id)
        expect(otherPrefix.id).not.toBe(first.id)
    })

    it('rejects a same-ID semantic collision before planning or enqueueing', async () => {
        const derived = deriveGeneratedReleaseProfile(base, {
            bucket: 'scene-bucket',
            prefix: 'prime/bluehair/01',
        })
        releaseMocks.repository.getProfile
            .mockResolvedValueOnce(base)
            .mockResolvedValueOnce({ ...derived, transport: 'relay' })
        releaseMocks.repository.putProfile.mockRejectedValue(
            new R2UploadRepositoryError('E_R2_VERSION_CONFLICT', 'collision'),
        )

        await expect(releaseLocalImageToR2({
            profileId: base.id,
            sourceId: 'source',
            image: {
                localPath: 'C:/fixture/image.png',
                fileName: 'image.png',
                contentSha256: `sha256:${'a'.repeat(64)}`,
                contentType: 'image/png',
                size: 128,
            },
            bucket: 'scene-bucket',
            prefix: 'prime/bluehair/01',
        })).resolves.toEqual({ status: 'unavailable', reason: 'profile' })

        expect(releaseMocks.repository.putProfile).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'generated-release-9a7823dbec13e1d212c6838d75ba5a168805b3cf' }),
            null,
        )
        expect(releaseMocks.coordinator.plan).not.toHaveBeenCalled()
        expect(releaseMocks.coordinator.enqueuePlan).not.toHaveBeenCalled()
    })

    it('reuses an existing legacy binding after the base profile is renamed', async () => {
        const oldGenerated = deriveGeneratedReleaseProfile(base, {
            bucket: 'scene-bucket',
            prefix: 'prime/bluehair/01',
        }, '2026-08-12T01:00:00.000Z')
        const renamedBase = { ...base, name: 'Renamed R2' }
        releaseMocks.repository.getProfile
            .mockResolvedValueOnce(renamedBase)
            .mockResolvedValueOnce(oldGenerated)
        releaseMocks.repository.putProfile.mockRejectedValue(
            new R2UploadRepositoryError('E_R2_VERSION_CONFLICT', 'renamed'),
        )
        releaseMocks.coordinator.plan.mockResolvedValue({ jobs: [] })
        releaseMocks.coordinator.enqueuePlan.mockResolvedValue([])
        releaseMocks.coordinator.runUntilIdle.mockResolvedValue(undefined)

        await expect(releaseLocalImageToR2({
            profileId: base.id,
            sourceId: 'source',
            image: {
                localPath: 'C:/fixture/image.png',
                fileName: 'image.png',
                contentSha256: `sha256:${'a'.repeat(64)}`,
                contentType: 'image/png',
                size: 128,
            },
            sidecar: {
                localPath: 'C:/fixture/image.json',
                fileName: 'image.json',
                contentSha256: `sha256:${'b'.repeat(64)}`,
                contentType: 'application/json',
                size: 64,
            },
            bucket: 'scene-bucket',
            prefix: 'prime/bluehair/01',
        })).resolves.toEqual({ status: 'uploaded', artifactCount: 2, sidecarUploaded: true })

        expect(releaseMocks.coordinator.plan).toHaveBeenCalledWith(oldGenerated, expect.any(Array), 'current-session')
        expect(releaseMocks.coordinator.enqueuePlan).toHaveBeenCalledTimes(1)
    })

    it('preserves edits made while a saved profile is awaiting readback', () => {
        const submittedHash = hashR2ProfileV2(base)
        const stored = { ...base, updatedAt: '2026-08-12T01:00:00.000Z' }
        const editedWhileSaving = { ...base, bucket: 'edited-bucket' }

        expect(reconcileR2ProfileSaveDraft(base, submittedHash, stored)).toBe(stored)
        expect(reconcileR2ProfileSaveDraft(editedWhileSaving, submittedHash, stored)).toBe(editedWhileSaving)
    })

    it('rejects unsafe destinations before any upload job can be planned', () => {
        expect(() => deriveGeneratedReleaseProfile(base, { bucket: 'Invalid_Bucket' })).toThrow()
        expect(() => deriveGeneratedReleaseProfile(base, { prefix: '../escape' })).toThrow()
    })
})
