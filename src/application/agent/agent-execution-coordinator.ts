import { canonicalSerialize } from '@/domain/composition/canonical-serialize'
import type { JsonObject } from '@/domain/composition/types'
import type { GenerationPlan, Sha256Digest } from '@/application/generation/generation-plan-contract'
import type { GenerationPlanRepository } from '@/application/generation/generation-plan-repository'
import { AgentCommandError, assertAgentPublicValue, type AgentCommandEnvelope } from './agent-command-contract'
import { agentResultDigest, type AgentCommandReceipt, type CommandReceiptRepository } from './command-receipt-repository'
import { effectiveAgentExecutionPolicy, normalizeAgentExecutionPolicy, type AgentExecutionPolicy } from './agent-execution-policy'
import { agentExecutionScope, isAgentExecutionCommitResult, type AgentExecutionGrant, type AgentExecutionLedger, type AgentExecutionRecord, type AgentExecutionRepository } from './agent-execution-repository'
import type { AgentCommandHandler } from './runtime-capability-registry'

export interface AgentExecutionApprovalBinding {
    readonly requestHash: Sha256Digest
    readonly planHash: Sha256Digest
    readonly policyRevision: number
}
export interface AgentExecutionReview extends AgentExecutionApprovalBinding {
    readonly requestId: string
    readonly clientId: string
    readonly planId: Sha256Digest
    readonly expiresAt: string
    readonly estimatedAnlas: number
    readonly imageCount: number
    readonly compatibilityStatuses: readonly string[]
    readonly sourceIds: readonly string[]
    readonly outputEffect: 'local-output' | 'local-output-and-r2'
    readonly reasons: readonly string[]
}
export type AgentPendingApproval = AgentExecutionReview
export type AgentApprovalExpectation = AgentExecutionApprovalBinding
export interface AgentExecutionCoordinatorOptions {
    readonly workspaceId: string
    readonly repository: AgentExecutionRepository
    readonly receipts: CommandReceiptRepository
    readonly plans: GenerationPlanRepository
    readonly getPolicy: () => AgentExecutionPolicy
    readonly now?: () => string
    readonly isClientAuthorized: (envelope: AgentCommandEnvelope) => Promise<boolean>
    readonly ports: {
        /** Replay source/output authority and current readiness without enqueueing. */
        readonly validate: (plan: GenerationPlan) => Promise<boolean>
        readonly enqueue: (plan: GenerationPlan, grant: AgentExecutionGrant) => Promise<JsonObject>
        /** Return facts only for this exact deterministic batch; null never authorizes a retry. */
        readonly reconcile: (grant: AgentExecutionGrant) => Promise<JsonObject | null>
        readonly isOutstanding?: (grant: AgentExecutionGrant) => Promise<boolean>
    }
}
const approval = (reason?: string): JsonObject => ({ code: 'AGENT_APPROVAL_REQUIRED', ...(reason ? { issueCodes: [reason] } : {}) })
const unknown = (): JsonObject => ({ code: 'AGENT_EXECUTION_UNKNOWN' })
const failure = (code: string): JsonObject => ({ code })
const adjustablePolicyIssue = (code: string | null): boolean => code !== null
    && ['AGENT_RUN_LIMIT', 'AGENT_CONCURRENCY_LIMIT', 'AGENT_COMPATIBILITY_DENIED', 'AGENT_R2_DENIED'].includes(code)

function validateInput(input: JsonObject): JsonObject {
    if (Object.keys(input).sort().join() !== 'planHash,planId'
        || !['planId', 'planHash'].every(key => typeof input[key] === 'string' && /^sha256:[a-f0-9]{64}$/.test(input[key] as string))) {
        throw new AgentCommandError('INVALID_COMMAND_INPUT')
    }
    return input
}
function receiptState(result: JsonObject): 'completed' | 'needs-input' | 'rejected' {
    return result.code === 'AGENT_APPROVAL_REQUIRED' || result.code === 'AGENT_EXECUTION_UNKNOWN' ? 'needs-input'
        : result.status === 'ready' ? 'completed' : 'rejected'
}

/** One durable reservation precedes the only enqueue call. Recovery reads Queue facts and never re-enters enqueue. */
export function createAgentExecutionCoordinator(options: AgentExecutionCoordinatorOptions) {
    const now = options.now ?? (() => new Date().toISOString())
    const policy = () => effectiveAgentExecutionPolicy(normalizeAgentExecutionPolicy(options.getPolicy()), Date.parse(now()))
    const ledger = () => options.repository.get(options.workspaceId)
    // ponytail: a workspace CAS ledger favors auditability; partition only if measured contention requires it.
    async function change(transform: (records: readonly AgentExecutionRecord[]) => readonly AgentExecutionRecord[] | null): Promise<boolean> {
        for (let attempt = 0; attempt < 3; attempt++) {
            const current = await ledger()
            const records = transform(current?.records ?? [])
            if (records === null) return false
            const next: AgentExecutionLedger = { schemaVersion: 1, workspaceId: options.workspaceId,
                revision: (current?.revision ?? -1) + 1, records }
            if (await options.repository.compareAndSet(current, next)) return true
        }
        throw new AgentCommandError('EXECUTION_STORAGE_CONFLICT')
    }
    async function replace(expected: AgentExecutionRecord, next: AgentExecutionRecord): Promise<boolean> {
        return change(records => {
            const existing = records.find(record => record.envelope.requestId === expected.envelope.requestId)
            return canonicalSerialize(existing ?? null) === canonicalSerialize(expected)
                ? records.map(record => record === existing ? next : record) : null
        })
    }
    async function refreshExposure(): Promise<AgentExecutionLedger | null> {
        for (const record of (await ledger())?.records ?? []) {
            if (record.state === 'completed' && record.grant && record.exposureSettledAt === null
                && options.ports.isOutstanding && !await options.ports.isOutstanding(record.grant)) {
                // A delayed Queue cannot age a reservation away before it ever dispatches.
                await replace(record, { ...record, exposureSettledAt: now() })
            }
        }
        return ledger()
    }
    async function publish(record: AgentExecutionRecord): Promise<void> {
        const saved = await options.receipts.get(record.envelope.requestId)
        if (!saved || saved.requestHash !== record.envelope.requestHash || saved.authenticatedClientId !== record.envelope.context.clientId) {
            throw new AgentCommandError('EXECUTION_RECEIPT_CONFLICT')
        }
        if (saved.state === receiptState(record.result) && canonicalSerialize(saved.result) === canonicalSerialize(record.result)) return
        // Legacy accepted records without our durable execution record are never passed here.
        if (saved.state !== 'accepted' && !(saved.state === 'needs-input'
            && (['AGENT_APPROVAL_REQUIRED', 'AGENT_EXECUTION_UNKNOWN'].includes(String(saved.result?.code))
                || (saved.result?.code === 'COMMAND_OUTCOME_UNKNOWN' && record.state === 'completed' && record.grant)))) return
        await options.receipts.finish(saved, { ...saved, state: receiptState(record.result),
            result: record.result, resultDigest: agentResultDigest(record.result) })
    }
    async function planFor(record: AgentExecutionRecord): Promise<GenerationPlan | null> {
        const plan = await options.plans.get(String(record.envelope.command.input.planId))
        return plan?.planHash === record.envelope.command.input.planHash
            && plan.jobs.length === record.imageCount && plan.estimatedAnlas === record.estimatedAnlas ? plan : null
    }
    function planIssue(plan: GenerationPlan, current: AgentExecutionPolicy): string | null {
        if (plan.jobs.length > plan.budget.maxImages || plan.estimatedAnlas > plan.budget.maxAnlas
            || plan.requiredApprovals.length > 0) return 'AGENT_REPLAN_REQUIRED'
        if (plan.jobs.length > current.generation.maxImagesPerRun || plan.estimatedAnlas > current.generation.maxAnlasPerRun) return 'AGENT_RUN_LIMIT'
        if (plan.executionPolicy.maxConcurrency > current.generation.maxConcurrentJobs) return 'AGENT_CONCURRENCY_LIMIT'
        if (plan.jobs.some(job => !current.generation.allowedCompatibilityStatuses.includes(job.compatibility.status as 'captured-pass'))) {
            return 'AGENT_COMPATIBILITY_DENIED'
        }
        // This phase never mutates folder structure or original outputs. R2 requires explicit destination authority.
        if (plan.jobs.some(job => job.destination.collisionPolicy !== 'fail')) return 'AGENT_OUTPUT_DENIED'
        if (plan.jobs.some(job => job.destination.r2 && (!current.r2.allowUpload
            || job.destination.r2.profileId === null || !current.r2.allowedProfileIds.includes(job.destination.r2.profileId)))) return 'AGENT_R2_DENIED'
        return null
    }
    async function eligibility(record: AgentExecutionRecord, current: AgentExecutionPolicy): Promise<{ plan: GenerationPlan | null; code: string | null }> {
        if (Date.parse(record.expiresAt) <= Date.parse(now())) return { plan: null, code: 'REQUEST_EXPIRED' }
        if (current.mode === 'observe') return { plan: null, code: 'AGENT_OBSERVE_ONLY' }
        if (!await options.isClientAuthorized(record.envelope)) return { plan: null, code: 'AUTHENTICATION_FAILED' }
        const plan = await planFor(record)
        if (!plan) return { plan: null, code: 'AGENT_PLAN_CHANGED' }
        const code = planIssue(plan, current)
        if (code) return { plan, code }
        if (!await options.ports.validate(plan)) return { plan, code: 'AGENT_PLAN_STALE' }
        return { plan, code: null }
    }
    async function settle(record: AgentExecutionRecord, result: JsonObject, state: AgentExecutionRecord['state']): Promise<JsonObject> {
        assertAgentPublicValue(result)
        const next = { ...record, state, result }
        if (await replace(record, next)) await publish(next)
        return result
    }
    async function execute(record: AgentExecutionRecord, human: boolean): Promise<JsonObject> {
        const current = policy()
        if (record.policyRevision !== current.revision) {
            const result = approval(current.globalPause ? 'AGENT_GLOBAL_PAUSE' : undefined)
            const refreshed = { ...record, policyRevision: current.revision, result }
            if (await replace(record, refreshed)) await publish(refreshed)
            return result
        }
        const eligible = await eligibility(record, current)
        if (adjustablePolicyIssue(eligible.code)) return settle(record, approval(eligible.code!), 'pending')
        if (eligible.code || !eligible.plan) return settle(record, failure(eligible.code ?? 'AGENT_PLAN_CHANGED'), 'rejected')
        // Human consent cannot bypass the workspace pause; clearing it requires a fresh policy-bound review.
        if (current.globalPause) return settle(record, approval('AGENT_GLOBAL_PAUSE'), 'pending')
        if (!human && current.mode !== 'bounded-auto') return record.result
        const grant: AgentExecutionGrant = Object.freeze({ requestId: record.envelope.requestId, requestHash: record.envelope.requestHash,
            workspaceId: options.workspaceId, clientId: record.envelope.context.clientId,
            actorKind: record.envelope.context.actor.kind,
            planId: eligible.plan.planId, planHash: eligible.plan.planHash, scopeId: agentExecutionScope(record.envelope),
            policyRevision: current.revision, consentedAt: now(), authorization: human ? 'human' : 'bounded-auto',
            estimatedAnlas: record.estimatedAnlas, imageCount: record.imageCount })
        await refreshExposure()
        let budgetCode: string | null = null
        const reserved: AgentExecutionRecord = { ...record, state: 'reserved', grant, result: unknown() }
        const didReserve = await change(records => {
            const saved = records.find(item => item.envelope.requestId === record.envelope.requestId)
            if (canonicalSerialize(saved ?? null) !== canonicalSerialize(record)) return null
            const latest = policy()
            if (canonicalSerialize(latest) !== canonicalSerialize(current)
                || Date.parse(record.expiresAt) <= Date.parse(now()) || (!human && latest.mode !== 'bounded-auto')) {
                budgetCode = 'AGENT_AUTHORITY_CHANGED'; return null
            }
            const consumed = records.filter(item => item.grant !== null)
            const hour = consumed.filter(item => item.exposureSettledAt === null || Date.parse(item.exposureSettledAt) > Date.parse(now()) - 3_600_000)
            const day = consumed.filter(item => item.exposureSettledAt === null || Date.parse(item.exposureSettledAt) > Date.parse(now()) - 86_400_000)
            const sum = (items: readonly AgentExecutionRecord[], key: 'estimatedAnlas' | 'imageCount') => items.reduce((total, item) => total + item[key], 0)
            const active = consumed.filter(item => item.exposureSettledAt === null)
            const limits = latest.rollingLimits
            if (hour.length + 1 > limits.maxRunsPerHour || sum(hour, 'imageCount') + record.imageCount > limits.maxImagesPerHour
                || sum(hour, 'estimatedAnlas') + record.estimatedAnlas > limits.maxAnlasPerHour
                || sum(day, 'estimatedAnlas') + record.estimatedAnlas > limits.maxAnlasPerDay) budgetCode = 'AGENT_ROLLING_LIMIT'
            else if (sum(active, 'imageCount') + Math.min(record.imageCount, eligible.plan!.executionPolicy.maxConcurrency)
                > latest.generation.maxConcurrentJobs) budgetCode = 'AGENT_CONCURRENCY_LIMIT'
            else if (active.filter(item => item.envelope.context.clientId === grant.clientId).length
                + records.filter(item => item !== saved && item.state === 'pending' && item.envelope.context.clientId === grant.clientId
                    && Date.parse(item.expiresAt) > Date.parse(now())).length + 1 > limits.maxOutstandingRequestsPerClient) budgetCode = 'AGENT_OUTSTANDING_LIMIT'
            if (budgetCode) return null
            return records.map(item => item === saved ? reserved : item)
        })
        if (!didReserve) return budgetCode ? settle(record, approval(budgetCode), 'pending') : unknown()
        // Authority can change while IndexedDB is committing. The grant is consumed but no Queue call follows stale consent.
        const stillAuthorized = await options.isClientAuthorized(record.envelope)
        if (!stillAuthorized || canonicalSerialize(policy()) !== canonicalSerialize(current)
            || Date.parse(record.expiresAt) <= Date.parse(now())) return settle(reserved, failure('AGENT_AUTHORITY_CHANGED'), 'rejected')
        let result: JsonObject
        try {
            result = await options.ports.enqueue(eligible.plan, grant)
            assertAgentPublicValue(result)
        } catch { return settle(reserved, unknown(), 'unknown') }
        if (!isAgentExecutionCommitResult(result, grant)) {
            return settle(reserved, unknown(), 'unknown')
        }
        return settle(reserved, result, 'completed')
    }
    const handler: AgentCommandHandler = {
        command: 'generation.enqueue', effect: 'mutation', executionGate: 'durable-approval', validate: validateInput, receiptState,
        execute: async (_input, { envelope }) => {
            const current = policy()
            const plan = await options.plans.get(String(envelope.command.input.planId))
            if (!plan || plan.planHash !== envelope.command.input.planHash || !plan.jobs.length) return failure('AGENT_PLAN_CHANGED')
            if (!envelope.expiresAt) return failure('AGENT_EXPIRY_REQUIRED')
            let record: AgentExecutionRecord = { envelope: structuredClone(envelope), policyRevision: current.revision, originalPolicyRevision: current.revision,
                expiresAt: envelope.expiresAt, estimatedAnlas: plan.estimatedAnlas, imageCount: plan.jobs.length,
                exposureSettledAt: null, state: 'pending', grant: null, result: approval() }
            const checked = await eligibility(record, current)
            if (checked.code && !adjustablePolicyIssue(checked.code)) return failure(checked.code)
            if (checked.code) record = { ...record, result: approval(checked.code) }
            await refreshExposure()
            let limit = false
            let duplicateOperation = false
            let capacity = false
            const created = await change(records => {
                if (records.some(item => item.envelope.requestId === envelope.requestId)) return null
                duplicateOperation = records.some(item => item.envelope.context.clientId === envelope.context.clientId
                    && item.envelope.context.idempotencyKey === envelope.context.idempotencyKey)
                if (duplicateOperation) return null
                // Keep replay history; full local history needs explicit maintenance, never silent deduplication loss.
                capacity = records.length >= 1_000
                if (capacity) return null
                limit = records.filter(item => item.envelope.context.clientId === envelope.context.clientId
                    && ((item.state === 'pending' && Date.parse(item.expiresAt) > Date.parse(now()))
                        || (item.grant && item.exposureSettledAt === null))).length >= current.rollingLimits.maxOutstandingRequestsPerClient
                return limit ? null : [...records, record]
            })
            if (!created) return failure(duplicateOperation ? 'AGENT_IDEMPOTENCY_CONFLICT' : capacity ? 'AGENT_EXECUTION_CAPACITY'
                : limit ? 'AGENT_OUTSTANDING_LIMIT' : 'AGENT_EXECUTION_EXISTS')
            return current.mode === 'bounded-auto' && !checked.code ? execute(record, false) : record.result
        },
    }
    async function decisionRecord(requestId: string, expected: AgentExecutionApprovalBinding): Promise<AgentExecutionRecord | null> {
        const record = (await ledger())?.records.find(item => item.envelope.requestId === requestId)
        if (!record || record.state !== 'pending') return null
        if (record.envelope.requestHash !== expected.requestHash || record.envelope.command.input.planHash !== expected.planHash
            || record.policyRevision !== expected.policyRevision) throw new AgentCommandError('AGENT_APPROVAL_BINDING_CHANGED')
        const receipt = await options.receipts.get(requestId)
        if (receipt?.state !== 'needs-input' || receipt.result?.code !== 'AGENT_APPROVAL_REQUIRED') return null
        return record
    }
    return {
        handler,
        async pending(): Promise<readonly AgentExecutionReview[]> {
            const reviews: AgentExecutionReview[] = []
            for (const stored of (await ledger())?.records ?? []) {
                let record = stored
                if (record.state !== 'pending') continue
                const plan = await planFor(record)
                if (!plan) continue
                const current = policy()
                if (record.policyRevision !== current.revision && current.revision >= record.originalPolicyRevision
                    && Date.parse(record.expiresAt) > Date.parse(now())) {
                    const refreshed = { ...record, policyRevision: current.revision, result: approval(planIssue(plan, current) ?? undefined) }
                    if (!await replace(record, refreshed)) continue
                    record = refreshed
                    await publish(record)
                }
                reviews.push({ requestId: record.envelope.requestId, requestHash: record.envelope.requestHash,
                    clientId: record.envelope.context.clientId, planId: plan.planId, planHash: plan.planHash,
                    policyRevision: record.policyRevision, expiresAt: record.expiresAt,
                    estimatedAnlas: record.estimatedAnlas, imageCount: record.imageCount,
                    compatibilityStatuses: [...new Set(plan.jobs.map(job => job.compatibility.status))],
                    sourceIds: plan.sourceBindings.map(source => source.resourceId),
                    outputEffect: plan.jobs.some(job => job.destination.r2) ? 'local-output-and-r2' : 'local-output',
                    reasons: Date.parse(record.expiresAt) <= Date.parse(now()) ? ['REQUEST_EXPIRED'] : current.globalPause ? ['AGENT_GLOBAL_PAUSE']
                        : [String(planIssue(plan, current) ?? (Array.isArray(record.result.issueCodes) ? record.result.issueCodes[0] : null)
                            ?? 'AGENT_APPROVAL_REQUIRED')] })
            }
            return reviews
        },
        async approve(requestId: string, expected: AgentExecutionApprovalBinding): Promise<JsonObject> {
            const record = await decisionRecord(requestId, expected)
            return record ? execute(record, true) : failure('AGENT_APPROVAL_UNAVAILABLE')
        },
        async reject(requestId: string, expected: AgentExecutionApprovalBinding): Promise<JsonObject> {
            const record = await decisionRecord(requestId, expected)
            return record ? settle(record, failure('AGENT_HUMAN_REJECTED'), 'rejected') : failure('AGENT_APPROVAL_UNAVAILABLE')
        },
        async recover(): Promise<readonly AgentCommandReceipt[]> {
            for (const record of (await ledger())?.records ?? []) {
                if ((record.state === 'reserved' || record.state === 'unknown') && record.grant) {
                    let result: JsonObject | null = null
                    try { result = await options.ports.reconcile(record.grant); if (result) assertAgentPublicValue(result) } catch { result = null }
                    if (result && isAgentExecutionCommitResult(result, record.grant)) {
                        await settle(record, result, 'completed')
                    } else await settle(record, unknown(), 'unknown')
                } else if (record.state === 'pending' && Date.parse(record.expiresAt) <= Date.parse(now())) {
                    await settle(record, failure('REQUEST_EXPIRED'), 'rejected')
                } else await publish(record)
            }
            const receipts: AgentCommandReceipt[] = []
            for (const record of (await refreshExposure())?.records ?? []) {
                const receipt = await options.receipts.get(record.envelope.requestId)
                if (receipt) receipts.push(receipt)
            }
            return receipts
        },
    }
}
export type AgentExecutionCoordinator = ReturnType<typeof createAgentExecutionCoordinator>
