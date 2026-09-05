import { ForegroundAgentCommandRuntime } from './foreground-agent-command-runtime'
import { createNativeAgentCommands } from '@/adapters/agent/native-agent-commands'
import { IndexedDbCommandReceiptRepository } from '@/adapters/agent/indexeddb-command-receipt-repository'
import { IndexedDbGenerationPlanRepository } from '@/adapters/generation/indexeddb-generation-plan-repository'
import { getWorkflowDraftRepository } from '@/adapters/workflow/indexeddb-workflow-draft-repository'
import { getRuntimeGenerationRun } from '@/adapters/generation/indexeddb-generation-run-reader'
import { createAgentGenerationPlanHandler } from '@/application/agent/agent-generation-plan-handler'
import { AgentCommandError } from '@/application/agent/agent-command-contract'
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
import { isAgentExecutionPolicyUpdatePending, useSettingsStore } from '@/stores/settings-store'

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
        const source = input.source as { draftId: string }
        const draft = await drafts.get(source.draftId)
        const pricingBasis = resolveAnlasPricingBasis({ model: draft?.payload.model ?? '',
            activeCredentialsAreOpus: selectActiveCredentialsAreOpus(useAuthStore.getState()) })
        return planner(pricingBasis).execute(input, context)
    } }, {
        command: 'workspace.get_snapshot', effect: 'read',
        validate: input => { if (Object.keys(input).length !== 0) throw new AgentCommandError('INVALID_COMMAND_INPUT'); return input },
        execute: async () => {
            const all = await drafts.list()
            return { workspaceId, workflowDrafts: all.slice(0, 100).map(draft => ({ draftId: draft.id, revision: draft.revision })),
                totalDrafts: all.length, truncated: all.length > 100 }
        },
    }, {
        command: 'generation.get_run', effect: 'read',
        validate: input => {
            if (Object.keys(input).length !== 1 || typeof input.runId !== 'string'
                || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(input.runId)) throw new AgentCommandError('INVALID_COMMAND_INPUT')
            return input
        },
        execute: async (input): Promise<JsonObject> => {
            const run = await getRuntimeGenerationRun(input.runId as string)
            if (run === null) return { found: false }
            return { found: true, runId: run.runId, state: run.overall, queueState: run.queue.state,
                jobCount: run.jobs.length, truncated: run.jobs.length > 100,
                jobs: run.jobs.slice(0, 100).map(job => ({ jobId: job.jobId, queueState: job.queue.state,
                    providerState: job.provider.state, storageState: job.storage.state, releaseState: job.release.state,
                    acceptanceState: job.acceptance.state })) }
        },
    }]
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
    createExecution: async (workspaceId, isClientAuthorized) => createAgentExecutionCoordinator({
        workspaceId, receipts, isClientAuthorized,
        repository: new IndexedDbAgentExecutionRepository(), plans: new IndexedDbGenerationPlanRepository(),
        getPolicy: () => useSettingsStore.getState().agentExecutionPolicy,
        ports: createAgentGenerationExecutionPort(),
    }),
})

export function startRuntimeAgentCommands(recovery: Promise<{ inboxReady: boolean }>): Promise<void> {
    if (runtimeCapabilities.platform !== 'windows' || !runtimeCapabilities.nativePluginRuntime.supported) {
        void recovery.catch(() => undefined)
        return Promise.resolve()
    }
    return runtimeAgentCommands.start(recovery)
}
