# Quickstart

Clone-to-running, plus the CLI surface and the repository map. If you want the
resident-app-authoring walkthrough instead, that's
[docs/getting-started.md](./getting-started.md); if you want to know whether your
host can enforce anything, that's
[docs/kernel-enforcement.md](./kernel-enforcement.md).

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

`pnpm build` compiles every package in dependency order through Turborepo: `@berth/manifest-schema` first, then `@berth/sdk`, `@berth/docker-orchestrator`, `@berth/agents` and the deploy adapters, and finally `@berth/cli`.

## See enforcement, with no API key

```bash
cd examples/kernel-says-no && pnpm start
```

Two writes through one resident app's `write_file` tool: one inside its declared
`filesystem:write:/workspace`, one outside it. The second comes back `EACCES`
from the kernel. Details, and what the example does on a host that can't enforce:
[`examples/kernel-says-no`](../examples/kernel-says-no).

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

Want a live browser you can actually watch? `apps/browser-native` declares `browser:navigate:*`, so `berth dev` prints a noVNC URL you can open in a tab and watch the sandboxed Chromium instance live.

```bash
cd apps/browser-native
pnpm exec berth dev
```

## Scaffold your own resident app

```bash
pnpm exec berth init my-app
cd my-app
pnpm exec berth dev
```

`berth init` asks for a name and a starting template (`hello-world` or `browser-native`), scaffolds `berth.yml` plus SDK boilerplate, runs `pnpm install`, and validates the manifest before handing control back to you. Pass `--template` to skip the prompt, or `--registry=<url>` to scaffold from a published app instead of a bundled template. Check [Resident apps](./resident-apps.md) for the full anatomy of what just got scaffolded.

## Testing and deploying

```bash
pnpm exec berth test              # build prod image, validate exports, run stub invocations + your own tests
pnpm exec berth test --json       # CI-friendly output

berth deploy --fleet=e2b          # or --fleet=daytona, --fleet=k8s, or an alias from ~/.berthrc
```

## Releasing

`@berth/*` is not published to npm yet, but the pipeline is real and dry-run-verified: `pnpm publish:npm:dry-run` (root `package.json`) builds every workspace package and packs each non-private one (everything under `packages/`, skipping `apps/`/`examples/`/test fixtures, which are all `"private": true`) exactly as `npm publish` would, without uploading. `.github/workflows/publish-npm.yml` and `.github/workflows/publish-pypi.yml` run that same pipeline (plus the `berth-agents` PyPI package's own build) from CI — both `workflow_dispatch`-only, dry-run by default, and only publish for real when a human explicitly flips `dry_run` to `false` on a manual run.

## CLI reference

| Command | What it does |
|---|---|
| `berth doctor [--json]` | Check whether this host can actually enforce capabilities, and say so plainly. Exits non-zero when it can't — see [the doctor reference](./doctor-reference.md) |
| `berth init <name>` | Scaffold a new resident app from a template |
| `berth dev` | Build a dev image, run it, hot-reload on source changes |
| `berth test` | Build the production image, validate exports against `berth.yml`, invoke each with a schema-valid stub, run your own `npm test` |
| `berth eval <file> [--history]` | Run a `@berth/agents` eval suite against a real Agent/Crew and check assertions about *behavior* — distinct from `berth test`'s manifest/export shape check; `--history` lists a suite's prior recorded runs |
| `berth agent run <file.yml> <task>` | Run a task against an Agent declared in a YAML config file — no code needed for the common case |
| `berth crew run <file.yml> <task>` | Run a task against a `sequential`/`parallel`/`withManager` Crew declared in a YAML config file |
| `berth deploy --fleet=<e2b\|daytona\|k8s> [--region=<value>]` | Deploy to a remote sandbox provider — `--region` meaning differs per adapter (Daytona snapshot region, k8s node selector, no-op on E2B) |
| `berth logs <app>` | Stream logs from an already-running dev or fleet container |
| `berth rpc <app> --export=<name> --input=<json>` | Call a resident app's export directly from the host |
| `berth mcp --app=<name> [--only=<export1>,<export2>] [--warm] [--no-boot]` | Serve an app's exports as MCP tools, for Claude Code/Desktop/Cursor or any MCP client — boots the sandbox itself if none is running (`--no-boot` to attach only), `--only` scopes which exports get bridged, `--warm` pre-builds and exits. See [mcp-quickstart.md](./mcp-quickstart.md) |
| `berth publish --registry=<url> [--token=<value>]` | Build and publish the app to a running app registry — `--token` is required to publish a new version of a name someone already published |
| `berth snapshot create\|list\|restore [--fleet=<name>]` | Checkpoint and restore a container plus its semantic-fs context data — `--fleet` pauses/resumes (E2B) or snapshots (Daytona) a remote instance instead |
| `berth snapshot fork <app> --fleet=<name>` | Fork a running remote instance into a new, independent clone (Daytona only) |
| `berth grants list\|approve\|deny [--token=<value>]` | Review and resolve pending human-approval capability requests — `approve`/`deny` need the grants-server operator token |
| `berth fleet status <fleet>` | Check the state of a configured remote fleet (`e2b`, `daytona`, or a `~/.berthrc` alias) |
| `berth fleet scale <fleet> --count=<n>` | Manually scale this app's instances on a fleet up or down to a target count — not automatic load-based autoscaling |
| `berth os up\|down\|status` | Boot a long-lived Berth OS once, then reconnect to it instantly instead of rebuilding on every dev iteration |

Run `berth <command> --help` to see the flags. A few of these deserve their own doc: [MCP bridge](./mcp-bridge-reference.md), [app registry](./app-registry-reference.md), [computer snapshots](./computer-snapshots-reference.md), [capability tokens and grants](./capability-tokens-reference.md), [K8s adapter](./k8s-adapter-reference.md), [what is a Berth OS](./berth-os.md), and [the `berth os` command reference for cold start](./berth-os-reference.md).

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
  grants-server/       human approval service for capability grants (Fastify + SQLite)
  mesh-coordinator/    coordination service for the WireGuard mesh: allocates IPs, exchanges keys, mutually matches peers
  mesh-daemon/         Rust daemon that reconciles a sandbox's WireGuard config against mesh-coordinator's state
  adapters/            deploy adapters for E2B, Daytona, and Kubernetes
  cli/                 the `berth` CLI: init, dev, test, publish, deploy, os
  sdk-python/          Python resident app SDK, wire-protocol compatible with @berth/sdk
  agents/              computer, then agent, then tool: boots a Berth OS from resident apps, drives it with any LLM provider, composes multi-agent Crews
  agents-python/       Python Agent/Crew core (checkpointing, streaming, structured-output repair, all Crew shapes but networked) plus Computer.connect() over berth os up --http-rpc for a real sandbox's tools — no Computer.boot() yet
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
  agents/              agent examples that depend on @berth/agents as a real (workspace:*) package dependency (simple-agent/ is computer, agent, tool; agent-server/ serves the agent over HTTP instead of driving something itself)
```
