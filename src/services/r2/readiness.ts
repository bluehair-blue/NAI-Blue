import type { ResolvedGenerationFolder } from '@/domain/generation-folders'
import { DEFAULT_R2_PROFILE_ID, type R2ProfileV2 } from '@/domain/r2/types'
import { runtimeCapabilities } from '@/platform/capabilities'
import { nativeR2CredentialStatus } from './native-r2-adapter'
import { getRuntimeR2UploadRepository } from './runtime'

export type DefaultR2Readiness =
    | { readonly status: 'loading'; readonly profile: null }
    | { readonly status: 'unavailable'; readonly reason: 'runtime' | 'profile' | 'credential'; readonly profile: R2ProfileV2 | null }
    | { readonly status: 'ready'; readonly profile: R2ProfileV2 }

/** Checks one already-snapshotted profile without re-reading mutable profile storage. */
export async function getR2ProfileReadiness(
    profile: R2ProfileV2,
): Promise<Exclude<DefaultR2Readiness, { status: 'loading' }>> {
    if (!runtimeCapabilities.r2ForegroundUpload.supported || typeof indexedDB === 'undefined') {
        return { status: 'unavailable', reason: 'runtime', profile }
    }
    if (profile.transport !== 'native-s3'
        || profile.accountId.trim().length === 0
        || profile.bucket.trim().length === 0) {
        return { status: 'unavailable', reason: 'profile', profile }
    }
    const credential = await nativeR2CredentialStatus(profile.credentialRef).catch(() => null)
    return credential?.available
        ? { status: 'ready', profile }
        : { status: 'unavailable', reason: 'credential', profile }
}

export async function getDefaultR2Readiness(
    profileId = DEFAULT_R2_PROFILE_ID,
): Promise<Exclude<DefaultR2Readiness, { status: 'loading' }>> {
    if (!runtimeCapabilities.r2ForegroundUpload.supported || typeof indexedDB === 'undefined') {
        return { status: 'unavailable', reason: 'runtime', profile: null }
    }
    let profile: R2ProfileV2 | null
    try {
        profile = await getRuntimeR2UploadRepository().getProfile(profileId)
    } catch {
        return { status: 'unavailable', reason: 'profile', profile: null }
    }
    if (!profile) return { status: 'unavailable', reason: 'profile', profile }
    return getR2ProfileReadiness(profile)
}

/** A saved preference cannot activate release work after its runtime prerequisites disappear. */
export function gateGenerationFolderAutoUpload(
    folder: ResolvedGenerationFolder | null,
    ready: boolean,
): ResolvedGenerationFolder | null {
    if (folder === null || !folder.r2.autoUpload || ready) return folder
    return {
        ...folder,
        r2: { ...folder.r2, autoUpload: false },
    }
}
