# Per-app uid: design

Every process in a Berth container runs as uid 0 today — the three daemons, both brokers, the display stack, and every resident app. This document is the design for changing that, written before any of it is built, because it is the shared unlock for three separate [remediation](../REMEDIATION.md) items and doing it three times partially would be worse than doing it once badly.

It is a design, not a plan of record. Where a decision is still open it says so, and where the cost is real it states the cost rather than the benefit.

## What it unlocks, and what it does not

| Item | What per-app uid gives it |
|---|---|
| [1.4](../REMEDIATION.md#14--app-rpc-sockets-in-world-writable-tmp-unauthenticated) — cross-app RPC borrowing | The whole fix. A `0700` socket directory owned by the serving app's uid is what stops a sibling connecting; `SO_PEERCRED` is what lets the server say *which* sibling is calling |
| [1.11](../REMEDIATION.md#111--signals-unrestricted-any-app-can-kill-the-governor) — unrestricted signals | The whole fix. `kill(2)` between different uids is refused by the kernel's ordinary permission check, with no new mechanism needed |
| [1.14](../REMEDIATION.md#114--unbounded-frame-allocation-and-spoofable-identity-in-the-daemons) — spoofable daemon identity | The *precondition*. `SO_PEERCRED` on the context-bus and semantic-FS control sockets returns uid 0 for every caller today, so deriving identity from it carries exactly zero information until uids differ |
| [1.5](../REMEDIATION.md#15--on_install-is-unsandboxed-root-shell-run-before-enforcement) — `on_install` as root | Nothing, and the dependency runs the other way — see [Blocker 4](#blocker-4--on_install-is-defined-as-a-root-shell) |
| [1.7](../REMEDIATION.md#17--ttyd--vnc--cdp-unauthenticated-on-all-host-interfaces) — Chromium `--no-sandbox` | A possible removal, at a cost that may not be worth paying — see [Blocker 5](#blocker-5--chromiums-own-sandbox-wants-the-thing-13-just-took-away) |

What it does **not** give: any defence on a kernel where Landlock is unenforced but DAC still works — this is DAC, so it holds on Docker Desktop too, which is a genuine advantage over the Landlock layer. And no defence against the `docker exec` path, which enters as root by design and must keep doing so ([Blocker 7](#blocker-7--the-host-relay-must-stay-root)).

## The premise correction that motivates the design

`packages/sdk/src/generate-capability-policy.ts:43-45` says `/tmp` is in the unconditional baseline write set partly because "connecting to a Unix socket requires write access to it." That is true of DAC. It is **not** true of the Landlock ruleset, and the difference is the whole reason this document exists.

Landlock's filesystem enforcement hangs off `security_file_open` and a set of `path_*` hooks. Connecting to a pathname socket goes through `unix_find_other()` → `inode_permission(MAY_WRITE)`, and Landlock implements no `inode_permission` hook. ABI 6 added `LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET`, which — as the name says — scopes *abstract* sockets, not pathname ones. So a Landlock ruleset that omits `/tmp` from an app's write paths does not stop that app connecting to `/tmp/berth-rpc/filesystem.sock`.

The consequence: 1.4 cannot be closed by narrowing the Landlock policy. It needs DAC (uids and mode bits), or an application-layer secret, or both. That is a claim worth re-testing on a real kernel before Step 2 below rests on it — see [Verification](#verification).

## Target model

**Assignment.** Each app in a container gets uid = `10000 + index`, where `index` is its position in `BERTH_APPS` (single-app mode is index 0, so uid 10000 always). A per-app group of the same id, plus one shared supplementary group `berth` (gid 9999) for the resources every app is meant to reach.

Index-derived rather than name-hashed because a hash collides and the failure mode of a collision is two apps silently sharing an identity — the exact thing being fixed. Index is stable across boots as long as the app list is, which matters for the one piece of uid-owned state that outlives a container: the install-marker volume bind-mounted at `$workingDir/.berth` (`container.ts:228`). A reordered app list changes ownership of that volume, so boot must `chown` it rather than assume it.

**Where the switch happens.** Inside `agent-init`, immediately before `exec`, after everything else it does:

```
apply_policy()          # create_dir_all() the declared write paths — needs root
  restrict_self()       # Landlock domain: inode-based, unaffected by the uid change
drop_all_capabilities() # bounding set
install_no_new_namespaces_filter()
install_no_udp_no_raw_filter()   # (conditional)
setgroups() / setresgid() / setresuid()   # ← new, and last
exec()
```

Not `setpriv` in `entrypoint.sh`, which was the other candidate. Keeping it in `agent-init` preserves the property that every irreversible narrowing happens in one place, in one auditable order, and it keeps `create_dir_all()` running as root — which it must, since the app's declared write paths may not exist yet and their parents are root-owned.

Ordering note: `setresuid()` away from 0 clears the permitted and effective capability sets by the kernel's own rule, so there is no `capset` back to root afterward — but the code should assert that rather than rely on it, and `SECBIT_KEEP_CAPS` must not be set. `setgroups()` before `setresgid()` before `setresuid()`, in that order, because each later call is the one that removes the privilege needed for the earlier ones.

**What stays root.** The three daemons (context-bus, semantic-FS, mesh), both brokers, and the display stack. They start before any `agent-init` and are deliberately outside every app's Landlock domain; that is unchanged, and remains B4 in the [threat model](./threat-model.md). Making them non-root is a separate, later question — semantic-FS genuinely needs `CAP_SYS_ADMIN` for its FUSE mount, and mesh-daemon needs `CAP_NET_ADMIN` for `wg0`.

**Socket layout after the change.**

| Path | Mode | Owner | Reachable by |
|---|---|---|---|
| `/run/berth/<app>/rpc.sock` | dir `0700` | `<app>` | that app, plus root (the host relay) |
| `/tmp/<app>/` | dir `0700` | `<app>` | that app, plus root |
| `/tmp/berth-context-bus.sock` | `0660` | `root:berth` | every app — by design |
| `/tmp/berth-semantic-fs.sock` | `0660` | `root:berth` | every app — by design |
| `/tmp/berth-mesh.sock` | `0660` | `root:berth` | every app that declared `network:peer:*` |

The daemon sockets stay reachable by every app because `entrypoint.sh:103-107` already documents that as intentional ("only the control socket is unconditionally reachable"). Uid separation buys nothing there directly — its value is that `SO_PEERCRED` on those sockets finally distinguishes callers, which is 1.14's identity half.

`/tmp` itself comes out of `BASELINE_WRITE_PATHS`, replaced by the per-app `/tmp/<app>`. Anything in the image that writes to a hardcoded `/tmp` path needs auditing first — `XDG_CONFIG_HOME=/tmp/.chromium` (`base.Dockerfile:127`) and `BERTH_GITHUB_API_BROKER_CERT_DIR=/tmp/berth-github-api-broker` (`entrypoint.sh:151`) are the two known ones.

## Blockers

Each of these is a thing that breaks the moment an app is not uid 0. They are ordered by how likely they are to change the design rather than merely cost a day.

### Blocker 1 — `/workspace` is host-owned in `berth dev` — **mostly dissolved**

> **Largely resolved since this was written**, by 1.6 rather than by any of the four options below. `berth dev` now mounts the workspace root **read-only**, so no app writes host-owned files there at all and the ownership question simply doesn't arise for the repo. What remains writable is two paths Berth creates itself: a per-app named volume for `.berth` (Docker-owned, `chown`able at boot with no effect on the developer's tree) and the shared `.berth/dev-workspace` directory. Both can be given to a per-app uid or a shared `berth` group without the mutation problem that made options 1 and 2 unacceptable.
>
> What's left of this blocker is much smaller: `.berth/dev-workspace` is a host directory owned by the developer, so a synthetic uid still can't write it without a `chgrp` — but `chgrp`ing one Berth-created, gitignored directory is a different proposition from `chown -R`-ing someone's repository. **The open decision is now narrow enough not to gate the design.** Option 4 is no longer needed as a hedge.
>
> The reasoning below is kept because the `CAP_DAC_OVERRIDE` mechanics still apply to the writable paths, and because option 3's objection still stands.

`workspace.ts` used to bind-mount the host repo read-write at `/workspace`, so its contents are owned by whatever uid the developer or CI runner has. Root writes it today only because of `CAP_DAC_OVERRIDE`, and this is not hypothetical: `drop_all_capabilities()`'s doc comment (`main.rs:172-180`) records a real CI run where dropping the whole capability set stripped `CAP_DAC_OVERRIDE` and "every write inside the declared `/workspace` path started failing with `EACCES`." A per-app uid reproduces that failure deliberately, and this time `CAP_DAC_OVERRIDE` cannot be kept as the escape hatch, because keeping it would let the app write every other app's files too and defeat the point.

Four apps declare `filesystem:write:/workspace` (`code-interpreter`, `notes`, `terminal`, `filesystem`), so this is the common path, not an edge case.

It also does not fail uniformly, which is worse than failing: Docker Desktop for Mac remaps ownership through virtiofs/gRPC-FUSE so almost anything appears to work, while a Linux host bind-mounts real inodes and enforces real ownership. A design validated only on a Mac would look finished and break in CI — the same shape as [0.1](../REMEDIATION.md#01--berthagents-cannot-run-on-macos-at-all) and [1.15](../REMEDIATION.md#115--appsterminal-is-non-functional-on-any-landlock-enforcing-kernel).

**Options, none free.**

1. `chown -R` the bind mount to the app's uid at boot. Mutates the developer's own working tree — unacceptable for `berth dev`, whose whole point is that `/workspace` *is* your repo.
2. Add every app uid to a group that owns the mount, via `group_add` and a boot-time `chgrp`. Same mutation problem, plus it makes `/workspace` shared between all apps again, which is a real weakening: today four apps share it anyway, so this is arguably status quo rather than a regression.
3. Run each app at the **host** uid rather than a synthetic one, discovered from `stat()` of the mount. Solves ownership exactly, but collapses to a single uid whenever two apps share a workspace — which is every multi-app container, and multi-app is precisely where 1.4 bites.
4. Keep `berth dev` at uid 0 and apply per-app uids only to `Computer.boot()` / `berth os up`, which do not bind-mount.

**Superseded by 1.6.** The plan when this was written was option 4 first (uids only where nothing is bind-mounted), then option 2 "once 1.6 has narrowed the mount to something it is reasonable to `chgrp`." 1.6 did exactly that, so option 2 applies directly to `.berth/dev-workspace` and there is no longer a reason to exempt `berth dev` from the uid work.

### Blocker 2 — `/context` disappears entirely for a non-root uid

`semantic-fs-daemon/main.go:54-58` mounts FUSE with `FSName` and `Subtype` only. A FUSE mount without `allow_other` is accessible **only to the mounting uid** — the kernel refuses every other uid at the VFS layer, before any of the daemon's own logic runs. So the instant apps stop being root, `/context` is gone for all of them: `apps/filesystem`'s four `*_context_file` exports, every checkpoint, every session, every trace.

**Fix:** add `fuse.AllowOther()` and ship `user_allow_other` in `/etc/fuse.conf`. Both are ours to change.

**Cost, stated plainly:** `allow_other` means *all* other uids, with no way to scope it to a subset. So `/context` reachability reverts to being governed by Landlock and file modes alone — per-app uid buys nothing there. That is the status quo, not a regression, but it means "each app is isolated from the others" will still have `/context` as an explicit exception.

### Blocker 3 — semantic-FS backing files are root-owned

`fusefs.go:257-258` passes the backing file's `stat.Uid`/`Gid` straight through as the FUSE attributes. The backing directory is written by the root daemon, so every file under `/context` presents as root-owned with the daemon's umask. Past `allow_other`, a non-root app can traverse and read but cannot write.

**Fix:** the daemon creates backing files `root:berth` mode `0660` and directories `2770` (setgid, so the group is inherited), with every app in the `berth` supplementary group. Same "shared by design" caveat as Blocker 2 — it makes `/context` writable by every app, not by the one that created a given file. Per-writer attribution is 1.14's `SO_PEERCRED` work, and it should be enforcement, not just attribution.

### Blocker 4 — `on_install` is defined as a root shell — **resolved**

> **Closed since this was written.** 1.5 landed: `on_install` is a Docker build layer for both targets, nothing executes it at container boot, and `run-lifecycle`'s marker mechanism is gone. The collision described below no longer exists, and Step 0 of the [migration](#migration-order) is that much shorter. The reasoning is kept because it is *why* 1.5 went first.


`run-lifecycle.ts:34` runs manifest `on_install` commands with `execSync`, before `agent-init` exists. The base image deliberately deletes `EXTERNALLY-MANAGED` (`base.Dockerfile:101`) so that `pip install -r requirements.txt` into the *system* Python is a supported `on_install` — which a non-root uid cannot do.

So the uid split does not merely fail to fix [1.5](../REMEDIATION.md#15--on_install-is-unsandboxed-root-shell-run-before-enforcement) — it collides with it. Running `on_install` as the app's uid breaks the documented use case; leaving it as root leaves an unsandboxed root shell that can `chown` its way around every boundary below, making the rest of this design decorative.

**Therefore: 1.5 lands first.** Its fix (move `on_install` into the image build as a `RUN` layer) resolves the collision by removing the boot-time root shell altogether, and system-Python installs keep working because they happen at build time. This ordering dependency is the single most important finding here, and it is not currently recorded in `REMEDIATION.md`'s sequencing, which lists 1.4 before 1.5.

### Blocker 5 — Chromium's own sandbox wants the thing 1.3 just took away

`cdp-controller.ts:48` passes `--no-sandbox`, commented (since 1.7) as being there because Chromium refuses its own sandbox as uid 0. A per-app uid is what would let that come off — a real renderer sandbox, and the removal of the standing risk that a renderer RCE lands as root.

Except Chromium's namespace sandbox calls `clone(CLONE_NEWUSER|CLONE_NEWPID)`, which [1.3](../REMEDIATION.md#13--bounding-set-drop-undone-by-unshareclone_newuser)'s seccomp filter now refuses for every app unconditionally, deliberately. Enabling one means punching a hole in the other.

**Recommendation: do not attempt this as part of the uid work.** Note it, leave `--no-sandbox` in place with the comment updated to name both reasons, and treat "browser apps get a real renderer sandbox" as its own item with its own threat analysis. The alternative — `CLONE_NEWUSER` permitted for `browser-native` — reopens 1.3 for exactly the app with the largest remote attack surface, which is the wrong app to make the exception for.

### Blocker 6 — pty allocation becomes a DAC question too

`apps/terminal` is already broken on any enforcing kernel ([1.15](../REMEDIATION.md#115--appsterminal-is-non-functional-on-any-landlock-enforcing-kernel), cause not fully established). Per-app uid adds a second, independent requirement: `/dev/ptmx` and the devpts mount are `root:tty`, so a non-root app needs the `tty` group to allocate a pty at all.

This could genuinely *help* — a real uid and a `tty` supplementary group is how pty allocation is meant to work, and the current everything-as-root arrangement may be part of why 1.15's behaviour is confusing. But 1.15 must be diagnosed on its own first; adding a uid change on top of an undiagnosed failure makes both harder to reason about.

### Blocker 7 — the host relay must stay root

`relay.ts:36` reaches a companion app via `docker exec` running `berth-rpc-relay.js` against `/tmp/berth-rpc/<app>.sock`. Under `0700` per-app directories that relay can only work as root — which it is, since `docker exec` defaults to the image's user. Fine, and required.

Worth stating explicitly because it is the same property as the documented `docker exec` bypass in [multi-app-reference](./multi-app-reference.md): anything that can talk to the Docker socket already has full authority inside the container. The uid boundary is between apps, never between the host and an app.

### Blocker 8 — smaller things that still need doing

- The install-marker volume at `$workingDir/.berth` (`container.ts:228`) is created root-owned by Docker; `chown` at boot, before `run_lifecycle`.
- The app directory itself, and `.berth/capability-policy.json` written into it by `generate-capability-policy.js` — the policy must be written before the uid switch, and must not be writable by the app afterward (`0640 root:<app>`), or an app can rewrite its own policy for the next boot.
- No privileged ports are involved: ttyd, websockify, VNC, and both brokers all bind above 1024, so nothing needs `CAP_NET_BIND_SERVICE`.
- `/root/.berth/vncpasswd` (`entrypoint.sh:44-48`) is already correctly out of app reach and stays root-owned.
- `BERTH_TOKEN_SECRET` is still exported into each app's environment (`entrypoint.sh:186`). The uid split does not touch that; it remains [1.10](../REMEDIATION.md#110--capability-tokens-are-never-verified-anywhere).

## Migration order

Each step is independently shippable and independently revertable. The ordering is chosen so that the step most likely to break something unrelated (Step 2) lands alone, with nothing else in the same change to confuse a bisect.

| Step | Change | Closes |
|---|---|---|
| 0 | ~~`on_install` moves to build time (Blocker 4)~~, ~~Blocker 1's open decision~~, ~~`allow_other` + backing-file group on semantic-FS (Blockers 2, 3)~~ — **done**. | 1.5 ✅ 1.6 ✅ |
| 1 | ~~Create uids, groups, and `/run/berth/<app>`; `chown` `.berth` and the install-marker volume~~ — **done**. No process changes uid yet. | — |
| 2 | ~~`setgroups`/`setresgid`/`setresuid` in `agent-init` before `exec`~~ — **done**. Sockets stay where they are. **The whole risk lives here** — full regression matrix before anything is built on top. | — |
| 3 | Sockets move to `/run/berth/<app>/rpc.sock`, mode `0700`; `/tmp` out of `BASELINE_WRITE_PATHS`, replaced by `/tmp/<app>`. | 1.4 (parts 1, 2) |
| 4 | `SO_PEERCRED` in `rpc.ts`'s `connectionHandler` (`rpc.ts:58`), and in the context-bus (`main.rs:125`) and semantic-FS (`control.go:136`) control paths, replacing self-asserted identity. | 1.4 (part 3), 1.14 identity half |
| 5 | Assert and test signal isolation; make `fail-closed` the governance default. | 1.11 |

Steps 3 and 4 are each about a day once Step 2 holds. Step 2 is the unknown, and Step 0 is most of the calendar time.

## Verification

Step 2 is the one that can break everything quietly, so its evidence has to be a regression matrix rather than a new assertion — all nine apps in `apps/` booted and exercised, plus `multi-app-milestone.mjs`, `published-port-security-milestone.mjs`, `capability-enforcement.mjs`, and `code-interpreter`'s `run_code` across python/javascript/shell. On both Docker Desktop and an enforcing kernel, because Blocker 1 is exactly the kind of thing that only shows up on one of them.

New assertions, per step:

- **Before Step 3 is designed on top of it** — confirm the premise in [the section above](#the-premise-correction-that-motivates-the-design) directly on an enforcing kernel: an app whose Landlock policy excludes `/tmp` can still `connect()` to a socket there. If that turns out to be wrong, Step 3 gets much simpler and this document needs revising, so it is worth ten minutes before it is worth three days.
- **Step 2** — every app process reports a non-zero, distinct uid; `setuid(0)` from inside an app fails.
- **Step 3** — the 1.4 exploit verbatim: `code-interpreter` runs `nc -U /run/berth/filesystem/rpc.sock` and gets `EACCES`, where today it gets `filesystem`'s capabilities. This extends Test 9, the existing cross-app boundary test.
- **Step 4** — a forged `app` field in a context-bus register frame is rejected in favour of the uid the kernel reports.
- **Step 5** — app B cannot `kill` app A's pid.

The Step 3 assertion is the one that matters. It should be confirmed to *fail* against the current code before it is claimed to pass against the new — the same discipline 1.7's closure used for the loopback binding and the VNC security types.

## The alternative, if this proves too expensive

If Blocker 1 or Blocker 2 turns out to cost more than the isolation is worth, the fallback for 1.4 alone is an application-layer secret: a per-app token generated by `entrypoint.sh`, exported only into that app's own environment, and required by `rpc.ts`'s `connectionHandler` on connect. It closes the specific exploit on every kernel, it is roughly a day, and it would give the capability-token machinery in [1.10](../REMEDIATION.md#110--capability-tokens-are-never-verified-anywhere) its first real enforcement point.

It is strictly weaker: it does nothing for 1.11 or 1.14, and it is a secret sitting in an environment the app itself can read, so any code-execution primitive that can read `/proc/<pid>/environ` of a sibling — which uid 0 can — defeats it. It is a mitigation, not a boundary. Recorded here so the trade is a decision rather than a drift.
