import { cancelGeneration } from '@/application/generation/enqueue-generation-plan'
import type { Sha256Digest } from '@/application/generation/generation-plan-contract'
import { hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import { resolveAnlasPricingBasis } from '@/lib/anlas-calculator'
import { enqueuePreparedMainGeneration } from '@/services/generation/main-application-generation-command'
import { getRuntimeGenerationCommandAdapter } from '@/services/queue/generation-command-adapter'
import { getRuntimeQueueRepository } from '@/services/queue/indexeddb-queue-repository'
import { getRuntimeMainQueueDependencies } from '@/services/queue/main-queue-runtime-dependencies'
import { useGenerationStore } from '@/stores/generation-store'
import { useQueueStore } from '@/stores/queue-store'
import { assessGenerationStepQuality } from '@/services/generation/generation-quality'
import { selectActiveCredentialsAreOpus, useAuthStore } from '@/stores/auth-store'
import { useSettingsStore } from '@/stores/settings-store'
import { createGenerationFolderDocumentBinding } from '@/application/folder/generation-folder-binding'

export type MainGenerationStartOutcome = 'started' | 'low-quality-steps'

let mainApplicationEnqueueInFlight: Promise<string> | null = null

function credentialReadinessFingerprint(auth: ReturnType<typeof useAuthStore.getState>): Sha256Digest {
    return `sha256:${hashCanonicalValue({
        initialized: auth.isCredentialStateInitialized,
        slots: [
            {
                slot: 1,
                active: Boolean(auth.token && auth.isVerified && auth.slot1Enabled),
                credentialId: auth.slot1CredentialRef?.id ?? null,
                verifiedAt: auth.slot1CredentialRef?.verifiedAt ?? null,
                tier: auth.tier,
            },
            {
                slot: 2,
                active: Boolean(auth.token2 && auth.isVerified2 && auth.slot2Enabled),
                credentialId: auth.slot2CredentialRef?.id ?? null,
                verifiedAt: auth.slot2CredentialRef?.verifiedAt ?? null,
                tier: auth.tier2,
            },
        ],
    })}`
}

async function enqueueCurrentMainThroughApplication(): Promise<string> {
    const generation = useGenerationStore.getState()
    const auth = useAuthStore.getState()
    if (auth.getActiveTokens().length === 0) {
        auth.requestTokenEntry()
        throw new Error('A verified NovelAI credential is required.')
    }
    const queueDependencies = getRuntimeMainQueueDependencies()
    const planner = queueDependencies.planner
    const requestedCount = planner.getRequestedCount()
    const readinessFingerprint = credentialReadinessFingerprint(auth)
    const prepared = await planner.prepareBatch()
    if (prepared.length !== requestedCount) throw new Error('The Main capture did not preserve the requested image count.')

    const captureId = `main-capture:${globalThis.crypto.randomUUID()}`
    const folderDocument = useSettingsStore.getState().generationFolderDocument
    if (folderDocument === null) throw new Error('Generation folder authority is not ready.')
    const result = await enqueuePreparedMainGeneration({
        prepared,
        captureId,
        idempotencyKey: `main:${captureId}`,
        pricingBasis: resolveAnlasPricingBasis({
            model: generation.model,
            activeCredentialsAreOpus: selectActiveCredentialsAreOpus(auth),
        }),
        approvedAt: new Date().toISOString(),
        credentialReadinessFingerprint: readinessFingerprint,
        folderBinding: createGenerationFolderDocumentBinding(folderDocument),
    })
    if (result.status !== 'ready') {
        const message = 'issues' in result
            ? result.issues[0]?.message
            : 'The Main generation plan still requires input.'
        throw new Error(message ?? 'The Main generation plan could not be enqueued.')
    }
    useQueueStore.getState().setSelectedBatchId(result.batchId)
    return result.batchId
}

/**
 * Single UI command surface. It depends on queue authority and the legacy store
 * fallback, then routes start/cancel to exactly one executor so pages and prompt
 * panels do not orchestrate providers, persistence, or queue draining themselves.
 */
export async function startMainGenerationCommand(): Promise<MainGenerationStartOutcome> {
    const generation = useGenerationStore.getState()
    if (assessGenerationStepQuality(generation.steps) === 'blocked') return 'low-quality-steps'

    if (useQueueStore.getState().executionAuthority === 'legacy') {
        await generation.generate()
        return 'started'
    }
    // The same in-flight promise gives double-clicks one reviewed capture and
    // one idempotency identity until its durable write finishes.
    mainApplicationEnqueueInFlight ??= enqueueCurrentMainThroughApplication()
        .finally(() => { mainApplicationEnqueueInFlight = null })
    await mainApplicationEnqueueInFlight
    return 'started'
}

export async function cancelMainGenerationCommand(): Promise<void> {
    if (useQueueStore.getState().executionAuthority === 'legacy') {
        useGenerationStore.getState().cancelGeneration()
        return
    }
    const selectedBatchId = useQueueStore.getState().selectedBatchId
    if (selectedBatchId === null) return
    // The persisted UI handle survives restart, while the durable batch record
    // prevents Main controls from cancelling a Scene or Style Lab selection.
    const selectedBatch = await getRuntimeQueueRepository().getBatch(selectedBatchId)
    if (selectedBatch?.workflow !== 'main') return
    const result = await cancelGeneration({
        batchId: selectedBatchId,
        actor: { kind: 'user', id: 'main-ui:user' },
    }, getRuntimeGenerationCommandAdapter())
    if (result.status !== 'ready') {
        throw new Error(result.issues[0]?.message ?? 'The Main batch could not be cancelled.')
    }
}
