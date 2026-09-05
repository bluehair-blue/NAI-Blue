import type { JsonObject } from '@/domain/composition/types'

export type SyncSanitizationErrorCode =
    | 'E_SYNC_PAYLOAD_INVALID'
    | 'E_SYNC_PAYLOAD_FORBIDDEN'
    | 'E_SYNC_ENTITY_UNSUPPORTED'

export class SyncSanitizationError extends Error {
    constructor(readonly code: SyncSanitizationErrorCode, message: string) {
        super(message)
        this.name = 'SyncSanitizationError'
    }
}

const MAX_DEPTH = 64
const MAX_NODES = 100_000
const MAX_STRING_LENGTH = 1_048_576
const MAX_TOTAL_STRING_LENGTH = 8_388_608

const FORBIDDEN_EXACT_KEYS = new Set([
    'token', 'apikey', 'apitoken', 'accesstoken', 'refreshtoken', 'authorization', 'authorizationheader',
    'secret', 'password', 'credential', 'credentialref', 'credentialdetail', 'cookie', 'cookies', 'session', 'signedurl',
    'image', 'images', 'imagebytes', 'thumbnail', 'thumbnailbytes', 'base64', 'blob', 'bytes', 'binary', 'dataurl',
    'displaypath', 'absolutepath', 'nativepath', 'resolvedpath', 'localpath', 'sourcepath', 'outputpath', 'savepath',
    'opaquetoken', 'platformtoken', 'outputwriterjournal', 'journal', 'lease', 'leasecontroller', 'controller',
    'diagnosticrawlog', 'rawdiagnosticlog', 'rawlog', 'auth', 'bearer', 'sig', 'signature', 'hmac',
    'imagedata', 'blobdata', 'binarydata', 'rawbinary', 'filedata', 'preview', 'previewdata', 'pixeldata', 'rgba', 'rgb',
])

export function normalizeSyncFieldKey(key: string): string {
    return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function isForbiddenSyncFieldKey(key: string): boolean {
    const normalized = normalizeSyncFieldKey(key)
    return FORBIDDEN_EXACT_KEYS.has(normalized)
        || /(?:token|secret|password|credential|authorization|cookie|session)/.test(normalized)
        || /(?:accesskey|privatekey|signedurl|base64|thumbnail)/.test(normalized)
        || /^(?:auth|bearer|sig|signature|hmac|image|thumbnail|thumb|preview|pixel|blob|binary|bytes|rawbinary|rgba|rgb)(?:data|payload|content|buffer|bytes)?$/.test(normalized)
        || /(?:absolutepath|displaypath|nativepath|resolvedpath|localpath|sourcepath|outputpath|savepath|homedir)/.test(normalized)
        || /(?:outputwriterjournal|diagnosticraw|rawdiagnostic|rawlog|leasecontroller|activequeuelease|controller)/.test(normalized)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalid(): never {
    throw new SyncSanitizationError('E_SYNC_PAYLOAD_INVALID', 'Sync payload is not bounded canonical JSON.')
}

function hasImageByteSignature(bytes: readonly number[], offset = 0): boolean {
    const startsWith = (signature: readonly number[]) => (
        signature.every((entry, index) => bytes[offset + index] === entry)
    )
    const uint16Le = (index: number) => bytes[offset + index] + (bytes[offset + index + 1] * 0x100)
    const uint32Be = (index: number) => (((bytes[offset + index] * 0x100 + bytes[offset + index + 1]) * 0x100
        + bytes[offset + index + 2]) * 0x100 + bytes[offset + index + 3])
    const uint32Le = (index: number) => (((bytes[offset + index + 3] * 0x100 + bytes[offset + index + 2]) * 0x100
        + bytes[offset + index + 1]) * 0x100 + bytes[offset + index])
    const bmpFileSize = uint32Le(2)
    const bmpPixelOffset = uint32Le(10)
    const bmpHeader = startsWith([0x42, 0x4d])
        && bmpFileSize >= 14
        && bytes[offset + 6] === 0 && bytes[offset + 7] === 0
        && bytes[offset + 8] === 0 && bytes[offset + 9] === 0
        && bmpPixelOffset >= 14
    const iconHeader = startsWith([0x00, 0x00, 0x01, 0x00]) && uint16Le(4) > 0
    const psdHeader = startsWith([0x38, 0x42, 0x50, 0x53, 0x00, 0x01])
        && startsWith([0x38, 0x42, 0x50, 0x53, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
    const qoiHeader = startsWith([0x71, 0x6f, 0x69, 0x66])
        && uint32Be(4) > 0 && uint32Be(8) > 0
        && (bytes[offset + 12] === 3 || bytes[offset + 12] === 4)
        && (bytes[offset + 13] === 0 || bytes[offset + 13] === 1)
    const binaryImage = startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        || startsWith([0xff, 0xd8, 0xff])
        || startsWith([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
        || startsWith([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
        || bmpHeader
        || iconHeader
        || psdHeader
        || qoiHeader
        || startsWith([0xff, 0x0a])
        || startsWith([0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a])
        || startsWith([0x49, 0x49, 0x2a, 0x00])
        || startsWith([0x4d, 0x4d, 0x00, 0x2a])
        || (startsWith([0x52, 0x49, 0x46, 0x46])
            && bytes[offset + 8] === 0x57 && bytes[offset + 9] === 0x45
            && bytes[offset + 10] === 0x42 && bytes[offset + 11] === 0x50)
        || (bytes[offset + 4] === 0x66 && bytes[offset + 5] === 0x74
            && bytes[offset + 6] === 0x79 && bytes[offset + 7] === 0x70
            && [
                'avif', 'avis', 'heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1',
            ].includes(String.fromCharCode(...bytes.slice(offset + 8, offset + 12))))
    if (binaryImage) return true
    const first = bytes[offset]
    if (first !== 0x3c && first !== 0xef && first !== 0xfe && first !== 0xff
        && first !== 0x09 && first !== 0x0a && first !== 0x0d && first !== 0x20) return false
    const asciiPrefix = String.fromCharCode(...bytes.slice(offset, offset + 128))
        .replace(/^\uFEFF/, '')
        .trimStart()
        .toLowerCase()
    return asciiPrefix.startsWith('<svg')
        || (asciiPrefix.startsWith('<?xml') && asciiPrefix.includes('<svg'))
}

function containsImageByteSignature(bytes: readonly number[]): boolean {
    for (let offset = 0; offset < bytes.length; offset += 1) {
        if (hasImageByteSignature(bytes, offset)) return true
    }
    return false
}

function containsRawImageSignature(value: string): boolean {
    const chunkSize = 4_096
    const overlap = 128
    for (let start = 0; start < value.length; start += chunkSize) {
        const chunk = value.slice(start, Math.min(value.length, start + chunkSize + overlap))
        const bytes = Array.from(chunk, character => {
            const codeUnit = character.charCodeAt(0)
            return codeUnit <= 0xff ? codeUnit : 0x100
        })
        if (containsImageByteSignature(bytes)) return true
    }
    return false
}

function compactBase64Candidate(value: string): string | null {
    const trimmed = value.trim()
    if (!/\s/.test(trimmed)) return trimmed
    const parts = trimmed.split(/\s+/)
    if (parts.length < 2
        || parts.some((part, index) => (
            part.length === 0
            || part.length % 4 !== 0
            || !/^[a-z0-9+/_-]+={0,2}$/i.test(part)
            || (part.includes('=') && index !== parts.length - 1)
        ))) return null
    return parts.join('')
}

function compactBase64ImageCandidate(value: string): string | null {
    const trimmed = value.trim()
    if (!/^[a-z0-9+/_=\s-]+$/i.test(trimmed)) return null
    return trimmed.replace(/\s+/g, '')
}

function looksLikeWhitespaceSeparatedProse(value: string): boolean {
    const trimmed = value.trim()
    return /\s/.test(trimmed) && trimmed.split(/\s+/).every(part => (
        /^[a-z]+$/.test(part)
        || /^[A-Z][a-z]+$/.test(part)
        || /^[A-Z]{2,5}$/.test(part)
        || /^[0-9]+$/.test(part)
        || /^(?:v[0-9]+|[0-9]+[a-z]{1,5})$/i.test(part)
        || /^[a-z]+(?:[A-Z][a-z]{2,})+$/.test(part)
        || /^(?:[0-9]+[A-Z]{1,4}|[A-Z]{1,4}[0-9]+)$/.test(part)
        || /^[A-Z][A-Za-z]{2,}[0-9]+$/.test(part)
        || looksLikeNaturalPlainToken(part)
    ))
}

function isControlByte(byte: number): boolean {
    return byte <= 0x08 || byte === 0x0b || byte === 0x0c
        || (byte >= 0x0e && byte <= 0x1f) || byte === 0x7f
}

function compactValueLooksLikeControlBinary(value: string): boolean {
    if (value.length < 16 || !/^[a-z0-9+/_-]+={0,2}$/i.test(value)) return false
    const body = value.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/')
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const recent: number[] = []
    let accumulator = 0
    let bitCount = 0
    for (let index = 0; index < body.length; index += 1) {
        const character = body[index]
        const digit = alphabet.indexOf(character)
        if (digit < 0) return false
        accumulator = (accumulator << 6) | digit
        bitCount += 6
        if (bitCount < 8) continue
        bitCount -= 8
        recent.push((accumulator >> bitCount) & 0xff)
        accumulator &= (1 << bitCount) - 1
        if (recent.length > 12) recent.shift()
        if (recent.length === 12) {
            const controlCount = recent.filter(isControlByte).length
            const encodedWindow = body.slice(Math.max(0, index - 15), index + 1)
            if (controlCount / recent.length >= 0.25
                || (/[0-9+/]/.test(encodedWindow) && recent.every(byte => byte >= 0x80))
                || new Set(recent).size <= 2) return true
        }
    }
    return false
}

function whitespaceEncodedOffsets(
    value: string,
    includeNaturalProse = false,
    includeEndOffsets = false,
    minimumLength = 16,
): string[] {
    if (!/\s/.test(value.trim()) || (!includeNaturalProse && looksLikeWhitespaceSeparatedProse(value))) return []
    const compact = compactBase64ImageCandidate(value)
    if (compact === null) return []
    const variants = [...new Set([compact, ...compact.split(/=+/)])]
    const paddingStart = compact.indexOf('=')
    if (paddingStart >= 0) {
        let paddingEnd = paddingStart
        while (paddingEnd < compact.length && compact[paddingEnd] === '=' && paddingEnd - paddingStart < 2) {
            paddingEnd += 1
        }
        variants.push(compact.slice(0, paddingEnd))
    }
    return [...new Set(variants.flatMap(candidate => (
        [0, 1, 2, 3].flatMap(startOffset => (
            (includeEndOffsets ? [0, 1, 2, 3] : [0])
                .filter(endOffset => candidate.length - startOffset - endOffset >= minimumLength)
                .map(endOffset => candidate.slice(startOffset, endOffset === 0 ? undefined : -endOffset))
        ))
    )))]
}

function looksLikeWhitespaceEncodedImage(value: string): boolean {
    return whitespaceEncodedOffsets(value, true, false, 4).some(looksLikeEncodedImage)
}

function looksLikeWhitespaceEncodedBinary(value: string): boolean {
    return whitespaceEncodedOffsets(value, true).some(compactValueLooksLikeControlBinary)
}

function looksLikeWhitespacePaddedBase64(value: string): boolean {
    if (!value.includes('=')) return false
    return whitespaceEncodedOffsets(value, false, true)
        .some(candidate => candidate.endsWith('=') && looksLikeGenericBase64(candidate))
}

function looksLikeWhitespaceGenericBase64(value: string): boolean {
    const requireDecodedTextEvidence = looksLikeWhitespaceSeparatedProse(value)
    return whitespaceEncodedOffsets(value, true, true)
        .some(candidate => looksLikeGenericBase64(candidate, requireDecodedTextEvidence))
}

function looksLikeEncodedImage(value: string): boolean {
    const compact = compactBase64ImageCandidate(value)
    if (compact === null) return false
    if (!/^[a-z0-9+/_-]+={0,2}$/i.test(compact)) return false
    const paddingLength = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0
    const body = compact.slice(0, compact.length - paddingLength).replace(/-/g, '+').replace(/_/g, '/')
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    let bytes: number[] = []
    let accumulator = 0
    let bitCount = 0
    for (const character of body) {
        const digit = alphabet.indexOf(character)
        if (digit < 0) return false
        accumulator = (accumulator << 6) | digit
        bitCount += 6
        if (bitCount >= 8) {
            bitCount -= 8
            bytes.push((accumulator >> bitCount) & 0xff)
            accumulator &= (1 << bitCount) - 1
        }
        if (bytes.length >= 4_224) {
            if (containsImageByteSignature(bytes)) return true
            bytes = bytes.slice(-128)
        }
    }
    return containsImageByteSignature(bytes)
}

function looksLikeHexEncodedImage(value: string): boolean {
    const compact = value.trim().replace(/\s+/g, '')
    if (compact.length < 16 || !/^[a-f0-9]+$/i.test(compact)) return false
    const chunkSize = 8_192
    const overlap = 256
    for (let nibbleOffset = 0; nibbleOffset < 2; nibbleOffset += 1) {
        const candidate = compact.slice(nibbleOffset)
        const aligned = candidate.slice(0, candidate.length - (candidate.length % 2))
        if (aligned.length < 16) continue
        for (let start = 0; start < aligned.length; start += chunkSize) {
            const chunk = aligned.slice(start, Math.min(aligned.length, start + chunkSize + overlap))
            const bytes: number[] = []
            for (let index = 0; index < chunk.length; index += 2) {
                bytes.push(Number.parseInt(chunk.slice(index, index + 2), 16))
            }
            if (containsImageByteSignature(bytes)) return true
        }
    }
    return false
}

function decodeBase64Prefix(value: string): number[] | null {
    const compact = compactBase64Candidate(value)
    if (compact === null) return null
    if (!/^[a-z0-9+/_-]+={0,2}$/i.test(compact)) return null
    const paddingLength = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0
    const body = compact.slice(0, compact.length - paddingLength).replace(/-/g, '+').replace(/_/g, '/')
    const remainder = body.length % 4
    if (remainder === 1
        || (paddingLength === 2 && remainder !== 2)
        || (paddingLength === 1 && remainder !== 3)
        || (paddingLength === 0 && compact.includes('='))) return null
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const bytes: number[] = []
    let accumulator = 0
    let bitCount = 0
    for (const character of body.slice(0, 1_024)) {
        const digit = alphabet.indexOf(character)
        if (digit < 0) return null
        accumulator = (accumulator << 6) | digit
        bitCount += 6
        if (bitCount >= 8) {
            bitCount -= 8
            bytes.push((accumulator >> bitCount) & 0xff)
            accumulator &= (1 << bitCount) - 1
        }
    }
    if (body.length <= 1_024 && accumulator !== 0) return null
    return bytes
}

function looksLikeNaturalPlainToken(value: string): boolean {
    return /^(?:(?:[A-Z][a-z]{2,}|[A-Z]{2,4})){2,}[0-9]*$/.test(value)
        || /^[a-z]{3,}(?:[A-Z][a-z]{2,})+[0-9]*$/.test(value)
        || /^(?=.*[a-z]{3})[a-z0-9]+(?:-[a-z0-9]+)+$/.test(value)
        || /^[a-z]{8,}[0-9]{1,6}$/.test(value)
        || /^(?=.*[a-z]{3})[a-z0-9]+(?:_[a-z0-9]+)+$/.test(value)
}

function decodedBytesLookLikeText(bytes: readonly number[]): boolean {
    if (bytes.length < 8) return false
    try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes))
        return decoded.trim().length > 0
            && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(decoded)
    } catch {
        return false
    }
}

function looksLikeGenericBase64(value: string, requireDecodedTextEvidence = false): boolean {
    const compact = compactBase64Candidate(value)
    if (compact === null) return false
    if (compact.length < 16
        || !/^[a-z0-9+/_-]+={0,2}$/i.test(compact)) return false
    const body = compact.replace(/=+$/, '')
    if (body.length % 4 === 1) return false
    const decoded = decodeBase64Prefix(compact)
    if (decoded !== null && !/^[a-z]+$/.test(body)) {
        const controlBytes = decoded.filter(byte => byte <= 0x08 || byte === 0x0b || byte === 0x0c
            || (byte >= 0x0e && byte <= 0x1f) || byte === 0x7f)
        if (controlBytes.length / Math.max(1, decoded.length) >= 0.25 || new Set(decoded).size <= 2) return true
    }
    if (looksLikeWhitespaceSeparatedProse(value)) return false
    if (/^[a-f0-9]+$/i.test(body) || looksLikeNaturalPlainToken(body)) return false
    const characterClasses = [/[a-z]/.test(body), /[A-Z]/.test(body), /[0-9]/.test(body)]
        .filter(Boolean).length
    if (characterClasses < 2) return false
    if (/=+$/.test(compact)) return compact.length % 4 === 0
    return decoded !== null && (!requireDecodedTextEvidence || decodedBytesLookLikeText(decoded))
}

function containsEncodedBinary(
    value: string,
    allowOpaqueIdentifier = false,
    allowDigestOrReference = false,
): boolean {
    if (looksLikeEncodedImage(value) || looksLikeWhitespaceEncodedImage(value)
        || looksLikeHexEncodedImage(value) || looksLikeWhitespaceEncodedBinary(value)
        || (!allowOpaqueIdentifier && looksLikeWhitespacePaddedBase64(value))
        || (!allowOpaqueIdentifier && looksLikeWhitespaceGenericBase64(value))
        || (!allowOpaqueIdentifier && looksLikeGenericBase64(value))) return true
    const candidates = value.match(/[a-z0-9+/_-]{16,}={0,2}/gi) ?? []
    const whitespaceCandidates = value.match(/[a-z0-9+/_=-]+(?:\s+[a-z0-9+/_=-]+)+/gi) ?? []
    const hexCandidates = value.match(/[a-f0-9]{16,}/gi) ?? []
    const whitespaceHexCandidates = value.match(/[a-f0-9]+(?:\s+[a-f0-9]+)+/gi) ?? []
    return whitespaceCandidates.some(candidate => (
        looksLikeEncodedImage(candidate)
        || looksLikeWhitespaceEncodedImage(candidate)
        || looksLikeWhitespaceEncodedBinary(candidate)
        || (!allowOpaqueIdentifier && looksLikeWhitespacePaddedBase64(candidate))
        || (!allowOpaqueIdentifier && looksLikeWhitespaceGenericBase64(candidate))
    ))
        || candidates.some(candidate => (
            looksLikeEncodedImage(candidate) || (!allowOpaqueIdentifier && looksLikeGenericBase64(candidate))
        ))
        || hexCandidates.some(candidate => (
            looksLikeHexEncodedImage(candidate)
            || (!allowOpaqueIdentifier && !allowDigestOrReference && looksLikeHighEntropyHex(candidate))
        ))
        || whitespaceHexCandidates.some(looksLikeHexEncodedImage)
}

const OPAQUE_IDENTIFIER_FIELDS = new Set([
    // Agent envelopes/results use these public identity/reference fields. Their
    // random IDs are not generic encoded payloads; credential/image/path checks
    // still run, exactly as for the existing id/requestId/planId fields below.
    'clientid', 'workspaceid', 'correlationid', 'idempotencykey', 'draftid', 'runid', 'jobid',
    'id', 'actionid', 'activeprofileid', 'artifactid', 'baseopid', 'bookmarkid', 'characterid', 'characterids',
    'defaultparamspresetid', 'defaultrecipeid', 'deviceid', 'documentid', 'entityid', 'fromid', 'libraryimageid',
    'maskresourceid', 'moduleid', 'moduleids', 'opid', 'paramspresetid', 'paramspresetids', 'parentid', 'planid',
    'preferredid', 'presetid', 'profileid', 'randomruleid', 'randomruleids', 'recipeid', 'recipeids', 'requestid',
    'resourceid', 'resourceids', 'ruleid', 'sceneid', 'sceneids', 'selectedoptionids', 'sourceimageresourceid',
    'sourcejobid', 'sourcesceneid', 'targetpresetid', 'toid', 'uploadjobid', 'userid', 'variantid',
])

function isOpaqueIdentifierField(fieldKey: string | undefined): boolean {
    return fieldKey !== undefined && OPAQUE_IDENTIFIER_FIELDS.has(normalizeSyncFieldKey(fieldKey))
}

function isMachineCode(value: string, fieldKey: string | undefined): boolean {
    if (fieldKey === undefined || !['code', 'issuecodes'].includes(normalizeSyncFieldKey(fieldKey))) return false
    // Protocol enum labels such as SOURCE_REVISION_CONFLICT can accidentally
    // decode to control bytes. Only bounded snake/kebab-case codes receive the
    // existing generic-entropy exemption; all credential/image/path checks stay.
    return value.length <= 128
        && /^(?:[A-Z][A-Z0-9]*(?:_[A-Z][A-Z0-9]*)+|[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)+)$/.test(value)
}

function isDigestOrReferenceField(fieldKey: string | undefined): boolean {
    if (fieldKey === undefined) return false
    const normalized = normalizeSyncFieldKey(fieldKey)
    return /(?:checksum|digest|hash)$/.test(normalized) || normalized === 'remotekey'
}

function looksLikeHighEntropyHex(value: string): boolean {
    return value.length >= 32
        && /[a-f]/i.test(value)
        && /[0-9]/.test(value)
        && new Set(value.toLowerCase()).size >= 8
}

function decodePercentMaterial(value: string): string | null {
    let decoded = value
    for (let pass = 0; pass < 8; pass += 1) {
        let failed = false
        const next = decoded.replace(/(?:%[a-f0-9]{2})+/gi, segment => {
            try {
                return decodeURIComponent(segment)
            } catch {
                failed = true
                return segment
            }
        })
        if (failed) return null
        if (next === decoded) return decoded
        decoded = next
    }
    return /%[a-f0-9]{2}/i.test(decoded) ? null : decoded
}

function containsBasicCredential(value: string): boolean {
    const candidates = [...value.matchAll(/\bbasic\s+([a-z0-9+/]{8,}={0,2})(?:$|[^a-z0-9+/=])/gi)]
    return candidates.some(match => {
        const decoded = decodeBase64Prefix(match[1])
        return decoded !== null && String.fromCharCode(...decoded).includes(':')
    })
}

function containsCredentialMaterial(value: string): boolean {
    return /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/i.test(value)
        || /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(value)
        || /\b(?=[a-z0-9+/=]{40}\b)(?=[a-z0-9+/=]*[+/])[a-z0-9+/=]{40}\b/i.test(value)
        || /\b(?:sk-(?:proj-)?|gh[pousr]_|xox[baprs]-|AIza)[a-z0-9_+/=-]{8,}/i.test(value)
        || /(?:^|[^a-z0-9_-])eyJ[a-z0-9_-]{2,}\.[a-z0-9_-]{2,}\.[a-z0-9_-]*(?:$|[^a-z0-9_-])/i.test(value)
        || /\bbearer\s+[a-z0-9._~+\/-]{8,}/i.test(value)
        || containsBasicCredential(value)
        || /\bdigest\s+(?=[^\r\n]{0,512}\b(?:username|realm|nonce|uri|response)\s*=)/i.test(value)
        || /\b(?:authorization|proxy-authorization|(?:set-)?cookie|session|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|sig|signature|hmac|policy)\s*[:=]/i.test(value)
}

function containsLocalPathMaterial(value: string): boolean {
    return /[a-z]:[\\/]|\\\\/i.test(value)
        || /(?:\$(?:\{)?(?:HOME|USERPROFILE|TMPDIR)(?:\})?|%(?:USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|TEMP|TMP)%)(?:[\\/]|$)/i
            .test(value)
        || /\/(?:home|users|tmp|var|etc|storage|sdcard|data|private|volumes|root|opt|usr|mnt|media)(?:\/|$)/i
            .test(value)
        || /(?:^|[^a-z0-9_])\/(?:\/|$|[^/\s"'<>]+)/i.test(value)
        || /(?:^|[^a-z0-9_])~[\\/]/i.test(value)
        || /(?:^|[^a-z0-9_])\\[^\\\s"'<>]+/i.test(value)
}

function unsafeString(value: string, fieldKey?: string): boolean {
    if (value.length > MAX_STRING_LENGTH) return true
    const decodedMaterial = decodePercentMaterial(value.trim())
    if (decodedMaterial === null) return true
    const normalized = decodedMaterial
    if (/\b(?:data:|blob:|file:|content:\/\/)/i.test(normalized)) return true
    if (/<svg(?:\s|\/?>)/i.test(normalized)) return true
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(normalized)) return true
    if (containsRawImageSignature(normalized)) return true
    if (containsCredentialMaterial(normalized)) return true
    let nonUrlMaterial = normalized
    const originalMaterial = value.trim()
    const urlScanMaterial = /https?:\/\//i.test(originalMaterial) ? originalMaterial : normalized
    if (/https?:\/\//i.test(urlScanMaterial)) {
        const candidates = urlScanMaterial.match(/https?:\/\/[^\s"'<>]+/gi) ?? []
        for (const candidate of candidates) {
            try {
                const url = new URL(candidate)
                if (url.username || url.password) return true
                if ([...url.searchParams.entries()].some(([key, parameterValue]) => {
                    const normalizedKey = normalizeSyncFieldKey(key)
                    const decodedParameter = decodePercentMaterial(parameterValue)
                    return /^(?:auth|sig|signature|hmac|policy)$/i.test(normalizedKey)
                        || /(?:token|signature|credential|security|session|cookie|authorization|accesskeyid|keypairid|policy)/i
                            .test(normalizedKey)
                        || (decodedParameter !== null && /\b(?:bearer|basic|digest)\s+\S+/i.test(decodedParameter))
                        || decodedParameter === null
                        || containsLocalPathMaterial(decodedParameter)
                        || containsCredentialMaterial(decodedParameter)
                        || containsEncodedBinary(decodedParameter)
                })) return true
                const urlMaterial = `${url.pathname}${url.hash}`
                if (containsCredentialMaterial(urlMaterial) || containsEncodedBinary(urlMaterial)) return true
            } catch {
                return true
            }
            nonUrlMaterial = nonUrlMaterial.replace(decodePercentMaterial(candidate) ?? candidate, ' ')
        }
    }
    if (containsLocalPathMaterial(nonUrlMaterial)) return true
    if (containsEncodedBinary(
        normalized,
        isOpaqueIdentifierField(fieldKey) || isMachineCode(normalized, fieldKey),
        isDigestOrReferenceField(fieldKey),
    )) return true
    return false
}

interface ScanBudget {
    nodes: number
    stringCharacters: number
}

function assertSafeValue(
    value: unknown,
    ancestors: Set<object>,
    budget: ScanBudget,
    depth: number,
    fieldKey?: string,
): void {
    budget.nodes += 1
    if (budget.nodes > MAX_NODES || depth > MAX_DEPTH) invalid()
    if (typeof value === 'string') {
        budget.stringCharacters += value.length
        if (budget.stringCharacters > MAX_TOTAL_STRING_LENGTH) invalid()
        if (unsafeString(value, fieldKey)) {
            throw new SyncSanitizationError('E_SYNC_PAYLOAD_FORBIDDEN', 'Sync payload contains forbidden string material.')
        }
        return
    }
    if (value === null || typeof value === 'boolean') return
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) invalid()
        return
    }
    if (typeof value !== 'object') invalid()
    if (ancestors.has(value)) invalid()
    ancestors.add(value)
    try {
        if (Array.isArray(value)) {
            if (value.length > MAX_NODES) invalid()
            if (value.length >= 2
                && value.every(entry => Number.isInteger(entry) && Number(entry) >= 0 && Number(entry) <= 255)
                && containsImageByteSignature(value as number[])) {
                throw new SyncSanitizationError('E_SYNC_PAYLOAD_FORBIDDEN', 'Sync payload contains image byte material.')
            }
            value.forEach(entry => assertSafeValue(entry, ancestors, budget, depth + 1, fieldKey))
            return
        }
        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) invalid()
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            const decodedKey = decodePercentMaterial(key)
            if (decodedKey === null
                || isForbiddenSyncFieldKey(key)
                || isForbiddenSyncFieldKey(decodedKey)
                || unsafeString(key)) {
                throw new SyncSanitizationError('E_SYNC_PAYLOAD_FORBIDDEN', 'Sync payload contains a forbidden field.')
            }
            assertSafeValue(child, ancestors, budget, depth + 1, key)
        }
    } finally {
        ancestors.delete(value)
    }
}

/** Whole-envelope invariant used by constructors and every persistence boundary. */
export function assertSyncPayloadSafe(value: unknown): asserts value is JsonObject {
    if (!isRecord(value)) invalid()
    assertSafeValue(value, new Set<object>(), { nodes: 0, stringCharacters: 0 }, 0)
}
