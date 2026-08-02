# What is a Berth OS?

A **Berth OS** is the real, sandboxed computer a Berth agent's tools actually come from — a Docker container (today; E2B/Daytona/Kubernetes for `berth deploy`) loaded with one or more [resident apps](../README.md#resident-apps), each running under its own kernel-enforced capability policy, all able to collaborate through a shared context bus and semantic filesystem. It's what the `Computer` class represents in code, and what `berth os up` lets you keep running as a named, reconnectable instance instead of throwing away after one agent run.

If you've used `Computer.boot()`/`createAgent({apps: [...]})`, you've already been creating one — just an ephemeral, single-use one. This doc is about what's actually inside it, and about the persistent version.

## What's actually inside one

- **Resident apps** — persistent, stateful processes loaded from a `berth.yml` manifest + code, each exposing exports that become tools for whatever `Agent` is driving the OS. See [Resident apps](../README.md#resident-apps) in the README for how to build one, including the full list of available permissions.
- **Capability enforcement (Landlock)** — every app's declared `namespace:action:scope` capabilities become a real kernel-enforced ruleset, applied by `agent-init` *before* the app's own code ever runs — an undeclared write isn't caught by a try/catch, the syscall itself is refused. See [capability tokens reference](./capability-tokens-reference.md).
- **Context bus** — pub/sub between apps sharing one OS, so one app's write can trigger another's reaction with zero direct wiring between them. See [context bus reference](./context-bus-reference.md).
- **Semantic FS** — a filesystem mounted at `/context`, queryable by intent (tag it, then search by describing what you need) rather than just by path, shared by every app in the OS. See [semantic FS reference](./semantic-fs-reference.md).
- **Multi-app composition** — one Berth OS can host several resident apps at once, each still independently Landlock-enforced (its own ruleset, not one shared policy for the whole container). See [multi-app reference](./multi-app-reference.md).

None of this is new machinery invented for agents specifically — it's the same runtime every `berth dev`/`berth test`/`berth deploy` invocation already uses for a single resident app. A Berth OS is just that runtime, addressed as a whole, with an `Agent` attached on top.

## Ephemeral vs. persistent

By default, every `Computer.boot()` — and therefore every `createAgent()`/`runAgent()` call that doesn't pass `connect` — builds a fresh image and boots a brand-new, throwaway Berth OS. Correct for a one-shot script; real seconds of latency (image build, container start, `on_install`, the context-bus/semantic-fs daemons, `agent-init`'s Landlock setup) paid again on every single dev-loop iteration otherwise.

`berth os up <name>` boots one and keeps it running as a named, shared instance instead. `Computer.connect({name})` / `createAgent({connect: name})` reattach to it in milliseconds — no build, no boot — and can even be scoped to a subset of that OS's loaded apps, so several agents can share one instance without each one seeing every app's tools. See [`berth os` reference](./berth-os-reference.md) for the full command/API reference and how the reconnect mechanism works under the hood.

## Where it runs

Local Docker for `berth dev`/`berth os up`/`Computer.boot()` today. `berth deploy --fleet=e2b|daytona|k8s` ships the same sandbox definition to a remote provider — though `berth os up`/`Computer.connect()`'s reconnect mechanism is local-Docker-only so far; there's no equivalent "leave a persistent OS running and reconnect to it" story for a deployed fleet yet.
