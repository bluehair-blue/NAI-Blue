import {
    assertAnlasCostConsentAllows,
} from '@/domain/queue/anlas-cost-consent'
import {
    replayGenerationPlan,
    type PlanGenerationDependencies,
} from './plan-generation'
import type { PlanIssue } from './generation-plan-contract'
import type {
    ActorRef,
    CancelGenerationInput,
    CancelGenerationPort,
    EnqueueGenerationInput,
    EnqueueGenerationPort,
    EnqueueGenerationPortResult,
    EnqueueGenerationResult,
    GenerationCommandFailure,
    GenerationCommandResult,
    RetryGenerationStorageInput,
    RetryGenerationStoragePort,
} from './generation-command-contract'

const MAX_IDENTIFIER_LENGTH = 200

function issue(code: string, fieldPath: string, message: string): PlanIssue {
    return Object.freeze({ code, severity: 'blocking', fieldPath, message })
}

function invalid(...issues: PlanIssue[]): GenerationCommandFailure {
    return Object.freeze({ status: 'invalid', issues: Object.freeze(issues) })
}

function validIdentifier(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= MAX_IDENTIFIER_LENGTH
        && value.trim() === value
}

function actorIssue(actor: ActorRef): PlanIssue | null {
    if (!actor || !['user', 'agent', 'system', 'service'].includes(actor.kind)) {
        return issue('invalid-actor-kind', 'actor.kind', 'A supported actor kind is required.')
    }
    if (!validIdentifier(actor.id)) {
        return issue('invalid-actor-id', 'actor.id', 'Actor ID must contain 1-200 non-padding characters.')
    }
    if (actor.displayName !== undefined
        && (!validIdentifier(actor.displayName))) {
        return issue('invalid-actor-display-name', 'actor.displayName', 'Actor display name must contain 1-200 non-padding characters.')
    }
    return null
}

function sanitizeFailure<TPrepared>(
    result: Exclude<EnqueueGenerationPortResult<TPrepared>, { readonly status: 'ready' }>,
): Exclude<EnqueueGenerationResult<TPrepared>, { readonly status: 'ready' }> {
    if (result.status === 'unsupported') {
        return Object.freeze({
            status: 'unsupported',
            capability: result.capability,
            issues: Object.freeze([...result.issues]),
        })
    }
    if (result.status === 'conflict' && 'source' in result) {
        return Object.freeze({
            status: 'conflict',
            source: structuredClone(result.source),
            currentRevision: result.currentRevision,
            action: result.action,
            ...('mismatch' in result && result.mismatch !== undefined
                ? { mismatch: structuredClone(result.mismatch) }
                : {}),
        })
    }
    if (result.status === 'conflict') {
        return Object.freeze({ status: 'conflict', issues: Object.freeze([...result.issues]) })
    }
    return Object.freeze({ status: 'invalid', issues: Object.freeze([...result.issues]) })
}

/**
 * Replays one immutable reviewed plan, validates explicit consent and identity,
 * then delegates the durable write without exposing adapter payloads or spools.
 */
export async function enqueueGeneration<TPrepared>(
    input: EnqueueGenerationInput<TPrepared>,
    ports: {
        readonly replan: PlanGenerationDependencies<TPrepared>
        readonly enqueue: EnqueueGenerationPort<TPrepared>
    },
): Promise<EnqueueGenerationResult<TPrepared>> {
    const actor = actorIssue(input.actor)
    if (actor !== null) return invalid(actor)
    if (!validIdentifier(input.idempotencyKey)) {
        return invalid(issue(
            'invalid-idempotency-key',
            'idempotencyKey',
            'Idempotency key must contain 1-200 non-padding characters.',
        ))
    }

    const replayed = await replayGenerationPlan(
        input.reviewedPlan,
        input.replanInput,
        ports.replan,
    )
    if (replayed.status !== 'ready') {
        if (replayed.status === 'needs_input') {
            return invalid(issue(
                'generation-plan-needs-input',
                'reviewedPlan.requiredApprovals',
                'The reviewed plan still requires approval input.',
            ))
        }
        return replayed
    }

    try {
        assertAnlasCostConsentAllows(input.costConsent, replayed.plan.estimatedAnlas)
    } catch {
        return invalid(issue(
            'invalid-anlas-cost-consent',
            'costConsent',
            'A valid Anlas consent matching the current reviewed estimate is required.',
        ))
    }
    if (input.costConsent.pricingBasis !== replayed.plan.executionPolicy.pricingBasis
        || input.costConsent.maxAnlas > replayed.plan.budget.maxAnlas) {
        return invalid(issue(
            'cost-consent-plan-mismatch',
            'costConsent',
            'Cost consent must use the reviewed pricing basis and stay within its budget.',
        ))
    }

    const persisted = await ports.enqueue.enqueue({
        plan: replayed.plan,
        costConsent: input.costConsent,
        idempotencyKey: input.idempotencyKey,
        actor: structuredClone(input.actor),
    })
    if (persisted.status !== 'ready') return sanitizeFailure(persisted)
    if (!validIdentifier(persisted.batchId)
        || persisted.jobs.length !== replayed.plan.jobs.length
        || persisted.jobs.some((job, ordinal) => (
            !validIdentifier(job.id) || job.ordinal !== ordinal
        ))
        || new Set(persisted.jobs.map(job => job.id)).size !== persisted.jobs.length) {
        return invalid(issue(
            'invalid-enqueue-result',
            'enqueueResult',
            'The generation adapter returned an invalid batch or ordered job identity.',
        ))
    }
    const jobIds = Object.freeze(persisted.jobs.map(job => job.id))
    return Object.freeze({
        status: 'ready',
        batchId: persisted.batchId,
        runId: persisted.batchId,
        jobIds,
    })
}

function sanitizeCommandResult(result: GenerationCommandResult, targetId: string): GenerationCommandResult {
    if (result.status === 'ready') return Object.freeze({ status: 'ready', targetId })
    if (result.status === 'unsupported') {
        return Object.freeze({
            status: 'unsupported',
            capability: result.capability,
            issues: Object.freeze([...result.issues]),
        })
    }
    return Object.freeze({ status: result.status, issues: Object.freeze([...result.issues]) })
}

/** Requests batch cancellation while carrying actor identity to the runtime boundary. */
export async function cancelGeneration(
    input: CancelGenerationInput,
    port: CancelGenerationPort,
): Promise<GenerationCommandResult> {
    const actor = actorIssue(input.actor)
    if (actor !== null) return invalid(actor)
    if (!validIdentifier(input.batchId)) {
        return invalid(issue('invalid-batch-id', 'batchId', 'Batch ID must contain 1-200 non-padding characters.'))
    }
    if (input.operationId !== undefined
        && (typeof input.operationId !== 'string' || input.operationId.length !== 64 || !/^[a-f0-9]{64}$/.test(input.operationId))) {
        return invalid(issue('invalid-cancel-operation-id', 'operationId', 'Cancellation operation ID must be a lowercase SHA-256 digest.'))
    }
    return sanitizeCommandResult(await port.cancelBatch({
        batchId: input.batchId,
        actor: structuredClone(input.actor),
        ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    }), input.batchId)
}

/** Retries storage only; the injected port must never redispatch the Provider. */
export async function retryGenerationStorage(
    input: RetryGenerationStorageInput,
    port: RetryGenerationStoragePort,
): Promise<GenerationCommandResult> {
    const actor = actorIssue(input.actor)
    if (actor !== null) return invalid(actor)
    if (!validIdentifier(input.jobId)) {
        return invalid(issue('invalid-job-id', 'jobId', 'Job ID must contain 1-200 non-padding characters.'))
    }
    return sanitizeCommandResult(await port.retryStorage({
        jobId: input.jobId,
        actor: structuredClone(input.actor),
    }), input.jobId)
}
