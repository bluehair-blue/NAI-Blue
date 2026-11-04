import JSZip from 'jszip'
import { invoke } from '@tauri-apps/api/core'
import { sha256Utf8 } from '@/domain/composition/canonical-serialize'
import { embedNaiBlueParams } from '@/lib/nai-blue-metadata'
import {
    buildNaiBlueParams,
    redactSentPayloadForMetadata,
    shouldEmbedNaiBlueParams,
} from '@/lib/generation-metadata'
import {
    NovelAiModelCapabilityError,
    adaptGenerationParams,
} from '@/services/nai/adapter'
import { NAI_ENDPOINTS } from '@/services/nai/endpoints'
import { buildGenerateImagePayload } from '@/services/nai/payload'
import { stripBase64Header } from '@/services/nai/refs'
import { readNaiImageStream } from '@/services/nai/stream'
import {
    NaiTransportCancelledError,
    NaiTransportTimeoutError,
    getNaiAuxiliaryFetch,
    getRuntimeNaiTransport,
    type NaiProviderFaultInjector,
    type NaiProviderObserver,
    type NaiTransportStage,
} from '@/services/nai/transport'
import { recordDiagnosticEvent, reportDiagnostic } from '@/services/diagnostics/error-registry'
import { OperationMonitor } from '@/services/diagnostics/operation-monitor'
import {
    NovelAIHttpError,
    type GenerateImageResult,
    type GenerationParams,
    type NovelAIUserInfo,
    type OpusGenerationUsage,
} from '@/services/novelai-types'

export const NAI_STANDARD_TIMEOUT_MS = 120_000
export const NAI_STREAM_TIMEOUT_MS = 120_000

export interface NaiGenerationExecutionHooks {
    readonly observer?: NaiProviderObserver
    /** Opt-in Queue mode; existing presentation callers keep failure results. */
    readonly errorMode?: 'result' | 'throw'
}

function isAbortError(error: unknown): boolean {
    return error instanceof NaiTransportCancelledError
        || (error instanceof DOMException && error.name === 'AbortError')
        || (error instanceof Error && error.name === 'AbortError')
}

function isTimeoutError(error: unknown): boolean {
    return error instanceof NaiTransportTimeoutError
}

function observeTransportStage(
    operation: ReturnType<OperationMonitor['start']>,
): (stage: NaiTransportStage) => void {
    return stage => {
        if (stage === 'stream-heartbeat') operation.heartbeat(stage)
        else operation.stageStart(stage)
    }
}

function taggedImage(base64: string, params: GenerationParams): string {
    return shouldEmbedNaiBlueParams(params.metadataMode)
        ? embedNaiBlueParams(base64, buildNaiBlueParams(params))
        : base64
}

async function firstZipEntryBase64(
    data: ArrayBuffer,
    emptyMessage: string,
    requireNamedPng = false,
): Promise<string> {
    const zip = await JSZip.loadAsync(data)
    const imageFilename = Object.keys(zip.files).find(name => /^image.*\.png$/i.test(name))
    const filename = imageFilename ?? (requireNamedPng ? undefined : Object.keys(zip.files)[0])
    if (!filename) throw new Error(emptyMessage)
    const file = zip.file(filename)
    if (!file) throw new Error('ZIP 파일에서 이미지를 읽을 수 없습니다.')
    return file.async('base64')
}

function makeSentPayloadSummary(sentPayload: string): string {
    return `sha256:${sha256Utf8(redactSentPayloadForMetadata(sentPayload))}`
}

const naiOperationMonitor = new OperationMonitor({
    onObservation: recordDiagnosticEvent,
    autoCheck: true,
    pollIntervalMs: 1_000,
})

interface NativeAnlasResult {
    success: boolean
    fixed?: number
    purchased?: number
    usage?: unknown
    error?: string
}

function parseOpusGenerationUsage(value: unknown): OpusGenerationUsage | undefined {
    if (value === null || typeof value !== 'object') return undefined
    const record = value as Record<string, unknown>
    const { percent, isNegative, timeUntilNextPercent } = record
    if (
        typeof percent !== 'number'
        || !Number.isFinite(percent)
        || typeof isNegative !== 'boolean'
        || typeof timeUntilNextPercent !== 'number'
        || !Number.isFinite(timeUntilNextPercent)
        || timeUntilNextPercent < 0
    ) return undefined
    const purchasedPercent = typeof record.purchasedPercent === 'number'
        && Number.isFinite(record.purchasedPercent)
        ? Math.min(400, Math.max(0, record.purchasedPercent))
        : undefined
    return {
        percent: Math.min(100, Math.max(0, percent)),
        isNegative,
        timeUntilNextPercent,
        ...(purchasedPercent === undefined ? {} : { purchasedPercent }),
    }
}

export async function getUserInfo(token: string): Promise<NovelAIUserInfo | null> {
    try {
        const result = await invoke<NativeAnlasResult>(
            'get_anlas_balance',
            { token: token.trim() },
        )
        if (!result.success) return null
        const fixed = result.fixed ?? 0
        const purchased = result.purchased ?? 0
        const usage = parseOpusGenerationUsage(result.usage)
        return {
            anlas: { fixed, purchased, total: fixed + purchased },
            ...(usage === undefined ? {} : { usage }),
        }
    } catch (error) {
        reportDiagnostic(error, { operation: 'nai.user-info', stage: 'invoke' })
        return null
    }
}

export async function verifyToken(token: string): Promise<{
    valid: boolean
    tier?: 'paper' | 'tablet' | 'scroll' | 'opus'
    error?: string
}> {
    try {
        const result = await invoke<{ valid: boolean; tier?: string; error?: string }>(
            'verify_token',
            { token: token.trim() },
        )
        if (result.valid && result.tier) {
            return { valid: true, tier: result.tier as 'paper' | 'tablet' | 'scroll' | 'opus' }
        }
        const event = reportDiagnostic(new Error(result.error || '인증 실패'), {
            operation: 'nai.verify-token',
            stage: 'invoke',
            category: 'auth',
        })
        return { valid: false, error: event.userSummary }
    } catch (error) {
        const event = reportDiagnostic(error, { operation: 'nai.verify-token', stage: 'invoke', category: 'auth' })
        return { valid: false, error: event.userSummary }
    }
}

export async function getAnlasBalance(token: string): Promise<{
    success: boolean
    fixedTrainingStepsLeft?: number
    purchasedTrainingSteps?: number
    usage?: OpusGenerationUsage
    error?: string
}> {
    try {
        const result = await invoke<NativeAnlasResult>(
            'get_anlas_balance',
            { token: token.trim() },
        )
        if (!result.success) {
            const event = reportDiagnostic(new Error(result.error || 'Anlas balance request failed'), {
                operation: 'nai.anlas-balance',
                stage: 'invoke',
            })
            return { success: false, error: event.userSummary }
        }
        const usage = parseOpusGenerationUsage(result.usage)
        return {
            success: result.success,
            fixedTrainingStepsLeft: result.fixed,
            purchasedTrainingSteps: result.purchased,
            ...(usage === undefined ? {} : { usage }),
            error: result.error,
        }
    } catch (error) {
        const event = reportDiagnostic(error, { operation: 'nai.anlas-balance', stage: 'invoke' })
        return { success: false, error: event.userSummary }
    }
}

export async function generateImage(
    token: string,
    params: GenerationParams,
    signal?: AbortSignal,
    faultInjector?: NaiProviderFaultInjector,
    hooks?: NaiGenerationExecutionHooks,
): Promise<GenerateImageResult> {
    if (!token) return { success: false, error: 'API 토큰이 필요합니다' }

    const operation = naiOperationMonitor.start({ operation: 'nai.generate', stage: 'prepare', prompt: params.prompt })
    try {
        operation.stageStart('payload')
        const adapted = await adaptGenerationParams(token, params)
        const payload = buildGenerateImagePayload(adapted.request, adapted.buildOptions)
        const sentPayload = JSON.stringify(payload)
        const response = await getRuntimeNaiTransport().request({
            endpoint: 'standard',
            token,
            payload: sentPayload,
            signal,
            timeoutMs: NAI_STANDARD_TIMEOUT_MS,
            onStage: observeTransportStage(operation),
            faultInjector,
            observer: hooks?.observer,
        })

        if (!response.ok) {
            const errorText = await response.text()
            throw new NovelAIHttpError(response.status, errorText, response.headers.get('Retry-After'))
        }

        const sentPayloadSummary = makeSentPayloadSummary(sentPayload)
        const responseBody = await response.arrayBuffer()
        operation.stageStart('decode')
        const imageData = await firstZipEntryBase64(responseBody, 'ZIP 파일이 비어있습니다.')
        return {
            success: true,
            imageData: taggedImage(imageData, { ...params, sentPayloadSummary }),
            encodedVibes: adapted.encodedVibes,
            sentPayloadSummary,
        }
    } catch (error) {
        if (error instanceof NovelAIHttpError) throw error
        const event = reportDiagnostic(error, {
            operation: 'nai.generate',
            stage: isAbortError(error) ? 'cancelled' : isTimeoutError(error) ? 'timeout' : 'request',
            prompt: params.prompt,
            cancelled: isAbortError(error),
            timeout: isTimeoutError(error),
        })
        if (hooks?.errorMode === 'throw') throw error
        return {
            success: false,
            error: error instanceof NovelAiModelCapabilityError ? error.message : event.userSummary,
            ...(isAbortError(error) ? { termination: 'cancelled' as const } : {}),
            ...(isTimeoutError(error) ? { termination: 'timeout' as const } : {}),
        }
    } finally {
        operation.finish()
    }
}

export async function generateImageStream(
    token: string,
    params: GenerationParams,
    onProgress?: (progress: number, partialImage?: string) => void,
    signal?: AbortSignal,
    faultInjector?: NaiProviderFaultInjector,
    hooks?: NaiGenerationExecutionHooks,
): Promise<GenerateImageResult> {
    if (!token) return { success: false, error: 'API 토큰이 필요합니다' }

    const operation = naiOperationMonitor.start({ operation: 'nai.generate-stream', stage: 'prepare', prompt: params.prompt })
    try {
        operation.stageStart('payload')
        const adapted = await adaptGenerationParams(token, params, 'msgpack')
        const payload = buildGenerateImagePayload(adapted.request, adapted.buildOptions)
        const sentPayload = JSON.stringify(payload)
        const response = await getRuntimeNaiTransport().request({
            endpoint: 'stream',
            token,
            payload: sentPayload,
            signal,
            timeoutMs: NAI_STREAM_TIMEOUT_MS,
            onStage: observeTransportStage(operation),
            faultInjector,
            observer: hooks?.observer,
        })

        if (!response.ok) {
            const errorText = await response.text()
            throw new NovelAIHttpError(response.status, errorText, response.headers.get('Retry-After'))
        }
        if (!response.body) return { success: false, error: '스트리밍 응답 없음' }

        let lastStepShown = -1
        const totalSteps = params.steps || 28
        const sentPayloadSummary = makeSentPayloadSummary(sentPayload)
        let decodeStarted = false
        const imageData = await readNaiImageStream(response.body, {
            onEvent: event => {
                if (!decodeStarted) {
                    decodeStarted = true
                    operation.stageStart('decode')
                }
                operation.heartbeat('streaming-progress')
                if (typeof event.stepIx === 'number') {
                    const progress = Math.round((event.stepIx / totalSteps) * 100)
                    if (event.eventType === 'intermediate' && event.imageBase64 && event.stepIx > lastStepShown + 1) {
                        lastStepShown = event.stepIx
                        onProgress?.(progress, event.imageBase64)
                    } else if (event.eventType === 'intermediate') {
                        onProgress?.(progress)
                    }
                }
                if (event.eventType === 'final') onProgress?.(100, event.imageBase64)
            },
        }, signal)

        return {
            success: true,
            imageData: taggedImage(imageData, { ...params, sentPayloadSummary }),
            encodedVibes: adapted.encodedVibes,
            sentPayloadSummary,
        }
    } catch (error) {
        if (error instanceof NovelAIHttpError) throw error
        const event = reportDiagnostic(error, {
            operation: 'nai.generate-stream',
            stage: isAbortError(error) ? 'cancelled' : isTimeoutError(error) ? 'timeout' : 'stream',
            prompt: params.prompt,
            cancelled: isAbortError(error),
            timeout: isTimeoutError(error),
        })
        if (hooks?.errorMode === 'throw') throw error
        return {
            success: false,
            error: error instanceof NovelAiModelCapabilityError ? error.message : event.userSummary,
            ...(isAbortError(error) ? { termination: 'cancelled' as const } : {}),
            ...(isTimeoutError(error) ? { termination: 'timeout' as const } : {}),
        }
    } finally {
        operation.finish()
    }
}

async function augmentViaFormData(
    token: string,
    imageBase64: string,
    width: number,
    height: number,
    reqType: string,
    defry?: number,
    prompt?: string,
): Promise<string> {
    const rawBase64 = stripBase64Header(imageBase64)
    const payload: Record<string, unknown> = {
        image: 'image',
        width,
        height,
        req_type: reqType,
    }
    if (reqType === 'colorize' || reqType === 'emotion') {
        payload.defry = defry ?? 0
        payload.prompt = prompt || ''
    }

    const imageBytes = Uint8Array.from(atob(rawBase64), char => char.charCodeAt(0))
    const formData = new FormData()
    formData.append('image', new Blob([imageBytes], { type: 'image/png' }), 'image.png')
    formData.append('request', new Blob([JSON.stringify(payload)], { type: 'application/json' }), 'blob')

    const response = await getNaiAuxiliaryFetch()(NAI_ENDPOINTS.augmentImage, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token.trim()}` },
        body: formData,
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new NovelAIHttpError(response.status, errorText)
    }
    return firstZipEntryBase64(await response.arrayBuffer(), 'ZIP 파일이 비어있습니다')
}

export async function augmentImage(
    token: string,
    imageBase64: string,
    width: number,
    height: number,
    reqType: string,
    defry?: number,
    prompt?: string,
): Promise<{ success: boolean; imageData?: string; error?: string }> {
    try {
        return {
            success: true,
            imageData: await augmentViaFormData(token, imageBase64, width, height, reqType, defry, prompt),
        }
    } catch (error) {
        const event = reportDiagnostic(error, { operation: 'nai.augment', stage: 'request', prompt })
        return { success: false, error: event.userSummary }
    }
}

export async function upscaleImage(
    token: string,
    imageBase64: string,
    width: number,
    height: number,
): Promise<{ success: boolean; imageData?: string; error?: string }> {
    try {
        if (width * height > 3_145_728) {
            return { success: false, error: '업스케일 입력 이미지는 3MP 이하만 지원합니다.' }
        }
        if (imageBase64.startsWith('data:') && !imageBase64.startsWith('data:image/png;base64,')) {
            return { success: false, error: '업스케일 입력은 PNG 이미지만 지원합니다.' }
        }

        const rawBase64 = stripBase64Header(imageBase64)
        const imageBytes = Uint8Array.from(atob(rawBase64), char => char.charCodeAt(0))
        const formData = new FormData()
        formData.append('image', new Blob([imageBytes], { type: 'image/png' }), 'image.png')
        formData.append('request', new Blob([JSON.stringify({
            image: 'image',
            model: 'nai-diffusion-5-curated',
            declared_blur_sigma: 0,
        })], { type: 'application/json' }), 'blob')

        const response = await getNaiAuxiliaryFetch()(NAI_ENDPOINTS.upscale, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token.trim()}` },
            body: formData,
        })

        if (!response.ok) {
            const errorText = await response.text()
            throw new NovelAIHttpError(response.status, errorText)
        }

        return {
            success: true,
            imageData: await firstZipEntryBase64(
                await response.arrayBuffer(),
                '업스케일 응답에 image*.png 파일이 없습니다.',
                true,
            ),
        }
    } catch (error) {
        if (error instanceof NovelAIHttpError) {
            const event = reportDiagnostic(error, {
                operation: 'nai.upscale',
                stage: 'request',
            })
            return { success: false, error: event.userSummary }
        }
        const event = reportDiagnostic(error, { operation: 'nai.upscale', stage: 'request' })
        return { success: false, error: event.userSummary }
    }
}
