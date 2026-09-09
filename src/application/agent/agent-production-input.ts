import { AgentCommandError } from './agent-command-contract'
import type { AgentCommandInputContract } from './agent-authoring-input'
import type { JsonObject } from '@/domain/composition/types'

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/
const identifier = { type: 'string', pattern: identifierPattern.source }
const integer = (maximum: number, minimum = 0): JsonObject => ({ type: 'integer', minimum, maximum })
const object = (properties: JsonObject): JsonObject => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const revision = integer(Number.MAX_SAFE_INTEGER)
const seedPolicy = { oneOf: [object({ kind: { const: 'random' } }),
    object({ kind: { const: 'fixed' }, seed: integer(0xffff_ffff) }),
    object({ kind: { const: 'increment' }, firstSeed: integer(0xffff_ffff) })] }

function invalid(): never { throw new AgentCommandError('INVALID_COMMAND_INPUT') }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) invalid()
    return value as Record<string, unknown>
}
function id(value: unknown): void { if (typeof value !== 'string' || !identifierPattern.test(value)) invalid() }
function boundedInteger(value: unknown, maximum: number, minimum = 0): void {
    if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) invalid()
}
function contract(schema: JsonObject, validate: (input: JsonObject) => void): AgentCommandInputContract {
    return { schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', ...schema },
        validate: input => { validate(input); return input } }
}

/** Wire validation precedes acceptance; saved-source capture, plan grants and budget admission stay in the application. */
export const agentProductionInputContracts = {
    'production.create': contract(object({
        title: { type: 'string', minLength: 1, maxLength: 100, 'x-maxUtf16Length': 100,
            description: 'Production title, additionally limited to 100 UTF-16 code units by application validation.' },
        source: { oneOf: [object({ kind: { const: 'scene' }, targets: { type: 'array', minItems: 1, maxItems: 100,
            items: object({ presetId: identifier, sceneId: identifier, expectedRevision: revision, count: integer(2400, 1) }),
            description: 'Unique preset/Scene identities. Application validation also limits the sum of counts to 2400.' } }),
        object({ kind: { const: 'preset' }, presetId: identifier, expectedRevision: revision })] },
        seedPolicy,
        budget: object({ maxImages: integer(2400, 1), maxAnlas: { type: 'number', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } }),
    }), input => {
        const value = record(input, ['title', 'source', 'seedPolicy', 'budget'])
        if (typeof value.title !== 'string' || value.title.length < 1 || value.title.length > 100) invalid()
        if (!value.source || typeof value.source !== 'object' || Array.isArray(value.source)) invalid()
        const source = value.source as Record<string, unknown>
        if (source.kind === 'scene') {
            record(source, ['kind', 'targets'])
            if (!Array.isArray(source.targets) || source.targets.length < 1 || source.targets.length > 100) invalid()
            const identities = new Set<string>()
            let total = 0
            for (const item of source.targets) {
                const target = record(item, ['presetId', 'sceneId', 'expectedRevision', 'count'])
                id(target.presetId); id(target.sceneId)
                boundedInteger(target.expectedRevision, Number.MAX_SAFE_INTEGER)
                boundedInteger(target.count, 2400, 1)
                const identity = JSON.stringify([target.presetId, target.sceneId])
                if (identities.has(identity)) invalid()
                identities.add(identity)
                total += Number(target.count)
            }
            if (total > 2400) invalid()
        } else {
            record(source, ['kind', 'presetId', 'expectedRevision'])
            if (source.kind !== 'preset') invalid()
            id(source.presetId)
            boundedInteger(source.expectedRevision, Number.MAX_SAFE_INTEGER)
        }
        if (!value.seedPolicy || typeof value.seedPolicy !== 'object' || Array.isArray(value.seedPolicy)) invalid()
        const seed = value.seedPolicy as Record<string, unknown>
        record(seed, seed.kind === 'random' ? ['kind'] : seed.kind === 'fixed' ? ['kind', 'seed'] : ['kind', 'firstSeed'])
        if (!['random', 'fixed', 'increment'].includes(String(seed.kind))) invalid()
        if (seed.kind !== 'random') boundedInteger(seed.kind === 'fixed' ? seed.seed : seed.firstSeed, 0xffff_ffff)
        const budget = record(value.budget, ['maxImages', 'maxAnlas'])
        boundedInteger(budget.maxImages, 2400, 1)
        if (typeof budget.maxAnlas !== 'number' || !Number.isFinite(budget.maxAnlas)
            || budget.maxAnlas < 0 || budget.maxAnlas > Number.MAX_SAFE_INTEGER) invalid()
    }),
    'production.list': contract(object({}), input => { record(input, []) }),
    'production.get': contract(object({ productionId: identifier }), input => { id(record(input, ['productionId']).productionId) }),
    'production.plan_next': contract(object({ productionId: identifier, expectedRevision: revision }), input => {
        const value = record(input, ['productionId', 'expectedRevision'])
        id(value.productionId)
        boundedInteger(value.expectedRevision, Number.MAX_SAFE_INTEGER)
    }),
}
