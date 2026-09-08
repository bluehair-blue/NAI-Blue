import type { JsonObject } from '@/domain/composition/types'
import { isGenerationFolderPathSegment } from '@/domain/generation-folders'
import { AgentCommandError } from './agent-command-contract'

export interface AgentCommandInputContract {
    readonly schema: JsonObject
    readonly validate: (input: JsonObject) => JsonObject
}

type Field = { schema: JsonObject; valid: (value: unknown) => boolean }
const text = (maximum: number, minimum = 0): Field => ({ schema: { type: 'string', minLength: minimum, maxLength: maximum },
    valid: value => typeof value === 'string' && value.length >= minimum && value.length <= maximum })
const number = (minimum: number, maximum: number, integer = true): Field => ({
    schema: { type: integer ? 'integer' : 'number', minimum, maximum },
    valid: value => typeof value === 'number' && Number.isFinite(value) && (!integer || Number.isSafeInteger(value)) && value >= minimum && value <= maximum,
})
const boolean: Field = { schema: { type: 'boolean' }, valid: value => typeof value === 'boolean' }
const literal = (value: string | boolean): Field => ({ schema: { const: value }, valid: candidate => candidate === value })
const id: Field = { schema: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$' },
    valid: value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value) }
const hash: Field = { schema: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
    valid: value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value) }
const segment: Field = { schema: { type: 'string', minLength: 1, maxLength: 96,
    pattern: '^[^<>:"/\\\\|?*\\u0000-\\u001f\\u007f]+$',
    not: { anyOf: [{ pattern: '^\\s|[.\\s]$' }, { pattern: '^(?:[cC][oO][nN]|[pP][rR][nN]|[aA][uU][xX]|[nN][uU][lL]|[cC][oO][mM][1-9]|[lL][pP][tT][1-9])(?:\\.|$)' }] },
    description: 'One safe folder segment; no separators, reserved device names, or trailing dots/spaces.' }, valid: isGenerationFolderPathSegment }
function object(required: Record<string, Field>, optional: Record<string, Field> = {}): Field {
    const fields = { ...required, ...optional }
    return { schema: { type: 'object', properties: Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.schema])),
        required: Object.keys(required), additionalProperties: false }, valid: value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false
        const row = value as Record<string, unknown>
        return Object.keys(required).every(key => Object.prototype.hasOwnProperty.call(row, key))
            && Object.keys(row).every(key => Object.prototype.hasOwnProperty.call(fields, key) && fields[key].valid(row[key]))
    } }
}
const array = (item: Field): Field => ({ schema: { type: 'array', minItems: 1, maxItems: 100, items: item.schema },
    valid: value => Array.isArray(value) && value.length > 0 && value.length <= 100 && value.every(item.valid) })
const revision = number(0, Number.MAX_SAFE_INTEGER - 1)
const prompts = object({}, Object.fromEntries(['base', 'additional', 'character', 'negative', 'characterNegative'].map(key => [key, text(16_384)])))
const generation = object({}, { model: text(100, 1), sampler: text(100, 1), scheduler: text(100, 1), steps: number(1, 50),
    cfgScale: number(0, 100, false), cfgRescale: number(0, 1, false), smea: literal(false), smeaDyn: literal(false),
    variety: boolean, qualityToggle: boolean, ucPreset: number(0, 3), seed: number(0, 0xffff_ffff), seedLocked: boolean })
const sceneChange = object({ sceneId: id }, { name: text(200, 1), prompts, generation, width: number(64, 4096), height: number(64, 4096),
    generationFolderId: id, productionCount: number(1, 100), filenameTemplate: text(200) })
const inheritedOptions = [object({ mode: literal('inherit') }), object({ mode: literal('clear') }), object({ mode: literal('set'), value: text(200, 1) })]
const inherited: Field = { schema: { oneOf: inheritedOptions.map(option => option.schema) }, valid: value => inheritedOptions.some(option => option.valid(value)) }
const folderPreferences = { commonPrompt: text(16_384), autoUpload: boolean,
    r2ProfilePolicy: inherited, r2BucketPolicy: inherited, r2PrefixPolicy: inherited }
const create = object({ op: literal('create'), folderId: id, parentId: id, displayName: text(96, 1), pathSegment: segment }, folderPreferences)
const patch = object({ op: literal('patch'), folderId: id }, { displayName: text(96, 1), pathSegment: segment, parentId: id, ...folderPreferences })
const folderChange: Field = { schema: { oneOf: [create.schema, patch.schema] }, valid: value => create.valid(value) || patch.valid(value) }
function contract(field: Field, unique?: (input: JsonObject) => unknown[]): AgentCommandInputContract {
    return { schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', ...field.schema }, validate: input => {
        if (!field.valid(input)) throw new AgentCommandError('INVALID_COMMAND_INPUT')
        const ids = unique?.(input)
        if (ids && new Set(ids).size !== ids.length) throw new AgentCommandError('INVALID_COMMAND_INPUT')
        return input
    } }
}
/** No runtime authority, filesystem paths, artifact refs, or Queue instructions are accepted. */
export const agentAuthoringInputContracts = {
    'scene.resolve_many': contract(object({ targets: array(object({ presetId: id, sceneId: id })) })),
    'scene.patch_many': contract(object({ presetId: id, expectedRevision: revision, changes: array(sceneChange) }, { presetName: text(200, 1) }),
        input => (input.changes as JsonObject[]).map(change => change.sceneId)),
    'folder.plan_changes': contract(object({ expectedRevision: revision, changes: array(folderChange) }),
        input => (input.changes as JsonObject[]).map(change => change.folderId)),
    'folder.apply_changes': contract(object({ expectedRevision: revision, expectedPlanHash: hash, changes: array(folderChange) }),
        input => (input.changes as JsonObject[]).map(change => change.folderId)),
    'r2.get_readiness': contract(object({})),
}
export const workspaceSnapshotInputContract = contract(object({}, { offset: number(0, Number.MAX_SAFE_INTEGER), limit: number(1, 100) }))
