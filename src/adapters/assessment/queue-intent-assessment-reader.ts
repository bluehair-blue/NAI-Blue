import { canonicalSerialize } from '@/domain/composition/canonical-serialize'
import {
    projectRunAcceptance,
    parseIntentAssessmentRunBinding,
    type IntentAssessmentEvent,
    type IntentAssessmentRunBinding,
    type RunAcceptanceProjection,
} from '@/domain/assessment/intent-assessment'
import type { IntentAssessmentRepository } from '@/application/assessment/intent-assessment-repository'
import type { GenerationJob } from '@/domain/queue/types'
import type { IndexedDBQueueRepository } from '@/services/queue/indexeddb-queue-repository'
import type { IndexedDBArtifactRepository } from '@/services/organizer/artifact-repository'

export interface IntentAssessmentRunView {
    readonly binding: IntentAssessmentRunBinding
    readonly candidateArtifactIds: readonly string[]
    readonly events: readonly IntentAssessmentEvent[]
    readonly projection: RunAcceptanceProjection
}

interface AssessmentAuthorities {
    readonly queue: Pick<IndexedDBQueueRepository, 'listJobs'>
    readonly artifacts: Pick<IndexedDBArtifactRepository, 'get'>
    readonly assessments: IntentAssessmentRepository
}

async function listJobs(queue: AssessmentAuthorities['queue'], batchId?: string): Promise<GenerationJob[]> {
    const jobs: GenerationJob[] = []
    let cursor: string | null = null
    do {
        const page = await queue.listJobs({ ...(batchId === undefined ? {} : { batchId }), cursor, limit: 1_000 })
        jobs.push(...page.items)
        cursor = page.nextCursor
    } while (cursor !== null)
    return jobs
}

/** Joins immutable Queue plans and registered Artifact lineage; no preference or UI state is an authority. */
export async function readQueueIntentAssessmentRun(
    runId: string,
    authorities: AssessmentAuthorities,
    batchJobs?: readonly GenerationJob[],
): Promise<IntentAssessmentRunView | null> {
    const selected = batchJobs ?? await listJobs(authorities.queue, runId)
    const first = selected.find(job => job.snapshot.intentAssessment !== undefined)?.snapshot.intentAssessment
    if (first === undefined) return null // Existing jobs keep their original, unassessed contract.
    const binding = parseIntentAssessmentRunBinding(first)
    const identity = canonicalSerialize(binding)
    if (selected.some(job => canonicalSerialize(job.snapshot.intentAssessment ?? null) !== identity)) {
        throw new TypeError('The run has conflicting assessment plans.')
    }

    // ponytail: on-demand lineage scan; add a run index if Queue history makes this read measurably slow.
    const all = await listJobs(authorities.queue)
    const byId = new Map(all.map(job => [job.id, job]))
    const roots = all.filter(job => job.batchId === binding.runId && job.retryOfJobId === null)
    if (roots.length === 0 || binding.requirement.requiredAcceptedCount > roots.length
        || roots.some(job => canonicalSerialize(job.snapshot.intentAssessment ?? null) !== identity)) {
        throw new TypeError('The original assessment plan is unavailable or inconsistent.')
    }
    const rootIds = new Set(roots.map(job => job.id))
    const belongsToRun = (job: GenerationJob): boolean => {
        const visited = new Set<string>()
        let current: GenerationJob | undefined = job
        while (current !== undefined && !visited.has(current.id)) {
            visited.add(current.id)
            if (canonicalSerialize(current.snapshot.intentAssessment ?? null) !== identity
                || current.rootJobId !== job.rootJobId) return false
            if (current.retryOfJobId === null) return rootIds.has(current.id) && current.id === job.rootJobId
            current = byId.get(current.retryOfJobId)
        }
        return false
    }
    const candidateIds = new Set<string>()
    for (const job of all) {
        if (job.snapshot.intentAssessment?.runId !== binding.runId || !belongsToRun(job)) continue
        const reference = job.artifactReference
        if (reference === null || candidateIds.has(reference.artifactId)) continue
        const artifact = await authorities.artifacts.get(reference.artifactId)
        if (artifact !== null && artifact.sourceJobId === job.id
            && artifact.original.contentChecksum === reference.digest) candidateIds.add(reference.artifactId)
    }
    const persisted = await authorities.assessments.read(binding.runId)
    if (persisted !== null && canonicalSerialize(persisted.binding) !== identity) {
        throw new TypeError('Stored assessment provenance differs from the Queue plan.')
    }
    const candidateArtifactIds = [...candidateIds].sort()
    const events = persisted?.events ?? []
    return { binding, candidateArtifactIds, events,
        projection: projectRunAcceptance(binding, candidateArtifactIds, events) }
}
