import type { CompositionDocument } from '@/domain/composition/types'
import type { CompositionMigrationTransactionResult } from './composition-migration-runtime'
import type { CompositionStartupObservation } from './composition-migration-startup'
import type { RawAssetProfileFileSnapshot } from '@/services/asset-profile-file'

export type MigrationHostRequest =
    | { operation: 'environment' }
    | { operation: 'profile-read' }
    | { operation: 'profile-seed'; raw: string }
    | { operation: 'profile-restore'; before: RawAssetProfileFileSnapshot; after: RawAssetProfileFileSnapshot }
export interface StartupMigrationReply {
    result: CompositionMigrationTransactionResult
    document: CompositionDocument | null
    observation: CompositionStartupObservation | null
}
export type MigrationWorkerMessage =
    | { kind: 'host'; id: number; request: MigrationHostRequest }
    | { kind: 'complete'; value: StartupMigrationReply }
    | { kind: 'error'; message: string }

let createWorker: (() => Worker) | undefined
export function configureStartupMigrationWorker(factory: () => Worker): void { createWorker = factory }

/** Only native file operations/localStorage cross the renderer boundary. The
 * worker owns IndexedDB, validation and the existing migration CAS transaction.
 * Failures never trigger an automatic second migration with unknown outcome. */
export async function runStartupCompositionMigration(): Promise<CompositionMigrationTransactionResult> {
    const startup = await import('./composition-migration-startup')
    if (createWorker === undefined) return startup.runStartupCompositionMigration()
    const { setRuntimeCompositionDocument } = await import('./composition-authority')
    setRuntimeCompositionDocument(null)
    const [profile, { LEGACY_COMPOSITION_STORE_ALIASES }] = await Promise.all([
        import('@/services/asset-profile-file'), import('@/domain/composition/migrations'),
    ])
    const handleHost = async (request: MigrationHostRequest): Promise<unknown> => {
        switch (request.operation) {
            case 'environment': return {
                localValues: Object.fromEntries([...new Set(Object.values(LEGACY_COMPOSITION_STORE_ALIASES).flat())]
                    .map(key => [key, localStorage.getItem(key)])),
                profile: await profile.loadRawAssetProfileFile(),
            }
            case 'profile-read': return profile.loadRawAssetProfileFile()
            case 'profile-seed': return profile.seedRawAssetProfileFileIfMissing(request.raw)
            case 'profile-restore': return profile.restoreRawAssetProfileFilePreimageIfUnchanged(request.before, request.after)
        }
    }
    const worker = createWorker()
    const reply = await new Promise<StartupMigrationReply>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<MigrationWorkerMessage>) => {
            const message = event.data
            if (message.kind === 'host') {
                void handleHost(message.request).then(value => worker.postMessage({ kind: 'host-reply', id: message.id, value }),
                    error => worker.postMessage({ kind: 'host-reply', id: message.id, error: String(error) }))
            } else {
                worker.terminate()
                if (message.kind === 'complete') resolve(message.value)
                else reject(new Error(message.message))
            }
        }
        worker.onerror = event => { worker.terminate(); reject(new Error(event.message || 'Startup migration worker failed')) }
        worker.postMessage({ kind: 'start' })
    })
    setRuntimeCompositionDocument(reply.document)
    if (reply.observation !== null) startup.recordStartupObservation(reply.observation)
    return reply.result
}
