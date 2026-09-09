import { canonicalSerialize, hashCanonicalValue } from '@/domain/composition/canonical-serialize'
import { compareAndSetIndexedDBItem, getIndexedDBItemStrict } from '@/lib/indexed-db'
import { assertProductionTransition, parseProductionRequest, type ProductionRequest } from '@/application/generation/production-request'

export interface ProductionRequestPersistencePort {
    getItem(key: string): Promise<string | null>
    compareAndSet(key: string, expected: string | null, next: string): Promise<boolean>
}
const KEY = 'nai-blue-production-requests:v1'
const MAX_BYTES = 8 * 1024 * 1024
function serialize(requests: readonly ProductionRequest[]): string {
    if (requests.length > 32 || new Set(requests.map(request => request.id)).size !== requests.length) {
        throw new TypeError('Production request ledger limit or duplicate identity')
    }
    requests.forEach(parseProductionRequest)
    const content = { schemaVersion: 1, requests }
    const raw = canonicalSerialize({ ...content, contentDigest: `sha256:${hashCanonicalValue(content)}` })
    if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) throw new TypeError('Production ledger exceeds 8 MiB')
    return raw
}
function parse(raw: string | null): ProductionRequest[] {
    if (raw === null) return []
    if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) throw new TypeError('Production ledger exceeds 8 MiB')
    const value = JSON.parse(raw)
    if (value?.schemaVersion !== 1 || !Array.isArray(value.requests) || serialize(value.requests) !== raw) {
        throw new TypeError('Invalid production ledger checksum or shape')
    }
    return value.requests
}

/** ponytail: one CAS ledger bounds 32 requests; split records with an atomic index if retention grows. */
export class IndexedDbProductionRequestRepository {
    constructor(private readonly persistence: ProductionRequestPersistencePort = {
        getItem: getIndexedDBItemStrict, compareAndSet: compareAndSetIndexedDBItem,
    }) {}

    async list(): Promise<ProductionRequest[]> { return parse(await this.persistence.getItem(KEY)) }
    async get(id: string): Promise<ProductionRequest | null> { return (await this.list()).find(request => request.id === id) ?? null }

    async putIfAbsent(request: ProductionRequest): Promise<'stored' | 'same' | 'conflict'> {
        const snapshot = parseProductionRequest(request)
        if (snapshot.revision !== 0 || snapshot.children.some(child => child.review !== null || child.submission !== null)) {
            throw new TypeError('New production request must start unreviewed')
        }
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const raw = await this.persistence.getItem(KEY)
            const requests = parse(raw)
            const previous = requests.find(item => item.id === snapshot.id)
            if (previous) return canonicalSerialize(previous) === canonicalSerialize(snapshot) ? 'same' : 'conflict'
            if (await this.persistence.compareAndSet(KEY, raw, serialize([...requests, snapshot]))) return 'stored'
        }
        throw new Error('Production request persistence contention after three attempts')
    }

    async compareAndSet(expected: ProductionRequest, next: ProductionRequest): Promise<boolean> {
        // Capture before await; callers cannot mutate the consent or expected revision during I/O.
        const before = parseProductionRequest(expected)
        const after = parseProductionRequest(next)
        assertProductionTransition(before, after)
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const raw = await this.persistence.getItem(KEY)
            const requests = parse(raw)
            const current = requests.find(item => item.id === before.id)
            if (!current || canonicalSerialize(current) !== canonicalSerialize(before)) return false
            if (await this.persistence.compareAndSet(KEY, raw, serialize(requests.map(item => item.id === before.id ? after : item)))) return true
        }
        throw new Error('Production request persistence contention after three attempts')
    }
}
