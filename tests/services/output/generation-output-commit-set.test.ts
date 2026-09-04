import { describe, expect, it } from 'vitest'

import {
    allocateExactOutputCommitSets,
    assertExactOutputCommitSetAllocation,
    createGenerationOutputCommitSet,
    type ExactOutputCommitSetAllocationRequest,
} from '@/services/output/generation-output-commit-set'

const FINGERPRINT = `sha256:${'a'.repeat(64)}` as const

function request(
    fileName: string,
    collisionPolicy: 'fail' | 'suffix' = 'suffix',
    overrides: Partial<ExactOutputCommitSetAllocationRequest> = {},
): ExactOutputCommitSetAllocationRequest {
    return {
        fileName,
        imageFormat: 'png',
        metadataMode: 'sidecar-only',
        preserveProviderOriginal: false,
        collisionPolicy,
        directoryAuthorityId: 'folder:output',
        directoryAuthorityFingerprint: FINGERPRINT,
        filesystemSemantics: 'windows',
        ...overrides,
    }
}

describe('exact output commit-set batch allocation', () => {
    it('detects a sidecar-only cross-job collision', () => {
        expect(() => allocateExactOutputCommitSets({
            requests: [request('portrait.png', 'fail'), request('portrait.nai-blue.json', 'fail', {
                metadataMode: 'embedded',
            })],
            occupiedCollisionKeys: new Set(),
        })).toThrow('Output destination is already occupied')
    })

    it('suffixes the whole set deterministically instead of renaming sidecars independently', () => {
        const allocations = allocateExactOutputCommitSets({
            requests: [request('portrait.png'), request('portrait.png')],
            occupiedCollisionKeys: new Set(),
        })

        expect(allocations.map(allocation => allocation.fileName)).toEqual(['portrait.png', 'portrait-2.png'])
        expect(allocations[1].commitSet.claims.map(claim => claim.relativePath)).toEqual([
            'portrait-2.png',
            'portrait-2.nai-blue.json',
        ])
    })

    it('fails immediately under fail policy', () => {
        const occupied = createGenerationOutputCommitSet(request('portrait.png')).commitSet.claims
            .map(claim => claim.collisionKey)
        expect(() => allocateExactOutputCommitSets({
            requests: [request('portrait.png', 'fail')],
            occupiedCollisionKeys: new Set(occupied),
        })).toThrow('portrait.png')
    })

    it('uses Windows case and trailing-space collision semantics', () => {
        const occupied = createGenerationOutputCommitSet(request('PORTRAIT.PNG')).commitSet.claims
            .map(claim => claim.collisionKey)
        expect(() => allocateExactOutputCommitSets({
            requests: [request('portrait.png ', 'fail', { metadataMode: 'embedded' })],
            occupiedCollisionKeys: new Set(occupied),
        })).toThrow('portrait.png ')
    })

    it('includes provider-original claims in allocation', () => {
        const existing = createGenerationOutputCommitSet(request('portrait.png', 'suffix', {
            metadataMode: 'embedded',
            preserveProviderOriginal: true,
        })).commitSet
        const providerOriginal = existing.claims.find(claim => claim.kind === 'provider-original')
        expect(providerOriginal).toBeDefined()

        const [allocation] = allocateExactOutputCommitSets({
            requests: [request('portrait.png', 'suffix', {
                metadataMode: 'embedded',
                preserveProviderOriginal: true,
            })],
            occupiedCollisionKeys: new Set([providerOriginal!.collisionKey]),
        })
        expect(allocation.fileName).toBe('portrait-2.png')
        expect(allocation.commitSet.claims.find(claim => claim.kind === 'provider-original')?.relativePath)
            .toBe('._nai-blue-private/portrait-2.png')
    })

    it('rejects fingerprint, semantics, sidecar, and provider-original planner tampering', () => {
        const allocation = allocateExactOutputCommitSets({
            requests: [request('portrait.png', 'fail', {
                preserveProviderOriginal: true,
            })],
            occupiedCollisionKeys: new Set(),
        })[0]
        const planned = { ...allocation, directoryIdentity: FINGERPRINT }
        const validationRequest = {
            ...request('portrait.png', 'fail', { preserveProviderOriginal: true }),
            directoryAuthorityFingerprint: undefined,
            filesystemSemantics: undefined,
        }
        delete validationRequest.directoryAuthorityFingerprint
        delete validationRequest.filesystemSemantics

        expect(() => assertExactOutputCommitSetAllocation(validationRequest, {
            ...planned, directoryIdentity: `sha256:${'b'.repeat(64)}`,
        }, 'windows')).toThrow('non-canonical')
        expect(() => assertExactOutputCommitSetAllocation(validationRequest, {
            ...planned,
            commitSet: { ...planned.commitSet, filesystemSemantics: 'linux' },
        }, 'windows')).toThrow('non-canonical')
        for (const omittedKind of ['metadata-sidecar', 'provider-original'] as const) {
            expect(() => assertExactOutputCommitSetAllocation(validationRequest, {
                ...planned,
                commitSet: {
                    ...planned.commitSet,
                    claims: planned.commitSet.claims.filter(claim => claim.kind !== omittedKind),
                },
            }, 'windows')).toThrow('non-canonical')
        }
    })
})
