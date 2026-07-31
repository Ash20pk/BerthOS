# Contributing to Berth

Berth is early — Phases 1–3 of a 5-phase roadmap. We're looking for pilot developers building resident apps and feedback on the `berth init` → `berth dev` workflow.

## Setup

```bash
corepack enable
pnpm install
pnpm build
pnpm test
```

`packages/context-bus-daemon` is Rust — you don't need a local Rust toolchain to use `berth`/build resident apps day-to-day, since `berth dev`/`test`/`deploy` compile it inside the Docker image (see `base.Dockerfile`'s `context-bus-builder` stage). You only need `cargo` + a `protoc` on PATH (`brew install protobuf` / `apk add protobuf`) if you're editing the daemon itself and want a fast local `cargo build`/`cargo check` loop.

## Reporting issues

Use the issue templates in `.github/ISSUE_TEMPLATE/`. For the Phase 1 pilot, the most useful reports are:
- **Bug report** — what broke, expected vs. actual behavior, `berth.yml` + logs if relevant
- **Workflow feedback** — what was confusing, how long `init` → `dev` took end to end, where you got stuck

## Development workflow

- `packages/manifest-schema` has no dependency on anything else in the repo — start there if you're touching the `berth.yml` shape.
- `packages/sdk` runs *inside* the sandboxed container — it must never import Docker, the CLI, or Node-host-only APIs.
- `packages/cli` never imports E2B/Daytona SDKs directly — deploy adapters live behind `packages/adapters/adapter-core`'s `DeployAdapter` interface.
- `packages/context-bus-daemon`'s `proto/context_bus.proto` is the canonical wire schema; `packages/sdk/proto/context_bus.proto` must be kept in sync by hand (see the comment at the top of either file).
- Run `pnpm --filter <package> test` to scope a test run to one package, or `pnpm test` to run everything through Turborepo.
- `node packages/docker-orchestrator/test/context-bus-milestone.mjs` is a real (Docker-backed, not mocked) integration test proving apps react to each other via the context bus — run it after touching `context-bus-daemon`, the SDK's context-bus client, or `apps/filesystem`/`apps/code-editor`.
- `packages/agent-init` (Rust, Landlock) needs Landlock active in the kernel's LSM stack to actually enforce anything — check `cat /sys/kernel/security/lsm` (after `mount -t securityfs securityfs /sys/kernel/security` if testing in a privileged container). Docker Desktop for Mac's linuxkit VM does NOT have it active; see `docs/capability-tokens-reference.md` before assuming a passing `capability-enforcement.mjs` run means enforcement actually works.

## Code style

TypeScript, strict mode (`tsconfig.base.json`). No default exports except where a package's public API is a single factory (e.g. a resident app's `export default defineApp(...)`).
