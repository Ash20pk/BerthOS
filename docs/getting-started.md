# Getting Started

This walkthrough takes you from a clean checkout to a working resident app with a live browser you can watch over VNC. It should take under 10 minutes. It's the resident-app-building path. For the fastest way to see a working agent, try the [README's Quickstart](../README.md#quickstart) instead. Both feed into the same [Berth OS](./berth-os.md), the sandboxed computer a resident app runs in and an agent's tools come from.

## Prerequisites

- Node.js 22+ (`nvm use` will pick up `.nvmrc`)
- Docker, running locally
- `corepack enable` (ships with Node 22, manages pnpm for you)

## 1. Install and build

```bash
git clone https://github.com/Ash20pk/BerthOS
cd BerthOS
corepack enable
pnpm install
pnpm build
```

`pnpm build` compiles every package in dependency order through Turborepo: `@berth/manifest-schema` first, then `@berth/sdk`, `@berth/docker-orchestrator`, `@berth/agents` and the deploy adapters, and finally `@berth/cli`.

## 2. Run the hello-world example

```bash
cd examples/resident-apps/hello-world
pnpm exec berth dev
```

You should see:

```
Building dev image for "hello-world"...
Container started. Watching .../examples/resident-apps/hello-world/src and berth.yml for changes...
[berth:dev] "hello-world" declares no browser:* capability: no VNC/CDP ports exposed
[berth:dev] "hello-world" declares no terminal:* capability: no terminal port exposed
[berth:dev] [berth:runtime] "hello-world" ready
```

Edit `src/index.ts` and save. The container restarts on its own (on_install hooks skip on warm restarts, so this stays fast).

## 3. Run the notes app (a resident app with a real capability)

`hello-world` declares zero capabilities. `apps/notes` is the next step up: a stateful, first-party resident app (`add_note`/`list_notes`/`complete_note`, persisted to a JSON file) that declares `filesystem:write:/workspace` and publishes to the context bus on every write.

```bash
cd apps/notes
pnpm exec berth dev
```

Call an export (through `berth rpc`, or the MCP bridge, see [mcp-bridge-reference.md](./mcp-bridge-reference.md)) and watch `filesystem:write:/workspace` actually get enforced. Writing outside `/workspace` gets refused at the kernel level, not just by convention.

## 4. Run the browser-native example (with a live VNC view)

```bash
cd ../browser-native
pnpm exec berth dev
```

Because this app declares `browser:navigate:*` in its `berth.yml`, `berth dev` prints a noVNC URL:

```
[berth:dev] noVNC:  http://localhost:<port>/vnc.html
[berth:dev] VNC:    localhost:<port>
[berth:dev] CDP:    http://localhost:<port>
[berth:dev] "browser-native" declares no terminal:* capability: no terminal port exposed
```

Open the noVNC URL in a browser tab. You're looking at the headless Chromium instance running inside the sandboxed container, live.

## 5. Scaffold your own app

```bash
pnpm exec berth init my-app
cd my-app
pnpm exec berth dev
```

`berth init` prompts for a name and a starting template (`hello-world` or `browser-native`), scaffolds `berth.yml` plus SDK boilerplate, runs `pnpm install`, and validates the manifest before handing control back to you. Pass `--template` to skip the prompt, useful for scripting: `berth init my-app --template hello-world`. Building on an app someone already published instead of a bundled template? `berth init my-app --registry=<url> --template=<published-app-name>` scaffolds from there — see [app-registry-reference.md](./app-registry-reference.md).

## 6. Test before you deploy

```bash
pnpm exec berth test
```

This builds the production image (not the dev one), checks that your `berth.yml`'s `exports:` list matches what your code actually implements, invokes each export with a schema-valid stub payload, and runs your own `npm test` if you have one. Add `--json` for CI.

## 7. Deploy

```bash
berth deploy --fleet=e2b   # or --fleet=daytona, --fleet=k8s, or an alias from ~/.berthrc
```

See [manifest-reference.md](./manifest-reference.md) for the full `berth.yml` schema and [sdk-reference.md](./sdk-reference.md) for the resident app SDK.

## More examples

Beyond the `hello-world` → `notes` → `browser-native` ladder above:

- [`apps/activity-feed`](../apps/activity-feed): a zero-capability resident app that fans context-bus events **in** from other apps rather than reacting to just one. It subscribes to `fs.file_created` (`apps/filesystem`) and `notes.added`/`notes.completed` (`apps/notes`), and exposes `get_recent_activity`, the last 50 events, most-recent first. Run it alongside `filesystem`/`notes` to see several containers composed purely over the context bus, with no direct RPC between them.
- [`apps/terminal`](../apps/terminal): a shared, interactive shell. The agent drives a real shell through `run_command`/`read_screen`/`send_keys` (backed by `tmux`), and a human can watch, and type into, that exact same session live over the web (`ttyd`), the terminal equivalent of watching `apps/browser-native`'s Chromium over noVNC. Because both are spawned as children of this app's own already-Landlocked process, the shell inherits whatever filesystem and network capabilities `terminal` declares, the same way Chromium inherits `browser-native`'s.

## 8. Build agents on top with `@berth/agents`

Everything above is about authoring and running one resident app. To wire an LLM agent up to one or more resident apps' exports as tools, whether that's a single agent, a manager/worker crew, or independent agents networked across containers, start with [`examples/agents/simple-agent`](../examples/agents/simple-agent). It depends on `@berth/agents` as an ordinary `workspace:*` package dependency, the shape an external project's `package.json` would actually use. Then see [`packages/agents/examples/`](../packages/agents/examples/README.md) and [agents-reference.md](./agents-reference.md) for multi-agent composition.

## Something not working?

File a [bug report](../.github/ISSUE_TEMPLATE/bug_report.md) or [workflow feedback](../.github/ISSUE_TEMPLATE/workflow_feedback.md). Phase 1 is a pilot, and "what was confusing" reports are exactly what we need right now.
