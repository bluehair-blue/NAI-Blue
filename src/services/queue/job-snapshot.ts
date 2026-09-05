import { canonicalSerialize, hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import type {
    GenerationJobSnapshot,
    GenerationSnapshotResource,
    OutputReservationSnapshot,
    SnapshotResumability,
} from '@/domain/queue/types'
import type { ProviderExecutionEnvelope } from '@/domain/queue/provider-result'
import { parseIntentAssessmentRunBinding } from '@/domain/assessment/intent-assessment'

export const GENERATION_JOB_SNAPSHOT_SCHEMA_VERSION = 1 as const

const PROHIBITED_KEYS = new Set([
    'token',
    'apikey',
    'apitoken',
    'accesstoken',
    'refreshtoken',
    'authorization',
    'authorizationheader',
    'secret',
    'cachesecret',
    'base64',
    'imagebase64',
    'sourceimagebase64',
    'maskbase64',
    'signedurl',
])

export class QueueSnapshotError extends Error {
    readonly code = 'E_QUEUE_SNAPSHOT_INVALID' as const

    constructor(message: string) {
        super(message)
        this.name = 'QueueSnapshotError'
    }
}

export interface CreateGenerationJobSnapshotInput {
    prompt: { positive: string; negative: string }
    parameters: unknown
    outputPolicy: unknown
    resources: readonly GenerationSnapshotResource[]
    resumability: SnapshotResumability
    nonResumableReason?: 'volatile-resource' | 'runtime-only-capability'
    /** Present only for jobs routed through the Provider-safe executor. */
    providerExecutionEnvelope?: ProviderExecutionEnvelope
}

function normalizedKey(key: string): string {
    return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function assertSafeValue(value: unknown, path: readonly (string | number)[], ancestors: Set<object>): void {
    if (typeof value === 'string') {
        if (/^data:[^,;]+;base64,/i.test(value) || /^bearer\s+/i.test(value)) {
            throw new QueueSnapshotError(`Snapshot contains prohibited material at ${formatPath(path)}`)
        }
        return
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return
    if (typeof value !== 'object') {
        throw new QueueSnapshotError(`Snapshot contains a non-JSON value at ${formatPath(path)}`)
    }
    if (ancestors.has(value)) throw new QueueSnapshotError(`Snapshot contains a cycle at ${formatPath(path)}`)
    ancestors.add(value)
    try {
        if (Array.isArray(value)) {
            value.forEach((item, index) => assertSafeValue(item, [...path, index], ancestors))
            return
        }
        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) {
            throw new QueueSnapshotError(`Snapshot contains a non-plain object at ${formatPath(path)}`)
        }
        for (const [key, item] of Object.entries(value)) {
            if (PROHIBITED_KEYS.has(normalizedKey(key))) {
                throw new QueueSnapshotError(`Snapshot contains a prohibited field at ${formatPath([...path, key])}`)
            }
            assertSafeValue(item, [...path, key], ancestors)
        }
    } finally {
        ancestors.delete(value)
    }
}

function formatPath(path: readonly (string | number)[]): string {
    return path.reduce<string>((result, segment) => (
        typeof segment === 'number' ? `${result}[${segment}]` : `${result}.${segment}`
    ), '$')
}

function deepFreeze<T>(value: T): T {
    if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
    return value
}

export function assertGenerationJobSnapshotSafe(snapshot: unknown): void {
    assertSafeValue(snapshot, [], new Set())
    if (snapshot !== null && typeof snapshot === 'object' && 'intentAssessment' in snapshot) {
        parseIntentAssessmentRunBinding(snapshot.intentAssessment)
    }
}


export function createGenerationJobSnapshot(input: CreateGenerationJobSnapshotInput): GenerationJobSnapshot {
    if (input.resources.some(resource => resource.persistence === 'volatile')
        && (input.resumability !== 'non-resumable' || input.nonResumableReason !== 'volatile-resource')) {
        throw new QueueSnapshotError('Volatile resources require an explicit non-resumable snapshot')
    }
    if (input.resumability === 'non-resumable' && input.nonResumableReason === undefined) {
        throw new QueueSnapshotError('Non-resumable snapshots require a stable reason')
    }

    const candidate = {
        schemaVersion: GENERATION_JOB_SNAPSHOT_SCHEMA_VERSION,
        prompt: {
            positive: input.prompt.positive,
            negative: input.prompt.negative,
        },
        parameters: input.parameters,
        outputPolicy: input.outputPolicy,
        resources: input.resources,
        resumability: input.resumability,
        ...(input.providerExecutionEnvelope === undefined
            ? {}
            : { providerExecutionEnvelope: input.providerExecutionEnvelope }),
        ...(input.nonResumableReason === undefined
            ? {}
            : { nonResumableReason: input.nonResumableReason }),
    }
    assertGenerationJobSnapshotSafe(candidate)
    const detached = JSON.parse(canonicalSerialize(candidate)) as GenerationJobSnapshot
    return deepFreeze(detached)
}

export function hashGenerationJobSnapshot(snapshot: GenerationJobSnapshot): string {
    assertGenerationJobSnapshotSafe(snapshot)
    return `sha256:${hashCanonicalValue(snapshot)}`
}

/** Binds the Queue-owned exact destination before snapshot hashing and enqueue. */
export function bindOutputReservationSnapshot(
    snapshot: GenerationJobSnapshot,
    outputReservation: OutputReservationSnapshot,
): GenerationJobSnapshot {
    if (snapshot.outputReservation !== undefined
        && canonicalSerialize(snapshot.outputReservation) !== canonicalSerialize(outputReservation)) {
        throw new QueueSnapshotError('Snapshot already contains a different output reservation')
    }
    const candidate = { ...snapshot, outputReservation }
    assertGenerationJobSnapshotSafe(candidate)
    return deepFreeze(JSON.parse(canonicalSerialize(candidate)) as GenerationJobSnapshot)
}
