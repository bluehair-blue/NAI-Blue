import { canonicalSerialize } from '@/domain/composition/canonical-serialize'
import type { Sha256Digest } from '@/application/generation/generation-plan-contract'
import { AgentCommandError, assertAgentPublicValue } from './agent-command-contract'

export interface AgentStorageRetryInput {
    readonly runId: string
    readonly jobId: string
}
/** Public immutable bindings identify one committed output; paths and journal contents stay in the storage adapter. */
export interface AgentStorageRetryTarget extends AgentStorageRetryInput {
    readonly batchId: string
    readonly outputTransactionId: string
    readonly artifactId: string
    readonly targetHash: Sha256Digest
}
export interface AgentStorageRetryGrant {
    readonly requestId: string
    readonly requestHash: Sha256Digest
    readonly workspaceId: string
    readonly clientId: string
    readonly actorKind: 'agent' | 'service'
    readonly policyRevision: number
    readonly consentedAt: string
    readonly expiresAt: string
    readonly authorization: 'human'
    readonly target: AgentStorageRetryTarget
}
export interface AgentStorageRetryResult {
    readonly status: 'storage-registered'
    readonly runId: string
    readonly batchId: string
    readonly jobId: string
    readonly artifactId: string
}
export interface AgentStorageRetryPorts {
    inspect(input: AgentStorageRetryInput): Promise<AgentStorageRetryTarget | null>
    retry(target: AgentStorageRetryTarget, grant: AgentStorageRetryGrant): Promise<AgentStorageRetryResult>
    /** Exact Artifact plus Queue completion facts only; never re-enter storage retry after an unknown outcome. */
    reconcile(grant: AgentStorageRetryGrant): Promise<AgentStorageRetryResult | null>
}

export function assertAgentStorageRetryTarget(value: unknown): asserts value is AgentStorageRetryTarget {
    const target = value as AgentStorageRetryTarget
    const id = (item: unknown): item is string => typeof item === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(item)
    if (!target || Object.keys(target).sort().join() !== 'artifactId,batchId,jobId,outputTransactionId,runId,targetHash'
        || !id(target.runId) || target.batchId !== target.runId || !id(target.jobId)
        || !id(target.outputTransactionId) || !id(target.artifactId) || !/^sha256:[a-f0-9]{64}$/.test(target.targetHash)) {
        throw new AgentCommandError('INVALID_STORAGE_RETRY_TARGET')
    }
    assertAgentPublicValue(target)
}
export function sameAgentStorageRetryTarget(left: AgentStorageRetryTarget, right: AgentStorageRetryTarget): boolean {
    return canonicalSerialize(left) === canonicalSerialize(right)
}
export function isAgentStorageRetryResult(value: unknown, grant: AgentStorageRetryGrant): value is AgentStorageRetryResult {
    const result = value as AgentStorageRetryResult
    return !!result && Object.keys(result).sort().join() === 'artifactId,batchId,jobId,runId,status'
        && result.status === 'storage-registered' && result.runId === grant.target.runId && result.batchId === grant.target.batchId
        && result.jobId === grant.target.jobId && result.artifactId === grant.target.artifactId
}
