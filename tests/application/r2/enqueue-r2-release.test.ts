import { describe, expect, it, vi } from 'vitest'

import { enqueueR2Release } from '@/application/r2/enqueue-r2-release'
import { createArtifactRecord } from '@/domain/organizer/types'
import { createR2ProfileV2, hashR2ProfileV2, type PlannedR2DestinationSnapshot } from '@/domain/r2/types'

const NOW = '2026-09-04T00:00:00.000Z'
const profile = createR2ProfileV2({
    id: 'private-profile', name: 'Private', accountId: 'account', jurisdiction: null, endpoint: null,
    bucket: 'private-bucket', prefix: 'images', credentialRef: 'stronghold:r2', transport: 'native-s3',
    conflictPolicy: 'fail', publicMode: 'private', publicBaseUrl: null,
}, NOW)
const snapshot: PlannedR2DestinationSnapshot = {
    destination: {
        requirement: 'best-effort', profileId: profile.id, profileHash: hashR2ProfileV2(profile),
        bucket: profile.bucket, key: 'images/output.png', conflictPolicy: 'fail',
        verification: 'head-metadata-sha256',
        provenance: { profileId: 'generation-folder', bucket: 'profile-snapshot', prefix: 'profile-snapshot', key: 'planned-output' },
    },
    profile,
    credentialBinding: { credentialRef: profile.credentialRef },
}

function artifact() {
    return createArtifactRecord({
        artifactId: 'artifact:job-1', sourceJobId: 'job-1',
        file: { directory: { kind: 'standard', root: 'app-data', segments: ['outputs'] }, fileName: 'output.png' },
        format: 'png', contentChecksum: `sha256:${'a'.repeat(64)}`, size: 3, createdAt: NOW,
    })
}

describe('enqueueR2Release', () => {
    it('rejects a destination that differs from its profile snapshot before enqueue', async () => {
        const port = { enqueue: vi.fn() }
        await expect(enqueueR2Release({
            snapshot: { ...snapshot, destination: { ...snapshot.destination, bucket: 'different-bucket' } },
            readiness: 'ready', artifact: artifact(), originalLocalPath: 'C:/output.png',
        }, port)).rejects.toThrow('immutable profile binding')
        expect(port.enqueue).not.toHaveBeenCalled()
    })

    it('creates zero jobs when delivery is disabled', async () => {
        const port = { enqueue: vi.fn() }
        const handle = await enqueueR2Release({
            snapshot: null, readiness: 'ready', artifact: artifact(), originalLocalPath: 'C:/output.png',
        }, port)
        expect(handle).toMatchObject({ status: 'not-required', jobIds: [] })
        expect(port.enqueue).not.toHaveBeenCalled()
    })

    it('queues original and private sidecar using the already committed Artifact version', async () => {
        const current = artifact()
        const bound = { ...current, sidecar: {
            file: { directory: current.original.file.directory, fileName: 'output.nai-blue.json' },
            digest: `sha256:${'b'.repeat(64)}`, size: 7,
        }, version: 2 }
        const port = {
            enqueue: vi.fn(async (_snapshot, jobs) => {
                return jobs.map((_, index) => ({ id: `r2-job-${index}` }))
            }),
        }
        const handle = await enqueueR2Release({
            snapshot, readiness: 'needs-attention', artifact: bound, originalLocalPath: 'C:/output.png',
            sidecar: {
                file: { directory: current.original.file.directory, fileName: 'output.nai-blue.json' },
                localPath: 'C:/output.nai-blue.json', digest: `sha256:${'b'.repeat(64)}`, size: 7,
            },
        }, port)

        expect(port.enqueue).toHaveBeenCalledTimes(1)
        expect(handle).toMatchObject({ status: 'needs-attention', jobIds: ['r2-job-0', 'r2-job-1'] })
        const jobs = port.enqueue.mock.calls[0][1]
        expect(jobs.map(job => ({ key: job.remoteKey, variant: job.artifactBinding?.localVariant, version: job.artifactBinding?.artifactVersion }))).toEqual([
            { key: 'images/output.png', variant: 'original', version: 2 },
            { key: 'images/output.nai-blue.json', variant: 'sidecar', version: 2 },
        ])
    })

    it.each(['missing-authority', 'missing-file', 'digest', 'size', 'locator'] as const)(
        'rejects %s without creating either private release job', async mismatch => {
            const current = artifact()
            const committed = {
                file: { directory: current.original.file.directory, fileName: 'output.nai-blue.json' },
                digest: `sha256:${'b'.repeat(64)}` as const, size: 7,
            }
            const sidecar = { ...committed, localPath: 'C:/output.nai-blue.json' }
            const port = { enqueue: vi.fn() }
            await expect(enqueueR2Release({
                snapshot, readiness: 'ready',
                artifact: { ...current, sidecar: mismatch === 'missing-authority' ? null : committed },
                originalLocalPath: 'C:/output.png',
                ...(mismatch === 'missing-file' ? {} : { sidecar: {
                    ...sidecar,
                    ...(mismatch === 'digest' ? { digest: `sha256:${'c'.repeat(64)}` as const } : {}),
                    ...(mismatch === 'size' ? { size: 8 } : {}),
                    ...(mismatch === 'locator' ? { file: { ...committed.file, fileName: 'other.json' } } : {}),
                } }),
            }, port)).rejects.toThrow(/sidecar/i)
            expect(port.enqueue).not.toHaveBeenCalled()
        },
    )
})
