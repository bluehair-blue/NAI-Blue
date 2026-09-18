import { useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { runtimeAgentCommands } from '@/composition-root/runtime-agent-commands'
import type { ForegroundAgentCommandRuntime } from '@/composition-root/foreground-agent-command-runtime'
import type { AgentExecutionReview, AgentGenerationExecutionReview } from '@/application/agent/agent-execution-coordinator'
import { useQueueStore } from '@/stores/queue-store'
import type { JsonObject, JsonValue } from '@/domain/composition/types'
import { AgentPolicyForm } from './AgentPolicyForm'

/** Show every signed input field for review; display labels never alter the consent binding. */
function authoringRows(value: JsonValue, prefix = ''): { label: string; value: string }[] {
    const labels: Record<string, string> = { presetId: '프리셋 ID', presetName: '프리셋 이름', expectedRevision: '기준 버전',
        expectedPlanHash: '검토 계획 확인값', changes: '변경 항목', sceneId: '에셋 ID', name: '에셋 이름', prompts: '프롬프트',
        base: '기본', additional: '추가', character: '캐릭터', negative: '제외', characterNegative: '캐릭터 제외',
        generation: '생성 설정', model: '모델', steps: '단계', cfgScale: '프롬프트 강도', cfgRescale: '강도 보정', sampler: '샘플러',
        scheduler: '노이즈 일정', smea: 'SMEA', smeaDyn: '동적 SMEA', variety: '다양성', qualityToggle: '품질 태그',
        strength: '강도', noise: '노이즈', characterStrength: '캐릭터 강도', characterFidelity: '캐릭터 충실도',
        characterReferenceType: '캐릭터 참조 방식', characterPositionEnabled: '캐릭터 위치 사용', imageFormat: '이미지 형식',
        upscaledEnhance: '업스케일 보정', transparentBackground: '투명 배경',
        ucPreset: '제외 프리셋', seed: '시드', seedLocked: '시드 고정', width: '너비', height: '높이', generationFolderId: '저장 폴더 ID',
        productionCount: '생성 수량', filenameTemplate: '파일 이름 규칙', op: '작업', folderId: '폴더 ID', parentId: '상위 폴더 ID',
        displayName: '폴더 이름', pathSegment: '저장 폴더 이름', commonPrompt: '공통 프롬프트', autoUpload: 'R2 자동 업로드 설정',
        prompt: '프롬프트', position: '위치', x: '가로', y: '세로', enabled: '활성화',
        r2ProfilePolicy: 'R2 프로필', r2BucketPolicy: 'R2 버킷', r2PrefixPolicy: 'R2 저장 위치', mode: '적용 방식', value: '설정값' }
    if (Array.isArray(value)) return value.flatMap((item, index) => authoringRows(item, `${prefix} ${index + 1}`))
    if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) =>
        authoringRows(item, [prefix, labels[key] ?? key].filter(Boolean).join(' · ')))
    return [{ label: prefix, value: value === null ? '없음' : typeof value === 'boolean' ? value ? '켜짐' : '꺼짐' : String(value) }]
}

const visibleGenerationSettings = new Set([
    'cfgScale', 'cfgRescale', 'sampler', 'scheduler', 'smea', 'smeaDyn', 'variety', 'strength', 'noise',
    'characterStrength', 'characterFidelity', 'characterReferenceType', 'characterPositionEnabled',
    'imageFormat', 'upscaledEnhance', 'qualityToggle', 'ucPreset', 'transparentBackground',
])

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
    return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
}

function generationSettingsRows(value: JsonValue): { label: string; value: string }[] {
    if (!isJsonObject(value)) return []
    const settings = Object.fromEntries(Object.entries(value).filter(([key]) => visibleGenerationSettings.has(key))) as JsonObject
    return authoringRows(settings)
}

function renderGenerationPreview(item: AgentGenerationExecutionReview) {
    return <details className="rounded-control border px-3 py-2">
        <summary className="cursor-pointer font-medium">프롬프트와 생성 설정 확인 · {item.previewJobs.length}장</summary>
        <div className="mt-3 max-h-[32rem] space-y-3 overflow-y-auto pr-1">
            {item.previewJobs.map(job => {
                const parameters = isJsonObject(job.generationParameters) ? job.generationParameters : {}
                const characters = Array.isArray(parameters.characterPrompts)
                    ? parameters.characterPrompts.filter(isJsonObject)
                    : []
                return <article key={job.ordinal} className="space-y-3 rounded-control border bg-muted/20 p-3">
                    <div>
                        <p className="font-medium">이미지 {job.ordinal + 1} · {job.model}</p>
                        <p className="mt-1 text-muted-foreground">{job.width} × {job.height} · Steps {job.steps} · Seed {job.seed}</p>
                    </div>
                    <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
                        {generationSettingsRows(job.generationParameters).map((row, index) => <div key={`${row.label}-${index}`} className="min-w-0">
                            <dt className="text-muted-foreground">{row.label}</dt><dd className="break-words">{row.value}</dd>
                        </div>)}
                    </dl>
                    <section><h4 className="font-medium">전체 프롬프트</h4><p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{job.prompt || '없음'}</p></section>
                    <section><h4 className="font-medium">제외 프롬프트</h4><p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{job.negativePrompt || '없음'}</p></section>
                    {characters.map((character, index) => {
                        const position = isJsonObject(character.position) ? character.position : {}
                        return <section key={index} className="border-t pt-2">
                            <h4 className="font-medium">캐릭터 프롬프트 {index + 1}{character.enabled === false ? ' · 꺼짐' : ''}</h4>
                            <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{typeof character.prompt === 'string' ? character.prompt : '없음'}</p>
                            <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">제외 요소: {typeof character.negative === 'string' && character.negative ? character.negative : '없음'}</p>
                            <p className="mt-1 text-muted-foreground">위치: {typeof position.x === 'number' ? position.x.toFixed(2) : '—'}, {typeof position.y === 'number' ? position.y.toFixed(2) : '—'}</p>
                        </section>
                    })}
                </article>
            })}
        </div>
    </details>
}

/** Human registration controls share the live dispatcher's capabilities, never its secret keys. */
export function AgentCommandPanel({ runtime = runtimeAgentCommands }: { runtime?: ForegroundAgentCommandRuntime }) {
    const { t } = useTranslation()
    const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot)
    const [label, setLabel] = useState('')
    const [message, setMessage] = useState<string | null>(null)
    const ready = state.status === 'ready' && !state.changingClient && !state.changingExecution
    const decide = async (item: AgentExecutionReview, decision: 'approve' | 'reject') => {
        setMessage(null)
        try {
            // Each human decision binds the reviewed plan or exact existing Queue result.
            const expected = item.command === 'generation.retry_storage'
                ? { requestHash: item.requestHash, runId: item.runId, jobId: item.jobId, targetHash: item.targetHash, policyRevision: item.policyRevision }
                : item.command === 'generation.cancel'
                ? { requestHash: item.requestHash, runId: item.runId, targetHash: item.targetHash, policyRevision: item.policyRevision }
                : 'input' in item
                ? { requestHash: item.requestHash, resourceId: item.resourceId, targetHash: item.targetHash, policyRevision: item.policyRevision }
                : { requestHash: item.requestHash, planHash: item.planHash, policyRevision: item.policyRevision }
            await runtime.decideApproval(item.requestId, decision, expected)
            setMessage(t('agentInbox.approvalChanged'))
        } catch { setMessage(t('agentInbox.approvalFailed')) }
    }
    const change = async (action: 'register' | 'rotate' | 'revoke', value: string) => {
        setMessage(null)
        try {
            await runtime.changeClient(action, value)
            if (action === 'register') setLabel('')
            setMessage(t('agentInbox.clientChanged', '접속 권한을 갱신했습니다.'))
        } catch { setMessage(t('agentInbox.changeFailed', '접속 권한을 갱신하지 못했습니다. 앱의 복구 상태를 확인해 주세요.')) }
    }
    const toggle = async () => {
        setMessage(null)
        try { if (state.status === 'ready') await runtime.stop(); else await runtime.start() }
        catch { setMessage(t('agentInbox.toggleFailed', '수신 상태를 변경하지 못했습니다. 앱을 다시 시작해 주세요.')) }
    }
    const statusLabels = {
        unsupported: t('agentInbox.windowsOnly', 'Windows 앱에서 사용 가능'),
        starting: t('agentInbox.starting', '저장 데이터와 복구 상태 확인 중'),
        ready: t('agentInbox.ready', '인증된 요청 수신 중'),
        busy: t('agentInbox.busy', '다른 앱 프로세스가 처리 중'),
        'app-unavailable': t('agentInbox.unavailable', '수신을 준비하지 못했습니다. 복구 상태 확인 후 앱을 다시 시작해 주세요.'),
        stopped: t('agentInbox.stopped', '요청 수신 중지됨'),
        stopping: t('agentInbox.stopping', '진행 중인 요청을 정리하는 중'),
    }
    return <Card data-testid="agent-command-panel" className="mb-6 border-0 shadow-none">
        <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle>{t('agentInbox.title', '인증된 AI 요청')}</CardTitle>
                <Badge variant={state.status === 'app-unavailable' ? 'destructive' : 'secondary'}>{statusLabels[state.status]}</Badge>
            </div>
            <CardDescription>{t('agentInbox.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
            {state.workspaceId && <div className="flex flex-wrap items-center gap-3">
                <Button variant="outline" size="sm" disabled={state.changingClient || state.changingExecution || !['ready', 'stopped'].includes(state.status)} onClick={() => void toggle()}>
                    {state.status === 'stopped' ? t('agentInbox.resume', '수신 재개') : t('agentInbox.pause', '수신 중지')}
                </Button>
            </div>}
            <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); if (ready && label.trim()) void change('register', label.trim()) }}>
                <Input aria-label={t('agentInbox.clientLabel', 'AI 접속 이름')} placeholder={t('agentInbox.clientPlaceholder', '예: 로컬 작업 도우미')}
                    className="min-w-0 flex-1" value={label} maxLength={100} disabled={!ready} onChange={event => setLabel(event.target.value)} />
                <Button disabled={!ready || !label.trim()} type="submit">{t('agentInbox.register', 'AI 접속 등록')}</Button>
            </form>
            <p className="text-xs leading-5 text-muted-foreground">{t('agentInbox.registrationScope')}</p>
            <details className="choice-details">
                <summary>{t('readableChoices.connectionDetails')}</summary>
                {state.workspaceId && <p className="mb-3 break-all text-sm text-muted-foreground">{t('agentInbox.workspace', '작업공간 ID')}: {state.workspaceId}</p>}
                <p className="choice-help">{t('agentInbox.keyStorage', '비밀키는 Windows 자격 증명 저장소에 보관됩니다. 접속 정보를 복사해 외부 제출 도구에 전달할 수 있으며, 키 교체 후에는 새 접속 정보를 사용해야 합니다.')}</p>
            </details>
            {message && <p role="status" className="text-sm">{message}</p>}
            <ul className="space-y-3" aria-label={t('agentInbox.clients', '등록된 AI 접속')}>
                {state.clients.map(client => <li key={client.clientId} className="flex flex-wrap items-center justify-between gap-3 rounded-panel border p-3">
                    <div className="min-w-0"><p className="break-words text-sm font-medium">{client.label}</p>
                        <p className="break-all text-xs text-muted-foreground">{client.clientId}</p>
                        {client.revokedAt && <p className="text-xs text-muted-foreground">{t('agentInbox.revoked', '권한 폐기됨')}</p>}
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button variant="outline" size="sm" disabled={!ready || client.revokedAt !== null} onClick={() => {
                            void navigator.clipboard.writeText(JSON.stringify({ workspaceId: state.workspaceId, clientId: client.clientId, keyId: client.keyId, actorKind: client.actorKind }, null, 2))
                                .then(() => setMessage(t('agentInbox.copied', '비밀키가 없는 접속 정보를 복사했습니다.')))
                                .catch(() => setMessage(t('agentInbox.copyFailed', '접속 정보를 복사하지 못했습니다.')))
                        }}>{t('agentInbox.copyConnection', '접속 정보 복사')}</Button>
                        <Button variant="outline" size="sm" disabled={!ready || client.revokedAt !== null} onClick={() => void change('rotate', client.clientId)}>{t('agentInbox.rotate', '키 교체')}</Button>
                        <Button variant="outline" size="sm" disabled={!ready || client.revokedAt !== null} onClick={() => void change('revoke', client.clientId)}>{t('agentInbox.revoke', '권한 폐기')}</Button>
                    </div>
                </li>)}
            </ul>
            <AgentPolicyForm key={`${state.policy.revision}:${state.policy.mode}:${state.policy.globalPause}`} policy={state.policy}
                disabled={!ready}
                onSave={async (revision, next) => {
                    setMessage(null)
                    try { await runtime.changePolicy(revision, next); setMessage(t('agentInbox.policySaved')) }
                    catch (error) { setMessage(t('agentInbox.policySaveFailed')); throw error }
                }} />
            <div className="space-y-2"><p className="text-sm font-medium">{t('agentInbox.pendingApprovals')}</p>
                {state.pendingApprovals.length === 0 && <p className="text-xs text-muted-foreground">{t('agentInbox.noPendingApprovals')}</p>}
                <ul className="space-y-3">{state.pendingApprovals.map(item => <li key={item.requestId} className="space-y-2 rounded-panel border p-3 text-xs">
                    <p className="break-all font-medium">{state.clients.find(client => client.clientId === item.clientId)?.label ?? item.clientId} · {item.clientId}</p>
                    <p className="break-all">{t('agentInbox.request')}: {item.requestId}</p>
                    {item.command === 'generation.cancel' ? <>
                        <p className="font-medium">{t('agentInbox.cancelAction')}</p>
                        <p className="break-all">{t('agentInbox.cancelRun')}: {item.runId}</p>
                        <p>{t('agentInbox.cancelJobCount', { count: item.jobCount })}</p>
                        <p className="break-all">{item.jobIds.join(', ')}</p>
                        <p>{t('agentInbox.cancelEffect')}</p>
                    </> : item.command === 'generation.retry_storage' ? <>
                        <p className="font-medium">{t('agentInbox.storageAction')}</p>
                        <p className="break-all">{t('agentInbox.storageRun')}: {item.runId}</p>
                        <p className="break-all">{t('agentInbox.storageJob')}: {item.jobId}</p>
                        <p className="break-all">{t('agentInbox.storageArtifact')}: {item.artifactId}</p>
                        <p>{t('agentInbox.storageEffect')}</p>
                    </> : 'input' in item ? <>
                        <p className="font-medium">{item.command === 'scene.patch_many' ? t('agentInbox.sceneAuthoringAction', '에셋 설정 편집') : t('agentInbox.folderAuthoringAction', '생성 폴더 설정 편집')}</p>
                        <p className="break-all">{item.resourceId} · {t('agentInbox.authoringChangeCount', '{{count}}개 항목', { count: item.changeCount })}</p>
                        <details><summary className="cursor-pointer font-medium">{t('agentInbox.authoringChanges', '바뀌는 내용')}</summary>
                            <div className="mt-2 max-h-96 space-y-2 overflow-y-auto">{authoringRows(item.input).map((row, index) => <label key={index} className="block space-y-1">
                                <span>{row.label}</span><textarea readOnly className="w-full resize-y rounded border bg-background p-2" value={row.value} rows={Math.min(6, Math.max(1, row.value.split('\n').length))} />
                            </label>)}</div>
                        </details>
                        {item.createsFolders && <p>{t('agentInbox.authoringCreatesFolders', '설정된 저장 위치 아래에 폴더를 만듭니다.')}</p>}
                        {item.renamesPathSegments && <p>{t('agentInbox.authoringRenamesFolders', '비어 있는 폴더의 저장 경로를 변경합니다.')}</p>}
                    </> : <>
                        <p className="break-all">{t('agentInbox.reviewedSource')}: {item.sourceIds.join(', ')}</p>
                        <p>{t('agentInbox.reviewCost', { count: item.imageCount, anlas: item.estimatedAnlas })}</p>
                        <p>{t('agentInbox.outputEffect')}: {t(item.outputEffect === 'local-output-and-r2' ? 'agentInbox.outputLocalR2' : 'agentInbox.outputLocal')}</p>
                        <p>{t('agentInbox.allowedCompatibility')}: {item.compatibilityStatuses.join(', ')}</p>
                        {renderGenerationPreview(item)}
                    </>}
                    <p>{t('agentInbox.approvalExpiry')}: <time dateTime={item.expiresAt}>{new Date(item.expiresAt).toLocaleString()}</time></p>
                    <p>{t('agentInbox.approvalReasons')}: {item.reasons.map(reason => t(`agentInbox.reason_${reason}`, { defaultValue: reason })).join(', ')}</p>
                    <div className="flex flex-wrap gap-2">
                        <Button size="sm" disabled={!ready || (!['generation.cancel', 'generation.retry_storage'].includes(item.command ?? 'generation.enqueue') && state.policy.globalPause) || state.policy.mode === 'observe' || Date.parse(item.expiresAt) <= Date.now()}
                            onClick={() => void decide(item, 'approve')}>{t('agentInbox.approveOnce')}</Button>
                        <Button size="sm" variant="outline" disabled={!ready} onClick={() => void decide(item, 'reject')}>{t('agentInbox.rejectApproval')}</Button>
                    </div>
                </li>)}</ul>
            </div>
            <details className="choice-details"><summary>{t('agentInbox.capabilities', '요청별 지원 상태')}</summary>
                <ul className="mt-3 space-y-2">{state.capabilities.map(capability => <li key={capability.command} className="flex flex-wrap justify-between gap-2 text-xs">
                    <code>{capability.command}</code><span>{capability.available ? t('agentInbox.available', '사용 가능') : t('agentInbox.notAvailable', '현재 사용 불가')}</span>
                </li>)}</ul>
            </details>
            {state.recent.length > 0 && <div><p className="mb-2 text-sm font-medium">{t('agentInbox.recent', '이번 실행의 최근 요청')}</p>
                <ul className="space-y-1">{state.recent.map(item => <li key={item.requestId} className="flex flex-wrap justify-between gap-2 text-xs"><span className="break-all">{item.requestId}</span><span>{item.cancelRequested ? t('agentInbox.cancelRequested') : item.storageRegistered ? t('agentInbox.storageRegistered') : item.state}</span>
                    {item.batchId && <Link className="break-all underline" to="/queue" onClick={() => useQueueStore.getState().setSelectedBatchId(item.batchId!)}>{t(item.cancelRequested || item.storageRegistered ? 'agentInbox.openTargetBatch' : 'agentInbox.openBatch')}: {item.batchId}</Link>}
                </li>)}</ul>
            </div>}
        </CardContent>
    </Card>
}
