# Quickstart

Install Berth, watch the kernel refuse a write, run and scaffold a resident app, and find every CLI command. If you only want to use Berth from an agent you already run, [the MCP quickstart](./mcp-quickstart.md) is shorter: one entry in your MCP client's config, no code.

## Prerequisites

- Node.js 22+ (`nvm use` reads the repo's `.nvmrc`)
- Docker, running locally
- `corepack enable` (ships with Node 22 and manages pnpm)

Kernel enforcement needs Landlock (Linux 6.7+). Docker Desktop's VM on macOS and Windows doesn't have it. Run `berth doctor` to check your machine; see [enforcement by platform](./kernel-enforcement.md#kernel-enforcement-by-platform).

## Install and build

The CLI installs on its own with `npm install -g @berthos/cli`. The demos and first-party apps live in the repository, so to run them, clone and build:

```bash
git clone https://github.com/Ash20pk/BerthOS
cd BerthOS
corepack enable
pnpm install
pnpm build
```

The commands below write `berth`. In a clone without the global install, that's `node packages/cli/bin/berth.js` from the repo root (or `node ../../packages/cli/bin/berth.js` from inside an app's folder).

## See enforcement, with no API key

```bash
cd examples/kernel-says-no && pnpm start
```

The demo makes two writes through one resident app's `write_file` tool: one inside its declared `filesystem:write:/workspace`, one outside it. The kernel refuses the second with `EACCES`. See [`examples/kernel-says-no`](../examples/kernel-says-no).

> **On macOS or Windows, run `berth doctor --fix` first.** On a kernel without Landlock the demos exit non-zero instead of faking a pass. `--fix` sets up a Colima VM that enforces; the manual recipe is in [mac-enforcement.md](./mac-enforcement.md). Linux 6.7+ works as-is.

More demos are in the [examples catalog](../examples/README.md): `prompt-injection` (a compromised model, refused by the kernel), `no-egress` (code execution with no network), and `audit-trail` (tamper-evident records; needs neither a Landlock kernel nor an API key).

## Run an agent

The agent framework (`@berthos/agents`) is experimental and not published, so this works from a clone only. [`examples/agents/simple-agent`](../examples/agents/simple-agent) boots a Berth OS from `apps/filesystem` and runs one task against it, picking Anthropic or OpenAI from whichever key you set:

```bash
cd examples/agents/simple-agent
export ANTHROPIC_API_KEY=sk-ant-...   # or OPENAI_API_KEY
pnpm start
```

On macOS or Windows without an enforcing VM, prefix `pnpm start` with `BERTH_ALLOW_UNENFORCED=1`. The apps then run unrestricted, with a warning. Under the hood this is `runAgent({ apps: "apps/filesystem", task: "..." })`; the full API is in [Building a Berth Agent](./berth-agents-guide.md#building-a-berth-agent).

## Run a resident app directly

`berth dev` builds and boots one resident app in the sandbox, with no agent attached, and restarts it when you save.

```bash
cd examples/resident-apps/hello-world
berth dev
```

```
Building dev image for "hello-world"...
Container started. Watching .../examples/resident-apps/hello-world/src and berth.yml for changes...
[berth:dev] "hello-world" declares no browser:* capability: no VNC ports exposed
[berth:dev] "hello-world" declares no terminal:* capability: no terminal port exposed
[berth:dev] [berth:runtime] "hello-world" ready
```

Edit `src/index.ts` and save; the container restarts. `on_install` runs at image build time, so a restart doesn't re-run it.

`hello-world` declares no capabilities. [`apps/notes`](../apps/notes) is the next step up: stateful notes (`add_note`, `list_notes`, `complete_note`) persisted to `/workspace`, with `filesystem:write:/workspace`. Run it the same way and call an export with `berth rpc` or from an MCP client. A write outside `/workspace` is refused by the kernel.

```bash
cd apps/notes
berth dev
```

To watch a live browser, run [`apps/browser-native`](../apps/browser-native). It declares `browser:navigate:*`, so `berth dev` prints a noVNC URL:

```bash
cd apps/browser-native
berth dev
```

```
[berth:dev] noVNC:    http://127.0.0.1:<port>/vnc.html
[berth:dev] VNC:      127.0.0.1:<port>
[berth:dev]           password: <generated per boot>
```

Open the URL and enter the password to watch and control the sandboxed Chromium. Both ports bind to `127.0.0.1` only and the password changes every boot.

Two more apps to try: [`apps/activity-feed`](../apps/activity-feed) collects context-bus events from `filesystem` and `notes` into one feed, and [`apps/terminal`](../apps/terminal) is a shared `tmux` shell the agent drives and you can watch and type into from the browser.

## Scaffold your own resident app

```bash
berth init my-app
cd my-app
berth dev
```

`berth init` asks for a name and a template (`hello-world` or `browser-native`), writes `berth.yml` and SDK boilerplate, runs `pnpm install`, and validates the manifest. `--template` skips the prompt; `--registry=<url>` scaffolds from a published app instead ([app registry](./app-registry-reference.md)).

Next: [Resident apps](./resident-apps.md) for the anatomy, the [manifest reference](./manifest-reference.md) for `berth.yml`, and the [SDK reference](./sdk-reference.md).

## Testing and deploying

```bash
berth test              # build the production image, check exports, call each one, run your npm test
berth test --json       # JSON output for CI

berth deploy --fleet=e2b          # or --fleet=daytona, --fleet=k8s, or an alias from ~/.berthrc
```

## CLI reference

| Command | What it does |
|---|---|
| `berth doctor [--json] [--fix] [--runtime=<name>]` | Check whether this machine's kernel can enforce capabilities. Exits `1` when it can't. See the [doctor reference](./doctor-reference.md) |
| `berth init [name] [--template=<name>] [--registry=<url>]` | Scaffold a new resident app |
| `berth dev [--apps=<paths>]` | Build a dev image, run it, restart on source changes |
| `berth test [--json] [--apps=<paths>]` | Build the production image, check exports against `berth.yml`, call each with a schema-valid stub, run your `npm test` |
| `berth rpc <app> --export=<name> --input=<json>` | Call a resident app's export from the host |
| `berth logs <app>` | Stream logs from a running dev or fleet container |
| `berth mcp --app=<name> [--app-dir=<path>] [--only=<a>,<b>] [--warm] [--no-boot]` | Serve an app's exports as MCP tools. Boots the sandbox if none is running. See the [MCP quickstart](./mcp-quickstart.md) |
| `berth attest <runId>` | Produce a record of a run and the enforcement measured for its boot. See [attestation](./attestation-reference.md) |
| `berth audit list\|verify` | Read or verify the hash-chained audit trail. See [audit](./audit-reference.md) |
| `berth deploy --fleet=<e2b\|daytona\|k8s\|alias> [--region=<value>] [--count=<n>]` | Deploy to a remote sandbox provider. `--region` means a snapshot region on Daytona, a node selector on k8s, and nothing on E2B |
| `berth fleet status <fleet>` | Show the state of a remote fleet (`e2b`, `daytona`, or a `~/.berthrc` alias) |
| `berth fleet scale <fleet> --count=<n>` | Set this app's instance count on a fleet. Manual, not autoscaling |
| `berth publish --registry=<url> [--token=<value>]` | Build and publish the app to an app registry. `--token` is required to publish a new version of a name someone already published |
| `berth snapshot create\|list\|restore [--fleet=<name>]` | Checkpoint and restore a container plus its semantic-fs data. With `--fleet`, pauses and resumes (E2B) or snapshots (Daytona) a remote instance |
| `berth snapshot fork <app> --fleet=<name>` | Clone a running remote instance (Daytona only) |
| `berth os up\|down\|status` | Boot a long-lived Berth OS once and reconnect to it instead of rebuilding each time. See [Berth OS](./berth-os-reference.md) |
| `berth tls init` | Create a CA and certificate for the registry and mesh coordinator. See [TLS](./tls-reference.md) |
| `berth agent run <file.yml> <task>` | Run a task against an Agent defined in YAML. Clone only |
| `berth crew run <file.yml> <task>` | Run a task against a `sequential`, `parallel` or `withManager` Crew defined in YAML. Clone only |
| `berth eval <file> [--history]` | Run an eval suite against a real Agent or Crew and check its behaviour. `--history` lists past runs. Clone only |

Run `berth <command> --help` for every flag. More detail: [MCP bridge](./mcp-bridge-reference.md), [app registry](./app-registry-reference.md), [snapshots](./computer-snapshots-reference.md), [capability enforcement](./capability-tokens-reference.md), [K8s adapter](./k8s-adapter-reference.md).

`berth agent run`, `berth crew run` and `berth eval` need the experimental agent framework, which `@berthos/cli` doesn't depend on and which isn't published. They work from a clone, where the framework is built alongside the CLI. From an installed CLI they print a message saying so.

## Releasing

Releases run from GitHub: **Actions → Release → Run workflow**, enter a version (`x.y.z`), and leave *dry run* ticked to rehearse. The workflow, `.github/workflows/release.yml`, must run on `main`.

1. It sets the version on the 12 public `@berthos/*` npm packages and the `berthos-sdk` Python package together (`scripts/set-version.mjs`), runs the same build, lint and test gate as every PR, and packs the exact files to publish. A dry run stops here.
2. A real run pushes a `chore(release): vx.y.z` commit and a `vx.y.z` tag to `main`.
3. The `npm` and `pypi` jobs wait for a maintainer to approve the GitHub environments of those names. One approval on the run page covers both.
4. It publishes the packed files to npm (with provenance) and PyPI (trusted publishing), then creates a GitHub Release with generated notes and an SBOM.

If a publish step fails after the tag is pushed, use **Re-run failed jobs** on the same run. Both registries skip versions already published.

After a release, **Actions → Fresh install → Run workflow** checks the published version the way a new user meets it: it installs the CLI from npm with pnpm 10 and pnpm 11, runs `berth doctor`, scaffolds and tests an app, boots it with `berth mcp`, and imports `berthos-sdk` from PyPI.

To retire a broken version, **Actions → Deprecate npm versions** takes a version range and a message, waits for approval on the `npm` environment, and marks that range on every `@berthos/*` package, so installing one prints a warning. It refuses a range that includes a current release. On PyPI the equivalent is yanking a release (pip skips a yanked release unless it's pinned exactly). PyPI has no API for that, so it's done on pypi.org: `berthos-sdk` → **Manage** → **Releases** → **Options** → **Yank**.

The workflow relies on one-time repository settings: GitHub environments `npm` and `pypi`, each limited to `main` with a required reviewer; an `NPM_TOKEN` secret with publish rights to the `@berthos` scope; and a PyPI trusted publisher on `berthos-sdk` pointing at `release.yml` and the `pypi` environment. The top of the workflow file describes each.

The agent framework under `experimental/` is not released.

## Repository layout

```
packages/
  manifest-schema/     berth.yml schema, validation, and capability parsing
  sdk/                 resident app SDK: defineApp(), lifecycle hooks, context bus client
  sdk-python/          Python resident app SDK, wire-compatible with @berthos/sdk
  cli/                 the `berth` CLI
  docker-orchestrator/ container lifecycle for a Berth OS, and the doctor checks
  agent-init/          Rust binary that applies the Landlock and seccomp policy before starting the app
  context-bus-daemon/  Rust daemon for shared memory between apps in one Berth OS
  semantic-fs-daemon/  Go/FUSE filesystem searchable by file tags, backed by SQLite
  registry-server/     local app registry for publish, discover, install (Fastify + SQLite)
  mesh-coordinator/    WireGuard mesh coordination: allocates IPs, exchanges keys, matches peers
  mesh-daemon/         Rust daemon that applies a sandbox's WireGuard config
  adapters/            deploy adapters for E2B, Daytona and Kubernetes
  audit/               the hash-chained audit trail and the attestation record
  tls/                 certificates for the registry and mesh coordinator
experimental/          the agent framework: experimental, unpublished (see experimental/README.md)
  agents/              Computer, Agent, Crew: boots a Berth OS and drives it with any LLM provider
  agents-python/       Python Agent/Crew, plus Computer.connect() over `berth os up --http-rpc`
  seam-*/              Berth tools for the Claude Agent SDK and OpenAI Agents
apps/
  filesystem/          read and write /workspace; publishes fs.file_created
  code-editor/         reacts to fs.file_created over the context bus
  code-interpreter/    run Python, JavaScript or shell; no network unless declared
  terminal/            shared shell (tmux + ttyd), watchable live in the browser
  browser-native/      headless Chromium plus VNC; also a DuckDuckGo search
  github-assistant/    read repos and open issues, scoped by verb and path
  notes/               stateful notes persisted to /workspace
  activity-feed/       collects fs.file_created and notes.* into one feed
  hello-world-py/      minimal Python resident app
examples/
  kernel-says-no/      one app, two writes, one EACCES from the kernel; no LLM, no API key
  resident-apps/       apps to run with `berth dev` (hello-world, http-fetch, generic-connector)
  agents/              agent examples using @berthos/agents (simple-agent, agent-server, with-vercel-ai-sdk)
```
