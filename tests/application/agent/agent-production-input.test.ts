import { describe, expect, it } from 'vitest'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv'
import { getAgentCommandInputContract } from '@/application/agent/agent-command-input'
import type { JsonObject } from '@/domain/composition/types'

const target = { presetId: 'preset-1', sceneId: 'scene-1', expectedRevision: 0, count: 2400 }
const create = (): JsonObject => ({ title: 'Production', source: { kind: 'scene', targets: [{ ...target }] },
    seedPolicy: { kind: 'random' }, budget: { maxImages: 2400, maxAnlas: 1.25 } })

describe('production input boundary', () => {
    it('matches supported creation boundaries against official SDK schema validation', () => {
        const contract = getAgentCommandInputContract('production.create')!
        const schema = new AjvJsonSchemaValidator().getValidator(contract.schema)
        const valid = [create(), { ...create(), title: 'a'.repeat(100),
            source: { kind: 'preset', presetId: 'preset-1', expectedRevision: Number.MAX_SAFE_INTEGER } },
        { ...create(), seedPolicy: { kind: 'fixed', seed: 0 }, budget: { maxImages: 1, maxAnlas: 0 } },
        { ...create(), seedPolicy: { kind: 'increment', firstSeed: 0xffff_ffff }, budget: { maxImages: 2400, maxAnlas: Number.MAX_SAFE_INTEGER } }]
        const invalid = [null, [], 1, {}, { ...create(), title: '' }, { ...create(), title: 'a'.repeat(101) },
            { ...create(), extra: true }, { ...create(), source: { kind: 'scene', targets: [] } },
            { ...create(), source: { kind: 'scene', targets: Array.from({ length: 101 }, (_, index) => ({ ...target, sceneId: `scene-${index}`, count: 1 })) } },
            ...[0, 2401, 1.5].map(count => ({ ...create(), source: { kind: 'scene', targets: [{ ...target, count }] } })),
            { ...create(), source: { kind: 'scene', targets: [{ ...target, grant: 'invented' }] } },
            { ...create(), source: { kind: 'preset', presetId: '../private', expectedRevision: 0 } },
            { ...create(), source: { kind: 'preset', presetId: 'preset-1', expectedRevision: -1 } },
            { ...create(), source: { kind: 'preset', presetId: 'preset-1', expectedRevision: Number.MAX_SAFE_INTEGER + 1 } },
            { ...create(), source: { kind: 'workflow-draft', draftId: 'draft-1', expectedRevision: 0 } },
            ...[0, 2401, 1.5].map(maxImages => ({ ...create(), budget: { maxImages, maxAnlas: 1 } })),
            ...[-1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1].map(maxAnlas => ({ ...create(), budget: { maxImages: 2400, maxAnlas } })),
            ...[{ kind: 'random', seed: 1 }, { kind: 'fixed', seed: -1 }, { kind: 'fixed', seed: 1.5 },
                { kind: 'increment', firstSeed: 0x1_0000_0000 }, { kind: 'other' }].map(seedPolicy => ({ ...create(), seedPolicy })),
        ]
        for (const input of valid) {
            expect(contract.validate(input)).toBe(input)
            expect(schema(input).valid).toBe(true)
        }
        for (const input of invalid) {
            expect(() => contract.validate(input as JsonObject), JSON.stringify(input)).toThrow()
            expect(schema(input).valid, JSON.stringify(input)).toBe(false)
        }
    })

    it('enforces unique identities and the total image ceiling beyond structural JSON Schema', () => {
        const contract = getAgentCommandInputContract('production.create')!
        const schema = new AjvJsonSchemaValidator().getValidator(contract.schema)
        for (const targets of [[{ ...target, count: 1 }, { ...target, count: 2 }],
            [target, { ...target, sceneId: 'scene-2', count: 1 }]]) {
            const input = { ...create(), source: { kind: 'scene', targets } }
            expect(schema(input).valid).toBe(true)
            expect(() => contract.validate(input)).toThrow()
        }
        expect(contract.validate({ ...create(), source: { kind: 'scene', targets: Array.from({ length: 100 },
            (_, index) => ({ ...target, sceneId: `scene-${index}`, count: 24 })) } })).toBeDefined()
    })

    it('keeps discovery empty and requires production identity and exact revision for the next plan', () => {
        for (const [name, valid, invalid] of [
            ['production.list', {}, { limit: 100 }],
            ['production.get', { productionId: 'production-1' }, { productionId: '../private' }],
            ['production.plan_next', { productionId: 'production-1', expectedRevision: 0 }, { productionId: 'production-1', expectedRevision: 0.5 }],
        ] as const) {
            const contract = getAgentCommandInputContract(name)!
            const schema = new AjvJsonSchemaValidator().getValidator(contract.schema)
            expect(contract.validate(valid)).toBe(valid)
            expect(schema(valid).valid).toBe(true)
            for (const input of [invalid, { ...valid, approvalToken: 'not-a-wire-input' }, null]) {
                expect(() => contract.validate(input as JsonObject)).toThrow()
                expect(schema(input).valid).toBe(false)
            }
        }
    })
})
