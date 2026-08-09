# `berth os` reference: fixing agent-dev cold start

This doc covers the `berth os up`, `down`, and `status` commands, plus `Computer.connect()`: the mechanics of keeping one Berth OS running and reconnecting to it. If you haven't yet, read [What is a Berth OS?](./berth-os.md) first for what a Berth OS actually is (resident apps, capability enforcement, context bus, semantic FS).

Here's the problem this solves. `Computer.boot()` (from `@berth/agents`) builds a fresh production image and starts a brand-new container on every single call. That's correct for a one-shot script, but you'll feel it as real seconds of latency (image build, container start, `on_install`, the context-bus and semantic-fs daemons, `agent-init`'s Landlock setup) paid again on every run while you're iterating on agent code. `berth os up` moves that cost out of the loop. Build and boot once, then reconnect instantly for as many runs as you need.

## The commands

```bash
berth os up <name> --apps=<dir1>,<dir2>,...   # or --config=<path>
berth os status [<name>]                       # omit <name> to list every recorded instance
berth os down <name>
```

### `berth os up`

Builds a production image for the given resident apps and starts a container that stays running after the command returns. That's different from `berth dev`'s hot-reload loop or `berth test`'s one-shot container, both of which tear down when their own process ends.

- `--apps=<dir1>,<dir2>,...`: comma-separated resident app directories, relative to the current directory.
- `--config=<path>`: a small YAML file instead, worth reaching for once you have more than a couple of apps, or anything meant to be checked in and reused.

  ```yaml
  name: my-agent
  apps:
    - apps/filesystem
    - apps/notes
  network: my-net   # optional, see Crew.networked()
  ```

  This isn't a new manifest format. Each entry under `apps:` is still just a directory containing its own `berth.yml`, loaded with the same `loadManifest()` any other multi-app path uses.
- `--network=<name>`: join a Docker network (overrides the config file's `network:`, if both are given).
- `--http-rpc`: also expose `@berth/sdk`'s HTTP RPC bridge on a host port — the way a process with no Docker API access (a Python client, see [`docs/agents-python-reference.md`](./agents-python-reference.md)) reaches this instance's exports. `--http-rpc-app=<name>` picks which loaded app binds it when there's more than one (defaults to the first); the bridge only ever serves that one app's exports (see below). The resulting URL and a freshly generated bearer token are printed and recorded in the state file.
- The instance name comes from, in order: the positional `<name>` argument, then the config file's `name:`, then the first app's own manifest `name`.

Same v1 constraints as `berth dev --apps=` and `berth test --apps=`: at most one app across the set can declare `browser:*`, `terminal:*`, or `network:peer:*` (one Xvfb/VNC display, one ttyd port, one `wg0` interface per container).

### `berth os status`

Lists every instance recorded under `~/.berth/os/` and tells you whether its container is actually still running. A stopped or removed container doesn't clean up its own record. `berth os down` does that part.

### `berth os down <name>`

Stops and removes the container, removes the image `berth os up` built, and deletes the recorded state. Full cleanup, the same thing `Computer.stop()` does for a container `Computer.boot()` created.

## Connecting from agent code

Keep the `Computer`/`Agent` handles around:

```ts
import { createAgent, createAnthropicProvider } from "@berth/agents";

const { agent, computer } = await createAgent({ connect: "my-agent", llm: createAnthropicProvider() });
```

Or one call per task:

```ts
import { runAgent } from "@berth/agents";

const result = await runAgent({ connect: "my-agent", task: "..." });
```

Or just the `Computer`, with no `Agent`/LLM involved at all:

```ts
import { Computer } from "@berth/agents";

const computer = await Computer.connect({ name: "my-agent" });
```

`connect` and `apps` aren't validated against each other on `createAgent()`/`runAgent()` the way `--apps`/`--config` are on `berth os up` (which hard-errors if you pass both). Pass `connect` and it silently takes precedence — `apps` is just never read. Pass one or the other to avoid relying on that precedence.

This is the natural pairing for a long-lived server process. [`examples/agents/agent-server`](../examples/agents/agent-server) boots (or connects, via `BERTH_OS_CONNECT=<name>`) a `Computer`/`Agent` once at startup and answers HTTP requests against it. Restarting the server itself, say on every code change during development, no longer means rebuilding the sandbox too.

## How it works

`Computer.connect({name})` reads `~/.berth/os/<name>.json` (written by `berth os up`), re-derives a `Docker.Container` handle through `docker.getContainer(containerName)` plus `inspect()` (the same reconnect idiom `berth logs`, `berth rpc`, `berth mcp`, and `berth snapshot create` already use against deterministically-named containers), and dispatches every tool call through `invokeAppExport()`. That's the same docker-exec-plus-Unix-socket relay multi-app mode already uses to reach a specific app in an already-running container from a fresh host process. See the [multi-app reference](./multi-app-reference.md).

**`berth os up` always forces the multi-app entrypoint branch, even for a single app.** Here's why. `Computer.boot()`'s single-app path attaches to the container's own PID 1 stdio through `createStdioRpcClient`, and only the process that started the container can hold that connection. A second, later process has no way to reattach to another process's already-open stdio stream. `invokeAppExport()`'s per-app Unix socket has no such restriction: any process that knows the container's name can reach it through a fresh `docker exec` per call. So `berth os up` builds with `forceCompanionLayout` (part of `@berth/docker-orchestrator`'s `buildImage()`) and always passes a non-empty `apps` array to `startContainer()`, even a one-element one, so `entrypoint.sh` always takes its multi-app branch and always opens `/run/berth/<appName>/rpc.sock`, no matter how many apps are loaded.

**`computer.stop()` is a no-op for a connected Computer.** A Computer that `Computer.boot()` created owns the container and image it made, so `stop()` tears both down. A connected Computer didn't create anything, and it has no business tearing down a container that other runs, or other agent processes, might still be using. So `stop()` on it does nothing. That's what makes `runAgent({connect: "...", task: "..."})` safe to call over and over against the same `berth os up` instance: its `finally { computer.stop() }` always runs safely, it just doesn't do anything when `connect` was used. Use `berth os down <name>` when you actually want to tear the instance down.

## Reaching an instance without Docker API access

`Computer.connect()`'s `invokeAppExport()` relay needs `docker exec` access — fine for another TypeScript process on the same host, useless for anything else. `--http-rpc` starts an in-app HTTP listener instead (`@berth/sdk`'s `startHttpRpcServer`, the same bridge `bootNetworkedAgent({fleet})` uses for a remote deploy), published to a host port, bearer-token-gated. **It only ever serves one app's exports** — the listener runs inside that one app's own `runtime.js` process and dispatches to its own `invokeExport`, with no path to a sibling app's exports in the same container — so `--http-rpc-app` matters the moment you load more than one app. This is what `packages/agents-python`'s `Computer.connect()` is built on; see [`docs/agents-python-reference.md`](./agents-python-reference.md) for the Python side.

## State file

`~/.berth/os/<name>.json` follows the same pattern as `@berth/cli`'s `~/.berth/fleets/<fleet>.json` (fleet-state.ts) and `~/.berth/snapshots/`: a small local record keyed by name, living under `~/.berth/`. It's global rather than project-local, since an agent script calling `Computer.connect()` might run from any directory, not just the one `berth os up` was invoked from.

```json
{
  "name": "my-agent",
  "containerName": "berth-os-my-agent",
  "image": "berth-os/my-agent:latest",
  "apps": [{ "name": "filesystem", "appDir": "/absolute/path/to/apps/filesystem" }],
  "startedAt": "2026-08-02T12:00:00.000Z"
}
```

`network` is an optional field (`OsStateFile["network"]?: string` in `os-state.ts`) — when `--network` wasn't given, it's `undefined` on the object passed to `JSON.stringify()`, which drops the key entirely rather than emitting `"network": null`. It only appears in the file at all when an instance actually joined a Docker network.

`httpRpc` is the same kind of optional field, present only when started with `--http-rpc`:

```json
"httpRpc": { "url": "http://127.0.0.1:54321", "token": "a64-char-hex-string", "app": "filesystem" }
```

`app` itself is omitted for a single-app instance (there's no sibling to disambiguate, same convention `BERTH_HTTP_RPC_APP` uses). Nothing in this file is schema-validated on read — `JSON.parse(raw) as OsStateFile` is an unchecked cast — so an older state file without `httpRpc` just has it come back `undefined`, not an error.

## Scope

- **Local Docker only**, same as the rest of `@berth/agents` and `berth dev`/`test`. There's no equivalent for E2B, Daytona, or K8s fleets yet.
- **One container per name.** `berth os up <name>` won't rebuild over an already-running instance of the same name. Run `berth os down <name>` first.
- **No automatic idle shutdown.** A `berth os up` instance keeps running, and consuming resources, until you explicitly `berth os down` it or stop Docker.
