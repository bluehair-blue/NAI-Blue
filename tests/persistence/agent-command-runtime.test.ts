import { webcrypto } from 'node:crypto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentCommandDispatcher } from '@/application/agent/agent-command-dispatcher'
import { AgentCommandError, agentRequestHash, canonicalAgentSigningPayload, type AgentCommandEnvelope, type AgentCommandName } from '@/application/agent/agent-command-contract'
import { describeAgentCommandCapabilities } from '@/application/agent/runtime-capability-registry'
import type { AgentCommandHandler, AgentCommandRuntimeState } from '@/application/agent/runtime-capability-registry'
import type { CommandReceiptRepository } from '@/application/agent/command-receipt-repository'
import { IndexedDbCommandReceiptRepository } from '@/adapters/agent/indexeddb-command-receipt-repository'
import { WebCryptoAgentAuthentication } from '@/adapters/agent/webcrypto-agent-authentication'
import { createInboxSubmissionReceipt, processAgentInboxFile } from '@/adapters/agent/inbox/process-agent-inbox-file'
import { initializeAgentCommandRuntime } from '@/composition-root/agent-command-runtime'
import { resetIndexedDBConnectionForRetry } from '@/lib/indexed-db'
import type { JsonObject } from '@/domain/composition/types'

const now = '2026-09-05T00:00:01.000Z'
const subtle = webcrypto.subtle as unknown as SubtleCrypto

async function fixture() {
    const key = await subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
    let revoked = false
    const authentication = new WebCryptoAgentAuthentication(async (clientId, keyId) => (
        clientId === 'client-1' && keyId === 'key-1'
            ? { clientId, keyId, revokedAt: revoked ? now : null, actorKind: 'agent', key } : null
    ), subtle)
    const execute = vi.fn(async (): Promise<JsonObject> => ({ count: 1 }))
    let state: AgentCommandRuntimeState = { ready: true, mode: 'suggest', globalPause: false }
    let observedAt = now
    const handlers: AgentCommandHandler[] = [
        { command: 'workspace.get_snapshot', effect: 'read', validate: input => input, execute },
        { command: 'generation.plan', effect: 'plan', validate: input => input, execute },
        { command: 'generation.enqueue', effect: 'mutation', validate: input => input, execute },
    ]
    const repository = new IndexedDbCommandReceiptRepository()
    const dispatcher = (receipts: CommandReceiptRepository = repository) => new AgentCommandDispatcher({
        workspaceId: 'workspace-1', authentication, receipts, handlers, runtime: () => state, now: () => observedAt,
    })
    async function sign(requestId: string, name: AgentCommandName = 'workspace.get_snapshot', input: JsonObject = {}) {
        const envelope: AgentCommandEnvelope = {
            schemaVersion: 1, requestId, requestHash: `sha256:${'0'.repeat(64)}`,
            submittedAt: '2026-09-05T00:00:00.000Z', expiresAt: '2026-09-05T01:00:00.000Z',
            context: { apiVersion: 'nai-blue.agent/v1alpha1', workspaceId: 'workspace-1', clientId: 'client-1',
                actor: { kind: 'agent' }, idempotencyKey: requestId },
            command: { name, input },
            authentication: { scheme: 'hmac-sha256', keyId: 'key-1', signature: `hmac-sha256:${'0'.repeat(64)}` },
        }
        const hashed = { ...envelope, requestHash: agentRequestHash(envelope) }
        const signature = await subtle.sign('HMAC', key, new TextEncoder().encode(canonicalAgentSigningPayload(hashed)))
        return { ...hashed, authentication: { ...hashed.authentication,
            signature: `hmac-sha256:${Buffer.from(signature).toString('hex')}` as const } }
    }
    return { sign, dispatcher, repository, execute, handlers, authentication,
        setTime: (value: string) => { observedAt = value }, revoke: () => { revoked = true },
        setState: (next: AgentCommandRuntimeState) => { state = next } }
}

beforeEach(() => { resetIndexedDBConnectionForRetry(); vi.stubGlobal('indexedDB', new IDBFactory()) })
afterEach(() => { resetIndexedDBConnectionForRetry(); vi.unstubAllGlobals() })

describe('authenticated durable command integration (simulated file port)', () => {
    it('keeps the claim but never executes a request that expires during its durable write', async () => {
        const f = await fixture()
        const receipts: CommandReceiptRepository = {
            get: id => f.repository.get(id), finish: (expected, next) => f.repository.finish(expected, next),
            claim: async receipt => {
                const result = await f.repository.claim(receipt)
                f.setTime('2026-09-05T01:00:00.000Z')
                return result
            },
        }
        const request = await f.sign('expires-during-claim')
        const result = await f.dispatcher(receipts).dispatch(request)
        expect(result).toMatchObject({ state: 'rejected', result: { code: 'REQUEST_EXPIRED' } })
        expect(f.execute).not.toHaveBeenCalled()
        resetIndexedDBConnectionForRetry()
        expect(await f.dispatcher(new IndexedDbCommandReceiptRepository()).dispatch(request)).toEqual(result)
        expect(f.execute).not.toHaveBeenCalled()
    })

    it('rejects forged read effects for mutation registration and keeps the registry unavailable', async () => {
        const f = await fixture()
        const forged: AgentCommandHandler = { ...f.handlers[2], effect: 'read' }
        expect(() => new AgentCommandDispatcher({ workspaceId: 'workspace-1', authentication: f.authentication,
            receipts: f.repository, handlers: [forged], runtime: () => ({ ready: true, mode: 'bounded-auto', globalPause: false }) }))
            .toThrow(AgentCommandError)
        expect(describeAgentCommandCapabilities([forged], { ready: true, mode: 'bounded-auto', globalPause: false })
            .find(item => item.command === 'generation.enqueue')).toMatchObject({ available: false, reason: 'invalid-command-registration' })
    })

    it('replays authenticated expired receipts before changed validation but rejects fresh expired work', async () => {
        const f = await fixture()
        const request = await f.sign('old-result')
        const original = await f.dispatcher().dispatch(request)
        f.setTime('2026-09-05T02:00:00.000Z')
        const validate = vi.fn(() => { throw new AgentCommandError('INVALID_COMMAND_INPUT') })
        f.handlers[0] = { ...f.handlers[0], validate }
        f.execute.mockClear()
        resetIndexedDBConnectionForRetry()
        const dispatcher = f.dispatcher(new IndexedDbCommandReceiptRepository())
        expect(await dispatcher.dispatch(request)).toEqual(original)
        expect(validate).not.toHaveBeenCalled()
        expect(f.execute).not.toHaveBeenCalled()
        await expect(dispatcher.dispatch(await f.sign('new-expired'))).rejects.toMatchObject({ code: 'REQUEST_EXPIRED' })
        expect(await f.repository.get('new-expired')).toBeNull()
        expect(validate).not.toHaveBeenCalled()
        f.revoke()
        await expect(dispatcher.dispatch(request)).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' })
    })

    it('does not publish rejection for a post-handler receipt CAS conflict', async () => {
        const f = await fixture()
        const receipts: CommandReceiptRepository = { get: id => f.repository.get(id), claim: input => f.repository.claim(input),
            finish: async () => { throw new AgentCommandError('RECEIPT_STORAGE_CONFLICT') } }
        const request = await f.sign('finish-conflict')
        const files = { readReady: vi.fn(async () => JSON.stringify(request)), publishResult: vi.fn(), publishRejection: vi.fn() }
        await expect(processAgentInboxFile('finish-conflict.ready.json', files, f.dispatcher(receipts)))
            .rejects.toMatchObject({ code: 'RECEIPT_STORAGE_CONFLICT' })
        expect(files.publishRejection).not.toHaveBeenCalled()
        expect(files.publishResult).not.toHaveBeenCalled()
        expect(f.execute).toHaveBeenCalledTimes(1)
        expect((await f.repository.get(request.requestId))?.state).toBe('accepted')
    })
    it('keeps independent IDs and atomically deduplicates concurrent authenticated requests', async () => {
        const f = await fixture()
        const request = await f.sign('first')
        const results = await Promise.all([f.dispatcher().dispatch(request), f.dispatcher().dispatch(request)])
        expect(results.some(result => result.state === 'completed')).toBe(true)
        expect(f.execute).toHaveBeenCalledTimes(1)
        expect((await f.repository.get('first'))?.state).toBe('completed')
        const second = await f.dispatcher().dispatch(await f.sign('second'))
        expect(second.requestId).toBe('second')
        expect(f.execute).toHaveBeenCalledTimes(2)
        const original = await f.repository.get('first')
        await expect(f.dispatcher().dispatch(await f.sign('first', 'workspace.get_snapshot', { count: 2 })))
            .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
        expect(await f.repository.get('first')).toEqual(original)
        expect(f.execute).toHaveBeenCalledTimes(2)
    })

    it('reprojects a failed result write after DB reopen without entering the handler again', async () => {
        const f = await fixture()
        const request = await f.sign('projection')
        const files = { readReady: vi.fn(async () => JSON.stringify(request)),
            publishResult: vi.fn(async () => { throw new Error('simulated result disk failure') }), publishRejection: vi.fn() }
        await expect(processAgentInboxFile('projection.ready.json', files, f.dispatcher())).rejects.toThrow(/disk failure/)
        const original = await f.repository.get('projection')
        expect(original?.state).toBe('completed')
        expect(files.publishRejection).not.toHaveBeenCalled()
        resetIndexedDBConnectionForRetry()
        const publishResult = vi.fn(async () => {})
        expect(await processAgentInboxFile('projection.ready.json', { ...files, publishResult },
            f.dispatcher(new IndexedDbCommandReceiptRepository()))).toBe('projected')
        expect(publishResult).toHaveBeenCalledWith('projection', original)
        expect(f.execute).toHaveBeenCalledTimes(1)
    })

    it('retains an unresolved accepted claim after finish failure and never reexecutes it after restart', async () => {
        const f = await fixture()
        const receipts: CommandReceiptRepository = { get: id => f.repository.get(id),
            claim: receipt => f.repository.claim(receipt), finish: async () => { throw new Error('finish unavailable') } }
        const request = await f.sign('unfinished')
        await expect(f.dispatcher(receipts).dispatch(request)).rejects.toThrow(/finish unavailable/)
        expect((await f.repository.get('unfinished'))?.state).toBe('accepted')
        resetIndexedDBConnectionForRetry()
        expect((await f.dispatcher(new IndexedDbCommandReceiptRepository()).dispatch(request)).state).toBe('accepted')
        expect(f.execute).toHaveBeenCalledTimes(1)
    })

    it('rejects bad authentication before ledger writes and rechecks revocation even for completed replay', async () => {
        const f = await fixture()
        const bad = await f.sign('bad')
        await expect(f.dispatcher().dispatch({ ...bad, authentication: { ...bad.authentication,
            signature: `hmac-sha256:${'0'.repeat(64)}` } })).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' })
        expect(await f.repository.get('bad')).toBeNull()
        expect(f.execute).not.toHaveBeenCalled()
        const good = await f.sign('good')
        const original = await f.dispatcher().dispatch(good)
        f.revoke()
        await expect(f.dispatcher().dispatch(good)).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' })
        expect(await f.repository.get('good')).toEqual(original)
        expect(f.execute).toHaveBeenCalledTimes(1)
    })

    it.each([{ secret: 'private' }, { message: 'E:\\private\\output.png' }, { base64: 'iVBORw0KGgo=' }])(
        'never persists or projects unsafe handler result %j', async result => {
            const f = await fixture()
            f.execute.mockResolvedValue(result)
            const receipt = await f.dispatcher().dispatch(await f.sign('unsafe'))
            expect(receipt.state).toBe('needs-input')
            expect(receipt.result).toEqual({ code: 'RESULT_NOT_PUBLIC' })
            expect(await f.repository.get('unsafe')).toEqual(receipt)
        },
    )

    it('rejects unsafe signed ingress before acceptance and projects the same registered capability facts', async () => {
        const f = await fixture()
        for (const [index, input] of [{ secret: 'private' }, { message: 'E:\\private\\output.png' }, { base64: 'iVBORw0KGgo=' }].entries()) {
            const request = await f.sign(`ingress-${index}`, 'workspace.get_snapshot', input)
            await expect(f.dispatcher().dispatch(request)).rejects.toMatchObject({ code: 'UNSAFE_PAYLOAD' })
            expect(await f.repository.get(request.requestId)).toBeNull()
        }
        expect(f.execute).not.toHaveBeenCalled()
        const dispatcher = f.dispatcher()
        const receipt = await dispatcher.dispatch(await f.sign('capabilities', 'system.describe_capabilities'))
        expect(receipt.result).toEqual({ capabilities: dispatcher.capabilities() })
    })

    it('keeps mutations unavailable across every mode/pause combination and preserves observe reads', async () => {
        const f = await fixture()
        for (const mode of ['observe', 'suggest', 'bounded-auto'] as const) {
            for (const globalPause of [false, true]) {
                f.setState({ ready: true, mode, globalPause })
                const dispatcher = f.dispatcher()
                const descriptor = dispatcher.capabilities().find(item => item.command === 'generation.enqueue')!
                expect(descriptor).toMatchObject({ available: false, requiresHumanApproval: true,
                    requiresAppProcess: true, canExecuteWhileAppClosed: false })
                expect((await dispatcher.dispatch(await f.sign(`${mode}-${globalPause}`, 'generation.enqueue'))).state).toBe('needs-input')
            }
        }
        expect(f.execute).not.toHaveBeenCalled()
        f.setState({ ready: true, mode: 'observe', globalPause: true })
        expect((await f.dispatcher().dispatch(await f.sign('plan', 'generation.plan'))).state).toBe('rejected')
        expect((await f.dispatcher().dispatch(await f.sign('read'))).state).toBe('completed')
        f.setState({ ready: false, mode: 'suggest', globalPause: false })
        await expect(f.dispatcher().dispatch(await f.sign('unavailable'))).rejects.toMatchObject({ code: 'APP_UNAVAILABLE' })
        expect(await f.repository.get('unavailable')).toBeNull()
        expect(f.execute).toHaveBeenCalledTimes(1)
    })

    it('ignores partial/path-like files and rejects ID mismatch or oversized reads before dispatch', async () => {
        const f = await fixture()
        const readReady = vi.fn(async () => JSON.stringify(await f.sign('different')))
        const files = { readReady, publishResult: vi.fn(), publishRejection: vi.fn() }
        for (const name of ['partial.tmp', '../escape.ready.json', 'CON.ready.json', 'x/y.ready.json']) {
            expect(await processAgentInboxFile(name, files, f.dispatcher())).toBe('ignored')
        }
        expect(readReady).not.toHaveBeenCalled()
        expect(await processAgentInboxFile('valid.ready.json', files, f.dispatcher())).toBe('rejected')
        expect(files.publishRejection).toHaveBeenLastCalledWith('valid', { accepted: false, code: 'REQUEST_ID_MISMATCH' })
        readReady.mockResolvedValue('x'.repeat(65_537))
        expect(await processAgentInboxFile('large.ready.json', files, f.dispatcher())).toBe('rejected')
        expect(files.publishRejection).toHaveBeenLastCalledWith('large', { accepted: false, code: 'REQUEST_TOO_LARGE' })
        expect(readReady).toHaveBeenLastCalledWith('large', 65_536)
        expect(f.execute).not.toHaveBeenCalled()
        expect(createInboxSubmissionReceipt('queued-file')).toEqual({ status: 'submitted-to-inbox', accepted: false,
            requestId: 'queued-file', requiresAppProcess: true })
    })
})

describe('command startup barrier', () => {
    function fixture() {
        const order: string[] = []
        const release = vi.fn(async () => { order.push('release') })
        return { order, release, dependencies: {
            migrate: vi.fn(async () => { order.push('migrate') }),
            recover: vi.fn(async () => { order.push('recover'); return { ready: true } }),
            hydrate: vi.fn(async () => { order.push('hydrate') }),
            acquireOwner: vi.fn(async () => { order.push('owner'); return { release } as { release(): Promise<void> } | null }),
            processReadyRequests: vi.fn(async () => { order.push('process') }),
        } }
    }
    it('awaits every barrier in order and releases its owner on stop', async () => {
        const f = fixture()
        const result = await initializeAgentCommandRuntime(f.dependencies)
        expect(f.order).toEqual(['migrate', 'recover', 'hydrate', 'owner', 'process'])
        expect(result.status).toBe('ready')
        if (result.status === 'ready') await result.stop()
        expect(f.release).toHaveBeenCalledTimes(1)
    })
    it('does not hydrate, acquire, or process while recovery remains pending', async () => {
        const f = fixture()
        let completeRecovery!: (result: { ready: boolean }) => void
        f.dependencies.recover.mockImplementation(() => new Promise(resolve => { completeRecovery = resolve }))
        const pending = initializeAgentCommandRuntime(f.dependencies)
        await vi.waitFor(() => expect(f.dependencies.recover).toHaveBeenCalledTimes(1))
        expect(f.dependencies.hydrate).not.toHaveBeenCalled()
        expect(f.dependencies.acquireOwner).not.toHaveBeenCalled()
        expect(f.dependencies.processReadyRequests).not.toHaveBeenCalled()
        completeRecovery({ ready: true })
        expect((await pending).status).toBe('ready')
    })
    it.each(['not-ready', 'rejection'])('stops before hydration and ownership when recovery returns %s', async mode => {
        const f = fixture()
        if (mode === 'not-ready') f.dependencies.recover.mockResolvedValue({ ready: false })
        else f.dependencies.recover.mockRejectedValue(new Error('recovery failed'))
        expect(await initializeAgentCommandRuntime(f.dependencies)).toEqual({ status: 'app-unavailable' })
        expect(f.dependencies.hydrate).not.toHaveBeenCalled()
        expect(f.dependencies.acquireOwner).not.toHaveBeenCalled()
        expect(f.dependencies.processReadyRequests).not.toHaveBeenCalled()
    })
    it('reports a second owner busy and releases acquired ownership after processing failure', async () => {
        const f = fixture()
        f.dependencies.acquireOwner.mockResolvedValueOnce(null)
        expect(await initializeAgentCommandRuntime(f.dependencies)).toEqual({ status: 'busy' })
        expect(f.dependencies.processReadyRequests).not.toHaveBeenCalled()
        f.dependencies.processReadyRequests.mockRejectedValueOnce(new Error('poll failed'))
        expect(await initializeAgentCommandRuntime(f.dependencies)).toEqual({ status: 'app-unavailable' })
        expect(f.release).toHaveBeenCalledTimes(1)
    })
})
