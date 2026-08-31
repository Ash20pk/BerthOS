# Verification record — the last two ungated transports (claims.md work list 1 and 2)

Date: 2026-08-29. Host: the Colima enforcing host from `docs/mac-enforcement.md`
(`DOCKER_HOST=unix://$HOME/.colima/default/docker.sock`, Ubuntu 24.04.4, kernel
6.8.0-117-generic, aarch64). `berth doctor` → `enforcement: ACTIVE`, Landlock
ABI 4, before every run below.

Runner: `node experimental/agents/test/governance-gate-milestone.mjs`, extended from
three transport rows to four.

## Why these two

`docs/internal/claims.md`'s work list opened with the only two enforcement
claims in the repo that rested on unit tests alone. Both are about the same
question: an agent whose `write_file` the governor refused — can it get the
same write through some *other* door into the same container?

Three doors already had milestone rows (the Computer's own dispatch, the
`berth rpc` relay, the HTTP RPC bridge). These were the remaining two.

## Result

| Transport | Claim | Result |
|---|---|---|
| Sibling peer socket (`app:invoke:filesystem`) | gated (B16) | **Refused**, with the governor's own reason string |
| Cross-container TCP listener (`BERTH_NETWORK_PORT`) | gated (was 1.13) | **Cannot bind at all** (K22) — `listen(2)` EACCES |

Full run, all four rows plus the on-disk sweep:

```
--- Transport: the relay (what `berth rpc` and `berth mcp` use) ---
PASS — `berth rpc`'s own transport is gated, and an allowed export still runs on it.
--- Transport: the HTTP RPC bridge ---
PASS — the HTTP RPC bridge is gated, and an allowed export still runs on it.
--- Transport: a sibling app's peer socket (app:invoke:filesystem) ---
peer-socket response: { id: 'gate-peer-1',
  error: "governance denied write_file: writes are blocked by this test fixture's policy" }
PASS — the sibling peer socket is gated, and an allowed export still runs on it.
--- Transport: the cross-container TCP listener (BERTH_NETWORK_PORT_FILESYSTEM) ---
tcp response: { error: 'dial failed: Error: connect ECONNREFUSED 127.0.0.1:7911' }
kernel refused the bind: [berth:runtime] WARNING: could not listen on 0.0.0.0:7911
  (Error: listen EACCES: permission denied 0.0.0.0:7911) — this app is not reachable over TCP
PASS — 7911 is refused by Landlock while the bridge's 32775 bound in the same container.
PASS — none of the four refused writes exists on disk.
```

## The peer socket (claims.md 1 → B16)

The gap was narrower than "is it gated" and worse than it sounded. K14 already
proved the *identity* half — a request arriving on
`/run/berth/filesystem/peers/<caller>/rpc.sock` is attributed to `<caller>` by
the kernel, because `entrypoint.sh` makes that directory mode 2710 group-owned
by the caller. What nothing asserted was the *verdict*: that the gate then
refuses. And this is the only one of the four transports an app can reach
**without root**, so an unenforced sibling channel would have been the denied
agent's own way around the governor rather than the operator's.

Closing it needed a sibling to exist. `experimental/agents/test/fixtures/governance-peer-caller`
is a fixture that exists for its manifest rather than its code: declaring
`app:invoke:filesystem` is what makes `grant_invoke_access` provision the
per-caller directory and socket. The milestone then dials that socket from
inside the container and sends the same `write_file` the governor refused.

**Negative control performed.** `evaluateAction()` patched to return
`{ allowed: true }` for `subject.caller === 'governance-peer-caller'` only —
narrow on purpose, so that the three already-passing rows stayed green and the
failure isolated to the new one. Observed:

```
PASS — `berth rpc`'s own transport is gated, and an allowed export still runs on it.
PASS — the HTTP RPC bridge is gated, and an allowed export still runs on it.
GOVERNANCE GATE MILESTONE VERIFICATION FAILED: Error: expected the sibling's call to be
  denied by governance, got: {"id":"gate-peer-1"}
```

A first, coarser control (patching `evaluateAction` to allow *everything*)
failed at the relay row instead, which is why the isolated version was run.

## The TCP listener (claims.md 2 → K22)

This one closed in the opposite direction to the one the work list expected,
and the finding is worth more than the test.

**The listener cannot bind on an enforcing kernel.**
`restrict_network`'s `AccessNet::from_all` denies `BindTcp` the moment network
scoping is active — which is any app not declaring `network:connect:*` — and
`computeBindPorts()` grants a bind exemption to exactly two ports: the HTTP RPC
bridge's and ttyd's. `BERTH_NETWORK_PORT`'s is neither. So `listen(2)` returns
EACCES and the transport does not exist to be gated. That is a stronger
statement than "a governor covers it": a governor is a policy check that can be
misconfigured; this is a closed door.

The milestone asserts both the effect (ECONNREFUSED from inside the container)
and the cause (the app's own log line, matched on `EACCES` specifically). The
cause assertion is the one that matters — without it the row also passes when
the env var never arrived, when the app crashed, or when the SDK ignored the
variable, none of which are the kernel refusing a bind. The in-container
positive control is the HTTP bridge's port, which *is* in `computeBindPorts`
and did bind in the same container on the same kernel.

**Negative control performed.** `computeBindPorts()` patched to push `7911` for
`filesystem`. Observed — and it proves the second half of the claim for free:

```
tcp response: {"id":"gate-tcp-1","error":"governance denied write_file: writes are
  blocked by this test fixture's policy"}
GOVERNANCE GATE MILESTONE VERIFICATION FAILED: Error: expected nothing to be listening
  on 7911 … which means computeBindPorts() grew a port and this row now needs the
  gated-transport assertions instead
```

So: with the bind refused (as shipped) the kernel closes the transport; with the
bind granted, the governance gate covers it. Both halves are now observed rather
than argued.

## Two product findings, and the fixes that came with them

1. **`startTcpServer` had no `error` handler.** That EACCES was an unhandled
   `error` event on a `net.Server`, which takes the whole app process down.
   Anyone who set `BERTH_NETWORK_PORT` on a kernel that enforces — the
   supported configuration — lost the app, not the listener. Fixed: the
   failure is now a warning, which is also what makes the milestone's cause
   assertion readable.

2. **Nothing in the product sets `BERTH_NETWORK_PORT`.** `Crew.networked()`
   reaches a remote peer over the authenticated HTTP RPC bridge
   (`startHttpRpcServer`). The TCP listener is a door an app author opens by
   hand, which is worth saying out loud in `rpc.ts` rather than leaving the
   `Crew.networked` reference in a comment to imply otherwise. Corrected.

   `envNetworkPort()` also gained an app-scoped `BERTH_NETWORK_PORT_<APP>`
   form, because the container-wide variable cannot work in a multi-app
   container — every app would race for the same port and all but one would
   fail (unhandled, before fix 1). Five unit tests cover the resolution order.

## What this does not prove

- The gate's behaviour under a **hostile governor** (one that lies, hangs
  differently per caller, or returns malformed verdicts) is unit-tested only.
  Fail-closed on timeout is B13's row; a governor that answers `allowed: true`
  for everything is a misconfiguration, not a bypass.
- `docker exec` still reaches every one of these transports as root, by
  construction — it is outside the trust boundary and the threat model says so.
- K22 is a statement about **enforcing kernels**. On Docker Desktop's linuxkit
  VM the bind would succeed, and the transport would then be gated rather than
  closed — the negative control above is exactly what that host looks like.
