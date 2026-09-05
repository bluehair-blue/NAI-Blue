import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import ja from '@/i18n/locales/ja.json'
import { DEFAULT_AGENT_EXECUTION_POLICY } from '@/application/agent/agent-execution-policy'
import type { ForegroundAgentCommandRuntime, ForegroundAgentSnapshot } from '@/composition-root/foreground-agent-command-runtime'

vi.mock('@/composition-root/runtime-agent-commands', () => ({ runtimeAgentCommands: {} }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
import { AgentCommandPanel } from '@/presentation/agent/AgentCommandPanel'

describe('human execution controls in the existing inbox panel', () => {
    it('renders bound pending review facts and the existing batch link without automatic approval', () => {
        const snapshot: ForegroundAgentSnapshot = { status: 'ready', workspaceId: 'workspace', clients: [], capabilities: [],
            changingClient: false, changingExecution: false, policy: DEFAULT_AGENT_EXECUTION_POLICY,
            recent: [{ requestId: 'request-done', state: 'completed', batchId: 'batch-existing' }],
            pendingApprovals: [{ requestId: 'request-review', clientId: 'client-human', requestHash: `sha256:${'1'.repeat(64)}`,
                planHash: `sha256:${'2'.repeat(64)}`, planId: `sha256:${'2'.repeat(64)}`, policyRevision: 0,
                expiresAt: '2099-01-01T00:00:00.000Z', estimatedAnlas: 12, imageCount: 2,
                sourceIds: ['reviewed-source'], compatibilityStatuses: ['captured-pass'], outputEffect: 'local-output', reasons: ['AGENT_APPROVAL_REQUIRED'] }],
        }
        const decideApproval = vi.fn()
        const runtime = { subscribe: () => () => undefined, getSnapshot: () => snapshot, decideApproval } as unknown as ForegroundAgentCommandRuntime
        const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(AgentCommandPanel, { runtime })))
        for (const fact of ['request-review', 'client-human', 'reviewed-source', 'captured-pass', '2099-01-01',
            'agentInbox.approveOnce', 'agentInbox.rejectApproval', 'agentInbox.reviewCost', 'agentInbox.outputLocal', 'batch-existing', 'href="/queue"']) expect(html).toContain(fact)
        expect(html).toContain('value="suggest" selected=""')
        expect(html).not.toContain('type="datetime-local"')
        expect(decideApproval).not.toHaveBeenCalled()
    })
    it('keeps all inbox policy and approval messages available in Korean, English and Japanese', () => {
        expect(Object.keys(ko.agentInbox).sort()).toEqual(Object.keys(en.agentInbox).sort())
        expect(Object.keys(ja.agentInbox).sort()).toEqual(Object.keys(en.agentInbox).sort())
        for (const locale of [ko, en, ja]) {
            for (const key of ['approveOnce', 'rejectApproval', 'autoExpiry', 'policySaveFailed', 'maxAnlasPerDay', 'unavailableChanges'] as const) {
                expect(locale.agentInbox[key].length).toBeGreaterThan(0)
            }
        }
    })
})
