import type {
    NativeR2ScannedArtifact,
    R2ManifestV2,
    R2ManifestV2Item,
    R2ProfileV2,
    UploadJob,
} from '@/domain/r2/types'
import { deterministicR2Suffix, hashR2ProfileV2 } from '@/domain/r2/types'
import type { ArtifactRemoteObjectRef, Phase7ArtifactRemoteObjectRef } from '@/domain/organizer/types'
import { reportDiagnostic } from '@/services/diagnostics/error-registry'
import { ArtifactRepositoryError, type IndexedDBArtifactRepository } from '@/services/organizer/artifact-repository'
import { getRuntimeArtifactRepository } from '@/services/organizer/runtime'
import {
    appendCompletedPart,
    createUploadJob,
    IndexedDBR2UploadRepository,
    R2UploadRepositoryError,
} from './indexeddb-r2-upload-repository'
import {
    NativeR2Error,
    nativeR2UploadAdapter,
    type NativeR2UploadAdapter,
} from './native-r2-adapter'

export type R2UploadMode = 'current-session' | 'delta' | 'full-sync' | 'dry-run'

export interface R2UploadPlan {
    readonly mode: R2UploadMode
    readonly total: number
    readonly alreadyCompleted: number
    readonly jobs: readonly UploadJob[]
}

export interface R2UploadRunSummary {
    readonly succeeded: number
    readonly failed: number
    readonly queued: number
    readonly cancelled: number
}

export interface R2ConflictPreview {
    readonly examined: number
    readonly missing: number
    readonly alreadySame: number
    readonly conflicts: number
    readonly overwrites: number
    readonly suffixAvailable: number
}

const MULTIPART_THRESHOLD_BYTES = 8 * 1024 * 1024

function retryAt(attempt: number, now: Date): string {
    const delayMs = Math.min(60_000, 1_000 * (2 ** Math.max(0, attempt - 1)))
    return new Date(now.getTime() + delayMs).toISOString()
}

function artifactRetryAt(now: Date): string {
    return new Date(now.getTime() + 60_000).toISOString()
}

function isRetryable(error: unknown): boolean {
    return error instanceof NativeR2Error && error.retryable
}

function diagnosticId(error: unknown, job: UploadJob): string {
    return reportDiagnostic(error, {
        operation: 'r2.native-upload',
        stage: job.multipart.uploadId ? 'multipart' : 'put',
        jobId: job.id,
    }).eventId
}

function manifestItem(job: UploadJob, completedAt: string): R2ManifestV2Item {
    return {
        profileId: job.profileId,
        artifactId: job.artifactId,
        localVariant: job.localVariant,
        remoteKey: job.remoteKey,
        contentSha256: job.contentSha256,
        size: job.size,
        completedAt,
    }
}

export class R2UploadCoordinator {
    constructor(
        private readonly repository: IndexedDBR2UploadRepository,
        private readonly adapter: NativeR2UploadAdapter = nativeR2UploadAdapter,
        private readonly now: () => Date = () => new Date(),
        private readonly artifacts?: Pick<IndexedDBArtifactRepository, 'get' | 'replaceRemoteObjectRef'>,
    ) {}

    async plan(
        profile: R2ProfileV2,
        artifacts: readonly NativeR2ScannedArtifact[],
        mode: R2UploadMode,
    ): Promise<R2UploadPlan> {
        const manifest = await this.repository.getManifest(profile)
        const completed = new Map(manifest.items.map(item => [item.remoteKey, item]))
        const candidates = mode === 'delta'
            ? artifacts.filter(artifact => {
                if (artifact.artifactBinding !== undefined) return true
                const prior = completed.get(artifact.remoteKey)
                return prior?.contentSha256 !== artifact.contentSha256 || prior.size !== artifact.size
            })
            : [...artifacts]
        const alreadyCompleted = artifacts.length - candidates.length
        const timestamp = this.now().toISOString()
        const jobs = candidates.map((artifact, index) => createUploadJob(profile.id, artifact, {
            id: `${profile.id}:${timestamp}:${String(index).padStart(6, '0')}`,
            now: timestamp,
            ...(artifact.artifactBinding === undefined ? {} : {
                profileSnapshot: profile,
                artifactBinding: artifact.artifactBinding,
            }),
        }))
        return { mode, total: artifacts.length, alreadyCompleted, jobs }
    }

    async enqueuePlan(plan: R2UploadPlan): Promise<UploadJob[]> {
        if (plan.mode === 'dry-run') return []
        return this.repository.enqueue(plan.jobs)
    }

    /** Read-only remote HEAD preview. It never PUTs, DELETEs, or creates multipart state. */
    async previewConflicts(profile: R2ProfileV2, plan: R2UploadPlan): Promise<R2ConflictPreview> {
        const preview = {
            examined: 0,
            missing: 0,
            alreadySame: 0,
            conflicts: 0,
            overwrites: 0,
            suffixAvailable: 0,
        }
        for (const job of plan.jobs) {
            preview.examined += 1
            const previewProfile = job.contractVersion === 'phase7-v1' && job.profileSnapshot
                ? job.profileSnapshot
                : profile
            const existing = await this.adapter.headObject(previewProfile, job.remoteKey)
            if (!existing.exists) {
                preview.missing += 1
                continue
            }
            if (existing.contentSha256 === job.contentSha256 && existing.size === job.size) {
                preview.alreadySame += 1
                continue
            }
            if (job.contractVersion === 'phase7-v1') {
                preview.conflicts += 1
                continue
            }
            if (profile.conflictPolicy === 'overwrite') {
                preview.overwrites += 1
                continue
            }
            if (profile.conflictPolicy === 'suffix') {
                const suffixKey = deterministicR2Suffix(job.remoteKey, job.contentSha256)
                const suffixed = await this.adapter.headObject(previewProfile, suffixKey)
                if (!suffixed.exists) preview.suffixAvailable += 1
                else if (suffixed.contentSha256 === job.contentSha256 && suffixed.size === job.size) preview.alreadySame += 1
                else preview.conflicts += 1
                continue
            }
            preview.conflicts += 1
        }
        return preview
    }

    async recoverAfterRestart(): Promise<number> {
        return this.repository.recoverInterrupted(this.now().toISOString())
    }

    async runUntilIdle(profile: R2ProfileV2): Promise<R2UploadRunSummary> {
        while (true) {
            const now = this.now()
            const ready = (await this.repository.listJobs(profile.id))
                .filter(job => !['succeeded', 'failed', 'cancelled', 'running'].includes(job.state)
                    && Date.parse(job.nextAttemptAt) <= now.getTime())
            if (ready.length === 0) break

            // The repository snapshot supplies stable job versions to the sequential executor.
            // Processing the whole ready set avoids re-reading every profile job after each object,
            // while the outer loop still picks up jobs enqueued during the batch before reporting idle.
            for (const job of ready) {
                try {
                    await this.runJob(profile, job)
                } catch (error) {
                    // Cancellation or another coordinator may update a snapshotted job first.
                    // The next outer snapshot observes that authoritative state without aborting the batch.
                    if (error instanceof R2UploadRepositoryError && error.code === 'E_R2_VERSION_CONFLICT') continue
                    throw error
                }
            }
        }
        const jobs = await this.repository.listJobs(profile.id)
        return {
            succeeded: jobs.filter(job => job.state === 'succeeded').length,
            failed: jobs.filter(job => job.state === 'failed').length,
            queued: jobs.filter(job => !['succeeded', 'failed', 'cancelled'].includes(job.state)).length,
            cancelled: jobs.filter(job => job.state === 'cancelled').length,
        }
    }

    async cancel(profile: R2ProfileV2, jobId: string): Promise<UploadJob> {
        const job = await this.repository.getJob(jobId)
        if (!job) throw new Error('R2 upload job was not found.')
        if (job.state === 'succeeded' || job.state === 'failed' || job.state === 'cancelled') return job
        const boundProfile = job.contractVersion === 'phase7-v1' ? job.profileSnapshot : profile
        if (job.multipart.uploadId && boundProfile && (job.state === 'queued' || job.state === 'running')) {
            await this.adapter.abortMultipart(boundProfile, {
                remoteKey: job.remoteKey,
                uploadId: job.multipart.uploadId,
            })
        }
        return this.repository.updateJob(job.id, job.version, { state: 'cancelled' }, this.now().toISOString())
    }

    async manifest(profile: R2ProfileV2): Promise<R2ManifestV2> {
        return this.repository.getManifest(profile)
    }

    /** One snapshotted job lets foreground readiness isolate credentials even within one profile. */
    async runJob(profile: R2ProfileV2, initial: UploadJob): Promise<void> {
        if (initial.contractVersion === 'phase7-v1') {
            await this.runPhase7Job(initial)
            return
        }
        const startedAt = this.now()
        let job = await this.repository.updateJob(initial.id, initial.version, {
            state: 'running',
            attempt: initial.attempt + 1,
        }, startedAt.toISOString())

        try {
            if (await this.hasExactRemoteObject(profile, job)) {
                await this.succeedVerifiedJob(profile, job)
                return
            }
            if (job.size < MULTIPART_THRESHOLD_BYTES) {
                const result = await this.adapter.putObject(profile, job)
                if (result.remoteKey !== job.remoteKey) {
                    job = await this.repository.updateJob(job.id, job.version, { remoteKey: result.remoteKey }, this.now().toISOString())
                }
            } else {
                job = await this.runMultipart(profile, job)
            }
            if (!await this.hasExactRemoteObject(profile, job)) {
                throw new NativeR2Error('E_R2_VERIFICATION', 'Uploaded R2 object did not match the expected size and SHA-256.', true, null)
            }
            await this.succeedVerifiedJob(profile, job)
        } catch (error) {
            if (error instanceof NativeR2Error && error.code === 'E_R2_ALREADY_COMPLETE') {
                const reconciled = await this.repository.getJob(job.id)
                if (!reconciled) throw error
                if (await this.hasExactRemoteObject(profile, reconciled)) {
                    await this.succeedVerifiedJob(profile, reconciled)
                    return
                }
            }
            const current = await this.repository.getJob(job.id)
            if (!current || current.state === 'cancelled' || current.state === 'succeeded') return
            const eventId = diagnosticId(error, current)
            const retry = isRetryable(error) && current.attempt < current.maxAttempts
            await this.repository.updateJob(current.id, current.version, {
                state: retry ? 'queued' : 'failed',
                nextAttemptAt: retry ? retryAt(current.attempt, this.now()) : current.nextAttemptAt,
                diagnosticEventId: eventId,
            }, this.now().toISOString())
        }
    }

    private async runPhase7Job(initial: UploadJob): Promise<void> {
        const profile = initial.profileSnapshot
        if (!profile || !initial.artifactBinding) {
            throw new R2UploadRepositoryError('E_R2_RECORD_INVALID', 'Phase 7 upload job lost its durable bindings')
        }
        const artifactBinding = initial.artifactBinding
        const exactKeyProfile: R2ProfileV2 = { ...profile, conflictPolicy: 'fail' }
        let job = initial
        try {
            if (job.state === 'queued') {
                job = await this.repository.updateJob(job.id, job.version, {
                    state: 'running',
                    attempt: job.attempt + 1,
                }, this.now().toISOString())
                if (!await this.hasExactRemoteObject(profile, job)) {
                    if (job.size < MULTIPART_THRESHOLD_BYTES) {
                        const result = await this.adapter.putObject(exactKeyProfile, job)
                        if (result.remoteKey !== job.remoteKey) {
                            throw new NativeR2Error('E_R2_REMOTE_KEY_MISMATCH', 'Phase 7 upload returned an unexpected remote key.', false, null)
                        }
                    } else {
                        job = await this.runMultipart(exactKeyProfile, job, true)
                    }
                }
                job = await this.repository.updateJob(job.id, job.version, { state: 'uploaded' }, this.now().toISOString())
            }
            if (job.state === 'uploaded') {
                job = await this.repository.updateJob(job.id, job.version, { state: 'verifying' }, this.now().toISOString())
            }
            if (job.state === 'verifying') {
                if (!await this.hasExactRemoteObject(profile, job)) {
                    throw new NativeR2Error('E_R2_VERIFICATION', 'Uploaded R2 object did not match the expected size and SHA-256.', false, null)
                }
                const verifiedAt = this.now().toISOString()
                job = await this.repository.updateJob(job.id, job.version, {
                    state: 'verified',
                    remoteRef: {
                        contractVersion: 'phase7-v1',
                        profileId: profile.id,
                        profileHash: hashR2ProfileV2(profile),
                        bucket: profile.bucket,
                        uploadJobId: job.id,
                        artifactId: job.artifactId,
                        variantId: artifactBinding.localVariant,
                        remoteKey: job.remoteKey,
                        contentSha256: job.contentSha256,
                        size: job.size,
                        verifiedAt,
                    },
                }, verifiedAt)
            }
            if (job.state === 'verified') {
                job = await this.repository.updateJob(job.id, job.version, { state: 'linking' }, this.now().toISOString())
            }
            if (job.state === 'linking') await this.linkPhase7Job(profile, job)
        } catch (error) {
            const current = await this.repository.getJob(job.id)
            if (!current || ['cancelled', 'succeeded', 'failed'].includes(current.state)) return
            let failure = error
            if (error instanceof ArtifactRepositoryError && error.code === 'E_ARTIFACT_VERSION_CONFLICT') {
                try {
                    const artifact = await this.artifactRepository().get(current.artifactId)
                    if (artifact && current.remoteRef) {
                        const exact = artifact.remoteObjectRefs.some(reference => this.isExactArtifactRef(reference, current.remoteRef!))
                        if (exact) {
                            await this.succeedVerifiedJob(profile, current)
                            return
                        }
                        await this.repository.updateJob(current.id, current.version, {
                            linkExpectedArtifactVersion: artifact.version,
                            nextAttemptAt: retryAt(current.attempt, this.now()),
                        }, this.now().toISOString())
                        return
                    }
                } catch (artifactError) {
                    failure = artifactError
                }
            }
            const transientArtifactFailure = failure instanceof ArtifactRepositoryError
                && (failure.code === 'E_ARTIFACT_DB_BLOCKED' || failure.code === 'E_ARTIFACT_DB_UNAVAILABLE')
            const eventId = diagnosticId(failure, current)
            if (transientArtifactFailure && current.state === 'linking') {
                await this.repository.updateJob(current.id, current.version, {
                    state: 'linking',
                    nextAttemptAt: artifactRetryAt(this.now()),
                    diagnosticEventId: eventId,
                }, this.now().toISOString())
                return
            }
            const uploadStage = current.state === 'running'
            const retry = (uploadStage ? isRetryable(failure) : failure instanceof NativeR2Error && failure.retryable)
                && current.attempt < current.maxAttempts
            await this.repository.updateJob(current.id, current.version, {
                state: uploadStage && retry ? 'queued' : retry ? current.state : 'failed',
                nextAttemptAt: retry ? retryAt(current.attempt, this.now()) : current.nextAttemptAt,
                diagnosticEventId: eventId,
            }, this.now().toISOString())
        }
    }

    private async linkPhase7Job(profile: R2ProfileV2, job: UploadJob): Promise<void> {
        if (!job.artifactBinding || !job.linkExpectedArtifactVersion || !job.remoteRef) {
            throw new R2UploadRepositoryError('E_R2_RECORD_INVALID', 'Verified Phase 7 job lacks Artifact linkage facts')
        }
        const remote: Phase7ArtifactRemoteObjectRef = {
            ...job.remoteRef,
            contentSha256: job.remoteRef.contentSha256 as `sha256:${string}`,
            state: 'succeeded',
            updatedAt: this.now().toISOString(),
            failure: null,
        }
        const linked = await this.artifactRepository().replaceRemoteObjectRef(
            job.artifactId,
            job.linkExpectedArtifactVersion,
            remote,
            remote.updatedAt,
        )
        if (!linked.remoteObjectRefs.some(reference => this.isExactArtifactRef(reference, job.remoteRef!))) {
            throw new ArtifactRepositoryError('E_ARTIFACT_NOT_FOUND', 'Artifact remote reference write was not readable.')
        }
        await this.succeedVerifiedJob(profile, job)
    }

    private isExactArtifactRef(reference: ArtifactRemoteObjectRef, remote: NonNullable<UploadJob['remoteRef']>): boolean {
        return reference.contractVersion === remote.contractVersion
            && reference.profileId === remote.profileId
            && reference.profileHash === remote.profileHash
            && reference.bucket === remote.bucket
            && reference.uploadJobId === remote.uploadJobId
            && reference.artifactId === remote.artifactId
            && reference.variantId === remote.variantId
            && reference.remoteKey === remote.remoteKey
            && reference.contentSha256 === remote.contentSha256
            && reference.size === remote.size
            && reference.verifiedAt === remote.verifiedAt
    }

    private artifactRepository(): Pick<IndexedDBArtifactRepository, 'get' | 'replaceRemoteObjectRef'> {
        return this.artifacts ?? getRuntimeArtifactRepository()
    }

    /** ETag is deliberately ignored because multipart and encrypted objects do not expose a content checksum there. */
    private async hasExactRemoteObject(profile: R2ProfileV2, job: UploadJob): Promise<boolean> {
        const head = await this.adapter.headObject(profile, job.remoteKey)
        return head.exists && head.size === job.size && head.contentSha256 === job.contentSha256
    }

    private async succeedVerifiedJob(profile: R2ProfileV2, job: UploadJob): Promise<void> {
        const completedAt = this.now().toISOString()
        await this.repository.succeedJobWithManifest(
            profile,
            job.id,
            job.version,
            manifestItem(job, completedAt),
            completedAt,
        )
    }

    private async runMultipart(profile: R2ProfileV2, initial: UploadJob, exactKey = false): Promise<UploadJob> {
        let job = initial
        if (!job.multipart.uploadId) {
            const created = await this.adapter.createMultipart(profile, job)
            if (exactKey && created.remoteKey !== job.remoteKey) {
                await this.adapter.abortMultipart(profile, {
                    remoteKey: created.remoteKey,
                    uploadId: created.uploadId,
                }).catch(() => undefined)
                throw new NativeR2Error('E_R2_REMOTE_KEY_MISMATCH', 'Phase 7 multipart returned an unexpected remote key.', false, null)
            }
            job = await this.repository.updateJob(job.id, job.version, {
                remoteKey: created.remoteKey,
                multipart: {
                    ...job.multipart,
                    uploadId: created.uploadId,
                },
            }, this.now().toISOString())
        }
        const uploadId = job.multipart.uploadId
        if (!uploadId) throw new NativeR2Error('E_R2_MULTIPART', 'Multipart upload did not start.', true, null)

        const partCount = Math.ceil(job.size / job.multipart.partSize)
        const completed = new Set(job.multipart.completedParts.map(part => part.partNumber))
        for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
            if (completed.has(partNumber)) continue
            const offset = (partNumber - 1) * job.multipart.partSize
            const length = Math.min(job.multipart.partSize, job.size - offset)
            const part = await this.adapter.uploadPart(profile, {
                localVariant: job.localVariant,
                remoteKey: job.remoteKey,
                uploadId,
                partNumber,
                offset,
                length,
            })
            job = await this.repository.updateJob(job.id, job.version, {
                multipart: appendCompletedPart(job, part),
            }, this.now().toISOString())
        }
        const result = await this.adapter.completeMultipart(profile, {
            remoteKey: job.remoteKey,
            uploadId,
            contentSha256: job.contentSha256,
            completedParts: job.multipart.completedParts,
        })
        if (result.remoteKey !== job.remoteKey) {
            if (exactKey) {
                throw new NativeR2Error('E_R2_REMOTE_KEY_MISMATCH', 'Phase 7 multipart completion returned an unexpected remote key.', false, null)
            }
            job = await this.repository.updateJob(job.id, job.version, { remoteKey: result.remoteKey }, this.now().toISOString())
        }
        return job
    }
}
