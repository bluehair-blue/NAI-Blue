import type { ProviderResultSpool } from '@/application/generation/provider-result-spool'
import type { RetryGenerationStoragePort } from '@/application/generation/generation-command-contract'
import { retryGenerationStorage } from '@/application/generation/enqueue-generation-plan'
import { linkSceneArtifact, type LinkSceneArtifactResult } from '@/application/scene/link-scene-artifact'
import type { SceneDocument, SceneRepositoryPort } from '@/application/scene/scene-repository'
import type { FulfillmentIssue, RecoveryAction } from '@/application/generation/generation-fulfillment'
import type { GenerationJob, OutputReservation } from '@/domain/queue/types'
import { applySceneDocumentProjection } from '@/lib/scene-authority-runtime'
import { getRuntimeSceneRepository } from '@/lib/scene-migration-startup'
import { getRuntimeArtifactRepository } from '@/services/organizer/runtime'
import { getRuntimeGenerationCommandAdapter } from './generation-command-adapter'
import { getRuntimeMainQueueDependencies } from './main-queue-runtime-dependencies'
import { getRuntimeQueueRepository, type IndexedDBQueueRepository, QueueRepositoryError } from './indexeddb-queue-repository'
import { discardSpooledResultAndAbandonReservation } from './output-reservation-commands'
import type { QueueArtifactRepository } from './queue-artifact-lineage'

type QueueRecoveryRepository = Pick<
    IndexedDBQueueRepository,
    | 'initialize'
    | 'getJob'
    | 'getOutputReservation'
    | 'listAttempts'
    | 'abandonOutputReservation'
    | 'recoverFilesCommittedSuccess'
>

export interface QueueRecoveryCommandDependencies {
    readonly repository: QueueRecoveryRepository
    readonly storage: RetryGenerationStoragePort
    readonly artifacts: QueueArtifactRepository
    readonly scenes: SceneRepositoryPort
    readonly spool: ProviderResultSpool | (() => ProviderResultSpool)
    readonly projectSceneDocument?: (document: SceneDocument) => void
    readonly now?: () => string
}

export type QueueRecoveryCommandResult =
    | { readonly status: 'recovered'; readonly action: RecoveryAction['kind'] }
    | { readonly status: 'scene-linked'; readonly result: LinkSceneArtifactResult }

function scenePresetId(parameters: unknown): string | null {
    if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) return null
    const workflow = (parameters as Record<string, unknown>).sceneWorkflow
    if (workflow === null || typeof workflow !== 'object' || Array.isArray(workflow)) return null
    const saveContext = (workflow as Record<string, unknown>).saveContext
    if (saveContext === null || typeof saveContext !== 'object' || Array.isArray(saveContext)) return null
    const value = (saveContext as Record<string, unknown>).activePresetId
    return typeof value === 'string' && value.trim() ? value.trim() : null
}

function unsupported(action: RecoveryAction['kind']): never {
    throw new QueueRepositoryError('E_QUEUE_INVALID_TRANSITION', `Recovery action is not executable here: ${action}`)
}

function reservationMatchesSnapshot(job: GenerationJob, reservation: OutputReservation): boolean {
    const snapshot = job.snapshot.outputReservation
    return snapshot !== undefined
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

/** Re-reads every private authority from the opaque job ID before invoking existing recovery primitives. */
export function createQueueRecoveryCommandAdapter(dependencies: QueueRecoveryCommandDependencies) {
    const now = dependencies.now ?? (() => new Date().toISOString())
    return {
        async execute(issue: Pick<FulfillmentIssue, 'jobId' | 'action'>): Promise<QueueRecoveryCommandResult> {
            if (!issue.jobId.trim()) throw new TypeError('Recovery job ID is required')
            await dependencies.repository.initialize()
            const job = await dependencies.repository.getJob(issue.jobId)
            if (job === null) throw new QueueRepositoryError('E_QUEUE_NOT_FOUND', 'Recovery job does not exist')

            if (issue.action.kind === 'retry-storage') {
                const result = await retryGenerationStorage({
                    jobId: job.id,
                    actor: { kind: 'user', id: 'queue-center' },
                }, dependencies.storage)
                if (result.status !== 'ready') {
                    throw new QueueRepositoryError('E_QUEUE_INVALID_TRANSITION', `Storage recovery is stale: ${result.status}`)
                }
                return { status: 'recovered', action: issue.action.kind }
            }

            if (issue.action.kind === 'retry-scene-link') {
                const reference = job.artifactReference
                const presetId = scenePresetId(job.snapshot.parameters)
                if (job.workflow !== 'scene' || job.sceneId === null || reference === null || presetId === null) {
                    throw new QueueRepositoryError('E_QUEUE_INVALID_TRANSITION', 'Scene recovery authority is incomplete')
                }
                const artifact = await dependencies.artifacts.get(reference.artifactId)
                if (artifact === null
                    || artifact.artifactId !== reference.artifactId
                    || artifact.sourceJobId !== job.id
                    || artifact.sourceSceneId !== job.sceneId
                    || (job.snapshot.outputReservation?.reservationSchemaVersion === 1
                        && artifact.outputCommitSetHash !== job.snapshot.outputReservation.commitSetHash)) {
                    throw new QueueRepositoryError('E_QUEUE_IDEMPOTENCY_CONFLICT', 'Scene artifact lineage changed')
                }
                const result = await linkSceneArtifact(dependencies.scenes, {
                    presetId,
                    sceneId: job.sceneId,
                    artifactId: artifact.artifactId,
                    createdAt: artifact.createdAt,
                    favorite: false,
                })
                if (result.status === 'SCENE_MISSING' || result.status === 'PENDING_CONFLICT') {
                    throw new QueueRepositoryError('E_QUEUE_INVALID_TRANSITION', `Scene link recovery did not commit: ${result.status}`)
                }
                dependencies.projectSceneDocument?.(result.document)
                return { status: 'scene-linked', result }
            }

            const snapshot = job.snapshot.outputReservation
            if (snapshot === undefined) {
                throw new QueueRepositoryError('E_QUEUE_INVALID_TRANSITION', 'Recovery job has no output reservation')
            }
            const reservation = await dependencies.repository.getOutputReservation(snapshot.reservationId)
            if (reservation === null || !reservationMatchesSnapshot(job, reservation)) {
                throw new QueueRepositoryError('E_QUEUE_IDEMPOTENCY_CONFLICT', 'Output reservation authority changed')
            }

            if (issue.action.kind === 'discard-result-and-abandon-reservation') {
                const spool = typeof dependencies.spool === 'function' ? dependencies.spool() : dependencies.spool
                await discardSpooledResultAndAbandonReservation(dependencies.repository, spool, {
                    jobId: job.id,
                    reservationId: reservation.reservationId,
                    now: now(),
                })
                return { status: 'recovered', action: issue.action.kind }
            }

            if (issue.action.kind === 'abandon-reservation') {
                const attempts = await dependencies.repository.listAttempts(job.id)
                const current = attempts.find(candidate => candidate.attemptNumber === job.attemptCount)
                if (!['failed', 'blocked', 'cancelled', 'skipped'].includes(job.state)
                    || job.outputTransactionId !== null
                    || job.artifactReference !== null
                    || reservation.state === 'committed'
                    || reservation.state === 'abandoned'
                    || current?.providerEvidence?.dispatchState === 'result-spooled'
                    || current?.providerEvidence?.providerOutcome === 'unknown') {
                    throw new QueueRepositoryError('E_QUEUE_INVALID_TRANSITION', 'Bound, active, terminal, or uncertain output cannot be abandoned')
                }
                await dependencies.repository.abandonOutputReservation({
                    reservationId: reservation.reservationId,
                    owner: reservation,
                    ...(reservation.reservationSchemaVersion === 1 ? { expectedVersion: reservation.version } : {}),
                    now: now(),
                })
                return { status: 'recovered', action: issue.action.kind }
            }

            return unsupported(issue.action.kind)
        },
    }
}

/** Runtime composition reuses the Queue session's Provider spool instead of opening another store. */
export function getRuntimeQueueRecoveryCommandAdapter() {
    return createQueueRecoveryCommandAdapter({
        repository: getRuntimeQueueRepository(),
        storage: getRuntimeGenerationCommandAdapter(),
        artifacts: getRuntimeArtifactRepository(),
        scenes: getRuntimeSceneRepository(),
        projectSceneDocument: applySceneDocumentProjection,
        spool: () => getRuntimeMainQueueDependencies().providerResultSpool,
    })
}
