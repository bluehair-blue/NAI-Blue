import { describe, expect, it } from 'vitest'
import {
    createBatchImageDraft,
    createSingleImageDraft,
    reviseBatchImageDraft,
    reviseSingleImageDraft,
} from '@/domain/workflow/single-image-draft'
import { assertAgentPublicValue } from '@/application/agent/agent-command-contract'
import { summarizeWorkflowDraft, workflowDraftImageCount } from '@/application/agent/agent-workflow-draft-summary'

const NOW = '2026-09-05T00:00:00.000Z'

describe('agent workflow draft summary', () => {
    it('identifies a missing resolution and gives the saved cardinality without exporting prompts', () => {
        const created = createSingleImageDraft({ id: 'guided-resolution-summary', now: NOW, seed: 42 })
        const draft = reviseSingleImageDraft(created, {
            updatedAt: NOW,
            payload: { ...created.payload, prompt: { positive: 'private prompt text', negative: '' }, resolution: null },
        })

        const summary = summarizeWorkflowDraft(draft)

        expect(summary).toMatchObject({
            draftId: draft.id,
            revision: 1,
            ready: false,
            issueCodes: ['draft-resolution-required'],
            imageCount: 1,
            resolution: null,
            nextAction: 'repair-in-guided-ui',
        })
        expect(() => assertAgentPublicValue(summary)).not.toThrow()
        expect(JSON.stringify(summary)).not.toContain('private prompt text')
    })

    it('reports the effective scene count rather than the batch form default', () => {
        const created = createBatchImageDraft({ id: 'guided-eighty-summary', now: NOW, seed: 42, batchMode: 'scenes' })
        const draft = reviseBatchImageDraft(created, {
            updatedAt: NOW,
            payload: {
                ...created.payload,
                prompt: { positive: 'portrait', negative: '' },
                scenes: Array.from({ length: 8 }, (_, index) => ({
                    id: `scene:${index + 1}`, name: `Scene ${index + 1}`, positive: 'blue hair', negative: '', count: 10,
                })),
                count: 80,
            },
        })

        expect(workflowDraftImageCount(draft)).toBe(80)
        expect(summarizeWorkflowDraft(draft)).toMatchObject({
            ready: true, imageCount: 80, configuredCount: 80, batchMode: 'scenes', resolution: { width: 832, height: 1216 },
        })
    })
})
