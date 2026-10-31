import { afterEach, describe, expect, it, vi } from 'vitest'
import { queueLivePreview } from '@/services/queue/queue-live-preview'

const job = (id: string, batchId: string) => ({ id, batchId, sceneId: 'same-scene', workflow: 'scene' as const,
    progress: { stage: 'transport', current: 0, total: 28 } })

describe('all-client queue live preview', () => {
    afterEach(() => queueLivePreview.getSnapshot().forEach(item => queueLivePreview.finish(item.jobId)))
    it('keeps concurrent agents separate and releases preview bytes on finish', () => {
        queueLivePreview.begin(job('agent-a-job', 'batch-a'))
        queueLivePreview.begin(job('agent-b-job', 'batch-b'))
        queueLivePreview.frame('agent-a-job', 'data:image/png;base64,YQ==')
        queueLivePreview.frame('agent-b-job', 'data:image/png;base64,Yg==')
        queueLivePreview.progress('agent-b-job', { stage: 'stream', current: 7, total: 28 })
        expect(queueLivePreview.getSnapshot().map(item => item.preview)).toEqual(['data:image/png;base64,YQ==', 'data:image/png;base64,Yg=='])
        queueLivePreview.finish('agent-a-job')
        queueLivePreview.frame('agent-a-job', 'data:image/png;base64,bGF0ZQ==')
        expect(queueLivePreview.getSnapshot()).toHaveLength(1)
        expect(queueLivePreview.getSnapshot()[0].progress.current).toBe(7)
    })
    it('does not notify for unchanged progress, unknown jobs or external image URLs', () => {
        queueLivePreview.begin(job('a', 'batch'))
        const listener = vi.fn()
        const unsubscribe = queueLivePreview.subscribe(listener)
        queueLivePreview.progress('a', { stage: 'transport', current: 0, total: 28 })
        queueLivePreview.frame('missing', 'data:image/png;base64,YQ==')
        queueLivePreview.frame('a', 'https://external.invalid/image.png')
        expect(listener).not.toHaveBeenCalled()
        unsubscribe()
    })
    it('coalesces a burst to the latest frame and never publishes after finish', () => {
        vi.useFakeTimers()
        try {
            queueLivePreview.begin(job('a', 'batch'))
            queueLivePreview.frame('a', 'data:image/png;base64,YQ==')
            queueLivePreview.frame('a', 'data:image/png;base64,Yg==')
            queueLivePreview.frame('a', 'data:image/png;base64,Yw==')
            expect(queueLivePreview.getSnapshot()[0].preview).toBe('data:image/png;base64,YQ==')
            vi.advanceTimersByTime(200)
            expect(queueLivePreview.getSnapshot()[0].preview).toBe('data:image/png;base64,Yw==')
            queueLivePreview.frame('a', 'data:image/png;base64,ZA==')
            queueLivePreview.finish('a')
            vi.advanceTimersByTime(200)
            expect(queueLivePreview.getSnapshot()).toHaveLength(0)
        } finally { vi.useRealTimers() }
    })
})
