# berth.yml Reference

Every resident app has a `berth.yml` at its root. It's the single source of truth for what the app is called, what permissions it wants, and what it exposes — validated by `@berth/manifest-schema` (Zod is the source of truth; this document is hand-written prose, not auto-generated, because capability-string semantics need explanation Zod can't express on its own).

```yaml
name: github-assistant
version: 1.0.0

capabilities:
  - github:read:repos
  - github:write:issues
  - filesystem:read:/workspace
  - browser:navigate:*.github.com

exports:
  - name: create_issue
    input: { title: string, body: string }
  - name: get_repo_summary
    input: { repo: string }
    output: { summary: string, open_issues: number }

on_install:
  - "pip install -r requirements.txt"
on_agent_ready:
  - "register_with_context_bus"
```

## Fields

### `name` (required)

Lowercase alphanumeric with dashes (`^[a-z0-9-]+$`). Used as the Docker image name (`berth/<name>:<version>`) and the context-bus registration identity.

### `version` (required)

Strict semver (`x.y.z`).

### `description` (default: `""`)

A short human-readable summary. Unused before Phase 5; the [app registry](./app-registry-reference.md) now surfaces it in `GET /apps` listings and matches it against `?q=` search terms.

### `capabilities` (default: `[]`)

A list of `namespace:action:scope` strings — e.g. `github:read:repos`, `browser:navigate:*.github.com`, `filesystem:read:/workspace`. `scope` may use a trailing/embedded `*` glob.

**Kernel-enforced, not just declared.** `filesystem:*` and `network:connect:*` grants are compiled into a Landlock policy that `agent-init` applies before your app's runtime even execs — an undeclared write or outbound connection is refused at the syscall boundary, not caught by a framework-level check. `requestCapability()` (`@berth/sdk`) reflects that same policy back to your code, returning `granted: false` for anything you didn't declare. See the [capability tokens reference](./capability-tokens-reference.md) for exactly what's kernel-enforced versus recorded-only. Declare capabilities honestly: enforcement trusts this list, and so does the [app registry](./app-registry-reference.md)'s listing, which shows them to anyone `berth init`-ing your app.

### `exports` (default: `[]`)

The RPC surface your app exposes. Each entry has a `name` and optional `input`/`output` — flat maps of field name to one of `string | number | boolean | object | array` (no nested objects in Phase 1; this is the wire-contract subset the SDK's stub-payload generator and RPC layer need).

**This list must exactly match your code's `app.export(...)` calls.** `@berth/sdk`'s runtime cross-checks this at container boot and hard-fails startup on mismatch — an export declared here but not implemented, or implemented but not declared, is a startup error, not a warning. This is what keeps `berth.yml` trustworthy for tooling (like `berth test`'s stub invocation, Phase 3's capability tokens, and the [app registry](./app-registry-reference.md)'s listing) that need to trust what this file says an app does.

### `on_install` (default: `[]`)

Shell commands run once when the app's container is first built/started — e.g. `pip install -r requirements.txt`, `apt-get install -y <tool>`. These aren't Node-specific: they run via `bash -c` inside the container, so any interpreter available in the base image (Python, Node, etc.) works. Skipped on warm restarts (`berth dev` hot reload) via a marker file, so editing your app's source doesn't re-run these every time.

### `on_agent_ready` (default: `[]`)

Shell commands (or, more commonly, effectively-named hooks like `"register_with_context_bus"`) run after `on_install` and after your app's `onAgentReady` SDK callbacks. The actual registration happens via the SDK's `ctx.contextBus.register()` call, which talks to the real `context-bus-daemon` (Rust, one per sandbox) over a Unix socket — see the [context bus reference](./context-bus-reference.md).

### `expose` (default: `{ browser: true, terminal: true, preview: false }`)

Whether declaring `browser:*`/`terminal:*` also publishes the corresponding VNC/CDP/ttyd port to the host in `berth dev`. The capability itself (what the app is *allowed* to do) and exposure (whether a human can *watch* it happen over noVNC/ttyd) are separate decisions:

```yaml
capabilities:
  - browser:navigate:*.github.com
expose:
  browser: false   # capability still granted — no VNC/CDP port published to the host
```

`browser`/`terminal` both default to `true`, so an existing `berth.yml` with no `expose:` block keeps today's behavior unchanged (declaring the capability publishes the port). Set `browser: false` or `terminal: false` to run headless/unwatched — e.g. in CI, or for an app whose browser/terminal session shouldn't be reachable from the host at all.

**`preview` is a separate, deliberately opt-in decision for deployed fleets.** `browser`/`terminal` only ever govern local `berth dev` (one trusted operator, on their own machine). A deployed fleet instance is potentially public-facing, so declaring `browser:*`/`terminal:*` must never, by itself, cause a live noVNC/ttyd URL to appear the moment the app is deployed. `preview` defaults to `false` for exactly that reason:

```yaml
expose:
  preview: true   # opt in to a public/reachable noVNC/ttyd URL when this app is deployed
```

`berth deploy`/`berth fleet status` only create or print a preview URL when `preview: true` **and** the corresponding capability is declared — `preview: true` with no `browser:*`/`terminal:*` capability is a no-op, not an error, same as any other declared-but-unbacked intent elsewhere in this file. Scoped to noVNC/ttyd specifically, since both are WebSocket-based web protocols each deploy target's own port-exposure mechanism can carry; raw VNC (5900) and CDP (9222) aren't web protocols and stay local-only regardless. E2B exposes this via `sandbox.getHost(port)` (a real HTTPS reverse-proxy hostname), Daytona via `sandbox.getPreviewLink(port)` (same idea), and Kubernetes via a `Service` this adapter creates alongside the Pod, reporting the in-cluster DNS name — a real public URL there needs the cluster's own Ingress/LoadBalancer, which this adapter doesn't provision. See [Shipping to production](./shipping-to-production.md) for the full picture.

## Capability string grammar

```
namespace:action:scope
```

- `namespace` — the resource family (`github`, `browser`, `filesystem`, `network`, ...)
- `action` — what's being done (`read`, `write`, `navigate`, `screenshot`, `connect`, `peer`, ...)
- `scope` — what it applies to; may contain a `*` glob (e.g. `*.github.com` matches `api.github.com` but not `example.com`)

`@berth/manifest-schema`'s `matchesCapability(granted, requested)` implements glob matching on `scope` while requiring exact matches on `namespace`/`action` — this is the exact function the kernel-level token issuer calls to decide grants.

`network:peer:<name>` (e.g. `network:peer:database-service`, or `network:peer:*` for any peer) joins a resident app to a real WireGuard mesh with other apps whose own `network:peer:<pattern>` names it back — mutual consent, decided by `mesh-coordinator`, not a flat "everyone who opts in reaches everyone else" mesh. See [mesh reference](./mesh-reference.md).
