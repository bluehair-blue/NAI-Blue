import { canonicalSerialize } from '@/domain/composition/canonical-serialize'
import type { ProviderResultSpool } from '@/application/generation/provider-result-spool'
import type { GenerationJob, OutputReservation } from '@/domain/queue/types'
import type { IndexedDBQueueRepository } from './indexeddb-queue-repository'
import { QueueRepositoryError } from './indexeddb-queue-repository'

type ReservationCommandRepository = Pick<
    IndexedDBQueueRepository,
    'getJob' | 'getOutputReservation' | 'listAttempts' | 'abandonOutputReservation'
>

function assertDiscardAuthority(job: GenerationJob, reservation: OutputReservation, reservationId: string): void {
    const snapshot = job.snapshot.outputReservation
    if (snapshot === undefined
        || reservationId !== snapshot.reservationId
        || reservation.reservationId !== snapshot.reservationId
        || reservation.jobId !== job.id
        || reservation.batchId !== job.batchId
        || reservation.folderBinding.resourceType !== snapshot.folderBinding.resourceType
        || reservation.folderBinding.resourceId !== snapshot.folderBinding.resourceId
        || reservation.folderBinding.revision !== snapshot.folderBinding.revision
        || reservation.folderBinding.contentHash !== snapshot.folderBinding.contentHash
        || reservation.directoryIdentity !== snapshot.directoryIdentity
        || reservation.relativePath !== snapshot.relativePath
        || reservation.collisionPolicy !== snapshot.collisionPolicy
        || reservation.expectedExistingDigest !== snapshot.expectedExistingDigest
        || reservation.reservationSchemaVersion !== snapshot.reservationSchemaVersion
        || (reservation.reservationSchemaVersion === 1
            && (snapshot.reservationSchemaVersion !== 1 || reservation.commitSetHash !== snapshot.commitSetHash))) {
        throw new QueueRepositoryError('E_QUEUE_IDEMPOTENCY_CONFLICT', 'Spooled reservation authority changed')
    }
    if (!['failed', 'blocked', 'cancelled', 'skipped'].includes(job.state)
        || job.outputTransactionId !== null
        || job.artifactReference !== null
        || reservation.state === 'committed'
        || reservation.state === 'abandoned') {
        throw new QueueRepositoryError('E_QUEUE_INVALID_TRANSITION', 'Bound, active, or terminal reservation cannot discard its result')
    }
}

/** Deletes the verified Provider result before releasing its durable path claims. */
export async function discardSpooledResultAndAbandonReservation(
    repository: ReservationCommandRepository,
    spool: ProviderResultSpool,
    input: { readonly jobId: string; readonly reservationId: string; readonly now: string },
): Promise<OutputReservation> {
    const [job, reservation, attempts] = await Promise.all([
        repository.getJob(input.jobId),
        repository.getOutputReservation(input.reservationId),
        repository.listAttempts(input.jobId),
    ])
    if (job === null || reservation === null || reservation.jobId !== job.id) {
        throw new QueueRepositoryError('E_QUEUE_NOT_FOUND', 'Spooled reservation owner is missing')
    }
    assertDiscardAuthority(job, reservation, input.reservationId)
    const attempt = attempts.find(candidate => candidate.attemptNumber === job.attemptCount)
    const receipt = attempt?.providerEvidence?.dispatchState === 'result-spooled'
        ? attempt.providerEvidence.spoolReceipt
        : null
    if (receipt === null) {
        throw new QueueRepositoryError('E_QUEUE_INVALID_TRANSITION', 'Job has no spooled Provider result to discard')
    }
    const verified = await spool.verify(receipt.spoolId)
    if (canonicalSerialize(verified) !== canonicalSerialize(receipt)) {
        throw new QueueRepositoryError('E_QUEUE_WRITE_VERIFY', 'Provider spool receipt changed before discard')
    }
    const [latestJob, latestReservation, latestAttempts] = await Promise.all([
        repository.getJob(input.jobId),
        repository.getOutputReservation(input.reservationId),
        repository.listAttempts(input.jobId),
    ])
    if (latestJob === null || latestReservation === null) {
        throw new QueueRepositoryError('E_QUEUE_NOT_FOUND', 'Spooled reservation authority disappeared before discard')
    }
    assertDiscardAuthority(latestJob, latestReservation, input.reservationId)
    const latestAttempt = latestAttempts.find(candidate => candidate.attemptNumber === latestJob.attemptCount)
    const latestReceipt = latestAttempt?.providerEvidence?.dispatchState === 'result-spooled'
        ? latestAttempt.providerEvidence.spoolReceipt
        : null
    if (latestReceipt === null
        || latestJob.version !== job.version
        || canonicalSerialize(latestReservation) !== canonicalSerialize(reservation)
        || canonicalSerialize(latestReceipt) !== canonicalSerialize(receipt)) {
        throw new QueueRepositoryError('E_QUEUE_IDEMPOTENCY_CONFLICT', 'Spooled result authority changed before discard')
    }
    await spool.discard(receipt)
    // User consent names result deletion itself. Reservation release follows in a
    // separate authority, so a crash may leave a still-held reservation requiring
    // another explicit recovery, but must never delete an unverified or active result.
    return repository.abandonOutputReservation({
        reservationId: latestReservation.reservationId,
        owner: latestReservation,
        ...(latestReservation.reservationSchemaVersion === 1 ? { expectedVersion: latestReservation.version } : {}),
        now: input.now,
        discardedSpoolReceipt: receipt,
    })
}
