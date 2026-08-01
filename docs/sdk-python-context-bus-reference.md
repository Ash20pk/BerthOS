# Python SDK Reference (Slice 2 — context bus)

Follow-up to [Python SDK reference](./sdk-python-reference.md) (Slice 1: manifest + RPC + a demo app). This slice adds `berth_sdk/context_bus.py` — a real client for the same Rust context-bus daemon `@berth/sdk`'s `unix-socket.ts` talks to — and proves real cross-language pub/sub: a Python app publishing, a TypeScript app reacting, through the actual daemon.

## Compiled protobuf, not protobufjs's runtime-load trick

`@berth/sdk`'s TS client (`protobufjs`) loads `context_bus.proto` at runtime — no codegen step. This SDK deliberately does it differently: `packages/sdk-python/scripts/gen_proto.sh` compiles `proto/context_bus.proto` (a hand-kept-in-sync copy of the canonical one at `packages/sdk/proto/context_bus.proto`) into a real `context_bus_pb2.py` ahead of time. Call this out explicitly as a deliberate per-language difference, not an oversight — Python's protobuf ecosystem favors compiled codegen over the JS-style dynamic-schema-load pattern.

**A real version-compatibility trap found in the process, worth documenting for whoever runs this next:** a system `protoc` (e.g. installed via Homebrew) tracks its own release train and can be materially newer than whatever `protobuf` version is published to PyPI for Python — generating code that then refuses to load at runtime:

```
google.protobuf.runtime_version.VersionError: Detected incompatible Protobuf Gencode/Runtime versions:
gencode 7.35.1 runtime 6.33.6. Runtime version cannot be older than the linked gencode version.
```

`gen_proto.sh` uses `python3 -m grpc_tools.protoc` instead — `grpcio-tools` bundles a `protoc` release guaranteed compatible with the `protobuf` Python runtime it depends on, sidestepping the mismatch entirely. `grpcio-tools` is a codegen-time tool only, not a runtime dependency of the package (only `protobuf` itself, added to `pyproject.toml`, is).

## The client itself

`berth_sdk/context_bus.py`'s `ContextBusClient` implements the same three-method shape as `@berth/sdk`'s `ContextBusClient` interface (`register`, `publish`, `subscribe`) — same wire framing as `unix-socket.ts` too: a 4-byte big-endian length prefix + protobuf `Envelope` bytes over a Unix socket, a background thread reading and dispatching `Event` frames to subscribed handlers.

**One deliberate departure from a literal port, and why:** the TS client's methods are `async` because Node's I/O model makes everything naturally asynchronous. This SDK's runtime has no event loop — `on_agent_ready` hooks are called as plain synchronous functions — so `register`/`publish` here are **plain synchronous methods**, not `async def`. Making them `async def` would have produced un-awaited coroutine objects that silently never execute when called from a sync hook; this was caught by testing the actual failure mode, not guessed at.

`berth_sdk/local_context_bus.py` is the no-op fallback (an in-process dict-of-handlers, synchronous for the same reason), used when the real daemon isn't reachable — `runtime.py`'s `_create_context_bus()` tries the real client first and falls back on any connection error, mirroring `runtime.ts`'s own `createContextBus()` try/catch.

## The cross-language proof

`packages/docker-orchestrator/test/python-sdk-context-bus-milestone.mjs` mirrors `context-bus-milestone.mjs`'s original pattern (one container, a companion app's runtime started as a second process via `docker exec`, sharing the same daemon socket and `/workspace` bind mount) — but with the language pairing **reversed** from the original Phase 2 test: the primary is `apps/hello-world-py` (Python), the companion is `apps/code-editor` (TypeScript), proving the interop isn't an artifact of one specific language having to go first.

`apps/hello-world-py` gained a `publish_file_created` export that calls `context_bus.publish("fs.file_created", {"path": ..., "createdBy": ...})` — the **exact** topic and payload shape `apps/code-editor` already subscribes to and reacts to (opening the file, logging a specific line) with **zero changes** to `code-editor`'s own code. The test asserts that reactive log line actually appears after the Python app's publish call — a real message, decoded by a real Rust daemon, delivered to a real TypeScript subscriber.

## What's still deliberately out of scope

Everything `docs/sdk-python-reference.md`'s own "what's out of scope" section already names remains true here too (multi-app-mode wiring, production images/`berth deploy` for Python apps, a packaged pip distribution) — this slice only closes the context-bus gap, nothing else.
