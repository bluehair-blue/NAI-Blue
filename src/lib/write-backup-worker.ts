import { exists, remove, rename, writeFile, type WriteFileOptions } from '@tauri-apps/plugin-fs'
import type { BackupWorkerInput, BackupWorkerOutput } from './backup-worker-protocol'

/** One worker at a time bounds memory across full exports and store snapshots.
 * Scoped native writes acknowledge each chunk; only a completed file is renamed
 * into the backup listing. Errors never advance last-success or rotate backups. */
let tail: Promise<unknown> = Promise.resolve()
let workerFactory: (() => Worker) | undefined
/** Composition root supplies the entry so worker imports cannot recursively
 * bundle another worker. No synchronous UI-thread fallback for large exports. */
export function configureBackupWorker(factory: () => Worker): void { workerFactory = factory }
export function writeBackupWithWorker(path: string, input: BackupWorkerInput,
    options: Pick<WriteFileOptions, 'baseDir'>): Promise<{ storeCount: number; createdAt: string }> {
    const next = tail.then(() => writeBackup(path, input, options))
    tail = next.catch(() => undefined)
    return next
}

async function writeBackup(path: string, input: BackupWorkerInput,
    options: Pick<WriteFileOptions, 'baseDir'>): Promise<{ storeCount: number; createdAt: string }> {
    const temporary = `${path}.partial`
    if (!workerFactory) throw new Error('Backup worker is not configured')
    const worker = workerFactory()
    let append = false
    try {
        const result = await new Promise<{ storeCount: number; createdAt: string }>((resolve, reject) => {
            worker.onerror = () => reject(new Error('Backup worker could not complete'))
            worker.onmessageerror = () => reject(new Error('Backup worker message could not be decoded'))
            worker.onmessage = (event: MessageEvent<BackupWorkerOutput>) => {
                const message = event.data
                if (message.kind === 'error') { reject(new Error(message.message)); return }
                if (message.kind === 'complete') { resolve(message); return }
                void writeFile(temporary, message.bytes, { ...options, append }).then(() => {
                    append = true
                    worker.postMessage({ kind: 'ack' })
                }, reject)
            }
            worker.postMessage(input)
        })
        await rename(temporary, path, { oldPathBaseDir: options.baseDir, newPathBaseDir: options.baseDir })
        return result
    } catch (error) {
        if (await exists(temporary, options).catch(() => false)) await remove(temporary, options).catch(() => undefined)
        throw error
    } finally { worker.terminate() }
}
