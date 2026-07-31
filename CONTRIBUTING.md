# Contributing to Berth

Berth is early — Phase 1 of a 5-phase roadmap. We're looking for pilot developers building resident apps and feedback on the `berth init` → `berth dev` workflow.

## Setup

```bash
corepack enable
pnpm install
pnpm build
pnpm test
```

## Reporting issues

Use the issue templates in `.github/ISSUE_TEMPLATE/`. For the Phase 1 pilot, the most useful reports are:
- **Bug report** — what broke, expected vs. actual behavior, `berth.yml` + logs if relevant
- **Workflow feedback** — what was confusing, how long `init` → `dev` took end to end, where you got stuck

## Development workflow

- `packages/manifest-schema` has no dependency on anything else in the repo — start there if you're touching the `berth.yml` shape.
- `packages/sdk` runs *inside* the sandboxed container — it must never import Docker, the CLI, or Node-host-only APIs.
- `packages/cli` never imports E2B/Daytona SDKs directly — deploy adapters live behind `packages/adapters/adapter-core`'s `DeployAdapter` interface.
- Run `pnpm --filter <package> test` to scope a test run to one package, or `pnpm test` to run everything through Turborepo.

## Code style

TypeScript, strict mode (`tsconfig.base.json`). No default exports except where a package's public API is a single factory (e.g. a resident app's `export default defineApp(...)`).
