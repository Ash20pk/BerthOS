"""The governance gate at the SDK's own RPC dispatch — the Python half of
@berthos/sdk's governance-gate.ts, with the same wiring and the same
fail-closed semantics.

entrypoint.sh exports BERTH_GOVERNANCE_APP to every app in a sandbox that has
a `governs: true` app, whichever runtime the app is written in. Without this
module a Python app's exports ran ungoverned in that sandbox: `berth rpc`,
`berth mcp` and a sibling's direct socket call all reach invoke_export() in
rpc.py, and nothing there asked the governor. See the TypeScript original for
why the check sits at the dispatch rather than in @berthos/agents, and for the
blast radius fail-closed has here.

Asking the governor is an ordinary app-to-app RPC over the peer socket
entrypoint.sh provisions (/run/berth/<governor>/peers/<self>/rpc.sock), in the
same line-delimited JSON as everything else in rpc.py.
"""

from __future__ import annotations

import json
import os
import socket
import sys
import time
from dataclasses import dataclass
from typing import Any, Optional

# How long a governor gets to answer before the call is refused. Matches
# governance-gate.ts, which matches @berthos/agents' own evaluate_action
# timeout.
_DEFAULT_TIMEOUT_MS = 5000


@dataclass
class GateDecision:
    allowed: bool
    reason: str


@dataclass
class _GateConfig:
    governor: str
    self_name: str


def _gate_config() -> Optional[_GateConfig]:
    """Reads the wiring entrypoint.sh exports. Read per call rather than
    cached at import, so a test can set it around a single request."""
    governor = os.environ.get("BERTH_GOVERNANCE_APP")
    if not governor:
        return None  # no governor in this container — the common case
    self_name = os.environ.get("BERTH_APP_NAME", "")
    # The governor's own exports are never gated: routing evaluate_action
    # through the gate would call evaluate_action to decide whether
    # evaluate_action may run.
    if self_name and self_name == governor:
        return None
    # An app that declared `governance: { exempt: true }`. entrypoint.sh
    # resolves the manifest field; this only reads the result.
    if os.environ.get("BERTH_GOVERNANCE_EXEMPT") == "1":
        return None
    return _GateConfig(governor, self_name)


def governance_gate_active() -> bool:
    """True when a governor is loaded and this app is subject to it."""
    return _gate_config() is not None


def _timeout_seconds() -> float:
    raw = os.environ.get("BERTH_GOVERNANCE_TIMEOUT_MS")
    try:
        ms = float(raw) if raw else _DEFAULT_TIMEOUT_MS
    except ValueError:
        ms = _DEFAULT_TIMEOUT_MS
    return (ms if ms > 0 else _DEFAULT_TIMEOUT_MS) / 1000.0


def evaluate_action(caller: str, export: str, input: Any) -> Optional[GateDecision]:
    """Asks the governor about one action. Returns None when no gate
    applies, so the caller can tell "allowed" apart from "not governed"
    without either being the default.

    `caller` is who the kernel says is asking: a sibling's name when the
    request arrived on that sibling's peer socket, or "host" for stdio and
    the relay's socket. It is never read from the request."""
    config = _gate_config()
    if config is None:
        return None

    # BERTH_GOVERNANCE_SOCKET_ROOT is the same test-only knob governance-gate.ts
    # reads: it relocates the socket tree so the real dialling can be exercised
    # without /run/berth. Unset in every real container.
    root = os.environ.get("BERTH_GOVERNANCE_SOCKET_ROOT", "")
    socket_path = f"{root}/run/berth/{config.governor}/peers/{config.self_name}/rpc.sock"
    request = {
        "id": f"gate-{os.getpid()}-{int(time.time() * 1000)}",
        "export": "evaluate_action",
        "input": {"app": config.self_name, "export": export, "input": input, "caller": caller},
    }
    try:
        verdict = _ask_governor(socket_path, request, _timeout_seconds())
    except Exception as err:  # noqa: BLE001 - every failure to get a verdict must deny
        # Fail-closed. "The governor said no" and "the governor never
        # answered" stay distinguishable in the message, because one is policy
        # working and the other is policy broken.
        print(
            f"[berth:governance] evaluate_action unreachable for {config.self_name}.{export} ({err}) — denying, fail-closed",
            file=sys.stderr,
        )
        return GateDecision(False, f"governance unavailable ({err})")

    reason = verdict.get("reason")
    if verdict["allowed"]:
        return GateDecision(True, "" if reason is None else str(reason))
    return GateDecision(False, "denied by governance policy" if reason is None else str(reason))


def _ask_governor(socket_path: str, request: dict[str, Any], timeout: float) -> dict[str, Any]:
    """One line-delimited JSON request over the governor's peer socket. No
    keep-alive: a verdict is a single round trip, and a pooled socket would
    outlive the governor's own restarts. `timeout` bounds the whole exchange,
    connect included."""
    deadline = time.monotonic() + timeout

    def remaining() -> float:
        left = deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError(f"evaluate_action timed out after {int(timeout * 1000)}ms")
        return left

    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        try:
            sock.settimeout(remaining())
            sock.connect(socket_path)
            sock.settimeout(remaining())
            sock.sendall((json.dumps(request) + "\n").encode("utf-8"))
            buffer = b""
            while b"\n" not in buffer:
                sock.settimeout(remaining())
                chunk = sock.recv(65536)
                if not chunk:
                    raise ConnectionError("governor closed the connection without answering")
                buffer += chunk
        except socket.timeout as err:
            raise TimeoutError(f"evaluate_action timed out after {int(timeout * 1000)}ms") from err

    response = json.loads(buffer.split(b"\n", 1)[0].decode("utf-8"))
    if not isinstance(response, dict):
        raise ValueError("evaluate_action returned no boolean 'allowed' field")
    if response.get("error"):
        raise RuntimeError(str(response["error"]))
    result = response.get("result")
    if not isinstance(result, dict) or not isinstance(result.get("allowed"), bool):
        # A governor that answers with something this can't read hasn't
        # rendered a verdict — treated as unavailable, not as consent.
        raise ValueError("evaluate_action returned no boolean 'allowed' field")
    return result
