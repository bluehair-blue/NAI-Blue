import { enqueueR2Release, type DurableR2ReleaseHandle, type EnqueueR2ReleasePort } from '@/application/r2/enqueue-r2-release'
import type { GenerationJob } from '@/domain/queue/types'
import { sha256Bytes } from '@/lib/binary-digest'
import type { QueueArtifactRepository } from './queue-artifact-lineage'
import { childOutputRef, type OutputPlatformAdapter } from '@/services/output/platform-adapter'
import { createRuntimeOutputPlatformAdapter } from '@/services/output/tauri-output-adapter'
import { getRuntimeArtifactRepository } from '@/services/organizer/runtime'
import { getRuntimeR2UploadRepository } from '@/services/r2/runtime'
import type { IndexedDBR2UploadRepository } from '@/services/r2/indexeddb-r2-upload-repository'
import { getRuntimeMainQueueDependencies } from './main-queue-runtime-dependencies'
import { decodeMainJobSnapshot } from './main-job-snapshot-codec'
import { decodeSceneJobSnapshot } from './scene-job-snapshot-codec'

export interface QueueR2ReleaseRecoveryDependencies {
    readonly artifacts: Pick<QueueArtifactRepository, 'get'>
    readonly platform: Pick<OutputPlatformAdapter, 'resolveDirectory' | 'readFile'>
    readonly release: EnqueueR2ReleasePort
    readonly uploads: Pick<IndexedDBR2UploadRepository, 'getJob' | 'resumeFailedJob'>
}

/** Startup and user recovery share committed Artifact authority and the idempotent application enqueue seam. */
export async function recoverQueueR2Release(
    job: GenerationJob,
    retryFailed = false,
    dependencies: QueueR2ReleaseRecoveryDependencies = {
        artifacts: getRuntimeArtifactRepository(),
        platform: createRuntimeOutputPlatformAdapter(),
        release: getRuntimeMainQueueDependencies().r2Release,
        uploads: getRuntimeR2UploadRepository(),
    },
): Promise<DurableR2ReleaseHandle | null> {
    if (job.artifactReference === null) return null
    const delivery = job.workflow === 'main'
        ? decodeMainJobSnapshot(job.snapshot).mainWorkflow.r2Delivery
        : job.workflow === 'scene' ? decodeSceneJobSnapshot(job.snapshot).sceneWorkflow.r2Delivery : null
    if (!delivery?.planned) return null
    const artifact = await dependencies.artifacts.get(job.artifactReference.artifactId)
    if (artifact === null || artifact.sourceJobId !== job.id
        || artifact.artifactId !== job.artifactReference.artifactId
        || (job.snapshot.outputReservation?.reservationSchemaVersion === 1
            && artifact.outputCommitSetHash !== job.snapshot.outputReservation.commitSetHash)) {
        throw new TypeError('R2 recovery requires the committed job Artifact lineage')
    }
    const workflowDefaultDirectory = job.workflow === 'scene' ? 'NAI_Blue_Scene' : 'NAI_Blue_Output'
    const directory = await dependencies.platform.resolveDirectory({
        portableDirectory: artifact.original.file.directory, workflowDefaultDirectory,
    })
    let sidecar: Parameters<typeof enqueueR2Release>[0]['sidecar']
    if (delivery.planned.profile.publicMode === 'private') {
        if (artifact.sidecar === null) throw new TypeError('R2 recovery requires a committed sidecar')
        const sidecarDirectory = await dependencies.platform.resolveDirectory({
            portableDirectory: artifact.sidecar.file.directory, workflowDefaultDirectory,
        })
        const file = childOutputRef(sidecarDirectory, artifact.sidecar.file.fileName)
        const bytes = await dependencies.platform.readFile(file)
        if (bytes.byteLength !== artifact.sidecar.size || await sha256Bytes(bytes) !== artifact.sidecar.digest) {
            throw new TypeError('R2 recovery sidecar differs from committed bytes')
        }
        sidecar = {
            file: artifact.sidecar.file,
            digest: artifact.sidecar.digest as `sha256:${string}`,
            size: bytes.byteLength,
            localPath: file.displayPath,
        }
    }
    const handle = await enqueueR2Release({
        snapshot: delivery.planned, readiness: 'ready', artifact,
        originalLocalPath: childOutputRef(directory, artifact.original.file.fileName).displayPath,
        ...(sidecar === undefined ? {} : { sidecar }),
    }, dependencies.release)
    // Startup only reconciles missing jobs. A person explicitly retries failed delivery;
    // already queued/succeeded jobs and intentionally cancelled jobs remain untouched.
    if (retryFailed) {
        for (const id of handle.jobIds) {
            const upload = await dependencies.uploads.getJob(id)
            if (upload?.state === 'cancelled') throw new TypeError('Cancelled R2 delivery cannot be resumed')
            if (upload?.state === 'failed') await dependencies.uploads.resumeFailedJob(id, upload.version)
        }
    }
    return handle
}
