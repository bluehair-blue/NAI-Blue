import type {
    ExactOutputReservationIdentity,
    OutputRecoveryResult,
    OutputWriteResult,
    OutputWriter,
} from '@/services/output/output-writer'
import type { GenerationJob } from '@/domain/queue/types'
import { publishGeneratedArtifact } from '@/stores/artifact-lifecycle-store'
import { assertFilesCommittedRecoveryEligibility, type IndexedDBQueueRepository } from './indexeddb-queue-repository'
import {
    registerQueueArtifact,
    rollbackQueueArtifactRegistration,
    type QueueArtifactRepository,
} from './queue-artifact-lineage'

export type TargetedQueueOutputRetryResult =
    | { readonly status: 'ready' }
    | { readonly status: 'missing-job' }
    | { readonly status: 'unbound-job' }
    | { readonly status: 'missing-journal' }
    | { readonly status: 'ineligible'; readonly reason: OutputRecoveryResult['ineligibility'] }
    | { readonly status: 'failed'; readonly message: string }

type QueueOutputRecoveryRepository = Pick<
    IndexedDBQueueRepository,
    'initialize' | 'getJob' | 'getOutputReservation' | 'recoverFilesCommittedSuccess' | 'listAttempts'
>

/** Queue snapshot, reservation row, and journal must name one exact owner and destination. */
export async function verifyRecoveryReservation(
    repository: Pick<QueueOutputRecoveryRepository, 'getOutputReservation'>,
    job: GenerationJob,
    journal?: { inspected: true; reservation?: ExactOutputReservationIdentity },
): Promise<ExactOutputReservationIdentity | undefined> {
    const snapshot = job.snapshot.outputReservation
    if (snapshot === undefined) {
        if (journal?.reservation !== undefined) throw new Error('Output journal has no Queue reservation owner')
        return undefined
    }
    const reservation = await repository.getOutputReservation(snapshot.reservationId)
    const expectedState = job.state === 'succeeded' ? 'committed' : 'writing'
    if (reservation === null
        || reservation.batchId !== job.batchId
        || reservation.jobId !== job.id
        || reservation.reservationId !== snapshot.reservationId
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
            && (snapshot.reservationSchemaVersion !== 1
                || reservation.commitSetHash !== snapshot.commitSetHash))
        || reservation.state !== expectedState) {
        throw new Error('Queue output reservation owner, destination, or state changed')
    }
    const expected = {
        reservationId: snapshot.reservationId,
        directoryIdentity: snapshot.directoryIdentity,
        relativePath: snapshot.relativePath,
        ...(snapshot.reservationSchemaVersion === 1
            ? { commitSet: snapshot.commitSet, commitSetHash: snapshot.commitSetHash }
            : {}),
    } satisfies ExactOutputReservationIdentity
    if (journal?.inspected === true
        && (journal.reservation === undefined
            || journal.reservation.reservationId !== expected.reservationId
            || journal.reservation.directoryIdentity !== expected.directoryIdentity
            || journal.reservation.relativePath !== expected.relativePath
            || journal.reservation.commitSetHash !== expected.commitSetHash)) {
        throw new Error('Output journal reservation does not match Queue authority')
    }
    return expected
}

/** Retries one explicitly bound Queue journal without scanning or draining other work. */
export async function retryQueueLinkedOutput(
    repository: QueueOutputRecoveryRepository,
    writer: OutputWriter,
    options: { jobId: string; now: string; artifactRepository?: QueueArtifactRepository },
): Promise<TargetedQueueOutputRetryResult> {
    await repository.initialize()
    const job = await repository.getJob(options.jobId)
    if (job === null) return { status: 'missing-job' }
    if (job.outputTransactionId === null || job.artifactReference === null) return { status: 'unbound-job' }

    const outputTransactionId = job.outputTransactionId
    const artifactReference = job.artifactReference
    let reservation: ExactOutputReservationIdentity | undefined
    try {
        const attempts = await repository.listAttempts(job.id)
        assertFilesCommittedRecoveryEligibility(
            job, attempts.find(attempt => attempt.attemptNumber === job.attemptCount) ?? null, options.now, true,
        )
        reservation = await verifyRecoveryReservation(repository, job)
    } catch (error) {
        return { status: 'failed', message: error instanceof Error ? error.message : 'Output reservation validation failed' }
    }
    const commitWorkflow = async (output: OutputWriteResult) => {
        const registration = await registerQueueArtifact(
            job,
            artifactReference,
            output,
            options.artifactRepository,
        )
        try {
            await repository.recoverFilesCommittedSuccess({
                jobId: job.id,
                now: options.now,
                outputTransactionId,
                artifactReference,
                expectedAttemptCount: job.attemptCount,
                rejectActiveLease: true,
            })
        } catch (error) {
            await rollbackQueueArtifactRegistration(registration, options.artifactRepository)
            throw error
        }
        publishGeneratedArtifact({
            path: output.path,
            ...(registration === null
                ? {}
                : {
                    artifactId: registration.record.artifactId,
                    sourceJobId: job.id,
                    ...(job.sceneId === null ? {} : { sourceSceneId: job.sceneId }),
                }),
        })
    }
    const recovery = reservation === undefined
        ? await writer.retryFilesCommittedWorkflow(outputTransactionId, job.id, commitWorkflow)
        : await writer.retryFilesCommittedWorkflow(outputTransactionId, job.id, commitWorkflow, reservation)
    if (recovery.action === 'retried') return { status: 'ready' }
    if (recovery.action === 'missing') return { status: 'missing-journal' }
    if (recovery.action === 'ineligible') {
        return { status: 'ineligible', reason: recovery.ineligibility ?? 'phase-not-files-committed' }
    }
    return { status: 'failed', message: recovery.error ?? 'Output storage retry did not complete.' }
}

/**
 * Reconciles queue-owned OutputWriter journals before generic journal rollback
 * and before expired-lease recovery. Ownership comes only from the journal's
 * sourceJobId plus the job's pre-bound transaction/artifact pair; an output
 * path is never treated as proof of success.
 */
export async function recoverQueueLinkedOutputs(
    repository: IndexedDBQueueRepository,
    writer: OutputWriter,
    options: { now: string; artifactRepository?: QueueArtifactRepository },
): Promise<OutputRecoveryResult[]> {
    await repository.initialize()
    const links = await writer.inspectPendingQueueTransactions()
    const results: OutputRecoveryResult[] = []
    for (const link of links) {
        const job = await repository.getJob(link.sourceJobId)
        const ownsTransaction = job !== null
            && job.outputTransactionId === link.transactionId
            && job.artifactReference !== null
        if (link.phase === 'files-committed' && ownsTransaction) {
            const artifactReference = job.artifactReference
            let reservation: ExactOutputReservationIdentity | undefined
            try {
                const attempts = await repository.listAttempts(job.id)
                assertFilesCommittedRecoveryEligibility(
                    job, attempts.find(attempt => attempt.attemptNumber === job.attemptCount) ?? null, options.now,
                )
                reservation = await verifyRecoveryReservation(repository, job, {
                    inspected: true,
                    ...(link.outputReservation === undefined ? {} : { reservation: link.outputReservation }),
                })
            } catch (error) {
                results.push({
                    transactionId: link.transactionId,
                    action: 'failed',
                    error: error instanceof Error ? error.message : 'Output reservation validation failed',
                })
                continue
            }
            const commitWorkflow = async (output: OutputWriteResult) => {
                    // A files-committed journal may survive a process restart. Register
                    // the same immutable artifact before terminalizing the Job so recovery
                    // cannot create an artifact-less Queue success.
                    const registration = await registerQueueArtifact(
                        job,
                        artifactReference,
                        output,
                        options.artifactRepository,
                    )
                    try {
                        await repository.recoverFilesCommittedSuccess({
                            jobId: job.id,
                            now: options.now,
                            outputTransactionId: link.transactionId,
                            artifactReference,
                            expectedAttemptCount: job.attemptCount,
                        })
                    } catch (error) {
                        await rollbackQueueArtifactRegistration(registration, options.artifactRepository)
                        throw error
                    }
                    publishGeneratedArtifact({
                        path: output.path,
                        ...(registration === null
                            ? {}
                            : {
                                artifactId: registration.record.artifactId,
                                sourceJobId: job.id,
                                ...(job.sceneId === null ? {} : { sourceSceneId: job.sceneId }),
                            }),
                    })
            }
            results.push(reservation === undefined
                ? await writer.retryFilesCommittedWorkflow(link.transactionId, job.id, commitWorkflow)
                : await writer.retryFilesCommittedWorkflow(link.transactionId, job.id, commitWorkflow, reservation))
            continue
        }
        results.push(await writer.recoverTransaction(link.transactionId, { mode: 'rollback' }))
    }
    return results
}
