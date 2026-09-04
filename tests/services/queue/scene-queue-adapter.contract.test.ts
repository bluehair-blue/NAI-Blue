import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Scene Queue boundaries', () => {
    it('uses measured total batch limits instead of the former per-scene ceiling', async () => {
        const adapter = await readFile(resolve(process.cwd(), 'src/services/queue/scene-queue-adapter.ts'), 'utf8')

        expect(adapter.match(/assertGenerationAtomicBatchAvailable\(/g)).toHaveLength(3)
        expect(adapter).toContain('targets.reduce((total, target) => total + target.count, 0)')
        expect(adapter).toContain('reservation.commitSet.claims.length')
        expect(adapter).not.toContain('999')
    })

    it('plans all exact Scene commit sets once after the early limit guard', async () => {
        const adapter = await readFile(resolve(process.cwd(), 'src/services/queue/scene-queue-adapter.ts'), 'utf8')
        const earlyLimit = adapter.indexOf('assertGenerationAtomicBatchAvailable(prepared.length, plannedClaimCount')
        const allocation = adapter.indexOf('outputReservations.planBatch(allocationRequests)')

        expect(adapter.match(/outputReservations\.planBatch\(/g)).toHaveLength(1)
        expect(earlyLimit).toBeGreaterThan(-1)
        expect(allocation).toBeGreaterThan(earlyLimit)
        expect(adapter).toContain('if (allocation.fileName !== item.fileName)')
        expect(adapter).toContain('assertExactOutputCommitSetAllocation({')
        expect(adapter).toContain('reservationId: `output-reservation:scene-job-${requestIdentity}-${ordinal}`')
        expect(adapter).toContain('jobId: `scene-job-${requestIdentity}-${ordinal}`')
        expect(adapter).toContain('const { commitSet, commitSetHash } = allocation')
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
        expect(adapter).toContain('enqueueOperationId: operationId')
        expect(adapter).toContain('idempotencyKey: `scene-enqueue-${requestIdentity}`')
        expect(executor).not.toContain('createBatchAndEnqueue')
        expect(executor).not.toMatch(/@\/stores\//)
        expect(executor).toContain('SceneResultPresentationPort')
        expect(executor).toContain('presentation: dependencies.presentation')
        expect(outputTransaction).toContain('SceneResultPresentationPort')
        expect(outputTransaction).not.toMatch(/@\/(?:components|hooks|presentation|stores)\//)
        expect(outputTransaction).not.toContain("from '@/i18n'")
    })
})
