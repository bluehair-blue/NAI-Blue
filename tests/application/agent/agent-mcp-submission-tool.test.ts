import { spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentRequestHash, canonicalAgentSigningPayload, parseAgentCommandEnvelope } from '@/application/agent/agent-command-contract'
import { canonicalSerialize } from '@/domain/composition/canonical-serialize'
import type { JsonObject } from '@/domain/composition/types'

// Only imported test modules replace the vault with a public fixed vector. The
// production CLI provides no secret argument, environment switch, or fixture mode.
const bundledPython = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe')
const python = existsSync(bundledPython) ? bundledPython : process.platform === 'win32' ? 'python' : 'python3'
const script = path.resolve('scripts/submit-agent-mcp-command.py')
const connection = { workspaceId: 'workspace-1', clientId: 'client-1', keyId: 'key-1', actorKind: 'agent' }

function payload(input: JsonObject = { budget: 1.5, tiny: 1e-7, larger: 1e21, text: '한글 🙂' }) {
    const unsigned = { schemaVersion: 1 as const, requestId: 'decimal-request', submittedAt: '2026-09-06T00:00:00.000Z',
        expiresAt: '2026-09-06T01:00:00.000Z', context: { apiVersion: 'nai-blue.agent/v1alpha1' as const,
            workspaceId: connection.workspaceId, clientId: connection.clientId, actor: { kind: 'agent' as const },
            idempotencyKey: 'decimal-operation' }, command: { name: 'generation.plan' as const, input } }
    const envelope = parseAgentCommandEnvelope({ ...unsigned, requestHash: agentRequestHash(unsigned),
        authentication: { scheme: 'hmac-sha256', keyId: connection.keyId, signature: `hmac-sha256:${'0'.repeat(64)}` } })
    return { connection, unsignedPayload: canonicalSerialize(unsigned), signingPayload: canonicalAgentSigningPayload(envelope) }
}

function runPython(code: string, submitted = payload()) {
    const bootstrap = `
import importlib.util, json, sys, tempfile, pathlib, copy, os
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("mcp_submit", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
payload = json.loads(${JSON.stringify(JSON.stringify(submitted))})
def rejected(call):
    try:
        call()
    except Exception:
        return
    raise AssertionError("Expected rejection")
`
    const result = spawnSync(python, ['-B', '-X', 'utf8', '-', script], {
        input: bootstrap + code, encoding: 'utf8', timeout: 20_000,
    })
    expect(result.error).toBeUndefined()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    return result.stdout.trim()
}

describe('Phase 10 TS-canonical Python signing bridge (fixture credentials, no app)', () => {
    it.skipIf(process.platform !== 'win32')('signs exact TypeScript bytes and roundtrips finite decimal/exponent values through native publication', () => {
        const result = JSON.parse(runPython(`
with tempfile.TemporaryDirectory() as directory:
    inbox = pathlib.Path(directory) / "inbox"
    inbox.mkdir()
    key = bytearray(range(32))
    with patch.object(module.base, "_read_credential", return_value=key):
        receipt = module.submit(payload, inbox, "decimal-request")
    assert key == bytearray(32)
    archive = (inbox / "decimal-request.submitted.json").read_bytes()
    assert archive == (inbox / "decimal-request.ready.json").read_bytes()
    print(json.dumps({"receipt": receipt, "envelope": json.loads(archive)}))
`))
        const envelope = parseAgentCommandEnvelope(result.envelope)
        expect(envelope.requestHash).toBe(agentRequestHash(envelope))
        expect(envelope.authentication.signature).toBe(`hmac-sha256:${createHmac('sha256', Buffer.from(Array.from({ length: 32 }, (_, i) => i)))
            .update(canonicalAgentSigningPayload(envelope), 'utf8').digest('hex')}`)
        expect(envelope.command.input).toEqual({ budget: 1.5, tiny: 1e-7, larger: 1e21, text: '한글 🙂' })
        expect(result.receipt).toEqual({ status: 'submitted-to-inbox', accepted: false,
            requestId: 'decimal-request', requiresAppProcess: true })
    })

    it('rejects hash, identity, scheme, boolean/number swaps, duplicates, nonfinite values and unsafe text before vault access', () => {
        expect(runPython(`
def altered(which, field, value):
    changed = copy.deepcopy(payload)
    parsed = json.loads(changed[which])
    parsed[field] = value
    changed[which] = json.dumps(parsed)
    return changed
with tempfile.TemporaryDirectory() as directory:
    inbox = pathlib.Path(directory) / "inbox"
    inbox.mkdir()
    with patch.object(module.base, "_read_credential") as vault:
        cases = [
            altered("signingPayload", "requestHash", "sha256:" + "0" * 64),
            altered("signingPayload", "requestId", "another-request"),
            altered("signingPayload", "schemaVersion", True),
            altered("signingPayload", "authentication", {"scheme": "hmac-sha256", "keyId": "other-key"}),
            altered("signingPayload", "authentication", {"scheme": "other", "keyId": "key-1"}),
            dict(payload, connection=dict(payload["connection"], clientId="another-client")),
            dict(payload, unsignedPayload='{"schemaVersion":1,"schemaVersion":1}'),
        ]
        for changed in cases:
            rejected(lambda: module.submit(changed, inbox, "decimal-request"))
        for raw in [b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":Infinity}']:
            rejected(lambda: module.decode_json(raw))
        for number in [float("inf"), float("nan")]:
            rejected(lambda: module.public_shape({"number": number}))
        for value in [{"secret": "hidden"}, {"note": "Bearer abcdefgh1234"}, {"note": "C:\\\\private\\\\key"}]:
            unsafe = altered("unsignedPayload", "command", {"name": "generation.plan", "input": value})
            rejected(lambda: module.submit(unsafe, inbox, "decimal-request"))
        vault.assert_not_called()
        assert list(inbox.iterdir()) == []
print("rejected")
`)).toBe('rejected')
    })

    it.skipIf(process.platform !== 'win32')('replays exact archived bytes, preserves request collisions and fails closed on stale temporary files', () => {
        expect(runPython(`
with tempfile.TemporaryDirectory() as directory:
    inbox = pathlib.Path(directory) / "inbox"
    inbox.mkdir()
    archive = inbox / "decimal-request.submitted.json"
    ready = inbox / "decimal-request.ready.json"
    temporary = inbox / "decimal-request.tmp"
    with patch.object(module.base, "_read_credential", side_effect=lambda _connection: bytearray(range(32))):
        module.submit(payload, inbox, "decimal-request")
        original = archive.read_bytes()
        ready.unlink()
        module.submit(payload, inbox, "decimal-request")
        assert archive.read_bytes() == ready.read_bytes() == original
        archive.write_bytes(original.replace(b'1.5', b'1.6'))
        rejected(lambda: module.submit(payload, inbox, "decimal-request"))
        assert archive.read_bytes() != original and ready.read_bytes() == original
        archive.write_bytes(original)
        temporary.write_bytes(b"retained-interrupted-publication")
        rejected(lambda: module.submit(payload, inbox, "decimal-request"))
        assert temporary.read_bytes() == b"retained-interrupted-publication"
        assert archive.read_bytes() == ready.read_bytes() == original
print("preserved")
`)).toBe('preserved')
    })

    it.skipIf(process.platform !== 'win32')('rechecks current credentials on replay and does not publish with a missing or rotated key', () => {
        expect(runPython(`
with tempfile.TemporaryDirectory() as directory:
    inbox = pathlib.Path(directory) / "inbox"
    inbox.mkdir()
    ready = inbox / "decimal-request.ready.json"
    archive = inbox / "decimal-request.submitted.json"
    with patch.object(module.base, "_read_credential", return_value=bytearray(range(32))):
        module.submit(payload, inbox, "decimal-request")
    original = archive.read_bytes()
    ready.unlink()
    with patch.object(module.base, "_read_credential", side_effect=module.base.SubmissionError("CREDENTIAL_UNAVAILABLE")):
        rejected(lambda: module.submit(payload, inbox, "decimal-request"))
    rotated = bytearray([42] * 32)
    with patch.object(module.base, "_read_credential", return_value=rotated):
        rejected(lambda: module.submit(payload, inbox, "decimal-request"))
    assert rotated == bytearray(32)
    assert archive.read_bytes() == original and not ready.exists()
print("no-replay")
`)).toBe('no-replay')
    })

    it('keeps the original submit CLI integer-only contract', () => {
        expect(runPython(`
rejected(lambda: module.base.decode_json(b'{"budget":1.5}'))
rejected(lambda: module.base.decode_json(b'{"budget":1e-7}'))
print("legacy-unchanged")
`)).toBe('legacy-unchanged')
    })

    it('bounds stdin and returns only fixed errors without echoing malformed material or private paths', () => {
        for (const input of ['{"private":"must-not-escape","private":2}', '{"private":"must-not-escape"}', ' '.repeat(65_536 * 12 + 4097)]) {
            const result = spawnSync(python, ['-B', '-X', 'utf8', script, '--inbox-dir', 'C:\\private\\must-not-escape',
                '--request-id', 'decimal-request'], { input, encoding: 'utf8', timeout: 20_000 })
            expect(result.status).toBe(1)
            expect(result.stdout).toBe('')
            expect(result.stderr).not.toContain('must-not-escape')
            expect(JSON.parse(result.stderr)).toMatchObject({ status: 'not-submitted', accepted: false })
            expect(['INVALID_INPUT', 'INPUT_TOO_LARGE']).toContain(JSON.parse(result.stderr).code)
        }
    })
})
