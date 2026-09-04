import { createOutputCommitSet } from '@/domain/output-commit-set'
import { canonicalSerialize } from '@/domain/composition/canonical-serialize'
import type { OutputCommitSet, OutputPathClaimKind } from '@/domain/queue/types'
import { shouldWriteNaiBlueSidecar } from '@/lib/generation-metadata'
import { runtimeCapabilities, type RuntimePlatform } from '@/platform/capabilities'
import type { GenerationParams } from '@/services/novelai-types'
import {
    OUTPUT_FILENAME_POLICY_REVISION,
    OUTPUT_PATH_NORMALIZATION_REVISION,
    PRIVATE_ORIGINAL_DIRECTORY,
    toArtifactSidecarPath,
    toDiagnosticSidecarPath,
    toSidecarFileName,
    withDuplicateSuffix,
    type PlannedOutputCollisionPolicy,
} from './filename-policy'

export interface GenerationOutputClaimPlan {
    readonly fileName: string
    readonly imageFormat: 'png' | 'webp'
    readonly metadataMode: GenerationParams['metadataMode']
    readonly preserveProviderOriginal: boolean
    readonly artifactSidecar?: boolean
    readonly diagnosticSidecar?: boolean
}

export interface ExactOutputCommitSetAllocationRequest extends GenerationOutputClaimPlan {
    readonly collisionPolicy: PlannedOutputCollisionPolicy
    readonly directoryAuthorityId: string
    readonly directoryAuthorityFingerprint: `sha256:${string}`
    readonly filesystemSemantics?: OutputCommitSet['filesystemSemantics']
}

export interface ExactOutputCommitSetAllocation {
    readonly fileName: string
    readonly commitSet: OutputCommitSet
    readonly commitSetHash: `sha256:${string}`
}

export function outputFilesystemSemantics(
    platform: RuntimePlatform = runtimeCapabilities.platform,
): OutputCommitSet['filesystemSemantics'] {
    if (platform === 'android') return 'android'
    if (platform === 'macos' || platform === 'ios') return 'macos'
    if (platform === 'linux') return 'linux'
    // Windows is the conservative fallback for the current desktop/web test
    // runtime: it rejects the broadest set of aliases before persistence.
    return 'windows'
}

export function generationOutputClaimKinds(
    plan: GenerationOutputClaimPlan,
): readonly OutputPathClaimKind[] {
    return Object.freeze([
        'image' as const,
        ...(shouldWriteNaiBlueSidecar(plan.metadataMode, plan.imageFormat, true)
            ? ['metadata-sidecar' as const]
            : []),
        ...(plan.artifactSidecar === true ? ['artifact-sidecar' as const] : []),
        ...(plan.diagnosticSidecar === true ? ['diagnostic-sidecar' as const] : []),
        ...(plan.preserveProviderOriginal ? ['provider-original' as const] : []),
    ])
}

export function generationOutputRelativePath(
    kind: OutputPathClaimKind,
    fileName: string,
): string {
    switch (kind) {
        case 'image': return fileName
        case 'metadata-sidecar': return toSidecarFileName(fileName)
        case 'artifact-sidecar': return toArtifactSidecarPath(fileName)
        case 'diagnostic-sidecar': return toDiagnosticSidecarPath(fileName)
        case 'provider-original': return `${PRIVATE_ORIGINAL_DIRECTORY}/${fileName}`
    }
}

/** Plans exactly the permanent files OutputWriter will publish for one generation. */
export function createGenerationOutputCommitSet(input: GenerationOutputClaimPlan & {
    readonly directoryAuthorityId: string
    readonly directoryAuthorityFingerprint: `sha256:${string}`
    readonly filesystemSemantics?: OutputCommitSet['filesystemSemantics']
}) {
    const kinds = generationOutputClaimKinds(input)
    return createOutputCommitSet({
        directoryAuthorityId: input.directoryAuthorityId,
        directoryAuthorityFingerprint: input.directoryAuthorityFingerprint,
        filesystemSemantics: input.filesystemSemantics ?? outputFilesystemSemantics(),
        filenamePolicyRevision: OUTPUT_FILENAME_POLICY_REVISION,
        pathNormalizationRevision: OUTPUT_PATH_NORMALIZATION_REVISION,
        claims: kinds.map(kind => ({
            claimId: kind,
            kind,
            relativePath: generationOutputRelativePath(kind, input.fileName),
        })),
    })
}

/** Allocates each job's permanent files as one unit against one batch snapshot. */
export function allocateExactOutputCommitSets(input: {
    readonly requests: readonly ExactOutputCommitSetAllocationRequest[]
    readonly occupiedCollisionKeys: ReadonlySet<string>
}): readonly ExactOutputCommitSetAllocation[] {
    const occupied = new Set(input.occupiedCollisionKeys)
    return Object.freeze(input.requests.map(request => {
        for (let duplicateIndex = 0; duplicateIndex < 10_000; duplicateIndex += 1) {
            const fileName = withDuplicateSuffix(request.fileName, duplicateIndex)
            const selected = createGenerationOutputCommitSet({ ...request, fileName })
            const collides = selected.commitSet.claims.some(claim => occupied.has(claim.collisionKey))
            if (!collides) {
                for (const claim of selected.commitSet.claims) occupied.add(claim.collisionKey)
                return Object.freeze({ fileName, ...selected })
            }
            if (request.collisionPolicy === 'fail') break
        }
        throw new Error(`Output destination is already occupied: ${request.fileName}`)
    }))
}

/** Recomputes a planner response before Queue persists its immutable binding. */
export function assertExactOutputCommitSetAllocation(
    request: Omit<ExactOutputCommitSetAllocationRequest, 'directoryAuthorityFingerprint' | 'filesystemSemantics'>,
    allocation: ExactOutputCommitSetAllocation & { readonly directoryIdentity: `sha256:${string}` },
    filesystemSemantics: OutputCommitSet['filesystemSemantics'],
): void {
    if (request.collisionPolicy === 'fail' && allocation.fileName !== request.fileName) {
        throw new Error('Fail-policy output allocation changed the exact filename')
    }
    const expected = createGenerationOutputCommitSet({
        ...request,
        fileName: allocation.fileName,
        directoryAuthorityFingerprint: allocation.directoryIdentity,
        filesystemSemantics,
    })
    if (allocation.commitSetHash !== expected.commitSetHash
        || canonicalSerialize(allocation.commitSet) !== canonicalSerialize(expected.commitSet)) {
        throw new Error('Output planner returned a non-canonical commit set')
    }
}
