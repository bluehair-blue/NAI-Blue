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
import type { GenerationJob, OutputReservation } from '@/domain/queue/types'
import type { PendingQueueOutputTransaction } from '@/services/output/output-writer'
import {
    isR2QueueDeliverySnapshot,
    hashR2ProfileV2,
    type R2ManifestV2,
    type R2ProfileV2,
    type R2QueueDeliverySnapshot,
    type UploadJob,
} from '@/domain/r2/types'
import type { ArtifactRecord } from '@/domain/organizer/types'
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
import type { IntentAssessmentRepository } from '@/application/assessment/intent-assessment-repository'
import { IndexedDbIntentAssessmentRepository } from '@/adapters/assessment/indexeddb-intent-assessment-repository'
import { readQueueIntentAssessmentRun } from '@/adapters/assessment/queue-intent-assessment-reader'
import { latestArtifactAssessments } from '@/domain/assessment/intent-assessment'

export interface GenerationRunAuthorityReaders {
    readonly queue: Pick<IndexedDBQueueRepository, 'getBatch' | 'listJobs' | 'getOutputReservation' | 'listAttempts'>
    readonly output: Pick<OutputWriter, 'inspectPendingQueueTransactions'>
    readonly artifacts: Pick<IndexedDBArtifactRepository, 'get'>
    readonly r2: Pick<IndexedDBR2UploadRepository, 'listJobs' | 'getProfile' | 'getManifest'>
    /** Optional in injected readers; runtime supplies it to project Scene-link issues. */
    readonly scenes?: Pick<SceneRepositoryPort, 'getDocument'>
    readonly assessments?: IntentAssessmentRepository
}

function runtimeAuthorities(): GenerationRunAuthorityReaders {
    return {
        queue: getRuntimeQueueRepository(),
        output: getRuntimeOutputWriter(),
        artifacts: getRuntimeArtifactRepository(),
        r2: getRuntimeR2UploadRepository(),
        scenes: getRuntimeSceneRepository(),
        assessments: new IndexedDbIntentAssessmentRepository(),
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function releaseSnapshot(job: GenerationJob): R2QueueDeliverySnapshot | null {
    const parameters = job.snapshot.parameters
    if (!isRecord(parameters)) return null
    const workflow = job.workflow === 'main'
        ? parameters.mainWorkflow
        : job.workflow === 'scene'
            ? parameters.sceneWorkflow
            : null
    if (!isRecord(workflow)) return null
    return isR2QueueDeliverySnapshot(workflow.r2Delivery) ? workflow.r2Delivery : null
}

function releaseProfileId(job: GenerationJob): string | null {
    const current = releaseSnapshot(job)
    if (current !== null) return current.planned?.destination.profileId ?? null
    const parameters = job.snapshot.parameters
    if (!isRecord(parameters)) return null
    const workflow = job.workflow === 'main' ? parameters.mainWorkflow : parameters.sceneWorkflow
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

function journalMatchesJob(transaction: PendingQueueOutputTransaction | undefined, job: GenerationJob): boolean {
    if (transaction === undefined
        || transaction.phase !== 'files-committed'
        || job.outputTransactionId !== transaction.transactionId
        || job.artifactReference === null) return false
    const snapshot = job.snapshot.outputReservation
    if (snapshot === undefined) return transaction.outputReservation === undefined
    return transaction.outputReservation?.reservationId === snapshot.reservationId
        && transaction.outputReservation.directoryIdentity === snapshot.directoryIdentity
        && transaction.outputReservation.relativePath === snapshot.relativePath
        && (snapshot.reservationSchemaVersion !== 1
            || transaction.outputReservation.commitSetHash === snapshot.commitSetHash)
}

function reservationMatchesJob(reservation: OutputReservation | null | undefined, job: GenerationJob): boolean {
    const snapshot = job.snapshot.outputReservation
    return reservation !== null && reservation !== undefined && snapshot !== undefined
        && reservation.reservationId === snapshot.reservationId
        && reservation.jobId === job.id
        && reservation.batchId === job.batchId
        && reservation.folderBinding.resourceType === snapshot.folderBinding.resourceType
        && reservation.folderBinding.resourceId === snapshot.folderBinding.resourceId
        && reservation.folderBinding.revision === snapshot.folderBinding.revision
        && reservation.folderBinding.contentHash === snapshot.folderBinding.contentHash
        && reservation.directoryIdentity === snapshot.directoryIdentity
        && reservation.relativePath === snapshot.relativePath
        && reservation.collisionPolicy === snapshot.collisionPolicy
        && reservation.expectedExistingDigest === snapshot.expectedExistingDigest
        && reservation.reservationSchemaVersion === snapshot.reservationSchemaVersion
        && (reservation.reservationSchemaVersion !== 1
            || (snapshot.reservationSchemaVersion === 1 && reservation.commitSetHash === snapshot.commitSetHash))
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
    artifact: ArtifactRecord | null,
    linked: readonly UploadJob[] | null,
    r2: GenerationRunAuthorityReaders['r2'],
): Promise<GenerationFulfillmentJobFacts['release']> {
    const snapshot = releaseSnapshot(job)
    if (snapshot?.requirement === 'disabled') return { policy: 'not-required' }
    if (snapshot?.planned) {
        const policy = snapshot.requirement
        if (linked === null) return { policy }
        const expectedVariants = snapshot.planned.profile.publicMode === 'private'
            ? ['original', 'sidecar'] as const
            : ['original'] as const
        const current = linked.filter(candidate => (
            candidate.contractVersion === 'phase7-v1'
            && candidate.profileSnapshot !== null
            && candidate.profileId === snapshot.planned!.destination.profileId
            && hashR2ProfileV2(candidate.profileSnapshot) === snapshot.planned!.destination.profileHash
            && candidate.profileSnapshot.bucket === snapshot.planned!.destination.bucket
            && candidate.artifactId === job.artifactReference?.artifactId
            && candidate.remoteKey === (candidate.artifactBinding?.localVariant === 'sidecar'
                ? snapshot.planned!.destination.key.replace(/\.[^./]+$/u, '.nai-blue.json')
                : snapshot.planned!.destination.key)
            && (candidate.artifactBinding?.localVariant === 'sidecar'
                ? artifact?.sidecar?.digest === candidate.contentSha256 && artifact.sidecar.size === candidate.size
                : artifact?.original.contentChecksum === candidate.contentSha256 && artifact.original.size === candidate.size)
        ))
        const newest = [...current].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
        if (current.some(candidate => candidate.state === 'failed' || candidate.state === 'cancelled')) {
            return { policy, jobIds: current.map(candidate => candidate.id), fact: directFact('failed', 'r2-upload-job', `${job.id}:release`, newest?.updatedAt ?? job.updatedAt) }
        }
        if (!expectedVariants.every(variant => current.some(candidate => candidate.artifactBinding?.localVariant === variant))) {
            return {
                policy,
                fact: ['queued', 'leased', 'running', 'recovering'].includes(job.state)
                    ? derivedFact('pending', 'queue-job', `${job.id}:release`, job.updatedAt)
                    : undefined,
            }
        }
        if (current.some(candidate => candidate.state !== 'succeeded')) {
            return { policy, jobIds: current.map(candidate => candidate.id), fact: directFact('pending', 'r2-upload-job', `${job.id}:release`, newest?.updatedAt ?? job.updatedAt) }
        }
        const linkedExactly = artifact !== null && expectedVariants.every(variant => {
            const upload = current.find(candidate => candidate.artifactBinding?.localVariant === variant)
            return upload?.remoteRef !== null && upload?.remoteRef !== undefined
                && upload.remoteRef.profileHash === snapshot.planned!.destination.profileHash
                && upload.remoteRef.profileId === snapshot.planned!.destination.profileId
                && upload.remoteRef.artifactId === artifact.artifactId
                && upload.remoteRef.uploadJobId === upload.id
                && upload.remoteRef.variantId === variant
                && upload.remoteRef.bucket === snapshot.planned!.destination.bucket
                && upload.remoteRef.remoteKey === upload.remoteKey
                && upload.remoteRef.contentSha256 === upload.contentSha256
                && upload.remoteRef.size === upload.size
                && artifact.remoteObjectRefs.some(reference => (
                    reference.contractVersion === 'phase7-v1'
                    && reference.profileId === snapshot.planned!.destination.profileId
                    && reference.profileHash === snapshot.planned!.destination.profileHash
                    && reference.bucket === snapshot.planned!.destination.bucket
                    && reference.artifactId === artifact.artifactId
                    && reference.verifiedAt === upload.remoteRef?.verifiedAt
                    && reference.uploadJobId === upload.id
                    && reference.variantId === variant
                    && reference.remoteKey === upload.remoteKey
                    && reference.contentSha256 === upload.contentSha256
                    && reference.size === upload.size
                    && reference.state === 'succeeded'
                ))
        })
        return linkedExactly
            ? { policy, jobIds: current.map(candidate => candidate.id), fact: directFact('succeeded', 'artifact-record', `${job.id}:release`, artifact.updatedAt) }
            : { policy, fact: directFact('uncertain', 'artifact-record', `${job.id}:release`, artifact?.updatedAt ?? job.updatedAt) }
    }
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
        return { policy, jobIds: linked.map(candidate => candidate.id), fact: directFact('pending', 'r2-upload-job', `${job.id}:release`, newest.updatedAt) }
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
        const assessmentRun = jobs.some(job => job.snapshot.intentAssessment !== undefined)
            ? await readQueueIntentAssessmentRun(runId, {
                ...this.authorities, assessments: this.authorities.assessments ?? new IndexedDbIntentAssessmentRepository(),
            }, jobs)
            : null
        const latestAssessments = assessmentRun === null ? new Map() : latestArtifactAssessments(
            assessmentRun.binding, assessmentRun.candidateArtifactIds, assessmentRun.events,
        )
        const [pendingTransactions, r2Jobs] = await Promise.all([
            this.authorities.output.inspectPendingQueueTransactions().catch(() => null),
            jobs.some(job => releaseProfileId(job) !== null)
                ? this.authorities.r2.listJobs().catch(() => null)
                : Promise.resolve([]),
        ])
        const pendingByJobId = new Map<string, PendingQueueOutputTransaction[]>()
        for (const transaction of pendingTransactions ?? []) {
            const linked = pendingByJobId.get(transaction.sourceJobId) ?? []
            linked.push(transaction)
            pendingByJobId.set(transaction.sourceJobId, linked)
        }
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
        const reservations = await Promise.all(jobs.map(job => (
            job.snapshot.outputReservation === undefined
                ? Promise.resolve(null)
                : this.authorities.queue.getOutputReservation(job.snapshot.outputReservation.reservationId).catch(() => null)
        )))
        const attempts = await Promise.all(jobs.map(job => (
            job.attemptCount === 0
                ? Promise.resolve([])
                : this.authorities.queue.listAttempts(job.id).catch(() => null)
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
            const reservationRow = reservations[index]
            const attemptRows = attempts[index]
            const currentAttempt = attemptRows?.find(candidate => candidate.attemptNumber === job.attemptCount)
            const pendingTransaction = pendingByJobId.get(job.id)?.find(transaction => journalMatchesJob(transaction, job))
                ?? pendingByJobId.get(job.id)?.[0]
            const filesCommitted = journalMatchesJob(pendingTransaction, job)
            const artifactHasCurrentLineage = reservation?.reservationSchemaVersion !== 1
                || artifact?.outputCommitSetHash === reservation.commitSetHash
            const artifactMatchesJob = artifact?.sourceJobId === job.id && artifactHasCurrentLineage
            const storage = artifactMatchesJob
                ? directFact('succeeded', 'artifact-record', `${job.id}:artifact`, artifact.updatedAt)
                : job.state === 'succeeded' && job.outputTransactionId !== null && job.artifactReference !== null
                    ? directFact('succeeded', 'queue-output-commit', `${job.id}:storage`, job.updatedAt)
                    : pendingTransaction !== undefined
                        ? directFact('pending', 'output-journal', `${job.id}:storage`, job.updatedAt)
                        : ['queued', 'leased', 'running', 'recovering'].includes(job.state)
                            ? derivedFact('pending', 'queue-job', `${job.id}:storage`, job.updatedAt)
                            : undefined
            const providerEvidence = currentAttempt?.providerEvidence
            const provider = providerEvidence?.dispatchState === 'result-spooled'
                ? directFact('succeeded', 'queue-attempt', `${job.id}:provider`, job.updatedAt)
                : providerEvidence?.providerOutcome === 'unknown'
                    ? directFact('uncertain', 'queue-attempt', `${job.id}:provider`, job.updatedAt)
                    : job.attemptCount > 0 && storage === undefined
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
            const reservationMatches = reservationMatchesJob(reservationRow, job)
            const issues = [] as NonNullable<GenerationFulfillmentJobFacts['issues']>[number][]
            if (filesCommitted) {
                issues.push({
                    code: 'OUTPUT_RESERVATION_CONFLICT',
                    jobId: job.id,
                    severity: 'blocking',
                    action: { kind: 'retry-storage', requiresHuman: false },
                })
            }
            const destructiveEligible = pendingTransactions !== null
                && attemptRows !== null
                && job.outputTransactionId === null
                && job.artifactReference === null
                && !artifactMatchesJob
                && storage === undefined
                && reservationRow !== null
                && reservationRow.state !== 'committed'
                && reservationRow.state !== 'abandoned'
                && ['failed', 'blocked', 'cancelled', 'skipped'].includes(job.state)
            if (!filesCommitted && reservationMatches && destructiveEligible
                && providerEvidence?.dispatchState === 'result-spooled') {
                issues.push({
                    code: 'OUTPUT_RESERVATION_CONFLICT',
                    jobId: job.id,
                    severity: 'blocking',
                    action: { kind: 'discard-result-and-abandon-reservation', requiresHuman: true },
                })
            } else if (!filesCommitted && reservationMatches && attemptRows !== null
                && providerEvidence?.providerOutcome === 'unknown') {
                issues.push({
                    code: 'OUTPUT_RESERVATION_CONFLICT',
                    jobId: job.id,
                    severity: 'blocking',
                    action: { kind: 'review-provider-unknown', requiresHuman: true },
                })
            } else if (!filesCommitted && reservationMatches && destructiveEligible) {
                issues.push({
                    code: 'OUTPUT_RESERVATION_CONFLICT',
                    jobId: job.id,
                    severity: 'blocking',
                    action: { kind: 'abandon-reservation', requiresHuman: true },
                })
            }
            if (sceneLinkPending) {
                issues.push({
                    code: 'SCENE_LINK_PENDING',
                    jobId: job.id,
                    severity: 'warning',
                    action: { kind: 'retry-scene-link', requiresHuman: false },
                })
            }

            const release = await releaseFact(job, artifact, r2Jobs === null
                    ? null
                    : [
                        ...(job.artifactReference === null
                            ? []
                            : r2JobsByArtifactId.get(job.artifactReference.artifactId) ?? []),
                        ...(r2JobsByArtifactId.get(`${job.id}:release-image`) ?? []),
                        ...(r2JobsByArtifactId.get(`${job.id}:release-sidecar`) ?? []),
                    ], this.authorities.r2)
            if (storage?.state === 'succeeded' && releaseSnapshot(job)?.planned
                && r2Jobs !== null && ['unavailable', 'failed'].includes(release.fact?.state ?? 'unavailable')
                && !r2Jobs.some(upload => upload.artifactId === artifact?.artifactId && upload.state === 'cancelled')) {
                issues.push({
                    code: release.fact?.state === 'failed' ? 'R2_DELIVERY_FAILED' : 'R2_DELIVERY_MISSING',
                    jobId: job.id,
                    severity: release.policy === 'required' ? 'blocking' : 'warning',
                    action: { kind: 'retry-r2-release', requiresHuman: false },
                })
            }

            return {
                jobId: job.id,
                queueState: job.state,
                interpretation: job.snapshotHash.trim()
                    ? directFact('succeeded', 'queue-snapshot', `${job.id}:interpretation`, job.createdAt)
                    : undefined,
                provider,
                storage,
                release,
                acceptance: {
                    required: assessmentRun !== null,
                    ...(job.artifactReference === null || !latestAssessments.has(job.artifactReference.artifactId) ? {} : {
                        assessment: {
                            state: latestAssessments.get(job.artifactReference.artifactId)!.decision,
                            assessmentId: latestAssessments.get(job.artifactReference.artifactId)!.assessmentId,
                            acceptedArtifactIds: latestAssessments.get(job.artifactReference.artifactId)!.decision === 'accepted'
                                ? [job.artifactReference.artifactId] : [],
                        },
                    }),
                },
                ...(issues.length === 0 ? {} : { issues }),
            }
        }))

        return {
            batchId: batch.id,
            queueState: batch.state,
            ...(assessmentRun === null ? {} : { runAcceptance: assessmentRun.projection }),
            jobs: facts,
        }
    }
}

/** Runtime entry point backing generation.getRun; the query is intentionally UI-triggered, not polled. */
export function getRuntimeGenerationRun(runId: string): Promise<GenerationFulfillmentProjection | null> {
    return getGenerationRun(new IndexedDbGenerationRunReader(), runId)
}
