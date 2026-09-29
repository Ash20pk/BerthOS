"""The identical line-delimited JSON RPC protocol from @berthos/sdk's rpc.ts —
{id, export, input} in, {id, result} or {id, error} out — over stdio and,
optionally, a Unix socket. No length-prefix, no protobuf: this is the
simplest of the two wire protocols this SDK reuses (see context_bus.py for
the other, protobuf-framed one), so a straight re-implementation rather than
anything requiring codegen.

Alongside the socket this also binds one socket per authorized sibling, under
<socket's directory>/peers/<caller>/rpc.sock, exactly as rpc.ts does: which
socket a connection arrived on is how the server learns who is calling (see
start_peer_socket_servers), and that identity is what the governance gate in
governance_gate.py is told.
"""

from __future__ import annotations

import json
import os
import socketserver
import sys
import threading
from typing import Any, Callable, Optional

from .app import BerthApp
from .governance_gate import evaluate_action

RpcRequest = dict[str, Any]
RpcResponse = dict[str, Any]


def invoke_export(app: BerthApp, request: RpcRequest, caller: str = "host") -> RpcResponse:
    """`caller` is who the kernel says is asking — a sibling's name when the
    request arrived on that sibling's own peer socket, otherwise "host" (stdio
    and the relay's socket, which only root and this app can reach). It is
    never read from the request. Defaulted so an in-process caller keeps
    working, matching rpc.ts's invokeExport()."""
    export_def = app.exports.get(request.get("export"))
    if export_def is None:
        return {"id": request.get("id"), "error": f'no such export "{request.get("export")}"'}

    # Every transport into this app converges here, so this is where a
    # governor can see them all. None when no governor is loaded, which is the
    # common case and costs one env lookup.
    decision = evaluate_action(caller, request.get("export"), request.get("input"))
    if decision is not None and not decision.allowed:
        print(
            "[berth:governance] "
            + json.dumps({"event": "denied", "caller": caller, "export": request.get("export"), "reason": decision.reason}, separators=(",", ":")),
            file=sys.stderr,
        )
        return {"id": request.get("id"), "error": f"governance denied {request.get('export')}: {decision.reason}"}

    try:
        raw_input = request.get("input")
        parsed_input = export_def.input_model.model_validate(raw_input) if export_def.input_model else raw_input
        result = export_def.handler(parsed_input)

        if export_def.output_model is not None and not isinstance(result, export_def.output_model):
            result = export_def.output_model.model_validate(result)
        output_payload = result.model_dump() if hasattr(result, "model_dump") else result

        return {"id": request.get("id"), "result": output_payload}
    except Exception as err:  # matches rpc.ts's catch-all — reported back to the caller, not raised
        return {"id": request.get("id"), "error": str(err)}


def _handle_line(app: BerthApp, line: str, write: Callable[[str], None], peer: Optional[str] = None) -> None:
    line = line.strip()
    if not line:
        return
    try:
        request = json.loads(line)
    except json.JSONDecodeError:
        print(f"[berth:runtime] ignoring non-JSON RPC line: {line}", file=sys.stderr)
        return
    if not isinstance(request, dict):
        print(f"[berth:runtime] ignoring non-object RPC line: {line}", file=sys.stderr)
        return
    # One audit line per cross-app call, and only for those — the record of
    # which app invoked an export, same as rpc.ts.
    if peer:
        print(f'[berth:runtime] "{peer}" invoked export "{request.get("export")}"', file=sys.stderr)
    response = invoke_export(app, request, peer or "host")
    write(json.dumps(response))


class _RpcSocketHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        app: BerthApp = self.server.app  # type: ignore[attr-defined]
        peer: Optional[str] = self.server.peer  # type: ignore[attr-defined]

        def write(resp: str) -> None:
            self.wfile.write((resp + "\n").encode("utf-8"))
            self.wfile.flush()

        while True:
            raw = self.rfile.readline()
            if not raw:
                break
            line = raw.decode("utf-8")
            if not line.strip():
                continue
            _handle_line(app, line, write, peer)


class _RpcUnixStreamServer(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True


def _serve(app: BerthApp, socket_path: str, peer: Optional[str], mode: int) -> threading.Thread:
    try:
        os.unlink(socket_path)
    except FileNotFoundError:
        pass

    server = _RpcUnixStreamServer(socket_path, _RpcSocketHandler)
    server.app = app  # type: ignore[attr-defined]
    server.peer = peer  # type: ignore[attr-defined]
    try:
        os.chmod(socket_path, mode)
    except OSError as err:
        print(f"[berth:runtime] WARNING: could not chmod {socket_path} to {mode:04o} ({err})", file=sys.stderr)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return thread


def start_socket_server(app: BerthApp, socket_path: str) -> threading.Thread:
    # 0600, explicitly, rather than whatever the umask leaves behind. This
    # socket is for the host relay (`docker exec`, root, which mode bits don't
    # constrain) and for this app itself. No sibling reaches it: an authorized
    # one gets its own socket under peers/ — see start_peer_socket_servers().
    thread = _serve(app, socket_path, None, 0o600)
    print(f"[berth:runtime] RPC server also listening on {socket_path}", file=sys.stderr)
    return thread


def start_peer_socket_servers(app: BerthApp, socket_path: str) -> list[threading.Thread]:
    """One listener per sibling app that may call this one — rpc.ts's
    startPeerSocketServers(), with the same filesystem contract.

    entrypoint.sh creates /run/berth/<this app>/peers/<caller>/ mode 2710,
    owned by this app and group-owned by the caller, for every sibling that
    declared app:invoke:<this app> and, when this app is the governor, for
    every governed sibling. The caller is the only unprivileged uid that can
    traverse into its directory, so a connection's arrival on that socket is
    the kernel's statement about who connected, checked by DAC at connect(2)
    — nothing the caller sends can change it.

    The directory is read, not configured: entrypoint.sh finishes creating it
    before any app starts, so what is on disk now is exactly the authorized
    set. The setgid bit on each directory is what lands the socket in the
    caller's group without this (non-root) process chowning anything."""
    peers_dir = os.path.join(os.path.dirname(socket_path), "peers")
    try:
        callers = sorted(os.listdir(peers_dir))
    except OSError:
        return []  # no authorized callers, which is the common case

    threads = []
    for caller in callers:
        peer_socket_path = os.path.join(peers_dir, caller, "rpc.sock")
        try:
            # 0660 so the caller's group can connect: connecting to a pathname
            # socket needs write, which the umask default leaves off.
            threads.append(_serve(app, peer_socket_path, caller, 0o660))
        except OSError as err:
            print(
                f"[berth:runtime] WARNING: could not serve {caller} on {peer_socket_path} ({err}) — its app:invoke: calls will fail",
                file=sys.stderr,
            )
            continue
        print(f'[berth:runtime] RPC server also listening on {peer_socket_path} for "{caller}"', file=sys.stderr)
    return threads


def start_rpc_server(app: BerthApp, socket_path: Optional[str] = None) -> Optional[threading.Thread]:
    """Starts the (optional) socket server and logs readiness — does NOT
    block. serve_stdio_forever() is the blocking call, run last in
    runtime.py's boot sequence so "ready" logs before it, matching rpc.ts's
    ordering (its own startRpcServer() is non-blocking; Node's event loop
    is what keeps the process alive).

    Returns the socket server's thread, if one was started, so the runtime
    can keep serving it after stdin closes."""
    print("[berth:runtime] RPC server listening on stdio", file=sys.stderr)
    if socket_path:
        thread = start_socket_server(app, socket_path)
        start_peer_socket_servers(app, socket_path)
        return thread
    return None


def serve_stdio_forever(app: BerthApp) -> None:
    def write(resp: str) -> None:
        sys.stdout.write(resp + "\n")
        sys.stdout.flush()

    for line in sys.stdin:
        _handle_line(app, line, write)
