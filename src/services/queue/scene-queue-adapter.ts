import type {
    OutputCommitSetReservation,
    QueueBatchOrigin,
    QueueResourceRecord,
} from '@/domain/queue/types'
import { canonicalSerialize, hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import { calculateAnlasCost, resolveAnlasPricingBasis } from '@/lib/anlas-calculator'
import { createAnlasCostConsentSnapshot } from '@/domain/queue/anlas-cost-consent'
import { selectActiveCredentialsAreOpus, useAuthStore } from '@/stores/auth-store'
import { createGenerationFolderDocumentBinding } from '@/application/folder/generation-folder-binding'
import type { SceneAuthoringRecord, SceneDocument } from '@/application/scene/scene-repository'
import {
    createSceneGenerationBinding,
    planSceneBatch,
    resolveRepositorySceneBatchTargets,
    sceneGenerationBindingMatches,
    type SceneBatchRequest,
    type PlannedSceneBatchJob,
} from '@/application/scene/plan-scene-batch'
import { getRuntimeSceneRepository } from '@/lib/scene-migration-startup'
import { IndexedDbGenerationFolderRepository } from '@/adapters/folder/indexeddb-generation-folder-repository'
import { DEFAULT_GENERATION_FOLDER_WORKSPACE_ID } from '@/lib/generation-folder-authority-runtime'
import { resolveGenerationFolderAuthority } from '@/lib/generation-folder-authority-runtime'
import { DEFAULT_R2_PROFILE_ID } from '@/domain/r2/types'
import { buildSceneGenerationParams } from '@/lib/scene-generation/build-scene-params'
import type { SaveSceneResultContext } from '@/lib/scene-generation/save-scene-result'
import { getRotationCharacterFolderName } from '@/lib/scene-output-path'
import { useCharacterStore } from '@/stores/character-store'
import { useQueueStore } from '@/stores/queue-store'
import { useRotationStore } from '@/stores/character-rotation-store'
import {
    getScenePresetPathSegments,
    resolveSceneGeneration,
    useSceneStore,
    type SceneCard,
    type SceneCompositionRuntimeRecord,
    type ScenePreset,
} from '@/stores/scene-store'
import { useSettingsStore } from '@/stores/settings-store'
import { generationFolderDocumentMutationKey } from '@/application/workspace/workspace-mutation-gate'
import { runtimeWorkspaceMutationGate } from '@/lib/workspace-mutation-gate'
import { QueueExecutionError } from './durable-queue-coordinator'
import {
    assertGenerationAtomicBatchAvailable,
    getRuntimeQueueRepository,
    type CreateBatchAndEnqueueResult,
    type EnqueueGenerationJobInput,
} from './indexeddb-queue-repository'
import { runtimeCapabilities } from '@/platform/capabilities'
import {
    encodeSceneJobSnapshot,
    type SceneQueueWorkflowSnapshot,
} from './scene-job-snapshot-codec'
import {
    dehydrateGenerationParams,
    getRuntimeQueueResourceMaterializer,
    type DehydratedGenerationResult,
    type MaterializedQueueResource,
} from './queue-resource-materializer'
import { gateGenerationFolderAutoUpload, getDefaultR2Readiness } from '@/services/r2/readiness'
import { ensureImageFileExtension, renderFilenameTemplate } from '@/services/output/filename-policy'
import { getRuntimeMainQueueDependencies } from './main-queue-runtime-dependencies'
import { bindOutputReservationSnapshot } from './job-snapshot'
import type { OutputWriterDestination } from '@/services/output/output-writer'
import {
    assertExactOutputCommitSetAllocation,
    generationOutputClaimKinds,
    outputFilesystemSemantics,
} from '@/services/output/generation-output-commit-set'

// Queue Center passes explicit folder/scene/count tuples; this boundary keeps
// selection UI concerns out of snapshot creation and makes each job retain the
// correct output folder even when that folder is not currently active.
export interface SceneQueueTarget {
    readonly presetId: string
    readonly sceneId: string
    readonly count: number
    /** Optional caller-observed repository revision; stale callers fail the whole request. */
    readonly expectedRevision?: number
    readonly fileNames?: readonly string[]
}

interface ResolvedSceneQueueTarget {
    readonly target: SceneQueueTarget
    readonly preset: ScenePreset
    readonly scene: SceneCard
    readonly document: SceneDocument
}

function projectRepositoryScene(scene: SceneAuthoringRecord): SceneCard {
    const generation = scene.generation === undefined
        ? undefined
        : { ...scene.generation, smea: false as const, smeaDyn: false as const } as SceneCard['generation']
    return {
        ...structuredClone(scene) as unknown as SceneCard,
        ...(generation === undefined ? {} : { generation: { ...generation } }),
        queueCount: 0,
        images: [],
    }
}

interface PreparedSceneQueueJob {
    readonly scene: { readonly id: string; readonly name: string }
    readonly params: import('@/services/novelai-types').GenerationParams
    readonly finalPrompt: string
    readonly mimeType: string
    readonly saveContext: SaveSceneResultContext
    readonly outputContext: SceneQueueWorkflowSnapshot['outputContext']
    readonly sequenceCommitProposal: Parameters<typeof encodeSceneJobSnapshot>[0]['sequenceCommitProposal']
    readonly planHash: Parameters<typeof encodeSceneJobSnapshot>[0]['planHash']
    readonly sceneBinding: import('@/application/scene/plan-scene-batch').SceneGenerationBinding
    readonly costConsent: import('@/domain/queue/anlas-cost-consent').AnlasCostConsentSnapshot
    readonly dehydrated: Pick<DehydratedGenerationResult, 'parameters' | 'resources'>
    readonly imageFormat: 'png' | 'webp'
    readonly destination: OutputWriterDestination
    readonly compositionResult: SceneCompositionRuntimeRecord
}

function exactSceneFileName(value: string, extension: 'png' | 'webp'): string {
    const fileName = ensureImageFileExtension(value.trim(), extension)
    if (fileName === null
        || fileName.length === 0
        || fileName.length > 255
        || /[\\/\r\n]/.test(fileName)) {
        throw new QueueExecutionError('fatal', 'Scene output filename is not a safe exact destination')
    }
    return fileName
}

function planSceneFileName(input: {
    readonly targetFileName?: string
    readonly scene: SceneCard
    readonly preset: ScenePreset
    readonly params: { readonly imageFormat?: string; readonly seed: number; readonly assetModulePlan?: { readonly output: { readonly fileName?: string } } }
    readonly ordinal: number
    readonly now: Date
}): string {
    const extension = input.params.imageFormat === 'webp' ? 'webp' : 'png'
    const requested = input.targetFileName?.trim()
    if (requested) return exactSceneFileName(requested, extension)
    const fallback = `NAI_Blue_SCENE_${input.preset.id}_${input.scene.id}_${input.ordinal}`
    const template = input.scene.filenameTemplate?.trim()
    const rendered = template
        ? renderFilenameTemplate({
            template,
            context: {
                seed: input.params.seed,
                scene: { id: input.scene.id, name: input.scene.name },
                preset: { id: input.preset.id, name: input.preset.name },
            },
            now: input.now,
            fallback,
        })
        : input.params.assetModulePlan?.output.fileName ?? fallback
    return exactSceneFileName(rendered, extension)
}

function normalizeSceneQueueTargets(targets: readonly SceneQueueTarget[]): SceneQueueTarget[] {
    if (targets.length === 0) return []
    const generationLimits = runtimeCapabilities.generationPublication.generationLimits
    assertGenerationAtomicBatchAvailable(
        targets.reduce((total, target) => total + target.count, 0),
        0,
        generationLimits,
    )
    const normalized = new Map<string, SceneQueueTarget>()
    for (const target of targets) {
        if (!Number.isSafeInteger(target.count) || target.count < 1) {
            throw new QueueExecutionError('fatal', 'Scene queue count must be a positive integer')
        }
        const count = target.count
        const key = `${target.presetId}:${target.sceneId}`
        const previous = normalized.get(key)
        if (previous?.expectedRevision !== undefined
            && target.expectedRevision !== undefined
            && previous.expectedRevision !== target.expectedRevision) {
            throw new QueueExecutionError('fatal', `Scene target revisions conflict for ${key}`)
        }
        const fileNames = [
            ...(previous?.fileNames ?? []),
            ...Array.from({ length: count }, (_, index) => target.fileNames?.[index]?.trim() ?? ''),
        ]
        normalized.set(key, {
            presetId: target.presetId,
            sceneId: target.sceneId,
            count: (previous?.count ?? 0) + count,
            ...((target.expectedRevision ?? previous?.expectedRevision) === undefined
                ? {}
                : { expectedRevision: target.expectedRevision ?? previous?.expectedRevision }),
            ...(fileNames.some(Boolean) ? { fileNames } : {}),
        })
    }
    return [...normalized.values()]
}

export function enqueueCurrentSceneQueue(): Promise<CreateBatchAndEnqueueResult | null> {
    const sceneState = useSceneStore.getState()
    const presetId = sceneState.activePresetId
    const preset = sceneState.presets.find(candidate => candidate.id === presetId)
    if (presetId === null || preset === undefined) return Promise.resolve(null)
    const targets = sceneState.getQueuedScenes(presetId).map(scene => ({
        presetId,
        sceneId: scene.id,
        count: scene.queueCount,
        ...(scene.queuedFileNames === undefined
            ? {}
            : { fileNames: scene.queuedFileNames.slice(0, scene.queueCount) }),
    }))
    return enqueueSceneQueueTargets(targets, {
        origin: 'legacy-conversion',
        consumePendingEntries: true,
    })
}

export function enqueueSceneQueueTargets(
    targets: readonly SceneQueueTarget[],
    options: { origin?: QueueBatchOrigin; consumePendingEntries?: boolean } = {},
): Promise<CreateBatchAndEnqueueResult | null> {
    const normalizedTargets = normalizeSceneQueueTargets(targets)
    if (normalizedTargets.length === 0) return Promise.resolve(null)
    return enqueueSceneQueueTargetsOnce(
        normalizedTargets,
        options.origin ?? 'fresh',
        options.consumePendingEntries === true,
    )
}

async function enqueueSceneQueueTargetsOnce(
    targets: readonly SceneQueueTarget[],
    origin: QueueBatchOrigin,
    consumePendingEntries: boolean,
): Promise<CreateBatchAndEnqueueResult | null> {
    const operationId = useQueueStore.getState().beginEnqueueOperation('scene')
    try {
        const sceneState = useSceneStore.getState()
        const settings = useSettingsStore.getState()
        const folderRepository = new IndexedDbGenerationFolderRepository()
        const folderDocument = await folderRepository.getDocument(DEFAULT_GENERATION_FOLDER_WORKSPACE_ID)
        if (folderDocument === null) {
            throw new QueueExecutionError('fatal', 'Generation folder authority is not ready')
        }
        const folderBinding = createGenerationFolderDocumentBinding(folderDocument)
        const sceneRepository = getRuntimeSceneRepository()
        const repositorySources = await resolveRepositorySceneBatchTargets(sceneRepository, targets)
            .catch(error => {
                throw new QueueExecutionError('fatal', error instanceof Error ? error.message : 'Scene authority is unavailable')
            })
        const authorityByPreset = new Map(repositorySources.map(source => [source.document.presetId, source.document]))
        const selected: ResolvedSceneQueueTarget[] = repositorySources.map(({ document, scene: source }, index) => {
            const target = targets[index]
            const projectedPreset = sceneState.presets.find(candidate => candidate.id === target.presetId)
            const preset: ScenePreset = projectedPreset ?? {
                id: target.presetId,
                name: target.presetId,
                scenes: [],
                createdAt: 0,
            }
            return { target, preset, scene: projectRepositoryScene(source), document }
        })
        const requestedDay = new Date().toISOString().slice(0, 10)
        const canonicalRequestHash = `sha256:${hashCanonicalValue({
            schemaVersion: 1,
            // The persisted operation id is the idempotency nonce: concurrent
            // or crash-replayed submissions share it, while a later user action
            // must be allowed to enqueue the same Scene again.
            enqueueOperationId: operationId,
            requestedDay,
            folderBinding,
            targets: selected.map(({ target, document }) => ({
                presetId: target.presetId,
                sceneId: target.sceneId,
                count: target.count,
                fileNames: target.fileNames ?? [],
                repositoryRevision: document.revision,
            })),
        })}`
        const planningNow = new Date(`${requestedDay}T00:00:00.000Z`)
        planningNow.setUTCMilliseconds(Number.parseInt(canonicalRequestHash.slice(7, 15), 16) % 86_400_000)
        const r2ReadinessByProfile = new Map<string, ReturnType<typeof getDefaultR2Readiness>>()
        const readR2Profile = (profileId: string) => {
            let pending = r2ReadinessByProfile.get(profileId)
            if (pending === undefined) {
                pending = getDefaultR2Readiness(profileId)
                r2ReadinessByProfile.set(profileId, pending)
            }
            return pending
        }
        const rotation = useRotationStore.getState()
        const rotationCharacterId = rotation.active && rotation.snapshot
            ? rotation.characterIds[rotation.currentIndex]
            : undefined
        const materializer = getRuntimeQueueResourceMaterializer()
        const resourceCache = new Map<string, Promise<MaterializedQueueResource>>()
        const resources = new Map<string, QueueResourceRecord>()
        // One enqueue operation must use one credential-tier pricing authority;
        // reading auth per image could otherwise mix consent bases mid-batch.
        const activeCredentialsAreOpus = selectActiveCredentialsAreOpus(useAuthStore.getState())
        const prepared: Array<Omit<PlannedSceneBatchJob<PreparedSceneQueueJob>, 'ordinal'>> = []

        for (const { target, preset, scene } of selected) {
            const document = authorityByPreset.get(preset.id)
            const sceneBinding = document === undefined
                ? null
                : createSceneGenerationBinding(document, scene.id)
            if (sceneBinding === null) {
                throw new QueueExecutionError('fatal', `Scene authority is missing ${preset.id}:${scene.id}`)
            }
            const preliminaryFolder = resolveGenerationFolderAuthority(
                folderDocument,
                settings.generationFolders,
                scene.generationFolderId,
                {
                    directory: settings.sceneSavePath,
                    useAbsolutePath: settings.useAbsoluteScenePath,
                },
            )
            const requestedProfileId = preliminaryFolder?.r2.profileId ?? DEFAULT_R2_PROFILE_ID
            const r2Readiness = preliminaryFolder?.r2.autoUpload
                ? await readR2Profile(requestedProfileId)
                : null
            const baseR2Profile = r2Readiness?.status === 'ready' ? r2Readiness.profile : null
            const resolvedFolder = resolveGenerationFolderAuthority(
                folderDocument,
                settings.generationFolders,
                scene.generationFolderId,
                {
                    directory: settings.sceneSavePath,
                    useAbsolutePath: settings.useAbsoluteScenePath,
                    r2ProfileId: baseR2Profile?.id,
                    r2Bucket: baseR2Profile?.bucket,
                    r2Prefix: baseR2Profile?.prefix,
                },
            )
            const generationFolder = gateGenerationFolderAutoUpload(
                resolvedFolder,
                r2Readiness?.status === 'ready',
            )
            const saveContext: SaveSceneResultContext = {
                activePresetId: preset.id,
                sceneSavePath: settings.sceneSavePath,
                ...(rotationCharacterId === undefined ? {} : { rotationCharacterId }),
                ...(rotationCharacterId === undefined
                    ? {}
                    : {
                        rotationCharacterFolderName: getRotationCharacterFolderName(
                            rotationCharacterId,
                            rotation.currentIndex,
                        ) ?? undefined,
                    }),
            }
            const directory = generationFolder?.directory ?? settings.sceneSavePath
            const capabilityFallbackDirectory = generationFolder?.useAbsolutePath
                ? 'NAI_Blue_Scene'
                : generationFolder?.directory ?? settings.sceneSavePath
            const outputContextBase: SceneQueueWorkflowSnapshot['outputContext'] = {
                useAbsoluteScenePath: generationFolder?.useAbsolutePath ?? settings.useAbsoluteScenePath,
                metadataMode: generationFolder?.r2.autoUpload
                    ? 'strip-and-sidecar'
                    : scene.metadataMode ?? settings.metadataMode,
                presetName: preset.name || 'Default',
                presetPathSegments: getScenePresetPathSegments(sceneState.presets, preset.id),
                sceneName: scene.name,
                sceneSubfoldersEnabled: settings.sceneSubfoldersEnabled,
                directory,
                capabilityFallbackDirectory,
                ...(generationFolder === null
                    ? {}
                    : {
                        generationFolderId: generationFolder.id,
                        generationFolderPath: generationFolder.path,
                        autoR2UploadProfileId: generationFolder.r2.autoUpload
                            ? generationFolder.r2.profileId ?? DEFAULT_R2_PROFILE_ID
                            : null,
                        r2Bucket: generationFolder.r2.bucket,
                        r2Prefix: generationFolder.r2.prefix,
                    }),
            }
            for (let count = 0; count < target.count; count += 1) {
                const ordinal = prepared.length
                const now = planningNow
                const generation = resolveSceneGeneration(scene)
                // Seed selection is pure here; the Zustand seed is consumed only after
                // the repository commits the complete batch and its reservations.
                const seed = generation.seedLocked
                    ? generation.seed
                    : Number.parseInt(hashCanonicalValue({ canonicalRequestHash, presetId: preset.id, sceneId: scene.id, count }).slice(0, 8), 16) >>> 0
                const built = await buildSceneGenerationParams(scene, {
                    requestId: `durable-enqueue:${canonicalRequestHash.slice(7, 39)}:${preset.id}:${scene.id}:${count}`,
                    now,
                    presetId: preset.id,
                    generationFolder,
                    seed,
                })
                if (!built.success) {
                    throw new QueueExecutionError('fatal', 'Scene composition plan is invalid')
                }
                const fileName = planSceneFileName({
                    targetFileName: target.fileNames?.[count],
                    scene,
                    preset,
                    params: built.params,
                    ordinal,
                    now,
                })
                const outputContext = { ...outputContextBase, fileName }
                const dehydrated = await dehydrateGenerationParams(built.params, materializer, resourceCache)
                for (const record of dehydrated.records) resources.set(record.id, record)
                const pricingBasis = resolveAnlasPricingBasis({
                    model: built.params.model,
                    activeCredentialsAreOpus,
                })
                const estimatedAnlas = calculateAnlasCost({
                    model: built.params.model,
                    width: built.params.width,
                    height: built.params.height,
                    steps: built.params.steps,
                    imageCount: 1,
                    pricingBasis,
                })
                const costConsent = createAnlasCostConsentSnapshot({
                    pricingBasis,
                    estimatedAnlas,
                    maxAnlas: estimatedAnlas,
                    estimatedAt: now.toISOString(),
                    approvedAt: now.toISOString(),
                })
                prepared.push({
                    presetId: preset.id,
                    sceneId: scene.id,
                    seed,
                    fileName,
                    sceneBinding,
                    estimatedAnlas,
                    prepared: {
                        scene: { id: scene.id, name: scene.name },
                        params: built.params,
                        finalPrompt: built.finalPrompt,
                        mimeType: built.mimeType,
                        saveContext,
                        outputContext,
                        sequenceCommitProposal: built.sequenceCommitProposal,
                        planHash: built.planHash,
                        sceneBinding,
                        costConsent,
                        dehydrated: {
                            parameters: dehydrated.parameters,
                            resources: dehydrated.resources,
                        },
                        imageFormat: built.mimeType === 'image/webp' ? 'webp' : 'png',
                        destination: {
                            directory,
                            useAbsolutePath: outputContext.useAbsoluteScenePath,
                            capabilityFallbackDirectory,
                            workflowDefaultDirectory: 'NAI_Blue_Scene',
                            extension: built.mimeType === 'image/webp' ? 'webp' : 'png',
                            fileName,
                            collisionPolicy: 'error',
                        },
                        compositionResult: {
                            mode: built.mode,
                            ...(built.planHash === null ? {} : { planHash: built.planHash }),
                            warnings: built.warnings,
                            errors: built.errors,
                        },
                    },
                })
            }
        }

        // Re-read the authoritative documents after composition/resource work so
        // a Scene edit that lands during enqueue cannot be paired with old output.
        const currentAuthorityByPreset = new Map<string, SceneDocument>()
        for (const presetId of authorityByPreset.keys()) {
            const document = await sceneRepository.getDocument(presetId)
            if (document === null) {
                throw new QueueExecutionError('fatal', `Scene authority disappeared for preset ${presetId}`)
            }
            currentAuthorityByPreset.set(presetId, document)
        }
        if (prepared.some(item => {
            const current = currentAuthorityByPreset.get(item.presetId)
            return current === undefined
                || !sceneGenerationBindingMatches(item.sceneBinding, current, item.sceneId)
        })) {
            throw new QueueExecutionError('fatal', 'Scene document changed before Queue reservation')
        }
        const plans = new Map<string, ReturnType<typeof planSceneBatch<PreparedSceneQueueJob>>>()
        for (const [presetId, authority] of authorityByPreset) {
            const presetPrepared = prepared.filter(item => item.presetId === presetId)
            if (presetPrepared.length === 0) continue
            const request: SceneBatchRequest = {
                actor: { kind: 'user', id: 'scene-queue' },
                preset: { id: presetId, expectedRevision: authority.revision },
                items: selected
                    .filter(item => item.preset.id === presetId)
                    .map(({ target }) => ({ sceneId: target.sceneId, count: target.count })),
                seedPolicy: { kind: 'replay', traceId: `scene-seeds:${canonicalRequestHash.slice(7, 39)}:${presetId}` },
                execution: { failurePolicy: 'continue' },
                budget: {
                    maxImages: presetPrepared.length,
                    maxAnlas: presetPrepared.reduce((total, item) => total + item.estimatedAnlas, 0),
                },
            }
            plans.set(presetId, planSceneBatch({ folderBinding, request, jobs: presetPrepared }))
        }
        const requestIdentity = canonicalRequestHash.slice('sha256:'.length)
        const batchId = `scene-batch-${requestIdentity}`
        const createdAt = planningNow.toISOString()
        const jobs: EnqueueGenerationJobInput[] = []
        const reservations: OutputCommitSetReservation[] = []
        const dependencies = getRuntimeMainQueueDependencies()
        const assertCurrentFolderBinding = async (): Promise<void> => {
            const currentDocument = await folderRepository.getDocument(DEFAULT_GENERATION_FOLDER_WORKSPACE_ID)
            const current = currentDocument === null ? null : createGenerationFolderDocumentBinding(currentDocument)
            if (current === null || canonicalSerialize(current) !== canonicalSerialize(folderBinding)) {
                throw new QueueExecutionError('fatal', 'Generation folder changed before Queue reservation')
            }
        }
        const generationLimits = runtimeCapabilities.generationPublication.generationLimits
        const plannedClaimCount = prepared.reduce((total, item) => total + generationOutputClaimKinds({
            fileName: item.fileName,
            imageFormat: item.prepared.imageFormat,
            metadataMode: item.prepared.outputContext.metadataMode,
            preserveProviderOriginal: item.prepared.outputContext.autoR2UploadProfileId != null
                && item.prepared.outputContext.metadataMode === 'strip-and-sidecar',
        }).length, 0)
        assertGenerationAtomicBatchAvailable(prepared.length, plannedClaimCount, generationLimits)
        const allocationRequests = prepared.map((item, ordinal) => ({
            destination: item.prepared.destination,
            claimPlan: {
                fileName: item.fileName,
                imageFormat: item.prepared.imageFormat,
                metadataMode: item.prepared.outputContext.metadataMode,
                preserveProviderOriginal: item.prepared.outputContext.autoR2UploadProfileId != null
                    && item.prepared.outputContext.metadataMode === 'strip-and-sidecar',
            },
            collisionPolicy: 'fail' as const,
            directoryAuthorityId: folderBinding.resourceId,
            folderBinding,
            reservationIdentity: {
                reservationId: `output-reservation:scene-job-${requestIdentity}-${ordinal}`,
                batchId,
                jobId: `scene-job-${requestIdentity}-${ordinal}`,
            },
        }))
        const allocations = await dependencies.outputReservations.planBatch(allocationRequests)
        if (allocations.length !== prepared.length) {
            throw new QueueExecutionError('fatal', 'Scene output allocation did not preserve the requested count')
        }
        await assertCurrentFolderBinding()
        let queueOrdinal = 0
        // Keep the caller's target order while attaching each job to its
        // preset-local durable sub-plan.
        for (const item of prepared) {
            const plan = plans.get(item.presetId)
            if (plan === undefined) {
                throw new QueueExecutionError('fatal', `Scene sub-plan is missing for preset ${item.presetId}`)
            }
            // Sub-plan ordinals are local to each preset; Queue IDs and ordering
            // must remain unique across the one atomic batch.
            const ordinal = queueOrdinal++
            const jobId = `scene-job-${requestIdentity}-${ordinal}`
            const allocation = allocations[ordinal]
            if (allocation.fileName !== item.fileName) {
                throw new QueueExecutionError('fatal', 'Scene output preflight changed the exact filename')
            }
            assertExactOutputCommitSetAllocation({
                ...allocationRequests[ordinal].claimPlan,
                collisionPolicy: 'fail',
                directoryAuthorityId: folderBinding.resourceId,
            }, allocation, outputFilesystemSemantics())
            const { commitSet, commitSetHash } = allocation
            const reservationId = `output-reservation:${jobId}`
            const reservation: OutputCommitSetReservation = {
                reservationSchemaVersion: 1,
                reservationId,
                batchId,
                jobId,
                folderBinding: plan.folderBinding,
                directoryIdentity: allocation.directoryIdentity,
                relativePath: item.fileName,
                collisionPolicy: 'fail',
                expectedExistingDigest: null,
                commitSet,
                commitSetHash,
                state: 'reserved',
                version: 1,
                updatedAt: createdAt,
            }
            const {
                batchId: _batchId,
                jobId: _jobId,
                state: _state,
                version: _version,
                updatedAt: _updatedAt,
                ...reservationSnapshot
            } = reservation
            const destinationBoundPlanHash: `sha256:${string}` = `sha256:${hashCanonicalValue({
                scenePlanHash: plan.planHash,
                outputCommitSetHash: commitSetHash,
            })}`
            const encoded = encodeSceneJobSnapshot({
                scene: item.prepared.scene,
                params: item.prepared.params,
                finalPrompt: item.prepared.finalPrompt,
                mimeType: item.prepared.mimeType,
                saveContext: item.prepared.saveContext,
                outputContext: item.prepared.outputContext,
                streaming: settings.useStreaming,
                sequenceCommitProposal: item.prepared.sequenceCommitProposal,
                planHash: item.prepared.planHash,
                sceneBinding: item.sceneBinding,
                batch: {
                    request: plan.request,
                    count: plan.count,
                    estimatedAnlas: plan.estimatedAnlas,
                    planHash: destinationBoundPlanHash,
                },
                costConsent: item.prepared.costConsent,
            }, item.prepared.dehydrated)
            const snapshot = bindOutputReservationSnapshot(encoded.snapshot, reservationSnapshot)
            jobs.push({
                id: jobId,
                batchId,
                workflow: 'scene',
                sceneId: item.sceneId,
                createdAt,
                priority: 0,
                ordinal,
                snapshot,
                compositionPlanHash: destinationBoundPlanHash,
                maxAttempts: 3,
                idempotencyKey: `scene-enqueue-${requestIdentity}-${ordinal}`,
            })
            reservations.push(reservation)
        }
        const result = await runtimeWorkspaceMutationGate.runExclusive(
            generationFolderDocumentMutationKey(folderBinding.resourceId),
            async () => {
                await assertCurrentFolderBinding()
                const finalAuthorityByPreset = new Map<string, SceneDocument>()
                for (const presetId of authorityByPreset.keys()) {
                    const document = await sceneRepository.getDocument(presetId)
                    if (document === null) {
                        throw new QueueExecutionError('fatal', `Scene authority disappeared for preset ${presetId}`)
                    }
                    finalAuthorityByPreset.set(presetId, document)
                }
                if (prepared.some(item => {
                    const current = finalAuthorityByPreset.get(item.presetId)
                    return current === undefined
                        || !sceneGenerationBindingMatches(item.sceneBinding, current, item.sceneId)
                })) {
                    throw new QueueExecutionError('fatal', 'Scene document changed before atomic Queue enqueue')
                }
                assertGenerationAtomicBatchAvailable(
                    jobs.length,
                    reservations.reduce((total, reservation) => (
                        total + (reservation.reservationSchemaVersion === 1 ? reservation.commitSet.claims.length : 0)
                    ), 0),
                    generationLimits,
                )
                return getRuntimeQueueRepository().createBatchAndEnqueue({
                    batch: {
                        id: batchId,
                        workflow: 'scene',
                        createdAt,
                        failurePolicy: 'continue',
                        origin,
                        idempotencyKey: `scene-enqueue-${requestIdentity}`,
                    },
                    jobs,
                    resources: [...resources.values()],
                    reservations,
                })
            },
        )
        // Queue pending entries and seed advancement are presentation side effects;
        // both happen only after the atomic repository transaction succeeds.
        if (consumePendingEntries) {
            for (const { target } of selected) {
                useSceneStore.getState().consumeSceneQueueEntries(target.presetId, target.sceneId, target.count)
            }
        }
        for (const item of prepared) {
            useSceneStore.getState().recordSceneCompositionResult(item.sceneId, item.prepared.compositionResult)
        }
        for (const { preset, scene } of selected) {
            for (let count = 0; count < (targets.find(target => target.presetId === preset.id && target.sceneId === scene.id)?.count ?? 0); count += 1) {
                useSceneStore.getState().consumeSceneGenerationSeed(preset.id, scene.id)
            }
        }
        return result
    } finally {
        useCharacterStore.getState().releaseImageData()
        useQueueStore.getState().completeEnqueueOperation('scene', operationId)
    }
}
