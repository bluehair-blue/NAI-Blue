import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('generation-folder workspace mutation integration', () => {
    it('keeps Main planning outside and only final authority checks plus Queue commit inside its gate', async () => {
        const source = await readFile(resolve(process.cwd(), 'src/services/queue/main-queue-adapter.ts'), 'utf8')
        const allocation = source.indexOf('outputReservations.planBatch(allocationRequests)')
        const gate = source.lastIndexOf('runtimeWorkspaceMutationGate.runExclusive(')
        const enqueue = source.indexOf('getRuntimeQueueRepository().createBatchAndEnqueue', gate)
        const guarded = source.slice(gate, enqueue)

        expect(allocation).toBeGreaterThan(-1)
        expect(gate).toBeGreaterThan(allocation)
        expect(enqueue).toBeGreaterThan(gate)
        expect(guarded).not.toMatch(/executeNovelAIImageTransport|drainQueue|prepareBatch|planBatch\(/)
    })

    it('revalidates the reviewed Scene commit set inside its gate before Queue commit', async () => {
        const source = await readFile(resolve(process.cwd(), 'src/services/queue/scene-queue-adapter.ts'), 'utf8')
        const gate = source.lastIndexOf('runtimeWorkspaceMutationGate.runExclusive(')
        const revalidation = source.indexOf('outputReservations.planBatch(data.allocationRequests)', gate)
        const enqueue = source.indexOf('getRuntimeQueueRepository().createBatchAndEnqueue', gate)
        const guarded = source.slice(gate, enqueue)

        expect(revalidation).toBeGreaterThan(gate)
        expect(enqueue).toBeGreaterThan(revalidation)
        expect(guarded).not.toMatch(/executeNovelAIImageTransport|drainQueue|prepareBatch\(/)
    })

    it('uses the same whole-document key for Folder, Main, Scene enqueue, and Scene CAS', async () => {
        const sources = await Promise.all([
            'src/application/folder/apply-folder-changes.ts',
            'src/services/queue/main-queue-adapter.ts',
            'src/services/queue/scene-queue-adapter.ts',
            'src/adapters/scene/indexeddb-scene-repository.ts',
        ].map(path => readFile(resolve(process.cwd(), path), 'utf8')))

        for (const source of sources) {
            expect(source).toContain('generationFolderDocumentMutationKey(')
        }
        expect(sources[0]).toContain('input.mutationGate.runExclusive')
        for (const source of sources.slice(1)) expect(source).toContain('runtimeWorkspaceMutationGate')
    })

    it('routes manual Folder commands through guarded apply and leaves no unsafe runtime commit API', async () => {
        const [store, runtime] = await Promise.all([
            readFile(resolve(process.cwd(), 'src/stores/settings-store.ts'), 'utf8'),
            readFile(resolve(process.cwd(), 'src/lib/generation-folder-authority-runtime.ts'), 'utf8'),
        ])

        expect(store).toContain('await applyRuntimeGenerationFolderChanges({')
        expect(store).not.toContain('commitAuthorityDocument')
        expect(runtime).not.toMatch(/\n\s+commit\(document:/)
    })
})
