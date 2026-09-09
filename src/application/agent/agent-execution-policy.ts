/** Human-owned authority, shared by settings hydration and each enqueue evaluation. */
export interface AgentExecutionPolicy {
    readonly schemaVersion: 2
    readonly revision: number
    readonly mode: 'observe' | 'suggest' | 'bounded-auto'
    readonly globalPause: boolean
    readonly boundedAutoExpiresAt: string | null
    readonly generation: {
        readonly allowedCompatibilityStatuses: readonly ('captured-pass' | 'live-canary-pass' | 'synthetic-only')[]
    }
    readonly authoring: { readonly allowSceneChanges: boolean }
    readonly output: {
        readonly allowCreateFolders: boolean
        readonly allowRenamePathSegments: boolean
        readonly allowOverwrite: false
        readonly allowDeleteOriginal: false
    }
    readonly r2: {
        readonly allowedProfileIds: readonly string[]
        readonly allowUpload: boolean
        readonly allowOverwrite: false
    }
    readonly destructiveActions: 'always-ask' | 'deny'
}

export const DEFAULT_AGENT_EXECUTION_POLICY: AgentExecutionPolicy = {
    schemaVersion: 2, revision: 0, mode: 'suggest', globalPause: false, boundedAutoExpiresAt: null,
    generation: { allowedCompatibilityStatuses: ['captured-pass', 'live-canary-pass'] },
    authoring: { allowSceneChanges: false },
    output: { allowCreateFolders: false, allowRenamePathSegments: false, allowOverwrite: false, allowDeleteOriginal: false },
    r2: { allowedProfileIds: [], allowUpload: false, allowOverwrite: false },
    destructiveActions: 'deny',
}

function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        && Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
}
function integer(value: unknown, max: number, min = 0): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}
function strings(value: unknown, valid: (item: string) => boolean, max: number): boolean {
    return Array.isArray(value) && value.length <= max && new Set(value).size === value.length
        && value.every(item => typeof item === 'string' && valid(item))
}

/** Reject unknown authority and unsafe numbers instead of silently repairing permission grants. */
export function validateAgentExecutionPolicy(value: unknown): value is AgentExecutionPolicy {
    if (!record(value, ['schemaVersion', 'revision', 'mode', 'globalPause', 'boundedAutoExpiresAt', 'generation', 'authoring', 'output', 'r2', 'destructiveActions'])) return false
    const { generation, output, r2 } = value
    return value.schemaVersion === 2 && integer(value.revision, Number.MAX_SAFE_INTEGER - 1)
        && ['observe', 'suggest', 'bounded-auto'].includes(value.mode as string) && typeof value.globalPause === 'boolean'
        && (value.boundedAutoExpiresAt === null ? value.mode !== 'bounded-auto'
            : typeof value.boundedAutoExpiresAt === 'string' && Number.isFinite(Date.parse(value.boundedAutoExpiresAt))
                && new Date(value.boundedAutoExpiresAt).toISOString() === value.boundedAutoExpiresAt)
        && record(generation, ['allowedCompatibilityStatuses'])
        && strings(generation.allowedCompatibilityStatuses, item => ['captured-pass', 'live-canary-pass', 'synthetic-only'].includes(item), 3)
        && record(value.authoring, ['allowSceneChanges']) && typeof value.authoring.allowSceneChanges === 'boolean'
        && record(output, ['allowCreateFolders', 'allowRenamePathSegments', 'allowOverwrite', 'allowDeleteOriginal'])
        && typeof output.allowCreateFolders === 'boolean' && typeof output.allowRenamePathSegments === 'boolean'
        && output.allowOverwrite === false && output.allowDeleteOriginal === false
        && record(r2, ['allowedProfileIds', 'allowUpload', 'allowOverwrite'])
        && strings(r2.allowedProfileIds, item => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item), 100)
        && typeof r2.allowUpload === 'boolean' && r2.allowOverwrite === false
        && ['always-ask', 'deny'].includes(value.destructiveActions as string)
}

export function normalizeAgentExecutionPolicy(value: unknown): AgentExecutionPolicy {
    if (value === undefined) return structuredClone(DEFAULT_AGENT_EXECUTION_POLICY)
    if (validateAgentExecutionPolicy(value)) return structuredClone(value)
    // Remove retired quotas from valid v1 settings. Preserve mode/expiry/permissions,
    // and advance the revision so an old pending approval cannot reuse stale consent.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const legacy = { authoring: { allowSceneChanges: false }, ...value } as Record<string, unknown>
        const { generation, rollingLimits } = legacy
        if (legacy.schemaVersion === 1
            && record(generation, ['maxImagesPerRun', 'maxAnlasPerRun', 'maxConcurrentJobs', 'allowedCompatibilityStatuses'])
            && integer(generation.maxImagesPerRun, 1_000, 1) && integer(generation.maxAnlasPerRun, 1_000_000)
            && integer(generation.maxConcurrentJobs, 2, 1)
            && record(rollingLimits, ['maxRunsPerHour', 'maxImagesPerHour', 'maxAnlasPerHour', 'maxAnlasPerDay', 'maxOutstandingRequestsPerClient'])
            && integer(rollingLimits.maxRunsPerHour, 10_000) && integer(rollingLimits.maxImagesPerHour, 100_000)
            && integer(rollingLimits.maxAnlasPerHour, 10_000_000) && integer(rollingLimits.maxAnlasPerDay, 100_000_000)
            && integer(rollingLimits.maxOutstandingRequestsPerClient, 100, 1)
            && integer(legacy.revision, Number.MAX_SAFE_INTEGER - 2)) {
            const { rollingLimits: _retired, ...settings } = legacy
            const migrated = { ...settings, schemaVersion: 2, revision: legacy.revision + 1,
                generation: { allowedCompatibilityStatuses: generation.allowedCompatibilityStatuses } }
            if (validateAgentExecutionPolicy(migrated)) return structuredClone(migrated)
        }
    }
    return { ...structuredClone(DEFAULT_AGENT_EXECUTION_POLICY), mode: 'observe', globalPause: true }
}

/** Expiry is evaluated per request, including after restart; no timer can extend authority. */
export function effectiveAgentExecutionPolicy(policy: AgentExecutionPolicy, now = Date.now()): AgentExecutionPolicy {
    if (policy.mode === 'observe') return policy
    if (policy.globalPause || (policy.mode === 'bounded-auto'
        && (policy.boundedAutoExpiresAt === null || Date.parse(policy.boundedAutoExpiresAt) <= now))) {
        return { ...policy, mode: 'suggest' }
    }
    return policy
}

/** Only the human settings action calls this CAS; external command contracts expose no policy mutation. */
export function updateAgentExecutionPolicy(current: AgentExecutionPolicy, expectedRevision: number,
    next: unknown, now = Date.now()): AgentExecutionPolicy {
    if (expectedRevision !== current.revision) throw new Error('Agent policy revision changed; review the current policy')
    if (!validateAgentExecutionPolicy(next) || next.revision !== expectedRevision) throw new TypeError('Invalid agent execution policy')
    if (next.mode === 'bounded-auto') {
        const expiry = Date.parse(next.boundedAutoExpiresAt!)
        if (expiry <= now || expiry > now + 24 * 60 * 60 * 1_000) throw new TypeError('Bounded automatic execution must expire within 24 hours')
    }
    const updated = { ...structuredClone(next), revision: current.revision + 1 }
    if (!validateAgentExecutionPolicy(updated)) throw new TypeError('Agent policy revision limit reached')
    return updated
}
