import type {
    PreparedGenerationJobDraft,
    Sha256Digest,
} from '@/application/generation/generation-plan-contract'
import { hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import { projectMainGenerationSemantic } from '@/services/generation/main-generation-semantic'
import type { PreparedMainGeneration } from '@/services/generation/main-generation-plan'

function digest(value: unknown): Sha256Digest {
    return `sha256:${hashCanonicalValue(value)}`
}

/**
 * Projects one executable Main preparation into the public review meaning.
 * Resource bytes remain only in the opaque prepared value and enter hashes as
 * ordered digests through projectMainGenerationSemantic.
 */
export function projectPreparedMainGenerationJob(
    prepared: PreparedMainGeneration,
): PreparedGenerationJobDraft<PreparedMainGeneration> {
    const params = prepared.params
    const pathHash = (value: string | null): Sha256Digest | null => value ? digest(value) : null
    // Reviewed Main capture permits only fail-on-collision writes. Its executable value must
    // match the logical destination reviewed by the application plan.
    const canonicalPrepared = prepared.output.collisionPolicy === 'error'
        ? prepared
        : Object.freeze({
            ...prepared,
            output: Object.freeze({ ...prepared.output, collisionPolicy: 'error' as const }),
        })
    return Object.freeze({
        semantic: projectMainGenerationSemantic(params, prepared.imageFormat),
        preparationDigest: digest({ sequenceCommitProposal: prepared.sequenceCommitProposal }),
        destination: {
            generationFolderId: prepared.output.generationFolderId,
            generationFolderPathHash: pathHash(prepared.output.generationFolderPath),
            outputPolicyId: digest({
                autoSave: prepared.output.autoSave,
                directoryHash: digest(prepared.output.directory),
                fallbackDirectoryHash: digest(prepared.output.capabilityFallbackDirectory),
                useAbsolutePath: prepared.output.useAbsolutePath,
                portableDirectory: prepared.output.portableDirectory ?? null,
                metadataMode: prepared.metadataMode,
                rightsXmpEnabled: prepared.output.rightsXmpEnabled,
                rightsOwner: prepared.output.rightsOwner,
                rightsEffectiveDate: prepared.output.rightsEffectiveDate,
            }),
            expectedBaseName: prepared.output.fileName?.replace(/\.(?:png|webp)$/i, '')
                || `NAI_Blue_${params.seed}`,
            extension: prepared.imageFormat,
            collisionPolicy: 'fail' as const,
            deliveryRequired: prepared.output.autoSave,
            ...(prepared.output.r2Delivery?.planned == null ? {} : { r2: prepared.output.r2Delivery.planned.destination }),
        },
        prepared: canonicalPrepared,
    })
}
