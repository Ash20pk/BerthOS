# Contributing to Berth

Berth is early and solo-maintained right now — see [ROADMAP.md](./ROADMAP.md) for what's actually shipped versus planned. I'm the only reviewer at the moment, so PR and issue response times will vary; I'll get to everything, but not always fast. If a few days pass with no reply, a friendly ping is welcome, not annoying.

The single most useful thing you can do right now is build a resident app or give feedback on the `berth init` → `berth dev` workflow.

## Building a resident app

This is the fastest path from clone to a merged PR.

```bash
corepack enable
pnpm install
pnpm build

pnpm exec berth init my-app     # scaffolds berth.yml + SDK boilerplate from a template
cd my-app
pnpm exec berth dev             # hot-reloading dev loop
```

From there:

- Edit `src/index.ts` and `berth.yml` — see [Resident apps](./README.md#resident-apps) in the README for the manifest/export/capability model, and [docs/sdk-reference.md](./docs/sdk-reference.md) for the full SDK surface.
- `pnpm exec berth test` builds the production image and validates your exports before you open a PR.
- Open the PR against `main`. No need to touch anything under `packages/` for this path.

### Resident apps we'd love to see

No menu, no PR — an open invitation is where interest usually goes to die. Concrete starting points instead:

- **Slack** — post messages, read channel history, react to events
- **Postgres / generic SQL** — query and mutate a database scoped to specific tables
- **Gmail / email** — read, send, and search, scoped by label or folder
- **Linear or Jira** — read and create issues, scoped like `apps/github-assistant`
- **Stripe** — read-only reporting first; write scopes (refunds, etc.) are a bigger conversation
- **Playwright-driven QA** — a step up from `apps/browser-native`, oriented around running a test suite instead of free-form navigation
- **Calendar** (Google Calendar or similar) — read availability, create events

Don't see your idea, or not sure it fits the capability model yet? Open a [resident app proposal](./.github/ISSUE_TEMPLATE/resident_app_proposal.md) — that's exactly the kind of issue we want right now, even (especially) before you've written code.

## Reporting issues

Use the issue templates in `.github/ISSUE_TEMPLATE/`. The most useful reports right now:
- **Bug report** — what broke, expected vs. actual behavior, `berth.yml` + logs if relevant
- **Workflow feedback** — what was confusing, how long `init` → `dev` took end to end, where you got stuck
- **Resident app proposal** — an app you want to build or want to exist, before or instead of a PR

## Working on Berth's internals

If you're touching `packages/` rather than building a resident app, a few invariants matter:

- `packages/manifest-schema` has no dependency on anything else in the repo — start there if you're touching the `berth.yml` shape.
- `packages/sdk` runs *inside* the sandboxed container — it must never import Docker, the CLI, or Node-host-only APIs.
- `packages/cli` never imports E2B/Daytona SDKs directly — deploy adapters live behind `packages/adapters/adapter-core`'s `DeployAdapter` interface.
- `packages/context-bus-daemon`'s `proto/context_bus.proto` is the canonical wire schema; `packages/sdk/proto/context_bus.proto` must be kept in sync by hand (see the comment at the top of either file).
- Run `pnpm --filter <package> test` to scope a test run to one package, or `pnpm test` to run everything through Turborepo.
- `node packages/docker-orchestrator/test/context-bus-milestone.mjs` is a real (Docker-backed, not mocked) integration test proving apps react to each other via the context bus — run it after touching `context-bus-daemon`, the SDK's context-bus client, or `apps/filesystem`/`apps/code-editor`.
- `packages/agent-init` (Rust, Landlock) needs Landlock active in the kernel's LSM stack to actually enforce anything — check `cat /sys/kernel/security/lsm` (after `mount -t securityfs securityfs /sys/kernel/security` if testing in a privileged container). Docker Desktop for Mac's linuxkit VM does NOT have it active; see `docs/capability-tokens-reference.md` before assuming a passing `capability-enforcement.mjs` run means enforcement actually works.
- `packages/context-bus-daemon` is Rust — you don't need a local Rust toolchain to use `berth`/build resident apps day-to-day, since `berth dev`/`test`/`deploy` compile it inside the Docker image (see `base.Dockerfile`'s `context-bus-builder` stage). You only need `cargo` + a `protoc` on PATH (`brew install protobuf` / `apk add protobuf`) if you're editing the daemon itself and want a fast local `cargo build`/`cargo check` loop.

## Code style

TypeScript, strict mode (`tsconfig.base.json`). No default exports except where a package's public API is a single factory (e.g. a resident app's `export default defineApp(...)`).
