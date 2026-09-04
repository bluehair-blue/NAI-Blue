import { describe, expect, it, vi } from 'vitest'

import { applyGenerationFolderChanges } from '@/application/folder/apply-folder-changes'
import type { GenerationFolderRepositoryPort } from '@/application/folder/generation-folder-repository'
import { planGenerationFolderChanges } from '@/application/folder/plan-folder-changes'
import { generationFolderDocumentMutationKey } from '@/application/workspace/workspace-mutation-gate'
import {
    migrateGenerationFolderV1Projection,
    normalizeGenerationFolderV1Projection,
    type GenerationFolderDocument,
} from '@/domain/generation-folders'
import { ProcessLocalWorkspaceMutationGate } from '@/lib/workspace-mutation-gate'

const defaults = { directory: 'fallback', useAbsolutePath: false, r2Prefix: 'generated' }
const initial = migrateGenerationFolderV1Projection('race', normalizeGenerationFolderV1Projection({
    savePath: 'D:\\images', useAbsolutePath: true, activeGenerationFolderId: 'child',
    generationFolders: [{
        schemaVersion: 1, id: 'child', name: 'Child', parentId: 'generation-folder-default',
        rootDirectory: null, useAbsolutePath: false, commonPrompt: '',
        r2: { autoUpload: false, bucket: null, prefix: null },
        createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
    }],
}))
const changes = [{ folderId: 'child', pathSegment: 'Moved' }] as const

function repository() {
    let current = structuredClone(initial)
    const commit = vi.fn(async (next: GenerationFolderDocument, expectedRevision: number) => {
        if (current.revision !== expectedRevision) return { status: 'REVISION_CONFLICT' as const, current }
        current = structuredClone(next)
        return { status: 'COMMITTED' as const, document: structuredClone(current) }
    })
    const port: GenerationFolderRepositoryPort = {
        readLegacyProjection: async () => null,
        getDocument: async () => structuredClone(current),
        listDocuments: async () => [],
        materializeLegacy: async () => null,
        commit,
    }
    return { port, commit, current: () => structuredClone(current) }
}

function reviewedPlan() {
    const plan = planGenerationFolderChanges(initial, changes, defaults)
    if (plan.status !== 'PLANNED') throw new Error(plan.reason)
    return plan
}

describe('Folder and Queue final mutation races', () => {
    it('lets a winning Folder CAS make the queued final binding check write nothing stale', async () => {
        const state = repository()
        const gate = new ProcessLocalWorkspaceMutationGate()
        let releaseAuthorization!: () => void
        let authorizationStarted!: () => void
        const started = new Promise<void>(resolve => { authorizationStarted = resolve })
        const hold = new Promise<void>(resolve => { releaseAuthorization = resolve })
        const plan = reviewedPlan()
        const apply = applyGenerationFolderChanges({
            repository: state.port, workspaceId: 'race', expectedRevision: initial.revision,
            expectedPlanHash: plan.planHash, changes, defaults, mutationGate: gate,
            occupancyGuard: async () => ({ status: 'empty' }),
            authorizeDirectories: async () => { authorizationStarted(); await hold },
        })
        await started
        let queueWrites = 0
        const enqueue = gate.runExclusive(generationFolderDocumentMutationKey('race'), async () => {
            if (state.current().revision === initial.revision) queueWrites += 1
        })
        releaseAuthorization()

        await expect(apply).resolves.toMatchObject({ status: 'COMMITTED' })
        await enqueue
        expect(queueWrites).toBe(0)
        expect(state.commit).toHaveBeenCalledOnce()
    })

    it('lets a winning Queue reservation make Folder occupancy reject with zero CAS', async () => {
        const state = repository()
        const gate = new ProcessLocalWorkspaceMutationGate()
        let releaseQueue!: () => void
        let queueStarted!: () => void
        const started = new Promise<void>(resolve => { queueStarted = resolve })
        const hold = new Promise<void>(resolve => { releaseQueue = resolve })
        let occupied = false
        const enqueue = gate.runExclusive(generationFolderDocumentMutationKey('race'), async () => {
            occupied = true
            queueStarted()
            await hold
        })
        await started
        const plan = reviewedPlan()
        const apply = applyGenerationFolderChanges({
            repository: state.port, workspaceId: 'race', expectedRevision: initial.revision,
            expectedPlanHash: plan.planHash, changes, defaults, mutationGate: gate,
            occupancyGuard: async folderIds => occupied
                ? { status: 'occupied', folderIds }
                : { status: 'empty' },
            authorizeDirectories: async () => undefined,
        })
        releaseQueue()

        await enqueue
        await expect(apply).resolves.toMatchObject({ status: 'UNSUPPORTED' })
        expect(state.commit).not.toHaveBeenCalled()
    })
})
