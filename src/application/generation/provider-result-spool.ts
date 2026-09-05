import type { ProviderSha256, SpoolReceipt } from '@/domain/queue/provider-result'

export interface SpoolCommitInput {
    readonly spoolId: string
    readonly attemptId: string
    readonly contentType: string
    readonly bytes: Uint8Array
    readonly committedAt: string
}

export interface SpoolRemovalEligibility {
    readonly spoolId: string
    readonly now: string
    readonly terminalAt: string
    readonly storageTerminal: boolean
    readonly requiredReleaseTerminal: boolean
}

export interface SpoolReconcileResult {
    readonly receipts: readonly SpoolReceipt[]
    readonly promotedSpoolIds: readonly string[]
    readonly removedTemporarySpoolIds: readonly string[]
    readonly removedOrphanSpoolIds: readonly string[]
    readonly corruptSpoolIds: readonly string[]
    /** Retained committed corruption, excluding temporary files successfully cleaned during recovery. */
    readonly unresolvedCorruptSpoolIds?: readonly string[]
}

/** App-private byte spool; callers persist only its redacted receipt in Queue attempts. */
export interface ProviderResultSpool {
    commit(input: SpoolCommitInput): Promise<SpoolReceipt>
    verify(spoolId: string): Promise<SpoolReceipt>
    read(spoolId: string): Promise<Uint8Array>
    /** Explicit user-authorized discard; verifies the exact receipt before removal. */
    discard(receipt: SpoolReceipt): Promise<void>
    removeIfEligible(input: SpoolRemovalEligibility): Promise<boolean>
    list(): Promise<readonly SpoolReceipt[]>
    reconcile(): Promise<SpoolReconcileResult>
}

export class ProviderResultSpoolError extends Error {
    constructor(
        readonly code: 'invalid-input' | 'missing' | 'conflict' | 'checksum-mismatch' | 'corrupt-receipt',
        message: string,
        options?: { cause?: unknown },
    ) {
        super(message)
        this.name = 'ProviderResultSpoolError'
        if (options?.cause !== undefined) (this as Error & { cause?: unknown }).cause = options.cause
    }
}

export function isProviderSha256(value: unknown): value is ProviderSha256 {
    return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
}
