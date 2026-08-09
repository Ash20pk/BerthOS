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

### `schema_version` (default: current — see below)

Which version of `berth.yml`'s *own shape* this file was written against — not the app's own `version` above, which is just its semver/Docker image tag and has nothing to do with the manifest format itself. Omit it entirely unless you have a specific reason not to; every `berth.yml` in this repo omits it today, and that's the expected common case, not a legacy path. See [Schema compatibility policy](#schema-compatibility-policy) below for what it's for and when you'd ever set it.

### `description` (default: `""`)

A short human-readable summary. Unused before Phase 5; the [app registry](./app-registry-reference.md) now surfaces it in `GET /apps` listings and matches it against `?q=` search terms.

### `capabilities` (default: `[]`)

A list of `namespace:action:scope` strings — e.g. `github:read:repos`, `browser:navigate:*.github.com`, `filesystem:read:/workspace`. `scope` may use a trailing/embedded `*` glob.

**`filesystem:` scopes are restricted to four path prefixes: `/workspace`, `/context`, `/tmp`, and `/app`** (or any path beneath one of them). A `filesystem:read:`/`filesystem:write:` scope isn't a label — `agent-init` creates the directory as uid 0 before it applies the Landlock ruleset. That mkdir used to land on your host through `berth dev`'s workspace bind mount; since [1.6](../REMEDIATION.md#16--berth-dev-bind-mounts-the-whole-host-repo-read-write) that mount is read-only, so it fails with `EROFS` and the grant is skipped with a warning instead — which is its own reason to declare a path that exists. So the scope must be an absolute, canonical path (no `.`, `..`, empty segments, or trailing slash) under one of those four, and `*` is only meaningful as a trailing `/*` — anywhere else it becomes a literal directory named `*` rather than a glob. `filesystem:write:/` is rejected outright; it grants the entire container filesystem. Anything else fails validation at load time, so `berth test`, `berth dev`, and `berth publish` all refuse the manifest with the offending line number rather than silently compiling it into a policy.

**Kernel-enforced, not just declared.** `filesystem:*` and `network:connect:*` grants are compiled into a Landlock policy that `agent-init` applies before your app's runtime even execs — an undeclared write or outbound connection is refused at the syscall boundary, not caught by a framework-level check. `requestCapability()` ([`@berth/sdk`](./sdk-reference.md)) reflects that same policy back to your code, returning `granted: false` for anything you didn't declare. See the [capability tokens reference](./capability-tokens-reference.md) for exactly what's kernel-enforced versus recorded-only. Declare capabilities honestly: enforcement trusts this list, and so does the [app registry](./app-registry-reference.md)'s listing, which shows them to anyone `berth init`-ing your app.

### `exports` (default: `[]`)

The RPC surface your app exposes. Each entry has a `name` and optional `input`/`output` — flat maps of field name to one of `string | number | boolean | object | array` (no nested objects in Phase 1; this is the wire-contract subset the SDK's stub-payload generator and RPC layer need).

**This list must exactly match your code's `app.export(...)` calls.** `@berth/sdk`'s runtime cross-checks this at container boot and hard-fails startup on mismatch — an export declared here but not implemented, or implemented but not declared, is a startup error, not a warning. This is what keeps `berth.yml` trustworthy for tooling (like `berth test`'s stub invocation, Phase 3's capability tokens, and the [app registry](./app-registry-reference.md)'s listing) that need to trust what this file says an app does.

### `on_install` (default: `[]`)

Shell commands run **once, at image build time** — e.g. `pip install -r requirements.txt`, `apk add <tool>`. They execute as a Docker build layer (`@berth/docker-orchestrator` generates a script from this list; `docker/run-on-install.sh` runs it), for both the `dev` and `production` targets.

They run under `bash`, not the container's BusyBox `/bin/sh`, so ordinary bashisms are fine. Each command runs with the app's directory as its working directory, which is why a relative `requirements.txt` resolves.

Two things follow from this being a build layer, and both are behaviour you can rely on:

- **Editing `on_install` requires a rebuild, not just a restart.** `berth dev`'s file watcher restarts the container when `berth.yml` changes; it does not rebuild the image. Restart `berth dev` to pick up a changed `on_install`. Editing your app's *source* is unaffected — that's still a plain restart, and `on_install` doesn't re-run.
- **A failing command fails the build,** with the command's own output, rather than producing a container that exits at boot for reasons you have to go digging in `docker logs` to find.

It did not always work this way. Until [REMEDIATION 1.5](../REMEDIATION.md#15--on_install-is-unsandboxed-root-shell-run-before-enforcement), `on_install` ran at container *boot*, from the SDK's lifecycle script, as uid 0 with `CAP_SYS_ADMIN` and no Landlock domain applied — necessarily before one existed, since the capability policy is generated moments later by the same script. That made any `berth.yml` arbitrary root code execution inside the sandbox meant to constrain it. Nothing executes this list at boot any more.

If you need setup that must happen in-process, at startup, rather than at build time, use the SDK's [`app.onInstall(fn)`](./sdk-reference.md) instead: it runs inside your app's own process, after `agent-init` has applied its Landlock domain, under the capabilities the manifest declares.

### `on_agent_ready` (default: `[]`)

Accepted and schema-validated, but **not currently executed by the runtime.** Nothing in `packages/sdk/src/runtime.ts` or `run-lifecycle.ts` reads or runs this list today — it's reserved/vestigial: you can declare it in `berth.yml` without error, but the shell commands you list here will not actually run.

Don't confuse this with the SDK's `app.onAgentReady(fn)` callback (see [`@berth/sdk` reference](./sdk-reference.md#apponagentreadyfn)), which is a completely different, real mechanism — a TypeScript callback registered in your app's code, run once your app's exports are registered (and, since `on_install` is now a build layer, necessarily long after it). The similar name is coincidental; only the SDK callback actually fires. If you need something to happen when your app comes up, use `app.onAgentReady(fn)`, not this manifest field.

### `expose` (default: `{ browser: true, terminal: true, preview: false }`)

Whether declaring `browser:*`/`terminal:*` also publishes the corresponding VNC/ttyd port to the host in `berth dev` (on `127.0.0.1`, credential-gated; Chromium's CDP port is never published). The capability itself (what the app is *allowed* to do) and exposure (whether a human can *watch* it happen over noVNC/ttyd) are separate decisions:

```yaml
capabilities:
  - browser:navigate:*.github.com
expose:
  browser: false   # capability still granted — no VNC port published to the host
```

`browser`/`terminal` both default to `true`, so an existing `berth.yml` with no `expose:` block keeps today's behavior unchanged (declaring the capability publishes the port). Set `browser: false` or `terminal: false` to run headless/unwatched — e.g. in CI, or for an app whose browser/terminal session shouldn't be reachable from the host at all.

**`preview` is a separate, deliberately opt-in decision for deployed fleets.** `browser`/`terminal` only ever govern local `berth dev` (one trusted operator, on their own machine). A deployed fleet instance is potentially public-facing, so declaring `browser:*`/`terminal:*` must never, by itself, cause a live noVNC/ttyd URL to appear the moment the app is deployed. `preview` defaults to `false` for exactly that reason:

```yaml
expose:
  preview: true   # opt in to a public/reachable noVNC/ttyd URL when this app is deployed
```

`berth deploy`/`berth fleet status` only create or print a preview URL when `preview: true` **and** the corresponding capability is declared — `preview: true` with no `browser:*`/`terminal:*` capability is a no-op, not an error, same as any other declared-but-unbacked intent elsewhere in this file. Scoped to noVNC/ttyd specifically, since both are WebSocket-based web protocols each deploy target's own port-exposure mechanism can carry; raw VNC (5900) and CDP (9222) aren't web protocols and stay local-only regardless. E2B exposes this via `sandbox.getHost(port)` (a real HTTPS reverse-proxy hostname), Daytona via `sandbox.getPreviewLink(port)` (same idea), and Kubernetes via a `Service` this adapter creates alongside the Pod, reporting the in-cluster DNS name — a real public URL there needs the cluster's own Ingress/LoadBalancer, which this adapter doesn't provision. See the [Kubernetes adapter reference](./k8s-adapter-reference.md#how-it-maps-to-deployadapter) for the K8s case in more depth.

### `governs` (default: `false`)

Declares this app as the governance authority for its `Computer` — every other loaded app's tool calls get wrapped so `Computer` awaits this app's `evaluate_action` export before the real call happens, and `allowed: false` throws a `GovernanceDeniedError` instead of calling through.

**Validated, not just declared.** `@berth/manifest-schema` hard-fails manifest loading if `governs: true` is set without a matching `evaluate_action` export declared in `exports:` — the same severity as the exports-must-match-code check above. At most one app per `Computer` may set `governs: true`; `Computer.boot()`/`Computer.connect()` throws at boot if more than one is loaded. See the [governance gate reference](./governance-reference.md) for the full `evaluate_action` contract, the fail-open timeout behavior, and how to build a governance app.

### `governance` (default: `{ exempt: false }`)

```yaml
governance:
  exempt: true
```

Lets an app opt out of being gated by whichever app declares `governs: true` in the same `Computer`. Only relevant when a governance app is actually loaded — with none loaded, this field has no effect. See the [governance gate reference](./governance-reference.md) for how the gate applies and its fail-open failure mode.

### `resources` (default: `{}`)

```yaml
resources:
  cpu: 0.5        # fractional cores
  memory_mb: 512  # MiB
  gpu: 1          # GPU count (best-effort; not every target enforces it — see below)
```

All three keys are optional and independent — declare only what you need. Omitting `resources:` entirely keeps every local sandbox exactly as unbounded as it's always been; this only ever narrows behavior for an app that opts in.

- **`docker-orchestrator`** (`berth dev`/`berth test`, local): `cpu` becomes `HostConfig.NanoCpus`, `memory_mb` becomes `HostConfig.Memory` (bytes), `gpu` becomes an `nvidia` `DeviceRequests` entry (the Docker Engine API's `--gpus` equivalent — needs the NVIDIA Container Toolkit on the host to actually do anything). A multi-app container (see `apps` in the [multi-app reference](./multi-app-reference.md)) takes the **max** of each field independently across every app sharing it, since the limit applies to the whole container, not one app's process within it.
- **`adapter-k8s`** (`berth deploy --fleet=k8s`): becomes the Pod's container `resources.requests` **and** `resources.limits` (Guaranteed QoS) for whichever of `cpu`/`memory` (`${memory_mb}Mi`)/`nvidia.com/gpu` were declared — the direct answer to "no protection against one noisy sandbox starving co-located ones": a Guaranteed pod can't be evicted for node-pressure reasons a BestEffort/Burstable one could be, and can't burst past what it declared either. `nvidia.com/gpu` is the standard NVIDIA device-plugin resource name; a cluster without that device plugin (or an AMD/other-vendor GPU) has no equivalent here.
- **`adapter-e2b`/`adapter-daytona`**: not wired — resource sizing on those platforms is controlled by the provider's own template/plan configuration, not a per-deploy request; out of scope for this field.

## Capability string grammar

```
namespace:action:scope
```

- `namespace` — the resource family (`github`, `browser`, `filesystem`, `network`, ...)
- `action` — what's being done (`read`, `write`, `navigate`, `screenshot`, `connect`, `peer`, ...)
- `scope` — what it applies to; may contain a `*` glob (e.g. `*.github.com` matches `api.github.com` but not `example.com`)

`@berth/manifest-schema`'s `matchesCapability(granted, requested)` implements glob matching on `scope` while requiring exact matches on `namespace`/`action` — this is the exact function the kernel-level token issuer calls to decide grants.

`app:invoke:<name>` lets this app call another resident app's exports directly, inside the same container. It is the *only* way to do so: since [REMEDIATION 1.4](../REMEDIATION.md#14--app-rpc-sockets-in-world-writable-tmp-unauthenticated) an app's own socket at `/run/berth/<app>/rpc.sock` is mode `0600`, reachable by that app and by root (the host relay) and nobody else. Declaring this capability gets the caller its own socket instead — `/run/berth/<target>/peers/<caller>/rpc.sock`, in a directory only the caller can traverse — created at boot. An app that declares nothing gets `EACCES` on `connect(2)`, from the kernel rather than from a check in the SDK. `@berth/agents` emits one of these per sibling whose exports it embeds as tools in a synthesized agent app.

Because each authorized caller reaches the target on a socket only it can reach, the target knows *which* app is calling without trusting anything on the wire, and logs it. That is the same property `SO_PEERCRED` gives the daemons; Node exposes no way to read peer credentials, so the identity comes from the path instead.

One limit worth knowing: it is a connect-time gate, so it says *who may call*, not *which exports they may call* — the target's whole export surface is reachable once granted. Naming an app that isn't in the same container is a warning at boot, not an error, since there is nothing to grant.

`network:peer:<name>` (e.g. `network:peer:database-service`, or `network:peer:*` for any peer) joins a resident app to a real WireGuard mesh with other apps whose own `network:peer:<pattern>` names it back — mutual consent, decided by `mesh-coordinator`, not a flat "everyone who opts in reaches everyone else" mesh. See [mesh reference](./mesh-reference.md).

## Schema compatibility policy

`berth.yml`'s shape is versioned via the `schema_version` field above, resolved in `@berth/manifest-schema`'s `validate.ts` before Zod ever sees the parsed object — `BerthManifestSchema` itself has no notion of versioning at all; it only ever validates "today's current shape." This section is the policy that decides when a schema change needs a version bump versus when it doesn't, and what happens at each of the three points a `berth.yml` can disagree with the schema it's validated against.

**Additive, defaulted changes never need a version bump.** Adding a new optional field with a sensible default (the way `expose`, `description`, and `governance` were all added) is always safe: an old `berth.yml` that predates the field simply gets the default, and nothing about it needs to change. This is the common case — most schema evolution should stay in this category.

**A version bump is required for anything that changes the *meaning* of an existing field, not just adds a new one** — renaming a field, changing a field's type or shape (e.g. a boolean becoming an object), or making a previously-optional field required. Anything in this category needs:

1. Bump `CURRENT_SCHEMA_VERSION` in `packages/manifest-schema/src/migrations.ts`.
2. Register a migration in that same file's `MIGRATIONS` map, keyed by the version it migrates *from* — it receives the old-shaped raw object and must return the new-shaped one.
3. Add a test (see `migrations.test.ts`) loading a manifest that declares the *old* `schema_version` and asserting it validates correctly after migration.

**What happens when a `berth.yml` doesn't match the schema it's checked against:**

- **No `schema_version` field at all** — treated as the current version, not as an ambiguous "version 0." Every `berth.yml` written before this field existed falls here, and must keep validating exactly as it always has.
- **`schema_version` older than current** — walked forward through the registered migrations, one version at a time, then validated against today's schema. If any step in that walk has no registered migration, this fails loudly with a clear error naming the missing step — it never silently returns the file unchanged and lets it fail Zod validation in a confusing, indirect way instead.
- **`schema_version` newer than this installed `@berth/manifest-schema` supports** — fails immediately with an "upgrade `@berth/manifest-schema`" error. The alternative (attempting to validate a file against a schema it was never written for) is exactly the kind of silent misinterpretation this mechanism exists to prevent.

Nothing in this repo has ever actually needed a migration yet — `CURRENT_SCHEMA_VERSION` is still `1`, and `MIGRATIONS[0]` in `migrations.ts` is a reference implementation proving the mechanism works, not a real historical shape this project shipped. It's there so the first real breaking change follows an established, tested pattern instead of improvising one under pressure.
