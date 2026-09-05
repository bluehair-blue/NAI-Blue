import { describe, expect, it, vi } from 'vitest'

import {
    planR2Release,
    revalidateR2Release,
    checkR2ReleaseReadiness,
    type PlanR2ReleaseDependencies,
} from '@/application/r2/plan-r2-release'
import {
    createR2ProfileV2,
    hashR2ProfileV2,
    type R2ProfileV2,
} from '@/domain/r2/types'

const PLAN_IDENTITY = `sha256:${'a'.repeat(64)}` as const

function profile(overrides: Partial<R2ProfileV2> = {}): R2ProfileV2 {
    return {
        ...createR2ProfileV2({
            id: 'profile-1',
            name: 'Private release',
            accountId: 'account-1',
            jurisdiction: null,
            endpoint: null,
            bucket: 'release-bucket',
            prefix: 'generated/images',
            credentialRef: 'stronghold:r2-secret',
            transport: 'native-s3',
            conflictPolicy: 'fail',
            publicMode: 'private',
            publicBaseUrl: null,
        }, '2026-09-04T00:00:00.000Z'),
        ...overrides,
    }
}

function dependencies(
    selected = profile(),
    readiness: 'ready' | 'not-ready' = 'ready',
): PlanR2ReleaseDependencies & {
    getProfile: ReturnType<typeof vi.fn>
    getReadiness: ReturnType<typeof vi.fn>
} {
    return {
        getProfile: vi.fn(async () => selected),
        getReadiness: vi.fn(async () => readiness === 'ready'
            ? { status: 'ready' as const, credentialRef: selected.credentialRef }
            : { status: 'not-ready' as const, reason: 'credential' as const }),
    }
}

async function readySnapshot(
    mode: 'best-effort' | 'required' = 'required',
    deps = dependencies(),
) {
    const result = await planR2Release({
        requirement: { mode, profileId: 'profile-1' },
        objectName: 'image.png',
        planIdentity: PLAN_IDENTITY,
    }, deps)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready' || result.internalSnapshot === null) {
        throw new Error('Expected an enabled R2 release snapshot')
    }
    return result
}

describe('planR2Release', () => {
    it('binds resolved Folder targets and checks the original shared profile hash only before enqueue', async () => {
        const deps = dependencies()
        const resolvedDestination = {
            bucket: 'folder-bucket', prefix: 'characters/blue',
            provenance: {
                profileId: 'generation-folder' as const, bucket: 'ancestor' as const,
                prefix: 'folder' as const, key: 'planned-output' as const,
                folder: { id: 'blue', profileId: null, bucket: 'parent', prefix: 'blue' },
            },
        }
        const planned = await planR2Release({
            requirement: { mode: 'required', profileId: 'profile-1' }, objectName: 'image.png',
            planIdentity: PLAN_IDENTITY, resolvedDestination,
        }, deps)
        if (planned.status !== 'ready' || planned.internalSnapshot === null) throw new Error('Expected ready')
        expect(planned.destination).toMatchObject({
            bucket: 'folder-bucket', key: 'characters/blue/image.png', provenance: resolvedDestination.provenance,
            profileHash: hashR2ProfileV2({ ...profile(), bucket: 'folder-bucket', prefix: 'characters/blue' }),
        })
        expect(planned.internalSnapshot.profile).toMatchObject({ bucket: 'folder-bucket', prefix: 'characters/blue' })
        expect(planned.internalSnapshot.sourceProfileHash).toBe(hashR2ProfileV2(profile()))
        expect((await revalidateR2Release(planned.internalSnapshot, deps)).status).toBe('ready')
        const rotated = dependencies(profile({ credentialRef: 'stronghold:new-unavailable' }))
        expect((await revalidateR2Release(planned.internalSnapshot, rotated)).status).toBe('blocked')
        deps.getProfile.mockRejectedValue(new Error('Dispatch must not read mutable profile'))
        expect((await checkR2ReleaseReadiness(planned.internalSnapshot, deps)).status).toBe('ready')
        deps.getReadiness.mockResolvedValue({ status: 'not-ready', reason: 'credential' })
        expect((await checkR2ReleaseReadiness(planned.internalSnapshot, deps)).status).toBe('blocked')
    })

    it('preserves prefix clear while rejecting an explicitly cleared bucket', async () => {
        const deps = dependencies()
        const input = {
            requirement: { mode: 'best-effort' as const, profileId: 'profile-1' },
            objectName: 'image.png', planIdentity: PLAN_IDENTITY,
            resolvedDestination: {
                bucket: 'folder-bucket', prefix: '',
                provenance: { profileId: 'generation-folder' as const, bucket: 'folder' as const, prefix: 'cleared' as const, key: 'planned-output' as const },
            },
        }
        expect(await planR2Release(input, deps)).toMatchObject({ status: 'ready', destination: { key: 'image.png' } })
        expect(await planR2Release({ ...input, resolvedDestination: { ...input.resolvedDestination, bucket: null } }, deps))
            .toMatchObject({ status: 'invalid', code: 'r2-destination-unavailable' })
    })
    it('plans disabled delivery without reading profile or readiness state', async () => {
        const deps = dependencies()

        const result = await planR2Release({
            requirement: { mode: 'disabled' },
            objectName: 'ignored.png',
            planIdentity: PLAN_IDENTITY,
        }, deps)

        expect(result).toMatchObject({
            status: 'ready',
            destination: { requirement: 'disabled', profileId: null, key: null },
            internalSnapshot: null,
            readiness: 'not-required',
        })
        expect(deps.getProfile).not.toHaveBeenCalled()
        expect(deps.getReadiness).not.toHaveBeenCalled()
    })

    it('fixes one deterministic suffix target and keeps credentials out of the public destination', async () => {
        const selected = profile({ conflictPolicy: 'suffix' })
        const first = await readySnapshot('required', dependencies(selected))
        const second = await readySnapshot('required', dependencies(selected))

        expect(first.destination).toEqual(second.destination)
        expect(first.destination).toMatchObject({
            requirement: 'required',
            profileId: selected.id,
            profileHash: hashR2ProfileV2(selected),
            bucket: selected.bucket,
            conflictPolicy: 'suffix',
            verification: 'head-metadata-sha256',
            provenance: {
                profileId: 'explicit-request',
                bucket: 'profile-snapshot',
                prefix: 'profile-snapshot',
                key: 'planned-output',
            },
        })
        expect(first.destination.key).toMatch(/^generated\/images\/image-[a-f0-9]{12}\.png$/)
        expect(JSON.stringify(first.destination)).not.toContain('credentialRef')
        expect(JSON.stringify(first.destination)).not.toContain(selected.credentialRef)
        expect(first.internalSnapshot.credentialBinding.credentialRef).toBe(selected.credentialRef)
        expect(Object.isFrozen(first.destination)).toBe(true)
        expect(Object.isFrozen(first.internalSnapshot)).toBe(true)
    })

    it('rejects delete-original and overwrite before readiness checks', async () => {
        const deleteDeps = dependencies()
        const deleted = await planR2Release({
            requirement: { mode: 'required', profileId: 'profile-1' },
            objectName: 'image.png',
            planIdentity: PLAN_IDENTITY,
            deleteOriginal: true,
        }, deleteDeps)
        const overwriteDeps = dependencies(profile({ conflictPolicy: 'overwrite' }))
        const overwritten = await planR2Release({
            requirement: { mode: 'required', profileId: 'profile-1' },
            objectName: 'image.png',
            planIdentity: PLAN_IDENTITY,
        }, overwriteDeps)

        expect(deleted).toMatchObject({ status: 'unsupported', code: 'r2-delete-original-unsupported' })
        expect(overwritten).toMatchObject({ status: 'unsupported', code: 'r2-conflict-policy-unsupported' })
        expect(deleteDeps.getProfile).not.toHaveBeenCalled()
        expect(deleteDeps.getReadiness).not.toHaveBeenCalled()
        expect(overwriteDeps.getReadiness).not.toHaveBeenCalled()
    })

    it('blocks required delivery when readiness is missing initially or after review', async () => {
        const initial = await planR2Release({
            requirement: { mode: 'required', profileId: 'profile-1' },
            objectName: 'image.png',
            planIdentity: PLAN_IDENTITY,
        }, dependencies(profile(), 'not-ready'))
        const reviewed = await readySnapshot()
        const staleDeps = dependencies(profile({ bucket: 'changed-bucket' }))
        const stale = await revalidateR2Release(reviewed.internalSnapshot, staleDeps)
        const notReady = await revalidateR2Release(
            reviewed.internalSnapshot,
            dependencies(profile(), 'not-ready'),
        )

        expect(initial).toMatchObject({ status: 'invalid', code: 'r2-required-not-ready' })
        expect(stale).toMatchObject({ status: 'blocked', code: 'r2-profile-stale' })
        expect(staleDeps.getReadiness).not.toHaveBeenCalled()
        expect(notReady).toMatchObject({ status: 'blocked', code: 'r2-required-not-ready' })
    })

    it('retains a best-effort snapshot when readiness is unavailable or later becomes stale', async () => {
        const planned = await readySnapshot('best-effort', dependencies(profile(), 'not-ready'))
        const stale = await revalidateR2Release(
            planned.internalSnapshot,
            dependencies(profile({ prefix: 'changed' })),
        )

        expect(planned.readiness).toBe('needs-attention')
        expect(planned.destination.requirement).toBe('best-effort')
        expect(stale).toMatchObject({
            status: 'needs-attention',
            snapshot: planned.internalSnapshot,
        })
    })
})
