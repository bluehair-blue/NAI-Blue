import { recordIntentAssessment } from '@/application/assessment/record-intent-assessment'
import { IndexedDbIntentAssessmentRepository } from '@/adapters/assessment/indexeddb-intent-assessment-repository'
import { readQueueIntentAssessmentRun } from '@/adapters/assessment/queue-intent-assessment-reader'
import { getRuntimeQueueRepository } from '@/services/queue/indexeddb-queue-repository'
import { getRuntimeArtifactRepository } from '@/services/organizer/runtime'
import { assessPortablePath } from '@/platform/portable-resources'
import { runtimeCapabilities } from '@/platform/capabilities'
import { runtimePortableResourceByteReader } from '@/platform/tauri-portable-resource-reader'

export const LOCAL_ASSESSMENT_ACTOR_ID = 'local-ui:user'

/** Local composition root only. External Agent commands never receive the human write port. */
export function getRuntimeIntentAssessmentRun(runId: string) {
    return readQueueIntentAssessmentRun(runId, {
        queue: getRuntimeQueueRepository(), artifacts: getRuntimeArtifactRepository(),
        assessments: new IndexedDbIntentAssessmentRepository(),
    })
}

export function recordRuntimeHumanIntentAssessment(input: unknown) {
    return recordIntentAssessment(input, { kind: 'user', id: LOCAL_ASSESSMENT_ACTOR_ID }, {
        repository: new IndexedDbIntentAssessmentRepository(),
        readRun: getRuntimeIntentAssessmentRun,
    })
}

/** Private local preview: the caller supplies an Artifact ID, never an arbitrary filesystem path. */
export async function getRuntimeAssessmentPreview(artifactId: string): Promise<{ url: string; dispose(): void }> {
    const artifact = await getRuntimeArtifactRepository().get(artifactId)
    if (artifact === null) throw new Error('Assessment image is unavailable.')
    const { directory, fileName } = artifact.original.file
    const resolved = assessPortablePath({ ...directory, segments: [...directory.segments, fileName] }, runtimeCapabilities)
    if (resolved.status !== 'resolved') throw new Error('Grant access to the original output folder to review this image.')
    const bytes = await runtimePortableResourceByteReader.read(resolved.materialized)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))
    const checksum = `sha256:${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`
    if (bytes.byteLength !== artifact.original.size || checksum !== artifact.original.contentChecksum) {
        throw new Error('The image no longer matches its registered Artifact. Assessment preview was refused.')
    }
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: `image/${artifact.original.format}` }))
    return { url, dispose: () => URL.revokeObjectURL(url) }
}
