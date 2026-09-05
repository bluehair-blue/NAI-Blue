import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from '@/components/ui/use-toast'
import { getScenePresetPathSegments, useSceneStore, type SceneCard } from '@/stores/scene-store'
import { useGenerationStore } from '@/stores/generation-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useAuthStore, type ApiSlot } from '@/stores/auth-store'
import { generateImage, generateImageStream, NovelAIHttpError } from '@/services/novelai-api'
import { useCharacterStore } from '@/stores/character-store'
import { useRotationStore } from '@/stores/character-rotation-store'
import { buildSceneGenerationParams } from '@/lib/scene-generation/build-scene-params'
import { reserveSceneFragmentSequenceProposal } from '@/lib/scene-generation/fragment-runtime'
import {
    registerDirectSceneArtifact,
    rollbackDirectSceneArtifact,
    saveSceneResult,
    type DirectSceneArtifactRegistration,
} from '@/lib/scene-generation/save-scene-result'
import { linkSceneArtifact } from '@/application/scene/link-scene-artifact'
import { applySceneDocumentProjection } from '@/lib/scene-authority-runtime'
import { getRuntimeSceneRepository } from '@/lib/scene-migration-startup'
import { getRotationCharacterFolderName } from '@/lib/scene-output-path'
import { reportDiagnostic } from '@/services/diagnostics/error-registry'
import {
    acquireSceneRequestController,
    type SceneRequestControllerLease,
} from '@/lib/scene-generation/request-cancellation'
import { useQueueStore } from '@/stores/queue-store'
import { createZustandSceneResultPresentation } from '@/presentation/scene/zustand-scene-result-presentation'
import { resolveGenerationFolderAuthority } from '@/lib/generation-folder-authority-runtime'
import { DEFAULT_R2_PROFILE_ID } from '@/domain/r2/types'
import { gateGenerationFolderAutoUpload, getDefaultR2Readiness } from '@/services/r2/readiness'
import { releaseGeneratedOutputToR2 } from '@/services/r2/generated-release'

const activeSceneWorkerCounts = new Map<number, number>()
const runningSceneSlots = new Set<ApiSlot>()
const sceneResultPresentation = createZustandSceneResultPresentation()
let releasedImageDataSessionId: number | null = null

type Translate = ReturnType<typeof useTranslation>['t']

interface SceneWorkerContext {
    activePresetId: string
    sessionId: number
    sceneSavePath: string
    streamingView: boolean
    t: Translate
    rotationCharacterId?: string
    rotationCharacterFolderName?: string
}

type SceneProcessStatus = 'success' | 'retryable' | 'fatal' | 'invalid' | 'cancelled'

interface SceneProcessResult {
    status: SceneProcessStatus
    reason?: string
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function isSessionAlive(sessionId: number): boolean {
    const state = useSceneStore.getState()
    return state.isGenerating && !state.isCancelling && state.generationSessionId === sessionId
}

function shouldStopForSession(sessionId: number): boolean {
    return !isSessionAlive(sessionId)
}

function incrementActiveSceneWorkerCount(sessionId: number): void {
    activeSceneWorkerCounts.set(sessionId, (activeSceneWorkerCounts.get(sessionId) ?? 0) + 1)
}

function decrementActiveSceneWorkerCount(sessionId: number): void {
    const nextCount = (activeSceneWorkerCounts.get(sessionId) ?? 0) - 1
    if (nextCount > 0) {
        activeSceneWorkerCounts.set(sessionId, nextCount)
    } else {
        activeSceneWorkerCounts.delete(sessionId)
    }
}

function hasActiveSceneWorkers(): boolean {
    return activeSceneWorkerCounts.size > 0
}

function handleSceneCancellationState(): boolean {
    const sceneStore = useSceneStore.getState()
    if (!sceneStore.isCancelling) return false

    if (!hasActiveSceneWorkers()) {
        const generationStore = useGenerationStore.getState()
        if (generationStore.generatingMode === 'scene') {
            generationStore.setGeneratingMode(null)
        }
        sceneStore.setIsGenerating(false)
    }

    return true
}

function releaseImageDataOnce(sessionId: number): void {
    if (releasedImageDataSessionId === sessionId) return
    releasedImageDataSessionId = sessionId
    useCharacterStore.getState().releaseImageData()
}

function isRetryableReason(reason: string): boolean {
    const normalized = reason.toLowerCase()
    return normalized.includes('429')
        || normalized.includes('too many requests')
        || normalized.includes('rate limit')
        || /api (?:error|오류)[^\d]*(5\d\d)/i.test(reason)
        || /\((5\d\d)\)/.test(reason)
}

function classifyProcessError(
    error: unknown,
    termination?: 'cancelled' | 'timeout',
): SceneProcessResult {
    if (termination === 'cancelled') return { status: 'cancelled', reason: 'Generation request cancelled' }
    // A hard timeout has an indeterminate provider outcome. Preserve the queue
    // item, but do not automatically submit a duplicate request.
    if (termination === 'timeout') return { status: 'fatal', reason: 'Generation request timed out' }
    if (error instanceof NovelAIHttpError) {
        return {
            status: error.retryable ? 'retryable' : 'fatal',
            reason: error.message,
        }
    }

    const reason = error instanceof Error ? error.message : String(error)
    const normalized = reason.toLowerCase()
    if (normalized.includes('abort') || reason.includes('요청이 취소')) {
        return { status: 'cancelled', reason }
    }

    return {
        status: isRetryableReason(reason) ? 'retryable' : 'fatal',
        reason,
    }
}

function reportSceneFailure(result: SceneProcessResult, ctx: SceneWorkerContext): void {
    const reason = result.reason || 'Generation failed'

    if (result.status === 'fatal') {
        toast({ title: ctx.t('common.error', '오류'), description: reason, variant: 'destructive' })
    }
}

async function processSceneWithSlot(
    slot: ApiSlot,
    token: string,
    scene: SceneCard,
    ctx: SceneWorkerContext,
    filenameTemplate?: string,
): Promise<SceneProcessResult> {
    if (!isSessionAlive(ctx.sessionId)) return { status: 'cancelled' }

    const operationId = crypto.randomUUID()
    const requestId = `scene-request:${ctx.sessionId}:${scene.id}:${operationId}`
    const seed = useSceneStore.getState().consumeSceneGenerationSeed(ctx.activePresetId, scene.id)
    useSceneStore.getState().setStreamingData(scene.id, null, 0)
    let sequenceLease: ReturnType<typeof reserveSceneFragmentSequenceProposal> = null
    let requestLease: SceneRequestControllerLease | null = null

    try {
        const resolveStartedAt = Date.now()
        const settingsSnapshot = useSettingsStore.getState()
        const preliminaryFolder = resolveGenerationFolderAuthority(
            settingsSnapshot.generationFolderDocument,
            settingsSnapshot.generationFolders,
            scene.generationFolderId,
            {
                directory: settingsSnapshot.sceneSavePath,
                useAbsolutePath: settingsSnapshot.useAbsoluteScenePath,
            },
        )
        const r2Readiness = preliminaryFolder?.r2.autoUpload
            ? await getDefaultR2Readiness(preliminaryFolder.r2.profileId ?? DEFAULT_R2_PROFILE_ID)
            : null
        const baseR2Profile = r2Readiness?.status === 'ready' ? r2Readiness.profile : null
        const resolvedFolder = baseR2Profile === null
            ? preliminaryFolder
            : resolveGenerationFolderAuthority(
                settingsSnapshot.generationFolderDocument,
                settingsSnapshot.generationFolders,
                scene.generationFolderId,
                {
                    directory: settingsSnapshot.sceneSavePath,
                    useAbsolutePath: settingsSnapshot.useAbsoluteScenePath,
                    r2ProfileId: baseR2Profile.id,
                    r2Bucket: baseR2Profile.bucket,
                    r2Prefix: baseR2Profile.prefix,
                },
            )
        const generationFolder = gateGenerationFolderAutoUpload(
            resolvedFolder,
            r2Readiness?.status === 'ready',
        )
        const built = await buildSceneGenerationParams(scene, {
            sessionId: ctx.sessionId,
            requestId,
            now: new Date(resolveStartedAt),
            presetId: ctx.activePresetId,
            generationFolder,
            seed,
        })
        if (!isSessionAlive(ctx.sessionId)) return { status: 'cancelled' }

        useSceneStore.getState().recordSceneCompositionResult(scene.id, {
            mode: built.mode,
            ...(built.planHash === null ? {} : { planHash: built.planHash }),
            warnings: built.warnings,
            errors: built.errors,
        })
        if (!built.success) {
            return {
                status: 'invalid',
                reason: built.errors.map(issue => issue.code).join(', ') || 'Invalid composition plan',
            }
        }

        sequenceLease = built.sequenceCommitProposal === null
            ? null
            : reserveSceneFragmentSequenceProposal(built.sequenceCommitProposal)
        if (built.sequenceCommitProposal !== null && sequenceLease === null) {
            const failure = { status: 'retryable', reason: 'Fragment sequence changed before reservation' } as const
            reportSceneFailure(failure, ctx)
            return failure
        }

        const { params, finalPrompt, mimeType } = built
        requestLease = acquireSceneRequestController({
            sessionId: ctx.sessionId,
            slot,
            requestId,
        })
        if (!isSessionAlive(ctx.sessionId)) {
            requestLease.abort()
            return { status: 'cancelled' }
        }

        // Keep i2i/inpaint on ZIP until stream-final output is proven identical
        // to the server-composited archive result.
        const hasSourceEdit = Boolean(params.sourceImage || params.mask)
        const canUseStreaming = ctx.streamingView && !hasSourceEdit
        const streamMimeType = params.imageFormat === 'webp' ? 'image/webp' : 'image/png'
        const result = canUseStreaming
            ? await generateImageStream(token, params, (progress, image) => {
                if (!isSessionAlive(ctx.sessionId)) return
                if (image) {
                    useSceneStore.getState().setStreamingData(scene.id, `data:${streamMimeType};base64,${image}`, progress / 100)
                } else {
                    useSceneStore.getState().setStreamingData(scene.id, null, progress / 100)
                }
            }, requestLease.signal)
            : await generateImage(token, params, requestLease.signal)

        if (!isSessionAlive(ctx.sessionId)) return { status: 'cancelled' }

        if (!result.success || !result.imageData) {
            reportDiagnostic(new Error(result.error || 'Scene generation failed'), {
                operation: 'scene.generate',
                stage: canUseStreaming ? 'stream' : 'request',
                sceneId: scene.id,
                correlationId: requestId,
                prompt: finalPrompt,
            })
            const failure = classifyProcessError(result.error || 'Generation failed', result.termination)
            reportSceneFailure(failure, ctx)
            return failure
        }

        if (!isSessionAlive(ctx.sessionId)) return { status: 'cancelled' }
        let sequenceConflict = false
        const activeSequenceLease = sequenceLease
        const sceneState = useSceneStore.getState()
        const preset = sceneState.presets.find(candidate => candidate.id === ctx.activePresetId)
        const baseOutputContext = {
            useAbsoluteScenePath: generationFolder?.useAbsolutePath ?? settingsSnapshot.useAbsoluteScenePath,
            metadataMode: generationFolder?.r2.autoUpload
                ? 'strip-and-sidecar' as const
                : scene.metadataMode ?? settingsSnapshot.metadataMode,
            presetName: preset?.name || 'Default',
            presetPathSegments: getScenePresetPathSegments(sceneState.presets, ctx.activePresetId),
            sceneName: scene.name,
            sceneSubfoldersEnabled: settingsSnapshot.sceneSubfoldersEnabled,
            ...(filenameTemplate?.trim() ? { filenameTemplate: filenameTemplate.trim() } : {}),
        }
        const outputContext = generationFolder === null
            ? baseOutputContext
            : {
                ...baseOutputContext,
                generationFolderId: generationFolder.id,
                generationFolderPath: generationFolder.path,
                directory: generationFolder.directory,
                capabilityFallbackDirectory: generationFolder.useAbsolutePath ? 'NAI_Blue_Scene' : generationFolder.directory,
                autoR2UploadProfileId: generationFolder.r2.autoUpload
                    ? generationFolder.r2.profileId ?? DEFAULT_R2_PROFILE_ID
                    : null,
                r2Bucket: generationFolder.r2.bucket,
                r2Prefix: generationFolder.r2.prefix,
            }
        const sourceJobId = `scene-direct-${operationId}`
        let artifactRegistration: DirectSceneArtifactRegistration | null = null
        const saved = await saveSceneResult(scene, ctx, finalPrompt, params, result.imageData, mimeType, result.encodedVibes, {
            presentation: sceneResultPresentation,
            canSave: () => isSessionAlive(ctx.sessionId),
            sentPayloadSummary: result.sentPayloadSummary,
            sourceJobId,
            outputContext,
            registerArtifact: async output => {
                artifactRegistration = await registerDirectSceneArtifact(sourceJobId, scene.id, output)
                return artifactRegistration === null
                    ? null
                    : {
                        artifactId: artifactRegistration.record.artifactId,
                        sourceJobId,
                        sourceSceneId: scene.id,
                    }
            },
            linkArtifact: async lineage => {
                const linked = await linkSceneArtifact(getRuntimeSceneRepository(), {
                    presetId: ctx.activePresetId,
                    sceneId: scene.id,
                    artifactId: lineage.artifactId,
                    createdAt: artifactRegistration?.record.createdAt ?? new Date().toISOString(),
                    favorite: false,
                })
                if ('document' in linked) applySceneDocumentProjection(linked.document)
            },
            rollbackArtifact: async () => {
                await rollbackDirectSceneArtifact(artifactRegistration)
                artifactRegistration = null
            },
            ...(generationFolder?.r2.autoUpload
                ? {
                    afterSave: async output => {
                        try {
                            const release = await releaseGeneratedOutputToR2({
                                profileId: generationFolder.r2.profileId ?? DEFAULT_R2_PROFILE_ID,
                                sourceJobId,
                                imageFormat: mimeType === 'image/webp' ? 'webp' : 'png',
                                output,
                                bucket: generationFolder.r2.bucket,
                                prefix: generationFolder.r2.prefix,
                            })
                            if (release.status !== 'uploaded' && release.status !== 'queued') {
                                reportDiagnostic(new Error(`Generated R2 release did not complete: ${release.status}`), {
                                    operation: 'r2.generated-release',
                                    stage: release.status,
                                    jobId: sourceJobId,
                                })
                            }
                        } catch (error) {
                            reportDiagnostic(error, {
                                operation: 'r2.generated-release',
                                stage: 'upload',
                                jobId: sourceJobId,
                            })
                        }
                    },
                }
                : {}),
            ...(activeSequenceLease === null
                ? {}
                : {
                    beforeFinalize: () => {
                        if (!isSessionAlive(ctx.sessionId)) return false
                        const committed = activeSequenceLease.commit()
                        sequenceConflict = !committed
                        return committed
                    },
                }),
        })
        if (!saved || !isSessionAlive(ctx.sessionId)) {
            if (sequenceConflict) {
                const failure = { status: 'retryable', reason: 'Fragment sequence changed before commit' } as const
                reportSceneFailure(failure, ctx)
                return failure
            }
            return { status: 'cancelled' }
        }

        useAuthStore.getState().refreshAnlas(slot)

        const currentState = useSceneStore.getState()
        currentState.setGenerationProgress(currentState.completedCount + 1, currentState.totalQueuedCount)
        return { status: 'success' }
    } catch (error) {
        reportDiagnostic(error, {
            operation: 'scene.generate',
            stage: 'request',
            sceneId: scene.id,
            correlationId: requestId,
        })
        const failure = classifyProcessError(error)
        reportSceneFailure(failure, ctx)
        return failure
    } finally {
        requestLease?.release()
        sequenceLease?.release()
    }
}

function finalizeWorkers(ctx: SceneWorkerContext): void {
    if ((activeSceneWorkerCounts.get(ctx.sessionId) ?? 0) !== 0) return

    const sceneStore = useSceneStore.getState()
    const sessionMatches = sceneStore.generationSessionId === ctx.sessionId
    const wasCancelling = sceneStore.isCancelling

    if (!sessionMatches && !wasCancelling) {
        return
    }

    const queueRemaining = sceneStore.getQueuedScenes(ctx.activePresetId).length

    sceneStore.setStreamingData(null, null, 0)
    useGenerationStore.getState().setGeneratingMode(null)
    releaseImageDataOnce(ctx.sessionId)
    sceneStore.setIsGenerating(false)

    if (queueRemaining === 0) {
        sceneStore.setGenerationProgress(0, 0)
        if (!wasCancelling) {
            toast({
                title: ctx.t('generate.complete', '생성 완료'),
                description: ctx.t('generate.allComplete', '모든 예약된 작업이 완료되었습니다.'),
                variant: 'success',
            })
        }
    }
}

async function workerLoop(slot: ApiSlot, token: string, ctx: SceneWorkerContext): Promise<void> {
    incrementActiveSceneWorkerCount(ctx.sessionId)
    try {
        while (true) {
            if (shouldStopForSession(ctx.sessionId)) return
            if (!useAuthStore.getState().isSlotActive(slot)) return

            const claim = useSceneStore.getState().decrementFirstQueuedScene(ctx.activePresetId)
            if (!claim) return

            const { scene, filenameTemplate } = claim
            const result = await processSceneWithSlot(slot, token, scene, ctx, filenameTemplate)
            if (result.status === 'cancelled') return

            if (result.status === 'invalid') {
                useSceneStore.getState().setStreamingData(null, null, 0)
                continue
            }

            if (result.status === 'retryable' || result.status === 'fatal') {
                useSceneStore.getState().setStreamingData(null, null, 0)

                if (isSessionAlive(ctx.sessionId)) {
                    useSceneStore.getState().requeueSceneGeneration(ctx.activePresetId, scene.id, filenameTemplate)
                }

                if (result.status === 'retryable' && isSessionAlive(ctx.sessionId) && useAuthStore.getState().isSlotActive(slot)) {
                    await sleep(3000)
                    continue
                }

                useSceneStore.getState().setIsGenerating(false)
                return
            }

            useSceneStore.getState().setStreamingData(null, null, 0)

            const state = useSceneStore.getState()
            const hasMoreScenes = isSessionAlive(ctx.sessionId) && state.getQueuedScenes(ctx.activePresetId).length > 0
            if (hasMoreScenes) {
                const { generationDelay } = useSettingsStore.getState()
                if (generationDelay > 0) {
                    await sleep(generationDelay)
                }
            }
        }
    } finally {
        decrementActiveSceneWorkerCount(ctx.sessionId)
        finalizeWorkers(ctx)
    }
}

export function useSceneGeneration() {
    const { t } = useTranslation()
    const sceneSavePath = useSettingsStore(state => state.sceneSavePath)
    const streamingView = useSettingsStore(state => state.useStreaming)
    const isGenerating = useSceneStore(state => state.isGenerating)
    const activePresetId = useSceneStore(state => state.activePresetId)
    const generationSessionId = useSceneStore(state => state.generationSessionId)
    const completedCount = useSceneStore(state => state.completedCount)
    const totalQueuedCount = useSceneStore(state => state.totalQueuedCount)
    const initGenerationProgress = useSceneStore(state => state.initGenerationProgress)
    const setIsGenerating = useSceneStore(state => state.setIsGenerating)
    const slot1Enabled = useAuthStore(state => state.slot1Enabled)
    const slot2Enabled = useAuthStore(state => state.slot2Enabled)
    const isVerified = useAuthStore(state => state.isVerified)
    const isVerified2 = useAuthStore(state => state.isVerified2)
    const token = useAuthStore(state => state.token)
    const token2 = useAuthStore(state => state.token2)
    const executionAuthority = useQueueStore(state => state.executionAuthority)
    const rotationActive = useRotationStore(state => state.active)

    useEffect(() => {
        // Rotation retains the established session/worker executor during the
        // compatibility release. Normal Scene launches use the durable queue.
        if (!isGenerating || (executionAuthority !== 'legacy' && !rotationActive)) return

        const startWorkers = () => {
            if (!activePresetId) {
                setIsGenerating(false)
                return
            }

            if (handleSceneCancellationState()) return

            const activeGeneratingMode = useGenerationStore.getState().generatingMode
            if (activeGeneratingMode && activeGeneratingMode !== 'scene') {
                setIsGenerating(false)
                toast({
                    title: t('common.error', '오류'),
                    description: activeGeneratingMode === 'main'
                        ? t('generate.conflictMain', '메인 모드에서 생성 중입니다.')
                        : t('generate.conflictStyleLab', '그림체 연구소에서 생성 중입니다.'),
                    variant: 'destructive',
                })
                return
            }

            const tokens = useAuthStore.getState().getActiveTokens()
            if (tokens.length === 0) {
                setIsGenerating(false)
                useAuthStore.getState().requestTokenEntry()
                toast({
                    title: t('toast.tokenRequired.title', '토큰 필요'),
                    description: t('toast.tokenRequired.desc', '먼저 API 토큰을 검증해주세요.'),
                    variant: 'destructive',
                })
                return
            }

            if (completedCount === 0 && totalQueuedCount === 0) {
                initGenerationProgress()
            }

            const generationStore = useGenerationStore.getState()
            if (generationStore.generatingMode !== 'scene') {
                generationStore.setGeneratingMode('scene')
            }

            const rotation = useRotationStore.getState()
            const rotationCharacterId = rotation.active && rotation.snapshot
                ? rotation.characterIds[rotation.currentIndex]
                : undefined

            const ctx: SceneWorkerContext = {
                activePresetId,
                sessionId: generationSessionId,
                sceneSavePath,
                streamingView,
                t,
                rotationCharacterId,
                rotationCharacterFolderName: getRotationCharacterFolderName(rotationCharacterId, rotation.currentIndex) ?? undefined,
            }

            const sourceEditActive = Boolean(useGenerationStore.getState().sourceImage || useGenerationStore.getState().mask)
            const workerTokens = streamingView && !sourceEditActive ? tokens.slice(0, 1) : tokens

            for (const activeToken of workerTokens) {
                if (runningSceneSlots.has(activeToken.slot)) continue
                useRotationStore.getState().onWorkerConfirmed()
                runningSceneSlots.add(activeToken.slot)
                void workerLoop(activeToken.slot, activeToken.token, ctx).finally(() => {
                    runningSceneSlots.delete(activeToken.slot)
                })
            }
        }

        startWorkers()
    }, [
        isGenerating,
        activePresetId,
        generationSessionId,
        sceneSavePath,
        streamingView,
        t,
        completedCount,
        totalQueuedCount,
        initGenerationProgress,
        setIsGenerating,
        slot1Enabled,
        slot2Enabled,
        isVerified,
        isVerified2,
        token,
        token2,
        executionAuthority,
        rotationActive,
    ])

    useEffect(() => {
        if (!isGenerating && !hasActiveSceneWorkers()) {
            runningSceneSlots.clear()
        }
    }, [isGenerating])

    return {
        isGenerating,
    }
}

// Characterization tests need to exercise the real worker/session control flow
// without mounting the React hook. Exporting the existing functions does not
// alter production behavior; it only exposes the current orchestration seam.
export const __sceneGenerationTest = {
    isSessionAlive,
    classifyProcessError,
    processSceneWithSlot,
    workerLoop,
    handleSceneCancellationState,
}
