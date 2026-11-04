import { BaseDirectory, mkdir, writeFile } from '@tauri-apps/plugin-fs'
import { getAgentCommandInputContract } from '@/application/agent/agent-command-input'
import type { AgentCommandHandler } from '@/application/agent/runtime-capability-registry'
import { sha256Bytes } from '@/lib/binary-digest'
import { makeAgentImagePreview, readSavedArtifactImage } from '@/services/agent/saved-artifact-image'
import { reportDiagnostic } from '@/services/diagnostics/error-registry'
import type { JsonObject } from '@/domain/composition/types'

/** The private inbox cache is reachable only through its authenticated saved receipt;
 * the public handle is a request ID, never a filesystem capability or arbitrary path. */
export function createAgentArtifactImageHandler(): AgentCommandHandler {
    return { command: 'artifact.get_image', effect: 'read', validate: getAgentCommandInputContract('artifact.get_image')!.validate,
        receiptState: result => result.found === true ? 'completed' : 'rejected',
        execute: async (input, context): Promise<JsonObject> => {
            try {
                const image = await readSavedArtifactImage(input.artifactId as string)
                const preview = await makeAgentImagePreview(image)
                const requestId = context.envelope.requestId
                const directory = 'agent-commands/images'
                await mkdir(directory, { baseDir: BaseDirectory.AppData, recursive: true })
                await writeFile(`${directory}/${requestId}.png`, preview.bytes, { baseDir: BaseDirectory.AppData })
                return { found: true, artifactId: input.artifactId, contentChecksum: image.checksum,
                    resource: { requestId, mimeType: 'image/png',
                        byteLength: preview.bytes.length, contentChecksum: await sha256Bytes(preview.bytes), width: preview.width, height: preview.height } }
            } catch (error) {
                const diagnostic = reportDiagnostic(error, { operation: 'agent.artifact.image', stage: 'materialize' })
                return { found: false, code: 'SAVED_IMAGE_UNAVAILABLE', diagnostic: { resourceId: diagnostic.eventId } }
            }
        } }
}
