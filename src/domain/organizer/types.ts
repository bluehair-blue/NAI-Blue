import type { PortablePathRef } from '@/domain/composition/types'

export const ORGANIZER_ARTIFACT_SCHEMA_VERSION = 1 as const
export const ORGANIZER_SANITIZATION_POLICY_VERSION = 1 as const

export type OrganizerSourceImageFormat = 'png' | 'webp' | 'jpeg'
export type OrganizerDistributionFormat = 'png' | 'webp'
export type OrganizerCollisionPolicy = 'unique' | 'overwrite' | 'error'
export type OrganizerMetadataPolicy = 'preserve' | 'strip'
export type OrganizerAlphaPolicy = 'preserve' | 'flatten'
export type DistributionVariantStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type RemoteObjectState = 'queued' | 'succeeded' | 'failed' | 'cancelled'

/** A file location that remains portable and never serializes an OS path. */
export interface ArtifactPortableFileRef {
    readonly directory: PortablePathRef
    readonly fileName: string
}

export interface ArtifactOriginalVariant {
    readonly variantId: 'original'
    readonly file: ArtifactPortableFileRef
    readonly format: OrganizerSourceImageFormat
    readonly contentChecksum: string
    readonly size: number
    readonly createdAt: string
}

export interface ArtifactThumbnailReference {
    readonly cacheKey: string
    readonly sourceChecksum: string
    readonly variantId: 'original' | string
}

export interface ArtifactSidecarReference {
    readonly file: ArtifactPortableFileRef
    readonly digest: string
}

export interface OrganizerR2FollowUpPolicy {
    readonly profileId: string
    readonly remoteKeyPrefix: string
}

/**
 * All write intent is serializable and secret-free.  The selected R2 profile
 * is referenced by ID; credentials stay in the existing OS-vault boundary.
 */
export interface DistributionPolicy {
    readonly destination: PortablePathRef
    readonly filenameTemplate: string
    readonly collisionPolicy: OrganizerCollisionPolicy
    readonly format: OrganizerDistributionFormat
    readonly webpLossless: boolean
    readonly quality: number
    readonly alphaPolicy: OrganizerAlphaPolicy
    readonly matteColor: string
    readonly metadataPolicy: OrganizerMetadataPolicy
    readonly r2FollowUp: OrganizerR2FollowUpPolicy | null
}

export interface ArtifactDistributionFailure {
    readonly code: string
    readonly summary: string
    readonly occurredAt: string
}

export interface DistributionVariant {
    readonly variantId: string
    readonly status: DistributionVariantStatus
    /** Final file reference exists only after OutputWriter commits it. */
    readonly file: ArtifactPortableFileRef | null
    readonly requestedFileName: string
    readonly format: OrganizerDistributionFormat
    readonly contentChecksum: string | null
    readonly size: number | null
    readonly sidecar: ArtifactSidecarReference | null
    readonly policy: DistributionPolicy
    readonly sanitizationPolicyVersion: number
    readonly createdAt: string
    readonly updatedAt: string
    readonly failure: ArtifactDistributionFailure | null
}

export interface ArtifactRemoteObjectRef {
    readonly profileId: string
    readonly uploadJobId: string | null
    readonly artifactId: string
    readonly variantId: string
    readonly remoteKey: string
    readonly state: RemoteObjectState
    readonly updatedAt: string
    readonly failure: ArtifactDistributionFailure | null
}

/**
 * Organizer authority.  It never stores raw absolute paths, opaque platform
 * tokens, image bytes, prompts, credentials, Authorization headers, or signed
 * URLs.  Those remain at the platform/runtime boundary.
 */
export interface ArtifactRecord {
    readonly schemaVersion: typeof ORGANIZER_ARTIFACT_SCHEMA_VERSION
    readonly artifactId: string
    readonly sourceJobId: string | null
    readonly sourceSceneId: string | null
    /** Exact Queue publication claim; null for legacy and direct outputs. */
    readonly outputCommitSetHash: `sha256:${string}` | null
    readonly original: ArtifactOriginalVariant
    readonly distributionVariants: readonly DistributionVariant[]
    readonly thumbnail: ArtifactThumbnailReference
    /** The newest committed distribution sidecar, if one exists. */
    readonly sidecar: ArtifactSidecarReference | null
    /** Checksum of the immutable original variant. */
    readonly contentChecksum: string
    readonly sanitizationPolicyVersion: number
    readonly remoteObjectRefs: readonly ArtifactRemoteObjectRef[]
    readonly createdAt: string
    readonly updatedAt: string
    readonly version: number
}

export interface CreateArtifactRecordInput {
    readonly artifactId: string
    readonly sourceJobId?: string | null
    readonly sourceSceneId?: string | null
    readonly outputCommitSetHash?: `sha256:${string}` | null
    readonly file: ArtifactPortableFileRef
    readonly format: OrganizerSourceImageFormat
    readonly contentChecksum: string
    readonly size: number
    readonly createdAt?: string
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9:_-]{1,256}$/
const CHECKSUM_PATTERN = /^sha256:[a-f0-9]{64}$/i
const FORBIDDEN_FILENAME_PATTERN = /[\\/\0]|^\.{1,2}$/

function projectPortablePath(path: PortablePathRef): PortablePathRef {
    if (path.kind === 'standard') {
        return { kind: 'standard', root: path.root, segments: [...path.segments] }
    }
    return { kind: 'bookmark', bookmarkId: path.bookmarkId, segments: [...path.segments] }
}

function assertPortablePath(path: PortablePathRef): void {
    if (!Array.isArray(path.segments) || path.segments.some(segment => (
        !segment.trim() || segment === '.' || segment === '..' || /[\\/\0]/.test(segment)
    ))) {
        throw new ArtifactRecordError('E_ARTIFACT_RECORD_INVALID', 'Artifact path segments must be portable and traversal-free.')
    }
    if (path.kind === 'bookmark' && !IDENTIFIER_PATTERN.test(path.bookmarkId)) {
        throw new ArtifactRecordError('E_ARTIFACT_RECORD_INVALID', 'Artifact bookmark identity is invalid.')
    }
}

export class ArtifactRecordError extends Error {
    constructor(readonly code: 'E_ARTIFACT_RECORD_INVALID' | 'E_ARTIFACT_ORIGINAL_IMMUTABLE', message: string) {
        super(message)
        this.name = 'ArtifactRecordError'
    }
}

export function projectArtifactPortableFile(file: ArtifactPortableFileRef): ArtifactPortableFileRef {
    assertPortablePath(file.directory)
    if (!file.fileName.trim() || FORBIDDEN_FILENAME_PATTERN.test(file.fileName)) {
        throw new ArtifactRecordError('E_ARTIFACT_RECORD_INVALID', 'Artifact filename is invalid.')
    }
    return { directory: projectPortablePath(file.directory), fileName: file.fileName }
}

export function createArtifactRecord(input: CreateArtifactRecordInput): ArtifactRecord {
    const createdAt = input.createdAt ?? new Date().toISOString()
    if (!IDENTIFIER_PATTERN.test(input.artifactId)
        || (input.sourceJobId !== undefined && input.sourceJobId !== null && !IDENTIFIER_PATTERN.test(input.sourceJobId))
        || (input.sourceSceneId !== undefined && input.sourceSceneId !== null && !IDENTIFIER_PATTERN.test(input.sourceSceneId))
        || (input.outputCommitSetHash !== undefined
            && input.outputCommitSetHash !== null
            && !CHECKSUM_PATTERN.test(input.outputCommitSetHash))
        || !CHECKSUM_PATTERN.test(input.contentChecksum)
        || !Number.isSafeInteger(input.size)
        || input.size < 0
        || !Number.isFinite(Date.parse(createdAt))) {
        throw new ArtifactRecordError('E_ARTIFACT_RECORD_INVALID', 'Artifact record identity or checksum is invalid.')
    }
    const file = projectArtifactPortableFile(input.file)
    return {
        schemaVersion: ORGANIZER_ARTIFACT_SCHEMA_VERSION,
        artifactId: input.artifactId,
        sourceJobId: input.sourceJobId ?? null,
        sourceSceneId: input.sourceSceneId ?? null,
        outputCommitSetHash: input.outputCommitSetHash ?? null,
        original: {
            variantId: 'original',
            file,
            format: input.format,
            contentChecksum: input.contentChecksum,
            size: input.size,
            createdAt,
        },
        distributionVariants: [],
        thumbnail: {
            cacheKey: `thumbnail:${input.artifactId}`,
            sourceChecksum: input.contentChecksum,
            variantId: 'original',
        },
        sidecar: null,
        contentChecksum: input.contentChecksum,
        sanitizationPolicyVersion: ORGANIZER_SANITIZATION_POLICY_VERSION,
        remoteObjectRefs: [],
        createdAt,
        updatedAt: createdAt,
        version: 1,
    }
}

export function assertArtifactOriginalUnchanged(
    record: ArtifactRecord,
    candidate: ArtifactOriginalVariant,
    outputCommitSetHash: ArtifactRecord['outputCommitSetHash'] = record.outputCommitSetHash ?? null,
): void {
    if (record.original.contentChecksum !== candidate.contentChecksum
        || record.original.size !== candidate.size
        || JSON.stringify(record.original.file) !== JSON.stringify(candidate.file)
        || record.original.format !== candidate.format
        || (record.outputCommitSetHash ?? null) !== outputCommitSetHash) {
        throw new ArtifactRecordError('E_ARTIFACT_ORIGINAL_IMMUTABLE', 'Original artifact variants are immutable.')
    }
}

export function isOrganizerChecksum(value: string): boolean {
    return CHECKSUM_PATTERN.test(value)
}
