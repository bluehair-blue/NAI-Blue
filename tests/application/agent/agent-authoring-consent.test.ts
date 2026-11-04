import { describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_AUTHORING_CONSENT as defaults, hasAgentAuthoringConsent,
    normalizeAgentAuthoringConsent, updateAgentAuthoringConsent, validateAgentAuthoringConsent } from '@/application/agent/agent-authoring-consent'

describe('independent human editing consent', () => {
    it('defaults OFF and fails closed for malformed authority without repairing grants', () => {
        const grant = { workspaceId: 'workspace-1', clientId: 'client-1' }
        for (const invalid of [undefined, null, {}, { ...defaults, extra: true }, { ...defaults, revision: -1 },
            { ...defaults, approvedClients: [grant] }, { ...defaults, revision: 1, approvedClients: [grant, grant] },
            { ...defaults, revision: 1, approvedClients: [{ ...grant, alwaysGenerate: true }] },
            { ...defaults, revision: 1, approvedClients: [{ ...grant, clientId: '../client' }] },
            { ...defaults, revision: Number.MAX_SAFE_INTEGER }]) {
            expect(validateAgentAuthoringConsent(invalid)).toBe(false)
            expect(normalizeAgentAuthoringConsent(invalid)).toEqual(defaults)
        }
    })
    it('changes only the selected workspace/client and rejects stale revisions and invalid identities', () => {
        const first = updateAgentAuthoringConsent(defaults, 0, 'workspace-1', 'client-1', true)
        const second = updateAgentAuthoringConsent(first, 1, 'workspace-1', 'client-2', true)
        const third = updateAgentAuthoringConsent(second, 2, 'workspace-1', 'client-1', false)
        expect(hasAgentAuthoringConsent(third, 'workspace-1', 'client-1')).toBe(false)
        expect(hasAgentAuthoringConsent(third, 'workspace-1', 'client-2')).toBe(true)
        expect(hasAgentAuthoringConsent(third, 'workspace-2', 'client-2')).toBe(false)
        expect(normalizeAgentAuthoringConsent(JSON.parse(JSON.stringify(third)))).toEqual(third)
        expect(() => updateAgentAuthoringConsent(third, 1, 'workspace-1', 'client-1', true)).toThrow('revision changed')
        expect(() => updateAgentAuthoringConsent(third, 3, '../workspace', 'client-1', true)).toThrow('Invalid editing consent')
    })
})
