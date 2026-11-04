import type { JsonValue } from './types'

/**
 * This is a deliberately small canonical JSON contract, not an RFC 8785
 * implementation. A version change is required if key sorting or value
 * encoding changes.
 */
export const CANONICAL_SERIALIZATION_VERSION = 'composition-canonical-json-v1' as const

/** SHA-256 over the UTF-8 bytes of the canonical JSON string. */
export const CANONICAL_HASH_ALGORITHM = 'sha256-utf8-v1' as const

/** Projection + canonicalization + hash contract used for composition plans. */
export const COMPOSITION_PLAN_HASH_VERSION = 'composition-plan-hash-v2' as const

const FNV1A_64_OFFSET_BASIS = 0xcbf29ce484222325n
const FNV1A_64_PRIME = 0x100000001b3n
const UINT64_MASK = 0xffffffffffffffffn

export type CanonicalPathSegment = string | number
export type CanonicalPath = readonly CanonicalPathSegment[]

export interface CanonicalProjectionOptions {
    /** Property names excluded at every object depth. */
    excludeKeys?: readonly string[]
    /** Exact paths excluded from objects or arrays. */
    excludePaths?: readonly CanonicalPath[]
}

export interface CompositionPlanHashOptions {
    /** Extra property names added to the built-in plan exclusions. */
    additionalExcludedKeys?: readonly string[]
    /** Extra exact paths added to the built-in plan exclusions. */
    additionalExcludedPaths?: readonly CanonicalPath[]
}

export interface CompositionPlanHash {
    version: typeof COMPOSITION_PLAN_HASH_VERSION
    algorithm: typeof CANONICAL_HASH_ALGORITHM
    canonicalization: typeof CANONICAL_SERIALIZATION_VERSION
    digest: string
}

/**
 * These names are transport/runtime-only values and never participate in a
 * semantic plan hash. Portable path references (`path`, `directory`, segments)
 * and stable resource digests are intentionally not excluded.
 */
export const DEFAULT_PLAN_HASH_EXCLUDED_KEYS = Object.freeze([
    'planHash',
    'planId',
    'requestId',
    'secret',
    'apiKey',
    'apiToken',
    'accessToken',
    'refreshToken',
    'authorization',
    'credentials',
    'bytes',
    'imageBytes',
    'sourceImageBytes',
    'maskBytes',
    'maskImageBytes',
    'thumbnailBytes',
    'base64',
    'dataUrl',
    'blob',
    'displayPath',
    'absolutePath',
    'resolvedPath',
    'nativePath',
    'volatileDisplayPath',
] as const)

function formatPath(path: CanonicalPath): string {
    if (path.length === 0) return '$'
    return path.reduce<string>((formatted, segment) => (
        typeof segment === 'number'
            ? `${formatted}[${segment}]`
            : `${formatted}.${segment}`
    ), '$')
}

function throwInvalidValue(path: CanonicalPath, reason: string): never {
    throw new TypeError(`Value at ${formatPath(path)} is not canonical JSON: ${reason}`)
}

function* serializeString(value: string): Generator<string> {
    yield '"'
    for (let offset = 0; offset < value.length;) {
        let end = Math.min(offset + 16_384, value.length)
        if (end < value.length && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff
            && value.charCodeAt(end) >= 0xdc00 && value.charCodeAt(end) <= 0xdfff) end--
        yield JSON.stringify(value.slice(offset, end)).slice(1, -1)
        offset = end
    }
    yield '"'
}

function* serializeCanonicalValue(
    value: unknown,
    path: CanonicalPath,
    ancestors: Set<object>,
): Generator<string> {
    if (value === null) { yield 'null'; return }

    switch (typeof value) {
        case 'string':
            yield* serializeString(value)
            return
        case 'boolean':
            yield value ? 'true' : 'false'
            return
        case 'number':
            if (!Number.isFinite(value)) throwInvalidValue(path, 'number must be finite')
            yield JSON.stringify(Object.is(value, -0) ? 0 : value)
            return
        case 'undefined':
        case 'function':
        case 'symbol':
        case 'bigint':
            return throwInvalidValue(path, `unsupported ${typeof value} value`)
        case 'object':
            break
    }

    const objectValue = value as object
    if (ancestors.has(objectValue)) throwInvalidValue(path, 'circular reference')
    ancestors.add(objectValue)

    try {
        if (Array.isArray(value)) {
            yield '['
            for (let index = 0; index < value.length; index += 1) {
                if (!Object.prototype.hasOwnProperty.call(value, index)) {
                    throwInvalidValue([...path, index], 'sparse array entry')
                }
                if (index > 0) yield ','
                yield* serializeCanonicalValue(value[index], [...path, index], ancestors)
            }
            yield ']'
            return
        }

        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) {
            throwInvalidValue(path, 'object must have a plain or null prototype')
        }
        if (Object.getOwnPropertySymbols(value).length > 0) {
            throwInvalidValue(path, 'symbol keys are unsupported')
        }

        const record = value as Record<string, unknown>
        yield '{'
        let first = true
        for (const key of Object.keys(record).sort()) {
            if (!first) yield ','
            first = false
            yield* serializeString(key)
            yield ':'
            yield* serializeCanonicalValue(record[key], [...path, key], ancestors)
        }
        yield '}'
    } finally {
        ancestors.delete(objectValue)
    }
}

/**
 * Serializes a JSON-safe value with recursively sorted object keys. Array order
 * remains significant. Unsupported JSON values fail instead of being silently
 * coerced or dropped.
 */
export function canonicalSerialize(value: unknown): string {
    return Array.from(canonicalSerializeChunks(value)).join('')
}

/** Same canonical JSON ABI, with bounded string fragments for large archives. */
export function canonicalSerializeChunks(value: unknown): Generator<string> {
    return serializeCanonicalValue(value, [], new Set())
}

export function canonicalUtf8ByteLength(value: unknown): number {
    const encoder = new TextEncoder()
    let length = 0
    for (const part of canonicalSerializeChunks(value)) length += encoder.encode(part).length
    return length
}

function pathsEqual(left: CanonicalPath, right: CanonicalPath): boolean {
    return left.length === right.length
        && left.every((segment, index) => segment === right[index])
}

function projectCanonicalValue(
    value: unknown,
    path: CanonicalPath,
    excludedKeys: ReadonlySet<string>,
    excludedPaths: readonly CanonicalPath[],
    ancestors: Set<object>,
): JsonValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throwInvalidValue(path, 'number must be finite')
        return Object.is(value, -0) ? 0 : value
    }
    if (typeof value !== 'object') {
        return throwInvalidValue(path, `unsupported ${typeof value} value`)
    }

    if (ancestors.has(value)) throwInvalidValue(path, 'circular reference')
    ancestors.add(value)

    try {
        if (Array.isArray(value)) {
            const result: JsonValue[] = []
            for (let index = 0; index < value.length; index += 1) {
                if (!Object.prototype.hasOwnProperty.call(value, index)) {
                    throwInvalidValue([...path, index], 'sparse array entry')
                }
                const itemPath = [...path, index]
                if (excludedPaths.some(excluded => pathsEqual(excluded, itemPath))) continue
                result.push(projectCanonicalValue(
                    value[index],
                    itemPath,
                    excludedKeys,
                    excludedPaths,
                    ancestors,
                ))
            }
            return result
        }

        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) {
            throwInvalidValue(path, 'object must have a plain or null prototype')
        }
        if (Object.getOwnPropertySymbols(value).length > 0) {
            throwInvalidValue(path, 'symbol keys are unsupported')
        }

        const result: { [key: string]: JsonValue } = {}
        for (const key of Object.keys(value).sort()) {
            const propertyPath = [...path, key]
            if (excludedKeys.has(key)) continue
            if (excludedPaths.some(excluded => pathsEqual(excluded, propertyPath))) continue
            Object.defineProperty(result, key, {
                value: projectCanonicalValue(
                    (value as Record<string, unknown>)[key],
                    propertyPath,
                    excludedKeys,
                    excludedPaths,
                    ancestors,
                ),
                enumerable: true,
                configurable: true,
                writable: true,
            })
        }
        return result
    } finally {
        ancestors.delete(value)
    }
}

/** Returns a detached, JSON-safe projection using exact exclusion rules. */
export function canonicalProject(
    value: unknown,
    options: CanonicalProjectionOptions = {},
): JsonValue {
    return projectCanonicalValue(
        value,
        [],
        new Set(options.excludeKeys ?? []),
        options.excludePaths ?? [],
        new Set(),
    )
}

/**
 * Removes request identity and prohibited runtime-only material before hashing.
 * Callers may add domain-specific exclusions without disabling the defaults.
 */
export function projectForCompositionPlanHash(
    plan: unknown,
    options: CompositionPlanHashOptions = {},
): JsonValue {
    return canonicalProject(plan, {
        excludeKeys: [
            ...DEFAULT_PLAN_HASH_EXCLUDED_KEYS,
            ...(options.additionalExcludedKeys ?? []),
        ],
        excludePaths: options.additionalExcludedPaths,
    })
}

function hashByte(hash: bigint, byte: number): bigint {
    return ((hash ^ BigInt(byte)) * FNV1A_64_PRIME) & UINT64_MASK
}

function hashCodePointUtf8(hash: bigint, codePoint: number): bigint {
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) codePoint = 0xfffd
    if (codePoint <= 0x7f) return hashByte(hash, codePoint)
    if (codePoint <= 0x7ff) {
        hash = hashByte(hash, 0xc0 | (codePoint >>> 6))
        return hashByte(hash, 0x80 | (codePoint & 0x3f))
    }
    if (codePoint <= 0xffff) {
        hash = hashByte(hash, 0xe0 | (codePoint >>> 12))
        hash = hashByte(hash, 0x80 | ((codePoint >>> 6) & 0x3f))
        return hashByte(hash, 0x80 | (codePoint & 0x3f))
    }
    hash = hashByte(hash, 0xf0 | (codePoint >>> 18))
    hash = hashByte(hash, 0x80 | ((codePoint >>> 12) & 0x3f))
    hash = hashByte(hash, 0x80 | ((codePoint >>> 6) & 0x3f))
    return hashByte(hash, 0x80 | (codePoint & 0x3f))
}

/** Platform-independent FNV-1a 64-bit hash over a string's UTF-8 bytes. */
export function fnv1a64Utf8(value: string): string {
    let hash = FNV1A_64_OFFSET_BASIS
    for (const character of value) {
        hash = hashCodePointUtf8(hash, character.codePointAt(0) as number)
    }
    return hash.toString(16).padStart(16, '0')
}

const SHA256_INITIAL_STATE = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const

const SHA256_ROUND_CONSTANTS = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const

function rotateRight(value: number, bits: number): number {
    return (value >>> bits) | (value << (32 - bits))
}

/** Canonical fragments end at code point boundaries; SHA state spans all fragments. */
function sha256Utf8Parts(parts: Iterable<string>): string {
    const state: number[] = [...SHA256_INITIAL_STATE]
    const words = new Uint32Array(64)
    // Automatic backups can exceed 180 MB. A boxed number[] for every byte
    // exhausts the renderer heap; encode/compress fixed chunks with the same hash ABI.
    const encoder = new TextEncoder()
    const bytes = new Uint8Array(65_536)
    const compressBlock = (offset: number): void => {
        for (let index = 0; index < 16; index += 1) {
            const byteIndex = offset + index * 4
            words[index] = (
                (bytes[byteIndex] << 24)
                | (bytes[byteIndex + 1] << 16)
                | (bytes[byteIndex + 2] << 8)
                | bytes[byteIndex + 3]
            ) >>> 0
        }
        for (let index = 16; index < 64; index += 1) {
            const left = words[index - 15]
            const right = words[index - 2]
            const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3)
            const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10)
            words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0
        }

        let [a, b, c, d, e, f, g, h] = state
        for (let index = 0; index < 64; index += 1) {
            const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
            const choice = (e & f) ^ (~e & g)
            const temporary1 = (h + sum1 + choice + SHA256_ROUND_CONSTANTS[index] + words[index]) >>> 0
            const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
            const majority = (a & b) ^ (a & c) ^ (b & c)
            const temporary2 = (sum0 + majority) >>> 0
            h = g
            g = f
            f = e
            e = (d + temporary1) >>> 0
            d = c
            c = b
            b = a
            a = (temporary1 + temporary2) >>> 0
        }

        state[0] = (state[0] + a) >>> 0
        state[1] = (state[1] + b) >>> 0
        state[2] = (state[2] + c) >>> 0
        state[3] = (state[3] + d) >>> 0
        state[4] = (state[4] + e) >>> 0
        state[5] = (state[5] + f) >>> 0
        state[6] = (state[6] + g) >>> 0
        state[7] = (state[7] + h) >>> 0
    }

    let buffered = 0
    let byteLength = 0n
    for (const value of parts) {
        let characterOffset = 0
        while (characterOffset < value.length) {
            let end = Math.min(characterOffset + 16_384, value.length)
            // A valid surrogate pair must reach TextEncoder together. Lone surrogates
            // retain the existing WHATWG replacement-character behavior.
            const lastCodeUnit = value.charCodeAt(end - 1)
            if (end < value.length && lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1
            const encoded = encoder.encodeInto(value.slice(characterOffset, end), bytes.subarray(buffered))
            characterOffset += encoded.read
            byteLength += BigInt(encoded.written)
            const available = buffered + encoded.written
            const completeBytes = available - available % 64
            for (let offset = 0; offset < completeBytes; offset += 64) compressBlock(offset)
            buffered = available - completeBytes
            bytes.copyWithin(0, completeBytes, available)
        }
    }

    const paddedLength = buffered < 56 ? 64 : 128
    bytes.fill(0, buffered, paddedLength)
    bytes[buffered] = 0x80
    const bitLength = byteLength * 8n
    for (let index = 0; index < 8; index += 1) {
        bytes[paddedLength - 1 - index] = Number((bitLength >> BigInt(index * 8)) & 0xffn)
    }
    for (let offset = 0; offset < paddedLength; offset += 64) compressBlock(offset)

    return state.map(word => word.toString(16).padStart(8, '0')).join('')
}

/** Pure, platform-independent SHA-256 over WHATWG-compatible UTF-8 bytes. */
export function sha256Utf8(value: string): string {
    return sha256Utf8Parts([value])
}

/** Hashes canonical JSON without constructing a backup-sized intermediate string. */
export function hashCanonicalValue(value: unknown): string {
    return sha256Utf8Parts(canonicalSerializeChunks(value))
}

export function createCompositionPlanHash(
    plan: unknown,
    options: CompositionPlanHashOptions = {},
): CompositionPlanHash {
    const projectedPlan = projectForCompositionPlanHash(plan, options)
    return {
        version: COMPOSITION_PLAN_HASH_VERSION,
        algorithm: CANONICAL_HASH_ALGORITHM,
        canonicalization: CANONICAL_SERIALIZATION_VERSION,
        digest: hashCanonicalValue(projectedPlan),
    }
}
