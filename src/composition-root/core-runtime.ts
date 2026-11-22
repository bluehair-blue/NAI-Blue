import type { QueueTokenProvider } from '@/application/queue/queue-token-provider'
import { createZustandMainBatchPlanner } from '@/presentation/generation/zustand-main-batch-planner'
import { createZustandMainQueuePresentation } from '@/presentation/queue/zustand-main-queue-presentation'
import { createZustandStyleLabQueuePresentation } from '@/presentation/queue/zustand-style-lab-queue-presentation'
import { createZustandSceneResultPresentation } from '@/presentation/scene/zustand-scene-result-presentation'
import { configureRuntimeQueueDependencies } from '@/services/queue/runtime'
import { DesktopProviderResultSpool } from '@/adapters/generation/desktop-provider-result-spool'
import { selectActiveCredentialsAreOpus, useAuthStore } from '@/stores/auth-store'
import { useSettingsStore } from '@/stores/settings-store'
import { createGenerationFolderDocumentBinding } from '@/application/folder/generation-folder-binding'
import {
    getRuntimeOutputWriter,
} from '@/services/output/output-writer'
import { getRuntimeQueueRepository } from '@/services/queue/indexeddb-queue-repository'
import { createRuntimeOutputPlatformAdapter } from '@/services/output/tauri-output-adapter'
import {
    childOutputRef,
    directoryIdentityForResolvedOutputDirectory,
    type OutputFileRef,
} from '@/services/output/platform-adapter'
import {
    allocateExactOutputCommitSets,
    generationOutputClaimKinds,
    generationOutputRelativePath,
    outputFilesystemSemantics,
} from '@/services/output/generation-output-commit-set'
import { createOutputCollisionKey } from '@/domain/output-commit-set'
import {
    OUTPUT_PATH_NORMALIZATION_REVISION,
    withDuplicateSuffix,
} from '@/services/output/filename-policy'
import type {
    OutputCommitSetPlanningRequest,
    PlannedOutputCommitSet,
} from '@/services/queue/main-queue-runtime-dependencies'
import { canonicalSerialize } from '@/domain/composition/canonical-serialize'
import { normalizeOutputDirectoryPath } from '@/domain/output-commit-set'
import { measureSpan, measureSpanSync, type SpanDetail } from '@/lib/user-timing'
import {
    discardGeneratedProviderOriginal,
    releaseGeneratedOutputToR2,
} from '@/services/r2/generated-release'
import { getR2ProfileReadiness } from '@/services/r2/readiness'
import { getRuntimeR2UploadCoordinator, getRuntimeR2UploadRepository } from '@/services/r2/runtime'

function planningPathSegments(
    value: string,
    semantics: ReturnType<typeof outputFilesystemSemantics>,
): readonly string[] {
    const segments = value.replace(/\\/g, '/').split('/')
    while (segments.length > 1 && segments[segments.length - 1] === '') segments.pop()
    return segments.map(segment => normalizeOutputDirectoryPath(segment, semantics))
}

function isReplayFileName(
    requested: string,
    allocated: string,
    collisionPolicy: 'fail' | 'suffix',
): boolean {
    if (collisionPolicy === 'fail') return requested === allocated
    for (let duplicateIndex = 0; duplicateIndex < 10_000; duplicateIndex += 1) {
        if (withDuplicateSuffix(requested, duplicateIndex) === allocated) return true
    }
    return false
}

function relativeOutputPath(
    directory: OutputFileRef,
    file: OutputFileRef,
    semantics: ReturnType<typeof outputFilesystemSemantics>,
): string | null {
    if (directory.baseDir !== file.baseDir) return null
    const root = planningPathSegments(directory.path, semantics)
    const selectedRaw = file.path.replace(/\\/g, '/').split('/')
    while (selectedRaw.length > 1 && selectedRaw[selectedRaw.length - 1] === '') selectedRaw.pop()
    const selected = selectedRaw.map(segment => normalizeOutputDirectoryPath(segment, semantics))
    if (selected.length <= root.length
        || root.some((segment, index) => selected[index] !== segment)) return null
    return selectedRaw.slice(root.length).join('/')
}

/**
 * Joins Queue active claims, OutputWriter journals, and shallow filesystem
 * snapshots once, then delegates all naming decisions to the pure allocator.
 */
export function planOutputCommitSetBatch(
    requests: readonly OutputCommitSetPlanningRequest[],
): Promise<readonly PlannedOutputCommitSet[]> {
    if (requests.length === 0) return Promise.resolve([])
    return measureSpan('agent-plan:output-planning', detail => planNonEmptyOutputCommitSetBatch(requests, detail))
}

async function planNonEmptyOutputCommitSetBatch(
    requests: readonly OutputCommitSetPlanningRequest[],
    detail: SpanDetail,
): Promise<readonly PlannedOutputCommitSet[]> {
    const repository = getRuntimeQueueRepository()
    const platform = createRuntimeOutputPlatformAdapter()
    detail.items = requests.length
    detail.directoriesRead = 0
    detail.entriesHashed = 0
    const [reservationSnapshot, pendingFinals] = await Promise.all([
        measureSpan('output-plan:reservation-snapshot', () => repository.getOutputReservationPlanningSnapshot(requests.map(
            request => request.reservationIdentity.reservationId,
        ))),
        measureSpan('output-plan:pending-finals', () => getRuntimeOutputWriter().listPendingFinalOutputRefs()),
    ])
    detail.activeCollisionKeys = reservationSnapshot.activeCollisionKeys.length
    detail.pendingFinals = pendingFinals.length
    const resolved = await measureSpan('output-plan:resolve-directories', () => Promise.all(requests.map(async request => {
        const directory = await platform.resolveDirectory(request.destination)
        const semantics = outputFilesystemSemantics()
        const directoryIdentity = directoryIdentityForResolvedOutputDirectory(directory, semantics)
        return { request, directory, directoryIdentity, semantics }
    })))
    const parentReads = new Map<string, Promise<readonly string[]>>()
    // Keys depend only on authority, directory identity, semantics and path, so every
    // image of a batch that targets the same directory shares one hashing pass.
    const occupiedByDirectory = new Map<string, readonly string[]>()
    const occupied = new Set(reservationSnapshot.activeCollisionKeys)
    for (const item of resolved) {
        const collisionKey = (relativePath: string) => createOutputCollisionKey({
            directoryAuthorityId: item.request.directoryAuthorityId,
            directoryAuthorityFingerprint: item.directoryIdentity,
            filesystemSemantics: item.semantics,
            pathNormalizationRevision: OUTPUT_PATH_NORMALIZATION_REVISION,
            relativePath,
        })
        const authority = `${item.request.directoryAuthorityId}\u0000${item.directoryIdentity}\u0000${item.semantics}`
        const kinds = generationOutputClaimKinds(item.request.claimPlan)
        const parents = new Map<string, { readonly directory: OutputFileRef; readonly relativeParent: string }>()
        for (const kind of kinds) {
            const relativePath = generationOutputRelativePath(kind, item.request.claimPlan.fileName)
            const slash = relativePath.lastIndexOf('/')
            const relativeParent = slash < 0 ? '' : relativePath.slice(0, slash)
            const directory = relativeParent === '' ? item.directory : childOutputRef(item.directory, relativeParent)
            const key = `${directory.baseDir ?? ''}\u0000${planningPathSegments(directory.path, item.semantics).join('/')}`
            parents.set(key, { directory, relativeParent })
        }
        for (const [key, parent] of parents) {
            const cacheKey = `entries\u0000${authority}\u0000${key}\u0000${parent.relativeParent}`
            let keys = occupiedByDirectory.get(cacheKey)
            if (keys === undefined) {
                let entries = parentReads.get(key)
                if (entries === undefined) {
                    entries = measureSpan('output-plan:directory-read', () => platform.readDirectoryEntries(parent.directory))
                    parentReads.set(key, entries)
                    detail.directoriesRead += 1
                }
                const names = await entries
                keys = measureSpanSync('output-plan:collision-keys', hashing => {
                    hashing.entries = names.length
                    return names.map(name => collisionKey(parent.relativeParent === '' ? name : `${parent.relativeParent}/${name}`))
                })
                detail.entriesHashed += names.length
                occupiedByDirectory.set(cacheKey, keys)
            }
            keys.forEach(value => occupied.add(value))
        }
        // relativeOutputPath reads only the base directory and its normalized segments.
        const pendingKey = `pending\u0000${authority}\u0000${String(item.directory.baseDir)}\u0000${
            planningPathSegments(item.directory.path, item.semantics).join('/')}`
        let pendingKeys = occupiedByDirectory.get(pendingKey)
        if (pendingKeys === undefined) {
            pendingKeys = measureSpanSync('output-plan:pending-keys', () => pendingFinals.flatMap(final => {
                const relativePath = relativeOutputPath(item.directory, final, item.semantics)
                return relativePath === null ? [] : [collisionKey(relativePath)]
            }))
            occupiedByDirectory.set(pendingKey, pendingKeys)
        }
        pendingKeys.forEach(value => occupied.add(value))
    }
    const replayAllocations = new Map<number, PlannedOutputCommitSet>()
    const freshIndexes: number[] = []
    for (const [index, item] of resolved.entries()) {
        const existing = reservationSnapshot.reservations[index]
        if (existing === null) {
            freshIndexes.push(index)
            continue
        }
        const identity = item.request.reservationIdentity
        if (existing.reservationSchemaVersion !== 1
            || existing.state === 'abandoned'
            || existing.reservationId !== identity.reservationId
            || existing.batchId !== identity.batchId
            || existing.jobId !== identity.jobId
            || existing.collisionPolicy !== item.request.collisionPolicy
            || canonicalSerialize(existing.folderBinding) !== canonicalSerialize(item.request.folderBinding)
            || existing.folderBinding.resourceId !== item.request.directoryAuthorityId
            || existing.directoryIdentity !== item.directoryIdentity
            || existing.commitSet.directoryAuthorityId !== item.request.directoryAuthorityId
            || existing.commitSet.directoryAuthorityFingerprint !== item.directoryIdentity) {
            throw new Error('Existing output reservation does not match the deterministic request')
        }
        const expected = allocateExactOutputCommitSets({
            requests: [{
                ...item.request.claimPlan,
                fileName: existing.relativePath,
                collisionPolicy: 'fail',
                directoryAuthorityId: item.request.directoryAuthorityId,
                directoryAuthorityFingerprint: item.directoryIdentity,
                filesystemSemantics: item.semantics,
            }],
            occupiedCollisionKeys: new Set(),
        })[0]
        const validAllocatedName = isReplayFileName(
            item.request.claimPlan.fileName,
            existing.relativePath,
            item.request.collisionPolicy,
        )
        if (!validAllocatedName
            || expected.commitSetHash !== existing.commitSetHash
            || canonicalSerialize(expected.commitSet) !== canonicalSerialize(existing.commitSet)) {
            throw new Error('Existing output reservation commit set does not match the deterministic request')
        }
        for (const claim of existing.commitSet.claims) occupied.add(claim.collisionKey)
        replayAllocations.set(index, {
            fileName: existing.relativePath,
            directoryIdentity: existing.directoryIdentity,
            commitSet: existing.commitSet,
            commitSetHash: existing.commitSetHash,
        })
    }
    detail.occupiedKeys = occupied.size
    const freshAllocations = measureSpanSync('output-plan:allocate', () => allocateExactOutputCommitSets({
        requests: freshIndexes.map(index => {
            const item = resolved[index]
            return {
            ...item.request.claimPlan,
            collisionPolicy: item.request.collisionPolicy,
            directoryAuthorityId: item.request.directoryAuthorityId,
            directoryAuthorityFingerprint: item.directoryIdentity,
            filesystemSemantics: item.semantics,
            }
        }),
        occupiedCollisionKeys: occupied,
    }))
    const freshByIndex = new Map(freshIndexes.map((index, ordinal) => [index, freshAllocations[ordinal]]))
    return resolved.map((item, index) => {
        const replay = replayAllocations.get(index)
        const allocation = replay ?? freshByIndex.get(index)
        if (allocation === undefined) throw new Error('Output allocation is missing')
        return {
            ...allocation,
            directoryIdentity: item.directoryIdentity,
            imageDisplayPath: childOutputRef(item.directory, allocation.fileName).displayPath,
        }
    })
}

/**
 * The core composition root depends on the credential store and Queue runtime,
 * translates active credentials into the application port, and is initialized
 * before React mounts so every command observes the same dependency graph.
 */
const queueTokenProvider: QueueTokenProvider = {
    getActiveTokenSlots: () => {
        const auth = useAuthStore.getState()
        const activeCredentialsAreOpus = selectActiveCredentialsAreOpus(auth)
        return auth.getActiveTokens().map(entry => ({
            slotId: `slot-${entry.slot}`,
            token: entry.token,
            activeCredentialsAreOpus,
        }))
    },
}

let initialized = false

export function initializeCoreRuntime(): void {
    if (initialized) return
    configureRuntimeQueueDependencies({
        tokenProvider: queueTokenProvider,
        generationDelayMs: () => useSettingsStore.getState().generationDelay,
        mainQueue: {
            providerResultSpool: new DesktopProviderResultSpool(),
            planner: createZustandMainBatchPlanner(),
            presentation: createZustandMainQueuePresentation(),
            legacyR2Release: releaseGeneratedOutputToR2,
            legacyR2Cleanup: discardGeneratedProviderOriginal,
            r2Planning: {
                getProfile: profileId => getRuntimeR2UploadRepository().getProfile(profileId),
                getReadiness: async profile => {
                    const readiness = await getR2ProfileReadiness(profile)
                    return readiness.status === 'ready'
                        ? { status: 'ready' as const, credentialRef: profile.credentialRef }
                        : { status: 'not-ready' as const, reason: readiness.reason }
                },
            },
            r2Release: {
                enqueue: async (snapshot, artifacts) => {
                    const repository = getRuntimeR2UploadRepository()
                    const existing = await repository.listJobs(snapshot.profile.id)
                    const matched = artifacts.map(artifact => existing.find(job => (
                        job.contractVersion === 'phase7-v1'
                        && JSON.stringify(job.profileSnapshot) === JSON.stringify(snapshot.profile)
                        && job.artifactId === artifact.artifactId
                        && job.artifactBinding?.localVariant === artifact.artifactBinding?.localVariant
                        && job.remoteKey === artifact.remoteKey
                        && job.contentSha256 === artifact.contentSha256
                        && job.size === artifact.size
                    )) ?? null)
                    const missing = artifacts.filter((_artifact, index) => matched[index] === null)
                    if (missing.length === 0) return matched.filter(job => job !== null)
                    const coordinator = getRuntimeR2UploadCoordinator()
                    const plan = await coordinator.plan(snapshot.profile, missing, 'current-session')
                    const queued = await coordinator.enqueuePlan(plan)
                    return [...matched.filter(job => job !== null), ...queued]
                },
            },
            outputReservations: {
                getCurrentFolderBinding: () => {
                    const document = useSettingsStore.getState().generationFolderDocument
                    return document === null ? null : createGenerationFolderDocumentBinding(document)
                },
                getAuthoritativeFolderBinding: async workspaceId => {
                    const { IndexedDbGenerationFolderRepository } = await import(
                        '@/adapters/folder/indexeddb-generation-folder-repository'
                    )
                    const document = await new IndexedDbGenerationFolderRepository().getDocument(workspaceId)
                    return document === null ? null : createGenerationFolderDocumentBinding(document)
                },
                planBatch: planOutputCommitSetBatch,
            },
        },
        sceneQueue: {
            presentation: createZustandSceneResultPresentation(),
        },
        styleLabQueue: {
            presentation: createZustandStyleLabQueuePresentation(),
        },
    })
    initialized = true
}
