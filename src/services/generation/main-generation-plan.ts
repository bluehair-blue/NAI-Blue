import type { FragmentSequenceCommitProposal } from '@/domain/composition/fragment-resolver'
import type { DeepReadonly } from '@/domain/composition/provenance'
import { ensureImageFileExtension } from '@/services/output/filename-policy'
import type { GenerationParams } from '@/services/novelai-types'
import { DEFAULT_RIGHTS_OWNER } from '@/domain/workflow/bluehair-rights-policy'
import type { R2DeliveryRequirement, R2DestinationProvenance, R2QueueDeliverySnapshot } from '@/domain/r2/types'

/**
 * Non-secret Main preparation consumed by both the transitional direct runner
 * and PlanMainBatch. Keeping it outside Zustand makes format, transport, CAS,
 * and output-policy decisions identical while the Draft repository is split.
 */
export interface PreparedMainGeneration {
    readonly params: GenerationParams
    readonly finalPrompt: string
    readonly imageFormat: 'png' | 'webp'
    readonly metadataMode: NonNullable<GenerationParams['metadataMode']>
    readonly streaming: boolean
    readonly sourceEdit: boolean
    readonly sequenceCommitProposal: DeepReadonly<FragmentSequenceCommitProposal> | null
    readonly output: {
        readonly autoSave: boolean
        readonly directory: string
        readonly useAbsolutePath: boolean
        readonly capabilityFallbackDirectory: string
        readonly portableDirectory?: GenerationParams['portableOutputDirectory']
        readonly fileName?: string
        readonly collisionPolicy: 'unique' | 'overwrite' | 'error'
        /** Plan-time allocation policy retained after exact-name materialization. */
        readonly reservationCollisionPolicy?: 'fail' | 'suffix'
        readonly generationFolderId: string | null
        readonly generationFolderPath: string | null
        readonly autoR2UploadProfileId: string | null
        readonly r2Bucket: string | null
        readonly r2Prefix: string | null
        readonly r2Provenance?: R2DestinationProvenance
        readonly r2Requirement?: R2DeliveryRequirement
        /** Internal reviewed delivery binding; public review exposes only its destination. */
        readonly r2Delivery?: R2QueueDeliverySnapshot
        readonly deleteOriginalAfterRelease: boolean
        readonly rightsXmpEnabled: boolean
        readonly rightsOwner: string
        readonly rightsEffectiveDate: string | null
    }
}

export interface PrepareMainGenerationOptions {
    readonly params: GenerationParams
    readonly fallbackImageFormat: 'png' | 'webp'
    readonly fallbackMetadataMode: NonNullable<GenerationParams['metadataMode']>
    readonly streamingRequested: boolean
    readonly sequenceCommitProposal: DeepReadonly<FragmentSequenceCommitProposal> | null
    readonly output: {
        readonly autoSave: boolean
        readonly directory?: string | null
        readonly useAbsolutePath: boolean
        readonly capabilityFallbackDirectory?: string | null
        readonly portableDirectory?: GenerationParams['portableOutputDirectory']
        readonly fileName?: string | null
        readonly collisionPolicy: 'unique' | 'overwrite' | 'error'
        readonly generationFolderId?: string | null
        readonly generationFolderPath?: string | null
        readonly autoR2UploadProfileId?: string | null
        readonly r2Bucket?: string | null
        readonly r2Prefix?: string | null
        readonly r2Provenance?: R2DestinationProvenance
        readonly r2Requirement?: R2DeliveryRequirement
        readonly deleteOriginalAfterRelease?: boolean
        readonly rightsXmpEnabled?: boolean
        readonly rightsOwner?: string
        readonly rightsEffectiveDate?: string | null
    }
}

/**
 * Depends only on already-resolved generation/output facts. It normalizes the
 * explicit filename and source-edit transport gate once, producing the shared
 * plan without reading Stores, credentials, clocks, or platform APIs.
 */
export function prepareMainGeneration(
    options: PrepareMainGenerationOptions,
): PreparedMainGeneration {
    const imageFormat = options.params.imageFormat ?? options.fallbackImageFormat
    const sourceEdit = Boolean(options.params.sourceImage || options.params.mask)
    const fileName = ensureImageFileExtension(options.output.fileName, imageFormat)
    const output = Object.freeze({
        autoSave: options.output.autoSave,
        directory: options.output.directory || 'NAI_Blue_Output',
        useAbsolutePath: options.output.useAbsolutePath,
        capabilityFallbackDirectory: options.output.capabilityFallbackDirectory || 'NAI_Blue_Output',
        ...(options.output.portableDirectory === undefined
            ? {}
            : { portableDirectory: options.output.portableDirectory }),
        ...(fileName === null ? {} : { fileName }),
        collisionPolicy: options.output.collisionPolicy,
        generationFolderId: options.output.generationFolderId ?? null,
        generationFolderPath: options.output.generationFolderPath ?? null,
        autoR2UploadProfileId: options.output.autoR2UploadProfileId ?? null,
        r2Bucket: options.output.r2Bucket ?? null,
        r2Prefix: options.output.r2Prefix ?? null,
        ...(options.output.r2Provenance === undefined ? {} : { r2Provenance: options.output.r2Provenance }),
        ...(options.output.r2Requirement === undefined ? {} : { r2Requirement: options.output.r2Requirement }),
        deleteOriginalAfterRelease: options.output.deleteOriginalAfterRelease ?? false,
        rightsXmpEnabled: options.output.rightsXmpEnabled ?? false,
        rightsOwner: options.output.rightsOwner ?? DEFAULT_RIGHTS_OWNER,
        rightsEffectiveDate: options.output.rightsEffectiveDate ?? null,
    })
    return Object.freeze({
        params: options.params,
        finalPrompt: options.params.prompt,
        imageFormat,
        metadataMode: options.params.metadataMode ?? options.fallbackMetadataMode,
        streaming: options.streamingRequested && !sourceEdit,
        sourceEdit,
        sequenceCommitProposal: options.sequenceCommitProposal,
        output,
    })
}
