"""The identical line-delimited JSON RPC protocol from @berth/sdk's rpc.ts —
{id, export, input} in, {id, result} or {id, error} out — over stdio and,
optionally, a Unix socket. No length-prefix, no protobuf: this is the
simplest of the two wire protocols this SDK reuses (see context_bus.py for
the other, protobuf-framed one), so a straight re-implementation rather than
anything requiring codegen.
"""

from __future__ import annotations

import json
import os
import socketserver
import sys
import threading
from typing import Any, Callable, Optional

from .app import BerthApp

RpcRequest = dict[str, Any]
RpcResponse = dict[str, Any]


def invoke_export(app: BerthApp, request: RpcRequest) -> RpcResponse:
    export_def = app.exports.get(request.get("export"))
    if export_def is None:
        return {"id": request.get("id"), "error": f'no such export "{request.get("export")}"'}

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


def _handle_line(app: BerthApp, line: str, write: Callable[[str], None]) -> None:
    line = line.strip()
    if not line:
        return
    try:
        request = json.loads(line)
    except json.JSONDecodeError:
        print(f"[berth:runtime] ignoring non-JSON RPC line: {line}", file=sys.stderr)
        return
    response = invoke_export(app, request)
    write(json.dumps(response))


class _RpcSocketHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        app: BerthApp = self.server.app  # type: ignore[attr-defined]

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
            _handle_line(app, line, write)


class _RpcUnixStreamServer(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True


def start_socket_server(app: BerthApp, socket_path: str) -> None:
    try:
        os.unlink(socket_path)
    except FileNotFoundError:
        pass

    server = _RpcUnixStreamServer(socket_path, _RpcSocketHandler)
    server.app = app  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print(f"[berth:runtime] RPC server also listening on {socket_path}", file=sys.stderr)


def start_rpc_server(app: BerthApp, socket_path: Optional[str] = None) -> None:
    """Starts the (optional) socket server and logs readiness — does NOT
    block. serve_stdio_forever() is the blocking call, run last in
    runtime.py's boot sequence so "ready" logs before it, matching rpc.ts's
    ordering (its own startRpcServer() is non-blocking; Node's event loop
    is what keeps the process alive)."""
    print("[berth:runtime] RPC server listening on stdio", file=sys.stderr)
    if socket_path:
        start_socket_server(app, socket_path)


def serve_stdio_forever(app: BerthApp) -> None:
    def write(resp: str) -> None:
        sys.stdout.write(resp + "\n")
        sys.stdout.flush()

    for line in sys.stdin:
        _handle_line(app, line, write)
