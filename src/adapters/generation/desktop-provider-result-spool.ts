import {
    BaseDirectory,
    exists,
    mkdir,
    readDir,
    readFile,
    remove,
    rename,
    writeFile,
} from '@tauri-apps/plugin-fs'

import {
    ProviderResultSpoolError,
    isProviderSha256,
    type ProviderResultSpool,
    type SpoolCommitInput,
    type SpoolReconcileResult,
    type SpoolRemovalEligibility,
} from '@/application/generation/provider-result-spool'
import type { SpoolReceipt } from '@/domain/queue/provider-result'
import { sha256Bytes } from '@/lib/binary-digest'

const SPOOL_DIRECTORY = 'nai-blue/provider-result-spool'
const GRACE_PERIOD_MS = 24 * 60 * 60 * 1_000
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export interface ProviderResultSpoolStorage {
    ensureDirectory(path: string): Promise<void>
    exists(path: string): Promise<boolean>
    write(path: string, bytes: Uint8Array): Promise<void>
    read(path: string): Promise<Uint8Array>
    rename(from: string, to: string): Promise<void>
    remove(path: string): Promise<void>
    list(path: string): Promise<readonly string[]>
    /** Optional native fsync seam. Tauri plugin-fs currently exposes no flush operation. */
    flush?(path: string): Promise<void>
}

const tauriStorage: ProviderResultSpoolStorage = {
    ensureDirectory: async path => {
        if (!await exists(path, { baseDir: BaseDirectory.AppData })) {
            await mkdir(path, { baseDir: BaseDirectory.AppData, recursive: true })
        }
    },
    exists: path => exists(path, { baseDir: BaseDirectory.AppData }),
    write: (path, bytes) => writeFile(path, bytes, { baseDir: BaseDirectory.AppData }),
    read: path => readFile(path, { baseDir: BaseDirectory.AppData }),
    rename: (from, to) => rename(from, to, {
        oldPathBaseDir: BaseDirectory.AppData,
        newPathBaseDir: BaseDirectory.AppData,
    }),
    remove: path => remove(path, { baseDir: BaseDirectory.AppData }),
    list: async path => {
        if (!await exists(path, { baseDir: BaseDirectory.AppData })) return []
        return (await readDir(path, { baseDir: BaseDirectory.AppData }))
            .filter(entry => entry.isFile)
            .map(entry => entry.name)
            .sort()
    },
}

function assertSpoolId(value: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
        throw new ProviderResultSpoolError('invalid-input', 'spoolId is invalid')
    }
}

/** Queue job IDs are 256 chars and a safe-integer attempt suffix adds up to 17. */
function assertAttemptId(value: string): void {
    if (value.length === 0 || value.length > 273) {
        throw new ProviderResultSpoolError('invalid-input', 'attemptId is invalid')
    }
}

function assertTimestamp(value: string, label: string): number {
    const parsed = Date.parse(value)
    if (!Number.isFinite(parsed)) throw new ProviderResultSpoolError('invalid-input', `${label} is invalid`)
    return parsed
}

function dataPath(spoolId: string): string {
    return `${SPOOL_DIRECTORY}/${spoolId}.bin`
}

function dataTempPath(spoolId: string): string {
    return `${SPOOL_DIRECTORY}/${spoolId}.tmp`
}

function receiptPath(spoolId: string): string {
    return `${SPOOL_DIRECTORY}/${spoolId}.json`
}

function receiptTempPath(spoolId: string): string {
    return `${SPOOL_DIRECTORY}/${spoolId}.json.tmp`
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseReceipt(bytes: Uint8Array): SpoolReceipt {
    let value: unknown
    try {
        value = JSON.parse(decoder.decode(bytes))
    } catch (error) {
        throw new ProviderResultSpoolError('corrupt-receipt', 'Provider result spool receipt is invalid', { cause: error })
    }
    const receiptKeys = [
        'schemaVersion', 'spoolId', 'attemptId', 'contentType',
        'byteLength', 'sha256', 'committedAt',
    ]
    if (!isRecord(value)
        || Object.keys(value).sort().join('\0') !== receiptKeys.sort().join('\0')
        || value.schemaVersion !== 1
        || typeof value.spoolId !== 'string'
        || typeof value.attemptId !== 'string'
        || typeof value.contentType !== 'string'
        || !value.contentType.trim()
        || value.contentType.length > 128
        || !Number.isSafeInteger(value.byteLength)
        || (value.byteLength as number) < 0
        || !isProviderSha256(value.sha256)
        || typeof value.committedAt !== 'string'
        || !Number.isFinite(Date.parse(value.committedAt))) {
        throw new ProviderResultSpoolError('corrupt-receipt', 'Provider result spool receipt is invalid')
    }
    assertSpoolId(value.spoolId)
    assertAttemptId(value.attemptId)
    return Object.freeze(value as unknown as SpoolReceipt)
}

function sameReceipt(left: SpoolReceipt, right: SpoolReceipt): boolean {
    return left.spoolId === right.spoolId
        && left.attemptId === right.attemptId
        && left.contentType === right.contentType
        && left.byteLength === right.byteLength
        && left.sha256 === right.sha256
        && left.committedAt === right.committedAt
}

async function removeIfPresent(storage: ProviderResultSpoolStorage, path: string): Promise<void> {
    if (await storage.exists(path)) await storage.remove(path)
}

/**
 * Uses app-data sibling renames and mandatory readback verification. plugin-fs
 * has no fsync/flush API, so production cannot promise power-loss durability;
 * injected native storage may supply flush without changing the spool contract.
 */
export class DesktopProviderResultSpool implements ProviderResultSpool {
    constructor(private readonly storage: ProviderResultSpoolStorage = tauriStorage) {}

    private async verifiedContent(spoolId: string): Promise<{
        readonly receipt: SpoolReceipt
        readonly bytes: Uint8Array
    }> {
        assertSpoolId(spoolId)
        if (!await this.storage.exists(receiptPath(spoolId)) || !await this.storage.exists(dataPath(spoolId))) {
            throw new ProviderResultSpoolError('missing', 'Provider result spool is missing')
        }
        const receipt = parseReceipt(await this.storage.read(receiptPath(spoolId)))
        if (receipt.spoolId !== spoolId) {
            throw new ProviderResultSpoolError('corrupt-receipt', 'Spool receipt identity does not match its file')
        }
        const bytes = new Uint8Array(await this.storage.read(dataPath(spoolId)))
        if (bytes.byteLength !== receipt.byteLength || await sha256Bytes(bytes) !== receipt.sha256) {
            throw new ProviderResultSpoolError('checksum-mismatch', 'Provider result spool checksum does not match')
        }
        return { receipt, bytes }
    }

    async commit(input: SpoolCommitInput): Promise<SpoolReceipt> {
        assertSpoolId(input.spoolId)
        assertAttemptId(input.attemptId)
        assertTimestamp(input.committedAt, 'committedAt')
        if (!input.contentType.trim() || input.contentType.length > 128 || input.bytes.byteLength === 0) {
            throw new ProviderResultSpoolError('invalid-input', 'Spool content must have a bounded type and non-empty bytes')
        }
        await this.storage.ensureDirectory(SPOOL_DIRECTORY)
        const bytes = new Uint8Array(input.bytes)
        const receipt: SpoolReceipt = Object.freeze({
            schemaVersion: 1,
            spoolId: input.spoolId,
            attemptId: input.attemptId,
            contentType: input.contentType,
            byteLength: bytes.byteLength,
            sha256: await sha256Bytes(bytes) as SpoolReceipt['sha256'],
            committedAt: input.committedAt,
        })
        if (await this.storage.exists(receiptPath(input.spoolId))) {
            const existing = await this.verify(input.spoolId)
            if (!sameReceipt(existing, receipt)) {
                throw new ProviderResultSpoolError('conflict', 'Spool ID already belongs to different content')
            }
            return existing
        }
        if (await this.storage.exists(dataPath(input.spoolId))) {
            throw new ProviderResultSpoolError('conflict', 'Spool data exists without a committed receipt')
        }

        await removeIfPresent(this.storage, dataTempPath(input.spoolId))
        await removeIfPresent(this.storage, receiptTempPath(input.spoolId))
        await this.storage.write(dataTempPath(input.spoolId), bytes)
        await this.storage.flush?.(dataTempPath(input.spoolId))
        const dataReadback = await this.storage.read(dataTempPath(input.spoolId))
        if (dataReadback.byteLength !== receipt.byteLength
            || await sha256Bytes(dataReadback) !== receipt.sha256) {
            throw new ProviderResultSpoolError('checksum-mismatch', 'Spool temporary data failed readback verification')
        }
        const receiptBytes = encoder.encode(JSON.stringify(receipt))
        await this.storage.write(receiptTempPath(input.spoolId), receiptBytes)
        await this.storage.flush?.(receiptTempPath(input.spoolId))
        const receiptReadback = parseReceipt(await this.storage.read(receiptTempPath(input.spoolId)))
        if (!sameReceipt(receiptReadback, receipt)) {
            throw new ProviderResultSpoolError('corrupt-receipt', 'Spool temporary receipt failed readback verification')
        }
        await this.storage.rename(dataTempPath(input.spoolId), dataPath(input.spoolId))
        await this.storage.rename(receiptTempPath(input.spoolId), receiptPath(input.spoolId))
        return this.verify(input.spoolId)
    }

    async verify(spoolId: string): Promise<SpoolReceipt> {
        return (await this.verifiedContent(spoolId)).receipt
    }

    async read(spoolId: string): Promise<Uint8Array> {
        return (await this.verifiedContent(spoolId)).bytes
    }

    async discard(receipt: SpoolReceipt): Promise<void> {
        const verified = await this.verify(receipt.spoolId)
        if (!sameReceipt(verified, receipt)) {
            throw new ProviderResultSpoolError('conflict', 'Discard receipt does not match the Provider spool')
        }
        // Receipt first makes an interrupted discard fail closed as orphan data,
        // which startup reconciliation can remove without treating it as a result.
        await removeIfPresent(this.storage, receiptPath(receipt.spoolId))
        await removeIfPresent(this.storage, dataPath(receipt.spoolId))
        await removeIfPresent(this.storage, receiptTempPath(receipt.spoolId))
        await removeIfPresent(this.storage, dataTempPath(receipt.spoolId))
    }

    async removeIfEligible(input: SpoolRemovalEligibility): Promise<boolean> {
        assertSpoolId(input.spoolId)
        const now = assertTimestamp(input.now, 'now')
        const terminalAt = assertTimestamp(input.terminalAt, 'terminalAt')
        if (!input.storageTerminal || !input.requiredReleaseTerminal
            || now - terminalAt < GRACE_PERIOD_MS) return false
        await removeIfPresent(this.storage, receiptPath(input.spoolId))
        await removeIfPresent(this.storage, dataPath(input.spoolId))
        await removeIfPresent(this.storage, receiptTempPath(input.spoolId))
        await removeIfPresent(this.storage, dataTempPath(input.spoolId))
        return true
    }

    async list(): Promise<readonly SpoolReceipt[]> {
        await this.storage.ensureDirectory(SPOOL_DIRECTORY)
        const names = await this.storage.list(SPOOL_DIRECTORY)
        const receipts: SpoolReceipt[] = []
        for (const name of names.filter(value => value.endsWith('.json') && !value.endsWith('.json.tmp'))) {
            const spoolId = name.slice(0, -'.json'.length)
            receipts.push(await this.verify(spoolId))
        }
        return Object.freeze(receipts.sort((left, right) => left.spoolId.localeCompare(right.spoolId)))
    }

    async reconcile(): Promise<SpoolReconcileResult> {
        await this.storage.ensureDirectory(SPOOL_DIRECTORY)
        const names = await this.storage.list(SPOOL_DIRECTORY)
        const promoted: string[] = []
        const removedTemps: string[] = []
        const removedOrphans: string[] = []
        const corrupt: string[] = []
        const unresolvedCorrupt: string[] = []

        for (const name of names.filter(value => value.endsWith('.json.tmp'))) {
            const spoolId = name.slice(0, -'.json.tmp'.length)
            try {
                const receipt = parseReceipt(await this.storage.read(receiptTempPath(spoolId)))
                if (receipt.spoolId === spoolId && await this.storage.exists(dataPath(spoolId))) {
                    const bytes = await this.storage.read(dataPath(spoolId))
                    if (bytes.byteLength === receipt.byteLength && await sha256Bytes(bytes) === receipt.sha256) {
                        if (!await this.storage.exists(receiptPath(spoolId))) {
                            await this.storage.rename(receiptTempPath(spoolId), receiptPath(spoolId))
                            promoted.push(spoolId)
                            continue
                        }
                    }
                }
            } catch {
                corrupt.push(spoolId)
            }
            await removeIfPresent(this.storage, receiptTempPath(spoolId))
            await removeIfPresent(this.storage, dataTempPath(spoolId))
            removedTemps.push(spoolId)
        }

        const afterPromotion = await this.storage.list(SPOOL_DIRECTORY)
        for (const name of afterPromotion.filter(value => value.endsWith('.tmp') && !value.endsWith('.json.tmp'))) {
            const spoolId = name.slice(0, -'.tmp'.length)
            await removeIfPresent(this.storage, dataTempPath(spoolId))
            removedTemps.push(spoolId)
        }
        const current = await this.storage.list(SPOOL_DIRECTORY)
        for (const name of current.filter(value => value.endsWith('.bin'))) {
            const spoolId = name.slice(0, -'.bin'.length)
            if (!await this.storage.exists(receiptPath(spoolId))) {
                await this.storage.remove(dataPath(spoolId))
                removedOrphans.push(spoolId)
            }
        }
        for (const name of current.filter(value => value.endsWith('.json') && !value.endsWith('.json.tmp'))) {
            const spoolId = name.slice(0, -'.json'.length)
            if (!await this.storage.exists(dataPath(spoolId))) {
                await this.storage.remove(receiptPath(spoolId))
                removedOrphans.push(spoolId)
            }
        }

        const receipts: SpoolReceipt[] = []
        for (const name of await this.storage.list(SPOOL_DIRECTORY)) {
            if (!name.endsWith('.json') || name.endsWith('.json.tmp')) continue
            const spoolId = name.slice(0, -'.json'.length)
            try {
                receipts.push(await this.verify(spoolId))
            } catch {
                corrupt.push(spoolId)
                unresolvedCorrupt.push(spoolId)
            }
        }
        return Object.freeze({
            receipts: Object.freeze(receipts.sort((left, right) => left.spoolId.localeCompare(right.spoolId))),
            promotedSpoolIds: Object.freeze([...new Set(promoted)].sort()),
            removedTemporarySpoolIds: Object.freeze([...new Set(removedTemps)].sort()),
            removedOrphanSpoolIds: Object.freeze([...new Set(removedOrphans)].sort()),
            corruptSpoolIds: Object.freeze([...new Set(corrupt)].sort()),
            unresolvedCorruptSpoolIds: Object.freeze([...new Set(unresolvedCorrupt)].sort()),
        })
    }
}
