import type {
    GenerationFulfillmentFacts,
    GenerationFulfillmentJobFacts,
    GenerationFulfillmentProjection,
    ObservedTechnicalFact,
} from '@/application/generation/generation-fulfillment'
import {
    getGenerationRun,
    type GenerationRunReadPort,
} from '@/application/generation/get-generation-run'
import type { GenerationJob } from '@/domain/queue/types'
import type { R2ManifestV2, R2ProfileV2, UploadJob } from '@/domain/r2/types'
import { getRuntimeArtifactRepository } from '@/services/organizer/runtime'
import { getRuntimeOutputWriter } from '@/services/output/output-writer'
import {
    getRuntimeQueueRepository,
    type IndexedDBQueueRepository,
} from '@/services/queue/indexeddb-queue-repository'
import type { IndexedDBArtifactRepository } from '@/services/organizer/artifact-repository'
import type { OutputWriter } from '@/services/output/output-writer'
import type { IndexedDBR2UploadRepository } from '@/services/r2/indexeddb-r2-upload-repository'
import { getRuntimeR2UploadRepository } from '@/services/r2/runtime'
import type { SceneDocument, SceneRepositoryPort } from '@/application/scene/scene-repository'
import { getRuntimeSceneRepository } from '@/lib/scene-migration-startup'

export interface GenerationRunAuthorityReaders {
    readonly queue: Pick<IndexedDBQueueRepository, 'getBatch' | 'listJobs'>
    readonly output: Pick<OutputWriter, 'inspectPendingQueueTransactions'>
    readonly artifacts: Pick<IndexedDBArtifactRepository, 'get'>
    readonly r2: Pick<IndexedDBR2UploadRepository, 'listJobs' | 'getProfile' | 'getManifest'>
    /** Optional in injected readers; runtime supplies it to project Scene-link issues. */
    readonly scenes?: Pick<SceneRepositoryPort, 'getDocument'>
}

function runtimeAuthorities(): GenerationRunAuthorityReaders {
    return {
        queue: getRuntimeQueueRepository(),
        output: getRuntimeOutputWriter(),
        artifacts: getRuntimeArtifactRepository(),
        r2: getRuntimeR2UploadRepository(),
        scenes: getRuntimeSceneRepository(),
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function releaseProfileId(job: GenerationJob): string | null {
    const parameters = job.snapshot.parameters
    if (!isRecord(parameters)) return null
    const workflow = job.workflow === 'main'
        ? parameters.mainWorkflow
        : job.workflow === 'scene'
            ? parameters.sceneWorkflow
            : null
    if (!isRecord(workflow)) return null
    if (job.workflow === 'main' && workflow.metadataMode !== 'strip-and-sidecar') return null
    const output = job.workflow === 'main' ? workflow.output : workflow.outputContext
    if (!isRecord(output) || typeof output.autoR2UploadProfileId !== 'string') return null
    return output.autoR2UploadProfileId.trim() || null
}

function scenePresetId(job: GenerationJob): string | null {
    if (job.workflow !== 'scene') return null
    const parameters = job.snapshot.parameters
    if (!isRecord(parameters) || !isRecord(parameters.sceneWorkflow)) return null
    const saveContext = parameters.sceneWorkflow.saveContext
    return isRecord(saveContext) && typeof saveContext.activePresetId === 'string'
        ? saveContext.activePresetId.trim() || null
        : null
}

function directFact(
    state: ObservedTechnicalFact['state'],
    source: string,
    referenceId: string,
    observedAt: string,
): ObservedTechnicalFact {
    return { state, source, referenceId, observedAt, kind: 'direct' }
}

function derivedFact(
    state: ObservedTechnicalFact['state'],
    source: string,
    referenceId: string,
    observedAt: string,
): ObservedTechnicalFact {
    return { state, source, referenceId, observedAt, kind: 'derived' }
}

async function listBatchJobs(
    queue: GenerationRunAuthorityReaders['queue'],
    batchId: string,
): Promise<GenerationJob[]> {
    const jobs: GenerationJob[] = []
    let cursor: string | null = null
    do {
        const page = await queue.listJobs({ batchId, cursor, limit: 1_000 })
        jobs.push(...page.items)
        cursor = page.nextCursor
    } while (cursor !== null)
    return jobs
}

function manifestContains(job: UploadJob, manifest: R2ManifestV2): boolean {
    return manifest.items.some(item => (
        item.profileId === job.profileId
        && item.artifactId === job.artifactId
        && item.localVariant === job.localVariant
        && item.remoteKey === job.remoteKey
        && item.contentSha256 === job.contentSha256
        && item.size === job.size
    ))
}

async function releaseFact(
    job: GenerationJob,
    linked: readonly UploadJob[] | null,
    r2: GenerationRunAuthorityReaders['r2'],
): Promise<GenerationFulfillmentJobFacts['release']> {
    if (releaseProfileId(job) === null) return { policy: 'not-required' }
    const policy = 'best-effort' as const
    if (linked === null) return { policy }
    if (linked.length === 0) {
        return {
            policy,
            fact: ['queued', 'leased', 'running', 'recovering'].includes(job.state)
                ? derivedFact('pending', 'queue-job', `${job.id}:release`, job.updatedAt)
                : undefined,
        }
    }

    const newest = [...linked].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] as UploadJob
    if (linked.some(candidate => candidate.state === 'failed' || candidate.state === 'cancelled')) {
        return { policy, fact: directFact('failed', 'r2-upload-job', `${job.id}:release`, newest.updatedAt) }
    }
    if (linked.some(candidate => candidate.state === 'queued' || candidate.state === 'running')) {
        return { policy, fact: directFact('pending', 'r2-upload-job', `${job.id}:release`, newest.updatedAt) }
    }

    const profiles = await Promise.all([...new Set(linked.map(candidate => candidate.profileId))]
        .map(profileId => r2.getProfile(profileId).catch(() => null)))
    const resolvedProfiles = profiles.filter((profile): profile is R2ProfileV2 => profile !== null)
    if (resolvedProfiles.length !== profiles.length) {
        return { policy, fact: directFact('uncertain', 'r2-upload-job', `${job.id}:release`, newest.updatedAt) }
    }
    if (resolvedProfiles.some(profile => (
        profile.publicMode === 'private'
        && !linked.some(candidate => (
            candidate.profileId === profile.id && candidate.artifactId === `${job.id}:release-sidecar`
        ))
    ))) {
        return { policy, fact: directFact('uncertain', 'r2-upload-job', `${job.id}:release`, newest.updatedAt) }
    }
    const manifests = await Promise.all(resolvedProfiles.map(profile => r2.getManifest(profile).catch(() => null)))
    const manifestByProfile = new Map(manifests
        .filter((manifest): manifest is R2ManifestV2 => manifest !== null)
        .map(manifest => [manifest.profileId, manifest]))
    if (!linked.every(candidate => {
        const manifest = manifestByProfile.get(candidate.profileId)
        return manifest !== undefined && manifestContains(candidate, manifest)
    })) {
        return { policy, fact: directFact('uncertain', 'r2-upload-job', `${job.id}:release`, newest.updatedAt) }
    }
    return { policy, fact: directFact('succeeded', 'r2-manifest', `${job.id}:release`, newest.updatedAt) }
}

/**
 * Joins existing Queue, OutputWriter, Artifact, and R2 read authorities on demand.
 * It persists nothing and emits only opaque IDs plus timestamps; payloads and paths stay behind the adapter.
 */
export class IndexedDbGenerationRunReader implements GenerationRunReadPort {
    constructor(private readonly authorities: GenerationRunAuthorityReaders = runtimeAuthorities()) {}

    async readGenerationRunFacts(runId: string): Promise<GenerationFulfillmentFacts | null> {
        const batch = await this.authorities.queue.getBatch(runId)
        if (batch === null) return null

        const jobs = await listBatchJobs(this.authorities.queue, batch.id)
        const [pendingTransactions, r2Jobs] = await Promise.all([
            this.authorities.output.inspectPendingQueueTransactions().catch(() => []),
            jobs.some(job => releaseProfileId(job) !== null)
                ? this.authorities.r2.listJobs().catch(() => null)
                : Promise.resolve([]),
        ])
        const pendingJobIds = new Set(pendingTransactions.map(transaction => transaction.sourceJobId))
        const r2JobsByArtifactId = new Map<string, UploadJob[]>()
        for (const r2Job of r2Jobs ?? []) {
            const linked = r2JobsByArtifactId.get(r2Job.artifactId) ?? []
            linked.push(r2Job)
            r2JobsByArtifactId.set(r2Job.artifactId, linked)
        }
        const artifacts = await Promise.all(jobs.map(job => (
            job.artifactReference === null
                ? Promise.resolve(null)
                : this.authorities.artifacts.get(job.artifactReference.artifactId).catch(() => null)
        )))
        const scenePresetIds = [...new Set(jobs.map(scenePresetId).filter((id): id is string => id !== null))]
        const sceneDocuments = new Map<string, SceneDocument | null>(this.authorities.scenes === undefined
            ? []
            : await Promise.all(scenePresetIds.map(async presetId => [
                    presetId,
                    await this.authorities.scenes!.getDocument(presetId).catch(() => null),
                ] as const)))

        const facts = await Promise.all(jobs.map(async (job, index): Promise<GenerationFulfillmentJobFacts> => {
            const artifact = artifacts[index]
            const reservation = job.snapshot.outputReservation
            const artifactHasCurrentLineage = reservation?.reservationSchemaVersion !== 1
                || artifact?.outputCommitSetHash === reservation.commitSetHash
            const artifactMatchesJob = artifact?.sourceJobId === job.id && artifactHasCurrentLineage
            const storage = artifactMatchesJob
                ? directFact('succeeded', 'artifact-record', `${job.id}:artifact`, artifact.updatedAt)
                : job.state === 'succeeded' && job.outputTransactionId !== null && job.artifactReference !== null
                    ? directFact('succeeded', 'queue-output-commit', `${job.id}:storage`, job.updatedAt)
                    : pendingJobIds.has(job.id)
                        ? directFact('pending', 'output-journal', `${job.id}:storage`, job.updatedAt)
                        : ['queued', 'leased', 'running', 'recovering'].includes(job.state)
                            ? derivedFact('pending', 'queue-job', `${job.id}:storage`, job.updatedAt)
                            : undefined
            const provider = job.attemptCount > 0 && storage === undefined
                ? derivedFact('uncertain', 'queue-attempt', `${job.id}:provider`, job.updatedAt)
                : undefined
            const presetId = scenePresetId(job)
            const sceneDocument = presetId === null ? undefined : sceneDocuments.get(presetId)
            const scene = sceneDocument?.scenes.find(candidate => candidate.id === job.sceneId)
            const sceneLinkPending = this.authorities.scenes !== undefined
                && artifactMatchesJob
                && presetId !== null
                && (scene === undefined
                    || !scene.artifactRefs.some(reference => reference.artifactId === artifact.artifactId))

            return {
                jobId: job.id,
                queueState: job.state,
                interpretation: job.snapshotHash.trim()
                    ? directFact('succeeded', 'queue-snapshot', `${job.id}:interpretation`, job.createdAt)
                    : undefined,
                provider,
                storage,
                release: await releaseFact(job, r2Jobs === null
                    ? null
                    : [
                        ...(r2JobsByArtifactId.get(`${job.id}:release-image`) ?? []),
                        ...(r2JobsByArtifactId.get(`${job.id}:release-sidecar`) ?? []),
                    ], this.authorities.r2),
                acceptance: { required: false },
                ...(sceneLinkPending
                    ? {
                            issues: [{
                                code: 'SCENE_LINK_PENDING' as const,
                                jobId: job.id,
                                severity: 'warning' as const,
                                action: { kind: 'retry-scene-link' as const, requiresHuman: false },
                            }],
                        }
                    : {}),
            }
        }))

        return {
            batchId: batch.id,
            queueState: batch.state,
            jobs: facts,
        }
    }
}

/** Runtime entry point backing generation.getRun; the query is intentionally UI-triggered, not polled. */
export function getRuntimeGenerationRun(runId: string): Promise<GenerationFulfillmentProjection | null> {
    return getGenerationRun(new IndexedDbGenerationRunReader(), runId)
}
