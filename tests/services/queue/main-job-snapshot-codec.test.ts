import { describe, expect, it } from 'vitest'

import type { JsonValue } from '@/domain/composition/types'
import { createAnlasCostConsentSnapshot } from '@/domain/queue/anlas-cost-consent'
import type { GenerationJobSnapshot } from '@/domain/queue/types'
import type { PreparedMainGeneration } from '@/services/generation/main-generation-plan'
import type { GenerationParams } from '@/services/novelai-types'
import { QueueExecutionError } from '@/services/queue/durable-queue-coordinator'
import {
    decodeMainJobSnapshot,
    encodeMainJobSnapshot,
} from '@/services/queue/main-job-snapshot-codec'
import {
    CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
    LEGACY_NAI_PAYLOAD_BUILDER_REVISION,
    queryNaiGenerationCompatibility,
} from '@/services/nai/compatibility'
import { CURRENT_NAI_MODEL_CATALOG_REVISION } from '@/services/nai/model-catalog'
import {
    createR2ProfileV2,
    hashR2ProfileV2,
    type R2QueueDeliverySnapshot,
} from '@/domain/r2/types'

function currentR2Delivery(accountId = 'account-1'): R2QueueDeliverySnapshot {
    const profile = createR2ProfileV2({
        id: 'profile-1', name: 'Release', accountId, jurisdiction: null,
        endpoint: null, bucket: 'release-bucket', prefix: 'generated/images',
        credentialRef: 'stronghold:r2-profile-1', transport: 'native-s3', conflictPolicy: 'fail',
        publicMode: 'private', publicBaseUrl: null,
    }, '2026-09-04T00:00:00.000Z')
    return {
        requirement: 'required',
        planned: {
            destination: {
                requirement: 'required', profileId: profile.id, profileHash: hashR2ProfileV2(profile),
                bucket: profile.bucket, key: 'generated/images/image.png', conflictPolicy: 'fail',
                verification: 'head-metadata-sha256',
                provenance: {
                    profileId: 'explicit-request', bucket: 'profile-snapshot',
                    prefix: 'profile-snapshot', key: 'planned-output',
                },
            },
            profile,
            credentialBinding: { credentialRef: profile.credentialRef },
        },
    }
}

function params(overrides: Partial<GenerationParams> = {}): GenerationParams {
    return {
        prompt: 'encoded prompt',
        negative_prompt: 'encoded negative',
        model: 'nai-diffusion-4-5-full',
        width: 832,
        height: 1216,
        steps: 28,
        cfg_scale: 5,
        cfg_rescale: 0,
        sampler: 'k_euler_ancestral',
        scheduler: 'karras',
        smea: false,
        smea_dyn: false,
        variety: false,
        seed: 4321,
        ...overrides,
    }
}

function prepared(overrides: Partial<PreparedMainGeneration> = {}): PreparedMainGeneration {
    return {
        params: params(),
        finalPrompt: 'encoded prompt',
        imageFormat: 'png',
        metadataMode: 'embedded',
        streaming: true,
        sourceEdit: false,
        sequenceCommitProposal: null,
        output: {
            autoSave: true,
            directory: 'NAI_Blue_Output',
            useAbsolutePath: false,
            capabilityFallbackDirectory: 'NAI_Blue_Output',
            collisionPolicy: 'unique',
        },
        ...overrides,
    }
}

const dehydrated = {
    parameters: {
        generationParams: { prompt: 'encoded prompt', seed: 4321 } as JsonValue,
        resourceBindings: [],
        resourceArrayLengths: {},
    },
    resources: [],
}

describe('Main Job Snapshot codec', () => {
    it('encodes the stable V1 wire shape and Queue seed filename policy', () => {
        const encoded = encodeMainJobSnapshot(prepared(), dehydrated)

        expect(encoded.compositionPlanHash).toBeNull()
        expect(encoded.snapshot).toMatchObject({
            schemaVersion: 1,
            prompt: { positive: 'encoded prompt', negative: 'encoded negative' },
            parameters: {
                payloadBuilderRevision: CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
                queueExecution: { streaming: true, sourceEdit: false },
                mainWorkflow: {
                    finalPrompt: 'encoded prompt',
                    imageFormat: 'png',
                    metadataMode: 'embedded',
                    output: {
                        directory: 'NAI_Blue_Output',
                        fileName: 'NAI_Blue_4321.png',
                        collisionPolicy: 'unique',
                    },
                },
            },
            outputPolicy: {
                workflow: 'main',
                imageFormat: 'png',
                metadataMode: 'embedded',
            },
            resumability: 'resumable',
        })
        expect(Object.isFrozen(encoded.snapshot)).toBe(true)
        expect(encoded.snapshot).not.toHaveProperty('providerExecutionEnvelope')
    })

    it('optionally builds the reviewed Provider envelope from current execution authorities', () => {
        const sourceEdit = prepared({
            params: params({ sourceImage: 'data:image/png;base64,AA==' }),
            streaming: true,
            sourceEdit: true,
        })
        const resources = [{
            resourceId: 'resource:source',
            role: 'source' as const,
            persistence: 'managed-app-data' as const,
            digest: `sha256:${'b'.repeat(64)}`,
            reference: { relativePath: 'queue-resources/source.bin' } as JsonValue,
        }, {
            resourceId: 'resource:vibe',
            role: 'vibe-reference' as const,
            persistence: 'managed-app-data' as const,
            digest: `sha256:${'c'.repeat(64)}`,
            reference: { relativePath: 'queue-resources/vibe.bin' } as JsonValue,
        }]
        const compatibility = queryNaiGenerationCompatibility(
            sourceEdit.params,
            CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
            false,
        )
        const semanticIntentHash = `sha256:${'d'.repeat(64)}` as const

        const encoded = encodeMainJobSnapshot(
            sourceEdit,
            { ...dehydrated, resources },
            undefined,
            { compatibilityProfileId: compatibility.compatibilityProfileId, semanticIntentHash },
        )

        expect(encoded.snapshot.providerExecutionEnvelope).toEqual({
            schemaVersion: 1,
            provider: 'novelai',
            compatibilityProfileId: compatibility.compatibilityProfileId,
            payloadBuilderRevision: CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
            modelCatalogRevision: CURRENT_NAI_MODEL_CATALOG_REVISION,
            action: 'img2img',
            responseMode: 'standard',
            semanticIntentHash,
            queueResourceBindings: resources.map(({ resourceId, role, digest }) => ({
                resourceId, role, digest,
            })),
        })
    })

    it('fails closed when reviewed and fresh compatibility identities differ', () => {
        expect(() => encodeMainJobSnapshot(
            prepared(),
            dehydrated,
            undefined,
            {
                compatibilityProfileId: 'nai:stale-profile',
                semanticIntentHash: `sha256:${'d'.repeat(64)}`,
            },
        )).toThrowError(QueueExecutionError)
    })

    it('round-trips valid payloads and classifies malformed payloads as fatal', () => {
        const costConsent = createAnlasCostConsentSnapshot({
            pricingBasis: 'all-active-opus',
            estimatedAnlas: 0,
            maxAnlas: 0,
            estimatedAt: '2026-08-08T12:00:00.000Z',
            approvedAt: '2026-08-08T12:00:01.000Z',
        })
        const snapshot = encodeMainJobSnapshot(prepared({
            output: {
                autoSave: false,
                directory: 'Custom',
                useAbsolutePath: true,
                capabilityFallbackDirectory: 'Fallback',
                fileName: 'chosen.webp',
                collisionPolicy: 'overwrite',
            },
            imageFormat: 'webp',
        }), dehydrated, costConsent).snapshot

        expect(decodeMainJobSnapshot(snapshot)).toMatchObject({
            payloadBuilderRevision: CURRENT_NAI_PAYLOAD_BUILDER_REVISION,
            queueExecution: { streaming: true, sourceEdit: false },
            mainWorkflow: {
                imageFormat: 'webp',
                costConsent,
                output: { fileName: 'chosen.webp', collisionPolicy: 'overwrite' },
            },
        })

        const malformed = {
            ...snapshot,
            parameters: { queueExecution: { streaming: 'yes' } } as unknown as JsonValue,
        } satisfies GenerationJobSnapshot
        expect(() => decodeMainJobSnapshot(malformed)).toThrowError(QueueExecutionError)
        try {
            decodeMainJobSnapshot(malformed)
        } catch (error) {
            expect(error).toMatchObject({ kind: 'fatal' })
        }
    })

    it('migrates snapshots without a builder revision to the explicit legacy revision', () => {
        const snapshot = JSON.parse(JSON.stringify(
            encodeMainJobSnapshot(prepared(), dehydrated).snapshot,
        )) as GenerationJobSnapshot
        const parameters = snapshot.parameters as Record<string, unknown>
        delete parameters.payloadBuilderRevision

        expect(decodeMainJobSnapshot(snapshot).payloadBuilderRevision)
            .toBe(LEGACY_NAI_PAYLOAD_BUILDER_REVISION)
    })

    it('preserves an unknown well-formed revision for the executor compatibility pause', () => {
        const snapshot = JSON.parse(JSON.stringify(
            encodeMainJobSnapshot(prepared(), dehydrated).snapshot,
        )) as GenerationJobSnapshot
        const parameters = snapshot.parameters as Record<string, unknown>
        parameters.payloadBuilderRevision = 'future-wire-v99'

        expect(decodeMainJobSnapshot(snapshot).payloadBuilderRevision).toBe('future-wire-v99')
    })

    it('round-trips the captured generation folder and R2 target without consulting live settings', () => {
        const base = prepared()
        const snapshot = encodeMainJobSnapshot({
            ...base,
            metadataMode: 'strip-and-sidecar',
            output: {
                ...base.output,
                directory: 'D:\\Images\\Prime\\01',
                useAbsolutePath: true,
                generationFolderId: 'folder-01',
                generationFolderPath: 'Prime / 01',
                autoR2UploadProfileId: 'asset-profile-default-r2',
                r2Bucket: 'scene-bucket',
                r2Prefix: 'prime/bluehair/01',
            },
        }, dehydrated).snapshot

        const decoded = decodeMainJobSnapshot(snapshot)
        expect(decoded.mainWorkflow.output).toMatchObject({
            directory: 'D:\\Images\\Prime\\01',
            generationFolderId: 'folder-01',
            generationFolderPath: 'Prime / 01',
            autoR2UploadProfileId: 'asset-profile-default-r2',
            r2Bucket: 'scene-bucket',
            r2Prefix: 'prime/bluehair/01',
        })
        expect(decoded.mainWorkflow.r2Delivery).toEqual({ requirement: 'best-effort', planned: null })

        const legacy = JSON.parse(JSON.stringify(snapshot)) as GenerationJobSnapshot
        delete (legacy.parameters as unknown as { mainWorkflow: { r2Delivery?: unknown } })
            .mainWorkflow.r2Delivery
        expect(decodeMainJobSnapshot(legacy).mainWorkflow.r2Delivery).toEqual({
            requirement: 'best-effort', planned: null,
        })

        const malformed = JSON.parse(JSON.stringify(snapshot)) as GenerationJobSnapshot
        const parameters = malformed.parameters as Record<string, unknown>
        const workflow = parameters.mainWorkflow as { output: { r2Bucket: string } }
        workflow.output.r2Bucket = 'Invalid_Bucket'
        expect(() => decodeMainJobSnapshot(malformed)).toThrowError(QueueExecutionError)
    })

    it('round-trips a strict current R2 binding and rejects unsafe or contradictory variants', () => {
        const delivery = currentR2Delivery()
        const snapshot = encodeMainJobSnapshot(prepared(), dehydrated, undefined, undefined, delivery).snapshot
        expect(decodeMainJobSnapshot(snapshot).mainWorkflow.r2Delivery).toEqual(delivery)

        const overwrite = JSON.parse(JSON.stringify(snapshot)) as GenerationJobSnapshot
        const overwriteDelivery = (overwrite.parameters as unknown as {
            mainWorkflow: { r2Delivery: { planned: { profile: { conflictPolicy: string } } } }
        }).mainWorkflow.r2Delivery
        overwriteDelivery.planned.profile.conflictPolicy = 'overwrite'
        expect(() => decodeMainJobSnapshot(overwrite)).toThrowError(QueueExecutionError)

        const secret = JSON.parse(JSON.stringify(snapshot)) as GenerationJobSnapshot
        const secretPlanned = (secret.parameters as unknown as {
            mainWorkflow: { r2Delivery: { planned: Record<string, unknown> } }
        }).mainWorkflow.r2Delivery.planned
        secretPlanned.secretAccessKey = 'prohibited'
        expect(() => decodeMainJobSnapshot(secret)).toThrowError(QueueExecutionError)

        const contradictory = JSON.parse(JSON.stringify(encodeMainJobSnapshot({
            ...prepared(),
            output: { ...prepared().output, autoR2UploadProfileId: 'profile-1' },
        }, dehydrated).snapshot)) as GenerationJobSnapshot
        const workflow = (contradictory.parameters as unknown as {
            mainWorkflow: { r2Delivery: R2QueueDeliverySnapshot }
        }).mainWorkflow
        workflow.r2Delivery = { requirement: 'disabled', planned: null }
        expect(() => decodeMainJobSnapshot(contradictory)).toThrowError(QueueExecutionError)

        const notReadyProfile = currentR2Delivery('')
        const notReadySnapshot = encodeMainJobSnapshot(
            prepared(), dehydrated, undefined, undefined, notReadyProfile,
        ).snapshot
        expect(decodeMainJobSnapshot(notReadySnapshot).mainWorkflow.r2Delivery).toEqual(notReadyProfile)
    })

    it('keeps passive bucket/prefix config disabled and rejects legacy best-effort without activation', () => {
        const passive = encodeMainJobSnapshot({
            ...prepared(),
            output: {
                ...prepared().output,
                autoR2UploadProfileId: null,
                r2Bucket: 'release-bucket',
                r2Prefix: 'generated/images',
            },
        }, dehydrated).snapshot
        expect(decodeMainJobSnapshot(passive).mainWorkflow.r2Delivery).toEqual({
            requirement: 'disabled', planned: null,
        })

        const silentDrop = JSON.parse(JSON.stringify(passive)) as GenerationJobSnapshot
        const workflow = (silentDrop.parameters as unknown as {
            mainWorkflow: { r2Delivery: R2QueueDeliverySnapshot }
        }).mainWorkflow
        workflow.r2Delivery = { requirement: 'best-effort', planned: null }
        expect(() => decodeMainJobSnapshot(silentDrop)).toThrowError(QueueExecutionError)
    })
})
