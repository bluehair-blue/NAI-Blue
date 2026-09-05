import type {
    OutputCommitSetReservation,
    QueueBatchOrigin,
    QueueResourceRecord,
} from '@/domain/queue/types'
import { canonicalSerialize, hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import { calculateAnlasCost, resolveAnlasPricingBasis } from '@/lib/anlas-calculator'
import {
    approveSceneQueueCostEstimates,
    assertSceneQueueReviewCondition,
    createSceneQueueResourcePlan,
    materializeApprovedSceneQueueResources,
    SceneQueueApprovalRegistry,
    SceneQueueReviewConflict,
    type SceneQueueCostEstimate,
    type SceneQueueReplanIssue,
    type SceneQueueResourcePlan,
} from '@/application/scene/scene-queue-review'
export { SceneQueueReviewConflict }
export type { SceneQueueReplanIssue }
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
import { parseAssessmentRequirement, type GenerationAssessmentRequirement } from '@/domain/assessment/visual-rubric'
import type { IntentAssessmentRunBinding } from '@/domain/assessment/intent-assessment'
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
    type MaterializedQueueResource,
} from './queue-resource-materializer'
import { ensureImageFileExtension, renderFilenameTemplate } from '@/services/output/filename-policy'
import {
    getRuntimeMainQueueDependencies,
    type OutputCommitSetPlanningRequest,
    type PlannedOutputCommitSet,
} from './main-queue-runtime-dependencies'
import { bindOutputReservationSnapshot } from './job-snapshot'
import type { OutputWriterDestination } from '@/services/output/output-writer'
import {
    assertExactOutputCommitSetAllocation,
    generationOutputClaimKinds,
    outputFilesystemSemantics,
} from '@/services/output/generation-output-commit-set'
import { planR2Release, revalidateR2Release } from '@/application/r2/plan-r2-release'
import type { PlannedR2Destination, R2DeliveryRequirement, R2DestinationProvenance, R2ProfileV2, R2QueueDeliverySnapshot } from '@/domain/r2/types'

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
    /** Reviewed per-target policy, frozen into each generated job and review identity. */
    readonly r2Requirement?: R2DeliveryRequirement
}

export interface SceneQueueFilenameSummary {
    readonly kind: 'filenames' | 'range'
    readonly filenames?: readonly string[]
    readonly first?: string
    readonly last?: string
    readonly count: number
}

export interface SceneQueueDestinationReview {
    readonly logicalFolderLabel: string
    readonly imageCount: number
    readonly claimCount: number
    readonly filenameSummary: SceneQueueFilenameSummary
}

export interface SceneQueueReview {
    readonly assessment?: GenerationAssessmentRequirement
    readonly reviewId: string
    readonly sceneCount: number
    readonly imageCount: number
    readonly estimatedAnlas: number
    readonly maxAnlas: number
    readonly claimCount: number
    readonly destinations: readonly SceneQueueDestinationReview[]
    readonly r2Destinations: readonly PlannedR2Destination[]
}

declare const sceneQueueSubmissionBrand: unique symbol
export interface SceneQueueSubmission {
    readonly reviewId: string
    readonly [sceneQueueSubmissionBrand]: true
}

export interface PreparedSceneQueueReview {
    readonly review: SceneQueueReview
    readonly submission: SceneQueueSubmission
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
    readonly costEstimate: SceneQueueCostEstimate
    readonly imageFormat: 'png' | 'webp'
    readonly destination: OutputWriterDestination
    readonly compositionResult: SceneCompositionRuntimeRecord
    readonly reviewDestinationKey: string
    readonly reviewDestinationLabel: string
    readonly r2Requirement: R2DeliveryRequirement
    readonly r2Provenance?: R2DestinationProvenance
}

interface SceneQueueSubmissionData {
    readonly intentAssessment?: IntentAssessmentRunBinding
    readonly submission: SceneQueueSubmission
    readonly review: SceneQueueReview
    readonly selected: readonly ResolvedSceneQueueTarget[]
    readonly targets: readonly SceneQueueTarget[]
    readonly origin: QueueBatchOrigin
    readonly consumePendingEntries: boolean
    readonly folderRepository: IndexedDbGenerationFolderRepository
    readonly folderBinding: ReturnType<typeof createGenerationFolderDocumentBinding>
    readonly sceneRepository: ReturnType<typeof getRuntimeSceneRepository>
    readonly authorityByPreset: ReadonlyMap<string, SceneDocument>
    readonly prepared: readonly Omit<PlannedSceneBatchJob<PreparedSceneQueueJob>, 'ordinal'>[]
    readonly plans: ReadonlyMap<string, ReturnType<typeof planSceneBatch<PreparedSceneQueueJob>>>
    readonly allocationRequests: readonly OutputCommitSetPlanningRequest[]
    readonly allocations: readonly PlannedOutputCommitSet[]
    readonly r2Deliveries: readonly R2QueueDeliverySnapshot[]
    readonly batchId: string
    readonly requestIdentity: string
    readonly createdAt: string
    readonly useStreaming: boolean
    readonly resourcePlan: SceneQueueResourcePlan<import('@/services/novelai-types').GenerationParams>
}

const sceneQueueSubmissions = new WeakMap<SceneQueueSubmission, SceneQueueSubmissionData>()
const sceneQueueApprovals = new SceneQueueApprovalRegistry<SceneQueueSubmission, CreateBatchAndEnqueueResult>()

function replan(reason: SceneQueueReplanIssue['reason'], message: string): never {
    assertSceneQueueReviewCondition(false, reason, message)
}

function summarizeSceneFilenames(fileNames: readonly string[]): SceneQueueFilenameSummary {
    if (fileNames.length <= 5) return Object.freeze({ kind: 'filenames', filenames: Object.freeze([...fileNames]), count: fileNames.length })
    return Object.freeze({
        kind: 'range',
        first: fileNames[0],
        last: fileNames[fileNames.length - 1],
        count: fileNames.length,
    })
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
        if (previous !== undefined && canonicalSerialize(previous.r2Requirement ?? null) !== canonicalSerialize(target.r2Requirement ?? null)) {
            throw new QueueExecutionError('fatal', `Scene target R2 requirements conflict for ${key}`)
        }
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
            ...(target.r2Requirement === undefined ? {} : { r2Requirement: structuredClone(target.r2Requirement) }),
        })
    }
    return [...normalized.values()]
}

export function prepareCurrentSceneQueueReview(): Promise<PreparedSceneQueueReview | null> {
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
    return prepareSceneQueueReview(targets, {
        origin: 'legacy-conversion',
        consumePendingEntries: true,
    })
}

/** Non-interactive compatibility boundary; user-facing callers must present the returned review before approval. */
export function enqueueCurrentSceneQueue(): Promise<CreateBatchAndEnqueueResult | null> {
    return prepareCurrentSceneQueueReview().then(prepared => (
        prepared === null ? null : enqueueReviewedSceneQueue(prepared.submission)
    ))
}

/** Non-interactive compatibility boundary for already-authorized internal callers. */
export function enqueueSceneQueueTargets(
    targets: readonly SceneQueueTarget[],
    options: { origin?: QueueBatchOrigin; consumePendingEntries?: boolean } = {},
): Promise<CreateBatchAndEnqueueResult | null> {
    return prepareSceneQueueReview(targets, options).then(prepared => (
        prepared === null ? null : enqueueReviewedSceneQueue(prepared.submission)
    ))
}

/** Reads Scene/Folder authority and the exact allocator, returning UI-safe review data without Queue or presentation writes. */
export function prepareSceneQueueReview(
    targets: readonly SceneQueueTarget[],
    options: { origin?: QueueBatchOrigin; consumePendingEntries?: boolean; assessment?: GenerationAssessmentRequirement } = {},
): Promise<PreparedSceneQueueReview | null> {
    const normalizedTargets = normalizeSceneQueueTargets(targets)
    if (normalizedTargets.length === 0) return Promise.resolve(null)
    return prepareSceneQueueReviewOnce(
        normalizedTargets,
        options.origin ?? 'fresh',
        options.consumePendingEntries === true,
        options.assessment,
    )
}

async function prepareSceneQueueReviewOnce(
    targets: readonly SceneQueueTarget[],
    origin: QueueBatchOrigin,
    consumePendingEntries: boolean,
    requestedAssessment?: GenerationAssessmentRequirement,
): Promise<PreparedSceneQueueReview> {
        const assessment = requestedAssessment === undefined ? undefined : parseAssessmentRequirement(requestedAssessment)
        if (assessment !== undefined && assessment.requiredAcceptedCount > targets.reduce((sum, target) => sum + target.count, 0)) {
            throw new TypeError('Required acceptance count exceeds planned Scene images.')
        }
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
        const reviewedAt = new Date().toISOString()
        const requestedDay = reviewedAt.slice(0, 10)
        const reviewId = `scene-review-${globalThis.crypto.randomUUID()}`
        const canonicalRequestHash = `sha256:${hashCanonicalValue({
            schemaVersion: 1,
            reviewId,
            requestedDay,
            ...(assessment === undefined ? {} : { assessment }),
            folderBinding,
            targets: selected.map(({ target, document }) => ({
                presetId: target.presetId,
                sceneId: target.sceneId,
                count: target.count,
                fileNames: target.fileNames ?? [],
                repositoryRevision: document.revision,
                r2Requirement: target.r2Requirement ?? null,
            })),
        })}`
        const planningNow = new Date(`${requestedDay}T00:00:00.000Z`)
        planningNow.setUTCMilliseconds(Number.parseInt(canonicalRequestHash.slice(7, 15), 16) % 86_400_000)
        const r2ReadinessByProfile = new Map<string, Promise<R2ProfileV2 | null>>()
        const readR2Profile = (profileId: string) => {
            let pending = r2ReadinessByProfile.get(profileId)
            if (pending === undefined) {
                pending = getRuntimeMainQueueDependencies().r2Planning.getProfile(profileId)
                r2ReadinessByProfile.set(profileId, pending)
            }
            return pending
        }
        const rotation = useRotationStore.getState()
        const rotationCharacterId = rotation.active && rotation.snapshot
            ? rotation.characterIds[rotation.currentIndex]
            : undefined
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
            const r2Requirement = target.r2Requirement ?? (preliminaryFolder?.r2.autoUpload
                ? { mode: 'best-effort' as const, profileId: preliminaryFolder.r2.profileId ?? DEFAULT_R2_PROFILE_ID }
                : { mode: 'disabled' as const })
            const baseR2Profile = r2Requirement.mode === 'disabled' ? null : await readR2Profile(r2Requirement.profileId)
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
            const generationFolder = resolvedFolder
            const reviewDestinationKey = generationFolder?.id ?? 'default-scene-output'
            const reviewDestinationLabel = generationFolder === null
                ? 'Default Scene output'
                : generationFolder.path
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
                metadataMode: r2Requirement.mode !== 'disabled'
                    ? 'strip-and-sidecar'
                    : scene.metadataMode ?? settings.metadataMode,
                presetName: preset.name || 'Default',
                presetPathSegments: getScenePresetPathSegments(sceneState.presets, preset.id),
                sceneName: scene.name,
                sceneSubfoldersEnabled: settings.sceneSubfoldersEnabled,
                directory,
                capabilityFallbackDirectory,
                autoR2UploadProfileId: r2Requirement.mode === 'disabled' ? null : r2Requirement.profileId,
                ...(generationFolder === null
                    ? {}
                    : {
                        generationFolderId: generationFolder.id,
                        generationFolderPath: generationFolder.path,
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
                const costEstimate = Object.freeze({
                    pricingBasis,
                    estimatedAnlas,
                    maxAnlas: estimatedAnlas,
                    estimatedAt: reviewedAt,
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
                        costEstimate,
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
                        reviewDestinationKey,
                        reviewDestinationLabel,
                        r2Requirement,
                        ...(generationFolder?.r2.provenance === undefined ? {} : { r2Provenance: generationFolder.r2.provenance }),
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
        const dependencies = getRuntimeMainQueueDependencies()
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
        const r2Deliveries = await Promise.all(prepared.map(async (item, ordinal): Promise<R2QueueDeliverySnapshot> => {
            const planIdentity = `sha256:${hashCanonicalValue({
                scenePlanHash: item.prepared.planHash,
                outputCommitSetHash: allocations[ordinal].commitSetHash,
            })}` as const
            const release = await planR2Release({
                requirement: item.prepared.r2Requirement,
                objectName: allocations[ordinal].fileName,
                planIdentity,
                ...(item.prepared.r2Provenance === undefined ? {} : { resolvedDestination: {
                    bucket: item.prepared.outputContext.r2Bucket ?? null,
                    prefix: item.prepared.outputContext.r2Prefix ?? '',
                    provenance: item.prepared.r2Provenance,
                } }),
                profileIdProvenance: item.prepared.outputContext.generationFolderId == null
                    ? 'legacy-output'
                    : 'generation-folder',
            }, dependencies.r2Planning)
            if (release.status !== 'ready') throw new QueueExecutionError('fatal', release.message)
            return release.internalSnapshot === null
                ? { requirement: 'disabled', planned: null }
                : release.internalSnapshot.destination.requirement === 'required'
                    ? { requirement: 'required', planned: release.internalSnapshot }
                    : { requirement: 'best-effort', planned: release.internalSnapshot }
        }))
        const destinations = new Map<string, { label: string; filenames: string[]; imageCount: number; claimCount: number }>()
        prepared.forEach((item, ordinal) => {
            const allocation = allocations[ordinal]
            if (allocation.fileName !== item.fileName) {
                throw new QueueExecutionError('fatal', 'Scene output preflight changed the exact filename')
            }
            assertExactOutputCommitSetAllocation({
                ...allocationRequests[ordinal].claimPlan,
                collisionPolicy: 'fail',
                directoryAuthorityId: folderBinding.resourceId,
            }, allocation, outputFilesystemSemantics())
            const destination = destinations.get(item.prepared.reviewDestinationKey) ?? {
                label: item.prepared.reviewDestinationLabel,
                filenames: [],
                imageCount: 0,
                claimCount: 0,
            }
            destination.filenames.push(allocation.fileName)
            destination.imageCount += 1
            destination.claimCount += allocation.commitSet.claims.length
            destinations.set(item.prepared.reviewDestinationKey, destination)
        })
        const review: SceneQueueReview = Object.freeze({
            ...(assessment === undefined ? {} : { assessment }),
            reviewId,
            sceneCount: selected.length,
            imageCount: prepared.length,
            estimatedAnlas: prepared.reduce((total, item) => total + item.estimatedAnlas, 0),
            maxAnlas: prepared.reduce((total, item) => total + item.prepared.costEstimate.maxAnlas, 0),
            claimCount: allocations.reduce((total, allocation) => total + allocation.commitSet.claims.length, 0),
            destinations: Object.freeze([...destinations.values()].map(destination => Object.freeze({
                logicalFolderLabel: destination.label,
                imageCount: destination.imageCount,
                claimCount: destination.claimCount,
                filenameSummary: summarizeSceneFilenames(destination.filenames),
            }))),
            r2Destinations: Object.freeze(r2Deliveries.flatMap(delivery => delivery.planned === null ? [] : [delivery.planned.destination])),
        })
        const submission = Object.freeze({ reviewId }) as SceneQueueSubmission
        sceneQueueSubmissions.set(submission, {
            // One run can span presets: bind their plans and exact destinations to a single human rubric.
            ...(assessment === undefined ? {} : { intentAssessment: {
                runId: batchId, requirement: assessment,
                planHash: `sha256:${hashCanonicalValue({
                    plans: [...plans.values()].map(plan => plan.planHash),
                    commitSets: allocations.map(allocation => allocation.commitSetHash),
                    r2Deliveries, assessment,
                })}` as const,
            } }),
            submission,
            review,
            selected,
            targets,
            origin,
            consumePendingEntries,
            folderRepository,
            folderBinding,
            sceneRepository,
            authorityByPreset,
            prepared,
            plans,
            allocationRequests,
            allocations,
            r2Deliveries,
            batchId,
            requestIdentity,
            createdAt,
            useStreaming: settings.useStreaming,
            resourcePlan: createSceneQueueResourcePlan(prepared.map(item => item.prepared.params)),
        })
        return Object.freeze({ review, submission })
}

/** Revalidates the opaque review under the shared workspace gate, then commits Queue state before projecting UI state. */
export function enqueueReviewedSceneQueue(
    submission: SceneQueueSubmission,
): Promise<CreateBatchAndEnqueueResult> {
    const data = sceneQueueSubmissions.get(submission)
    if (data === undefined || data.submission.reviewId !== submission.reviewId) {
        return Promise.reject(new TypeError('Scene Queue submission is invalid or belongs to another process'))
    }
    return sceneQueueApprovals.run(submission, () => enqueueReviewedSceneQueueOnce(data))
}

async function enqueueReviewedSceneQueueOnce(
    data: SceneQueueSubmissionData,
): Promise<CreateBatchAndEnqueueResult> {
    const operationId = useQueueStore.getState().beginEnqueueOperation('scene')
    try {
        const materializer = getRuntimeQueueResourceMaterializer()
        const resourceCache = new Map<string, Promise<MaterializedQueueResource>>()
        const resources = new Map<string, QueueResourceRecord>()
        const dehydratedByOrdinal = await materializeApprovedSceneQueueResources(
            data.resourcePlan,
            async params => {
                const dehydrated = await dehydrateGenerationParams(params, materializer, resourceCache)
                for (const record of dehydrated.records) resources.set(record.id, record)
                return { parameters: dehydrated.parameters, resources: dehydrated.resources }
            },
        )
        const result = await runtimeWorkspaceMutationGate.runExclusive(
            generationFolderDocumentMutationKey(data.folderBinding.resourceId),
            async () => {
                const currentFolder = await data.folderRepository.getDocument(DEFAULT_GENERATION_FOLDER_WORKSPACE_ID)
                const currentFolderBinding = currentFolder === null
                    ? null
                    : createGenerationFolderDocumentBinding(currentFolder)
                if (currentFolderBinding === null
                    || canonicalSerialize(currentFolderBinding) !== canonicalSerialize(data.folderBinding)) {
                    replan('folder-changed', 'Generation folder changed after Scene Queue review')
                }

                for (const presetId of data.authorityByPreset.keys()) {
                    const document = await data.sceneRepository.getDocument(presetId)
                    if (document === null || data.prepared.some(item => item.presetId === presetId
                        && !sceneGenerationBindingMatches(item.sceneBinding, document, item.sceneId))) {
                        replan('scene-changed', 'Scene document changed after Scene Queue review')
                    }
                }

                const activeCredentialsAreOpus = selectActiveCredentialsAreOpus(useAuthStore.getState())
                for (const delivery of data.r2Deliveries) {
                    if (delivery.planned === null) continue
                    const checked = await revalidateR2Release(delivery.planned, getRuntimeMainQueueDependencies().r2Planning)
                    if (checked.status === 'blocked') replan('folder-changed', checked.reason)
                }
                if (data.prepared.some(item => {
                    const pricingBasis = resolveAnlasPricingBasis({
                        model: item.prepared.params.model,
                        activeCredentialsAreOpus,
                    })
                    const estimatedAnlas = calculateAnlasCost({
                        model: item.prepared.params.model,
                        width: item.prepared.params.width,
                        height: item.prepared.params.height,
                        steps: item.prepared.params.steps,
                        imageCount: 1,
                        pricingBasis,
                    })
                    return pricingBasis !== item.prepared.costEstimate.pricingBasis
                        || estimatedAnlas !== item.prepared.costEstimate.estimatedAnlas
                })) {
                    replan('pricing-changed', 'Scene Queue pricing changed after review')
                }

                const generationLimits = runtimeCapabilities.generationPublication.generationLimits
                try {
                    assertGenerationAtomicBatchAvailable(data.review.imageCount, data.review.claimCount, generationLimits)
                } catch {
                    replan('runtime-limit-changed', 'Runtime atomic Queue limits changed after review')
                }

                let currentAllocations: readonly PlannedOutputCommitSet[]
                try {
                    currentAllocations = await getRuntimeMainQueueDependencies().outputReservations.planBatch(data.allocationRequests)
                } catch {
                    replan('commit-set-changed', 'Exact Scene output commit set conflicts after review')
                }
                if (currentAllocations.length !== data.allocations.length
                    || currentAllocations.some((allocation, ordinal) => {
                        const reviewed = data.allocations[ordinal]
                        return allocation.fileName !== reviewed.fileName
                            || allocation.directoryIdentity !== reviewed.directoryIdentity
                            || allocation.commitSetHash !== reviewed.commitSetHash
                            || canonicalSerialize(allocation.commitSet) !== canonicalSerialize(reviewed.commitSet)
                    })) {
                    replan('commit-set-changed', 'Exact Scene output commit set changed after review')
                }

                const jobs: EnqueueGenerationJobInput[] = []
                const reservations: OutputCommitSetReservation[] = []
                const approvedAt = new Date().toISOString()
                const costConsents = approveSceneQueueCostEstimates(
                    data.prepared.map(item => item.prepared.costEstimate),
                    approvedAt,
                )
                data.prepared.forEach((item, ordinal) => {
                    const plan = data.plans.get(item.presetId)
                    if (plan === undefined) replan('scene-changed', `Scene sub-plan is missing for preset ${item.presetId}`)
                    const jobId = `scene-job-${data.requestIdentity}-${ordinal}`
                    const allocation = currentAllocations[ordinal]
                    assertExactOutputCommitSetAllocation({
                        ...data.allocationRequests[ordinal].claimPlan,
                        collisionPolicy: 'fail',
                        directoryAuthorityId: data.folderBinding.resourceId,
                    }, allocation, outputFilesystemSemantics())
                    const reservation: OutputCommitSetReservation = {
                        reservationSchemaVersion: 1,
                        reservationId: `output-reservation:${jobId}`,
                        batchId: data.batchId,
                        jobId,
                        folderBinding: plan.folderBinding,
                        directoryIdentity: allocation.directoryIdentity,
                        relativePath: item.fileName,
                        collisionPolicy: 'fail',
                        expectedExistingDigest: null,
                        commitSet: allocation.commitSet,
                        commitSetHash: allocation.commitSetHash,
                        state: 'reserved',
                        version: 1,
                        updatedAt: data.createdAt,
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
                        outputCommitSetHash: allocation.commitSetHash,
                        r2Delivery: data.r2Deliveries[ordinal],
                    })}`
                    const encoded = encodeSceneJobSnapshot({
                        scene: item.prepared.scene,
                        params: item.prepared.params,
                        finalPrompt: item.prepared.finalPrompt,
                        mimeType: item.prepared.mimeType,
                        saveContext: item.prepared.saveContext,
                        outputContext: item.prepared.outputContext,
                        streaming: data.useStreaming,
                        sequenceCommitProposal: item.prepared.sequenceCommitProposal,
                        planHash: item.prepared.planHash,
                        sceneBinding: item.sceneBinding,
                        batch: {
                            request: plan.request,
                            count: plan.count,
                            estimatedAnlas: plan.estimatedAnlas,
                            planHash: destinationBoundPlanHash,
                        },
                        costConsent: costConsents[ordinal],
                        r2Delivery: data.r2Deliveries[ordinal],
                    }, dehydratedByOrdinal[ordinal])
                    jobs.push({
                        id: jobId,
                        batchId: data.batchId,
                        workflow: 'scene',
                        sceneId: item.sceneId,
                        createdAt: data.createdAt,
                        priority: 0,
                        ordinal,
                        snapshot: bindOutputReservationSnapshot({
                            ...encoded.snapshot,
                            ...(data.intentAssessment === undefined ? {} : { intentAssessment: data.intentAssessment }),
                        }, reservationSnapshot),
                        compositionPlanHash: destinationBoundPlanHash,
                        maxAttempts: 3,
                        idempotencyKey: `scene-enqueue-${data.requestIdentity}-${ordinal}`,
                    })
                    reservations.push(reservation)
                })
                return getRuntimeQueueRepository().createBatchAndEnqueue({
                    batch: {
                        id: data.batchId,
                        workflow: 'scene',
                        createdAt: data.createdAt,
                        failurePolicy: 'continue',
                        origin: data.origin,
                        idempotencyKey: `scene-enqueue-${data.requestIdentity}`,
                    },
                    jobs,
                    resources: [...resources.values()],
                    reservations,
                })
            },
        )
        // Presentation changes occur only after the atomic Queue transaction commits.
        if (data.consumePendingEntries) {
            for (const { target } of data.selected) {
                useSceneStore.getState().consumeSceneQueueEntries(target.presetId, target.sceneId, target.count)
            }
        }
        for (const item of data.prepared) {
            useSceneStore.getState().recordSceneCompositionResult(item.sceneId, item.prepared.compositionResult)
        }
        for (const { preset, scene } of data.selected) {
            const count = data.targets.find(target => target.presetId === preset.id && target.sceneId === scene.id)?.count ?? 0
            for (let index = 0; index < count; index += 1) {
                useSceneStore.getState().consumeSceneGenerationSeed(preset.id, scene.id)
            }
        }
        return result
    } finally {
        useCharacterStore.getState().releaseImageData()
        useQueueStore.getState().completeEnqueueOperation('scene', operationId)
    }
}
