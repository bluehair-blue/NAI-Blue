import { describe, expect, it } from 'vitest'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv'
import { getAgentCommandInputContract } from '@/application/agent/agent-command-input'
import { AGENT_COMMAND_NAMES, assertAgentPublicValue, type AgentCommandName } from '@/application/agent/agent-command-contract'
import { describeAgentCommandCapabilities, AGENT_COMMAND_EFFECTS, type AgentCommandHandler } from '@/application/agent/runtime-capability-registry'
import type { JsonObject } from '@/domain/composition/types'
import { hashCanonicalValue } from '@/domain/composition/canonical-serialize'

const plan = (): JsonObject => ({ source: { kind: 'workflow-draft', draftId: '저장한 draft', expectedRevision: 0 },
    count: 1, seedPolicy: { kind: 'random' }, budget: { maxImages: 100, maxAnlas: 1.25 } })
const digest = `sha256:${'a'.repeat(64)}`
const fixtures: Partial<Record<AgentCommandName, { valid: JsonObject[]; invalid: unknown[] }>> = {
    'system.describe_capabilities': { valid: [{}], invalid: [{ extra: true }] },
    'workspace.get_snapshot': { valid: [{}], invalid: [{ extra: true }] },
    'generation.get_run': { valid: [{ runId: 'run-1' }], invalid: [{}, { runId: '' }, { runId: '../private' }, { runId: 'a'.repeat(201) }, { runId: 'run-1', extra: true }] },
    'generation.cancel': { valid: [{ runId: 'run-1' }], invalid: [{}, { runId: 1 }, { runId: 'run 1' }] },
    'generation.retry_storage': { valid: [{ runId: 'run-1', jobId: 'job-1' }], invalid: [{ runId: 'run-1' }, { runId: 'run-1', jobId: '' }, { runId: 'run-1', jobId: 'job-1', extra: true }] },
    'generation.enqueue': { valid: [{ planId: digest, planHash: digest }], invalid: [{ planId: 'plan-1', planHash: digest }, { planId: digest }, { planId: digest, planHash: digest, extra: true }] },
    'generation.plan': { valid: [plan(), { ...plan(), seedPolicy: { kind: 'fixed', seed: 0 } },
        { ...plan(), count: 100, seedPolicy: { kind: 'increment', firstSeed: 0xffff_ffff } },
        { ...plan(), source: { kind: 'workflow-draft', draftId: 'a'.repeat(200), expectedRevision: Number.MAX_SAFE_INTEGER } },
        { ...plan(), budget: { maxImages: 0, maxAnlas: 0 } }], invalid: [
        {}, { ...plan(), extra: true }, { ...plan(), count: 0 }, { ...plan(), count: 101 }, { ...plan(), count: 1.5 },
        { ...plan(), source: { kind: 'other', draftId: 'draft-1', expectedRevision: 0 } },
        ...['', ' draft-1', 'draft-1 ', 'draft-1\n', '\ufeffdraft-1', 'a'.repeat(201)].map(draftId => ({ ...plan(), source: { kind: 'workflow-draft', draftId, expectedRevision: 0 } })),
        { ...plan(), source: { kind: 'workflow-draft', draftId: 'draft-1', expectedRevision: Number.MAX_SAFE_INTEGER + 1 } },
        { ...plan(), seedPolicy: { kind: 'random', seed: 1 } }, { ...plan(), seedPolicy: { kind: 'fixed', seed: -1 } },
        { ...plan(), seedPolicy: { kind: 'increment', firstSeed: 0x1_0000_0000 } },
        { ...plan(), seedPolicy: { kind: 'fixed', seed: 1.5 } }, { ...plan(), seedPolicy: { kind: 'other' } },
        { ...plan(), budget: { maxImages: 101, maxAnlas: 1 } }, { ...plan(), budget: { maxImages: 1.5, maxAnlas: 1 } },
        { ...plan(), budget: { maxImages: 1, maxAnlas: -1 } }, { ...plan(), budget: { maxImages: 1, maxAnlas: Infinity } },
    ] },
}

describe('shared application command input contracts', () => {
    it('matches operational input fixtures against the official SDK 2020-12 validator', () => {
        const provider = new AjvJsonSchemaValidator()
        for (const [name, examples] of Object.entries(fixtures)) {
            const contract = getAgentCommandInputContract(name as AgentCommandName)!
            const validateSchema = provider.getValidator(contract.schema)
            for (const input of examples.valid) {
                expect(contract.validate(input), name).toBe(input)
                expect(validateSchema(input).valid, `${name}: ${JSON.stringify(input)}`).toBe(true)
            }
            for (const input of [...examples.invalid, null, [], 1]) {
                expect(() => contract.validate(input as JsonObject), name).toThrow()
                expect(validateSchema(input).valid, `${name}: ${JSON.stringify(input)}`).toBe(false)
            }
        }
    })

    it('documents the stronger existing UTF-16 ID limit and still enforces it in shared validation', () => {
        const contract = getAgentCommandInputContract('generation.plan')!
        const input = { ...plan(), source: { kind: 'workflow-draft', draftId: '😀'.repeat(101), expectedRevision: 0 } }
        // Standard schema length counts code points. The adapter must also call
        // shared validate before submission; no schema claim relaxes app admission.
        expect(new AjvJsonSchemaValidator().getValidator(contract.schema)(input).valid).toBe(true)
        expect(() => contract.validate(input)).toThrow()
        expect(JSON.stringify(contract.schema)).toContain('x-maxUtf16Length')
    })

    it('includes schemas only for registered supported commands without overriding runtime gates', () => {
        const handlers = Object.keys(fixtures).map(command => ({ command, effect: AGENT_COMMAND_EFFECTS[command as AgentCommandName],
            validate: getAgentCommandInputContract(command as AgentCommandName)!.validate, execute: async () => ({}) })) as AgentCommandHandler[]
        const stopped = describeAgentCommandCapabilities(handlers, { ready: false, mode: 'suggest', globalPause: false })
        for (const item of stopped) {
            expect(item.available).toBe(false)
            expect(item.inputSchemaHash).toEqual(fixtures[item.command] ? `sha256:${hashCanonicalValue(getAgentCommandInputContract(item.command)!.schema)}` : undefined)
        }
        const unsupported = AGENT_COMMAND_NAMES.filter(name => !fixtures[name])
        for (const name of unsupported) expect(getAgentCommandInputContract(name)).toBeUndefined()
        const schema = getAgentCommandInputContract('generation.get_run')!.schema
        schema.properties = {}
        expect(getAgentCommandInputContract('generation.get_run')!.schema.properties).not.toEqual({})
    })
    it('keeps all schema hashes within the existing public result contract without exporting schema literals', () => {
        const handlers = Object.keys(fixtures).map(command => ({ command, effect: AGENT_COMMAND_EFFECTS[command as AgentCommandName],
            validate: getAgentCommandInputContract(command as AgentCommandName)!.validate, execute: async () => ({}) })) as AgentCommandHandler[]
        const capabilities = describeAgentCommandCapabilities(handlers, { ready: true, mode: 'suggest', globalPause: false })
        expect(() => assertAgentPublicValue({ capabilities })).not.toThrow()
        expect(JSON.stringify(capabilities)).not.toContain('$schema')
    })
})
