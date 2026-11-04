import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRuntimeGuard } from '../../scripts/agent-runtime-guard.mjs'

function fixture() {
    const executable = { path: 'E:\\Apps\\NAI Blue\\NAI-Blue.exe', version: '1.3.6', sha256: 'a'.repeat(64) }
    const state = { registeredInstallations: [{ registeredVersion: '1.3.6', executable }],
        runningProcesses: [{ ProcessId: 10, ExecutablePath: executable.path }] }
    let fingerprint = 'original', pending = false, liveHash, target
    const calls = [], inspections = []
    const result = () => pending ? { status: 'submitted-to-inbox' } : { status: 'application-receipt',
        receipt: { state: 'completed', result: { runtimeIdentity: { version: executable.version,
            processId: state.runningProcesses[0]?.ProcessId, executableHash: liveHash ?? `sha256:${executable.sha256}` } } } }
    const guard = createRuntimeGuard({ initialFingerprint: 'original', fingerprint: async () => fingerprint,
        resolve: async () => structuredClone(state), onTarget: hash => { target = hash },
        inbox: { invoke: async (command, id) => { calls.push({ command, id }); return result() },
            inspect: async id => { inspections.push(id); return result() } } })
    return { guard, state, executable, calls, inspections, target: () => target,
        changeAdapter: () => { fingerprint = 'changed' }, pending: value => { pending = value }, liveHash: value => { liveHash = value } }
}

test('re-resolves every call and reattests same-version binary replacements and PID changes', async () => {
    const f = fixture()
    assert.equal((await f.guard.status()).status, 'ready')
    assert.equal(f.target(), `sha256:${'a'.repeat(64)}`)
    await f.guard.status()
    assert.equal(f.calls.length, 1)
    f.executable.sha256 = 'b'.repeat(64)
    assert.equal((await f.guard.status()).executableHash, `sha256:${'b'.repeat(64)}`)
    f.state.runningProcesses[0].ProcessId = 20
    assert.equal((await f.guard.status()).processId, 20)
    assert.equal(f.calls.length, 3)
})

test('follows a moved installation only when its live process follows it', async () => {
    const f = fixture()
    await f.guard.status()
    f.executable.path = 'E:\\Latest\\NAI-Blue.exe'
    assert.equal((await f.guard.status()).code, 'APP_RUNTIME_RESTART_REQUIRED')
    f.state.runningProcesses[0] = { ProcessId: 20, ExecutablePath: f.executable.path }
    assert.equal((await f.guard.status()).status, 'ready')
})

test('pending and concurrent reads reuse one probe and never enqueue user work', async () => {
    const f = fixture()
    f.pending(true)
    const results = await Promise.all([f.guard.status(), f.guard.status()])
    assert.equal(results[0].code, 'APP_STARTING')
    assert.equal(f.calls.length, 1)
    await f.guard.status()
    assert.deepEqual(f.inspections, [f.calls[0].id])
    f.pending(false)
    assert.equal((await f.guard.status()).status, 'ready')
    assert.equal(f.calls[0].command.name, 'system.describe_capabilities')
})

test('blocks an old process at the same path and version by executable hash', async () => {
    const f = fixture()
    f.liveHash(`sha256:${'b'.repeat(64)}`)
    assert.equal((await f.guard.status()).code, 'APP_RUNTIME_RESTART_REQUIRED')
})

test('adapter content changes block before probing; unknown and ambiguous installations never guess', async () => {
    const f = fixture()
    f.changeAdapter()
    assert.equal((await f.guard.status()).code, 'MCP_ADAPTER_RECONNECT_REQUIRED')
    assert.equal(f.calls.length, 0)
    const missing = fixture()
    missing.state.registeredInstallations = []
    assert.equal((await missing.guard.status()).code, 'APP_INSTALLATION_NOT_FOUND')
    const ambiguous = fixture()
    ambiguous.state.registeredInstallations.push({ registeredVersion: '1.3.6', executable: { ...ambiguous.executable, path: 'C:\\Old\\NAI-Blue.exe' } })
    assert.equal((await ambiguous.guard.status()).code, 'APP_INSTALLATION_AMBIGUOUS')
    assert.equal(ambiguous.calls.length, 0)
})

test('inspection failure is public and bounded, with no guessed ready state', async () => {
    const guard = createRuntimeGuard({ initialFingerprint: 'a', fingerprint: async () => 'a',
        resolve: async () => { throw new Error('private path') }, inbox: {} })
    assert.deepEqual(await guard.status(), { status: 'unavailable', code: 'APP_RUNTIME_CHECK_FAILED' })
})
