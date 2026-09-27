# Quickstart

Clone-to-running, plus the CLI surface and the repository map. If you only want
to use Berth from an agent you already run, start with
[the MCP quickstart](./mcp-quickstart.md) instead — one command in your MCP
client's config, no code. If you want to know whether your host can enforce
anything, that's [docs/kernel-enforcement.md](./kernel-enforcement.md).

## Prerequisites

- Node.js 22+ (`nvm use` picks up your `.nvmrc`)
- Docker, running locally
- `corepack enable` (ships with Node 22 and manages pnpm for you)

Whether that Docker daemon's kernel can actually enforce a capability is a
separate question, and the one that decides what runs locally: see
[Kernel enforcement, by platform](./kernel-enforcement.md#kernel-enforcement-by-platform),
or just run `berth doctor`.

## Install and build

```bash
git clone https://github.com/Ash20pk/BerthOS
cd BerthOS
corepack enable
pnpm install
pnpm build
```

`pnpm build` compiles every package in dependency order through Turborepo: `@berthos/manifest-schema` first, then `@berthos/sdk`, `@berthos/docker-orchestrator`, `@berthos/agents` and the deploy adapters, and finally `@berthos/cli`.

## See enforcement, with no API key

> **On macOS or Windows, run `berth doctor` first.** These demos show a real
> kernel denial, so they need a kernel with Landlock. Docker Desktop's VM
> doesn't have it, and the demos exit non-zero rather than fake a pass — that's
> intended, not a bug. [docs/mac-enforcement.md](./mac-enforcement.md) is a
> four-flag Colima recipe (no kernel build) that gets `enforcement: ACTIVE`;
> Linux 5.13+ works as-is.

```bash
cd examples/kernel-says-no && pnpm start
```

Two writes through one resident app's `write_file` tool: one inside its declared
`filesystem:write:/workspace`, one outside it. The second comes back `EACCES`
from the kernel. Details, and what the example does on a host that can't enforce:
[`examples/kernel-says-no`](../examples/kernel-says-no).

Then work through the rest of the [examples catalog](../examples/README.md):
`prompt-injection` (a compromised model, refused by the kernel),
`no-egress` (code-exec with no network capability), and `audit-trail`
(tamper-evident records — this one needs neither a kernel nor an API key).

## Run an agent

[`examples/agents/simple-agent`](../examples/agents/simple-agent) boots a Berth OS from `apps/filesystem` and runs one task against it. Notice we never pass `llm`. It checks whether you have `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` set and picks accordingly.

```bash
cd examples/agents/simple-agent
export ANTHROPIC_API_KEY=sk-ant-...   # or OPENAI_API_KEY
pnpm start
```

On macOS or Windows, prefix that last command with `BERTH_ALLOW_UNENFORCED=1` — see the [platform table](./kernel-enforcement.md#kernel-enforcement-by-platform) for why.

That one call is `runAgent({ apps: "apps/filesystem", task: "..." })` under the hood. Head to [Building a Berth Agent](./berth-agents-guide.md#building-a-berth-agent) for the full API, multi-agent `Crew`s, and how to skip the boot cost entirely on every dev loop run with `berth os up`.

## Run a resident app directly

Want to build or inspect a resident app on its own, with no agent attached? Maybe you're authoring one. `berth dev` boots it with hot reload.

```bash
cd examples/resident-apps/hello-world
pnpm exec berth dev
```

```
Building dev image for "hello-world"...
Container started. Watching .../examples/resident-apps/hello-world/src and berth.yml for changes...
[berth:dev] "hello-world" declares no browser:* capability: no VNC ports exposed
[berth:dev] "hello-world" declares no terminal:* capability: no terminal port exposed
[berth:dev] [berth:runtime] "hello-world" ready
```

Edit `src/index.ts` and save. The container restarts on its own — `on_install` is baked into the image at build time, so a restart never re-runs it and this stays fast.

`hello-world` declares zero capabilities. `apps/notes` is the next step up: a stateful resident app (`add_note`/`list_notes`/`complete_note`, persisted to a JSON file) that declares `filesystem:write:/workspace` and publishes to the context bus on every write. Run it the same way, call an export with `berth rpc` or from an MCP client, and a write outside `/workspace` is refused by the kernel, not by convention.

```bash
cd apps/notes
pnpm exec berth dev
```

Want a live browser you can actually watch? `apps/browser-native` declares `browser:navigate:*`, so `berth dev` prints a noVNC URL:

```bash
cd apps/browser-native
pnpm exec berth dev
```

```
[berth:dev] noVNC:    http://127.0.0.1:<port>/vnc.html
[berth:dev] VNC:      127.0.0.1:<port>
[berth:dev]           password: <generated per boot>
```

Open the noVNC URL, enter that password, and you're watching the sandboxed Chromium instance live. Both ports are published on `127.0.0.1` only and the password is fresh on every boot — a live view of your agent's browser, with mouse and keyboard control, is not something to leave open to your LAN ([threat model](./threat-model.md)).

More apps to run the same way: [`apps/activity-feed`](../apps/activity-feed) fans in context-bus events from `filesystem` and `notes` (several containers composed purely over the bus, no direct RPC), and [`apps/terminal`](../apps/terminal) is a shared `tmux` shell the agent drives and a human can watch and type into over the web (`ttyd`), inheriting whatever capabilities `terminal` declares.

## Scaffold your own resident app

```bash
pnpm exec berth init my-app
cd my-app
pnpm exec berth dev
```

`berth init` asks for a name and a starting template (`hello-world` or `browser-native`), scaffolds `berth.yml` plus SDK boilerplate, runs `pnpm install`, and validates the manifest before handing control back to you. Pass `--template` to skip the prompt, or `--registry=<url>` to scaffold from a published app instead of a bundled template ([app registry](./app-registry-reference.md)). Check [Resident apps](./resident-apps.md) for the full anatomy of what just got scaffolded, [manifest-reference.md](./manifest-reference.md) for the full `berth.yml` schema, and [sdk-reference.md](./sdk-reference.md) for the SDK.

## Testing and deploying

```bash
pnpm exec berth test              # build prod image, validate exports, run stub invocations + your own tests
pnpm exec berth test --json       # CI-friendly output

berth deploy --fleet=e2b          # or --fleet=daytona, --fleet=k8s, or an alias from ~/.berthrc
```

## Releasing

Releases are cut from GitHub, never from a laptop: **Actions → Release → Run workflow**, enter a version (`x.y.z`), and leave *dry run* ticked to rehearse. `.github/workflows/release.yml` sets that version on the 12 public `@berthos/*` npm packages and the `berthos-sdk` Python package in lockstep (`scripts/set-version.mjs`), runs the same build, lint and test gate as every PR, and packs the exact files to publish. A dry run stops there. A real run then pushes a `chore(release): vx.y.z` commit and a `vx.y.z` tag to `main`, publishes the packed files to npm (with provenance) and PyPI (trusted publishing), and creates a GitHub Release with generated notes and an SBOM attached. If a publish step fails after the tag is pushed, **Re-run failed jobs** on the same run: both registries skip versions already published.

Nothing has been published yet. The first real run needs two one-time settings the workflow can't make itself: an `NPM_TOKEN` repository secret with publish rights to the `@berthos` scope, and a PyPI trusted publisher on `berthos-sdk` pointing at `release.yml` and the `pypi` environment. Both are described at the top of the workflow file.

## CLI reference

| Command | What it does |
|---|---|
| `berth doctor [--json]` | Check whether this host can actually enforce capabilities, and say so plainly. Exits non-zero when it can't — see [the doctor reference](./doctor-reference.md) |
| `berth init <name>` | Scaffold a new resident app from a template |
| `berth dev` | Build a dev image, run it, hot-reload on source changes |
| `berth test` | Build the production image, validate exports against `berth.yml`, invoke each with a schema-valid stub, run your own `npm test` |
| `berth eval <file> [--history]` | Run a `@berthos/agents` eval suite against a real Agent/Crew and check assertions about *behavior* — distinct from `berth test`'s manifest/export shape check; `--history` lists a suite's prior recorded runs |
| `berth agent run <file.yml> <task>` | Run a task against an Agent declared in a YAML config file — no code needed for the common case |
| `berth crew run <file.yml> <task>` | Run a task against a `sequential`/`parallel`/`withManager` Crew declared in a YAML config file |
| `berth deploy --fleet=<e2b\|daytona\|k8s> [--region=<value>]` | Deploy to a remote sandbox provider — `--region` meaning differs per adapter (Daytona snapshot region, k8s node selector, no-op on E2B) |
| `berth logs <app>` | Stream logs from an already-running dev or fleet container |
| `berth rpc <app> --export=<name> --input=<json>` | Call a resident app's export directly from the host |
| `berth mcp --app=<name> [--only=<export1>,<export2>] [--warm] [--no-boot]` | Serve an app's exports as MCP tools, for Claude Code/Desktop/Cursor or any MCP client — boots the sandbox itself if none is running (`--no-boot` to attach only), `--only` scopes which exports get bridged, `--warm` pre-builds and exits. See [mcp-quickstart.md](./mcp-quickstart.md) |
| `berth publish --registry=<url> [--token=<value>]` | Build and publish the app to a running app registry — `--token` is required to publish a new version of a name someone already published |
| `berth snapshot create\|list\|restore [--fleet=<name>]` | Checkpoint and restore a container plus its semantic-fs context data — `--fleet` pauses/resumes (E2B) or snapshots (Daytona) a remote instance instead |
| `berth snapshot fork <app> --fleet=<name>` | Fork a running remote instance into a new, independent clone (Daytona only) |
| `berth fleet status <fleet>` | Check the state of a configured remote fleet (`e2b`, `daytona`, or a `~/.berthrc` alias) |
| `berth fleet scale <fleet> --count=<n>` | Manually scale this app's instances on a fleet up or down to a target count — not automatic load-based autoscaling |
| `berth os up\|down\|status` | Boot a long-lived Berth OS once, then reconnect to it instantly instead of rebuilding on every dev iteration |

Run `berth <command> --help` to see the flags. A few of these deserve their own doc: [MCP bridge](./mcp-bridge-reference.md), [app registry](./app-registry-reference.md), [computer snapshots](./computer-snapshots-reference.md), [capability enforcement](./capability-tokens-reference.md), [K8s adapter](./k8s-adapter-reference.md), and [Berth OS and `berth os`](./berth-os-reference.md).

`berth eval`, `berth agent run` and `berth crew run` are the only commands that need
the agent framework, and `@berthos/cli` does not depend on it. Installing the CLI
gets you the sandbox and its evidence — `dev`, `mcp`, `doctor`, `attest`, `os`,
`snapshot` — not an LLM framework and its provider tree. The framework
(`@berthos/agents`) is experimental and not published, so those three commands work
from a clone of this repository, where it is built alongside the CLI. Run one of them
from an installed CLI and it says exactly that, rather than printing a
module-resolution trace.

## Repository layout

```
packages/
  manifest-schema/     berth.yml schema, validation, and capability parsing
  sdk/                 resident app SDK: defineApp(), lifecycle hooks, context bus client
  docker-orchestrator/ Alpine-based container lifecycle for a Berth OS
  context-bus-daemon/  Rust daemon for shared semantic memory across apps in one Berth OS
  agent-init/          Rust binary that applies a kernel-enforced (Landlock) capability policy before exec-ing the runtime
  semantic-fs-daemon/  Go/FUSE daemon, a filesystem searchable by its files' tags, backed by a SQLite metadata index
  registry-server/     local app registry for publish, discover, and install (Fastify + SQLite)
  mesh-coordinator/    coordination service for the WireGuard mesh: allocates IPs, exchanges keys, mutually matches peers
  mesh-daemon/         Rust daemon that reconciles a sandbox's WireGuard config against mesh-coordinator's state
  adapters/            deploy adapters for E2B, Daytona, and Kubernetes
  audit/               the hash-chained audit trail and the attestation record
  tls/                 certificate plumbing for the registry and mesh coordinator
  cli/                 the `berth` CLI: init, dev, test, doctor, mcp, attest, publish, deploy, os, snapshot
  sdk-python/          Python resident app SDK, wire-protocol compatible with @berthos/sdk
experimental/          the agent framework, frozen: a reference consumer of the sandbox, not part of it (see experimental/README.md)
  agents/              computer, then agent, then tool: boots a Berth OS from resident apps, drives it with any LLM provider, composes multi-agent Crews
  agents-python/       Python Agent/Crew core plus Computer.connect() over berth os up --http-rpc
  seam-*/              Berth tools exposed to the Claude Agent SDK and OpenAI Agents
apps/
  browser-native/      first-party resident app: headless Chromium plus VNC, also exposes search (DuckDuckGo, no API key)
  filesystem/          first-party resident app that reads and writes /workspace, publishes fs.file_created
  code-editor/         first-party resident app that reacts to fs.file_created through the context bus
  github-assistant/    first-party resident app, the original example manifest for this pattern, deployed and milestone-tested
  hello-world-py/      minimal Python resident app proving the Python SDK's RPC wire compatibility
  terminal/            first-party resident app: a shared shell (tmux + ttyd), driven by the agent and watchable live over the web
  activity-feed/       first-party resident app that fans in fs.file_created and notes.* into one queryable feed
  notes/               first-party resident app for stateful notes (add, list, complete), persisted to /workspace
  code-interpreter/    first-party resident app: run_code executes Python/JavaScript/shell as a real subprocess, kernel-sandboxed like every other app — no network unless you declare it
examples/
  kernel-says-no/      the hero demo: one resident app, two writes, one EACCES from the kernel — no LLM, no API key
  resident-apps/       resident app examples you run with `berth dev` (hello-world/ is the minimal, zero-capability one; http-fetch/ shows network:host:* + configureEgressProxy() on a plain, non-browser app)
  agents/              agent examples that depend on @berthos/agents as a real (workspace:*) package dependency (simple-agent/ is computer, agent, tool; agent-server/ serves the agent over HTTP instead of driving something itself)
```
