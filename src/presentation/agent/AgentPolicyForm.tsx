import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { type AgentExecutionPolicy, updateAgentExecutionPolicy } from '@/application/agent/agent-execution-policy'
import { getRuntimeR2UploadRepository } from '@/services/r2/runtime'

/** Mounted by policy revision so a newly committed policy replaces any stale human draft. */
export function AgentPolicyForm({ policy, disabled, onSave }: {
    policy: AgentExecutionPolicy
    disabled: boolean
    onSave: (expectedRevision: number, next: AgentExecutionPolicy) => Promise<unknown>
}) {
    const { t } = useTranslation()
    const [draft, setDraft] = useState(policy)
    const [error, setError] = useState(false)
    const [profiles, setProfiles] = useState<{ status: 'loading' | 'ready' | 'error'; items: { id: string; name: string }[] }>({ status: 'loading', items: [] })
    const [profileReload, setProfileReload] = useState(0)
    useEffect(() => {
        let active = true
        // Only names/IDs enter this form; listing never reads credentials or changes consent.
        void getRuntimeR2UploadRepository().listProfiles().then(items => {
            if (active) setProfiles({ status: 'ready', items: items.map(({ id, name }) => ({ id, name })) })
        }).catch(() => { if (active) setProfiles({ status: 'error', items: [] }) })
        return () => { active = false }
    }, [profileReload])
    const selectProfile = (id: string, checked: boolean) => setDraft(previous => ({ ...previous, r2: { ...previous.r2,
        allowedProfileIds: checked ? [...new Set([...previous.r2.allowedProfileIds, id])]
            : previous.r2.allowedProfileIds.filter(selected => selected !== id) } }))
    return <form className="space-y-3 rounded-panel border p-3" aria-label={t('agentInbox.executionPolicy')}
        onSubmit={event => {
            event.preventDefault(); setError(false)
            try {
                updateAgentExecutionPolicy(policy, policy.revision, draft)
                void onSave(policy.revision, draft).catch(() => setError(true))
            } catch { setError(true) }
        }}>
        <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">{t('agentInbox.executionPolicy')} · {t('agentInbox.policyRevision', { revision: policy.revision })}</p>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={disabled} checked={draft.globalPause}
                onChange={event => setDraft({ ...draft, globalPause: event.target.checked })} />{t('agentInbox.globalPause')}</label>
        </div>
        <label className="block space-y-1 text-xs">{t('agentInbox.executionMode')}
            <select className="h-10 w-full rounded-md border bg-background px-3 text-sm" disabled={disabled} value={draft.mode}
                onChange={event => setDraft({ ...draft, mode: event.target.value as AgentExecutionPolicy['mode'], boundedAutoExpiresAt: null })}>
                <option value="observe">{t('agentInbox.modeObserve')}</option>
                <option value="suggest">{t('agentInbox.modeSuggest')}</option>
                <option value="bounded-auto">{t('agentInbox.modeBoundedAuto')}</option>
            </select>
        </label>
        <p className="text-xs text-muted-foreground">{t('agentInbox.policyExplanation')}</p>
        {draft.mode === 'bounded-auto' && <label className="block space-y-1 text-xs">{t('agentInbox.autoExpiry')}
            <Input type="datetime-local" required disabled={disabled} step={60}
                value={draft.boundedAutoExpiresAt ? new Date(Date.parse(draft.boundedAutoExpiresAt) - new Date(draft.boundedAutoExpiresAt).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : ''}
                onChange={event => setDraft({ ...draft, boundedAutoExpiresAt: event.target.value ? new Date(event.target.value).toISOString() : null })} />
        </label>}
        <p className="text-xs text-muted-foreground">{t('agentInbox.queuePacing')}</p>
        <fieldset className="space-y-2 text-xs"><legend>{t('agentInbox.authoringPermissions', '저장 데이터 편집 권한')}</legend>
            <label className="flex items-center gap-2"><input type="checkbox" disabled={disabled} checked={draft.authoring.allowSceneChanges}
                onChange={event => setDraft({ ...draft, authoring: { allowSceneChanges: event.target.checked } })} />{t('agentInbox.allowSceneChanges', '제한 자동 모드에서 에셋 설정 편집 허용')}</label>
            <label className="flex items-center gap-2"><input type="checkbox" disabled={disabled} checked={draft.output.allowCreateFolders}
                onChange={event => setDraft({ ...draft, output: { ...draft.output, allowCreateFolders: event.target.checked } })} />{t('agentInbox.allowCreateFolders', '설정된 저장 위치 아래에 폴더 만들기 허용')}</label>
            <label className="flex items-center gap-2"><input type="checkbox" disabled={disabled} checked={draft.output.allowRenamePathSegments}
                onChange={event => setDraft({ ...draft, output: { ...draft.output, allowRenamePathSegments: event.target.checked } })} />{t('agentInbox.allowRenamePathSegments', '비어 있는 폴더의 저장 경로 변경 허용')}</label>
        </fieldset>
        <fieldset className="space-y-2 rounded border p-3 text-xs"><legend>{t('agentInbox.r2Permissions', '인터넷 저장 권한')}</legend>
            <label className="flex items-center gap-2"><input type="checkbox" disabled={disabled} checked={draft.r2.allowUpload}
                onChange={event => setDraft({ ...draft, r2: { ...draft.r2, allowUpload: event.target.checked } })} />{t('agentInbox.allowR2Upload', 'R2 업로드 허용')}</label>
            <p>{t('agentInbox.r2ProfileSelection', '사용할 저장 연결을 선택하세요. 아래 정책 저장 버튼을 누르면 업로드 허용 여부와 선택한 연결이 함께 저장됩니다.')}</p>
            {profiles.status === 'loading' && <p role="status">{t('agentInbox.r2ProfilesLoading', '저장 연결을 불러오는 중입니다.')}</p>}
            {profiles.status === 'error' && <div role="alert">
                <p>{t('agentInbox.r2ProfilesFailed', '저장 연결 목록을 불러오지 못했습니다. 이전에 선택한 연결은 그대로 유지됩니다.')}</p>
                <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => {
                    setProfiles({ status: 'loading', items: [] }); setProfileReload(value => value + 1)
                }}>{t('agentInbox.r2ProfilesRetry', '다시 불러오기')}</Button>
            </div>}
            {profiles.status === 'ready' && profiles.items.length === 0 && <p>{t('agentInbox.r2ProfilesEmpty', '등록된 저장 연결이 없습니다. 먼저 R2 연결 설정에서 저장 연결을 추가하세요.')}</p>}
            {profiles.items.map(profile => <label key={profile.id} className="flex items-center gap-2">
                <input type="checkbox" disabled={disabled} checked={draft.r2.allowedProfileIds.includes(profile.id)}
                    onChange={event => selectProfile(profile.id, event.target.checked)} />{profile.name}
            </label>)}
            {profiles.status === 'ready' && draft.r2.allowedProfileIds.filter(id => !profiles.items.some(profile => profile.id === id)).map((id, index) =>
                <label key={id} className="flex items-center gap-2"><input type="checkbox" disabled={disabled} checked
                    onChange={event => selectProfile(id, event.target.checked)} />{t('agentInbox.r2ProfileMissing', '이전에 선택한 연결 {{count}} (현재 목록에 없음)', { count: index + 1 })}</label>)}
            <p className="text-muted-foreground">{t('agentInbox.r2UploadScope', '연결 선택만으로 파일이 업로드되지는 않습니다. 실제 업로드는 폴더 설정과 연결 준비 상태, 실행 정책을 함께 확인합니다.')}</p>
        </fieldset>
        <details><summary className="cursor-pointer text-xs font-medium">{t('agentInbox.allowedCompatibility')}</summary>
            <fieldset className="mt-3 space-y-2 text-xs"><legend>{t('agentInbox.allowedCompatibility')}</legend>
                {(['captured-pass', 'live-canary-pass', 'synthetic-only'] as const).map(status => <label key={status} className="flex items-center gap-2">
                    <input type="checkbox" disabled={disabled} checked={draft.generation.allowedCompatibilityStatuses.includes(status)} onChange={event => setDraft({ ...draft,
                        generation: { ...draft.generation, allowedCompatibilityStatuses: event.target.checked
                            ? [...draft.generation.allowedCompatibilityStatuses, status] : draft.generation.allowedCompatibilityStatuses.filter(item => item !== status) } })} />{status}
                </label>)}
            </fieldset>
            <p className="mt-3 text-xs text-muted-foreground">{t('agentInbox.authoringLimits', '작업 취소와 결과 등록 복구는 사람의 승인이 필요합니다. 새 저장 위치 지정, 파일 덮어쓰기와 원본 삭제는 지원하지 않습니다. R2 설정 변경은 업로드 실행과 별개입니다.')}</p>
        </details>
        {error && <p role="alert" className="text-xs text-destructive">{t('agentInbox.policySaveFailed')}</p>}
        <Button type="submit" size="sm" disabled={disabled}>{t('agentInbox.savePolicy')}</Button>
    </form>
}
