import type { ArtifactPortableFileRef, ArtifactRecord } from '@/domain/organizer/types'
import type {
    NativeR2ScannedArtifact,
    PlannedR2DestinationSnapshot,
    UploadJob,
} from '@/domain/r2/types'

export interface DurableR2ReleaseHandle {
    readonly artifactId: string
    readonly jobIds: readonly string[]
    readonly status: 'not-required' | 'queued' | 'needs-attention'
}

export interface EnqueueR2ReleasePort {
    enqueue(
        snapshot: PlannedR2DestinationSnapshot,
        artifacts: readonly NativeR2ScannedArtifact[],
    ): Promise<readonly Pick<UploadJob, 'id'>[]>
}

export interface EnqueueR2ReleaseInput {
    readonly snapshot: PlannedR2DestinationSnapshot | null
    readonly readiness: 'ready' | 'needs-attention'
    readonly artifact: ArtifactRecord
    readonly originalLocalPath: string
    readonly sidecar?: {
        readonly file: ArtifactPortableFileRef
        readonly localPath: string
        readonly digest: `sha256:${string}`
        readonly size: number
    }
}

function sidecarKey(originalKey: string): string {
    return originalKey.replace(/\.[^./]+$/u, '.nai-blue.json')
}

/**
 * Depends on an immutable plan, committed Organizer record, and injected durable
 * queue port. Private sidecar authority must already share the original Artifact
 * commit lineage; this seam only persists exact delivery jobs and never performs I/O.
 */
export async function enqueueR2Release(
    input: EnqueueR2ReleaseInput,
    port: EnqueueR2ReleasePort,
): Promise<DurableR2ReleaseHandle> {
    if (input.snapshot === null) {
        return { artifactId: input.artifact.artifactId, jobIds: [], status: 'not-required' }
    }
    const destination = input.snapshot.destination
    const artifact = input.artifact
    if (input.snapshot.profile.publicMode === 'private') {
        if (input.sidecar === undefined) throw new TypeError('Private R2 release requires an exact sidecar binding')
        if (artifact.sidecar === null
            || artifact.sidecar.digest !== input.sidecar.digest
            || artifact.sidecar.size !== input.sidecar.size
            || JSON.stringify(artifact.sidecar.file) !== JSON.stringify(input.sidecar.file)) {
            throw new TypeError('Private R2 release sidecar differs from committed Artifact authority')
        }
    }
    const artifacts: NativeR2ScannedArtifact[] = [{
        artifactId: artifact.artifactId,
        localVariant: input.originalLocalPath,
        remoteKey: destination.key,
        contentSha256: artifact.original.contentChecksum,
        contentType: `image/${artifact.original.format}`,
        size: artifact.original.size,
        artifactBinding: {
            artifactId: artifact.artifactId,
            artifactVersion: artifact.version,
            localVariant: 'original',
        },
    }]
    if (input.snapshot.profile.publicMode === 'private' && input.sidecar !== undefined) {
        artifacts.push({
            artifactId: artifact.artifactId,
            localVariant: input.sidecar.localPath,
            remoteKey: sidecarKey(destination.key),
            contentSha256: input.sidecar.digest,
            contentType: 'application/json',
            size: input.sidecar.size,
            artifactBinding: {
                artifactId: artifact.artifactId,
                artifactVersion: artifact.version,
                localVariant: 'sidecar',
            },
        })
    }
    const jobs = await port.enqueue(input.snapshot, artifacts)
    return {
        artifactId: artifact.artifactId,
        jobIds: jobs.map(job => job.id),
        status: input.readiness === 'ready' ? 'queued' : 'needs-attention',
    }
}
