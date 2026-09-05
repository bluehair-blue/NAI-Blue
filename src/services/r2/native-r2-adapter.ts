import { invoke, isTauri } from '@tauri-apps/api/core'

import type {
    NativeR2ScannedArtifact,
    R2ProfileV2,
    UploadCompletedPart,
} from '@/domain/r2/types'
import { requireRuntimeCapability } from '@/platform/capabilities'

export interface NativeR2ErrorShape {
    code: string
    message: string
    retryable: boolean
    status?: number | null
}

export class NativeR2Error extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly retryable: boolean,
        readonly status: number | null,
    ) {
        super(message)
        this.name = 'NativeR2Error'
    }
}

export interface NativeR2PutResult {
    remoteKey: string
    uploaded: boolean
    skippedSame: boolean
    etag: string | null
}

export interface NativeR2HeadResult {
    exists: boolean
    size: number | null
    contentSha256: string | null
    etag: string | null
}

export interface NativeR2MultipartStartResult {
    remoteKey: string
    uploadId: string
}

function nativeProfile(profile: R2ProfileV2) {
    return {
        accountId: profile.accountId,
        jurisdiction: profile.jurisdiction,
        endpoint: profile.endpoint,
        bucket: profile.bucket,
        prefix: profile.prefix,
        credentialRef: profile.credentialRef,
        conflictPolicy: profile.conflictPolicy,
    }
}

function safeNativeError(error: unknown): NativeR2Error {
    if (error instanceof NativeR2Error) return error
    if (error && typeof error === 'object') {
        const record = error as Partial<NativeR2ErrorShape>
        if (typeof record.code === 'string' && typeof record.message === 'string') {
            return new NativeR2Error(
                record.code,
                record.message,
                record.retryable === true,
                typeof record.status === 'number' ? record.status : null,
            )
        }
    }
    return new NativeR2Error('E_R2_NATIVE', 'The native R2 operation failed.', false, null)
}

async function invokeNative<T>(command: string, args: Record<string, unknown>): Promise<T> {
    requireRuntimeCapability('r2ForegroundUpload')
    if (!isTauri()) throw new NativeR2Error('E_R2_UNSUPPORTED', 'Native R2 upload requires the Tauri runtime.', false, null)
    try {
        return await invoke<T>(command, args)
    } catch (error) {
        throw safeNativeError(error)
    }
}

/** One-way registration. No command exists that returns either secret. */
export async function storeNativeR2Credential(input: {
    credentialRef: string
    accessKeyId: string
    secretAccessKey: string
}): Promise<{ credentialRef: string; available: boolean }> {
    return invokeNative('r2_store_credential', { request: input })
}

export async function nativeR2CredentialStatus(credentialRef: string): Promise<{ credentialRef: string; available: boolean }> {
    return invokeNative('r2_credential_status', { credentialRef })
}

export async function deleteNativeR2Credential(credentialRef: string): Promise<void> {
    return invokeNative('r2_delete_credential', { credentialRef })
}

export async function testNativeR2Connection(profile: R2ProfileV2): Promise<{ ok: boolean }> {
    return invokeNative('r2_test_connection', { profile: nativeProfile(profile) })
}

export async function testNativeR2TemporaryObject(profile: R2ProfileV2): Promise<{ put: boolean; head: boolean; deleted: boolean }> {
    return invokeNative('r2_test_temporary_object', { profile: nativeProfile(profile) })
}

export async function scanNativeR2Artifacts(localRoot: string, prefix: string): Promise<NativeR2ScannedArtifact[]> {
    return invokeNative('r2_scan_local_artifacts', { localRoot, prefix })
}

/** Public image profiles fail closed: prompt-bearing JSON and arbitrary files stay local. */
export function filterNativeR2ArtifactsForProfile(
    profile: R2ProfileV2,
    artifacts: readonly NativeR2ScannedArtifact[],
): NativeR2ScannedArtifact[] {
    if (profile.publicMode === 'private') return [...artifacts]
    return artifacts.filter(artifact => artifact.contentType.startsWith('image/'))
}

export interface NativeR2UploadAdapter {
    headObject(profile: R2ProfileV2, remoteKey: string): Promise<NativeR2HeadResult>
    putObject(profile: R2ProfileV2, job: {
        localVariant: string
        size: number
        remoteKey: string
        contentSha256: string
        contentType: string
    }): Promise<NativeR2PutResult>
    createMultipart(profile: R2ProfileV2, job: {
        localVariant: string
        size: number
        remoteKey: string
        contentSha256: string
        contentType: string
    }): Promise<NativeR2MultipartStartResult>
    uploadPart(profile: R2ProfileV2, input: {
        localVariant: string
        size: number
        contentSha256: string
        remoteKey: string
        uploadId: string
        partNumber: number
        offset: number
        length: number
    }): Promise<UploadCompletedPart>
    completeMultipart(profile: R2ProfileV2, input: {
        remoteKey: string
        uploadId: string
        contentSha256: string
        completedParts: readonly UploadCompletedPart[]
    }): Promise<NativeR2PutResult>
    abortMultipart(profile: R2ProfileV2, input: { remoteKey: string; uploadId: string }): Promise<void>
}

export const nativeR2UploadAdapter: NativeR2UploadAdapter = {
    headObject(profile, remoteKey) {
        return invokeNative('r2_head_object', { profile: nativeProfile(profile), remoteKey })
    },
    putObject(profile, job) {
        return invokeNative('r2_put_object', {
            profile: nativeProfile(profile),
            localPath: job.localVariant,
            contentSize: job.size,
            remoteKey: job.remoteKey,
            contentSha256: job.contentSha256,
            contentType: job.contentType,
        })
    },
    createMultipart(profile, job) {
        return invokeNative('r2_create_multipart', {
            profile: nativeProfile(profile),
            localPath: job.localVariant,
            contentSize: job.size,
            remoteKey: job.remoteKey,
            contentSha256: job.contentSha256,
            contentType: job.contentType,
        })
    },
    uploadPart(profile, input) {
        return invokeNative('r2_upload_part', {
            profile: nativeProfile(profile),
            localPath: input.localVariant,
            contentSize: input.size,
            contentSha256: input.contentSha256,
            remoteKey: input.remoteKey,
            uploadId: input.uploadId,
            partNumber: input.partNumber,
            offset: input.offset,
            length: input.length,
        })
    },
    completeMultipart(profile, input) {
        return invokeNative('r2_complete_multipart', {
            profile: nativeProfile(profile),
            remoteKey: input.remoteKey,
            uploadId: input.uploadId,
            contentSha256: input.contentSha256,
            completedParts: input.completedParts,
        })
    },
    abortMultipart(profile, input) {
        return invokeNative('r2_abort_multipart', {
            profile: nativeProfile(profile),
            remoteKey: input.remoteKey,
            uploadId: input.uploadId,
        })
    },
}
