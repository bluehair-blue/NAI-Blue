import { canonicalSerialize, hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import type { Sha256Digest } from '@/application/generation/generation-plan-contract'
import { AgentCommandError, assertAgentPublicValue } from './agent-command-contract'

/** Queue inspection supplies immutable membership; stopped jobs are captured again at consent. */
export interface AgentCancellationTarget {
    readonly runId: string
    readonly batchId: string
    readonly jobIds: readonly string[]
    readonly targetHash: Sha256Digest
    readonly previouslyStoppedJobIds: readonly string[]
}
export interface AgentCancellationGrant {
    readonly requestId: string
    readonly requestHash: Sha256Digest
    readonly workspaceId: string
    readonly clientId: string
    readonly actorKind: 'agent' | 'service'
    readonly policyRevision: number
    readonly consentedAt: string
    readonly expiresAt: string
    readonly authorization: 'human'
    readonly target: AgentCancellationTarget
}
export interface AgentCancellationResult {
    readonly status: 'cancel-requested'
    readonly runId: string
    readonly batchId: string
    readonly jobIds: readonly string[]
}
export interface AgentCancellationPorts {
    inspect(runId: string): Promise<AgentCancellationTarget | null>
    cancel(target: AgentCancellationTarget, grant: AgentCancellationGrant): Promise<AgentCancellationResult>
    /** Read exact grant markers only; absent or partial evidence never authorizes another cancel. */
    reconcile(grant: AgentCancellationGrant): Promise<AgentCancellationResult | null>
}

export function assertAgentCancellationTarget(value: unknown): asserts value is AgentCancellationTarget {
    const target = value as AgentCancellationTarget
    const id = (item: unknown): item is string => typeof item === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(item)
    if (!target || Object.keys(target).sort().join() !== 'batchId,jobIds,previouslyStoppedJobIds,runId,targetHash'
        || !id(target.runId) || target.batchId !== target.runId || !/^sha256:[a-f0-9]{64}$/.test(target.targetHash)
        || !Array.isArray(target.jobIds) || !target.jobIds.length || !target.jobIds.every(id)
        || new Set(target.jobIds).size !== target.jobIds.length || !Array.isArray(target.previouslyStoppedJobIds)
        || new Set(target.previouslyStoppedJobIds).size !== target.previouslyStoppedJobIds.length
        || !target.previouslyStoppedJobIds.every(jobId => target.jobIds.includes(jobId))) throw new AgentCommandError('INVALID_CANCELLATION_TARGET')
    assertAgentPublicValue(target)
}

/** Mutable stop facts may advance during review; immutable membership cannot change under consent. */
export function sameAgentCancellationTarget(left: AgentCancellationTarget, right: AgentCancellationTarget): boolean {
    return left.runId === right.runId && left.batchId === right.batchId && left.targetHash === right.targetHash
        && canonicalSerialize(left.jobIds) === canonicalSerialize(right.jobIds)
}

export function isAgentCancellationResult(value: unknown, grant: AgentCancellationGrant): value is AgentCancellationResult {
    const result = value as AgentCancellationResult
    return !!result && Object.keys(result).sort().join() === 'batchId,jobIds,runId,status'
        && result.status === 'cancel-requested' && result.runId === grant.target.runId && result.batchId === grant.target.batchId
        && Array.isArray(result.jobIds) && result.jobIds.length === grant.target.jobIds.length
        && result.jobIds.every((id, index) => id === grant.target.jobIds[index])
}

/** This stable Queue marker proves this exact human grant after receipt publication fails. */
export function agentCancellationMarker(grant: AgentCancellationGrant): string {
    return `agent-cancel:${hashCanonicalValue(grant)}`
}
