import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'
import { createR2ProfileV2, hashR2ProfileV2, type PlannedR2DestinationSnapshot } from '@/domain/r2/types'
import type { GenerationJob } from '@/domain/queue/types'
import { sha256Bytes } from '@/lib/binary-digest'
import { IndexedDBArtifactRepository } from '@/services/organizer/artifact-repository'
import { createUploadJob, IndexedDBR2UploadRepository } from '@/services/r2/indexeddb-r2-upload-repository'
import { recoverQueueR2Release, type QueueR2ReleaseRecoveryDependencies } from '@/services/queue/queue-r2-release-recovery'

const provider = vi.hoisted(() => vi.fn())
vi.mock('@/services/generation/novelai-image-transport', () => ({ executeNovelAIImageTransport: provider }))
vi.mock('@/services/queue/main-job-snapshot-codec', () => ({
    decodeMainJobSnapshot: (snapshot: GenerationJob['snapshot']) => snapshot.parameters,
}))

const now = '2026-09-05T00:00:00.000Z'
const digest = `sha256:${'a'.repeat(64)}`
let serial = 0

async function fixture(privateMode = false) {
    const factory = new IDBFactory() as unknown as globalThis.IDBFactory
    const keyRange = IDBKeyRange as unknown as typeof globalThis.IDBKeyRange
    const artifacts = new IndexedDBArtifactRepository({ factory, keyRange, databaseName: `recovery-artifact-${++serial}` })
    const uploads = new IndexedDBR2UploadRepository({ factory, keyRange, databaseName: `recovery-upload-${serial}`, artifactReader: artifacts })
    const profile = createR2ProfileV2({
        id: 'profile', name: 'Profile', accountId: 'account', jurisdiction: null, endpoint: null,
        bucket: 'test-bucket', prefix: 'images', credentialRef: 'credential', transport: 'native-s3',
        conflictPolicy: 'fail', publicMode: privateMode ? 'private' : 'r2-dev', publicBaseUrl: null,
    }, now)
    const snapshot: PlannedR2DestinationSnapshot = {
        profile,
        credentialBinding: { credentialRef: profile.credentialRef },
        destination: {
            requirement: 'required', profileId: profile.id, profileHash: hashR2ProfileV2(profile),
            bucket: profile.bucket, key: 'images/output.png', conflictPolicy: 'fail', verification: 'head-metadata-sha256',
            provenance: { profileId: 'explicit-request', bucket: 'profile-snapshot', prefix: 'profile-snapshot', key: 'planned-output' },
        },
    }
    const sidecarBytes = new TextEncoder().encode('{"fixture":true}')
    await artifacts.putOriginal({
        artifactId: 'artifact', sourceJobId: 'generation-job', sourceSceneId: null,
        file: { directory: { kind: 'standard', root: 'app-data', segments: ['images'] }, fileName: 'output.png' },
        format: 'png', contentChecksum: digest, size: 3, createdAt: now,
        ...(privateMode ? { sidecar: {
            file: { directory: { kind: 'standard' as const, root: 'app-data' as const, segments: ['sidecars'] }, fileName: 'output.nai-blue.json' },
            digest: await sha256Bytes(sidecarBytes), size: sidecarBytes.length,
        } } : {}),
    })
    const job = {
        id: 'generation-job', workflow: 'main', artifactReference: { artifactId: 'artifact' },
        snapshot: { parameters: { mainWorkflow: { r2Delivery: { requirement: 'required', planned: snapshot } } } },
    } as unknown as GenerationJob
    const dependencies: QueueR2ReleaseRecoveryDependencies = {
        artifacts, uploads,
        platform: {
            resolveDirectory: vi.fn(async request => {
                const directory = request.portableDirectory
                const path = directory?.kind === 'standard' ? `E:/${directory.segments.join('/')}` : 'E:/unexpected'
                return { path, displayPath: path, capabilityFallbackUsed: false }
            }),
            readFile: vi.fn(async () => sidecarBytes),
        },
        release: {
            enqueue: vi.fn(async (planned, scanned) => uploads.enqueue(scanned.map((item, index) => createUploadJob(profile.id, item, {
                id: `attempt-${++serial}-${index}`, now, profileSnapshot: planned.profile, artifactBinding: item.artifactBinding,
            })))),
        },
    }
    return { job, dependencies, uploads, artifacts, snapshot }
}

describe('committed R2 delivery recovery', () => {
    it('reconciles enqueue failure, restart, and duplicate user recovery to one durable job without Provider dispatch', async () => {
        const { job, dependencies, uploads } = await fixture()
        const enqueue = vi.mocked(dependencies.release.enqueue)
        enqueue.mockRejectedValueOnce(new Error('repository temporarily unavailable'))
        await expect(recoverQueueR2Release(job, false, dependencies)).rejects.toThrow('temporarily unavailable')
        expect(await uploads.listJobs()).toHaveLength(0)
        const restarted = await recoverQueueR2Release(job, false, dependencies)
        const [first, second] = await Promise.all([
            recoverQueueR2Release(job, true, dependencies), recoverQueueR2Release(job, true, dependencies),
        ])
        expect(first?.jobIds).toEqual(restarted?.jobIds)
        expect(second?.jobIds).toEqual(restarted?.jobIds)
        expect(await uploads.listJobs()).toHaveLength(1)
        expect(provider).not.toHaveBeenCalled()
    })

    it('leaves failures stopped on startup and explicitly resumes the same failed upload with CAS', async () => {
        const { job, dependencies, uploads } = await fixture()
        await recoverQueueR2Release(job, false, dependencies)
        const initial = (await uploads.listJobs())[0]!
        const running = await uploads.updateJob(initial.id, initial.version, { state: 'running' }, now)
        const failed = await uploads.updateJob(initial.id, running.version, { state: 'failed' }, now)
        await recoverQueueR2Release(job, false, dependencies)
        expect((await uploads.getJob(initial.id))?.state).toBe('failed')
        await recoverQueueR2Release(job, true, dependencies)
        expect(await uploads.getJob(initial.id)).toMatchObject({ state: 'queued', attempt: 0, profileSnapshot: initial.profileSnapshot })
        await expect(uploads.resumeFailedJob(initial.id, failed.version, now)).rejects.toMatchObject({ code: 'E_R2_VERSION_CONFLICT' })
        expect(await uploads.listJobs()).toHaveLength(1)
        expect(provider).not.toHaveBeenCalled()
    })

    it('resumes verified proof directly at linkage and refuses cancelled jobs', async () => {
        const { job, dependencies, uploads, snapshot } = await fixture()
        await recoverQueueR2Release(job, false, dependencies)
        let upload = (await uploads.listJobs())[0]!
        upload = await uploads.updateJob(upload.id, upload.version, { state: 'running' }, now)
        upload = await uploads.updateJob(upload.id, upload.version, { state: 'uploaded' }, now)
        upload = await uploads.updateJob(upload.id, upload.version, { state: 'verifying' }, now)
        upload = await uploads.updateJob(upload.id, upload.version, { state: 'verified', remoteRef: {
            contractVersion: 'phase7-v1', profileId: upload.profileId, profileHash: snapshot.destination.profileHash,
            bucket: snapshot.destination.bucket, uploadJobId: upload.id, artifactId: upload.artifactId,
            variantId: 'original', remoteKey: upload.remoteKey, contentSha256: upload.contentSha256, size: upload.size, verifiedAt: now,
        } }, now)
        const proof = upload.remoteRef
        upload = await uploads.updateJob(upload.id, upload.version, { state: 'linking' }, now)
        upload = await uploads.updateJob(upload.id, upload.version, { state: 'failed' }, now)
        await recoverQueueR2Release(job, true, dependencies)
        upload = (await uploads.getJob(upload.id))!
        expect(upload).toMatchObject({ state: 'linking', remoteRef: proof })
        const cancelledFixture = await fixture()
        await recoverQueueR2Release(cancelledFixture.job, false, cancelledFixture.dependencies)
        const queued = (await cancelledFixture.uploads.listJobs())[0]!
        const cancelled = await cancelledFixture.uploads.updateJob(queued.id, queued.version, { state: 'cancelled' }, now)
        await expect(cancelledFixture.uploads.resumeFailedJob(cancelled.id, cancelled.version, now)).rejects.toThrow()
        expect(provider).not.toHaveBeenCalled()
    })

    it('reads private sidecar from its own committed directory and rejects changed bytes', async () => {
        const { job, dependencies, uploads } = await fixture(true)
        await recoverQueueR2Release(job, false, dependencies)
        expect(dependencies.platform.readFile).toHaveBeenCalledWith(expect.objectContaining({ displayPath: 'E:/sidecars/output.nai-blue.json' }))
        expect(await uploads.listJobs()).toHaveLength(2)
        vi.mocked(dependencies.platform.readFile).mockResolvedValue(new Uint8Array([0]))
        await expect(recoverQueueR2Release(job, true, dependencies)).rejects.toThrow('committed bytes')
        expect(await uploads.listJobs()).toHaveLength(2)
    })
})
