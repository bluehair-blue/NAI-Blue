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

export interface VerifiedCompatibilityRequest {
    readonly params: GenerationParams
    readonly streaming: boolean
}

function runtimeDependencies(): VerifiedCompatibilityDependencies {
    return {
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
}

/** A real successful attempt can attest only the identical semantic intent,
 * builder/catalog revision and response mode. No registry or policy is rewritten. */
export async function queryVerifiedNaiGenerationCompatibility(params: GenerationParams, revision: string, streaming: boolean,
    dependencies?: VerifiedCompatibilityDependencies,
): Promise<NaiCompatibilityProfile> {
    return (await queryVerifiedNaiGenerationCompatibilityBatch([{ params, streaming }], revision, dependencies))[0]
}

/** One paged pass over succeeded jobs for a whole plan. Each result equals the single-image query:
 * the first verifying job in listing order wins, and a read failure on its path grants nothing. */
export async function queryVerifiedNaiGenerationCompatibilityBatch(requests: readonly VerifiedCompatibilityRequest[],
    revision: string, dependencies?: VerifiedCompatibilityDependencies,
): Promise<NaiCompatibilityProfile[]> {
    const results = requests.map(request => queryNaiGenerationCompatibility(request.params, revision, request.streaming))
    const unresolved = new Map<number, { readonly profile: NaiCompatibilityProfile; readonly responseMode: string; readonly semanticHash: string }>()
    results.forEach((profile, index) => {
        if (profile.status !== 'synthetic-only') return
        const { params, streaming } = requests[index]
        unresolved.set(index, { profile, responseMode: streaming ? 'streaming' : 'standard',
            semanticHash: hashGenerationSemanticIntent(projectMainGenerationSemantic(params, params.imageFormat ?? 'png')) })
    })
    if (unresolved.size === 0) return results
    const deps = dependencies ?? runtimeDependencies()
    let cursor: string | null = null
    try {
        do {
            const page = await deps.listJobs(cursor)
            for (const job of page.items) {
                const envelope = job.snapshot.providerExecutionEnvelope
                if (job.state !== 'succeeded' || job.artifactReference === null || !envelope
                    || envelope.provider !== 'novelai' || envelope.payloadBuilderRevision !== revision
                    || envelope.modelCatalogRevision !== CURRENT_NAI_MODEL_CATALOG_REVISION) continue
                const matched = [...unresolved].filter(([, item]) => envelope.compatibilityProfileId === item.profile.compatibilityProfileId
                    && envelope.action === item.profile.action && envelope.responseMode === item.responseMode
                    && envelope.semanticIntentHash === item.semanticHash).map(([index]) => index)
                if (matched.length === 0) continue
                let attempt: GenerationAttempt | undefined
                try {
                    attempt = (await deps.listAttempts(job.id)).find(item => item.jobId === job.id && item.outcome === 'succeeded'
                        && item.providerEvidence?.providerOutcome === 'succeeded'
                        && item.providerEvidence.dispatchState === 'result-spooled'
                        && item.providerEvidence.spoolReceipt?.attemptId === item.id
                        && item.providerEvidence.spoolReceipt.byteLength > 0
                        && item.providerEvidence.spoolReceipt.sha256 === item.providerEvidence.responseDigest)
                    if (attempt && !await deps.verifyArtifact(job.artifactReference.artifactId, job.id)) attempt = undefined
                } catch {
                    // The single query would stop here for these images; others keep scanning.
                    matched.forEach(index => unresolved.delete(index))
                    continue
                }
                if (!attempt) continue
                for (const index of matched) {
                    results[index] = { ...unresolved.get(index)!.profile, status: 'live-canary-pass', warnings: [], fixture: {
                        path: `queue-attempt:${attempt.id}`, provenance: 'live-canary',
                        sha256: attempt.providerEvidence!.responseDigest!,
                    } }
                    unresolved.delete(index)
                }
                if (unresolved.size === 0) return results
            }
            cursor = page.nextCursor
        } while (cursor !== null)
    } catch {
        // Unreadable or incomplete evidence never grants compatibility.
    }
    return results
}
