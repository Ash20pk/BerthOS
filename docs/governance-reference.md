# Governance gate reference

Lets a resident app put itself in front of every other app's tool calls in a Computer: evaluate, then allow or deny. Berth defines the extension point and wires it in by default — the actual policy, verdict logic, human-in-the-loop, and audit trail belong entirely to whatever app you load. Berth ships no first-party governance app.

## Why this lives in `@berth/agents`, not the kernel

The instinct is "gate this at the kernel." Landlock (Berth's real kernel enforcement mechanism) applies a static ruleset once at container boot — it has no per-syscall callback to consult an external verdict-provider, which is the same reason per-syscall audit logging is permanently out of scope (see [capability tokens reference](./capability-tokens-reference.md)). There's no real hook at that layer to build this on.

The layer that actually sees every action an agent takes, regardless of which app owns it, is `Computer` (`packages/agents/src/computer.ts`): the one place that turns every loaded app's exports into `Tool`s that the `Agent`'s tool-use loop calls through (see [agents reference](./agents-reference.md)). Gating there is the closest honest equivalent to "every app the agent uses goes through governance," and it stays pure TypeScript — no kernel, Rust, or Docker changes.

**Scope boundary, stated plainly:** this only gates tool calls made through `Computer`/`Agent` — an LLM-driven agent's tool use. It does not gate `berth rpc`, direct multi-app `invokeAppExport()` calls, or anything at the kernel/Landlock level.

## Becoming the governance authority

Declare `governs: true` in your `berth.yml`, and export a fixed-contract `evaluate_action`:

```yaml
name: my-governance-app
version: 0.1.0
governs: true

exports:
  - name: evaluate_action
    input: { app: string, export: string, input: object }
    output: { allowed: boolean, reason: string }
```

`@berth/manifest-schema` hard-fails manifest loading if `governs: true` is set without an `evaluate_action` export declared — the same severity as the existing exports-must-match-code check.

At most one app per Computer may declare `governs: true`. `Computer.boot()`/`Computer.connect()` throws a clear error at boot if more than one is loaded.

## The `evaluate_action` contract

This is the one thing Berth defines as a stable interface. Everything else — verdict vocabulary, policy source, human approval flow, audit trail — is your app's own business.

- **Input**: `{ app: string, export: string, input: object }` — which app and export were about to be called, and with what input.
- **Output**: `{ allowed: boolean, reason: string }` — deliberately just a boolean and a reason string, not a richer vocabulary like allow/halt/block/pending. If your policy backend speaks a richer verdict language, translate it down to this boolean in your connector app; Berth stays a neutral, vendor-agnostic hook.

## How the gate applies

Once a Computer has a `governs: true` app loaded:

- Every other app's tools get wrapped: before the real call happens, `Computer` awaits `evaluate_action({ app, export, input })` on the governance app's tool. `allowed: false` throws a `GovernanceDeniedError` (carrying `.appName`, `.exportName`, `.reason`) instead of calling through — this surfaces to the `Agent`'s tool-use loop as a normal tool-call failure, same as any other tool error.
- The governance app's own tools are automatically exempt from gating itself (no self-recursion).
- Any other app can opt out explicitly:

```yaml
governance:
  exempt: true
```

## Failure mode: fails open, by default

If the `evaluate_action` call itself errors or exceeds a 10-second timeout, `Computer` logs a warning and lets the underlying call through rather than wedging the agent indefinitely. This is a v1 default, not a security guarantee — a governance app that's down doesn't block the agent, it just stops being consulted. If your use case needs fail-closed behavior, build that into your own connector app (e.g. have `evaluate_action` itself return `allowed: false` on its own internal errors, rather than letting the call throw) — `Computer` doesn't currently expose a fail-closed configuration option.

## Building your own governance app

Nothing under `apps/` in this repo is a governance app — Berth ships only the extension point. To build one:

1. Implement `evaluate_action` with the contract above, backed by whatever policy engine, ML classifier, or human-approval flow you want.
2. Declare `governs: true` in your `berth.yml`.
3. Load it alongside whatever else the Computer needs:

```ts
const computer = await Computer.boot({
  apps: ["apps/filesystem", "./my-governance-app"],
});
```

Every other app's tool calls now route through `my-governance-app`'s `evaluate_action` automatically — no other wiring required.
