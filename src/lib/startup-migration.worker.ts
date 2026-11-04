import { collectCompositionMigrationSource, getLastCompositionStartupObservation, runStartupCompositionMigration } from './composition-migration-startup'
import { getRuntimeCompositionDocument } from './composition-authority'
import { materializeCompositionMigrationSidecars } from './composition-migration-materialization'
import { compareAndReplaceWildcardContentSnapshot, compareAndSetIndexedDBItem, exportWildcardContentSnapshot, getIndexedDBItemStrict } from './indexed-db'
import type { RawAssetProfileFileSnapshot } from '@/services/asset-profile-file'
import type { MigrationHostRequest, MigrationWorkerMessage } from './startup-migration-worker'

const worker = globalThis as unknown as {
    onmessage: ((event: MessageEvent<{ kind: string; id: number; value?: unknown; error?: string }>) => void) | null
    postMessage(message: MigrationWorkerMessage): void
}
let sequence = 0
let started = false
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
function host<T>(request: MigrationHostRequest): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const id = ++sequence
        pending.set(id, { resolve: value => resolve(value as T), reject })
        worker.postMessage({ kind: 'host', id, request })
    })
}
worker.onmessage = event => {
    const message = event.data
    if (message.kind === 'host-reply') {
        const callback = pending.get(message.id)
        pending.delete(message.id)
        if (message.error !== undefined) callback?.reject(new Error(message.error))
        else callback?.resolve(message.value)
        return
    }
    if (started) return
    started = true
    void run().catch(error => worker.postMessage({ kind: 'error', message: String(error) }))
}

async function run(): Promise<void> {
    const result = await runStartupCompositionMigration({
        sourceProvider: async () => {
            // Re-read native/local inputs for every source drift check, never a
            // frozen launch snapshot that could miss a concurrent writer.
            const environment = await host<{ localValues: Record<string, string | null>; profile: RawAssetProfileFileSnapshot }>({ operation: 'environment' })
            return collectCompositionMigrationSource({
                readLocalValue: key => environment.localValues[key] ?? null,
                readAssetProfile: async () => environment.profile,
            })
        },
        materializeSidecars: input => materializeCompositionMigrationSidecars(input, {
            getItem: getIndexedDBItemStrict,
            compareAndSetItem: compareAndSetIndexedDBItem,
            getWildcardContent: () => exportWildcardContentSnapshot({ strict: true }),
            replaceWildcardContent: compareAndReplaceWildcardContentSnapshot,
            readAssetProfile: () => host({ operation: 'profile-read' }),
            seedAssetProfileIfMissing: raw => host({ operation: 'profile-seed', raw }),
            restoreAssetProfilePreimage: (before, after) => host({ operation: 'profile-restore', before, after }),
        }),
    })
    worker.postMessage({ kind: 'complete', value: { result,
        document: getRuntimeCompositionDocument(), observation: getLastCompositionStartupObservation() } })
}
