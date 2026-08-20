# The negative control that proved our own writeup wrong

*Draft for publication — the Landlock/seccomp engineering story. Every claim
links the test or doc that proves it; where something is unproven, it says
so.*

---

Berth's pitch is one sentence: an agent's permissions are a line in a
manifest — `filesystem:write:/workspace` — compiled into a
[Landlock](https://docs.kernel.org/userspace-api/landlock.html) ruleset and
applied by a small Rust binary, [`agent-init`](https://github.com/Ash20pk/BerthOS/tree/main/packages/agent-init),
before the app's own code ever runs. A write anywhere else dies on `EACCES`
in the kernel — not in a `try/catch`, not in a system prompt the model can be
talked out of.

That's the part that demos well. This post is about the part that doesn't:
what it took to make the *second* boundary hold — app against app inside the
same container — and how the negative control for that work caught us
publishing a claim that had been false from the moment we wrote it.

## The hole: every app could be every other app

Early Berth had per-app Landlock rulesets that were real and individually
correct — and that didn't matter, because every app's RPC socket sat in
world-writable `/tmp`, unauthenticated
([REMEDIATION 1.4](https://github.com/Ash20pk/BerthOS/blob/main/docs/internal/REMEDIATION.md)).
A code-interpreter app declaring only `filesystem:write:/workspace` could do:

```bash
printf '{"id":"1","export":"write_context_file","input":{...}}\n' \
  | nc -U /tmp/berth-rpc/filesystem.sock
```

and execute with the *filesystem* app's capabilities. Kernel-perfect walls,
with an open door between the rooms.

## Why Landlock couldn't fix it

The obvious fix — narrow each app's Landlock ruleset so it can't reach a
sibling's socket — doesn't work, and finding out why cost a design doc
([docs/per-app-uid-design.md](https://github.com/Ash20pk/BerthOS/blob/main/docs/per-app-uid-design.md)):
**Landlock does not gate `connect()` to a pathname Unix socket.** There is no
`inode_permission` hook on that path; ABI 6's scoping covers *abstract*
sockets only. "Connecting to a Unix socket requires write access to it" is a
DAC (plain Unix permissions) fact, not a ruleset one.

So the fix was the old-fashioned one: **every app gets its own uid**
(`10000 + index`), dropped irreversibly in `agent-init` after Landlock, the
capability drop, and both seccomp filters. Sockets moved from `/tmp` to
`/run/berth/<app>/`, owned by that app. `/tmp` left the baseline write set
entirely, replaced by a private `/tmp/<app>` that `TMPDIR`, `HOME`, and the
XDG variables all point at.

Cross-app calls didn't die — they became *declared*. `app:invoke:<name>` in
`berth.yml` is now the only way to reach a sibling, and the identity plumbing
is filesystem-shaped because Node cannot read `SO_PEERCRED`: each authorized
caller gets its own socket at `/run/berth/<target>/peers/<caller>/rpc.sock`
in a `2710` directory only that caller's uid can traverse. Which socket a
connection arrived on is a fact the kernel established at `connect(2)` — the
same property `SO_PEERCRED` gives, one layer up.

## The negative control, and what it actually found

House rule ([BUILD_PLAN rule 2](https://github.com/Ash20pk/BerthOS/blob/main/docs/internal/BUILD_PLAN.md)):
a security test isn't done until you've proven it *can* fail — reintroduce
the hole, watch the test go red. So before closing REMEDIATION 1.4 we ran the
original exploit against the pre-fix code, expecting to watch it succeed.

**It didn't.** `boundary-app-a` connecting to `boundary-app-b`'s socket in
the world-writable directory got `EACCES` — against the *vulnerable* code.

The reason was mundane and nobody's design: the socket file was
`srwxr-xr-x` — the default umask — and owned by app B's uid, so `other` had
no write bit, and `connect(2)` needs one. An earlier migration step
(per-app uids) had closed the connect path *by accident*, and the "exploit
still works verbatim" note our own tracking doc carried had been wrong from
the moment it was written.

Two lessons we now build by:

1. **A security property held up by a umask is a bug that hasn't happened
   yet.** The socket mode is now set explicitly in
   [`rpc.ts`](https://github.com/Ash20pk/BerthOS/blob/main/packages/sdk/src/rpc.ts)
   precisely because relying on the umask is how we ended up publishing a
   false claim.
2. **The negative control found the *real* remaining hole.** The
   world-writable directory no longer permitted connecting — but it still
   permitted **squatting**: any app could `bind()` a not-yet-started
   sibling's socket path and serve in its place, which the sticky bit does
   not prevent. That, not the original exploit, is what the final fix closes.

## What proves it today

[`capability-enforcement.mjs` Test 9](https://github.com/Ash20pk/BerthOS/blob/main/packages/docker-orchestrator/test/capability-enforcement.mjs)
asserts, unconditionally (this boundary is DAC, so it holds even on kernels
without Landlock):

- App A reaches its own socket (the positive control) and gets `EACCES` on
  app B's.
- App C, differing from A by one manifest line (`app:invoke:b`), is allowed
  through on its own peer socket — and still refused on a direction it never
  declared.
- The impersonation case: A is refused on the channel B keeps for C.
- The identity arrives: C's real call is logged by B as `"boundary-app-c"`,
  and the write is read back through B.

And the seccomp side has the same shape: the user-namespace filter's negative
control ran a `docker exec` (no filter — not a descendant of `agent-init`)
in the *same booted container* where the app's process got
`unshare: Operation not permitted`, proving the denial is the filter and not
the environment.

## What this does not claim

Honesty is the product here, so: the container-to-container story above is
strong against a prompt-injected agent. It is **not yet** a boundary against
an attacker with arbitrary code execution who targets the pre-`agent-init`
daemons, and the container still carries `CAP_SYS_ADMIN` for the semantic-fs
FUSE mount — both named in
[docs/threat-model.md](https://github.com/Ash20pk/BerthOS/blob/main/docs/threat-model.md)
and queued as the next milestone (BUILD_PLAN M1). When those close, this
paragraph changes — and not before.
