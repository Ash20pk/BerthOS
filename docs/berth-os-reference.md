# `berth os` Reference — fixing agent-dev cold start

This doc covers the `berth os up`/`down`/`status` commands and `Computer.connect()` — the mechanics of keeping one Berth OS running and reconnecting to it. For what a Berth OS actually *is* (resident apps, capability enforcement, context bus, semantic FS), see [What is a Berth OS?](./berth-os.md) first if you haven't already.

`Computer.boot()` (`@berth/agents`) builds a fresh production image and starts a brand-new container on every call — correct for a one-shot script, but real seconds of latency (image build, container start, `on_install`, the context-bus/semantic-fs daemons, `agent-init`'s Landlock setup) paid again on *every* run while iterating on agent code. `berth os up` moves that cost out of the loop: build and boot once, then reconnect instantly for as many runs as you need.

## The commands

```bash
berth os up <name> --apps=<dir1>,<dir2>,...   # or --config=<path>
berth os status [<name>]                       # omit <name> to list every recorded instance
berth os down <name>
```

### `berth os up`

Builds a production image for the given resident apps and starts a container that stays running after the command returns (unlike `berth dev`'s hot-reload loop or `berth test`'s one-shot container, both of which tear down when their own process ends).

- `--apps=<dir1>,<dir2>,...` — comma-separated resident app directories, relative to the current directory.
- `--config=<path>` — a small YAML file instead, for anything more than a couple of apps or anything meant to be checked in and reused:

  ```yaml
  name: my-agent
  apps:
    - apps/filesystem
    - apps/notes
  network: my-net   # optional — see Crew.networked()
  ```

  Not a new manifest format: each entry under `apps:` is still just a directory containing its own `berth.yml`, loaded with the same `loadManifest()` any other multi-app path uses.
- `--network=<name>` — join a Docker network (overrides the config file's `network:`, if both are given).
- The instance name is, in order: the positional `<name>` argument, then the config file's `name:`, then the first app's own manifest `name`.

Same v1 constraints as `berth dev --apps=`/`berth test --apps=`: at most one app across the set may declare `browser:*`, `terminal:*`, or `network:peer:*` (one Xvfb/VNC display, one ttyd port, one `wg0` interface per container).

### `berth os status`

Lists every instance recorded under `~/.berth/os/` and whether its container is still actually running (a stopped/removed container doesn't clean up its own record — `berth os down` does that).

### `berth os down <name>`

Stops and removes the container, removes the image `berth os up` built, and deletes the recorded state — full cleanup, mirroring what `Computer.stop()` does for a `Computer.boot()`-created container.

## Connecting from agent code

```ts
import { createAgent, runAgent, Computer } from "@berth/agents";

// full form — keep the Computer/Agent handles
const { agent, computer } = await createAgent({ connect: "my-agent", llm: createAnthropicProvider() });

// dead-simple form — one call per task
const result = await runAgent({ connect: "my-agent", task: "..." });

// or just the Computer, with no Agent/LLM involved at all
const computer = await Computer.connect({ name: "my-agent" });
```

`connect` is mutually exclusive with `apps` on `createAgent()`/`runAgent()` — pass one or the other.

This is the natural pairing for a long-lived server process: [`examples/agents/agent-server`](../examples/agents/agent-server) boots (or `connect`s, via `BERTH_OS_CONNECT=<name>`) a `Computer`/`Agent` once at startup and answers HTTP requests against it — restarting the server itself (e.g. on every code change during development) no longer means rebuilding the sandbox too.

## How it works

`Computer.connect({name})` reads `~/.berth/os/<name>.json` (written by `berth os up`), re-derives a `Docker.Container` handle via `docker.getContainer(containerName)` + `inspect()` (the same reconnect idiom `berth logs`/`berth rpc`/`berth mcp`/`berth snapshot create` already use against deterministically-named containers), and dispatches every tool call through `invokeAppExport()` — the same docker-exec + Unix-socket relay multi-app mode already uses to reach a specific app in an already-running container from a fresh host process (see [multi-app reference](./multi-app-reference.md)).

**`berth os up` always forces the multi-app entrypoint branch, even for a single app.** `Computer.boot()`'s single-app path attaches to the container's own PID 1 stdio (`createStdioRpcClient`) — a connection only the process that started the container can hold, since a second, later process has no way to reattach to another process's already-open stdio stream. `invokeAppExport()`'s per-app Unix socket has no such restriction: any process that knows the container's name can reach it via a fresh `docker exec` per call. So `berth os up` builds with `forceCompanionLayout` (`@berth/docker-orchestrator`'s `buildImage()`) and always passes a non-empty `apps` array to `startContainer()` — even a one-element one — so entrypoint.sh always takes its multi-app branch and always opens `/tmp/berth-rpc/<appName>.sock`, regardless of how many apps are loaded.

**`computer.stop()` is a no-op for a connected Computer.** A `Computer.boot()`-created Computer owns the container and image it created — `stop()` tears both down. A connected Computer didn't create anything and has no business tearing down a container other runs (or other agent processes) may still be using — so `stop()` on it does nothing. This is what makes `runAgent({connect: "...", task: "..."})` safe to call repeatedly against the same `berth os up` instance: its `finally { computer.stop() }` is always safe to run, it just doesn't do anything when `connect` was used. Use `berth os down <name>` to actually tear the instance down.

## State file

`~/.berth/os/<name>.json` — the same "small local record keyed by name, under `~/.berth/`" shape as `@berth/cli`'s `~/.berth/fleets/<fleet>.json` (fleet-state.ts) and `~/.berth/snapshots/`. Global rather than project-local, since an agent script calling `Computer.connect()` may run from any directory, not just the one `berth os up` was invoked from.

```json
{
  "name": "my-agent",
  "containerName": "berth-os-my-agent",
  "image": "berth-os/my-agent:latest",
  "apps": [{ "name": "filesystem", "appDir": "/absolute/path/to/apps/filesystem" }],
  "network": null,
  "startedAt": "2026-08-02T12:00:00.000Z"
}
```

## Scope

- **Local Docker only** — same as the rest of `@berth/agents` and `berth dev`/`test`. No equivalent exists for E2B/Daytona/K8s fleets today.
- **One container per name** — `berth os up <name>` refuses to rebuild over an already-running instance of the same name; run `berth os down <name>` first.
- **No automatic idle shutdown** — a `berth os up` instance keeps running (and consuming resources) until you explicitly `berth os down` it or stop Docker.
