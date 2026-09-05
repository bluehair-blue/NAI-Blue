import type { ActorRef } from '@/application/generation/generation-command-contract'
import {
    parseIntentAssessmentEvent,
    validateIntentAssessmentEvent,
    projectRunAcceptance,
    type IntentAssessmentRunBinding,
    type RunAcceptanceProjection,
} from '@/domain/assessment/intent-assessment'
import type { IntentAssessmentRepository } from './intent-assessment-repository'
import { canonicalSerialize } from '@/domain/composition/canonical-serialize'

export interface RecordIntentAssessmentPorts {
    readonly repository: IntentAssessmentRepository
    readRun(runId: string): Promise<{
        readonly binding: IntentAssessmentRunBinding
        readonly candidateArtifactIds: readonly string[]
    } | null>
}

/** The caller supplies trusted UI actor context; event payloads cannot grant human authority. */
export async function recordIntentAssessment(
    input: unknown,
    actor: ActorRef,
    ports: RecordIntentAssessmentPorts,
): Promise<RunAcceptanceProjection> {
    if (actor.kind !== 'user' || !actor.id.trim()) throw new TypeError('Only a local user can record human assessment')
    const event = parseIntentAssessmentEvent(input)
    if (event.evaluator.actorId !== actor.id) throw new TypeError('Assessment evaluator does not match the user actor')
    const run = await ports.readRun(event.runId)
    if (run === null) throw new TypeError('Assessment run was not found')
    validateIntentAssessmentEvent(event, run.binding, run.candidateArtifactIds)
    await ports.repository.append(run.binding, event)
    const persisted = await ports.repository.read(event.runId)
    if (persisted === null || canonicalSerialize(persisted.binding) !== canonicalSerialize(run.binding)
        || !persisted.events.some(saved => canonicalSerialize(saved) === canonicalSerialize(event))) {
        throw new Error('Assessment write could not be read back with its immutable binding')
    }
    for (const saved of persisted.events) validateIntentAssessmentEvent(saved, run.binding, run.candidateArtifactIds)
    return projectRunAcceptance(run.binding, run.candidateArtifactIds, persisted.events)
}
