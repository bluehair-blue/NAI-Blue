import type { GenerationJob, GenerationJobProgress } from '@/domain/queue/types'

export interface LiveQueuePreview {
    readonly jobId: string
    readonly batchId: string
    readonly sceneId: string | null
    readonly workflow: GenerationJob['workflow']
    readonly progress: GenerationJobProgress
    readonly preview: string | null
}

const EMPTY: readonly LiveQueuePreview[] = Object.freeze([])
let snapshot = EMPTY
const listeners = new Set<() => void>()
const frameTimers = new Map<string, ReturnType<typeof setTimeout>>()
const pendingFrames = new Map<string, string>()
const frameTimes = new Map<string, number>()
const FRAME_INTERVAL_MS = 200

function publishFrame(jobId: string, preview: string): void {
    const current = snapshot.find(item => item.jobId === jobId)
    if (!current || current.preview === preview) return
    frameTimes.set(jobId, Date.now())
    publish(snapshot.map(item => item === current ? { ...item, preview } : item))
}

/** Memory-only, per-job projection shared by every Queue client and route.
 * Provider frames never enter persistence, command receipts or authoring stores.
 * Leases bound the number of frames retained; finish releases each job's bytes.
 */
function publish(next: readonly LiveQueuePreview[]): void {
    snapshot = next
    for (const listener of listeners) listener()
}

export const queueLivePreview = {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => EMPTY,
    subscribe(listener: () => void) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
    },
    begin(job: Pick<GenerationJob, 'id' | 'batchId' | 'sceneId' | 'workflow' | 'progress'>) {
        clearTimeout(frameTimers.get(job.id))
        frameTimers.delete(job.id)
        pendingFrames.delete(job.id)
        frameTimes.delete(job.id)
        publish([...snapshot.filter(item => item.jobId !== job.id), {
            jobId: job.id, batchId: job.batchId, sceneId: job.sceneId,
            workflow: job.workflow, progress: job.progress, preview: null,
        }])
    },
    progress(jobId: string, progress: GenerationJobProgress) {
        const current = snapshot.find(item => item.jobId === jobId)
        if (!current || (current.progress.stage === progress.stage
            && current.progress.current === progress.current && current.progress.total === progress.total)) return
        publish(snapshot.map(item => item === current ? { ...item, progress } : item))
    },
    frame(jobId: string, preview: string | undefined) {
        if (!preview || !/^data:image\/(?:png|jpeg|webp);base64,/u.test(preview)) return
        const current = snapshot.find(item => item.jobId === jobId)
        if (!current || current.preview === preview) return
        const elapsed = Date.now() - (frameTimes.get(jobId) ?? 0)
        if (elapsed >= FRAME_INTERVAL_MS) {
            clearTimeout(frameTimers.get(jobId))
            frameTimers.delete(jobId)
            pendingFrames.delete(jobId)
            publishFrame(jobId, preview)
            return
        }
        // Keep only the latest pending frame, never a backlog of image strings.
        pendingFrames.set(jobId, preview)
        if (!frameTimers.has(jobId)) frameTimers.set(jobId, setTimeout(() => {
            frameTimers.delete(jobId)
            const latest = pendingFrames.get(jobId)
            pendingFrames.delete(jobId)
            if (latest) publishFrame(jobId, latest)
        }, FRAME_INTERVAL_MS - elapsed))
    },
    finish(jobId: string) {
        clearTimeout(frameTimers.get(jobId))
        frameTimers.delete(jobId)
        pendingFrames.delete(jobId)
        frameTimes.delete(jobId)
        if (snapshot.some(item => item.jobId === jobId)) publish(snapshot.filter(item => item.jobId !== jobId))
    },
}
