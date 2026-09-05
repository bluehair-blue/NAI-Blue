#!/usr/bin/env python3
"""Submit a command after a human registers the client in NAI Blue on Windows.

Only Python's standard library is required. Connection JSON contains exactly
workspaceId, clientId, keyId, actorKind; command JSON contains name and input.
Numbers must be safe integers (no decimal/exponent notation). The native app
owns inbox creation/ACLs; this tool neither starts it nor waits for acceptance.

A .submitted.json archive retains the original signed public envelope, never
the credential. Reusing --request-id replays those exact bytes, including the
original expiry, after verifying the connection, command and current key.
Do not delete archives to retry a generation. An interrupted .tmp publication
fails closed and requires inspecting that request before removing the stale tmp.
"""

import argparse
import base64
import ctypes
from ctypes import wintypes
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid
from urllib.parse import parse_qsl, unquote, urlsplit


SERVICE = "blue.bluehair.naiblue.agent-commands"
MAX_BYTES = 65_536
COMMAND_NAMES = frozenset((
    "system.describe_capabilities", "workspace.get_snapshot", "generation.plan",
    "generation.enqueue", "generation.get_run", "generation.cancel",
    "generation.retry_storage", "scene.retry_link", "output.abandon_reservation",
    "scene.resolve_many", "scene.patch_many", "folder.plan_changes", "r2.get_readiness",
))
FORBIDDEN_KEYS = re.compile(
    r"token|secret|password|credential|authorization|cookie|session|apikey|accesskey|privatekey|"
    r"signedurl|base64|thumbnail|absolutepath|displaypath|nativepath|resolvedpath|"
    r"localpath|sourcepath|outputpath|savepath|homedir|journal|rawlog|controller|"
    r"^(?:auth|bearer|sig|signature|hmac|image|images|thumb|preview|pixel|blob|binary|"
    r"bytes|rawbinary|rgba|rgb|filedata|dataurl|lease)(?:data|payload|content|buffer|bytes)?$"
)
# Keep credential text rules aligned with domain/sync/payload-safety.ts: a safe
# property name must not let credentials reach the durable submission archive.
CREDENTIAL_TEXT = re.compile(
    r"-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----|"
    r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|"
    r"\b(?=[a-z0-9+/=]{40}\b)(?=[a-z0-9+/=]*[+/])[a-z0-9+/=]{40}\b|"
    r"\b(?:sk-(?:proj-)?|gh[pousr]_|xox[baprs]-|AIza)[a-z0-9_+/=-]{8,}|"
    r"(?:^|[^a-z0-9_-])eyJ[a-z0-9_-]{2,}\.[a-z0-9_-]{2,}\.[a-z0-9_-]*(?:$|[^a-z0-9_-])|"
    r"\bbearer\s+[a-z0-9._~+/\-]{8,}|"
    r"\bdigest\s+(?=[^\r\n]{0,512}\b(?:username|realm|nonce|uri|response)\s*=)|"
    r"\b(?:authorization|proxy-authorization|(?:set-)?cookie|session|api[_-]?key|"
    r"access[_-]?token|refresh[_-]?token|token|secret|password|sig|signature|hmac|policy)\s*[:=]",
    re.I | re.ASCII,
)


class SubmissionError(Exception):
    """Only fixed error codes cross the CLI boundary; never echo input or OS errors."""


def require(condition, code="INVALID_INPUT"):
    if not condition:
        raise SubmissionError(code)


def request_id(value):
    require(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,100}", value)
            and not re.fullmatch(r"con|prn|aux|nul|com[0-9]|lpt[0-9]", value, re.I))
    return value


def canonical(value):
    """Match composition-canonical-json-v1 key ordering and UTF-8, within integer inputs."""
    if isinstance(value, dict):
        return "{" + ",".join(canonical(key) + ":" + canonical(value[key]) for key in
                              sorted(value, key=lambda key: key.encode("utf-16-be"))) + "}"
    if isinstance(value, list):
        return "[" + ",".join(canonical(item) for item in value) + "]"
    require(value is None or isinstance(value, (str, bool))
            or (type(value) is int and abs(value) <= 9_007_199_254_740_991))
    # Reject lone surrogates instead of relying on Python/JS replacement behavior.
    if isinstance(value, str):
        value.encode("utf-8")
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def decoded_material(value):
    for _ in range(8):
        decoded = unquote(value, errors="strict")
        if decoded == value:
            return decoded
        value = decoded
    require(not re.search(r"%[a-f0-9]{2}", value, re.I), "UNSAFE_PAYLOAD")
    return value


def credential_text(value):
    if CREDENTIAL_TEXT.search(value):
        return True
    for match in re.finditer(r"\bbasic\s+([a-z0-9+/]{8,}={0,2})(?:$|[^a-z0-9+/=])", value, re.I):
        encoded = match[1]
        try:
            if b":" in base64.b64decode(encoded + "=" * (-len(encoded) % 4)):
                return True
        except ValueError:
            return True
    # URL user-info and credential query names are secrets even without a known prefix.
    for match in re.finditer(r'https?://[^\s\x22\x27<>]+', value, re.I):
        url = urlsplit(match[0])
        if url.username or url.password:
            return True
        for key, _ in parse_qsl(url.query, keep_blank_values=True):
            normalized = re.sub(r"[^a-z0-9]", "", decoded_material(key).lower())
            if re.search(r"^(?:auth|sig|signature|hmac|policy)$|token|signature|credential|security|"
                         r"session|cookie|authorization|accesskeyid|keypairid|policy", normalized):
                return True
    return False


def public_value(value, depth=0):
    """Conservative preflight; the app's shared scanner remains acceptance authority."""
    require(depth <= 64, "UNSAFE_PAYLOAD")
    if isinstance(value, dict):
        for key, child in value.items():
            decoded = decoded_material(key)
            require(not FORBIDDEN_KEYS.search(re.sub(r"[^a-z0-9]", "", decoded.lower())),
                    "UNSAFE_PAYLOAD")
            public_value(key, depth + 1)
            public_value(child, depth + 1)
    elif isinstance(value, list):
        for child in value:
            public_value(child, depth + 1)
    elif isinstance(value, str):
        decoded = decoded_material(value)
        require(not credential_text(decoded), "UNSAFE_PAYLOAD")
        require(not re.search(r"(?:[A-Za-z]:[\\/]|\\\\|(?:^|\s)/(?:home|Users|tmp|var|etc)/|"
                              r"\bBearer\s|data:|-----BEGIN|[?&](?:X-Amz-|signature=|token=))",
                              decoded, re.I), "UNSAFE_PAYLOAD")
    canonical(value)


def safe_path(path, directory=False):
    """Inspect every ancestor without resolving away Windows junctions or symlinks."""
    path = Path(os.path.abspath(path))
    for candidate in reversed((path, *path.parents)):
        info = candidate.lstat()
        require(not stat.S_ISLNK(info.st_mode)
                and not (getattr(info, "st_file_attributes", 0) & 0x400), "UNSAFE_PATH")
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode), "UNSAFE_PATH")
    if not directory:
        require(info.st_nlink == 1, "UNSAFE_PATH")
    return path


def read_bytes(path):
    path = safe_path(path)
    with path.open("rb") as handle:
        info = os.fstat(handle.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                and not (getattr(info, "st_file_attributes", 0) & 0x400), "UNSAFE_PATH")
        raw = handle.read(MAX_BYTES + 1)
    require(len(raw) <= MAX_BYTES, "INPUT_TOO_LARGE")
    return raw


def decode_json(raw):
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result)
            result[key] = value
        return result

    def reject_number(_value):
        raise SubmissionError("SAFE_INTEGERS_REQUIRED")

    value = json.loads(raw.decode("utf-8-sig"), object_pairs_hook=unique_object,
                       parse_float=reject_number, parse_constant=reject_number)
    canonical(value)
    return value


def validate_inputs(connection, command):
    require(isinstance(connection, dict)
            and set(connection) == {"workspaceId", "clientId", "keyId", "actorKind"})
    for field in ("workspaceId", "clientId", "keyId"):
        require(isinstance(connection[field], str)
                and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}", connection[field]))
    require(connection["actorKind"] in ("agent", "service"))
    require(isinstance(command, dict) and set(command) == {"name", "input"}
            and isinstance(command["name"], str) and command["name"] in COMMAND_NAMES
            and isinstance(command["input"], dict))
    public_value(connection)
    public_value(command["input"])


def _read_credential(connection):
    """Read the native keyring generic credential in-process; no helper or export."""
    require(os.name == "nt", "WINDOWS_REQUIRED")

    class Credential(ctypes.Structure):
        _fields_ = [("Flags", wintypes.DWORD), ("Type", wintypes.DWORD),
                    ("TargetName", wintypes.LPWSTR), ("Comment", wintypes.LPWSTR),
                    ("LastWritten", wintypes.FILETIME), ("CredentialBlobSize", wintypes.DWORD),
                    ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
                    ("Persist", wintypes.DWORD), ("AttributeCount", wintypes.DWORD),
                    ("Attributes", ctypes.c_void_p), ("TargetAlias", wintypes.LPWSTR),
                    ("UserName", wintypes.LPWSTR)]

    advapi = ctypes.WinDLL("Advapi32.dll", use_last_error=True)
    advapi.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                ctypes.POINTER(ctypes.POINTER(Credential))]
    advapi.CredReadW.restype = wintypes.BOOL
    advapi.CredFree.argtypes = [ctypes.c_void_p]
    advapi.CredFree.restype = None
    pointer = ctypes.POINTER(Credential)()
    account = ":".join(connection[field] for field in ("workspaceId", "clientId", "keyId"))
    require(advapi.CredReadW(account + "." + SERVICE, 1, 0, ctypes.byref(pointer)),
            "CREDENTIAL_UNAVAILABLE")
    try:
        require(pointer.contents.CredentialBlobSize == 32, "CREDENTIAL_UNAVAILABLE")
        secret = bytearray(32)
        ctypes.memmove((ctypes.c_ubyte * 32).from_buffer(secret), pointer.contents.CredentialBlob, 32)
        return secret
    finally:
        # Scrub the API allocation before release; submit() also clears our mutable copy.
        # Python's HMAC implementation may retain transient internal copies until freed.
        ctypes.memset(pointer.contents.CredentialBlob, 0, pointer.contents.CredentialBlobSize)
        advapi.CredFree(pointer)


def signing_payload(envelope):
    authentication = {key: value for key, value in envelope["authentication"].items() if key != "signature"}
    return canonical({**envelope, "authentication": authentication}).encode("utf-8")


def build_envelope(connection, command, identifier, expires_in, secret, now=None):
    require(type(expires_in) is int and 1 <= expires_in <= 86_400)
    now = now or datetime.now(timezone.utc)
    timestamp = lambda date: date.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    envelope = {"schemaVersion": 1, "requestId": request_id(identifier),
                "submittedAt": timestamp(now), "expiresAt": timestamp(now + timedelta(seconds=expires_in)),
                "context": {"apiVersion": "nai-blue.agent/v1alpha1", "workspaceId": connection["workspaceId"],
                            "clientId": connection["clientId"], "actor": {"kind": connection["actorKind"]},
                            "idempotencyKey": identifier}, "command": command}
    envelope["requestHash"] = "sha256:" + hashlib.sha256(canonical(envelope).encode("utf-8")).hexdigest()
    envelope["authentication"] = {"scheme": "hmac-sha256", "keyId": connection["keyId"]}
    envelope["authentication"]["signature"] = "hmac-sha256:" + hmac.new(secret, signing_payload(envelope), "sha256").hexdigest()
    return envelope


def verify_archive(raw, connection, command, identifier, secret):
    envelope = decode_json(raw)
    expected_context = {"apiVersion": "nai-blue.agent/v1alpha1", "workspaceId": connection["workspaceId"],
                        "clientId": connection["clientId"], "actor": {"kind": connection["actorKind"]},
                        "idempotencyKey": identifier}
    require(envelope["schemaVersion"] == 1 and envelope["requestId"] == identifier
            and envelope["context"] == expected_context and envelope["command"] == command
            and envelope["authentication"]["keyId"] == connection["keyId"]
            and envelope["authentication"]["scheme"] == "hmac-sha256", "REQUEST_ID_CONFLICT")
    unsigned = {key: value for key, value in envelope.items() if key not in ("requestHash", "authentication")}
    require(envelope["requestHash"] == "sha256:" + hashlib.sha256(canonical(unsigned).encode("utf-8")).hexdigest(),
            "REQUEST_ID_CONFLICT")
    signature = "hmac-sha256:" + hmac.new(secret, signing_payload(envelope), "sha256").hexdigest()
    require(hmac.compare_digest(envelope["authentication"]["signature"], signature), "REQUEST_ID_CONFLICT")


def publish(raw, destination, temporary):
    """Windows rename fails when destination exists, preserving native no-replace semantics."""
    require(os.name == "nt", "WINDOWS_REQUIRED")
    safe_path(destination.parent, directory=True)
    created = False
    try:
        with temporary.open("xb") as handle:
            created = True
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        safe_path(temporary)
        os.rename(temporary, destination)
        created = False
    finally:
        if created:
            safe_path(temporary)
            temporary.unlink()


def submit(connection, command, inbox, identifier, expires_in=3600):
    validate_inputs(connection, command)
    request_id(identifier)
    require(type(expires_in) is int and 1 <= expires_in <= 86_400)
    inbox = safe_path(inbox, directory=True)
    ready = inbox / (identifier + ".ready.json")
    archive = inbox / (identifier + ".submitted.json")
    temporary = inbox / (identifier + ".tmp")
    secret = _read_credential(connection)
    try:
        if os.path.lexists(archive):
            raw = read_bytes(archive)
            verify_archive(raw, connection, command, identifier, secret)
        elif os.path.lexists(ready):
            raw = read_bytes(ready)
            verify_archive(raw, connection, command, identifier, secret)
            publish(raw, archive, temporary)
        else:
            raw = canonical(build_envelope(connection, command, identifier, expires_in, secret)).encode("utf-8")
            require(len(raw) <= MAX_BYTES, "INPUT_TOO_LARGE")
            publish(raw, archive, temporary)
        if os.path.lexists(ready):
            require(read_bytes(ready) == raw, "REQUEST_ID_CONFLICT")
        else:
            publish(raw, ready, temporary)
    finally:
        secret[:] = b"\0" * len(secret)
    return {"status": "submitted-to-inbox", "accepted": False,
            "requestId": identifier, "requiresAppProcess": True}


class PublicParser(argparse.ArgumentParser):
    def error(self, message):
        raise SubmissionError("INVALID_ARGUMENTS")


def main(argv=None):
    parser = PublicParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--connection", required=True, type=Path)
    parser.add_argument("--command", required=True, type=Path)
    parser.add_argument("--request-id", help="Stable safe ID; an existing submission replays its original envelope")
    parser.add_argument("--expires-in", default=3600, type=int, help="Expiry in seconds, 1..86400 (default 3600)")
    parser.add_argument("--inbox-dir", type=Path, help="Existing native app inbox; never created by this tool")
    try:
        args = parser.parse_args(argv)
        inbox = args.inbox_dir
        if inbox is None:
            require(bool(os.environ.get("APPDATA")), "INBOX_UNAVAILABLE")
            inbox = Path(os.environ["APPDATA"]) / "blue.bluehair.naiblue" / "agent-commands" / "inbox"
        receipt = submit(decode_json(read_bytes(args.connection)), decode_json(read_bytes(args.command)),
                         inbox, args.request_id or str(uuid.uuid4()), args.expires_in)
        print(json.dumps(receipt, separators=(",", ":")))
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, SubmissionError) else "SUBMISSION_FAILED"
        print(json.dumps({"status": "not-submitted", "accepted": False, "code": code}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
