import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import en from '@/i18n/locales/en.json'
import ja from '@/i18n/locales/ja.json'
import ko from '@/i18n/locales/ko.json'
import { calculateFixedVirtualRange } from '@/lib/virtualization/fixed-range'

const source = (path: string) => readFile(resolve(process.cwd(), path), 'utf8')

describe('Queue Center 10,000-job UI contract', () => {
    it('keeps the mounted row window bounded at the top, middle, and end', () => {
        const cases = [
            calculateFixedVirtualRange({ itemCount: 10_000, scrollTop: 0, viewportHeight: 640, rowHeight: 96, overscan: 5 }),
            calculateFixedVirtualRange({ itemCount: 10_000, scrollTop: 480_000, viewportHeight: 640, rowHeight: 96, overscan: 5 }),
            calculateFixedVirtualRange({ itemCount: 10_000, scrollTop: 960_000, viewportHeight: 640, rowHeight: 96, overscan: 5 }),
        ]
        for (const range of cases) {
            expect(range.start).toBeGreaterThanOrEqual(0)
            expect(range.end).toBeLessThanOrEqual(10_000)
            expect(range.end - range.start).toBeLessThanOrEqual(18)
        }
        expect(cases[0]).toEqual({ start: 0, end: 12 })
        expect(cases[2]).toEqual({ start: 9994, end: 10_000 })
    })

    it('uses revision-gated viewport projections, fixed virtualization, ARIA positions, and keyboard focus', async () => {
        const [page, app, layout, nav] = await Promise.all([
            source('src/pages/QueueCenter.tsx'),
            source('src/App.tsx'),
            source('src/components/layout/ThreeColumnLayout.tsx'),
            source('src/components/layout/AnimatedNavBar.tsx'),
        ])
        expect(page).toContain('getBatchProjectionMeta')
        expect(page).toContain('listJobProjectionWindow')
        expect(page).not.toContain('repository.getBatchSummary')
        expect(page).not.toContain('listJobProjections')
        expect(page).not.toContain("statusFilter === 'all' ? jobs : jobs.filter(job => job.state === statusFilter)")
        expect(page).toContain('projectionMeta.revision')
        expect(page).toContain('requestedWindow.start')
        expect(page).toContain('visibleWindowItems')
        expect(page).toContain("document.visibilityState === 'visible'")
        expect(page).toContain("document.addEventListener('visibilitychange', refreshWhenVisible)")
        expect(page).toContain('summary.states.failed > 0')
        expect(page).toContain('if (selectedBatch === null || !hasRetryableFailures) return')
        expect(page).toContain('disabled={busy || !hasRetryableFailures}')
        expect(page).not.toContain("jobs.some(job => job.state === 'failed')")
        expect(page).toContain('calculateFixedVirtualRange')
        expect(page).toContain('visibleWindowItems.map')
        expect(page).toContain('aria-setsize={filteredTotal}')
        expect(page).toContain('aria-posinset={index + 1}')
        expect(page).toContain("event.key === 'ArrowDown'")
        expect(page).toContain("event.key === 'Home'")
        expect(page).toContain('min-h-11')
        expect(app).toContain('path="/queue"')
        expect(layout).toContain("path: '/queue'")
        expect(nav).toContain("const MOBILE_PRIMARY_PATHS = new Set(['/advanced', '/scenes', '/tools', '/library'])")
    })

    it('exposes every required state plus pause, cancel, skip, retry, policy, progress, ETA, and diagnostics', async () => {
        const page = await source('src/pages/QueueCenter.tsx')
        for (const required of [
            'queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped', 'blocked',
            'pause-on-fatal', 'stop-on-first-error', 'retryFailedJobs', 'cancelBatch',
            'skipJob', 'openDrawer', 'throughput', 'eta', 'Total queue progress',
            'failureSummary',
        ]) {
            expect(page).toContain(required)
        }
        expect(page).toContain('safe-area-inset-bottom')
        expect(page).toContain('data-testid="queue-center-ready"')
        expect(page).toContain('data-testid="legacy-queue-migration"')
        expect(page).toContain('data-testid="queue-credential-required"')
        expect(page).toContain('requestTokenEntry')
        expect(page).toContain('prepareCurrentSceneQueueReview()')
        expect(page).toContain('<SceneQueueReviewDialog')
        expect(page).toContain('keeps existing item counts available for rollback')
        expect(page).toContain("t('queue.executionMode', 'Execution method')")
        expect(page).toContain("t('queue.executionCurrent', 'Durable queue')")
        expect(page).toContain("t('queue.executionPrevious', 'Existing Scene queue')")
    })

    it('maps queue runtime IDs and job controls to locale-backed user labels', async () => {
        const page = await source('src/pages/QueueCenter.tsx')

        for (const required of [
            "t('queue.workflow.main', 'Main image')",
            "t('queue.workflow.scene', 'Scene image')",
            "t('queue.stage.transport', 'Sending request')",
            "t('queue.stage.processing', 'Processing')",
            "t('queue.cancelJob', 'Cancel job')",
            "t('queue.skipJob', 'Skip job')",
            "t('queue.viewDetails', 'View details')",
            "t('queue.openJobDetails', 'Open job details')",
            "t('queue.jobActions', 'Job actions')",
            "t('queue.existingQueueTransfer', 'Existing Scene queue transfer')",
        ]) {
            expect(page).toContain(required)
        }
        expect(page).not.toContain('>{job.workflow}{job.sceneId')
        expect(page).not.toContain('{job.progress.stage} · {percent}%')
        expect(page).not.toContain('/>Cancel\n')
        expect(page).not.toContain('/>Skip\n')
        expect(page).not.toContain('/>Diagnostic\n')

        for (const locale of [en, ko, ja]) {
            expect(locale.queue).toMatchObject({
                executionCurrent: expect.any(String),
                executionPrevious: expect.any(String),
                existingQueueTransfer: expect.any(String),
                workflow: {
                    main: expect.any(String),
                    scene: expect.any(String),
                    styleLab: expect.any(String),
                },
                stage: {
                    queued: expect.any(String),
                    transport: expect.any(String),
                    stream: expect.any(String),
                    executor: expect.any(String),
                    processing: expect.any(String),
                },
            })
        }
        expect(en.queue.executionCurrent).toBe('Durable queue')
        expect(en.queue.executionPrevious).toBe('Existing Scene queue')
        expect(en.queue.legacyPending).not.toMatch(/legacy|durable/i)
    })
})
