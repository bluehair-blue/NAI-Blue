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
    readonly authorization: 'human' | 'bounded-auto' | 'client-always-edit'
    /** Present only for persisted client editing consent; never generation authority. */
    readonly consentRevision?: number
    readonly target: AgentAuthoringTarget
}
/** A request the authority refuses for a reason the agent can act on, rather than an unavailable target. */
export interface AgentAuthoringRefusal { readonly refused: string }
export const isAgentAuthoringRefusal = (value: AgentAuthoringTarget | AgentAuthoringRefusal | null): value is AgentAuthoringRefusal =>
    value !== null && 'refused' in value
/** Existing Scene/Folder authorities own commit and exact grant evidence; recovery is read-only. */
export interface AgentAuthoringPort {
    inspect(command: AgentAuthoringCommand, input: JsonObject): Promise<AgentAuthoringTarget | AgentAuthoringRefusal | null>
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
        // Zero Scene changes is a preset-only archive or restore, which only scene.patch_many can express.
        || !Number.isSafeInteger(target.changeCount) || target.changeCount < (target.command === 'scene.patch_many' ? 0 : 1) || target.changeCount > 100
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
        // An archive or restore without Scene changes commits no Scene document, so its revision stays.
        && result.resourceId === grant.target.resourceId
        && result.revision === grant.target.expectedRevision + (grant.target.changeCount === 0 ? 0 : 1)
        && result.targetHash === grant.target.targetHash
}
