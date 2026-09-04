import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'

import { createR2ProfileV2, hashR2ProfileV2, type NativeR2ScannedArtifact, type R2ProfileV2 } from '@/domain/r2/types'
import { ArtifactRepositoryError, IndexedDBArtifactRepository } from '@/services/organizer/artifact-repository'
import {
    createUploadJob,
    IndexedDBR2UploadRepository,
    R2UploadRepositoryError,
} from '@/services/r2/indexeddb-r2-upload-repository'
import { NativeR2Error, type NativeR2UploadAdapter } from '@/services/r2/native-r2-adapter'
import { R2UploadCoordinator } from '@/services/r2/r2-upload-coordinator'

const NOW = '2026-07-14T12:00:00.000Z'
const HASH = `sha256:${'a'.repeat(64)}`
let databaseCounter = 0

function repository(
    label: string,
    artifactReader?: Pick<IndexedDBArtifactRepository, 'get'>,
): IndexedDBR2UploadRepository {
    databaseCounter += 1
    return new IndexedDBR2UploadRepository({
        factory: new IDBFactory() as unknown as globalThis.IDBFactory,
        keyRange: IDBKeyRange as unknown as typeof globalThis.IDBKeyRange,
        databaseName: `r2-${label}-${databaseCounter}`,
        artifactReader,
    })
}

function profile(overrides: Partial<R2ProfileV2> = {}): R2ProfileV2 {
    return {
        ...createR2ProfileV2({
            id: 'r2-profile',
            name: 'Fixture R2',
            accountId: 'account-metadata',
            jurisdiction: null,
            endpoint: 'https://fixture.invalid',
            bucket: 'fixture-bucket',
            prefix: 'exports',
            credentialRef: 'r2-system-fixture',
            transport: 'native-s3',
            conflictPolicy: 'fail',
            publicMode: 'private',
            publicBaseUrl: null,
        }, NOW),
        ...overrides,
    }
}

function artifact(index: number, size = 128): NativeR2ScannedArtifact {
    return {
        artifactId: `artifact:${index}`,
        localVariant: `C:/fixture/image-${index}.png`,
        remoteKey: `exports/image-${index}.png`,
        contentSha256: `sha256:${index.toString(16).padStart(64, '0')}`,
        contentType: 'image/png',
        size,
    }
}

function adapter(overrides: Partial<NativeR2UploadAdapter> = {}): NativeR2UploadAdapter {
    const objects = new Map<string, { size: number; contentSha256: string }>()
    const multipart = new Map<string, { remoteKey: string; size: number; contentSha256: string }>()
    return {
        headObject: vi.fn(async (_profile, remoteKey) => {
            const object = objects.get(remoteKey)
            return object
                ? { exists: true, ...object, etag: 'opaque-etag' }
                : { exists: false, size: null, contentSha256: null, etag: null }
        }),
        putObject: vi.fn(async (_profile, job) => {
            objects.set(job.remoteKey, {
                size: (job as typeof job & { size: number }).size,
                contentSha256: job.contentSha256,
            })
            return { remoteKey: job.remoteKey, uploaded: true, skippedSame: false, etag: 'etag' }
        }),
        createMultipart: vi.fn(async (_profile, job) => {
            multipart.set('upload-1', {
                remoteKey: job.remoteKey,
                size: (job as typeof job & { size: number }).size,
                contentSha256: job.contentSha256,
            })
            return { remoteKey: job.remoteKey, uploadId: 'upload-1' }
        }),
        uploadPart: vi.fn(async (_profile, input) => ({ partNumber: input.partNumber, etag: `etag-${input.partNumber}`, size: input.length })),
        completeMultipart: vi.fn(async (_profile, input) => {
            const completed = multipart.get(input.uploadId)
            if (completed) objects.set(completed.remoteKey, { size: completed.size, contentSha256: completed.contentSha256 })
            return { remoteKey: input.remoteKey, uploaded: true, skippedSame: false, etag: 'complete-etag' }
        }),
        abortMultipart: vi.fn(async () => undefined),
        ...overrides,
    }
}

describe('R2 upload repository and coordinator', () => {
    it('migrates v1 jobs losslessly as historical legacy contracts', async () => {
        const factory = new IDBFactory()
        const databaseName = `r2-v1-migration-${++databaseCounter}`
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = factory.open(databaseName, 1)
            request.onupgradeneeded = () => {
                request.result.createObjectStore('profiles', { keyPath: 'id' })
                const jobs = request.result.createObjectStore('jobs', { keyPath: 'id' })
                jobs.createIndex('by-state-ready', ['state', 'nextAttemptAt', 'createdAt', 'id'])
                jobs.createIndex('by-profile', ['profileId', 'createdAt', 'id'])
                jobs.createIndex('by-dedupe', 'dedupeKey', { unique: true })
                const manifest = request.result.createObjectStore('manifest', { keyPath: 'id' })
                manifest.createIndex('by-profile', ['profileId', 'remoteKey'])
            }
            request.onsuccess = () => resolve(request.result as unknown as IDBDatabase)
            request.onerror = () => reject(request.error)
        })
        const legacy = createUploadJob(profile().id, artifact(91), { id: 'legacy-succeeded', now: NOW })
        const {
            contractVersion: _contract,
            profileSnapshot: _profile,
            artifactBinding: _binding,
            linkExpectedArtifactVersion: _linkVersion,
            remoteRef: _remote,
            ...v1
        } = legacy
        const transaction = database.transaction('jobs', 'readwrite')
        transaction.objectStore('jobs').put({ ...v1, state: 'succeeded', dedupeKey: 'legacy-dedupe' })
        await new Promise<void>((resolve, reject) => {
            transaction.oncomplete = () => resolve()
            transaction.onerror = () => reject(transaction.error)
        })
        database.close()

        const repo = new IndexedDBR2UploadRepository({
            factory: factory as unknown as globalThis.IDBFactory,
            keyRange: IDBKeyRange as unknown as typeof globalThis.IDBKeyRange,
            databaseName,
        })
        await expect(repo.getJob(legacy.id)).resolves.toMatchObject({
            state: 'succeeded',
            contractVersion: 'legacy-v1',
            profileSnapshot: null,
            artifactBinding: null,
            linkExpectedArtifactVersion: null,
            remoteRef: null,
            dedupeKey: ['legacy-v1', legacy.profileId, '', legacy.artifactId, legacy.localVariant, legacy.remoteKey, legacy.contentSha256].join('\u001f'),
        })
    })

    it('deduplicates legacy and Phase 7 jobs by their full durable contracts', async () => {
        const repo = repository('contract-dedupe')
        const scanned = artifact(92)
        const legacy = createUploadJob(profile().id, scanned, { id: 'legacy-contract', now: NOW })
        const phase = createUploadJob(profile().id, scanned, {
            id: 'phase-contract', now: NOW, profileSnapshot: profile(),
            artifactBinding: { artifactId: scanned.artifactId, artifactVersion: 1, localVariant: 'original' },
        })
        const changedProfile = { ...profile(), bucket: 'changed-bucket' }
        const changed = createUploadJob(changedProfile.id, scanned, {
            id: 'phase-changed-profile', now: NOW, profileSnapshot: changedProfile,
            artifactBinding: { artifactId: scanned.artifactId, artifactVersion: 1, localVariant: 'original' },
        })
        await expect(repo.enqueue([legacy, phase, changed])).resolves.toHaveLength(3)
        await expect(repo.listJobs(profile().id)).resolves.toHaveLength(3)
    })

    it('enforces the Phase 7 state graph and immutable exact linkage facts in the repository', async () => {
        const repo = repository('phase7-transition-authority')
        const scanned = artifact(93)
        const initial = createUploadJob(profile().id, scanned, {
            id: 'phase7-transition-authority', now: NOW, profileSnapshot: profile(),
            artifactBinding: { artifactId: scanned.artifactId, artifactVersion: 1, localVariant: 'original' },
        })
        const [queued] = await repo.enqueue([initial])
        const remoteRef = {
            contractVersion: 'phase7-v1' as const,
            profileId: profile().id,
            profileHash: hashR2ProfileV2(profile()),
            bucket: profile().bucket,
            uploadJobId: queued.id,
            artifactId: queued.artifactId,
            variantId: 'original' as const,
            remoteKey: queued.remoteKey,
            contentSha256: queued.contentSha256,
            size: queued.size,
            verifiedAt: NOW,
        }
        await expect(repo.updateJob(queued.id, queued.version, { state: 'succeeded' }, NOW))
            .rejects.toMatchObject({ code: 'E_R2_VERSION_CONFLICT' })
        await expect(repo.updateJob(queued.id, queued.version, { remoteKey: 'exports/bypass.png' }, NOW))
            .rejects.toMatchObject({ code: 'E_R2_RECORD_INVALID' })
        await expect(repo.updateJob(queued.id, queued.version, { remoteRef }, NOW))
            .rejects.toMatchObject({ code: 'E_R2_RECORD_INVALID' })
        await expect(repo.updateJob(queued.id, queued.version, { linkExpectedArtifactVersion: 2 }, NOW))
            .rejects.toMatchObject({ code: 'E_R2_RECORD_INVALID' })

        const running = await repo.updateJob(queued.id, queued.version, { state: 'running' }, NOW)
        const uploaded = await repo.updateJob(running.id, running.version, { state: 'uploaded' }, NOW)
        const verifying = await repo.updateJob(uploaded.id, uploaded.version, { state: 'verifying' }, NOW)
        await expect(repo.updateJob(verifying.id, verifying.version, {
            state: 'verified', remoteRef: { ...remoteRef, profileId: 'different-profile' },
        }, NOW)).rejects.toMatchObject({ code: 'E_R2_RECORD_INVALID' })
        await expect(repo.updateJob(verifying.id, verifying.version, {
            state: 'verified', remoteRef: { ...remoteRef, verifiedAt: 'not-a-timestamp' },
        }, NOW)).rejects.toMatchObject({ code: 'E_R2_RECORD_INVALID' })
        const verified = await repo.updateJob(verifying.id, verifying.version, { state: 'verified', remoteRef }, NOW)
        await expect(repo.updateJob(verified.id, verified.version, {
            remoteRef: { ...remoteRef, remoteKey: 'exports/replaced.png' },
        }, NOW)).rejects.toMatchObject({ code: 'E_R2_RECORD_INVALID' })
        await expect(repo.updateJob(verified.id, verified.version, { linkExpectedArtifactVersion: 2 }, NOW))
            .rejects.toMatchObject({ code: 'E_R2_RECORD_INVALID' })
        const linking = await repo.updateJob(verified.id, verified.version, { state: 'linking' }, NOW)
        await expect(repo.updateJob(linking.id, linking.version, { state: 'succeeded' }, NOW))
            .rejects.toMatchObject({ code: 'E_R2_VERSION_CONFLICT' })
        const recoveredCursor = await repo.updateJob(linking.id, linking.version, { linkExpectedArtifactVersion: 2 }, NOW)
        expect(recoveredCursor.state).toBe('linking')
        await expect(new R2UploadCoordinator(repo, adapter(), () => new Date(NOW)).cancel(profile(), recoveredCursor.id))
            .rejects.toMatchObject({ code: 'E_R2_VERSION_CONFLICT' })
        await expect(repo.getJob(recoveredCursor.id)).resolves.toMatchObject({ state: 'linking', version: recoveredCursor.version })
    })

    it('requires exact Organizer readback before atomic Phase 7 success', async () => {
        const artifactRepo = new IndexedDBArtifactRepository({
            factory: new IDBFactory() as unknown as globalThis.IDBFactory,
            keyRange: IDBKeyRange as unknown as typeof globalThis.IDBKeyRange,
            databaseName: `artifact-terminal-authority-${++databaseCounter}`,
        })
        const repo = repository('phase7-terminal-authority', artifactRepo)
        const scanned = artifact(96)
        const original = await artifactRepo.putOriginal({
            artifactId: scanned.artifactId,
            file: { directory: { kind: 'standard', root: 'app-data', segments: ['nai-blue', 'outputs'] }, fileName: 'image-96.png' },
            format: 'png', contentChecksum: scanned.contentSha256, size: scanned.size, createdAt: NOW,
        })
        const queued = createUploadJob(profile().id, scanned, {
            id: 'phase7-terminal-authority', now: NOW, profileSnapshot: profile(),
            artifactBinding: { artifactId: scanned.artifactId, artifactVersion: original.version, localVariant: 'original' },
        })
        const [stored] = await repo.enqueue([queued])
        const running = await repo.updateJob(stored.id, stored.version, { state: 'running' }, NOW)
        const uploaded = await repo.updateJob(running.id, running.version, { state: 'uploaded' }, NOW)
        const verifying = await repo.updateJob(uploaded.id, uploaded.version, { state: 'verifying' }, NOW)
        const remoteRef = {
            contractVersion: 'phase7-v1' as const, profileId: profile().id, profileHash: hashR2ProfileV2(profile()),
            bucket: profile().bucket, uploadJobId: stored.id, artifactId: scanned.artifactId, variantId: 'original' as const,
            remoteKey: scanned.remoteKey, contentSha256: scanned.contentSha256, size: scanned.size, verifiedAt: NOW,
        }
        const verified = await repo.updateJob(verifying.id, verifying.version, { state: 'verified', remoteRef }, NOW)
        const linking = await repo.updateJob(verified.id, verified.version, { state: 'linking' }, NOW)
        const manifest = {
            profileId: profile().id, artifactId: scanned.artifactId, localVariant: scanned.localVariant,
            remoteKey: scanned.remoteKey, contentSha256: scanned.contentSha256, size: scanned.size, completedAt: NOW,
        }
        await expect(repo.succeedJobWithManifest(profile(), linking.id, linking.version, manifest, NOW))
            .rejects.toMatchObject({ code: 'E_R2_RECORD_INVALID' })
        await artifactRepo.replaceRemoteObjectRef(original.artifactId, original.version, {
            ...remoteRef, state: 'succeeded', updatedAt: NOW, failure: null,
        }, NOW)
        await expect(repo.succeedJobWithManifest(
            { ...profile(), bucket: 'wrong-current-bucket' }, linking.id, linking.version, manifest, NOW,
        )).rejects.toMatchObject({ code: 'E_R2_RECORD_INVALID' })
        await expect(repo.succeedJobWithManifest(profile(), linking.id, linking.version, manifest, NOW))
            .resolves.toMatchObject({ state: 'succeeded' })
    })

    it('persists only non-secret profiles and rejects credentials or signed URLs', async () => {
        const repo = repository('secret-safe')
        await expect(repo.putProfile(profile(), null)).resolves.toMatchObject({ credentialRef: 'r2-system-fixture' })
        await expect(repo.putProfile({
            ...profile({ id: 'unsafe' }),
            endpoint: `https://fixture.invalid?X-Amz-Signature=${'secret-canary'}`,
        }, null)).rejects.toMatchObject({ code: 'E_R2_RECORD_INVALID' })
        await expect(repo.putProfile({
            ...profile({ id: 'unsafe-field' }),
            accessKeyId: 'secret-canary',
        } as R2ProfileV2, null)).rejects.toBeInstanceOf(R2UploadRepositoryError)
        const unsafeJob = createUploadJob(profile().id, artifact(99), {
            profileSnapshot: { ...profile(), authorization: 'Bearer secret-canary' } as R2ProfileV2,
            artifactBinding: { artifactId: 'artifact:99', artifactVersion: 1, localVariant: 'original' },
        })
        await expect(repo.enqueue([unsafeJob])).rejects.toMatchObject({ code: 'E_R2_RECORD_INVALID' })
    })

    it('rejects externally constructed non-initial jobs at enqueue', async () => {
        const repo = repository('enqueue-initial-authority')
        const scanned = artifact(97)
        const initial = createUploadJob(profile().id, scanned, {
            id: 'phase7-enqueue-initial', now: NOW, profileSnapshot: profile(),
            artifactBinding: { artifactId: scanned.artifactId, artifactVersion: 1, localVariant: 'original' },
        })
        await expect(repo.enqueue([{ ...initial, state: 'running' }]))
            .rejects.toMatchObject({ code: 'E_R2_RECORD_INVALID' })
        await expect(repo.enqueue([{
            ...initial,
            state: 'succeeded',
            remoteRef: {
                contractVersion: 'phase7-v1', profileId: profile().id, profileHash: hashR2ProfileV2(profile()),
                bucket: profile().bucket, uploadJobId: initial.id, artifactId: scanned.artifactId, variantId: 'original',
                remoteKey: scanned.remoteKey, contentSha256: scanned.contentSha256, size: scanned.size, verifiedAt: NOW,
            },
        }])).rejects.toMatchObject({ code: 'E_R2_RECORD_INVALID' })
    })

    it('uses the immutable profile snapshot and links only after exact HEAD proof', async () => {
        const artifactFactory = new IDBFactory()
        const artifactRepo = new IndexedDBArtifactRepository({
            factory: artifactFactory as unknown as globalThis.IDBFactory,
            keyRange: IDBKeyRange as unknown as typeof globalThis.IDBKeyRange,
            databaseName: `artifact-phase7-${++databaseCounter}`,
        })
        const repo = repository('phase7-link', artifactRepo)
        const scanned = {
            ...artifact(12),
            artifactBinding: { artifactId: 'artifact:12', artifactVersion: 1, localVariant: 'original' as const },
        }
        await artifactRepo.putOriginal({
            artifactId: scanned.artifactId,
            file: { directory: { kind: 'standard', root: 'app-data', segments: ['nai-blue', 'outputs'] }, fileName: 'image-12.png' },
            format: 'png',
            contentChecksum: scanned.contentSha256,
            size: scanned.size,
            createdAt: NOW,
        })
        const capturedBuckets: string[] = []
        const capturedCredentialRefs: string[] = []
        let uploaded = false
        const fake = adapter({
            headObject: vi.fn(async () => uploaded
                ? { exists: true, size: scanned.size, contentSha256: scanned.contentSha256, etag: 'opaque' }
                : { exists: false, size: null, contentSha256: null, etag: null }),
            putObject: vi.fn(async (bound, job) => {
                capturedBuckets.push(bound.bucket)
                capturedCredentialRefs.push(bound.credentialRef)
                uploaded = true
                return { remoteKey: job.remoteKey, uploaded: true, skippedSame: false, etag: 'opaque' }
            }),
        })
        const originalProfile = profile()
        const coordinator = new R2UploadCoordinator(repo, fake, () => new Date(NOW), artifactRepo)
        await coordinator.enqueuePlan(await coordinator.plan(originalProfile, [scanned], 'full-sync'))
        const rotated = { ...originalProfile, bucket: 'rotated-bucket', credentialRef: 'rotated-ref' }
        await expect(coordinator.runUntilIdle(rotated)).resolves.toMatchObject({ succeeded: 1 })

        const [job] = await repo.listJobs(originalProfile.id)
        const linked = await artifactRepo.get(scanned.artifactId)
        expect(capturedBuckets).toEqual([originalProfile.bucket])
        expect(capturedCredentialRefs).toEqual([originalProfile.credentialRef])
        expect(job).toMatchObject({ state: 'succeeded', contractVersion: 'phase7-v1' })
        expect(linked?.remoteObjectRefs).toEqual([expect.objectContaining({
            contractVersion: 'phase7-v1',
            bucket: originalProfile.bucket,
            contentSha256: scanned.contentSha256,
            size: scanned.size,
        })])
    })

    it('uses conditional fail for the planned Phase 7 key and rejects transport key mutation', async () => {
        const repo = repository('phase7-exact-key')
        const scanned = artifact(15)
        const suffixProfile = profile({ conflictPolicy: 'suffix' })
        const job = createUploadJob(suffixProfile.id, scanned, {
            id: 'phase7-exact-key', now: NOW, profileSnapshot: suffixProfile,
            artifactBinding: { artifactId: scanned.artifactId, artifactVersion: 1, localVariant: 'original' },
        })
        await repo.enqueue([job])
        const fake = adapter({
            putObject: vi.fn(async (bound, current) => ({
                remoteKey: `${current.remoteKey}-unexpected`, uploaded: true, skippedSame: false, etag: bound.conflictPolicy,
            })),
        })
        const summary = await new R2UploadCoordinator(repo, fake, () => new Date(NOW)).runUntilIdle(suffixProfile)
        expect(fake.putObject).toHaveBeenCalledWith(expect.objectContaining({ conflictPolicy: 'fail' }), expect.anything())
        expect(summary.failed).toBe(1)
        expect((await repo.getJob(job.id))?.remoteKey).toBe(scanned.remoteKey)
    })

    it('previews a Phase 7 planned-key mismatch as conflict without proposing a suffix', async () => {
        const repo = repository('phase7-preview-exact-key')
        const suffixProfile = profile({ conflictPolicy: 'suffix' })
        const scanned = {
            ...artifact(98),
            artifactBinding: { artifactId: 'artifact:98', artifactVersion: 1, localVariant: 'original' as const },
        }
        const fake = adapter({
            headObject: vi.fn(async () => ({
                exists: true, size: scanned.size + 1, contentSha256: `sha256:${'f'.repeat(64)}`, etag: 'opaque',
            })),
        })
        const coordinator = new R2UploadCoordinator(repo, fake, () => new Date(NOW))
        const plan = await coordinator.plan(suffixProfile, [scanned], 'dry-run')
        await expect(coordinator.previewConflicts(suffixProfile, plan)).resolves.toMatchObject({
            conflicts: 1, suffixAvailable: 0,
        })
        expect(fake.headObject).toHaveBeenCalledTimes(1)
    })

    it('previews Phase 7 against its immutable profile snapshot after current-profile rotation', async () => {
        const repo = repository('phase7-preview-snapshot')
        const plannedProfile = profile({
            bucket: 'planned-bucket', prefix: 'planned-prefix', credentialRef: 'planned-credential',
        })
        const scanned = {
            ...artifact(99),
            artifactBinding: { artifactId: 'artifact:99', artifactVersion: 1, localVariant: 'original' as const },
        }
        const fake = adapter({
            headObject: vi.fn(async () => ({
                exists: true, size: scanned.size, contentSha256: scanned.contentSha256, etag: 'opaque',
            })),
        })
        const coordinator = new R2UploadCoordinator(repo, fake, () => new Date(NOW))
        const plan = await coordinator.plan(plannedProfile, [scanned], 'dry-run')
        const rotated = {
            ...plannedProfile,
            bucket: 'rotated-bucket', prefix: 'rotated-prefix', credentialRef: 'rotated-credential',
        }
        await expect(coordinator.previewConflicts(rotated, plan)).resolves.toMatchObject({
            alreadySame: 1, conflicts: 0,
        })
        expect(fake.headObject).toHaveBeenCalledWith(expect.objectContaining({
            bucket: 'planned-bucket', prefix: 'planned-prefix', credentialRef: 'planned-credential',
        }), scanned.remoteKey)
    })

    it('aborts an unexpected Phase 7 multipart key without rebinding the job', async () => {
        const repo = repository('phase7-multipart-exact-key')
        const scanned = artifact(16, 9 * 1024 * 1024)
        const job = createUploadJob(profile().id, scanned, {
            id: 'phase7-multipart-exact-key', now: NOW, profileSnapshot: profile(),
            artifactBinding: { artifactId: scanned.artifactId, artifactVersion: 1, localVariant: 'original' },
        })
        await repo.enqueue([job])
        const fake = adapter({
            createMultipart: vi.fn(async () => ({ remoteKey: 'exports/unexpected.png', uploadId: 'unexpected-upload' })),
        })
        await new R2UploadCoordinator(repo, fake, () => new Date(NOW)).runUntilIdle(profile())
        expect(fake.abortMultipart).toHaveBeenCalledWith(expect.objectContaining({ conflictPolicy: 'fail' }), {
            remoteKey: 'exports/unexpected.png', uploadId: 'unexpected-upload',
        })
        expect((await repo.getJob(job.id))?.remoteKey).toBe(scanned.remoteKey)
    })

    it('rejects an unexpected Phase 7 multipart completion key', async () => {
        const repo = repository('phase7-multipart-complete-key')
        const scanned = artifact(19, 9 * 1024 * 1024)
        const job = createUploadJob(profile().id, scanned, {
            id: 'phase7-multipart-complete-key', now: NOW, profileSnapshot: profile(),
            artifactBinding: { artifactId: scanned.artifactId, artifactVersion: 1, localVariant: 'original' },
        })
        await repo.enqueue([job])
        const fake = adapter({
            completeMultipart: vi.fn(async (bound) => ({
                remoteKey: 'exports/unexpected-complete.png', uploaded: true, skippedSame: false, etag: bound.conflictPolicy,
            })),
        })
        const summary = await new R2UploadCoordinator(repo, fake, () => new Date(NOW)).runUntilIdle(profile())
        expect(fake.completeMultipart).toHaveBeenCalledWith(expect.objectContaining({ conflictPolicy: 'fail' }), expect.anything())
        expect(summary.failed).toBe(1)
        expect((await repo.getJob(job.id))?.remoteKey).toBe(scanned.remoteKey)
    })

    it('does not let a legacy manifest skip a current Phase 7 linkage job in delta mode', async () => {
        const repo = repository('phase7-delta-linkage')
        const currentProfile = profile()
        const scanned = {
            ...artifact(17),
            artifactBinding: { artifactId: 'artifact:17', artifactVersion: 1, localVariant: 'original' as const },
        }
        await repo.putManifestItem(currentProfile, {
            profileId: currentProfile.id, artifactId: scanned.artifactId, localVariant: scanned.localVariant,
            remoteKey: scanned.remoteKey, contentSha256: scanned.contentSha256, size: scanned.size, completedAt: NOW,
        })
        const plan = await new R2UploadCoordinator(repo, adapter(), () => new Date(NOW)).plan(currentProfile, [scanned], 'delta')
        expect(plan.jobs).toHaveLength(1)
        expect(plan.jobs[0]?.contractVersion).toBe('phase7-v1')
    })

    it('does not abort completed Phase 7 multipart state during cancellation', async () => {
        const repo = repository('phase7-cancel-completed')
        const scanned = artifact(18, 9 * 1024 * 1024)
        const queued = createUploadJob(profile().id, scanned, {
            id: 'phase7-cancel-completed', now: NOW, profileSnapshot: profile(),
            artifactBinding: { artifactId: scanned.artifactId, artifactVersion: 1, localVariant: 'original' },
        })
        const [stored] = await repo.enqueue([queued])
        const running = await repo.updateJob(stored.id, stored.version, {
            state: 'running', multipart: { ...stored.multipart, uploadId: 'completed-upload' },
        }, NOW)
        await repo.updateJob(running.id, running.version, { state: 'uploaded' }, NOW)
        const fake = adapter()
        await new R2UploadCoordinator(repo, fake, () => new Date(NOW)).cancel(profile(), stored.id)
        expect(fake.abortMultipart).not.toHaveBeenCalled()
    })

    it('resumes from durable uploaded without a second PUT', async () => {
        const artifactRepo = new IndexedDBArtifactRepository({
            factory: new IDBFactory() as unknown as globalThis.IDBFactory,
            keyRange: IDBKeyRange as unknown as typeof globalThis.IDBKeyRange,
            databaseName: `artifact-uploaded-${++databaseCounter}`,
        })
        const repo = repository('phase7-uploaded-resume', artifactRepo)
        const scanned = artifact(13)
        const original = await artifactRepo.putOriginal({
            artifactId: scanned.artifactId,
            file: { directory: { kind: 'standard', root: 'app-data', segments: ['nai-blue', 'outputs'] }, fileName: 'image-13.png' },
            format: 'png', contentChecksum: scanned.contentSha256, size: scanned.size, createdAt: NOW,
        })
        const queued = createUploadJob(profile().id, scanned, {
            id: 'phase7-uploaded', now: NOW, profileSnapshot: profile(),
            artifactBinding: { artifactId: scanned.artifactId, artifactVersion: original.version, localVariant: 'original' },
        })
        const [stored] = await repo.enqueue([queued])
        const running = await repo.updateJob(stored.id, stored.version, { state: 'running', attempt: 1 }, NOW)
        await repo.updateJob(running.id, running.version, { state: 'uploaded' }, NOW)
        const fake = adapter({
            headObject: vi.fn(async () => ({
                exists: true, size: scanned.size, contentSha256: scanned.contentSha256, etag: scanned.contentSha256,
            })),
        })

        const summary = await new R2UploadCoordinator(repo, fake, () => new Date(NOW), artifactRepo).runUntilIdle(profile())
        expect(summary.succeeded).toBe(1)
        expect(fake.putObject).not.toHaveBeenCalled()
        expect((await artifactRepo.get(scanned.artifactId))?.remoteObjectRefs).toHaveLength(1)
    })

    it('keeps an Artifact CAS conflict resumable without re-uploading', async () => {
        const artifactRepo = new IndexedDBArtifactRepository({
            factory: new IDBFactory() as unknown as globalThis.IDBFactory,
            keyRange: IDBKeyRange as unknown as typeof globalThis.IDBKeyRange,
            databaseName: `artifact-cas-resume-${++databaseCounter}`,
        })
        const repo = repository('phase7-cas-resume', artifactRepo)
        const scanned = artifact(14)
        const original = await artifactRepo.putOriginal({
            artifactId: scanned.artifactId,
            file: { directory: { kind: 'standard', root: 'app-data', segments: ['nai-blue', 'outputs'] }, fileName: 'image-14.png' },
            format: 'png', contentChecksum: scanned.contentSha256, size: scanned.size, createdAt: NOW,
        })
        const job = createUploadJob(profile().id, scanned, {
            id: 'phase7-cas-resume', now: NOW, profileSnapshot: profile(),
            artifactBinding: { artifactId: scanned.artifactId, artifactVersion: original.version, localVariant: 'original' },
        })
        await repo.enqueue([job])
        await artifactRepo.addDistribution(scanned.artifactId, {
            variantId: 'unrelated', status: 'pending', file: null, requestedFileName: 'unrelated.png', format: 'png',
            contentChecksum: null, size: null, sidecar: null,
            policy: {
                destination: { kind: 'standard', root: 'app-data', segments: ['nai-blue', 'outputs'] },
                filenameTemplate: '{original.name}', collisionPolicy: 'unique', format: 'png', webpLossless: false,
                quality: 1, alphaPolicy: 'preserve', matteColor: '#ffffff', metadataPolicy: 'strip', r2FollowUp: null,
            },
            sanitizationPolicyVersion: 1, createdAt: NOW, updatedAt: NOW, failure: null,
        }, NOW)
        let uploaded = false
        const fake = adapter({
            headObject: vi.fn(async () => uploaded
                ? { exists: true, size: scanned.size, contentSha256: scanned.contentSha256, etag: 'opaque' }
                : { exists: false, size: null, contentSha256: null, etag: null }),
            putObject: vi.fn(async (_bound, current) => {
                uploaded = true
                return { remoteKey: current.remoteKey, uploaded: true, skippedSame: false, etag: 'opaque' }
            }),
        })
        let clock = new Date(NOW)
        const coordinator = new R2UploadCoordinator(repo, fake, () => clock, artifactRepo)
        await coordinator.runUntilIdle(profile())
        expect((await repo.getJob(job.id))?.state).toBe('linking')

        clock = new Date('2026-07-14T12:01:00.000Z')
        await expect(coordinator.runUntilIdle(profile())).resolves.toMatchObject({ succeeded: 1 })
        expect(fake.putObject).toHaveBeenCalledTimes(1)
    })

    it('fails a non-exact Artifact remote-link conflict instead of retrying linkage forever', async () => {
        const artifactRepo = new IndexedDBArtifactRepository({
            factory: new IDBFactory() as unknown as globalThis.IDBFactory,
            keyRange: IDBKeyRange as unknown as typeof globalThis.IDBKeyRange,
            databaseName: `artifact-semantic-conflict-${++databaseCounter}`,
        })
        const repo = repository('phase7-semantic-link-conflict', artifactRepo)
        const scanned = artifact(94)
        const original = await artifactRepo.putOriginal({
            artifactId: scanned.artifactId,
            file: { directory: { kind: 'standard', root: 'app-data', segments: ['nai-blue', 'outputs'] }, fileName: 'image-94.png' },
            format: 'png', contentChecksum: scanned.contentSha256, size: scanned.size, createdAt: NOW,
        })
        const linked = await artifactRepo.replaceRemoteObjectRef(original.artifactId, original.version, {
            contractVersion: 'phase7-v1', profileId: profile().id, profileHash: hashR2ProfileV2(profile()),
            bucket: profile().bucket, uploadJobId: 'older-upload', artifactId: original.artifactId, variantId: 'original',
            remoteKey: 'exports/older-key.png', contentSha256: scanned.contentSha256, size: scanned.size,
            verifiedAt: NOW, state: 'succeeded', updatedAt: NOW, failure: null,
        }, NOW)
        const job = createUploadJob(profile().id, scanned, {
            id: 'phase7-semantic-link-conflict', now: NOW, profileSnapshot: profile(),
            artifactBinding: { artifactId: scanned.artifactId, artifactVersion: linked.version, localVariant: 'original' },
        })
        await repo.enqueue([job])
        const fake = adapter({
            headObject: vi.fn(async () => ({
                exists: true, size: scanned.size, contentSha256: scanned.contentSha256, etag: 'opaque',
            })),
        })
        const summary = await new R2UploadCoordinator(repo, fake, () => new Date(NOW), artifactRepo).runUntilIdle(profile())
        expect(summary).toMatchObject({ failed: 1, queued: 0 })
        expect((await repo.getJob(job.id))?.state).toBe('failed')
        expect(fake.putObject).not.toHaveBeenCalled()
    })

    it('retries a transient Artifact database failure from linking without another PUT', async () => {
        const artifactRepo = new IndexedDBArtifactRepository({
            factory: new IDBFactory() as unknown as globalThis.IDBFactory,
            keyRange: IDBKeyRange as unknown as typeof globalThis.IDBKeyRange,
            databaseName: `artifact-transient-db-${++databaseCounter}`,
        })
        const repo = repository('phase7-transient-artifact-db', artifactRepo)
        const scanned = artifact(95)
        const original = await artifactRepo.putOriginal({
            artifactId: scanned.artifactId,
            file: { directory: { kind: 'standard', root: 'app-data', segments: ['nai-blue', 'outputs'] }, fileName: 'image-95.png' },
            format: 'png', contentChecksum: scanned.contentSha256, size: scanned.size, createdAt: NOW,
        })
        const job = createUploadJob(profile().id, scanned, {
            id: 'phase7-transient-artifact-db', now: NOW, profileSnapshot: profile(),
            artifactBinding: { artifactId: scanned.artifactId, artifactVersion: original.version, localVariant: 'original' },
        })
        await repo.enqueue([job])
        let uploaded = false
        const fake = adapter({
            headObject: vi.fn(async () => uploaded
                ? { exists: true, size: scanned.size, contentSha256: scanned.contentSha256, etag: 'opaque' }
                : { exists: false, size: null, contentSha256: null, etag: null }),
            putObject: vi.fn(async (_bound, current) => {
                uploaded = true
                return { remoteKey: current.remoteKey, uploaded: true, skippedSame: false, etag: 'opaque' }
            }),
        })
        let failOnce = true
        const transientArtifacts = {
            get: artifactRepo.get.bind(artifactRepo),
            replaceRemoteObjectRef: async (...args: Parameters<IndexedDBArtifactRepository['replaceRemoteObjectRef']>) => {
                if (failOnce) {
                    failOnce = false
                    throw new ArtifactRepositoryError('E_ARTIFACT_DB_UNAVAILABLE', 'Transient fixture.')
                }
                return artifactRepo.replaceRemoteObjectRef(...args)
            },
        }
        let clock = new Date(NOW)
        const coordinator = new R2UploadCoordinator(repo, fake, () => clock, transientArtifacts)
        await coordinator.runUntilIdle(profile())
        expect(await repo.getJob(job.id)).toMatchObject({
            state: 'linking', attempt: 1, nextAttemptAt: '2026-07-14T12:01:00.000Z',
        })
        clock = new Date('2026-07-14T12:01:00.000Z')
        await expect(coordinator.runUntilIdle(profile())).resolves.toMatchObject({ succeeded: 1 })
        expect(fake.putObject).toHaveBeenCalledTimes(1)
    })

    it('creates idempotently and updates only against the exact observed profile hash', async () => {
        const repo = repository('profile-cas')
        const created = await repo.putProfile(profile(), null)
        const retried = await repo.putProfile(profile({
            createdAt: '2026-07-15T12:00:00.000Z',
            updatedAt: '2026-07-15T12:00:00.000Z',
        }), null)
        expect(retried).toEqual(created)

        const observedHash = hashR2ProfileV2(created)
        const updated = await repo.putProfile({ ...created, bucket: 'updated-bucket', updatedAt: '2026-07-15T12:00:00.000Z' }, observedHash)
        expect(updated.bucket).toBe('updated-bucket')

        await expect(repo.putProfile({ ...created, bucket: 'stale-bucket' }, observedHash))
            .rejects.toMatchObject({ code: 'E_R2_VERSION_CONFLICT' })
        await expect(repo.putProfile({ ...created, bucket: 'create-collision' }, null))
            .rejects.toMatchObject({ code: 'E_R2_VERSION_CONFLICT' })
        await expect(repo.getProfile(created.id)).resolves.toEqual(updated)
        await expect(repo.putProfile(profile({ id: 'missing' }), observedHash))
            .rejects.toMatchObject({ code: 'E_R2_VERSION_CONFLICT' })
        await expect(repo.getProfile('missing')).resolves.toBeNull()
    })

    it('deduplicates completed objects through manifest v2 and idempotent enqueue', async () => {
        const repo = repository('manifest')
        const currentProfile = profile()
        await repo.putProfile(currentProfile, null)
        const coordinator = new R2UploadCoordinator(repo, adapter(), () => new Date(NOW))
        const first = await coordinator.plan(currentProfile, [artifact(1)], 'delta')
        const [job] = await coordinator.enqueuePlan(first)
        const duplicate = await coordinator.enqueuePlan(first)
        expect(duplicate[0].id).toBe(job.id)
        await coordinator.runUntilIdle(currentProfile)

        const second = await coordinator.plan(currentProfile, [artifact(1)], 'delta')
        expect(second.jobs).toHaveLength(0)
        expect(second.alreadyCompleted).toBe(1)
        await expect(coordinator.manifest(currentProfile)).resolves.toMatchObject({ schemaVersion: 2 })
    })

    it.each([
        ['size', { exists: true, size: 127, contentSha256: artifact(1).contentSha256, etag: artifact(1).contentSha256 }],
        ['digest', { exists: true, size: 128, contentSha256: `sha256:${'f'.repeat(64)}`, etag: artifact(1).contentSha256 }],
    ])('does not succeed or write manifest when HEAD has a %s mismatch', async (label, mismatched) => {
        const repo = repository(`head-${label}-mismatch`)
        const currentProfile = profile()
        let headCount = 0
        const fake = adapter({
            headObject: vi.fn(async () => {
                headCount += 1
                return headCount === 1
                    ? { exists: false, size: null, contentSha256: null, etag: null }
                    : mismatched
            }),
            putObject: vi.fn(async (_profile, job) => ({ remoteKey: job.remoteKey, uploaded: true, skippedSame: false, etag: 'opaque-etag' })),
        })
        const coordinator = new R2UploadCoordinator(repo, fake, () => new Date(NOW))
        await coordinator.enqueuePlan(await coordinator.plan(currentProfile, [artifact(1)], 'full-sync'))

        await expect(coordinator.runUntilIdle(currentProfile)).resolves.toMatchObject({ succeeded: 0, queued: 1 })
        await expect(repo.listJobs(currentProfile.id)).resolves.toEqual([expect.not.objectContaining({ state: 'succeeded' })])
        await expect(coordinator.manifest(currentProfile)).resolves.toMatchObject({ items: [] })
        expect(fake.putObject).toHaveBeenCalledTimes(1)
    })

    it('atomically reconciles an exact HEAD without a remote mutation', async () => {
        const repo = repository('head-exact-atomic')
        const currentProfile = profile()
        const expected = artifact(3)
        const fake = adapter({
            headObject: vi.fn(async () => ({
                exists: true,
                size: expected.size,
                contentSha256: expected.contentSha256,
                etag: 'not-a-checksum',
            })),
        })
        const coordinator = new R2UploadCoordinator(repo, fake, () => new Date(NOW))
        await coordinator.enqueuePlan(await coordinator.plan(currentProfile, [expected], 'full-sync'))

        await expect(coordinator.runUntilIdle(currentProfile)).resolves.toMatchObject({ succeeded: 1, failed: 0 })
        await expect(repo.listJobs(currentProfile.id)).resolves.toEqual([
            expect.objectContaining({ state: 'succeeded', contentSha256: expected.contentSha256 }),
        ])
        await expect(coordinator.manifest(currentProfile)).resolves.toMatchObject({
            items: [expect.objectContaining({ remoteKey: expected.remoteKey, contentSha256: expected.contentSha256 })],
        })
        expect(fake.putObject).not.toHaveBeenCalled()
        expect(fake.createMultipart).not.toHaveBeenCalled()
    })

    it('refuses atomic success while the authoritative job is queued', async () => {
        const repo = repository('atomic-requires-running')
        const currentProfile = profile()
        const queued = createUploadJob(currentProfile.id, artifact(11), { id: 'job:queued-atomic', now: NOW })
        const [stored] = await repo.enqueue([queued])

        await expect(repo.succeedJobWithManifest(currentProfile, stored.id, stored.version, {
            profileId: stored.profileId,
            artifactId: stored.artifactId,
            localVariant: stored.localVariant,
            remoteKey: stored.remoteKey,
            contentSha256: stored.contentSha256,
            size: stored.size,
            completedAt: NOW,
        }, NOW)).rejects.toMatchObject({ code: 'E_R2_VERSION_CONFLICT' })
        await expect(repo.listJobs(currentProfile.id)).resolves.toEqual([expect.objectContaining({ state: 'queued' })])
        await expect(repo.getManifest(currentProfile)).resolves.toMatchObject({ items: [] })
    })

    it('reconciles a recovered exact remote object without a second PUT', async () => {
        const repo = repository('recovered-exact')
        const currentProfile = profile()
        const queued = createUploadJob(currentProfile.id, artifact(4), { id: 'job:recovered-exact', now: NOW })
        const [stored] = await repo.enqueue([queued])
        await repo.updateJob(stored.id, stored.version, { state: 'running' }, NOW)
        await repo.recoverInterrupted(NOW)
        const fake = adapter({
            headObject: vi.fn(async () => ({
                exists: true,
                size: queued.size,
                contentSha256: queued.contentSha256,
                etag: 'opaque-etag',
            })),
        })

        await expect(new R2UploadCoordinator(repo, fake, () => new Date(NOW)).runUntilIdle(currentProfile))
            .resolves.toMatchObject({ succeeded: 1 })
        expect(fake.putObject).not.toHaveBeenCalled()
    })

    it('previews conditional conflicts without writing remote objects', async () => {
        const repo = repository('preview')
        const currentProfile = profile({ conflictPolicy: 'fail' })
        const fake = adapter({
            headObject: vi.fn(async () => ({ exists: true, size: 64, contentSha256: `sha256:${'b'.repeat(64)}`, etag: 'existing' })),
        })
        const coordinator = new R2UploadCoordinator(repo, fake, () => new Date(NOW))
        const plan = await coordinator.plan(currentProfile, [artifact(9)], 'dry-run')
        await expect(coordinator.previewConflicts(currentProfile, plan)).resolves.toMatchObject({
            examined: 1,
            conflicts: 1,
            overwrites: 0,
        })
        expect(fake.putObject).not.toHaveBeenCalled()
        expect(fake.createMultipart).not.toHaveBeenCalled()
    })

    it('resumes interrupted multipart from completed parts without starting over', async () => {
        const repo = repository('multipart-resume')
        const currentProfile = profile()
        await repo.putProfile(currentProfile, null)
        let failedOnce = false
        const fake = adapter({
            uploadPart: vi.fn(async (_profile, input) => {
                if (input.partNumber === 2 && !failedOnce) {
                    failedOnce = true
                    throw new NativeR2Error('E_R2_TRANSPORT', 'Typed interruption.', true, null)
                }
                return { partNumber: input.partNumber, etag: `etag-${input.partNumber}`, size: input.length }
            }),
        })
        let clock = new Date(NOW)
        const firstRuntime = new R2UploadCoordinator(repo, fake, () => clock)
        const multipartArtifact = artifact(2, 20 * 1024 * 1024)
        await firstRuntime.enqueuePlan(await firstRuntime.plan(currentProfile, [multipartArtifact], 'full-sync'))
        await firstRuntime.runUntilIdle(currentProfile)

        const interrupted = (await repo.listJobs(currentProfile.id))[0]
        expect(interrupted.state).toBe('queued')
        expect(interrupted.multipart.uploadId).toBe('upload-1')
        expect(interrupted.multipart.completedParts.map(part => part.partNumber)).toEqual([1])

        clock = new Date('2026-07-14T12:01:00.000Z')
        const restarted = new R2UploadCoordinator(repo, fake, () => clock)
        await restarted.recoverAfterRestart()
        const summary = await restarted.runUntilIdle(currentProfile)
        expect(summary.succeeded).toBe(1)
        expect(fake.createMultipart).toHaveBeenCalledTimes(1)
        expect(vi.mocked(fake.uploadPart).mock.calls.filter(call => call[1].partNumber === 1)).toHaveLength(1)
        expect(vi.mocked(fake.uploadPart).mock.calls.filter(call => call[1].partNumber === 2)).toHaveLength(2)
    })

    it('reconciles a lost multipart completion response as already complete', async () => {
        const repo = repository('multipart-complete-reconcile')
        const currentProfile = profile()
        const expected = artifact(5, 9 * 1024 * 1024)
        let headCount = 0
        const fake = adapter({
            headObject: vi.fn(async () => {
                headCount += 1
                return headCount === 1
                    ? { exists: false, size: null, contentSha256: null, etag: null }
                    : { exists: true, size: expected.size, contentSha256: expected.contentSha256, etag: 'opaque-etag' }
            }),
            completeMultipart: vi.fn(async () => {
                throw new NativeR2Error('E_R2_ALREADY_COMPLETE', 'Typed reconciliation.', false, null)
            }),
        })
        const coordinator = new R2UploadCoordinator(repo, fake, () => new Date(NOW))
        await coordinator.enqueuePlan(await coordinator.plan(currentProfile, [expected], 'full-sync'))
        await expect(coordinator.runUntilIdle(currentProfile)).resolves.toMatchObject({ succeeded: 1, failed: 0 })
        await expect(coordinator.manifest(currentProfile)).resolves.toMatchObject({
            items: [expect.objectContaining({ contentSha256: artifact(5).contentSha256 })],
        })
    })

    it('does not reconcile E_R2_ALREADY_COMPLETE when HEAD mismatches', async () => {
        const repo = repository('already-complete-mismatch')
        const currentProfile = profile()
        const fake = adapter({
            headObject: vi.fn(async () => ({ exists: true, size: 1, contentSha256: `sha256:${'f'.repeat(64)}`, etag: 'opaque-etag' })),
            completeMultipart: vi.fn(async () => {
                throw new NativeR2Error('E_R2_ALREADY_COMPLETE', 'Typed reconciliation.', false, null)
            }),
        })
        const coordinator = new R2UploadCoordinator(repo, fake, () => new Date(NOW))
        await coordinator.enqueuePlan(await coordinator.plan(currentProfile, [artifact(6, 9 * 1024 * 1024)], 'full-sync'))

        await expect(coordinator.runUntilIdle(currentProfile)).resolves.toMatchObject({ succeeded: 0, failed: 1 })
        await expect(coordinator.manifest(currentProfile)).resolves.toMatchObject({ items: [] })
    })

    it('requires exact HEAD proof after multipart completion', async () => {
        const repo = repository('multipart-head-proof')
        const currentProfile = profile()
        const fake = adapter({
            headObject: vi.fn(async () => ({ exists: false, size: null, contentSha256: null, etag: null })),
        })
        const coordinator = new R2UploadCoordinator(repo, fake, () => new Date(NOW))
        await coordinator.enqueuePlan(await coordinator.plan(currentProfile, [artifact(7, 9 * 1024 * 1024)], 'full-sync'))

        await expect(coordinator.runUntilIdle(currentProfile)).resolves.toMatchObject({ succeeded: 0, queued: 1 })
        await expect(coordinator.manifest(currentProfile)).resolves.toMatchObject({ items: [] })
        expect(fake.completeMultipart).toHaveBeenCalledTimes(1)
        expect(fake.headObject).toHaveBeenCalledTimes(2)
    })

    it('continues a 1,000-object batch after isolated non-retryable failures', async () => {
        const repo = repository('thousand')
        const currentProfile = profile()
        const headCalls = new Map<string, number>()
        const fake = adapter({
            headObject: vi.fn(async (_profile, remoteKey) => {
                const calls = (headCalls.get(remoteKey) ?? 0) + 1
                headCalls.set(remoteKey, calls)
                const index = Number(remoteKey.match(/(\d+)\.png$/)?.[1] ?? 0)
                return calls === 1 || index % 100 === 0
                    ? { exists: false, size: null, contentSha256: null, etag: null }
                    : { exists: true, size: 128, contentSha256: artifact(index).contentSha256, etag: `etag-${index}` }
            }),
            putObject: vi.fn(async (_profile, job) => {
                const index = Number(job.remoteKey.match(/(\d+)\.png$/)?.[1] ?? 0)
                if (index % 100 === 0) throw new NativeR2Error('E_R2_AUTH', 'Typed fixture failure.', false, 403)
                return { remoteKey: job.remoteKey, uploaded: true, skippedSame: false, etag: `etag-${index}` }
            }),
        })
        const coordinator = new R2UploadCoordinator(repo, fake, () => new Date(NOW))
        const artifacts = Array.from({ length: 1_000 }, (_, index) => artifact(index))
        await coordinator.enqueuePlan(await coordinator.plan(currentProfile, artifacts, 'full-sync'))
        const summary = await coordinator.runUntilIdle(currentProfile)
        expect(summary).toEqual({ succeeded: 990, failed: 10, queued: 0, cancelled: 0 })
        expect(fake.putObject).toHaveBeenCalledTimes(1_000)
    }, 30_000)

    it('honors cancellation that changes a job after the ready snapshot', async () => {
        const repo = repository('snapshot-cancel')
        const currentProfile = profile()
        const first = createUploadJob(currentProfile.id, artifact(1), { id: 'job:snapshot:first', now: NOW })
        const second = createUploadJob(currentProfile.id, artifact(2), { id: 'job:snapshot:second', now: NOW })
        let firstHeadCalls = 0
        const fake = adapter({
            headObject: vi.fn(async (_profile, remoteKey) => {
                if (remoteKey !== first.remoteKey) return { exists: false, size: null, contentSha256: null, etag: null }
                firstHeadCalls += 1
                return firstHeadCalls === 1
                    ? { exists: false, size: null, contentSha256: null, etag: null }
                    : { exists: true, size: first.size, contentSha256: first.contentSha256, etag: 'etag' }
            }),
            putObject: vi.fn(async (_profile, job) => {
                if (job.id === first.id) {
                    const target = await repo.getJob(second.id)
                    if (!target) throw new Error('Cancellation target was not found.')
                    await repo.updateJob(target.id, target.version, { state: 'cancelled' }, NOW)
                }
                return { remoteKey: job.remoteKey, uploaded: true, skippedSame: false, etag: 'etag' }
            }),
        })
        await repo.enqueue([first, second])

        const summary = await new R2UploadCoordinator(repo, fake, () => new Date(NOW)).runUntilIdle(currentProfile)

        expect(summary).toEqual({ succeeded: 1, failed: 0, queued: 0, cancelled: 1 })
        expect(fake.putObject).toHaveBeenCalledTimes(1)
    })

    it('never converts a conditional conflict into overwrite success', async () => {
        const repo = repository('conflict')
        const currentProfile = profile({ conflictPolicy: 'fail' })
        const fake = adapter({
            putObject: vi.fn(async () => {
                throw new NativeR2Error('E_R2_CONFLICT', 'Conditional create rejected.', false, 412)
            }),
        })
        const coordinator = new R2UploadCoordinator(repo, fake, () => new Date(NOW))
        const job = createUploadJob(currentProfile.id, {
            artifactId: 'artifact:conflict',
            localVariant: 'C:/fixture/conflict.png',
            remoteKey: 'exports/conflict.png',
            contentSha256: HASH,
            contentType: 'image/png',
            size: 128,
        }, { id: 'job:conflict', now: NOW })
        await repo.enqueue([job])
        const summary = await coordinator.runUntilIdle(currentProfile)
        expect(summary.failed).toBe(1)
        expect(fake.putObject).toHaveBeenCalledTimes(1)
        expect(fake.completeMultipart).not.toHaveBeenCalled()
    })

    it('aborts an active multipart before marking the job cancelled', async () => {
        const repo = repository('abort')
        const currentProfile = profile()
        const fake = adapter()
        const job = createUploadJob(currentProfile.id, artifact(8, 20 * 1024 * 1024), { id: 'job:abort', now: NOW })
        const [stored] = await repo.enqueue([job])
        const running = await repo.updateJob(stored.id, stored.version, {
            state: 'running',
            multipart: { ...stored.multipart, uploadId: 'upload-abort' },
        }, NOW)
        const coordinator = new R2UploadCoordinator(repo, fake, () => new Date(NOW))
        const cancelled = await coordinator.cancel(currentProfile, running.id)
        expect(fake.abortMultipart).toHaveBeenCalledWith(currentProfile, {
            remoteKey: running.remoteKey,
            uploadId: 'upload-abort',
        })
        expect(cancelled.state).toBe('cancelled')
    })
})
