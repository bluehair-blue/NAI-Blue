import { describe, expect, it } from 'vitest'

import {
    createBatchImageDraft,
    createSingleImageDraft,
    reviseBatchImageDraft,
    reviseSingleImageDraft,
} from '@/domain/workflow/single-image-draft'
import { createWorkflowDraftMainBatchPlanner } from '@/presentation/generation/workflow-draft-main-batch-planner'
import type { FragmentLookupRepository } from '@/stores/fragment-store'

const NOW = '2026-08-08T00:00:00.000Z'

function readyDraft() {
    const created = createSingleImageDraft({ id: 'draft:1', now: NOW, seed: 4242 })
    return reviseSingleImageDraft(created, {
        updatedAt: NOW,
        currentNodeId: 'review',
        status: 'review',
        payload: {
            ...created.payload,
            model: 'nai-diffusion-4-5-full',
            prompt: {
                positive: '1girl, blue hour\n# omitted comment',
                negative: 'blurry',
            },
            resolution: { width: 832, height: 1216 },
        },
    })
}

function readyBatch(mode: 'same-settings' | 'variations' | 'scenes' = 'same-settings') {
    const created = createBatchImageDraft({ id: `batch:${mode}`, now: NOW, seed: 100, batchMode: mode })
    return reviseBatchImageDraft(created, {
        updatedAt: NOW,
        currentNodeId: 'review',
        status: 'review',
        payload: {
            ...created.payload,
            model: 'nai-diffusion-4-5-full',
            prompt: { positive: '1girl, <*wardrobe/outfit>', negative: 'blurry' },
            resolution: { width: 1024, height: 1024 },
            count: 3,
        },
    })
}

describe('Workflow Draft Main batch Planner', () => {
    it('materializes one non-streaming PreparedMainGeneration from the detached draft', async () => {
        const planner = createWorkflowDraftMainBatchPlanner(readyDraft())
        const prepared = await planner.prepareBatch()

        expect(planner.getRequestedCount()).toBe(1)
        expect(prepared).toHaveLength(1)
        expect(prepared[0]).toMatchObject({
            finalPrompt: '1girl, blue hour',
            imageFormat: 'png',
            metadataMode: 'embedded',
            streaming: false,
            sourceEdit: false,
            sequenceCommitProposal: null,
            params: {
                prompt: '1girl, blue hour',
                negative_prompt: 'blurry',
                model: 'nai-diffusion-4-5-full',
                width: 832,
                height: 1216,
                steps: 28,
                seed: 4242,
            },
            output: {
                directory: 'NAI_Blue_Output',
                collisionPolicy: 'unique',
            },
        })
    })

    it('rejects incomplete drafts without consulting the expert Generation store', async () => {
        const draft = createSingleImageDraft({ id: 'draft:1', now: NOW, seed: 42 })
        const planner = createWorkflowDraftMainBatchPlanner(draft)

        await expect(planner.prepareBatch()).resolves.toEqual([])
    })

    it('rejects a requested count that does not match the saved draft cardinality', async () => {
        const planner = createWorkflowDraftMainBatchPlanner(readyDraft(), { materializedSeeds: [1, 2] })

        await expect(planner.prepareBatch()).rejects.toMatchObject({
            name: 'WorkflowDraftCountMismatchError', expected: 1, requested: 2,
        })
    })

    it('does not silently ignore a pinned credential before Queue affinity exists', async () => {
        const draft = readyDraft()
        const pinned = reviseSingleImageDraft(draft, {
            updatedAt: NOW,
            payload: {
                ...draft.payload,
                credentialPolicy: { kind: 'pinned', credentialId: 'credential:1' },
            },
        })

        await expect(createWorkflowDraftMainBatchPlanner(pinned).prepareBatch()).resolves.toEqual([])
    })

    it('resolves folder modules into the immutable queue prompt and stages sequence state', async () => {
        const draft = reviseSingleImageDraft(readyDraft(), {
            updatedAt: '2026-08-08T00:00:01.000Z',
            payload: {
                ...readyDraft().payload,
                prompt: {
                    positive: '1girl, <wardrobe/outfit>',
                    negative: '<*quality/avoid>',
                },
            },
        })
        const repository: FragmentLookupRepository = {
            findMetadataByPath: () => undefined,
            loadDefinitionByPath: async path => path === 'wardrobe/outfit'
                ? { id: 'fragment:outfit', path, lines: ['coat'] }
                : path === 'quality/avoid'
                    ? { id: 'fragment:avoid', path, lines: ['blurry', 'text'] }
                    : null,
            getSequenceSnapshot: () => ({ revision: 7, counters: { 'fragment:avoid': 0 } }),
            commitSequenceProposal: () => {
                throw new Error('Planning must not commit sequential module state')
            },
        }

        const prepared = await createWorkflowDraftMainBatchPlanner(draft, {
            fragmentRepository: repository,
        }).prepareBatch()

        expect(prepared[0]).toMatchObject({
            finalPrompt: '1girl, coat',
            params: {
                prompt: '1girl, coat',
                negative_prompt: 'blurry',
            },
            sequenceCommitProposal: {
                expectedRevision: 7,
                changes: [{
                    fragmentId: 'fragment:avoid',
                    fragmentPath: 'quality/avoid',
                    expectedCounter: 0,
                    nextCounter: 1,
                }],
            },
        })
    })

    it('materializes draft-owned character prompts through the same module session', async () => {
        const source = readyDraft()
        const draft = reviseSingleImageDraft(source, {
            updatedAt: '2026-08-08T00:00:01.000Z',
            payload: {
                ...source.payload,
                characterPrompts: {
                    positionEnabled: true,
                    items: [{
                        id: 'character:hero',
                        name: 'Hero',
                        prompt: '1girl, <characters/hair>',
                        negative: 'alternate costume',
                        enabled: true,
                        position: { x: 0.25, y: 0.6 },
                    }],
                },
            },
        })
        const repository: FragmentLookupRepository = {
            findMetadataByPath: () => undefined,
            loadDefinitionByPath: async path => path === 'characters/hair'
                ? { id: 'fragment:hair', path, lines: ['silver hair'] }
                : null,
            getSequenceSnapshot: () => ({ revision: 0, counters: {} }),
            commitSequenceProposal: () => false,
        }

        const prepared = await createWorkflowDraftMainBatchPlanner(draft, {
            fragmentRepository: repository,
        }).prepareBatch()

        expect(prepared[0]?.params).toMatchObject({
            characterPositionEnabled: true,
            characterPrompts: [{
                stableId: 'character:hero',
                name: 'Hero',
                prompt: '1girl, silver hair',
                negative: 'alternate costume',
                enabled: true,
                position: { x: 0.25, y: 0.6 },
            }],
        })
    })

    it('fails closed when a saved module reference no longer exists', async () => {
        const source = readyDraft()
        const draft = reviseSingleImageDraft(source, {
            updatedAt: '2026-08-08T00:00:01.000Z',
            payload: {
                ...source.payload,
                prompt: { ...source.payload.prompt, positive: '<missing>' },
            },
        })
        const repository: FragmentLookupRepository = {
            findMetadataByPath: () => undefined,
            loadDefinitionByPath: async () => null,
            getSequenceSnapshot: () => ({ revision: 0, counters: {} }),
            commitSequenceProposal: () => true,
        }

        await expect(createWorkflowDraftMainBatchPlanner(draft, {
            fragmentRepository: repository,
        }).prepareBatch()).rejects.toThrow('A saved Guided prompt module could not be resolved')
    })

    it('plans an exact N-item batch with distinct seeds and staged sequential proposals', async () => {
        const repository: FragmentLookupRepository = {
            findMetadataByPath: () => undefined,
            loadDefinitionByPath: async path => path === 'wardrobe/outfit'
                ? { id: 'fragment:outfit', path, lines: ['coat', 'dress', 'jacket'] }
                : null,
            getSequenceSnapshot: () => ({ revision: 7, counters: { 'fragment:outfit': 0 } }),
            commitSequenceProposal: () => {
                throw new Error('Planning must not commit sequential module state')
            },
        }
        const planner = createWorkflowDraftMainBatchPlanner(readyBatch(), {
            fragmentRepository: repository,
        })

        const prepared = await planner.prepareBatch()

        expect(planner.getRequestedCount()).toBe(3)
        expect(prepared.map(item => item.params.seed)).toEqual([100, 101, 102])
        expect(prepared.map(item => item.finalPrompt)).toEqual([
            '1girl, coat',
            '1girl, dress',
            '1girl, jacket',
        ])
        expect(prepared.map(item => item.sequenceCommitProposal?.expectedRevision)).toEqual([7, 8, 9])
        expect(prepared.map(item => item.sequenceCommitProposal?.changes[0]?.expectedCounter)).toEqual([0, 1, 2])
    })

    it('fans out scene prompts and per-scene counts without reading Scene or Generation stores', async () => {
        const source = readyBatch('scenes')
        const draft = reviseBatchImageDraft(source, {
            updatedAt: '2026-08-08T00:00:01.000Z',
            payload: {
                ...source.payload,
                prompt: { positive: 'cinematic lighting', negative: 'text' },
                scenes: [
                    { id: 'scene:1', name: 'Arrival', positive: 'train platform', negative: '', count: 2 },
                    { id: 'scene:2', name: 'Departure', positive: 'empty station', negative: 'crowd', count: 1 },
                ],
            },
        })
        const repository: FragmentLookupRepository = {
            findMetadataByPath: () => undefined,
            loadDefinitionByPath: async () => null,
            getSequenceSnapshot: () => ({ revision: 0, counters: {} }),
            commitSequenceProposal: () => false,
        }
        const planner = createWorkflowDraftMainBatchPlanner(draft, { fragmentRepository: repository })

        const prepared = await planner.prepareBatch()

        expect(planner.getRequestedCount()).toBe(3)
        expect(prepared.map(item => item.finalPrompt)).toEqual([
            'cinematic lighting, train platform',
            'cinematic lighting, train platform',
            'cinematic lighting, empty station',
        ])
        expect(prepared[2]?.params.negative_prompt).toBe('text, crowd')
    })

    it('carries the Guided output folder and format into every immutable job plan', async () => {
        const source = readyBatch()
        const draft = reviseBatchImageDraft(source, {
            updatedAt: '2026-08-08T00:00:01.000Z',
            payload: {
                ...source.payload,
                prompt: { positive: '1girl, portrait', negative: '' },
                output: {
                    ...source.payload.output,
                    directory: 'NAI_Blue_Output/batches/portraits',
                    imageFormat: 'webp',
                },
            },
        })
        const repository: FragmentLookupRepository = {
            findMetadataByPath: () => undefined,
            loadDefinitionByPath: async () => null,
            getSequenceSnapshot: () => ({ revision: 0, counters: {} }),
            commitSequenceProposal: () => false,
        }

        const prepared = await createWorkflowDraftMainBatchPlanner(draft, {
            fragmentRepository: repository,
        }).prepareBatch()

        expect(prepared).toHaveLength(3)
        expect(prepared.every(item => (
            item.imageFormat === 'webp'
            && item.params.imageFormat === 'webp'
            && item.output.directory === 'NAI_Blue_Output/batches/portraits'
        ))).toBe(true)
    })
})
