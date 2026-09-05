import { beforeEach, describe, expect, it, vi } from 'vitest'

type WriteMode = 'success' | 'quota' | 'abort' | 'readback-mismatch'

interface FakeIndexedDBControl {
    writeMode: WriteMode
    values: Map<string, string>
}

function installFakeIndexedDB(options: { blocked?: boolean } = {}): FakeIndexedDBControl {
    const control: FakeIndexedDBControl = {
        writeMode: 'success',
        values: new Map<string, string>(),
    }

    const database = {
        objectStoreNames: { contains: () => true },
        close: vi.fn(),
        onclose: null as (() => void) | null,
        onerror: null as ((event: Event) => void) | null,
        transaction: (_storeName: string, transactionMode: IDBTransactionMode) => {
            const transaction = {
                error: null as DOMException | null,
                oncomplete: null as (() => void) | null,
                onerror: null as (() => void) | null,
                onabort: null as (() => void) | null,
                abort: vi.fn(),
                objectStore: () => ({
                    getKey: (key: string) => {
                        const request = { result: undefined as string | undefined,
                            onsuccess: null as (() => void) | null, onerror: null as (() => void) | null }
                        queueMicrotask(() => {
                            request.result = control.values.has(key) ? key : undefined
                            request.onsuccess?.()
                        })
                        return request
                    },
                    put: (value: string, key: string) => {
                        const request = {
                            error: null as DOMException | null,
                            onsuccess: null as (() => void) | null,
                            onerror: null as (() => void) | null,
                        }
                        queueMicrotask(() => {
                            if (control.writeMode === 'quota') {
                                const error = new DOMException('Synthetic quota failure', 'QuotaExceededError')
                                request.error = error
                                transaction.error = error
                                request.onerror?.()
                                transaction.onerror?.()
                                return
                            }
                            if (control.writeMode === 'abort') {
                                const error = new DOMException('Synthetic transaction abort', 'AbortError')
                                transaction.error = error
                                transaction.onabort?.()
                                return
                            }
                            control.values.set(key, value)
                            request.onsuccess?.()
                            transaction.oncomplete?.()
                        })
                        return request
                    },
                    get: (key: string) => {
                        const request = {
                            error: null as DOMException | null,
                            result: undefined as string | undefined,
                            onsuccess: null as (() => void) | null,
                            onerror: null as (() => void) | null,
                        }
                        queueMicrotask(() => {
                            const stored = control.values.get(key)
                            request.result = control.writeMode === 'readback-mismatch' && transactionMode === 'readonly'
                                ? `${stored ?? ''}:mismatch`
                                : stored
                            request.onsuccess?.()
                        })
                        return request
                    },
                    delete: (key: string) => {
                        const request = {
                            error: null as DOMException | null,
                            onsuccess: null as (() => void) | null,
                            onerror: null as (() => void) | null,
                        }
                        queueMicrotask(() => {
                            control.values.delete(key)
                            request.onsuccess?.()
                            transaction.oncomplete?.()
                        })
                        return request
                    },
                }),
            }
            return transaction
        },
    }

    const factory = {
        open: () => {
            const request = {
                result: database,
                error: null as DOMException | null,
                onupgradeneeded: null as ((event: { target: unknown }) => void) | null,
                onsuccess: null as (() => void) | null,
                onerror: null as (() => void) | null,
                onblocked: null as (() => void) | null,
            }
            queueMicrotask(() => {
                if (options.blocked) request.onblocked?.()
                else request.onsuccess?.()
            })
            return request
        },
    }

    vi.stubGlobal('indexedDB', factory as unknown as IDBFactory)
    return control
}

async function loadPersistence() {
    return import('@/lib/indexed-db') as Promise<typeof import('@/lib/indexed-db') & {
        initializeIndexedDB(): Promise<void>
        getPersistenceCriticality(key: string): 'critical' | 'best-effort'
        closeApplicationWithFlush(options: {
            flush?: () => Promise<void>
            cleanup?: () => Promise<void>
            notify?: (message: string) => void
            exit: () => Promise<void>
        }): Promise<{ status: 'closed' | 'closed-with-persistence-failure' | 'closed-with-cleanup-failure' }>
    }>
}

describe('IndexedDB persistence correctness', () => {
    beforeEach(() => {
        vi.resetModules()
        vi.unstubAllGlobals()
    })

    it('classifies user data and reserved repositories as critical while keeping UI preferences best-effort', async () => {
        installFakeIndexedDB()
        const { getPersistenceCriticality } = await loadPersistence()

        for (const key of [
            'nai-blue-auth',
            'nai-blue-scenes',
            'nai-blue-composition-repository',
            'nai-blue-composition-migration-backup',
            'nai-blue-backup-restore-journal',
            'nai-blue-queue-repository',
            'future-user-data-store',
        ]) {
            expect(getPersistenceCriticality(key), key).toBe('critical')
        }
        for (const key of ['nai-blue-theme', 'nai-blue-layout', 'nai-blue-shortcuts', 'nai-blue-tools', 'nai-blue-update']) {
            expect(getPersistenceCriticality(key), key).toBe('best-effort')
        }
    })

    it.each([
        ['quota exceeded', 'quota' as const, 'PERSISTENCE_QUOTA_EXCEEDED'],
        ['transaction abort', 'abort' as const, 'PERSISTENCE_TRANSACTION_ABORTED'],
    ])('propagates a critical %s and records a diagnostic event', async (_label, mode, code) => {
        const control = installFakeIndexedDB()
        control.writeMode = mode
        const { indexedDBStorage } = await loadPersistence()
        const { useDiagnosticsStore } = await import('@/stores/diagnostics-store')

        await expect(indexedDBStorage.setItem('nai-blue-auth', '{"state":{}}')).rejects.toMatchObject({
            name: 'PersistenceFault',
            code,
        })
        expect(useDiagnosticsStore.getState().events[0]).toMatchObject({
            code,
            category: 'persistence',
            operation: 'persistence.write',
        })
    })

    it('rejects a blocked database open instead of waiting into a writable normal startup', async () => {
        installFakeIndexedDB({ blocked: true })
        const { initializeIndexedDB } = await loadPersistence()

        await expect(initializeIndexedDB()).rejects.toMatchObject({
            name: 'PersistenceFault',
            code: 'PERSISTENCE_DATABASE_BLOCKED',
        })
    })

    it('rejects a critical write whose committed value fails readback verification', async () => {
        const control = installFakeIndexedDB()
        control.writeMode = 'readback-mismatch'
        const { indexedDBStorage } = await loadPersistence()

        await expect(indexedDBStorage.setItem('nai-blue-scenes', '{"state":{"presets":[]}}')).rejects.toMatchObject({
            name: 'PersistenceFault',
            code: 'PERSISTENCE_READBACK_MISMATCH',
        })
    })

    it('throws a keyed failure list when a pending best-effort write cannot flush', async () => {
        const control = installFakeIndexedDB()
        const { flushAllPendingWrites, indexedDBStorage } = await loadPersistence()

        await indexedDBStorage.setItem('nai-blue-layout', '{"state":{"leftSidebarVisible":true}}')
        control.writeMode = 'abort'
        await indexedDBStorage.setItem('nai-blue-layout', '{"state":{"leftSidebarVisible":false}}')

        await expect(flushAllPendingWrites()).rejects.toMatchObject({
            name: 'PersistenceFlushError',
            failures: [expect.objectContaining({ key: 'nai-blue-layout' })],
        })
    })

    it('notifies, diagnoses, and exits exactly once after a close flush failure', async () => {
        installFakeIndexedDB()
        const { closeApplicationWithFlush } = await loadPersistence()
        const notify = vi.fn()
        const exit = vi.fn(async () => undefined)

        const result = await closeApplicationWithFlush({
            flush: async () => { throw new Error('Synthetic close flush failure') },
            notify,
            exit,
        })

        expect(result.status).toBe('closed-with-persistence-failure')
        expect(notify).toHaveBeenCalledOnce()
        expect(notify.mock.calls[0]?.[0]).toContain('안전하게 저장되지')
        expect(exit).toHaveBeenCalledOnce()
        const { useDiagnosticsStore } = await import('@/stores/diagnostics-store')
        expect(useDiagnosticsStore.getState().events[0]).toMatchObject({
            category: 'persistence',
            operation: 'persistence.close-flush',
        })
    })

    it('still exits exactly once when the close-failure notification cannot be shown', async () => {
        installFakeIndexedDB()
        const { closeApplicationWithFlush } = await loadPersistence()
        const exit = vi.fn(async () => undefined)

        const result = await closeApplicationWithFlush({
            flush: async () => { throw new Error('Synthetic close flush failure') },
            notify: () => { throw new Error('Synthetic notification failure') },
            exit,
        })

        expect(result.status).toBe('closed-with-persistence-failure')
        expect(exit).toHaveBeenCalledOnce()
        const { useDiagnosticsStore } = await import('@/stores/diagnostics-store')
        expect(useDiagnosticsStore.getState().events).toEqual(expect.arrayContaining([
            expect.objectContaining({ operation: 'persistence.close-flush' }),
            expect.objectContaining({ operation: 'persistence.close-flush-notification' }),
        ]))
    })

    it('awaits native cleanup after persistence flush and before exit', async () => {
        installFakeIndexedDB()
        const { closeApplicationWithFlush } = await loadPersistence()
        const order: string[] = []

        const result = await closeApplicationWithFlush({
            flush: async () => { order.push('flush') },
            cleanup: async () => { order.push('cleanup') },
            exit: async () => { order.push('exit') },
        })

        expect(result.status).toBe('closed')
        expect(order).toEqual(['flush', 'cleanup', 'exit'])
    })

    it('diagnoses cleanup failure but still releases the process exactly once', async () => {
        installFakeIndexedDB()
        const { closeApplicationWithFlush } = await loadPersistence()
        const notify = vi.fn()
        const exit = vi.fn(async () => undefined)

        const result = await closeApplicationWithFlush({
            flush: async () => undefined,
            cleanup: async () => { throw new Error('Synthetic vault cleanup failure') },
            notify,
            exit,
        })

        expect(result.status).toBe('closed-with-cleanup-failure')
        expect(notify).toHaveBeenCalledOnce()
        expect(exit).toHaveBeenCalledOnce()
        const { useDiagnosticsStore } = await import('@/stores/diagnostics-store')
        expect(useDiagnosticsStore.getState().events).toEqual(expect.arrayContaining([
            expect.objectContaining({ operation: 'application.shutdown-cleanup' }),
        ]))
    })
})
