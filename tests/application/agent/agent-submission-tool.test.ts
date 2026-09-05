import { spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentRequestHash, assertAgentPublicValue, canonicalAgentSigningPayload, parseAgentCommandEnvelope } from '@/application/agent/agent-command-contract'
import { canonicalSerialize } from '@/domain/composition/canonical-serialize'

// Tests inject only a public fixed vector inside the imported Python module.
// The production CLI has no secret argument, environment switch or fake vault.
const bundledPython = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe')
const python = existsSync(bundledPython) ? bundledPython : process.platform === 'win32' ? 'python' : 'python3'
const script = path.resolve('scripts/submit-agent-command.py')
const bootstrap = `
import importlib.util, sys, json, tempfile, pathlib, copy, os, ctypes
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("submit_agent_command", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
connection = {"workspaceId": "workspace-1", "clientId": "client-1", "keyId": "key-1", "actorKind": "agent"}
command = {"name": "workspace.get_snapshot", "input": {}}
def rejected(call):
    try:
        call()
    except Exception:
        return
    raise AssertionError("Expected rejection")
`

function runPython(code: string) {
    const result = spawnSync(python, ['-B', '-X', 'utf8', '-', script], {
        input: bootstrap + code, encoding: 'utf8', timeout: 20_000,
    })
    expect(result.error).toBeUndefined()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    return result.stdout.trim()
}

describe('external Python agent command submitter', () => {
    it('matches the TypeScript request hash and HMAC including UTF-16 key order', () => {
        const envelope = parseAgentCommandEnvelope(JSON.parse(runPython(`
command["input"] = {"text": "한글 \\U0001f642", "\\ue000": False, "\\U00010000": [9007199254740991, -1, None]}
module.validate_inputs(connection, command)
envelope = module.build_envelope(connection, command, "fixed-request", 3600, bytearray(range(32)),
                                 module.datetime(2026, 9, 5, tzinfo=module.timezone.utc))
print(module.canonical(envelope))
`)))
        expect(envelope.requestHash).toBe(agentRequestHash(envelope))
        expect(envelope.authentication.signature).toBe(`hmac-sha256:${createHmac('sha256', Buffer.from(Array.from({ length: 32 }, (_, i) => i)))
            .update(canonicalAgentSigningPayload(envelope), 'utf8').digest('hex')}`)
        expect(JSON.parse(canonicalSerialize(envelope))).toEqual(envelope)
    })

    it('rejects unsafe IDs, unknown connection fields, credentials, duplicate keys and noninteger JSON', () => {
        expect(runPython(`
for identifier in ["../x", "x.ready.json", "CON", "Com0", "lpt9", "x:y", "", "x" * 101]:
    rejected(lambda: module.request_id(identifier))
for changed in [dict(connection, secret="do-not-persist"), dict(connection, extra=True),
                dict(connection, workspaceId="../workspace"), dict(connection, actorKind="user")]:
    rejected(lambda: module.validate_inputs(changed, command))
for value in [b'{"value":1.5}', b'{"value":1e2}', b'{"value":NaN}', b'{"value":9007199254740992}', b'{"x":1,"x":2}']:
    rejected(lambda: module.decode_json(value))
for value in [{"secret": "hidden"}, {"apiKey": "hidden"}, {"nested": {"accessToken": "hidden"}}, {"outputPath": "hidden"},
              {"message": "Bearer hidden"}, {"message": "C:\\\\private\\\\key"}, {"%73ecret": "hidden"}]:
    rejected(lambda: module.validate_inputs(connection, {"name": "generation.plan", "input": value}))
for seconds in [0, -1, 86401]:
    rejected(lambda: module.build_envelope(connection, command, "request-1", seconds, bytearray(32)))
print("validated")
`)).toBe('validated')
    })

    it('rejects credential text before reading the vault or persisting any submission', () => {
        const corpus = [
            'sk-proj-abcdefgh12345678', 'sk-abcdefgh12345678', 'ghp_abcdefgh12345678',
            'xoxb-abcdefgh12345678', 'AIzaabcdefgh12345678', 'AKIAABCDEFGHIJKLMNOP',
            'token=hidden', 'Authorization: hidden', 'password: hidden', 'Cookie=hidden',
            'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
            'Basic dXNlcjpwYXNz', 'Digest username="user", nonce="hidden"',
            'https://user:password@example.test/object', 'https://example.test/?security=hidden',
            'https://example.test/?Key-Pair-Id=hidden',
            '%2573k-proj-abcdefgh12345678', 'safe text %2574oken%253Dhidden',
        ]
        for (const value of corpus) expect(() => assertAgentPublicValue({ note: value })).toThrow()
        expect(runPython(`
corpus = json.loads(${JSON.stringify(JSON.stringify(corpus))})
with tempfile.TemporaryDirectory() as folder:
    inbox = pathlib.Path(folder)
    with patch.object(module, "_read_credential") as vault:
        for value in corpus:
            unsafe_command = {"name": "generation.plan", "input": {"note": value}}
            try:
                module.submit(connection, unsafe_command, inbox, "credential-request")
            except module.SubmissionError as error:
                assert str(error) == "UNSAFE_PAYLOAD"
            else:
                raise AssertionError("Credential text reached submission")
        vault.assert_not_called()
        assert list(inbox.iterdir()) == []
print("credentials-blocked-before-vault-and-disk")
`)).toBe('credentials-blocked-before-vault-and-disk')
    })

    it.skipIf(process.platform !== 'win32')('publishes while app is off, replays exact archived bytes and never replaces a conflict', () => {
        expect(runPython(`
with tempfile.TemporaryDirectory() as folder:
    inbox = pathlib.Path(folder)
    secret_copies = []
    def credential(_connection):
        secret = bytearray(range(32))
        secret_copies.append(secret)
        return secret
    with patch.object(module, "_read_credential", credential):
        receipt = module.submit(connection, command, inbox, "request-1")
        assert receipt == {"status": "submitted-to-inbox", "accepted": False,
                           "requestId": "request-1", "requiresAppProcess": True}
        ready = inbox / "request-1.ready.json"
        archive = inbox / "request-1.submitted.json"
        original = ready.read_bytes()
        assert original == archive.read_bytes()
        assert not (inbox / "request-1.tmp").exists()
        assert module.submit(connection, command, inbox, "request-1", 100) == receipt
        assert ready.read_bytes() == original
        ready.unlink()  # Model app retirement; replay must retain original timestamps and identity.
        module.submit(connection, command, inbox, "request-1", 100)
        assert ready.read_bytes() == original
        changed = {"name": "generation.enqueue", "input": {"planId": "other-plan"}}
        rejected(lambda: module.submit(connection, changed, inbox, "request-1"))
        assert ready.read_bytes() == original and archive.read_bytes() == original
        ready.write_bytes(b"conflicting-final")
        rejected(lambda: module.submit(connection, command, inbox, "request-1"))
        assert ready.read_bytes() == b"conflicting-final"
        assert archive.read_bytes() == original
        (inbox / "interrupted.tmp").write_bytes(b"unfinished")
        rejected(lambda: module.submit(connection, command, inbox, "interrupted"))
        assert (inbox / "interrupted.tmp").read_bytes() == b"unfinished"
        assert not (inbox / "interrupted.ready.json").exists()
        with patch.object(module, "_read_credential", lambda _: bytearray([99] * 32)):
            rejected(lambda: module.submit(connection, command, inbox, "request-1"))
        assert not any(any(secret) for secret in secret_copies)
        rejected(lambda: module.submit(connection, command, inbox / "missing", "request-2"))
        assert not (inbox / "missing").exists()
print("transport-verified")
`)).toBe('transport-verified')
    })

    it.skipIf(process.platform !== 'win32')('uses CredReadW native keyring target and scrubs both vault and local buffers', () => {
        expect(runPython(`
class Function:
    def __init__(self, callback): self.callback = callback
    def __call__(self, *args): return self.callback(*args)
blob = (ctypes.c_ubyte * 32)(*range(32))
calls = []
allocations = []
def read(target, kind, flags, out):
    calls.append((target, kind, flags))
    value = out._obj._type_()
    value.CredentialBlobSize = 32
    value.CredentialBlob = ctypes.cast(blob, ctypes.POINTER(ctypes.c_ubyte))
    allocations.append(value)
    out._obj.contents = value
    return 1
def free(pointer):
    assert list(blob) == [0] * 32
    calls.append("freed")
class Vault:
    CredReadW = Function(read)
    CredFree = Function(free)
with patch.object(ctypes, "WinDLL", lambda *args, **kwargs: Vault()):
    secret = module._read_credential(connection)
assert secret == bytearray(range(32))
assert calls == [("workspace-1:client-1:key-1.blue.bluehair.naiblue.agent-commands", 1, 0), "freed"]
secret[:] = b"\\0" * 32
print("vault-boundary-verified")
`)).toBe('vault-boundary-verified')
    })

    it.skipIf(process.platform !== 'win32')('rejects hard links, reparse paths, oversized input and archive tampering', () => {
        expect(runPython(`
with tempfile.TemporaryDirectory() as folder:
    inbox = pathlib.Path(folder)
    original = inbox / "original.json"
    original.write_text("{}")
    linked = inbox / "linked.json"
    os.link(original, linked)
    rejected(lambda: module.read_bytes(linked))
    oversized = inbox / "large.json"
    oversized.write_bytes(b" " * (module.MAX_BYTES + 1))
    rejected(lambda: module.read_bytes(oversized))
    real_lstat = pathlib.Path.lstat
    class Reparse:
        st_mode = 0o040755
        st_file_attributes = 0x400
    with patch.object(pathlib.Path, "lstat", lambda path: Reparse() if path == inbox else real_lstat(path)):
        rejected(lambda: module.safe_path(inbox, directory=True))
    with patch.object(module, "_read_credential", lambda _: bytearray(range(32))):
        module.submit(connection, command, inbox, "tampered")
        ready = inbox / "tampered.ready.json"
        ready.unlink()
        archive = inbox / "tampered.submitted.json"
        envelope = json.loads(archive.read_text())
        envelope["submittedAt"] = "2026-09-05T00:00:00.000Z"
        archive.write_text(json.dumps(envelope))
        rejected(lambda: module.submit(connection, command, inbox, "tampered"))
        assert not ready.exists()
print("file-boundary-verified")
`)).toBe('file-boundary-verified')
    })

    it('keeps CLI failures bounded without exposing rejected arguments or filesystem paths', () => {
        const result = spawnSync(python, ['-B', script, '--secret', 'never-echo-this'], { encoding: 'utf8', timeout: 20_000 })
        expect(result.status).toBe(1)
        expect(result.stdout).toBe('')
        expect(JSON.parse(result.stderr)).toEqual({ status: 'not-submitted', accepted: false, code: 'INVALID_ARGUMENTS' })
        expect(result.stderr).not.toContain('never-echo-this')
        expect(result.stderr).not.toContain(script)
    })
})
