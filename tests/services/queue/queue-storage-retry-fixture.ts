import type { OutputFileRef, OutputPlatformAdapter } from '@/services/output/platform-adapter'
import { OutputWriter } from '@/services/output/output-writer'

/** Actual writer over a small memory filesystem; captures a crash after durable file commit. */
export function storageRetryWriterFixture() {
    const files = new Map<string, Uint8Array>()
    const journals = new Map<string, Uint8Array>()
    const calls: string[] = []
    const key = (file: OutputFileRef) => file.path
    const platform: OutputPlatformAdapter = {
        capabilities: {
            absolutePaths: false, atomicSiblingRename: true,
            outputReservationGuarantee: 'atomic-no-replace', runtime: 'app-scoped',
        },
        resolveDirectory: async request => ({
            path: request.directory || request.workflowDefaultDirectory,
            displayPath: `/app-data/${request.directory || request.workflowDefaultDirectory}`,
            baseDir: 1, capabilityFallbackUsed: false,
        }),
        ensureDirectory: async () => undefined,
        exists: async file => files.has(key(file)),
        writeFile: async (file, bytes) => { calls.push('write-file'); files.set(key(file), bytes.slice()) },
        readFile: async file => {
            const bytes = files.get(key(file))
            if (!bytes) throw new Error('Missing file')
            return bytes.slice()
        },
        rename: async (from, to) => {
            const bytes = files.get(key(from))
            if (!bytes) throw new Error('Missing source')
            files.set(key(to), bytes); files.delete(key(from))
        },
        commitSiblingIfAbsent: async (from, to) => {
            if (files.has(key(to))) return { status: 'destination-exists' }
            const bytes = files.get(key(from))
            if (!bytes) throw new Error('Missing source')
            files.set(key(to), bytes); files.delete(key(from))
            return { status: 'committed' }
        },
        remove: async file => { calls.push('remove-file'); files.delete(key(file)) },
        writeJournal: async (id, bytes) => { journals.set(id, bytes.slice()) },
        readJournal: async id => { calls.push(`read:${id}`); return journals.get(id)?.slice() ?? null },
        removeJournal: async id => { journals.delete(id) },
        listJournalIds: async () => { calls.push('list-journals'); return [...journals.keys()] },
    }
    const writer = new OutputWriter(platform, { prepare: bytes => ({ imageBytes: bytes }) })
    async function seedFilesCommitted(transactionId = 'txn-bound', sourceJobId = 'job:1') {
        let committedJournal: Uint8Array | undefined
        await writer.write({
            transactionId, sourceJobId, includeFinalImageFacts: true,
            destination: {
                directory: 'NAI_Blue_Output', useAbsolutePath: false,
                portableDirectory: { kind: 'standard', root: 'app-data', segments: ['NAI_Blue_Output'] },
                workflowDefaultDirectory: 'NAI_Blue_Output', extension: 'png',
                fileName: `${transactionId}.png`, collisionPolicy: 'unique',
            },
            imageBytes: new Uint8Array([1, 2, 3, 4]), imageDataUrl: 'data:image/png;base64,AQIDBA==',
            canCommit: () => true,
            commitWorkflow: () => { committedJournal = journals.get(transactionId)?.slice() },
        })
        if (!committedJournal) throw new Error('Writer did not persist the files-committed journal')
        journals.set(transactionId, committedJournal)
        calls.length = 0
    }
    return { writer, platform, journals, files, calls, seedFilesCommitted }
}
