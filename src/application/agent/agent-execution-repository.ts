import { canonicalSerialize, hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import type { JsonObject } from '@/domain/composition/types'
import type { Sha256Digest } from '@/application/generation/generation-plan-contract'
import { AgentCommandError, agentRequestHash, assertAgentPublicValue, parseAgentCommandEnvelope, type AgentCommandEnvelope } from './agent-command-contract'
import { assertAgentCancellationTarget, isAgentCancellationResult, sameAgentCancellationTarget, type AgentCancellationGrant, type AgentCancellationTarget } from './agent-cancellation-contract'
import { assertAgentStorageRetryTarget, isAgentStorageRetryResult, type AgentStorageRetryGrant, type AgentStorageRetryTarget } from './agent-storage-retry-contract'

/** Durable authority is local: public inbox results contain only a projection of these records. */
export interface AgentExecutionGrant {
    readonly requestId: string
    readonly requestHash: Sha256Digest
    readonly workspaceId: string
    readonly clientId: string
    readonly actorKind: 'agent' | 'service'
    readonly planId: Sha256Digest
    readonly planHash: Sha256Digest
    readonly scopeId: string
    readonly policyRevision: number
    readonly consentedAt: string
    readonly authorization: 'human' | 'bounded-auto'
    readonly estimatedAnlas: number
    readonly imageCount: number
}
export interface AgentGenerationExecutionRecord {
    readonly envelope: AgentCommandEnvelope
    readonly originalPolicyRevision: number
    readonly policyRevision: number
    readonly expiresAt: string
    readonly estimatedAnlas: number
    readonly imageCount: number
    /** First exact Queue observation that all jobs settled; estimates are retained for full rolling windows from here. */
    readonly exposureSettledAt: string | null
    readonly state: 'pending' | 'reserved' | 'unknown' | 'completed' | 'rejected'
    readonly grant: AgentExecutionGrant | null
    readonly result: JsonObject
}
/** Cancellation shares durable request history without pretending to reserve generation spend. */
export interface AgentCancellationRecord {
    readonly command: 'generation.cancel'
    readonly envelope: AgentCommandEnvelope
    readonly originalPolicyRevision: number
    readonly policyRevision: number
    readonly expiresAt: string
    readonly target: AgentCancellationTarget
    readonly state: AgentGenerationExecutionRecord['state']
    readonly grant: AgentCancellationGrant | null
    readonly result: JsonObject
}
export interface AgentStorageRetryRecord extends Omit<AgentCancellationRecord, 'command' | 'target' | 'grant'> {
    readonly command: 'generation.retry_storage'
    readonly target: AgentStorageRetryTarget
    readonly grant: AgentStorageRetryGrant | null
}
export type AgentQueueRepairRecord = AgentCancellationRecord | AgentStorageRetryRecord
export type AgentExecutionRecord = AgentGenerationExecutionRecord | AgentQueueRepairRecord
export function isAgentCancellationRecord(record: AgentExecutionRecord): record is AgentCancellationRecord {
    return 'command' in record && record.command === 'generation.cancel'
}
export function isAgentGenerationRecord(record: AgentExecutionRecord): record is AgentGenerationExecutionRecord {
    return !isAgentCancellationRecord(record) && !isAgentStorageRetryRecord(record)
}
export function isAgentStorageRetryRecord(record: AgentExecutionRecord): record is AgentStorageRetryRecord {
    return 'command' in record && record.command === 'generation.retry_storage'
}
export interface AgentExecutionLedger {
    readonly schemaVersion: 1
    readonly workspaceId: string
    readonly revision: number
    readonly records: readonly AgentExecutionRecord[]
}
export interface AgentExecutionRepository {
    get(workspaceId: string): Promise<AgentExecutionLedger | null>
    compareAndSet(expected: AgentExecutionLedger | null, next: AgentExecutionLedger): Promise<boolean>
}
export function agentExecutionScope(envelope: AgentCommandEnvelope): string {
    return `agent-${hashCanonicalValue({ workspaceId: envelope.context.workspaceId,
        clientId: envelope.context.clientId, requestId: envelope.requestId, requestHash: envelope.requestHash,
        planHash: envelope.command.input.planHash })}`
}
/** Public commit facts still bind to the exact reserved batch and ordered job count. */
export function isAgentExecutionCommitResult(result: JsonObject, grant: AgentExecutionGrant): boolean {
    return result.status === 'ready' && result.batchId === `main-batch-${grant.scopeId}` && result.runId === result.batchId
        && Array.isArray(result.jobIds) && result.jobIds.length === grant.imageCount
        && result.jobIds.every(id => typeof id === 'string' && id.length > 0)
        && new Set(result.jobIds).size === result.jobIds.length
}

/** A corrupt reservation is never replaced by an empty ledger (which would restore spend authority). */
export function parseAgentExecutionLedger(value: unknown, workspaceId: string): AgentExecutionLedger {
    try {
        const ledger = value as AgentExecutionLedger
        if (!ledger || ledger.schemaVersion !== 1 || ledger.workspaceId !== workspaceId
            || !Number.isSafeInteger(ledger.revision) || ledger.revision < 0 || !Array.isArray(ledger.records)
            || Object.keys(ledger).sort().join() !== 'records,revision,schemaVersion,workspaceId') throw new Error()
        const ids = new Set<string>()
        for (const record of ledger.records) {
            const envelope = parseAgentCommandEnvelope(record.envelope)
            if (!isAgentGenerationRecord(record)) {
                validateQueueRepairRecord(record, envelope, workspaceId)
                if (ids.has(envelope.requestId)) throw new Error()
                ids.add(envelope.requestId)
                continue
            }
            if (envelope.context.workspaceId !== workspaceId || envelope.command.name !== 'generation.enqueue'
                || agentRequestHash(envelope) !== envelope.requestHash || ids.has(envelope.requestId)
                || Object.keys(envelope.command.input).sort().join() !== 'planHash,planId'
                || !['planId', 'planHash'].every(key => /^sha256:[a-f0-9]{64}$/.test(String(envelope.command.input[key])))
                || !Number.isSafeInteger(record.policyRevision) || record.policyRevision < 0
                || !Number.isSafeInteger(record.originalPolicyRevision) || record.originalPolicyRevision < 0
                || record.originalPolicyRevision > record.policyRevision
                || !Number.isSafeInteger(record.imageCount) || record.imageCount < 1
                || !Number.isFinite(record.estimatedAnlas) || record.estimatedAnlas < 0
                || !Number.isFinite(Date.parse(record.expiresAt)) || new Date(record.expiresAt).toISOString() !== record.expiresAt
                || record.expiresAt !== envelope.expiresAt
                || !['pending', 'reserved', 'unknown', 'completed', 'rejected'].includes(record.state)
                || Object.keys(record).sort().join() !== 'envelope,estimatedAnlas,expiresAt,exposureSettledAt,grant,imageCount,originalPolicyRevision,policyRevision,result,state') throw new Error()
            ids.add(envelope.requestId)
            assertAgentPublicValue(record.result)
            if (record.state === 'pending' && (record.grant !== null || record.result.code !== 'AGENT_APPROVAL_REQUIRED')) throw new Error()
            if ((record.state === 'reserved' || record.state === 'unknown') && record.result.code !== 'AGENT_EXECUTION_UNKNOWN') throw new Error()
            if (record.exposureSettledAt !== null && (record.state !== 'completed' || !record.grant
                || !Number.isFinite(Date.parse(record.exposureSettledAt))
                || new Date(record.exposureSettledAt).toISOString() !== record.exposureSettledAt
                || record.exposureSettledAt < record.grant.consentedAt)) throw new Error()
            if (['reserved', 'unknown', 'completed'].includes(record.state) && !record.grant) throw new Error()
            if (record.grant) {
                const grant = record.grant
                if (grant.requestId !== envelope.requestId || grant.requestHash !== envelope.requestHash
                    || grant.workspaceId !== workspaceId || grant.clientId !== envelope.context.clientId
                    || grant.actorKind !== envelope.context.actor.kind
                    || grant.planId !== envelope.command.input.planId || grant.planHash !== envelope.command.input.planHash
                    || grant.scopeId !== agentExecutionScope(envelope) || grant.policyRevision !== record.policyRevision
                    || grant.estimatedAnlas !== record.estimatedAnlas || grant.imageCount !== record.imageCount
                    || !['human', 'bounded-auto'].includes(grant.authorization)
                    || !Number.isFinite(Date.parse(grant.consentedAt))
                    || new Date(grant.consentedAt).toISOString() !== grant.consentedAt
                    || grant.consentedAt < envelope.submittedAt || grant.consentedAt >= record.expiresAt
                    || Object.keys(grant).sort().join() !== 'actorKind,authorization,clientId,consentedAt,estimatedAnlas,imageCount,planHash,planId,policyRevision,requestHash,requestId,scopeId,workspaceId') throw new Error()
                if (record.state === 'completed' && !isAgentExecutionCommitResult(record.result, grant)) throw new Error()
            }
        }
        return JSON.parse(canonicalSerialize(ledger)) as AgentExecutionLedger
    } catch { throw new AgentCommandError('INVALID_EXECUTION_STORE') }
}

/** The two human Queue operations share authority fields while retaining exact command-specific target validators. */
function validateQueueRepairRecord(record: AgentQueueRepairRecord, envelope: AgentCommandEnvelope, workspaceId: string): void {
    if (Object.keys(record).sort().join() !== 'command,envelope,expiresAt,grant,originalPolicyRevision,policyRevision,result,state,target'
        || envelope.command.name !== record.command || envelope.context.workspaceId !== workspaceId
        || agentRequestHash(envelope) !== envelope.requestHash
        || !Number.isSafeInteger(record.policyRevision) || record.policyRevision < 0
        || !Number.isSafeInteger(record.originalPolicyRevision) || record.originalPolicyRevision < 0
        || record.originalPolicyRevision > record.policyRevision || record.expiresAt !== envelope.expiresAt
        || !Number.isFinite(Date.parse(record.expiresAt)) || new Date(record.expiresAt).toISOString() !== record.expiresAt
        || !['pending', 'reserved', 'unknown', 'completed', 'rejected'].includes(record.state)) throw new Error()
    if (record.command === 'generation.cancel') {
        if (Object.keys(envelope.command.input).join() !== 'runId') throw new Error()
        assertAgentCancellationTarget(record.target)
    } else {
        if (Object.keys(envelope.command.input).sort().join() !== 'jobId,runId') throw new Error()
        assertAgentStorageRetryTarget(record.target)
        if (record.target.jobId !== envelope.command.input.jobId) throw new Error()
    }
    if (record.target.runId !== envelope.command.input.runId) throw new Error()
    assertAgentPublicValue(record.result)
    if (record.state === 'pending' && (record.grant !== null || record.result.code !== 'AGENT_APPROVAL_REQUIRED')) throw new Error()
    if ((record.state === 'reserved' || record.state === 'unknown') && record.result.code !== 'AGENT_EXECUTION_UNKNOWN') throw new Error()
    if (['reserved', 'unknown', 'completed'].includes(record.state) && !record.grant) throw new Error()
    if (!record.grant) return
    const grant = record.grant
    if (record.command === 'generation.cancel') {
        assertAgentCancellationTarget(record.grant.target)
        if (!sameAgentCancellationTarget(record.target, record.grant.target)
            || (record.state === 'completed' && !isAgentCancellationResult(record.result, record.grant))) throw new Error()
    } else {
        assertAgentStorageRetryTarget(record.grant.target)
        if (record.state === 'completed' && !isAgentStorageRetryResult(record.result, record.grant)) throw new Error()
    }
    if (Object.keys(grant).sort().join() !== 'actorKind,authorization,clientId,consentedAt,expiresAt,policyRevision,requestHash,requestId,target,workspaceId'
        || grant.requestId !== envelope.requestId || grant.requestHash !== envelope.requestHash
        || grant.workspaceId !== workspaceId || grant.clientId !== envelope.context.clientId
        || grant.actorKind !== envelope.context.actor.kind || grant.authorization !== 'human'
        || grant.policyRevision !== record.policyRevision || grant.expiresAt !== record.expiresAt
        || canonicalSerialize(record.target) !== canonicalSerialize(grant.target)
        || !Number.isFinite(Date.parse(grant.consentedAt)) || new Date(grant.consentedAt).toISOString() !== grant.consentedAt
        || grant.consentedAt < envelope.submittedAt || grant.consentedAt >= record.expiresAt) throw new Error()
}
