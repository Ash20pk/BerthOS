# Python SDK: context bus

The Python SDK's context bus client lets a Python resident app publish and subscribe to events from other apps in the same sandbox, including TypeScript apps. It talks to the same daemon as `@berthos/sdk`'s [`ContextBusClient`](./sdk-reference.md#contextbusclient). For the rest of the Python SDK, see the [Python SDK reference](./sdk-python-reference.md).

## Use it

The client arrives as `ctx.context_bus` in your `on_agent_ready` hook. Keep a reference if your exports need it:

```python
from berth_sdk import define_app
from pydantic import BaseModel

_bus = None


class FileCreated(BaseModel):
    path: str
    created_by: str


def on_ready(ctx):
    global _bus
    _bus = ctx.context_bus
    _bus.register("hello-world-py")
    _bus.subscribe("fs.file_created", lambda payload: print(f"new file: {payload['path']}"))


def publish_file_created(inp: FileCreated) -> None:
    _bus.publish("fs.file_created", {"path": inp.path, "createdBy": inp.created_by})


def setup(app):
    app.export("publish_file_created", publish_file_created, input_model=FileCreated)
    app.on_agent_ready(on_ready)


app = define_app(setup)
```

A TypeScript app subscribed to `fs.file_created`, such as [`apps/code-editor`](../apps/code-editor), receives this event unchanged.

## API

| Method | What it does |
|---|---|
| `register(app: str) -> None` | Identifies this app to the daemon |
| `publish(topic: str, payload) -> None` | Sends `payload`, encoded as JSON, to every subscriber of `topic` |
| `subscribe(topic: str, handler) -> unsubscribe` | Calls `handler(payload)` for each event on `topic`; call the returned function to stop |

The methods are synchronous, unlike the TypeScript client's `async` ones, because Python hooks are plain functions. Note that `register` takes the app name as a string, where TypeScript takes `{ app }`.

Subscription handlers run on a background thread that reads from the daemon, so guard any state they share with your export handlers.

## How it connects

At startup the runtime connects to the daemon's Unix socket at `$BERTH_CONTEXT_BUS_SOCKET` (default `/tmp/berth-context-bus.sock`), retrying for up to 2 seconds. Messages are protobuf frames, each prefixed with a 4-byte big-endian length, the same as the TypeScript client.

If the daemon can't be reached, for example when you run the app outside a sandbox, the runtime logs a warning and uses an in-process stand-in: `publish` delivers only to subscribers in the same process, and `register` does nothing.

See the [context bus reference](./context-bus-reference.md) for topics and the daemon itself.

## Regenerating the protobuf code

`berth_sdk/context_bus_pb2.py` is generated from `packages/sdk-python/proto/context_bus.proto`, a copy of `packages/sdk/proto/context_bus.proto` that must be kept in sync by hand. Regenerate it with `packages/sdk-python/scripts/gen_proto.sh`, which runs `python3 -m grpc_tools.protoc` (from `grpcio-tools`). Don't use a system `protoc`: it can be newer than the `protobuf` runtime on PyPI, and the generated code then fails to import with `VersionError: Detected incompatible Protobuf Gencode/Runtime versions`.
