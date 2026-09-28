"""The governance gate at the Python SDK's own dispatch — the same cases as
@berthos/sdk's governance-gate.test.ts, run against a real Unix socket
speaking the real line-JSON framing (a stub governor, not a stubbed
transport)."""

from __future__ import annotations

import json
import socket
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Optional

from berth_sdk import define_app
from berth_sdk.rpc import invoke_export

Verdict = Optional[Callable[[Any], Any]]


@contextmanager
def stub_governor(socket_path: Path, verdict: Verdict):
    """Stands in for a `governs: true` app. `verdict` decides; None means
    answer nothing at all, which is what a hung governor looks like."""
    seen: list[dict] = []
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(socket_path))
    server.listen(8)
    stop = threading.Event()
    held: list[socket.socket] = []

    def serve() -> None:
        server.settimeout(0.1)
        while not stop.is_set():
            try:
                conn, _ = server.accept()
            except (socket.timeout, OSError):
                continue
            held.append(conn)
            buffer = b""
            while b"\n" not in buffer:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                buffer += chunk
            if not buffer:
                continue
            request = json.loads(buffer.split(b"\n", 1)[0])
            seen.append(request)
            if verdict is None:
                continue  # hang, deliberately
            conn.sendall((json.dumps({"id": request["id"], "result": verdict(request["input"])}) + "\n").encode())

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    try:
        yield seen
    finally:
        stop.set()
        thread.join(timeout=2)
        for conn in held:
            conn.close()
        server.close()


@contextmanager
def with_governor(short_tmp: Path, env, verdict: Verdict):
    """Builds the /run/berth/<governor>/peers/<self>/rpc.sock layout the gate
    dials, rooted in a temp dir."""
    peer_dir = short_tmp / "run" / "berth" / "governor" / "peers" / "worker"
    peer_dir.mkdir(parents=True)
    with stub_governor(peer_dir / "rpc.sock", verdict) as seen:
        env.setenv("BERTH_GOVERNANCE_APP", "governor")
        env.setenv("BERTH_APP_NAME", "worker")
        env.setenv("BERTH_GOVERNANCE_SOCKET_ROOT", str(short_tmp))
        yield seen


def worker_app():
    return define_app(lambda a: a.export("transfer_funds", lambda _input: {"ok": True}))


def test_a_denial_stops_the_call_whatever_transport_it_arrived_on(short_tmp, clean_env):
    with with_governor(short_tmp, clean_env, lambda _i: {"allowed": False, "reason": "not on the allowlist"}):
        app = worker_app()
        for caller in ["host", "sibling-app"]:
            response = invoke_export(app, {"id": "1", "export": "transfer_funds", "input": {"amount": 1}}, caller)
            assert "error" in response, f"expected {caller} to be denied"
            assert "governance denied transfer_funds: not on the allowlist" in response["error"]


def test_an_allowed_action_runs_and_the_real_result_comes_back(short_tmp, clean_env):
    with with_governor(short_tmp, clean_env, lambda _i: {"allowed": True}):
        response = invoke_export(worker_app(), {"id": "2", "export": "transfer_funds", "input": {"amount": 1}}, "host")
        assert response == {"id": "2", "result": {"ok": True}}


def test_the_governor_is_told_who_asked(short_tmp, clean_env):
    with with_governor(short_tmp, clean_env, lambda _i: {"allowed": True}) as seen:
        invoke_export(worker_app(), {"id": "3", "export": "transfer_funds", "input": {"amount": 7}}, "sibling-app")
        evaluated = seen[-1]
        assert evaluated["export"] == "evaluate_action"
        assert evaluated["input"] == {"app": "worker", "export": "transfer_funds", "input": {"amount": 7}, "caller": "sibling-app"}


def test_a_denial_without_a_reason_gets_the_default_one(short_tmp, clean_env):
    with with_governor(short_tmp, clean_env, lambda _i: {"allowed": False}):
        response = invoke_export(worker_app(), {"id": "3b", "export": "transfer_funds"}, "host")
        assert response["error"] == "governance denied transfer_funds: denied by governance policy"


def test_an_unreachable_governor_denies_fail_closed(short_tmp, clean_env):
    with with_governor(short_tmp, clean_env, lambda _i: {"allowed": True}):
        clean_env.setenv("BERTH_GOVERNANCE_APP", "governor-that-never-started")
        response = invoke_export(worker_app(), {"id": "4", "export": "transfer_funds"}, "host")
        assert "governance unavailable" in response["error"]


def test_a_governor_that_answers_with_no_verdict_is_unavailable_not_consent(short_tmp, clean_env):
    with with_governor(short_tmp, clean_env, lambda _i: {"notAVerdict": True}):
        response = invoke_export(worker_app(), {"id": "5", "export": "transfer_funds"}, "host")
        assert "governance unavailable" in response["error"]


def test_a_truthy_non_boolean_allowed_is_not_consent(short_tmp, clean_env):
    with with_governor(short_tmp, clean_env, lambda _i: {"allowed": "yes"}):
        response = invoke_export(worker_app(), {"id": "5b", "export": "transfer_funds"}, "host")
        assert "governance unavailable" in response["error"]


def test_a_hung_governor_times_out_and_denies(short_tmp, clean_env):
    with with_governor(short_tmp, clean_env, None):
        clean_env.setenv("BERTH_GOVERNANCE_TIMEOUT_MS", "200")
        response = invoke_export(worker_app(), {"id": "5c", "export": "transfer_funds"}, "host")
        assert "governance unavailable" in response["error"]
        assert "timed out" in response["error"]


def test_the_governors_own_exports_are_never_gated(short_tmp, clean_env):
    with with_governor(short_tmp, clean_env, lambda _i: {"allowed": False, "reason": "would recurse"}):
        clean_env.setenv("BERTH_APP_NAME", "governor")  # this process IS the governor
        governor_app = define_app(lambda a: a.export("evaluate_action", lambda _input: {"allowed": True}))
        response = invoke_export(governor_app, {"id": "6", "export": "evaluate_action", "input": {}}, "sibling-app")
        assert "result" in response


def test_governance_exempt_opts_out_without_a_round_trip(short_tmp, clean_env):
    with with_governor(short_tmp, clean_env, lambda _i: {"allowed": False, "reason": "would have denied"}) as seen:
        clean_env.setenv("BERTH_GOVERNANCE_EXEMPT", "1")
        response = invoke_export(worker_app(), {"id": "7", "export": "transfer_funds"}, "host")
        assert "result" in response
        assert seen == []


def test_no_governor_loaded_means_no_gate(clean_env):
    response = invoke_export(worker_app(), {"id": "8", "export": "transfer_funds"}, "host")
    assert response == {"id": "8", "result": {"ok": True}}
