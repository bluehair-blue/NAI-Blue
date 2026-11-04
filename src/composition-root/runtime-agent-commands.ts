import { ForegroundAgentCommandRuntime } from './foreground-agent-command-runtime'
import { createNativeAgentCommands } from '@/adapters/agent/native-agent-commands'
import { IndexedDbCommandReceiptRepository } from '@/adapters/agent/indexeddb-command-receipt-repository'
import { IndexedDbGenerationPlanRepository } from '@/adapters/generation/indexeddb-generation-plan-repository'
import { getWorkflowDraftRepository } from '@/adapters/workflow/indexeddb-workflow-draft-repository'
import { getRuntimeGenerationRun } from '@/adapters/generation/indexeddb-generation-run-reader'
import { projectGenerationRunStatus } from '@/application/generation/generation-run-monitor'
import { createAgentGenerationPlanHandler } from '@/application/agent/agent-generation-plan-handler'
import { getAgentCommandInputContract } from '@/application/agent/agent-command-input'
import type { AgentCommandHandler } from '@/application/agent/runtime-capability-registry'
import { createWorkflowDraftGenerationPlanDependencies } from '@/presentation/generation/workflow-draft-main-batch-planner'
import { selectActiveCredentialsAreOpus, useAuthStore } from '@/stores/auth-store'
import { useFragmentStore } from '@/stores/fragment-store'
import { resolveAnlasPricingBasis } from '@/lib/anlas-calculator'
import { runtimeCapabilities } from '@/platform/capabilities'
import type { JsonObject } from '@/domain/composition/types'
import { createAgentExecutionCoordinator } from '@/application/agent/agent-execution-coordinator'
import { IndexedDbAgentExecutionRepository } from '@/adapters/agent/indexeddb-agent-execution-repository'
import { createAgentGenerationExecutionPort } from './agent-generation-execution'
import { createAgentGenerationCancellationPort } from './agent-generation-cancellation'
import { createAgentGenerationStorageRetryPort } from './agent-generation-storage-retry'
import { isAgentExecutionPolicyUpdatePending, useSettingsStore } from '@/stores/settings-store'
import { createRuntimeAgentAuthoring, createAgentAuthoringReadHandlers, getAgentAuthoringSnapshot } from './agent-authoring'
import { createAgentSceneGenerationPlanHandler } from './agent-scene-generation-plan'
import { createProductionRequestHandlers } from './production-requests'
import { summarizeWorkflowDraft } from '@/application/agent/agent-workflow-draft-summary'
import { createAgentArtifactImageHandler } from './agent-artifact-image'
import { getRuntimeQueueRepository } from '@/services/queue/indexeddb-queue-repository'
import { hasAgentAuthoringConsent } from '@/application/agent/agent-authoring-consent'
import { hasAgentGenerationConsent } from '@/application/agent/agent-generation-consent'
import { inspectGenerationRecovery } from './agent-generation-recovery-inspection'

const receipts = new IndexedDbCommandReceiptRepository()

async function createHandlers(workspaceId: string): Promise<readonly AgentCommandHandler[]> {
    const drafts = getWorkflowDraftRepository()
    await drafts.list() // Strict hydration must succeed before the owner starts accepting files.
    const plans = new IndexedDbGenerationPlanRepository()
    const planner = (pricingBasis: 'paid' | 'all-active-opus') => createAgentGenerationPlanHandler(
        createWorkflowDraftGenerationPlanDependencies({ drafts,
            fragmentRepository: useFragmentStore.getState().getLookupRepository(), pricingBasis }), plans,
    )
    return [{ ...planner('paid'), execute: async (input, context) => {
        if ((input.source as { kind?: string }).kind === 'scene') {
            return createAgentSceneGenerationPlanHandler(plans).execute(input, context)
        }
        const source = input.source as { draftId: string }
        const draft = await drafts.get(source.draftId)
        const pricingBasis = resolveAnlasPricingBasis({ model: draft?.payload.model ?? '',
            activeCredentialsAreOpus: selectActiveCredentialsAreOpus(useAuthStore.getState()) })
        return planner(pricingBasis).execute(input, context)
    } }, {
        command: 'workspace.get_snapshot', effect: 'read',
        validate: getAgentCommandInputContract('workspace.get_snapshot')!.validate,
        execute: async (input, { envelope }) => {
            const offset = Number(input.offset ?? 0)
            const limit = Math.min(Number(input.limit ?? 20), 50)
            const all = [...await drafts.list()].sort((a, b) => a.id.localeCompare(b.id))
            const authoring = await getAgentAuthoringSnapshot(offset, limit)
            const settings = useSettingsStore.getState()
            const alwaysApproved = hasAgentAuthoringConsent(settings.agentAuthoringConsent, workspaceId, envelope.context.clientId)
            const generationApproved = hasAgentGenerationConsent(settings.agentGenerationConsent, workspaceId, envelope.context.clientId)
            // Read-only counts support safe app maintenance; consent is projected only for the authenticated caller.
            const queueActivity = await getRuntimeQueueRepository().getActivitySummary()
            const hasMore = offset + limit < Math.max(all.length, Number(authoring.totalScenes), Number(authoring.totalPresets), Number(authoring.totalFolders))
            return { workspaceId, ...authoring, queueActivity: { ...queueActivity },
                editingApproval: { alwaysApproved, active: alwaysApproved && settings.agentExecutionPolicy.mode !== 'observe'
                    && !settings.agentExecutionPolicy.globalPause, consentRevision: settings.agentAuthoringConsent.revision },
                generationApproval: { alwaysApproved: generationApproved,
                    active: generationApproved && settings.agentExecutionPolicy.mode !== 'observe' && !settings.agentExecutionPolicy.globalPause,
                    allowsSyntheticOnly: generationApproved && settings.agentExecutionPolicy.mode !== 'observe' && !settings.agentExecutionPolicy.globalPause,
                    consentRevision: settings.agentGenerationConsent.revision },
                workflowDrafts: all.slice(offset, offset + limit).map(summarizeWorkflowDraft),
                totalDrafts: all.length, truncated: hasMore, nextOffset: hasMore ? offset + limit : null }
        },
    }, {
        command: 'generation.get_run', effect: 'read',
        validate: getAgentCommandInputContract('generation.get_run')!.validate,
        execute: async (input): Promise<JsonObject> => {
            const run = await getRuntimeGenerationRun(input.runId as string)
            if (run === null) return { found: false }
            const jobId = typeof input.jobId === 'string' ? input.jobId : undefined
            const result = projectGenerationRunStatus(run, jobId)
            result.jobs = await Promise.all((result.jobs as JsonObject[]).map(async job => {
                const stored = job.storageState === 'succeeded' ? await getRuntimeQueueRepository().getJob(job.jobId as string) : null
                return stored?.artifactReference ? { ...job, artifactId: stored.artifactReference.artifactId } : job
            }))
            if (jobId !== undefined && result.requestedJobFound === true) {
                result.recoveryInspection = await inspectGenerationRecovery(input.runId as string, jobId)
            }
            return result
        },
    }, createAgentArtifactImageHandler(), ...createAgentAuthoringReadHandlers(), ...createProductionRequestHandlers()]
}

/** Singleton is shared by Data Hub and post-recovery startup; no second Queue or credential authority. */
export const runtimeAgentCommands = new ForegroundAgentCommandRuntime({
    native: createNativeAgentCommands(), receipts, createHandlers,
    policy: {
        get: () => useSettingsStore.getState().agentExecutionPolicy,
        set: (revision, next) => useSettingsStore.getState().setAgentExecutionPolicy(revision, next),
        subscribe: listener => useSettingsStore.subscribe((state, previous) => {
            if (state.agentExecutionPolicy !== previous.agentExecutionPolicy) listener()
        }),
        isSaving: isAgentExecutionPolicyUpdatePending,
    },
    authoringConsent: {
        get: () => useSettingsStore.getState().agentAuthoringConsent,
        set: (revision, workspaceId, clientId, enabled) => useSettingsStore.getState().setAgentAuthoringConsent(revision, workspaceId, clientId, enabled),
    },
    generationConsent: {
        get: () => useSettingsStore.getState().agentGenerationConsent,
        set: (revision, workspaceId, clientId, enabled) => useSettingsStore.getState().setAgentGenerationConsent(revision, workspaceId, clientId, enabled),
    },
    createExecution: async (workspaceId, isClientAuthorized) => createAgentExecutionCoordinator({
        workspaceId, receipts, isClientAuthorized,
        repository: new IndexedDbAgentExecutionRepository(), plans: new IndexedDbGenerationPlanRepository(),
        getPolicy: () => useSettingsStore.getState().agentExecutionPolicy,
        getAuthoringConsent: () => useSettingsStore.getState().agentAuthoringConsent,
        getGenerationConsent: () => useSettingsStore.getState().agentGenerationConsent,
        ports: createAgentGenerationExecutionPort(),
        cancellation: createAgentGenerationCancellationPort(),
        storageRetry: createAgentGenerationStorageRetryPort(),
        authoring: createRuntimeAgentAuthoring(),
    }),
})

export function startRuntimeAgentCommands(recovery: Promise<{ inboxReady: boolean }>): Promise<void> {
    if (runtimeCapabilities.platform !== 'windows' || !runtimeCapabilities.nativePluginRuntime.supported) {
        void recovery.catch(() => undefined)
        return Promise.resolve()
    }
    return runtimeAgentCommands.start(recovery)
}
