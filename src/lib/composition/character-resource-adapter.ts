import type {
    ActorRef,
    CharacterReferenceType,
    ResourceBinding,
    ResourceRef,
} from '@/domain/composition/types'
import type { DeepReadonly } from '@/domain/composition/provenance'
import {
    characterStoreResourceId,
    type CharacterResourceKind,
    type CharacterResourceRepository,
    type CharacterResourceReferenceType,
} from '@/lib/composition/character-resource-repository'
import { runtimeCapabilities, type RuntimeCapabilities } from '@/platform/capabilities'
import {
    assessPortablePath,
    runtimePortablePathTokenRegistry,
    type PlatformTokenRegistry,
    type PortableResourceByteReader,
    type PortableResourceIssue,
    type PortableResourceRepairAction,
} from '@/platform/portable-resources'
import { runtimePortableResourceByteReader } from '@/platform/tauri-portable-resource-reader'

export interface CharacterResourceProjectionContext {
    revision: number
    timestamp: string
    actor: ActorRef
}

export interface CharacterResourceSnapshot {
    id: string
    enabled?: boolean | null
    informationExtracted?: number | null
    strength?: number | null
    fidelity?: number | null
    referenceType?: CharacterResourceReferenceType | null
    digest?: string
}

export interface CharacterResourceProjection {
    resources: ResourceRef[]
    bindings: ResourceBinding[]
}

type NaiCharacterReferenceType = Exclude<CharacterReferenceType, 'vibe'>

export interface MaterializedCharacterResources {
    charImages: string[]
    charStrength: number[]
    charFidelity: number[]
    charReferenceType: NaiCharacterReferenceType[]
    charCacheKeys: Array<string | null>
    charInfo: number[]
    vibeImages: string[]
    vibeInfo: number[]
    vibeStrength: number[]
    preEncodedVibes: Array<string | null>
}

export interface CharacterResourceMaterializationIssue {
    code:
        | 'E_RESOURCE_REPOSITORY_UNAVAILABLE'
        | 'E_RESOURCE_NOT_FOUND'
        | 'E_RESOURCE_BYTES_MISSING'
        | PortableResourceIssue['code']
    resourceId: string
    message: string
    blocking?: true
    repairAction?: PortableResourceRepairAction
}

export type CharacterResourceMaterializationResult =
    | { success: true; value: MaterializedCharacterResources; errors: [] }
    | { success: false; value: null; errors: CharacterResourceMaterializationIssue[] }

function finiteOr(value: number | null | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function revisionFields(context: CharacterResourceProjectionContext) {
    return {
        revision: Math.max(0, Math.trunc(context.revision)),
        createdAt: context.timestamp,
        createdBy: context.actor,
        updatedAt: context.timestamp,
        updatedBy: context.actor,
    }
}

export function characterResourceRefId(kind: CharacterResourceKind, id: string): string {
    return `main-resource:${kind}:${id}`
}

function projectResource(
    kind: CharacterResourceKind,
    snapshot: CharacterResourceSnapshot,
    index: number,
    context: CharacterResourceProjectionContext,
): { resource: ResourceRef; binding: ResourceBinding } {
    const enabled = typeof snapshot.enabled === 'boolean' ? snapshot.enabled : true
    const resourceId = characterResourceRefId(kind, snapshot.id)
    return {
        resource: {
            ...revisionFields(context),
            id: resourceId,
            orderKey: `runtime:${String(index).padStart(6, '0')}`,
            kind: 'managed',
            enabled,
            role: kind === 'vibe' ? 'vibe-reference' : 'character-reference',
            resourceId: characterStoreResourceId(kind, snapshot.id),
            ...(snapshot.digest === undefined ? {} : { digest: snapshot.digest }),
        },
        binding: {
            resourceId,
            enabled,
            referenceType: kind === 'vibe' ? 'vibe' : (snapshot.referenceType ?? 'character&style'),
            strength: finiteOr(snapshot.strength, 0.6),
            fidelity: finiteOr(snapshot.fidelity, 0.6),
            informationExtracted: finiteOr(snapshot.informationExtracted, 1),
        },
    }
}

/** Projects stable handles and typed settings only; image/cache material never enters the document. */
export function projectCharacterResourcesToV2(input: {
    characterImages: readonly CharacterResourceSnapshot[]
    vibeImages: readonly CharacterResourceSnapshot[]
    context: CharacterResourceProjectionContext
}): CharacterResourceProjection {
    const projected = [
        ...input.characterImages.map((snapshot, index) => (
            projectResource('character', snapshot, index, input.context)
        )),
        ...input.vibeImages.map((snapshot, index) => (
            projectResource('vibe', snapshot, input.characterImages.length + index, input.context)
        )),
    ]
    return {
        resources: projected.map(item => item.resource),
        bindings: projected.map(item => item.binding),
    }
}

function emptyMaterialization(): MaterializedCharacterResources {
    return {
        charImages: [],
        charStrength: [],
        charFidelity: [],
        charReferenceType: [],
        charCacheKeys: [],
        charInfo: [],
        vibeImages: [],
        vibeInfo: [],
        vibeStrength: [],
        preEncodedVibes: [],
    }
}

type RepositoryContent = NonNullable<ReturnType<CharacterResourceRepository['getByResourceId']>>

/**
 * The only adapter boundary that materializes bytes/cache keys for NovelAI.
 * Existing encoded vibes are forwarded as-is and are never regenerated here.
 */
export async function materializeCharacterResourcesForNai(input: {
    resources: readonly DeepReadonly<ResourceRef>[]
    bindings: readonly DeepReadonly<ResourceBinding>[]
    repository: CharacterResourceRepository
    capabilities?: RuntimeCapabilities
    tokenRegistry?: PlatformTokenRegistry
    portableReader?: PortableResourceByteReader
}): Promise<CharacterResourceMaterializationResult> {
    const capabilities = input.capabilities ?? runtimeCapabilities
    const tokenRegistry = input.tokenRegistry ?? runtimePortablePathTokenRegistry
    const portableReader = input.portableReader ?? runtimePortableResourceByteReader
    const portableMaterializations = new Map<string, ReturnType<typeof assessPortablePath>>()
    const portableErrors: CharacterResourceMaterializationIssue[] = []
    for (const resource of input.resources) {
        if (!resource.enabled || resource.kind !== 'path') continue
        const assessment = assessPortablePath(resource.path, capabilities, tokenRegistry, resource.id)
        portableMaterializations.set(resource.id, assessment)
        if (assessment.status === 'unresolved') {
            portableErrors.push(...assessment.issues.map(issue => ({
                code: issue.code,
                resourceId: resource.id,
                message: issue.message,
                blocking: true as const,
                repairAction: issue.repairAction,
            })))
        }
    }
    // A portable resource mismatch never prevents loading the plan, but it is a
    // hard generation boundary until the caller performs the supplied repair.
    if (portableErrors.length > 0) return { success: false, value: null, errors: portableErrors }

    try {
        await input.repository.ensureAvailable()
    } catch (error) {
        return {
            success: false,
            value: null,
            errors: [{
                code: 'E_RESOURCE_REPOSITORY_UNAVAILABLE',
                resourceId: '*',
                message: error instanceof Error ? error.message : String(error),
            }],
        }
    }

    const resourcesById = new Map(input.resources.map(resource => [resource.id, resource]))
    const characterItems: Array<{ binding: DeepReadonly<ResourceBinding>; content: RepositoryContent }> = []
    const vibeItems: Array<{ binding: DeepReadonly<ResourceBinding>; content: RepositoryContent }> = []
    const errors: CharacterResourceMaterializationIssue[] = []

    for (const binding of input.bindings) {
        if (!binding.enabled) continue
        const resource = resourcesById.get(binding.resourceId)
        if (resource === undefined) {
            errors.push({
                code: 'E_RESOURCE_NOT_FOUND',
                resourceId: binding.resourceId,
                message: 'Managed resource reference was not found',
            })
            continue
        }
        if (!resource.enabled) continue
        if (resource.role !== 'character-reference' && resource.role !== 'vibe-reference') continue

        let content: RepositoryContent | undefined
        if (resource.kind === 'managed') {
            content = input.repository.getByResourceId(resource.resourceId)
        } else if (resource.kind === 'path') {
            const assessment = portableMaterializations.get(resource.id)
            if (assessment?.status === 'resolved') {
                try {
                    const bytes = await portableReader.read(assessment.materialized)
                    content = {
                        id: resource.id,
                        base64: bytesToBase64(bytes),
                        enabled: true,
                        informationExtracted: binding.informationExtracted ?? 1,
                        strength: binding.strength,
                        fidelity: binding.fidelity ?? 0.6,
                        referenceType: binding.referenceType === 'vibe' || binding.referenceType === 'delta'
                            ? 'character&style'
                            : binding.referenceType,
                    }
                } catch (error) {
                    errors.push({
                        code: 'E_RESOURCE_BYTES_MISSING',
                        resourceId: resource.id,
                        message: error instanceof Error ? error.message : String(error),
                        blocking: true,
                        repairAction: {
                            kind: 'select-file',
                            resourceId: resource.id,
                            ...(resource.path.kind === 'bookmark'
                                ? { bookmarkId: resource.path.bookmarkId }
                                : {}),
                            label: 'Locate readable resource',
                        },
                    })
                    continue
                }
            }
        }
        if (content === undefined) {
            errors.push({
                code: 'E_RESOURCE_NOT_FOUND',
                resourceId: resource.kind === 'managed' ? resource.resourceId : resource.id,
                message: 'Resource repository entry was not found',
            })
            continue
        }
        const materialAvailable = resource.role === 'vibe-reference'
            ? Boolean(content.base64 || content.encodedVibe)
            : Boolean(content.base64 || content.cacheKey)
        if (!materialAvailable) {
            errors.push({
                code: 'E_RESOURCE_BYTES_MISSING',
                resourceId: resource.kind === 'managed' ? resource.resourceId : resource.id,
                message: 'Resource bytes or existing cache material are unavailable after repository loading',
            })
            continue
        }

        const item = { binding, content }
        if (resource.role === 'vibe-reference') vibeItems.push(item)
        else characterItems.push(item)
    }

    if (errors.length > 0) return { success: false, value: null, errors }

    const value = emptyMaterialization()
    value.charImages = characterItems.map(item => item.content.base64)
    value.charStrength = characterItems.map(item => item.binding.strength)
    value.charFidelity = characterItems.map(item => item.binding.fidelity ?? item.content.fidelity)
    value.charReferenceType = characterItems.map(item => (
        item.binding.referenceType === 'vibe' ? 'character&style' : item.binding.referenceType
    ))
    value.charCacheKeys = characterItems.map(item => item.content.cacheKey ?? null)
    value.charInfo = characterItems.map(item => (
        item.binding.informationExtracted ?? item.content.informationExtracted
    ))
    value.vibeImages = vibeItems.map(item => item.content.base64)
    value.vibeInfo = vibeItems.map(item => (
        item.binding.informationExtracted ?? item.content.informationExtracted
    ))
    value.vibeStrength = vibeItems.map(item => item.binding.strength)
    value.preEncodedVibes = vibeItems.map(item => item.content.encodedVibe ?? null)
    return { success: true, value, errors: [] }
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = ''
    const chunkSize = 32_768
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
    }
    return btoa(binary)
}
