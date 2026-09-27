# Governance gate reference

A governance app is a resident app that sits in front of every other app's tool calls and decides whether each one may run. Use it to plug in your own policy: a rules engine, a classifier, or a human approval step. Berth provides the hook and calls it; the policy is yours. Berth ships no governance app of its own.

## Write a governance app

Declare `governs: true` in its `berth.yml` and export `evaluate_action`:

```yaml
name: my-governance-app
version: 0.1.0
governs: true

exports:
  - name: evaluate_action
    input: { app: string, export: string, input: object }
    output: { allowed: boolean, reason: string }
```

Load it next to the apps it should govern:

```ts
const computer = await Computer.boot({
  apps: ["apps/filesystem", "./my-governance-app"],
});
```

Every other app's calls now go through `my-governance-app`'s `evaluate_action` first. No other wiring is needed. `Computer` is part of the experimental agent framework (`@berthos/agents`), which isn't published; use it from a clone.

Rules:

- Manifest loading fails if `governs: true` is set without an `evaluate_action` export: `an app declaring governs: true must also declare an 'evaluate_action' export`.
- At most one app per Computer can declare `governs: true`. More than one throws at boot: `multiple governance apps declared (…) — only one governance authority per Computer is supported`.
- The governance app's own exports are never gated.
- Any other app can opt out in its manifest:

```yaml
governance:
  exempt: true
```

## The `evaluate_action` contract

This is the one interface Berth fixes. Everything else (your verdict vocabulary, policy source, approval flow, your own logging) is up to your app.

**Input:** `{ app, export, input, caller? }`

| Field | Meaning |
|---|---|
| `app` | The app about to be called. `mcp:<server>` for an MCP server's tool, `agent:<name>` for a delegated agent. |
| `export` | The export or tool name. `invoke` for a delegated agent. |
| `input` | The arguments of the call. |
| `caller` | Sent by the SDK gate only (below). The sibling app's name if the call came over that app's own socket, otherwise `"host"` (`berth rpc`, `berth mcp`), `"http"` (the HTTP RPC bridge) or `"tcp"` (the cross-container listener). Set by which socket accepted the connection, so a caller can't claim to be another app. |

A Zod object schema drops unknown keys, so if you want to use `caller`, declare it in your input schema.

**Output:** `{ allowed: boolean, reason: string }`. If your policy engine has a richer vocabulary (allow, block, pending), translate it to this boolean in your app.

If your governor denies names it doesn't recognise, it will deny `mcp:` and `agent:` calls too. Delegating to an agent is one decision (may this agent be given work at all?); the delegate's own tool calls are then gated as it makes them.

## What happens on each call

| Governor answers | Result |
|---|---|
| `allowed: true` | The call runs. |
| `allowed: false` | Throws `GovernanceDeniedError` (`.appName`, `.exportName`, `.reason`). An agent sees it as a failed tool call. Over RPC, the caller gets the error `governance denied <export>: <reason>`. |
| Errors or times out | Depends on the gate's mode (below). |

### Fail-closed by default

If `evaluate_action` errors or times out, the call throws `GovernanceUnavailableError` (`.appName`, `.exportName`, `.cause`) instead of running. A policy check that didn't happen never counts as one that passed.

You can choose fail-open where availability matters more than the guarantee:

```ts
const computer = await Computer.boot({ apps: [...], governance: { mode: "fail-open" } });
```

With `mode: "fail-open"`, a call whose governor couldn't be reached runs anyway, with a warning. An explicit `allowed: false` still throws `GovernanceDeniedError`. The same `governance` option works on `Computer.connect()`, `createAgent()` (which passes it through) and `HttpBridgeComputer.deploy()`.

`mode` applies to the Computer gate only. The SDK gate is always fail-closed; a governor outage there fails every app-to-app call in the container. To keep a specific app running regardless, mark it `governance: { exempt: true }`.

| Setting | Computer gate | SDK gate |
|---|---|---|
| Timeout | 10s | 5s, or `BERTH_GOVERNANCE_TIMEOUT_MS` |
| When unreachable | `mode`, default `fail-closed` | Always denies |

### Recording verdicts

Pass an audit sink and every allow, deny and unreachable-governor outcome is written to the hash-chained [audit trail](./audit-reference.md) with an actor:

```ts
Computer.boot({ apps: [...], governance: { audit, actor } });
```

This records what the gate decided. A governance app can keep its own, richer log as well.

## Why this lives in `@berthos/agents`, not the kernel

Landlock applies a fixed ruleset once at boot. It has no per-call hook to ask an outside app for a verdict, so a gate like this can't be built at the kernel level (see [capability tokens](./capability-tokens-reference.md)).

Instead, there are two gates, each where a different set of calls passes through:

| Gate | Lives in | Covers |
|---|---|---|
| Computer dispatch | `@berthos/agents` | An agent's tool calls, `computer.call`, the retriever, MCP tools, delegated agents |
| RPC dispatch | `@berthos/sdk` | Every way into a resident app: `berth rpc` and `berth mcp`, the HTTP RPC bridge, the TCP listener, a sibling app's socket |

A call from an agent to a resident app passes both gates, so **your governor is asked twice for each agent tool call**. De-duplicate on your side if your own log cares. Both are kept: the Computer gate gives the agent a typed `GovernanceDeniedError`, and the SDK gate is what covers callers that never touch a Computer.

For `berth rpc` and `berth mcp` the gate is policy and audit rather than a security boundary, because whoever runs them already has root on the host. For the HTTP bridge and sibling sockets it is a real boundary.

On an enforcing kernel the TCP listener can't bind at all: Landlock refuses the bind for any app with network scoping, so there's nothing to gate. If an app opens it where the kernel allows (`BERTH_NETWORK_PORT_<APP>`), the SDK gate covers it.

## Limits

- **Root on the host isn't gated.** Anyone who can `docker exec` into the container bypasses both gates.
- **Nothing at the syscall level is gated.** The gate sees tool and RPC calls, not what an app does inside its own process; that's what its manifest and the kernel rules are for.
