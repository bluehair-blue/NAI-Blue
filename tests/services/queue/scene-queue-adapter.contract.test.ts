import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Scene Queue boundaries', () => {
    it('uses measured total batch limits instead of the former per-scene ceiling', async () => {
        const adapter = await readFile(resolve(process.cwd(), 'src/services/queue/scene-queue-adapter.ts'), 'utf8')

        expect(adapter.match(/assertGenerationAtomicBatchAvailable\(/g)).toHaveLength(3)
        expect(adapter).toContain('targets.reduce((total, target) => total + target.count, 0)')
        expect(adapter).toContain('data.review.claimCount')
        expect(adapter).not.toContain('999')
    })

    it('plans exact Scene commit sets for review and revalidates them inside the mutation gate', async () => {
        const adapter = await readFile(resolve(process.cwd(), 'src/services/queue/scene-queue-adapter.ts'), 'utf8')
        const prepareAllocation = adapter.indexOf('outputReservations.planBatch(allocationRequests)')
        const gate = adapter.indexOf('runtimeWorkspaceMutationGate.runExclusive(')
        const approvalAllocation = adapter.indexOf('outputReservations.planBatch(data.allocationRequests)')
        const commit = adapter.indexOf('createBatchAndEnqueue({')

        expect(adapter.match(/outputReservations\.planBatch\(/g)).toHaveLength(2)
        expect(prepareAllocation).toBeGreaterThan(-1)
        expect(gate).toBeGreaterThan(prepareAllocation)
        expect(approvalAllocation).toBeGreaterThan(gate)
        expect(commit).toBeGreaterThan(approvalAllocation)
        expect(adapter).toContain('if (allocation.fileName !== item.fileName)')
        expect(adapter).toContain('assertExactOutputCommitSetAllocation({')
        expect(adapter).toContain('reservationId: `output-reservation:scene-job-${requestIdentity}-${ordinal}`')
        expect(adapter).toContain('jobId: `scene-job-${requestIdentity}-${ordinal}`')
        expect(adapter).toContain("replan('commit-set-changed'")
    })

    it('delegates V1 encoding and decoding to the Scene codec', async () => {
        const [adapter, executor, outputTransaction] = await Promise.all([
            readFile(resolve(process.cwd(), 'src/services/queue/scene-queue-adapter.ts'), 'utf8'),
            readFile(resolve(process.cwd(), 'src/services/queue/scene-queue-executor.ts'), 'utf8'),
            readFile(resolve(process.cwd(), 'src/lib/scene-generation/save-scene-result.ts'), 'utf8'),
        ])

        expect(adapter).toContain('encodeSceneJobSnapshot({')
        expect(executor).toContain('decodeSceneJobSnapshot(job.snapshot)')
        expect(adapter).not.toContain('createGenerationJobSnapshot(')
        expect(adapter).not.toContain('parseSceneQueueParameters')
        expect(adapter).not.toContain('executeNovelAIImageTransport')
        expect(adapter).not.toContain('sceneEnqueueInFlight')
        expect(adapter).toContain('resolveRepositorySceneBatchTargets(sceneRepository, targets)')
        expect(adapter).toContain('folderRepository.getDocument(DEFAULT_GENERATION_FOLDER_WORKSPACE_ID)')
        expect(adapter).toContain('reviewId,')
        expect(adapter).toContain('idempotencyKey: `scene-enqueue-${data.requestIdentity}`')
        expect(executor).not.toContain('createBatchAndEnqueue')
        expect(executor).not.toMatch(/@\/stores\//)
        expect(executor).toContain('SceneResultPresentationPort')
        expect(executor).toContain('presentation: dependencies.presentation')
        expect(outputTransaction).toContain('SceneResultPresentationPort')
        expect(outputTransaction).not.toMatch(/@\/(?:components|hooks|presentation|stores)\//)
        expect(outputTransaction).not.toContain("from '@/i18n'")
    })

    it('keeps prepare read-only for Queue and presentation, then projects only after commit', async () => {
        const adapter = await readFile(resolve(process.cwd(), 'src/services/queue/scene-queue-adapter.ts'), 'utf8')
        const prepareStart = adapter.indexOf('async function prepareSceneQueueReviewOnce(')
        const approveStart = adapter.indexOf('export function enqueueReviewedSceneQueue(')
        const prepareBody = adapter.slice(prepareStart, approveStart)
        const approvalBody = adapter.slice(approveStart)

        expect(prepareBody).not.toContain('beginEnqueueOperation(')
        expect(prepareBody).not.toContain('createBatchAndEnqueue(')
        expect(prepareBody).not.toContain('consumeSceneQueueEntries(')
        expect(prepareBody).not.toContain('consumeSceneGenerationSeed(')
        expect(prepareBody).not.toContain('dehydrateGenerationParams(')
        expect(prepareBody).not.toContain('approvedAt')
        expect(approvalBody.indexOf('materializeApprovedSceneQueueResources(')).toBeLessThan(approvalBody.indexOf('runtimeWorkspaceMutationGate.runExclusive('))
        expect(approvalBody.indexOf('createBatchAndEnqueue(')).toBeLessThan(approvalBody.indexOf('consumeSceneQueueEntries('))
        expect(adapter).toContain("replan('scene-changed'")
        expect(adapter).toContain("replan('folder-changed'")
        expect(adapter).toContain("replan('pricing-changed'")
        expect(adapter).toContain("replan('runtime-limit-changed'")
    })

    it('leaves no user-facing auto-approval or coordinator drain call site', async () => {
        const sources = await Promise.all([
            'src/pages/SceneMode.tsx',
            'src/pages/SceneDetail.tsx',
            'src/pages/QueueCenter.tsx',
            'src/components/prompt/PromptGenerationControls.tsx',
            'src/services/generation/prompt-generation-command.ts',
        ].map(path => readFile(resolve(process.cwd(), path), 'utf8')))

        for (const source of sources) {
            expect(source).not.toContain('enqueueCurrentSceneQueue(')
            expect(source).not.toContain('enqueueSceneQueueTargets(')
            expect(source).not.toContain('.drain(')
        }
        expect(sources[4]).toContain("return 'review-required'")
        for (const source of sources.slice(0, 4)) expect(source).toContain('SceneQueueReviewDialog')
    })

    it('exposes a path-safe review DTO and submission-scoped duplicate approval promise', async () => {
        const adapter = await readFile(resolve(process.cwd(), 'src/services/queue/scene-queue-adapter.ts'), 'utf8')
        const reviewType = adapter.slice(adapter.indexOf('export interface SceneQueueDestinationReview {'), adapter.indexOf('declare const sceneQueueSubmissionBrand'))

        expect(reviewType).toContain('logicalFolderLabel')
        expect(reviewType).toContain('filenameSummary')
        expect(reviewType).not.toContain('directoryIdentity')
        expect(reviewType).not.toContain('directory:')
        expect(reviewType).not.toContain('credential')
        expect(adapter).toContain('sceneQueueApprovals.run(submission')
    })

    it('renders Select then Review and invalidates review when selection changes', async () => {
        const [dialog, review] = await Promise.all([
            readFile(resolve(process.cwd(), 'src/components/queue/SceneQueueSelectionDialog.tsx'), 'utf8'),
            readFile(resolve(process.cwd(), 'src/components/queue/SceneQueueReviewDialog.tsx'), 'utf8'),
        ])

        expect(dialog.match(/setPrepared\(null\)/g)?.length).toBeGreaterThanOrEqual(4)
        expect(dialog).toContain('const next = await onPrepare(selectedTargets, assessment ?? undefined)')
        expect(dialog).toContain('setPrepared(next)')
        expect(dialog).toContain('<SceneQueueReviewDialog')
        expect(review).toContain('await onApprove(prepared.submission)')
        expect(review).toContain('data-testid="scene-queue-review"')
        expect(review).toContain('shouldAcceptSceneQueueDialogOpenChange(submitting, nextOpen)')
        expect(review).toContain('if (isSceneQueueReviewConflict(error))')
        expect(review).toContain("t('queue.reviewAgain', 'Review again')")
        expect(review).toContain('onEscapeKeyDown')
        expect(review).toContain('onPointerDownOutside')
        expect(review.match(/disabled=\{submitting\}/g)?.length).toBeGreaterThanOrEqual(2)
        expect(dialog).not.toContain('drain(')
    })

    it('wires explicit replan and conflict passthrough for every review caller', async () => {
        const sources = await Promise.all([
            'src/components/queue/SceneQueueSelectionDialog.tsx',
            'src/components/prompt/PromptGenerationControls.tsx',
            'src/pages/SceneMode.tsx',
            'src/pages/SceneDetail.tsx',
            'src/pages/QueueCenter.tsx',
        ].map(path => readFile(resolve(process.cwd(), path), 'utf8')))

        for (const source of sources) expect(source).toContain('onReplan=')
        for (const source of sources.slice(1, 4)) expect(source).toContain('isSceneQueueReviewConflict(error)')
        expect(sources[4]).toContain('isSceneQueueReviewConflict)')
        expect(sources[4]).toContain('if (rethrow(error)) throw error')
    })
})
