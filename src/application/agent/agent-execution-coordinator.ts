import { assertAgentAuthoringTarget, isAgentAuthoringResult, type AgentAuthoringCommand, type AgentAuthoringPort } from './agent-authoring-contract'
import { isAgentAuthoringRecord, type AgentAuthoringRecord } from './agent-execution-repository'
import { canonicalSerialize } from '@/domain/composition/canonical-serialize'
import type { JsonObject, JsonValue } from '@/domain/composition/types'
import type { GenerationPlan, Sha256Digest } from '@/application/generation/generation-plan-contract'
import type { GenerationPlanRepository } from '@/application/generation/generation-plan-repository'
import { AgentCommandError, assertAgentPublicValue, type AgentCommandEnvelope } from './agent-command-contract'
import { agentResultDigest, type AgentCommandReceipt, type CommandReceiptRepository } from './command-receipt-repository'
import { effectiveAgentExecutionPolicy, normalizeAgentExecutionPolicy, type AgentExecutionPolicy } from './agent-execution-policy'
import { agentExecutionScope, isAgentExecutionCommitResult, isAgentCancellationRecord, isAgentStorageRetryRecord, isAgentGenerationRecord, type AgentExecutionGrant, type AgentExecutionLedger, type AgentExecutionRecord, type AgentGenerationExecutionRecord, type AgentQueueRepairRecord, type AgentExecutionRepository } from './agent-execution-repository'
import { assertAgentCancellationTarget, isAgentCancellationResult, sameAgentCancellationTarget, type AgentCancellationPorts } from './agent-cancellation-contract'
import { assertAgentStorageRetryTarget, isAgentStorageRetryResult, sameAgentStorageRetryTarget, type AgentStorageRetryPorts } from './agent-storage-retry-contract'
import type { AgentCommandHandler } from './runtime-capability-registry'
import { getAgentCommandInputContract } from './agent-command-input'

export interface AgentGenerationApprovalBinding {
    readonly requestHash: Sha256Digest
    readonly planHash: Sha256Digest
    readonly policyRevision: number
}
export interface AgentGenerationExecutionReview extends AgentGenerationApprovalBinding {
    readonly command?: 'generation.enqueue'
    readonly requestId: string
    readonly clientId: string
    readonly planId: Sha256Digest
    readonly expiresAt: string
    readonly estimatedAnlas: number
    readonly imageCount: number
    readonly previewJobs: readonly {
        readonly ordinal: number
        readonly prompt: string
        readonly negativePrompt: string
        readonly model: string
        readonly width: number
        readonly height: number
        readonly steps: number
        readonly seed: number
        readonly generationParameters: JsonValue
    }[]
    readonly compatibilityStatuses: readonly string[]
    readonly sourceIds: readonly string[]
    readonly outputEffect: 'local-output' | 'local-output-and-r2'
    readonly reasons: readonly string[]
}
export interface AgentCancellationApprovalBinding {
    readonly requestHash: Sha256Digest
    readonly runId: string
    readonly targetHash: Sha256Digest
    readonly policyRevision: number
}
export interface AgentCancellationReview extends AgentCancellationApprovalBinding {
    readonly command: 'generation.cancel'
    readonly requestId: string
    readonly clientId: string
    readonly expiresAt: string
    readonly jobIds: readonly string[]
    readonly jobCount: number
    readonly reasons: readonly string[]
}
export interface AgentStorageRetryApprovalBinding extends AgentCancellationApprovalBinding {
    readonly jobId: string
}
export interface AgentStorageRetryReview extends AgentStorageRetryApprovalBinding {
    readonly command: 'generation.retry_storage'
    readonly requestId: string
    readonly clientId: string
    readonly expiresAt: string
    readonly artifactId: string
    readonly reasons: readonly string[]
}
export interface AgentAuthoringApprovalBinding {
    readonly requestHash: Sha256Digest
    readonly targetHash: Sha256Digest
    readonly resourceId: string
    readonly policyRevision: number
}
export interface AgentAuthoringReview extends AgentAuthoringApprovalBinding {
    readonly input: JsonObject
    readonly command: AgentAuthoringCommand
    readonly requestId: string
    readonly clientId: string
    readonly expiresAt: string
    readonly changeCount: number
    readonly createsFolders: boolean
    readonly renamesPathSegments: boolean
    readonly reasons: readonly string[]
}
export type AgentExecutionApprovalBinding = AgentAuthoringApprovalBinding | AgentGenerationApprovalBinding | AgentCancellationApprovalBinding | AgentStorageRetryApprovalBinding
export type AgentExecutionReview = AgentAuthoringReview | AgentGenerationExecutionReview | AgentCancellationReview | AgentStorageRetryReview
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
    readonly cancellation?: AgentCancellationPorts
    readonly storageRetry?: AgentStorageRetryPorts
    readonly authoring?: AgentAuthoringPort
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
    && ['AGENT_COMPATIBILITY_DENIED', 'AGENT_R2_DENIED'].includes(code)

function receiptState(result: JsonObject): 'completed' | 'needs-input' | 'rejected' {
    return result.code === 'AGENT_APPROVAL_REQUIRED' || result.code === 'AGENT_EXECUTION_UNKNOWN' ? 'needs-input'
        : ['ready', 'cancel-requested', 'storage-registered', 'authoring-committed'].includes(String(result.status)) ? 'completed' : 'rejected'
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
            if (isAgentGenerationRecord(record) && record.state === 'completed' && record.grant && record.exposureSettledAt === null
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
    async function planFor(record: AgentGenerationExecutionRecord): Promise<GenerationPlan | null> {
        const plan = await options.plans.get(String(record.envelope.command.input.planId))
        return plan?.planHash === record.envelope.command.input.planHash
            && plan.jobs.length === record.imageCount && plan.estimatedAnlas === record.estimatedAnlas ? plan : null
    }
    function planIssue(plan: GenerationPlan, current: AgentExecutionPolicy): string | null {
        if (plan.jobs.length > plan.budget.maxImages || plan.estimatedAnlas > plan.budget.maxAnlas
            || plan.requiredApprovals.length > 0) return 'AGENT_REPLAN_REQUIRED'
        if (plan.jobs.some(job => !current.generation.allowedCompatibilityStatuses.includes(job.compatibility.status as 'captured-pass'))) {
            return 'AGENT_COMPATIBILITY_DENIED'
        }
        // This phase never mutates folder structure or original outputs. R2 requires explicit destination authority.
        if (plan.jobs.some(job => job.destination.collisionPolicy !== 'fail')) return 'AGENT_OUTPUT_DENIED'
        if (plan.jobs.some(job => job.destination.r2 && (!current.r2.allowUpload
            || job.destination.r2.profileId === null || !current.r2.allowedProfileIds.includes(job.destination.r2.profileId)))) return 'AGENT_R2_DENIED'
        return null
    }
    async function eligibility(record: AgentGenerationExecutionRecord, current: AgentExecutionPolicy): Promise<{ plan: GenerationPlan | null; code: string | null }> {
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
    /** Every supported mutation shares operation identity and durable history capacity. */
    async function storePending(record: AgentExecutionRecord): Promise<string | null> {
        const envelope = record.envelope
        let code = 'AGENT_EXECUTION_EXISTS'
        const created = await change(records => {
            if (records.some(item => item.envelope.requestId === envelope.requestId)) return null
            if (records.some(item => item.envelope.context.clientId === envelope.context.clientId
                && item.envelope.context.idempotencyKey === envelope.context.idempotencyKey)) {
                code = 'AGENT_IDEMPOTENCY_CONFLICT'; return null
            }
            // Keep replay history; full local history requires explicit maintenance.
            if (records.length >= 1_000) { code = 'AGENT_EXECUTION_CAPACITY'; return null }
            return [...records, record]
        })
        return created ? null : code
    }

    function queueRepairResult(record: AgentQueueRepairRecord, result: unknown): JsonObject | null {
        if (!record.grant) return null
        if (record.command === 'generation.cancel') {
            return isAgentCancellationResult(result, record.grant) ? { ...result, jobIds: [...result.jobIds] } : null
        }
        return isAgentStorageRetryResult(result, record.grant) ? { ...result } : null
    }
    /** Both explicit human Queue operations reserve before mutation; neither consumes or refunds generation authority. */
    async function executeQueueRepair(record: AgentQueueRepairRecord): Promise<JsonObject> {
        const current = policy()
        if (record.policyRevision !== current.revision) {
            const refreshed = { ...record, policyRevision: current.revision, result: approval() }
            if (await replace(record, refreshed)) await publish(refreshed)
            return refreshed.result
        }
        if (current.mode === 'observe') return settle(record, failure('AGENT_OBSERVE_ONLY'), 'rejected')
        if (Date.parse(record.expiresAt) <= Date.parse(now())) return settle(record, failure('REQUEST_EXPIRED'), 'rejected')
        if (!await options.isClientAuthorized(record.envelope)) return settle(record, failure('AUTHENTICATION_FAILED'), 'rejected')
        const authority = { requestId: record.envelope.requestId, requestHash: record.envelope.requestHash,
            workspaceId: options.workspaceId, clientId: record.envelope.context.clientId, actorKind: record.envelope.context.actor.kind,
            policyRevision: current.revision, expiresAt: record.expiresAt, authorization: 'human' as const }
        let reserved: AgentQueueRepairRecord
        if (record.command === 'generation.cancel') {
            const target = await options.cancellation?.inspect(record.target.runId)
            if (target) assertAgentCancellationTarget(target)
            if (!target || !sameAgentCancellationTarget(record.target, target)) return settle(record, failure('AGENT_CANCEL_TARGET_CHANGED'), 'rejected')
            const grant = { ...authority, consentedAt: now(), target: structuredClone(target) }
            reserved = { ...record, target: grant.target, grant, state: 'reserved', result: unknown() }
        } else {
            const target = await options.storageRetry?.inspect({ runId: record.target.runId, jobId: record.target.jobId })
            if (target) assertAgentStorageRetryTarget(target)
            if (!target || !sameAgentStorageRetryTarget(record.target, target)) return settle(record, failure('AGENT_STORAGE_TARGET_CHANGED'), 'rejected')
            const grant = { ...authority, consentedAt: now(), target: structuredClone(target) }
            reserved = { ...record, target: grant.target, grant, state: 'reserved', result: unknown() }
        }
        // Global pause blocks new generation; approved stopping and files-committed registration may continue locally.
        const didReserve = await change(records => {
            const saved = records.find(item => item.envelope.requestId === record.envelope.requestId)
            if (canonicalSerialize(saved ?? null) !== canonicalSerialize(record)
                || canonicalSerialize(policy()) !== canonicalSerialize(current) || Date.parse(record.expiresAt) <= Date.parse(now())) return null
            return records.map(item => item === saved ? reserved : item)
        })
        if (!didReserve) return unknown()
        const authorized = await options.isClientAuthorized(record.envelope)
        if (!authorized || canonicalSerialize(policy()) !== canonicalSerialize(current) || Date.parse(record.expiresAt) <= Date.parse(now())) {
            return settle(reserved, failure('AGENT_AUTHORITY_CHANGED'), 'rejected')
        }
        let result: unknown
        try {
            result = reserved.command === 'generation.cancel'
                ? await options.cancellation!.cancel(structuredClone(reserved.target), structuredClone(reserved.grant!))
                : await options.storageRetry!.retry(structuredClone(reserved.target), structuredClone(reserved.grant!))
            assertAgentPublicValue(result)
        } catch { return settle(reserved, unknown(), 'unknown') }
        const completed = queueRepairResult(reserved, result)
        return completed ? settle(reserved, completed, 'completed') : settle(reserved, unknown(), 'unknown')
    }
    async function execute(record: AgentGenerationExecutionRecord, human: boolean): Promise<JsonObject> {
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
        let authorityCode: string | null = null
        const reserved: AgentGenerationExecutionRecord = { ...record, state: 'reserved', grant, result: unknown() }
        const didReserve = await change(records => {
            const saved = records.find(item => item.envelope.requestId === record.envelope.requestId)
            if (canonicalSerialize(saved ?? null) !== canonicalSerialize(record)) return null
            const latest = policy()
            if (canonicalSerialize(latest) !== canonicalSerialize(current)
                || Date.parse(record.expiresAt) <= Date.parse(now()) || (!human && latest.mode !== 'bounded-auto')) {
                authorityCode = 'AGENT_AUTHORITY_CHANGED'; return null
            }
            // Queue scheduling owns parallelism and pacing; the reviewed plan owns
            // its budget. Admission only reserves this exact authorized operation.
            return records.map(item => item === saved ? reserved : item)
        })
        if (!didReserve) return authorityCode ? settle(record, approval(authorityCode), 'pending') : unknown()
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
        command: 'generation.enqueue', effect: 'mutation', executionGate: 'durable-approval', validate: getAgentCommandInputContract('generation.enqueue')!.validate, receiptState,
        execute: async (_input, { envelope }) => {
            const current = policy()
            const plan = await options.plans.get(String(envelope.command.input.planId))
            if (!plan || plan.planHash !== envelope.command.input.planHash || !plan.jobs.length) return failure('AGENT_PLAN_CHANGED')
            if (!envelope.expiresAt) return failure('AGENT_EXPIRY_REQUIRED')
            let record: AgentGenerationExecutionRecord = { envelope: structuredClone(envelope), policyRevision: current.revision, originalPolicyRevision: current.revision,
                expiresAt: envelope.expiresAt, estimatedAnlas: plan.estimatedAnlas, imageCount: plan.jobs.length,
                exposureSettledAt: null, state: 'pending', grant: null, result: approval() }
            const checked = await eligibility(record, current)
            if (checked.code && !adjustablePolicyIssue(checked.code)) return failure(checked.code)
            if (checked.code) record = { ...record, result: approval(checked.code) }
            await refreshExposure()
            const createIssue = await storePending(record)
            if (createIssue) return failure(createIssue)
            return current.mode === 'bounded-auto' && !checked.code ? execute(record, false) : record.result
        },
    }
    /** Only these two concrete Queue actions share admission; future commands remain unregistered. */
    const queueRepairHandler = (command: AgentQueueRepairRecord['command']): AgentCommandHandler => ({
        command, effect: 'mutation', executionGate: 'durable-approval', receiptState,
        validate: getAgentCommandInputContract(command)!.validate,
        execute: async (_input, { envelope }) => {
            const current = policy()
            if (current.mode === 'observe') return failure('AGENT_OBSERVE_ONLY')
            if (!envelope.expiresAt) return failure('AGENT_EXPIRY_REQUIRED')
            if (Date.parse(envelope.expiresAt) <= Date.parse(now())) return failure('REQUEST_EXPIRED')
            if (!await options.isClientAuthorized(envelope)) return failure('AUTHENTICATION_FAILED')
            const authority = { envelope: structuredClone(envelope),
                originalPolicyRevision: current.revision, policyRevision: current.revision, expiresAt: envelope.expiresAt,
                state: 'pending' as const, grant: null, result: approval() }
            let record: AgentQueueRepairRecord
            if (command === 'generation.cancel') {
                const target = await options.cancellation!.inspect(String(envelope.command.input.runId))
                if (!target) return failure('AGENT_CANCEL_TARGET_UNAVAILABLE')
                assertAgentCancellationTarget(target)
                if (target.runId !== envelope.command.input.runId) return failure('AGENT_CANCEL_TARGET_CHANGED')
                record = { ...authority, command, target: structuredClone(target) }
            } else {
                const input = { runId: String(envelope.command.input.runId), jobId: String(envelope.command.input.jobId) }
                const target = await options.storageRetry!.inspect(input)
                if (!target) return failure('AGENT_STORAGE_TARGET_UNAVAILABLE')
                assertAgentStorageRetryTarget(target)
                if (target.runId !== input.runId || target.jobId !== input.jobId) return failure('AGENT_STORAGE_TARGET_CHANGED')
                record = { ...authority, command, target: structuredClone(target) }
            }
            const createIssue = await storePending(record)
            // Bounded automatic generation is never consent for these local human actions.
            return createIssue ? failure(createIssue) : record.result
        },
    })
    function authoringIssue(record: AgentAuthoringRecord, current: AgentExecutionPolicy, human: boolean): string | null {
        if (current.mode === 'observe') return 'AGENT_OBSERVE_ONLY'
        if (current.globalPause) return 'AGENT_GLOBAL_PAUSE'
        if (!human && current.mode !== 'bounded-auto') return 'AGENT_APPROVAL_REQUIRED'
        if (!human && record.command === 'scene.patch_many' && !current.authoring.allowSceneChanges) return 'AGENT_SCENE_AUTHORING_DENIED'
        if (record.target.createsFolders && !current.output.allowCreateFolders) return 'AGENT_FOLDER_CREATE_DENIED'
        if (record.target.renamesPathSegments && !current.output.allowRenamePathSegments) return 'AGENT_FOLDER_RENAME_DENIED'
        return null
    }
    async function executeAuthoring(record: AgentAuthoringRecord, human: boolean): Promise<JsonObject> {
        const current = policy()
        if (current.revision !== record.policyRevision) {
            const refreshed = { ...record, policyRevision: current.revision, result: approval() }
            if (await replace(record, refreshed)) await publish(refreshed)
            return refreshed.result
        }
        const issue = authoringIssue(record, current, human)
        if (issue) return settle(record, approval(issue), 'pending')
        if (Date.parse(record.expiresAt) <= Date.parse(now())) return settle(record, failure('REQUEST_EXPIRED'), 'rejected')
        if (!await options.isClientAuthorized(record.envelope)) return settle(record, failure('AUTHENTICATION_FAILED'), 'rejected')
        const target = await options.authoring!.inspect(record.command, structuredClone(record.envelope.command.input))
        if (target) assertAgentAuthoringTarget(target)
        if (!target || canonicalSerialize(target) !== canonicalSerialize(record.target)) return settle(record, failure('AGENT_AUTHORING_TARGET_CHANGED'), 'rejected')
        const grant = { requestId: record.envelope.requestId, requestHash: record.envelope.requestHash,
            workspaceId: options.workspaceId, clientId: record.envelope.context.clientId, actorKind: record.envelope.context.actor.kind,
            policyRevision: current.revision, expiresAt: record.expiresAt, consentedAt: now(),
            authorization: human ? 'human' as const : 'bounded-auto' as const, target: structuredClone(target) }
        const reserved: AgentAuthoringRecord = { ...record, grant, state: 'reserved', result: unknown() }
        const didReserve = await change(records => {
            const saved = records.find(item => item.envelope.requestId === record.envelope.requestId)
            if (canonicalSerialize(saved ?? null) !== canonicalSerialize(record)
                || canonicalSerialize(policy()) !== canonicalSerialize(current) || Date.parse(record.expiresAt) <= Date.parse(now())) return null
            return records.map(item => item === saved ? reserved : item)
        })
        if (!didReserve) return unknown()
        if (!await options.isClientAuthorized(record.envelope) || canonicalSerialize(policy()) !== canonicalSerialize(current)
            || Date.parse(record.expiresAt) <= Date.parse(now())) return settle(reserved, failure('AGENT_AUTHORITY_CHANGED'), 'rejected')
        let result: JsonObject
        try {
            result = await options.authoring!.apply(record.command, structuredClone(record.envelope.command.input), structuredClone(target), structuredClone(grant))
            assertAgentPublicValue(result)
        } catch { return settle(reserved, unknown(), 'unknown') }
        return isAgentAuthoringResult(result, grant) ? settle(reserved, result, 'completed') : settle(reserved, unknown(), 'unknown')
    }
    const authoringHandlers: AgentCommandHandler[] = options.authoring ? (['scene.patch_many', 'folder.apply_changes'] as const).map(command => ({
        command, effect: 'mutation', executionGate: 'durable-approval', receiptState,
        validate: getAgentCommandInputContract(command)!.validate,
        execute: async (_input, { envelope }) => {
            const current = policy()
            if (!envelope.expiresAt) return failure('AGENT_EXPIRY_REQUIRED')
            if (Date.parse(envelope.expiresAt) <= Date.parse(now())) return failure('REQUEST_EXPIRED')
            if (current.mode === 'observe') return failure('AGENT_OBSERVE_ONLY')
            if (!await options.isClientAuthorized(envelope)) return failure('AUTHENTICATION_FAILED')
            const target = await options.authoring!.inspect(command, structuredClone(envelope.command.input))
            if (!target) return failure('AGENT_AUTHORING_TARGET_UNAVAILABLE')
            assertAgentAuthoringTarget(target)
            if (target.command !== command || target.expectedRevision !== envelope.command.input.expectedRevision
                || target.changeCount !== (envelope.command.input.changes as unknown[]).length
                || (command === 'scene.patch_many' && target.resourceId !== envelope.command.input.presetId)) return failure('AGENT_AUTHORING_TARGET_CHANGED')
            const record: AgentAuthoringRecord = { command, envelope: structuredClone(envelope), target: structuredClone(target),
                originalPolicyRevision: current.revision, policyRevision: current.revision, expiresAt: envelope.expiresAt,
                state: 'pending', grant: null, result: approval() }
            const createIssue = await storePending(record)
            if (createIssue) return failure(createIssue)
            return current.mode === 'bounded-auto' && !authoringIssue(record, current, false) ? executeAuthoring(record, false) : record.result
        },
    })) : []
    const cancelHandler = options.cancellation ? queueRepairHandler('generation.cancel') : undefined
    const storageRetryHandler = options.storageRetry ? queueRepairHandler('generation.retry_storage') : undefined
    async function decisionRecord(requestId: string, expected: AgentExecutionApprovalBinding): Promise<AgentExecutionRecord | null> {
        const record = (await ledger())?.records.find(item => item.envelope.requestId === requestId)
        if (!record || record.state !== 'pending') return null
        const targetMatches = isAgentAuthoringRecord(record)
            ? 'resourceId' in expected && expected.resourceId === record.target.resourceId && expected.targetHash === record.target.targetHash
            : isAgentCancellationRecord(record)
            ? 'runId' in expected && expected.runId === record.target.runId && expected.targetHash === record.target.targetHash
            : isAgentStorageRetryRecord(record)
                ? 'jobId' in expected && expected.runId === record.target.runId && expected.jobId === record.target.jobId && expected.targetHash === record.target.targetHash
                : 'planHash' in expected && record.envelope.command.input.planHash === expected.planHash
        if (record.envelope.requestHash !== expected.requestHash || !targetMatches
            || record.policyRevision !== expected.policyRevision) throw new AgentCommandError('AGENT_APPROVAL_BINDING_CHANGED')
        const receipt = await options.receipts.get(requestId)
        if (receipt?.state !== 'needs-input' || receipt.result?.code !== 'AGENT_APPROVAL_REQUIRED') return null
        return record
    }
    return {
        handler, cancelHandler, storageRetryHandler, authoringHandlers,
        async pending(): Promise<readonly AgentExecutionReview[]> {
            const reviews: AgentExecutionReview[] = []
            for (const stored of (await ledger())?.records ?? []) {
                if (isAgentAuthoringRecord(stored)) {
                    if (stored.state !== 'pending') continue
                    let record = stored
                    const current = policy()
                    if (record.policyRevision !== current.revision && current.revision >= record.originalPolicyRevision
                        && Date.parse(record.expiresAt) > Date.parse(now())) {
                        const refreshed = { ...record, policyRevision: current.revision, result: approval() }
                        if (!await replace(record, refreshed)) continue
                        record = refreshed
                        await publish(record)
                    }
                    reviews.push({ input: structuredClone(record.envelope.command.input), command: record.command, requestId: record.envelope.requestId, requestHash: record.envelope.requestHash,
                        clientId: record.envelope.context.clientId, policyRevision: record.policyRevision, expiresAt: record.expiresAt,
                        resourceId: record.target.resourceId, targetHash: record.target.targetHash, changeCount: record.target.changeCount,
                        createsFolders: record.target.createsFolders, renamesPathSegments: record.target.renamesPathSegments,
                        reasons: [Date.parse(record.expiresAt) <= Date.parse(now()) ? 'REQUEST_EXPIRED' : authoringIssue(record, current, true) ?? 'AGENT_APPROVAL_REQUIRED'] })
                    continue
                }
                if (!isAgentGenerationRecord(stored)) {
                    if (stored.state !== 'pending') continue
                    let record = stored
                    const current = policy()
                    if (record.policyRevision !== current.revision && current.revision >= record.originalPolicyRevision
                        && Date.parse(record.expiresAt) > Date.parse(now())) {
                        const refreshed = { ...record, policyRevision: current.revision, result: approval() }
                        if (!await replace(record, refreshed)) continue
                        record = refreshed
                        await publish(record)
                    }
                    const common = { requestId: record.envelope.requestId, requestHash: record.envelope.requestHash,
                        clientId: record.envelope.context.clientId, policyRevision: record.policyRevision, expiresAt: record.expiresAt,
                        runId: record.target.runId, targetHash: record.target.targetHash,
                        reasons: Date.parse(record.expiresAt) <= Date.parse(now()) ? ['REQUEST_EXPIRED']
                            : current.mode === 'observe' ? ['AGENT_OBSERVE_ONLY'] : ['AGENT_APPROVAL_REQUIRED'] }
                    reviews.push(record.command === 'generation.cancel'
                        ? { ...common, command: record.command, jobIds: [...record.target.jobIds], jobCount: record.target.jobIds.length }
                        : { ...common, command: record.command, jobId: record.target.jobId, artifactId: record.target.artifactId })
                    continue
                }
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
                    previewJobs: plan.jobs.map(job => ({ ordinal: job.ordinal, prompt: job.semantic.prompt,
                        negativePrompt: job.semantic.negativePrompt, model: job.semantic.model, width: job.semantic.width,
                        height: job.semantic.height, steps: job.semantic.steps, seed: job.semantic.seed,
                        generationParameters: structuredClone(job.semantic.generationParameters) })),
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
            return record ? isAgentAuthoringRecord(record) ? executeAuthoring(record, true)
                : isAgentGenerationRecord(record) ? execute(record, true) : executeQueueRepair(record) : failure('AGENT_APPROVAL_UNAVAILABLE')
        },
        async reject(requestId: string, expected: AgentExecutionApprovalBinding): Promise<JsonObject> {
            const record = await decisionRecord(requestId, expected)
            return record ? settle(record, failure('AGENT_HUMAN_REJECTED'), 'rejected') : failure('AGENT_APPROVAL_UNAVAILABLE')
        },
        async recover(): Promise<readonly AgentCommandReceipt[]> {
            for (const record of (await ledger())?.records ?? []) {
                if (isAgentAuthoringRecord(record)) {
                    if ((record.state === 'reserved' || record.state === 'unknown') && record.grant) {
                        let result: JsonObject | null = null
                        try { result = await options.authoring?.reconcile(structuredClone(record.grant), structuredClone(record.envelope.command.input)) ?? null; if (result) assertAgentPublicValue(result) } catch { result = null }
                        await settle(record, result && isAgentAuthoringResult(result, record.grant) ? result : unknown(),
                            result && isAgentAuthoringResult(result, record.grant) ? 'completed' : 'unknown')
                    } else if (record.state === 'pending' && Date.parse(record.expiresAt) <= Date.parse(now())) {
                        await settle(record, failure('REQUEST_EXPIRED'), 'rejected')
                    } else await publish(record)
                    continue
                }
                if (!isAgentGenerationRecord(record) && (record.state === 'reserved' || record.state === 'unknown') && record.grant) {
                    let result: unknown = null
                    try {
                        result = record.command === 'generation.cancel'
                            ? await options.cancellation?.reconcile(structuredClone(record.grant))
                            : await options.storageRetry?.reconcile(structuredClone(record.grant))
                        if (result) assertAgentPublicValue(result)
                    } catch { result = null }
                    const completed = queueRepairResult(record, result)
                    if (completed) await settle(record, completed, 'completed')
                    else await settle(record, unknown(), 'unknown')
                    continue
                }
                if (isAgentGenerationRecord(record) && (record.state === 'reserved' || record.state === 'unknown') && record.grant) {
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
