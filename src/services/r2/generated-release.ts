import { sha256Utf8 } from '@/domain/composition/canonical-serialize'
import {
    isR2BucketName,
    isResolvedR2Prefix,
    type NativeR2ScannedArtifact,
    type R2ProfileV2,
} from '@/domain/r2/types'
import { sha256Bytes } from '@/lib/binary-digest'
import { runtimeCapabilities } from '@/platform/capabilities'
import type { OutputWriteResult } from '@/services/output/output-writer'
import { createRuntimeOutputPlatformAdapter } from '@/services/output/tauri-output-adapter'
import { R2UploadRepositoryError } from './indexeddb-r2-upload-repository'
import { nativeR2CredentialStatus } from './native-r2-adapter'
import { getRuntimeR2UploadCoordinator, getRuntimeR2UploadRepository } from './runtime'

export type GeneratedR2ReleaseResult =
    | { readonly status: 'uploaded'; readonly artifactCount: number; readonly sidecarUploaded: boolean }
    | { readonly status: 'unavailable'; readonly reason: 'runtime' | 'profile' | 'credential' | 'output' }
    | { readonly status: 'pending-or-failed'; readonly failed: number; readonly pending: number }

export interface LocalImageR2ReleaseArtifact {
    readonly localPath: string
    readonly fileName: string
    readonly contentSha256: string
    readonly contentType: string
    readonly size: number
}

function remoteKey(prefix: string, fileName: string): string {
    const safeName = fileName.replace(/\\/g, '/').split('/').pop()?.trim() ?? ''
    if (!safeName || safeName === '.' || safeName === '..') throw new Error('Generated R2 release filename is invalid')
    const cleanPrefix = prefix.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    return [cleanPrefix, safeName].filter(Boolean).join('/')
}

/** This exact legacy tuple owns generated profile identity and compatible collision reuse. */
function generatedReleaseIdentity(profile: R2ProfileV2): readonly unknown[] {
    return [
        profile.accountId,
        profile.jurisdiction,
        profile.endpoint,
        profile.bucket,
        profile.prefix,
        profile.credentialRef,
        profile.transport,
        profile.conflictPolicy,
        profile.publicMode,
        profile.publicBaseUrl,
    ]
}

function hasSameGeneratedReleaseBinding(left: R2ProfileV2, right: R2ProfileV2): boolean {
    return JSON.stringify(generatedReleaseIdentity(left)) === JSON.stringify(generatedReleaseIdentity(right))
}

/**
 * Upload jobs store only a profile ID, so every generated release uses an
 * immutable, content-addressed profile. A later edit to the default profile
 * can therefore never redirect an already queued upload to another bucket.
 */
export function deriveGeneratedReleaseProfile(
    base: R2ProfileV2,
    target: { readonly bucket?: string | null; readonly prefix?: string | null },
    now = new Date().toISOString(),
): R2ProfileV2 {
    const bucket = target.bucket?.trim() || base.bucket.trim()
    const prefix = target.prefix ?? base.prefix
    if (!isR2BucketName(bucket) || !isResolvedR2Prefix(prefix)) {
        throw new TypeError('Generated R2 release target is invalid')
    }
    const profile: R2ProfileV2 = {
        ...base,
        id: '',
        name: `${base.name} · ${bucket}${prefix ? `/${prefix}` : ''}`,
        bucket,
        prefix,
        createdAt: now,
        updatedAt: now,
    }
    return {
        ...profile,
        id: `generated-release-${sha256Utf8(JSON.stringify(generatedReleaseIdentity(profile))).slice(0, 40)}`,
    }
}

/** Uploads one verified local image and, for private profiles, its audit sidecar. */
export async function releaseLocalImageToR2(input: {
    readonly profileId: string
    readonly sourceId: string
    readonly image: LocalImageR2ReleaseArtifact
    readonly sidecar?: LocalImageR2ReleaseArtifact
    readonly bucket?: string | null
    readonly prefix?: string | null
}): Promise<GeneratedR2ReleaseResult> {
    if (!runtimeCapabilities.r2ForegroundUpload.supported) {
        return { status: 'unavailable', reason: 'runtime' }
    }
    const repository = getRuntimeR2UploadRepository()
    const baseProfile = await repository.getProfile(input.profileId)
    if (!baseProfile
        || baseProfile.transport !== 'native-s3'
        || !baseProfile.accountId.trim()
        || !baseProfile.bucket.trim()) {
        return { status: 'unavailable', reason: 'profile' }
    }
    let profile: R2ProfileV2
    let derivedProfile: R2ProfileV2
    try {
        derivedProfile = deriveGeneratedReleaseProfile(baseProfile, {
            bucket: input.bucket,
            prefix: input.prefix,
        })
    } catch {
        return { status: 'unavailable', reason: 'profile' }
    }
    try {
        profile = await repository.putProfile(derivedProfile, null)
    } catch (error) {
        if (!(error instanceof R2UploadRepositoryError) || error.code !== 'E_R2_VERSION_CONFLICT') {
            return { status: 'unavailable', reason: 'profile' }
        }
        const existing = await repository.getProfile(derivedProfile.id).catch(() => null)
        if (!existing || !hasSameGeneratedReleaseBinding(existing, derivedProfile)) {
            return { status: 'unavailable', reason: 'profile' }
        }
        profile = existing
    }
    const credential = await nativeR2CredentialStatus(profile.credentialRef).catch(() => null)
    if (!credential?.available) return { status: 'unavailable', reason: 'credential' }
    if (profile.publicMode === 'private' && input.sidecar === undefined) {
        return { status: 'unavailable', reason: 'output' }
    }

    const artifacts: NativeR2ScannedArtifact[] = [{
        artifactId: `${input.sourceId}:release-image`,
        localVariant: input.image.localPath,
        remoteKey: remoteKey(profile.prefix, input.image.fileName),
        contentSha256: input.image.contentSha256,
        contentType: input.image.contentType,
        size: input.image.size,
    }]
    if (profile.publicMode === 'private' && input.sidecar !== undefined) {
        artifacts.push({
            artifactId: `${input.sourceId}:release-sidecar`,
            localVariant: input.sidecar.localPath,
            remoteKey: remoteKey(profile.prefix, input.sidecar.fileName),
            contentSha256: input.sidecar.contentSha256,
            contentType: input.sidecar.contentType,
            size: input.sidecar.size,
        })
    }

    const coordinator = getRuntimeR2UploadCoordinator()
    const plan = await coordinator.plan(profile, artifacts, 'current-session')
    await coordinator.enqueuePlan(plan)
    await coordinator.runUntilIdle(profile)
    const settled = await Promise.all(plan.jobs.map(job => repository.getJob(job.id)))
    const failed = settled.filter(job => job?.state === 'failed' || job?.state === 'cancelled').length
    const pending = settled.filter(job => job?.state === 'queued' || job?.state === 'running' || job === null).length
    if (failed > 0 || pending > 0) return { status: 'pending-or-failed', failed, pending }
    return {
        status: 'uploaded',
        artifactCount: artifacts.length,
        sidecarUploaded: profile.publicMode === 'private',
    }
}

/**
 * Uploads only the exact verified output set. Public profiles never receive the
 * prompt-bearing sidecar; private profiles require and upload the pair.
 */
export async function releaseGeneratedOutputToR2(input: {
    readonly profileId: string
    readonly sourceJobId: string
    readonly imageFormat: 'png' | 'webp'
    readonly output: OutputWriteResult
    readonly bucket?: string | null
    readonly prefix?: string | null
}): Promise<GeneratedR2ReleaseResult> {
    const finalImage = input.output.finalImage
    if (!finalImage) return { status: 'unavailable', reason: 'output' }
    let sidecar: LocalImageR2ReleaseArtifact | undefined
    if (input.output.sidecarFile) {
        const sidecarBytes = await createRuntimeOutputPlatformAdapter().readFile(input.output.sidecarFile)
        sidecar = {
            localPath: input.output.sidecarFile.displayPath,
            fileName: input.output.sidecarFile.displayPath,
            contentSha256: await sha256Bytes(sidecarBytes),
            contentType: 'application/json',
            size: sidecarBytes.byteLength,
        }
    }
    return releaseLocalImageToR2({
        profileId: input.profileId,
        sourceId: input.sourceJobId,
        image: {
            localPath: input.output.file.displayPath,
            fileName: input.output.fileName,
            contentSha256: finalImage.contentChecksum,
            contentType: `image/${input.imageFormat}`,
            size: finalImage.byteSize,
        },
        ...(sidecar === undefined ? {} : { sidecar }),
        bucket: input.bucket,
        prefix: input.prefix,
    })
}

/** Removes only the transaction-owned private original, never the published image. */
export async function discardGeneratedProviderOriginal(output: OutputWriteResult): Promise<boolean> {
    if (!output.providerOriginalFile) return false
    await createRuntimeOutputPlatformAdapter().remove(output.providerOriginalFile)
    return true
}
