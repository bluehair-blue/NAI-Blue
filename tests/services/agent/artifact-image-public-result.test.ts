import { describe, expect, it, vi } from 'vitest'
import { AgentCommandDispatcher } from '@/application/agent/agent-command-dispatcher'
import { agentRequestHash, assertAgentPublicValue, type AgentCommandEnvelope } from '@/application/agent/agent-command-contract'
import { agentResultDigest, type AgentCommandReceipt, type CommandReceiptRepository } from '@/application/agent/command-receipt-repository'
import { createAgentArtifactImageHandler } from '@/composition-root/agent-artifact-image'

const mocks = vi.hoisted(() => ({ read: vi.fn(), preview: vi.fn(), mkdir: vi.fn(), write: vi.fn(), diagnostic: vi.fn() }))
vi.mock('@tauri-apps/plugin-fs', () => ({ BaseDirectory: { AppData: 1 }, mkdir: mocks.mkdir, writeFile: mocks.write }))
vi.mock('@/services/agent/saved-artifact-image', () => ({ readSavedArtifactImage: mocks.read, makeAgentImagePreview: mocks.preview }))
vi.mock('@/services/diagnostics/error-registry', () => ({ reportDiagnostic: mocks.diagnostic }))

// Hash-only native evidence; no original pixels, private file or Provider request is used.
const originalChecksum = 'sha256:538ff0aae9891c2e0cda87e6d31b16164d490ba31f8ec6617a9487a2be8576cd'
const artifactId = 'artifact:scene-job-agent-8bb9724029a4f829995c5931da05c6f3de837af3ce7ae9254711e90ee2fa652a-1'

describe('saved image result checksum byte alignment', () => {
    it('publishes the actual original checksum through the production handler and durable replay', async () => {
        mocks.read.mockResolvedValue({ bytes: new Uint8Array([1]), mimeType: 'image/png', checksum: originalChecksum })
        mocks.preview.mockResolvedValue({ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70]), mimeType: 'image/jpeg',
            width: 480, height: 480, sourceWidth: 1024, sourceHeight: 1024 })
        const saved = new Map<string, AgentCommandReceipt>()
        const receipts: CommandReceiptRepository = {
            get: async id => saved.get(id) ?? null,
            claim: async receipt => { saved.set(receipt.requestId, receipt); return { status: 'claimed', receipt } },
            finish: async (_expected, receipt) => { saved.set(receipt.requestId, receipt); return receipt },
        }
        const requestId = 'qa-artifact-checksum-alignment'
        const unsigned: AgentCommandEnvelope = { schemaVersion: 1, requestId, requestHash: `sha256:${'0'.repeat(64)}`,
            submittedAt: '2026-10-19T00:00:00.000Z',
            context: { apiVersion: 'nai-blue.agent/v1alpha1', workspaceId: 'workspace-1', clientId: 'client-1',
                actor: { kind: 'agent' }, idempotencyKey: requestId },
            command: { name: 'artifact.get_image', input: { artifactId } },
            authentication: { scheme: 'hmac-sha256', keyId: 'key-1', signature: `hmac-sha256:${'0'.repeat(64)}` } }
        const envelope = { ...unsigned, requestHash: agentRequestHash(unsigned) }
        const dispatcher = new AgentCommandDispatcher({ workspaceId: 'workspace-1', receipts,
            authentication: { authenticate: async () => ({ clientId: 'client-1', actor: { kind: 'agent', id: 'client:client-1' } }) },
            handlers: [createAgentArtifactImageHandler()], runtime: () => ({ ready: true, mode: 'suggest', globalPause: false }),
            now: () => '2026-10-19T00:00:01.000Z' })
        const receipt = await dispatcher.dispatch(envelope)
        expect(receipt).toMatchObject({ state: 'completed', result: { found: true, artifactId, contentChecksum: originalChecksum,
            resource: { requestId, mimeType: 'image/jpeg', byteLength: 8, width: 480, height: 480, sourceWidth: 1024, sourceHeight: 1024 } } })
        expect(receipt.resultDigest).toBe(agentResultDigest(receipt.result!))
        expect(() => assertAgentPublicValue(receipt.result)).not.toThrow()
        expect(await dispatcher.dispatch(envelope)).toEqual(receipt)
        expect(mocks.read).toHaveBeenCalledExactlyOnceWith(artifactId)
        // An old-shape request passes no preview options, so the renderer applies its 480 px default.
        expect(mocks.preview).toHaveBeenCalledExactlyOnceWith(expect.anything(), {})
        expect(mocks.write).toHaveBeenCalledExactlyOnceWith(`agent-commands/images/${requestId}.jpg`, expect.any(Uint8Array), { baseDir: 1 })
        expect(mocks.diagnostic).not.toHaveBeenCalled()
    })

    it('forwards maxSide and region to the renderer unchanged', async () => {
        mocks.preview.mockClear()
        mocks.read.mockResolvedValue({ bytes: new Uint8Array([1]), mimeType: 'image/png', checksum: originalChecksum })
        mocks.preview.mockResolvedValue({ bytes: new Uint8Array([0xff, 0xd8, 0xff]), mimeType: 'image/jpeg', width: 768, height: 384, sourceWidth: 1024, sourceHeight: 1536 })
        const handler = createAgentArtifactImageHandler()
        const region = { x: 0.25, y: 0.5, width: 0.75, height: 0.25 }
        const result = await handler.execute(handler.validate({ artifactId, maxSide: 768, region }),
            { envelope: { requestId: 'zoomed-read' } } as never)
        expect(mocks.preview).toHaveBeenCalledExactlyOnceWith(expect.anything(), { maxSide: 768, region })
        expect(result).toMatchObject({ found: true, resource: { mimeType: 'image/jpeg', width: 768, height: 384, sourceWidth: 1024, sourceHeight: 1536 } })
        expect(JSON.stringify(result)).not.toMatch(/[A-Za-z]:[\\/]|agent-commands/)
    })

    it('changes neither the checksum nor the untyped high-entropy payload boundary', () => {
        const value = { contentChecksum: originalChecksum }
        const before = JSON.stringify(value)
        expect(() => assertAgentPublicValue(value)).not.toThrow()
        expect(JSON.stringify(value)).toBe(before)
        expect(() => assertAgentPublicValue({ untyped: originalChecksum })).toThrow()
    })

    it('does not invent a short JPEGXL marker by shifting a half byte', () => {
        const value = { contentChecksum: `sha256:fff0a${'ab'.repeat(29)}f` }
        expect(() => assertAgentPublicValue(value)).not.toThrow()
    })

    it('keeps a longer JPEG marker between incomplete nibbles blocked', () => {
        expect(() => assertAgentPublicValue({ contentChecksum: `sha256:fffd8ff${'ab'.repeat(28)}f` })).toThrow()
    })

    it.each([
        ['canonical JPEGXL hex', { contentChecksum: `sha256:ff0a${'ab'.repeat(30)}` }],
        ['byte-offset JPEGXL hex', { contentChecksum: `sha256:00ff0a${'ab'.repeat(29)}` }],
        ['raw JPEGXL', { contentChecksum: String.fromCharCode(255, 10, 1, 2) }],
        ['JPEGXL Base64', { contentChecksum: btoa(String.fromCharCode(255, 10, 1, 2, 3, 4, 5, 6)) }],
        ['JPEGXL byte array', { contentChecksum: [255, 10] }],
        ['typed byte array', { contentChecksum: new Uint8Array([255, 10]) }],
        ['canonical PNG hex', { contentChecksum: '89504e470d0a1a0a' }],
        ['byte-offset PNG hex', { contentChecksum: '0089504e470d0a1a0a' }],
        ['PNG between incomplete nibbles', { contentChecksum: 'f89504e470d0a1a0af' }],
        ['PNG after incomplete nibble', { contentChecksum: 'f89504e470d0a1a0a' }],
        ['PNG Base64', { contentChecksum: 'iVBORw0KGgo=' }],
        ['binary Base64', { contentChecksum: 'AAECAwQFBgcICQoL' }],
        ['unknown binary', { value: 'agaa agaa agaa agaa' }],
        ['private path', { contentChecksum: 'C:/private/file.png' }],
        ['credential', { contentChecksum: 'Bearer synthetic-secret-value' }],
        ['forbidden image field', { imageBytes: [1, 2, 3] }],
    ])('still rejects %s', (_label, value) => {
        expect(() => assertAgentPublicValue(value)).toThrow()
    })
})
