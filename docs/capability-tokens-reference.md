# How enforcement works

When a sandbox boots, Berth turns each app's `berth.yml` capabilities into kernel rules and applies them before the app's own code runs. This page explains that step, so you can read the boot log and reason about what an app can and can't do. Which capability is enforced at which level is on [Enforcement](./kernel-enforcement.md#available-capabilities).

## See it on your machine

Boot any app and read its log. On a kernel that enforces, you'll see lines like:

```
[agent-init] landlock restrict_self() status: ruleset=FullyEnforced no_new_privs=true
[agent-init] restricted "filesystem" (FullyEnforced) — write access allowed only under: ...
[agent-init] running "filesystem" as uid 10000 (gid 10000, supplementary [...]) — no longer root
```

On a kernel that can't, you'll see `NOT RESTRICTED "<app>"` instead, and an undeclared write will succeed. Run [`berth doctor`](./doctor-reference.md) to find out which you have.

To check the whole boundary against a real app (writes, reads, network, symlink escapes, namespace creation, isolation between apps):

```bash
cd packages/docker-orchestrator
node test/capability-enforcement.mjs
```

It talks to the daemon at `DOCKER_HOST` (or `/var/run/docker.sock`), not your current Docker context. On a kernel without Landlock it reports its denial checks as not verified rather than passing them.

## What happens at boot

For each app, before its code starts:

1. **Compile the policy.** `generate-capability-policy.js` (in `@berthos/sdk`) reads `berth.yml` and writes a JSON policy. It uses `@berthos/manifest-schema` to parse capabilities, so there's one grammar. The app can read its policy file but not change it.
2. **Apply Landlock.** `agent-init`, a small Rust binary, builds a Landlock ruleset from the policy and applies it to itself:
   - writes (write, create, delete, rename, truncate) only under the declared write paths and the app's baseline;
   - reads only under the declared read paths plus a baseline, if the app declared any;
   - outbound TCP only to declared ports, unless the app declared `network:connect:*`;
   - listening only on declared bind ports.
3. **Drop Linux capabilities.** `CAP_SYS_ADMIN`, `CAP_NET_ADMIN` and `CAP_NET_RAW` are removed from the bounding, inheritable and ambient sets. The container holds the first two for Berth's own daemons; `CAP_NET_RAW` would let an app build TCP from raw packets and skip the port rules. `ping` doesn't work inside a sandbox as a result.
4. **Block namespace creation (seccomp), for every app.** `unshare(2)` and `clone(2)` with any `CLONE_NEW*` flag fail with `EPERM`, `setns(2)` fails with `EPERM`, and `clone3(2)` returns `ENOSYS` so libc falls back to `clone(2)`. Without this, creating a user namespace would hand the app back the capabilities step 3 removed.
5. **Block UDP and raw sockets (seccomp), for apps that declared no network capability.** `socket(2)` for `AF_INET`/`AF_INET6` datagram or raw sockets, and any `AF_PACKET` socket, fails with `EPERM`. Landlock has no rule for UDP, so this is what makes "no network" mean no network. Unix sockets and netlink are unaffected.
6. **Switch to the app's own uid.** Each app runs as uid and gid `10000 + its index` in the sandbox (10000 for a single app), irreversibly. This is what keeps apps sharing a sandbox out of each other's files, sockets and processes.
7. **Start the app.** `agent-init` `exec()`s the app. Landlock rules and seccomp filters are inherited by every process the app starts and can't be removed.

`requestCapability(appName, capability)` in `@berthos/sdk` returns `{ granted: boolean }`: whether the capability matches one the app declared. It doesn't grant anything; the kernel already decided at boot.

## When the kernel can't enforce

By default `agent-init` fails open: if Landlock isn't applied (or the policy can't be read), it prints a warning and starts the app unrestricted. That keeps `berth dev` working on Docker Desktop.

With `BERTH_REQUIRE_ENFORCEMENT=1` (or `true`) it fails closed instead. It refuses to start the app unless the ruleset status is exactly `FullyEnforced`, and also refuses if either seccomp filter or the uid switch fails. It logs a `capability_enforcement_refused` event and exits non-zero. Production images, which `Computer.boot()` uses, set this. See [Enforcement, by platform](./kernel-enforcement.md#kernel-enforcement-by-platform) for turning it off locally.

## Reference

### Policy file

Written to `.berth/capability-policy.json` in the app's directory (override with `BERTH_CAPABILITY_POLICY`).

| Field | Contents |
|---|---|
| `appName` | The manifest's `name` |
| `declaredCapabilities` | Every valid capability from `berth.yml`; invalid ones are dropped with a warning |
| `writePaths` | Declared `filesystem:write:` paths (a trailing `/*` is stripped), plus `/dev/null`, `/tmp/<app>` and `/run/berth/<app>`; plus `/dev/pts` and `/dev/ptmx` for `terminal:*` |
| `readPaths` | Always set. `/usr`, `/bin`, `/sbin`, `/lib`, `/etc`, `/proc`, `/dev`, `/tmp`, `/run/berth/<app>`, the working directory, the app's own write paths, the real locations of its dependencies (under `berth dev`, the checkout's `packages/` and `node_modules/.pnpm`; for a Python app, its SDK), and any declared `filesystem:read:` paths |
| `networkPorts` | Declared `network:connect:<port>` ports; plus the mesh coordinator's port (`BERTH_MESH_COORDINATOR_PORT`, default `4875`) for any `network:peer:` |
| `networkUnrestricted` | `true` if the app declared `network:connect:*` |
| `bindPorts` | Declared `network:bind:<port>` ports; plus the HTTP RPC bridge's port (`BERTH_HTTP_RPC_PORT`) for the app named by `BERTH_HTTP_RPC_APP`, or every app if that's unset; plus `7681` (ttyd) for `terminal:*` |
| `meshPeers` | Declared `network:peer:` names, read by the mesh daemon |

Declared filesystem paths must be `/workspace`, `/context`, `/tmp`, `/app` or beneath one, canonical, with `*` only as a trailing `/*`. The manifest schema rejects anything else, and `agent-init` checks write paths again before creating them.

### Environment variables

| Variable | Effect |
|---|---|
| `BERTH_REQUIRE_ENFORCEMENT` | `1` or `true`: refuse to start an app that isn't fully enforced. Set in production images. |
| `BERTH_CAPABILITY_POLICY` | Path of the policy file. Default `.berth/capability-policy.json`. |
| `BERTH_MANIFEST_PATH` | Manifest the policy is compiled from. Default `./berth.yml`. |
| `BERTH_APP_UID`, `BERTH_APP_GID`, `BERTH_APP_SUPPLEMENTARY_GIDS` | The identity `agent-init` switches to. Set by the container's entrypoint; without them the app stays root. |

### Audit events

`agent-init` writes one JSON line per event to the container log, with `"source":"agent-init"` and no text prefix, so you can parse them directly.

| `event` | Meaning |
|---|---|
| `capability_policy_applied` | The policy applied, with its paths, ports and the ruleset status (`FullyEnforced`, `PartiallyEnforced` or `NotEnforced`) |
| `capabilities_dropped` | Whether the capability drop succeeded |
| `namespace_seccomp_filter` | Whether namespace creation was blocked |
| `network_seccomp_filter` | Whether UDP and raw sockets were blocked, or why not |
| `app_uid_applied` | The uid and gid the app runs as, or why it stayed root |
| `capability_enforcement_refused` | `BERTH_REQUIRE_ENFORCEMENT` stopped the boot, with the reason |

## Limits

- Individual denials aren't logged. The audit events record what was granted at boot; a refused syscall just returns `EACCES` or `EPERM` to the app.
- Execution isn't scoped. With read scoping on, an app can't run a file it can't read, but there's no separate rule for executing.
- A `filesystem:read:` path that doesn't exist when the app starts stays unreadable for that boot. In a multi-app sandbox, apps start at the same time, so reading a directory that a sibling creates can lose the grant.
