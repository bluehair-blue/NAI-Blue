/** Human editing consent is independent of generation policy and its pending approvals. */
export interface AgentAuthoringConsent {
    readonly schemaVersion: 1
    readonly revision: number
    readonly approvedClients: readonly { readonly workspaceId: string; readonly clientId: string }[]
}

export const DEFAULT_AGENT_AUTHORING_CONSENT: AgentAuthoringConsent = {
    schemaVersion: 1, revision: 0, approvedClients: [],
}

const validId = (value: unknown): value is string => typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value)

export function validateAgentAuthoringConsent(value: unknown): value is AgentAuthoringConsent {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const consent = value as AgentAuthoringConsent
    return Object.keys(consent).sort().join() === 'approvedClients,revision,schemaVersion'
        && consent.schemaVersion === 1 && Number.isSafeInteger(consent.revision)
        && consent.revision >= 0 && consent.revision < Number.MAX_SAFE_INTEGER
        && Array.isArray(consent.approvedClients) && consent.approvedClients.length <= 1000
        && (consent.approvedClients.length === 0 || consent.revision > 0)
        && consent.approvedClients.every(client => client && typeof client === 'object'
            && Object.keys(client).sort().join() === 'clientId,workspaceId'
            && validId(client.workspaceId) && validId(client.clientId))
        && new Set(consent.approvedClients.map(client => JSON.stringify([client.workspaceId, client.clientId]))).size === consent.approvedClients.length
}

/** Old/malformed settings grant no editing consent; other settings keep their own authority. */
export function normalizeAgentAuthoringConsent(value: unknown): AgentAuthoringConsent {
    return structuredClone(validateAgentAuthoringConsent(value) ? value : DEFAULT_AGENT_AUTHORING_CONSENT)
}

export function hasAgentAuthoringConsent(consent: AgentAuthoringConsent, workspaceId: string, clientId: string): boolean {
    return consent.approvedClients.some(client => client.workspaceId === workspaceId && client.clientId === clientId)
}

/** Called only by the human settings action; revision changes invalidate stale in-flight consent. */
export function updateAgentAuthoringConsent(current: AgentAuthoringConsent, expectedRevision: number,
    workspaceId: string, clientId: string, enabled: boolean): AgentAuthoringConsent {
    if (!validateAgentAuthoringConsent(current) || current.revision !== expectedRevision) throw new Error('Editing consent revision changed')
    if (!validId(workspaceId) || !validId(clientId) || typeof enabled !== 'boolean') throw new TypeError('Invalid editing consent')
    const approvedClients = current.approvedClients.filter(client => client.workspaceId !== workspaceId || client.clientId !== clientId)
    if (enabled) approvedClients.push({ workspaceId, clientId })
    const next = { ...current, revision: current.revision + 1, approvedClients }
    if (!validateAgentAuthoringConsent(next)) throw new TypeError('Editing consent limit reached')
    return next
}
