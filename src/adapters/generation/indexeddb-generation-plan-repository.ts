import type { GenerationPlanRepository } from '@/application/generation/generation-plan-repository'
import type { GenerationPlan } from '@/application/generation/generation-plan-contract'
import { canonicalSerialize, hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import { compareAndSetIndexedDBItem, getIndexedDBItemStrict } from '@/lib/indexed-db'

const MAX_RECORD_BYTES = 8 * 1024 * 1024
const DIGEST = /^sha256:[a-f0-9]{64}$/

export interface GenerationPlanPersistencePort {
    getItem(key: string): Promise<string | null>
    compareAndSet(key: string, expected: string | null, next: string): Promise<boolean>
}

export function generationPlanStorageKey(planId: string): string {
    if (!DIGEST.test(planId)) throw new TypeError('Invalid generation plan identity')
    return `nai-blue-generation-plan:${planId}`
}

function object(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Structural integrity only: authoritative planner replay must precede any enqueue. */
function validatePlan(value: unknown): asserts value is GenerationPlan {
    if (!object(value) || value.schemaVersion !== 1
        || typeof value.planId !== 'string' || !DIGEST.test(value.planId)
        || value.planHash !== value.planId
        || typeof value.semanticPlanHash !== 'string' || !DIGEST.test(value.semanticPlanHash)
        || !Array.isArray(value.sourceBindings) || !value.sourceBindings.every(binding => (
            object(binding) && typeof binding.resourceType === 'string' && typeof binding.resourceId === 'string'
            && (binding.revision === null || (Number.isSafeInteger(binding.revision) && Number(binding.revision) >= 0))
            && typeof binding.contentHash === 'string' && DIGEST.test(binding.contentHash)
        ))
        || !Array.isArray(value.jobs) || value.jobs.length === 0 || value.jobs.length > 9_999
        || !value.jobs.every((job, ordinal) => object(job) && job.ordinal === ordinal
            && object(job.semantic) && object(job.destination) && object(job.compatibility)
            && Object.prototype.hasOwnProperty.call(job, 'prepared') && typeof job.preparationDigest === 'string'
            && DIGEST.test(job.preparationDigest) && typeof job.estimatedAnlas === 'number' && job.estimatedAnlas >= 0)
        || !object(value.materializedSeedTrace) || !Array.isArray(value.materializedSeedTrace.seeds)
        || value.materializedSeedTrace.seeds.length !== value.jobs.length
        || !value.materializedSeedTrace.seeds.every(seed => Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffff_ffff)
        || !Array.isArray(value.issues) || !Array.isArray(value.requiredApprovals)
        || typeof value.estimatedAnlas !== 'number' || value.estimatedAnlas < 0
        || !object(value.executionPolicy) || !object(value.budget)
        || !Number.isSafeInteger(value.budget.maxImages) || Number(value.budget.maxImages) < 0
        || typeof value.budget.maxAnlas !== 'number' || value.budget.maxAnlas < 0) {
        throw new TypeError('Invalid persisted generation plan structure')
    }
}

function boundedCanonical(value: unknown): string {
    // Canonical serialization rejects Blob, typed arrays, cycles and undefined rather than stripping them.
    const serialized = canonicalSerialize(value)
    if (new TextEncoder().encode(serialized).byteLength > MAX_RECORD_BYTES) {
        throw new TypeError('Generation plan record exceeds the 8 MiB persistence limit')
    }
    return serialized
}

function serialize(plan: GenerationPlan): string {
    validatePlan(plan)
    const payload = { schemaVersion: 1, plan }
    boundedCanonical(payload)
    return boundedCanonical({ ...payload, contentDigest: `sha256:${hashCanonicalValue(payload)}` })
}

function parse(serialized: string, expectedId: string): GenerationPlan {
    if (new TextEncoder().encode(serialized).byteLength > MAX_RECORD_BYTES) {
        throw new TypeError('Generation plan record exceeds the 8 MiB persistence limit')
    }
    const value: unknown = JSON.parse(serialized)
    if (!object(value) || value.schemaVersion !== 1) throw new TypeError('Invalid generation plan record')
    validatePlan(value.plan)
    if (value.plan.planId !== expectedId || serialize(value.plan) !== serialized) {
        throw new TypeError('Generation plan record checksum or canonical content mismatch')
    }
    return value.plan
}

/** Per-plan strict CAS preserves full internal prepared state without introducing a second database. */
export class IndexedDbGenerationPlanRepository implements GenerationPlanRepository {
    constructor(private readonly persistence: GenerationPlanPersistencePort = {
        getItem: getIndexedDBItemStrict,
        compareAndSet: compareAndSetIndexedDBItem,
    }) {}

    async get(planId: string): Promise<GenerationPlan | null> {
        const serialized = await this.persistence.getItem(generationPlanStorageKey(planId))
        return serialized === null ? null : parse(serialized, planId)
    }

    async putIfAbsent(plan: GenerationPlan): Promise<'stored' | 'same' | 'conflict'> {
        // Snapshot synchronously before the first await so caller mutation cannot alter this write.
        const next = serialize(plan)
        const planId = plan.planId
        const key = generationPlanStorageKey(planId)
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const current = await this.persistence.getItem(key)
            if (current !== null) {
                parse(current, planId)
                return current === next ? 'same' : 'conflict'
            }
            if (await this.persistence.compareAndSet(key, null, next)) return 'stored'
        }
        throw new Error('Generation plan persistence contention after three attempts')
    }
}
