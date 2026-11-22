import { getAgentCommandInputContract } from '@/application/agent/agent-command-input'
import type { AgentCommandHandler } from '@/application/agent/runtime-capability-registry'
import type { JsonObject, StandardPortablePathRef } from '@/domain/composition/types'
import type { ArtifactRecord, CreateArtifactRecordInput } from '@/domain/organizer/types'
import { sha256Bytes } from '@/lib/binary-digest'
import { MAX_AGENT_IMAGE_PIXELS, MAX_AGENT_ORIGINAL_IMAGE_BYTES } from '@/services/agent/saved-artifact-image'
import { reportDiagnostic } from '@/services/diagnostics/error-registry'
import { childOutputRef, type OutputFileRef, type OutputPlatformAdapter } from '@/services/output/platform-adapter'

/** The only place an agent may register a local image from: Pictures/NAI_Blue_Import, never a caller path. */
export const AGENT_IMPORT_DIRECTORY: Readonly<StandardPortablePathRef> = Object.freeze({ kind: 'standard', root: 'pictures', segments: ['NAI_Blue_Import'] })

export interface AgentArtifactImportPorts {
    readonly artifacts: { get(id: string): Promise<ArtifactRecord | null>; putOriginal(input: CreateArtifactRecordInput): Promise<ArtifactRecord> }
    /** Active "always approve editing" consent of this client; checked before any file access. */
    readonly hasEditingConsent: (clientId: string) => boolean
    readonly platform?: Pick<OutputPlatformAdapter, 'resolveDirectory' | 'ensureDirectory' | 'exists' | 'readFile'>
    /** Size on disk before the whole file is read; defaults to the native stat when the runtime platform is used. */
    readonly fileSize?: (file: OutputFileRef) => Promise<number>
    readonly decode?: (bytes: Uint8Array, mimeType: string) => Promise<{ width: number; height: number }>
}

async function sizeOnDisk(file: OutputFileRef): Promise<number> {
    const { stat } = await import('@tauri-apps/plugin-fs')
    return (await stat(file.path, file.baseDir === undefined ? undefined : { baseDir: file.baseDir })).size
}

const rejected = (code: string): JsonObject => ({ status: 'rejected', code })

function imageFormat(bytes: Uint8Array): 'png' | 'webp' | null {
    const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))
    if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte)) return 'png'
    return bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP' ? 'webp' : null
}

async function decodeWithBrowser(bytes: Uint8Array, mimeType: string) {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mimeType }))
    try { return { width: bitmap.width, height: bitmap.height } } finally { bitmap.close() }
}

function imported(record: ArtifactRecord, width: number, height: number): JsonObject {
    // fileName names the file the record points at: a re-import of the same bytes keeps the first name.
    return { status: 'imported', artifactId: record.artifactId, contentChecksum: record.original.contentChecksum, width, height,
        format: record.original.format, byteLength: record.original.size, fileName: record.original.file.fileName }
}

/** Content-addressed and idempotent: equal bytes always map to one Artifact, whose original is never replaced. */
export function createAgentArtifactImportHandler(ports: AgentArtifactImportPorts): AgentCommandHandler {
    return { command: 'artifact.import', effect: 'plan', validate: getAgentCommandInputContract('artifact.import')!.validate,
        receiptState: result => result.status === 'imported' ? 'completed' : 'rejected',
        execute: async (input, { envelope }): Promise<JsonObject> => {
            if (!ports.hasEditingConsent(envelope.context.clientId)) return rejected('AGENT_EDITING_CONSENT_REQUIRED')
            const fileName = input.fileName as string
            try {
                const platform = ports.platform ?? (await import('@/services/output/tauri-output-adapter')).createRuntimeOutputPlatformAdapter()
                const directory = await platform.resolveDirectory({ portableDirectory: structuredClone(AGENT_IMPORT_DIRECTORY) as StandardPortablePathRef,
                    workflowDefaultDirectory: 'NAI_Blue_Import' })
                // Creating the folder lets the human find where to put the file after a first miss.
                await platform.ensureDirectory(directory)
                const file = childOutputRef(directory, fileName)
                if (!await platform.exists(file)) return rejected('IMPORT_FILE_NOT_FOUND')
                // The file is read whole, so a mislabelled multi-gigabyte file is refused by its size first.
                const fileSize = ports.fileSize ?? (ports.platform === undefined ? sizeOnDisk : undefined)
                if (fileSize !== undefined && await fileSize(file) > MAX_AGENT_ORIGINAL_IMAGE_BYTES) return rejected('IMPORT_TOO_LARGE')
                const bytes = await platform.readFile(file)
                if (bytes.length > MAX_AGENT_ORIGINAL_IMAGE_BYTES) return rejected('IMPORT_TOO_LARGE')
                const format = imageFormat(bytes)
                if (format === null) return rejected('IMPORT_NOT_AN_IMAGE')
                let size: { width: number; height: number }
                try { size = await (ports.decode ?? decodeWithBrowser)(bytes, `image/${format}`) } catch { return rejected('IMPORT_NOT_AN_IMAGE') }
                if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width < 1 || size.height < 1
                    || size.width * size.height > MAX_AGENT_IMAGE_PIXELS) return rejected('IMPORT_NOT_AN_IMAGE')
                const contentChecksum = await sha256Bytes(bytes)
                const artifactId = `artifact:import-${contentChecksum.slice('sha256:'.length, 'sha256:'.length + 32)}`
                const existing = await ports.artifacts.get(artifactId)
                if (existing !== null) {
                    if (existing.original.contentChecksum !== contentChecksum) return rejected('IMPORT_UNAVAILABLE')
                    // The record keeps the name of its first import and is never repointed; if that file is gone,
                    // the caller learns the name to restore instead of an artifact that cannot be read.
                    const original = existing.original.file.fileName
                    if (original !== fileName && !await platform.exists(childOutputRef(directory, original))) {
                        return { ...rejected('IMPORT_ORIGINAL_MISSING'), fileName: original }
                    }
                    return imported(existing, size.width, size.height)
                }
                // Reading and decoding took time; consent may have been withdrawn since the first check.
                if (!ports.hasEditingConsent(envelope.context.clientId)) return rejected('AGENT_EDITING_CONSENT_REQUIRED')
                const record = await ports.artifacts.putOriginal({ artifactId, sourceJobId: null, sourceSceneId: null,
                    file: { directory: structuredClone(AGENT_IMPORT_DIRECTORY) as StandardPortablePathRef, fileName },
                    format, contentChecksum, size: bytes.length })
                return imported(record, size.width, size.height)
            } catch (error) {
                reportDiagnostic(error, { operation: 'agent.artifact.import', stage: 'register' })
                return rejected('IMPORT_UNAVAILABLE')
            }
        } }
}
