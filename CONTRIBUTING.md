# Contributing to Berth

Thanks for helping. The most useful things you can do are build a resident app and tell us where the `berth init` → `berth dev` workflow got in your way. [ROADMAP.md](./ROADMAP.md) lists what works today and what's next.

Berth has one maintainer, so reviews can take a few days. If you hear nothing for a while, a friendly ping on the PR or issue is welcome.

## Set up

You need Node.js 22+, pnpm (through corepack) and Docker.

```bash
git clone https://github.com/Ash20pk/BerthOS && cd BerthOS
corepack enable
pnpm install
pnpm build
node packages/cli/bin/berth.js doctor --fix   # can this machine's kernel enforce anything?
```

The commands below write `berth` for `node packages/cli/bin/berth.js`. Enforcement needs a Linux 6.7+ kernel with Landlock. Docker Desktop doesn't have it; on a Mac, `berth doctor --fix` sets up a Colima VM that does.

## Run the tests

```bash
pnpm test                          # everything, through Turborepo
pnpm --filter <package> test       # one package, e.g. pnpm --filter @berthos/sdk test
pnpm lint                          # type-check every package
```

The Docker-backed integration tests live in `packages/docker-orchestrator/test/*.mjs` and run against a real container. Run the one that covers what you changed, for example:

```bash
node packages/docker-orchestrator/test/context-bus-milestone.mjs
```

A passing `capability-enforcement.mjs` run only proves enforcement on a kernel that has Landlock. Check with `berth doctor`, or `cat /sys/kernel/security/lsm`.

## Build a resident app

This is the quickest route from a clone to a merged PR, and needs no changes under `packages/`.

```bash
berth init my-app     # scaffolds berth.yml and SDK boilerplate from a template
cd my-app
berth dev             # boots it in the sandbox, reloads on save
berth test            # builds the production image and checks every export
```

Edit `src/index.ts` and `berth.yml`. [Resident apps](./docs/resident-apps.md) explains the manifest, exports and capabilities, and the [SDK reference](./docs/sdk-reference.md) covers the full API. Run `berth test` before you open the PR.

### Resident apps we'd love to see

Each of these is self-contained and makes a good first contribution:

- **Slack**: post messages, read channel history, react to events.
- **Postgres / SQL**: query and change a database, scoped to specific tables.
- **Email**: read, send and search, scoped by label or folder.
- **Linear or Jira**: read and create issues, scoped like [`apps/github-assistant`](./apps/github-assistant).
- **Stripe**: read-only reporting first. Write scopes such as refunds need a design discussion.
- **Playwright QA**: a step up from [`apps/browser-native`](./apps/browser-native) that runs a test suite instead of free-form browsing.
- **Calendar**: read availability, create events.

Have a different idea, or not sure it fits the capability model? Open a [resident app proposal](./.github/ISSUE_TEMPLATE/resident_app_proposal.md), ideally before you write code.

## Open a good PR

- Open it against `main`, one change per PR.
- Say what it changes and how you checked it. For anything touching enforcement, say which kernel you ran it on.
- Run `pnpm build`, `pnpm lint` and the tests for the packages you touched.
- For a new or changed app, `berth test` passes.
- Code style: TypeScript in strict mode (`tsconfig.base.json`). No default exports, except where a package's public API is a single factory, such as a resident app's `export default defineApp(...)`.

## Report an issue

Use the [issue templates](./.github/ISSUE_TEMPLATE):

- **[Bug report](./.github/ISSUE_TEMPLATE/bug_report.md)**: what broke, what you expected, your `berth.yml`, logs, and `berth doctor` output.
- **[Workflow feedback](./.github/ISSUE_TEMPLATE/workflow_feedback.md)**: what confused you, how long `init` → `dev` took, where you got stuck.
- **[Resident app proposal](./.github/ISSUE_TEMPLATE/resident_app_proposal.md)**: an app you want to build or want to exist.

Security issues go through [SECURITY.md](./SECURITY.md), not a public issue.

## The agents packages are frozen

Berth is a sandbox, not an agent framework. The agent framework in [`experimental/`](./experimental) (`@berthos/agents`, and `berthos-agents` for Python) exists to show the sandbox works from an agent loop. It is not published and is used from a clone.

Its API is frozen: we don't accept new `Crew` shapes, new providers or framework-parity features. Bug fixes and security fixes are welcome. To build a richer agent loop on Berth, use the sandbox's own interfaces: `berth mcp`, `toAiSdkTools` / `toLangChainTools`, the HTTP RPC bridge, or the SDK directly.

## Working on Berth's internals

If you're changing `packages/` rather than building an app, keep these rules:

- `packages/manifest-schema` depends on nothing else in the repo. Start there if you're changing the `berth.yml` format.
- `packages/sdk` runs inside the sandbox. It must never import Docker, the CLI or host-only Node APIs.
- `packages/cli` never imports the E2B or Daytona SDKs directly. Deploy adapters sit behind the `DeployAdapter` interface in `packages/adapters/adapter-core`.
- `packages/context-bus-daemon/proto/context_bus.proto` is the wire schema. Keep `packages/sdk/proto/context_bus.proto` in sync with it by hand.
- After changing `context-bus-daemon`, the SDK's context-bus client, `apps/filesystem` or `apps/code-editor`, run `node packages/docker-orchestrator/test/context-bus-milestone.mjs`.
- `packages/context-bus-daemon` and `packages/agent-init` are Rust. You don't need a Rust toolchain to build apps, because `berth dev`, `test` and `deploy` compile them inside the Docker image. To iterate on the daemon locally you need `cargo` and `protoc` (`brew install protobuf` or `apk add protobuf`).
- `packages/agent-init` applies the Landlock policy, so it only enforces on a kernel with Landlock in its LSM stack. In a privileged container, mount securityfs first (`mount -t securityfs securityfs /sys/kernel/security`) and then check `/sys/kernel/security/lsm`.
