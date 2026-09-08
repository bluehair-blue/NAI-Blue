import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_EXECUTION_POLICY, normalizeAgentExecutionPolicy, updateAgentExecutionPolicy } from '@/application/agent/agent-execution-policy'

describe('agent policy R2 authorization controls', () => {
    const source = readFileSync('src/presentation/agent/AgentPolicyForm.tsx', 'utf8')
    it('lists existing connection names and saves both controls through the existing policy action', () => {
        expect(source).toContain('getRuntimeR2UploadRepository().listProfiles()')
        expect(source).toContain('items.map(({ id, name }) => ({ id, name }))')
        expect(source).toContain('checked={draft.r2.allowUpload}')
        expect(source).toContain('checked={draft.r2.allowedProfileIds.includes(profile.id)}')
        expect(source).toContain('selectProfile(profile.id, event.target.checked)')
        expect(source).toContain('{profile.name}')
        expect(source).toContain('onSave(policy.revision, draft)')
        expect(source).not.toContain('getCredential')
        expect(source).not.toContain('enqueue(')
    })
    it('keeps selected consent across loading failure and retains missing profiles until explicitly unchecked', () => {
        const loading = source.slice(source.indexOf('useEffect(() =>'), source.indexOf('const selectProfile'))
        expect(loading).toContain("status: 'error'")
        expect(loading).not.toContain('setDraft')
        expect(loading).not.toContain('allowedProfileIds')
        expect(source).toContain('이전에 선택한 연결은 그대로 유지됩니다.')
        expect(source).toContain('draft.r2.allowedProfileIds.filter(id => !profiles.items.some(profile => profile.id === id))')
        expect(source).toContain('previous.r2.allowedProfileIds.filter(selected => selected !== id)')
    })
    it('defaults deny upload and persists explicit selected profile consent together without enabling overwrite', () => {
        const current = structuredClone(DEFAULT_AGENT_EXECUTION_POLICY)
        expect(current.r2).toMatchObject({ allowUpload: false, allowedProfileIds: [], allowOverwrite: false })
        const saved = updateAgentExecutionPolicy(current, current.revision,
            { ...current, r2: { ...current.r2, allowUpload: true, allowedProfileIds: ['profile-primary', 'profile-existing'] } })
        expect(normalizeAgentExecutionPolicy(JSON.parse(JSON.stringify(saved))).r2).toEqual({
            allowUpload: true, allowedProfileIds: ['profile-primary', 'profile-existing'], allowOverwrite: false,
        })
        expect(saved.revision).toBe(current.revision + 1)
    })
})
