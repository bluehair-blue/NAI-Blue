import { describe, expect, it, vi } from 'vitest'
import type { GenerationAttempt, GenerationJob } from '@/domain/queue/types'
import type { GenerationParams } from '@/services/novelai-types'
import { queryVerifiedNaiGenerationCompatibility } from '@/services/nai/verified-compatibility'
import { queryNaiGenerationCompatibility, CURRENT_NAI_PAYLOAD_BUILDER_REVISION as revision } from '@/services/nai/compatibility'
import { CURRENT_NAI_MODEL_CATALOG_REVISION } from '@/services/nai/model-catalog'
import { hashGenerationSemanticIntent } from '@/application/generation/plan-generation'
import { projectMainGenerationSemantic } from '@/services/generation/main-generation-semantic'

const params: GenerationParams = { model: 'nai-diffusion-5-full-medium', prompt: 'blue bird', negative_prompt: '',
    width: 512, height: 512, steps: 14, cfg_scale: 5, cfg_rescale: 0, seed: 123,
    sampler: 'k_euler_ancestral', scheduler: 'karras', smea: false, smea_dyn: false, variety: false, imageFormat: 'png' }

function evidence() {
    const digest = `sha256:${'a'.repeat(64)}`
    const job = { id: 'job', state: 'succeeded', artifactReference: { artifactId: 'artifact:job' }, snapshot: {
        providerExecutionEnvelope: { provider: 'novelai', schemaVersion: 1,
            compatibilityProfileId: queryNaiGenerationCompatibility(params, revision, false).compatibilityProfileId,
            payloadBuilderRevision: revision, modelCatalogRevision: CURRENT_NAI_MODEL_CATALOG_REVISION,
            action: 'generate', responseMode: 'standard', queueResourceBindings: [],
            semanticIntentHash: hashGenerationSemanticIntent(projectMainGenerationSemantic(params, 'png')) },
    } } as unknown as GenerationJob
    const attempt = { id: 'attempt', jobId: 'job', outcome: 'succeeded', providerEvidence: { dispatchState: 'result-spooled',
        providerOutcome: 'succeeded', responseDigest: digest, spoolReceipt: { attemptId: 'attempt', byteLength: 99, sha256: digest } } } as GenerationAttempt
    return { job, attempt, deps: { listJobs: vi.fn(async () => ({ items: [job], nextCursor: null })),
        listAttempts: vi.fn(async () => [attempt]), verifyArtifact: vi.fn(async () => true) } }
}

describe('exact live canary compatibility evidence', () => {
    it('attests the identical semantic intent from a successful attempt and verified committed Artifact without changing the registry', async () => {
        const f = evidence()
        const result = await queryVerifiedNaiGenerationCompatibility(params, revision, false, f.deps)
        expect(result).toMatchObject({ status: 'live-canary-pass', warnings: [], fixture: { provenance: 'live-canary', path: 'queue-attempt:attempt' } })
        expect(f.deps.verifyArtifact).toHaveBeenCalledWith('artifact:job', 'job')
        expect(queryNaiGenerationCompatibility(params, revision, false).status).toBe('synthetic-only')
    })
    it.each([{ seed: 124 }, { model: 'nai-diffusion-4-5-full' }, { sourceImage: 'data:image/png;base64,AA==' },
        { cfg_scale: 6 }, { width: 832 }, { imageFormat: 'webp' as const }])('does not generalize evidence to changed intent %j', async change => {
        const f = evidence()
        expect((await queryVerifiedNaiGenerationCompatibility({ ...params, ...change }, revision, false, f.deps)).status).toBe('synthetic-only')
        expect(f.deps.verifyArtifact).not.toHaveBeenCalled()
    })
    it('does not generalize a standard response to streaming', async () => {
        const f = evidence()
        expect((await queryVerifiedNaiGenerationCompatibility(params, revision, true, f.deps)).status).toBe('synthetic-only')
    })
    it.each(['unknown', 'lost', 'digest', 'artifact', 'catalog'])('keeps incomplete %s evidence closed', async fault => {
        const f = evidence()
        if (fault === 'unknown') (f.attempt.providerEvidence as { providerOutcome: string }).providerOutcome = 'unknown'
        if (fault === 'lost') f.deps.listAttempts.mockResolvedValue([])
        if (fault === 'digest') (f.attempt.providerEvidence!.spoolReceipt as { sha256: string }).sha256 = `sha256:${'b'.repeat(64)}`
        if (fault === 'artifact') f.deps.verifyArtifact.mockResolvedValue(false)
        if (fault === 'catalog') (f.job.snapshot.providerExecutionEnvelope as { modelCatalogRevision: string }).modelCatalogRevision = 'old'
        expect((await queryVerifiedNaiGenerationCompatibility(params, revision, false, f.deps)).status).toBe('synthetic-only')
    })
})
