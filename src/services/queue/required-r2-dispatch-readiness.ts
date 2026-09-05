import { checkR2ReleaseReadiness } from '@/application/r2/plan-r2-release'
import type { R2QueueDeliverySnapshot } from '@/domain/r2/types'
import { QueueExecutionError } from './durable-queue-coordinator'
import { getRuntimeMainQueueDependencies } from './main-queue-runtime-dependencies'

/** Only fresh dispatch calls this guard. Verified spool storage never needs R2 credentials. */
export async function assertRequiredR2DispatchReady(delivery: R2QueueDeliverySnapshot): Promise<void> {
    if (delivery.requirement !== 'required') return
    try {
        const readiness = await checkR2ReleaseReadiness(delivery.planned, getRuntimeMainQueueDependencies().r2Planning)
        if (readiness.status === 'ready') return
    } catch {
        // Vault/runtime errors are known pre-dispatch blockers, never Provider failures.
    }
    throw new QueueExecutionError('r2-readiness', 'Required R2 delivery needs a ready runtime and credential before Provider dispatch')
}
