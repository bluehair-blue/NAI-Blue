import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const digestPattern = /^sha256:[a-f0-9]{64}$/
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string'
    && path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase()
const version = value => typeof value === 'string' ? value.replace(/^(\d+\.\d+\.\d+)\.0$/, '$1') : ''

/** Content fingerprint of adapter dependencies, not Git HEAD (which misses local edits). */
export async function adapterFingerprint(repo) {
    const files = ['package.json', 'package-lock.json']
    async function collect(relative) {
        for (const entry of await readdir(path.join(repo, relative), { withFileTypes: true })) {
            if (entry.isSymbolicLink()) throw new Error('Adapter dependency symlink is unsupported')
            const name = path.join(relative, entry.name)
            if (entry.isDirectory()) await collect(name)
            else if (/\.(?:tsx?|json|mjs|py|ps1)$/.test(name)) files.push(name)
        }
    }
    await collect('src')
    await collect('scripts')
    const hash = createHash('sha256')
    for (const file of files.sort()) hash.update(file).update('\0').update(await readFile(path.join(repo, file))).update('\0')
    return `sha256:${hash.digest('hex')}`
}

/** Registry is the only executable locator; PowerShell serializes normal launch across hosts. */
export async function resolveInstalledRuntime(repo) {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
    const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-File',
        path.join(repo, 'scripts/inspect-agent-runtime.ps1'), '-EnsureRunning'],
    { windowsHide: true, timeout: 30_000, maxBuffer: 131_072, encoding: 'utf8' })
    return JSON.parse(stdout.replace(/^\uFEFF/, ''))
}

/**
 * Re-resolve every call, cache only an attestation for the exact live PID/hash.
 * Probe retries inspect the same receipt. No process termination, new identity,
 * generation retry, installer download, or mutation is performed by this guard.
 */
export function createRuntimeGuard({ inbox, resolve, fingerprint, initialFingerprint, onTarget = () => {} }) {
    let key, probeId, attested = false, flight
    const blocked = (code, extra = {}) => ({ status: 'unavailable', code, ...extra })
    async function inspect() {
        if (await fingerprint() !== initialFingerprint) return blocked('MCP_ADAPTER_RECONNECT_REQUIRED')
        const state = await resolve()
        const registrations = state.registeredInstallations
        if (!Array.isArray(registrations) || registrations.length === 0) return blocked('APP_INSTALLATION_NOT_FOUND')
        if (registrations.some(item => !item.executable)) return blocked('APP_INSTALLATION_INVALID')
        const installed = registrations[0].executable
        if (registrations.some(item => !samePath(item.executable.path, installed.path))) return blocked('APP_INSTALLATION_AMBIGUOUS')
        if (!/^[a-f0-9]{64}$/.test(installed.sha256) || !version(installed.version)
            || registrations.some(item => version(item.registeredVersion) !== version(installed.version))) {
            return blocked('APP_INSTALLATION_INVALID')
        }
        const running = state.runningProcesses
        if (!Array.isArray(running) || running.length === 0) return blocked('APP_STARTING')
        if (running.length !== 1 || !samePath(running[0].ExecutablePath, installed.path)
            || !Number.isSafeInteger(running[0].ProcessId)) return blocked('APP_RUNTIME_RESTART_REQUIRED')
        const expected = { version: version(installed.version), processId: running[0].ProcessId,
            executableHash: `sha256:${installed.sha256}` }
        const nextKey = JSON.stringify(expected)
        if (key !== nextKey) { key = nextKey; probeId = undefined; attested = false }
        onTarget(expected.executableHash)
        if (!attested) {
            // A probe is bound to the selected binary too. Legacy apps reject
            // that new optional signed field rather than executing new work.
            let result
            if (!probeId) {
                probeId = `mcp-runtime-${randomUUID()}`
                result = await inbox.invoke({ name: 'system.describe_capabilities', input: {} }, probeId)
            } else result = await inbox.inspect(probeId)
            if (result.status === 'inbox-rejection' || result.receipt?.state === 'rejected') {
                return blocked('APP_RUNTIME_UPGRADE_REQUIRED', { requestResource: `nai-blue://requests/${probeId}` })
            }
            if (result.status !== 'application-receipt' || result.receipt?.state !== 'completed') {
                return blocked('APP_STARTING', { requestResource: `nai-blue://requests/${probeId}` })
            }
            const actual = result.receipt.result?.runtimeIdentity
            if (!actual || !digestPattern.test(actual.executableHash)
                || version(actual.version) !== expected.version || actual.processId !== expected.processId
                || actual.executableHash !== expected.executableHash) {
                return blocked('APP_RUNTIME_RESTART_REQUIRED', { requestResource: `nai-blue://requests/${probeId}` })
            }
            attested = true
        }
        return { status: 'ready', ...expected }
    }
    return {
        status() {
            // Coalesce simultaneous discovery/tool calls without a stale TTL.
            if (!flight) flight = inspect().catch(() => blocked('APP_RUNTIME_CHECK_FAILED')).finally(() => { flight = undefined })
            return flight
        },
    }
}
