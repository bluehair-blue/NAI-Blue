import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { type AgentExecutionPolicy, updateAgentExecutionPolicy } from '@/application/agent/agent-execution-policy'

/** Mounted by policy revision so a newly committed policy replaces any stale human draft. */
export function AgentPolicyForm({ policy, disabled, onSave }: {
    policy: AgentExecutionPolicy
    disabled: boolean
    onSave: (expectedRevision: number, next: AgentExecutionPolicy) => Promise<unknown>
}) {
    const { t } = useTranslation()
    const [draft, setDraft] = useState(policy)
    const [error, setError] = useState(false)
    const number = (group: 'generation' | 'rollingLimits', key: string, max: number, min = 0) =>
        <label key={key} className="space-y-1 text-xs">{t(`agentInbox.${key}`)}
            <Input type="number" min={min} max={max} step={1} required disabled={disabled}
                value={draft[group][key as keyof typeof draft[typeof group]] as number}
                onChange={event => setDraft({ ...draft, [group]: { ...draft[group], [key]: event.target.valueAsNumber } })} />
        </label>
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
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {number('generation', 'maxImagesPerRun', 1_000, 1)}
            {number('generation', 'maxAnlasPerRun', 1_000_000)}
            {number('generation', 'maxConcurrentJobs', 2, 1)}
        </div>
        <details><summary className="cursor-pointer text-xs font-medium">{t('agentInbox.advancedLimits')}</summary>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {number('rollingLimits', 'maxRunsPerHour', 10_000)}
                {number('rollingLimits', 'maxImagesPerHour', 100_000)}
                {number('rollingLimits', 'maxAnlasPerHour', 10_000_000)}
                {number('rollingLimits', 'maxAnlasPerDay', 100_000_000)}
                {number('rollingLimits', 'maxOutstandingRequestsPerClient', 100, 1)}
            </div>
            <fieldset className="mt-3 space-y-2 text-xs"><legend>{t('agentInbox.allowedCompatibility')}</legend>
                {(['captured-pass', 'live-canary-pass', 'synthetic-only'] as const).map(status => <label key={status} className="flex items-center gap-2">
                    <input type="checkbox" disabled={disabled} checked={draft.generation.allowedCompatibilityStatuses.includes(status)} onChange={event => setDraft({ ...draft,
                        generation: { ...draft.generation, allowedCompatibilityStatuses: event.target.checked
                            ? [...draft.generation.allowedCompatibilityStatuses, status] : draft.generation.allowedCompatibilityStatuses.filter(item => item !== status) } })} />{status}
                </label>)}
            </fieldset>
            <p className="mt-3 text-xs text-muted-foreground">{t('agentInbox.unavailableChanges')}</p>
        </details>
        {error && <p role="alert" className="text-xs text-destructive">{t('agentInbox.policySaveFailed')}</p>}
        <Button type="submit" size="sm" disabled={disabled}>{t('agentInbox.savePolicy')}</Button>
    </form>
}
