# Python SDK reference

`berthos-sdk` lets you write a resident app in Python. It uses the same `berth.yml` and the same export protocol as the TypeScript [`@berthos/sdk`](./sdk-reference.md), so a Python app's exports look identical to an agent, and it can publish and subscribe on the context bus alongside TypeScript apps.

```bash
pip install berthos-sdk        # imported as berth_sdk; Python 3.11+
```

## Example

`berth.yml`:

```yaml
name: hello-world-py
version: 0.1.0
capabilities: []
exports:
  - name: greet
    input: { name: string }
    output: { message: string }
```

`src/app.py`:

```python
from berth_sdk import define_app
from pydantic import BaseModel


class GreetInput(BaseModel):
    name: str


class GreetOutput(BaseModel):
    message: str


def greet(inp: GreetInput) -> GreetOutput:
    return GreetOutput(message=f"Hello, {inp.name}!")


def setup(app):
    app.export("greet", greet, input_model=GreetInput, output_model=GreetOutput)


app = define_app(setup)
```

The runtime loads `src/app.py` and looks for a module-level variable named `app`. A full example is [`apps/hello-world-py`](../apps/hello-world-py).

## Running a Python app

Declare the runtime in `berth.yml`:

```yaml
name: my-app
version: 0.1.0
runtime: python
```

Then run it like any other app: `berth dev`, `berth mcp`, `berth os up`, or `Computer.boot()`. A Python app can share a sandbox with TypeScript apps; each is started with its own runtime, and they talk over the same context bus.

Every sandbox image carries the SDK at `/opt/berth/sdk-python`, and already has `pydantic`, `pyyaml` and `protobuf`. When the repo is bind-mounted (`berth dev` in a clone), the repo's own `packages/sdk-python` is used instead, so SDK edits need no rebuild. Your capabilities are compiled into the same kernel policy a TypeScript app gets. Put your own dependencies in `on_install` (`pip install -r requirements.txt`).

## How an app boots

1. Load and validate `berth.yml`.
2. Import the entry file and find `app`.
3. Check the app's exports against `berth.yml`'s `exports:`, and stop with an error if they differ.
4. Run `on_install` hooks.
5. Connect to the context bus.
6. Run `on_agent_ready` hooks with an `AppContext`.
7. Log `[berth:runtime] "<name>" ready` and serve exports.

## API

### `define_app(setup) -> BerthApp`

Calls `setup(app)` and returns the app. Assign the result to a module-level `app`.

### `app.export(name, handler, input_model=None, output_model=None)`

Registers an export. `name` must match an entry in `berth.yml`'s `exports:`, and registering the same name twice raises `ValueError`.

- With `input_model` (a pydantic `BaseModel` subclass), the handler receives a validated model instance. Without it, the handler receives the raw input (usually a `dict`, or `None`).
- With `output_model`, a return value that isn't already an instance is validated into one. A pydantic model is sent back as its `model_dump()`; anything else is sent as returned.
- A raised exception is sent back to the caller as an error; it doesn't stop the app.

### `app.on_install(fn)`

Registers `fn()` to run once at startup, before `on_agent_ready`, inside the sandboxed process. For build-time setup, use `berth.yml`'s [`on_install`](./manifest-reference.md#on_install-default-).

### `app.on_agent_ready(fn)`

Registers `fn(ctx)` to run once at startup, before exports are served. `ctx` is an `AppContext`:

| Attribute | Type |
|---|---|
| `ctx.manifest` | `BerthManifest` |
| `ctx.context_bus` | context bus client; see the [context bus reference](./sdk-python-context-bus-reference.md) |

Hooks are plain functions, not `async`. A handler only receives its input, so keep `ctx.context_bus` in a module-level variable if an export needs it.

### Manifest helpers

| Name | What it does |
|---|---|
| `load_manifest(path) -> BerthManifest` | Reads and validates a `berth.yml` |
| `BerthManifest`, `ExportSpec` | Pydantic models for the manifest and one export |
| `parse_capability(s)` | Splits `namespace:action:scope`; raises `ValueError` if malformed |
| `matches_capability(granted, requested) -> bool` | Namespace and action match exactly; scope matches with `*` globs |

`BerthManifest` validates `name`, `version`, `description`, `capabilities`, `exports`, `on_install` and `on_agent_ready`. Other fields (`secrets`, `expose`, `governs`, `governance`, `resources`) are accepted but not checked; use `@berthos/manifest-schema` for full validation.

## Protocol

Exports are served as line-delimited JSON on stdio, and also on a Unix socket when `BERTH_RPC_SOCKET` is set:

```json
{"id": "1", "export": "greet", "input": {"name": "Ada"}}
{"id": "1", "result": {"message": "Hello, Ada!"}}
{"id": "2", "error": "no such export \"nope\""}
```

## Environment variables

| Variable | Default |
|---|---|
| `BERTH_APP_RUNTIME` | Overrides the manifest's `runtime` for a single-app sandbox. Leave it unset. |
| `BERTH_MANIFEST_PATH` | `./berth.yml` |
| `BERTH_APP_ENTRY` | `./src/app.py` |
| `BERTH_RPC_SOCKET` | unset (stdio only) |
| `BERTH_CONTEXT_BUS_SOCKET` | `/tmp/berth-context-bus.sock` |

## Limits

- **One app per sandbox.** A Python app can't be a companion in a multi-app sandbox, so it can't use `app:invoke:` or be governed by another app.
- **No `network:bind:` or `network:peer:`.** The Python policy compiler ignores them, so a Python app can't listen on a port or join the mesh.
- **No semantic filesystem client, `requestCapability` or `configureEgressProxy`.** Reading and writing files under `/context` works as ordinary file I/O. To use the egress proxy, point your HTTP client at `$BERTH_EGRESS_PROXY_URL`.
