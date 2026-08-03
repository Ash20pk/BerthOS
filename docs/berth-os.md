# What is a Berth OS?

A Berth OS is the real, sandboxed computer a Berth agent's tools actually come from. Today that means a Docker container, loaded with one or more resident apps — `berth deploy --fleet=e2b|daytona|k8s` already ships the same sandbox definition to a remote provider too, though `berth os up`/`Computer.connect()`'s instant-reconnect is local-Docker-only so far (see [Where it runs](#where-it-runs)). Each app runs under its own kernel-enforced capability policy, and all of them can collaborate through a shared context bus and semantic filesystem. In code, this is the `Computer` class. `berth os up` is what lets you keep one running as a named, reconnectable instance instead of throwing it away after a single agent run.

If you've called `Computer.boot()` or `createAgent({apps: [...]})`, you've already created one. Just an ephemeral, single-use one. This doc is about what's actually inside it, and about the persistent version.

## What's actually inside one

- **Resident apps.** Persistent, stateful processes loaded from a `berth.yml` manifest plus code, each exposing exports that become tools for whatever `Agent` is driving the OS. See [Resident apps](../README.md#resident-apps) in the README for how to build one, including the full list of available permissions.
- **Capability enforcement (Landlock).** Every app's declared `namespace:action:scope` capabilities become a real, kernel-enforced ruleset, applied by `agent-init` before the app's own code ever runs. An undeclared write isn't caught by a try/catch. The syscall itself gets refused. See the [capability tokens reference](./capability-tokens-reference.md).
- **Context bus.** Pub/sub between apps sharing one OS, so one app's write can trigger another's reaction with zero direct wiring between them. See the [context bus reference](./context-bus-reference.md).
- **Semantic FS.** A filesystem mounted at `/context`, queryable by intent (tag it, then search by describing what you need) instead of by path alone, shared by every app in the OS. See the [semantic FS reference](./semantic-fs-reference.md).
- **Multi-app composition.** One Berth OS can host several resident apps at once, each still independently Landlock-enforced. Nobody shares one policy for the whole container. See the [multi-app reference](./multi-app-reference.md).

None of this is new machinery invented just for agents. It's the same runtime every `berth dev`, `berth test`, and `berth deploy` invocation already uses for a single resident app. A Berth OS is that same runtime, addressed as a whole, with an `Agent` attached on top.

## Ephemeral vs. persistent

By default, every `Computer.boot()` call (and so every `createAgent()` or `runAgent()` call that doesn't pass `connect`) builds a fresh image and boots a brand-new, throwaway Berth OS. That's fine for a one-shot script. It's real seconds of latency (image build, container start, `on_install`, the context-bus and semantic-fs daemons, `agent-init`'s Landlock setup) paid again on every single dev-loop iteration otherwise.

`berth os up <name>` boots one and keeps it running as a named, shared instance instead. `Computer.connect({name})` and `createAgent({connect: name})` reattach to it in milliseconds: no build, no boot. You can even scope the connection to a subset of that OS's loaded apps, so several agents can share one instance without each one seeing every app's tools. See the [`berth os` reference](./berth-os-reference.md) for the full command and API reference, and for how the reconnect mechanism actually works under the hood.

## Where it runs

Local Docker, for `berth dev`, `berth os up`, and `Computer.boot()` today. `berth deploy --fleet=e2b|daytona|k8s` ships the same sandbox definition to a remote provider, though `berth os up` and `Computer.connect()`'s reconnect mechanism is local-Docker-only so far. There's no "leave a persistent OS running and reconnect to it" story for a deployed fleet yet.
