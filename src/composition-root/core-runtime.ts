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
export async function planOutputCommitSetBatch(
    requests: readonly OutputCommitSetPlanningRequest[],
): Promise<readonly PlannedOutputCommitSet[]> {
    if (requests.length === 0) return []
    const repository = getRuntimeQueueRepository()
    const platform = createRuntimeOutputPlatformAdapter()
    const [reservationSnapshot, pendingFinals] = await Promise.all([
        repository.getOutputReservationPlanningSnapshot(requests.map(
            request => request.reservationIdentity.reservationId,
        )),
        getRuntimeOutputWriter().listPendingFinalOutputRefs(),
    ])
    const resolved = await Promise.all(requests.map(async request => {
        const directory = await platform.resolveDirectory(request.destination)
        const semantics = outputFilesystemSemantics()
        const directoryIdentity = directoryIdentityForResolvedOutputDirectory(directory, semantics)
        return { request, directory, directoryIdentity, semantics }
    }))
    const parentReads = new Map<string, Promise<readonly string[]>>()
    const occupied = new Set(reservationSnapshot.activeCollisionKeys)
    for (const item of resolved) {
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
            let entries = parentReads.get(key)
            if (entries === undefined) {
                entries = platform.readDirectoryEntries(parent.directory)
                parentReads.set(key, entries)
            }
            for (const name of await entries) {
                const relativePath = parent.relativeParent === '' ? name : `${parent.relativeParent}/${name}`
                occupied.add(createOutputCollisionKey({
                    directoryAuthorityId: item.request.directoryAuthorityId,
                    directoryAuthorityFingerprint: item.directoryIdentity,
                    filesystemSemantics: item.semantics,
                    pathNormalizationRevision: OUTPUT_PATH_NORMALIZATION_REVISION,
                    relativePath,
                }))
            }
        }
        for (const final of pendingFinals) {
            const relativePath = relativeOutputPath(item.directory, final, item.semantics)
            if (relativePath === null) continue
            occupied.add(createOutputCollisionKey({
                directoryAuthorityId: item.request.directoryAuthorityId,
                directoryAuthorityFingerprint: item.directoryIdentity,
                filesystemSemantics: item.semantics,
                pathNormalizationRevision: OUTPUT_PATH_NORMALIZATION_REVISION,
                relativePath,
            }))
        }
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
    const freshAllocations = allocateExactOutputCommitSets({
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
    })
    const freshByIndex = new Map(freshIndexes.map((index, ordinal) => [index, freshAllocations[ordinal]]))
    return resolved.map((item, index) => {
        const replay = replayAllocations.get(index)
        if (replay !== undefined) return replay
        const allocation = freshByIndex.get(index)
        if (allocation === undefined) throw new Error('Output allocation is missing')
        return { ...allocation, directoryIdentity: item.directoryIdentity }
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
        mainQueue: {
            providerResultSpool: new DesktopProviderResultSpool(),
            planner: createZustandMainBatchPlanner(),
            presentation: createZustandMainQueuePresentation(),
            outputReservations: {
                getCurrentFolderBinding: () => {
                    const document = useSettingsStore.getState().generationFolderDocument
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
