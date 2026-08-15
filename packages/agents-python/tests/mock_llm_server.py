"""A real HTTP server for provider-adapter tests — the Python counterpart to
`packages/agents/src/providers/mock-server.ts`.

**A real server rather than a stubbed vendor client, deliberately**, and for
the reason REMEDIATION 3.7 records for the TypeScript side: every bug this
kind of test exists to catch is about the request body an adapter *builds* or
the response field it fails to *read*. Stubbing `client.chat.completions.create`
would assert the arguments this package passes to the SDK — the half that was
never wrong — and would happily accept a body the vendor's API rejects.

Every Python provider already takes a `base_url` for production reasons
(Ollama, vLLM, gateways), so pointing one at `http://127.0.0.1:<port>` needs
no seam that didn't already exist. The one exception is `google.py`, which
has no `base_url` at all — the same absence REMEDIATION 3.7 had to fix in
`google.ts` before that adapter could be tested.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable


class MockLLMServer:
    """Serves canned responses and records every request that arrives.

    `responses` is consumed in order, so a test can drive a multi-turn
    exchange. `requests` holds the parsed JSON bodies, which is what
    assertions are actually made against.
    """

    def __init__(self, responses: list[Any] | None = None) -> None:
        self.requests: list[dict[str, Any]] = []
        self.paths: list[str] = []
        self.headers: list[dict[str, str]] = []
        self._responses: list[Any] = list(responses or [])
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def queue(self, response: Any) -> "MockLLMServer":
        self._responses.append(response)
        return self

    @property
    def base_url(self) -> str:
        assert self._server is not None, "server not started"
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    @property
    def last_request(self) -> dict[str, Any]:
        assert self.requests, "no request was made"
        return self.requests[-1]

    def __enter__(self) -> "MockLLMServer":
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler's naming
                length = int(self.headers.get("content-length", 0))
                raw = self.rfile.read(length)
                outer.requests.append(json.loads(raw) if raw else {})
                outer.paths.append(self.path)
                outer.headers.append({k.lower(): v for k, v in self.headers.items()})

                response = outer._responses.pop(0) if outer._responses else {}
                # A list of chunks means "stream this back as SSE" — the shape
                # every OpenAI-compatible streaming endpoint uses, including
                # the `[DONE]` sentinel the SDK's parser waits for.
                if isinstance(response, list):
                    self.send_response(200)
                    self.send_header("content-type", "text/event-stream")
                    self.end_headers()
                    for chunk in response:
                        self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
                    self.wfile.write(b"data: [DONE]\n\n")
                    return

                status = response.pop("__status", 200) if isinstance(response, dict) else 200
                body = json.dumps(response).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args: Any) -> None:
                """Silence per-request logging, which would otherwise interleave
                with pytest's own output on every single call."""

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *_exc: Any) -> None:
        assert self._server is not None
        self._server.shutdown()
        self._server.server_close()
        assert self._thread is not None
        self._thread.join(timeout=5)


def chat_completion(
    *,
    content: str | None = "hello",
    tool_calls: list[dict[str, Any]] | None = None,
    finish_reason: str | None = "stop",
    usage: dict[str, int] | None = None,
    refusal: str | None = None,
) -> dict[str, Any]:
    """One OpenAI Chat Completions response, shaped as the API really returns
    it — the SDK validates enough of this that a hand-waved dict won't parse."""
    message: dict[str, Any] = {"role": "assistant", "content": content}
    if tool_calls is not None:
        message["tool_calls"] = tool_calls
    if refusal is not None:
        message["refusal"] = refusal
    return {
        "id": "chatcmpl-test",
        "object": "chat.completion",
        "created": 0,
        "model": "gpt-4o",
        "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
        "usage": usage or {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    }


def anthropic_message(
    *,
    content: list[dict[str, Any]] | None = None,
    stop_reason: str = "end_turn",
) -> dict[str, Any]:
    return {
        "id": "msg_test",
        "type": "message",
        "role": "assistant",
        "model": "claude-sonnet-5",
        "content": content if content is not None else [{"type": "text", "text": "hello"}],
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "usage": {"input_tokens": 10, "output_tokens": 5},
    }


def tool_call(*, call_id: str = "call_1", name: str = "read_file", arguments: str = '{"path":"/x"}') -> dict[str, Any]:
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}}


def sse_chunk(
    *,
    content: str | None = None,
    tool_call_delta: dict[str, Any] | None = None,
    finish_reason: str | None = None,
    usage: dict[str, int] | None = None,
) -> dict[str, Any]:
    delta: dict[str, Any] = {}
    if content is not None:
        delta["content"] = content
    if tool_call_delta is not None:
        delta["tool_calls"] = [tool_call_delta]
    chunk: dict[str, Any] = {
        "id": "chatcmpl-test",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "gpt-4o",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }
    if usage is not None:
        # The usage-only final frame carries an empty choices list, which is
        # what makes "read finish_reason off the last chunk" wrong.
        chunk["choices"] = []
        chunk["usage"] = usage
    return chunk


Provider = Callable[..., Any]
