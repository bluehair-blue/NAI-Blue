import { describe, expect, it, vi } from 'vitest'

import {
    DesktopProviderResultSpool,
    type ProviderResultSpoolStorage,
} from '@/adapters/generation/desktop-provider-result-spool'
import { ProviderResultSpoolError } from '@/application/generation/provider-result-spool'

const DIRECTORY = 'nai-blue/provider-result-spool'
const NOW = '2026-09-03T00:00:00.000Z'
const LATER = '2026-09-04T00:00:00.001Z'
const BYTES = new Uint8Array([1, 2, 3, 4])

class MemoryStorage implements ProviderResultSpoolStorage {
    readonly files = new Map<string, Uint8Array>()
    readonly operations: string[] = []
    failReceiptRename = false
    dataReadCount = 0
    replaceDataOnSecondRead = false

    async ensureDirectory(path: string): Promise<void> {
        this.operations.push(`mkdir:${path}`)
    }

    async exists(path: string): Promise<boolean> {
        return this.files.has(path)
    }

    async write(path: string, bytes: Uint8Array): Promise<void> {
        this.operations.push(`write:${path}`)
        this.files.set(path, new Uint8Array(bytes))
    }

    async read(path: string): Promise<Uint8Array> {
        this.operations.push(`read:${path}`)
        const bytes = this.files.get(path)
        if (bytes === undefined) throw new Error(`missing ${path}`)
        if (path.endsWith('.bin')) {
            this.dataReadCount += 1
            if (this.replaceDataOnSecondRead && this.dataReadCount === 2) return new Uint8Array([9])
        }
        return new Uint8Array(bytes)
    }

    async rename(from: string, to: string): Promise<void> {
        this.operations.push(`rename:${from}->${to}`)
        if (this.failReceiptRename && from.endsWith('.json.tmp')) {
            this.failReceiptRename = false
            throw new Error('injected receipt rename failure')
        }
        const bytes = this.files.get(from)
        if (bytes === undefined) throw new Error(`missing ${from}`)
        if (this.files.has(to)) throw new Error(`exists ${to}`)
        this.files.set(to, bytes)
        this.files.delete(from)
    }

    async remove(path: string): Promise<void> {
        this.operations.push(`remove:${path}`)
        this.files.delete(path)
    }

    async list(path: string): Promise<readonly string[]> {
        const prefix = `${path}/`
        return [...this.files.keys()]
            .filter(value => value.startsWith(prefix))
            .map(value => value.slice(prefix.length))
            .sort()
    }

    readonly flush = vi.fn(async (path: string) => {
        this.operations.push(`flush:${path}`)
    })
}

function input(overrides: Partial<Parameters<DesktopProviderResultSpool['commit']>[0]> = {}) {
    return {
        spoolId: 'spool-1',
        attemptId: 'job-1:1',
        contentType: 'image/png',
        bytes: BYTES,
        committedAt: NOW,
        ...overrides,
    }
}

describe('DesktopProviderResultSpool', () => {
    it('readback-verifies temp bytes before atomic sibling renames', async () => {
        const storage = new MemoryStorage()
        const spool = new DesktopProviderResultSpool(storage)

        const receipt = await spool.commit(input())

        expect(receipt).toEqual({
            schemaVersion: 1,
            spoolId: 'spool-1',
            attemptId: 'job-1:1',
            contentType: 'image/png',
            byteLength: 4,
            sha256: 'sha256:9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a',
            committedAt: NOW,
        })
        expect(await spool.read('spool-1')).toEqual(BYTES)
        expect(storage.flush).toHaveBeenCalledTimes(2)
        expect(storage.operations.indexOf(`read:${DIRECTORY}/spool-1.tmp`))
            .toBeLessThan(storage.operations.indexOf(`rename:${DIRECTORY}/spool-1.tmp->${DIRECTORY}/spool-1.bin`))
        expect(JSON.stringify(receipt)).not.toMatch(/path|bytes|token/i)
    })

    it('rejects corrupted committed bytes', async () => {
        const storage = new MemoryStorage()
        const spool = new DesktopProviderResultSpool(storage)
        await spool.commit(input())
        storage.files.set(`${DIRECTORY}/spool-1.bin`, new Uint8Array([9]))

        await expect(spool.verify('spool-1')).rejects.toMatchObject({
            name: 'ProviderResultSpoolError',
            code: 'checksum-mismatch',
        })
    })

    it('returns the same bytes it verified instead of performing a replaceable second read', async () => {
        const storage = new MemoryStorage()
        const spool = new DesktopProviderResultSpool(storage)
        await spool.commit(input())
        storage.dataReadCount = 0
        storage.replaceDataOnSecondRead = true

        await expect(spool.read('spool-1')).resolves.toEqual(BYTES)
        expect(storage.dataReadCount).toBe(1)
    })

    it('uses verified readback when the platform exposes no flush primitive', async () => {
        const storage = new MemoryStorage()
        Object.defineProperty(storage, 'flush', { value: undefined })
        const spool = new DesktopProviderResultSpool(storage)

        await expect(spool.commit(input())).resolves.toMatchObject({ spoolId: 'spool-1' })
        expect(storage.operations).toContain(`read:${DIRECTORY}/spool-1.tmp`)
        await expect(spool.verify('spool-1')).resolves.toMatchObject({ byteLength: 4 })
    })

    it('promotes an interrupted data commit from its verified receipt temp', async () => {
        const storage = new MemoryStorage()
        storage.failReceiptRename = true
        const spool = new DesktopProviderResultSpool(storage)
        await expect(spool.commit(input())).rejects.toThrow('injected receipt rename failure')

        const result = await new DesktopProviderResultSpool(storage).reconcile()

        expect(result.promotedSpoolIds).toEqual(['spool-1'])
        expect(result.receipts).toHaveLength(1)
        await expect(spool.read('spool-1')).resolves.toEqual(BYTES)
    })

    it('removes incomplete temp and orphan files during reconciliation', async () => {
        const storage = new MemoryStorage()
        storage.files.set(`${DIRECTORY}/temp-only.tmp`, BYTES)
        storage.files.set(`${DIRECTORY}/orphan.bin`, BYTES)

        const result = await new DesktopProviderResultSpool(storage).reconcile()

        expect(result.removedTemporarySpoolIds).toEqual(['temp-only'])
        expect(result.removedOrphanSpoolIds).toEqual(['orphan'])
        expect(storage.files.size).toBe(0)
    })

    it('distinguishes cleaned temporary corruption from retained committed corruption', async () => {
        const storage = new MemoryStorage()
        const spool = new DesktopProviderResultSpool(storage)
        await spool.commit(input())
        storage.files.set(`${DIRECTORY}/spool-1.bin`, new Uint8Array([9]))
        storage.files.set(`${DIRECTORY}/temp-corrupt.json.tmp`, new TextEncoder().encode('{invalid'))

        const result = await spool.reconcile()

        expect(result.corruptSpoolIds).toEqual(['spool-1', 'temp-corrupt'])
        expect(result.unresolvedCorruptSpoolIds).toEqual(['spool-1'])
        expect(result.removedTemporarySpoolIds).toContain('temp-corrupt')
        expect(storage.files.has(`${DIRECTORY}/temp-corrupt.json.tmp`)).toBe(false)
        expect(storage.files.has(`${DIRECTORY}/spool-1.bin`)).toBe(true)
        expect(result.receipts).toEqual([])
    })

    it('removes committed data only after storage, release, and 24-hour grace are complete', async () => {
        const storage = new MemoryStorage()
        const spool = new DesktopProviderResultSpool(storage)
        await spool.commit(input())

        await expect(spool.removeIfEligible({
            spoolId: 'spool-1',
            now: NOW,
            terminalAt: NOW,
            storageTerminal: true,
            requiredReleaseTerminal: true,
        })).resolves.toBe(false)
        await expect(spool.removeIfEligible({
            spoolId: 'spool-1',
            now: LATER,
            terminalAt: NOW,
            storageTerminal: true,
            requiredReleaseTerminal: false,
        })).resolves.toBe(false)
        await expect(spool.removeIfEligible({
            spoolId: 'spool-1',
            now: LATER,
            terminalAt: NOW,
            storageTerminal: true,
            requiredReleaseTerminal: true,
        })).resolves.toBe(true)
        await expect(spool.verify('spool-1')).rejects.toBeInstanceOf(ProviderResultSpoolError)
    })

    it('explicitly discards only the exact verified receipt without a grace delay', async () => {
        const storage = new MemoryStorage()
        const spool = new DesktopProviderResultSpool(storage)
        const receipt = await spool.commit(input())

        await expect(spool.discard({ ...receipt, attemptId: 'job-2:1' }))
            .rejects.toMatchObject({ code: 'conflict' })
        await expect(spool.verify(receipt.spoolId)).resolves.toEqual(receipt)
        await spool.discard(receipt)
        await expect(spool.verify(receipt.spoolId)).rejects.toMatchObject({ code: 'missing' })
    })

    it('is idempotent only for the same receipt and rejects spool ID reuse', async () => {
        const storage = new MemoryStorage()
        const spool = new DesktopProviderResultSpool(storage)
        const first = await spool.commit(input())

        await expect(spool.commit(input())).resolves.toEqual(first)
        await expect(spool.commit(input({ attemptId: 'job-2:1' }))).rejects.toMatchObject({
            code: 'conflict',
        })
    })

    it('accepts the maximum Queue-derived attempt ID and rejects one character beyond it', async () => {
        const storage = new MemoryStorage()
        const spool = new DesktopProviderResultSpool(storage)
        const maximumAttemptId = `${'j'.repeat(256)}:${'9'.repeat(16)}`
        expect(maximumAttemptId).toHaveLength(273)

        await expect(spool.commit(input({ attemptId: maximumAttemptId })))
            .resolves.toMatchObject({ attemptId: maximumAttemptId })
        await expect(spool.commit(input({
            spoolId: 'spool-2',
            attemptId: `${maximumAttemptId}0`,
        }))).rejects.toMatchObject({ code: 'invalid-input' })
    })
})
