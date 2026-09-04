import { hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import type { OutputCommitSet, OutputPathClaim, OutputPathClaimKind } from '@/domain/queue/types'

export interface OutputCommitSetClaimInput {
    readonly claimId: string
    readonly kind: OutputPathClaimKind
    readonly relativePath: string
}

export interface CreateOutputCommitSetInput {
    readonly directoryAuthorityId: string
    readonly directoryAuthorityFingerprint: `sha256:${string}`
    readonly filesystemSemantics: OutputCommitSet['filesystemSemantics']
    readonly filenamePolicyRevision: string
    readonly pathNormalizationRevision: string
    readonly claims: readonly OutputCommitSetClaimInput[]
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

function boundedIdentifier(value: string, field: string): string {
    if (value !== value.trim() || value.length === 0 || value.length > 256 || /[\\/\r\n]/.test(value)) {
        throw new TypeError(`${field} must be a bounded non-path identifier`)
    }
    return value
}

export function normalizeOutputRelativePath(
    relativePath: string,
    semantics: OutputCommitSet['filesystemSemantics'],
): string {
    if (relativePath.length === 0
        || relativePath.length > 1_024
        || relativePath.includes('\\')
        || relativePath.startsWith('/')
        || /^[A-Za-z]:/.test(relativePath)) {
        throw new TypeError('Output claim relativePath is invalid')
    }
    const normalized = relativePath.split('/').map(segment => {
        if (segment.length === 0 || segment === '.' || segment === '..') {
            throw new TypeError('Output claim relativePath is invalid')
        }
        let selected = semantics === 'macos' ? segment.normalize('NFD') : segment.normalize('NFC')
        if (semantics === 'windows') {
            if (/[<>:"|?*\u0000-\u001f]/.test(selected)) throw new TypeError('Windows output component is invalid')
            selected = selected.replace(/[ .]+$/g, '').toLowerCase()
            if (selected.length === 0 || WINDOWS_RESERVED.test(selected)) {
                throw new TypeError('Windows output component is reserved')
            }
        }
        if (semantics === 'macos') selected = selected.toLowerCase()
        if (selected.length === 0 || selected.length > 255) throw new TypeError('Output component is too long')
        return selected
    })
    return normalized.join('/')
}

/** Normalizes resolved directory paths with the same filesystem aliases used by claims. */
export function normalizeOutputDirectoryPath(
    path: string,
    semantics: OutputCommitSet['filesystemSemantics'],
): string {
    return path.replace(/\\/g, '/').split('/').map(component => {
        let selected = semantics === 'macos' ? component.normalize('NFD') : component.normalize('NFC')
        if (semantics === 'windows') selected = selected.replace(/[ .]+$/g, '')
        return semantics === 'windows' || semantics === 'macos' ? selected.toLowerCase() : selected
    }).join('/')
}

export function createOutputCollisionKey(input: {
    readonly directoryAuthorityId: string
    readonly directoryAuthorityFingerprint: `sha256:${string}`
    readonly filesystemSemantics: OutputCommitSet['filesystemSemantics']
    readonly pathNormalizationRevision: string
    readonly relativePath: string
}): string {
    boundedIdentifier(input.directoryAuthorityId, 'directoryAuthorityId')
    boundedIdentifier(input.pathNormalizationRevision, 'pathNormalizationRevision')
    if (!/^sha256:[a-f0-9]{64}$/.test(input.directoryAuthorityFingerprint)) {
        throw new TypeError('directoryAuthorityFingerprint is invalid')
    }
    const normalizedRelativePath = normalizeOutputRelativePath(input.relativePath, input.filesystemSemantics)
    return `collision:sha256:${hashCanonicalValue({
        directoryAuthorityId: input.directoryAuthorityId,
        directoryAuthorityFingerprint: input.directoryAuthorityFingerprint,
        filesystemSemantics: input.filesystemSemantics,
        normalizedRelativePath,
        pathNormalizationRevision: input.pathNormalizationRevision,
    })}`
}

export function hashOutputCommitSet(commitSet: OutputCommitSet): `sha256:${string}` {
    return `sha256:${hashCanonicalValue(commitSet)}`
}

export function createOutputCommitSet(input: CreateOutputCommitSetInput): {
    readonly commitSet: OutputCommitSet
    readonly commitSetHash: `sha256:${string}`
} {
    boundedIdentifier(input.filenamePolicyRevision, 'filenamePolicyRevision')
    boundedIdentifier(input.pathNormalizationRevision, 'pathNormalizationRevision')
    if (input.claims.length === 0) throw new TypeError('Output commit set must contain at least one claim')
    const claimIds = new Set<string>()
    const collisionKeys = new Set<string>()
    const claims: OutputPathClaim[] = input.claims.map(claim => {
        boundedIdentifier(claim.claimId, 'claimId')
        if (claimIds.has(claim.claimId)) throw new TypeError('Output commit set claimId is duplicated')
        claimIds.add(claim.claimId)
        const collisionKey = createOutputCollisionKey({
            directoryAuthorityId: input.directoryAuthorityId,
            directoryAuthorityFingerprint: input.directoryAuthorityFingerprint,
            filesystemSemantics: input.filesystemSemantics,
            pathNormalizationRevision: input.pathNormalizationRevision,
            relativePath: claim.relativePath,
        })
        if (collisionKeys.has(collisionKey)) throw new TypeError('Output commit set collision key is duplicated')
        collisionKeys.add(collisionKey)
        return Object.freeze({ ...claim, collisionKey })
    })
    const commitSet: OutputCommitSet = Object.freeze({
        schemaVersion: 1,
        directoryAuthorityId: boundedIdentifier(input.directoryAuthorityId, 'directoryAuthorityId'),
        directoryAuthorityFingerprint: input.directoryAuthorityFingerprint,
        filesystemSemantics: input.filesystemSemantics,
        filenamePolicyRevision: input.filenamePolicyRevision,
        pathNormalizationRevision: input.pathNormalizationRevision,
        claims: Object.freeze(claims),
    })
    return Object.freeze({ commitSet, commitSetHash: hashOutputCommitSet(commitSet) })
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parses persisted/journaled commit sets and recomputes every collision key. */
export function parseOutputCommitSet(value: unknown): OutputCommitSet {
    if (!isRecord(value)
        || value.schemaVersion !== 1
        || typeof value.directoryAuthorityId !== 'string'
        || typeof value.directoryAuthorityFingerprint !== 'string'
        || !/^sha256:[a-f0-9]{64}$/.test(value.directoryAuthorityFingerprint)
        || (value.filesystemSemantics !== 'windows'
            && value.filesystemSemantics !== 'macos'
            && value.filesystemSemantics !== 'linux'
            && value.filesystemSemantics !== 'android')
        || typeof value.filenamePolicyRevision !== 'string'
        || typeof value.pathNormalizationRevision !== 'string'
        || !Array.isArray(value.claims)) {
        throw new TypeError('Output commit set is invalid')
    }
    const claimInputs: Array<OutputCommitSetClaimInput & { readonly collisionKey: string }> = value.claims.map(claim => {
        if (!isRecord(claim)
            || typeof claim.claimId !== 'string'
            || (claim.kind !== 'image'
                && claim.kind !== 'metadata-sidecar'
                && claim.kind !== 'artifact-sidecar'
                && claim.kind !== 'diagnostic-sidecar'
                && claim.kind !== 'provider-original')
            || typeof claim.relativePath !== 'string'
            || typeof claim.collisionKey !== 'string') {
            throw new TypeError('Output commit set claim is invalid')
        }
        return {
            claimId: claim.claimId,
            kind: claim.kind as OutputPathClaimKind,
            relativePath: claim.relativePath,
            collisionKey: claim.collisionKey,
        }
    })
    const parsed = createOutputCommitSet({
        directoryAuthorityId: value.directoryAuthorityId,
        directoryAuthorityFingerprint: value.directoryAuthorityFingerprint as `sha256:${string}`,
        filesystemSemantics: value.filesystemSemantics,
        filenamePolicyRevision: value.filenamePolicyRevision,
        pathNormalizationRevision: value.pathNormalizationRevision,
        claims: claimInputs,
    }).commitSet
    if (parsed.claims.some((claim, index) => claim.collisionKey !== claimInputs[index].collisionKey)) {
        throw new TypeError('Output commit set collision key is invalid')
    }
    return parsed
}
