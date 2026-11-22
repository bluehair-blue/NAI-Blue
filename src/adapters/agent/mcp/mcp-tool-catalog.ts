import type { AgentCommandName } from '@/application/agent/agent-command-contract'
import { getAgentCommandInputContract } from '@/application/agent/agent-command-input'
import type { JsonObject, JsonValue } from '@/domain/composition/types'
import { AGENT_TOOL_DESCRIPTIONS } from './agent-workflow-guide'

/** The advertised tool list is static text: availability is reported by call results and nai-blue://capabilities. */
export type AgentMcpToolName = keyof typeof AGENT_TOOL_DESCRIPTIONS
export const SNAPSHOT_LISTS = { presets: 'scenePresets', scenes: 'scenes', folders: 'folders', drafts: 'workflowDrafts' } as const
export const MAX_WAIT_SECONDS = 50
// A 480px preview is about 0.5 MB as base64; four keep one response near 2 MB.
export const MAX_IMAGES_PER_CALL = 4
export const ADVANCED_COMMANDS: readonly AgentCommandName[] = ['folder.plan_changes', 'folder.apply_changes',
    'production.create', 'production.list', 'production.get', 'production.plan_next']

// Contract validators enforce these; repeating them in every advertised schema only costs context.
const FORMAT_KEYS = new Set(['$schema', 'pattern', 'not', 'minLength', 'maxLength', 'minItems', 'additionalProperties', 'x-maxUtf16Length'])
// Small bounds tell the model something (strength 0-1, 100 Scenes); integer-range bounds do not.
const informativeBound = (key: string, value: JsonValue) => key === 'minimum' ? value !== 0 : key !== 'maximum' || Number(value) <= 65_536

export function compactSchema(value: JsonValue, namesAreProperties = false): JsonValue {
    if (Array.isArray(value)) return value.map(item => compactSchema(item))
    if (value === null || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value)
        .filter(([key, child]) => namesAreProperties || (!FORMAT_KEYS.has(key) && informativeBound(key, child)))
        .map(([key, child]) => [key, compactSchema(child, !namesAreProperties && key === 'properties')]))
}

const text = { type: 'string' }
const integer = { type: 'integer' }
const fields = (properties: JsonObject, required = Object.keys(properties)): JsonObject => ({ type: 'object', properties, required })
// One shape for both plan sources; the contract's two near-identical variants would double the size.
const PLAN_INPUT = fields({
    source: { oneOf: [
        fields({ kind: { const: 'scene' }, targets: { type: 'array',
            items: fields({ presetId: text, sceneId: text, expectedRevision: integer, count: integer }) } }),
        fields({ kind: { const: 'workflow-draft' }, draftId: text, expectedRevision: integer }),
    ] },
    count: { ...integer, description: 'workflow-draft only: the draft imageCount' },
    seedPolicy: { ...fields({ kind: { enum: ['random', 'fixed', 'increment'] }, seed: integer, firstSeed: integer }, ['kind']),
        description: 'fixed needs seed; increment needs firstSeed' },
    budget: fields({ maxImages: { ...integer, maximum: 100 }, maxAnlas: { type: 'number' } }),
}, ['source', 'seedPolicy', 'budget'])

const OPTIONS = {
    requestId: text,
    detail: { enum: ['summary', 'full'] },
    waitSeconds: { ...integer, description: `0-${MAX_WAIT_SECONDS}` },
    include: { type: 'array', items: { enum: Object.keys(SNAPSHOT_LISTS) } },
    planOnly: { type: 'boolean' },
}
type Option = keyof typeof OPTIONS

function contractInput(command: AgentCommandName): JsonObject {
    return compactSchema(getAgentCommandInputContract(command)!.schema) as JsonObject
}
// A lost response leaves the caller nothing to inspect unless it chose the ID of a generation request itself.
export const REQUEST_ID_REQUIRED: readonly string[] = ['generation.run', 'generation.enqueue']

function tool(name: AgentMcpToolName, input: JsonObject, options: Option[] = [], extra: JsonObject = {}) {
    const hasRequired = Array.isArray(input.required) && input.required.length > 0
    const properties: JsonObject = { ...extra, input, ...Object.fromEntries(['requestId', 'detail', ...options].map(key => [key, OPTIONS[key as Option]])) }
    return { name, description: AGENT_TOOL_DESCRIPTIONS[name],
        inputSchema: { type: 'object' as const, properties, required: [...Object.keys(extra), ...(hasRequired ? ['input'] : []),
            ...(REQUEST_ID_REQUIRED.includes(name) ? ['requestId'] : [])] } }
}

export function listAgentMcpTools() {
    return [
        tool('workspace.get_snapshot', contractInput('workspace.get_snapshot'), ['include']),
        tool('scene.resolve_many', contractInput('scene.resolve_many')),
        tool('scene.patch_many', contractInput('scene.patch_many')),
        tool('generation.run', PLAN_INPUT, ['waitSeconds', 'planOnly']),
        tool('generation.enqueue', contractInput('generation.enqueue')),
        tool('generation.get_run', contractInput('generation.get_run'), ['waitSeconds']),
        tool('generation.cancel', contractInput('generation.cancel')),
        tool('generation.retry_storage', contractInput('generation.retry_storage')),
        tool('artifact.get_images', fields({ artifactIds: { type: 'array', items: text } })),
        tool('r2.get_readiness', contractInput('r2.get_readiness')),
        tool('advanced.call', { type: 'object' }, [], { command: { enum: [...ADVANCED_COMMANDS] } }),
    ]
}

const ADVANCED_NOTES: Partial<Record<AgentCommandName, string>> = {
    'folder.plan_changes': 'Preview folder changes using known parent IDs and safe child path segments.',
    'folder.apply_changes': 'Apply exactly the previewed changes with expectedRevision and the preview\'s expectedPlanHash.',
    'production.create': 'Save a production request of up to 2400 images from Scene targets or a whole preset. Does not enqueue.',
    'production.list': 'List saved production requests.',
    'production.get': 'Latest revision, budget use, children and nextAction of one request.',
    'production.plan_next': 'Preview the next child of at most 100 images at expectedRevision; enqueue it with generation.enqueue.',
}

export function advancedCommandGuide(): string {
    return ['# advanced.call', 'Call advanced.call with { command, input }. requestId and detail work as on every tool.',
        ...ADVANCED_COMMANDS.map(command => `## ${command}\n${ADVANCED_NOTES[command]}\ninput: ${JSON.stringify(contractInput(command))}`),
    ].join('\n\n')
}
