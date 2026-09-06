import { useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { runtimeAgentCommands } from '@/composition-root/runtime-agent-commands'
import type { ForegroundAgentCommandRuntime } from '@/composition-root/foreground-agent-command-runtime'
import type { AgentExecutionReview } from '@/application/agent/agent-execution-coordinator'
import { useQueueStore } from '@/stores/queue-store'
import { AgentPolicyForm } from './AgentPolicyForm'

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
        <CardContent className="space-y-5">
            {state.workspaceId && <div className="flex flex-wrap items-center gap-3">
                <span className="break-all text-xs text-muted-foreground">{t('agentInbox.workspace', '작업공간 ID')}: {state.workspaceId}</span>
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
            <p className="text-xs leading-5 text-muted-foreground">{t('agentInbox.keyStorage', '비밀키는 Windows 자격 증명 저장소에 보관됩니다. 접속 정보를 복사해 외부 제출 도구에 전달할 수 있으며, 키 교체 후에는 새 접속 정보를 사용해야 합니다.')}</p>
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
                    </> : <>
                        <p className="break-all">{t('agentInbox.reviewedSource')}: {item.sourceIds.join(', ')}</p>
                        <p>{t('agentInbox.reviewCost', { count: item.imageCount, anlas: item.estimatedAnlas })}</p>
                        <p>{t('agentInbox.outputEffect')}: {t(item.outputEffect === 'local-output-and-r2' ? 'agentInbox.outputLocalR2' : 'agentInbox.outputLocal')}</p>
                        <p>{t('agentInbox.allowedCompatibility')}: {item.compatibilityStatuses.join(', ')}</p>
                    </>}
                    <p>{t('agentInbox.approvalExpiry')}: <time dateTime={item.expiresAt}>{new Date(item.expiresAt).toLocaleString()}</time></p>
                    <p>{t('agentInbox.approvalReasons')}: {item.reasons.map(reason => t(`agentInbox.reason_${reason}`, { defaultValue: reason })).join(', ')}</p>
                    <div className="flex flex-wrap gap-2">
                        <Button size="sm" disabled={!ready || ((item.command ?? 'generation.enqueue') === 'generation.enqueue' && state.policy.globalPause) || state.policy.mode === 'observe' || Date.parse(item.expiresAt) <= Date.now()}
                            onClick={() => void decide(item, 'approve')}>{t('agentInbox.approveOnce')}</Button>
                        <Button size="sm" variant="outline" disabled={!ready} onClick={() => void decide(item, 'reject')}>{t('agentInbox.rejectApproval')}</Button>
                    </div>
                </li>)}</ul>
            </div>
            <details><summary className="cursor-pointer text-sm font-medium">{t('agentInbox.capabilities', '요청별 지원 상태')}</summary>
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
