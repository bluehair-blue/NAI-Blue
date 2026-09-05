import type { IntentAssessmentEvent, IntentAssessmentRunBinding } from '@/domain/assessment/intent-assessment'

export interface IntentAssessmentRecord {
    readonly binding: IntentAssessmentRunBinding
    readonly events: readonly IntentAssessmentEvent[]
}

/** Assessment evidence is separate from Style Lab preferences and Queue delivery facts. */
export interface IntentAssessmentRepository {
    read(runId: string): Promise<IntentAssessmentRecord | null>
    append(binding: IntentAssessmentRunBinding, event: IntentAssessmentEvent): Promise<void>
}
