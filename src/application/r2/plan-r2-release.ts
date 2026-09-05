import { hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import {
    deterministicR2Suffix,
    hashR2ProfileV2,
    isR2BucketName,
    isR2QueueDeliverySnapshot,
    normalizeR2Prefix,
    type PlannedR2Destination,
    type PlannedR2DestinationSnapshot,
    type R2DeliveryRequirement,
    type R2DestinationProvenance,
    type R2ProfileV2,
} from '@/domain/r2/types'

export interface R2ReleaseReadiness {
    readonly status: 'ready' | 'not-ready'
    readonly reason?: 'runtime' | 'profile' | 'credential'
    /** Ready credentials must still name the immutable profile binding. */
    readonly credentialRef?: string
}

export interface PlanR2ReleaseDependencies {
    getProfile(profileId: string): Promise<R2ProfileV2 | null>
    getReadiness(profile: R2ProfileV2): Promise<R2ReleaseReadiness>
}

export interface PlanR2ReleaseInput {
    readonly requirement: R2DeliveryRequirement
    readonly objectName: string
    readonly planIdentity: `sha256:${string}`
    readonly deleteOriginal?: boolean
    readonly profileIdProvenance?: R2DestinationProvenance['profileId']
    /** Already resolved by Folder authority: null bucket is an intentional clear. */
    readonly resolvedDestination?: {
        readonly bucket?: string | null
        readonly prefix?: string
        readonly provenance: R2DestinationProvenance
    }
}

export type PlanR2ReleaseResult =
    | {
        readonly status: 'ready'
        readonly destination: PlannedR2Destination
        readonly internalSnapshot: PlannedR2DestinationSnapshot | null
        readonly readiness: 'not-required' | 'ready' | 'needs-attention'
    }
    | { readonly status: 'invalid' | 'unsupported'; readonly code: string; readonly message: string }

export type RevalidateR2ReleaseResult =
    | { readonly status: 'ready'; readonly snapshot: PlannedR2DestinationSnapshot }
    | { readonly status: 'needs-attention'; readonly snapshot: PlannedR2DestinationSnapshot; readonly reason: string }
    | { readonly status: 'blocked'; readonly code: string; readonly reason: string }

function immutable<T>(value: T): T {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
    for (const nested of Object.values(value as Record<string, unknown>)) immutable(nested)
    return Object.freeze(value)
}

function disabledDestination(): PlannedR2Destination {
    return immutable({
        requirement: 'disabled',
        profileId: null,
        profileHash: null,
        bucket: null,
        key: null,
        conflictPolicy: null,
        verification: 'head-metadata-sha256',
        provenance: null,
    })
}

function failure(
    status: 'invalid' | 'unsupported',
    code: string,
    message: string,
): PlanR2ReleaseResult {
    return immutable({ status, code, message })
}

function exactKey(profile: R2ProfileV2, objectName: string): string | null {
    if (!objectName || objectName !== objectName.trim() || /[\\\r\n]/u.test(objectName)) return null
    try {
        return normalizeR2Prefix([profile.prefix, objectName].filter(Boolean).join('/'))
    } catch {
        return null
    }
}

/**
 * Reads one profile at most once and fixes the exact conditional-create target.
 * It performs no reservation, Queue, credential resolution, or remote mutation.
 */
export async function planR2Release(
    input: PlanR2ReleaseInput,
    dependencies: PlanR2ReleaseDependencies,
): Promise<PlanR2ReleaseResult> {
    if (input.deleteOriginal === true) {
        return failure('unsupported', 'r2-delete-original-unsupported', 'Deleting the local original is not supported.')
    }
    if (input.requirement.mode === 'disabled') {
        return immutable({
            status: 'ready',
            destination: disabledDestination(),
            internalSnapshot: null,
            readiness: 'not-required',
        })
    }
    if (!/^sha256:[a-f0-9]{64}$/u.test(input.planIdentity)) {
        return failure('invalid', 'invalid-r2-plan-identity', 'A canonical plan identity is required.')
    }

    const sourceProfile = await dependencies.getProfile(input.requirement.profileId)
    if (sourceProfile === null || sourceProfile.id !== input.requirement.profileId) {
        return failure('invalid', 'r2-profile-unavailable', 'The selected R2 profile is unavailable or invalid.')
    }
    const resolved = input.resolvedDestination
    if (resolved?.bucket !== undefined && !isR2BucketName(resolved.bucket)) {
        return failure('invalid', 'r2-destination-unavailable', 'The resolved R2 bucket is cleared or invalid.')
    }
    const profile: R2ProfileV2 = resolved === undefined ? sourceProfile : {
        ...sourceProfile, bucket: resolved.bucket ?? sourceProfile.bucket, prefix: resolved.prefix ?? sourceProfile.prefix,
    }
    if (!isR2BucketName(profile.bucket)) return failure('invalid', 'r2-profile-unavailable', 'The selected R2 bucket is invalid.')
    if (profile.conflictPolicy === 'overwrite' || profile.conflictPolicy === 'skip-same') {
        return failure('unsupported', 'r2-conflict-policy-unsupported', 'New releases support only fail or suffix conflict policy.')
    }
    const baseKey = exactKey(profile, input.objectName)
    if (baseKey === null) {
        return failure('invalid', 'invalid-r2-object-name', 'The planned R2 object name is invalid.')
    }
    const conflictPolicy = profile.conflictPolicy
    const key = conflictPolicy === 'suffix'
        ? deterministicR2Suffix(baseKey, `sha256:${hashCanonicalValue({ planIdentity: input.planIdentity, baseKey })}`)
        : baseKey
    const destination: Exclude<PlannedR2Destination, { readonly requirement: 'disabled' }> = immutable({
        requirement: input.requirement.mode,
        profileId: profile.id,
        profileHash: hashR2ProfileV2(profile),
        bucket: profile.bucket,
        key,
        conflictPolicy,
        verification: 'head-metadata-sha256' as const,
        provenance: resolved?.provenance ?? {
            profileId: input.profileIdProvenance ?? 'explicit-request',
            bucket: 'profile-snapshot',
            prefix: 'profile-snapshot',
            key: 'planned-output',
        },
    })
    const snapshot = immutable({
        destination,
        profile: structuredClone(profile),
        credentialBinding: { credentialRef: profile.credentialRef },
        sourceProfileHash: hashR2ProfileV2(sourceProfile),
    })
    if (!isR2QueueDeliverySnapshot({ requirement: destination.requirement, planned: snapshot })) {
        return failure('invalid', 'invalid-r2-snapshot', 'The resolved R2 destination and profile binding are inconsistent.')
    }
    const readiness = await dependencies.getReadiness(profile)
    const ready = readiness.status === 'ready' && readiness.credentialRef === profile.credentialRef
    if (!ready && input.requirement.mode === 'required') {
        return failure('invalid', 'r2-required-not-ready', 'The required R2 profile and credential are not ready.')
    }
    return immutable({
        status: 'ready',
        destination,
        internalSnapshot: snapshot,
        readiness: ready ? 'ready' : 'needs-attention',
    })
}

/** Rechecks the reviewed binding immediately before any output reservation or Queue write. */
export async function revalidateR2Release(
    snapshot: PlannedR2DestinationSnapshot,
    dependencies: PlanR2ReleaseDependencies,
): Promise<RevalidateR2ReleaseResult> {
    const current = await dependencies.getProfile(snapshot.destination.profileId)
    const stale = current === null || hashR2ProfileV2(current) !== (snapshot.sourceProfileHash ?? snapshot.destination.profileHash)
    if (stale) {
        return snapshot.destination.requirement === 'required'
            ? immutable({ status: 'blocked', code: 'r2-profile-stale', reason: 'The required R2 profile changed after review.' })
            : immutable({ status: 'needs-attention', snapshot, reason: 'The best-effort R2 profile changed after review.' })
    }
    return checkR2ReleaseReadiness(snapshot, dependencies)
}

/** Dispatch/recovery checks the accepted credential binding without consulting mutable profiles. */
export async function checkR2ReleaseReadiness(
    snapshot: PlannedR2DestinationSnapshot,
    dependencies: Pick<PlanR2ReleaseDependencies, 'getReadiness'>,
): Promise<RevalidateR2ReleaseResult> {
    if (!isR2QueueDeliverySnapshot({ requirement: snapshot.destination.requirement, planned: snapshot })) {
        return immutable({ status: 'blocked', code: 'invalid-r2-snapshot', reason: 'The accepted R2 snapshot is invalid.' })
    }
    const readiness = await dependencies.getReadiness(snapshot.profile)
    const ready = readiness.status === 'ready'
        && readiness.credentialRef === snapshot.credentialBinding.credentialRef
    if (ready) return immutable({ status: 'ready', snapshot })
    return snapshot.destination.requirement === 'required'
        ? immutable({ status: 'blocked', code: 'r2-required-not-ready', reason: 'The required R2 credential is not ready.' })
        : immutable({ status: 'needs-attention', snapshot, reason: 'The best-effort R2 release needs attention.' })
}
