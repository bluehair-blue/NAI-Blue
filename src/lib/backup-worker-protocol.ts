import type { CompositionDocument } from '@/domain/composition/types'
import type { BackupStoreKey } from './indexed-db'

export type BackupWorkerInput = {
    kind: 'full'
    createdAt: string
    appVersion?: string
    sourceCommit?: string
    compositionDocument?: CompositionDocument
    assetProfile: { exists: boolean; rawJson: string | null }
    legacyValues: Record<string, string>
    legacyKeys: string[]
} | { kind: 'store'; storeKey: BackupStoreKey; createdAt: string }

export type BackupWorkerOutput =
    | { kind: 'chunk'; bytes: Uint8Array }
    | { kind: 'complete'; storeCount: number; createdAt: string }
    | { kind: 'error'; message: string }
