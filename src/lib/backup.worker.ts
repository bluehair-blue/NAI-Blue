import { createCurrentBackupEnvelopeV3 } from './auto-backup'
import { createStoreSnapshotBackup } from './store-snapshots'
import { getIndexedDBItemStrict } from './indexed-db'
import { backupJsonBytes } from './backup-stream'
import type { BackupWorkerInput, BackupWorkerOutput } from './backup-worker-protocol'

// The worker reads the same-origin database after the renderer flushes pending
// writes. Only small metadata and one transferable chunk cross the UI boundary.
const worker = globalThis as unknown as {
    onmessage: ((event: MessageEvent<BackupWorkerInput | { kind: 'ack' }>) => void) | null
    postMessage(message: BackupWorkerOutput, transfer?: Transferable[]): void
}
let acknowledge: (() => void) | undefined
let started = false
worker.onmessage = event => {
    if (event.data.kind === 'ack') { acknowledge?.(); acknowledge = undefined; return }
    if (started) return
    started = true
    void exportBackup(event.data).catch(error => worker.postMessage({ kind: 'error',
        message: error instanceof Error ? error.message : 'Backup worker failed' }))
}

async function exportBackup(input: BackupWorkerInput): Promise<void> {
    let value: unknown
    let storeCount = 1
    if (input.kind === 'full') {
        const envelope = await createCurrentBackupEnvelopeV3({
            createdAt: input.createdAt, appVersion: input.appVersion, sourceCommit: input.sourceCommit,
            compositionDocument: input.compositionDocument, purpose: 'disk-auto',
            readRawAssetProfile: async () => input.assetProfile,
            readLegacyLocalValue: key => input.legacyValues[key] ?? null,
            readLegacyLocalKeys: () => input.legacyKeys,
        })
        value = envelope
        storeCount = envelope.storeManifest.storeCount
    } else {
        const raw = await getIndexedDBItemStrict(input.storeKey)
        if (raw === null) throw new Error('Snapshot source is missing')
        value = createStoreSnapshotBackup(input.storeKey, JSON.parse(raw), input.createdAt)
    }
    for (const bytes of backupJsonBytes(value)) {
        const written = new Promise<void>(resolve => { acknowledge = resolve })
        worker.postMessage({ kind: 'chunk', bytes }, [bytes.buffer as ArrayBuffer])
        await written
    }
    worker.postMessage({ kind: 'complete', storeCount, createdAt: input.createdAt })
}
