import { hashGenerationSemanticIntent } from '@/application/generation/plan-generation'
import type { GenerationParams } from '@/services/novelai-types'
import type { GenerationAttempt, GenerationJob } from '@/domain/queue/types'
import { CURRENT_NAI_MODEL_CATALOG_REVISION } from './model-catalog'
import { queryNaiGenerationCompatibility, type NaiCompatibilityProfile } from './compatibility'
import { projectMainGenerationSemantic } from '@/services/generation/main-generation-semantic'
import { getRuntimeQueueRepository } from '@/services/queue/indexeddb-queue-repository'
import { readSavedArtifactImage } from '@/services/agent/saved-artifact-image'

interface VerifiedCompatibilityDependencies {
    listJobs(cursor: string | null): Promise<{ items: readonly GenerationJob[]; nextCursor: string | null }>
    listAttempts(jobId: string): Promise<readonly GenerationAttempt[]>
    verifyArtifact(artifactId: string, jobId: string): Promise<boolean>
}

/** A real successful attempt can attest only the identical semantic intent,
 * builder/catalog revision and response mode. No registry or policy is rewritten. */
export async function queryVerifiedNaiGenerationCompatibility(params: GenerationParams, revision: string, streaming: boolean,
    dependencies?: VerifiedCompatibilityDependencies,
): Promise<NaiCompatibilityProfile> {
    const profile = queryNaiGenerationCompatibility(params, revision, streaming)
    if (profile.status !== 'synthetic-only') return profile
    const deps = dependencies ?? {
        listJobs: (cursor: string | null) => getRuntimeQueueRepository().listJobs({ states: ['succeeded'], cursor, limit: 250 }),
        listAttempts: (jobId: string) => getRuntimeQueueRepository().listAttempts(jobId),
        verifyArtifact: async (artifactId: string, jobId: string) => {
            const { getRuntimeArtifactRepository } = await import('@/services/organizer/runtime')
            const artifact = await getRuntimeArtifactRepository().get(artifactId)
            if (artifact?.sourceJobId !== jobId) return false
            await readSavedArtifactImage(artifactId)
            return true
        },
    }
    const semanticHash = hashGenerationSemanticIntent(projectMainGenerationSemantic(params, params.imageFormat ?? 'png'))
    let cursor: string | null = null
    try {
        do {
            const page = await deps.listJobs(cursor)
            for (const job of page.items) {
                const envelope = job.snapshot.providerExecutionEnvelope
                if (job.state !== 'succeeded' || job.artifactReference === null || !envelope
                    || envelope.provider !== 'novelai' || envelope.payloadBuilderRevision !== revision
                    || envelope.modelCatalogRevision !== CURRENT_NAI_MODEL_CATALOG_REVISION
                    || envelope.compatibilityProfileId !== profile.compatibilityProfileId
                    || envelope.action !== profile.action || envelope.responseMode !== (streaming ? 'streaming' : 'standard')
                    || envelope.semanticIntentHash !== semanticHash) continue
                const attempt = (await deps.listAttempts(job.id)).find(item => item.jobId === job.id && item.outcome === 'succeeded'
                    && item.providerEvidence?.providerOutcome === 'succeeded'
                    && item.providerEvidence.dispatchState === 'result-spooled'
                    && item.providerEvidence.spoolReceipt?.attemptId === item.id
                    && item.providerEvidence.spoolReceipt.byteLength > 0
                    && item.providerEvidence.spoolReceipt.sha256 === item.providerEvidence.responseDigest)
                if (!attempt || !await deps.verifyArtifact(job.artifactReference.artifactId, job.id)) continue
                return { ...profile, status: 'live-canary-pass', warnings: [], fixture: {
                    path: `queue-attempt:${attempt.id}`, provenance: 'live-canary',
                    sha256: attempt.providerEvidence!.responseDigest!,
                } }
            }
            cursor = page.nextCursor
        } while (cursor !== null)
    } catch {
        // Unreadable or incomplete evidence never grants compatibility.
    }
    return profile
}
