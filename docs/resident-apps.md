# Resident apps

What you build to extend what a Berth OS can do. The manifest schema itself is
[docs/manifest-reference.md](./manifest-reference.md); which of the capabilities
you declare are actually enforced, and by what, is
[docs/kernel-enforcement.md](./kernel-enforcement.md).

A resident app is what you build to extend what a Berth OS can do: a persistent, stateful process, loaded from a directory with a `berth.yml` manifest and some code, that declares capability-scoped permissions and exposes exports that become an agent's tools. Every first-party app (`apps/filesystem`, `apps/browser-native`, `apps/notes`) is built exactly this way. There's no separate, more privileged mechanism reserved for us.

Every app has two things at its root: a `berth.yml` manifest and an entry file that calls `defineApp()`.

**`berth.yml`** tells Berth what the app is called, what it's allowed to do, and what it exposes:

```yaml
name: hello-world
version: 0.1.0

capabilities: []

exports:
  - name: ping
    output: { message: string }

on_install: []
on_agent_ready:
  - "register_with_context_bus"
```

**`src/index.ts`** is the code behind those exports:

```ts
import { defineApp } from "@berth/sdk";
import { z } from "zod";

export default defineApp((app) => {
  app.export({
    name: "ping",
    output: z.object({ message: z.string() }),
    handler: () => ({ message: "pong" }),
  });

  app.onAgentReady(async (ctx) => {
    await ctx.contextBus.register({ app: "hello-world" });
  });
});
```

A few things worth knowing up front, because they'll bite you otherwise:

- **Exports have to match on both sides.** Every `app.export({ name })` call needs a matching entry in `berth.yml`'s `exports:` list, and the reverse is true too. A mismatch is a hard boot failure, not a warning.
- **You declare capabilities up front.** `capabilities:` is a list of `namespace:action:scope` strings, things like `filesystem:write:/workspace`, `browser:navigate:*.github.com`, or `network:connect:8090`. Filesystem and network scoping is compiled into a kernel policy applied before your app's code ever runs; the rest is brokered or recorded — the [capability table](./kernel-enforcement.md#available-capabilities) says which per capability, and the [capability tokens reference](./capability-tokens-reference.md) has the mechanics. An undeclared filesystem write or outbound connection is denied, not just left unenforced.
- **Granting a capability and exposing it aren't the same thing.** Declaring `browser:navigate:*` or `terminal:attach:*` is what lets `berth dev` publish the noVNC or ttyd port to the host, bound to `127.0.0.1` and gated by a password it prints per boot. Add an `expose:` block to opt out per app (`expose: { browser: false }`) and keep the capability while running headless. Both default to `true`. See the [manifest reference](./manifest-reference.md). This one's local-`berth dev`-only; deploying the same app to E2B/Daytona/K8s needs its own, separate opt-in — `expose: { preview: true }`, defaulting to `false` since a deployed instance is potentially public-facing.
- **`on_install` and `app.onInstall(fn)` aren't interchangeable, and they no longer even run at the same time.** `on_install` in `berth.yml` is shell baked into the image as a build layer — `pip install -r requirements.txt` and the like. The SDK's `onInstall` is a TypeScript callback that runs at startup, inside your app's own sandboxed process. Changing `on_install` needs a rebuild, not just a `berth dev` restart. See the [manifest reference](./manifest-reference.md#on_install-default-).
- **Network access is denied by default.** If your app needs to reach the outside world, route it through the egress broker instead of requesting a wide-open `network:connect:*`. See the [egress broker reference](./egress-broker-reference.md) and `apps/browser-native`'s `berth.yml` for the pattern.
- **The egress broker can chain through a further upstream proxy.** Set `BERTH_EGRESS_UPSTREAM_PROXY` on the container and every *allowed* CONNECT (`browser:navigate:<pattern>` or `network:host:<pattern>`, same mechanism) tunnels through it instead of connecting directly — useful for a residential/rotating proxy provider when a target site blocks datacenter IP ranges. Capability enforcement still runs first; a denied host never reaches the upstream proxy either. See the [egress broker reference](./egress-broker-reference.md#optional-chaining-through-an-upstream-proxy-eg-residential).

## Talking to other apps

Apps sharing a Berth OS get two things for free, both reachable from `AppContext` inside `onAgentReady`:

- **Context bus** (`ctx.contextBus`): `register`, `publish(topic, payload)`, `subscribe(topic, handler)`. A Rust daemon gives you real pub/sub between apps with no explicit orchestration. One app writes a file, another reacts to `fs.file_created`, and neither one knows the other exists. See [docs/context-bus-reference.md](./context-bus-reference.md).
- **Semantic FS** (`ctx.semanticFs`): `register`, `tag(path, meta)`, `query(text, limit)`. A filesystem mounted at `$BERTH_CONTEXT_MOUNT` (`/context` by default) that carries metadata about *why* each file exists — `created_by` (attributed automatically), plus the `task` and `relatedApps` you tag it with — and lets any app search that metadata instead of needing the exact path. Be clear about what the search is: a hybrid keyword-and-embedding ranker over **tag text**, not file content, and only for files something explicitly tagged. See [docs/semantic-fs-reference.md](./semantic-fs-reference.md#query-semantics--hybrid-keyword--embedding-similarity).

`apps/filesystem` and `apps/code-editor` show this in action: the first publishes `fs.file_created`, the second reacts to it.

Want more than one app in a single Berth OS, each still independently enforced by Landlock? Check [docs/multi-app-reference.md](./multi-app-reference.md) and pass `--apps` to `berth dev`, or to `berth os up`.

**Looking for something to build?** The first-party apps above are a small starting set. [CONTRIBUTING.md](../CONTRIBUTING.md#resident-apps-wed-love-to-see) has a running wishlist (Slack, Postgres, Gmail, Stripe, and more) plus the exact `berth init` → PR path.
