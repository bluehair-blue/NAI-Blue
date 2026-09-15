import { DEFAULT_GENERATION_FOLDER_ID } from '@/domain/generation-folders'
import { DEFAULT_R2_PROFILE_ID } from '@/domain/r2/types'
import { resolveAnlasPricingBasis } from '@/lib/anlas-calculator'
import { resolveGenerationFolderAuthority } from '@/lib/generation-folder-authority-runtime'
import { generateRandomSeed } from '@/lib/utils'
import { createGenerationFolderDocumentBinding } from '@/application/folder/generation-folder-binding'
import { prepareMainGeneration } from '@/services/generation/main-generation-plan'
import {
    enqueuePreparedMainGeneration,
    type MainApplicationGenerationCommandResult,
} from '@/services/generation/main-application-generation-command'
import { credentialReadinessFingerprint } from '@/services/generation/generation-command'
import { getRuntimeR2UploadRepository } from '@/services/r2/runtime'
import { selectActiveCredentialsAreOpus, useAuthStore } from '@/stores/auth-store'
import { useQueueStore } from '@/stores/queue-store'
import { useSettingsStore } from '@/stores/settings-store'
import type { GenerationParams } from '@/services/novelai-types'

export class ManualReviewGenerationError extends Error {
    constructor(message: string, readonly mayHaveEnqueued: boolean) {
        super(message)
        this.name = 'ManualReviewGenerationError'
    }
}

/** Enqueues one human-approved image through the existing durable Main Queue. */
export async function queueManualReviewGeneration(
    cardId: string,
    params: GenerationParams,
    requestId = globalThis.crypto.randomUUID(),
): Promise<{ readonly batchId: string, readonly jobId: string }> {
    if (useQueueStore.getState().executionAuthority !== 'durable') {
        throw new ManualReviewGenerationError('내구성 큐가 준비된 뒤 다시 시도해 주세요.', false)
    }

    const auth = useAuthStore.getState()
    if (auth.getActiveTokens().length === 0) {
        auth.requestTokenEntry()
        throw new ManualReviewGenerationError('확인된 NovelAI 인증 정보가 필요합니다.', false)
    }

    const settings = useSettingsStore.getState()
    const folderDocument = settings.generationFolderDocument
    if (folderDocument === null) {
        throw new ManualReviewGenerationError('저장 폴더 설정이 준비되지 않았습니다.', false)
    }

    const defaults = { directory: settings.savePath, useAbsolutePath: settings.useAbsolutePath }
    const preliminaryFolder = resolveGenerationFolderAuthority(
        folderDocument,
        settings.generationFolders,
        settings.activeGenerationFolderId,
        defaults,
    )
    const r2Profile = preliminaryFolder?.r2.autoUpload
        ? await getRuntimeR2UploadRepository().getProfile(preliminaryFolder.r2.profileId ?? DEFAULT_R2_PROFILE_ID)
        : null
    const folder = r2Profile === null
        ? preliminaryFolder
        : resolveGenerationFolderAuthority(
            folderDocument,
            settings.generationFolders,
            settings.activeGenerationFolderId,
            { ...defaults, r2ProfileId: r2Profile.id, r2Bucket: r2Profile.bucket, r2Prefix: r2Profile.prefix },
        )
    const explicitFolder = folder?.id === DEFAULT_GENERATION_FOLDER_ID ? null : folder
    const seededParams: GenerationParams = {
        ...params,
        seed: params.seed === 0 ? generateRandomSeed() : params.seed,
        imageFormat: settings.imageFormat,
        metadataMode: folder?.r2.autoUpload ? 'strip-and-sidecar' : settings.metadataMode,
    }
    const prepared = prepareMainGeneration({
        params: seededParams,
        fallbackImageFormat: settings.imageFormat,
        fallbackMetadataMode: settings.metadataMode,
        streamingRequested: settings.useStreaming,
        sequenceCommitProposal: null,
        output: {
            autoSave: settings.autoSave,
            directory: explicitFolder?.directory || settings.savePath,
            useAbsolutePath: explicitFolder?.useAbsolutePath ?? settings.useAbsolutePath,
            capabilityFallbackDirectory: explicitFolder
                ? explicitFolder.useAbsolutePath ? 'NAI_Blue_Output' : explicitFolder.directory
                : settings.savePath,
            collisionPolicy: 'unique',
            generationFolderId: folder?.id ?? null,
            generationFolderPath: folder?.path ?? null,
            autoR2UploadProfileId: folder?.r2.autoUpload
                ? folder.r2.profileId ?? DEFAULT_R2_PROFILE_ID
                : null,
            r2Bucket: folder?.r2.bucket ?? null,
            r2Prefix: folder?.r2.prefix ?? null,
            ...(folder?.r2.provenance === undefined ? {} : { r2Provenance: folder.r2.provenance }),
        },
    })
    const captureId = `manual-review:${cardId}:${requestId}`

    let result: MainApplicationGenerationCommandResult
    try {
        result = await enqueuePreparedMainGeneration({
            prepared: [prepared],
            captureId,
            idempotencyKey: `manual-review:${captureId}`,
            pricingBasis: resolveAnlasPricingBasis({
                model: seededParams.model,
                activeCredentialsAreOpus: selectActiveCredentialsAreOpus(auth),
            }),
            approvedAt: new Date().toISOString(),
            credentialReadinessFingerprint: credentialReadinessFingerprint(auth),
            folderBinding: createGenerationFolderDocumentBinding(folderDocument),
            maxAttempts: 1,
        })
    } catch {
        throw new ManualReviewGenerationError(
            '요청 접수 상태를 확인할 수 없습니다. 중복 생성을 막기 위해 큐 센터에서 먼저 상태를 확인해 주세요.',
            true,
        )
    }

    if (result.status !== 'ready') {
        const reason = 'issues' in result ? result.issues[0]?.message : undefined
        throw new ManualReviewGenerationError(reason ?? '요청이 큐에 접수되지 않았습니다.', false)
    }

    const jobId = result.jobIds[0]
    if (jobId === undefined) {
        throw new ManualReviewGenerationError('큐 접수 결과를 확인할 수 없습니다. 큐 센터에서 상태를 확인해 주세요.', true)
    }
    useQueueStore.getState().setSelectedBatchId(result.batchId)
    return { batchId: result.batchId, jobId }
}
