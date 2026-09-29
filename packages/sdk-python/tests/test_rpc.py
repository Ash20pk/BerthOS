"""rpc.py's socket servers: the relay's own socket and the per-caller peer
sockets entrypoint.sh provisions under /run/berth/<app>/peers/<caller>/."""

from __future__ import annotations

import json
import os
import socket
import stat
import time
from pathlib import Path

from berth_sdk import define_app
from berth_sdk.rpc import invoke_export, start_rpc_server


def _call(socket_path: Path, request: dict) -> dict:
    deadline = time.monotonic() + 5
    while not socket_path.exists():
        if time.monotonic() > deadline:
            raise AssertionError(f"{socket_path} never appeared")
        time.sleep(0.02)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(5)
        sock.connect(str(socket_path))
        sock.sendall((json.dumps(request) + "\n").encode())
        buffer = b""
        while b"\n" not in buffer:
            chunk = sock.recv(65536)
            assert chunk, "server closed without answering"
            buffer += chunk
    return json.loads(buffer.split(b"\n", 1)[0])


def _echo_app():
    return define_app(lambda a: a.export("echo", lambda value: value))


def test_invoke_export_returns_a_result_and_an_unknown_export_error(clean_env):
    app = _echo_app()
    assert invoke_export(app, {"id": "1", "export": "echo", "input": {"x": 1}}) == {"id": "1", "result": {"x": 1}}
    assert invoke_export(app, {"id": "2", "export": "missing"}) == {"id": "2", "error": 'no such export "missing"'}


def test_the_relay_socket_is_0600(short_tmp, clean_env):
    socket_path = short_tmp / "rpc.sock"
    start_rpc_server(_echo_app(), socket_path=str(socket_path))
    assert _call(socket_path, {"id": "1", "export": "echo", "input": 5}) == {"id": "1", "result": 5}
    assert stat.S_IMODE(os.stat(socket_path).st_mode) == 0o600


def test_one_peer_socket_per_authorized_caller_at_0660(short_tmp, clean_env):
    (short_tmp / "peers" / "caller-a").mkdir(parents=True)
    (short_tmp / "peers" / "caller-b").mkdir(parents=True)
    socket_path = short_tmp / "rpc.sock"
    start_rpc_server(_echo_app(), socket_path=str(socket_path))

    for caller in ["caller-a", "caller-b"]:
        peer_socket = short_tmp / "peers" / caller / "rpc.sock"
        assert _call(peer_socket, {"id": caller, "export": "echo", "input": caller}) == {"id": caller, "result": caller}
        assert stat.S_IMODE(os.stat(peer_socket).st_mode) == 0o660


def test_no_peers_directory_means_no_peer_sockets(short_tmp, clean_env):
    socket_path = short_tmp / "rpc.sock"
    start_rpc_server(_echo_app(), socket_path=str(socket_path))
    assert _call(socket_path, {"id": "1", "export": "echo", "input": 1})["result"] == 1
    assert not (short_tmp / "peers").exists()


def test_the_caller_the_gate_sees_is_the_peer_socket_not_the_request(short_tmp, clean_env, monkeypatch):
    """The identity comes from which socket a connection reached; a caller
    field in the request body changes nothing."""
    seen: list[str] = []

    import berth_sdk.rpc as rpc

    def fake_gate(caller, export, input):
        seen.append(caller)
        return None

    monkeypatch.setattr(rpc, "evaluate_action", fake_gate)
    (short_tmp / "peers" / "real-caller").mkdir(parents=True)
    socket_path = short_tmp / "rpc.sock"
    start_rpc_server(_echo_app(), socket_path=str(socket_path))

    _call(short_tmp / "peers" / "real-caller" / "rpc.sock", {"id": "1", "export": "echo", "input": 1, "caller": "host"})
    _call(socket_path, {"id": "2", "export": "echo", "input": 1, "caller": "real-caller"})
    assert seen == ["real-caller", "host"]
