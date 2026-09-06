import { describe, expect, it } from 'vitest'
import { assertAgentPublicValue } from '@/application/agent/agent-command-contract'
import { assertAgentStorageRetryTarget, isAgentStorageRetryResult, type AgentStorageRetryGrant, type AgentStorageRetryTarget } from '@/application/agent/agent-storage-retry-contract'

const scope = 'dbe4f2d96161f10b48104a1522e7269abfb8a16ee223c7514912b5c8afc282d2'
const target: AgentStorageRetryTarget = { runId: `main-batch-agent-${scope}`, batchId: `main-batch-agent-${scope}`,
    jobId: `main-job-agent-${scope}-0`, artifactId: `artifact:main-job-agent-${scope}-0`,
    outputTransactionId: `queue-${scope.slice(0, 48)}`, targetHash: `sha256:${scope}` }

describe('agent files-committed storage retry contract', () => {
    it('accepts actual hash-shaped Queue transaction and Artifact identifiers', () => {
        expect(() => assertAgentStorageRetryTarget(target)).not.toThrow()
        expect(() => assertAgentPublicValue({ arbitraryTransaction: target.outputTransactionId })).toThrow()
    })
    it.each(['Bearer token-canary', 'data:image/png;base64,iVBORw0KGgoAAAAA', 'iVBORw0KGgoAAAAA', 'C:\\Users\\canary\\image.png'])(
        'keeps sensitive material forbidden in the exact transaction field: %s', outputTransactionId => {
            expect(() => assertAgentPublicValue({ outputTransactionId })).toThrow()
        })
    it.each([{ extra: true }, { runId: 'different-batch' }, { artifactId: '' }, { outputTransactionId: '' }])('rejects invalid target bindings %j', override => {
        expect(() => assertAgentStorageRetryTarget({ ...target, ...override })).toThrow()
    })
    it('validates exact completion facts without accepting a different output or additive payload', () => {
        const grant = { target } as AgentStorageRetryGrant
        const result = { status: 'storage-registered', runId: target.runId, batchId: target.batchId, jobId: target.jobId, artifactId: target.artifactId }
        expect(isAgentStorageRetryResult(result, grant)).toBe(true)
        expect(isAgentStorageRetryResult({ ...result, artifactId: 'different' }, grant)).toBe(false)
        expect(isAgentStorageRetryResult({ ...result, providerRetried: true }, grant)).toBe(false)
    })
})
