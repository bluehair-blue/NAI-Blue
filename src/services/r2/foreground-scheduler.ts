import { create } from 'zustand'

import type { R2ProfileV2 } from '@/domain/r2/types'
import { reportDiagnostic } from '@/services/diagnostics/error-registry'
import { R2UploadRepositoryError, type IndexedDBR2UploadRepository } from './indexeddb-r2-upload-repository'
import type { R2UploadCoordinator } from './r2-upload-coordinator'

/** Ephemeral scheduler health only; durable upload outcomes remain in the existing repository. */
export interface R2ForegroundState {
    readonly status: 'stopped' | 'running' | 'retrying'
    readonly blockedJobIds: readonly string[]
    readonly faultedJobIds: readonly string[]
    readonly diagnosticEventId: string | null
}

export const useR2ForegroundState = create<R2ForegroundState>(() => ({
    status: 'stopped', blockedJobIds: [], faultedJobIds: [], diagnosticEventId: null,
}))

interface ForegroundDependencies {
    readonly repository: Pick<IndexedDBR2UploadRepository, 'listJobs' | 'getProfile' | 'updateJob'>
    readonly coordinator: Pick<R2UploadCoordinator, 'recoverAfterRestart' | 'runJob'>
    readonly credentialStatus: (reference: string) => Promise<{ available: boolean }>
    readonly isCancelled: () => boolean
    readonly wait: () => Promise<void>
    readonly onState: (state: R2ForegroundState) => void
    readonly now?: () => number
}

/** Foreground polling resumes repository faults and gates each Phase 7 job by its immutable binding. */
export async function runR2ForegroundScheduler(dependencies: ForegroundDependencies): Promise<void> {
    const { repository, coordinator, credentialStatus, isCancelled, wait, onState } = dependencies
    const now = dependencies.now ?? Date.now
    let recovered = false
    // A thrown invocation has ended; only its own interrupted running job may be reclaimed next pass.
    const interruptedJobs = new Set<string>()
    const diagnostics = new Map<string, string>()
    const diagnose = (key: string, error: unknown, jobId?: string) => {
        if (!diagnostics.has(key)) diagnostics.set(key, reportDiagnostic(error, {
            operation: 'r2.foreground-resume', stage: jobId ? 'job' : 'scheduler', jobId,
        }).eventId)
        return diagnostics.get(key)!
    }
    while (!isCancelled()) {
        const blockedJobIds: string[] = []
        const faultedJobIds: string[] = []
        try {
            if (!recovered) {
                await coordinator.recoverAfterRestart()
                recovered = true
            }
            const jobs = await repository.listJobs()
            diagnostics.delete('scheduler')
            for (let job of jobs) {
                if (isCancelled()) break
                if (['succeeded', 'failed', 'cancelled'].includes(job.state)) {
                    interruptedJobs.delete(job.id)
                    diagnostics.delete(job.id)
                    continue
                }
                if (job.state === 'running' && !interruptedJobs.has(job.id)) continue
                if (Date.parse(job.nextAttemptAt) > now()) continue
                let executing = false
                try {
                    if (job.state === 'running') {
                        job = await repository.updateJob(job.id, job.version, { state: 'queued' })
                    }
                    const profile: R2ProfileV2 | null = job.contractVersion === 'phase7-v1'
                        ? job.profileSnapshot
                        : await repository.getProfile(job.profileId)
                    // Verified/linking stages need local Artifact access, not a credential or remote request.
                    const needsCredential = job.state !== 'verified' && job.state !== 'linking'
                    if (!profile || profile.transport !== 'native-s3'
                        || (needsCredential && !(await credentialStatus(profile.credentialRef)).available)) {
                        blockedJobIds.push(job.id)
                        diagnostics.delete(job.id)
                        continue
                    }
                    if (isCancelled()) break
                    executing = true
                    await coordinator.runJob(profile, job)
                    interruptedJobs.delete(job.id)
                    diagnostics.delete(job.id)
                } catch (error) {
                    if (error instanceof R2UploadRepositoryError && error.code === 'E_R2_VERSION_CONFLICT') continue
                    if (executing) interruptedJobs.add(job.id)
                    faultedJobIds.push(job.id)
                    diagnose(job.id, error, job.id)
                }
            }
            if (!isCancelled()) onState({
                status: 'running', blockedJobIds, faultedJobIds,
                diagnosticEventId: faultedJobIds.length ? diagnostics.get(faultedJobIds[0]!) ?? null : null,
            })
        } catch (error) {
            if (!isCancelled()) onState({
                status: 'retrying', blockedJobIds, faultedJobIds,
                diagnosticEventId: diagnose('scheduler', error),
            })
        }
        if (!isCancelled()) await wait()
    }
}
