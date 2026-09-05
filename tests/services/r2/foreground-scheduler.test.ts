import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'

import { createR2ProfileV2, type R2ProfileV2, type UploadJob } from '@/domain/r2/types'
import { reportDiagnostic } from '@/services/diagnostics/error-registry'
import { IndexedDBArtifactRepository } from '@/services/organizer/artifact-repository'
import { runR2ForegroundScheduler, type R2ForegroundState } from '@/services/r2/foreground-scheduler'
import { createUploadJob, IndexedDBR2UploadRepository, R2UploadRepositoryError } from '@/services/r2/indexeddb-r2-upload-repository'
import type { NativeR2UploadAdapter } from '@/services/r2/native-r2-adapter'
import { R2UploadCoordinator } from '@/services/r2/r2-upload-coordinator'

vi.mock('@/services/diagnostics/error-registry', () => ({
    reportDiagnostic: vi.fn(() => ({ eventId: 'diagnostic-fixture' })),
}))

const NOW = '2026-09-05T00:00:00.000Z'
const profile = (credentialRef = 'credential-original'): R2ProfileV2 => createR2ProfileV2({
    id: 'same-profile', name: 'Fixture', accountId: 'account', jurisdiction: null, endpoint: null,
    bucket: 'fixture-bucket', prefix: '', credentialRef, transport: 'native-s3', conflictPolicy: 'fail',
    publicMode: 'private', publicBaseUrl: null,
}, NOW)

function job(id: string, snapshot = profile()): UploadJob {
    return createUploadJob(snapshot.id, {
        artifactId: id, localVariant: `C:/fixture/${id}.png`, remoteKey: `${id}.png`,
        contentSha256: `sha256:${'a'.repeat(64)}`, contentType: 'image/png', size: 12,
    }, {
        id, now: NOW, profileSnapshot: snapshot,
        artifactBinding: { artifactId: id, artifactVersion: 1, localVariant: 'original' },
    })
}

type Dependencies = Parameters<typeof runR2ForegroundScheduler>[0]

async function passes(dependencies: Pick<Dependencies, 'repository' | 'coordinator' | 'credentialStatus'>, count = 1) {
    const states: R2ForegroundState[] = []
    let completed = 0
    await runR2ForegroundScheduler({
        ...dependencies, now: () => Date.parse(NOW),
        isCancelled: () => completed >= count,
        wait: async () => { completed += 1 },
        onState: state => states.push(state),
    })
    return states
}

function dependencies(jobs: UploadJob[]) {
    return {
        repository: {
            listJobs: vi.fn(async () => jobs),
            getProfile: vi.fn(async () => profile('credential-changed')),
            updateJob: vi.fn(async (id: string, _version: number, patch: Partial<UploadJob>) => {
                const index = jobs.findIndex(item => item.id === id)
                jobs[index] = { ...jobs[index]!, ...patch, version: jobs[index]!.version + 1 }
                return jobs[index]!
            }),
        },
        coordinator: { recoverAfterRestart: vi.fn(async () => 0), runJob: vi.fn(async () => undefined) },
        credentialStatus: vi.fn(async (reference: string) => ({ available: reference === 'credential-original' })),
    }
}

describe('foreground R2 scheduler', () => {
    it.each(['changed', 'deleted'])('completes a snapshotted job after its current profile is %s', async change => {
        const factory = new IDBFactory() as unknown as globalThis.IDBFactory
        const options = { factory, keyRange: IDBKeyRange as unknown as typeof globalThis.IDBKeyRange }
        const artifacts = new IndexedDBArtifactRepository({ ...options, databaseName: `artifact-${change}` })
        const repository = new IndexedDBR2UploadRepository({ ...options, databaseName: `r2-${change}`, artifactReader: artifacts })
        const queued = job('delivered')
        await artifacts.putOriginal({
            artifactId: queued.artifactId,
            file: { directory: { kind: 'standard', root: 'app-data', segments: ['outputs'] }, fileName: 'delivered.png' },
            format: 'png', contentChecksum: queued.contentSha256, size: queued.size, createdAt: NOW,
        })
        await repository.enqueue([queued])
        if (change === 'changed') await repository.putProfile(profile('credential-changed'), null)
        // Absence represents deletion: Phase 7 no longer needs this mutable profile row at all.
        const getProfile = vi.spyOn(repository, 'getProfile')
        let uploaded = false
        const adapter: NativeR2UploadAdapter = {
            headObject: vi.fn(async () => uploaded
                ? { exists: true, contentSha256: queued.contentSha256, size: queued.size, etag: null }
                : { exists: false, contentSha256: null, size: null, etag: null }),
            putObject: vi.fn(async () => {
                uploaded = true
                return { remoteKey: queued.remoteKey, uploaded: true, skippedSame: false, etag: null }
            }),
            createMultipart: vi.fn(), uploadPart: vi.fn(), completeMultipart: vi.fn(), abortMultipart: vi.fn(),
        }
        const credentialStatus = vi.fn(async (reference: string) => ({ available: reference === 'credential-original' }))
        await passes({
            repository, coordinator: new R2UploadCoordinator(repository, adapter, () => new Date(NOW), artifacts), credentialStatus,
        })
        expect(getProfile).not.toHaveBeenCalled()
        expect(credentialStatus).toHaveBeenCalledExactlyOnceWith('credential-original')
        expect(adapter.putObject).toHaveBeenCalledWith(profile(), expect.objectContaining({ id: queued.id }))
        expect(await repository.getJob(queued.id)).toMatchObject({ state: 'succeeded' })
        expect((await artifacts.get(queued.artifactId))?.remoteObjectRefs).toHaveLength(1)
    })

    it('isolates unready and faulting credentials from another job under the same profile ID', async () => {
        const ready = job('ready')
        const deps = dependencies([job('unready', profile('missing')), job('vault-fault', profile('fault')), ready])
        deps.credentialStatus.mockImplementation(async reference => {
            if (reference === 'fault') throw new Error('vault temporarily unavailable')
            return { available: reference === 'credential-original' }
        })
        const states = await passes(deps, 2)
        expect(deps.coordinator.runJob).toHaveBeenCalledTimes(2)
        expect(deps.coordinator.runJob).toHaveBeenCalledWith(ready.profileSnapshot, ready)
        expect(states[0]).toMatchObject({ status: 'running', blockedJobIds: ['unready'], faultedJobIds: ['vault-fault'] })
        expect(reportDiagnostic).toHaveBeenCalledTimes(1)
    })

    it('projects repository interruption and automatically resumes on a later foreground pass', async () => {
        const deps = dependencies([job('ready')])
        deps.repository.listJobs.mockRejectedValueOnce(new Error('database unavailable'))
            .mockRejectedValueOnce(new Error('database still unavailable'))
        const states = await passes(deps, 3)
        expect(states.map(state => state.status)).toEqual(['retrying', 'retrying', 'running'])
        expect(reportDiagnostic).toHaveBeenCalledTimes(1)
        expect(deps.coordinator.recoverAfterRestart).toHaveBeenCalledTimes(1)
        expect(deps.coordinator.runJob).toHaveBeenCalledTimes(1)
    })

    it('retries interrupted startup recovery before dispatching any jobs', async () => {
        const deps = dependencies([job('ready')])
        deps.coordinator.recoverAfterRestart.mockRejectedValueOnce(new Error('database blocked'))
        const states = await passes(deps, 2)
        expect(states.map(state => state.status)).toEqual(['retrying', 'running'])
        expect(deps.coordinator.recoverAfterRestart).toHaveBeenCalledTimes(2)
        expect(deps.coordinator.runJob).toHaveBeenCalledTimes(1)
    })

    it('reclaims only its own failed invocation and continues independent jobs', async () => {
        const jobs = [job('interrupted'), job('other')]
        const deps = dependencies(jobs)
        deps.coordinator.runJob.mockImplementationOnce(async () => {
            jobs[0] = { ...jobs[0]!, state: 'running', version: 2 }
            throw new Error('repository unavailable after marking running')
        })
        const states = await passes(deps, 2)
        expect(states[0]).toMatchObject({ status: 'running', faultedJobIds: ['interrupted'] })
        expect(states[1]).toMatchObject({ status: 'running', faultedJobIds: [] })
        expect(deps.repository.updateJob).toHaveBeenCalledExactlyOnceWith('interrupted', 2, { state: 'queued' })
        expect(deps.coordinator.runJob).toHaveBeenCalledTimes(4)
    })

    it('resumes local linkage without a credential and retains legacy profile lookup', async () => {
        const linking = { ...job('linking', profile('missing')), state: 'linking' as const }
        const legacy = { ...job('legacy'), contractVersion: 'legacy-v1' as const, profileSnapshot: null }
        const deps = dependencies([linking, legacy])
        const states = await passes(deps)
        expect(deps.credentialStatus).toHaveBeenCalledExactlyOnceWith('credential-changed')
        expect(deps.repository.getProfile).toHaveBeenCalledExactlyOnceWith(legacy.profileId)
        expect(deps.coordinator.runJob).toHaveBeenCalledExactlyOnceWith(linking.profileSnapshot, linking)
        expect(states[0]?.blockedJobIds).toEqual(['legacy'])
    })

    it('does not execute terminal, deferred, externally running or version-conflicted jobs', async () => {
        const deps = dependencies([
            { ...job('done'), state: 'succeeded' }, { ...job('active'), state: 'running' },
            { ...job('future'), nextAttemptAt: '2026-09-06T00:00:00.000Z' }, job('stale'),
        ])
        deps.coordinator.runJob.mockRejectedValueOnce(new R2UploadRepositoryError('E_R2_VERSION_CONFLICT', 'changed'))
        const states = await passes(deps)
        expect(deps.coordinator.runJob).toHaveBeenCalledTimes(1)
        expect(deps.repository.updateJob).not.toHaveBeenCalled()
        expect(reportDiagnostic).not.toHaveBeenCalled()
        expect(states[0]?.faultedJobIds).toEqual([])
    })
})
