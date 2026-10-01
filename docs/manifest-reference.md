# berth.yml reference

Every resident app has a `berth.yml` at its root. It names the app, lists what the app may touch, and declares the functions it exports. Berth validates it with `@berthos/manifest-schema` before anything builds or boots, and compiles its capabilities into the kernel policy the app runs under.

The format is also published as a standalone, versioned spec with a conformance suite: [spec/capability-manifest](../spec/capability-manifest). Where this page and the spec disagree about what a field means, the spec wins.

```yaml
name: github-assistant
version: 1.0.0
description: Read repos and open issues

capabilities:
  - github:read:repos
  - github:write:issues
  - network:connect:8092          # the GitHub API proxy's port
  - filesystem:read:/workspace

secrets:
  - GITHUB_TOKEN

exports:
  - name: create_issue
    input: { title: string, body: string }
  - name: get_repo_summary
    input: { repo: string }
    output: { summary: string, open_issues: number }

on_install:
  - "pip install -r requirements.txt"
```

## Fields

| Field | Type | Default | What it does |
|---|---|---|---|
| [`name`](#name-required) | string, `^[a-z0-9-]+$` | required | App identity and image name |
| [`version`](#version-required) | string, `x.y.z` | required | App version and image tag |
| [`schema_version`](#schema_version-default-current) | non-negative integer | current (`1`) | Which shape of `berth.yml` this file is written in |
| [`description`](#description-default-) | string | `""` | Summary shown by the app registry |
| [`runtime`](#runtime-default-node) | `node` or `python` | `node` | The language the app is written in |
| [`capabilities`](#capabilities-default-) | list of `namespace:action:scope` | `[]` | What the app may touch |
| [`secrets`](#secrets-default-) | list of env var names | `[]` | Credentials delivered only to this app |
| [`exports`](#exports-default-) | list of export specs | `[]` | The functions the app exposes as tools |
| [`on_install`](#on_install-default-) | list of shell commands | `[]` | Build-time setup commands |
| [`on_agent_ready`](#on_agent_ready-default-) | list of strings | `[]` | Accepted but never run |
| [`expose`](#expose-default-browser-true-terminal-true-preview-false) | object | `{browser: true, terminal: true, preview: false}` | Whether a human can watch the browser or terminal |
| [`governs`](#governs-default-false) | boolean | `false` | Makes this app the governance authority |
| [`governance`](#governance-default-exempt-false) | object | `{exempt: false}` | Opts this app out of governance |
| [`resources`](#resources-default-) | object | `{}` | This app's CPU, memory, task and GPU limits |

### `name` (required)

Lowercase letters, digits and dashes. Berth uses it as the image name (`berth/<name>:<version>` for `berth publish` and `berth deploy`; `berth/<name>:dev-<hash>` for `berth dev` and `berth/<name>:<version>-<hash>` for `berth test`, where `<hash>` is 8 hex digits derived from the app directory's path, so two checkouts of an app with the same name don't share an image), the app's identity on the context bus, and the name other apps use in `app:invoke:<name>`.

### `version` (required)

Strict semver: `x.y.z`. Used as the image tag.

### `schema_version` (default: current)

The version of the `berth.yml` format itself, not of your app. Leave it out. Omitted means the current version, which is `1`. See [Schema versions](#schema-versions).

### `description` (default: `""`)

A one-line summary. The [app registry](./app-registry-reference.md) shows it in listings and matches search terms against it.

### `runtime` (default: `node`)

The language the app's code is written in: `node` (the [TypeScript SDK](./sdk-reference.md)) or `python` (the [Python SDK](./sdk-python-reference.md)). Every way of running an app reads it, `berth test` included, and apps with different runtimes can share one sandbox. It is recorded in the image when the image is built, so changing it needs a rebuild, as `on_install` does.

### `capabilities` (default: `[]`)

A list of `namespace:action:scope` strings. Anything not declared is denied. The forms Berth acts on, and what each one grants, are in [Capabilities](#capabilities) below.

Declare only what the app needs. The kernel policy is built from this list, and the app registry shows it to anyone installing your app.

### `secrets` (default: `[]`)

Names of environment variables this app needs as credentials. Names only, never values: the values come from the environment Berth is booted with.

```yaml
secrets:
  - GITHUB_TOKEN
```

A name declared by any app in the sandbox is removed from the shared secrets file and delivered only to the apps that declared it, each through its own `0600` file. If a declared name has no value at boot, Berth warns (by name, never by value) and the app boots without it. Each entry must be a valid env var name (`^[A-Za-z_][A-Za-z0-9_]*$`). See the [secrets reference](./secrets-reference.md).

### `exports` (default: `[]`)

The functions your app exposes. Each becomes a tool an agent can call.

```yaml
exports:
  - name: get_repo_summary
    input: { repo: string }
    output: { summary: string, open_issues: number }
```

| Key | Type | Required |
|---|---|---|
| `name` | string | yes |
| `input` | flat map of field name to type | no |
| `output` | flat map of field name to type | no |

Types are `string`, `number`, `boolean`, `object` or `array`. Nested field maps aren't supported; use `object`.

**This list must match your code exactly.** Every `app.export({ name })` in your code needs an entry here, and every entry here needs an `app.export`. Any mismatch stops the app at boot with an error that names the missing exports:

```
exports mismatch between berth.yml and app code — declared in berth.yml but not implemented: create_issue
```

### `on_install` (default: `[]`)

Shell commands that run once, when the image is built. Use them for dependencies: `pip install -r requirements.txt`, `apk add <tool>`.

- They run under `bash`, with the app's directory as the working directory.
- A failing command fails the build and shows the command's output.
- Nothing runs them at container boot. **Changing `on_install` needs a rebuild.** `berth dev` restarts the container when `berth.yml` changes but doesn't rebuild the image, so stop and restart `berth dev`.
- An entry can't be empty or contain a NUL byte.

For setup that has to happen at startup inside your app's process, use the SDK's [`app.onInstall(fn)`](./sdk-reference.md#apponinstallfn). It runs under your app's declared capabilities.

### `on_agent_ready` (default: `[]`)

Accepted and validated, but **never executed**. Nothing reads it. To run code when your app comes up, use the SDK's [`app.onAgentReady(fn)`](./sdk-reference.md#apponagentreadyfn).

### `expose` (default: `{browser: true, terminal: true, preview: false}`)

Whether a human can watch the app's browser or terminal. This is separate from the capability: declaring `browser:*` lets the app drive a browser; `expose` decides whether you can see it.

| Key | Default | What it does |
|---|---|---|
| `browser` | `true` | `berth dev` publishes noVNC and VNC ports for an app that declares a `browser:*` capability |
| `terminal` | `true` | `berth dev` publishes the ttyd port for an app that declares a `terminal:*` capability |
| `preview` | `false` | `berth deploy` and `berth fleet status` create and print a noVNC/ttyd URL on a deployed instance |

`browser` and `terminal` apply to local `berth dev` only. Published ports bind to `127.0.0.1` and need a credential that `berth dev` prints fresh on each boot. Chromium's debugging port is never published. Set them to `false` to run headless, for example in CI:

```yaml
capabilities:
  - browser:navigate:*.github.com
expose:
  browser: false   # the app still drives the browser; no VNC port is published
```

`preview` is off by default because a deployed instance can be public. It only has an effect when the matching `browser:*` or `terminal:*` capability is declared. Only noVNC and ttyd are ever previewed; raw VNC and Chromium's debugging port stay inside the sandbox. E2B and Daytona give you a public HTTPS URL. Kubernetes gets a `Service` and reports its in-cluster DNS name; a public URL there needs your own Ingress or LoadBalancer (see the [Kubernetes adapter](./k8s-adapter-reference.md#how-it-maps-to-deployadapter)).

### `governs` (default: `false`)

Makes this app the governance authority for the apps it shares a sandbox with. Before any other app's export runs, Berth asks this app's `evaluate_action` export, and a denial stops the call. If the governor can't be reached, the call is refused.

`governs: true` requires an `evaluate_action` entry in `exports`, or the manifest fails validation. Load at most one governing app per sandbox. See the [governance reference](./governance-reference.md) for the `evaluate_action` contract.

### `governance` (default: `{exempt: false}`)

```yaml
governance:
  exempt: true
```

Opts this app out of the governing app's checks. Has no effect when no app declares `governs: true`.

### `resources` (default: `{}`)

```yaml
resources:
  cpu: 0.5        # cores, fractional allowed
  memory_mb: 512  # MiB, integer
  pids: 256       # most processes + threads at once, integer
  gpu: 1          # GPU count, integer
```

All four keys are optional positive numbers, and each is a limit on this app, not on the sandbox it shares with other apps. An app that leaves `resources` out still gets a default: an equal CPU share and 1024 tasks.

| Where it runs | What happens |
|---|---|
| `berth dev`, `berth test` (local Docker) | Each app runs in its own cgroup: `cpu` becomes `cpu.max`, `memory_mb` becomes `memory.max` (with no swap, so an app past it is OOM-killed), and `pids` becomes `pids.max` (1024 if unset). The container is capped at the sum of its apps plus a reserve for the Berth daemons. Per-app cgroups need a host that can delegate them (cgroup v2 with `nsdelegate`, Docker 28+), and `berth doctor` says whether yours can. Elsewhere `berth dev` warns and applies only the container-level caps, and a production image (`berth test`, `Computer.boot()`) refuses to boot. See [resource limits](./resource-limits.md). `gpu` requests NVIDIA GPUs for the whole container (the largest count any app asks for), which needs the NVIDIA Container Toolkit on the host. |
| `berth deploy --fleet=k8s` | Each declared key becomes both the Pod's request and its limit (`cpu`, `${memory_mb}Mi`, `nvidia.com/gpu`), giving Guaranteed QoS. `gpu` needs the NVIDIA device plugin on the cluster. `pids` is ignored: a Pod's task limit is kubelet configuration, not a Pod field. |
| `berth deploy --fleet=e2b` or `daytona` | Ignored. Sizing comes from the provider's template or plan. |

## Capabilities

A capability is `namespace:action:scope`. The namespace and action are lowercase letters, digits, `_` and `-`; the scope is anything after the second colon and may contain `*` globs (`*.github.com` matches `api.github.com`, not `example.com`). A declared capability covers a request when the namespace and action match exactly and the scope matches the glob.

| Capability | What it grants | Enforced by |
|---|---|---|
| `filesystem:write:<path>` | Write, create, delete and rename under `<path>`. Without one, the app can write only to its own scratch directory, `/tmp/<app>`. | Kernel |
| `filesystem:read:<path>` | Adds `<path>` to what the app can read. Reads are always scoped: without any declaration an app reads a system baseline (`/usr`, `/bin`, `/lib`, `/etc`, `/proc`, `/dev`, `/tmp`), its own directory, what it may write, and its dependencies. Another app's directory is readable only if a path the app may write or declares contains it; under `berth dev`, `/workspace` is the whole checkout (read-only), so an app that may write `/workspace` can read every app's directory in it. | Kernel |
| `network:connect:<port>` | Outbound TCP to that port. Without any, the app has no outbound network at all, including UDP and raw sockets. | Kernel |
| `network:connect:*` | Outbound TCP to any port. An escape hatch; prefer a proxy port. | Kernel |
| `network:bind:<port>` | Listening on that port. `*` isn't accepted. | Kernel |
| `network:host:<pattern>` | Outbound requests through the egress proxy to hosts matching `<pattern>`, ports 80 and 443. Add `:<port>` or `:*` to the pattern for other ports. Also declare `network:connect:8090`. | Egress proxy |
| `browser:navigate:<pattern>` | The same host allowlist as `network:host:`, for a browser. Any `browser:*` capability also starts the display stack that noVNC shows. | Egress proxy |
| `browser:screenshot:*` | Recorded only. | Nothing |
| `terminal:attach:*` | Access to pty devices, so the app can run a shell. Any `terminal:*` capability also lets ttyd listen and be exposed. | Kernel |
| `github:read:<scope>` | GitHub API `GET` and `HEAD` for that scope (`repos`, `issues`, `user:emails`, ...). Also declare `network:connect:8092`. | GitHub API proxy |
| `github:write:<scope>` | Every other GitHub API method for that scope. | GitHub API proxy |
| `app:invoke:<name>` | Calling the exports of app `<name>` in the same sandbox. | Kernel (socket permissions) |
| `network:peer:<name>` | Joining a WireGuard mesh with apps whose own `network:peer:` names this app back. `*` matches any peer. | Mesh coordinator |

Any other string is valid and recorded. [`requestCapability()`](./sdk-reference.md#requestcapabilityappname-capability) reports it as granted if declared, but nothing enforces it. Which layer enforces each capability, per platform, is in [enforcement](./kernel-enforcement.md#available-capabilities).

### Filesystem paths

A `filesystem:read:` or `filesystem:write:` scope must be:

- absolute and canonical: no `.`, `..`, empty segments or trailing slash
- `/workspace`, `/context`, `/tmp` or `/app`, or a path beneath one of them
- free of `*`, except a trailing `/*`, which means the same as the directory itself

A `filesystem:write:` scope also can't name a path inside a `node_modules` directory: that is an app's dependencies, and a directory created there for an app would let it put a module where Node looks before the real one. Reading there is fine.

`filesystem:write:/` is refused. Berth creates each declared write path at boot, before enforcement starts, which is why the scope can't be an arbitrary string. Under `berth dev` your project folder is mounted read-only, so a declared path that doesn't exist there is skipped with a warning; declare paths that exist.

### Proxied network access

The kernel sees ports, not hostnames. So hostname and API scoping go through a proxy inside the sandbox, and the app needs the kernel grant to reach the proxy's port:

```yaml
capabilities:
  - network:host:api.example.com
  - network:connect:8090           # the egress proxy
```

Call [`configureEgressProxy()`](./sdk-reference.md#configureegressproxy) once to route your app's `fetch()` through it. See the [egress proxy](./egress-broker-reference.md) and [GitHub API scoping](./github-api-scoping-reference.md) references.

### Calling another app

`app:invoke:<name>` gives the calling app its own socket to the target, `/run/berth/<name>/peers/<caller>/rpc.sock`, which no other app can reach. Without it, connecting fails with `EACCES`. Because the socket belongs to one caller, the target knows which app is calling and logs it.

- The grant covers all of the target's exports, not a subset.
- Naming an app that isn't in the same sandbox is a warning at boot, not an error.

See [Talking to other apps](./resident-apps.md#talking-to-other-apps) and the [multi-app reference](./multi-app-reference.md). For the mesh, see the [mesh reference](./mesh-reference.md).

## Validation errors

`berth dev`, `berth test`, `berth init` and `berth publish` load the manifest first and refuse an invalid one, naming the file, line and field:

```
invalid berth.yml:
berth.yml:6 capabilities.0: filesystem path must be /workspace, /context, /tmp, /app or a path beneath one of them, got "/etc"
```

From code, `loadManifest(path)` reads and validates a file, and `validateManifest(obj)` validates an object you've already parsed. Both are in `@berthos/manifest-schema` and throw `ManifestValidationError`, whose `issues` list carries each `message`, `path`, `line` and `column`.

## Schema versions

`schema_version` versions the format of `berth.yml`, so a future breaking change can migrate old files instead of misreading them. The current version is `1`.

| `schema_version` | Result |
|---|---|
| omitted | Treated as current |
| older than current | Migrated forward one version at a time, then validated. Fails with a clear error if a migration step is missing. |
| newer than your `@berthos/manifest-schema` | Fails with an error telling you to upgrade `@berthos/manifest-schema` |
| not a non-negative integer | Fails |

New optional fields with defaults don't change the version. Renaming a field, changing its type, or making it required does, and ships with a migration.
