import { assertAgentPublicValue } from './agent-command-contract'
import { hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import type { JsonObject } from '@/domain/composition/types'
import {
    listBatchImageDraftIssues,
    listSingleImageDraftIssues,
    type WorkflowDraft,
} from '@/domain/workflow/single-image-draft'

function digest(value: unknown): `sha256:${string}` {
    return `sha256:${hashCanonicalValue(value)}`
}

function publicText(value: string, limit: number): string | null {
    const text = value.slice(0, limit)
    try {
        assertAgentPublicValue({ text })
        return text
    } catch {
        return null
    }
}

/** Returns the image cardinality owned by a persisted Guided draft. */
export function workflowDraftImageCount(draft: WorkflowDraft): number {
    if (draft.kind === 'single-image') return 1
    if (draft.payload.batchMode !== 'scenes') return draft.payload.count
    return draft.payload.scenes.reduce((sum, scene) => sum + scene.count, 0)
}

/**
 * Exposes enough immutable draft state for an agent to repair or plan safely.
 * Prompt text and private output paths stay out of the snapshot; the Guided
 * repository remains the source of truth and the normal public-value scanner
 * still protects the returned object at the command boundary.
 */
export function summarizeWorkflowDraft(draft: WorkflowDraft): JsonObject {
    const issues = draft.kind === 'single-image'
        ? listSingleImageDraftIssues(draft)
        : listBatchImageDraftIssues(draft)
    const payload = draft.payload
    const imageCount = workflowDraftImageCount(draft)
    const promptDigest = digest({ positive: payload.prompt.positive, negative: payload.prompt.negative })
    const generation = payload.generation
    const output = payload.output
    return {
        draftId: draft.id,
        kind: draft.kind,
        revision: draft.revision,
        status: draft.status,
        currentNodeId: draft.currentNodeId,
        ready: issues.length === 0,
        issueCodes: issues.map(issue => `draft-${issue}`),
        nextAction: issues.length === 0 ? 'ready-for-generation-plan' : 'repair-in-guided-ui',
        model: payload.model === null ? null : publicText(payload.model, 96),
        imageCount,
        configuredCount: draft.kind === 'single-image' ? 1 : draft.payload.count,
        ...(draft.kind === 'batch-image' ? { batchMode: draft.payload.batchMode } : {}),
        resolution: payload.resolution === null ? null : {
            width: payload.resolution.width,
            height: payload.resolution.height,
        },
        promptDigest,
        promptLengths: {
            positive: payload.prompt.positive.length,
            negative: payload.prompt.negative.length,
        },
        generation: {
            steps: generation.steps,
            cfgScale: generation.cfgScale,
            cfgRescale: generation.cfgRescale,
            sampler: publicText(generation.sampler, 96),
            scheduler: publicText(generation.scheduler, 96),
            seed: generation.seed,
            smea: generation.smea,
            smeaDyn: generation.smeaDyn,
            variety: generation.variety,
            qualityToggle: generation.qualityToggle,
            ucPreset: generation.ucPreset,
            transparentBackground: generation.transparentBackground ?? false,
        },
        destination: {
            generationFolderSelected: Boolean(output.generationFolderId),
            imageFormat: output.imageFormat,
            metadataMode: output.metadataMode,
            collisionPolicy: output.collisionPolicy,
            r2Requested: output.autoR2UploadProfileId !== null
                && output.autoR2UploadProfileId !== undefined,
            rightsXmpEnabled: output.rightsXmpEnabled ?? false,
        },
        dispatchMode: { kind: payload.credentialPolicy.kind },
        deliveryReadiness: 'use-r2-get-readiness-for-current-provider-state',
        review: {
            promptDigest,
            negativePromptDigest: digest(payload.prompt.negative),
            characterPromptCount: payload.characterPrompts.items.filter(item => item.enabled).length,
        },
    }
}
