import type { QueueTokenProvider } from '@/application/queue/queue-token-provider'
import type { SceneResultPresentationPort } from '@/application/scene/scene-result-presentation-port'
import type { StyleLabQueuePresentationPort } from '@/application/style-lab/style-lab-queue-presentation-port'
import { DurableQueueCoordinator } from './durable-queue-coordinator'
import { getRuntimeQueueRepository } from './indexeddb-queue-repository'
import { executeMainQueueJob } from './main-queue-executor'
import { executeSceneQueueJob } from './scene-queue-executor'
import {
    configureRuntimeMainQueueDependencies,
    resetRuntimeMainQueueDependenciesForTests,
    type RuntimeMainQueueDependencies,
} from './main-queue-runtime-dependencies'
import { executeStyleLabQueueJob } from '@/services/style-lab/style-lab-queue-executor'
import { initializeQueueAfterRestart } from './queue-startup'

let runtimeCoordinator: DurableQueueCoordinator | null = null
let runtimeDependencies: RuntimeQueueDependencies | null = null

export interface RuntimeQueueDependencies {
    readonly tokenProvider: QueueTokenProvider
    readonly generationDelayMs?: () => number
    readonly mainQueue: RuntimeMainQueueDependencies
    readonly sceneQueue: {
        readonly presentation: SceneResultPresentationPort
    }
    readonly styleLabQueue: {
        readonly presentation: StyleLabQueuePresentationPort
    }
}

/**
 * Queue runtime construction depends on application ports supplied by the
 * composition root. Refusing late configuration prevents two coordinators from
 * observing different credential sources during one application session.
 */
export function configureRuntimeQueueDependencies(dependencies: RuntimeQueueDependencies): void {
    if (runtimeCoordinator !== null) {
        throw new Error('Queue runtime dependencies must be configured before coordinator creation')
    }
    configureRuntimeMainQueueDependencies(dependencies.mainQueue)
    runtimeDependencies = dependencies
}

export function getRuntimeDurableQueueCoordinator(): DurableQueueCoordinator {
    if (runtimeDependencies === null) {
        throw new Error('Queue runtime dependencies are not configured')
    }
    const dependencies = runtimeDependencies
    runtimeCoordinator ??= new DurableQueueCoordinator({
        repository: getRuntimeQueueRepository(),
        startup: () => initializeQueueAfterRestart({
            providerResultSpool: dependencies.mainQueue.providerResultSpool,
        }),
        tokenProvider: () => dependencies.tokenProvider.getActiveTokenSlots(),
        generationDelayMs: dependencies.generationDelayMs,
        executor: {
            execute: async (job, context) => {
                if (job.workflow === 'scene') {
                    await executeSceneQueueJob(job, context, {
                        presentation: dependencies.sceneQueue.presentation,
                    })
                    return
                }
                if (job.workflow === 'main') {
                    await executeMainQueueJob(job, context)
                    return
                }
                if (job.workflow === 'style-lab') {
                    await executeStyleLabQueueJob(job, context, {
                        presentation: dependencies.styleLabQueue.presentation,
                    })
                    return
                }
                throw new Error(`Durable executor is unavailable for ${job.workflow}`)
            },
        },
    })
    return runtimeCoordinator
}

export function resetRuntimeDurableQueueCoordinatorForTests(): void {
    runtimeCoordinator?.stop()
    runtimeCoordinator = null
    runtimeDependencies = null
    resetRuntimeMainQueueDependenciesForTests()
}
