import type { JsonObject } from '@/domain/composition/types'
import type { Sha256Digest } from '@/application/generation/generation-plan-contract'
import { AgentCommandError, assertAgentPublicValue } from './agent-command-contract'

export type AgentAuthoringCommand = 'scene.patch_many' | 'folder.apply_changes'
/** The application port binds the exact before/after document without exporting local paths. */
export interface AgentAuthoringTarget {
    readonly command: AgentAuthoringCommand
    readonly resourceId: string
    readonly expectedRevision: number
    readonly targetHash: Sha256Digest
    readonly changeCount: number
    readonly createsFolders: boolean
    readonly renamesPathSegments: boolean
}
export interface AgentAuthoringGrant {
    readonly requestId: string
    readonly requestHash: Sha256Digest
    readonly workspaceId: string
    readonly clientId: string
    readonly actorKind: 'agent' | 'service'
    readonly policyRevision: number
    readonly expiresAt: string
    readonly consentedAt: string
    readonly authorization: 'human' | 'bounded-auto'
    readonly target: AgentAuthoringTarget
}
/** Existing Scene/Folder authorities own commit and exact grant evidence; recovery is read-only. */
export interface AgentAuthoringPort {
    inspect(command: AgentAuthoringCommand, input: JsonObject): Promise<AgentAuthoringTarget | null>
    apply(command: AgentAuthoringCommand, input: JsonObject, target: AgentAuthoringTarget, grant: AgentAuthoringGrant): Promise<JsonObject>
    reconcile(grant: AgentAuthoringGrant, input: JsonObject): Promise<JsonObject | null>
}
export function assertAgentAuthoringTarget(value: unknown): asserts value is AgentAuthoringTarget {
    const target = value as AgentAuthoringTarget
    if (!target || Object.keys(target).sort().join() !== 'changeCount,command,createsFolders,expectedRevision,renamesPathSegments,resourceId,targetHash'
        || !['scene.patch_many', 'folder.apply_changes'].includes(target.command)
        || typeof target.resourceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(target.resourceId)
        || !Number.isSafeInteger(target.expectedRevision) || target.expectedRevision < 0 || target.expectedRevision >= Number.MAX_SAFE_INTEGER
        || !/^sha256:[a-f0-9]{64}$/.test(target.targetHash)
        || !Number.isSafeInteger(target.changeCount) || target.changeCount < 1 || target.changeCount > 100
        || typeof target.createsFolders !== 'boolean' || typeof target.renamesPathSegments !== 'boolean'
        || (target.command === 'scene.patch_many' && (target.createsFolders || target.renamesPathSegments))) {
        throw new AgentCommandError('INVALID_AUTHORING_TARGET')
    }
    assertAgentPublicValue(target)
}
export function isAgentAuthoringResult(value: unknown, grant: AgentAuthoringGrant): value is JsonObject {
    const result = value as JsonObject
    return !!result && Object.keys(result).sort().join() === 'command,resourceId,revision,status,targetHash'
        && result.status === 'authoring-committed' && result.command === grant.target.command
        && result.resourceId === grant.target.resourceId && result.revision === grant.target.expectedRevision + 1
        && result.targetHash === grant.target.targetHash
}
