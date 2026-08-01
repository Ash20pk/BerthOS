"""Real context-bus client — talks to the same Rust daemon @berth/sdk's
unix-socket.ts does, over the same wire contract: a Unix socket carrying
length-prefixed (4-byte big-endian length + protobuf bytes) Envelope frames,
per proto/context_bus.proto. Unlike rpc.py's protocol (plain newline-JSON,
reused as-is), this one needs real protobuf codegen — see
scripts/gen_proto.sh for how context_bus_pb2.py is generated, and why
`python3 -m grpc_tools.protoc` is used instead of a bare system `protoc`
(version-compatibility reasons documented there).
"""

from __future__ import annotations

import json
import socket
import threading
import time
from collections import defaultdict
from typing import Any, Callable, Optional

from . import context_bus_pb2 as pb

CONNECT_TIMEOUT_S = 2.0
CONNECT_RETRY_INTERVAL_S = 0.1


class ContextBusClient:
    """Same interface shape as @berth/sdk's ContextBusClient
    (register/publish/subscribe) — resident app code doesn't change based on
    which implementation runtime.py wires in, matching the TS SDK's own
    local-vs-real symmetry."""

    def __init__(self, sock: socket.socket) -> None:
        self._sock = sock
        self._lock = threading.Lock()
        self._handlers: dict[str, list[Callable[[Any], None]]] = defaultdict(list)
        self._read_buffer = b""
        self._reader_thread = threading.Thread(target=self._read_loop, daemon=True)
        self._reader_thread.start()

    def _read_loop(self) -> None:
        while True:
            try:
                chunk = self._sock.recv(4096)
            except OSError:
                return
            if not chunk:
                return
            self._read_buffer += chunk
            while len(self._read_buffer) >= 4:
                length = int.from_bytes(self._read_buffer[:4], "big")
                if len(self._read_buffer) < 4 + length:
                    break
                frame = self._read_buffer[4 : 4 + length]
                self._read_buffer = self._read_buffer[4 + length :]
                self._handle_frame(frame)

    def _handle_frame(self, frame: bytes) -> None:
        envelope = pb.Envelope()
        envelope.ParseFromString(frame)
        if envelope.HasField("event"):
            topic = envelope.event.topic
            raw_payload = envelope.event.payload
            payload = json.loads(raw_payload.decode("utf-8")) if raw_payload else None
            for handler in list(self._handlers.get(topic, [])):
                handler(payload)

    def _send(self, **kwargs: Any) -> None:
        envelope = pb.Envelope(**kwargs)
        encoded = envelope.SerializeToString()
        with self._lock:
            self._sock.sendall(len(encoded).to_bytes(4, "big") + encoded)

    # Plain synchronous methods, not `async def` — unlike the TS SDK
    # (Node's I/O model makes everything naturally async), this runtime has
    # no event loop: app hooks are called as plain sync functions, and the
    # underlying socket write is already a blocking sendall(). Making these
    # `async def` would just produce un-awaited coroutine objects that never
    # actually run when called from a sync hook.
    def register(self, app: str) -> None:
        self._send(register=pb.RegisterRequest(app=app))

    def publish(self, topic: str, payload: Any) -> None:
        encoded_payload = json.dumps(payload if payload is not None else None).encode("utf-8")
        self._send(publish=pb.PublishRequest(topic=topic, payload=encoded_payload))

    def subscribe(self, topic: str, handler: Callable[[Any], None]) -> Callable[[], None]:
        is_first = topic not in self._handlers or len(self._handlers[topic]) == 0
        self._handlers[topic].append(handler)
        if is_first:
            self._send(subscribe=pb.SubscribeRequest(topic=topic))

        def unsubscribe() -> None:
            handlers = self._handlers.get(topic, [])
            if handler in handlers:
                handlers.remove(handler)
            if not handlers:
                self._send(unsubscribe=pb.UnsubscribeRequest(topic=topic))

        return unsubscribe


def create_unix_socket_context_bus(socket_path: str) -> ContextBusClient:
    deadline = time.monotonic() + CONNECT_TIMEOUT_S
    last_error: Optional[OSError] = None
    while time.monotonic() < deadline:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            sock.connect(socket_path)
            return ContextBusClient(sock)
        except OSError as err:
            last_error = err
            sock.close()
            time.sleep(CONNECT_RETRY_INTERVAL_S)
    raise TimeoutError(f"timed out connecting to {socket_path} after {CONNECT_TIMEOUT_S}s: {last_error}")
