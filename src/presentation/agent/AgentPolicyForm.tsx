import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Link } from 'react-router'
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
    return <form className="agent-policy-form" aria-label={t('agentInbox.executionPolicy')}
        onSubmit={event => {
            event.preventDefault(); setError(false)
            try {
                updateAgentExecutionPolicy(policy, policy.revision, draft)
                void onSave(policy.revision, draft).catch(() => setError(true))
            } catch { setError(true) }
        }}>
        <header className="agent-policy-heading">
            <h3>{t('agentInbox.executionPolicy')}</h3>
            <span>{t('agentInbox.policyRevision', { revision: policy.revision })}</span>
        </header>
        <section className="agent-policy-mode">
            <label className="choice-field">{t('agentInbox.executionMode')}
                <select className="min-h-11 w-full rounded-control border border-input bg-background px-3" disabled={disabled} value={draft.mode}
                    onChange={event => setDraft({ ...draft, mode: event.target.value as AgentExecutionPolicy['mode'], boundedAutoExpiresAt: null })}>
                    <option value="observe">{t('agentInbox.modeObserve')}</option>
                    <option value="suggest">{t('agentInbox.modeSuggest')}</option>
                    <option value="bounded-auto">{t('agentInbox.modeBoundedAuto')}</option>
                </select>
            </label>
            <p className="choice-help">{t(draft.mode === 'bounded-auto' ? 'agentInbox.policyExplanation' : draft.mode === 'observe' ? 'readableChoices.observeHint' : 'readableChoices.suggestHint')}</p>
            {draft.mode === 'bounded-auto' && <label className="choice-field">{t('agentInbox.autoExpiry')}
                <Input type="datetime-local" required disabled={disabled} step={60}
                    value={draft.boundedAutoExpiresAt ? new Date(Date.parse(draft.boundedAutoExpiresAt) - new Date(draft.boundedAutoExpiresAt).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : ''}
                    onChange={event => setDraft({ ...draft, boundedAutoExpiresAt: event.target.value ? new Date(event.target.value).toISOString() : null })} />
            </label>}
            <label className="choice-row"><input className="choice-checkbox" type="checkbox" disabled={disabled} checked={draft.globalPause}
                onChange={event => setDraft({ ...draft, globalPause: event.target.checked })} /><span>{t('agentInbox.globalPause')}</span></label>
        </section>
        <div className="agent-policy-grid">
            <fieldset className="choice-group"><legend>{t('agentInbox.authoringPermissions', '저장 데이터 편집 권한')}</legend>
                <label className="choice-row"><input className="choice-checkbox" type="checkbox" disabled={disabled} checked={draft.authoring.allowSceneChanges}
                    onChange={event => setDraft({ ...draft, authoring: { allowSceneChanges: event.target.checked } })} />
                    <span>{t('readableChoices.editAssets')}<span className="choice-description">{t('readableChoices.editAssetsScope')}</span></span>
                </label>
                <label className="choice-row"><input className="choice-checkbox" type="checkbox" disabled={disabled} checked={draft.output.allowCreateFolders}
                    onChange={event => setDraft({ ...draft, output: { ...draft.output, allowCreateFolders: event.target.checked } })} />
                    <span>{t('readableChoices.createFolders')}<span className="choice-description">{t('readableChoices.createFoldersScope')}</span></span>
                </label>
                <label className="choice-row"><input className="choice-checkbox" type="checkbox" disabled={disabled} checked={draft.output.allowRenamePathSegments}
                    onChange={event => setDraft({ ...draft, output: { ...draft.output, allowRenamePathSegments: event.target.checked } })} />
                    <span>{t('readableChoices.renameFolders')}<span className="choice-description">{t('readableChoices.renameFoldersScope')}</span></span>
                </label>
            </fieldset>
            <fieldset className="choice-group"><legend>{t('agentInbox.r2Permissions', '인터넷 저장 권한')}</legend>
                <label className="choice-row"><input className="choice-checkbox" type="checkbox" disabled={disabled} checked={draft.r2.allowUpload}
                    onChange={event => setDraft({ ...draft, r2: { ...draft.r2, allowUpload: event.target.checked } })} />
                    <span>{t('agentInbox.allowR2Upload', 'R2 업로드 허용')}<span className="choice-description">{t('readableChoices.uploadScope')}</span></span>
                </label>
                <div className="agent-policy-connections">
                    {profiles.status === 'loading' && <p role="status" className="choice-help">{t('agentInbox.r2ProfilesLoading', '저장 연결을 불러오는 중입니다.')}</p>}
                    {profiles.status === 'error' && <div role="alert" className="space-y-3">
                        <p className="choice-help">{t('agentInbox.r2ProfilesFailed', '저장 연결 목록을 불러오지 못했습니다. 이전에 선택한 연결은 그대로 유지됩니다.')}</p>
                        <Button type="button" variant="outline" disabled={disabled} onClick={() => {
                            setProfiles({ status: 'loading', items: [] }); setProfileReload(value => value + 1)
                        }}>{t('agentInbox.r2ProfilesRetry', '다시 불러오기')}</Button>
                    </div>}
                    {profiles.status === 'ready' && profiles.items.length === 0 && <div className="space-y-2">
                        <p className="choice-help">{t('readableChoices.noConnections')}</p>
                        <Link className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline underline-offset-4" to="/r2">{t('readableChoices.addConnection')}</Link>
                    </div>}
                    {profiles.items.length > 0 && <p className="choice-help">{t('readableChoices.chooseConnections')}</p>}
                    {profiles.items.map(profile => <label key={profile.id} className="choice-row">
                        <input className="choice-checkbox" type="checkbox" disabled={disabled} checked={draft.r2.allowedProfileIds.includes(profile.id)}
                            onChange={event => selectProfile(profile.id, event.target.checked)} /><span>{profile.name}</span>
                    </label>)}
                    {profiles.status === 'ready' && draft.r2.allowedProfileIds.filter(id => !profiles.items.some(profile => profile.id === id)).map((id, index) =>
                        <label key={id} className="choice-row"><input className="choice-checkbox" type="checkbox" disabled={disabled} checked
                            onChange={event => selectProfile(id, event.target.checked)} /><span>{t('agentInbox.r2ProfileMissing', '이전에 선택한 연결 {{count}} (현재 목록에 없음)', { count: index + 1 })}</span></label>)}
                    <p className="choice-help">{t('readableChoices.uploadConditions')}</p>
                </div>
            </fieldset>
        </div>
        <details className="choice-details"><summary>{t('agentInbox.allowedCompatibility')}</summary>
            <fieldset className="choice-group"><legend className="sr-only">{t('agentInbox.allowedCompatibility')}</legend>
                {(['captured-pass', 'live-canary-pass', 'synthetic-only'] as const).map(status => <label key={status} className="choice-row">
                    <input className="choice-checkbox" type="checkbox" disabled={disabled} checked={draft.generation.allowedCompatibilityStatuses.includes(status)} onChange={event => setDraft({ ...draft,
                        generation: { ...draft.generation, allowedCompatibilityStatuses: event.target.checked
                            ? [...draft.generation.allowedCompatibilityStatuses, status] : draft.generation.allowedCompatibilityStatuses.filter(item => item !== status) } })} /><span>{status}</span>
                </label>)}
            </fieldset>
            <p className="choice-help">{t('agentInbox.queuePacing')}</p>
        </details>
        <p className="choice-help">{t('readableChoices.policyLimits')}</p>
        {error && <p role="alert" className="text-sm text-destructive">{t('agentInbox.policySaveFailed')}</p>}
        <footer className="agent-policy-footer">
            <p className="choice-help">{t('readableChoices.saveHint')}</p>
            <Button type="submit" className="min-h-12" disabled={disabled}>{t('agentInbox.savePolicy')}</Button>
        </footer>
    </form>
}
