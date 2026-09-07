import type { JsonObject } from '@/domain/composition/types'
import { AgentCommandError, type AgentCommandName } from './agent-command-contract'

export interface AgentCommandInputContract {
    readonly schema: JsonObject
    readonly validate: (input: JsonObject) => JsonObject
}

const dialect = 'https://json-schema.org/draft/2020-12/schema'
const identifier = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$' }
const digest = { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }
const integer = (maximum: number, minimum = 0): JsonObject => ({ type: 'integer', minimum, maximum })
const object = (properties: JsonObject): JsonObject => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) {
        throw new AgentCommandError('INVALID_COMMAND_INPUT')
    }
    return value as Record<string, unknown>
}

/** Existing application validators remain admission authority; schema is transport metadata. */
function validatePlanInput(value: JsonObject): JsonObject {
    const input = record(value, ['source', 'count', 'seedPolicy', 'budget'])
    const source = record(input.source, ['kind', 'draftId', 'expectedRevision'])
    if (source.kind !== 'workflow-draft' || typeof source.draftId !== 'string'
        || source.draftId.trim() !== source.draftId || source.draftId.length === 0 || source.draftId.length > 200
        || !Number.isSafeInteger(source.expectedRevision) || Number(source.expectedRevision) < 0
        || !Number.isSafeInteger(input.count) || Number(input.count) < 1 || Number(input.count) > 100) {
        throw new AgentCommandError('INVALID_COMMAND_INPUT')
    }
    if (typeof input.seedPolicy !== 'object' || input.seedPolicy === null || Array.isArray(input.seedPolicy)) {
        throw new AgentCommandError('INVALID_COMMAND_INPUT')
    }
    const seedKind = (input.seedPolicy as Record<string, unknown>).kind
    const seed = record(input.seedPolicy, seedKind === 'random' ? ['kind']
        : seedKind === 'fixed' ? ['kind', 'seed'] : ['kind', 'firstSeed'])
    if (!['random', 'fixed', 'increment'].includes(seed.kind as string)) throw new AgentCommandError('INVALID_COMMAND_INPUT')
    const seedValue = seed.kind === 'fixed' ? seed.seed : seed.firstSeed
    if (seed.kind !== 'random' && (!Number.isSafeInteger(seedValue) || Number(seedValue) < 0
        || Number(seedValue) > 0xffff_ffff)) throw new AgentCommandError('INVALID_COMMAND_INPUT')
    const budget = record(input.budget, ['maxImages', 'maxAnlas'])
    if (!Number.isSafeInteger(budget.maxImages) || Number(budget.maxImages) < 0 || Number(budget.maxImages) > 100
        || typeof budget.maxAnlas !== 'number' || !Number.isFinite(budget.maxAnlas) || budget.maxAnlas < 0) {
        throw new AgentCommandError('INVALID_COMMAND_INPUT')
    }
    return value
}

function referenceContract(properties: JsonObject, pattern: RegExp): AgentCommandInputContract {
    const keys = Object.keys(properties)
    return { schema: { $schema: dialect, ...object(properties) }, validate: input => {
        const value = record(input, keys)
        if (keys.some(key => typeof value[key] !== 'string' || !pattern.test(value[key] as string))) {
            throw new AgentCommandError('INVALID_COMMAND_INPUT')
        }
        return input
    } }
}

const empty: AgentCommandInputContract = { schema: { $schema: dialect, ...object({}) }, validate: input => {
    record(input, [])
    return input
} }
const run = referenceContract({ runId: identifier }, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/)
const contracts: Partial<Record<AgentCommandName, AgentCommandInputContract>> = {
    'system.describe_capabilities': empty,
    'workspace.get_snapshot': empty,
    'generation.get_run': run,
    'generation.cancel': run,
    'generation.retry_storage': referenceContract({ jobId: identifier, runId: identifier }, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/),
    'generation.enqueue': referenceContract({ planId: digest, planHash: digest }, /^sha256:[a-f0-9]{64}$/),
    'generation.plan': {
        validate: validatePlanInput,
        schema: { $schema: dialect, ...object({
            source: object({ kind: { const: 'workflow-draft' },
                draftId: { type: 'string', minLength: 1, maxLength: 200, pattern: '^\\S(?:[\\s\\S]*\\S)?(?![\\s\\S])',
                    description: 'Existing workflow draft ID. Application additionally limits the ID to 200 UTF-16 code units.',
                    'x-maxUtf16Length': 200 },
                expectedRevision: integer(Number.MAX_SAFE_INTEGER) }),
            count: integer(100, 1),
            seedPolicy: { oneOf: [object({ kind: { const: 'random' } }),
                object({ kind: { const: 'fixed' }, seed: integer(0xffff_ffff) }),
                object({ kind: { const: 'increment' }, firstSeed: integer(0xffff_ffff) })] },
            budget: object({ maxImages: integer(100), maxAnlas: { type: 'number', minimum: 0, maximum: Number.MAX_VALUE } }),
        }) },
    },
}

/** Only implemented input contracts exist here; runtime registration still decides availability. */
export function getAgentCommandInputContract(name: AgentCommandName): AgentCommandInputContract | undefined {
    const contract = contracts[name]
    return contract && { validate: contract.validate, schema: structuredClone(contract.schema) }
}
