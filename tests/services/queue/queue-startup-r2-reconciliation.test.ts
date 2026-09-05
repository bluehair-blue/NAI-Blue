import { describe, expect, it, vi } from 'vitest'

import { createArtifactRecord } from '@/domain/organizer/types'
import { createR2ProfileV2, hashR2ProfileV2 } from '@/domain/r2/types'

const mocks = vi.hoisted(() => ({ enqueue: vi.fn(), getArtifact: vi.fn(), getUpload: vi.fn(), resumeFailedJob: vi.fn() }))

vi.mock('@/services/queue/main-job-snapshot-codec', () => ({
    decodeMainJobSnapshot: (snapshot: { parameters: unknown }) => snapshot.parameters,
}))
vi.mock('@/services/queue/scene-job-snapshot-codec', () => ({ decodeSceneJobSnapshot: vi.fn() }))
vi.mock('@/services/output/tauri-output-adapter', () => ({
    createRuntimeOutputPlatformAdapter: () => ({
        resolveDirectory: vi.fn(async () => ({ path: 'C:/outputs', displayPath: 'C:/outputs' })),
        readFile: vi.fn(),
    }),
}))
vi.mock('@/services/organizer/runtime', () => ({
    getRuntimeArtifactRepository: () => ({ get: mocks.getArtifact }),
}))
vi.mock('@/services/r2/runtime', () => ({
    getRuntimeR2UploadRepository: () => ({ getJob: mocks.getUpload, resumeFailedJob: mocks.resumeFailedJob }),
}))
vi.mock('@/services/queue/main-queue-runtime-dependencies', () => ({
    getRuntimeMainQueueDependencies: () => ({
        r2Release: { enqueue: mocks.enqueue },
    }),
}))

import { reconcileR2ReleaseJobs } from '@/services/queue/queue-startup'

describe('startup R2 reconciliation', () => {
    it('recreates a missing durable job from committed Artifact authority without Provider work', async () => {
        const profile = createR2ProfileV2({
            id: 'startup-profile', name: 'Startup', accountId: 'account', jurisdiction: null, endpoint: null,
            bucket: 'startup-bucket', prefix: 'images', credentialRef: 'stronghold:r2', transport: 'native-s3',
            conflictPolicy: 'fail', publicMode: 'r2-dev', publicBaseUrl: null,
        }, '2026-09-04T00:00:00.000Z')
        const planned = {
            destination: {
                requirement: 'best-effort' as const, profileId: profile.id, profileHash: hashR2ProfileV2(profile),
                bucket: profile.bucket, key: 'images/output.png', conflictPolicy: 'fail' as const,
                verification: 'head-metadata-sha256' as const,
                provenance: { profileId: 'generation-folder' as const, bucket: 'profile-snapshot' as const, prefix: 'profile-snapshot' as const, key: 'planned-output' as const },
            },
            profile,
            credentialBinding: { credentialRef: profile.credentialRef },
        }
        const artifact = createArtifactRecord({
            artifactId: 'artifact:startup-job', sourceJobId: 'startup-job',
            file: { directory: { kind: 'standard', root: 'app-data', segments: ['outputs'] }, fileName: 'output.png' },
            format: 'png', contentChecksum: `sha256:${'a'.repeat(64)}`, size: 3,
        })
        mocks.getArtifact.mockResolvedValue(artifact)
        mocks.enqueue.mockResolvedValue([{ id: 'r2-startup-job' }])
        const repository = {
            listJobs: vi.fn(async () => ({
                items: [{
                    id: 'startup-job', workflow: 'main', artifactReference: { artifactId: artifact.artifactId },
                    snapshot: { parameters: { mainWorkflow: { r2Delivery: { requirement: 'best-effort', planned } } } },
                }],
                nextCursor: null,
            })),
        }

        await expect(reconcileR2ReleaseJobs(repository as never)).resolves.toBe(1)
        expect(mocks.enqueue).toHaveBeenCalledWith(planned, [expect.objectContaining({
            artifactId: artifact.artifactId,
            artifactBinding: { artifactId: artifact.artifactId, artifactVersion: artifact.version, localVariant: 'original' },
        })])
        expect(mocks.resumeFailedJob).not.toHaveBeenCalled()
    })
})
