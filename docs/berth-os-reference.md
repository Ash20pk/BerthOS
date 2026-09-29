# Berth OS and `berth os`

A Berth OS is the sandbox your agent's tools run in: one Docker container holding one or more resident apps, each under its own kernel-enforced policy. In code it's the `Computer` class. `Computer.boot()` builds and starts a fresh one on every call; `berth os up` starts one that stays running, so your agent code can reconnect to it in milliseconds instead of paying the build and boot again.

> `Computer`, `createAgent()` and `runAgent()` come from the experimental agent framework (`@berthos/agents`), which isn't published to npm. Use it from a clone of this repo.

## What's inside one

- **Resident apps.** Each app is a `berth.yml` plus code, and its exports become tools. See [Resident apps](./resident-apps.md).
- **Kernel enforcement.** Each app's declared capabilities are compiled into a Landlock and seccomp policy and applied before the app starts. See [enforcement](./kernel-enforcement.md).
- **Several apps, kept apart.** Apps share the container but each runs as its own uid with its own policy. See [several apps in one sandbox](./multi-app-reference.md).
- **Context bus.** Pub/sub between the apps in one sandbox. See the [context bus reference](./context-bus-reference.md).
- **Semantic FS.** A filesystem at `/context` whose files carry tags about why they exist, searchable by those tags. See the [semantic FS reference](./semantic-fs-reference.md).

It's the same runtime `berth dev`, `berth test` and `berth deploy` use.

## Keep one running

```bash
berth os up my-agent --apps=apps/filesystem,apps/notes
berth os status              # every recorded instance, running or stopped
berth os down my-agent
```

Then connect from agent code:

```ts
import { Computer, createAgent, runAgent, createAnthropicProvider } from "@berthos/agents";

// Just the Computer, no LLM
const computer = await Computer.connect({ name: "my-agent" });

// An Agent on top of it
const { agent } = await createAgent({ connect: "my-agent", llm: createAnthropicProvider() });

// One call per task
const result = await runAgent({ connect: "my-agent", task: "..." });
```

Several agents can share one instance, each seeing only some of its apps:

```ts
const computer = await Computer.connect({ name: "my-agent", apps: ["filesystem"] });
await createAgent({ connect: { name: "my-agent", apps: ["filesystem"] }, llm });
```

`computer.stop()` does nothing on a connected Computer, because other runs may still be using the container. That makes `runAgent({ connect })` safe to call over and over. Run `berth os down` when you want it gone.

For a long-lived server, see [`examples/agents/agent-server`](../examples/agents/agent-server): set `BERTH_OS_CONNECT=<name>` and restarting the server doesn't rebuild the sandbox.

## `berth os up`

```bash
berth os up [<name>] --apps=<dir1>,<dir2>,...
berth os up [<name>] --config=<path>
```

Builds a production image for the apps and starts a container that keeps running after the command returns.

| Flag | What it does |
|---|---|
| `--apps=<dirs>` | Comma-separated app directories, relative to the current directory. |
| `--config=<path>` | A YAML file listing the apps instead (see below). Pass `--apps` or `--config`, not both. |
| `--network=<name>` | Join a Docker network (see `Crew.networked()`). Overrides the config file's `network:`. |
| `--env=<NAME or NAME=value>` | A variable for the sandbox; repeatable. `NAME` alone takes the value from your shell's environment, keeping it out of shell history; `NAME=value` is visible in history and `ps`, so don't use it for a secret. A name an app declares under `secrets:` reaches that app only; any other name reaches every app, with a warning ([secrets](./secrets-reference.md)). Never saved in the state file. Ignored, with a warning, if the instance is already up. |
| `--env-file=<path>` | A dotenv file of variables, applied before `--env`. Quoted values may span lines. |
| `--http-rpc` | Also expose the app's exports over HTTP on a host port, for a client with no Docker access, such as the [Python client](./agents-python-reference.md). The URL and a fresh bearer token are printed and saved in the state file. |
| `--http-rpc-app=<name>` | Which loaded app serves the HTTP bridge. Defaults to the first. Needs `--http-rpc`. |

The config file:

```yaml
name: my-agent
apps:
  - apps/filesystem
  - apps/notes
network: my-net   # optional
```

App paths in the config file are relative to the file itself. Each entry is a directory with its own `berth.yml`.

The instance name is the positional `<name>`, else the config's `name:`, else the first app's manifest `name`. The container is named `berth-os-<name>`.

If an instance with that name is already running, `up` says so and does nothing; run `berth os down` first to rebuild it. A stopped container left over under the name is removed automatically.

Across the loaded apps, at most one may declare each of `browser:*`, `terminal:*`, `network:peer:*`, and `browser:navigate:*`/`network:host:*` (one display, one terminal port, one mesh interface, one egress proxy per container). App names must be unique.

## `berth os status` and `berth os down`

`berth os status [<name>]` lists each recorded instance with `running` or `stopped`, its container, its apps and, if set, its HTTP bridge URL. A container that stopped on its own keeps its record until you run `down`.

`berth os down <name>` stops and removes the container, removes the image, and deletes the record.

## The HTTP bridge

`Computer.connect()` reaches apps through `docker exec`, so it only works from a process that can talk to Docker on the same host. `--http-rpc` is the alternative: a bearer-token-protected HTTP listener on `127.0.0.1`. It runs inside one app and serves only that app's exports, so choose it with `--http-rpc-app` when you load more than one.

## State file

`berth os up` writes `~/.berth/os/<name>.json` (mode `0600`, in a `0700` directory, since it can hold the bridge token). `Computer.connect()` reads it, so agent code can connect from any directory.

```json
{
  "name": "my-agent",
  "containerName": "berth-os-my-agent",
  "image": "berth-os/my-agent:latest",
  "apps": [{ "name": "filesystem", "appDir": "/absolute/path/to/apps/filesystem" }],
  "network": "my-net",
  "startedAt": "2026-08-02T12:00:00.000Z",
  "httpRpc": { "url": "http://127.0.0.1:54321", "token": "<64 hex chars>", "app": "filesystem" }
}
```

`network` appears only with `--network`, and `httpRpc` only with `--http-rpc`. `httpRpc.app` is omitted for a single-app instance.

## Limits

- **Local Docker only.** `berth deploy` ships the same sandbox to E2B, Daytona or Kubernetes, but you can't reconnect to a deployed one this way yet.
- **No idle shutdown.** An instance runs, and uses resources, until you `berth os down` it or stop Docker.
- **`connect` wins over `apps`.** `createAgent()` and `runAgent()` don't reject both together; if you pass `connect`, `apps` is ignored.
