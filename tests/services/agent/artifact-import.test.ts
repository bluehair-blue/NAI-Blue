import { describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { AgentCommandDispatcher } from '@/application/agent/agent-command-dispatcher'
import { agentRequestHash, assertAgentPublicValue, type AgentCommandEnvelope } from '@/application/agent/agent-command-contract'
import type { AgentCommandReceipt, CommandReceiptRepository } from '@/application/agent/command-receipt-repository'
import { createAgentArtifactImportHandler, type AgentArtifactImportPorts } from '@/composition-root/agent-artifact-import'
import { sha256Bytes } from '@/lib/binary-digest'
import { readSavedArtifactImage } from '@/services/agent/saved-artifact-image'
import { IndexedDBArtifactRepository } from '@/services/organizer/artifact-repository'
import type { OutputFileRef } from '@/services/output/platform-adapter'

vi.mock('@/services/diagnostics/error-registry', () => ({ reportDiagnostic: vi.fn(() => ({ eventId: 'diagnostic-1' })) }))

const png = (marker: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, marker])
const webp = new Uint8Array([...'RIFF'].map(c => c.charCodeAt(0)).concat([4, 0, 0, 0], [...'WEBPVP8 '].map(c => c.charCodeAt(0))))
const UNDECODABLE = 0xee, HUGE = 0xdd

function fixture(options: { consent?: boolean; sizeOnDisk?: number } = {}) {
    // The display path is absolute on purpose: nothing from it may reach a result.
    const directory = { path: 'Pictures/NAI_Blue_Import', displayPath: 'C:/Users/Private/Pictures/NAI_Blue_Import', capabilityFallbackUsed: false }
    const files = new Map<string, Uint8Array>()
    const platform = {
        resolveDirectory: vi.fn(async () => directory),
        ensureDirectory: vi.fn(async () => undefined),
        exists: vi.fn(async (file: OutputFileRef) => files.has(file.path)),
        readFile: vi.fn(async (file: OutputFileRef) => {
            const bytes = files.get(file.path)
            if (!bytes) throw new Error('missing')
            return bytes
        }),
    }
    const repository = new IndexedDBArtifactRepository({ factory: new IDBFactory(), keyRange: IDBKeyRange })
    const artifacts = { get: vi.fn((id: string) => repository.get(id)), putOriginal: vi.fn((input: Parameters<IndexedDBArtifactRepository['putOriginal']>[0]) => repository.putOriginal(input)) }
    const ports: AgentArtifactImportPorts = { artifacts, platform, hasEditingConsent: vi.fn(() => options.consent ?? true),
        ...(options.sizeOnDisk === undefined ? {} : { fileSize: vi.fn(async () => options.sizeOnDisk!) }),
        decode: vi.fn(async (bytes: Uint8Array) => {
            if (bytes.includes(UNDECODABLE)) throw new Error('decode failed')
            return bytes.includes(HUGE) ? { width: 8192, height: 4096 } : { width: 832, height: 1216 }
        }) }
    const handler = createAgentArtifactImportHandler(ports)
    const run = (fileName: string) => handler.execute(handler.validate({ fileName }), { envelope: { context: { clientId: 'client-1' } } } as never)
    const put = (fileName: string, bytes: Uint8Array) => files.set(`${directory.path}/${fileName}`, bytes)
    return { run, put, files, platform, artifacts, repository, ports, handler }
}

describe('artifact.import from the fixed import folder', () => {
    it('registers a PNG as a content-addressed Artifact without a source job and returns no path', async () => {
        const f = fixture()
        const bytes = png(1)
        f.put('edited.png', bytes)
        const checksum = await sha256Bytes(bytes)
        const result = await f.run('edited.png')
        expect(result).toEqual({ status: 'imported', artifactId: `artifact:import-${checksum.slice(7, 39)}`, contentChecksum: checksum,
            width: 832, height: 1216, format: 'png', byteLength: bytes.length, fileName: 'edited.png' })
        expect(f.platform.resolveDirectory).toHaveBeenCalledWith({ portableDirectory: { kind: 'standard', root: 'pictures', segments: ['NAI_Blue_Import'] },
            workflowDefaultDirectory: 'NAI_Blue_Import' })
        expect(() => assertAgentPublicValue(result)).not.toThrow()
        expect(JSON.stringify(result)).not.toMatch(/Private|Pictures|[A-Za-z]:[\\/]/)
        const record = await f.repository.get(result.artifactId as string)
        expect(record).toMatchObject({ sourceJobId: null, sourceSceneId: null, outputCommitSetHash: null, contentChecksum: checksum,
            original: { format: 'png', size: bytes.length, file: { fileName: 'edited.png', directory: { kind: 'standard', root: 'pictures', segments: ['NAI_Blue_Import'] } } } })
        // The existing Image2Image read path accepts it unchanged (validateImageSource checks the same record fields).
        await expect(readSavedArtifactImage(result.artifactId as string, checksum, { artifacts: f.repository, platform: f.platform }))
            .resolves.toMatchObject({ checksum, mimeType: 'image/png' })
    })

    it('refuses a file above the size limit by its size on disk, before reading it', async () => {
        const f = fixture({ sizeOnDisk: 25 * 1024 * 1024 + 1 })
        f.put('huge.png', png(9))
        expect(await f.run('huge.png')).toEqual({ status: 'rejected', code: 'IMPORT_TOO_LARGE' })
        expect(f.platform.readFile).not.toHaveBeenCalled()
        expect(f.artifacts.putOriginal).not.toHaveBeenCalled()
    })

    it('is idempotent for the same bytes under the same or another name and never replaces the original', async () => {
        const f = fixture()
        f.put('edited.png', png(2))
        const first = await f.run('edited.png')
        expect(await f.run('edited.png')).toEqual(first)
        f.put('copy of edited.png', png(2))
        expect(await f.run('copy of edited.png')).toEqual(first)
        expect(f.artifacts.putOriginal).toHaveBeenCalledTimes(1)
        expect((await f.repository.list()).items).toHaveLength(1)
        f.put('other.webp', webp)
        const other = await f.run('other.webp')
        expect(other).toMatchObject({ status: 'imported', format: 'webp', fileName: 'other.webp' })
        expect(other.artifactId).not.toBe(first.artifactId)
    })

    it('names the original file to restore when the same bytes return under another name after it was removed', async () => {
        const f = fixture()
        f.put('edited.png', png(6))
        const first = await f.run('edited.png')
        f.files.clear()
        f.put('renamed.png', png(6))
        expect(await f.run('renamed.png')).toEqual({ status: 'rejected', code: 'IMPORT_ORIGINAL_MISSING', fileName: 'edited.png' })
        // The record is never repointed; restoring the name makes the same artifact readable again.
        f.put('edited.png', png(6))
        expect(await f.run('renamed.png')).toEqual(first)
        expect(f.artifacts.putOriginal).toHaveBeenCalledTimes(1)
    })

    it('checks consent again before writing and refuses Windows device names', async () => {
        const f = fixture()
        f.put('edited.png', png(7))
        vi.mocked(f.ports.hasEditingConsent).mockReturnValueOnce(true).mockReturnValueOnce(false)
        expect(await f.run('edited.png')).toEqual({ status: 'rejected', code: 'AGENT_EDITING_CONSENT_REQUIRED' })
        expect(f.artifacts.putOriginal).not.toHaveBeenCalled()
        for (const name of ['con.png', 'con .png', 'NUL  .webp', 'com1.png', 'com¹.png', 'lpt³ .png', 'aux.backup.png']) {
            expect(() => f.handler.validate({ fileName: name }), name).toThrow()
        }
        for (const name of ['console.png', 'computer 1.png', 'nullable.webp']) expect(() => f.handler.validate({ fileName: name }), name).not.toThrow()
    })

    it('creates the folder and reports a missing file', async () => {
        const f = fixture()
        expect(await f.run('missing.png')).toEqual({ status: 'rejected', code: 'IMPORT_FILE_NOT_FOUND' })
        expect(f.platform.ensureDirectory).toHaveBeenCalledTimes(1)
        expect(f.platform.readFile).not.toHaveBeenCalled()
    })

    it('rejects files that are not real PNG or WebP images, and oversized ones, without registering anything', async () => {
        const f = fixture()
        f.put('photo.png', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]))
        f.put('broken.png', png(UNDECODABLE))
        f.put('huge.png', png(HUGE))
        f.put('big.webp', Object.assign(new Uint8Array(25 * 1024 * 1024 + 1), webp))
        expect(await f.run('photo.png')).toEqual({ status: 'rejected', code: 'IMPORT_NOT_AN_IMAGE' })
        expect(await f.run('broken.png')).toEqual({ status: 'rejected', code: 'IMPORT_NOT_AN_IMAGE' })
        expect(await f.run('huge.png')).toEqual({ status: 'rejected', code: 'IMPORT_NOT_AN_IMAGE' })
        expect(await f.run('big.webp')).toEqual({ status: 'rejected', code: 'IMPORT_TOO_LARGE' })
        expect(f.artifacts.putOriginal).not.toHaveBeenCalled()
    })

    it('reads and writes nothing without active editing consent', async () => {
        const f = fixture({ consent: false })
        f.put('edited.png', png(3))
        expect(await f.run('edited.png')).toEqual({ status: 'rejected', code: 'AGENT_EDITING_CONSENT_REQUIRED' })
        expect(f.ports.hasEditingConsent).toHaveBeenCalledWith('client-1')
        for (const port of Object.values(f.platform)) expect(port).not.toHaveBeenCalled()
        expect(f.artifacts.get).not.toHaveBeenCalled()
    })

    it('reports an unusable folder or store as IMPORT_UNAVAILABLE', async () => {
        const f = fixture()
        f.platform.resolveDirectory.mockRejectedValueOnce(new Error('C:/Users/Private denied'))
        expect(await f.run('edited.png')).toEqual({ status: 'rejected', code: 'IMPORT_UNAVAILABLE' })
        f.put('edited.png', png(4))
        f.artifacts.putOriginal.mockRejectedValueOnce(new Error('store failed'))
        expect(await f.run('edited.png')).toEqual({ status: 'rejected', code: 'IMPORT_UNAVAILABLE' })
    })

    it('is registered as a plan command whose rejections are rejected receipts', async () => {
        const f = fixture()
        f.put('edited.png', png(5))
        const saved = new Map<string, AgentCommandReceipt>()
        const receipts: CommandReceiptRepository = {
            get: async id => saved.get(id) ?? null,
            claim: async receipt => { saved.set(receipt.requestId, receipt); return { status: 'claimed', receipt } },
            finish: async (_expected, receipt) => { saved.set(receipt.requestId, receipt); return receipt },
        }
        const dispatcher = new AgentCommandDispatcher({ workspaceId: 'workspace-1', receipts,
            authentication: { authenticate: async () => ({ clientId: 'client-1', actor: { kind: 'agent', id: 'client:client-1' } }) },
            handlers: [f.handler], runtime: () => ({ ready: true, mode: 'suggest', globalPause: false }), now: () => '2026-11-22T00:00:01.000Z' })
        const dispatch = (requestId: string, fileName: string) => {
            const unsigned: AgentCommandEnvelope = { schemaVersion: 1, requestId, requestHash: `sha256:${'0'.repeat(64)}`, submittedAt: '2026-11-22T00:00:00.000Z',
                context: { apiVersion: 'nai-blue.agent/v1alpha1', workspaceId: 'workspace-1', clientId: 'client-1', actor: { kind: 'agent' }, idempotencyKey: requestId },
                command: { name: 'artifact.import', input: { fileName } },
                authentication: { scheme: 'hmac-sha256', keyId: 'key-1', signature: `hmac-sha256:${'0'.repeat(64)}` } }
            return dispatcher.dispatch({ ...unsigned, requestHash: agentRequestHash(unsigned) })
        }
        expect(await dispatch('import-1', 'edited.png')).toMatchObject({ command: 'artifact.import', state: 'completed', result: { status: 'imported' } })
        expect(await dispatch('import-2', 'missing.png')).toMatchObject({ state: 'rejected', result: { code: 'IMPORT_FILE_NOT_FOUND' } })
        const observe = new AgentCommandDispatcher({ workspaceId: 'workspace-1', receipts,
            authentication: { authenticate: async () => ({ clientId: 'client-1', actor: { kind: 'agent', id: 'client:client-1' } }) },
            handlers: [f.handler], runtime: () => ({ ready: true, mode: 'observe', globalPause: false }) })
        expect(observe.capabilities().find(item => item.command === 'artifact.import')).toMatchObject({ available: false, reason: 'observe-only', requiresHumanApproval: false })
    })
})
