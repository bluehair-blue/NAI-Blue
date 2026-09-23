import {
    DIAGNOSTIC_SCHEMA_VERSION,
    type DiagnosticBreadcrumb,
    type DiagnosticCategory,
    type DiagnosticContext,
    type DiagnosticEvent,
    type DiagnosticEventInput,
    type DiagnosticSeverity,
} from '@/domain/diagnostics/types'
import {
    PersistenceFault,
    type PersistenceCriticality,
} from '@/domain/persistence/fault'
import { useDiagnosticsStore } from '@/stores/diagnostics-store'
import {
    redactDiagnosticText,
    redactProviderResponseBody,
    redactedCauseChain,
    summarizePrompt,
} from './redactor'
import { persistDiagnosticEvent } from './exporter'

const BREADCRUMB_LIMIT = 20
const breadcrumbs: DiagnosticBreadcrumb[] = []

type ErrorShape = Error & {
    status?: unknown
    responseBody?: unknown
    phase?: unknown
    retryable?: unknown
}

function nowIso(): string {
    return new Date().toISOString()
}

function appVersion(): string {
    return import.meta.env.VITE_APP_VERSION ?? '2.9.1'
}

function runtimePlatform(): { platform: string, architecture: string } {
    const navigatorValue = globalThis.navigator
    return {
        platform: navigatorValue?.platform || 'unknown',
        architecture: navigatorValue?.userAgent || 'unknown',
    }
}

function eventId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `diagnostic-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function asIso(value: Date | string | undefined): string | undefined {
    if (value === undefined) return undefined
    const parsed = value instanceof Date ? value : new Date(value)
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

function httpStatus(error: unknown, context: DiagnosticContext): number | undefined {
    if (context.httpStatus !== undefined) return context.httpStatus
    const status = (error as ErrorShape | null)?.status
    return typeof status === 'number' && Number.isFinite(status) ? status : undefined
}

function errorName(error: unknown): string {
    return error instanceof Error ? error.name : ''
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function hasOperation(context: DiagnosticContext, value: string): boolean {
    return context.operation.toLowerCase().includes(value)
}

function classifyCategory(error: unknown, context: DiagnosticContext, status: number | undefined): DiagnosticCategory {
    if (context.category !== undefined) return context.category
    if (hasOperation(context, 'migration') || hasOperation(context, 'persistence') || /(?:indexeddb|localstorage|database)/i.test(errorMessage(error))) return 'persistence'
    if (context.cancelled || errorName(error) === 'AbortError' || /(?:request aborted|operation aborted|cancelled|취소)/i.test(errorMessage(error))) return 'cancelled'
    if (context.timeout || /(?:deadline exceeded|timed?\s*out)/i.test(errorMessage(error))) return 'timeout'
    if (context.stalled || /(?:stalled|no progress heartbeat)/i.test(errorMessage(error))) return 'stalled'

    if (hasOperation(context, 'r2')) {
        if (status === 401 || status === 403 || /(?:credential|auth|access denied|forbidden)/i.test(errorMessage(error))) return 'r2_auth'
        if (status === 409 || /(?:conflict|already exists)/i.test(errorMessage(error))) return 'r2_conflict'
        return 'r2_upload'
    }
    if (hasOperation(context, 'sync')) return 'sync'
    if (errorName(error) === 'OutputWriterError' || hasOperation(context, 'output') || /(?:enospc|disk full|eacces|permission denied|write failed)/i.test(errorMessage(error))) return 'local_io'
    if (/(?:invalid zip|zip file|archive|decode response|msgpack)/i.test(errorMessage(error))) return 'response_decode'
    if (/(?:canvas|thumbnail|image decode|image processing)/i.test(errorMessage(error))) return 'image_processing'
    if (status === 401 || status === 403) return 'auth'
    if (status === 429) return 'rate_limit'
    if (status !== undefined && status >= 500) return 'novelai_api'
    if (/(?:enotfound|eai_again|dns|network|fetch failed|connection reset|socket)/i.test(errorMessage(error))) return 'network'
    return 'unknown'
}

const categoryMetadata: Record<DiagnosticCategory, { code: string, severity: DiagnosticSeverity, summary: string, action: string, recoverable: boolean }> = {
    auth: { code: 'AUTH_UNAUTHORIZED', severity: 'error', summary: '인증 정보를 확인한 뒤 다시 시도하세요.', action: 'API 토큰을 다시 확인하세요.', recoverable: true },
    network: { code: 'NETWORK_UNAVAILABLE', severity: 'warning', summary: '네트워크 연결을 확인한 뒤 다시 시도하세요.', action: '연결과 DNS 상태를 확인하세요.', recoverable: true },
    rate_limit: { code: 'RATE_LIMITED', severity: 'warning', summary: '요청 한도에 도달했습니다.', action: '잠시 기다린 뒤 다시 시도하세요.', recoverable: true },
    novelai_api: { code: 'NOVELAI_API_FAILURE', severity: 'error', summary: '이미지 생성 서비스가 요청을 완료하지 못했습니다.', action: '잠시 후 다시 시도하세요.', recoverable: true },
    response_decode: { code: 'RESPONSE_DECODE_FAILED', severity: 'error', summary: '생성 응답을 해석하지 못했습니다.', action: '같은 요청을 다시 시도하세요.', recoverable: true },
    image_processing: { code: 'IMAGE_PROCESSING_FAILED', severity: 'error', summary: '이미지 처리 작업을 완료하지 못했습니다.', action: '입력 이미지를 확인한 뒤 다시 시도하세요.', recoverable: true },
    local_io: { code: 'LOCAL_IO_FAILED', severity: 'error', summary: '로컬 파일 작업을 완료하지 못했습니다.', action: '저장 공간과 권한을 확인하세요.', recoverable: true },
    persistence: { code: 'PERSISTENCE_FAILED', severity: 'fatal', summary: '앱 데이터를 안전하게 확인하지 못했습니다.', action: '복구 화면의 안내에 따라 백업을 확인하세요.', recoverable: false },
    r2_auth: { code: 'R2_AUTH_FAILED', severity: 'error', summary: 'R2 인증을 확인하지 못했습니다.', action: 'Wrangler 로그인 또는 보안 설정을 확인하세요.', recoverable: true },
    r2_upload: { code: 'R2_UPLOAD_FAILED', severity: 'error', summary: 'R2 작업을 완료하지 못했습니다.', action: '연결과 배포 설정을 확인하세요.', recoverable: true },
    r2_conflict: { code: 'R2_CONFLICT', severity: 'warning', summary: 'R2 원격 객체 충돌이 발생했습니다.', action: '범위를 다시 확인한 뒤 재시도하세요.', recoverable: true },
    sync: { code: 'SYNC_FAILED', severity: 'warning', summary: '동기화 작업을 완료하지 못했습니다.', action: '파일 상태를 확인한 뒤 다시 시도하세요.', recoverable: true },
    cancelled: { code: 'OPERATION_CANCELLED', severity: 'info', summary: '작업이 취소되었습니다.', action: '필요하면 새 작업을 시작하세요.', recoverable: true },
    timeout: { code: 'OPERATION_TIMEOUT', severity: 'error', summary: '작업 시간이 제한을 초과했습니다.', action: '연결을 확인한 뒤 다시 시도하세요.', recoverable: true },
    stalled: { code: 'OPERATION_STALLED', severity: 'warning', summary: '작업 진행 상황이 멈춘 것으로 보입니다.', action: '잠시 기다리거나 다시 시도하세요.', recoverable: true },
    unknown: { code: 'UNKNOWN_FAILURE', severity: 'error', summary: '작업을 완료하지 못했습니다.', action: '다시 시도하고 계속되면 진단 로그를 확인하세요.', recoverable: true },
}

export function addDiagnosticBreadcrumb(
    operation: string,
    stage: string,
    message?: string,
): void {
    breadcrumbs.push({
        occurredAt: nowIso(),
        operation: redactDiagnosticText(operation),
        stage: redactDiagnosticText(stage),
        ...(message === undefined ? {} : { message: redactDiagnosticText(message) }),
    })
    if (breadcrumbs.length > BREADCRUMB_LIMIT) breadcrumbs.splice(0, breadcrumbs.length - BREADCRUMB_LIMIT)
}

export function recentDiagnosticBreadcrumbs(): DiagnosticBreadcrumb[] {
    return breadcrumbs.map(item => ({ ...item }))
}

export function createDiagnosticEvent(input: DiagnosticEventInput): DiagnosticEvent {
    const occurredAt = nowIso()
    const startedAt = asIso(input.startedAt)
    const startedMs = startedAt === undefined ? undefined : new Date(startedAt).getTime()
    const derivedElapsed = startedMs === undefined ? undefined : Math.max(0, new Date(occurredAt).getTime() - startedMs)
    const runtime = runtimePlatform()
    const cause = redactedCauseChain(input.cause)

    return {
        schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
        eventId: eventId(),
        occurredAt,
        appVersion: appVersion(),
        platform: runtime.platform,
        architecture: runtime.architecture,
        severity: input.severity,
        code: input.code,
        category: input.category,
        operation: redactDiagnosticText(input.operation),
        stage: redactDiagnosticText(input.stage ?? 'unknown'),
        ...(input.correlationId === undefined ? {} : { correlationId: redactDiagnosticText(input.correlationId) }),
        ...(input.userActionId === undefined ? {} : { userActionId: redactDiagnosticText(input.userActionId) }),
        ...(input.jobId === undefined ? {} : { jobId: redactDiagnosticText(input.jobId) }),
        ...(input.sceneId === undefined ? {} : { sceneId: redactDiagnosticText(input.sceneId) }),
        ...(input.attemptId === undefined ? {} : { attemptId: redactDiagnosticText(input.attemptId) }),
        ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
        ...(input.providerRequestId === undefined ? {} : { providerRequestId: redactDiagnosticText(input.providerRequestId) }),
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(input.elapsedMs ?? derivedElapsed) === undefined ? {} : { elapsedMs: input.elapsedMs ?? derivedElapsed },
        ...(asIso(input.lastProgressAt) === undefined ? {} : { lastProgressAt: asIso(input.lastProgressAt) }),
        ...(input.retryAttempt === undefined ? {} : { retryAttempt: input.retryAttempt }),
        ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
        cancelled: input.cancelled ?? false,
        timeout: input.timeout ?? false,
        stalled: input.stalled ?? false,
        recoverable: input.recoverable ?? true,
        userSummary: redactDiagnosticText(input.userSummary),
        recommendedAction: redactDiagnosticText(input.recommendedAction ?? '다시 시도하세요.'),
        ...(input.prompt === undefined ? {} : { prompt: summarizePrompt(input.prompt) }),
        redactedDeveloperMessage: redactDiagnosticText(input.developerMessage ?? 'No developer message provided.'),
        redactedCauseChain: cause,
        recentBreadcrumbs: recentDiagnosticBreadcrumbs(),
    }
}

export function diagnoseError(error: unknown, context: DiagnosticContext): DiagnosticEvent {
    const status = httpStatus(error, context)
    const category = classifyCategory(error, context, status)
    const metadata = categoryMetadata[category]
    const shape = error as ErrorShape
    const providerBody = typeof shape?.responseBody === 'string'
        ? redactProviderResponseBody(shape.responseBody)
        : undefined
    const phase = typeof shape?.phase === 'string' ? shape.phase : context.stage
    const developerMessage = providerBody === undefined
        ? errorMessage(error)
        : `${errorName(error) || 'ProviderError'} (${status ?? 'unknown'}): ${providerBody}`

    return createDiagnosticEvent({
        ...context,
        category,
        code: context.code ?? metadata.code,
        severity: context.severity ?? (context.fatal ? 'fatal' : metadata.severity),
        userSummary: metadata.summary,
        recommendedAction: metadata.action,
        developerMessage,
        cause: error,
        ...(status === undefined ? {} : { httpStatus: status }),
        ...(phase === undefined ? {} : { stage: phase }),
        cancelled: context.cancelled ?? category === 'cancelled',
        timeout: context.timeout ?? category === 'timeout',
        stalled: context.stalled ?? category === 'stalled',
        recoverable: context.recoverable ?? metadata.recoverable,
    })
}

/** Records only the already-redacted event in memory and production diagnostics logging. */
export function reportDiagnostic(error: unknown, context: DiagnosticContext): DiagnosticEvent {
    // Preserve the typed persistence code when a startup/background boundary
    // catches and re-reports a DB fault. Generic PERSISTENCE_FAILED hides the
    // affected operation/key and makes one timeout look like a new failure.
    if (error instanceof PersistenceFault && (context.category === undefined || context.category === 'persistence')) {
        return reportPersistenceFault(error, {
            operation: context.operation,
            stage: context.stage,
            criticality: error.criticality,
            fatal: context.fatal,
        })
    }
    const event = diagnoseError(error, context)
    return recordDiagnosticEvent(event)
}

export interface PersistenceDiagnosticContext {
    operation?: string
    stage?: string
    criticality?: PersistenceCriticality
    fatal?: boolean
}

/** Converts a typed persistence failure into the one redacted DiagnosticEvent projection. */
export function diagnosePersistenceFault(
    fault: PersistenceFault,
    context: PersistenceDiagnosticContext = {},
): DiagnosticEvent {
    const criticality = context.criticality ?? fault.criticality
    return diagnoseError(fault, {
        operation: context.operation ?? fault.operation,
        stage: context.stage ?? fault.kind,
        category: 'persistence',
        code: fault.code,
        severity: context.fatal === false || criticality === 'best-effort' ? 'warning' : 'fatal',
        recoverable: true,
        fatal: context.fatal ?? criticality === 'critical',
    })
}

export function reportPersistenceFault(
    fault: PersistenceFault,
    context: PersistenceDiagnosticContext = {},
): DiagnosticEvent {
    return recordDiagnosticEvent(diagnosePersistenceFault(fault, context))
}

/** Stores and writes a pre-built event after the same redaction boundary. */
export function recordDiagnosticEvent(event: DiagnosticEvent): DiagnosticEvent {
    useDiagnosticsStore.getState().record(event)
    persistDiagnosticEvent(event)
    return event
}

export function diagnosticPromptSummary(prompt: string | undefined) {
    return prompt === undefined ? undefined : summarizePrompt(prompt)
}
