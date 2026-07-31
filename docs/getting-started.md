# Getting Started

This walkthrough takes you from a clean checkout to a working resident app with a live browser you can watch over VNC. It should take under 10 minutes.

## Prerequisites

- Node.js 22+ (`nvm use` will pick up `.nvmrc`)
- Docker, running locally
- `corepack enable` (ships with Node 22, manages pnpm for you)

## 1. Install and build

```bash
git clone <this-repo>
cd agentOS
corepack enable
pnpm install
pnpm build
```

`pnpm build` compiles every package in dependency order via Turborepo — `@berth/manifest-schema` first, then `@berth/sdk`, `@berth/docker-orchestrator`, the deploy adapters, and finally `@berth/cli`.

## 2. Run the hello-world example

```bash
cd examples/hello-world
pnpm exec berth dev
```

You should see:

```
Building dev image for "hello-world"...
Container started. Watching .../examples/hello-world/src and berth.yml for changes...
[berth:dev] "hello-world" declares no browser:* capability — no VNC/CDP ports exposed
[berth:dev] [berth:runtime] "hello-world" ready
```

Edit `src/index.ts` and save — the container restarts automatically (on_install hooks are skipped on warm restarts, so this is fast).

## 3. Run the browser-native example (with a live VNC view)

```bash
cd examples/../../apps/browser-native
pnpm exec berth dev
```

Because this app declares `browser:navigate:*` in its `berth.yml`, `berth dev` prints a noVNC URL:

```
[berth:dev] noVNC:  http://localhost:<port>/vnc.html
[berth:dev] VNC:    localhost:<port>
[berth:dev] CDP:    http://localhost:<port>
```

Open the noVNC URL in a browser tab — you're looking at the headless Chromium instance running inside the sandboxed container, live.

## 4. Scaffold your own app

```bash
pnpm exec berth init my-app
cd my-app
pnpm exec berth dev
```

`berth init` prompts for a name and a starting template (`hello-world` or `browser-native`), scaffolds `berth.yml` + SDK boilerplate, runs `pnpm install`, and validates the manifest before handing control back to you. Pass `--template` to skip the prompt (e.g. for scripting): `berth init my-app --template hello-world`.

## 5. Test before you deploy

```bash
pnpm exec berth test
```

This builds the production image (not the dev one), checks that your `berth.yml`'s `exports:` list matches what your code actually implements, invokes each export with a schema-valid stub payload, and runs your own `npm test` if you have one. Add `--json` for CI.

## 6. Deploy

```bash
berth deploy --fleet=e2b   # or --fleet=daytona, or an alias from ~/.berthrc
```

See [manifest-reference.md](./manifest-reference.md) for the full `berth.yml` schema and [sdk-reference.md](./sdk-reference.md) for the resident app SDK.

## Something not working?

File a [bug report](../.github/ISSUE_TEMPLATE/bug_report.md) or [workflow feedback](../.github/ISSUE_TEMPLATE/workflow_feedback.md) — Phase 1 is a pilot, and "what was confusing" reports are exactly what we need right now.
