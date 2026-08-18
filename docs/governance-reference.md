# Governance gate reference

Lets a resident app put itself in front of every other app's tool calls in a Computer: evaluate, then allow or deny. Berth defines the extension point and wires it in by default — the actual policy, verdict logic, and human-in-the-loop belong entirely to whatever app you load. Berth ships no first-party governance app.

Berth does record the verdicts, though. Pass an `AuditSink` and every allow, deny, and could-not-reach-the-governor is written to a hash-chained trail with an actor on it — see the [audit trail reference](./audit-reference.md). That is a record of what the gate *decided*, which is a different thing from the richer, policy-aware trail a governance app may want to keep for itself.

## Why this lives in `@berth/agents`, not the kernel

The instinct is "gate this at the kernel." Landlock (Berth's real kernel enforcement mechanism) applies a static ruleset once at container boot — it has no per-syscall callback to consult an external verdict-provider, which is the same reason per-syscall audit logging is permanently out of scope (see [capability tokens reference](./capability-tokens-reference.md)). There's no real hook at that layer to build this on.

The layer that actually sees every action an agent takes, regardless of which app owns it, is `Computer` (`packages/agents/src/computer.ts`): the one place that turns every loaded app's exports into `Tool`s that the `Agent`'s tool-use loop calls through (see [agents reference](./agents-reference.md)). Gating there is the closest honest equivalent to "every app the agent uses goes through governance," and it stays pure TypeScript — no kernel, Rust, or Docker changes.

**Scope boundary, and where it moved.** Gating at `Computer` covers an LLM-driven agent's tool use. It never covered the other ways into the same container — `berth rpc`, `berth mcp`, the HTTP RPC bridge, the cross-container TCP listener, or a sibling app's direct socket call — because none of them touch a `Computer`. An app denied a tool call could make the identical call over its peer socket and be obeyed.

As of REMEDIATION.md 1.13's second half there is a **second gate, in `@berth/sdk`**, at the one point all of those converge: `invokeExport()`. Neither gate replaces the other, and the split follows what each layer can see:

| Gate | Lives in | Sees |
|---|---|---|
| Computer dispatch | `@berth/agents` | Agent tool calls, `computer.call`, the retriever, MCP tools, agent-as-tool delegation |
| RPC dispatch | `@berth/sdk` | Every transport into a resident app: the relay (`berth rpc`, `berth mcp`), the HTTP bridge, the TCP listener, a sibling's peer socket |

Still not gated: anything at the kernel/Landlock level (no per-syscall hook exists — see above), and root on the host, who can `docker exec` into the container regardless. For the relay specifically the gate is policy and audit rather than a boundary, since the operator reaching it is already root; for the peer socket, the TCP listener and the HTTP bridge it is a real boundary, because those callers are not.

**What is gated, as of REMEDIATION.md 1.13.** The gate used to be applied by mapping over one `Tool[]`, so it covered exactly the tools in that array at that moment — anything assembled afterwards escaped it. It now sits on the Computer's *dispatch*, plus an explicit wrapper for the two paths that never touch that dispatch:

| Path | Announced to the governor as |
|---|---|
| A resident app's export, however it is reached through this Computer (`computer.tools`, `computer.call`, an Agent's tool list, the retriever) | `{ app: "<app>", export: "<export>" }` |
| An MCP server's tool | `{ app: "mcp:<server>", export: "<tool>" }` |
| A delegated agent (`agent.asTool()`, which is what `Crew.withManager()` hands a manager) | `{ app: "agent:<name>", export: "invoke" }` |

The `mcp:` and `agent:` prefixes are deliberate: a governance app can tell at a glance that the action leaves the sandbox (MCP) or hands work to another agent, rather than having to recognise every name. **If your governor denies apps it doesn't recognise, it will now deny these** — that is the point of closing the bypass, but it is a behaviour change for an existing governor, and combined with the fail-closed default it is worth checking before upgrading.

Delegation is gated as one decision, not one per tool the delegate owns: the governor decides whether this agent may be handed work at all. The delegate's own tool calls are then gated normally as it makes them.

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

### One action, two evaluations

A resident app's tool call through a governed Computer now passes **both** gates, so the governor is consulted twice for it — once as the Computer dispatches, once as the SDK receives. That is a real cost, stated rather than left to be discovered in a governor's audit log: expect two `evaluate_action` calls per agent tool call, and de-duplicate on the governor side if your audit trail cares.

It was left this way deliberately. Removing the Computer-side gate would lose the typed `GovernanceDeniedError` the agent loop surfaces to the LLM; removing the SDK-side one for the relay would reopen `berth rpc`, which is the bypass being closed. A marker saying "already evaluated" would have to be trusted from the caller, and the whole point of the SDK gate is that the caller's identity is the one thing it does not take on trust.

## The `evaluate_action` contract

This is the one thing Berth defines as a stable interface. Everything else — verdict vocabulary, policy source, human approval flow, audit trail — is your app's own business.

- **Input**: `{ app: string, export: string, input: object }` — which app and export were about to be called, and with what input. The SDK-side gate adds a fourth field, `caller: string`: the sibling app's name when the request arrived on that sibling's own peer socket, or `"host"` (the relay), `"http"` (the bridge) or `"tcp"` (the cross-container listener). It is established by which listener accepted the connection, not by anything the request says, so a caller cannot claim to be another app. A Zod object schema strips unknown keys by default, so an existing governor keeps working unchanged — declare `caller` in your input schema if you want to police it.
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

## Failure mode: fails closed by default, fail-open available

If the `evaluate_action` call itself errors or exceeds its timeout (10s at the Computer gate, 5s at the SDK gate — `BERTH_GOVERNANCE_TIMEOUT_MS` overrides the latter), the gated call throws `GovernanceUnavailableError` (carrying `.appName`, `.exportName`, `.cause`) rather than running — "the policy check didn't happen" never quietly becomes "the policy check passed." This is the default as of REMEDIATION.md 1.11.

That item is why: any app sharing the container could `kill -9` the governance app, and under the previous fail-open default one signal turned the gate off entirely, with nothing but a `console.warn` to show for it. Per-app uids now make that particular kill impossible — the kernel refuses cross-uid signals, asserted by `capability-enforcement.mjs` Test 12 — but a governor can still crash, hang, or simply be slow, and a gate that opens under those conditions is not a gate.

Fail-open is still available, and is a legitimate choice where availability genuinely matters more than the guarantee — a governor outage then takes down every gated app's tool calls instead. It is simply no longer what you get by not deciding: pass `governance: { mode: "fail-open" }` to `Computer.boot()`/`Computer.connect()` (or `createAgent()`, which forwards it) or `HttpBridgeComputer.deploy()`. An unreachable/timed-out `evaluate_action` call then throws `GovernanceUnavailableError` (carrying `.appName`, `.exportName`, `.cause`) instead of letting the call through — distinct from `GovernanceDeniedError`, since the governor never actually rendered a verdict here, it just couldn't be reached:

```ts
const computer = await Computer.boot({ apps: [...], governance: { mode: "fail-open" } });
```

**`mode` applies to the Computer gate only.** The SDK-side gate is fail-closed and has no fail-open setting, because its blast radius is what would make one dangerous: a governor outage there fails every app-to-app RPC in the container, not only an agent's tool calls. If that trade is wrong for your deployment, the lever is `governance: { exempt: true }` on the specific app — a visible, per-app declaration in a manifest rather than a container-wide switch.

An explicitly-denied call (`allowed: false`) still throws the normal `GovernanceDeniedError` either way — `mode` only changes what happens when the governor itself can't be consulted at all. Pick fail-open only where availability matters more than the guarantee that "the policy check didn't happen" never becomes "the policy check passed."

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
