import type { PortablePathRef } from '@/domain/composition/types'
import type { ArtifactRecord, ArtifactSidecarReference, OrganizerSourceImageFormat } from '@/domain/organizer/types'
import type { GenerationJob, QueueArtifactReference } from '@/domain/queue/types'
import type { OutputWriteResult } from '@/services/output/output-writer'
import {
    getRuntimeArtifactRepository,
} from '@/services/organizer/runtime'
import type {
    RemoveOriginalIfUnmodifiedInput,
} from '@/services/organizer/artifact-repository'
import { createRuntimeOutputPlatformAdapter } from '@/services/output/tauri-output-adapter'
import { sha256Bytes } from '@/lib/binary-digest'

export interface QueueArtifactRepository {
    get(artifactId: string): Promise<ArtifactRecord | null>
    putOriginal(input: {
        artifactId: string
        sourceJobId: string | null
        sourceSceneId: string | null
        outputCommitSetHash?: `sha256:${string}` | null
        file: { directory: PortablePathRef; fileName: string }
        format: OrganizerSourceImageFormat
        contentChecksum: string
        size: number
        sidecar?: ArtifactSidecarReference | null
        createdAt?: string
    }): Promise<ArtifactRecord>
    removeOriginalIfUnmodified(input: RemoveOriginalIfUnmodifiedInput): Promise<boolean>
}

export interface QueueArtifactRegistration {
    readonly record: ArtifactRecord
    /** Only this execution may remove a newly-created record during workflow rollback. */
    readonly created: boolean
}

export class QueueArtifactLineageError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'QueueArtifactLineageError'
    }
}

function outputFormat(reference: QueueArtifactReference, output: OutputWriteResult): OrganizerSourceImageFormat {
    const mimeType = reference.mimeType?.toLowerCase()
    if (mimeType === 'image/webp' || output.fileName.toLowerCase().endsWith('.webp')) return 'webp'
    if (mimeType === 'image/png' || output.fileName.toLowerCase().endsWith('.png')) return 'png'
    throw new QueueArtifactLineageError('Queue output format is not supported by Organizer artifact lineage.')
}

function matchesRegistration(
    existing: ArtifactRecord,
    job: GenerationJob,
    reference: QueueArtifactReference,
    output: OutputWriteResult,
    sidecar: ArtifactSidecarReference | null,
): boolean {
    const facts = output.finalImage
    if (facts?.portableDirectory === undefined) return false
    return existing.artifactId === reference.artifactId
        && existing.sourceJobId === job.id
        && existing.sourceSceneId === job.sceneId
        && existing.original.file.fileName === output.fileName
        && JSON.stringify(existing.original.file.directory) === JSON.stringify(facts.portableDirectory)
        && existing.original.format === outputFormat(reference, output)
        && existing.contentChecksum === facts.contentChecksum
        && existing.original.size === facts.byteSize
        && JSON.stringify(existing.sidecar) === JSON.stringify(sidecar)
        && (existing.outputCommitSetHash ?? null) === (output.outputCommitSetHash ?? null)
}

function assertQueueCommitSetLineage(job: GenerationJob, output: OutputWriteResult): `sha256:${string}` | null {
    const reservation = job.snapshot.outputReservation
    const expected = reservation?.reservationSchemaVersion === 1 ? reservation.commitSetHash : null
    if ((output.outputCommitSetHash ?? null) !== expected) {
        throw new QueueArtifactLineageError('Queue snapshot, output journal, and Artifact commit-set lineage differ.')
    }
    return expected
}

/**
 * Registers the immutable Organizer authority using OutputWriter's final file
 * facts. Queue transport digests are intentionally not used because metadata
 * embedding can change the bytes that the user later distributes.
 */
export async function registerQueueArtifact(
    job: GenerationJob,
    reference: QueueArtifactReference,
    output: OutputWriteResult,
    repository: QueueArtifactRepository = getRuntimeArtifactRepository(),
    bindPrivateSidecar = false,
): Promise<QueueArtifactRegistration | null> {
    const facts = output.finalImage
    // Legacy absolute output has no portable directory. Keep its successful
    // output path, but do not put an unsafe raw path into Artifact authority.
    if (facts === undefined || facts.portableDirectory === undefined) {
        if (job.snapshot?.outputReservation?.reservationSchemaVersion === 1) {
            throw new QueueArtifactLineageError('Current Queue output is missing portable Artifact lineage.')
        }
        return null
    }
    if (!Number.isSafeInteger(facts.byteSize) || facts.byteSize < 0) {
        throw new QueueArtifactLineageError('Queue output byte size is invalid.')
    }
    const outputCommitSetHash = assertQueueCommitSetLineage(job, output)
    let sidecar: ArtifactSidecarReference | null = null
    if (bindPrivateSidecar) {
        if (output.sidecarFile === undefined) {
            throw new QueueArtifactLineageError('Private Queue output is missing committed sidecar authority.')
        }
        const bytes = await createRuntimeOutputPlatformAdapter().readFile(output.sidecarFile)
        sidecar = {
            file: {
                directory: facts.portableDirectory,
                fileName: output.sidecarFile.displayPath.replace(/\\/gu, '/').split('/').pop() ?? '',
            },
            digest: await sha256Bytes(bytes),
            size: bytes.byteLength,
        }
    }
    const existing = await repository.get(reference.artifactId)
    if (existing !== null) {
        if (!matchesRegistration(existing, job, reference, output, sidecar)) {
            throw new QueueArtifactLineageError('Queue artifact identity is already bound to different output facts.')
        }
        return { record: existing, created: false }
    }
    const record = await repository.putOriginal({
        artifactId: reference.artifactId,
        sourceJobId: job.id,
        sourceSceneId: job.sceneId,
        outputCommitSetHash,
        file: { directory: facts.portableDirectory, fileName: output.fileName },
        format: outputFormat(reference, output),
        contentChecksum: facts.contentChecksum,
        size: facts.byteSize,
        sidecar,
    })
    if (!matchesRegistration(record, job, reference, output, sidecar)) {
        throw new QueueArtifactLineageError('Queue artifact registration did not preserve final output facts.')
    }
    return { record, created: true }
}

/** Queue workflow rollback may remove only the exact new, undistributed original. */
export async function rollbackQueueArtifactRegistration(
    registration: QueueArtifactRegistration | null,
    repository: QueueArtifactRepository = getRuntimeArtifactRepository(),
): Promise<boolean> {
    if (registration === null || !registration.created) return false
    return repository.removeOriginalIfUnmodified({
        artifactId: registration.record.artifactId,
        file: registration.record.original.file,
        contentChecksum: registration.record.contentChecksum,
        size: registration.record.original.size,
    })
}
