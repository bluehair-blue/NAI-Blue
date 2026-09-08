import { useEffect, useState } from 'react'

import type { GenerationBatch, GenerationJob, GenerationJobState } from '@/domain/queue/types'
import { getRuntimeQueueRepository } from '@/services/queue/indexeddb-queue-repository'
import { decodeSceneJobSnapshot } from '@/services/queue/scene-job-snapshot-codec'

export interface FolderQueueJob {
    readonly key: string
    readonly batchId: string
    readonly queueSequence: number
    readonly state: GenerationJobState
}

export interface FolderQueueActivity {
    readonly state: GenerationJobState
    readonly unfinished: number
}

const UNFINISHED = new Set<GenerationJobState>(['queued', 'leased', 'running', 'blocked', 'recovering'])

/** Snapshot identity prevents imported duplicate Scene IDs from receiving another preset's status. */
export function projectFolderQueueJob(job: GenerationJob, batch: GenerationBatch): FolderQueueJob | null {
    if (job.workflow !== 'scene') return null
    try {
        const { sceneWorkflow } = decodeSceneJobSnapshot(job.snapshot)
        if (sceneWorkflow.scene.id !== job.sceneId) return null
        return {
            key: JSON.stringify([sceneWorkflow.saveContext.activePresetId, sceneWorkflow.scene.id]),
            batchId: job.batchId, queueSequence: batch.queueSequence, state: job.state,
        }
    } catch {
        // Invalid snapshots remain visible in Queue Center; never guess their destination Scene.
        return null
    }
}

/** Active work across runs takes precedence; otherwise show the newest run, not an old failure. */
export function collectFolderQueueActivity(jobs: readonly FolderQueueJob[]): Map<string, FolderQueueActivity> {
    const grouped = new Map<string, FolderQueueJob[]>()
    for (const job of jobs) {
        const group = grouped.get(job.key) ?? []
        group.push(job)
        grouped.set(job.key, group)
    }
    return new Map([...grouped].map(([key, group]) => {
        const unfinished = group.filter(job => UNFINISHED.has(job.state))
        const newestSequence = group.reduce((newest, job) => Math.max(newest, job.queueSequence), -Infinity)
        const relevant = unfinished.length > 0 ? unfinished : group.filter(job => job.queueSequence === newestSequence)
        const states = new Set(relevant.map(job => job.state))
        const state: GenerationJobState = states.has('running') || states.has('leased') ? 'running'
            : states.has('recovering') ? 'recovering'
                : states.has('blocked') ? 'blocked'
                    : states.has('queued') ? 'queued'
                        : states.has('failed') ? 'failed'
                            : states.has('cancelled') ? 'cancelled'
                                : states.has('skipped') ? 'skipped' : 'succeeded'
        return [key, { state, unfinished: unfinished.length }]
    }))
}

type FolderQueueRepository = Pick<ReturnType<typeof getRuntimeQueueRepository>, 'listBatches' | 'listJobs'>

/** Cache only read projections. Durable batch revisions invalidate them without retaining snapshots. */
export function createFolderQueueActivityReader(repository: FolderQueueRepository) {
    let cache = new Map<string, { revision: number; jobs: FolderQueueJob[] }>()
    let activity = new Map<string, FolderQueueActivity>()
    return async (): Promise<Map<string, FolderQueueActivity>> => {
        const batches = (await repository.listBatches()).filter(batch => batch.workflow === 'scene')
        const nextCache = new Map(cache)
        const ids = new Set(batches.map(batch => batch.id))
        let changed = false
        for (const id of cache.keys()) if (!ids.has(id)) { nextCache.delete(id); changed = true }
        for (const batch of batches) {
            if (cache.get(batch.id)?.revision === batch.projectionRevision) continue
            const jobs: FolderQueueJob[] = []
            let cursor: string | null = null
            do {
                const page = await repository.listJobs({ batchId: batch.id, cursor, limit: 250 })
                for (const job of page.items) {
                    const projected = projectFolderQueueJob(job, batch)
                    if (projected) jobs.push(projected)
                }
                cursor = page.nextCursor
            } while (cursor !== null)
            nextCache.set(batch.id, { revision: batch.projectionRevision, jobs })
            changed = true
        }
        if (changed) {
            activity = collectFolderQueueActivity([...nextCache.values()].flatMap(value => value.jobs))
            cache = nextCache
        }
        return activity
    }
}

/** Match Queue Center's visible-tab polling; route changes never start or control execution. */
export function useFolderQueueActivity() {
    const [activity, setActivity] = useState(new Map<string, FolderQueueActivity>())
    const [unavailable, setUnavailable] = useState(false)
    useEffect(() => {
        const read = createFolderQueueActivityReader(getRuntimeQueueRepository())
        let disposed = false
        let reading = false
        const refresh = async () => {
            if (disposed || reading || document.visibilityState !== 'visible') return
            reading = true
            try {
                const next = await read()
                if (!disposed) { setActivity(next); setUnavailable(false) }
            } catch {
                if (!disposed) setUnavailable(true)
            } finally { reading = false }
        }
        void refresh()
        const interval = window.setInterval(() => { void refresh() }, 1_000)
        const onVisible = () => { void refresh() }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
            disposed = true
            window.clearInterval(interval)
            document.removeEventListener('visibilitychange', onVisible)
        }
    }, [])
    return { activity, unavailable }
}
