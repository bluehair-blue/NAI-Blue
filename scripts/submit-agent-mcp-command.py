#!/usr/bin/env python3
"""Sign TS-canonical Phase 10 requests with the existing Windows credential authority.

stdin: {connection, unsignedPayload: string, signingPayload: string}; argv carries
only the existing inbox directory and request ID. TypeScript owns canonical number
formatting and acceptance validation. Python signs the supplied exact UTF-8 bytes,
checks their structural binding, and reuses the production no-replace publisher.
There is no credential argument, test mode, app launch, or client registration.
"""

import hashlib
import hmac
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import sys
from datetime import datetime


_spec = importlib.util.spec_from_file_location(
    "nai_agent_submit", Path(__file__).with_name("submit-agent-command.py"))
base = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(base)
require = base.require
MAX_STDIN_BYTES = base.MAX_BYTES * 12 + 4096  # Two JSON strings may escape every UTF-8 byte.


def decode_json(raw):
    """Duplicate-free finite JSON; unlike the legacy CLI, permit IEEE-754 decimals."""
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result)
            result[key] = value
        return result

    def reject_constant(_value):
        raise base.SubmissionError("INVALID_INPUT")

    return json.loads(raw.decode("utf-8"), object_pairs_hook=unique,
                      parse_constant=reject_constant)


def public_shape(value, depth=0):
    """Reuse the existing text/key scanner without its integer-only serializer.

    Numeric placeholders exist only in the scanner input; hash/signature and saved
    envelopes always retain the caller's numbers. This is not a second text policy.
    """
    require(depth <= 64, "UNSAFE_PAYLOAD")
    if type(value) in (int, float):
        require(math.isfinite(value), "INVALID_INPUT")
        return 0
    if isinstance(value, dict):
        return {key: public_shape(child, depth + 1) for key, child in value.items()}
    if isinstance(value, list):
        return [public_shape(child, depth + 1) for child in value]
    return value


def same_value(left, right):
    """JSON structural equality distinguishes booleans from numeric 0/1."""
    if type(left) in (int, float) and type(right) in (int, float):
        return math.isfinite(left) and math.isfinite(right) and left == right
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(same_value(left[key], right[key]) for key in left)
    if isinstance(left, list):
        return len(left) == len(right) and all(same_value(a, b) for a, b in zip(left, right))
    return left == right


def timestamp(value):
    require(isinstance(value, str) and re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value))
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def validate_payload(payload, identifier):
    base.request_id(identifier)
    require(isinstance(payload, dict)
            and set(payload) == {"connection", "unsignedPayload", "signingPayload"})
    connection = payload["connection"]
    for field in ("unsignedPayload", "signingPayload"):
        require(isinstance(payload[field], str)
                and len(payload[field].encode("utf-8")) <= base.MAX_BYTES, "INPUT_TOO_LARGE")
    unsigned = decode_json(payload["unsignedPayload"].encode("utf-8"))
    signing = decode_json(payload["signingPayload"].encode("utf-8"))
    required = {"schemaVersion", "requestId", "submittedAt", "context", "command"}
    require(isinstance(unsigned, dict) and required <= set(unsigned)
            and set(unsigned) <= required | {"expiresAt"})
    require(type(unsigned["schemaVersion"]) is int and unsigned["schemaVersion"] == 1
            and unsigned["requestId"] == identifier)
    submitted = timestamp(unsigned["submittedAt"])
    if "expiresAt" in unsigned:
        require(timestamp(unsigned["expiresAt"]) > submitted)
    command = unsigned["command"]
    base.validate_inputs(connection, public_shape(command))
    context = unsigned["context"]
    context_fields = {"apiVersion", "workspaceId", "clientId", "actor", "idempotencyKey"}
    require(isinstance(context, dict) and context_fields <= set(context)
            and set(context) <= context_fields | {"correlationId", "approvalToken"})
    require(context["apiVersion"] == "nai-blue.agent/v1alpha1"
            and context["workspaceId"] == connection["workspaceId"]
            and context["clientId"] == connection["clientId"])
    actor = context["actor"]
    require(isinstance(actor, dict) and "kind" in actor
            and set(actor) <= {"kind", "displayName"} and actor["kind"] == connection["actorKind"])
    if "displayName" in actor:
        require(isinstance(actor["displayName"], str) and 1 <= len(actor["displayName"]) <= 100)
    for field in ("idempotencyKey", "correlationId", "approvalToken"):
        if field in context:
            require(isinstance(context[field], str)
                    and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}", context[field]))
    base.public_value({key: value for key, value in context.items() if key != "approvalToken"})
    require(isinstance(signing, dict) and set(signing) == set(unsigned) | {"requestHash", "authentication"})
    require(same_value(unsigned, {key: value for key, value in signing.items()
                                  if key not in ("requestHash", "authentication")}))
    expected_hash = "sha256:" + hashlib.sha256(payload["unsignedPayload"].encode("utf-8")).hexdigest()
    require(signing["requestHash"] == expected_hash, "REQUEST_HASH_MISMATCH")
    require(signing["authentication"] == {"scheme": "hmac-sha256", "keyId": connection["keyId"]})
    return connection, signing


def submit(payload, inbox, identifier):
    connection, signing = validate_payload(payload, identifier)
    inbox = base.safe_path(inbox, directory=True)
    require(inbox.name == "inbox", "UNSAFE_PATH")
    archive = inbox / (identifier + ".submitted.json")
    ready = inbox / (identifier + ".ready.json")
    temporary = inbox / (identifier + ".tmp")
    require(not os.path.lexists(temporary), "REQUEST_ID_CONFLICT")
    secret = base._read_credential(connection)
    try:
        signature = "hmac-sha256:" + hmac.new(secret, payload["signingPayload"].encode("utf-8"), "sha256").hexdigest()
        signed = {**signing, "authentication": {**signing["authentication"], "signature": signature}}
        raw = json.dumps(signed, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        require(len(raw) <= base.MAX_BYTES, "INPUT_TOO_LARGE")
        if os.path.lexists(archive):
            raw = base.read_bytes(archive)
            require(same_value(decode_json(raw), signed), "REQUEST_ID_CONFLICT")
        elif os.path.lexists(ready):
            raw = base.read_bytes(ready)
            require(same_value(decode_json(raw), signed), "REQUEST_ID_CONFLICT")
            base.publish(raw, archive, temporary)
        else:
            base.publish(raw, archive, temporary)
        if os.path.lexists(ready):
            require(base.read_bytes(ready) == raw, "REQUEST_ID_CONFLICT")
        else:
            base.publish(raw, ready, temporary)
    finally:
        secret[:] = b"\0" * len(secret)
    return {"status": "submitted-to-inbox", "accepted": False,
            "requestId": identifier, "requiresAppProcess": True}


def main():
    try:
        parser = base.PublicParser(description=__doc__)
        parser.add_argument("--inbox-dir", required=True)
        parser.add_argument("--request-id", required=True)
        args = parser.parse_args()
        raw = sys.stdin.buffer.read(MAX_STDIN_BYTES + 1)
        require(len(raw) <= MAX_STDIN_BYTES, "INPUT_TOO_LARGE")
        result = submit(decode_json(raw), args.inbox_dir, args.request_id)
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except Exception as error:
        allowed = {"INVALID_INPUT", "INVALID_ARGUMENTS", "INPUT_TOO_LARGE", "UNSAFE_PAYLOAD",
                   "UNSAFE_PATH", "REQUEST_ID_CONFLICT", "REQUEST_HASH_MISMATCH",
                   "CREDENTIAL_UNAVAILABLE", "WINDOWS_REQUIRED"}
        code = str(error) if isinstance(error, base.SubmissionError) and str(error) in allowed else "SUBMISSION_FAILED"
        print(json.dumps({"status": "not-submitted", "accepted": False, "code": code}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
