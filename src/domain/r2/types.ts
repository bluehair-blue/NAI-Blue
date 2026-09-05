import { hashCanonicalValue } from '@/domain/composition/canonical-serialize'

export const R2_TRANSPORTS = ['native-s3', 'wrangler', 'relay'] as const
export type R2Transport = typeof R2_TRANSPORTS[number]

export const R2_CONFLICT_POLICIES = ['fail', 'skip-same', 'overwrite', 'suffix'] as const
export type R2ConflictPolicy = typeof R2_CONFLICT_POLICIES[number]

export type R2PublicMode = 'private' | 'r2-dev' | 'custom'

export const DEFAULT_R2_PROFILE_ID = 'asset-profile-default-r2'
export const MAX_R2_PREFIX_LENGTH = 900

export function normalizeR2Prefix(value: string | null | undefined): string | null {
    if (value == null) return null
    const normalized = value.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '')
    if (!normalized) return null
    const segments = normalized.split('/').filter(Boolean)
    if (segments.some(segment => segment === '.' || segment === '..' || /[\u0000-\u001f\u007f]/u.test(segment))) {
        throw new TypeError('R2 prefix contains an unsafe path segment')
    }
    const result = segments.join('/')
    if (result.length > MAX_R2_PREFIX_LENGTH) throw new TypeError('R2 prefix is too long')
    return result
}

export function isResolvedR2Prefix(value: unknown): value is string {
    if (value === '') return true
    if (typeof value !== 'string') return false
    try {
        return normalizeR2Prefix(value) === value
    } catch {
        return false
    }
}

export function isR2BucketName(value: unknown): value is string {
    return typeof value === 'string'
        && value.length >= 3
        && value.length <= 63
        && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(value)
        && !/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value)
}

export interface R2ProfileV2 {
    readonly schemaVersion: 2
    readonly id: string
    readonly name: string
    readonly accountId: string
    readonly jurisdiction: string | null
    readonly endpoint: string | null
    readonly bucket: string
    readonly prefix: string
    readonly credentialRef: string
    readonly transport: R2Transport
    readonly conflictPolicy: R2ConflictPolicy
    readonly publicMode: R2PublicMode
    readonly publicBaseUrl: string | null
    readonly createdAt: string
    readonly updatedAt: string
}

export type R2ProfileHash = `sha256:${string}`

export type R2DeliveryRequirement =
    | { readonly mode: 'disabled' }
    | { readonly mode: 'best-effort'; readonly profileId: string }
    | { readonly mode: 'required'; readonly profileId: string }

export interface R2DestinationProvenance {
    readonly profileId: 'explicit-request' | 'generation-folder' | 'legacy-output'
    readonly bucket: 'profile-snapshot' | 'folder' | 'ancestor' | 'workspace' | 'cleared' | 'legacy-output'
    readonly prefix: 'profile-snapshot' | 'folder' | 'ancestor' | 'workspace' | 'cleared' | 'legacy-output'
    readonly key: 'planned-output'
    /** Exact Folder resolver sources; null means the workspace/profile default. */
    readonly folder?: {
        readonly id: string
        readonly profileId: string | null
        readonly bucket: string | null
        readonly prefix: string | null
    }
}

/** Agent-visible release identity. Credential references remain internal. */
export type PlannedR2Destination =
    | {
        readonly requirement: 'disabled'
        readonly profileId: null
        readonly profileHash: null
        readonly bucket: null
        readonly key: null
        readonly conflictPolicy: null
        readonly verification: 'head-metadata-sha256'
        readonly provenance: null
    }
    | {
        readonly requirement: 'best-effort' | 'required'
        readonly profileId: string
        readonly profileHash: R2ProfileHash
        readonly bucket: string
        readonly key: string
        readonly conflictPolicy: 'fail' | 'suffix'
        readonly verification: 'head-metadata-sha256'
        readonly provenance: R2DestinationProvenance
    }

/** Durable Queue-only binding; never project this object into plan views or command results. */
export interface PlannedR2DestinationSnapshot {
    readonly destination: Exclude<PlannedR2Destination, { readonly requirement: 'disabled' }>
    readonly profile: R2ProfileV2
    readonly credentialBinding: { readonly credentialRef: string }
    /** Reviewed shared-profile CAS authority, before Folder bucket/prefix overrides. */
    readonly sourceProfileHash?: R2ProfileHash
}

export type R2QueueDeliverySnapshot =
    | { readonly requirement: 'disabled'; readonly planned: null }
    | {
        readonly requirement: 'best-effort'
        /** Null only when decoding a legacy fields-only Queue snapshot. */
        readonly planned: PlannedR2DestinationSnapshot | null
    }
    | { readonly requirement: 'required'; readonly planned: PlannedR2DestinationSnapshot }

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(value).sort()
    const expected = [...keys].sort()
    return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0 && value === value.trim()
}

function isNullableString(value: unknown): value is string | null {
    return value === null || typeof value === 'string'
}

function isTimestamp(value: unknown): value is string {
    return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isStrictPlannedR2Profile(value: unknown): value is R2ProfileV2 {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const profile = value as Record<string, unknown>
    if (!hasExactKeys(profile, [
        'schemaVersion', 'id', 'name', 'accountId', 'jurisdiction', 'endpoint', 'bucket', 'prefix',
        'credentialRef', 'transport', 'conflictPolicy', 'publicMode', 'publicBaseUrl', 'createdAt', 'updatedAt',
    ])) return false
    return profile.schemaVersion === 2
        && isNonEmptyString(profile.id)
        && isNonEmptyString(profile.name)
        && typeof profile.accountId === 'string'
        && isNullableString(profile.jurisdiction)
        && isNullableString(profile.endpoint)
        && isR2BucketName(profile.bucket)
        && isResolvedR2Prefix(profile.prefix)
        && isNonEmptyString(profile.credentialRef)
        && !profile.credentialRef.startsWith('Bearer ')
        && (profile.transport === 'native-s3' || profile.transport === 'wrangler' || profile.transport === 'relay')
        && (profile.conflictPolicy === 'fail' || profile.conflictPolicy === 'suffix')
        && (profile.publicMode === 'private' || profile.publicMode === 'r2-dev' || profile.publicMode === 'custom')
        && isNullableString(profile.publicBaseUrl)
        && (profile.publicMode !== 'custom'
            || (typeof profile.publicBaseUrl === 'string' && profile.publicBaseUrl.startsWith('https://')))
        && isTimestamp(profile.createdAt)
        && isTimestamp(profile.updatedAt)
}

export function isR2QueueDeliverySnapshot(value: unknown): value is R2QueueDeliverySnapshot {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const candidate = value as Record<string, unknown>
    if (!hasExactKeys(candidate, ['requirement', 'planned'])) return false
    if (candidate.requirement === 'disabled') return candidate.planned === null
    if (candidate.requirement !== 'best-effort' && candidate.requirement !== 'required') return false
    if (candidate.planned === null) return candidate.requirement === 'best-effort'
    if (typeof candidate.planned !== 'object' || candidate.planned === null || Array.isArray(candidate.planned)) return false
    const planned = candidate.planned as Record<string, unknown>
    if (!hasExactKeys(planned, ['destination', 'profile', 'credentialBinding',
        ...(planned.sourceProfileHash === undefined ? [] : ['sourceProfileHash'])])) return false
    if (planned.sourceProfileHash !== undefined
        && (typeof planned.sourceProfileHash !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(planned.sourceProfileHash))) return false
    if (typeof planned.destination !== 'object' || planned.destination === null
        || Array.isArray(planned.destination)
        || !isStrictPlannedR2Profile(planned.profile)
        || typeof planned.credentialBinding !== 'object' || planned.credentialBinding === null
        || Array.isArray(planned.credentialBinding)) return false
    const destination = planned.destination as Record<string, unknown>
    const profile = planned.profile
    const credential = planned.credentialBinding as Record<string, unknown>
    if (!hasExactKeys(destination, [
        'requirement', 'profileId', 'profileHash', 'bucket', 'key', 'conflictPolicy', 'verification', 'provenance',
    ]) || !hasExactKeys(credential, ['credentialRef'])
        || typeof destination.provenance !== 'object' || destination.provenance === null
        || Array.isArray(destination.provenance)) return false
    const provenance = destination.provenance as Record<string, unknown>
    if (!hasExactKeys(provenance, ['profileId', 'bucket', 'prefix', 'key',
        ...(provenance.folder === undefined ? [] : ['folder'])])) return false
    if (provenance.folder !== undefined) {
        if (typeof provenance.folder !== 'object' || provenance.folder === null || Array.isArray(provenance.folder)) return false
        const folder = provenance.folder as Record<string, unknown>
        if (!hasExactKeys(folder, ['id', 'profileId', 'bucket', 'prefix']) || !isNonEmptyString(folder.id)
            || ![folder.profileId, folder.bucket, folder.prefix].every(value => value === null || isNonEmptyString(value))) return false
    }
    try {
        return destination.requirement === candidate.requirement
            && destination.profileId === profile.id
            && typeof destination.profileHash === 'string'
            && /^sha256:[a-f0-9]{64}$/u.test(destination.profileHash)
            && destination.profileHash === hashR2ProfileV2(profile)
            && destination.bucket === profile.bucket
            && typeof destination.key === 'string' && destination.key.length > 0
            && isResolvedR2Prefix(destination.key)
            && destination.conflictPolicy === profile.conflictPolicy
            && destination.verification === 'head-metadata-sha256'
            && (provenance.profileId === 'explicit-request'
                || provenance.profileId === 'generation-folder'
                || provenance.profileId === 'legacy-output')
            && ['profile-snapshot', 'folder', 'ancestor', 'workspace', 'cleared', 'legacy-output'].includes(provenance.bucket as string)
            && ['profile-snapshot', 'folder', 'ancestor', 'workspace', 'cleared', 'legacy-output'].includes(provenance.prefix as string)
            && provenance.key === 'planned-output'
            && credential.credentialRef === profile.credentialRef
    } catch {
        return false
    }
}

/** Hashes only the durable profile binding; edit timestamps are intentionally excluded. */
export function hashR2ProfileV2(profile: R2ProfileV2): R2ProfileHash {
    return `sha256:${hashCanonicalValue({
        schemaVersion: profile.schemaVersion,
        id: profile.id,
        name: profile.name,
        accountId: profile.accountId,
        jurisdiction: profile.jurisdiction,
        endpoint: profile.endpoint,
        bucket: profile.bucket,
        prefix: profile.prefix,
        credentialRef: profile.credentialRef,
        transport: profile.transport,
        conflictPolicy: profile.conflictPolicy,
        publicMode: profile.publicMode,
        publicBaseUrl: profile.publicBaseUrl,
    })}`
}

export type UploadJobState =
    | 'queued'
    | 'running'
    | 'uploaded'
    | 'verifying'
    | 'verified'
    | 'linking'
    | 'succeeded'
    | 'failed'
    | 'cancelled'

export interface Phase7ArtifactBinding {
    readonly artifactId: string
    readonly artifactVersion: number
    readonly localVariant: 'original' | 'sidecar'
}

export interface Phase7RemoteObjectRef {
    readonly contractVersion: 'phase7-v1'
    readonly profileId: string
    readonly profileHash: R2ProfileHash
    readonly bucket: string
    readonly uploadJobId: string
    readonly artifactId: string
    readonly variantId: 'original' | 'sidecar'
    readonly remoteKey: string
    readonly contentSha256: string
    readonly size: number
    readonly verifiedAt: string
}

export interface UploadCompletedPart {
    readonly partNumber: number
    readonly etag: string
    readonly size: number
}

export interface UploadMultipartState {
    readonly uploadId: string | null
    readonly completedParts: readonly UploadCompletedPart[]
    readonly partSize: number
}

export interface UploadJob {
    readonly id: string
    /** v1 rows are migrated as historical jobs and never imply Artifact linkage. */
    readonly contractVersion: 'legacy-v1' | 'phase7-v1'
    readonly profileId: string
    readonly profileSnapshot: R2ProfileV2 | null
    readonly artifactBinding: Phase7ArtifactBinding | null
    /** Mutable CAS cursor; the immutable binding above keeps enqueue identity. */
    readonly linkExpectedArtifactVersion: number | null
    readonly remoteRef: Phase7RemoteObjectRef | null
    readonly artifactId: string
    readonly localVariant: string
    readonly remoteKey: string
    readonly contentSha256: string
    readonly contentType: string
    readonly size: number
    readonly state: UploadJobState
    readonly attempt: number
    readonly maxAttempts: number
    readonly nextAttemptAt: string
    readonly multipart: UploadMultipartState
    readonly diagnosticEventId: string | null
    readonly createdAt: string
    readonly updatedAt: string
    readonly version: number
}

export interface NativeR2ScannedArtifact {
    readonly artifactId: string
    readonly localVariant: string
    readonly remoteKey: string
    readonly contentSha256: string
    readonly contentType: string
    readonly size: number
    /** Present only for current Phase 7 Organizer-backed delivery. */
    readonly artifactBinding?: Phase7ArtifactBinding
}

export interface R2ManifestV2Item {
    readonly profileId: string
    readonly artifactId: string
    readonly localVariant: string
    readonly remoteKey: string
    readonly contentSha256: string
    readonly size: number
    readonly completedAt: string
}

export interface R2ManifestV2 {
    readonly schemaVersion: 2
    readonly profileId: string
    readonly bucket: string
    readonly prefix: string
    readonly updatedAt: string
    readonly items: readonly R2ManifestV2Item[]
}

export function createR2ProfileV2(
    input: Omit<R2ProfileV2, 'schemaVersion' | 'createdAt' | 'updatedAt'>,
    now = new Date().toISOString(),
): R2ProfileV2 {
    return {
        schemaVersion: 2,
        ...input,
        createdAt: now,
        updatedAt: now,
    }
}

export function deterministicR2Suffix(remoteKey: string, contentSha256: string): string {
    const suffix = contentSha256.replace(/^sha256:/, '').slice(0, 12)
    const slash = remoteKey.lastIndexOf('/')
    const dot = remoteKey.lastIndexOf('.')
    if (dot > slash + 1) return `${remoteKey.slice(0, dot)}-${suffix}${remoteKey.slice(dot)}`
    return `${remoteKey}-${suffix}`
}
