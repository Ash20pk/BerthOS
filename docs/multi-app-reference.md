# Multi-App Sandbox Reference

See [What is a Berth OS?](./berth-os.md) and the README's [Resident apps](../README.md#resident-apps) section first if you're not yet familiar with those terms — this doc assumes them.

`berth dev`/`test`/`deploy` originally supported exactly one resident app per container. The real gap that closes: the pre-existing way to demo "multiple resident apps in one sandbox" (`packages/docker-orchestrator/test/context-bus-milestone.mjs`) bind-mounts the whole workspace and starts a second app via a raw `docker exec` — which bypasses `agent-init` entirely, so that second app gets **zero** Landlock enforcement. `--apps` gives every app in the container its own real, independently-enforced process.

## Using it

```bash
cd apps/filesystem
berth dev --apps=apps/code-editor
```

`--apps` takes comma-separated, **workspace-relative** paths to companion apps — not a new manifest format; each still just needs its own `berth.yml`, loaded with the same `loadManifest()` as the primary. Requires the primary app to be a pnpm workspace member (same precondition `berth dev`'s bind-mount already has for any workspace member — pnpm's relative symlinks point outside a single app's directory).

`berth test --apps=...` and `berth deploy --fleet=<x> --apps=...` accept the same flag — but don't run the same pre-build validation `berth dev` does; see the v1-scope constraints below.

## What changes under the hood

- **`entrypoint.sh`** branches on whether `BERTH_APPS` (a JSON array of `{name, workingDir}`, set by `container.ts` only when there's more than one app) is present. Absent: byte-for-byte today's single-app script. Present: loops over every app, running each one's own `on_install` → capability-policy-generation → `agent-init` chain as an independent backgrounded process — N sibling `agent-init` processes, each with its own Landlock ruleset, since Landlock binds a process and its own fork/exec descendants.
- **No app in multi-app mode reads the container's raw stdin** — including the primary. Two Node processes sharing one inherited stdin pipe was confirmed (by hand) to race for bytes, each receiving a truncated, unparseable fragment of the other's RPC line, silently breaking both. Every app instead gets its own Unix socket (`BERTH_RPC_SOCKET`, `@berth/sdk`'s `rpc.ts`) — same line-delimited JSON framing already used over stdio, just a second transport.
- **`invokeAppExport()`** (`@berth/docker-orchestrator`) is how the host reaches any one app's socket: `container.attach()` can only ever reach the container's own PID 1 stdio, not an arbitrary interior process, so this spawns a tiny relay (`docker/rpc-relay.js`) inside the container via `docker exec` that pipes its own stdio to the target socket. `berth rpc <appName> --export=<name> --input=<json>` is the CLI's documented entry point to this.
- **Production builds** (`berth test`/`deploy`) stage each app into its own `apps/<name>/` subdirectory instead of one flattened root (`image.ts`'s `companions` option) — dev builds don't need this, since dev source arrives via bind mount, never `COPY`'d into the image at all.
- **v1 scope: at most one app across the whole set may declare a `browser:*` capability** (`assertAtMostOneBrowserApp`) — two simultaneous browser-capable apps would need per-app Xvfb displays and dynamic VNC/CDP port allocation, real additional scope this pass doesn't attempt. The existing fixed port set is unchanged. Same constraint, same reason, for `terminal:*` (`assertAtMostOneTerminalApp`) — the ttyd port (7681) is a single fixed container port too, not allocated per-app; see `apps/terminal`. Same constraint again for `network:peer:*` (`assertAtMostOneMeshApp`) — `entrypoint.sh`'s `NEEDS_MESH` branch starts a single mesh daemon on a single `wg0` interface per container, not one per app; see [mesh reference](./mesh-reference.md). **Only `berth dev` (`dev.ts`) checks all three before build/start today. `berth test` and `berth deploy` (`test.ts`, `deploy.ts`) only call `assertAtMostOneBrowserApp`** — a terminal or mesh conflict between companion apps isn't caught pre-build/deploy there, only on `dev`.
- **`berth test`'s multi-app path** is structurally different from its single-app one-shot `docker.run(AutoRemove)`: there's no way to keep companions alive alongside a one-shot exec, so multi-app instead starts a real container (`startContainer`), execs the check inside the primary's own directory, then tears the container down.

## Reaching another app's exports

```
/run/berth/<app>/rpc.sock                    0600  <app>:<app>     the app itself, and root (the host relay)
/run/berth/<app>/peers/<caller>/rpc.sock     0660  <app>:<caller>  one authorized sibling, and nobody else
```

An app's own socket is not reachable by any sibling. A sibling that declares `app:invoke:<name>` gets a socket of its own under `peers/`, created at boot in a directory mode `2710` owned by the target and group-owned by the caller — so the caller is the only unprivileged uid that can traverse to it, and the connection's arrival there is the kernel's statement about who connected. That is what lets the target log which app invoked which export. Undeclared, `connect(2)` fails with `EACCES`. The host is unaffected: `invokeAppExport()` enters via `docker exec` as root, and the uid boundary is between apps, never between the host and an app.

This replaced a `1777` `/tmp/berth-rpc/` directory that every app could bind and connect into, which is [REMEDIATION 1.4](../REMEDIATION.md#14--app-rpc-sockets-in-world-writable-tmp-unauthenticated). One limit remains, recorded there: the grant is connect-time, so it authorizes a *caller* and not a per-export subset.

## Verification

`packages/docker-orchestrator/test/multi-app-milestone.mjs` — a real, running test: builds a real image, starts filesystem + code-editor together via the actual `--apps` path, and asserts **two separate** `[agent-init] landlock restrict_self()` status lines appear (proving each app got its own ruleset, not one enforced process plus an unenforced passenger), then confirms both apps are reachable via `invokeAppExport()` — including a real cross-app round trip (filesystem writes a file, code-editor reads it back through its own socket).

```bash
cd packages/docker-orchestrator
node test/multi-app-milestone.mjs
```
