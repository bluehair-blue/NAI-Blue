import { beforeEach, describe, expect, it, vi } from 'vitest'

import { sha256Bytes } from '@/lib/binary-digest'
import type { MetadataWriteRequest, OutputMetadataWriter } from '@/services/output/metadata-writer'
import {
    OutputWriter,
    OutputWriterError,
    type OutputWriterPhase,
    type OutputWriterRequest,
} from '@/services/output/output-writer'
import type {
    OutputDestinationRequest,
    OutputFileRef,
    OutputPlatformAdapter,
    ResolvedOutputDirectory,
} from '@/services/output/platform-adapter'
import { createGenerationOutputCommitSet } from '@/services/output/generation-output-commit-set'

const FIXED_NOW = new Date('2026-07-13T00:00:00.000Z')
const IMAGE_BYTES = new Uint8Array([1, 2, 3, 4])
const SIDECAR_BYTES = new TextEncoder().encode('{"metadata":true}')

type AdapterOperation =
    | 'resolve-directory'
    | 'ensure-directory'
    | 'exists'
    | 'write-file'
    | 'read-file'
    | 'rename'
    | 'commit-if-absent'
    | 'remove'
    | 'write-journal'
    | 'read-journal'
    | 'remove-journal'
    | 'list-journals'

interface AdapterCall {
    operation: AdapterOperation
    from?: string
    to?: string
}

interface AdapterFault {
    operation: AdapterOperation
    when?: (call: AdapterCall) => boolean
    error?: Error
}

function bytesEqual(actual: Uint8Array | undefined, expected: Uint8Array): boolean {
    return actual !== undefined
        && actual.length === expected.length
        && actual.every((value, index) => value === expected[index])
}

class InMemoryOutputAdapter implements OutputPlatformAdapter {
    readonly capabilities = {
        absolutePaths: false,
        atomicSiblingRename: true,
        outputReservationGuarantee: 'atomic-no-replace' as const,
        runtime: 'app-scoped' as const,
    }

    readonly files = new Map<string, Uint8Array>()
    readonly journals = new Map<string, Uint8Array>()
    readonly calls: AdapterCall[] = []
    fault: AdapterFault | null = null

    private record(call: AdapterCall): void {
        this.calls.push(call)
        if (this.fault?.operation === call.operation && (this.fault.when?.(call) ?? true)) {
            const error = this.fault.error ?? new Error(`Injected ${call.operation} failure`)
            this.fault = null
            throw error
        }
    }

    private key(file: OutputFileRef): string {
        return `${file.baseDir ?? 'absolute'}:${file.path}`
    }

    private clone(bytes: Uint8Array): Uint8Array {
        return new Uint8Array(bytes)
    }

    async resolveDirectory(request: OutputDestinationRequest): Promise<ResolvedOutputDirectory> {
        this.record({ operation: 'resolve-directory' })
        const directory = request.directory?.trim() || request.workflowDefaultDirectory
        return {
            path: directory,
            displayPath: `/app-data/${directory}`,
            baseDir: 1,
            capabilityFallbackUsed: false,
        }
    }

    async ensureDirectory(directory: OutputFileRef): Promise<void> {
        this.record({ operation: 'ensure-directory', from: this.key(directory) })
    }

    async exists(file: OutputFileRef): Promise<boolean> {
        const key = this.key(file)
        this.record({ operation: 'exists', from: key })
        return this.files.has(key)
    }

    async writeFile(file: OutputFileRef, bytes: Uint8Array): Promise<void> {
        const key = this.key(file)
        this.record({ operation: 'write-file', to: key })
        this.files.set(key, this.clone(bytes))
    }

    async readFile(file: OutputFileRef): Promise<Uint8Array> {
        const key = this.key(file)
        this.record({ operation: 'read-file', from: key })
        const bytes = this.files.get(key)
        if (bytes === undefined) throw new Error(`Missing file: ${key}`)
        return this.clone(bytes)
    }

    async rename(from: OutputFileRef, to: OutputFileRef): Promise<void> {
        const fromKey = this.key(from)
        const toKey = this.key(to)
        this.record({ operation: 'rename', from: fromKey, to: toKey })
        const bytes = this.files.get(fromKey)
        if (bytes === undefined) throw new Error(`Missing rename source: ${fromKey}`)
        this.files.set(toKey, bytes)
        this.files.delete(fromKey)
    }

    async commitSiblingIfAbsent(from: OutputFileRef, to: OutputFileRef) {
        const fromKey = this.key(from)
        const toKey = this.key(to)
        this.record({ operation: 'commit-if-absent', from: fromKey, to: toKey })
        if (this.files.has(toKey)) return { status: 'destination-exists' as const }
        const bytes = this.files.get(fromKey)
        if (bytes === undefined) throw new Error(`Missing commit source: ${fromKey}`)
        this.files.set(toKey, bytes)
        this.files.delete(fromKey)
        return { status: 'committed' as const }
    }

    async remove(file: OutputFileRef): Promise<void> {
        const key = this.key(file)
        this.record({ operation: 'remove', from: key })
        this.files.delete(key)
    }

    async writeJournal(transactionId: string, bytes: Uint8Array): Promise<void> {
        this.record({ operation: 'write-journal', to: transactionId })
        this.journals.set(transactionId, this.clone(bytes))
    }

    async readJournal(transactionId: string): Promise<Uint8Array | null> {
        this.record({ operation: 'read-journal', from: transactionId })
        const bytes = this.journals.get(transactionId)
        return bytes === undefined ? null : this.clone(bytes)
    }

    async removeJournal(transactionId: string): Promise<void> {
        this.record({ operation: 'remove-journal', from: transactionId })
        this.journals.delete(transactionId)
    }

    async listJournalIds(): Promise<string[]> {
        this.record({ operation: 'list-journals' })
        return [...this.journals.keys()].sort()
    }

    seed(path: string, bytes: Uint8Array): void {
        this.files.set(`1:${path}`, this.clone(bytes))
    }

    file(path: string): Uint8Array | undefined {
        return this.files.get(`1:${path}`)
    }

    paths(): string[] {
        return [...this.files.keys()].map(key => key.replace(/^1:/, '')).sort()
    }
}

class DeterministicMetadataWriter implements OutputMetadataWriter {
    prepare(imageBytes: Uint8Array, request?: MetadataWriteRequest) {
        return {
            imageBytes: new Uint8Array(imageBytes),
            ...(request === undefined ? {} : { sidecarBytes: new Uint8Array(SIDECAR_BYTES) }),
        }
    }
}

function metadataRequest(): MetadataWriteRequest {
    return {
        params: {} as MetadataWriteRequest['params'],
        imageFormat: 'png',
        metadataMode: 'sidecar-only',
    }
}

function request(overrides: Partial<OutputWriterRequest> = {}): OutputWriterRequest {
    return {
        destination: {
            directory: 'output',
            useAbsolutePath: false,
            workflowDefaultDirectory: 'NAI_Blue_Output',
            extension: 'png',
            fileName: 'result.png',
            collisionPolicy: 'unique',
        },
        imageBytes: new Uint8Array(IMAGE_BYTES),
        imageDataUrl: 'data:image/png;base64,AQIDBA==',
        canCommit: () => true,
        commitWorkflow: () => undefined,
        ...overrides,
    }
}

function writer(adapter: InMemoryOutputAdapter, transactionId = 'txn-1'): OutputWriter {
    return new OutputWriter(
        adapter,
        new DeterministicMetadataWriter(),
        () => transactionId,
        () => new Date(FIXED_NOW),
    )
}

function expectNoTransactionArtifacts(adapter: InMemoryOutputAdapter): void {
    expect(adapter.paths().filter(path => path.includes('.nai-blue-txn-'))).toEqual([])
    expect([...adapter.journals.keys()]).toEqual([])
}

function expectNoOutput(adapter: InMemoryOutputAdapter): void {
    expect(adapter.paths()).toEqual([])
    expectNoTransactionArtifacts(adapter)
}

beforeEach(() => {
    vi.restoreAllMocks()
})

describe('OutputWriter fault containment', () => {
    it('keeps string platform failures in the diagnostic cause chain', () => {
        const error = new OutputWriterError('resolve-destination', 'Output failed', {
            cause: 'path not allowed',
        })

        expect((error as Error & { cause?: unknown }).cause).toMatchObject({
            name: 'Error',
            message: 'path not allowed',
        })
    })

    it('preflights an exact destination with a reversible write probe', async () => {
        const adapter = new InMemoryOutputAdapter()
        const outputWriter = writer(adapter, 'preflight-1')

        const result = await outputWriter.preflightExactDestination({
            destination: request().destination,
            fileName: 'result.png',
            probeWrite: true,
        })

        expect(result).toMatchObject({
            fileName: 'result.png',
            availableSpaceCheck: 'unavailable',
            foregroundSingleWriterOnly: true,
            crossProcessReservation: false,
        })
        expect(result.directoryIdentity).toMatch(/^sha256:[a-f0-9]{64}$/)
        expect(adapter.paths()).toEqual([])
        expect(adapter.calls.some(call => call.operation === 'write-file'
            && call.to?.includes('.nai-blue-preflight-'))).toBe(true)
        expect(adapter.calls.some(call => call.operation === 'read-file'
            && call.from?.includes('.nai-blue-preflight-'))).toBe(true)
    })

    it('writes the reserved exact filename without suffixing', async () => {
        const adapter = new InMemoryOutputAdapter()
        const outputWriter = writer(adapter, 'txn-reserved')
        const preflight = await outputWriter.preflightExactDestination({
            destination: request().destination,
            fileName: 'result.png',
        })
        const outputReservation = {
            reservationId: 'reservation:1',
            directoryIdentity: preflight.directoryIdentity,
            relativePath: 'result.png',
        } as const

        const outcome = await outputWriter.write(request({
            destination: { ...request().destination, collisionPolicy: 'error' },
            outputReservation,
        }))

        expect(outcome).toMatchObject({ status: 'committed', result: { fileName: 'result.png' } })
        expect(adapter.file('output/result.png')).toEqual(IMAGE_BYTES)
        expect(adapter.file('output/result-2.png')).toBeUndefined()
    })

    it('publishes exactly the image, metadata, and provider-original paths in its commit set', async () => {
        const adapter = new InMemoryOutputAdapter()
        const outputWriter = new OutputWriter(
            adapter,
            new DeterministicMetadataWriter(),
            () => 'txn-full-commit-set',
            () => new Date(FIXED_NOW),
            async () => ({ bytes: new Uint8Array([9]), dataUrl: 'data:image/png;base64,CQ==' }),
        )
        const preflight = await outputWriter.preflightExactDestination({
            destination: request().destination,
            fileName: 'result.png',
        })
        const { commitSet, commitSetHash } = createGenerationOutputCommitSet({
            directoryAuthorityId: 'folder:1',
            directoryAuthorityFingerprint: preflight.directoryIdentity,
            filesystemSemantics: 'windows',
            fileName: 'result.png',
            imageFormat: 'png',
            metadataMode: 'strip-and-sidecar',
            preserveProviderOriginal: true,
        })

        const outcome = await outputWriter.write(request({
            destination: { ...request().destination, collisionPolicy: 'error' },
            outputReservation: {
                reservationId: 'reservation:full',
                directoryIdentity: preflight.directoryIdentity,
                relativePath: 'result.png',
                commitSet,
                commitSetHash,
            },
            metadata: { ...metadataRequest(), metadataMode: 'strip-and-sidecar' },
            preserveProviderOriginal: true,
        }))

        expect(outcome).toMatchObject({
            status: 'committed',
            result: { outputCommitSetHash: commitSetHash },
        })
        expect(adapter.paths()).toEqual([
            'output/._nai-blue-private/result.png',
            'output/result.nai-blue.json',
            'output/result.png',
        ])
    })

    it('fails before staging when actual permanent artifacts differ from the commit set', async () => {
        const adapter = new InMemoryOutputAdapter()
        const outputWriter = writer(adapter, 'txn-commit-set-mismatch')
        const preflight = await outputWriter.preflightExactDestination({
            destination: request().destination,
            fileName: 'result.png',
        })
        const { commitSet, commitSetHash } = createGenerationOutputCommitSet({
            directoryAuthorityId: 'folder:1',
            directoryAuthorityFingerprint: preflight.directoryIdentity,
            filesystemSemantics: 'windows',
            fileName: 'result.png',
            imageFormat: 'png',
            metadataMode: 'strip-only',
            preserveProviderOriginal: false,
        })

        await expect(outputWriter.write(request({
            destination: { ...request().destination, collisionPolicy: 'error' },
            outputReservation: {
                reservationId: 'reservation:mismatch',
                directoryIdentity: preflight.directoryIdentity,
                relativePath: 'result.png',
                commitSet,
                commitSetHash,
            },
            metadata: metadataRequest(),
        }))).rejects.toMatchObject({ phase: 'resolve-destination' })
        expectNoOutput(adapter)
    })

    it('rejects a reserved write when the resolved directory identity changed', async () => {
        const adapter = new InMemoryOutputAdapter()

        await expect(writer(adapter, 'txn-mismatch').write(request({
            destination: { ...request().destination, collisionPolicy: 'error' },
            outputReservation: {
                reservationId: 'reservation:1',
                directoryIdentity: `sha256:${'f'.repeat(64)}`,
                relativePath: 'result.png',
            },
        }))).rejects.toMatchObject({
            name: 'OutputWriterError',
            phase: 'resolve-destination',
        })
        expectNoOutput(adapter)
    })

    it('preflight rejects a derived diagnostic sidecar collision', async () => {
        const adapter = new InMemoryOutputAdapter()
        adapter.seed('output/result.nai-blue.diagnostic.json', SIDECAR_BYTES)

        await expect(writer(adapter, 'preflight-collision').preflightExactDestination({
            destination: request().destination,
            fileName: 'result.png',
        })).rejects.toMatchObject({
            name: 'OutputWriterError',
            phase: 'resolve-destination',
        })
    })

    it('reserves distinct names for concurrent unique writes', async () => {
        const adapter = new InMemoryOutputAdapter()
        let transactionOrdinal = 0
        const outputWriter = new OutputWriter(
            adapter,
            new DeterministicMetadataWriter(),
            () => `txn-concurrent-${++transactionOrdinal}`,
            () => new Date(FIXED_NOW),
        )

        const [first, second] = await Promise.all([
            outputWriter.write(request({ imageBytes: new Uint8Array([1]) })),
            outputWriter.write(request({ imageBytes: new Uint8Array([2]) })),
        ])

        expect(first.status).toBe('committed')
        expect(second.status).toBe('committed')
        if (first.status !== 'committed' || second.status !== 'committed') {
            throw new Error('Expected both output transactions to commit')
        }
        expect([first.result.fileName, second.result.fileName].sort()).toEqual([
            'result-2.png',
            'result.png',
        ])
        expect(adapter.file('output/result.png')).toEqual(new Uint8Array([1]))
        expect(adapter.file('output/result-2.png')).toEqual(new Uint8Array([2]))
        expectNoTransactionArtifacts(adapter)
    })

    it.each(['strip-and-sidecar', 'strip-only'] as const)(
        'purges provider metadata before writing and thumbnailing %s output',
        async metadataMode => {
            const adapter = new InMemoryOutputAdapter()
            const cleanBytes = new Uint8Array([9, 8, 7])
            const cleanDataUrl = 'data:image/png;base64,CQgH'
            const purge = vi.fn(async () => ({ bytes: cleanBytes, dataUrl: cleanDataUrl }))
            let thumbnailInput = ''
            const outputWriter = new OutputWriter(
                adapter,
                new DeterministicMetadataWriter(),
                () => `txn-${metadataMode}`,
                () => new Date(FIXED_NOW),
                purge,
            )

            await outputWriter.write(request({
                metadata: { ...metadataRequest(), metadataMode },
                generateThumbnail: async imageDataUrl => {
                    thumbnailInput = imageDataUrl
                    return 'data:image/png;base64,dGh1bWI='
                },
            }))

            expect(purge).toHaveBeenCalledOnce()
            expect(purge).toHaveBeenCalledWith('data:image/png;base64,AQIDBA==', 'png')
            expect(bytesEqual(adapter.file('output/result.png'), cleanBytes)).toBe(true)
            expect(thumbnailInput).toBe(cleanDataUrl)
        },
    )

    it('keeps the provider original in a scanner-excluded private directory while publishing purified bytes', async () => {
        const adapter = new InMemoryOutputAdapter()
        const cleanBytes = new Uint8Array([9, 8, 7])
        const outputWriter = new OutputWriter(
            adapter,
            new DeterministicMetadataWriter(),
            () => 'txn-private-original',
            () => new Date(FIXED_NOW),
            async () => ({ bytes: cleanBytes, dataUrl: 'data:image/png;base64,CQgH' }),
        )

        const outcome = await outputWriter.write(request({
            metadata: { ...metadataRequest(), metadataMode: 'strip-and-sidecar' },
            preserveProviderOriginal: true,
        }))

        expect(outcome.status).toBe('committed')
        if (outcome.status !== 'committed') throw new Error('Expected the output transaction to commit')
        expect(bytesEqual(adapter.file('output/result.png'), cleanBytes)).toBe(true)
        expect(bytesEqual(adapter.file('output/._nai-blue-private/result.png'), IMAGE_BYTES)).toBe(true)
        expect(outcome.result.providerOriginalPath).toBe('/app-data/output/._nai-blue-private/result.png')
        expectNoTransactionArtifacts(adapter)
    })

    it('uses a pre-bound queue transaction and exposes its files-committed recovery link', async () => {
        const adapter = new InMemoryOutputAdapter()
        const outputWriter = writer(adapter, 'factory-id-must-not-win')
        let pending: Awaited<ReturnType<OutputWriter['inspectPendingQueueTransactions']>> = []

        const outcome = await outputWriter.write(request({
            transactionId: 'txn-bound-to-job',
            sourceJobId: 'job:durable:1',
            commitWorkflow: async () => {
                pending = await outputWriter.inspectPendingQueueTransactions()
            },
        }))

        expect(outcome).toMatchObject({
            status: 'committed',
            result: { transactionId: 'txn-bound-to-job' },
        })
        expect(pending).toEqual([{
            transactionId: 'txn-bound-to-job',
            sourceJobId: 'job:durable:1',
            phase: 'files-committed',
        }])
        expectNoTransactionArtifacts(adapter)
    })

    it('retains a terminal queue artifact when only post-commit journal persistence fails', async () => {
        const adapter = new InMemoryOutputAdapter()
        const outputWriter = writer(adapter, 'txn-terminal')
        const rollbackWorkflow = vi.fn()

        await expect(outputWriter.write(request({
            sourceJobId: 'job:terminal',
            terminalWorkflowCommit: true,
            commitWorkflow: () => {
                adapter.fault = { operation: 'write-journal' }
            },
            rollbackWorkflow,
        }))).rejects.toBeInstanceOf(OutputWriterError)

        expect(rollbackWorkflow).not.toHaveBeenCalled()
        expect(adapter.file('output/result.png')).toEqual(IMAGE_BYTES)
        expect(await outputWriter.inspectPendingQueueTransactions()).toEqual([{
            transactionId: 'txn-terminal',
            sourceJobId: 'job:terminal',
            phase: 'files-committed',
        }])

        await expect(outputWriter.recoverTransaction('txn-terminal', {
            mode: 'retry-workflow',
            canCommit: () => true,
            commitWorkflow: () => undefined,
        })).resolves.toEqual({ transactionId: 'txn-terminal', action: 'retried' })
        expect(adapter.file('output/result.png')).toEqual(IMAGE_BYTES)
        expectNoTransactionArtifacts(adapter)
    })

    it('returns opt-in final image facts with a projected portable directory', async () => {
        const adapter = new InMemoryOutputAdapter()
        const outputWriter = writer(adapter, 'txn-final-image-facts')

        const outcome = await outputWriter.write(request({
            includeFinalImageFacts: true,
            destination: {
                portableDirectory: {
                    kind: 'standard',
                    root: 'app-data',
                    segments: ['queue', 'outputs'],
                    displayPath: 'C:\\Users\\private\\queue\\outputs',
                },
                directory: 'output',
                useAbsolutePath: false,
                workflowDefaultDirectory: 'NAI_Blue_Output',
                extension: 'png',
                fileName: 'result.png',
                collisionPolicy: 'unique',
            },
        }))

        expect(outcome.status).toBe('committed')
        if (outcome.status !== 'committed') throw new Error('Expected the output transaction to commit')
        expect(outcome.result.contentChecksum).toBeUndefined()
        expect(outcome.result.finalImage).toEqual({
            contentChecksum: await sha256Bytes(IMAGE_BYTES),
            byteSize: IMAGE_BYTES.byteLength,
            portableDirectory: {
                kind: 'standard',
                root: 'app-data',
                segments: ['queue', 'outputs'],
            },
        })
        expect(JSON.stringify(outcome.result.finalImage)).not.toContain('C:\\Users\\private')
        expectNoTransactionArtifacts(adapter)
    })

    it('replays final image facts from the files-committed recovery journal', async () => {
        const adapter = new InMemoryOutputAdapter()
        const outputWriter = writer(adapter, 'txn-final-image-recovery')
        let recoveredFinalImage: unknown
        let recoveredCommitSetHash: unknown
        const preflight = await outputWriter.preflightExactDestination({
            destination: request().destination,
            fileName: 'result.png',
        })
        const { commitSet, commitSetHash } = createGenerationOutputCommitSet({
            directoryAuthorityId: 'folder:recovery',
            directoryAuthorityFingerprint: preflight.directoryIdentity,
            filesystemSemantics: 'windows',
            fileName: 'result.png',
            imageFormat: 'png',
            metadataMode: undefined,
            preserveProviderOriginal: false,
        })

        await expect(outputWriter.write(request({
            includeFinalImageFacts: true,
            terminalWorkflowCommit: true,
            destination: {
                portableDirectory: {
                    kind: 'bookmark',
                    bookmarkId: 'output:selected',
                    segments: ['queue'],
                    displayPath: 'D:\\private-output\\queue',
                },
                directory: 'output',
                useAbsolutePath: false,
                workflowDefaultDirectory: 'NAI_Blue_Output',
                extension: 'png',
                fileName: 'result.png',
                collisionPolicy: 'error',
            },
            outputReservation: {
                reservationId: 'reservation:recovery',
                directoryIdentity: preflight.directoryIdentity,
                relativePath: 'result.png',
                commitSet,
                commitSetHash,
            },
            commitWorkflow: () => {
                adapter.fault = { operation: 'write-journal' }
            },
        }))).rejects.toBeInstanceOf(OutputWriterError)

        await expect(outputWriter.recoverTransaction('txn-final-image-recovery', {
            mode: 'retry-workflow',
            commitWorkflow: result => {
                recoveredFinalImage = result.finalImage
                recoveredCommitSetHash = result.outputCommitSetHash
            },
        })).resolves.toEqual({ transactionId: 'txn-final-image-recovery', action: 'retried' })

        expect(recoveredFinalImage).toEqual({
            contentChecksum: await sha256Bytes(IMAGE_BYTES),
            byteSize: IMAGE_BYTES.byteLength,
            portableDirectory: {
                kind: 'bookmark',
                bookmarkId: 'output:selected',
                segments: ['queue'],
            },
        })
        expect(recoveredCommitSetHash).toBe(commitSetHash)
        expectNoTransactionArtifacts(adapter)
    })

    it('omits only a raw absolute output directory from opt-in final image facts', async () => {
        const adapter = new InMemoryOutputAdapter()
        vi.spyOn(adapter, 'resolveDirectory').mockResolvedValue({
            path: 'C:\\raw-output',
            displayPath: 'C:\\raw-output',
            capabilityFallbackUsed: false,
        })

        const outcome = await writer(adapter, 'txn-absolute-final-image').write(request({
            includeFinalImageFacts: true,
        }))

        expect(outcome.status).toBe('committed')
        if (outcome.status !== 'committed') throw new Error('Expected the output transaction to commit')
        expect(outcome.result.finalImage).toEqual({
            contentChecksum: await sha256Bytes(IMAGE_BYTES),
            byteSize: IMAGE_BYTES.byteLength,
        })
        expectNoTransactionArtifacts(adapter)
    })

    it('rejects malformed portable final image facts before retrying the workflow', async () => {
        const adapter = new InMemoryOutputAdapter()
        const commitWorkflow = vi.fn()
        const checksum = await sha256Bytes(IMAGE_BYTES)
        await adapter.writeJournal('txn-invalid-final-image', new TextEncoder().encode(JSON.stringify({
            format: 'nai-blue-output-transaction',
            version: 1,
            transactionId: 'txn-invalid-final-image',
            createdAt: FIXED_NOW.toISOString(),
            updatedAt: FIXED_NOW.toISOString(),
            phase: 'files-committed',
            fileName: 'result.png',
            finalImage: {
                contentChecksum: checksum,
                byteSize: IMAGE_BYTES.byteLength,
                portableDirectory: {
                    kind: 'standard',
                    root: 'app-data',
                    segments: ['queue', '..'],
                },
            },
            directory: {
                path: 'output',
                displayPath: '/app-data/output',
                baseDir: 1,
                capabilityFallbackUsed: false,
            },
            artifacts: [{
                kind: 'image',
                temp: {
                    path: 'output/.result.png.nai-blue-txn-txn-invalid-final-image.image.tmp',
                    displayPath: '/app-data/output/.result.png.nai-blue-txn-txn-invalid-final-image.image.tmp',
                    baseDir: 1,
                },
                final: {
                    path: 'output/result.png',
                    displayPath: '/app-data/output/result.png',
                    baseDir: 1,
                },
                committed: true,
            }],
            thumbnailStaged: false,
            commitStarted: true,
        })))

        await expect(writer(adapter).recoverTransaction('txn-invalid-final-image', {
            mode: 'retry-workflow',
            commitWorkflow,
        })).resolves.toMatchObject({
            transactionId: 'txn-invalid-final-image',
            action: 'failed',
        })
        expect(commitWorkflow).not.toHaveBeenCalled()
    })

    it('cancels before destination staging without creating files or a journal', async () => {
        const adapter = new InMemoryOutputAdapter()

        await expect(writer(adapter).write(request({ canCommit: () => false })))
            .resolves.toEqual({ status: 'cancelled' })

        expect(adapter.calls).toEqual([])
        expectNoOutput(adapter)
    })

    it('cleans the journal when the image temp write fails', async () => {
        const adapter = new InMemoryOutputAdapter()
        adapter.fault = {
            operation: 'write-file',
            when: call => call.to?.includes('.image.tmp') === true,
        }

        await expect(writer(adapter).write(request()))
            .rejects.toBeInstanceOf(OutputWriterError)

        expectNoOutput(adapter)
    })

    it('removes the staged image when the sidecar temp write fails', async () => {
        const adapter = new InMemoryOutputAdapter()
        adapter.fault = {
            operation: 'write-file',
            when: call => call.to?.includes('.sidecar.tmp') === true,
        }

        await expect(writer(adapter).write(request({ metadata: metadataRequest() })))
            .rejects.toBeInstanceOf(OutputWriterError)

        expectNoOutput(adapter)
    })

    it('rolls back staged image and sidecar data when thumbnail generation fails', async () => {
        const adapter = new InMemoryOutputAdapter()

        await expect(writer(adapter).write(request({
            metadata: metadataRequest(),
            generateThumbnail: async () => {
                throw new Error('thumbnail failed')
            },
        }))).rejects.toBeInstanceOf(OutputWriterError)

        expectNoOutput(adapter)
    })

    it('removes all staged data when the session changes immediately before commit', async () => {
        const adapter = new InMemoryOutputAdapter()
        let sessionValid = true

        const outcome = await writer(adapter).write(request({
            metadata: metadataRequest(),
            canCommit: () => sessionValid,
            onPhase: (phase: OutputWriterPhase) => {
                if (phase === 'can-commit') sessionValid = false
            },
        }))

        expect(outcome).toEqual({ status: 'cancelled' })
        expectNoOutput(adapter)
    })

    it('preserves a late external collision and fails instead of silently overwriting or suffixing', async () => {
        const adapter = new InMemoryOutputAdapter()
        const external = new Uint8Array([9, 9, 9])

        await expect(writer(adapter, 'txn-late-collision').write(request({
            destination: {
                directory: 'output',
                useAbsolutePath: false,
                workflowDefaultDirectory: 'NAI_Blue_Output',
                extension: 'png',
                fileName: 'result.png',
                collisionPolicy: 'error',
            },
            onPhase: phase => {
                if (phase === 'can-commit') adapter.seed('output/result.png', external)
            },
        }))).rejects.toMatchObject({
            name: 'OutputWriterError',
            phase: 'atomic-commit',
        })
        expect(bytesEqual(adapter.file('output/result.png'), external)).toBe(true)
        expect(adapter.paths()).toEqual(['output/result.png'])
        expectNoTransactionArtifacts(adapter)
    })

    it('preserves an external file created at the reserved no-replace commit port', async () => {
        const adapter = new InMemoryOutputAdapter()
        const outputWriter = writer(adapter, 'txn-port-race')
        const preflight = await outputWriter.preflightExactDestination({
            destination: request().destination,
            fileName: 'result.png',
        })
        const external = new Uint8Array([7, 7, 7])
        adapter.fault = {
            operation: 'commit-if-absent',
            when: call => {
                if (call.to?.endsWith(':output/result.png')) adapter.seed('output/result.png', external)
                return false
            },
        }

        await expect(outputWriter.write(request({
            destination: { ...request().destination, collisionPolicy: 'error' },
            outputReservation: {
                reservationId: 'reservation:race',
                directoryIdentity: preflight.directoryIdentity,
                relativePath: 'result.png',
            },
        }))).rejects.toMatchObject({ name: 'OutputWriterError', phase: 'atomic-commit' })

        expect(adapter.file('output/result.png')).toEqual(external)
        expect(adapter.calls.some(call => call.operation === 'rename')).toBe(false)
        expectNoTransactionArtifacts(adapter)
    })

    it('preserves an external sidecar collision and publishes no partial commit set', async () => {
        const adapter = new InMemoryOutputAdapter()
        const outputWriter = writer(adapter, 'txn-sidecar-race')
        const preflight = await outputWriter.preflightExactDestination({
            destination: request().destination,
            fileName: 'result.png',
        })
        const { commitSet, commitSetHash } = createGenerationOutputCommitSet({
            directoryAuthorityId: 'folder:1',
            directoryAuthorityFingerprint: preflight.directoryIdentity,
            filesystemSemantics: 'windows',
            fileName: 'result.png',
            imageFormat: 'png',
            metadataMode: 'sidecar-only',
            preserveProviderOriginal: false,
        })
        const external = new Uint8Array([8, 8, 8])
        adapter.fault = {
            operation: 'commit-if-absent',
            when: call => {
                if (call.to?.endsWith(':output/result.nai-blue.json')) {
                    adapter.seed('output/result.nai-blue.json', external)
                }
                return false
            },
        }

        await expect(outputWriter.write(request({
            destination: { ...request().destination, collisionPolicy: 'error' },
            outputReservation: {
                reservationId: 'reservation:sidecar-race',
                directoryIdentity: preflight.directoryIdentity,
                relativePath: 'result.png',
                commitSet,
                commitSetHash,
            },
            metadata: metadataRequest(),
        }))).rejects.toMatchObject({ name: 'OutputWriterError', phase: 'atomic-commit' })

        expect(adapter.file('output/result.nai-blue.json')).toEqual(external)
        expect(adapter.file('output/result.png')).toBeUndefined()
        expectNoTransactionArtifacts(adapter)
    })

    it('uses bounded digest temp names for long reserved filenames', async () => {
        const adapter = new InMemoryOutputAdapter()
        const outputWriter = writer(adapter, 'txn-bounded-temp')
        const fileName = `${'a'.repeat(180)}.png`
        const preflight = await outputWriter.preflightExactDestination({
            destination: request().destination,
            fileName,
        })

        await outputWriter.write(request({
            destination: { ...request().destination, fileName, collisionPolicy: 'error' },
            outputReservation: {
                reservationId: 'reservation:long-path',
                directoryIdentity: preflight.directoryIdentity,
                relativePath: fileName,
            },
        }))

        const stagedNames = adapter.calls
            .filter(call => call.operation === 'write-file' && call.to?.includes('.nai-blue-txn-'))
            .map(call => call.to?.split('/').at(-1) ?? '')
        expect(stagedNames.length).toBeGreaterThan(0)
        expect(stagedNames.every(name => name.length < 80 && !name.includes('a'.repeat(40)))).toBe(true)
    })

    it('treats a legacy pending journal as an occupied exact destination', async () => {
        const adapter = new InMemoryOutputAdapter()
        const outputWriter = writer(adapter, 'txn-legacy-journal')

        await outputWriter.write(request({
            sourceJobId: 'job:legacy',
            commitWorkflow: async () => {
                await expect(outputWriter.preflightExactDestination({
                    destination: request().destination,
                    fileName: 'result.png',
                })).rejects.toMatchObject({
                    name: 'OutputWriterError',
                    phase: 'resolve-destination',
                })
            },
        }))

        expectNoTransactionArtifacts(adapter)
    })

    it('removes partially renamed finals after an atomic rename failure', async () => {
        const adapter = new InMemoryOutputAdapter()
        adapter.fault = {
            operation: 'rename',
            when: call => call.from?.includes('.image.tmp') === true,
        }

        await expect(writer(adapter).write(request({ metadata: metadataRequest() })))
            .rejects.toMatchObject({ name: 'OutputWriterError' })

        expectNoOutput(adapter)
    })

    it('removes committed files and invokes workflow compensation after store commit failure', async () => {
        const adapter = new InMemoryOutputAdapter()
        const rollbackWorkflow = vi.fn()
        const commitFailure = new Error('store commit failed')

        await expect(writer(adapter).write(request({
            metadata: metadataRequest(),
            commitWorkflow: () => {
                throw commitFailure
            },
            rollbackWorkflow,
        }))).rejects.toBe(commitFailure)

        expect(rollbackWorkflow).toHaveBeenCalledOnce()
        expectNoOutput(adapter)
    })

    it('rolls back an interrupted files-committed journal on the next writer instance', async () => {
        const adapter = new InMemoryOutputAdapter()
        const oldBytes = new Uint8Array([9, 9, 9])
        const newBytes = new Uint8Array([8, 8, 8])
        adapter.seed('output/restart.png', newBytes)
        adapter.seed('output/.restart.png.nai-blue-txn-restart.backup', oldBytes)
        adapter.seed('output/.restart.png.nai-blue-txn-restart.image.tmp', IMAGE_BYTES)
        await adapter.writeJournal('txn-restart', new TextEncoder().encode(JSON.stringify({
            format: 'nai-blue-output-transaction',
            version: 1,
            transactionId: 'txn-restart',
            createdAt: FIXED_NOW.toISOString(),
            updatedAt: FIXED_NOW.toISOString(),
            phase: 'files-committed',
            fileName: 'restart.png',
            directory: {
                path: 'output',
                displayPath: '/app-data/output',
                baseDir: 1,
                capabilityFallbackUsed: false,
            },
            artifacts: [{
                kind: 'image',
                temp: {
                    path: 'output/.restart.png.nai-blue-txn-restart.image.tmp',
                    displayPath: '/app-data/output/.restart.png.nai-blue-txn-restart.image.tmp',
                    baseDir: 1,
                },
                final: {
                    path: 'output/restart.png',
                    displayPath: '/app-data/output/restart.png',
                    baseDir: 1,
                },
                backup: {
                    path: 'output/.restart.png.nai-blue-txn-restart.backup',
                    displayPath: '/app-data/output/.restart.png.nai-blue-txn-restart.backup',
                    baseDir: 1,
                },
            }],
            thumbnailStaged: true,
        })))

        const restartedWriter = writer(adapter, 'unused-after-restart')
        await expect(restartedWriter.recoverPending()).resolves.toEqual([{
            transactionId: 'txn-restart',
            action: 'rolled-back',
        }])

        expect(bytesEqual(adapter.file('output/restart.png'), oldBytes)).toBe(true)
        expect(adapter.paths()).toEqual(['output/restart.png'])
        expectNoTransactionArtifacts(adapter)
    })

    it('allocates a unique duplicate filename and leaves only committed finals', async () => {
        const adapter = new InMemoryOutputAdapter()
        const original = new Uint8Array([7, 7, 7])
        adapter.seed('output/result.png', original)

        const outcome = await writer(adapter).write(request())

        expect(outcome).toMatchObject({
            status: 'committed',
            result: {
                fileName: 'result-2.png',
                path: '/app-data/output/result-2.png',
            },
        })
        expect(bytesEqual(adapter.file('output/result.png'), original)).toBe(true)
        expect(bytesEqual(adapter.file('output/result-2.png'), IMAGE_BYTES)).toBe(true)
        expect(adapter.paths()).toEqual(['output/result-2.png', 'output/result.png'])
        expectNoTransactionArtifacts(adapter)
    })

    it('commits an organizer artifact sidecar atomically with a checksum-linked distribution image', async () => {
        const adapter = new InMemoryOutputAdapter()
        const artifactSidecar = new TextEncoder().encode('{"artifactId":"artifact-fixture"}')

        const outcome = await writer(adapter).write(request({ artifactSidecarBytes: artifactSidecar }))

        expect(outcome).toMatchObject({
            status: 'committed',
            result: {
                fileName: 'result.png',
                artifactSidecarPath: '/app-data/output/result.nai-blue.artifact.json',
                contentChecksum: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            },
        })
        expect(bytesEqual(adapter.file('output/result.png'), IMAGE_BYTES)).toBe(true)
        expect(bytesEqual(adapter.file('output/result.nai-blue.artifact.json'), artifactSidecar)).toBe(true)
        expectNoTransactionArtifacts(adapter)
    })

    it('commits a pre-encoded metadata preservation sidecar next to a non-generation image', async () => {
        const adapter = new InMemoryOutputAdapter()
        const metadataSidecar = new TextEncoder().encode('{"format":"nai-blue-library-image-release"}')

        const outcome = await writer(adapter).write(request({ metadataSidecarBytes: metadataSidecar }))

        expect(outcome).toMatchObject({
            status: 'committed',
            result: {
                fileName: 'result.png',
                sidecarPath: '/app-data/output/result.nai-blue.json',
            },
        })
        expect(bytesEqual(adapter.file('output/result.nai-blue.json'), metadataSidecar)).toBe(true)
        expectNoTransactionArtifacts(adapter)
    })

    it('leaves files and journal untouched when a strict retry owner no longer matches', async () => {
        const adapter = new InMemoryOutputAdapter()
        const outputWriter = writer(adapter, 'txn-strict-owner')
        const commitWorkflow = vi.fn()

        await expect(outputWriter.write(request({
            sourceJobId: 'job:owner',
            terminalWorkflowCommit: true,
            commitWorkflow: () => {
                adapter.fault = { operation: 'write-journal' }
            },
        }))).rejects.toBeInstanceOf(OutputWriterError)

        await expect(outputWriter.retryFilesCommittedWorkflow(
            'txn-strict-owner',
            'job:other',
            commitWorkflow,
        )).resolves.toEqual({
            transactionId: 'txn-strict-owner',
            action: 'ineligible',
            ineligibility: 'source-job-mismatch',
        })
        expect(commitWorkflow).not.toHaveBeenCalled()
        expect(adapter.file('output/result.png')).toEqual(IMAGE_BYTES)
        expect(await outputWriter.inspectPendingQueueTransactions()).toEqual([{
            transactionId: 'txn-strict-owner',
            sourceJobId: 'job:owner',
            phase: 'files-committed',
        }])
    })

    it('treats an existing organizer artifact sidecar as a collision and rolls it back with the image on workflow failure', async () => {
        const adapter = new InMemoryOutputAdapter()
        const existing = new Uint8Array([7, 7, 7])
        adapter.seed('output/result.nai-blue.artifact.json', existing)
        const artifactSidecar = new TextEncoder().encode('{"artifactId":"artifact-fixture"}')
        let attemptedFileName = ''
        const commitFailure = new Error('store commit failed')

        await expect(writer(adapter).write(request({
            artifactSidecarBytes: artifactSidecar,
            commitWorkflow: result => {
                attemptedFileName = result.fileName
                throw commitFailure
            },
        }))).rejects.toBe(commitFailure)

        expect(attemptedFileName).toBe('result-2.png')
        expect(bytesEqual(adapter.file('output/result.nai-blue.artifact.json'), existing)).toBe(true)
        expect(adapter.paths()).toEqual(['output/result.nai-blue.artifact.json'])
        expectNoTransactionArtifacts(adapter)
    })
})

describe('OutputWriter overwrite rollback safety', () => {
    it('preserves a pre-existing final when staging an overwrite fails', async () => {
        const adapter = new InMemoryOutputAdapter()
        const original = new Uint8Array([6, 6, 6])
        adapter.seed('output/result.png', original)
        adapter.fault = {
            operation: 'write-file',
            when: call => call.to?.includes('.image.tmp') === true,
        }

        await expect(writer(adapter).write(request({
            destination: {
                directory: 'output',
                workflowDefaultDirectory: 'NAI_Blue_Output',
                extension: 'png',
                fileName: 'result.png',
                collisionPolicy: 'overwrite',
            },
        }))).rejects.toBeInstanceOf(OutputWriterError)

        expect(bytesEqual(adapter.file('output/result.png'), original)).toBe(true)
        expect(adapter.paths()).toEqual(['output/result.png'])
        expectNoTransactionArtifacts(adapter)
    })
})
