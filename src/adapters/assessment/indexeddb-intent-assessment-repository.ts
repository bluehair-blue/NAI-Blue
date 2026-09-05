import type { IntentAssessmentRecord, IntentAssessmentRepository } from '@/application/assessment/intent-assessment-repository'
import {
    parseIntentAssessmentEvent,
    parseIntentAssessmentRunBinding,
    validateIntentAssessmentEvent,
    type IntentAssessmentEvent,
    type IntentAssessmentRunBinding,
} from '@/domain/assessment/intent-assessment'
import { canonicalSerialize } from '@/domain/composition/canonical-serialize'
import { compareAndSetIndexedDBItem, getIndexedDBItemStrict } from '@/lib/indexed-db'

export interface IntentAssessmentPersistence {
    getItem(key: string): Promise<string | null>
    compareAndSet(key: string, expected: string | null, next: string): Promise<boolean>
}

/** Per-run evidence is device-local, excluded from global backup registries like Queue evidence. */
export function intentAssessmentStorageKey(runId: string): string {
    if (typeof runId !== 'string' || !runId.trim()) throw new TypeError('Invalid assessment run ID')
    return `nai-blue-intent-assessment:${encodeURIComponent(runId)}`
}

function assertNextEvent(events: readonly IntentAssessmentEvent[], next: IntentAssessmentEvent): void {
    if (events.some(event => event.type === 'run-decision')) throw new TypeError('Assessment run is closed')
    if (next.type !== 'artifact-assessment') return
    const artifactEvents = events.filter(event => event.type === 'artifact-assessment' && event.artifactId === next.artifactId)
    const latest = artifactEvents[artifactEvents.length - 1]
    if (next.supersedesAssessmentId !== (latest?.assessmentId ?? null)) {
        throw new TypeError('Assessment supersedes a stale or unrelated event')
    }
}

function parseStored(serialized: string, runId: string): IntentAssessmentRecord {
    const value: unknown = JSON.parse(serialized)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid assessment document')
    const raw = value as Record<string, unknown>
    if (raw.schemaVersion !== 1 || Object.keys(raw).some(key => !['schemaVersion', 'binding', 'events'].includes(key))
        || !Array.isArray(raw.events)) throw new TypeError('Invalid assessment document schema')
    const binding = parseIntentAssessmentRunBinding(raw.binding)
    if (binding.runId !== runId) throw new TypeError('Assessment document belongs to another run')
    const events = raw.events.map(parseIntentAssessmentEvent)
    const candidates = events.flatMap(event => event.type === 'artifact-assessment' ? [event.artifactId] : [])
    const previous: IntentAssessmentEvent[] = []
    for (const event of events) {
        validateIntentAssessmentEvent(event, binding, candidates)
        if (previous.some(existing => existing.assessmentId === event.assessmentId)) throw new TypeError('Duplicate persisted assessment ID')
        assertNextEvent(previous, event)
        previous.push(event)
    }
    return { binding, events }
}

/** Strict reads and native CAS preserve append order across repository instances and reopen. */
export class IndexedDbIntentAssessmentRepository implements IntentAssessmentRepository {
    constructor(private readonly persistence: IntentAssessmentPersistence = {
        getItem: getIndexedDBItemStrict,
        compareAndSet: compareAndSetIndexedDBItem,
    }) {}

    async read(runId: string): Promise<IntentAssessmentRecord | null> {
        const serialized = await this.persistence.getItem(intentAssessmentStorageKey(runId))
        return serialized === null ? null : parseStored(serialized, runId)
    }

    async append(bindingInput: IntentAssessmentRunBinding, eventInput: IntentAssessmentEvent): Promise<void> {
        const binding = parseIntentAssessmentRunBinding(bindingInput)
        const event = parseIntentAssessmentEvent(eventInput)
        validateIntentAssessmentEvent(event, binding, event.type === 'artifact-assessment' ? [event.artifactId] : [])
        const key = intentAssessmentStorageKey(binding.runId)
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const serialized = await this.persistence.getItem(key)
            const current = serialized === null ? { binding, events: [] } : parseStored(serialized, binding.runId)
            if (canonicalSerialize(current.binding) !== canonicalSerialize(binding)) throw new TypeError('Assessment run binding changed')
            const existing = current.events.find(item => item.assessmentId === event.assessmentId)
            if (existing !== undefined) {
                if (canonicalSerialize(existing) !== canonicalSerialize(event)) throw new TypeError('Assessment ID collision')
                return
            }
            assertNextEvent(current.events, event)
            const next = JSON.stringify({ schemaVersion: 1, binding, events: [...current.events, event] })
            if (await this.persistence.compareAndSet(key, serialized, next)) return
        }
        throw new Error('Assessment storage conflict after three attempts')
    }
}
